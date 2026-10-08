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
| `grpo-to-apinv-agent.mjs` | `/api/grpo-apinv` | Copy an open GRPO into an A/P Invoice (shared `lib/copy-doc-flow.mjs`) |
| `scan-apinv-agent.mjs` | `/api/scan-apinv` | Scan A/P Invoice: OCR a supplier invoice and three-way match it to a GRPO |
| `order-confirmation-agent.mjs` | `/api/order-confirmation` | Sales Order Confirmation: list open SOs (pending/confirmed), detail drawer with lines + customer credit, confirm one or many by PATCHing `Confirmed: 'tYES'` (UI: `#soc-panel` in `public/index.html`) |
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
