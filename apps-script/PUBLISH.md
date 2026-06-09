# Publicar o Apps Script — roteiro

Você só precisa fazer isso uma vez. Depois é só copiar a URL final e colar no `index.html`.

## 1. Criar o projeto

1. Abre **https://script.google.com** com a sua conta Google (a mesma que tem acesso ao projeto BQ `db-clickhouse`).
2. Clica em **"+ Novo projeto"**.
3. Renomeia o projeto (em cima, "Untitled project") para **`RevOps Cockpit — Backend`**.

## 2. Colar os arquivos

1. No editor da esquerda, **substitui todo o conteúdo do `Code.gs`** pelo conteúdo de `apps-script/Code.gs` deste repo.
2. Clica no ícone de engrenagem **"Configurações do projeto"** (esquerda inferior).
3. Marca **"Mostrar o arquivo de manifesto `appsscript.json` no editor"**.
4. Volta pro editor (ícone `<>`). Agora aparece um `appsscript.json`. Cola o conteúdo de `apps-script/appsscript.json` neste repo.

## 3. Habilitar BigQuery

1. No editor, lateral esquerda: ícone **"Serviços"** (sinal de `+` ao lado).
2. Procura **BigQuery API** → seleciona → **Adicionar**.
3. Verifica que o "Identificador" ficou como **`BigQuery`** (com B maiúsculo). Se vier diferente, renomeia.

## 4. Conectar ao projeto GCP `db-clickhouse`

Esse é o passo que evita "BigQuery is not enabled for this project":

1. No script, abre **"Configurações do projeto"** → **"Projeto do Google Cloud"** → **"Alterar projeto"**.
2. Cola o número do projeto GCP `db-clickhouse`. (Pega em https://console.cloud.google.com → seletor de projeto → "Número do projeto".)
3. Confirma. O Apps Script agora roda as cobranças/cotas de BQ contra `db-clickhouse` (sem isso, dá erro de billing).

## 5. Rodar `setup()` uma vez para autorizar

1. No editor, no dropdown de funções (topo), seleciona **`setup`** → clica em **▶ Executar**.
2. Aparece um diálogo de permissões → "Revisar permissões" → escolhe sua conta → "Avançado" → "Acessar RevOps Cockpit — Backend (não verificado)" → **Permitir**.
3. Se rodar OK, no painel inferior deve aparecer algo como:
   ```
   Windows: {"mtdStart":"2026-06-01",...}
   BigQuery OK: [{"f":[{"v":"1"}]}]
   ```
4. Se der erro de "BigQuery: User does not have permission" → o usuário do script (você) precisa ter `roles/bigquery.user` (ou equivalente) no projeto `db-clickhouse`. Confirma no IAM.

## 6. (Opcional) Validar o payload completo

Mesmo dropdown → seleciona **`previewPayload`** → ▶ Executar. Demora ~10–30s (roda 4 queries reais). No log deve aparecer o JSON inteiro. Se algum campo vier `null` que não devia, me avisa.

## 7. Deploy como Web App

1. Topo direito → **Deploy** → **Nova implantação**.
2. Tipo: **Web app**.
3. Description: `v1`.
4. Execute as: **Eu (seu email)**.
5. Who has access: **Somente eu** (mais seguro, single user) OU **Usuários específicos** (lista de emails).
6. Clica **Deploy**. Autoriza de novo se pedir.
7. **Copia a "URL do web app"** — é algo tipo `https://script.google.com/macros/s/AKfycb.../exec`.

## 8. Plugar no dashboard

Abre `index.html` (raiz do repo). No topo do `<script>`, troca:

```js
const ENDPOINT_URL = null;  // ← cola sua URL aqui (entre aspas)
```

por:

```js
const ENDPOINT_URL = 'https://script.google.com/macros/s/AKfycb.../exec';
```

Commit + push. Pronto.

## 9. Para forçar refresh (bypass do cache de 15 min)

Adicione `?refresh=true` no fim da URL no momento que quiser furar o cache:
```
https://script.google.com/macros/s/AKfycb.../exec?refresh=true
```

---

## Próximos passos (quando estiver funcionando)

- **BP do Excel**: você compartilha o arquivo, eu adiciono uma função `queryBpFromSheet_()` que lê uma planilha Google Sheets espelho do Excel (ou eu leio o Excel direto se publicar como JSON).
- **Cluster Depósitos (Novos/Recor./Reativ.)**: adicionar query contra `vw_cohort_deposito_amount_wide` somando _0 por tipo.
- **Verticais (Sports/Slots/Live)**: depende de existir uma coluna de vertical em `player_metrics` — me avisa qual coluna usar (ex.: `ggr_casino`, `ggr_esporte`, `ggr_loteria`).
