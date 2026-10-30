# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Start the chat server (main web UI on port 3000)
npm run chat

# Build the MCP server TypeScript to dist/
npm run build

# Run the compiled MCP server over stdio (for Claude Desktop)
npm start

# Run the MCP server in dev mode (ts-node, no build needed)
npm run dev
```

There are no test scripts. The project uses Node.js ≥18 with ES modules (`"type": "module"`).

## Architecture Overview

This project has **two separate runtimes** that can run independently:

### 1. MCP Server (`src/server.ts` → `dist/server.js`)
A TypeScript MCP server that exposes SAP B1 Service Layer operations as Claude tools over **stdio**. It is designed to be listed in `claude_desktop_config.json`. It has its own session management, authenticates to SAP B1's `/Login` endpoint, and auto-renews B1SESSION cookies on 401. All 57+ tools live here.

### 2. Chat Server (`chat-server.mjs`)
A large (~6100 line) Express.js web application. It:
- Launches the MCP server as a **child process** via `StdioClientTransport` and proxies tool calls through it
- Serves `public/index.html` — a Fiori-style single-page chat UI with embedded panels for all agents
- Has its own NLP layer (`detectIntent` → `nlpQuery`) that intercepts common queries **before** sending them to AI, returning structured results without an LLM call
- Manages multi-company SAP connections stored in SQLite (`hanny.db` via `db.mjs`)
- Handles auth via token-based sessions stored in SQLite

### Message processing pipeline in `chat-server.mjs`

```
User message
  → detectIntent()        # local regex NLP — handles stock/BP/sales/AR etc.
  → nlpQuery()            # nlp-engine.mjs — broader entity matching
  → demoReply()           # If no match: "I didn't understand"
  OR
  → AI (Claude/GPT-4o/Azure) + MCP tools via child process
