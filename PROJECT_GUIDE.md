# Agentsphere — SAP Business One AI Platform
## Complete Project Guide

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Prerequisites](#2-prerequisites)
3. [Installation & Setup](#3-installation--setup)
4. [Environment Configuration (.env)](#4-environment-configuration-env)
5. [Running the Project](#5-running-the-project)
6. [Frontend (public/index.html)](#6-frontend-publicindexhtml)
7. [Backend Servers](#7-backend-servers)
   - [chat-server.mjs — Main Web Server](#chat-servermjs--main-web-server)
   - [db.mjs — Database Layer](#dbmjs--database-layer)
   - [db-connector.mjs — Direct DB Access](#db-connectormjs--direct-db-access)
   - [mail-po.mjs — Email Automation](#mail-pomjs--email-automation)
   - [nlp-engine.mjs — NLP Query Engine](#nlp-enginemjs--nlp-query-engine)
   - [src/server.ts — MCP Server](#srcserverts--mcp-server)
8. [Database Schema (hanny.db)](#8-database-schema-hannydb)
9. [API Endpoints Reference](#9-api-endpoints-reference)
10. [MCP Tools Reference (60+ Tools)](#10-mcp-tools-reference-60-tools)
11. [AI Provider Configuration](#11-ai-provider-configuration)
12. [Multi-Company Setup](#12-multi-company-setup)
13. [Mail PO→SO Automation](#13-mail-poso-automation)
14. [Troubleshooting](#14-troubleshooting)

---

## 1. Project Overview

**Agentsphere** is a full-stack AI-powered ERP integration platform for **SAP Business One**. It provides:

| Layer | What it does |
|-------|-------------|
| **Chat UI** | Browser-based chat interface — ask questions, trigger workflows, get insights |
| **MCP Server** | 60+ tools for O2C, P2P, inventory, forecasting, and BI analytics |
| **Agentic Workflows** | PO→Sales Order automation (PDF upload or email) |
| **NLP Engine** | Natural language → OData query translation (no AI required) |
| **Direct DB Query** | AI-generated SQL against MSSQL or HANA |
| **Email Monitor** | IMAP polling → PDF parse → SAP SO creation → reply |

**Tech stack:**

```
Frontend    →  HTML5 / CSS / Vanilla JS (no framework)
Backend     →  Node.js 18+ (ESM modules), Express 5
MCP Server  →  TypeScript, @modelcontextprotocol/sdk
Database    →  SQLite (better-sqlite3), WAL mode
AI          →  Anthropic Claude / Azure Claude / Azure GPT-4o
SAP         →  SAP B1 Service Layer (OData v4)
Email       →  node-imap + nodemailer + mailparser
PDF         →  pdf-parse
```

---

## 2. Prerequisites

| Requirement | Version | Notes |
|-------------|---------|-------|
| **Node.js** | ≥ 18.x | Required for ESM module support |
| **npm** | ≥ 9.x | Comes with Node.js |
| **SAP B1** | 9.x / 10.x | Service Layer must be enabled |
| **SSL Certificate** | Self-signed OK | `NODE_TLS_REJECT_UNAUTHORIZED=0` in .env |
| **AI API Key** | One of three | Anthropic, Azure Claude, or Azure GPT-4o |

Check your Node.js version:
```bash
node --version   # must be v18 or higher
npm --version
```

---

## 3. Installation & Setup

### Step 1 — Clone / download the project

```bash
cd d:/akhshat/MCP
```

### Step 2 — Install dependencies

```bash
npm install
```

This installs all packages listed in `package.json`:
- `express` — web server
- `better-sqlite3` — local SQLite database
- `@anthropic-ai/sdk` — Claude AI
- `@modelcontextprotocol/sdk` — MCP protocol
- `imap`, `mailparser`, `nodemailer` — email automation
- `pdf-parse` — PDF text extraction
- `mssql`, `hdb` — direct DB connections (MSSQL / HANA)
- `axios`, `dotenv`, `multer`

### Step 3 — Create your .env file

```bash
copy .env.example .env
# then edit .env with your actual credentials
```

See [Section 4](#4-environment-configuration-env) for all variables.

### Step 4 — (Optional) Build the TypeScript MCP server

Only needed if you want to use Agentsphere as a Claude Desktop MCP server:

```bash
npm run build
```

This compiles `src/server.ts` → `dist/server.js`.

---

## 4. Environment Configuration (.env)

```env
# ── SAP B1 Service Layer ─────────────────────────────────────────
# Base URL WITHOUT /b1s/v1 — the code adds it automatically
SL_BASE_URL=https://your-sap-server:50000/b1s/v2
SL_COMPANY=YOUR_DB_NAME
SL_USER=manager
SL_PASSWORD=your_password

# Optional: HANA SMLSVC namespace (auto-discovered if omitted)
SL_NAMESPACE=sap.yourcompanydb

# Disable SSL verification for self-signed SAP certificates
NODE_TLS_REJECT_UNAUTHORIZED=0

# ── AI Provider ──────────────────────────────────────────────────
# Options: "anthropic" | "azure" | "gpt"
AI_PROVIDER=gpt

# Anthropic direct API
ANTHROPIC_API_KEY=sk-ant-api03-...

# Azure AI Services — Claude models
AZURE_OPENAI_API_KEY=your_azure_key
AZURE_OPENAI_ENDPOINT=https://your-resource.services.ai.azure.com/anthropic
AZURE_CLAUDE_MODEL=claude-3-5-sonnet-20241022

# Azure OpenAI — GPT-4o (chat completions)
AZURE_GPT_ENDPOINT=https://your-resource.openai.azure.com/openai/deployments/gpt-4o/chat/completions?api-version=2025-01-01-preview

# ── Chat Server ──────────────────────────────────────────────────
CHAT_PORT=3000
DEMO_MODE=false

# ── Cost Centre Dimension Names ──────────────────────────────────
# Match these to your SAP B1 dimension names exactly
DIM1_NAME=Brand
DIM2_NAME=Sub Brand
DIM3_NAME=Budget
DIM4_NAME=Universe
DIM5_NAME=Cogs Customer

# ── Multi-Company (auto-seeded into DB on startup) ───────────────
COMPANY_1_NAME=My Company
COMPANY_1_URL=https://sap-server:50000/b1s/v2
COMPANY_1_DB=MY_DB_NAME
COMPANY_1_USER=manager
COMPANY_1_PASS=password

COMPANY_2_NAME=Second Company
COMPANY_2_URL=https://sap-server:50000/b1s/v1
COMPANY_2_DB=SECOND_DB
COMPANY_2_USER=manager
COMPANY_2_PASS=password

# ── Mail PO→SO Automation ────────────────────────────────────────
MAIL_IMAP_HOST=imap.gmail.com
MAIL_IMAP_PORT=993
MAIL_IMAP_TLS=true
MAIL_SMTP_HOST=smtp.gmail.com
MAIL_SMTP_PORT=587
MAIL_SMTP_TLS=false
MAIL_USER=your@gmail.com
MAIL_PASS=your-app-password   # Gmail: use App Password (not account password)
MAIL_FOLDER=INBOX
MAIL_POLL_MS=60000            # check every 60 seconds
```

> **Gmail tip:** Enable IMAP in Gmail settings → Forwarding and POP/IMAP. If 2FA is enabled, generate an App Password at myaccount.google.com/apppasswords.

---

## 5. Running the Project

### ▶ Start the Chat UI Server (recommended)

```bash
npm run chat
# or directly:
node chat-server.mjs
```

Open your browser at: **http://localhost:3000**

Default login: `admin` / `admin123`

---

### ▶ Start in Development Mode (MCP server only)

For use with Claude Desktop as an MCP server:

```bash
npm run dev
# uses ts-node live (no compile step needed)
```

Or build first then run:

```bash
npm run build
npm run start
```

---

### ▶ npm scripts summary

| Script | Command | Purpose |
|--------|---------|---------|
| `npm run chat` | `node chat-server.mjs` | **Main entry point** — starts chat UI on port 3000 |
| `npm run dev` | `node --loader ts-node/esm src/server.ts` | MCP stdio server (dev mode) |
| `npm run build` | `tsc -p tsconfig.json` | Compile TypeScript → dist/ |
| `npm run start` | `node dist/server.js` | Run compiled MCP stdio server |
| `npm run api` | `python main.py` | Legacy FastAPI server (optional) |

---

## 6. Frontend (public/index.html)

Single-page application at `public/index.html` (~6400 lines, ~334 KB).

### Layout Structure

```
┌──────────────────────────────────────────────────────────┐
│  Top Bar: Mode toggles | Company switcher | Voice | Auth │
├──────────────┬───────────────────────────────────────────┤
│              │                                           │
│   Sidebar    │          Main Content Area                │
│   (Navigation│  ┌─ Chat Panel (default) ──────────────┐ │
│    Menu)     │  │  Message history + input box         │ │
│              │  └──────────────────────────────────────┘ │
│   - Chat     │  ┌─ Workflow Panel (PO→SO) ─────────────┐ │
│   - Dashboard│  │  PDF upload → Extract → Review → SO  │ │
│   - Agentic  │  └──────────────────────────────────────┘ │
│   - Sales    │  ┌─ Mail PO Panel ──────────────────────┐ │
│   - Purchase │  │  Inbox | Settings | Activity tabs    │ │
│   - Finance  │  └──────────────────────────────────────┘ │
│   - Inventory│                                           │
│   - Analytics│                                           │
└──────────────┴───────────────────────────────────────────┘
```

### Key Panels

#### Chat Panel (default)
- Streaming AI chat with SAP B1 context
- Supports 3 AI engines switchable from the top bar: **Standard** (NLP), **Claude**, **GPT-4o**
- **DB SQL** mode — generates and runs SELECT queries against direct DB connection
- Message history with markdown rendering
- Voice input support
- Quick action modals (Create SO, Create PO, Create Delivery, etc.)

#### PO → Sales Order Workflow Panel
- Drag-and-drop PDF upload
- Auto-extract PO data via AI (item codes, quantities, prices, dates)
- Editable line items with **UoM dropdown** (loaded from SAP item master)
- Customer fuzzy search against SAP B1 BusinessPartners
- Credit limit check (with utilization percentage)
- ATP (Available-to-Promise) stock check per line
- **🔍 Validate Order** — S/4 HANA-style pre-check before posting
- **✅ Post Sales Order** — only enabled after validation passes

#### Mail PO → SO Panel (Agentic AI)
- **Inbox tab** — lists today's unread emails with subject "purchase order"
- Click any email → auto downloads + parses PDF → runs AI extraction
- Shows extraction card → customer match → credit check → ATP
- Editable lines with UoM selection from SAP item master
- Validate + Post workflow identical to PO→SO
- Sends acknowledgment email to sender on SO creation
- **Settings tab** — configure IMAP/SMTP credentials (saved to DB, persists across restarts)
- **Activity tab** — live monitor log

#### Dashboard
- KPI tiles, charts, analytics summaries populated via AI tools

### Authentication
- Login page at `/login` (redirects if not authenticated)
- Token stored in `localStorage`
- 12-hour session TTL, auto-redirect on expiry

---

## 7. Backend Servers

---

### chat-server.mjs — Main Web Server

**File:** `chat-server.mjs`  
**Port:** 3000 (configurable via `CHAT_PORT`)  
**Purpose:** Express HTTP server that serves the frontend and handles all business logic.

#### What it does at startup:
1. Loads `.env`
2. Initialises SQLite DB via `db.mjs`
3. Seeds multi-company connections from `COMPANY_*` env vars
4. Loads mail config from DB → sets `process.env` (no restart needed after settings change)
5. Spawns the TypeScript MCP server as a child process (stdio)
6. Connects to MCP server and lists all 60+ tools
7. Starts auto-polling IMAP if mail was previously started

#### Key responsibilities:

| Area | Details |
|------|---------|
| **Static files** | Serves `public/` (index.html, login.html) |
| **Authentication** | `requireAuth` middleware checks session token |
| **AI Chat** | Routes prompts to Anthropic / Azure Claude / GPT-4o |
| **Tool execution** | Calls MCP tools (SAP operations) based on AI decisions |
| **NLP routing** | `Standard` mode uses `nlp-engine.mjs` — zero AI cost |
| **SAP direct calls** | `getActiveSap()` returns authenticated Service Layer client |
| **PDF parsing** | `pdf-parse` extracts text from uploaded/emailed PDFs |
| **PDF caching** | In-memory `_pdfCache` Map (30-min TTL) for split open/extract flow |
| **Streaming** | Server-Sent Events for real-time AI response streaming |

#### SAP Session Management
The server maintains one SAP B1 session per connected company. Sessions auto-refresh on 401. Company switching (`/api/connections/:id/switch`) creates a new session for the selected company and marks it active in SQLite.

---

### db.mjs — Database Layer

**File:** `db.mjs`  
**Engine:** SQLite (better-sqlite3, WAL mode)  
**File:** `hanny.db`

All local state — users, sessions, SAP connection profiles, mail config, and query cache — is stored here. See [Section 8](#8-database-schema-hannydb) for full schema.

**Exported repositories:**

| Export | Purpose |
|--------|---------|
| `userRepo` | Create/find/list/delete users, change passwords |
| `sessionRepo` | Create tokens, verify + expiry check, purge expired |
| `connRepo` | SAP B1 connection profiles, activate by company |
| `mailConfigRepo` | Save/load IMAP+SMTP settings |
| `dbConnRepo` | Direct DB connections (MSSQL/HANA) CRUD |
| `queryCacheRepo` | Prompt → tool mapping cache (upsert, increment, clear) |

**Password security:** `scrypt` (Node.js `crypto.scryptSync`) with random 16-byte salt — same algorithm as bcrypt but built into Node.

---

### db-connector.mjs — Direct DB Access

**File:** `db-connector.mjs`  
**Purpose:** Execute raw SQL SELECT queries against SAP B1's underlying database.

Supports two database types:

| Type | Driver | When to use |
|------|--------|-------------|
| **MSSQL** | `mssql` npm package | SAP B1 on SQL Server |
| **HANA** | `hdb` npm package | SAP B1 on SAP HANA |

**Safety:** Only `SELECT` statements are allowed — all other keywords (`INSERT`, `UPDATE`, `DELETE`, `DROP`, `CREATE`, `EXEC`, `ALTER`) are rejected before execution.

**AI context:** The module exports a comprehensive SAP B1 schema reference (table names, field descriptions) that is injected into the AI prompt when DB SQL mode is active. This allows GPT-4o/Claude to write accurate SAP B1 SQL without hallucinating table names.

---

### mail-po.mjs — Email Automation

**File:** `mail-po.mjs`  
**Purpose:** IMAP email monitor that processes incoming Purchase Orders and creates Sales Orders automatically.

#### How it works

```
Gmail / any IMAP server
         │
         │  IMAP IDLE / Poll (every 60s by default)
         ▼
  Filter: UNSEEN + today + subject "purchase order"
         │
         ▼
  Download email → extract PDF attachment
         │
         ▼
  pdf-parse → raw text
         │
         ▼
  AI prompt → parse PO JSON (items, qty, price, dates, customer name)
         │
         ▼
  SAP B1: find customer → credit check → ATP check
         │
         ├── Auto mode: create SO automatically → reply email
         └── Manual mode: show in UI → user validates → Post SO → reply email
```

#### Configuration (persisted in SQLite)
Go to **Mail PO → SO → Settings tab** in the UI to configure. Changes take effect immediately — no server restart required.

#### Email format expected
- Subject must contain **"purchase order"** (case-insensitive)
- Must have a **PDF attachment**
- Must be **unread** and received **today or later**

#### Reply email sent on success
```
Your Purchase Order has been received and processed.
Sales Order #12345 has been created in SAP Business One.
PO Reference: PO-2024-001
Customer Code: C20000
Thank you for your order.
---
Agentsphere AI — Automated PO→SO Workflow
```

---

### nlp-engine.mjs — NLP Query Engine

**File:** `nlp-engine.mjs`  
**Purpose:** Translate natural language into SAP B1 Service Layer OData queries — **without using AI**.

This is used when the chat mode is set to **Standard** (the default). It's instant and has zero AI cost.

#### Supported query patterns

```
"show open sales orders this month"
"top 10 customers by revenue last quarter"
"overdue AR invoices over 5000"
"purchase orders for vendor ABC last week"
"delivery notes today"
"stock levels for all items"
"unpaid invoices highest value first"
```

#### How it works
1. `parseNLQuery(msg)` — extracts entity, date range, amount filter, sort order, top-N, status, customer/vendor name from the message using regex patterns
2. `buildODataParams(entity, parsed)` — constructs `$filter`, `$select`, `$orderby`, `$top` OData parameters
3. Result is fetched from SAP Service Layer and formatted as a markdown table
4. Follow-up suggestions are generated based on context

**46 SAP entities supported:** Sales Quotations, Sales Orders, Deliveries, AR Invoices, POs, GRPOs, AP Invoices, Items, Customers, Vendors, Payments, Inventory, Employees, and more.

---

### src/server.ts — MCP Server

**File:** `src/server.ts`  
**Runtime:** TypeScript (compiled to `dist/server.js`)  
**Purpose:** Implements the **Model Context Protocol** server exposing 60+ SAP B1 tools.

This server runs as a **child process** spawned by `chat-server.mjs` and communicates over stdio using the MCP protocol. It can also run standalone as a Claude Desktop MCP server.

#### SapB1ServiceLayerClient class
Handles all SAP B1 Service Layer communication:
- Session login with cookie-based auth
- Auto-relogin on 401 Unauthorized
- Retry logic for network errors
- Company-specific namespace resolution (for SMLSVC HANA views)

See [Section 10](#10-mcp-tools-reference-60-tools) for the full list of tools.

---

## 8. Database Schema (hanny.db)

```sql
-- Local users for the chat UI
CREATE TABLE users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT    UNIQUE NOT NULL,
  password_hash TEXT    NOT NULL,        -- scrypt:salt:hash
  full_name     TEXT    DEFAULT '',
  role          TEXT    DEFAULT 'user',  -- 'admin' or 'user'
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- SAP B1 Service Layer connection profiles
CREATE TABLE connections (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  base_url    TEXT NOT NULL,             -- https://host:50000/b1s/v2
  company     TEXT NOT NULL,             -- DB name
  sl_user     TEXT NOT NULL,
  sl_password TEXT NOT NULL,
  is_active   INTEGER DEFAULT 0,         -- 1 = currently selected
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Browser session tokens
CREATE TABLE auth_sessions (
  token      TEXT    PRIMARY KEY,        -- 32-byte hex random
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME NOT NULL           -- 12 hours after creation
);

-- IMAP/SMTP mail configuration
CREATE TABLE mail_config (
  id        INTEGER PRIMARY KEY DEFAULT 1,
  imap_host TEXT DEFAULT '',
  imap_port INTEGER DEFAULT 993,
  imap_tls  INTEGER DEFAULT 1,
  mail_user TEXT DEFAULT '',
  mail_pass TEXT DEFAULT '',
  smtp_host TEXT DEFAULT '',
  smtp_port INTEGER DEFAULT 587,
  smtp_tls  INTEGER DEFAULT 0,
  folder    TEXT DEFAULT 'INBOX',
  poll_ms   INTEGER DEFAULT 60000
);

-- Direct MSSQL / HANA DB connections
CREATE TABLE db_connections (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  db_type     TEXT NOT NULL DEFAULT 'mssql',  -- 'mssql' or 'hana'
  host        TEXT NOT NULL,
  port        INTEGER,
  database    TEXT NOT NULL,
  schema_name TEXT DEFAULT '',
  username    TEXT NOT NULL,
  password    TEXT NOT NULL,
  is_active   INTEGER DEFAULT 0,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- NLP → Tool mapping cache
CREATE TABLE prompt_cache (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  prompt_norm      TEXT NOT NULL,              -- lowercased, stripped
  prompt_orig      TEXT NOT NULL,
  tool_name        TEXT NOT NULL,
  tool_params      TEXT DEFAULT '{}',
  response_preview TEXT DEFAULT '',
  used_count       INTEGER DEFAULT 0,
  last_used        DATETIME DEFAULT CURRENT_TIMESTAMP,
  created_at       DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_pc_norm ON prompt_cache(prompt_norm);
```

**Default admin account** (created on first run if no admin exists):
- Username: `admin`
- Password: `admin123`

> **Change the admin password after first login.**

---

## 9. API Endpoints Reference

All endpoints except `/auth/login` and `/` require an `Authorization: Bearer <token>` header (set automatically by the frontend).

### Authentication

| Method | Endpoint | Body | Response |
|--------|----------|------|----------|
| POST | `/auth/login` | `{username, password}` | `{token, user}` |
| POST | `/auth/logout` | — | `{ok}` |
| GET | `/auth/me` | — | `{user}` |

### SAP Connections (Multi-Company)

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/connections` | List all SAP B1 connections |
| POST | `/api/connections` | Add new connection |
| POST | `/api/connections/:id/switch` | Switch active company |
| DELETE | `/api/connections/:id` | Remove connection |

### Chat & AI

| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | `/api/chat` | Send message, get streaming AI response (SSE) |
| GET | `/api/tools` | List all available MCP tools |
| GET | `/api/query-cache` | View prompt history |
| DELETE | `/api/query-cache` | Clear all cached prompts |

### Workflow — PO → Sales Order (PDF Upload)

| Method | Endpoint | Body | Purpose |
|--------|----------|------|---------|
| POST | `/api/workflow/po/parse` | `{pdfBase64}` | Parse PDF, extract PO JSON |
| POST | `/api/workflow/po/customer` | `{name, code}` | Find customer in SAP B1 |
| POST | `/api/workflow/po/credit` | `{cardCode, orderAmt}` | Check credit limit |
| POST | `/api/workflow/po/atp` | `{lines}` | Check stock availability |
| POST | `/api/workflow/po/create` | `{cardCode, lines, ...}` | Create Sales Order |

### Mail PO → SO (Email Automation)

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/mail-po/status` | Monitor running status |
| GET | `/api/mail-po/logs` | Recent activity log (last 100 entries) |
| POST | `/api/mail-po/test` | Test IMAP connection |
| POST | `/api/mail-po/config` | Save IMAP/SMTP settings to DB |
| POST | `/api/mail-po/start` | Start email monitor |
| POST | `/api/mail-po/stop` | Stop email monitor |
| GET | `/api/mail-po/inbox` | List today's unread PO emails |
| POST | `/api/mail-po/open` | Download email + parse PDF (~5-10s) |
| POST | `/api/mail-po/extract` | AI extract + customer + credit + ATP (~15-20s) |
| GET | `/api/mail-po/item-uoms` | Get UoM options for item from SAP item master |
| POST | `/api/mail-po/validate-so` | Pre-flight validation (customer, credit, items, ATP) |
| POST | `/api/mail-po/create-so-mail` | Create SO + send acknowledgment email |

### Direct Database Query

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/db-connections` | List configured DB connections |
| POST | `/api/db-connections` | Add MSSQL/HANA connection |
| PUT | `/api/db-connections/:id` | Update connection |
| DELETE | `/api/db-connections/:id` | Remove connection |
| POST | `/api/db-connections/:id/activate` | Set active connection |
| POST | `/api/db-connections/test` | Test connection credentials |
| POST | `/api/db-execute` | Execute SELECT query on active DB |

### Autocomplete / Suggest

| Endpoint | Returns |
|----------|---------|
| `GET /api/suggest/customers?q=` | Customer list (CardCode, CardName) |
| `GET /api/suggest/vendors?q=` | Vendor list |
| `GET /api/suggest/items?q=` | Item list (ItemCode, ItemName) |
| `GET /api/suggest/warehouses` | Warehouse list |
| `GET /api/suggest/bins?warehouse=` | Bin locations |
| `GET /api/suggest/batches?itemCode=` | Batch numbers for item |

### Document Fetch

| Endpoint | Returns |
|----------|---------|
| `GET /api/fetch/order/:entry` | Sales Order detail |
| `GET /api/fetch/po/:entry` | Purchase Order detail |
| `GET /api/fetch/grpo/:entry` | Goods Receipt PO detail |
| `GET /api/print/:docType/:docEntry` | PDF print output |

---

## 10. MCP Tools Reference (60+ Tools)

These tools are available in the AI chat. Claude/GPT-4o selects and calls them automatically based on your question.

### Order-to-Cash (O2C)

| Tool | What it does |
|------|-------------|
| `create_sales_quotation` | Create a new quotation from customer + line items |
| `create_sales_order` | Create SO from quotation OR direct from customer + items |
| `check_atp` | Available-to-Promise check — stock vs. demand per item |
| `create_delivery` | Create delivery note from confirmed Sales Order |
| `get_pick_list` | Pick list by bin location for warehouse operations |
| `confirm_delivery_pod` | Record proof of delivery (POD reference + exceptions) |
| `create_ar_invoice` | Generate AR invoice from delivery note |
| `apply_incoming_payment` | Record customer payment, auto-allocate to open invoices |
| `get_collections_worklist` | Ranked list of overdue AR by risk score + DSO |

### Procure-to-Pay (P2P)

| Tool | What it does |
|------|-------------|
| `create_purchase_request` | Internal procurement requisition |
| `create_purchase_quotation` | Request for Quote (RFQ) |
| `create_po_from_quotation` | Convert approved quote to Purchase Order |
| `create_purchase_order` | Direct PO to vendor |
| `create_goods_receipt_po` | Record goods received against PO |
| `create_ap_invoice` | Vendor invoice from GRPO |
| `apply_outgoing_payment` | Record vendor payment |

### Sales Analysis

| Tool | What it does |
|------|-------------|
| `get_sales_analysis` | Sales breakdown by customer / item / salesperson / period |
| `get_top_customers` | Revenue concentration, Pareto ranking |
| `get_top_items` | Best-selling products by revenue, quantity, or gross profit |
| `get_sales_by_period` | Daily / weekly / monthly revenue trends |
| `get_salesperson_performance` | Individual SLP sales vs. GP% |
| `get_item_group_sales` | Sales by product category |
| `get_warehouse_sales` | Sales by warehouse / location |
| `get_year_over_year` | Current vs. prior year comparison |
| `get_quotation_win_rate` | Quote-to-order conversion rate |
| `get_open_orders` | All open Sales Orders |
| `get_open_quotations` | All open quotations |

### Purchase Analysis

| Tool | What it does |
|------|-------------|
| `get_purchase_analysis` | Spend by vendor / category / period |

### AR / AP Aging

| Tool | What it does |
|------|-------------|
| `get_ar_aging` | AR buckets: current / 30 / 60 / 90+ days overdue |
| `get_ap_aging` | AP buckets: current / 30 / 60 / 90+ days due |

### Inventory

| Tool | What it does |
|------|-------------|
| `get_total_stock` | All items with on-hand, committed, available quantities |
| `predict_stockout` | Items at risk — critical / low / moderate levels |
| `detect_dead_slow_stock` | Zero-demand and low-velocity inventory |
| `calc_reorder_point` | ROP calculation + items needing immediate order |
| `calc_eoq` | Economic Order Quantity optimization |

### Forecasting

| Tool | What it does |
|------|-------------|
| `forecast_sales` | 9-model ensemble: SMA, WMA, EWMA, Linear Trend, Drift, Holt, Holt-Winters, Seasonal Naive, Median — auto-selects best by MAPE |
| `forecast_item_demand` | Per-item demand forecast + procurement recommendation |
| `forecast_cash_flow` | AR inflow / AP outflow by due-date bucket |
| `detect_seasonality` | ACF analysis + decomposition + strength score + peak/trough months |

### BI Intelligence

| Tool | What it does |
|------|-------------|
| `analyze_abc_xyz` | ABC (revenue) × XYZ (variability) inventory classification |
| `segment_customers_rfm` | RFM scoring: Champions, Loyal, At Risk, Lost, etc. |
| `calc_working_capital` | DSO, DPO, DSI, Cash Conversion Cycle |
| `detect_customer_churn` | Flag at-risk customers by inactivity + overdue patterns |
| `calc_customer_clv` | Customer Lifetime Value with revenue tier labels |
| `analyze_revenue_concentration` | Pareto analysis + Herfindahl-Hirschman Index |
| `detect_margin_erosion` | GP% trend decline detection per customer/item |
| `detect_transaction_outliers` | Z-score anomaly detection in AR/AP transactions |
| `analyze_vendor_lead_time` | Avg/stddev/min/max lead time per vendor |
| `analyze_on_time_delivery` | On-time delivery rate by vendor |
| `analyze_vendor_concentration` | Spend concentration + supplier risk scoring |

### Master Data & Utilities

| Tool | What it does |
|------|-------------|
| `get_customer_list` | Browse customers with search / filter |
| `get_vendor_list` | Browse vendors |
| `get_customer_details` | Full BP master (credit, balance, open orders) |
| `get_company_info` | Active company DB, namespace, server version |
| `call_service_layer` | Generic OData GET — any SAP endpoint |
| `query_sml_view` | Query HANA SMLSVC analytical view |
| `switch_company` | Change active SAP B1 company database |

---

## 11. AI Provider Configuration

Set `AI_PROVIDER` in `.env` to one of:

### `AI_PROVIDER=anthropic` — Anthropic Claude (direct)
```env
ANTHROPIC_API_KEY=sk-ant-api03-...
```
Uses `claude-3-5-sonnet-20241022` by default.

### `AI_PROVIDER=azure` — Claude on Azure AI Services
```env
AZURE_OPENAI_API_KEY=your_key
AZURE_OPENAI_ENDPOINT=https://your-resource.services.ai.azure.com/anthropic
AZURE_CLAUDE_MODEL=claude-3-5-sonnet-20241022
```
Uses the Azure Messages API (`/messages` endpoint).

### `AI_PROVIDER=gpt` — GPT-4o on Azure OpenAI
```env
AZURE_OPENAI_API_KEY=your_key
AZURE_GPT_ENDPOINT=https://your-resource.openai.azure.com/openai/deployments/gpt-4o/chat/completions?api-version=2025-01-01-preview
```
Uses the Chat Completions API format.

> All three providers support streaming responses and tool/function calling.

---

## 12. Multi-Company Setup

You can connect to multiple SAP B1 companies and switch between them at runtime.

### Via .env (auto-seeded on startup)
```env
COMPANY_1_NAME=Production Company
COMPANY_1_URL=https://prod-server:50000/b1s/v2
COMPANY_1_DB=PROD_DB
COMPANY_1_USER=manager
COMPANY_1_PASS=password

COMPANY_2_NAME=Test Company
COMPANY_2_URL=https://test-server:50000/b1s/v1
COMPANY_2_DB=TEST_DB
COMPANY_2_USER=manager
COMPANY_2_PASS=password
```

### Via the UI
Settings → Connections → Add New Connection

### Switching companies
Click the **company pill** in the top navigation bar to switch. All subsequent SAP operations will use the selected company.

---

## 13. Mail PO→SO Automation

End-to-end automation from customer email → SAP Sales Order → reply email.

### Setup steps

1. Open **Mail PO → SO** in the sidebar
2. Go to **Settings tab**
3. Enter IMAP/SMTP credentials and click **Save & Test Connection**
4. If test passes, click **Start Monitor**
5. The monitor polls every 60 seconds (configurable)

### Manual processing
1. Go to **Inbox tab** → click **Scan Inbox**
2. Click any email to open it
3. Wait for PDF download + AI extraction (~5-15 seconds)
4. Review extracted lines, edit quantities/UoM if needed
5. Click **🔍 Validate Order** to run pre-flight checks
6. If all checks pass, click **✅ Post Sales Order**
7. Acknowledgment email sent automatically to the sender

### Automatic processing
When the monitor is running, emails matching the criteria are processed automatically without any user intervention. The workflow callback runs the full pipeline and sends a reply email with the SO number.

---

## 14. Troubleshooting

### Server won't start

```bash
# Check Node version
node --version   # must be v18+

# Check if port 3000 is already in use
netstat -ano | findstr :3000   # Windows
lsof -i :3000                  # Mac/Linux

# Kill existing node processes
taskkill /F /IM node.exe       # Windows
pkill node                     # Mac/Linux
```

### SAP B1 connection fails

1. Verify `SL_BASE_URL` — should be `https://host:50000/b1s/v2` (note `/v2` not `/v1`)
2. Confirm `NODE_TLS_REJECT_UNAUTHORIZED=0` is set (SAP uses self-signed certs)
3. Test Service Layer directly: `https://host:50000/b1s/v2/$metadata` in browser
4. Check SAP B1 Service Layer is running (`B1SiteManager`)

### Gmail IMAP fails

| Error | Fix |
|-------|-----|
| `Application-specific password required` | Use App Password, not Gmail password |
| `Invalid credentials` | Check IMAP is enabled in Gmail settings |
| `Connection refused` | Firewall blocking port 993 |
| `Self-signed certificate` | Already handled by `rejectUnauthorized: false` |

Generate App Password: Google Account → Security → 2-Step Verification → App Passwords

### UoM error on SO creation (`-5002`)

SAP B1 requires a UoM code per Sales Order line. This is now handled automatically — each line loads its UoM options from the SAP item master. If items show `Manual` UoM, that is correct for items that don't use UoM groups. If you see UoM errors, ensure:
- The item exists in SAP B1
- Select a valid UoM from the dropdown before validating

### AI not responding

1. Check `AI_PROVIDER` matches your configured API key
2. Verify the API key is valid and has quota
3. Check network access to Azure/Anthropic endpoints
4. Switch to **Standard** mode (NLP) to test without AI

### Database locked

```bash
# SQLite WAL files can lock under heavy load
# Stop the server, then:
rm hanny.db-shm hanny.db-wal   # Mac/Linux
del hanny.db-shm hanny.db-wal  # Windows
# Restart — WAL files will be recreated
```

---

## Project File Structure

```
d:/akhshat/MCP/
│
├── chat-server.mjs        # 🚀 Main Express server (start here)
├── db.mjs                 # SQLite ORM — users, sessions, connections
├── db-connector.mjs       # Direct MSSQL/HANA query executor
├── mail-po.mjs            # IMAP email monitor + PO workflow
├── nlp-engine.mjs         # NLP → OData query builder (no AI)
│
├── src/
│   └── server.ts          # TypeScript MCP server (60+ SAP tools)
│
├── dist/                  # Compiled JS (after npm run build)
│   └── server.js
│
├── public/
│   ├── index.html         # Main chat UI (single-page app)
│   └── login.html         # Login page
│
├── hanny.db               # SQLite database (auto-created)
├── hanny.db-shm           # SQLite WAL shared memory
├── hanny.db-wal           # SQLite WAL log
│
├── .env                   # Your credentials (never commit this)
├── .env.example           # Template for .env
├── package.json           # Dependencies & npm scripts
├── tsconfig.json          # TypeScript compiler config
└── PROJECT_GUIDE.md       # This file
```

---

*Agentsphere — Powered by SAP Business One + Claude AI*
