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
  const retention = safeQuery_('retention',   () => queryRetention_(w),             { house: { m0m1: null, m1m2: null, m3plus: null }, channels: null }, warnings);
  const verticals = safeQuery_('verticals',   () => queryVerticals_(w),             null, warnings);
  const channels  = safeQuery_('channels',    () => queryChannels_(w),              null, warnings);
  const ggrChannels = safeQuery_('ggrChannels', () => queryGgrChannels_(w),         null, warnings);
  const depM0 = safeQuery_('depM0', () => queryDepM0_(w), { total: null, growth: null, m1Total: null, m1Growth: null, channels: null }, warnings);

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
  // REGRA APOSTOU: o "GGR" do negócio é a coluna ngr_total da player_metrics
  // GGR / Depósito
  const ggrPerDepMtd = safeDiv_(mtd.ngr, mtd.depositos);
  const ggrPerDepLm  = safeDiv_(lm.ngr,  lm.depositos);
  // Hold % = GGR / Turnover (turnover de tbl_performance_daily)
  const holdMtd = safeDiv_(mtd.ngr, pmtd.turnover);
  const holdLm  = safeDiv_(lm.ngr,  plm.turnover);
  // Close trend GGR só faz sentido em MTD natural — janela custom mostra null
  const ggrTrend = w.isNaturalMtd && mtd.ngr != null && w.daysElapsed
    ? mtd.ngr * (w.daysInMonth / w.daysElapsed)
    : null;

  const M = {
    // AQUISIÇÃO
    ftdAmount:  metric_('FTD Amount',  pmtd.ftd_amount, plm.ftd_amount, 'brl'),
    roasFtd:    metric_('ROAS FTD',    roasFtdMtd,      roasFtdLm,      'multiple'),
    invest:     metric_('Investimento', pmtd.spend,     plm.spend,      'brl'),
    // RETENÇÃO (from cohort wide view)
    retM0M1:    metric_('Retenção M0→M1', retention.house.m0m1, null, 'pct'),
    retM1M2:    metric_('Retenção M1→M2', retention.house.m1m2, null, 'pct'),
    retM3plus:  metric_('Retenção M3+',   retention.house.m3plus, null, 'pct'),
    // DEPÓSITOS
    depTotal:    metric_('Depósitos Totais', mtd.depositos, lm.depositos, 'brl'),
    depM0Total:  metric_('DEP M0 Total',     depM0.total,  depM0.m1Total,  'brl'),
    depM0Growth: metric_('DEP M0 Growth',    depM0.growth, depM0.m1Growth, 'brl'),
    // GGR
    ggr:        metric_('GGR Total',      mtd.ngr, lm.ngr, 'brl'),
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
    channels: channels,   // breakdown de aquisição por canal (platform) — tbl_cohort_ftd_base
    retentionChannels: retention.channels, // retenção de valor por canal — cohort wide monthly
    ggrChannels: ggrChannels, // GGR (ngr_total) + ROAS GGR por canal — player_metrics + performance
    depM0Channels: depM0.channels, // DEP M0 por canal — vw_cohort_deposito_amount_wide_monthly
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
  // Retenção de VALOR depositado (R$), por canal + casa toda.
  //
  // M0→M1 e M1→M2: média das safras (desde 2025-01) com janela completa:
  //   M0→M1 = SUM(_1)/SUM(_0) onde age>=2 · M1→M2 = SUM(_2)/SUM(_1) onde age>=3
  //
  // M3+: snapshot mensal do pool de safras antigas (age>=3 no mês de referência):
  //   numerador   = depósito do pool NO mês de referência  (_age de cada safra)
  //   denominador = depósito do MESMO pool no mês anterior (_age-1) —
  //                 equivale a "M3+ do mês passado + M2 do mês passado"
  const refMonth = w.mtdStart.slice(0, 7) + '-01';

  // CASE dinâmico: pra cada idade 3..23, pega a coluna _N (mês ref) e _N-1 (mês anterior)
  const ages = [];
  for (let a = 3; a <= 23; a++) ages.push(a);
  const caseThis = ages.map(a => `WHEN ${a} THEN _${a}`).join(' ');
  const casePrev = ages.map(a => `WHEN ${a} THEN _${a - 1}`).join(' ');

  const sql = `
    WITH base AS (
      SELECT
        COALESCE(NULLIF(platform, ''), 'Orgânico (sem atribuição)') AS channel,
        DATE_DIFF(DATE '${refMonth}', DATE(cohort_month), MONTH) AS age,
        *
      FROM \`${PROJECT_ID}.analytics_cohorts.vw_cohort_deposito_amount_wide_monthly\`
      WHERE cohort_month >= "2025-01-01" AND cohort_month <= "${refMonth}"
    )
    SELECT
      channel,
      SUM(_0) AS m0_total,
      SUM(IF(age >= 2, _1, 0)) AS n1,
      SUM(IF(age >= 2, _0, 0)) AS d1,
      SUM(IF(age >= 3, _2, 0)) AS n2,
      SUM(IF(age >= 3, _1, 0)) AS d2,
      SUM(CASE age ${caseThis} ELSE 0 END) AS n3,
      SUM(CASE age ${casePrev} ELSE 0 END) AS d3
    FROM base
    GROUP BY channel
  `;
  const rows = runQuery_(sql);
  if (!rows.length) return { house: { m0m1: null, m1m2: null, m3plus: null }, channels: null };

  // Rates por canal + acumula numeradores/denominadores pra taxa da casa
  const acc = { n1: 0, d1: 0, n2: 0, d2: 0, n3: 0, d3: 0 };
  const channels = rows.map(r => {
    ['n1','d1','n2','d2','n3','d3'].forEach(k => { acc[k] += numOrNull_(r[k]) || 0; });
    return {
      channel: r.channel,
      m0Total: numOrNull_(r.m0_total),
      m0m1:   safeDiv_(numOrNull_(r.n1), numOrNull_(r.d1)),
      m1m2:   safeDiv_(numOrNull_(r.n2), numOrNull_(r.d2)),
      m3plus: safeDiv_(numOrNull_(r.n3), numOrNull_(r.d3)),
    };
  }).sort((a, b) => (b.m0Total || 0) - (a.m0Total || 0));

  return {
    house: {
      m0m1:   safeDiv_(acc.n1, acc.d1),
      m1m2:   safeDiv_(acc.n2, acc.d2),
      m3plus: safeDiv_(acc.n3, acc.d3),
    },
    channels,
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

function queryChannels_(w) {
  // Aquisição por canal — tudo da tbl_cohort_ftd_base (platform cobre pago + orgânico/social).
  // Grain: periodo × days_since_ftd × platform × utm_campaign_id.
  // FTD/spend pertencem à linha do dia 0 (dia do FTD) — filtrar evita dupla contagem.
  const sql = `
    SELECT
      COALESCE(NULLIF(platform, ''), 'Orgânico (sem atribuição)') AS channel,
      SUM(spend)           AS spend,
      SUM(qtd_ftd)         AS ftd_qty,
      SUM(amount_ftd)      AS ftd_amount,
      SUM(amount_deposito) AS dep_d0
    FROM \`${PROJECT_ID}.analytics_cohorts.tbl_cohort_ftd_base\`
    WHERE periodo BETWEEN DATE '${w.mtdStart}' AND DATE '${w.mtdEnd}'
      AND days_since_ftd = 0
    GROUP BY channel
    HAVING SUM(qtd_ftd) > 0 OR SUM(spend) > 0
  `;
  const rows = runQuery_(sql);
  if (!rows.length) return null;

  const channels = rows.map(r => {
    const spend = numOrNull_(r.spend);
    return {
      channel:   r.channel,
      spend:     spend > 0 ? spend : null, // 0 = canal sem mídia → front mostra "—"
      ftdQty:    numOrNull_(r.ftd_qty),
      ftdAmount: numOrNull_(r.ftd_amount),
      depD0:     numOrNull_(r.dep_d0),
    };
  });

  // Pagos primeiro (por spend desc), depois os demais (por FTD R$ desc)
  return channels.sort((a, b) => {
    const aPaid = a.spend != null, bPaid = b.spend != null;
    if (aPaid !== bPaid) return aPaid ? -1 : 1;
    if (aPaid) return b.spend - a.spend;
    return (b.ftdAmount || 0) - (a.ftdAmount || 0);
  });
}

// Mapeia platform (performance) pros mesmos labels da classificação por utm
function normalizeChannel_(raw) {
  const s = String(raw || '').toLowerCase();
  if (/meta|facebook|\bfb\b|instagram|\big\b/.test(s)) return 'Meta';
  if (/google|gads|adwords|youtube/.test(s)) return 'Google';
  if (/tiktok/.test(s)) return 'TikTok';
  if (/kwai/.test(s)) return 'Kwai';
  return raw;
}

function queryGgrChannels_(w) {
  // REGRA APOSTOU: GGR do negócio = coluna ngr_total da player_metrics.
  // player_metrics não tem platform — canal vem da atribuição de cadastro
  // (utm_cadastro_source + afiliado_nome). Spend (pro ROAS GGR) vem da
  // tbl_performance_daily, casado por canal normalizado.
  const ggrSql = `
    SELECT
      CASE
        WHEN REGEXP_CONTAINS(LOWER(IFNULL(utm_cadastro_source, '')), r'meta|facebook|fb_|instagram|ig_') THEN 'Meta'
        WHEN REGEXP_CONTAINS(LOWER(IFNULL(utm_cadastro_source, '')), r'google|gads|adwords|youtube')     THEN 'Google'
        WHEN REGEXP_CONTAINS(LOWER(IFNULL(utm_cadastro_source, '')), r'tiktok')                          THEN 'TikTok'
        WHEN REGEXP_CONTAINS(LOWER(IFNULL(utm_cadastro_source, '')), r'kwai')                            THEN 'Kwai'
        WHEN afiliado_nome IS NOT NULL AND afiliado_nome != ''                                           THEN 'Afiliados'
        WHEN REGEXP_CONTAINS(LOWER(IFNULL(utm_cadastro_source, '')), r'social|influencer|bio')           THEN 'Social Media'
        WHEN utm_cadastro_source IS NULL OR utm_cadastro_source = ''                                     THEN 'Orgânico (sem atribuição)'
        ELSE 'Outros'
      END AS channel,
      SUM(ngr_total)           AS ngr,
      SUM(valor_wins_freespin) AS freespin
    FROM \`${PROJECT_ID}.dados_clickhouse.player_metrics\`
    WHERE data_ref BETWEEN DATE '${w.mtdStart}' AND DATE '${w.mtdEnd}'
    GROUP BY channel
  `;
  const spendSql = `
    SELECT
      COALESCE(NULLIF(platform, ''), 'Outros') AS platform,
      SUM(spend) AS spend
    FROM \`${PROJECT_ID}.analytics_performance.tbl_performance_daily\`
    WHERE report_date BETWEEN DATE '${w.mtdStart}' AND DATE '${w.mtdEnd}'
    GROUP BY platform
    HAVING SUM(spend) > 0
  `;

  const ggrRows = runQuery_(ggrSql);
  if (!ggrRows.length) return null;
  const spendRows = runQuery_(spendSql);

  const byChannel = {};
  ggrRows.forEach(r => {
    byChannel[r.channel] = {
      channel:  r.channel,
      ggr:      numOrNull_(r.ngr),
      spend:    null,
      freespin: numOrNull_(r.freespin),
    };
  });
  spendRows.forEach(r => {
    const ch = normalizeChannel_(r.platform);
    byChannel[ch] = byChannel[ch] || { channel: ch, ggr: null, spend: null, freespin: null };
    byChannel[ch].spend = (byChannel[ch].spend || 0) + (numOrNull_(r.spend) || 0);
  });

  return Object.values(byChannel).sort((a, b) => {
    const aPaid = a.spend != null, bPaid = b.spend != null;
    if (aPaid !== bPaid) return aPaid ? -1 : 1;
    if (aPaid) return b.spend - a.spend;
    return (b.ggr || 0) - (a.ggr || 0);
  });
}

function queryDepM0_(w) {
  // DEP M0 por canal — safra do mês de referência (e do mês anterior pro Δ M-1).
  // "Growth" = canais com investimento (valor_investido > 0) — identificado pelo dado,
  // sem depender de nome de platform.
  const refMonth = w.mtdStart.slice(0, 7) + '-01';
  const lmMonth = w.lmStart.slice(0, 7) + '-01';
  const sql = `
    SELECT
      IF(DATE(cohort_month) = DATE '${refMonth}', 'mtd', 'lm') AS bucket,
      COALESCE(NULLIF(platform, ''), 'Orgânico (sem atribuição)') AS channel,
      SUM(amount_deposito_m0) AS dep_m0,
      SUM(valor_investido)    AS invest
    FROM \`${PROJECT_ID}.analytics_cohorts.vw_cohort_deposito_amount_wide_monthly\`
    WHERE DATE(cohort_month) IN (DATE '${refMonth}', DATE '${lmMonth}')
    GROUP BY bucket, channel
  `;
  const rows = runQuery_(sql);
  if (!rows.length) return { total: null, growth: null, m1Total: null, m1Growth: null, channels: null };

  let total = 0, growth = 0, m1Total = 0, m1Growth = 0;
  const channels = [];
  rows.forEach(r => {
    const dep = numOrNull_(r.dep_m0) || 0;
    const invest = numOrNull_(r.invest) || 0;
    const isPaid = invest > 0;
    if (r.bucket === 'mtd') {
      total += dep;
      if (isPaid) growth += dep;
      channels.push({
        channel: r.channel,
        depM0: dep,
        invest: isPaid ? invest : null,
      });
    } else {
      m1Total += dep;
      if (isPaid) m1Growth += dep;
    }
  });

  channels.sort((a, b) => {
    const aPaid = a.invest != null, bPaid = b.invest != null;
    if (aPaid !== bPaid) return aPaid ? -1 : 1;
    return (b.depM0 || 0) - (a.depM0 || 0);
  });

  return { total, growth, m1Total, m1Growth, channels: channels.length ? channels : null };
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
