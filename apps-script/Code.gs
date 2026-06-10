// ===== RevOps Cockpit — Apps Script backend =====
// Reads from BigQuery, returns JSON shaped for index.html.
// Deploy as: Execute as "Me" | Who has access: "Anyone" (protegido por token).

const PROJECT_ID = 'db-clickhouse';
const TZ = 'America/Sao_Paulo';
const CACHE_TTL_SECONDS = 60 * 60; // 1h (era 15min) — corta ~4× as queries/custo
const ACCESS_TOKEN = 'rvops_5fa28e9c4b1d3a7f';

// Canais Growth = mídia paga. Labels canônicos.
const GROWTH_CHANNELS = ['Meta', 'Google', 'TikTok', 'Kwai', 'Programática'];

// ============================================================
// ENTRY POINT
// ============================================================

function doGet(e) {
  try {
    const params = (e && e.parameter) || {};

    if (params.key !== ACCESS_TOKEN) {
      return ContentService
        .createTextOutput(JSON.stringify({ error: 'Unauthorized — missing or invalid key' }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    const refresh = params.refresh === 'true';
    const fromParam = params.from || null;     // YYYY-MM-DD
    const toParam = params.to || null;         // YYYY-MM-DD
    const filter = {
      channel: params.channel || null,         // nome exato do canal (label canônico)
      scope: params.scope === 'growth' ? 'growth' : 'all',
    };

    const cache = CacheService.getScriptCache();
    const cacheKey = `cockpit_v3:${fromParam || 'mtd'}:${toParam || 'd1'}:${filter.channel || '-'}:${filter.scope}`;

    if (!refresh) {
      const cached = cache.get(cacheKey);
      if (cached) return json_(JSON.parse(cached));
    }

    const payload = buildPayload_(fromParam, toParam, filter);
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
// DATE WINDOWS
// ============================================================

function windows_(fromParam, toParam) {
  let mtdStartDate, mtdEndDate;
  if (fromParam && toParam) {
    mtdStartDate = parseISO_(fromParam);
    mtdEndDate = parseISO_(toParam);
  } else {
    const ref = new Date(new Date().toLocaleString('en-US', { timeZone: TZ }));
    ref.setDate(ref.getDate() - 1);
    mtdStartDate = new Date(ref.getFullYear(), ref.getMonth(), 1);
    mtdEndDate = ref;
  }

  const lmStartDate = new Date(mtdStartDate);
  lmStartDate.setMonth(lmStartDate.getMonth() - 1);
  const lmEndDate = new Date(mtdEndDate);
  lmEndDate.setMonth(lmEndDate.getMonth() - 1);

  const y = mtdEndDate.getFullYear();
  const m = mtdEndDate.getMonth();
  const d = mtdEndDate.getDate();
  const isNaturalMtd = !fromParam && !toParam;
  const daysInMonth = isNaturalMtd ? new Date(y, m + 1, 0).getDate() : null;
  const daysElapsed = isNaturalMtd ? d : null;

  const fmt = (dt) => dt.toISOString().slice(0, 10);
  return {
    mtdStart: fmt(mtdStartDate), mtdEnd: fmt(mtdEndDate),
    lmStart: fmt(lmStartDate), lmEnd: fmt(lmEndDate),
    refDate: `${String(d).padStart(2, '0')}/${String(m + 1).padStart(2, '0')}/${y}`,
    daysInMonth, daysElapsed, isNaturalMtd,
  };
}

function parseISO_(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function shiftISO_(iso, deltaDays) {
  const d = parseISO_(iso);
  d.setDate(d.getDate() + deltaDays);
  return d.toISOString().slice(0, 10);
}

// ============================================================
// CHANNEL FILTER HELPERS
// ============================================================

function esc_(s) {
  return String(s).replace(/'/g, "\\'");
}

// Classificação canônica de canal na player_metrics (utm de cadastro + medium + afiliado).
// Valores reais validados no schema (09/06/2026): source meta|google|ig|vazio;
// 'ig' é Meta quando medium começa com 'paid', senão é Instagram orgânico (Social Media).
function caseChannelExpr_() {
  return `CASE
    WHEN REGEXP_CONTAINS(LOWER(IFNULL(utm_cadastro_source, '')), r'meta|facebook|\\bfb\\b') THEN 'Meta'
    WHEN REGEXP_CONTAINS(LOWER(IFNULL(utm_cadastro_source, '')), r'^ig$|instagram')
         AND STARTS_WITH(LOWER(IFNULL(utm_cadastro_medium, '')), 'paid')                    THEN 'Meta'
    WHEN REGEXP_CONTAINS(LOWER(IFNULL(utm_cadastro_source, '')), r'google|adwords|youtube') THEN 'Google'
    WHEN REGEXP_CONTAINS(LOWER(IFNULL(utm_cadastro_source, '')), r'tiktok')                 THEN 'TikTok'
    WHEN REGEXP_CONTAINS(LOWER(IFNULL(utm_cadastro_source, '')), r'kwai')                   THEN 'Kwai'
    WHEN REGEXP_CONTAINS(LOWER(IFNULL(utm_cadastro_source, '')), r'^ig$|instagram')
         OR LOWER(IFNULL(utm_cadastro_medium, '')) = 'social'                               THEN 'Social Media'
    WHEN afiliado_nome IS NOT NULL AND afiliado_nome != ''                                  THEN 'Afiliados'
    WHEN utm_cadastro_source IS NULL OR utm_cadastro_source = ''                            THEN 'Orgânico (sem atribuição)'
    ELSE 'Outros'
  END`;
}

// WHERE extra pra queries em player_metrics
function pmWhere_(filter) {
  if (filter.channel) return `AND ${caseChannelExpr_()} = '${esc_(filter.channel)}'`;
  if (filter.scope === 'growth') {
    const list = GROWTH_CHANNELS.map(c => `'${esc_(c)}'`).join(', ');
    return `AND ${caseChannelExpr_()} IN (${list})`;
  }
  return '';
}

// WHERE extra pra tabelas com coluna platform (performance, cohort views)
function platformWhere_(filter, col) {
  if (!filter.channel) return ''; // growth é tratado em JS (invest/spend > 0)
  const c = filter.channel.toLowerCase();
  if (c.indexOf('orgânico') === 0 || c.indexOf('organico') === 0) {
    return `AND (${col} IS NULL OR ${col} = '')`;
  }
  const rx = {
    'meta': 'meta|facebook|fb|instagram',
    'google': 'google|adwords|youtube',
    'tiktok': 'tiktok',
    'kwai': 'kwai',
    'afiliados': 'afiliad',
    'social media': 'social|influencer',
  }[c];
  if (rx) return `AND REGEXP_CONTAINS(LOWER(IFNULL(${col}, '')), r'${rx}')`;
  return `AND LOWER(IFNULL(${col}, '')) = '${esc_(c)}'`;
}

// SQL: normaliza a coluna `platform` (cohort/performance usam meta_ads, google_ads,
// social_media, programatica, kwai_ads...) pros mesmos labels da player_metrics.
function platformLabelExpr_(col) {
  return `CASE
    WHEN REGEXP_CONTAINS(LOWER(IFNULL(${col}, '')), r'meta|facebook|instagram') THEN 'Meta'
    WHEN REGEXP_CONTAINS(LOWER(IFNULL(${col}, '')), r'google|youtube')          THEN 'Google'
    WHEN REGEXP_CONTAINS(LOWER(IFNULL(${col}, '')), r'tiktok')                  THEN 'TikTok'
    WHEN REGEXP_CONTAINS(LOWER(IFNULL(${col}, '')), r'kwai')                    THEN 'Kwai'
    WHEN REGEXP_CONTAINS(LOWER(IFNULL(${col}, '')), r'program')                 THEN 'Programática'
    WHEN REGEXP_CONTAINS(LOWER(IFNULL(${col}, '')), r'social|influencer')       THEN 'Social Media'
    WHEN REGEXP_CONTAINS(LOWER(IFNULL(${col}, '')), r'afili')                   THEN 'Afiliados'
    WHEN ${col} IS NULL OR ${col} = ''                                         THEN 'Orgânico (sem atribuição)'
    ELSE 'Outros'
  END`;
}

// JS: mesma normalização pros valores de platform que chegam em JS
function normalizeChannel_(raw) {
  const s = String(raw || '').toLowerCase();
  if (!s) return 'Orgânico (sem atribuição)';
  if (/meta|facebook|\bfb\b|instagram|\big\b/.test(s)) return 'Meta';
  if (/google|gads|adwords|youtube/.test(s)) return 'Google';
  if (/tiktok/.test(s)) return 'TikTok';
  if (/kwai/.test(s)) return 'Kwai';
  if (/program/.test(s)) return 'Programática';
  if (/social|influencer/.test(s)) return 'Social Media';
  if (/afili/.test(s)) return 'Afiliados';
  return 'Outros';
}

// ============================================================
// PAYLOAD BUILDER
// ============================================================

function buildPayload_(fromParam, toParam, filter) {
  filter = filter || { channel: null, scope: 'all' };
  const w = windows_(fromParam, toParam);
  const warnings = [];
  const houseAgg  = safeQuery_('house',       () => queryHouseAggregates_(w, filter),       { mtd: {}, lm: {} }, warnings);
  const perfAgg   = safeQuery_('performance', () => queryPerformanceAggregates_(w, filter), { mtd: {}, lm: {} }, warnings);
  const retention = safeQuery_('retention',   () => queryRetention_(w, filter),             { house: { m0m1: null, m1m2: null, m3plus: null }, channels: null }, warnings);
  const channels  = safeQuery_('channels',    () => queryChannels_(w, filter),              null, warnings);
  const ggrChannels = safeQuery_('ggrChannels', () => queryGgrChannels_(w, filter),         null, warnings);
  const ggrPayback = getGgrPayback_(warnings); // safras maduras, independe dos slicers (cache diário)
  const dailyCohort = safeQuery_('dailyCohort', () => queryDailyCohort_(w, filter), null, warnings);
  const depM0 = safeQuery_('depM0', () => queryDepM0_(w, filter), { total: null, growth: null, m1Total: null, m1Growth: null, channels: null }, warnings);
  const rolloverMatrix = safeQuery_('rolloverMatrix', () => queryRolloverMatrix_(w, filter), null, warnings);

  const mtd = houseAgg.mtd;
  const lm = houseAgg.lm;
  const pmtd = perfAgg.mtd;
  const plm = perfAgg.lm;

  // REGRA APOSTOU: o "GGR" do negócio é a coluna ngr_total da player_metrics
  const roasFtdMtd = safeDiv_(pmtd.ftd_amount, pmtd.spend);
  const roasFtdLm  = safeDiv_(plm.ftd_amount,  plm.spend);
  const ggrPerDepMtd = safeDiv_(mtd.ngr, mtd.depositos);
  const ggrPerDepLm  = safeDiv_(lm.ngr,  lm.depositos);
  // Turnover/Hold/Rollover da casa toda via player_metrics (valor_apostas_*) —
  // mesma fonte de NGR/depósitos, então respeita o filtro de canal por inteiro
  const holdMtd = safeDiv_(mtd.ngr, mtd.turnover);
  const holdLm  = safeDiv_(lm.ngr,  lm.turnover);
  const ggrTrend = w.isNaturalMtd && mtd.ngr != null && w.daysElapsed
    ? mtd.ngr * (w.daysInMonth / w.daysElapsed)
    : null;
  const rolloverMtd = safeDiv_(mtd.turnover, mtd.depositos);
  const rolloverLm  = safeDiv_(lm.turnover,  lm.depositos);

  const M = {
    ftdAmount:  metric_('FTD Amount',  pmtd.ftd_amount, plm.ftd_amount, 'brl'),
    roasFtd:    metric_('ROAS FTD',    roasFtdMtd,      roasFtdLm,      'multiple'),
    invest:     metric_('Investimento', pmtd.spend,     plm.spend,      'brl'),
    retM0M1:    metric_('Retenção M0→M1', retention.house.m0m1, null, 'pct'),
    retM1M2:    metric_('Retenção M1→M2', retention.house.m1m2, null, 'pct'),
    retM3plus:  metric_('Retenção M3+',   retention.house.m3plus, null, 'pct'),
    depTotal:    metric_('Depósitos Totais', mtd.depositos, lm.depositos, 'brl'),
    depM0Total:  metric_('DEP M0 Total',     depM0.total,  depM0.m1Total,  'brl'),
    depM0Growth: metric_('DEP M0 Growth',    depM0.growth, depM0.m1Growth, 'brl'),
    ggr:        metric_('GGR Total',      mtd.ngr, lm.ngr, 'brl'),
    ggrPerDep:  metric_('GGR / Depósito', ggrPerDepMtd, ggrPerDepLm, 'pct'),
    ggrTrend:   metric_('Close Trend GGR', ggrTrend, null, 'brl'),
    turnover:   metric_('Turnover Total',           mtd.turnover, lm.turnover, 'brl'),
    hold:       metric_('Hold % (GGR / Turnover)',  holdMtd, holdLm, 'pct'),
    rollover:   metric_('Rollover (Turnover / Depósito)', rolloverMtd, rolloverLm, 'multiple'),
  };

  return {
    meta: {
      refDate: w.refDate,
      from: w.mtdStart, to: w.mtdEnd,
      lmFrom: w.lmStart, lmTo: w.lmEnd,
      daysInMonth: w.daysInMonth, daysElapsed: w.daysElapsed,
      isNaturalMtd: w.isNaturalMtd,
      filter: filter,
      generatedAt: new Date().toISOString(),
      source: 'BigQuery — live via Apps Script',
      warnings: warnings.length ? warnings : undefined,
    },
    metrics: M,
    channels: channels,                     // aquisição por canal — tbl_cohort_ftd_base
    retentionChannels: retention.channels,  // retenção de valor por canal — cohort wide monthly
    ggrChannels: ggrChannels,               // GGR (ngr) + ROAS GGR + freespin por canal — player_metrics
    ggrPayback: ggrPayback,                 // payback de GGR por canal (safras maduras 90d) — player_metrics
    dailyCohort: dailyCohort,               // safra de FTD por dia (D0/D1/W1 + Tx Passagem) — cohort base + player_metrics
    depM0Channels: depM0.channels,          // DEP M0 por canal — cohort wide monthly
    rolloverMatrix: rolloverMatrix,         // rollover canal × tipo de jogo — player_metrics
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

function queryHouseAggregates_(w, filter) {
  const sql = `
    SELECT
      IF(data_ref BETWEEN DATE '${w.mtdStart}' AND DATE '${w.mtdEnd}', 'mtd', 'lm') AS bucket,
      SUM(ggr_total)                                      AS ggr,
      SUM(ngr_total)                                      AS ngr,
      SUM(valor_depositos)                                AS depositos,
      COUNT(DISTINCT IF(qtd_depositos > 0, account_id, NULL)) AS depositantes_unicos,
      SUM(valor_bonus)                                    AS bonus,
      SUM(IFNULL(valor_apostas_casino, 0) + IFNULL(valor_apostas_esporte, 0) + IFNULL(valor_apostas_loteria, 0)) AS turnover
    FROM \`${PROJECT_ID}.dados_clickhouse.player_metrics\`
    WHERE data_ref BETWEEN DATE '${w.lmStart}' AND DATE '${w.mtdEnd}'
      ${pmWhere_(filter)}
    GROUP BY bucket
  `;
  const rows = runQuery_(sql);
  return splitByWindow_(rows, ['ggr', 'ngr', 'depositos', 'depositantes_unicos', 'bonus', 'turnover']);
}

function queryPerformanceAggregates_(w, filter) {
  // Tabela só tem mídia paga — scope growth não precisa de filtro extra
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
      ${platformWhere_(filter, 'platform')}
    GROUP BY bucket
  `;
  const rows = runQuery_(sql);
  return splitByWindow_(rows, ['spend', 'ftd_qty', 'ftd_amount', 'dep_d0', 'turnover']);
}

function queryChannels_(w, filter) {
  // Aquisição por canal — tbl_cohort_ftd_base (platform cobre pago + orgânico/social).
  // FTD/spend pertencem à linha do dia 0 (dia do FTD) — filtrar evita dupla contagem.
  const sql = `
    SELECT
      ${platformLabelExpr_('platform')} AS channel,
      SUM(spend)           AS spend_sum,
      SUM(qtd_ftd)         AS ftd_qty,
      SUM(amount_ftd)      AS ftd_amount,
      SUM(amount_deposito) AS dep_d0
    FROM \`${PROJECT_ID}.analytics_cohorts.tbl_cohort_ftd_base\`
    WHERE periodo BETWEEN DATE '${w.mtdStart}' AND DATE '${w.mtdEnd}'
      AND days_since_ftd = 0
      ${platformWhere_(filter, 'platform')}
    GROUP BY channel
  `;
  const rows = runQuery_(sql);
  if (!rows.length) return null;

  let channels = rows.map(r => {
    const spend = numOrNull_(r.spend_sum);
    return {
      channel:   r.channel,
      spend:     spend > 0 ? spend : null,
      ftdQty:    numOrNull_(r.ftd_qty),
      ftdAmount: numOrNull_(r.ftd_amount),
      depD0:     numOrNull_(r.dep_d0),
    };
  }).filter(c => (c.ftdQty || 0) > 0 || c.spend != null);

  if (filter.scope === 'growth' && !filter.channel) {
    channels = channels.filter(c => c.spend != null);
  }

  return channels.sort((a, b) => {
    const aPaid = a.spend != null, bPaid = b.spend != null;
    if (aPaid !== bPaid) return aPaid ? -1 : 1;
    if (aPaid) return b.spend - a.spend;
    return (b.ftdAmount || 0) - (a.ftdAmount || 0);
  });
}

function queryRetention_(w, filter) {
  // Retenção de VALOR depositado (R$) — NÃO acumulada, mês contra mês (MTD cru).
  // Cada linha olha uma safra pela sua idade no mês de referência:
  //   M0→M1 = safra idade 1 (mês anterior): _1 (dep. neste mês) ÷ _0 (dep. mês anterior)
  //   M1→M2 = safra idade 2: _2 ÷ _1
  //   M3+   = pool idade ≥3: Σ dep. neste mês (_age) ÷ Σ dep. mês anterior (_age-1)
  const refMonth = w.mtdStart.slice(0, 7) + '-01';

  const ages = [];
  for (let a = 3; a <= 23; a++) ages.push(a);
  const caseThis = ages.map(a => `WHEN ${a} THEN _${a}`).join(' ');
  const casePrev = ages.map(a => `WHEN ${a} THEN _${a - 1}`).join(' ');

  const sql = `
    WITH base AS (
      SELECT
        ${platformLabelExpr_('platform')} AS channel,
        DATE_DIFF(DATE '${refMonth}', DATE(cohort_month), MONTH) AS age,
        *
      FROM \`${PROJECT_ID}.analytics_cohorts.vw_cohort_deposito_amount_wide_monthly\`
      WHERE cohort_month >= "2025-01-01" AND cohort_month <= "${refMonth}"
        ${platformWhere_(filter, 'platform')}
    )
    SELECT
      channel,
      SUM(IF(age = 1, _0, 0)) AS m0_total,
      SUM(valor_investido) AS invest,
      SUM(IF(age = 1, _1, 0)) AS n1,
      SUM(IF(age = 1, _0, 0)) AS d1,
      SUM(IF(age = 2, _2, 0)) AS n2,
      SUM(IF(age = 2, _1, 0)) AS d2,
      SUM(CASE age ${caseThis} ELSE 0 END) AS n3,
      SUM(CASE age ${casePrev} ELSE 0 END) AS d3
    FROM base
    GROUP BY channel
  `;
  let rows = runQuery_(sql);
  if (!rows.length) return { house: { m0m1: null, m1m2: null, m3plus: null }, channels: null };

  if (filter.scope === 'growth' && !filter.channel) {
    rows = rows.filter(r => (numOrNull_(r.invest) || 0) > 0);
  }

  const acc = { n1: 0, d1: 0, n2: 0, d2: 0, n3: 0, d3: 0 };
  const channels = rows.map(r => {
    ['n1','d1','n2','d2','n3','d3'].forEach(k => { acc[k] += numOrNull_(r[k]) || 0; });
    return {
      channel: r.channel,
      m0Total: numOrNull_(r.m0_total),
      m0m1:   safeDiv_(numOrNull_(r.n1), numOrNull_(r.d1)),
      m1m2:   safeDiv_(numOrNull_(r.n2), numOrNull_(r.d2)),
      m3plus: safeDiv_(numOrNull_(r.n3), numOrNull_(r.d3)),
      // numeradores/denominadores brutos — o front usa pra linha Total exata
      nd: {
        n1: numOrNull_(r.n1), d1: numOrNull_(r.d1),
        n2: numOrNull_(r.n2), d2: numOrNull_(r.d2),
        n3: numOrNull_(r.n3), d3: numOrNull_(r.d3),
      },
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

function queryGgrChannels_(w, filter) {
  // REGRA APOSTOU: GGR do negócio = ngr_total. Canal = atribuição de cadastro.
  // Spend (ROAS GGR) da performance, casado por canal normalizado.
  const ggrSql = `
    SELECT
      ${caseChannelExpr_()} AS channel,
      SUM(ngr_total)           AS ngr,
      SUM(valor_wins_freespin) AS freespin
    FROM \`${PROJECT_ID}.dados_clickhouse.player_metrics\`
    WHERE data_ref BETWEEN DATE '${w.mtdStart}' AND DATE '${w.mtdEnd}'
      ${pmWhere_(filter)}
    GROUP BY channel
  `;
  const spendSql = `
    SELECT
      ${platformLabelExpr_('platform')} AS channel,
      SUM(spend) AS spend_sum
    FROM \`${PROJECT_ID}.analytics_performance.tbl_performance_daily\`
    WHERE report_date BETWEEN DATE '${w.mtdStart}' AND DATE '${w.mtdEnd}'
      ${platformWhere_(filter, 'platform')}
    GROUP BY channel
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
    const spend = numOrNull_(r.spend_sum);
    if (!(spend > 0)) return;
    const ch = r.channel;
    byChannel[ch] = byChannel[ch] || { channel: ch, ggr: null, spend: null, freespin: null };
    byChannel[ch].spend = (byChannel[ch].spend || 0) + spend;
  });

  let channels = Object.values(byChannel);
  if (filter.scope === 'growth' && !filter.channel) {
    channels = channels.filter(c => GROWTH_CHANNELS.indexOf(c.channel) >= 0);
  }

  return channels.sort((a, b) => {
    const aPaid = a.spend != null, bPaid = b.spend != null;
    if (aPaid !== bPaid) return aPaid ? -1 : 1;
    if (aPaid) return b.spend - a.spend;
    return (b.ggr || 0) - (a.ggr || 0);
  });
}

// ------------------------------------------------------------
// GGR PAYBACK por canal — em quantos dias o GGR (NGR) acumulado da safra
// cobre o investimento. Base: safras MADURAS (FTD ≥ 90 dias atrás), horizonte 90d.
// Independe dos slicers → computado 1×/dia e guardado em ScriptProperties (custo baixo).
// ------------------------------------------------------------
const PAYBACK_HORIZON_DAYS = 90;

function getGgrPayback_(warnings) {
  const asOf = windows_(null, null).mtdEnd; // ontem, mesma convenção do dashboard
  const props = PropertiesService.getScriptProperties();
  try {
    const raw = props.getProperty('ggrPayback');
    if (raw) {
      const obj = JSON.parse(raw);
      if (obj && obj.asOf === asOf && obj.data) return obj.data; // já computado hoje
    }
  } catch (e) { /* cache corrompido → recomputa */ }

  const data = safeQuery_('ggrPayback', () => queryGgrPayback_(asOf), null, warnings);
  if (data) {
    try { props.setProperty('ggrPayback', JSON.stringify({ asOf: asOf, data: data })); } catch (e) {}
  }
  return data;
}

function queryGgrPayback_(asOf) {
  const H = PAYBACK_HORIZON_DAYS;
  const cohortEnd   = shiftISO_(asOf, -H);         // FTD ≤ asOf-90 → ≥90d de maturidade
  const cohortStart = shiftISO_(asOf, -(H + 90));  // safras de uma janela de 90 dias (asOf-180..asOf-90)

  // NGR por canal × idade da safra (0..H). Atribuição = utm de cadastro (mesma da aba GGR).
  const ngrSql = `
    WITH ftd AS (
      SELECT
        account_id,
        MIN(data_ref)                  AS ftd_date,
        ANY_VALUE(utm_cadastro_source) AS utm_cadastro_source,
        ANY_VALUE(utm_cadastro_medium) AS utm_cadastro_medium,
        ANY_VALUE(afiliado_nome)       AS afiliado_nome
      FROM \`${PROJECT_ID}.dados_clickhouse.player_metrics\`
      WHERE qtd_ftd > 0
        AND data_ref BETWEEN DATE '${cohortStart}' AND DATE '${cohortEnd}'
      GROUP BY account_id
    ),
    labeled AS (
      SELECT account_id, ftd_date, ${caseChannelExpr_()} AS channel
      FROM ftd
    ),
    activity AS (
      SELECT
        l.channel,
        DATE_DIFF(pm.data_ref, l.ftd_date, DAY) AS age,
        SUM(pm.ngr_total)                       AS ngr
      FROM \`${PROJECT_ID}.dados_clickhouse.player_metrics\` pm
      JOIN labeled l USING (account_id)
      WHERE pm.data_ref BETWEEN DATE '${cohortStart}' AND DATE '${asOf}'
        AND DATE_DIFF(pm.data_ref, l.ftd_date, DAY) BETWEEN 0 AND ${H}
      GROUP BY channel, age
    )
    SELECT channel, age, ngr FROM activity ORDER BY channel, age
  `;

  // Investimento da safra = mídia paga gasta na janela de aquisição (mesma janela do FTD).
  const spendSql = `
    SELECT ${platformLabelExpr_('platform')} AS channel, SUM(spend) AS spend_sum
    FROM \`${PROJECT_ID}.analytics_performance.tbl_performance_daily\`
    WHERE report_date BETWEEN DATE '${cohortStart}' AND DATE '${cohortEnd}'
    GROUP BY channel
  `;

  const ngrRows = runQuery_(ngrSql);
  const spendRows = runQuery_(spendSql);

  const spendByCh = {};
  spendRows.forEach(r => {
    const s = numOrNull_(r.spend_sum);
    if (s > 0) spendByCh[r.channel] = (spendByCh[r.channel] || 0) + s;
  });

  const ageByCh = {};
  ngrRows.forEach(r => {
    const age = numOrNull_(r.age);
    if (age == null) return;
    const ch = r.channel;
    (ageByCh[ch] = ageByCh[ch] || {})[age] = (ageByCh[ch][age] || 0) + (numOrNull_(r.ngr) || 0);
  });

  // payback = 1º dia em que GGR acumulado ≥ investimento. Só canais com investimento.
  function paybackOf(spend, ages) {
    let cum = 0, payback = null;
    for (let a = 0; a <= H; a++) {
      cum += ages[a] || 0;
      if (payback === null && cum >= spend) payback = a;
    }
    return { paybackDays: payback, reached: payback !== null, spend: spend, ggrH: cum, roasH: spend > 0 ? cum / spend : null };
  }

  const byChannel = {};
  Object.keys(spendByCh).forEach(ch => {
    byChannel[ch] = paybackOf(spendByCh[ch], ageByCh[ch] || {});
  });

  // "Casa" = todos os canais pagos combinados (curva agregada vs investimento total)
  const totalAge = {};
  let totalSpend = 0;
  Object.keys(spendByCh).forEach(ch => {
    totalSpend += spendByCh[ch];
    const ages = ageByCh[ch] || {};
    Object.keys(ages).forEach(a => { totalAge[a] = (totalAge[a] || 0) + ages[a]; });
  });

  return {
    horizonDays: H,
    cohortFrom: cohortStart,
    cohortTo: cohortEnd,
    asOf: asOf,
    byChannel: byChannel,
    total: totalSpend > 0 ? paybackOf(totalSpend, totalAge) : null,
  };
}

function queryDailyCohort_(w, filter) {
  // Safra de FTD por dia (aba Safras Diárias). Segue os slicers de canal + data.
  // Fontes: (1) cohort base = valores D0/D1/W1 + FTD#/$ + retenções (bate com o print do Luis);
  //         (2) player_metrics por dia = cadastros + FTDs same-day;
  //         (3) player_metrics com join de safra = qtd de DEPÓSITOS (transações) no D0 e D1, p/ tickets.
  const from = w.mtdStart, to = w.mtdEnd;

  const cohortSql = `
    SELECT
      periodo AS d,
      MAX(days_since_ftd)                                          AS max_age,
      SUM(IF(days_since_ftd = 0, qtd_ftd, 0))                      AS ftd_qty,
      SUM(IF(days_since_ftd = 0, amount_ftd, 0))                   AS ftd_amt,
      SUM(IF(days_since_ftd = 0, amount_deposito, 0))              AS d0,
      SUM(IF(days_since_ftd = 1, amount_deposito, 0))              AS d1,
      SUM(IF(days_since_ftd BETWEEN 1 AND 7, amount_deposito, 0))  AS w1
    FROM \`${PROJECT_ID}.analytics_cohorts.tbl_cohort_ftd_base\`
    WHERE periodo BETWEEN DATE '${from}' AND DATE '${to}'
      ${platformWhere_(filter, 'platform')}
    GROUP BY d
    ORDER BY d
  `;
  // Cadastros do dia + FTDs que cadastraram e depositaram no mesmo dia (same-day).
  const regSql = `
    SELECT
      data_ref AS d,
      SUM(qtd_registro) AS registros,
      SUM(IF(qtd_ftd > 0 AND DATE(data_cadastro) = data_ref, qtd_ftd, 0)) AS sameday_ftd
    FROM \`${PROJECT_ID}.dados_clickhouse.player_metrics\`
    WHERE data_ref BETWEEN DATE '${from}' AND DATE '${to}'
      ${pmWhere_(filter)}
    GROUP BY d
  `;
  // qtd de DEPÓSITOS (transações, inclui o FTD) no D0 e no D1, por data de FTD.
  const cntSql = `
    WITH ftd AS (
      SELECT
        account_id,
        MIN(data_ref)                  AS ftd_date,
        ANY_VALUE(utm_cadastro_source) AS utm_cadastro_source,
        ANY_VALUE(utm_cadastro_medium) AS utm_cadastro_medium,
        ANY_VALUE(afiliado_nome)       AS afiliado_nome
      FROM \`${PROJECT_ID}.dados_clickhouse.player_metrics\`
      WHERE qtd_ftd > 0 AND data_ref BETWEEN DATE '${from}' AND DATE '${to}'
        ${pmWhere_(filter)}
      GROUP BY account_id
    ),
    labeled AS ( SELECT account_id, ftd_date FROM ftd )
    SELECT
      l.ftd_date AS d,
      SUM(IF(DATE_DIFF(pm.data_ref, l.ftd_date, DAY) = 0, pm.qtd_depositos, 0)) AS d0_cnt,
      SUM(IF(DATE_DIFF(pm.data_ref, l.ftd_date, DAY) = 1, pm.qtd_depositos, 0)) AS d1_cnt
    FROM \`${PROJECT_ID}.dados_clickhouse.player_metrics\` pm
    JOIN labeled l USING (account_id)
    WHERE pm.data_ref BETWEEN DATE '${from}' AND DATE_ADD(DATE '${to}', INTERVAL 1 DAY)
      AND DATE_DIFF(pm.data_ref, l.ftd_date, DAY) BETWEEN 0 AND 1
    GROUP BY d
  `;

  const cohortRows = runQuery_(cohortSql);
  if (!cohortRows.length) return null;
  const regRows = runQuery_(regSql);
  const cntRows = runQuery_(cntSql);

  const regByDate = {}, cntByDate = {};
  regRows.forEach(r => { regByDate[r.d] = { reg: numOrNull_(r.registros) || 0, sameday: numOrNull_(r.sameday_ftd) || 0 }; });
  cntRows.forEach(r => { cntByDate[r.d] = { d0: numOrNull_(r.d0_cnt) || 0, d1: numOrNull_(r.d1_cnt) || 0 }; });

  let tFtdQty = 0, tFtdAmt = 0, tD0 = 0, tD1 = 0, tW1 = 0, tReg = 0, tSameday = 0, tD0cnt = 0, tD1cnt = 0;
  const rows = cohortRows.map(r => {
    const maxAge = numOrNull_(r.max_age);
    const ftdQty = numOrNull_(r.ftd_qty) || 0;
    const ftdAmt = numOrNull_(r.ftd_amt) || 0;
    const d0 = numOrNull_(r.d0) || 0;
    const matured = maxAge != null && maxAge >= 1; // safra já tem ao menos o dia 1
    const d1 = matured ? (numOrNull_(r.d1) || 0) : null;
    const w1 = matured ? (numOrNull_(r.w1) || 0) : null;
    const rg = regByDate[r.d] || { reg: 0, sameday: 0 };
    const ct = cntByDate[r.d] || { d0: 0, d1: 0 };

    tFtdQty += ftdQty; tFtdAmt += ftdAmt; tD0 += d0; tReg += rg.reg; tSameday += rg.sameday; tD0cnt += ct.d0;
    if (d1 != null) { tD1 += d1; tD1cnt += ct.d1; }
    if (w1 != null) tW1 += w1;

    return {
      date:    r.d,
      txPass:  rg.reg > 0 ? ftdQty / rg.reg : null,
      txPassSD: rg.reg > 0 ? rg.sameday / rg.reg : null,
      ftdQty:  ftdQty,
      ftdAmt:  ftdAmt,
      d0:      d0,
      tktD0:   ct.d0 > 0 ? d0 / ct.d0 : null,
      d1:      d1,
      tktD1:   (d1 != null && ct.d1 > 0) ? d1 / ct.d1 : null,
      retD1:   (d1 != null && d0 > 0) ? d1 / d0 : null,
      w1:      w1,
      retW1:   (w1 != null && d0 > 0) ? w1 / d0 : null,
    };
  });

  const totals = {
    txPass:   tReg > 0 ? tFtdQty / tReg : null,
    txPassSD: tReg > 0 ? tSameday / tReg : null,
    ftdQty:   tFtdQty,
    ftdAmt:   tFtdAmt,
    d0:       tD0,
    tktD0:    tD0cnt > 0 ? tD0 / tD0cnt : null,
    d1:       tD1,
    tktD1:    tD1cnt > 0 ? tD1 / tD1cnt : null,
    retD1:    tD0 > 0 ? tD1 / tD0 : null,
    w1:       tW1,
    retW1:    tD0 > 0 ? tW1 / tD0 : null,
  };

  const channelLabel = filter.channel
    ? filter.channel
    : (filter.scope === 'growth' ? 'Canais Growth' : 'Total Casa');

  return { channelLabel: channelLabel, totals: totals, rows: rows };
}

function queryDepM0_(w, filter) {
  // DEP M0 por canal — safra do mês de referência (e mês anterior pro Δ M-1).
  // "Growth" = canais com investimento (valor_investido > 0).
  const refMonth = w.mtdStart.slice(0, 7) + '-01';
  const lmMonth = w.lmStart.slice(0, 7) + '-01';
  const sql = `
    SELECT
      IF(DATE(cohort_month) = DATE '${refMonth}', 'mtd', 'lm') AS bucket,
      ${platformLabelExpr_('platform')} AS channel,
      SUM(amount_deposito_m0) AS dep_m0,
      SUM(valor_investido)    AS invest
    FROM \`${PROJECT_ID}.analytics_cohorts.vw_cohort_deposito_amount_wide_monthly\`
    WHERE DATE(cohort_month) IN (DATE '${refMonth}', DATE '${lmMonth}')
      ${platformWhere_(filter, 'platform')}
    GROUP BY bucket, channel
  `;
  const rows = runQuery_(sql);
  if (!rows.length) return { total: null, growth: null, m1Total: null, m1Growth: null, channels: null };

  const growthOnly = filter.scope === 'growth' && !filter.channel;
  let total = 0, growth = 0, m1Total = 0, m1Growth = 0;
  const channels = [];
  rows.forEach(r => {
    const dep = numOrNull_(r.dep_m0) || 0;
    const invest = numOrNull_(r.invest) || 0;
    const isPaid = invest > 0;
    if (growthOnly && !isPaid) return;
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

function queryRolloverMatrix_(w, filter) {
  // Rollover (turnover/depósito) por canal × tipo de jogo — player_metrics.
  // Turnover por vertical = valor_apostas_* (schema validado 09/06/2026).
  const sql = `
    SELECT
      ${caseChannelExpr_()} AS channel,
      SUM(valor_apostas_esporte) AS t_sports,
      SUM(valor_apostas_casino)  AS t_casino,
      SUM(valor_apostas_loteria) AS t_loteria,
      SUM(valor_depositos)       AS depositos
    FROM \`${PROJECT_ID}.dados_clickhouse.player_metrics\`
    WHERE data_ref BETWEEN DATE '${w.mtdStart}' AND DATE '${w.mtdEnd}'
      ${pmWhere_(filter)}
    GROUP BY channel
  `;
  const rows = runQuery_(sql);
  if (!rows.length) return null;

  let list = rows.map(r => {
    const dep = numOrNull_(r.depositos);
    const sports = numOrNull_(r.t_sports) || 0;
    const casino = numOrNull_(r.t_casino) || 0;
    const loteria = numOrNull_(r.t_loteria) || 0;
    const div = (v) => (dep != null && dep > 0 ? v / dep : null);
    return {
      channel: r.channel,
      values: [div(sports), div(casino), div(loteria)],
      total: div(sports + casino + loteria),
      weight: dep, // depósitos — o front usa pra linha Total ponderada
    };
  }).filter(r => r.weight != null && r.weight > 0); // sem depósito → rollover indefinido

  if (filter.scope === 'growth' && !filter.channel) {
    list = list.filter(r => GROWTH_CHANNELS.indexOf(r.channel) >= 0);
  }

  list.sort((a, b) => (b.weight || 0) - (a.weight || 0));

  return {
    columns: ['Sports', 'Casino', 'Loteria'],
    rows: list,
  };
}

// ============================================================
// BIGQUERY HELPER
// ============================================================

function runQuery_(sql) {
  const request = { query: sql, useLegacySql: false, timeoutMs: 60000 };
  const queryResults = BigQuery.Jobs.query(request, PROJECT_ID);
  const jobId = queryResults.jobReference.jobId;

  let result = queryResults;
  let attempts = 0;
  while (!result.jobComplete && attempts < 30) {
    Utilities.sleep(2000);
    result = BigQuery.Jobs.getQueryResults(PROJECT_ID, jobId);
    attempts++;
  }
  if (!result.jobComplete) throw new Error('BigQuery job timeout: ' + jobId);

  const fields = (result.schema && result.schema.fields) || [];
  return (result.rows || []).map(row => {
    const out = {};
    row.f.forEach((cell, i) => { out[fields[i].name] = cell.v; });
    return out;
  });
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
// SETUP / DEBUG
// ============================================================

function setup() {
  const result = BigQuery.Jobs.query(
    { query: 'SELECT 1 AS ok', useLegacySql: false, timeoutMs: 30000 },
    PROJECT_ID
  );
  Logger.log('BigQuery OK: ' + JSON.stringify(result.rows));
}

function previewPayload() {
  Logger.log(JSON.stringify(buildPayload_(null, null, { channel: null, scope: 'all' }), null, 2));
}