```

The **AI engine** is selected by the `engine` field in the chat request body: `standard` (Anthropic), `claude`, `gpt4o`, `db` (DB Direct SQL). `USE_AI` is `false` when no API keys are set, causing the NLP path to handle all queries.

### Controllers (`controllers/*.mjs`)

Each controller exports a `create*Router(deps)` factory that receives injected dependencies from `chat-server.mjs` (SAP client, AI helpers, auth middleware). All are mounted under `/api/`:

| Controller | Mount point | Purpose |
|---|---|---|
| `pr-agent.mjs` | `/api/pr-agent` | Conversational Purchase Request wizard (state machine) |
| `pr-to-po-agent.mjs` | `/api/pr-to-po` | Convert open PRs → Purchase Order |
| `po-to-grpo-agent.mjs` | `/api/po-to-grpo` | Receive an open PO as a GRPO (shared `lib/copy-doc-flow.mjs`, `receive` mode): vendor → PO → lines (qty, price, disc, tax, warehouse), create batches/serials, receiving bins, "+ Add Line" for substitute items |
| `grpo-sorting-agent.mjs` | `/api/grpo-sorting` | GRPO Sorting: load last-month GRPO lines (OPDN/PDN1) into SQLite `sorting_tasks`; sorters clock in/out (`sorting_shifts`), get auto-assigned queues, start/pause/complete lines (`sorting_work` intervals); user-wise / item-wise time reports. Mirrors every line to SAP UDT `@SORTING` (Service Layer `/U_SORTING`, Code `DocEntry-LineNum`) via a background sync (`sap_dirty`); U_USER comes from the sorter's mapped OHEM employee. Demo data (app + SAP, users nik/josh/tom/kevin/pedro): `scripts/sorting-demo-data.mjs [--delete]` (UI: `public/grpo-sorting.html`, iframe `#grpo-sorting-panel`) |
| `sorting-analytics-agent.mjs` | `/api/sorting-analytics` | Sorting Analytics: read-only analytics over SAP UDT `@SORTING` (no clock-in data) — KPIs, sorter scorecard, working window, hour × sorter heatmap, item/vendor/bin breakdowns, open backlog, AI brief (UI: `public/sorting-analytics.html`, iframe `#sorting-analytics-panel`) |
| `putaway-analytics-agent.mjs` | `/api/putaway-analytics` | Putaway Analytics: read-only analytics over SAP Document UDO `STTL_PUTAWAY` (`@STTL_OPTW` header / `@STTL_PTW1` rows, joined to `@SORTING` via `U_SortCode`) — user workload, warehouse flow, sort→putaway wait, backlog, AI brief. Schema: `scripts/putaway-udo-setup.mjs`; demo data: `scripts/putaway-demo-data.mjs [--delete]` (UI: `public/putaway-analytics.html`) |
| `warehouse-twin-agent.mjs` | `/api/warehouse-twin` | Warehouse Digital Twin (default whs `17SH`): Three.js 3D racks/bins with the stock in each bin. Data: OBIN + OIBQ (+ OBBQ batches, OINM 90-day pick frequency) via DB Direct → else Service Layer bins + warehouse stock placed by simulation → else a generated demo warehouse. Bin code / sublevels map to aisle·rack·level·position in the browser; layout settings and planned (what-if) aisles saved to `data/warehouse-twin/<whs>.json`. Item/batch/bin search, manual pallet moves, re-slotting suggestions (fast movers low & near dock, consolidation), CSV move plan, AI brief — moves are simulated, nothing is posted to SAP (UI: `public/warehouse-twin.html`, iframe `#warehouse-twin-panel`, perm `purchase.workflow.warehouse_twin`) |
| `grpo-to-apinv-agent.mjs` | `/api/grpo-apinv` | Copy an open GRPO into an A/P Invoice (shared `lib/copy-doc-flow.mjs`) |
| `scan-apinv-agent.mjs` | `/api/scan-apinv` | Scan A/P Invoice: OCR a supplier invoice and three-way match it to a GRPO |
| `bank-reco-agent.mjs` | `/api/bank-reco` | Bank Reconciliation: OCR a bank statement (PDF/image, running-balance check), pull the bank G/L account's JDT1 lines (+ earlier lines with `ExtrMatch = 0` as carry-forwards), auto-match (reference/cheque no → keyword+date → unique amount → day groups → optional AI pass validated by amount), the four reconciling buckets with a zero-difference proof, manual match/exclude/carry-forward items, Excel export (UI: `public/bank-reco.html`, iframe `#bank-reco-panel`, perm `ai.ocr.bank_reco`) |
| `order-confirmation-agent.mjs` | `/api/order-confirmation` | Sales Order Confirmation: list open SOs (pending/confirmed), detail drawer with lines + customer credit, confirm one or many by PATCHing `Confirmed: 'tYES'` (UI: `#soc-panel` in `public/index.html`) |
| `excel-import-agent.mjs` | `/api/so-excel-import`, `/api/item-excel-import`, `/api/bp-excel-import`, `/api/bom-excel-import`, `/api/apinv-excel-import`, `/api/salary-jv-import` | Excel Import agents — one engine, one router per SAP object (`createExcelImportRouter(deps, type)`; types `order` Orders · `item` Items+ItemPrices · `bp` BusinessPartners+BPAddresses · `bom` ProductTrees · `apservice` PurchaseInvoices DocType service · `je` JournalEntries). Per-type catalog, lookups, rules, payload and built-in templates live in `lib/excel-import-types.mjs`. DTW-style templates per company + type in SQLite `so_import_templates` (`importRepo`, every query scoped by `{company, type}` / column `doc_type`): columns {heading + aliases → target} where target is `header.<SL field>` / `line.<SL field>` (catalog, UDFs from `/UserFieldsMD`, or any typed property), `key`, `info.header`/`info.line`, `ignore`, or `head` (JE only: amount column with its own `account` + `side` D/C → one JE line); heading-less columns send their default as a fixed value; `groupKey` columns form records; `layout` table (heading row, all matching sheets) or form (label | value, one record per sheet — salary slips); `options` (JE remarks / line-remarks patterns with `{Column heading}` placeholders, masters `onExisting` error|update → PATCH). Lookups resolve names → codes (G/L accounts by code / FormatCode / name, item & BP groups, payment terms, sales employees, branches); A/P checks vendor + vendor invoice no against existing invoices; JE must balance. Records in `so_import_batches` (template snapshot) / `so_import_orders`; tabs Pending · Posted · Missing data. UI: `public/excel-import.html?type=…` (Import view + Templates mapper; `so-excel-import.html` redirects), iframe `#excel-import-panel` via `showExcelImportPanel(type)`; perms `sales.workflow.so_excel_import`, `master.excel_import.item|bp|bom`, `purchase.workflow.apinv_excel_import`, `finance.salary_jv_import`, templates `tools.excel_import_templates` (SO also `sales.workflow.so_excel_import_templates`), enforced server-side |
| `forecasting.mjs` | `/api/forecasting` | Product demand forecasting agent |
| `rush-orders.mjs` | `/api/rush-orders` | Rush order prioritisation agent |

All controllers share the same `callAI()` pattern: try GPT → Azure Claude → Anthropic SDK in that order.

### Key supporting files

| File | Purpose |
|---|---|
| `db.mjs` | SQLite via `better-sqlite3`. Tables: `users`, `connections`, `auth_sessions`, `db_connections`, `query_cache`, `mail_config`, `user_prompts` (saved prompts + prompt history) |
| `db-connector.mjs` | Direct DB connections (MSSQL via `mssql`, HANA via `hdb`). Exports `executeSQL`, `connectDB`, `tableRef`. SELECT-only guard enforced here. |
| `nlp-engine.mjs` | Rule-based NLP for SAP B1 entities. Matches entity patterns → calls Service Layer OData → returns markdown table. No AI needed. |
| `data/sap-schema.json` | SAP B1 schema registry (OData paths, field names, filter examples) used as AI context. |
| `mail-po.mjs` | IMAP email polling for PDF purchase orders; `pdf-parse` for extraction. |
| `public/` | All frontend HTML files served statically by Express. |

## SAP Service Layer API Patterns

**Authentication:** Cookie-based. POST `/Login` → get `B1SESSION` + `ROUTEID` cookies. Auto-renew on 401.

**OData status values** (critical — SQL values are different):
- `DocumentStatus eq 'bost_Open'` / `'bost_Close'`
- `Cancelled eq 'tNO'` / `'tYES'`
- Never use `'O'`, `'C'`, `DocStatus` — those are SQL column names

**HANA analytics:** `GET /sml.svc/{ViewName}` — separate from the main Service Layer. Namespace prefix must match the company DB (see `NAMESPACE_MAP` in `src/server.ts`).

**Single item lookup:** `GET /Items('{ItemCode}')` — not `get_total_stock` which returns all items.

**Single BP lookup:** `GET /BusinessPartners('{CardCode}')` or `get_customer_details` — not `get_customer_list`.

## AI Provider Configuration

Set `AI_PROVIDER` in `.env` to `anthropic` (default), `azure`, or `gpt`. The `USE_AI` flag is derived at startup — all controllers check it before making AI calls and degrade gracefully to structured responses.

```env
# Anthropic (default)
ANTHROPIC_API_KEY=sk-ant-...

# Azure OpenAI (Claude via Azure)
AI_PROVIDER=azure
AZURE_OPENAI_API_KEY=...
AZURE_OPENAI_ENDPOINT=...
AZURE_CLAUDE_MODEL=claude-3-5-sonnet-20241022

# Azure GPT-4o
AI_PROVIDER=gpt
AZURE_GPT_ENDPOINT=...
AZURE_OPENAI_API_KEY=...
```

## Intent Routing (NLP Layer)

`detectIntent()` in `chat-server.mjs` runs **before** the AI on every message. It uses regex patterns to route to specific tools or actions. When adding new natural-language trigger phrases, edit both:
1. The relevant `if` block in `detectIntent()` (~line 968)
2. The corresponding routing rule text in `buildSapSystemPrompt()` (~line 1960) so the AI also uses the right tool

The `nlpQuery()` fallback in `nlp-engine.mjs` handles ~25 SAP entity types (ProductionOrders, ServiceCalls, JournalEntries, EmployeesInfo, etc.) that `detectIntent` doesn't cover.

## DB Direct Mode

When the `db` engine is selected, queries run against a live MSSQL/HANA database via `db-connector.mjs`. The `tableRef()` helper generates the correct qualified name (`[DB].[dbo].[TABLE]` for MSSQL, `"SCHEMA"."TABLE"` for HANA). Only SELECT statements are allowed — enforced in `executeSQL()`.

DB connections are stored in the `db_connections` SQLite table and activated via `POST /api/db-connections/:id/activate`.

## sql-gateway-mcp/ (separate subproject — independent of everything above)

`sql-gateway-mcp/` is a **standalone** project living inside this repo folder
for convenience only. It does not import from, depend on, or get imported by
any of the AgentSphere code described above (`src/`, `chat-server.mjs`,
`controllers/`, etc.), has its own `package.json`/`node_modules`/git history,
and is deployed as its own separate Render service. Treat it as a different
codebase that happens to share a parent directory — do not assume changes
here affect it, or vice versa.

**What it is:** an MCP server + local-agent pair that lets ChatGPT/Claude
query an on-prem SQL Server/MySQL/Postgres/SQLite/HANA database without
opening any inbound port on the machine that holds the data — modeled on
Power BI's on-premises data gateway. Full architecture, setup, and security
notes live in `sql-gateway-mcp/README.md` — read that file before making any
changes here, it is the source of truth for this subproject.

**Quick orientation:**
- `sql-gateway-mcp/render-mcp-server/` — the MCP server, deployed on Render at
  `sql-gateway-mcp-server.onrender.com`. Exposes `list_connectors`,
  `run_named_query`, `run_sql_query` to any MCP client. Gated by
  `MCP_ACCESS_TOKEN` (query param `?key=` or `Authorization: Bearer`).
- `sql-gateway-mcp/local-agent/` — runs on whichever PC holds the database,
  dials out to Render over WebSocket, never accepts inbound connections.
  Enforces read-only SQL independently of what the server/client asked for
  (`sqlGuard.js`). `install.bat` is the one-touch setup for a new PC —
  generates its own connector token, no need to invent one.
- Live connector on this machine: `sap-live`, pointed at the local SQL
  Server database `NOCPL_LIVe` (`DESKTOP-ICFN0OJ\SQLEXPRESS01`).
- A `WMS_DEV_UK` HANA connector is planned but not yet configured — HANA
  driver support (`hdb`) already exists in `local-agent/db.js`, just needs
  real `HANA_HOST`/`PORT`/`USER`/`PASSWORD`.

If asked to work on "the SQL connector", "the gateway", "run_sql_query", or
anything Render/ChatGPT/Claude-connector related, it almost certainly means
this subproject, not the AgentSphere MCP server in `src/server.ts` (which is
stdio-based and SAP-Service-Layer-specific, a different thing entirely).
