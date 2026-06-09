// ===== RevOps Cockpit — Apps Script backend =====
// Reads from BigQuery, returns JSON shaped for index.html.
// Deploy as: Execute as "Me" | Who has access: "Only myself" (or "Specific users").
//
// First-time setup: see PUBLISH.md. Bottom-line: enable BigQuery advanced service,
// run `setup()` once to grant scopes, then Deploy → Web app.

const PROJECT_ID = 'db-clickhouse';
const TZ = 'America/Sao_Paulo';
const CACHE_TTL_SECONDS = 15 * 60; // 15 min — cohort queries are expensive
// Token "público" — visível no index.html do repo público. Não é segredo forte,
// só evita varredura. Rotaciona aqui + no index.html quando quiser.
const ACCESS_TOKEN = 'rvops_5fa28e9c4b1d3a7f';

// ============================================================
// ENTRY POINT
// ============================================================

function doGet(e) {
  try {
    const params = (e && e.parameter) || {};

    // Token check — endpoint deployado como "Anyone", protegido só pela chave
    if (params.key !== ACCESS_TOKEN) {
      return ContentService
        .createTextOutput(JSON.stringify({ error: 'Unauthorized — missing or invalid key' }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    const refresh = params.refresh === 'true';
    const fromParam = params.from || null;  // YYYY-MM-DD
    const toParam = params.to || null;      // YYYY-MM-DD

    const cache = CacheService.getScriptCache();
    const cacheKey = `cockpit_payload_v2:${fromParam || 'mtd'}:${toParam || 'd1'}`;

    if (!refresh) {
      const cached = cache.get(cacheKey);
      if (cached) return json_(JSON.parse(cached));
    }

    const payload = buildPayload_(fromParam, toParam);
    cache.put(cacheKey, JSON.stringify(payload), CACHE_TTL_SECONDS);
    return json_(payload);
  } catch (err) {
    return json_({ error: String(err && err.message || err), stack: err && err.stack });
  }
}

function json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ============================================================
// DATE WINDOWS — MTD vs last month, same day-of-month window
// ============================================================

function windows_(fromParam, toParam) {
  // Parse fromParam/toParam (YYYY-MM-DD strings) ou default = MTD usando D-1
  let mtdStartDate, mtdEndDate;
  if (fromParam && toParam) {
    mtdStartDate = parseISO_(fromParam);
    mtdEndDate = parseISO_(toParam);
  } else {
    const ref = new Date(new Date().toLocaleString('en-US', { timeZone: TZ }));
    ref.setDate(ref.getDate() - 1);  // D-1
    mtdStartDate = new Date(ref.getFullYear(), ref.getMonth(), 1);
    mtdEndDate = ref;
  }

  // M-1 = mesma janela, um mês para trás (calendar arithmetic)
  const lmStartDate = new Date(mtdStartDate);
  lmStartDate.setMonth(lmStartDate.getMonth() - 1);
  const lmEndDate = new Date(mtdEndDate);
  lmEndDate.setMonth(lmEndDate.getMonth() - 1);

  // Projeção close trend: só faz sentido em MTD natural — se for janela custom, retorna null no payload
  const y = mtdEndDate.getFullYear();
  const m = mtdEndDate.getMonth();
  const d = mtdEndDate.getDate();
  const isNaturalMtd = !fromParam && !toParam;
  const daysInMonth = isNaturalMtd ? new Date(y, m + 1, 0).getDate() : null;
  const daysElapsed = isNaturalMtd ? d : null;

  const fmt = (dt) => dt.toISOString().slice(0, 10);
  return {
    mtdStart: fmt(mtdStartDate),
    mtdEnd: fmt(mtdEndDate),
    lmStart: fmt(lmStartDate),
    lmEnd: fmt(lmEndDate),
    refDate: `${String(d).padStart(2, '0')}/${String(m + 1).padStart(2, '0')}/${y}`,
    daysInMonth,
    daysElapsed,
    isNaturalMtd,
  };
}

function parseISO_(s) {
  // YYYY-MM-DD → Date local (sem timezone shenanigans)
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

// ============================================================
// PAYLOAD BUILDER — orchestrates queries + assembles cockpit shape
// ============================================================

function buildPayload_(fromParam, toParam) {
  const w = windows_(fromParam, toParam);
  // Cada query blindada: se uma falhar (coluna errada etc.), só ela vira fallback,
  // o resto do payload continua. Erros ficam em meta.warnings pra debug.
  const warnings = [];
  const houseAgg  = safeQuery_('house',       () => queryHouseAggregates_(w),       { mtd: {}, lm: {} }, warnings);
  const perfAgg   = safeQuery_('performance', () => queryPerformanceAggregates_(w), { mtd: {}, lm: {} }, warnings);
  const retention = safeQuery_('retention',   () => queryRetention_(w),             { m0m1: null, m1m2: null, m3plus: null }, warnings);
  const verticals = safeQuery_('verticals',   () => queryVerticals_(w),             null, warnings);
  const channels  = safeQuery_('channels',    () => queryChannels_(w),              null, warnings);

  const mtd = houseAgg.mtd;
  const lm = houseAgg.lm;
  const pmtd = perfAgg.mtd;
  const plm = perfAgg.lm;

  // ROAS FTD = amount_ftd / spend
  const roasFtdMtd = safeDiv_(pmtd.ftd_amount, pmtd.spend);
  const roasFtdLm  = safeDiv_(plm.ftd_amount,  plm.spend);
  // ROAS D0 = amount_dep_d0 / spend
  const roasD0Mtd = safeDiv_(pmtd.dep_d0, pmtd.spend);
  const roasD0Lm  = safeDiv_(plm.dep_d0,  plm.spend);
  // GGR / Depósito
  const ggrPerDepMtd = safeDiv_(mtd.ggr, mtd.depositos);
  const ggrPerDepLm  = safeDiv_(lm.ggr,  lm.depositos);
  // Hold % = GGR / Turnover (turnover agora vem de tbl_performance_daily)
  const holdMtd = safeDiv_(mtd.ggr, pmtd.turnover);
  const holdLm  = safeDiv_(lm.ggr,  plm.turnover);
  // Close trend GGR só faz sentido em MTD natural — janela custom mostra null
  const ggrTrend = w.isNaturalMtd && mtd.ggr != null && w.daysElapsed
    ? mtd.ggr * (w.daysInMonth / w.daysElapsed)
    : null;

  const M = {
    // AQUISIÇÃO
    ftdAmount:  metric_('FTD Amount',  pmtd.ftd_amount, plm.ftd_amount, 'brl'),
    roasFtd:    metric_('ROAS FTD',    roasFtdMtd,      roasFtdLm,      'multiple'),
    invest:     metric_('Investimento', pmtd.spend,     plm.spend,      'brl'),
    // RETENÇÃO (from cohort wide view)
    retM0M1:    metric_('Retenção M0→M1', retention.m0m1, null, 'pct'),
    retM1M2:    metric_('Retenção M1→M2', retention.m1m2, null, 'pct'),
    retM3plus:  metric_('Retenção M3+',   retention.m3plus, null, 'pct'),
    // DEPÓSITOS
    depTotal:    metric_('Depósitos Totais', mtd.depositos, lm.depositos, 'brl'),
    depM0Total:  metric_('DEP M0 Total',     null, null, 'brl'),   // TODO: cohort wide _0 sum
    depM0Growth: metric_('DEP M0 Growth',    null, null, 'brl'),   // TODO: cohort wide filtered por platform
    // GGR
    ggr:        metric_('GGR Total',      mtd.ggr, lm.ggr, 'brl'),
    ggrPerDep:  metric_('GGR / Depósito', ggrPerDepMtd, ggrPerDepLm, 'pct'),
    ggrTrend:   metric_('Close Trend GGR', ggrTrend, null, 'brl'),
    // TURNOVER
    turnover:   metric_('Turnover Total',           pmtd.turnover, plm.turnover, 'brl'),
    hold:       metric_('Hold % (GGR / Turnover)',  holdMtd, holdLm, 'pct'),
    bettors:    metric_('Apostadores Ativos',       mtd.depositantes_unicos, lm.depositantes_unicos, 'qty'),
  };

  return {
    meta: {
      refDate: w.refDate,
      from: w.mtdStart,
      to: w.mtdEnd,
      lmFrom: w.lmStart,
      lmTo: w.lmEnd,
      daysInMonth: w.daysInMonth,
      daysElapsed: w.daysElapsed,
      isNaturalMtd: w.isNaturalMtd,
      generatedAt: new Date().toISOString(),
      source: 'BigQuery — live via Apps Script',
      warnings: warnings.length ? warnings : undefined,
    },
    metrics: M,
    // Vizs de apoio
    clusterDep: null,     // % Novos / Recorrentes / Reativados — pendente (cohort wide)
    clusterGgr: null,     // GGR/Dep por safra — pendente
    depComposition: null, // Novos / Recorrentes / Reativados em R$ — pendente
    verticals: verticals, // GGR por vertical (casino / esporte / loteria) — de player_metrics
    channels: channels,   // breakdown de aquisição por canal (platform) — tbl_performance_daily
  };
}

function metric_(label, act, m1, fmt) {
  return { label, act, m1, pctBp: null, fmt };
  // pctBp permanece null até a fonte de BP estar conectada (Excel pendente)
}

function safeDiv_(a, b) {
  if (a == null || b == null || b === 0) return null;
  return a / b;
}

// Roda uma query e devolve fallback se ela estourar; registra o erro em warnings.
function safeQuery_(name, fn, fallback, warnings) {
  try {
    return fn();
  } catch (err) {
    warnings.push(`${name}: ${String(err && err.message || err)}`);
    return fallback;
  }
}

// ============================================================
// QUERIES
// ============================================================

function queryHouseAggregates_(w) {
  const sql = `
    SELECT
      IF(data_ref BETWEEN DATE '${w.mtdStart}' AND DATE '${w.mtdEnd}', 'mtd', 'lm') AS bucket,
      SUM(ggr_total)                                      AS ggr,
      SUM(ngr_total)                                      AS ngr,
      SUM(valor_depositos)                                AS depositos,
      COUNT(DISTINCT IF(qtd_depositos > 0, account_id, NULL)) AS depositantes_unicos,
      SUM(valor_bonus)                                    AS bonus
    FROM \`${PROJECT_ID}.dados_clickhouse.player_metrics\`
    WHERE data_ref BETWEEN DATE '${w.lmStart}' AND DATE '${w.mtdEnd}'
    GROUP BY bucket
  `;
  const rows = runQuery_(sql);
  return splitByWindow_(rows, ['ggr', 'ngr', 'depositos', 'depositantes_unicos', 'bonus']);
}

function queryPerformanceAggregates_(w) {
  const sql = `
    SELECT
      IF(report_date BETWEEN DATE '${w.mtdStart}' AND DATE '${w.mtdEnd}', 'mtd', 'lm') AS bucket,
      SUM(spend)               AS spend,
      SUM(qtd_ftd)             AS ftd_qty,
      SUM(amount_ftd)          AS ftd_amount,
      SUM(amount_deposito_d0)  AS dep_d0,
      SUM(turnover_total)      AS turnover
    FROM \`${PROJECT_ID}.analytics_performance.tbl_performance_daily\`
    WHERE report_date BETWEEN DATE '${w.lmStart}' AND DATE '${w.mtdEnd}'
    GROUP BY bucket
  `;
  const rows = runQuery_(sql);
  return splitByWindow_(rows, ['spend', 'ftd_qty', 'ftd_amount', 'dep_d0', 'turnover']);
}

function queryRetention_(w) {
  // Cohort monthly wide: _0 = deposit value at M0, _1 = M1, etc.
  // Retenção = SUM(_N) / SUM(_0) — só considera safras com pelo menos N meses de história.
  const refMonth = w.mtdStart.slice(0, 7) + '-01';
  const sql = `
    WITH cohorts AS (
      SELECT
        cohort_month,
        SUM(_0)  AS m0,
        SUM(_1)  AS m1,
        SUM(_2)  AS m2,
        SUM(_3)  AS m3,
        SUM(_4)  AS m4,
        SUM(_5)  AS m5
      FROM \`${PROJECT_ID}.analytics_cohorts.vw_cohort_deposito_amount_wide_monthly\`
      WHERE cohort_month >= "2025-01-01" AND cohort_month <= "${refMonth}"
      GROUP BY cohort_month
    )
    SELECT
      SAFE_DIVIDE(SUM(IF(m1 IS NOT NULL, m1, 0)), SUM(IF(m1 IS NOT NULL, m0, 0))) AS m0m1,
      SAFE_DIVIDE(SUM(IF(m2 IS NOT NULL, m2, 0)), SUM(IF(m2 IS NOT NULL, m1, 0))) AS m1m2,
      SAFE_DIVIDE(SUM(IF(m3 IS NOT NULL, m3 + IFNULL(m4,0) + IFNULL(m5,0), 0)),
                  SUM(IF(m3 IS NOT NULL, m2, 0)))                                  AS m3plus
    FROM cohorts
  `;
  const rows = runQuery_(sql);
  const r = rows[0] || {};
  return {
    m0m1:   numOrNull_(r.m0m1),
    m1m2:   numOrNull_(r.m1m2),
    m3plus: numOrNull_(r.m3plus),
  };
}

function queryVerticals_(w) {
  // GGR por vertical no período (MTD). player_metrics tem ggr_casino / ggr_esporte / ggr_loteria.
  const sql = `
    SELECT
      SUM(ggr_casino)  AS casino,
      SUM(ggr_esporte) AS esporte,
      SUM(ggr_loteria) AS loteria
    FROM \`${PROJECT_ID}.dados_clickhouse.player_metrics\`
    WHERE data_ref BETWEEN DATE '${w.mtdStart}' AND DATE '${w.mtdEnd}'
  `;
  const r = runQuery_(sql)[0] || {};
  const casino = numOrNull_(r.casino) || 0;
  const esporte = numOrNull_(r.esporte) || 0;
  const loteria = numOrNull_(r.loteria) || 0;
  const total = casino + esporte + loteria;
  if (total <= 0) return null;
  // Front-end espera { label, value(0..1), amount } e ordena por value
  return [
    { label: 'Casino',  value: casino / total,  amount: casino },
    { label: 'Esporte', value: esporte / total, amount: esporte },
    { label: 'Loteria', value: loteria / total, amount: loteria },
  ].sort((a, b) => b.value - a.value);
}

// Normaliza nomes de canal (platform da performance + utm da player_metrics) num label único
function normalizeChannel_(raw) {
  const s = String(raw || '').toLowerCase();
  if (/meta|facebook|\bfb\b|instagram|\big\b/.test(s)) return 'Meta';
  if (/google|gads|adwords|youtube/.test(s)) return 'Google';
  if (/tiktok/.test(s)) return 'TikTok';
  if (/kwai/.test(s)) return 'Kwai';
  return null; // não é plataforma paga conhecida
}

function queryChannels_(w) {
  // FTDs por atribuição: player_metrics no dia do FTD (utm_cadastro_source + afiliado).
  // Cobre a casa toda — pago, social, afiliados e sem atribuição (orgânico).
  const ftdSql = `
    WITH ftd_dates AS (
      SELECT account_id, MIN(data_ref) AS ftd_date
      FROM \`${PROJECT_ID}.dados_clickhouse.player_metrics\`
      WHERE qtd_ftd > 0
      GROUP BY account_id
    ),
    period AS (
      SELECT
        f.account_id,
        ANY_VALUE(a.utm_cadastro_source) AS utm,
        ANY_VALUE(a.afiliado_nome)       AS afiliado,
        SUM(a.ftd_amount)                AS amount
      FROM ftd_dates f
      JOIN \`${PROJECT_ID}.dados_clickhouse.player_metrics\` a
        ON a.account_id = f.account_id AND a.data_ref = f.ftd_date
      WHERE f.ftd_date BETWEEN DATE '${w.mtdStart}' AND DATE '${w.mtdEnd}'
      GROUP BY f.account_id
    )
    SELECT
      CASE
        WHEN REGEXP_CONTAINS(LOWER(IFNULL(utm, '')), r'meta|facebook|fb_|instagram|ig_') THEN 'Meta'
        WHEN REGEXP_CONTAINS(LOWER(IFNULL(utm, '')), r'google|gads|adwords|youtube')     THEN 'Google'
        WHEN REGEXP_CONTAINS(LOWER(IFNULL(utm, '')), r'tiktok')                          THEN 'TikTok'
        WHEN REGEXP_CONTAINS(LOWER(IFNULL(utm, '')), r'kwai')                            THEN 'Kwai'
        WHEN afiliado IS NOT NULL AND afiliado != ''                                     THEN 'Afiliados'
        WHEN REGEXP_CONTAINS(LOWER(IFNULL(utm, '')), r'social|influencer|bio')           THEN 'Social Media'
        WHEN utm IS NULL OR utm = ''                                                     THEN 'Orgânico (sem atribuição)'
        ELSE 'Outros'
      END AS channel,
      COUNT(*)    AS ftd_qty,
      SUM(amount) AS ftd_amount
    FROM period
    GROUP BY channel
  `;

  // Spend por plataforma paga (só a performance table sabe de investimento)
  const spendSql = `
    SELECT
      COALESCE(NULLIF(platform, ''), 'Outros') AS platform,
      SUM(spend) AS spend
    FROM \`${PROJECT_ID}.analytics_performance.tbl_performance_daily\`
    WHERE report_date BETWEEN DATE '${w.mtdStart}' AND DATE '${w.mtdEnd}'
    GROUP BY platform
    HAVING SUM(spend) > 0
  `;

  const ftdRows = runQuery_(ftdSql);
  const spendRows = runQuery_(spendSql);
  if (!ftdRows.length && !spendRows.length) return null;

  // Merge por canal normalizado
  const byChannel = {};
  ftdRows.forEach(r => {
    const ch = r.channel;
    byChannel[ch] = byChannel[ch] || { channel: ch, spend: null, ftdQty: 0, ftdAmount: 0 };
    byChannel[ch].ftdQty += numOrNull_(r.ftd_qty) || 0;
    byChannel[ch].ftdAmount += numOrNull_(r.ftd_amount) || 0;
  });
  spendRows.forEach(r => {
    const ch = normalizeChannel_(r.platform) || r.platform;
    byChannel[ch] = byChannel[ch] || { channel: ch, spend: null, ftdQty: 0, ftdAmount: 0 };
    byChannel[ch].spend = (byChannel[ch].spend || 0) + (numOrNull_(r.spend) || 0);
  });

  // Pagos (com spend) primeiro, por spend desc; depois os demais por FTD R$ desc
  return Object.values(byChannel).sort((a, b) => {
    const aPaid = a.spend != null, bPaid = b.spend != null;
    if (aPaid !== bPaid) return aPaid ? -1 : 1;
    if (aPaid) return b.spend - a.spend;
    return b.ftdAmount - a.ftdAmount;
  });
}

// ============================================================
// BIGQUERY HELPER
// ============================================================

function runQuery_(sql) {
  const request = { query: sql, useLegacySql: false, timeoutMs: 60000 };
  const queryResults = BigQuery.Jobs.query(request, PROJECT_ID);
  const jobId = queryResults.jobReference.jobId;

  // Poll until job completes (up to ~60s)
  let result = queryResults;
  let attempts = 0;
  while (!result.jobComplete && attempts < 30) {
    Utilities.sleep(2000);
    result = BigQuery.Jobs.getQueryResults(PROJECT_ID, jobId);
    attempts++;
  }

  if (!result.jobComplete) throw new Error('BigQuery job timeout: ' + jobId);

  const fields = (result.schema && result.schema.fields) || [];
  const rows = (result.rows || []).map(row => {
    const out = {};
    row.f.forEach((cell, i) => {
      out[fields[i].name] = cell.v;
    });
    return out;
  });
  return rows;
}

function numOrNull_(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return isNaN(n) ? null : n;
}

function splitByWindow_(rows, numericKeys) {
  const out = { mtd: {}, lm: {} };
  numericKeys.forEach(k => { out.mtd[k] = 0; out.lm[k] = 0; });
  rows.forEach(r => {
    const target = r.bucket === 'mtd' ? out.mtd : out.lm;
    numericKeys.forEach(k => { target[k] = numOrNull_(r[k]); });
  });
  return out;
}

// ============================================================
// SETUP — run once after first save to grant scopes
// ============================================================

function setup() {
  // Forces Apps Script to enumerate the scopes we'll need at runtime.
  // Just open & run this once; consent dialog will appear.
  const w = windows_();
  Logger.log('Windows: ' + JSON.stringify(w));
  const result = BigQuery.Jobs.query(
    { query: 'SELECT 1 AS ok', useLegacySql: false, timeoutMs: 30000 },
    PROJECT_ID
  );
  Logger.log('BigQuery OK: ' + JSON.stringify(result.rows));
}

// Útil pra debug — chama do editor pra ver o payload no Logger
function previewPayload() {
  const payload = buildPayload_();
  Logger.log(JSON.stringify(payload, null, 2));
}
