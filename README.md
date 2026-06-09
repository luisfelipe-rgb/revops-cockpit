# RevOps Cockpit

Custom revenue dashboard for Apostou — single-file React port of the Farol report, deployable to GitHub Pages.

## Stack
- React 18 + Babel standalone (CDN, no build step)
- Custom CSS (preto puro + acentos verde/amarelo/vermelho/azul/roxo)

## Current state (v0.3)
Tabbed UI — informação distribuída em 5 abas, números grandes e farol visual em cada KPI:

- **Aquisições** — FTD $, FTD Qty, D0 $, ROAS FTD, ROAS DEP D0, Investimento + composição da base
- **Retenções** — M0→M1, M1→M2, M3+ + margem GGR/Dep por safra
- **Depósitos** — Depósitos Totais, DEP M0 Total/Growth + composição (Novos/Recorrentes/Reativados) + detalhe
- **GGR** — GGR Total, GGR/Dep, FreeSpins/Dep, Bonif. + cluster por safra
- **Apostas · Turnover** — Turnover, Hold %, Apostadores, Bets/Usuário, Stake + breakdown por vertical *(dados mock)*

### Bandas do Farol
Aplicadas em cada `% vs BP`:
- ≥ 95% → 🟢 verde
- 85 – 94% → 🟡 amarelo
- < 85% → 🔴 vermelho

Para `Trend vs BP`: verde positivo, vermelho negativo (binário).

### Dados
Mock inline (snapshot de 22/05/2026, mesmo shape do `farol-data.js` original). Veja a constante `DATA` em `index.html`.

## Next (v0.3)
- View Daily (D-1) — já cabe na estrutura, só precisa do dado
- Wire-up `analytics_cohorts.Metrics_RevOps` (camada thin Cloud Function → JSON, browser não fala BQ direto)
- Toggle de canal (Todos / Growth / Orgânico) — estrutura HTML já existe no farol original
- Period selector (MTD / últimos 7 / últimos 30 / custom)

## Run locally
Abre `index.html` no browser. Sem build, sem servidor.

## Deploy
Push para `main`, ativa GitHub Pages (Settings → Pages → Deploy from branch → `main` / root). `.nojekyll` já está no repo.
