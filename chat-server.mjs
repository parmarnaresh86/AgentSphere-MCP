import express from "express";
import axios from "axios";
import https from "node:https";
import { appendFileSync, readFileSync, existsSync } from "node:fs";
import { EXPORTS_DIR, isExcelExportRequest, isMultiTabReportRequest, generateExcelExport } from "./lib/excel-export.mjs";
import { buildProfessionalInsight } from "./lib/data-insight.mjs";
import { detectIntent as _detectIntentPure } from "./lib/detect-intent.mjs";
import { qcol } from "./lib/sql-dialect.mjs";
import { createProductionAgentRouter } from "./controllers/production-agent.mjs";
import { createMrpAgentRouter, OITM_FIELD_CANDIDATES, mrpFetchVendorsViaDB, mrpFetchPricesViaDB } from "./controllers/mrp-agent.mjs";
import { createPricingAgentRouter } from "./controllers/pricing-agent.mjs";
import { createProcurementAgentRouter, createPurchaseThreeWayMatchRouter } from "./controllers/procurement-agent.mjs";
import { createPoWorkflowAgentRouter } from "./controllers/po-workflow-agent.mjs";
import { createMailPoAgentRouter } from "./controllers/mail-po-agent.mjs";
import { AsyncLocalStorage } from "node:async_hooks";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import path from "path";
import { nlpQuery } from "./nlp-engine.mjs";
import { createForecastingRouter, runForecastCore, runPurchaseForecastCore } from './controllers/forecasting.mjs';
import { createRushOrderRouter, runRushOrderScan } from './controllers/rush-orders.mjs';
import { createPurchasingAgentRouter }      from './controllers/purchasing-agent.mjs';
import { createOrderIntelligenceRouter }    from './controllers/order-intelligence-agent.mjs';
import { createShipmentDelayRouter }        from './controllers/shipment-delay-agent.mjs';
import { createPurchaseRequestAgentRouter } from './controllers/pr-agent.mjs';
import { createPurchaseOrderAgentRouter } from './controllers/po-agent.mjs';
import { createSalesOrderAgentRouter } from './controllers/sales-order-agent.mjs';
import { createPRtoPOAgentRouter } from './controllers/pr-to-po-agent.mjs';
import { createPOtoGRPOAgentRouter } from './controllers/po-to-grpo-agent.mjs';
import { createGRPOtoAPInvAgentRouter } from './controllers/grpo-to-apinv-agent.mjs';
import { createOcrPoScanAgentRouter }   from './controllers/ocr-po-scan-agent.mjs';
import { createOcrExpenseAgentRouter }  from './controllers/ocr-expense-agent.mjs';
import { createOcrInwardAgentRouter }   from './controllers/ocr-inward-agent.mjs';
import { createOcrGatePassAgentRouter } from './controllers/ocr-gatepass-agent.mjs';
import { createOcrDocumentAgentRouter } from './controllers/ocr-document-agent.mjs';
import { createThreeWayMatchRouter }    from './controllers/three-way-match-agent.mjs';
import { createMenuMasterRouter }        from './controllers/master-data-agent.mjs';
import { createScViewRouter }            from './controllers/sc-view-agent.mjs';
import { createScFormRouter }            from './controllers/sc-form-agent.mjs';
import { createScWizardRouter }          from './controllers/sc-wizard-agent.mjs';
import { createRolesPermissionsRouter }  from './controllers/roles-permissions.mjs';
import { createAPInvToAPCMAgentRouter }     from './controllers/apinv-to-apcm-agent.mjs';
import { createSalesQuotationRouter }       from './controllers/sales-quotation-agent.mjs';
import { createQuotationComparisonRouter }  from './controllers/quotation-comparison-agent.mjs';
import { createQuotationToOrderRouter }     from './controllers/quotation-to-order-agent.mjs';
import { createOrderToDeliveryRouter }      from './controllers/order-to-delivery-agent.mjs';
import { createDeliveryToARInvRouter }      from './controllers/delivery-to-arinv-agent.mjs';
import { createARInvToARCMRouter }          from './controllers/arinv-to-arcm-agent.mjs';
import { createIncomingPaymentRouter }      from './controllers/incoming-payment-agent.mjs';
import { createOutgoingPaymentRouter }      from './controllers/outgoing-payment-agent.mjs';
import db, { userRepo, sessionRepo, connRepo, verifyPassword, queryCacheRepo, dbConnRepo, mailConfigRepo, roleRepo, userPermRepo, cacheRepo, ALL_PERMISSIONS, schemaRepo, sqlCacheRepo, brandingRepo, ocrDocumentsRepo } from "./db.mjs";
import { createDataSyncRouter } from './controllers/data-sync.mjs';
import { createFinancialAgentRouter } from './controllers/financial-agent.mjs';
import { createActivityAgentRouter } from './controllers/activity-agent.mjs';
import { createVendorPaymentAgingRouter } from './controllers/vendor-payment-aging-agent.mjs';
import { createPurchaseAnalysisRouter } from './controllers/purchase-analysis-agent.mjs';
import { createSalesAnalysisRouter } from './controllers/sales-analysis-agent.mjs';
import { connectDB, disconnectDB, executeSQL, testConnection as testDBConn, isConnected, getActiveType, getActiveConfig, SAP_B1_SCHEMA, tableRef, fetchLiveUDFs, fetchRawUDFs, invalidateUDFCache, getTableColumns, resolveFieldMap } from "./db-connector.mjs";
import { loadCompanyContext, buildSqlContext, buildAiSummary, buildDimBlock, buildRegistryBlock, getDimMap, invalidateCache as invalidateContextCache, BASE_SCHEMA } from "./company-context.mjs";
import { REPORT_CATEGORIES, listReports, getReport, runReport as runReportSQL } from "./reports-engine.mjs";
import { handleV2Chat, classifyIntent, generateSQL, lintSql, buildMultiTabExcelReport } from "./analytics-v2.mjs";
import { matchTemplate } from "./query-templates.mjs";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.CHAT_PORT || 3000;
const HTTPS_PORT = process.env.CHAT_HTTPS_PORT || 3443;
const TLS_KEY_PATH = path.join(__dirname, "certs", "localhost-key.pem");
const TLS_CERT_PATH = path.join(__dirname, "certs", "localhost-cert.pem");
const AI_PROVIDER = (process.env.AI_PROVIDER || "anthropic").toLowerCase();
const GPT_AVAILABLE = !!(
  process.env.DEMO_MODE !== "true" &&
  process.env.AZURE_GPT_ENDPOINT &&
  process.env.AZURE_OPENAI_API_KEY
);
const USE_AI = !!(
  process.env.DEMO_MODE !== "true" &&
  (AI_PROVIDER === "gpt"
    ? GPT_AVAILABLE  // GPT-4o mode
    : AI_PROVIDER === "azure"
      ? (process.env.AZURE_OPENAI_API_KEY && process.env.AZURE_OPENAI_ENDPOINT)
      : (process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_API_KEY.startsWith("your-")))
);

// ---------------------------------------------------------------------------
// Direct SAP B1 client (for suggest / fetch endpoints)
// ---------------------------------------------------------------------------
class SapDirectClient {
  constructor() {
    this._activeUrl = (process.env.SAP_B1_BASE_URL || "").replace(/\/+$/, "");
    this.sessionId = null;
    this.routeId = null;
    this._connCredentials = null;
    this.http = axios.create({
      timeout: 20000,
      headers: { "Content-Type": "application/json" },
      httpsAgent: new https.Agent({
        rejectUnauthorized: false,
      }),
      validateStatus: () => true,
    });
  }

  // Always read the current env var so company switches are reflected
  get baseUrl() {
    const current = (this._connCredentials?.base_url || process.env.SAP_B1_BASE_URL || "").replace(/\/+$/, "");
    if (current !== this._activeUrl) {
      // URL changed (company switched) — invalidate session
      this.sessionId = null;
      this.routeId   = null;
      this._activeUrl = current;
    }
    return current;
  }

  async login() {
    const url = this.baseUrl;
    const creds = this._connCredentials || {};
    const res = await this.http.post(`${url}/Login`, {
      CompanyDB: creds.company     || process.env.SAP_B1_COMPANY,
      UserName:  creds.sl_user     || process.env.SAP_B1_USER,
      Password:  creds.sl_password || process.env.SAP_B1_PASSWORD,
    });
    for (const c of (res.headers["set-cookie"] || [])) {
      const [pair] = c.split(";");
      const [name, value] = pair.split("=");
      if (name === "B1SESSION") this.sessionId = value;
      if (name === "ROUTEID")   this.routeId   = value;
    }
    if (!this.sessionId) throw new Error("SAP login failed – B1SESSION not returned");
  }

  cookieHeader() {
    return [`B1SESSION=${this.sessionId}`, this.routeId ? `ROUTEID=${this.routeId}` : ""]
      .filter(Boolean).join("; ");
  }

  async get(path, params = {}) {
    const url = this.baseUrl;
    if (!this.sessionId) await this.login();
    const call = () => this.http.get(`${url}${path}`, {
      params,
      headers: { Cookie: this.cookieHeader() },
    });
    let res = await call();
    if (res.status === 401) { this.sessionId = null; await this.login(); res = await call(); }
    if (res.status < 200 || res.status >= 300)
      throw new Error(`SAP ${res.status}: ${JSON.stringify(res.data)}`);
    return res.data;
  }

}

// Add POST method to SapDirectClient prototype for SMLSVC
SapDirectClient.prototype.post = async function(path, body) {
  const url = this.baseUrl;
  if (!this.sessionId) await this.login();
  const call = () => this.http.post(`${url}${path}`, body, {
    headers: { Cookie: this.cookieHeader() },
  });
  let res = await call();
  if (res.status === 401) { this.sessionId = null; await this.login(); res = await call(); }
  if (res.status < 200 || res.status >= 300)
    throw new Error(`SAP ${res.status}: ${JSON.stringify(res.data)}`);
  return res.data;
};

SapDirectClient.prototype.patch = async function(path, body) {
  const url = this.baseUrl;
  if (!this.sessionId) await this.login();
  const call = () => this.http.patch(`${url}${path}`, body, {
    headers: { Cookie: this.cookieHeader() },
  });
  let res = await call();
  if (res.status === 401) { this.sessionId = null; await this.login(); res = await call(); }
  if (res.status < 200 || res.status >= 300)
    throw new Error(`SAP ${res.status}: ${JSON.stringify(res.data)}`);
  return res.data;
};

const sap = new SapDirectClient();

// ── Per-session multi-company support ──────────────────────────────────────
const _sapPool = new Map();          // connId (number) → SapDirectClient
const _sessConn = new Map();         // authToken (string) → connId (number)

function _getPoolClient(conn) {
  if (!_sapPool.has(conn.id)) {
    const c = new SapDirectClient();
    c._activeUrl = (conn.base_url || "").replace(/\/+$/, "");
    c._connCredentials = conn;  // store for login()
    _sapPool.set(conn.id, c);
  }
  return _sapPool.get(conn.id);
}

function getActiveSap() {
  return _reqCtx.getStore()?.sap ?? sap;
}

const _reqCtx = new AsyncLocalStorage();

function esc(s) { return String(s || "").replace(/'/g, "''"); }

// ── Request-scoped query log (reset per /api/chat call) ───────────────────────
let _reqQueryLog = [];
function _logQ(entry) { _reqQueryLog.push(entry); }

// ── SMLSVC Namespace resolution ───────────────────────────────────────────────
const NAMESPACE_MAP = {
  "SBO_DEMO_GB":       "sap.sbodemogb",
  "SBO_DEMO_US":       "sap.sbodemos",
  "SBO_DEMO_IN":       "sap.sbodemoin",
  "SBO_DEMO_DE":       "sap.sbodemode",
  "SBO_DEMO_AU":       "sap.sbodemoau",
  "SILVERTOUCH_LIVE":  "sap.silvertouch",
  "SILVERTOUCH_TEST":  "sap.silvertouchtest",
  "ME0925_SADP":       "sap.me0925sadp",
  "WMS_DEV_UK":        "sap.me0925sadp",
  "SBO_DEMO_UK":       "sap.me0925sadp",
};

// ── Follow-up context: stores last brand/dimension result so the user can drill down ─
// Reset each time a new brand analysis runs; keyed per session via _lastSAContext.
let _lastSAContext = null; // { dimField, dimName, brands: Set, fromDate, toDate }

let _cachedNamespace = process.env.SL_NAMESPACE || null;
const _activeCompany  = process.env.SL_COMPANY || process.env.SAP_B1_COMPANY || "";

async function getNamespace() {
  if (_cachedNamespace) return _cachedNamespace;
  if (NAMESPACE_MAP[_activeCompany]) return (_cachedNamespace = NAMESPACE_MAP[_activeCompany]);
  // Auto-discover from sml.svc service document
  try {
    const res = await getActiveSap().get("/sml.svc/");
    const queries = Array.isArray(res.value) ? res.value : [];
    const match   = queries.find(q => q.QueryName?.includes("SalesAnalysis"));
    if (match?.QueryName) {
      _cachedNamespace = match.QueryName.split(".ar.case")[0];
      NAMESPACE_MAP[_activeCompany] = _cachedNamespace;
      return _cachedNamespace;
    }
  } catch { /* ignore — will fall back to GET */ }
  return null;
}

// Call SMLSVC via POST+ParamList (Section 4 protocol)
// Falls back to GET OData if namespace unavailable or POST fails
async function callSMLSVCPost(queryType = "sales", paramList = []) {
  const ns = await getNamespace();
  // sales uses bare SalesAnalysisQuery — no namespace required
  if (!ns && queryType !== 'sales') throw new Error("SMLSVC namespace unavailable — use GET fallback");
  const QUERY = {
    sales:     `SalesAnalysisQuery`,              // direct path — ar.case does not exist in this deployment
    purchase:  `${ns}.ap.case/PurchaseAnalysis`,
    inventory: `${ns}.inv.case/InventoryStatus`,
    financial: `${ns}.fin.case/FinancialAnalysis`,
  };
  const queryPath = `/sml.svc/${QUERY[queryType]}`;
  _logQ({ method: 'SMLSVC POST', endpoint: queryPath, params: Object.fromEntries(paramList.map(p => [p.Name, p.Value])) });
  const data = await getActiveSap().post(queryPath, { ParamList: paramList });
  const rows = Array.isArray(data.value) ? data.value : [];
  _reqQueryLog[_reqQueryLog.length - 1].rows = rows.length;
  return rows;
}

// Build ParamList array (dates as YYYYMMDD)
function buildParamList({ fromDate, toDate, cardCode, itemCode, whsCode, slpCode } = {}) {
  const p = [];
  const f = d => d?.replace(/-/g, "") || "";
  if (fromDate) p.push({ Name:"FromDate",  Value: f(fromDate) });
  if (toDate)   p.push({ Name:"ToDate",    Value: f(toDate) });
  if (cardCode) p.push({ Name:"CardCode",  Value: cardCode });
  if (itemCode) p.push({ Name:"ItemCode",  Value: itemCode });
  if (whsCode)  p.push({ Name:"WhsCode",   Value: whsCode });
  if (slpCode)  p.push({ Name:"SlpCode",   Value: slpCode });
  return p;
}

// Client-side aggregation (Section 7 protocol)
function aggregateRows(rows, groupFields, measures = ["NetSalesAmountLC","GrossProfitLC","QuantityInInventoryUoM"]) {
  const map = new Map();
  for (const row of rows) {
    const key = groupFields.map(f => String(row[f] ?? "")).join("||");
    if (!map.has(key)) {
      const rec = {};
      for (const f of groupFields) rec[f] = row[f];
      for (const f of measures) rec[f] = 0;
      map.set(key, rec);
    }
    const rec = map.get(key);
    for (const f of measures) rec[f] += Number(row[f] || 0);
  }
  for (const rec of map.values()) {
    const s = Number(rec.NetSalesAmountLC || 0);
    const g = Number(rec.GrossProfitLC    || 0);
    rec.GPMarginPct = s > 0 ? +((g/s)*100).toFixed(2) : 0;
  }
  return [...map.values()];
}

// ---------------------------------------------------------------------------
// MCP Client
// ---------------------------------------------------------------------------
let mcpClient = null;
let mcpTools  = [];

async function startMcpClient() {
  try {
    const transport = new StdioClientTransport({
      command: "node",
      args: [path.join(__dirname, "dist", "server.js")],
      env: { ...process.env },
    });
    mcpClient = new Client({ name: "sap-b1-chat", version: "1.0.0" }, { capabilities: {} });
    await mcpClient.connect(transport);
    const { tools } = await mcpClient.listTools();
    mcpTools = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema }));
    console.log(`MCP connected. ${mcpTools.length} tools available.`);
  } catch (err) {
    console.error("MCP connect failed:", err.message);
  }
}

async function callTool(name, args = {}) {
  if (!mcpClient) throw new Error("MCP client not connected");
  const result = await mcpClient.callTool({ name, arguments: args });
  const text = Array.isArray(result.content)
    ? result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n")
    : JSON.stringify(result);
  return JSON.parse(text);
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------
function fmt(n, d = 2) {
  return n == null ? "—" : Number(n).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
}
function tbl(headers, rows) {
  if (!rows.length) return "_No records_";
  return [
    "| " + headers.join(" | ") + " |",
    "| " + headers.map(() => "---").join(" | ") + " |",
    ...rows.map((r) => "| " + r.map((v) => String(v ?? "—").replace(/\|/g, "\\|")).join(" | ") + " |"),
  ].join("\n");
}

const formatCustomers = (d) => !d.customers?.length ? "No customers found." :
  `### Customers (${d.total} found)\n\n` + tbl(
    ["Code", "Name", "City", "Country", "Phone", "Email", "Balance", "Credit Limit", "Status"],
    d.customers.map((c) => [`**${c.cardCode}**`, c.cardName || "—", c.city || "—", c.country || "—",
      c.phone || "—", c.email || "—", fmt(c.currentBalance), fmt(c.creditLimit),
      c.frozen ? "❌ Frozen" : "✅ Active"])
  );

const formatStock = (d) => !d.items?.length ? "No stock found." :
  `### Stock Levels\n\n**Items:** ${d.summary.itemCount} | **On Stock:** ${fmt(d.summary.totalOnStock,0)} | **Available:** ${fmt(d.summary.totalAvailable,0)}\n\n` +
  tbl(["Item Code","Item Name","On Stock","Committed","On Order","Available","Unit","Status"],
    d.items.map((i) => [`**${i.itemCode}**`, i.itemName||"—",
      fmt(i.onStock,0), fmt(i.committed,0), fmt(i.onOrder,0), fmt(i.available,0),
      i.unit||"—", i.belowMin?"⚠️ Low":"✅ OK"]));

const formatCollections = (d) => !d.customers?.length
  ? `✅ No overdue invoices (>${d.overdueMoreThanDays} days as of ${d.asOfDate}).`
  : `### Collections Worklist — ${d.asOfDate} (>${d.overdueMoreThanDays} days)\n\n**Total: ${fmt(d.customers.reduce((s,c)=>s+c.totalOutstanding,0))}**\n\n` +
    tbl(["Code","Customer","Outstanding","Max Overdue","Invoices","Dunning?"],
      d.customers.map((c) => [`**${c.cardCode}**`, c.cardName, fmt(c.totalOutstanding),
        Math.max(...c.invoices.map((i)=>i.overdueDays))+" days", String(c.invoices.length),
        c.dunningRecommended?"🔴 Yes":"🟡 No"]));

const formatAtp = (d) => !d.results?.length ? "No ATP results." :
  `### ATP Check Results\n\n` + tbl(
    ["Item Code","Item Name","Required","In Stock","Committed","On Order","Available","Status"],
    d.results.map((r) => [`**${r.itemCode}**`, r.itemName||"—",
      fmt(r.requiredQty,0), fmt(r.inStock,0), fmt(r.committed,0), fmt(r.onOrder,0), fmt(r.availableQty,0),
      r.status==="CONFIRMED"?"✅ In Stock":r.status==="BACKORDER"?"⚠️ Backorder":"❌ "+r.status]));

const formatPickList = (d) => !d.lines?.length ? "No pick list lines." :
  `### Pick List — Order ${d.salesOrderDocEntry}\n\n` +
  tbl(["Item Code","Item Name","Qty","Warehouse","Bin"],
    d.lines.map((l) => [`**${l.itemCode}**`, l.itemName||"—", fmt(l.quantity,0), l.warehouseCode||"—", l.binCode||"—"]));

const formatQuotation = (d) => {
  const q = d.quotation;
  let out = `### ✅ Sales Quotation Created\n\n| | |\n|---|---|\n|**Doc #**|${q.DocNum}|\n|**Entry**|${q.DocEntry}|\n|**Customer**|${q.CardCode}|\n|**Total**|${fmt(q.DocTotal)} ${q.DocCurrency||""}|`;
  if (d.approvalRequired) out += `\n\n⚠️ **Approval needed:**\n` + d.approvalReasons.map((r)=>`- ${r}`).join("\n");
  out += `\n\n[🖨️ Print Quotation](/api/print/quotation/${q.DocEntry}){:target="_blank"}`;
  return out;
};

const formatSalesOrder = (d) => d.status === "BLOCKED_BY_CREDIT_LIMIT"
  ? `### ❌ Blocked — Credit Limit\n\n|Field|Value|\n|---|---|\n|**Customer**|${d.cardCode}|\n|**Credit Limit**|${fmt(d.creditLimit)}|\n|**Projected**|${fmt(d.projectedExposure)}|`
  : `### ✅ Sales Order Created\n\n|Field|Value|\n|---|---|\n|**Doc #**|${d.salesOrder.DocNum}|\n|**Entry**|${d.salesOrder.DocEntry}|\n|**Customer**|${d.salesOrder.CardCode}|\n|**Total**|${fmt(d.salesOrder.DocTotal)} ${d.salesOrder.DocCurrency||""}|\n\n[🖨️ Print Order](/api/print/order/${d.salesOrder.DocEntry}){:target="_blank"}`;

const formatDelivery = (d) =>
  `### ✅ Delivery Note Created\n\n|Field|Value|\n|---|---|\n|**Doc #**|${d.delivery.DocNum}|\n|**Entry**|${d.delivery.DocEntry}|\n|**Customer**|${d.delivery.CardCode}|${d.trackingNumber?`\n|**Tracking**|${d.trackingNumber}|`:""}\n\n[🖨️ Print Delivery](/api/print/delivery/${d.delivery.DocEntry}){:target="_blank"}`;

const formatPod   = (d) => `### ✅ POD Confirmed\n\n|Field|Value|\n|---|---|\n|**Delivery**|${d.deliveryDocEntry}|\n|**Reference**|${d.podReference}|${d.exceptions?`\n|**Exceptions**|${d.exceptions}|`:""}`;
const formatInvoice = (d) => `### ✅ A/R Invoice Created\n\n|Field|Value|\n|---|---|\n|**Doc #**|${d.invoice.DocNum}|\n|**Entry**|${d.invoice.DocEntry}|\n|**Customer**|${d.invoice.CardCode}|\n|**Total**|${fmt(d.invoice.DocTotal)} ${d.invoice.DocCurrency||""}|\n|**Due**|${d.invoice.DocDueDate?.slice(0,10)||"—"}|\n\n[🖨️ Print Invoice](/api/print/invoice/${d.invoice.DocEntry}){:target="_blank"}`;
const formatPayment = (d) => `### ✅ Payment Applied\n\n|Field|Value|\n|---|---|\n|**Doc #**|${d.payment.DocNum}|\n|**Entry**|${d.payment.DocEntry}|\n|**Customer**|${d.payment.CardCode}|\n|**Amount**|${fmt(d.payment.TransferSum||d.payment.CashSum)}|\n|**Cleared**|${d.clearedInvoices?.length||0} invoice(s)|`;

// P2P formatters
const formatPurchaseOrder = (d) =>
  `### ✅ Purchase Order Created\n\n|Field|Value|\n|---|---|\n|**Doc #**|${d.purchaseOrder.DocNum}|\n|**Entry**|${d.purchaseOrder.DocEntry}|\n|**Vendor**|${d.purchaseOrder.CardCode}|\n|**Total**|${fmt(d.purchaseOrder.DocTotal)} ${d.purchaseOrder.DocCurrency||""}|`;
const formatGrpo = (d) =>
  `### ✅ Goods Receipt PO Created\n\n|Field|Value|\n|---|---|\n|**Doc #**|${d.goodsReceiptPO.DocNum}|\n|**Entry**|${d.goodsReceiptPO.DocEntry}|\n|**Vendor**|${d.goodsReceiptPO.CardCode}|\n|**Date**|${d.goodsReceiptPO.DocDate}|\n|**Total**|${fmt(d.goodsReceiptPO.DocTotal)}|`;
const formatApInvoice = (d) =>
  `### ✅ A/P Invoice Created\n\n|Field|Value|\n|---|---|\n|**Doc #**|${d.apInvoice.DocNum}|\n|**Entry**|${d.apInvoice.DocEntry}|\n|**Vendor**|${d.apInvoice.CardCode}|\n|**Total**|${fmt(d.apInvoice.DocTotal)}|\n|**Due**|${d.apInvoice.DocDueDate?.slice(0,10)||"—"}|`;
const formatOutgoingPayment = (d) =>
  `### ✅ Vendor Payment Applied\n\n|Field|Value|\n|---|---|\n|**Doc #**|${d.payment.DocNum}|\n|**Entry**|${d.payment.DocEntry}|\n|**Vendor**|${d.payment.CardCode}|\n|**Amount**|${fmt(d.payment.TransferSum||d.payment.CashSum)}|\n|**Cleared**|${d.clearedInvoices?.length||0} invoice(s)|`;

// ---------------------------------------------------------------------------
// QUERY ENGINE — Natural Language → SAP Service Layer / sml.svc
// ---------------------------------------------------------------------------

// ── Date helpers ────────────────────────────────────────────────────────────
function yearFilter(m) {
  const now = new Date();
  if (/this year/.test(m))  return { y: now.getFullYear() };
  if (/last year/.test(m))  return { y: now.getFullYear() - 1 };
  const ym = m.match(/\b(20\d\d)\b/);
  if (ym) return { y: parseInt(ym[1]) };
  return { y: now.getFullYear() }; // default current year
}
function fromToForYear(y) {
  return { fromDate:`${y}-01-01`, toDate:`${y}-12-31` };
}

// ── Cost-Centre Sales/Purchase Analysis (Service Layer — no HANA required) ───
// Uses CostingCode* fields on DocumentLines, which always work via SL REST API.
// Field mapping: CostingCode=Brand, CostingCode2=SubBrand, CostingCode3=Budget,
//                CostingCode4=Universe, CostingCode5=CogsCustomer
const CC_SL_FIELD  = { CogsOcrCod:"CostingCode", CogsOcrCo2:"CostingCode2", CogsOcrCo3:"CostingCode3", CogsOcrCo4:"CostingCode4", CogsOcrCo5:"CostingCode5" };

// Maps HANA view groupBy field → SQL expression builder (h = isHana boolean)
// Used by SQL-first block to build multi-dimensional GROUP BY queries.
const SA_FIELD_TO_SQL = {
  CogsOcrCod:                 h => h ? `T1."OcrCode"`    : `T1.OcrCode`,
  CogsOcrCo2:                 h => h ? `T1."OcrCode2"`   : `T1.OcrCode2`,
  CogsOcrCo3:                 h => h ? `T1."OcrCode3"`   : `T1.OcrCode3`,
  CogsOcrCo4:                 h => h ? `T1."OcrCode4"`   : `T1.OcrCode4`,
  CogsOcrCo5:                 h => h ? `T1."OcrCode5"`   : `T1.OcrCode5`,
  BusinessPartnerCode:        h => h ? `T0."CardCode"`   : `T0.CardCode`,
  BusinessPartnerName:        h => h ? `T0."CardName"`   : `T0.CardName`,
  ItemCode:                   h => h ? `T1."ItemCode"`   : `T1.ItemCode`,
  ItemDescription:            h => h ? `T1."Dscription"` : `T1.Dscription`,
  WarehouseCode:              h => h ? `T1."WhsCode"`    : `T1.WhsCode`,
  SalesEmployeeOrBuyerNumber: h => h ? `T0."SlpCode"`   : `T0.SlpCode`,
  PostingYear:                h => h ? `YEAR(T0."DocDate")`                                                          : `YEAR(T0.DocDate)`,
  PostingYearAndMonth:        h => h ? `YEAR(T0."DocDate")||'-'||LPAD(MONTH(T0."DocDate"),2,'0')`                   : `FORMAT(T0.DocDate,'yyyy-MM')`,
  PostingYearAndQuarter:      h => h ? `YEAR(T0."DocDate")||'-Q'||CEIL(MONTH(T0."DocDate")/3)`                      : `CAST(YEAR(T0.DocDate) AS VARCHAR)+'-Q'+CAST(CEILING(MONTH(T0.DocDate)/3.0) AS VARCHAR)`,
};

// ── Configurable dimension names (read from .env — set per company) ───────────
const DIM_NAMES = {
  1: (process.env.DIM1_NAME || "Brand").toLowerCase(),
  2: (process.env.DIM2_NAME || "Sub Brand").toLowerCase(),
  3: (process.env.DIM3_NAME || "Budget").toLowerCase(),
  4: (process.env.DIM4_NAME || "Universe").toLowerCase(),
  5: (process.env.DIM5_NAME || "Cogs Customer").toLowerCase(),
};
const CC_DIM_NAME  = {
  CogsOcrCod: process.env.DIM1_NAME || "Brand",
  CogsOcrCo2: process.env.DIM2_NAME || "Sub Brand",
  CogsOcrCo3: process.env.DIM3_NAME || "Budget",
  CogsOcrCo4: process.env.DIM4_NAME || "Universe",
  CogsOcrCo5: process.env.DIM5_NAME || "Cogs Customer",
};

// ── Complete SalesAnalysisQuery field registry ────────────────────────────────
// All fields available in the HANA SalesAnalysisQuery view + Service Layer fallback.
// aliases[] = natural-language phrases users might say (lowercase). Used by
// detectDimensions() to map any user phrasing to the correct HANA field.
const SA_DIMENSIONS = [
  { hanaField:"BusinessPartnerCode", slHeaderField:"CardCode",   slLineField:null,
    label:"Customer", dimCols:["BusinessPartnerCode","BusinessPartnerName"], dimLabels:["Code","Customer"],
    group:"header",
    aliases:["customer","client","account","debtor","business partner","bp","buyer",
             "customer wise","client wise","by customer","by client","per customer",
             "customer code","customer name","customer wise sales","clientwise"] },

  { hanaField:"ItemCode", slHeaderField:null, slLineField:"ItemCode",
    label:"Item", dimCols:["ItemCode","ItemDescription"], dimLabels:["Item Code","Description"],
    group:"line",
    aliases:["item","product","sku","article","goods","material","part",
             "item wise","product wise","by item","by product","per item","per product",
             "item code","item name","item wise sales","productwise"] },

  { hanaField:"ItemGroup", slHeaderField:null, slLineField:null,
    label:"Item Group", dimCols:["ItemGroup"], dimLabels:["Item Group"],
    group:"hana_only",
    aliases:["item group","product group","category","product category","group wise",
             "by category","by item group","by product group","item group wise"] },

  { hanaField:"SalesEmployeeOrBuyerNumber", slHeaderField:"SalesPersonCode", slLineField:null,
    label:"Salesperson", dimCols:["SalesEmployeeOrBuyerNumber","SalesEmployeeOrBuyerName"], dimLabels:["Emp#","Salesperson"],
    group:"header",
    aliases:["salesperson","sales person","sales rep","salesrep","employee","staff",
             "rep","sales employee","by salesperson","by sales rep","per salesperson",
             "salesperson wise","sales rep wise","slp wise","by slp","sales rep performance"] },

  { hanaField:"WarehouseCode", slHeaderField:null, slLineField:"WarehouseCode",
    label:"Warehouse", dimCols:["WarehouseCode","WarehouseName"], dimLabels:["WH","Warehouse"],
    group:"line",
    aliases:["warehouse","whs","store","stock location","warehouse wise","by warehouse",
             "per warehouse","warehouse wise sales","storewise"] },

  { hanaField:"TerritoryName", slHeaderField:null, slLineField:null,
    label:"Territory", dimCols:["TerritoryName"], dimLabels:["Territory"],
    group:"hana_only",
    aliases:["territory","region","area","zone","territory wise","by territory",
             "by region","region wise","area wise","per territory"] },

  { hanaField:"BranchCode", slHeaderField:null, slLineField:null,
    label:"Branch", dimCols:["BranchCode","BranchName"], dimLabels:["Branch","Branch Name"],
    group:"hana_only",
    aliases:["branch","office","location","branch wise","by branch","per branch","branchwise"] },

  { hanaField:"PostingYearAndMonth", slHeaderField:"DocDate", slLineField:null,
    label:"Month", dimCols:["PostingYearAndMonth"], dimLabels:["Month"],
    group:"period",
    aliases:["monthly","by month","per month","month by month","month wise","month trend",
             "month-wise","each month","monthwise"] },

  { hanaField:"PostingYearAndQuarter", slHeaderField:"DocDate", slLineField:null,
    label:"Quarter", dimCols:["PostingYearAndQuarter"], dimLabels:["Quarter"],
    group:"period",
    aliases:["quarterly","by quarter","per quarter","quarter wise","quarter trend","quarterwise"] },

  { hanaField:"PostingYear", slHeaderField:"DocDate", slLineField:null,
    label:"Year", dimCols:["PostingYear"], dimLabels:["Year"],
    group:"period",
    aliases:["yearly","annual","annually","by year","per year","year wise","year over year",
             "year trend","yoy","yearwise"] },

  // Cost-centre dimensions — names are env-configurable
  { hanaField:"CogsOcrCod", slHeaderField:null, slLineField:"CostingCode",
    label: CC_DIM_NAME.CogsOcrCod, dimCols:["CogsOcrCod"], dimLabels:[CC_DIM_NAME.CogsOcrCod],
    group:"cc",
    aliases:[DIM_NAMES[1], `${DIM_NAMES[1]} wise`, `by ${DIM_NAMES[1]}`, `per ${DIM_NAMES[1]}`,
             `${DIM_NAMES[1]}wise`, "dim1","dimension 1","cost center 1","cogsocrcod","cogs dim1"] },

  { hanaField:"CogsOcrCo2", slHeaderField:null, slLineField:"CostingCode2",
    label: CC_DIM_NAME.CogsOcrCo2, dimCols:["CogsOcrCo2"], dimLabels:[CC_DIM_NAME.CogsOcrCo2],
    group:"cc",
    aliases:[DIM_NAMES[2], `${DIM_NAMES[2]} wise`, `by ${DIM_NAMES[2]}`, `per ${DIM_NAMES[2]}`,
             `${DIM_NAMES[2].replace(/\s+/,'')}`, "dim2","dimension 2","cost center 2","cogsoco2"] },

  { hanaField:"CogsOcrCo3", slHeaderField:null, slLineField:"CostingCode3",
    label: CC_DIM_NAME.CogsOcrCo3, dimCols:["CogsOcrCo3"], dimLabels:[CC_DIM_NAME.CogsOcrCo3],
    group:"cc",
    aliases:[DIM_NAMES[3], `${DIM_NAMES[3]} wise`, `by ${DIM_NAMES[3]}`, `per ${DIM_NAMES[3]}`,
             "dim3","dimension 3","cost center 3"] },

  { hanaField:"CogsOcrCo4", slHeaderField:null, slLineField:"CostingCode4",
    label: CC_DIM_NAME.CogsOcrCo4, dimCols:["CogsOcrCo4"], dimLabels:[CC_DIM_NAME.CogsOcrCo4],
    group:"cc",
    aliases:[DIM_NAMES[4], `${DIM_NAMES[4]} wise`, `by ${DIM_NAMES[4]}`, `per ${DIM_NAMES[4]}`,
             "dim4","dimension 4","cost center 4"] },

  { hanaField:"CogsOcrCo5", slHeaderField:null, slLineField:"CostingCode5",
    label: CC_DIM_NAME.CogsOcrCo5, dimCols:["CogsOcrCo5"], dimLabels:[CC_DIM_NAME.CogsOcrCo5],
    group:"cc",
    aliases:[DIM_NAMES[5], `${DIM_NAMES[5]} wise`, `by ${DIM_NAMES[5]}`, `per ${DIM_NAMES[5]}`,
             "dim5","dimension 5","cost center 5"] },
];

// ── Detect which dimensions a message is requesting ──────────────────────────
// Returns { groupBy[], dimCols[], dimLabels[] } based on SA_DIMENSIONS registry.
// Falls back to customer grouping if nothing matched.
function detectDimensions(msg) {
  const m = msg.toLowerCase().replace(/[^\w\s]/g, ' ');
  const groupBy = [], dimCols = [], dimLabels = [];

  for (const dim of SA_DIMENSIONS) {
    if (dim.aliases.some(alias => m.includes(alias))) {
      if (!groupBy.includes(dim.hanaField)) {
        groupBy.push(dim.hanaField);
        dim.dimCols.forEach(c => { if (!dimCols.includes(c)) dimCols.push(c); });
        dim.dimLabels.forEach(l => { if (!dimLabels.includes(l)) dimLabels.push(l); });
      }
    }
  }
  return { groupBy, dimCols, dimLabels };
}

// Build a regex pattern from analytics-specific dimension aliases (for detectIntent routing).
// Only use compound phrases ("customer wise", "by brand") or clearly analytical words
// ("brandwise", "monthly", "yoy"). Exclude bare short words ("customer", "item") to avoid
// hijacking the customer-list, stock, etc. intent checks that come after sales_analysis.
const _dimAliasPattern = SA_DIMENSIONS
  .flatMap(d => d.aliases)
  .filter(a => a.includes(' ') || a.endsWith('wise') || a.endsWith('trend')
            || a.includes('yoy') || a.includes('annual')
            || (a.length > 8 && !['salesperson','territory','warehouse','quarterly','yearwise','yearover'].some(x => a === x)))
  .map(a => a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  .join('|');

// ── Generic follow-up drill-down ──────────────────────────────────────────────
// Works for ANY dimension from the last sales_analysis result.
// Maps each HANA view groupBy field → SQL column + table alias.
const DIM_SQL_FILTER = {
  CogsOcrCod:                  { tbl:'T1', col:'OcrCode'  },
  CogsOcrCo2:                  { tbl:'T1', col:'OcrCode2' },
  CogsOcrCo3:                  { tbl:'T1', col:'OcrCode3' },
  CogsOcrCo4:                  { tbl:'T1', col:'OcrCode4' },
  CogsOcrCo5:                  { tbl:'T1', col:'OcrCode5' },
  BusinessPartnerCode:         { tbl:'T0', col:'CardCode' },
  BusinessPartnerName:         { tbl:'T0', col:'CardName' },
  ItemCode:                    { tbl:'T1', col:'ItemCode' },
  WarehouseCode:               { tbl:'T1', col:'WhsCode'  },
  SalesEmployeeOrBuyerNumber:  { tbl:'T0', col:'SlpCode', numeric: true },
};

async function queryDimensionDetail(value, ctx) {
  const { groupByField, dimName, fromDate, toDate } = ctx;

  // Auto-reconnect if needed
  if (!isConnected()) {
    const savedDb = dbConnRepo.getActive();
    if (savedDb) { try { await connectDB(savedDb); } catch {} }
  }
  if (!isConnected()) {
    return `**${dimName} Detail: ${value}**\n\nNo database connected — cannot run drill-down.`;
  }

  const cfg    = getActiveConfig();
  const isHana = getActiveType() === 'hana';
  const inv0   = tableRef('OINV', cfg);
  const inv1   = tableRef('INV1', cfg);
  const q      = s => isHana ? `"${s}"` : s; // quote for HANA

  // Common column refs
  const LT   = `${q('T1')}.${q('LineTotal')}`.replace('"T1"',  'T1');  // keep alias unquoted
  const GP   = `T1.${isHana?'"GrssProfit"':'GrssProfit'}`;
  const QTY  = `T1.${isHana?'"Quantity"':'Quantity'}`;
  const DE   = `T0.${isHana?'"DocEntry"':'DocEntry'}`;
  const JOIN = isHana ? `T0."DocEntry"=T1."DocEntry"` : `T0.DocEntry=T1.DocEntry`;
  const CC   = `T0.${isHana?'"CardCode"':'CardCode'}`;
  const CN   = `T0.${isHana?'"CardName"':'CardName'}`;
  const IC   = `T1.${isHana?'"ItemCode"':'ItemCode'}`;
  const IDesc= `T1.${isHana?'"Dscription"':'Dscription'}`;
  const OCR  = `T1.${isHana?'"OcrCode"':'OcrCode'}`;

  // Date filter
  const dateFlt = isHana
    ? `T0."DocDate" BETWEEN '${fromDate}' AND '${toDate}'`
    : `T0.DocDate BETWEEN '${fromDate}' AND '${toDate}'`;

  // Dimension-specific WHERE clause
  const esc   = String(value).replace(/'/g, "''");
  const finfo = DIM_SQL_FILTER[groupByField];
  let dimFlt;
  if (finfo) {
    const colRef = isHana ? `${finfo.tbl}."${finfo.col}"` : `${finfo.tbl}.${finfo.col}`;
    dimFlt = finfo.numeric ? `${colRef}=${esc}` : `${colRef}='${esc}'`;
  } else if (/PostingYear/.test(groupByField)) {
    // year-based: value is YYYY or YYYYMM
    const yr = String(esc).slice(0,4);
    const mo = String(esc).length === 6 ? String(esc).slice(4,6) : null;
    dimFlt = isHana
      ? (mo ? `YEAR(T0."DocDate")=${yr} AND MONTH(T0."DocDate")=${Number(mo)}` : `YEAR(T0."DocDate")=${yr}`)
      : (mo ? `YEAR(T0.DocDate)=${yr} AND MONTH(T0.DocDate)=${Number(mo)}`     : `YEAR(T0.DocDate)=${yr}`);
  } else {
    dimFlt = isHana ? `T0."DocDate" IS NOT NULL` : `T0.DocDate IS NOT NULL`; // fallback (no filter)
  }

  const WHERE = `${dateFlt} AND ${dimFlt}`;

  // What to show in drill-down depends on what was the primary dimension
  const isCust  = ['BusinessPartnerCode','BusinessPartnerName'].includes(groupByField);
  const isItem  = ['ItemCode','ItemDescription'].includes(groupByField);
  const isBrand = ['CogsOcrCod','CogsOcrCo2','CogsOcrCo3','CogsOcrCo4','CogsOcrCo5'].includes(groupByField);
  const isMonth = ['PostingYear','PostingYearAndMonth','PostingYearAndQuarter'].includes(groupByField);
  const isSlp   = groupByField === 'SalesEmployeeOrBuyerNumber';

  const monthExpr = isHana
    ? `YEAR(T0."DocDate")||'-'||LPAD(MONTH(T0."DocDate"),2,'0')`
    : `FORMAT(T0.DocDate,'yyyy-MM')`;

  const parts = [];
  try {
    // 1. Summary
    const [sum] = await executeSQL(
      `SELECT SUM(T1.${isHana?'"LineTotal"':'LineTotal'}) AS SALES, SUM(${GP}) AS GP, SUM(${QTY}) AS QTY, COUNT(DISTINCT ${DE}) AS DOCS FROM ${inv0} T0 INNER JOIN ${inv1} T1 ON ${JOIN} WHERE ${WHERE}`
    );
    const sales  = Number(sum?.SALES||0), gp = Number(sum?.GP||0), qty = Number(sum?.QTY||0), docs = Number(sum?.DOCS||0);
    const margin = sales > 0 ? ((gp/sales)*100).toFixed(1) : '0.0';
    parts.push(`### 🔍 ${dimName} Detail: **${value}** — ${fromDate} → ${toDate}\n\n**Sales:** ${fmt(sales)} | **GP:** ${fmt(gp)} | **Margin:** ${margin}% | **Invoices:** ${docs} | **Qty:** ${fmt(qty,0)}\n`);

    // 2. Top Customers (skip if already grouped by customer)
    if (!isCust) {
      const rows = await executeSQL(`SELECT ${CC} AS CODE, ${CN} AS NAME, SUM(T1.${isHana?'"LineTotal"':'LineTotal'}) AS SALES, SUM(${GP}) AS GP, COUNT(DISTINCT ${DE}) AS DOCS FROM ${inv0} T0 INNER JOIN ${inv1} T1 ON ${JOIN} WHERE ${WHERE} GROUP BY ${CC},${CN} ORDER BY SALES DESC`);
      if (rows.length) parts.push(`\n**Top Customers**\n\n` + tbl(['Code','Name','Sales','GP','Invoices'], rows.slice(0,10).map(r => [r.CODE||'', r.NAME||'', fmt(Number(r.SALES||0)), fmt(Number(r.GP||0)), String(r.DOCS||0)])));
    }

    // 3. Monthly Trend (skip if already a time-based grouping)
    if (!isMonth) {
      const rows = await executeSQL(`SELECT ${monthExpr} AS MON, SUM(T1.${isHana?'"LineTotal"':'LineTotal'}) AS SALES, SUM(${GP}) AS GP FROM ${inv0} T0 INNER JOIN ${inv1} T1 ON ${JOIN} WHERE ${WHERE} GROUP BY ${monthExpr} ORDER BY MON`);
      if (rows.length) parts.push(`\n**Monthly Trend**\n\n` + tbl(['Month','Sales','Gross Profit'], rows.map(r => [r.MON||'', fmt(Number(r.SALES||0)), fmt(Number(r.GP||0))])));
    }

    // 4. Brand breakdown (skip if already grouped by a brand dimension)
    if (!isBrand) {
      const rows = await executeSQL(`SELECT IFNULL(${OCR},'(none)') AS DIM, SUM(T1.${isHana?'"LineTotal"':'LineTotal'}) AS SALES, SUM(${GP}) AS GP FROM ${inv0} T0 INNER JOIN ${inv1} T1 ON ${JOIN} WHERE ${WHERE} AND ${OCR} IS NOT NULL AND ${OCR}!='' GROUP BY ${OCR} ORDER BY SALES DESC`);
      if (rows.length) parts.push(`\n**By Brand**\n\n` + tbl(['Brand','Sales','Gross Profit'], rows.slice(0,15).map(r => [r.DIM||'', fmt(Number(r.SALES||0)), fmt(Number(r.GP||0))])));
    }

    // 5. Top Items (skip if already grouped by item)
    if (!isItem) {
      const rows = await executeSQL(`SELECT ${IC} AS ITEM, ${IDesc} AS DESC, SUM(T1.${isHana?'"LineTotal"':'LineTotal'}) AS SALES, SUM(${QTY}) AS QTY FROM ${inv0} T0 INNER JOIN ${inv1} T1 ON ${JOIN} WHERE ${WHERE} GROUP BY ${IC},${IDesc} ORDER BY SALES DESC`);
      if (rows.length) parts.push(`\n**Top Items / Products**\n\n` + tbl(['Item Code','Description','Sales','Qty'], rows.slice(0,10).map(r => [r.ITEM||'', r.DESC||'', fmt(Number(r.SALES||0)), fmt(Number(r.QTY||0),0)])));
    }

    // 6. Salesperson breakdown (only if not already grouped by slp)
    if (!isSlp) {
      const SLP  = `T0.${isHana?'"SlpCode"':'SlpCode'}`;
      const rows = await executeSQL(`SELECT ${SLP} AS SLP, SUM(T1.${isHana?'"LineTotal"':'LineTotal'}) AS SALES, COUNT(DISTINCT ${DE}) AS DOCS FROM ${inv0} T0 INNER JOIN ${inv1} T1 ON ${JOIN} WHERE ${WHERE} GROUP BY ${SLP} ORDER BY SALES DESC`);
      if (rows.length > 1) parts.push(`\n**By Salesperson**\n\n` + tbl(['Slp Code','Sales','Invoices'], rows.slice(0,10).map(r => [String(r.SLP||''), fmt(Number(r.SALES||0)), String(r.DOCS||0)])));
    }

    const others = [...(ctx.values||[])].filter(v => v !== value).slice(0,3).map(v => `\`${v}\``).join(', ');
    if (others) parts.push(`\n> 💬 You can also ask about: ${others}`);
    return parts.join('\n');
  } catch(e) {
    return `**${dimName} Detail Error (${value}):** ${e.message}`;
  }
}

async function queryCostCentreAnalysis(dimField, fromDate, toDate, topN = 500, docType = "invoice") {
  const slField  = CC_SL_FIELD[dimField]  || "CostingCode";
  const dimName  = CC_DIM_NAME[dimField]  || "Dimension";
  const endpoint = docType === "order"    ? "/Orders"          : docType === "purchase" ? "/PurchaseInvoices" : "/Invoices";
  const docLabel = docType === "order"    ? "Sales Orders"     : docType === "purchase" ? "Purchase Invoices" : "AR Invoices";
  const smlType  = docType === "purchase" ? "purchase"         : "sales";

  // Helper — aggregate SMLSVC rows by dimField
  function aggregateSml(rows) {
    const map = new Map();
    for (const r of rows) {
      const k = r[dimField] || "(none)";
      const e = map.get(k) ?? { dim:k, total:0, gp:0, qty:0 };
      e.total += Number(r.NetSalesAmountLC || r.PurchaseAmountLC || 0);
      e.gp    += Number(r.GrossProfitLC    || 0);
      e.qty   += Number(r.QuantityInInventoryUoM || 0);
      map.set(k, e);
    }
    return [...map.values()].sort((a,b) => b.total - a.total).slice(0, topN);
  }

  // Helper — format aggregated result as markdown table
  function formatAgg(agg, source) {
    const grand   = agg.reduce((s,r) => s+r.total, 0);
    const grandGP = agg.reduce((s,r) => s+r.gp,    0);
    if (!grand) return null;
    const period = `${fromDate} → ${toDate}`;
    const gpPct  = grand > 0 ? ((grandGP/grand)*100).toFixed(1) : "N/A";
    return `### 📊 ${docLabel} by ${dimName} — ${period}\n\n`
      + `**Source:** ${source} | **Total:** ${fmt(grand)} | **GP:** ${fmt(grandGP)} | **Margin:** ${gpPct}% | **${dimName}s:** ${agg.length}\n\n`
      + tbl([dimName, "Net Sales (LC)", "Gross Profit", "GP%", "% of Total"],
          agg.map(r => {
            const gpP = r.total > 0 ? ((r.gp/r.total)*100).toFixed(1)+"%" : "—";
            const tot = grand > 0   ? ((r.total/grand)*100).toFixed(1)+"%" : "—";
            return [r.dim || "(none)", fmt(r.total), fmt(r.gp), gpP, tot];
          }))
      + (agg[0] ? `\n\n📊 **Top ${dimName.toLowerCase()}** "${agg[0].dim}" accounts for **${((agg[0].total/grand)*100).toFixed(1)}%** of total.` : "")
      + `\n\n💡 You can also ask:\n• \`sales by sub brand this year\`\n• \`brand wise sales 2024\`\n• \`universe wise sales Q1 2025\`\n• \`purchase analysis by brand\``;
  }

  // ── SQL-First: AI-generated or pattern SQL when DB connected ────────────
  if (!isConnected()) {
    const savedDb = dbConnRepo.getActive();
    if (savedDb) {
      try { await connectDB(savedDb); console.log('[CC-SQL] auto-reconnected DB'); }
      catch(e) { console.warn('[CC-SQL] auto-reconnect failed:', e.message); }
    }
  }
  if (isConnected() && USE_AI) {
    try {
      const synQ  = `${docLabel} analysis grouped by ${dimName} from ${fromDate} to ${toDate} top ${topN}`;
      const aiSQL = await aiGenerateSQL(synQ);
      console.log(`[CC-AI] generated SQL: ${aiSQL.slice(0, 200)}`);
      const aiRows = await executeSQL(aiSQL);
      console.log(`[CC-AI] rows=${aiRows.length}`);
      if (aiRows.length) {
        const cols     = Object.keys(aiRows[0]);
        const header   = `| ${cols.join(' | ')} |`;
        const divider  = `| ${cols.map(() => '---').join(' | ')} |`;
        const rowLines = aiRows.slice(0, 200).map(r =>
          `| ${cols.map(c => String(r[c] ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 80)).join(' | ')} |`
        );
        const src = getActiveType().toUpperCase();
        return `## 📊 ${docLabel} by ${dimName}\n\n🗄️ **${src} · AI Query** · ${aiRows.length} row${aiRows.length !== 1 ? 's' : ''}\n\n` +
          [header, divider, ...rowLines].join('\n') +
          `\n\n<details><summary>📋 SQL</summary>\n\n\`\`\`sql\n${aiSQL}\n\`\`\`\n</details>`;
      }
    } catch(eAI) {
      console.log(`[CC-AI] AI SQL failed: ${eAI.message} — falling through to pattern SQL`);
    }
  }
  if (isConnected()) {
    try {
      const CC_HANA_TO_SQL = { CogsOcrCod:'OcrCode', CogsOcrCo2:'OcrCode2', CogsOcrCo3:'OcrCode3', CogsOcrCo4:'OcrCode4', CogsOcrCo5:'OcrCode5' };
      const cfg      = getActiveConfig();
      const isHana   = getActiveType() === 'hana';
      const isPurch  = docType === 'purchase';
      const hdr      = tableRef(isPurch ? 'OPCH' : 'OINV', cfg);
      const lin      = tableRef(isPurch ? 'PCH1' : 'INV1', cfg);
      const sqlCol   = CC_HANA_TO_SQL[dimField] || 'OcrCode';
      const col      = isHana ? `"${sqlCol}"` : sqlCol;
      const nullFn   = isHana ? `IFNULL(T1.${col},'(none)')` : `ISNULL(T1.${sqlCol},'(none)')`;
      const dateFlt  = isHana
        ? `T0."DocDate" BETWEEN '${fromDate}' AND '${toDate}'`
        : `T0.DocDate BETWEEN '${fromDate}' AND '${toDate}'`;
      const LT   = isHana ? `T1."LineTotal"` : `T1.LineTotal`;
      const GP2  = isHana ? `T1."GrssProfit"` : `T1.GrssProfit`;
      const QTY2 = isHana ? `T1."Quantity"` : `T1.Quantity`;
      const JOIN2= isHana ? `T0."DocEntry"=T1."DocEntry"` : `T0.DocEntry=T1.DocEntry`;
      const dimCol2 = isHana ? col : sqlCol;
      const sqlFirst = `SELECT ${nullFn} AS DIM, SUM(${LT}) AS TOTAL, SUM(${GP2}) AS GP, SUM(${QTY2}) AS QTY FROM ${hdr} T0 INNER JOIN ${lin} T1 ON ${JOIN2} WHERE ${dateFlt} AND T1.${dimCol2} IS NOT NULL AND T1.${dimCol2}!='' GROUP BY T1.${dimCol2} ORDER BY TOTAL DESC`;
      console.log(`[CC-SQL] ${sqlFirst.slice(0,120)}...`);
      const sqlRows = await executeSQL(sqlFirst);
      console.log(`[CC-SQL] rows=${sqlRows.length}, sample:`, JSON.stringify(sqlRows[0]));
      if (sqlRows.length) {
        const agg = sqlRows.slice(0, topN).map(r => ({ dim: r.DIM || r.dim || '(none)', total: Number(r.TOTAL||r.total||0), gp: Number(r.GP||r.gp||0), qty: Number(r.QTY||r.qty||0) }));
        const out = formatAgg(agg, `SQL (${isPurch ? 'OPCH+PCH1' : 'OINV+INV1'})`);
        if (out) return out;
      }
    } catch(eSql) { console.log(`[CC-SQL] failed: ${eSql.message} — falling through to SMLSVC`); }
  }

  // ── Tier 1: SMLSVC POST (SalesAnalysisQuery / PurchaseAnalysis) ───────────
  try {
    const rows = await callSMLSVCPost(smlType, buildParamList({ fromDate, toDate }));
    console.log(`[CC-T1] SMLSVC POST rows=${rows.length}, sample CogsOcrCod=${rows[0]?.[dimField]}`);
    if (rows.length) {
      const agg = aggregateSml(rows);
      console.log(`[CC-T1] agg groups=${agg.length}, first=${JSON.stringify(agg[0])}`);
      const out = formatAgg(agg, "HANA SalesAnalysisQuery (POST)");
      if (out) return out;
      console.log("[CC-T1] formatAgg returned null (all totals zero) — falling through");
    }
  } catch(e) { console.log(`[CC-T1] SMLSVC POST failed: ${e.message}`); }

  // ── Tier 2: SMLSVC GET OData on SalesAnalysisQuery ───────────────────────
  if (docType !== "purchase") {
    const ccT2Filter = `PostingDate ge '${fromDate}' and PostingDate le '${toDate}'`;
    // Try with $select (includes dimField); if that fails retry without $select (field may not exist in this view)
    for (const qp of [
      { $select: `${dimField},NetSalesAmountLC,GrossProfitLC,QuantityInInventoryUoM`, $filter: ccT2Filter },
      { $filter: ccT2Filter },
    ]) {
      try {
        _logQ({ method: 'SMLSVC GET', endpoint: '/sml.svc/SalesAnalysisQuery', filter: ccT2Filter, select: qp.$select || 'all', tier: 'Tier 2 fallback' });
        const resp = await getActiveSap().get("/sml.svc/SalesAnalysisQuery", qp);
        const rows = Array.isArray(resp.value) ? resp.value : [];
        console.log(`[CC-T2] SMLSVC GET rows=${rows.length}, sample ${dimField}=${rows[0]?.[dimField]}`);
        _reqQueryLog[_reqQueryLog.length - 1].rows = rows.length;
        if (rows.length) {
          const agg = aggregateSml(rows);
          const out = formatAgg(agg, "HANA SalesAnalysisQuery (GET)");
          if (out) return out;
          console.log("[CC-T2] formatAgg returned null — falling through");
          break;
        }
      } catch(e) { console.log(`[CC-T2] SMLSVC GET attempt failed: ${e.message}`); }
    }
  }

  // ── Tier 3: Service Layer DocumentLines (always works, no GP) ────────────
  const ccT3Filter = `DocDate ge '${fromDate}' and DocDate le '${toDate}'`;
  _logQ({ method: 'SL GET', endpoint, filter: ccT3Filter, expand: `DocumentLines($select=${slField},LineTotal,Quantity)`, tier: 'Tier 3 fallback' });
  let allDocs = [];
  try {
    const r1 = await getActiveSap().get(endpoint, {
      $select: "DocEntry,DocDate,CardCode,CardName",
      $expand: "DocumentLines",
      $filter: ccT3Filter,
      $top: 500,
    });
    allDocs = Array.isArray(r1.value) ? r1.value : [];
    _reqQueryLog[_reqQueryLog.length - 1].rows = allDocs.length;
    console.log(`[CC-T3] SL expand(select) docs=${allDocs.length}`);
  } catch(e1) {
    console.log(`[CC-T3] SL expand(select) failed: ${e1.message} — retrying without inner $select`);
    try {
      const r2 = await getActiveSap().get(endpoint, {
        $select: "DocEntry,DocDate,CardCode,CardName",
        $expand: "DocumentLines",
        $filter: `DocDate ge '${fromDate}' and DocDate le '${toDate}'`,
      });
      allDocs = Array.isArray(r2.value) ? r2.value : [];
      console.log(`[CC-T3] SL expand(full) docs=${allDocs.length}`);
    } catch(e2) {
      console.log(`[CC-T3] SL full expand also failed: ${e2.message}`);
    }
  }

  if (allDocs.length === 0) {
    console.log(`[CC-T3] No documents returned from SL for ${fromDate}→${toDate}`);
  } else {
    // Log first doc's first line to see what fields are available
    const sampleLine = allDocs[0]?.DocumentLines?.[0];
    console.log(`[CC-T3] Sample line keys: ${Object.keys(sampleLine||{}).slice(0,15).join(", ")}`);
    console.log(`[CC-T3] Sample ${slField}=${sampleLine?.[slField]}`);
  }

  const map = new Map();
  for (const doc of allDocs) {
    for (const line of (doc.DocumentLines || [])) {
      const k = line[slField] || "(none)";
      const e = map.get(k) ?? { dim:k, total:0, gp:0, qty:0 };
      e.total += Number(line.LineTotal || 0);
      e.qty   += Number(line.Quantity  || 0);
      map.set(k, e);
    }
  }
  const rows  = [...map.values()].sort((a,b) => b.total - a.total).slice(0, topN);
  console.log(`[CC-T3] aggregated groups=${rows.length}, first=${JSON.stringify(rows[0])}`);
  const out   = formatAgg(rows, `Service Layer ${endpoint}`);
  if (out) return out;

  return `No ${docLabel} with ${dimName} data found for ${fromDate} → ${toDate}.\n\n> Tip: make sure cost-centre dimension (${slField}) is assigned on document lines in SAP B1.`;
}

// ── Purchase Analysis ────────────────────────────────────────────────────────
async function queryPurchaseAnalysis(msg) {
  // ── AI-generated SQL (preferred when DB connected) ──────────────────────
  if (!isConnected()) {
    const savedDb = dbConnRepo.getActive();
    if (savedDb) { try { await connectDB(savedDb); } catch {} }
  }
  if (isConnected() && USE_AI) {
    try {
      const aiSQL  = await aiGenerateSQL(msg);
      console.log(`[PA-AI] generated SQL: ${aiSQL.slice(0, 200)}`);
      const aiRows = await executeSQL(aiSQL);
      console.log(`[PA-AI] rows=${aiRows.length}`);
      if (aiRows.length) {
        const cols     = Object.keys(aiRows[0]);
        const header   = `| ${cols.join(' | ')} |`;
        const divider  = `| ${cols.map(() => '---').join(' | ')} |`;
        const rowLines = aiRows.slice(0, 200).map(r =>
          `| ${cols.map(c => String(r[c] ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 80)).join(' | ')} |`
        );
        const src = getActiveType().toUpperCase();
        return `## 📦 Purchase Analysis\n\n🗄️ **${src} · AI Query** · ${aiRows.length} row${aiRows.length !== 1 ? 's' : ''}\n\n` +
          [header, divider, ...rowLines].join('\n') +
          `\n\n<details><summary>📋 SQL</summary>\n\n\`\`\`sql\n${aiSQL}\n\`\`\`\n</details>`;
      }
    } catch(eAI) {
      console.log(`[PA-AI] AI SQL failed: ${eAI.message} — falling through to pattern logic`);
    }
  }

  const m = msg.toLowerCase();
  const { y } = yearFilter(m);
  const { fromDate, toDate } = fromToForYear(y);
  const topN = parseInt(msg.match(/top\s*(\d+)/i)?.[1] || "20");

  // ── Detect dimension ────────────────────────────────────────────────────
  const byVendor  = !(/item|product|month|brand|sub.?brand|universe|budget|cogs.?customer/.test(m)); // eslint-disable-line no-unused-vars
  const byItem    = /item|product|sku/.test(m);
  const byMonth   = /monthly|by month|per month/.test(m);
  const byBrand   = /\bbrand\b/.test(m) && !/sub.?brand/.test(m);
  const bySubBrand= /sub.?brand/.test(m);
  const byBudget  = /\bbudget\b/.test(m);
  const byUniverse= /\buniverse\b/.test(m);
  const byCogsCust= /cogs.?customer/.test(m);

  // ── Cost-centre dimensions: use SL /PurchaseInvoices + DocumentLines ───────
  if (byBrand || bySubBrand || byBudget || byUniverse || byCogsCust) {
    const dimField = bySubBrand ? "CogsOcrCo2" : byBudget ? "CogsOcrCo3" : byUniverse ? "CogsOcrCo4" : byCogsCust ? "CogsOcrCo5" : "CogsOcrCod";
    try {
      return await queryCostCentreAnalysis(dimField, fromDate, toDate, topN, "purchase");
    } catch(e) {
      return `**Purchase Cost-Centre Error:** ${e.message}`;
    }
  }

  // ── SMLSVC by vendor/item/month (non cost-centre) ───────────────────────
  if (!byItem) {
    try {
      const rows = await callSMLSVCPost("purchase", buildParamList({ fromDate, toDate }));
      if (rows.length) {
        const dimField = byMonth ? "PostingYearAndMonth" : "BusinessPartnerCode";
        const dimLabel2 = byMonth ? "Month" : "Vendor Code";
        const nameField = byMonth ? null : "BusinessPartnerName";
        const map = new Map();
        for (const r of rows) {
          const k = r[dimField] || "?";
          const e = map.get(k) ?? { dim:k, name: nameField ? (r[nameField]||"—") : k, total:0, count:0 };
          e.total += Number(r.NetSalesAmountLC || r.PurchaseAmountLC || 0);
          e.count++;
          map.set(k, e);
        }
        const agg = [...map.values()].sort((a,b) => byMonth ? String(a.dim).localeCompare(String(b.dim)) : b.total-a.total).slice(0, topN);
        const grand = agg.reduce((s,r)=>s+r.total,0);
        if (agg.length && grand > 0) {
          const headers = byMonth ? ["Month","Total Spend"] : [dimLabel2,"Vendor Name","Total Spend","Invoices","Avg Invoice"];
          const tableRows = byMonth
            ? agg.map(r => [r.dim, fmt(r.total)])
            : agg.map(r => [`**${r.dim}**`, r.name, fmt(r.total), String(r.count), fmt(r.total/r.count)]);
          const dimTitle = byMonth ? " by Month" : " by Vendor";
          return `### 🛒 Purchase Analysis${dimTitle} — ${y}\n\n`
            + `**Period:** ${fromDate} → ${toDate} | **Total Spend:** ${fmt(grand)}\n\n`
            + tbl(headers, tableRows)
            + (agg.length && !byMonth ? `\n\n📊 **Top vendor** accounts for **${((agg[0].total/grand)*100).toFixed(1)}%** of total spend.` : "")
            + `\n\n💡 You can also ask:\n• \`purchase analysis by brand\`\n• \`purchase analysis by sub brand\`\n• \`AP aging report\``;
        }
      }
    } catch { /* fall through to SL */ }
  }

  // ── Fallback: Service Layer /PurchaseInvoices (no $top — SL returns all) ──
  const invoices = await getActiveSap().get("/PurchaseInvoices", {
    $select: "CardCode,CardName,DocDate,DocTotal",
    $filter: `DocDate ge '${fromDate}' and DocDate le '${toDate}'`,
  });
  const rows = Array.isArray(invoices.value) ? invoices.value : [];

  const map = new Map();
  for (const inv of rows) {
    const k = inv.CardCode || "?";
    const e = map.get(k) ?? { cardCode:k, cardName:inv.CardName||"—", total:0, count:0 };
    e.total += Number(inv.DocTotal||0);
    e.count++;
    map.set(k, e);
  }
  const vendors = [...map.values()].sort((a,b)=>b.total-a.total).slice(0, topN);
  const grandTotal = vendors.reduce((s,v)=>s+v.total,0);

  if (!vendors.length) return `No purchase invoices found for ${y}.`;

  return `### 🛒 Purchase Analysis by Vendor — ${y}\n\n`
    + `**Period:** ${fromDate} → ${toDate} | **Total Spend:** ${fmt(grandTotal)} | **Vendors:** ${vendors.length}\n\n`
    + tbl(["Vendor Code","Vendor Name","Total Spend","Invoices","Avg Invoice"],
        vendors.map(v=>[`**${v.cardCode}**`, v.cardName, fmt(v.total), String(v.count), fmt(v.total/v.count)]))
    + `\n\n📊 **Top vendor** accounts for **${((vendors[0].total/grandTotal)*100).toFixed(1)}%** of total spend.`
    + `\n\n💡 You can also ask:\n• \`purchase analysis by brand\`\n• \`purchase analysis by sub brand\`\n• \`top vendors last year\`\n• \`AP aging report\``;
}

// ── AR Aging ─────────────────────────────────────────────────────────────────
async function queryARaging() {
  const asOf = new Date();
  const asOfStr = asOf.toISOString().slice(0,10);

  const data = await getActiveSap().get("/Invoices", {
    $select: "CardCode,CardName,DocNum,DocDueDate,DocTotal,PaidToDate",
    $filter: "DocumentStatus eq 'bost_Open'",
  });
  const rows = (Array.isArray(data.value) ? data.value : []).map(inv => {
    const outstanding = Number(inv.DocTotal||0) - Number(inv.PaidToDate||0);
    if (outstanding <= 0) return null;
    const days = Math.floor((asOf - new Date(inv.DocDueDate)) / 86400000);
    return { ...inv, outstanding, days };
  }).filter(Boolean);

  const b = { current:0, d30:0, d60:0, d90:0, over90:0 };
  for (const r of rows) {
    if (r.days<=0) b.current+=r.outstanding;
    else if (r.days<=30) b.d30+=r.outstanding;
    else if (r.days<=60) b.d60+=r.outstanding;
    else if (r.days<=90) b.d90+=r.outstanding;
    else b.over90+=r.outstanding;
  }
  const total = Object.values(b).reduce((s,v)=>s+v,0);
  if (!total) return `✅ No open AR invoices as of ${asOfStr}.`;

  return `### 📊 AR Aging Report — As of ${asOfStr}\n\n`
    + `| Bucket | Amount | % |\n|---|---|---|\n`
    + `| ✅ Current (not overdue) | ${fmt(b.current)} | ${((b.current/total)*100).toFixed(1)}% |\n`
    + `| ⚠️ 1–30 days | ${fmt(b.d30)} | ${((b.d30/total)*100).toFixed(1)}% |\n`
    + `| 🟠 31–60 days | ${fmt(b.d60)} | ${((b.d60/total)*100).toFixed(1)}% |\n`
    + `| 🔴 61–90 days | ${fmt(b.d90)} | ${((b.d90/total)*100).toFixed(1)}% |\n`
    + `| 🔴 Over 90 days | ${fmt(b.over90)} | ${((b.over90/total)*100).toFixed(1)}% |\n`
    + `| **Total Open AR** | **${fmt(total)}** | 100% |\n\n`
    + tbl(["Code","Customer","Doc#","Due Date","Outstanding","Overdue Days"],
        rows.sort((a,b)=>b.days-a.days).slice(0,20).map(r=>[
          `**${r.CardCode}**`, r.CardName||"—", String(r.DocNum),
          r.DocDueDate?.slice(0,10)||"—", fmt(r.outstanding),
          r.days<=0?"Current":`${r.days} days`]))
    + `\n\n💡 You can also ask:\n• \`AP aging report\`\n• \`collections overdue 60 days\`\n• \`show open invoices for [customer]\``;
}

// ── AP Aging ─────────────────────────────────────────────────────────────────
async function queryAPAging() {
  const asOf = new Date();
  const asOfStr = asOf.toISOString().slice(0,10);

  const data = await getActiveSap().get("/PurchaseInvoices", {
    $select: "CardCode,CardName,DocNum,DocDueDate,DocTotal,PaidToDate",
    $filter: "DocumentStatus eq 'bost_Open'",
  });
  const rows = (Array.isArray(data.value) ? data.value : []).map(inv => {
    const outstanding = Number(inv.DocTotal||0) - Number(inv.PaidToDate||0);
    if (outstanding <= 0) return null;
    const days = Math.floor((asOf - new Date(inv.DocDueDate)) / 86400000);
    return { ...inv, outstanding, days };
  }).filter(Boolean);

  const b = { current:0, d30:0, d60:0, d90:0, over90:0 };
  for (const r of rows) {
    if (r.days<=0) b.current+=r.outstanding;
    else if (r.days<=30) b.d30+=r.outstanding;
    else if (r.days<=60) b.d60+=r.outstanding;
    else if (r.days<=90) b.d90+=r.outstanding;
    else b.over90+=r.outstanding;
  }
  const total = Object.values(b).reduce((s,v)=>s+v,0);
  if (!total) return `✅ No open AP invoices as of ${asOfStr}.`;

  return `### 📋 AP Aging Report — As of ${asOfStr}\n\n`
    + `| Bucket | Amount | % |\n|---|---|---|\n`
    + `| ✅ Current | ${fmt(b.current)} | ${((b.current/total)*100).toFixed(1)}% |\n`
    + `| ⚠️ 1–30 days | ${fmt(b.d30)} | ${((b.d30/total)*100).toFixed(1)}% |\n`
    + `| 🟠 31–60 days | ${fmt(b.d60)} | ${((b.d60/total)*100).toFixed(1)}% |\n`
    + `| 🔴 61–90 days | ${fmt(b.d90)} | ${((b.d90/total)*100).toFixed(1)}% |\n`
    + `| 🔴 Over 90 days | ${fmt(b.over90)} | ${((b.over90/total)*100).toFixed(1)}% |\n`
    + `| **Total Open AP** | **${fmt(total)}** | 100% |\n\n`
    + `💡 You can also ask:\n• \`AR aging report\`\n• \`top vendors this year\`\n• \`purchase analysis\``;
}

// ── Open Orders ───────────────────────────────────────────────────────────────
async function queryOpenOrders(msg) {
  const cardMatch = msg.match(/(?:for|customer)\s+([A-Za-z0-9\-]+)/i);
  const cardCode  = cardMatch?.[1];
  const filters   = ["DocumentStatus eq 'bost_Open'"];
  if (cardCode) filters.push(`CardCode eq '${esc(cardCode)}'`);

  const data = await getActiveSap().get("/Orders", {
    $select: "DocEntry,DocNum,CardCode,CardName,DocDate,DocDueDate,DocTotal,DocCurrency",
    $filter: filters.join(" and "),
    $orderby: "DocDate desc",
  });
  const rows = Array.isArray(data.value) ? data.value : [];
  if (!rows.length) return "No open sales orders found.";

  const total = rows.reduce((s,r)=>s+Number(r.DocTotal||0),0);
  return `### 📋 Open Sales Orders${cardCode?" — "+cardCode:""}\n\n`
    + `**${rows.length} orders** | **Total Value:** ${fmt(total)}\n\n`
    + tbl(["Doc#","Entry","Customer","Date","Due Date","Total","Currency"],
        rows.map(r=>[`**${r.DocNum}**`, String(r.DocEntry), `${r.CardCode} — ${r.CardName||""}`,
          r.DocDate?.slice(0,10)||"—", r.DocDueDate?.slice(0,10)||"—",
          fmt(Number(r.DocTotal||0)), r.DocCurrency||"—"]))
    + `\n\n💡 You can also ask:\n• \`open quotations\`\n• \`open orders for [customer code]\`\n• \`create delivery from order [entry]\``;
}

// ── Open Quotations ───────────────────────────────────────────────────────────
async function queryOpenQuotations(msg) {
  const cardMatch = msg.match(/(?:for|customer)\s+([A-Za-z0-9\-]+)/i);
  const cardCode  = cardMatch?.[1];
  const filters   = ["DocumentStatus eq 'bost_Open'"];
  if (cardCode) filters.push(`CardCode eq '${esc(cardCode)}'`);

  const data = await getActiveSap().get("/Quotations", {
    $select: "DocEntry,DocNum,CardCode,CardName,DocDate,DocDueDate,DocTotal,DocCurrency",
    $filter: filters.join(" and "),
    $orderby: "DocDate desc",
  });
  const rows = Array.isArray(data.value) ? data.value : [];
  if (!rows.length) return "No open quotations found.";

  const total = rows.reduce((s,r)=>s+Number(r.DocTotal||0),0);
  return `### 📄 Open Quotations${cardCode?" — "+cardCode:""}\n\n`
    + `**${rows.length} quotations** | **Total Value:** ${fmt(total)}\n\n`
    + tbl(["Doc#","Entry","Customer","Doc Date","Valid Until","Total","Currency"],
        rows.map(r=>[`**${r.DocNum}**`, String(r.DocEntry), `${r.CardCode} — ${r.CardName||""}`,
          r.DocDate?.slice(0,10)||"—", r.DocDueDate?.slice(0,10)||"—",
          fmt(Number(r.DocTotal||0)), r.DocCurrency||"—"]))
    + `\n\n💡 You can also ask:\n• \`convert quotation [entry] to order\`\n• \`open orders\`\n• \`create quotation\``;
}

// ── Vendor List ───────────────────────────────────────────────────────────────
async function queryVendors(msg) {
  const q = msg.match(/(?:search|find|named?|called?)\s+([A-Za-z0-9 ]+)/i)?.[1]?.trim();
  let filter = "CardType eq 'cSupplier' and Frozen eq 'tNO'";
  if (q) filter += ` and (substringof('${esc(q)}',CardCode) or substringof('${esc(q)}',CardName))`;

  const data = await getActiveSap().get("/BusinessPartners", {
    $filter: filter,
    $select: "CardCode,CardName,Phone1,EmailAddress,CurrentAccountBalance,Currency,City,Country",
    $orderby: "CardName asc",
  });
  const rows = Array.isArray(data.value) ? data.value : [];
  if (!rows.length) return "No vendors found.";

  return `### 🏭 Vendor List (${rows.length} found)\n\n`
    + tbl(["Code","Name","City","Country","Phone","Balance","Currency"],
        rows.map(v=>[`**${v.CardCode}**`, v.CardName||"—", v.City||"—", v.Country||"—",
          v.Phone1||"—", fmt(Number(v.CurrentAccountBalance||0)), v.Currency||"—"]))
    + `\n\n💡 You can also ask:\n• \`purchase analysis this year\`\n• \`AP aging report\`\n• \`top vendors by spend\``;
}

// ── KPI Dashboard ─────────────────────────────────────────────────────────────
async function queryKPIs() {
  const now  = new Date();
  const y    = now.getFullYear();
  const from = `${y}-01-01`;
  const to   = now.toISOString().slice(0,10);

  // Try SMLSVC POST first, fall back to GET OData
  const salesPromise = callSMLSVCPost("sales", buildParamList({ fromDate: from, toDate: to }))
    .catch(() => sap.get("/sml.svc/SalesAnalysisQuery", {
      $select: "NetSalesAmountLC,GrossProfitLC",
      $filter: `PostingDate ge '${from}' and PostingDate le '${to}'`,
      $top: 1000,
    }).then(d => d.value || []));

  const [salesData, arData, apData, stockData] = await Promise.allSettled([
    salesPromise,
    sap.get("/Invoices", {
      $select: "DocTotal,PaidToDate",
      $filter: "DocumentStatus eq 'bost_Open'",
      $top: 500,
    }),
    sap.get("/PurchaseInvoices", {
      $select: "DocTotal,PaidToDate",
      $filter: "DocumentStatus eq 'bost_Open'",
      $top: 500,
    }),
    sap.get("/Items", {
      $select: "QuantityOnStock",
      $filter: "ItemType eq 'itItems' and Frozen eq 'tNO' and QuantityOnStock gt 0",
      $top: 500,
    }),
  ]);

  const salesRows  = salesData.status==="fulfilled" ? (Array.isArray(salesData.value) ? salesData.value : (salesData.value?.value||[])) : [];
  const arRows     = arData.status==="fulfilled"    ? (arData.value?.value||[])    : [];
  const apRows     = apData.status==="fulfilled"    ? (apData.value?.value||[])    : [];
  const stockRows  = stockData.status==="fulfilled" ? (stockData.value?.value||[]) : [];

  const totalSales = salesRows.reduce((s,r)=>s+Number(r.NetSalesAmountLC||0),0);
  const totalGP    = salesRows.reduce((s,r)=>s+Number(r.GrossProfitLC||0),0);
  const openAR     = arRows.reduce((s,r)=>s+Number(r.DocTotal||0)-Number(r.PaidToDate||0),0);
  const openAP     = apRows.reduce((s,r)=>s+Number(r.DocTotal||0)-Number(r.PaidToDate||0),0);
  const stockItems = stockRows.length;
  const gpPct      = totalSales>0 ? ((totalGP/totalSales)*100).toFixed(1) : "N/A";

  return `### 📊 Business KPI Dashboard — ${y} YTD (as of ${to})\n\n`
    + `| KPI | Value |\n|---|---|\n`
    + `| 💰 Total Sales (YTD) | **${fmt(totalSales)}** |\n`
    + `| 📈 Gross Profit (YTD) | **${fmt(totalGP)}** |\n`
    + `| 📉 GP Margin % | **${gpPct}%** |\n`
    + `| 📬 Open AR (Receivables) | **${fmt(openAR)}** |\n`
    + `| 📤 Open AP (Payables) | **${fmt(openAP)}** |\n`
    + `| 📦 Items In Stock | **${stockItems}** |\n\n`
    + `💡 You can also ask:\n• \`monthly sales trend this year\`\n• \`AR aging report\`\n• \`top customers by sales\``;
}

// ── Intent Detection ──────────────────────────────────────────────────────────
// Rule body lives in ./lib/detect-intent.mjs (pure function, no SAP/DB access,
// extracted so it can be read/tested/extended without the surrounding file).
// This wrapper re-reads the two pieces of module state it needs on every call
// so behavior is unchanged: _lastSAContext is mutated elsewhere as replies
// come back, _dimAliasPattern is built once at startup from SA_DIMENSIONS.
function detectIntent(msg) {
  return _detectIntentPure(msg, { lastSAContext: _lastSAContext, dimAliasPattern: _dimAliasPattern });
}

const GUIDES = {
  create_sales_quotation:  "👉 Use the **Create Quotation** form in the toolbar above for a guided experience with customer & item autocomplete.",
  create_sales_order:      "👉 Use the **Create Order** form above, or type: `create order from quotation [DOC_ENTRY]`",
  create_delivery:         "👉 Use the **Create Delivery** form above — it will load order lines with batch & bin selection.",
  create_ar_invoice:       "👉 Use the **Create Invoice** form above, or type: `create invoice from delivery [DOC_ENTRY]`",
  apply_incoming_payment:  "👉 Use the **Apply Payment** form above for a guided experience.",
  create_purchase_order:   "👉 Use the **Create PO** form in the toolbar above for a guided experience with vendor & item autocomplete.",
  create_goods_receipt_po: "👉 Use the **Goods Receipt PO** form above, or type: `receive goods from PO [DOC_ENTRY]`",
  create_ap_invoice:       "👉 Use the **A/P Invoice** form above, or type: `create ap invoice from GRPO [DOC_ENTRY]`",
  apply_outgoing_payment:  "👉 Use the **Pay Vendor** form above for a guided experience.",
};

function helpMessage() {
  return `### SAP B1 Assistant — Standard Mode\n\nJust type naturally — the engine maps your words to live SAP B1 data.\n\n**📊 Dashboards & KPIs**\n\`kpi dashboard\` · \`business overview\` · \`sales summary this year\`\n\n**📈 Sales Analytics (HANA)**\n\`top 10 customers by sales\` · \`monthly sales trend\` · \`quarterly sales\`\n\`sales by salesperson\` · \`sales by item group\` · \`sales by warehouse\`\n\`top items by quantity\` · \`year over year comparison\`\n\n**📋 Sales Documents**\n\`open quotations\` · \`open orders\` · \`open orders for C00001\`\n\`invoices this month\` · \`delivery notes last week\` · \`credit notes this year\`\n\n**🛒 Purchase Documents**\n\`open purchase orders\` · \`purchase invoices this year\` · \`purchase orders for V00001\`\n\`vendor payments last month\` · \`purchase returns\`\n\n**📦 Inventory**\n\`stock levels\` · \`goods receipts today\` · \`goods issues this week\`\n\`stock transfers last month\` · \`ATP check A00001 qty 10\`\n\n**🏭 Production**\n\`open production orders\` · \`production orders due this week\`\n\n**💰 Finance**\n\`AR aging report\` · \`AP aging report\` · \`journal entries January 2026\`\n\`collections overdue 30 days\` · \`incoming payments this month\`\n\n**🔧 Service & CRM**\n\`open service calls\` · \`service calls this month\`\n\`activities this week\` · \`open sales opportunities\`\n\n**👥 Master Data**\n\`show employees\` · \`price lists\` · \`warehouses\` · \`show customers\`\n\n**🔄 Date filters work everywhere:**\n_today · this week · last week · this month · last month · this year · last year · last 30 days · January 2026_\n\n**🖨️ Print** — \`print quotation 88\` · \`print order 123\`\n\n**📝 Create** — use the toolbar buttons above for guided forms with autocomplete.`;
}

// ---------------------------------------------------------------------------
// Sales Analysis — natural language → OData query → formatted table
// Endpoint: {baseUrl}/sml.svc/SalesAnalysisQuery
// ---------------------------------------------------------------------------
const MONTH_MAP = {
  january:1,february:2,march:3,april:4,may:5,june:6,
  july:7,august:8,september:9,october:10,november:11,december:12,
  jan:1,feb:2,mar:3,apr:4,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12,
};

function parseSalesAnalysisQuery(msg) {
  const m = msg.toLowerCase();
  const now = new Date();

  // ── Dimension detection via SA_DIMENSIONS registry ──────────────────────
  // Supports ANY field available in SalesAnalysisQuery view.
  // Users can say "by customer", "item wise", "brand wise", "dim1", etc.
  const { groupBy, dimCols, dimLabels } = detectDimensions(msg);

  // Quarter shorthand Q1/Q2/Q3/Q4 — add period grouping if not already detected
  if (/\bq[1-4]\b/i.test(m) && !groupBy.includes("PostingYearAndQuarter")) {
    groupBy.push("PostingYearAndQuarter");
    dimCols.push("PostingYearAndQuarter");
    dimLabels.push("Quarter");
  }

  // Default → top customers (when nothing matched)
  if (groupBy.length === 0) {
    groupBy.push("BusinessPartnerCode");
    dimCols.push("BusinessPartnerCode","BusinessPartnerName");
    dimLabels.push("Code","Customer");
  }

  // Convenience booleans (used below for period-only sort, etc.)
  const byMonth    = groupBy.includes("PostingYearAndMonth");
  const byQuarter  = groupBy.includes("PostingYearAndQuarter");
  const byYear     = groupBy.includes("PostingYear");
  const byCustomer = groupBy.includes("BusinessPartnerCode");

  // ── Measures ────────────────────────────────────────────────────────────
  const measCols   = ["NetSalesAmountLC","GrossProfitLC","GrossProfitMarginBySalesAmount"];
  const wantsQty   = /quantity|qty|unit|volume/.test(m);
  if (wantsQty) measCols.push("QuantityInInventoryUoM");

  const sortByMargin = /margin|gp%/.test(m);
  const sortByGP     = /\bprofit\b/.test(m) && !sortByMargin;
  const sortByQty    = wantsQty && !/amount|revenue|sales value/.test(m);
  const byItem     = groupBy.includes("ItemCode");
  const byEmployee = groupBy.includes("SalesEmployeeOrBuyerNumber");
  const periodOnly = (byMonth || byQuarter || byYear) && !byCustomer && !byItem && !byEmployee;

  let $orderby = periodOnly    ? (byMonth ? "PostingYearAndMonth asc" : byQuarter ? "PostingYearAndQuarter asc" : "PostingYear asc")
               : sortByMargin  ? "GrossProfitMarginBySalesAmount desc"
               : sortByGP      ? "GrossProfitLC desc"
               : sortByQty     ? "QuantityInInventoryUoM desc"
               :                 "NetSalesAmountLC desc";
  // "top N" always means descending by sales
  if (/top\s*\d+/.test(m)) $orderby = "NetSalesAmountLC desc";

  // ── Date filters ─────────────────────────────────────────────────────────
  const filters = [];

  const yearMatch = msg.match(/\b(20\d\d)\b/);
  if      (/this year/.test(m))  filters.push(`PostingYear eq ${now.getFullYear()}`);
  else if (/last year/.test(m))  filters.push(`PostingYear eq ${now.getFullYear()-1}`);
  else if (yearMatch)            filters.push(`PostingYear eq ${yearMatch[1]}`);

  const thisMonth = /this month/.test(m);
  const lastMonth = /last month/.test(m);
  if (thisMonth) {
    if (!filters.some(f=>f.includes("PostingYear"))) filters.push(`PostingYear eq ${now.getFullYear()}`);
    filters.push(`PostingMonth eq ${now.getMonth()+1}`);
  } else if (lastMonth) {
    const d = new Date(now.getFullYear(), now.getMonth()-1, 1);
    if (!filters.some(f=>f.includes("PostingYear"))) filters.push(`PostingYear eq ${d.getFullYear()}`);
    filters.push(`PostingMonth eq ${d.getMonth()+1}`);
  } else {
    for (const [name, num] of Object.entries(MONTH_MAP)) {
      if (m.includes(name)) { filters.push(`PostingMonth eq ${num}`); break; }
    }
  }

  // Quarter filter e.g. "Q1" "Q2 2024"
  const qMatch = msg.match(/\bQ([1-4])\b/i);
  if (qMatch) filters.push(`PostingQuarter eq ${qMatch[1]}`);

  // Specific value filters (when NOT grouping by that dimension)
  if (!byCustomer) {
    const cm = msg.match(/(?:for customer|customer code|for bp|customer[:\s]+)\s*["']?([A-Za-z0-9\-_]+)["']?/i);
    if (cm && cm[1].length > 1) filters.push(`BusinessPartnerCode eq '${esc(cm[1])}'`);
  }
  if (!byItem) {
    const im = msg.match(/(?:for item|item code|item[:\s]+)\s*["']?([A-Za-z0-9\-_]+)["']?/i);
    if (im && im[1].length > 1) filters.push(`ItemCode eq '${esc(im[1])}'`);
  }
  // Salesperson filter
  if (!byEmployee) {
    const sm = msg.match(/(?:for salesperson|salesperson[:\s]+|slp[:\s]+|for slp)\s*["']?([A-Za-z0-9\-_]+)["']?/i);
    if (sm && sm[1].length > 0) filters.push(`SalesEmployeeOrBuyerNumber eq ${parseInt(sm[1]) || 0}`);
  }
  // Warehouse filter
  if (!groupBy.includes("WarehouseCode")) {
    const wm = msg.match(/(?:for warehouse|warehouse[:\s]+|whs[:\s]+)\s*["']?([A-Za-z0-9\-_]+)["']?/i);
    if (wm && wm[1].length > 0) filters.push(`WarehouseCode eq '${esc(wm[1])}'`);
  }

  // ── Transaction type detection (ObjType) ─────────────────────────────────
  // SAP B1 ObjType values: 13=AR Invoice, 14=AR Credit Memo, 15=Down Payment,
  //   16=AR Return, 17=Sales Order, 23=Delivery, 24=Return
  let objTypeFilter = null;
  let objTypeLabel  = "All Transactions";
  if      (/credit.?memo|credit.?note/.test(m))                                  { objTypeFilter = '14'; objTypeLabel = "AR Credit Memos"; }
  else if (/down.?payment/.test(m))                                               { objTypeFilter = '15'; objTypeLabel = "Down Payment Invoices"; }
  else if (/\breturn\b/.test(m) && !/no.?return|return.?to/.test(m))             { objTypeFilter = '16'; objTypeLabel = "AR Returns"; }
  else if (/\bsales.?order\b/.test(m) || (/\border\b/.test(m) && !/in.?order|border/.test(m) && !(/invoice|delivery/.test(m)))) { objTypeFilter = '17'; objTypeLabel = "Sales Orders"; }
  else if (/\bdelivery\b|\bdeliveries\b/.test(m))                                 { objTypeFilter = '23'; objTypeLabel = "Deliveries"; }
  else if (/\binvoice\b/.test(m))                                                  { objTypeFilter = '13'; objTypeLabel = "AR Invoices"; }

  // Top N (default 50, max 500)
  const topMatch = msg.match(/top\s*(\d+)/i);
  const $top = topMatch ? Math.min(parseInt(topMatch[1]), 500) : 50;

  // ── Label ──────────────────────────────────────────────────────────────
  const DIM_LABEL_MAP = { CogsOcrCod: CC_DIM_NAME.CogsOcrCod, CogsOcrCo2: CC_DIM_NAME.CogsOcrCo2, CogsOcrCo3: CC_DIM_NAME.CogsOcrCo3, CogsOcrCo4: CC_DIM_NAME.CogsOcrCo4, CogsOcrCo5: CC_DIM_NAME.CogsOcrCo5 };
  const dimDesc = groupBy.map(g => DIM_LABEL_MAP[g] || g.replace(/([A-Z])/g,' $1').trim().replace(/^./,c=>c.toUpperCase())).join(', ');
  const label   = `${objTypeLabel} — by ${dimDesc}`;

  return { $select:[...new Set([...dimCols,...measCols])].join(','), $filter:filters.join(' and ')||null,
    $orderby, $top, groupBy, dimCols, dimLabels, measCols, wantsQty, label, objTypeFilter, objTypeLabel };
}

function _aggregateSA(rows, params) {
  const map = new Map();
  for (const row of rows) {
    const key = params.groupBy.map(g => String(row[g]??'')).join('||');
    if (!map.has(key)) {
      const e = { _d:{}, NetSalesAmountLC:0, GrossProfitLC:0, QuantityInInventoryUoM:0 };
      params.dimCols.forEach(c => { e._d[c] = row[c] ?? ''; });
      map.set(key, e);
    }
    const e = map.get(key);
    e.NetSalesAmountLC       += Number(row.NetSalesAmountLC       ?? 0);
    e.GrossProfitLC          += Number(row.GrossProfitLC          ?? 0);
    e.QuantityInInventoryUoM += Number(row.QuantityInInventoryUoM ?? 0);
  }
  for (const e of map.values())
    e.GrossProfitMarginBySalesAmount = e.NetSalesAmountLC > 0 ? (e.GrossProfitLC / e.NetSalesAmountLC * 100) : 0;
  return [...map.values()];
}

function formatSalesAnalysis(data, params) {
  const raw = data?.value ?? (Array.isArray(data) ? data : []);
  if (!raw.length) return `_No data returned from Sales Analysis. Check your filters or verify HANA analytics are enabled._`;

  let rows = _aggregateSA(raw, params);

  // Sort
  const [sf, sd] = params.$orderby.split(' ');
  const desc = sd !== 'asc';
  rows.sort((a,b) => desc ? (b[sf]??0)-(a[sf]??0) : (a[sf]??0)-(b[sf]??0));

  // Totals
  const totalSales  = rows.reduce((s,r) => s + r.NetSalesAmountLC, 0);
  const totalGP     = rows.reduce((s,r) => s + r.GrossProfitLC, 0);
  const totalQty    = rows.reduce((s,r) => s + r.QuantityInInventoryUoM, 0);
  const avgMargin   = totalSales > 0 ? (totalGP / totalSales * 100) : 0;

  const headers = [...params.dimLabels, 'Net Sales (LC)', 'Gross Profit', 'GP%', ...(params.wantsQty ? ['Qty'] : [])];
  const tableRows = rows.map(r => [
    ...params.dimCols.map(c => String(r._d[c] ?? '—')),
    fmt(r.NetSalesAmountLC),
    fmt(r.GrossProfitLC),
    r.GrossProfitMarginBySalesAmount.toFixed(1) + '%',
    ...(params.wantsQty ? [fmt(r.QuantityInInventoryUoM, 2)] : []),
  ]);

  const txLine  = params.objTypeLabel && params.objTypeLabel !== "All Transactions"
    ? ` | **Type:** ${params.objTypeLabel}` : "";
  const summary = `**${rows.length} groups** | **Sales: ${fmt(totalSales)}** | **GP: ${fmt(totalGP)}** | **Margin: ${avgMargin.toFixed(1)}%**${params.wantsQty ? ` | **Qty: ${fmt(totalQty,2)}**` : ''}${txLine}`;
  const brandNote = raw.find(r => r._brandNote)?._brandNote ?? "";
  return `### 📊 ${params.label}\n\n${summary}\n\n` + tbl(headers, tableRows) + (brandNote ? `\n\n${brandNote}` : "");
}

function printGuide(msg) {
  const m = msg.toLowerCase();
  const n = msg.match(/\b(\d+)\b/)?.[1];
  if (!n) return "Please specify a document number, e.g. `print quotation 88`";
  const type = /quot/.test(m) ? "quotation" : /order/.test(m) ? "order" : /deliver/.test(m) ? "delivery" : /invoice/.test(m) ? "invoice" : null;
  if (!type) return "Specify doc type: `print quotation 88` | `print order 123` | `print delivery 45` | `print invoice 67`";
  return `[🖨️ Open Print Preview — ${type} #${n}](/api/print/${type}/${n}){:target="_blank"}`;
}

/**
 * Use the configured AI provider to generate a SAP B1 SQL query from natural language.
 * Returns a raw SELECT SQL string ready for executeSQL().
 * Throws if AI is not configured or returns invalid SQL.
 */
async function aiGenerateSQL(question) {
  if (!USE_AI) throw new Error("AI not configured — no API key set");
  const cfg    = getActiveConfig();
  const dbType = getActiveType();
  const isHana = dbType === 'hana';
  const schema = cfg?.schema_name || cfg?.database || '';
  const schemaHint = isHana
    ? `Database: SAP HANA. Schema: "${schema}". Use double-quoted identifiers: "${schema}"."TABLE"."COLUMN". HANA SQL: IFNULL, LIMIT N, YEAR(), MONTH(), LPAD(), || for concat. No TOP keyword.`
    : `Database: SQL Server. Database: [${cfg.database}]. T-SQL: ISNULL, TOP N, YEAR(), MONTH(), FORMAT(). No LIMIT keyword.`;
  const companyExtras = buildSqlContext();
  const today    = new Date().toISOString().slice(0, 10);
  const thisYear = new Date().getFullYear();
  const lastYear = thisYear - 1;

  // Fetch live UDFs from CUFD table (cached 10 min)
  const liveUDFs = await fetchLiveUDFs().catch(() => '');

  const prompt = [{ role: "user", content:
    `You are an expert SAP Business One SQL assistant.\n${schemaHint}\n\n` +
    `SAP B1 Complete Schema:\n${BASE_SCHEMA}\n\n` +
    (companyExtras ? `Company-specific definitions:\n${companyExtras}\n\n` : '') +
    (liveUDFs ? `${liveUDFs}\n\n` : '') +
    `Today: ${today}. This year: ${thisYear}. Last year: ${lastYear}.\n\n` +
    `User question: "${question}"\n\n` +
    `Generate a single read-only SELECT SQL query to answer this question.\n` +
    `Rules:\n` +
    `- Return ONLY the SQL query — no explanation, no markdown, no code fences\n` +
    `- Only SELECT — never INSERT/UPDATE/DELETE/DROP/EXEC/CREATE\n` +
    `- ${isHana ? 'Add LIMIT 200 at the end' : 'Use SELECT TOP 200'}\n` +
    `- Use descriptive column aliases (e.g. AS "Brand", AS "Sales Amount", AS "Month")\n` +
    `- "last year" = ${lastYear} (${lastYear}-01-01 to ${lastYear}-12-31)\n` +
    `- "this year" = ${thisYear} (${thisYear}-01-01 to ${today})\n` +
    `- AR invoices: JOIN OINV T0 with INV1 T1 ON T0.DocEntry=T1.DocEntry\n` +
    `- Brand/cost-centre grouping: INV1.CogsOcrCod (dim1), CogsOcrCo2 (dim2), etc.\n` +
    `- DocStatus: 'O'=Open, 'C'=Closed, 'W'=Cancelled\n` +
    `- For HANA use double-quoted identifiers: "SCHEMA"."TABLE"."COLUMN"`
  }];

  const model = AI_PROVIDER === 'azure'
    ? (process.env.AZURE_CLAUDE_MODEL || 'claude-3-5-sonnet-20241022')
    : 'claude-sonnet-4-6';
  const body = { model, max_tokens: 1024, messages: prompt };

  let aiContent;
  if (AI_PROVIDER === 'azure') {
    const r = await azureMessagesCreate(body);
    aiContent = r.content;
  } else if (AI_PROVIDER === 'gpt') {
    const r = await gptChatComplete({ messages: prompt, max_tokens: 1024 });
    aiContent = [{ type: 'text', text: r.choices?.[0]?.message?.content || '' }];
  } else {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const ant = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const r = await ant.messages.create(body);
    aiContent = r.content;
  }

  let sql = (aiContent?.[0]?.text || '').trim();
  sql = sql.replace(/^```[\w]*\n?/i, '').replace(/\n?```$/i, '').trim();
  if (!sql || !/^SELECT/i.test(sql)) throw new Error(`AI returned invalid SQL: "${sql.slice(0, 80)}"`);
  return sql;
}

async function demoReply(message) {
  const intent = detectIntent(message);
  if (!intent) {
    // ── NLP Engine fallback — covers ALL remaining SAP B1 entities ────────────
    try {
      const nlpResult = await nlpQuery(message, sap);
      if (nlpResult) return nlpResult;
    } catch(e) {
      // NLP engine found an entity but SAP call failed
      return `**Query Error:** ${e.message}`;
    }
    return `I didn't understand that. Type **help** for all available queries, or try:\n• \`open production orders\`\n• \`service calls this month\`\n• \`journal entries January 2026\`\n• \`purchase orders for V00001\`\n• \`show employees\``;
  }
  if (intent.action === "help") return helpMessage();
  if (intent.action === "print") return printGuide(message);

  // ── Product Forecasting Agent ─────────────────────────────────────────────
  if (intent.action === "product_forecast") {
    const { years, horizon } = intent;
    const sap = getActiveSap();
    try {
      const aiDeps = USE_AI ? { AI_PROVIDER, gptChatComplete, azureMessagesCreate } : null;
      const result = await runForecastCore(sap, { years, forecastHorizon: horizon, aiDeps, aiTokens: 900 });
      const { items, summary: s, aiInsights, periodFrom, periodTo } = result;

      if (items.length === 0) {
        return `**No product data found** for the requested period (${periodFrom} → ${periodTo}).\n\nTry running from the **Product Forecasting Agent** dashboard or check the SAP B1 connection.`;
      }

      // Build rich markdown summary
      const pct = (n, d) => d > 0 ? Math.round(n / d * 100) : 0;
      let md = `## 📊 Product Demand Forecast — ${years}-Year History\n\n`;
      md += `**Period:** ${periodFrom} → ${periodTo} &nbsp;·&nbsp; **Source:** ${s.dataSource} &nbsp;·&nbsp; ${(s.rowCount || 0).toLocaleString()} rows analysed\n\n`;

      // KPI summary table
      md += `### 📈 Portfolio Health\n\n`;
      md += `| Metric | Value |\n|---|---|\n`;
      md += `| 📦 Total Products | **${s.totalItems}** |\n`;
      md += `| 📈 Growing | **${s.growing}** — ${pct(s.growing, s.totalItems)}% of portfolio |\n`;
      md += `| ➡️ Stable | **${s.stable}** — ${pct(s.stable, s.totalItems)}% |\n`;
      md += `| 📉 Declining | **${s.declining}** — ${pct(s.declining, s.totalItems)}% |\n`;
      md += `| 🔴 High Stockout Risk | **${s.highStockout}** items need urgent reorder |\n`;
      md += `| 🔮 12-Month Forecast | **${(s.totalFc12m || 0).toLocaleString()} units** |\n\n`;

      // Critical stockout risks
      const highRisk = items.filter(r => r.stockoutRisk === 'HIGH').slice(0, 5);
      if (highRisk.length > 0) {
        md += `### 🔴 Critical Stockout Risks\n\n`;
        md += `| Item Code | Name | Stock | Wks Cover | 3M Forecast |\n|---|---|---|---|---|\n`;
        for (const it of highRisk) {
          const woc = it.weeksOfCover === 0 ? '**OUT**' : `${it.weeksOfCover} wks`;
          md += `| \`${it.itemCode}\` | ${(it.itemName || '').slice(0, 28)} | ${it.stockOnHand.toLocaleString()} | ${woc} | ${it.forecastQty3m.toLocaleString()} |\n`;
        }
        md += '\n';
      }

      // Growing items
      const growing = items.filter(r => r.trendLabel === 'Growing').sort((a, b) => b.trendPct - a.trendPct).slice(0, 5);
      if (growing.length > 0) {
        md += `### 📈 Top Growth Opportunities\n\n`;
        md += `| Item Code | Name | Trend/Month | YoY | 12M Forecast |\n|---|---|---|---|---|\n`;
        for (const it of growing) {
          md += `| \`${it.itemCode}\` | ${(it.itemName || '').slice(0, 28)} | **+${it.trendPct}%** | ${it.yoyGrowth > 0 ? '+' : ''}${it.yoyGrowth}% | ${it.forecastQty12m.toLocaleString()} |\n`;
        }
        md += '\n';
      }

      // Declining items
      const declining = items.filter(r => r.trendLabel === 'Declining').sort((a, b) => a.trendPct - b.trendPct).slice(0, 3);
      if (declining.length > 0) {
        md += `### 📉 Declining Products\n\n`;
        md += `| Item Code | Name | Trend/Month | 12M Forecast |\n|---|---|---|---|\n`;
        for (const it of declining) {
          md += `| \`${it.itemCode}\` | ${(it.itemName || '').slice(0, 28)} | ${it.trendPct}% | ${it.forecastQty12m.toLocaleString()} |\n`;
        }
        md += '\n';
      }

      // AI insights section
      if (aiInsights) {
        md += `---\n\n${aiInsights}\n\n`;
      }

      md += `---\n*Click **Open Forecast Dashboard** below to explore all ${items.length} products with charts, item-level detail, and follow-up AI chat.*`;

      // Strip large per-item arrays for the inline chat payload (saves bandwidth)
      const itemsForChat = items.map(({ monthlyHistory, forecastMonthly, ...rest }) => rest);

      return {
        text: md,
        openForecastDashboard: true,
        forecastData: { items: itemsForChat, summary: s, aiInsights, periodFrom, periodTo },
      };
    } catch (e) {
      console.error('[ForecastChat]', e.message);
      return `❌ Forecast analysis failed: **${e.message}**\n\nPlease check SAP B1 connection and try again.`;
    }
  }

  // ── Purchase Forecasting (procurement side) ──────────────────────────────────
  if (intent.action === "purchase_forecast") {
    const { years, horizon } = intent;
    const sap = getActiveSap();
    try {
      const aiDeps = USE_AI ? { AI_PROVIDER, gptChatComplete, azureMessagesCreate } : null;
      const result = await runPurchaseForecastCore(sap, { years, forecastHorizon: horizon, aiDeps, aiTokens: 900 });
      const { items, summary: s, aiInsights, periodFrom, periodTo } = result;

      if (items.length === 0) {
        return `**No purchase history found** for the requested period (${periodFrom} → ${periodTo}).\n\nTry running from the **Forecast Dashboard** or check the SAP B1 connection.`;
      }

      const pct = (n, d) => d > 0 ? Math.round(n / d * 100) : 0;
      let md = `## 🛒 Purchase Forecast — ${years}-Year History\n\n`;
      md += `**Period:** ${periodFrom} → ${periodTo} &nbsp;·&nbsp; **Source:** ${s.dataSource} &nbsp;·&nbsp; ${(s.rowCount || 0).toLocaleString()} rows analysed\n\n`;

      md += `### 📈 Procurement Health\n\n`;
      md += `| Metric | Value |\n|---|---|\n`;
      md += `| 📦 Total Purchased Items | **${s.totalItems}** |\n`;
      md += `| 📈 Rising Demand | **${s.growing}** — ${pct(s.growing, s.totalItems)}% of portfolio |\n`;
      md += `| ➡️ Stable | **${s.stable}** — ${pct(s.stable, s.totalItems)}% |\n`;
      md += `| 📉 Declining | **${s.declining}** — ${pct(s.declining, s.totalItems)}% |\n`;
      md += `| 🔴 Urgent Reorders | **${s.highReorder}** items below min stock |\n`;
      md += `| 🔮 12-Month Purchase Forecast | **${(s.totalFc12m || 0).toLocaleString()} units** |\n`;
      md += `| 🧾 Suggested Order Qty (now) | **${(s.totalSuggestedQty || 0).toLocaleString()} units** |\n\n`;

      const urgent = items.filter(r => r.reorderRisk === 'HIGH').slice(0, 5);
      if (urgent.length > 0) {
        md += `### 🔴 Urgent Reorders\n\n`;
        md += `| Item Code | Name | Stock | Wks Cover | Suggested Order Qty |\n|---|---|---|---|---|\n`;
        for (const it of urgent) {
          const woc = it.weeksOfCover === 0 ? '**OUT**' : `${it.weeksOfCover} wks`;
          md += `| \`${it.itemCode}\` | ${(it.itemName || '').slice(0, 28)} | ${it.stockOnHand.toLocaleString()} | ${woc} | ${it.suggestedOrderQty.toLocaleString()} |\n`;
        }
        md += '\n';
      }

      const growing = items.filter(r => r.trendLabel === 'Growing').sort((a, b) => b.trendPct - a.trendPct).slice(0, 5);
      if (growing.length > 0) {
        md += `### 📈 Rising Purchase Demand\n\n`;
        md += `| Item Code | Name | Trend/Month | 12M Purchase Forecast |\n|---|---|---|---|\n`;
        for (const it of growing) {
          md += `| \`${it.itemCode}\` | ${(it.itemName || '').slice(0, 28)} | **+${it.trendPct}%** | ${it.forecastQty12m.toLocaleString()} |\n`;
        }
        md += '\n';
      }

      const declining = items.filter(r => r.trendLabel === 'Declining').sort((a, b) => a.trendPct - b.trendPct).slice(0, 3);
      if (declining.length > 0) {
        md += `### 📉 Declining Purchases\n\n`;
        md += `| Item Code | Name | Trend/Month | 12M Purchase Forecast |\n|---|---|---|---|\n`;
        for (const it of declining) {
          md += `| \`${it.itemCode}\` | ${(it.itemName || '').slice(0, 28)} | ${it.trendPct}% | ${it.forecastQty12m.toLocaleString()} |\n`;
        }
        md += '\n';
      }

      if (aiInsights) {
        md += `---\n\n${aiInsights}\n\n`;
      }

      md += `---\n*Purchase forecast covers ${items.length} items sourced from Goods Receipt / Purchase Order history.*`;

      const itemsForChat = items.map(({ monthlyHistory, forecastMonthly, ...rest }) => rest);

      return {
        text: md,
        openForecastDashboard: true,
        forecastData: { items: itemsForChat, summary: s, aiInsights, periodFrom, periodTo, kind: 'purchase' },
      };
    } catch (e) {
      console.error('[PurchaseForecastChat]', e.message);
      return `❌ Purchase forecast failed: **${e.message}**\n\nPlease check SAP B1 connection and try again.`;
    }
  }

  // ── Rush Order Prioritisation Agent ─────────────────────────────────────────
  if (intent.action === "rush_orders") {
    const sap = getActiveSap();
    try {
      const aiDeps = USE_AI ? { AI_PROVIDER, gptChatComplete, azureMessagesCreate } : null;
      const dbDeps = isConnected() ? { isConnected, getActiveType, getActiveConfig, executeSQL, tableRef, getTableColumns, resolveFieldMap } : null;
      const result = await runRushOrderScan(sap, { urgentWithinDays: intent.urgentWithinDays, aiDeps, dbDeps, dryRun: true });
      const { orders, summary: s } = result;

      if (orders.length === 0) {
        return result.message || `No open orders due within ${intent.urgentWithinDays} days.`;
      }

      let md = `## 🚨 Rush Order Prioritisation — Live Scan\n\n`;
      md += `**Scanned:** ${s.totalScanned} open orders due within **${s.urgentWithinDays} days** &nbsp;·&nbsp; ${new Date().toISOString().slice(0,10)}\n\n`;

      md += `### 📊 Urgency Summary\n\n`;
      md += `| Priority | Count | Action |\n|---|---|---|\n`;
      md += `| 🔴 CRITICAL (score ≥75) | **${s.critical}** | Immediate escalation |\n`;
      md += `| 🟠 URGENT (score ≥55) | **${s.urgent}** | Expedite recommended |\n`;
      md += `| 🟡 MONITOR (score ≥35) | **${s.monitor}** | Watch closely |\n`;
      md += `| 🟢 NORMAL | **${s.normal}** | Standard processing |\n\n`;

      if (s.autoApproved > 0 || s.requireReview > 0) {
        md += `| Auto-Approved | **${s.autoApproved}** orders | Cost within threshold |\n`;
        md += `| Manual Review Required | **${s.requireReview}** orders | Exceeds threshold |\n\n`;
      }

      // CRITICAL orders table
      const critical = orders.filter(o => o._tag === 'CRITICAL').slice(0, 5);
      if (critical.length > 0) {
        md += `### 🔴 CRITICAL Orders — Immediate Action\n\n`;
        md += `| Order# | Customer | Due Date | Value | Score | AI Recommendation |\n|---|---|---|---|---|---|\n`;
        for (const o of critical) {
          const rec = o._aiRec?.recommendation || 'PENDING';
          const cost = o._aiRec?.expediteShippingCost ? ` (+${o._aiRec.expediteShippingCost} expedite)` : '';
          md += `| **#${o.DocNum}** | ${(o.CardName||'').slice(0,25)} | ${o.DocDueDate?.slice(0,10)} | ${Number(o.DocTotal||0).toFixed(0)} | **${o._score}** | ${rec}${cost} |\n`;
        }
        md += '\n';
      }

      // URGENT orders table
      const urgent = orders.filter(o => o._tag === 'URGENT').slice(0, 5);
      if (urgent.length > 0) {
        md += `### 🟠 URGENT Orders — Expedite Review\n\n`;
        md += `| Order# | Customer | Due Date | Value | Score | Days Left |\n|---|---|---|---|---|---|\n`;
        for (const o of urgent) {
          md += `| **#${o.DocNum}** | ${(o.CardName||'').slice(0,25)} | ${o.DocDueDate?.slice(0,10)} | ${Number(o.DocTotal||0).toFixed(0)} | **${o._score}** | ${o._daysLeft > 0 ? o._daysLeft + 'd' : '**OVERDUE**'} |\n`;
        }
        md += '\n';
      }

      if (s.totalExpediteCost > 0) {
        md += `---\n\n**💰 Total Expedite Cost:** ${s.totalExpediteCost.toLocaleString()} &nbsp;·&nbsp; **Revenue Protected:** ${s.revenueProtected.toLocaleString()}\n\n`;
      }

      md += `---\n*Click **Open Rush Order Dashboard** to approve, hold, or escalate individual orders with full SAP integration.*`;

      const ordersForChat = orders.map(({ DocumentLines, ...rest }) => rest);

      return {
        text: md,
        openRushDashboard: true,
        rushData: { orders: ordersForChat, summary: s },
      };
    } catch (e) {
      console.error('[RushOrdersChat]', e.message);
      return `❌ Rush order scan failed: **${e.message}**\n\nPlease check SAP B1 connection.`;
    }
  }

  if (intent.action === "guide") return { text: GUIDES[intent.tool] || helpMessage(), openForm: intent.openForm };
  if (intent.action === "sales_analysis") {
    const params = parseSalesAnalysisQuery(message);
    console.log(`[SA] groupBy=${params.groupBy}, objTypeFilter=${params.objTypeFilter}(${params.objTypeLabel}), filter=${params.$filter}`);

    // Detect cost-centre dimension fields (Brand/SubBrand/Universe/etc.) — may be multiple
    const ccDimFields = params.groupBy.filter(g => /^CogsOcr/.test(g)); // e.g. ["CogsOcrCod","CogsOcrCo2"]
    const ccDimField  = ccDimFields[0] || null; // first one (backward compat)

    // ── Extract date range from $filter for use in SL/SMLSVC calls ───────────
    const now = new Date(), curY = now.getFullYear();
    const yrMatch  = params.$filter?.match(/PostingYear eq (\d{4})/)?.[1];
    const moMatch  = params.$filter?.match(/PostingMonth eq (\d{1,2})/)?.[1];
    const yr = yrMatch ? parseInt(yrMatch) : curY;
    let slFromDate, slToDate;
    if (moMatch) {
      const mo = parseInt(moMatch);
      const lastDay = new Date(yr, mo, 0).getDate();
      slFromDate = `${yr}-${String(mo).padStart(2,'0')}-01`;
      slToDate   = `${yr}-${String(mo).padStart(2,'0')}-${String(lastDay).padStart(2,'0')}`;
    } else {
      slFromDate = yrMatch ? `${yr}-01-01` : `${curY}-01-01`;
      slToDate   = yrMatch ? `${yr}-12-31` : now.toISOString().slice(0,10);
    }

    let data = null;

    // ── SQL-First: try AI-generated SQL, then pattern SQL, then SMLSVC ─────
    // Auto-reconnects if HANA was connected but dropped.
    if (!isConnected()) {
      const savedDb = dbConnRepo.getActive();
      if (savedDb) {
        try { await connectDB(savedDb); console.log('[SA-SQL] auto-reconnected DB'); }
        catch(e) { console.warn('[SA-SQL] auto-reconnect failed:', e.message); }
      }
    }
    if (isConnected()) {
      // ── Path A: AI generates SQL from natural language (preferred) ───────
      if (USE_AI) {
        try {
          const aiSQL  = await aiGenerateSQL(message);
          console.log(`[SA-AI] generated SQL: ${aiSQL.slice(0, 200)}`);
          const aiRows = await executeSQL(aiSQL);
          console.log(`[SA-AI] rows=${aiRows.length}`);
          if (aiRows.length) {
            const cols     = Object.keys(aiRows[0]);
            const header   = `| ${cols.join(' | ')} |`;
            const divider  = `| ${cols.map(() => '---').join(' | ')} |`;
            const rowLines = aiRows.slice(0, 200).map(r =>
              `| ${cols.map(c => String(r[c] ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 80)).join(' | ')} |`
            );
            const src = getActiveType().toUpperCase();
            return `## 📊 Sales Analysis\n\n🗄️ **${src} · AI Query** · ${aiRows.length} row${aiRows.length !== 1 ? 's' : ''}\n\n` +
              [header, divider, ...rowLines].join('\n') +
              `\n\n<details><summary>📋 SQL</summary>\n\n\`\`\`sql\n${aiSQL}\n\`\`\`\n</details>`;
          }
        } catch(eAI) {
          console.log(`[SA-AI] AI SQL failed: ${eAI.message} — falling through to pattern SQL`);
        }
      }
      // ── Path B: Pattern-based SQL fallback (when no AI or AI failed) ────
      try {
        const cfg    = getActiveConfig();
        const isHana = getActiveType() === 'hana';
        const inv0   = tableRef('OINV', cfg);
        const inv1   = tableRef('INV1', cfg);
        const sqlDims = params.groupBy
          .map((field, idx) => ({ field, idx, fn: SA_FIELD_TO_SQL[field] }))
          .filter(d => d.fn);
        if (sqlDims.length) {
          const LT   = isHana ? `T1."LineTotal"` : `T1.LineTotal`;
          const GP   = isHana ? `T1."GrssProfit"` : `T1.GrssProfit`;
          const QTY  = isHana ? `T1."Quantity"` : `T1.Quantity`;
          const DE   = isHana ? `T0."DocEntry"` : `T0.DocEntry`;
          const JOIN = isHana ? `T0."DocEntry"=T1."DocEntry"` : `T0.DocEntry=T1.DocEntry`;
          const dateFilter = isHana
            ? `T0."DocDate" BETWEEN '${slFromDate}' AND '${slToDate}'`
            : `T0.DocDate BETWEEN '${slFromDate}' AND '${slToDate}'`;
          const selectDims  = sqlDims.map(d => `${d.fn(isHana)} AS DIM${d.idx}`).join(', ');
          const groupByExpr = sqlDims.map(d => d.fn(isHana)).join(', ');
          const timeDims    = sqlDims.filter(d => /PostingYear|Month|Quarter/.test(d.field));
          const orderExpr   = timeDims.length
            ? timeDims.map(d => `DIM${d.idx} ASC`).join(', ') + ', SALES DESC'
            : 'SALES DESC';
          const sqlFirst = `SELECT ${selectDims}, SUM(${LT}) AS SALES, SUM(${GP}) AS GP, SUM(${QTY}) AS QTY, COUNT(DISTINCT ${DE}) AS DOCS FROM ${inv0} T0 INNER JOIN ${inv1} T1 ON ${JOIN} WHERE ${dateFilter} GROUP BY ${groupByExpr} ORDER BY ${orderExpr}`;
          console.log(`[SA-SQL] dims=${sqlDims.map(d=>d.field).join('+')} SQL=${sqlFirst.slice(0,180)}...`);
          const sqlRows = await executeSQL(sqlFirst);
          console.log(`[SA-SQL] rows=${sqlRows.length}`);
          if (sqlRows.length) {
            const mapped = sqlRows.map(r => {
              const obj = { NetSalesAmountLC: Number(r.SALES || 0), GrossProfitLC: Number(r.GP || 0), QuantityInInventoryUoM: Number(r.QTY || 0) };
              sqlDims.forEach(d => { obj[d.field] = r[`DIM${d.idx}`] ?? ''; });
              return obj;
            });
            data = { value: mapped, _source: 'SQL' };
          }
        }
      } catch(eSql) { console.log(`[SA-SQL] failed: ${eSql.message} — falling through to SMLSVC`); }
    }

    // ── Tier 1: SMLSVC POST (has CogsOcr* + GP natively) ────────────────────
    if (!data) try {
      console.log(`[SA-T1] SMLSVC POST fromDate=${slFromDate} toDate=${slToDate}`);
      let rows = await callSMLSVCPost("sales", buildParamList({ fromDate: slFromDate, toDate: slToDate }));
      console.log(`[SA-T1] got ${rows.length} rows, sample ObjType=${rows[0]?.ObjType}, CogsOcrCod=${rows[0]?.CogsOcrCod}`);
      if (params.objTypeFilter) {
        rows = rows.filter(r => String(r.ObjType) === params.objTypeFilter);
        console.log(`[SA-T1] after ObjType filter: ${rows.length} rows`);
      }
      if (rows.length) data = { value: rows };
      else throw new Error("no rows after filter");
    } catch(e1) {
      console.log(`[SA-T1] failed: ${e1.message}`);
    }

    // ── Tier 2: SMLSVC GET OData ─────────────────────────────────────────────
    if (!data) {
      const fp = [];
      if (params.$filter) fp.push(params.$filter);
      if (params.objTypeFilter) fp.push(`ObjType eq '${params.objTypeFilter}'`);
      const filterStr = fp.join(" and ");
      // Try with $select first; if that fails, retry without. Also try PostingDate range filter.
      const postingDateFilter = `PostingDate ge '${slFromDate}' and PostingDate le '${slToDate}'`;
      const t2Attempts = [
        { "$filter": filterStr || undefined, "$select": params.$select || undefined, "$orderby": params.$orderby || undefined },
        { "$filter": filterStr || undefined },
        { "$filter": postingDateFilter },
      ];
      for (const qp of t2Attempts) {
        Object.keys(qp).forEach(k => qp[k] === undefined && delete qp[k]);
        try {
          console.log(`[SA-T2] GET OData filter=${qp["$filter"]} select=${qp["$select"] || "all"}`);
          _logQ({ method: 'SMLSVC GET', endpoint: '/sml.svc/SalesAnalysisQuery', filter: qp['$filter'], select: qp['$select'], tier: 'Tier 2' });
          const r2 = await getActiveSap().get("/sml.svc/SalesAnalysisQuery", qp);
          let rows = Array.isArray(r2.value) ? r2.value : [];
          console.log(`[SA-T2] got ${rows.length} rows`);
          if (params.objTypeFilter) rows = rows.filter(r => String(r.ObjType) === params.objTypeFilter);
          _reqQueryLog[_reqQueryLog.length - 1].rows = rows.length;
          if (rows.length) { data = { value: rows }; break; }
        } catch(e2) {
          console.log(`[SA-T2] attempt failed: ${e2.message}`);
        }
      }
      if (!data) console.log("[SA-T2] all attempts returned 0 rows — falling to Tier 3");
    }

    // ── Tier 3: Service Layer Universal Fallback ──────────────────────────────
    // Handles ALL dimension types when SMLSVC (Tier 1/2) fails or returns 0.
    // Sales Orders (ObjType 17) are NOT in SalesAnalysisQuery view — always land here.
    // Routes to correct SL endpoint and aggregates by the requested dimension.
    if (!data) {
      const slEndpoint = params.objTypeFilter === '17' ? "/Orders"
                       : params.objTypeFilter === '23' ? "/DeliveryNotes"
                       : params.objTypeFilter === '14' ? "/CreditNotes"
                       : params.objTypeFilter === '16' ? "/Returns"
                       : "/Invoices";
      const slFilter = `DocDate ge '${slFromDate}' and DocDate le '${slToDate}'`;

      // Determine if we need DocumentLines expansion (for line-level dims)
      const LINE_DIMS = ["ItemCode","ItemDescription","WarehouseCode","WarehouseName","ItemGroup"];
      const needsLineLevel = ccDimFields.length > 0
        || params.groupBy.some(g => LINE_DIMS.includes(g));

      console.log(`[SA-T3] ${slEndpoint} needsLine=${needsLineLevel} groupBy=${params.groupBy.join(",")}`);
      let allDocs = [];

      if (needsLineLevel) {
        // ── Line-level: expand DocumentLines ─────────────────────────────────
        const lineSelectFields = new Set(["LineTotal","Quantity"]);
        ccDimFields.forEach(f => lineSelectFields.add(CC_SL_FIELD[f] || "CostingCode"));
        if (params.groupBy.includes("ItemCode") || params.groupBy.includes("ItemDescription")) {
          lineSelectFields.add("ItemCode"); lineSelectFields.add("ItemDescription");
        }
        if (params.groupBy.includes("WarehouseCode") || params.groupBy.includes("WarehouseName")) {
          lineSelectFields.add("WarehouseCode");
        }
        const slExpand = `DocumentLines($select=${[...lineSelectFields].join(',')})`;
        _logQ({ method: 'SL GET', endpoint: slEndpoint, filter: slFilter, expand: slExpand, tier: 'Tier 3 Line-Level' });

        try {
          const r = await getActiveSap().get(slEndpoint, {
            $filter: slFilter, $expand: slExpand,
            $select: "DocEntry,DocDate,DocNum,CardCode,CardName,DocTotal",
            $top: 500,
          });
          allDocs = Array.isArray(r.value) ? r.value : [];
          console.log(`[SA-T3] expand(select) docs=${allDocs.length}`);
        } catch(e3a) {
          console.log(`[SA-T3] expand(select) failed: ${e3a.message} — retrying full expand`);
          try {
            const r = await getActiveSap().get(slEndpoint, {
              $filter: slFilter, $expand: "DocumentLines",
              $select: "DocEntry,DocDate,DocNum,CardCode,CardName,DocTotal", $top: 500,
            });
            allDocs = Array.isArray(r.value) ? r.value : [];
            console.log(`[SA-T3] expand(full) docs=${allDocs.length}`);
          } catch(e3b) {
            console.log(`[SA-T3] full expand failed: ${e3b.message}`);
          }
        }
        _reqQueryLog[_reqQueryLog.length - 1].rows = allDocs.length;

        // Aggregate over DocumentLines
        const map = new Map();
        for (const doc of allDocs) {
          for (const line of (doc.DocumentLines || [])) {
            const keyParts = [];
            if (ccDimFields.length > 0) {
              ccDimFields.forEach(f => keyParts.push(line[CC_SL_FIELD[f] || "CostingCode"] || "(none)"));
            }
            if (params.groupBy.includes("ItemCode")) keyParts.push(line.ItemCode || "(none)");
            if (params.groupBy.includes("WarehouseCode")) keyParts.push(line.WarehouseCode || "(none)");
            if (!keyParts.length) keyParts.push("all");

            const key = keyParts.join("||");
            if (!map.has(key)) {
              const e = { NetSalesAmountLC: 0, GrossProfitLC: 0, QuantityInInventoryUoM: 0 };
              // Populate HANA-style field names so _aggregateSA works correctly
              ccDimFields.forEach(f => { e[f] = line[CC_SL_FIELD[f] || "CostingCode"] || "(none)"; });
              if (params.groupBy.includes("ItemCode")) {
                e.ItemCode = line.ItemCode || "(none)";
                e.ItemDescription = line.ItemDescription || line.ItemCode || "(none)";
              }
              if (params.groupBy.includes("WarehouseCode")) {
                e.WarehouseCode = line.WarehouseCode || "(none)";
                e.WarehouseName = line.WarehouseCode || "(none)";
              }
              map.set(key, e);
            }
            const e = map.get(key);
            e.NetSalesAmountLC += Number(line.LineTotal || 0);
            e.QuantityInInventoryUoM += Number(line.Quantity || 0);
          }
        }
        const rows = [...map.values()];
        console.log(`[SA-T3] ${rows.length} line-groups from ${allDocs.length} docs`);

        if (rows.length) {
          data = { value: rows };
        } else if (allDocs.length > 0) {
          // Docs exist but lines have no dimension values — show total with warning
          const totalAmt = allDocs.reduce((s,d) => s + (d.DocumentLines||[]).reduce((ls,l) => ls+Number(l.LineTotal||0), 0), 0);
          const totalQty = allDocs.reduce((s,d) => s + (d.DocumentLines||[]).reduce((ls,l) => ls+Number(l.Quantity||0), 0), 0);
          const dimName  = ccDimFields.length > 0 ? "Brand/CostingCode" : params.groupBy.join(", ");
          const rec = { NetSalesAmountLC: totalAmt, GrossProfitLC: 0, QuantityInInventoryUoM: totalQty,
            _brandNote: `⚠️ ${allDocs.length} documents found but **${dimName}** is not assigned on document lines in SAP B1.` };
          ccDimFields.forEach(f => { rec[f] = "(none)"; });
          if (params.groupBy.includes("ItemCode")) { rec.ItemCode = "(none)"; rec.ItemDescription = "(none)"; }
          if (params.groupBy.includes("WarehouseCode")) { rec.WarehouseCode = "(none)"; rec.WarehouseName = "(none)"; }
          data = { value: [rec] };
        }

      } else {
        // ── Header-level: customer, salesperson, date period (no expand needed) ─
        _logQ({ method: 'SL GET', endpoint: slEndpoint, filter: slFilter, tier: 'Tier 3 Header-Level' });
        try {
          const r = await getActiveSap().get(slEndpoint, {
            $filter: slFilter,
            $select: "DocEntry,DocDate,CardCode,CardName,DocTotal,SalesPersonCode",
            $top: 500,
          });
          allDocs = Array.isArray(r.value) ? r.value : [];
          _reqQueryLog[_reqQueryLog.length - 1].rows = allDocs.length;
          console.log(`[SA-T3-H] header docs=${allDocs.length}`);
        } catch(e3h) {
          console.log(`[SA-T3-H] failed: ${e3h.message}`);
        }

        const map = new Map();
        for (const doc of allDocs) {
          // Build group key from requested header-level dims
          const keyParts = params.groupBy.map(g => {
            if (g === "BusinessPartnerCode") return doc.CardCode || "(none)";
            if (g === "BusinessPartnerName") return doc.CardName || "(none)";
            if (g === "SalesEmployeeOrBuyerNumber") return String(doc.SalesPersonCode ?? "(none)");
            if (g === "PostingYear") return doc.DocDate ? doc.DocDate.slice(0,4) : "(none)";
            if (g === "PostingYearAndMonth") {
              return doc.DocDate ? doc.DocDate.slice(0,7).replace('-','') : "(none)";
            }
            if (g === "PostingYearAndQuarter") {
              if (!doc.DocDate) return "(none)";
              const mo = parseInt(doc.DocDate.slice(5,7));
              return `${doc.DocDate.slice(0,4)}${Math.ceil(mo/3)}`;
            }
            return "(all)";
          });
          const key = keyParts.join("||");

          if (!map.has(key)) {
            const e = { NetSalesAmountLC: 0, GrossProfitLC: 0, QuantityInInventoryUoM: 0 };
            // Populate HANA-style field names for _aggregateSA
            if (params.groupBy.includes("BusinessPartnerCode")) {
              e.BusinessPartnerCode = doc.CardCode || "(none)";
              e.BusinessPartnerName = doc.CardName || "(none)";
            }
            if (params.groupBy.includes("SalesEmployeeOrBuyerNumber")) {
              e.SalesEmployeeOrBuyerNumber = doc.SalesPersonCode ?? "(none)";
              e.SalesEmployeeOrBuyerName   = `Salesperson #${doc.SalesPersonCode ?? "?"}`;
            }
            if (params.groupBy.includes("PostingYear")) {
              e.PostingYear = doc.DocDate ? parseInt(doc.DocDate.slice(0,4)) : 0;
            }
            if (params.groupBy.includes("PostingYearAndMonth")) {
              e.PostingYearAndMonth = doc.DocDate
                ? parseInt(doc.DocDate.slice(0,7).replace('-','')) : 0;
            }
            if (params.groupBy.includes("PostingYearAndQuarter")) {
              const mo = doc.DocDate ? parseInt(doc.DocDate.slice(5,7)) : 1;
              e.PostingYearAndQuarter = doc.DocDate
                ? parseInt(`${doc.DocDate.slice(0,4)}${Math.ceil(mo/3)}`) : 0;
            }
            map.set(key, e);
          }
          const e = map.get(key);
          e.NetSalesAmountLC += Number(doc.DocTotal || 0);
        }
        const rows = [...map.values()];
        console.log(`[SA-T3-H] ${rows.length} groups from ${allDocs.length} docs`);
        if (rows.length) data = { value: rows };
      }
    }


    if (!data) {
      const period = slFromDate && slToDate ? ` for **${slFromDate}** → **${slToDate}**` : "";
      const docType = params.objTypeLabel !== "All Transactions" ? ` (${params.objTypeLabel})` : "";
      return `**No Data Found${docType}${period}**\n\n` +
        `Could not retrieve data from SAP B1. Possible reasons:\n` +
        `• No transactions exist for this period/type\n` +
        `• SAP B1 analytics views (sml.svc) are not published for this company\n` +
        `• The dimension you're grouping by may not be assigned on document lines\n\n` +
        `**Try asking:**\n` +
        `• \`customer wise sales ${params.objTypeFilter === '17' ? 'order' : 'invoice'} ${slFromDate?.slice(0,7) || ''}\`\n` +
        `• \`brand wise invoice ${slFromDate?.slice(0,7) || ''}\` (invoices have more data than orders)\n` +
        `• \`open orders\` to see current order pipeline`;
    }
    // Store context for follow-up drill-down on any result value
    if (params.groupBy?.length && data?.value?.length) {
      const primaryField = params.groupBy[0];
      const DIM_LABEL_MAP2 = { CogsOcrCod: CC_DIM_NAME.CogsOcrCod, CogsOcrCo2: CC_DIM_NAME.CogsOcrCo2, CogsOcrCo3: CC_DIM_NAME.CogsOcrCo3, CogsOcrCo4: CC_DIM_NAME.CogsOcrCo4, CogsOcrCo5: CC_DIM_NAME.CogsOcrCo5,
        BusinessPartnerCode:'Customer', BusinessPartnerName:'Customer', ItemCode:'Item', SalesEmployeeOrBuyerNumber:'Salesperson', WarehouseCode:'Warehouse',
        PostingYear:'Year', PostingYearAndMonth:'Month', PostingYearAndQuarter:'Quarter' };
      _lastSAContext = {
        groupByField: primaryField,
        dimName:      DIM_LABEL_MAP2[primaryField] || primaryField,
        values:       new Set(data.value.map(r => String(r[primaryField] ?? '')).filter(v => v && v !== '(none)' && v !== '')),
        fromDate:     slFromDate,
        toDate:       slToDate,
      };
    }
    try {
      const result = formatSalesAnalysis(data, params);
      if (_lastSAContext?.values?.size) {
        const examples = [..._lastSAContext.values].slice(0, 3).map(v => `\`${v}\``).join(', ');
        return result + `\n\n> 💬 **Follow-up:** Click or type any value to drill down — e.g. ${examples}`;
      }
      return result;
    } catch(e) {
      return `**Sales Analysis Error:** ${e.message}`;
    }
  }

  // ── Pre-defined SQL Reports (from reports-engine.mjs) ────────────────────────
  if (intent.action === "run_report") {
    const report = getReport(intent.reportId);
    if (!report) return `Unknown report: ${intent.reportId}`;
    if (report.type === 'ai') return `**${report.title}**\n\n> AI Report — sending your query to the assistant...\n\n*(Tip: switch to AI mode and ask: "${report.prompt}")*`;
    if (!isConnected()) return `**${report.title}**\n\n> No database connected. Please activate a DB connection in Settings → DB Connection, then ask again.`;
    try {
      const cfg    = getActiveConfig();
      const schema = cfg?.schema_name || cfg?.database || '';
      const rows   = await runReportSQL(intent.reportId, schema, executeSQL);
      if (!rows.length) return `**${report.title}**\n\nNo data found.`;
      const cols = Object.keys(rows[0]);
      const header = `| ${cols.join(' | ')} |`;
      const sep    = `| ${cols.map(() => '---').join(' | ')} |`;
      const body   = rows.slice(0, 50).map(r => `| ${cols.map(c => r[c] ?? '').join(' | ')} |`).join('\n');
      return `**${report.title}**\n_${report.description}_\n\n${header}\n${sep}\n${body}${rows.length > 50 ? `\n\n_Showing first 50 of ${rows.length} rows_` : ''}`;
    } catch(e) {
      return `**${report.title} Error:** ${e.message}`;
    }
  }

  if (intent.action === "dim_detail") {
    try { return await queryDimensionDetail(intent.value, intent.context); }
    catch(e) { return `**Detail Error:** ${e.message}`; }
  }
  if (intent.action === "kpi") {
    try { return await queryKPIs(); }
    catch(e) { return `**KPI Dashboard Error:** ${e.message}`; }
  }
  if (intent.action === "purchase_analysis") {
    try { return await queryPurchaseAnalysis(message); }
    catch(e) { return `**Purchase Analysis Error:** ${e.message}`; }
  }
  if (intent.action === "ar_aging") {
    try { return await queryARaging(); }
    catch(e) { return `**AR Aging Error:** ${e.message}`; }
  }
  if (intent.action === "ap_aging") {
    try { return await queryAPAging(); }
    catch(e) { return `**AP Aging Error:** ${e.message}`; }
  }
  if (intent.action === "open_orders") {
    try { return await queryOpenOrders(message); }
    catch(e) { return `**Open Orders Error:** ${e.message}`; }
  }
  if (intent.action === "open_quotations") {
    try { return await queryOpenQuotations(message); }
    catch(e) { return `**Open Quotations Error:** ${e.message}`; }
  }
  if (intent.action === "vendors") {
    try { return await queryVendors(message); }
    catch(e) { return `**Vendor List Error:** ${e.message}`; }
  }

  // ── SMLSVC POST analytical actions ──────────────────────────────────────────
  if (intent.action === "smlsvc") {
    const now = new Date(), y = now.getFullYear();
    const fromDate = `${y}-01-01`, toDate = now.toISOString().slice(0,10);
    const topN = intent.topN || 10;
    try {
      if (intent.queryType === "top_customers") {
        const rows = await callSMLSVCPost("sales", buildParamList({ fromDate, toDate }));
        const grouped = aggregateRows(rows, ["BusinessPartnerCode","BusinessPartnerName"]);
        const sorted  = grouped.sort((a,b)=>b.NetSalesAmountLC-a.NetSalesAmountLC).slice(0, topN);
        const grand   = sorted.reduce((s,r)=>s+r.NetSalesAmountLC,0);
        return `### 🏆 Top ${topN} Customers by Sales — ${y} YTD\n\n`
          + `**Total Sales:** ${fmt(grand)} | **Customers shown:** ${sorted.length}\n\n`
          + tbl(["Code","Customer","Net Sales","Gross Profit","GP%"],
              sorted.map(r=>[`**${r.BusinessPartnerCode}**`, r.BusinessPartnerName||"—",
                fmt(r.NetSalesAmountLC), fmt(r.GrossProfitLC), r.GPMarginPct.toFixed(1)+"%"]))
          + `\n\n💡 You can also ask:\n• \`top 10 items by sales\`\n• \`monthly sales trend\`\n• \`sales by salesperson\``;
      }
      if (intent.queryType === "top_items") {
        const rows = await callSMLSVCPost("sales", buildParamList({ fromDate, toDate }));
        const grouped = aggregateRows(rows, ["ItemCode","ItemDescription","ItemGroup"]);
        const sortBy  = intent.sortBy || "NetSalesAmountLC";
        const sorted  = grouped.sort((a,b)=>b[sortBy]-a[sortBy]).slice(0, topN);
        return `### 📦 Top ${topN} Items — ${y} YTD (sorted by ${sortBy==="QuantityInInventoryUoM"?"Qty":sortBy==="GrossProfitLC"?"GP":"Sales"})\n\n`
          + tbl(["Item Code","Description","Group","Net Sales","Qty","GP%"],
              sorted.map(r=>[`**${r.ItemCode}**`, r.ItemDescription||"—", r.ItemGroup||"—",
                fmt(r.NetSalesAmountLC), fmt(r.QuantityInInventoryUoM,0), r.GPMarginPct.toFixed(1)+"%"]))
          + `\n\n💡 You can also ask:\n• \`top items by quantity\`\n• \`item group sales\`\n• \`sales by warehouse\``;
      }
      if (intent.queryType === "by_period") {
        const FIELD = { month:"PostingYearAndMonth", quarter:"PostingYearAndQuarter", year:"PostingYear", week:"PostingYearAndWeek" };
        const field = FIELD[intent.periodType] || "PostingYearAndMonth";
        const rows  = await callSMLSVCPost("sales", buildParamList({ fromDate, toDate }));
        const grouped = aggregateRows(rows, [field]);
        const sorted  = grouped.sort((a,b)=>String(a[field]).localeCompare(String(b[field])));
        return `### 📅 Sales Trend by ${intent.periodType||"month"} — ${y} YTD\n\n`
          + tbl([intent.periodType==="quarter"?"Quarter":intent.periodType==="year"?"Year":"Month","Net Sales","Gross Profit","GP%"],
              sorted.map(r=>[String(r[field]||"—"), fmt(r.NetSalesAmountLC), fmt(r.GrossProfitLC), r.GPMarginPct.toFixed(1)+"%"]))
          + `\n\n💡 You can also ask:\n• \`quarterly sales this year\`\n• \`year over year comparison\`\n• \`top customers this year\``;
      }
      if (intent.queryType === "year_over_year") {
        const y1 = intent.year1 || y, y2 = intent.year2 || y-1;
        const rows = await callSMLSVCPost("sales", buildParamList({ fromDate:`${Math.min(y1,y2)}-01-01`, toDate:`${Math.max(y1,y2)}-12-31` }));
        const grouped = aggregateRows(rows, ["PostingYear"]);
        const r1 = grouped.find(r=>String(r.PostingYear)===String(y1)) || {};
        const r2 = grouped.find(r=>String(r.PostingYear)===String(y2)) || {};
        const growth = r2.NetSalesAmountLC ? ((((r1.NetSalesAmountLC||0)-(r2.NetSalesAmountLC||0))/(r2.NetSalesAmountLC))*100).toFixed(1) : "N/A";
        return `### 📊 Year-over-Year Comparison — ${y2} vs ${y1}\n\n`
          + `| KPI | ${y2} | ${y1} | Growth |\n|---|---|---|---|\n`
          + `| Net Sales | ${fmt(r2.NetSalesAmountLC||0)} | ${fmt(r1.NetSalesAmountLC||0)} | **${growth}%** |\n`
          + `| Gross Profit | ${fmt(r2.GrossProfitLC||0)} | ${fmt(r1.GrossProfitLC||0)} | — |\n`
          + `| GP Margin | ${(r2.GPMarginPct||0).toFixed(1)}% | ${(r1.GPMarginPct||0).toFixed(1)}% | — |\n\n`
          + `💡 You can also ask:\n• \`monthly trend this year\`\n• \`top customers by sales\`\n• \`quarterly sales\``;
      }
      if (intent.queryType === "salesperson") {
        const rows    = await callSMLSVCPost("sales", buildParamList({ fromDate, toDate }));
        const grouped = aggregateRows(rows, ["SalesEmployeeOrBuyerNumber","SalesEmployeeOrBuyerName"]);
        const sorted  = grouped.sort((a,b)=>b.NetSalesAmountLC-a.NetSalesAmountLC);
        return `### 👤 Salesperson Performance — ${y} YTD\n\n`
          + tbl(["Emp#","Salesperson","Net Sales","Gross Profit","GP%"],
              sorted.map(r=>[String(r.SalesEmployeeOrBuyerNumber||"—"), r.SalesEmployeeOrBuyerName||"—",
                fmt(r.NetSalesAmountLC), fmt(r.GrossProfitLC), r.GPMarginPct.toFixed(1)+"%"]))
          + `\n\n💡 You can also ask:\n• \`top customers by sales\`\n• \`monthly sales trend\``;
      }
      if (intent.queryType === "item_group") {
        const rows    = await callSMLSVCPost("sales", buildParamList({ fromDate, toDate }));
        const grouped = aggregateRows(rows, ["ItemGroup"]);
        const sorted  = grouped.sort((a,b)=>b.NetSalesAmountLC-a.NetSalesAmountLC);
        return `### 📂 Sales by Item Group — ${y} YTD\n\n`
          + tbl(["Item Group","Net Sales","Gross Profit","GP%"],
              sorted.map(r=>[r.ItemGroup||"—", fmt(r.NetSalesAmountLC), fmt(r.GrossProfitLC), r.GPMarginPct.toFixed(1)+"%"]))
          + `\n\n💡 You can also ask:\n• \`top items by sales\`\n• \`sales by warehouse\``;
      }
      if (intent.queryType === "warehouse") {
        const rows    = await callSMLSVCPost("sales", buildParamList({ fromDate, toDate }));
        const grouped = aggregateRows(rows, ["WarehouseCode","WarehouseName"]);
        const sorted  = grouped.sort((a,b)=>b.NetSalesAmountLC-a.NetSalesAmountLC);
        return `### 🏭 Sales by Warehouse — ${y} YTD\n\n`
          + tbl(["WH Code","Warehouse","Net Sales","Gross Profit","GP%"],
              sorted.map(r=>[`**${r.WarehouseCode||"—"}**`, r.WarehouseName||"—",
                fmt(r.NetSalesAmountLC), fmt(r.GrossProfitLC), r.GPMarginPct.toFixed(1)+"%"]))
          + `\n\n💡 You can also ask:\n• \`sales by item group\`\n• \`top customers by sales\``;
      }
    } catch(e) {
      return `**Analytics Error:** ${e.message}\n\n> Verify HANA SMLSVC analytics are enabled and the company namespace is resolvable.`;
    }
    return `Unknown analytics query type.`;
  }

  if (intent.action === "text") return intent.text;

  const { tool, args } = intent;
  if (!args || Object.values(args).some(v => v == null || (Array.isArray(v) && !v.length)))
    return `Missing parameters. Try the toolbar form or type **help**.`;

  try {
    const data = await callTool(tool, args);
    const map = {
      get_customer_list: formatCustomers, get_total_stock: formatStock,
      get_collections_worklist: formatCollections, check_atp: formatAtp,
      get_pick_list: formatPickList, confirm_delivery_pod: formatPod,
      create_sales_quotation: formatQuotation, create_sales_order: formatSalesOrder,
      create_delivery: formatDelivery, create_ar_invoice: formatInvoice,
      apply_incoming_payment: formatPayment,
      create_purchase_order: formatPurchaseOrder, create_goods_receipt_po: formatGrpo,
      create_ap_invoice: formatApInvoice, apply_outgoing_payment: formatOutgoingPayment,
      // New tools — raw JSON formatted nicely
      get_customer_details: (d) => {
        const bp = d;
        return `### 👤 Business Partner — ${bp.CardCode}\n\n`
          + `| Field | Value |\n|---|---|\n`
          + `| **Name** | ${bp.CardName||"—"} |\n`
          + `| **Type** | ${bp.CardType||"—"} |\n`
          + `| **Phone** | ${bp.Phone1||"—"} |\n`
          + `| **Email** | ${bp.EmailAddress||"—"} |\n`
          + `| **City** | ${bp.City||"—"} |\n`
          + `| **Country** | ${bp.Country||"—"} |\n`
          + `| **Balance** | ${fmt(Number(bp.CurrentAccountBalance||0))} |\n`
          + `| **Credit Limit** | ${fmt(Number(bp.CreditLimit||0))} |\n`
          + `| **Currency** | ${bp.Currency||"—"} |\n`
          + `| **Status** | ${bp.Frozen==="tYES"?"❌ Frozen":"✅ Active"} |\n`;
      },
      get_company_info: (d) => `### 🏢 Company Information\n\n`
        + `| Field | Value |\n|---|---|\n`
        + `| **Database** | ${d.ActiveDatabase||d.CompanyDB||"—"} |\n`
        + `| **Company Name** | ${d.CompanyName||"—"} |\n`
        + `| **Namespace** | ${d.Namespace||"—"} |\n`
        + `| **Country** | ${d.CountryCode||"—"} |\n`,
      switch_company: (d) => `### ✅ Company Switched\n\n`
        + `| Field | Value |\n|---|---|\n`
        + `| **New Company** | ${d.company||"—"} |\n`
        + `| **Namespace** | ${d.namespace||"—"} |\n`,
    };
    return (map[tool] || ((d) => `\`\`\`json\n${JSON.stringify(d, null, 2)}\n\`\`\``))(data);
  } catch (err) {
    return `**SAP B1 Error:** ${err.message}`;
  }
}

// ---------------------------------------------------------------------------
// AI mode
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Azure: direct axios call to avoid Anthropic SDK injecting x-api-key header
// ---------------------------------------------------------------------------
const _azureHttpsAgent = new https.Agent({ rejectUnauthorized: false });

async function azureMessagesCreate(body) {
  const url = `${process.env.AZURE_OPENAI_ENDPOINT}/v1/messages`;
  appendFileSync("d:/akhshat/MCP/debug.log", `[Azure] POST ${url} model=${body.model}\n`);
  const r = await axios.post(url, body, {
    headers: {
      "Authorization": `Bearer ${process.env.AZURE_OPENAI_API_KEY}`,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    httpsAgent: _azureHttpsAgent,
    validateStatus: () => true,
  });
  appendFileSync("d:/akhshat/MCP/debug.log", `[Azure] response ${r.status} ${JSON.stringify(r.data).slice(0,200)}\n`);
  if (r.status < 200 || r.status >= 300) {
    const errBody = r.data?.error || r.data;
    if (r.status === 404 && errBody?.code === "DeploymentNotFound") {
      throw new Error(
        `Azure Claude deployment not found: "${body.model}". ` +
        `Check your Azure AI Foundry portal for the correct deployment name and update AZURE_CLAUDE_MODEL in .env. ` +
        `Current value: ${body.model}`
      );
    }
    throw new Error(`Azure Claude ${r.status}: ${JSON.stringify(errBody)}`);
  }
  return r.data;
}

// Shared system prompt for all AI providers
function buildSapSystemPrompt() {
  const now   = new Date();
  const today = now.toISOString().slice(0, 10);          // e.g. 2026-04-13
  const year  = now.getFullYear();                        // e.g. 2026
  const month = String(now.getMonth() + 1).padStart(2, "0"); // e.g. 04
  const ytdFrom = `${year}-01-01`;

  return `You are an expert SAP Business One AI Assistant with live access to SAP B1 through MCP tools. You help business users with Sales, Purchases, Inventory, Finance, and CRM operations for company ${process.env.SAP_B1_COMPANY || "SAP B1"}.

DATE CONTEXT (CRITICAL — always use these when building filters):
- Today : ${today}
- Current year  : ${year}
- Current month : ${month}/${year}
- YTD range     : ${ytdFrom} to ${today}

TEMPORAL LANGUAGE RULES — apply every time:
- "this year" / "current year" / "YTD"  → PostingDate ge '${ytdFrom}' and PostingDate le '${today}'
- "this month"                           → PostingYear eq ${year} and PostingMonth eq '${month}'
- "last year"                            → PostingDate ge '${year - 1}-01-01' and PostingDate le '${year - 1}-12-31'
- "last month"                           → calculate the previous month from today
- "Q1 this year"                         → PostingDate ge '${year}-01-01' and PostingDate le '${year}-03-31'
- Never default to data from a different year unless the user explicitly requests it.
- If a query returns 0 rows, say "No data found for ${year}" — do NOT silently re-query a different year.

IDENTITY & BEHAVIOR:
- You are a friendly, professional Senior SAP B1 Business Consultant
- Always use tools to fetch LIVE data — NEVER guess, estimate, or fabricate numbers
- If a request is missing required info (customer code, item code, quantity, etc.), ask ONE clarifying question before proceeding
- When a tool fails due to invalid codes (e.g. invalid customer code), automatically recover: call get_customer_list to show available options and let the user pick
- Never show raw technical errors — translate them into clear, friendly business messages

RESPONSE FORMAT — always follow this structure:
1. CONFIRM: "✅ You want to [restate what user asked] | Period/filter: [if applicable]"
2. FETCH: silently call the appropriate tool(s)
3. RESULT TABLE: clean markdown table with all relevant columns
4. INSIGHT: "📊 [2–3 sentence business insight derived from the data]"
5. FOLLOW-UPS — use a NUMBERED list (not bullets), fully self-contained (repeat any
   customer/item/date context, don't say "this" or "it"), so the user can reply
   with just the number to pick one and you can answer it without needing anything
   else from earlier in the conversation:
   "💡 You can also ask (reply with the number):\\n1. [question 1]\\n2. [question 2]\\n3. [question 3]"
   If a question needs a specific value you don't have yet (e.g. which customer),
   phrase the numbered item as the choice itself (e.g. "3. Filter to a specific
   customer") — if the user picks it, ask ONE clarifying question for that value.

NUMBER FORMATTING:
- Always use comma separators: 1,23,456
- Currency always labeled (GBP / USD / EUR)
- Percentages always 2 decimal places: 28.50%
- Quantities as whole numbers with units

MULTI-TURN CONVERSATION:
- Remember context from earlier in the session — if user says "ABC001" after asking about a customer, use that as the customer code
- Carry forward document numbers, customer codes, item codes from earlier messages when logical
- If a quotation was just created, offer to convert it to a sales order

TOOLS YOU HAVE:
${isConnected() ? `
DIRECT DATABASE ACCESS IS ACTIVE — query_hana_direct is your ONLY analytics/reporting tool:
- A live ODBC connection to ${getActiveType() === 'hana' ? 'HANA' : 'MSSQL'} is connected. sml.svc-backed tools
  (query_sml_view, get_sales_analysis, get_top_customers, get_top_items, get_sales_by_period,
  get_salesperson_performance, get_item_group_sales, get_warehouse_sales, get_year_over_year) have been
  REMOVED from your tool list — they do not exist right now, do not attempt to call them.
- For EVERY reporting, analytics, or "how many / how much / top N / trend / breakdown / total" question —
  including brand/sub-brand/budget/universe/cogs-customer (CogsOcrCod family) grouping — call
  query_hana_direct with the user's question in natural language. It classifies the SAP module, generates
  dialect-correct SQL against the live schema (which knows the CogsOcrCod=Brand / CogsOcrCo2=SubBrand /
  CogsOcrCo3=Budget / CogsOcrCo4=Universe / CogsOcrCo5=CogsCustomer mapping on the transactional line
  tables), and executes it directly — no row-count cap, unlike Service Layer's ~20-row default.
- Still use call_service_layer / the specific convenience tools below for single-record lookups, master
  data, and WRITE actions (create/update/post a document) — query_hana_direct is SELECT-only.
- If the request is ambiguous (e.g. "forecast" without saying for what/how), ask ONE clarifying
  question first (per IDENTITY & BEHAVIOR above) before calling any tool — do not guess.
` : `
DIRECT DATABASE ACCESS — query_hana_direct (PREFER THIS for bulk/historical data):
- Queries the SAP B1 database DIRECTLY over ODBC (HANA or MSSQL) — NO row-count cap.
- Service Layer tools (query_sml_view, get_sales_analysis, call_service_layer, etc.) are paginated
  and typically return only ~20 rows unless $top is raised — that is NOT enough for full historical
  analysis, trend/forecast base data, top-N lists across many rows, or aging reports with many lines.
- Whenever the question needs more than a handful of rows — "last 6 months sales", "all AR aging",
  "top 50 items", "full purchase history", data to base a forecast on, etc. — call query_hana_direct
  with the user's question in natural language instead of a Service Layer tool. It classifies the SAP
  module, generates dialect-correct SQL (HANA or MSSQL, whichever is connected), and executes it directly.
- Only available when a direct HANA/MSSQL connection is active; if it's not in your tool list, fall
  back to the Service Layer tools below.
- If the request is ambiguous (e.g. "forecast" without saying for what/how), ask ONE clarifying
  question first (per IDENTITY & BEHAVIOR above) before calling any tool — do not guess.
`}
${isConnected() ? `COST-CENTRE DIMENSIONS via query_hana_direct — brand/sub-brand/budget/universe/cogs-customer:
Field mapping (present on the transactional line tables — pass this context in your question to
query_hana_direct, e.g. "sales this year grouped by brand (CogsOcrCod)"):
  CogsOcrCod = Brand
  CogsOcrCo2 = Sub Brand
  CogsOcrCo3 = Budget
  CogsOcrCo4 = Universe
  CogsOcrCo5 = Cogs Customer
If query_hana_direct returns 0 rows for a brand grouping, tell the user documents exist but
CostingCode (Brand) may not be assigned on those lines — don't just say "no data found" without
checking totals for the same period without the brand grouping first.
` : `HANA ANALYTICS — query_sml_view (PRIMARY analytics tool, ONLY when no ODBC connection is active):
Use for ALL reporting, analytics, and document queries. Queries SAP B1 Standard HANA Model views via sml.svc.
- viewName: the view to query (see list below)
- filter: OData $filter (e.g. PostingDate ge '2026-01-01' and PostingDate le '2026-03-31')
- select: comma-separated fields (omit for all)
- orderby: e.g. TotalAmountLC desc
- top: max rows (default 50)

AVAILABLE VIEWS:
Sales/Quotation: SalesQuotationHeaderQuery, SalesQuotationDetailQuery, SalesOrderHeaderQuery, SalesOrderDetailQuery, SalesAnalysisQuery, AverageSellingPriceQuery, SalesReturnStatisticsQuery, BackOrderStatusQuery, SalesOrderFulfillmentCycleTimeQuery
AR/Receivables:  ARInvoiceHeaderQuery, ARInvoiceDetailQuery, ARCreditMemoHeaderQuery, CustomerReceivableAgingQuery, AgingQuery
Delivery:        DeliveryHeaderQuery, DeliveryDetailQuery, OnTimeDeliveryStatisticsQuery
Purchase/AP:     PurchaseAnalysisQuery, PurchaseOrderHeaderQuery, PurchaseOrderDetailQuery, APInvoiceHeaderQuery, APCreditMemoHeaderQuery, VendorBalanceAnalysisQuery, VendorPaymentAgingQuery, GoodsReceiptPOHeaderQuery, OnTimeReceiptStatisticsQuery
Inventory:       InventoryStatusQuery, InventoryTransactionDocumentsQuery, WMSSTOCK
Finance/GL:      ProfitAndLossQuery, BalanceSheetQuery, GeneralLedgerBPQuery, GeneralLedgerAccountQuery, TransactionalJournalQuery, BudgetVSActualQuery, CashFlowStatementQuery, VATReportQuery, TaxReportQuery
KPI:             KPIProfitAndLossQuery, KPICashFlowStatementQuery, KPIBalanceSheetQuery
CRM:             OpportunityQuery, OpportunityWinRateQuery, CustomerAttritionRatePredictionQuery
Returns:         ReturnHeaderQuery, GoodsReturnHeaderQuery

KEY FIELDS (header views): DocumentNumber, BusinessPartnerCode, BusinessPartnerName, SalesEmployeeOrBuyerName, PostingDate, PostingYear, PostingMonth, PostingQuarter, DocumentStatus (O=Open, C=Closed), TotalAmountLC, GrossProfitLC, OpenAmountLC
KEY FIELDS (detail views): + ItemCode, ItemDescription, ItemGroup, Quantity, OpenQuantity, LineTotalAmountLC, WarehouseCode

COST-CENTRE DIMENSIONS — CRITICAL RULES:
These fields ONLY exist in HANA analytics views (SalesAnalysisQuery, PurchaseAnalysisQuery).
They do NOT exist in transactional Service Layer endpoints (Invoices, Orders, etc.).
NEVER use call_service_layer or SalesOrderDetailQuery to fetch these fields — it will always fail.

Field mapping:
  CogsOcrCod = Brand
  CogsOcrCo2 = Sub Brand
  CogsOcrCo3 = Budget
  CogsOcrCo4 = Universe
  CogsOcrCo5 = Cogs Customer

MANDATORY approach for any brand/sub-brand/budget/universe/cogs-customer query:
→ ALWAYS use get_sales_analysis (NOT query_sml_view) — it uses SMLSVC POST which reliably returns CogsOcr* fields.
→ Set groupBy to the relevant field: CogsOcrCod=Brand, CogsOcrCo2=SubBrand, CogsOcrCo3=Budget, CogsOcrCo4=Universe, CogsOcrCo5=CogsCustomer
→ Pass fromDate/toDate as YYYY-MM-DD date strings (NOT PostingYear/PostingMonth — those are not valid API params)
→ Use docType param to filter document type (optional)

DOCUMENT TYPE via docType param in get_sales_analysis:
  docType='order'      = Sales Orders (ObjType 17)
  docType='invoice'    = AR Invoices (ObjType 13)
  docType='delivery'   = Deliveries (ObjType 23)
  docType='credit_memo'= AR Credit Memos (ObjType 14)
  docType='return'     = AR Returns (ObjType 16)
  (omit docType)       = all transaction types combined

Example: "brand-wise sales this year"
→ get_sales_analysis(fromDate='${new Date().getFullYear()}-01-01', toDate='${new Date().toISOString().slice(0,10)}', groupBy='CogsOcrCod', topN=100)
Then display results as "Brand | Net Sales | Gross Profit | GP%" table.

Example: "brand wise sales order June 2025"
→ get_sales_analysis(fromDate='2025-06-01', toDate='2025-06-30', groupBy='CogsOcrCod', docType='order', topN=200)
Then display results grouped by Brand.

WHEN get_sales_analysis returns count=0 for docType='order':
→ Call call_service_layer(endpoint='/Orders', params={filter:"DocDate ge '2025-06-01' and DocDate le '2025-06-30'",$select:"DocNum,DocDate,CardCode,CardName,DocTotal",$top:10}) to confirm if orders exist at all.
→ If orders exist but brand=0 rows: tell user "Orders exist for this period but CostingCode (Brand) is not assigned on the order lines in SAP B1."
→ If no orders at all: tell user "No sales orders found in SAP B1 for this date range."
→ NEVER just say "no data found" without first verifying whether the documents exist.

WHEN brandFieldNote contains "WARNING": tell the user the number of orders found and that brand/CostingCode is not set on those order lines, then offer to show the orders grouped by customer or item instead.

NOTE: query_sml_view uses OData GET which may fail for brand/CogsOcr queries — always prefer get_sales_analysis for any CogsOcr dimension.
`}
GENERIC (covers ALL SAP B1 transactional endpoints):
- call_service_layer: Call ANY SAP B1 Service Layer REST endpoint for transactions not covered above
  USE THIS for: ProductionOrders, ServiceCalls, StockTransfers, JournalEntries, etc.

BUSINESSPARTNER FIELD NAMES (use exact names — wrong names cause SAP 400 errors):
  CurrentAccountBalance  ← NEVER use 'Balance' alone — it is invalid
  CreditLimit, CardCode, CardName, CardType, Phone1, EmailAddress, Currency, Frozen, City, Country
  For open orders exposure: OrdersBalance, OpenDeliveryNotesBalance

SPECIFIC CONVENIENCE TOOLS:
- get_customer_list, get_total_stock, check_atp, get_collections_worklist, get_pick_list
- get_top_customers, get_top_items, get_sales_by_period, get_salesperson_performance
- get_item_group_sales, get_warehouse_sales, get_year_over_year
- get_ar_aging, get_ap_aging, get_vendor_list, get_open_orders, get_open_quotations
- get_customer_details, get_company_info, switch_company

BUSINESS PARTNER QUERIES — CRITICAL ROUTING RULES:
- User asks about ONE specific customer or vendor (by code or name) → NEVER use get_customer_list or get_vendor_list
  • Known code (e.g. C20000, V50000) → use get_customer_details(cardCode='X') for master data
  • Known name (partial) → call_service_layer GET /BusinessPartners?$filter=contains(CardName,'keyword')&$select=CardCode,CardName,CardType,Phone1,EmailAddress,CreditLimit,CurrentAccountBalance,SalesPersonCode&$top=10
- get_customer_list  → ONLY for "all customers", "list customers", "customer directory", "list of business partners", "list business partners", "show all business partners", "all business partners", "business partner list", "show customers" — NOT for a named BP
- get_vendor_list    → ONLY for "all vendors", "list suppliers", "list of vendors", "vendor list", "show vendors" — NOT for a named vendor
- "list of business partner" / "business partner list" / "all business partners" → ALWAYS call get_customer_list() (returns all customers + leads), do NOT call any sales or transaction tool
- get_ar_aging / get_ap_aging → ONLY for company-wide aging overview — NOT per-customer or per-vendor

BP TRANSACTION QUERIES — always use call_service_layer with $filter=CardCode eq 'X':
  Open Sales Orders    : GET /Orders?$filter=CardCode eq 'X' and DocumentStatus eq 'bost_Open' and Cancelled eq 'tNO'&$select=DocEntry,DocNum,DocDate,DocDueDate,DocTotal,DocCurrency,DocumentStatus
  Open AR Invoices     : GET /Invoices?$filter=CardCode eq 'X' and DocumentStatus eq 'bost_Open' and Cancelled eq 'tNO'&$select=DocEntry,DocNum,DocDate,DocDueDate,DocTotal,PaidToDate,DocCurrency
  All AR Invoices      : GET /Invoices?$filter=CardCode eq 'X' and Cancelled eq 'tNO'&$orderby=DocDate desc&$top=20
  Quotations           : GET /Quotations?$filter=CardCode eq 'X'&$select=DocEntry,DocNum,DocDate,DocDueDate,DocTotal,DocumentStatus&$orderby=DocDate desc&$top=10
  Deliveries           : GET /DeliveryNotes?$filter=CardCode eq 'X' and Cancelled eq 'tNO'&$orderby=DocDate desc&$top=10
  Incoming Payments    : GET /IncomingPayments?$filter=CardCode eq 'X' and Cancelled eq 'tNO'&$select=DocEntry,DocNum,DocDate,DocTotal,JournalRemarks&$orderby=DocDate desc&$top=10
  Open Purchase Orders : GET /PurchaseOrders?$filter=CardCode eq 'X' and DocumentStatus eq 'bost_Open' and Cancelled eq 'tNO'
  AP Invoices          : GET /PurchaseInvoices?$filter=CardCode eq 'X' and Cancelled eq 'tNO'&$orderby=DocDate desc&$top=20
  Vendor Payments      : GET /VendorPayments?$filter=CardCode eq 'X' and Cancelled eq 'tNO'&$orderby=DocDate desc&$top=10

BP MASTER + TRANSACTION DISPLAY — when user asks for full BP summary, show two sections:
  Section 1 — Master Data (from get_customer_details):
    CardCode | CardName | CardType | Phone | Email | Credit Limit | Current Balance | Open Orders | Salesperson
  Section 2 — Recent Transactions table:
    Doc Type | Doc # | Date | Due Date | Total | Status | Paid/Open Amount

EXAMPLE PROMPTS AND CORRECT TOOL MAPPING:
  "details for customer C20000"       → get_customer_details(cardCode='C20000')
  "show C20000 transactions"          → call_service_layer /Invoices + /Orders filtered by CardCode eq 'C20000'
  "open invoices for Norm Thompson"   → search BP by name first, then filter /Invoices by CardCode
  "vendor V50000 purchase history"    → call_service_layer /PurchaseOrders + /PurchaseInvoices filtered by CardCode eq 'V50000'
  "how much does customer C20000 owe" → call_service_layer /Invoices?$filter=CardCode eq 'C20000' and DocumentStatus eq 'bost_Open' — sum DocTotal − PaidToDate
  "aging for customer C20000"         → call_service_layer /Invoices?$filter=CardCode eq 'C20000' and DocumentStatus eq 'bost_Open'&$select=DocNum,DocDueDate,DocTotal,PaidToDate — calculate days overdue manually

ITEM STOCK QUERIES — CRITICAL ROUTING RULES:
- User asks about ONE specific item (by name or code) → ALWAYS use call_service_layer, NEVER use get_total_stock
  • Known item code  → GET /Items('{ItemCode}') with $select=ItemCode,ItemName,QuantityOnStock,QuantityOrderedByCustomers,QuantityOrderedFromVendors,MinInventory,MaxInventory,DefaultWarehouse,Mainsupplier,LeadTime,MinOrderQuantity,CostAccountingMethod,InventoryUOM
  • Known item name  → GET /Items with $filter=contains(ItemName,'keyword') and $select as above, $top=10
  • NEVER call get_total_stock when a specific item name or code is mentioned
- User asks for ALL items / overall stock overview / inventory list → use get_total_stock
- After fetching item data, ALWAYS show this table:
  | Field | Value |
  | On Hand | QuantityOnStock |
  | Committed (Sales) | QuantityOrderedByCustomers |
  | On Order (Purchase) | QuantityOrderedFromVendors |
  | Available | OnHand − Committed |
  | Min Stock | MinInventory |
  | Stock Status | OK / LOW / OUT (compare OnHand vs MinInventory) |
  | Default Warehouse | DefaultWarehouse |
  | Default Supplier | Mainsupplier → resolve name via /BusinessPartners('{code}') |
  | Lead Time | LeadTime days |
  | Costing Method | CostAccountingMethod |

═══════════════════════════════════════════════════════════
UNIVERSAL TRANSACTION FILTER REFERENCE
(Use these field names and values EXACTLY — wrong names cause SAP 400 errors)
═══════════════════════════════════════════════════════════

STATUS FIELDS (valid for ALL transactional documents):
  DocumentStatus eq 'bost_Open'    → open / in-progress documents
  DocumentStatus eq 'bost_Close'   → closed / fulfilled documents
  Cancelled eq 'tNO'               → not cancelled (always add unless explicitly asking for cancelled)
  Cancelled eq 'tYES'              → cancelled documents only
  NEVER use: Status, DocStatus, 'O', 'C' — these are SQL field names, NOT OData values

DATE FIELDS (valid for ALL documents):
  DocDate        → document creation / posting date
  DocDueDate     → delivery / payment due date
  TaxDate        → tax date
  Date filter patterns:
    Today          : DocDate eq '${today}'
    This month     : DocDate ge '${ytdFrom.slice(0,8)}01' and DocDate le '${today}'
    This year      : DocDate ge '${ytdFrom}' and DocDate le '${today}'
    Overdue        : DocumentStatus eq 'bost_Open' and DocDueDate lt '${today}'
    Date range     : DocDate ge 'YYYY-MM-DD' and DocDate le 'YYYY-MM-DD'
    Specific date  : DocDate eq 'YYYY-MM-DD'

COMMON FILTER FIELDS (valid for ALL transactional documents):
  CardCode eq 'X'              → specific customer or vendor
  SalesPersonCode eq N         → specific salesperson (integer)
  DocNum eq N                  → specific document number (integer)
  DocTotal gt N                → documents above amount
  DocTotal lt N                → documents below amount
  Series eq N                  → specific numbering series
  contains(CardName,'text')    → partial name match (case-sensitive in HANA)

PAYMENT FIELDS (AR/AP Invoices only):
  PaidToDate lt DocTotal       → partially paid invoices
  PaidToDate eq 0              → completely unpaid invoices

═══════════════════════════════════════════════════════════
ALL SAP B1 ENDPOINTS + CORRECT ROUTING
═══════════════════════════════════════════════════════════

SALES CYCLE:
  Endpoint             | When to use
  /Quotations          | Sales quotations (OQUT)
  /Orders              | Sales orders (ORDR)
  /DeliveryNotes       | Delivery notes / goods issue (ODLN)
  /Invoices            | AR invoices (OINV) — has PaidToDate field
  /CreditNotes         | AR credit notes / returns (ORIN)
  /Returns             | Sales returns (ORDN)

PURCHASE CYCLE:
  /PurchaseRequests    | Internal purchase requests (OPRQ) — unique: Requester, RequesterName
  /PurchaseQuotations  | RFQ to vendors (OPQT)
  /PurchaseOrders      | Purchase orders to vendors (OPOR)
  /PurchaseDeliveryNotes | Goods receipt PO / GRPO (OPDN)
  /PurchaseInvoices    | AP invoices (OPCH) — has PaidToDate field
  /PurchaseCreditNotes | AP credit notes (ORPC)
  /PurchaseReturns     | Purchase returns (ORPD)

PAYMENTS:
  /IncomingPayments    | Customer payments received (ORCT) — CardCode = customer
  /VendorPayments      | Vendor / outgoing payments (OVPM) — CardCode = vendor

INVENTORY:
  /Items               | Item master (OITM) — use /Items('{code}') for single item
  /Warehouses          | Warehouse master (OWHS)
  /StockTransfers      | Inter-warehouse stock transfers (OWTR)
  /InventoryGenEntries | Inventory adjustments (OIGE)

FINANCE:
  /JournalEntries      | GL journal entries (OJDT) — filter by ReferenceDate not DocDate
  /ChartOfAccounts     | GL chart of accounts (OACT)

OTHER:
  /ProductionOrders    | Production orders — Status field: 'P'=Planned, 'R'=Released, 'L'=Closed
  /ServiceCalls        | Service calls
  /BusinessPartners    | Customer/vendor master (OCRD)

═══════════════════════════════════════════════════════════
TRANSACTION ROUTING RULES — pick the RIGHT tool / filter
═══════════════════════════════════════════════════════════

SALES QUOTATIONS:
  "open quotations"                  → get_open_quotations()
  "open quotations for customer X"   → get_open_quotations(cardCode='X')
  "closed quotations"                → call_service_layer /Quotations $filter="DocumentStatus eq 'bost_Close' and Cancelled eq 'tNO'"
  "quotations this month"            → call_service_layer /Quotations $filter="DocDate ge 'YYYY-MM-01' and DocDate le 'TODAY' and Cancelled eq 'tNO'"
  "quotations for salesperson N"     → call_service_layer /Quotations $filter="SalesPersonCode eq N and Cancelled eq 'tNO'"
  "cancelled quotations"             → call_service_layer /Quotations $filter="Cancelled eq 'tYES'"

SALES ORDERS:
  "open sales orders"                → get_open_orders()
  "open orders for customer X"       → get_open_orders(cardCode='X')
  "closed orders"                    → call_service_layer /Orders $filter="DocumentStatus eq 'bost_Close' and Cancelled eq 'tNO'"
  "overdue orders"                   → call_service_layer /Orders $filter="DocumentStatus eq 'bost_Open' and DocDueDate lt 'TODAY' and Cancelled eq 'tNO'"
  "orders this month / this year"    → call_service_layer /Orders $filter="DocDate ge '...' and DocDate le '...' and Cancelled eq 'tNO'"
  "orders for salesperson N"         → call_service_layer /Orders $filter="SalesPersonCode eq N and Cancelled eq 'tNO'"
  "cancelled orders"                 → call_service_layer /Orders $filter="Cancelled eq 'tYES'"
  "order number 1234"                → call_service_layer /Orders $filter="DocNum eq 1234"

AR INVOICES:
  "open invoices / unpaid invoices"  → call_service_layer /Invoices $filter="DocumentStatus eq 'bost_Open' and Cancelled eq 'tNO'"
  "overdue invoices"                 → call_service_layer /Invoices $filter="DocumentStatus eq 'bost_Open' and DocDueDate lt 'TODAY' and Cancelled eq 'tNO'" $orderby="DocDueDate asc"
  "paid invoices"                    → call_service_layer /Invoices $filter="DocumentStatus eq 'bost_Close' and Cancelled eq 'tNO'"
  "invoices this month / this year"  → call_service_layer /Invoices $filter="DocDate ge '...' and DocDate le '...' and Cancelled eq 'tNO'"
  "invoices for customer X"          → call_service_layer /Invoices $filter="CardCode eq 'X' and Cancelled eq 'tNO'"
  "partially paid invoices"          → call_service_layer /Invoices $filter="DocumentStatus eq 'bost_Open' and PaidToDate gt 0 and Cancelled eq 'tNO'"

DELIVERY NOTES:
  "open deliveries"                  → call_service_layer /DeliveryNotes $filter="DocumentStatus eq 'bost_Open' and Cancelled eq 'tNO'"
  "deliveries this month"            → call_service_layer /DeliveryNotes $filter="DocDate ge 'YYYY-MM-01' and DocDate le 'TODAY' and Cancelled eq 'tNO'"
  "deliveries for customer X"        → call_service_layer /DeliveryNotes $filter="CardCode eq 'X' and Cancelled eq 'tNO'"

PURCHASE REQUESTS:
  "open purchase requests"           → call_service_layer /PurchaseRequests $filter="DocumentStatus eq 'bost_Open'"
  "purchase requests this month"     → call_service_layer /PurchaseRequests $filter="DocDate ge 'YYYY-MM-01' and DocDate le 'TODAY'"
  "my purchase requests" (requester) → call_service_layer /PurchaseRequests $filter="Requester eq 'CODE'"

PURCHASE ORDERS:
  "open purchase orders"             → call_service_layer /PurchaseOrders $filter="DocumentStatus eq 'bost_Open' and Cancelled eq 'tNO'"
  "open POs for vendor X"            → call_service_layer /PurchaseOrders $filter="CardCode eq 'X' and DocumentStatus eq 'bost_Open' and Cancelled eq 'tNO'"
  "closed purchase orders"           → call_service_layer /PurchaseOrders $filter="DocumentStatus eq 'bost_Close' and Cancelled eq 'tNO'"
  "overdue POs"                      → call_service_layer /PurchaseOrders $filter="DocumentStatus eq 'bost_Open' and DocDueDate lt 'TODAY' and Cancelled eq 'tNO'"
  "POs this month / this year"       → call_service_layer /PurchaseOrders $filter="DocDate ge '...' and DocDate le '...' and Cancelled eq 'tNO'"

GRPO (GOODS RECEIPT PO):
  "open GRPOs"                       → call_service_layer /PurchaseDeliveryNotes $filter="DocumentStatus eq 'bost_Open' and Cancelled eq 'tNO'"
  "GRPOs for vendor X"               → call_service_layer /PurchaseDeliveryNotes $filter="CardCode eq 'X' and Cancelled eq 'tNO'" $orderby="DocDate desc"
  "GRPOs this month"                 → call_service_layer /PurchaseDeliveryNotes $filter="DocDate ge 'YYYY-MM-01' and DocDate le 'TODAY' and Cancelled eq 'tNO'"

AP INVOICES:
  "open AP invoices / unpaid vendor invoices" → call_service_layer /PurchaseInvoices $filter="DocumentStatus eq 'bost_Open' and Cancelled eq 'tNO'"
  "overdue AP invoices"              → call_service_layer /PurchaseInvoices $filter="DocumentStatus eq 'bost_Open' and DocDueDate lt 'TODAY' and Cancelled eq 'tNO'" $orderby="DocDueDate asc"
  "paid AP invoices"                 → call_service_layer /PurchaseInvoices $filter="DocumentStatus eq 'bost_Close' and Cancelled eq 'tNO'"
  "AP invoices for vendor X"         → call_service_layer /PurchaseInvoices $filter="CardCode eq 'X' and Cancelled eq 'tNO'"

PAYMENTS:
  "customer payments this month"     → call_service_layer /IncomingPayments $filter="DocDate ge 'YYYY-MM-01' and DocDate le 'TODAY' and Cancelled eq 'tNO'"
  "vendor payments this month"       → call_service_layer /VendorPayments $filter="DocDate ge 'YYYY-MM-01' and DocDate le 'TODAY' and Cancelled eq 'tNO'"
  "payments from customer X"         → call_service_layer /IncomingPayments $filter="CardCode eq 'X' and Cancelled eq 'tNO'"
  "payments to vendor X"             → call_service_layer /VendorPayments $filter="CardCode eq 'X' and Cancelled eq 'tNO'"

DEFAULT $select FIELDS TO ALWAYS USE (never return all fields — too large):
  All doc headers : DocEntry,DocNum,DocDate,DocDueDate,CardCode,CardName,DocTotal,DocCurrency,DocumentStatus,Cancelled
  + AR/AP Invoices: add PaidToDate
  + Orders/POs    : add SalesPersonCode
  + Payments      : DocEntry,DocNum,DocDate,CardCode,CardName,DocCurrency,JournalRemarks,Cancelled
  $top default    : 20 (raise to 50-100 only when user asks for a full list)
  $orderby default: DocDate desc (most recent first)

═══════════════════════════════════════════════════════════
CONVENIENCE TOOL vs call_service_layer — WHEN TO USE EACH
═══════════════════════════════════════════════════════════
  get_open_orders(cardCode?)         → "open sales orders" (with optional customer filter)
  get_open_quotations(cardCode?)     → "open sales quotations"
  get_ar_aging()                     → "AR aging" / "overdue receivables summary" (company-wide ONLY)
  get_ap_aging()                     → "AP aging" / "overdue payables summary" (company-wide ONLY)
  get_collections_worklist()         → "collections priority" / "who to chase for payment"
  get_total_stock(search?,topN?)     → "all stock" / "inventory overview" — also accepts keyword search
  get_customer_list(search?)         → "list all customers", "list business partners", "all business partners", "business partner list", "list of business partners", "show customers" — also accepts name/code search
  get_vendor_list(search?)           → "list all vendors", "list of vendors", "vendor list", "show vendors"
  get_customer_details(cardCode)     → single BP master record by exact code
  check_atp(items[])                 → available-to-promise check for specific items+qty

  call_service_layer                 → EVERYTHING ELSE: closed docs, overdue, date ranges,
                                       purchase-side docs, payments, specific statuses,
                                       any filter not covered by a convenience tool above

O2C WORKFLOW:
- create_sales_quotation → create_sales_order → create_delivery → confirm_delivery_pod → create_ar_invoice → apply_incoming_payment

DECISION RULE:
- Analytics / reporting question              → ${isConnected() ? "use query_hana_direct (sml.svc tools are unavailable right now)" : "use query_sml_view with the most relevant view"}
- "open sales orders" / "open quotations"     → get_open_orders() / get_open_quotations()
- Single specific item stock / detail         → call_service_layer /Items('{code}') or /Items?$filter=contains(ItemName,'...')
- Single specific customer/vendor master data → get_customer_details(cardCode='X')
- Any transaction with a STATUS filter        → call_service_layer with DocumentStatus/Cancelled as defined above
- Any transaction with a DATE filter          → call_service_layer with DocDate/DocDueDate range
- Any transaction with a BP filter            → call_service_layer with CardCode eq 'X'
- get_total_stock                             → ONLY all-items overview (or with search keyword)
- get_customer_list / get_vendor_list         → ONLY full BP list (or with search keyword); triggers: "list business partners", "list of business partners", "all business partners", "list customers", "list vendors", "business partner list"
- get_ar_aging / get_ap_aging                 → ONLY company-wide aging, NEVER per-BP
- Transactional data not in sml.svc           → use call_service_layer
- NEVER say "I cannot access that data"       → always try call_service_layer first

ERROR RECOVERY:
- Invalid BP code → call get_customer_list, show table, ask user to pick
- Invalid item code → tell user the item wasn't found, ask for correct code
- Credit limit exceeded → show credit details clearly and suggest options
- Missing required fields → ask for exactly the missing field, nothing else
- Unknown endpoint → try call_service_layer with your best guess at the endpoint name

${buildAiSummary()}`;
}

// SMLSVC-backed analytics tools — all query SAP B1's HANA analytics views over
// sml.svc (OData GET or SMLSVC POST/ParamList). When a direct HANA/MSSQL ODBC
// connection is active, query_hana_direct can answer every one of these without
// touching sml.svc at all (no row cap, and sidesteps query_sml_view's documented
// OData GET reliability problems) — so they're excluded from the tool list the
// model sees whenever ODBC is connected, rather than relying on a prompt
// preference the model has been observed to ignore.
const SMLSVC_TOOL_NAMES = new Set([
  "query_sml_view", "get_sales_analysis", "get_top_customers", "get_top_items",
  "get_sales_by_period", "get_salesperson_performance", "get_item_group_sales",
  "get_warehouse_sales", "get_year_over_year",
]);

// Convert Anthropic-format MCP tools → OpenAI function format
function mcpToGptTools(tools) {
  return tools.map(t => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema || { type: "object", properties: {} },
    },
  }));
}

// Synthetic tool (not from the MCP server) that lets the tool-calling agent query
// HANA/MSSQL directly over ODBC — no Service Layer pagination cap. Intercepted in
// the agent loops below rather than dispatched via mcpClient.callTool.
const DIRECT_SQL_TOOL_DESC =
  "Query the SAP B1 database DIRECTLY via ODBC (HANA or MSSQL) with NO row-count cap — use this " +
  "instead of Service Layer tools (get_sales_analysis, query_sml_view, call_service_layer, etc.) " +
  "whenever the question needs more than a handful of rows: full sales/purchase history, " +
  "trend/forecast base data, top-N lists, aging reports, stock levels across many items, or any " +
  "bulk analytical query. Pass the user's question in natural language, in as much detail as " +
  "possible (date ranges, filters, item/customer names) — this classifies the SAP module, " +
  "generates dialect-correct SQL, and executes it.";
const DIRECT_SQL_TOOL_SCHEMA = {
  type: "object",
  properties: { question: { type: "string", description: "The natural-language data question to answer" } },
  required: ["question"],
};
const DIRECT_SQL_TOOL_GPT = {
  type: "function",
  function: { name: "query_hana_direct", description: DIRECT_SQL_TOOL_DESC, parameters: DIRECT_SQL_TOOL_SCHEMA },
};
const DIRECT_SQL_TOOL_CLAUDE = {
  name: "query_hana_direct", description: DIRECT_SQL_TOOL_DESC, input_schema: DIRECT_SQL_TOOL_SCHEMA,
};

// Formats a query_hana_direct tool result the same way for both agent loops.
async function callDirectSqlTool(question) {
  const { sql, rows } = await generateAndRunDirectSql(question);
  return rows.length
    ? `SQL used:\n${sql}\n\nResults (${rows.length} row${rows.length === 1 ? "" : "s"}, JSON):\n${JSON.stringify(rows.slice(0, 500))}`
    : `Query executed — 0 rows returned.\nSQL used:\n${sql}`;
}

async function gptChatComplete(body) {
  const url = process.env.AZURE_GPT_ENDPOINT;
  const r = await axios.post(url, body, {
    headers: {
      "api-key": process.env.AZURE_OPENAI_API_KEY,
      "Content-Type": "application/json",
    },
    httpsAgent: _azureHttpsAgent,
    validateStatus: () => true,
  });
  if (r.status < 200 || r.status >= 300) {
    throw new Error(`GPT ${r.status}: ${JSON.stringify(r.data)}`);
  }
  return r.data;
}

// ── Context management helpers ────────────────────────
// GPT-4o limit: 128K tokens. Reserve: 8K response + 4K system + 4K tools = ~16K.
const GPT_MSG_TOKEN_BUDGET = 100_000;
// Max characters per individual tool result before truncation (~10K tokens)
const TOOL_RESULT_MAX_CHARS = 36_000;

/** Rough token estimate: 1 token ≈ 3.5 chars for English/JSON */
function estimateTokens(messages) {
  return Math.ceil(JSON.stringify(messages).length / 3.5);
}

/** Truncate a single tool result string if it exceeds the char limit */
function truncateToolContent(content, maxChars = TOOL_RESULT_MAX_CHARS) {
  if (typeof content !== "string" || content.length <= maxChars) return content;
  const kept = content.slice(0, maxChars);
  const trimmed = content.length - maxChars;
  return kept + `\n\n[...truncated ${trimmed} chars — ${Math.ceil(trimmed/3.5).toLocaleString()} tokens removed to stay within context limit]`;
}

/**
 * Remove oldest complete conversation exchanges from the front of the history
 * until the estimated token count is under budget.
 * An "exchange" = one user turn + all following assistant/tool turns up to (not including) the next user turn.
 */
function trimToTokenBudget(messages, budget = GPT_MSG_TOKEN_BUDGET) {
  let msgs = [...messages];
  while (msgs.length > 2 && estimateTokens(msgs) > budget) {
    // Find the index of the second user message (end of first exchange)
    const nextUserIdx = msgs.findIndex((m, i) => i > 0 && m.role === "user");
    if (nextUserIdx === -1) {
      // Can't find a safe split — drop first message and hope for the best
      msgs = msgs.slice(1);
    } else {
      msgs = msgs.slice(nextUserIdx); // drop first exchange
    }
  }
  return msgs;
}

async function runGptAgentLoop(messages) {
  const dbConnected = isConnected();
  const systemPrompt = buildSapSystemPrompt();
  const availableMcpTools = dbConnected
    ? mcpTools.filter(t => !SMLSVC_TOOL_NAMES.has(t.name))
    : mcpTools;
  const toolsArr = [...(availableMcpTools.length ? mcpToGptTools(availableMcpTools) : []), ...(dbConnected ? [DIRECT_SQL_TOOL_GPT] : [])];
  const gptTools = toolsArr.length ? toolsArr : undefined;

  // Trim history to fit within context budget before every API call
  const safe = () => trimToTokenBudget(messages);

  let response = await gptChatComplete({
    messages: [{ role: "system", content: systemPrompt }, ...safe()],
    tools: gptTools,
    tool_choice: gptTools ? "auto" : undefined,
    max_tokens: 8096,
  });

  while (response.choices[0].finish_reason === "tool_calls") {
    const msg = response.choices[0].message;
    messages.push(msg);

    const toolResults = await Promise.all((msg.tool_calls || []).map(async tc => {
      try {
        const args = JSON.parse(tc.function.arguments);
        _logQ({ method: 'MCP Tool', tool: tc.function.name, params: args });
        const raw = tc.function.name === 'query_hana_direct'
          ? await callDirectSqlTool(args.question)
          : (r => Array.isArray(r.content) ? r.content.map(c => c.text).join("\n") : JSON.stringify(r))(await mcpClient.callTool({ name: tc.function.name, arguments: args }));
        _reqQueryLog[_reqQueryLog.length - 1].rows = (raw.match(/\n/g)||[]).length;
        // Truncate large payloads (e.g. full stock list, ABC-XYZ with 300 items) before adding to history
        return { role: "tool", tool_call_id: tc.id, content: truncateToolContent(raw) };
      } catch (e) {
        return { role: "tool", tool_call_id: tc.id, content: `Error: ${e.message}` };
      }
    }));

    messages.push(...toolResults);
    response = await gptChatComplete({
      messages: [{ role: "system", content: systemPrompt }, ...safe()],
      tools: gptTools,
      tool_choice: gptTools ? "auto" : undefined,
      max_tokens: 4096,
    });
  }

  const text = response.choices[0].message.content || "";
  messages.push(response.choices[0].message);
  return { text, messages };
}

// ---------------------------------------------------------------------------
// Prompt cache helpers
// ---------------------------------------------------------------------------
function normPrompt(text) {
  return text.toLowerCase().replace(/[^\w\s]/g, " ").replace(/\s+/g, " ").trim();
}

function findCacheMatch(prompt, threshold = 0.55) {
  const norm  = normPrompt(prompt);
  const exact = queryCacheRepo.findExact(norm);
  if (exact) return { row: exact, score: 1.0 };

  const stopWords = new Set(["the","a","an","is","are","in","of","to","for","and","or","show","me","give","list","get","my","this","that","what","how","all"]);
  const words = norm.split(" ").filter(w => w.length > 2 && !stopWords.has(w));
  if (!words.length) return null;

  const all = queryCacheRepo.findAll();
  let best = null, bestScore = 0;
  for (const row of all) {
    const rowWords = row.prompt_norm.split(" ").filter(w => w.length > 2 && !stopWords.has(w));
    const rowSet   = new Set(rowWords);
    const hits     = words.filter(w => rowSet.has(w)).length;
    const union    = new Set([...words, ...rowWords]).size;
    const score    = union > 0 ? hits / union : 0;
    if (score > bestScore) { bestScore = score; best = row; }
  }
  return bestScore >= threshold ? { row: best, score: bestScore } : null;
}

async function runAgentLoop(messages) {
  const primaryModel = process.env.AZURE_CLAUDE_MODEL ||
    (AI_PROVIDER === "azure" ? "claude-3-5-sonnet-20241022" : "claude-sonnet-4-6");
  const systemPrompt = buildSapSystemPrompt();
  const callAI = (body) =>
    AI_PROVIDER === "azure"
      ? azureMessagesCreate(body)
      : anthropic.messages.create(body);

  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const anthropic = (AI_PROVIDER === "azure" || AI_PROVIDER === "gpt") ? null : new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const toolCallsRecorded = []; // capture all tool calls for cache
  const claudeToolsArr = [...mcpTools, ...(isConnected() ? [DIRECT_SQL_TOOL_CLAUDE] : [])];
  const claudeTools = claudeToolsArr.length ? claudeToolsArr : undefined;

  let response = await callAI({ model:primaryModel, max_tokens:8096, system:systemPrompt, tools: claudeTools, messages });
  while (response.stop_reason === "tool_use") {
    const blocks = response.content.filter(b=>b.type==="tool_use");
    messages.push({ role:"assistant", content:response.content });
    const results = await Promise.all(blocks.map(async b => {
      try {
        _logQ({ method: 'MCP Tool', tool: b.name, params: b.input });
        const raw = b.name === 'query_hana_direct'
          ? await callDirectSqlTool(b.input.question)
          : (r => Array.isArray(r.content)?r.content.map(c=>c.text).join("\n"):JSON.stringify(r))(await mcpClient.callTool({ name:b.name, arguments:b.input }));
        _reqQueryLog[_reqQueryLog.length - 1].rows = (raw.match(/\n/g)||[]).length;
        toolCallsRecorded.push({ name: b.name, input: b.input, preview: raw.slice(0, 300) });
        return { type:"tool_result", tool_use_id:b.id, content: truncateToolContent(raw) };
      } catch(e) { return { type:"tool_result", tool_use_id:b.id, content:`Error: ${e.message}`, is_error:true }; }
    }));
    messages.push({ role:"user", content:results });
    response = await callAI({ model:primaryModel, max_tokens:4096, system:systemPrompt, tools:claudeTools, messages });
  }
  const text = response.content.filter(b=>b.type==="text").map(b=>b.text).join("\n");
  return { text, messages, toolCalls: toolCallsRecorded };
}

// ---------------------------------------------------------------------------
// Print HTML renderer
// ---------------------------------------------------------------------------
function renderPrint(docType, doc) {
  const TITLES = { quotation:"Sales Quotation", order:"Sales Order", delivery:"Delivery Note", invoice:"A/R Invoice" };
  const title = TITLES[docType] || docType;
  const lines = (doc.DocumentLines || []).filter(l => l.LineStatus !== "bost_Close");
  const linesHtml = lines.map((l, i) => `
    <tr>
      <td>${i+1}</td>
      <td>${l.ItemCode||""}</td>
      <td>${l.ItemDescription||""}</td>
      <td style="text-align:right">${Number(l.Quantity||0).toFixed(2)}</td>
      <td>${l.UoMCode||""}</td>
      <td style="text-align:right">${Number(l.UnitPrice||0).toFixed(2)}</td>
      <td style="text-align:right">${Number(l.DiscountPercent||0).toFixed(1)}%</td>
      <td style="text-align:right">${Number(l.LineTotal||0).toFixed(2)}</td>
    </tr>`).join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${title} #${doc.DocNum}</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{font-family:Arial,sans-serif;font-size:11px;color:#222;padding:28px 36px;max-width:900px;margin:auto}
    .print-btn{text-align:right;margin-bottom:16px}
    .print-btn button{padding:8px 18px;background:#5b6af0;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:13px}
    .header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:24px;padding-bottom:16px;border-bottom:2px solid #5b6af0}
    .company-name{font-size:20px;font-weight:700;color:#1a1d27}
    .company-sub{color:#888;font-size:11px;margin-top:2px}
    .doc-title{font-size:18px;font-weight:700;color:#5b6af0;text-align:right}
    .doc-num{font-size:13px;color:#444;text-align:right;margin-top:2px}
    .info-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:20px}
    .info-box{border:1px solid #ddd;border-radius:6px;padding:12px}
    .info-label{font-size:9px;font-weight:700;text-transform:uppercase;color:#888;letter-spacing:.06em;margin-bottom:6px}
    .info-val{font-size:12px;color:#222;margin-bottom:2px}
    .info-val strong{font-size:13px}
    table{width:100%;border-collapse:collapse;margin-bottom:16px}
    thead tr{background:#f0f2f8}
    th{padding:8px 10px;text-align:left;font-size:10px;font-weight:700;text-transform:uppercase;color:#555;border-bottom:2px solid #d0d4f0}
    td{padding:7px 10px;border-bottom:1px solid #eee;font-size:11px}
    tr:nth-child(even) td{background:#fafbfe}
    .totals{text-align:right;margin-bottom:20px}
    .total-row{display:flex;justify-content:flex-end;gap:24px;padding:3px 0;font-size:12px}
    .total-row.grand{font-size:14px;font-weight:700;padding-top:8px;border-top:2px solid #222;margin-top:4px}
    .badge{display:inline-block;padding:2px 8px;border-radius:12px;font-size:10px;font-weight:700}
    .badge-open{background:#d4f4e8;color:#1a7a4a}
    .badge-close{background:#f4d4d4;color:#7a1a1a}
    .comments-box{border:1px solid #ddd;border-radius:6px;padding:12px;margin-bottom:20px;font-size:11px;color:#444}
    .signatures{display:grid;grid-template-columns:1fr 1fr 1fr;gap:24px;margin-top:40px}
    .sig{text-align:center}
    .sig-line{border-top:1px solid #333;margin-top:32px;padding-top:4px;font-size:9px;color:#888;text-transform:uppercase}
    .footer-note{text-align:center;margin-top:20px;font-size:9px;color:#aaa}
    @media print{.print-btn{display:none}.page-break{page-break-before:always}}
  </style>
</head>
<body>
<div class="print-btn"><button onclick="window.print()">🖨️ Print</button></div>

<div class="header">
  <div>
    <div class="company-name">${process.env.SAP_B1_COMPANY||"Company"}</div>
    <div class="company-sub">SAP Business One</div>
  </div>
  <div>
    <div class="doc-title">${title}</div>
    <div class="doc-num"># ${doc.DocNum}</div>
    <div style="text-align:right;margin-top:4px">
      <span class="badge ${doc.DocumentStatus==="bost_Open"?"badge-open":"badge-close"}">${doc.DocumentStatus==="bost_Open"?"Open":"Closed"}</span>
    </div>
  </div>
</div>

<div class="info-grid">
  <div class="info-box">
    <div class="info-label">Bill To / Customer</div>
    <div class="info-val"><strong>${doc.CardName||doc.CardCode||"—"}</strong></div>
    <div class="info-val">${doc.CardCode||""}</div>
    ${doc.Address?`<div class="info-val" style="margin-top:4px;white-space:pre-line">${doc.Address}</div>`:""}
  </div>
  <div class="info-box">
    <div class="info-label">Document Details</div>
    <div class="info-val"><strong>Entry #${doc.DocEntry}</strong></div>
    <div class="info-val">Date: ${doc.DocDate?.slice(0,10)||"—"}</div>
    <div class="info-val">Due: ${doc.DocDueDate?.slice(0,10)||"—"}</div>
    <div class="info-val">Currency: ${doc.DocCurrency||"—"}</div>
  </div>
</div>

<table>
  <thead>
    <tr><th>#</th><th>Item Code</th><th>Description</th><th style="text-align:right">Qty</th><th>UoM</th><th style="text-align:right">Unit Price</th><th style="text-align:right">Disc%</th><th style="text-align:right">Total</th></tr>
  </thead>
  <tbody>${linesHtml}</tbody>
</table>

<div class="totals">
  <div class="total-row"><span>Subtotal</span><span>${Number((doc.DocTotal||0)-(doc.VatSum||0)).toFixed(2)} ${doc.DocCurrency||""}</span></div>
  <div class="total-row"><span>VAT / Tax</span><span>${Number(doc.VatSum||0).toFixed(2)}</span></div>
  <div class="total-row grand"><span>Total</span><span>${Number(doc.DocTotal||0).toFixed(2)} ${doc.DocCurrency||""}</span></div>
</div>

${doc.Comments?`<div class="comments-box"><strong>Comments / Remarks:</strong><br>${doc.Comments}</div>`:""}

<div class="signatures">
  <div class="sig"><div class="sig-line">Prepared By</div></div>
  <div class="sig"><div class="sig-line">Authorized By</div></div>
  <div class="sig"><div class="sig-line">Customer Signature</div></div>
</div>

<div class="footer-note">Generated by SAP B1 Assistant · ${new Date().toLocaleString()}</div>
</body></html>`;
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------
const app = express();
// Raised from the 100kb default so branding-logo uploads (base64 data URIs in JSON) fit.
app.use(express.json({ limit: "8mb" }));

// Attach per-session SAP client to request context
app.use((req, _res, next) => {
  const token  = getToken(req);
  const connId = token ? _sessConn.get(token) : null;
  let sessionSap = sap;
  if (connId) {
    // Session has an explicit company choice
    const conn = connRepo.getById(connId);
    if (conn) sessionSap = _getPoolClient(conn);
  } else {
    // No in-memory mapping (e.g. after server restart) — use DB's active connection
    const activeConn = connRepo.getActive();
    if (activeConn) sessionSap = _getPoolClient(activeConn);
  }
  _reqCtx.run({ sap: sessionSap }, next);
});

// Never cache HTML so the browser always gets the latest version
app.use((req, res, next) => {
  if (req.path === "/" || req.path.endsWith(".html")) {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
    res.setHeader("Pragma", "no-cache");
  }
  next();
});
app.use(express.static(path.join(__dirname, "public")));
// Generated Excel exports — a real file on disk, served statically, so a
// chat reply can link to it directly. Not committed (gitignored).
app.use("/exports", express.static(EXPORTS_DIR));

// ═══════════════════════════════════════════════════════════════
// AUTH helpers
// ═══════════════════════════════════════════════════════════════
function getToken(req) {
  // Check Authorization header first, then cookie
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) return auth.slice(7);
  return req.headers["x-auth-token"] || null;
}

function requireAuth(req, res, next) {
  const user = sessionRepo.verify(getToken(req));
  if (!user) return res.status(401).json({ error: "Unauthorised" });
  req.user = user;
  next();
}

// ── Auth routes ──────────────────────────────────────────────
// POST /auth/login
app.post("/auth/login", (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: "username and password required" });
  const user = userRepo.findByUsername.get(username.trim().toLowerCase());
  if (!user || !verifyPassword(password, user.password_hash))
    return res.status(401).json({ error: "Invalid username or password" });
  const token = sessionRepo.create(user.id);
  res.json({ token, id: user.id, username: user.username, fullName: user.full_name, role: user.role });
});

// POST /auth/logout
app.post("/auth/logout", (req, res) => {
  const token = getToken(req);
  if (token) sessionRepo.delete.run(token);
  res.json({ ok: true });
});

// GET /auth/me — returns user info + effective permissions (role + user overrides)
app.get("/auth/me", (req, res) => {
  const user = sessionRepo.verify(getToken(req));
  if (!user) return res.status(401).json({ error: "Unauthorised" });
  const permissions = userPermRepo.getEffective(user.user_id, user.role);
  res.json({ ...user, permissions, isSuperAdmin: user.role === 'superadmin' });
});

// ── Connection management routes (admin only) ─────────────────
// GET /api/connections/active-session — returns which company THIS session is using
app.get("/api/connections/active-session", requireAuth, (req, res) => {
  try {
    const token  = getToken(req);
    const connId = token ? _sessConn.get(token) : null;
    const conn   = connId ? connRepo.getById(connId) : connRepo.getActive();
    const pooled = connId ? _sapPool.has(connId) : false;
    res.json({ connId, conn: conn ? { id:conn.id, name:conn.name, company:conn.company, base_url:conn.base_url } : null, pooled });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/connections
app.get("/api/connections", requireAuth, (_req, res) => {
  try {
    res.json(connRepo.list.all());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/connections
app.post("/api/connections", requireAuth, (req, res) => {
  if (req.user.role !== "admin") return res.status(403).json({ error: "Admin only" });
  const { name, base_url, company, sl_user, sl_password, hana, schema_hint, dim_names } = req.body;
  if (!name || !base_url || !company || !sl_user || !sl_password)
    return res.status(400).json({ error: "All fields required" });
  try {
    const info = connRepo.create(name, base_url, company, sl_user, sl_password, hana || {}, schema_hint || '', dim_names || '');
    invalidateContextCache(company);
    res.json({ id: info.lastInsertRowid, ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/connections/:id/activate
app.put("/api/connections/:id/activate", requireAuth, (req, res) => {
  if (req.user.role !== "admin") return res.status(403).json({ error: "Admin only" });
  try {
    connRepo.activate(Number(req.params.id));
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/connections/:id  — edit a connection
app.put("/api/connections/:id", requireAuth, (req, res) => {
  if (req.user.role !== "admin") return res.status(403).json({ error: "Admin only" });
  const { name, base_url, company, sl_user, sl_password, hana, schema_hint, dim_names } = req.body;
  if (!name || !base_url || !company || !sl_user)
    return res.status(400).json({ error: "name, base_url, company and sl_user are required" });
  try {
    // If HANA password is blank, preserve the existing one (UI clears it on edit for security)
    const hanaObj = hana || {};
    if (!hanaObj.password && hanaObj.host) {
      const existing = connRepo.getById(Number(req.params.id));
      if (existing?.hana_password) hanaObj.password = existing.hana_password;
    }
    connRepo.update(Number(req.params.id), name, base_url, company, sl_user, sl_password || '', hanaObj, schema_hint || '', dim_names || '');
    invalidateContextCache(company);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/connections/:id/switch — activate + reload SAP client + call MCP switch_company
app.post("/api/connections/:id/switch", requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const conn = connRepo.getById(id);
    if (!conn) return res.status(404).json({ error: "Connection not found" });

    // Store in session map — per-user, not global
    const token = getToken(req);
    if (token) _sessConn.set(token, id);

    // Also update global DB active marker and process.env for MCP compatibility
    connRepo.activate(id);
    sap._activeUrl   = (conn.base_url || "").replace(/\/+$/, "");
    sap.sessionId    = null;
    sap.routeId      = null;
    process.env.SAP_B1_BASE_URL = conn.base_url;
    process.env.SAP_B1_COMPANY  = conn.company;
    process.env.SAP_B1_USER     = conn.sl_user;
    process.env.SAP_B1_PASSWORD = conn.sl_password;
    process.env.SL_BASE_URL     = conn.base_url;
    process.env.SL_COMPANY      = conn.company;
    process.env.SL_USER         = conn.sl_user;
    process.env.SL_PASSWORD     = conn.sl_password;

    let mcpSwitched = false;
    try {
      const result = await mcpClient.callTool({ name: "switch_company", arguments: { companyDB: conn.company } });
      mcpSwitched = !result.isError;
    } catch { }

    // Auto-connect direct DB using credentials stored on the SAP B1 connection record.
    // If this company has none configured, DISCONNECT rather than leave the previous
    // company's DB session active — otherwise Analytics V2/DB Direct would silently
    // keep querying the wrong company's data with no indication anything is off.
    let dbConnected = false;
    if (conn.hana_host) {
      try {
        await connectDB({
          db_type:     'hana',
          host:        conn.hana_host,
          port:        conn.hana_port || 30015,
          database:    conn.hana_database || conn.company,
          schema_name: conn.hana_schema  || conn.company,
          username:    conn.hana_user,
          password:    conn.hana_password,
        });
        dbConnected = true;
        console.log(`[Switch] Auto-connected HANA DB for ${conn.company}`);
      } catch(e) {
        console.warn(`[Switch] HANA auto-connect failed: ${e.message}`);
        await disconnectDB();
      }
    } else {
      // No direct-DB credentials for this company — make sure we're not still
      // connected to a DIFFERENT company's database from before the switch.
      await disconnectDB();
      console.log(`[Switch] No direct-DB credentials for ${conn.company} — DB Direct/Analytics V2 disconnected`);
    }

    res.json({
      ok: true, id: conn.id, name: conn.name, company: conn.company,
      base_url: conn.base_url, mcpSwitched, dbConnected,
      message: `Switched to **${conn.name}** (Company: ${conn.company})${mcpSwitched ? " — MCP session updated" : ""}${dbConnected ? " — HANA DB connected" : ""}`
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/connections/:id
app.delete("/api/connections/:id", requireAuth, (req, res) => {
  if (req.user.role !== "admin") return res.status(403).json({ error: "Admin only" });
  try {
    connRepo.delete.run(Number(req.params.id));
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── User management routes (admin only) ──────────────────────
// GET /api/users
app.get("/api/users", requireAuth, (req, res) => {
  if (req.user.role !== "admin") return res.status(403).json({ error: "Admin only" });
  res.json(userRepo.list.all());
});

// POST /api/users
app.post("/api/users", requireAuth, (req, res) => {
  if (req.user.role !== "admin") return res.status(403).json({ error: "Admin only" });
  const { username, password, fullName, role } = req.body;
  if (!username || !password) return res.status(400).json({ error: "username and password required" });
  try {
    const info = userRepo.create(username.trim().toLowerCase(), password, fullName || "", role || "user");
    res.json({ id: info.lastInsertRowid, ok: true });
  } catch (e) {
    res.status(409).json({ error: "Username already exists" });
  }
});

// DELETE /api/users/:id
app.delete("/api/users/:id", requireAuth, (req, res) => {
  if (req.user.role !== "admin" && req.user.role !== "superadmin") return res.status(403).json({ error: "Admin only" });
  userRepo.delete.run(Number(req.params.id));
  res.json({ ok: true });
});

// GET /api/users/:id/permissions — effective perms + role defaults + user overrides
app.get("/api/users/:id/permissions", requireAuth, (req, res) => {
  if (req.user.role !== "admin" && req.user.role !== "superadmin") return res.status(403).json({ error: "Admin only" });
  const uid = Number(req.params.id);
  const user = userRepo.findById.get(uid);
  if (!user) return res.status(404).json({ error: "User not found" });
  const rolePerms   = roleRepo.getPermissionsByRoleName(user.role);
  const overrides   = userPermRepo.getOverrides(uid);
  const effective   = userPermRepo.getEffective(uid, user.role);
  res.json({ userId: uid, username: user.username, role: user.role, rolePerms, overrides, effective, allPerms: ALL_PERMISSIONS });
});

// PUT /api/users/:id/permissions — save user-specific overrides
app.put("/api/users/:id/permissions", requireAuth, (req, res) => {
  if (req.user.role !== "admin" && req.user.role !== "superadmin") return res.status(403).json({ error: "Admin only" });
  const uid = Number(req.params.id);
  const user = userRepo.findById.get(uid);
  if (!user) return res.status(404).json({ error: "User not found" });
  if (user.role === "superadmin") return res.status(403).json({ error: "superadmin permissions cannot be changed" });
  const { overrides = [] } = req.body;
  userPermRepo.setOverrides(uid, overrides);
  res.json({ ok: true, count: overrides.length });
});

const sessions = new Map();

// Intents that must always go to the real statistical forecasting engine
// (runForecastCore via demoReply) — never to AI-generated SQL. A SELECT query
// cannot extrapolate a trend; asking an LLM to "forecast" via SQL is why
// forecast answers were inconsistent before this was routed deterministically.
const FORECAST_ACTIONS = new Set(["product_forecast", "purchase_forecast"]);

// ── Shared: AI generates SQL → executes directly against HANA/MSSQL ──────────
// Used by DB Direct mode, and preferred by GPT-4o/Claude modes for data questions
// when a direct DB connection is available (avoids SAP Service Layer's row limits).
// Reuses analytics-v2.mjs's generateSQL (same intent-scoped schema + dialect rules
// + business rules as Analytics V2 — single source of truth, no drift between
// engines) plus a pre-flight lint and a 2-attempt retry-with-error-feedback loop,
// and caches results for SQL_CACHE_TTL_MS so repeated questions answer instantly.
// Throws on failure (after both attempts) so callers can fall back to another data path.
const SQL_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
async function generateAndRunDirectSql(message) {
  const dbType = getActiveType();
  const dbCfg  = getActiveConfig();
  const schema = dbCfg?.schema_name || dbCfg?.database || "DB";
  const intent = classifyIntent(message);

  const cacheKey = schema + "::" + normPrompt(message);
  const cached = sqlCacheRepo.get(cacheKey, SQL_CACHE_TTL_MS);
  if (cached) return { sql: cached.sql, rows: cached.rows, dbType, cacheHit: true };

  // Query Template Library — known high-frequency questions skip AI SQL
  // generation entirely (faster, zero hallucination risk). Falls through to
  // AI generation below if the template's SQL fails against this schema.
  const template = matchTemplate(message, dbType, dbCfg);
  if (template) {
    try {
      const rows = await executeSQL(template.sql);
      sqlCacheRepo.set(cacheKey, schema, message, template.sql, rows);
      return { sql: template.sql, rows, dbType, cacheHit: false, template: template.name };
    } catch (err) {
      console.warn(`[TEMPLATE] ${template.name} failed (${err.message}), falling back to AI generation`);
    }
  }

  let lastError = null, generatedSQL = "", presentation = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      ({ sql: generatedSQL, presentation } = await generateSQL(message, intent, [], attempt > 1 ? lastError : null));
      const lintError = lintSql(generatedSQL, dbType);
      if (lintError) throw new Error(lintError);

      const rows = await executeSQL(generatedSQL);
      sqlCacheRepo.set(cacheKey, schema, message, generatedSQL, rows);
      return { sql: generatedSQL, rows, dbType, cacheHit: false, presentation };
    } catch (err) {
      lastError = err.message;
      if (attempt === 2) {
        err.sql = generatedSQL; // lets callers tell "generation failed" from "execution failed"
        throw err;
      }
    }
  }
}

// Peels off one layer of our own "Break down "X" by month..."-style wrapping.
// Without this, clicking a generated suggestion re-wraps the question on every
// answer — "Break down "Break down "X" by..." by..." — growing forever the more
// suggestions get clicked. Applied before re-embedding the question below so
// re-wrapping is idempotent no matter how many suggestions deep the user goes.
function unwrapSuggestionText(q) {
  const m = q.match(/^(?:Break down|Filter|Export)\s+"([\s\S]+)"\s+(?:by month or a date range|to a specific customer, item, or warehouse|as a report)$/i);
  return m ? m[1] : q;
}

// isExcelExportRequest / generateExcelExport now live in ./lib/excel-export.mjs
// (shared with analytics-v2.mjs) — see the RESPONSE FORMAT rules above for why:
// models trained on ChatGPT's Code Interpreter will otherwise invent a
// plausible-looking "sandbox:/file.xlsx" link that goes nowhere.

// ChatGPT-style wrap-up appended after a direct-SQL fast-path answer — the
// tool-calling agent already does this itself via the RESPONSE FORMAT rules in
// buildSapSystemPrompt (INSIGHT + FOLLOW-UPS), but the fast path below skips the
// agent entirely for speed, so it needs its own lightweight version.
// "Summary"-style wording ("give me an overview", "summarize sales", "at a
// glance"...) means the user wants the picture, not the rows — the frontend
// opens straight into the Chart + AI Summary tabs instead of the raw table.
function isSummaryStyleQuestion(question) {
  return /\b(summary|summarize|summarise|overview|insight|snapshot|at a glance|highlight|recap|chart|graph|plot|trend|analysis|analyse|analyze|visuali[sz]e)\b/i.test(question || "");
}

function buildDirectSqlWrapup(question, rows) {
  if (!rows || !rows.length) return "";
  const q = unwrapSuggestionText(question);
  // Real computed stats (total/avg/max/min/trend) from the actual rows —
  // not the AI eyeballing the table and describing it in free text.
  const insight = buildProfessionalInsight(q, rows);
  // Each numbered item re-embeds the original question so it's self-contained —
  // this fast path doesn't go through the agent's conversation history, so a
  // picked suggestion needs to carry its own context rather than relying on "this".
  // Numbered (not bulleted) so the user can just reply "1"/"2"/"3" to pick one.
  return `\n\n${insight}\n💡 **You can also ask** (reply with the number):\n1. Break down "${q}" by month or a date range\n2. Filter "${q}" to a specific customer, item, or warehouse\n3. Export "${q}" as a report`;
}

// Numbered-suggestion selection — sid -> the "💡 You can also ask" bullets from
// the last reply, so a bare "1"/"2"/"3" reply picks that suggestion instead of
// the user having to retype it.
const _lastSuggestions = new Map();

// sid -> { question } for a follow-up we had to ask a clarifying question about
// (e.g. "Filter ... to a specific customer, item, or warehouse" names no value).
// The direct-SQL fast path has no multi-turn memory of its own, so the *next*
// message from that session is treated as the missing answer and merged back
// into the original question rather than run as a disconnected new query.
const _pendingClarification = new Map();
function extractSuggestions(text) {
  if (!text) return [];
  const m = text.match(/💡[^\n]*\n((?:\s*(?:\d+[.)]|[•\-])[^\n]*\n?)+)/);
  if (!m) return [];
  return m[1].split("\n").map(l => l.replace(/^\s*(?:\d+[.)]|[•\-])\s*/, "").trim()).filter(Boolean);
}

// ── Chat ──
app.post("/api/chat", async (req, res) => {
  let { message, sessionId, engine } = req.body;
  if (!message) return res.status(400).json({ error: "message required" });
  const sid = sessionId || crypto.randomUUID();

  // "1" / "2." / "3)" → resolve against the suggestions shown last turn.
  const suggestionPick = /^\s*(\d{1,2})\s*[.):]?\s*$/.exec(message);
  if (suggestionPick) {
    const stored = _lastSuggestions.get(sid);
    const picked = stored && stored[parseInt(suggestionPick[1], 10) - 1];
    if (picked) message = picked;
  }

  // We previously asked "which customer/item/warehouse?" for this session —
  // this message is that answer. The reply usually names just the value
  // ("STRIPE TIKTOK") without saying which of the three it is, so don't guess
  // a single column (that silently picked the wrong dimension before, e.g.
  // matching a Brand field instead of the customer name) — ask the SQL
  // generator to match the value against all three possible fields instead.
  const pendingClarification = !suggestionPick && _pendingClarification.get(sid);
  if (pendingClarification) {
    const answer = message.trim();
    message = `${pendingClarification.question}, filtered to "${answer}" (match against customer name, item code/description, or warehouse code/name — whichever one it actually is, do not assume)`;
    _pendingClarification.delete(sid);
  }

  // The "Filter ... to a specific customer, item, or warehouse" follow-up we
  // ourselves generate (buildDirectSqlWrapup) names no actual value — sending
  // it straight to SQL generation used to silently return every customer/item/
  // warehouse ungrouped-down instead of filtering to one. Ask the missing
  // question instead of guessing, same as the tool-agent's own clarification rule.
  const ambiguousFilter = /^filter\s+"([\s\S]+?)"\s+to a specific customer,\s*item,\s*or warehouse\.?$/i.exec(message.trim());
  if (ambiguousFilter) {
    const origQuestion = ambiguousFilter[1];
    _pendingClarification.set(sid, { question: origQuestion });
    return res.json({
      reply: `Which would you like to filter *"${origQuestion}"* by — a **customer**, an **item**, or a **warehouse**? Tell me the specific one (name or code) and I'll rerun it filtered to just that.`,
      sessionId: sid,
      mode: "clarify",
    });
  }

  // "prepare excel ... with trend analysis and item wise month wise analysis,
  // multiple tabs, multi chart" → a structured multi-view report, not a single
  // flat table. Engine-agnostic (works regardless of db/ai/gpt) and bypasses
  // the normal single-query flow entirely since there's no one table to show.
  if (isMultiTabReportRequest(message) && isConnected()) {
    try {
      const { url, built, failed } = await buildMultiTabExcelReport(message);
      const tabLines = built.map((t, i) =>
        `${i + 1}. **${t.name}**${t.chartType !== "none" ? ` (${t.chartType} chart)` : ""} — ${t.rows.length.toLocaleString()} rows`
      ).join("\n");
      const failLines = failed.length
        ? `\n\n⚠️ ${failed.length} tab${failed.length > 1 ? "s" : ""} couldn't be built: ${failed.map(f => f.name).join(", ")}`
        : "";
      const reply = `📊 **Multi-tab Excel report ready** — ${built.length} tab${built.length > 1 ? "s" : ""} built:\n${tabLines}${failLines}\n\n📥 **[Download Report](${url})**`;
      return res.json({ reply, sessionId: sid, mode: "excel-report" });
    } catch (err) {
      return res.status(500).json({ error: `Report generation failed: ${err.message}` });
    }
  }

  // ── Analytics V2: AI generates SQL → runs on HANA/MSSQL directly ──────────
  if (engine === "v2") return handleV2Chat(req.body, res);

  // When AI_PROVIDER=gpt, treat "ai" engine as GPT-4o
  const useGPT = (engine === "gpt4o" || (engine === "ai" && AI_PROVIDER === "gpt")) && GPT_AVAILABLE;
  const useAI  = engine === "ai" && USE_AI && AI_PROVIDER !== "gpt";
  const useDB  = engine === "db";
  _reqQueryLog = []; // reset per-request
  try {
    let reply, openForm, openForecastDashboard, forecastData, openRushDashboard, rushData, cacheHit = false, cacheSource = null;

    if (useDB) {
      // ── DB Direct mode: AI generates SQL → execute against MSSQL/HANA ──────
      if (!isConnected()) {
        const saved = dbConnRepo.getActive();
        if (saved) {
          try { await connectDB(saved); } catch (e) {
            return res.status(503).json({ error: `DB connection failed: ${e.message}. Please re-configure in Settings → DB Connection.` });
          }
        } else {
          return res.status(503).json({ error: "No DB connection configured. Go to Settings → DB Connection to add one." });
        }
      }
      let generatedSQL = "", rows = [], dbType = getActiveType(), presentation = null;
      try {
        const result = await generateAndRunDirectSql(message);
        generatedSQL = result.sql; rows = result.rows; dbType = result.dbType; presentation = result.presentation;
      } catch (err) {
        if (!err.sql) return res.status(500).json({ error: `SQL generation failed: ${err.message}` });
        generatedSQL = err.sql;
        reply = `⚠️ **SQL Error**\n\n\`\`\`sql\n${generatedSQL}\n\`\`\`\n\n**Error:** ${err.message}`;
      }

      if (!reply) {
        if (!rows || rows.length === 0) {
          reply = `✅ **Query executed — no records found**\n\n\`\`\`sql\n${generatedSQL}\n\`\`\``;
        } else {
          // Emit structured block — frontend renders rich tabbed analytics card
          const payload = { rows: rows.slice(0, 500), sql: generatedSQL, source: `DB Direct · ${dbType.toUpperCase()}`, rowCount: rows.length, question: message, displayMode: presentation || (isSummaryStyleQuestion(message) ? "chart" : "table") };
          reply = `__ATBL__${JSON.stringify(payload)}__/ATBL__${buildDirectSqlWrapup(message, rows)}`;
          if (isExcelExportRequest(message)) {
            const excelUrl = await generateExcelExport(message, rows);
            reply += `\n\n📥 **[Download Excel (${rows.length} rows)](${excelUrl})**`;
          }
        }
      }
      if (generatedSQL) _logQ({ method: 'SQL', endpoint: 'Direct DB Query', sql: generatedSQL, rows: rows.length });
      const dbSuggestions = extractSuggestions(reply);
      if (dbSuggestions.length) _lastSuggestions.set(sid, dbSuggestions); else _lastSuggestions.delete(sid);
      return res.json({ reply, sessionId: sid, mode: "db", sql: generatedSQL, rowCount: rows.length, cacheHit: false, queryLog: _reqQueryLog });

    } else if (useGPT) {
      // ── Pre-intercept analytics queries — same as Claude mode.
      //    GPT-4o ignores system prompt instructions to use get_sales_analysis
      //    and keeps calling query_sml_view which fails. Route deterministically.
      const GPT_ANALYTICS_ACTIONS = new Set([
        "sales_analysis", "purchase_analysis", "kpi", "ar_aging", "ap_aging",
        "open_orders", "open_quotations", "smlsvc",
      ]);

      const gptMessage = message;

      const gptIntent = detectIntent(gptMessage);
      const isKnownAnalytics = gptIntent && GPT_ANALYTICS_ACTIONS.has(gptIntent.action);
      console.log(`[GPT-PRE-INTERCEPT] msg="${gptMessage.slice(0,60)}" intent=${JSON.stringify(gptIntent)} knownAnalytics=${isKnownAnalytics}`);

      if (gptIntent && FORECAST_ACTIONS.has(gptIntent.action)) {
        // Forecasting needs the real statistical engine, never AI-generated SQL —
        // a SELECT query can't extrapolate a trend. Always route to demoReply,
        // which calls runForecastCore and opens the real Forecast dashboard.
        console.log(`[GPT-PRE-INTERCEPT] routing to demoReply (forecast, action=${gptIntent.action})`);
        const result = await demoReply(gptMessage);
        if (typeof result === "object" && result.text) { reply = result.text; openForm = result.openForm; openForecastDashboard = result.openForecastDashboard; forecastData = result.forecastData; openRushDashboard = result.openRushDashboard; rushData = result.rushData; }
        else reply = result;
      } else {
        let dbResult = null, hanaAttemptError = null;
        if (isKnownAnalytics && isConnected()) {
          // Confidently classified analytics question — answer immediately via direct
          // HANA/MSSQL (no Service Layer row cap). Understands the request first
          // (intent classification + schema-focused SQL generation + lint/retry)
          // before ever querying — never a blind guess.
          try {
            const { sql: genSql, rows, dbType, presentation } = await generateAndRunDirectSql(gptMessage);
            const payload = { rows: rows.slice(0, 500), sql: genSql, source: `HANA Direct (GPT-4o) · ${dbType.toUpperCase()}`, rowCount: rows.length, question: gptMessage, displayMode: presentation || (isSummaryStyleQuestion(gptMessage) ? "chart" : "table") };
            dbResult = rows.length
              ? `__ATBL__${JSON.stringify(payload)}__/ATBL__${buildDirectSqlWrapup(gptMessage, rows)}`
              : `✅ **Query executed — no records found**\n\n\`\`\`sql\n${genSql}\n\`\`\``;
            if (rows.length && isExcelExportRequest(gptMessage)) {
              const excelUrl = await generateExcelExport(gptMessage, rows);
              dbResult += `\n\n📥 **[Download Excel (${rows.length} rows)](${excelUrl})**`;
            }
            _logQ({ method: 'SQL', endpoint: 'Direct DB Query (GPT-4o preferred)', sql: genSql, rows: rows.length });
            console.log(`[GPT-PRE-INTERCEPT] routing to HANA direct SQL`);
          } catch (dbErr) {
            hanaAttemptError = dbErr.message;
            console.warn(`[GPT-PRE-INTERCEPT] HANA direct attempt failed, falling back: ${dbErr.message}`);
          }
        }

        if (dbResult) {
          reply = dbResult;
        } else if (isKnownAnalytics) {
          // Known analytics intent but no DB connection / SQL attempt failed — fall
          // back to the deterministic Service-Layer-backed NLP path, as before.
          console.log(`[GPT-PRE-INTERCEPT] routing to demoReply (action=${gptIntent.action})`);
          const result = await demoReply(gptMessage);
          if (typeof result === "object" && result.text) { reply = result.text; openForm = result.openForm; openForecastDashboard = result.openForecastDashboard; forecastData = result.forecastData; openRushDashboard = result.openRushDashboard; rushData = result.rushData; }
          else reply = result;
          // If the Service-Layer/SMLSVC fallback ALSO failed, surface the earlier
          // HANA-direct error too — otherwise the user only ever sees the last
          // failure and wrongly concludes ODBC was never attempted at all.
          if (hanaAttemptError && typeof reply === "string" && /error/i.test(reply)) {
            reply += `\n\n<sub>⚠️ A direct HANA/ODBC query was tried first and also failed: ${hanaAttemptError}</sub>`;
          }
        } else {
          // Everything else — write/action requests, and any free-form/ambiguous
          // question — goes to the tool-calling agent. It understands the request
          // through natural conversation (asking a clarifying question itself when
          // genuinely ambiguous, per the system prompt), then calls query_hana_direct
          // (ODBC, no row cap) or a Service Layer tool as appropriate.
          console.log(`[GPT-PRE-INTERCEPT] falling through to GPT agent`);
          let msgs = sessions.get(sid) || [];
          msgs.push({ role: "user", content: gptMessage });
          const { text, messages } = await runGptAgentLoop(msgs);
          sessions.set(sid, messages);
          reply = text;
        }
      }

    } else if (useAI) {
      // ── Pre-intercept: route analytics queries through deterministic
      //    SMLSVC engine / direct HANA regardless of AI mode.  The AI agent loop
      //    does not know how to map Brand→CogsOcrCod and will fail on these.
      const ANALYTICS_ACTIONS = new Set([
        "sales_analysis", "purchase_analysis", "kpi", "ar_aging", "ap_aging",
        "open_orders", "open_quotations", "smlsvc",
      ]);

      const claudeMessage = message;

      const analyticsIntent = detectIntent(claudeMessage);
      const isKnownAnalytics = analyticsIntent && ANALYTICS_ACTIONS.has(analyticsIntent.action);
      console.log(`[PRE-INTERCEPT] msg="${claudeMessage.slice(0,60)}" intent=${JSON.stringify(analyticsIntent)} knownAnalytics=${isKnownAnalytics}`);

      if (analyticsIntent && FORECAST_ACTIONS.has(analyticsIntent.action)) {
        console.log(`[PRE-INTERCEPT] routing to demoReply (forecast, action=${analyticsIntent.action})`);
        const result = await demoReply(claudeMessage);
        if (typeof result === "object" && result.text) { reply = result.text; openForm = result.openForm; openForecastDashboard = result.openForecastDashboard; forecastData = result.forecastData; openRushDashboard = result.openRushDashboard; rushData = result.rushData; }
        else reply = result;
      } else {
        let dbResult = null, hanaAttemptError = null;
        if (isKnownAnalytics && isConnected()) {
          // Confidently classified analytics question — answer immediately via direct
          // HANA/MSSQL (no Service Layer row cap). Understands the request first
          // (intent classification + schema-focused SQL generation + lint/retry)
          // before ever querying — never a blind guess.
          try {
            const { sql: genSql, rows, dbType, presentation } = await generateAndRunDirectSql(claudeMessage);
            const payload = { rows: rows.slice(0, 500), sql: genSql, source: `HANA Direct (Claude) · ${dbType.toUpperCase()}`, rowCount: rows.length, question: claudeMessage, displayMode: presentation || (isSummaryStyleQuestion(claudeMessage) ? "chart" : "table") };
            dbResult = rows.length
              ? `__ATBL__${JSON.stringify(payload)}__/ATBL__${buildDirectSqlWrapup(claudeMessage, rows)}`
              : `✅ **Query executed — no records found**\n\n\`\`\`sql\n${genSql}\n\`\`\``;
            if (rows.length && isExcelExportRequest(claudeMessage)) {
              const excelUrl = await generateExcelExport(claudeMessage, rows);
              dbResult += `\n\n📥 **[Download Excel (${rows.length} rows)](${excelUrl})**`;
            }
            _logQ({ method: 'SQL', endpoint: 'Direct DB Query (Claude preferred)', sql: genSql, rows: rows.length });
            console.log(`[PRE-INTERCEPT] routing to HANA direct SQL`);
          } catch (dbErr) {
            hanaAttemptError = dbErr.message;
            console.warn(`[PRE-INTERCEPT] HANA direct attempt failed, falling back: ${dbErr.message}`);
          }
        }

        if (dbResult) {
          reply = dbResult;
        } else if (isKnownAnalytics) {
          console.log(`[PRE-INTERCEPT] routing to demoReply (action=${analyticsIntent.action})`);
          const result = await demoReply(claudeMessage);
          if (typeof result === "object" && result.text) { reply = result.text; openForm = result.openForm; openForecastDashboard = result.openForecastDashboard; forecastData = result.forecastData; openRushDashboard = result.openRushDashboard; rushData = result.rushData; }
          else reply = result;
          if (hanaAttemptError && typeof reply === "string" && /error/i.test(reply)) {
            reply += `\n\n<sub>⚠️ A direct HANA/ODBC query was tried first and also failed: ${hanaAttemptError}</sub>`;
          }
        } else {
          // Everything else — write/action requests, and any free-form/ambiguous
          // question — goes to the tool-calling agent. It understands the request
          // through natural conversation (asking a clarifying question itself when
          // genuinely ambiguous, per the system prompt), then calls query_hana_direct
          // (ODBC, no row cap) or a Service Layer tool as appropriate.
          console.log(`[PRE-INTERCEPT] falling through to AI agent`);

          let msgs = sessions.get(sid) || [];
          msgs.push({ role:"user", content:claudeMessage });
          const { text, messages, toolCalls } = await runAgentLoop(msgs);
          sessions.set(sid, messages);
          reply = text;

          // ── Save tool calls to prompt cache ────────────────────────
          if (toolCalls && toolCalls.length > 0) {
            const norm = normPrompt(claudeMessage);
            for (const tc of toolCalls) {
              try {
                queryCacheRepo.upsert(norm, claudeMessage, tc.name, JSON.stringify(tc.input || {}), tc.preview || "");
              } catch {}
            }
          }
        }
      }

    } else {
      // ── Standard mode: check cache first ─────────────────────────
      const match = findCacheMatch(message);
      if (match) {
        const { row } = match;
        try {
          const params = JSON.parse(row.tool_params || "{}");
          const r = await callTool(row.tool_name, params);
          const raw = typeof r === "string" ? r : JSON.stringify(r, null, 2);
          reply = `📋 **Cached Query** · *${row.tool_name}*\n\n${raw.slice(0, 4000)}`;
          cacheHit   = true;
          cacheSource = { id: row.id, tool: row.tool_name, prompt: row.prompt_orig };
          queryCacheRepo.incrementUsed.run(row.id);
        } catch (cacheErr) {
          // Cache hit but execution failed — fall through to demoReply
        }
      }

      if (!cacheHit) {
        const result = await demoReply(message);
        if (typeof result === "object" && result.text) { reply = result.text; openForm = result.openForm; openForecastDashboard = result.openForecastDashboard; forecastData = result.forecastData; openRushDashboard = result.openRushDashboard; rushData = result.rushData; }
        else reply = result;
      }
    }

    const mode = useGPT ? "gpt4o" : useAI ? "ai" : "standard";
    const suggestions = extractSuggestions(reply);
    if (suggestions.length) _lastSuggestions.set(sid, suggestions); else _lastSuggestions.delete(sid);
    res.json({ reply, sessionId: sid, mode, cacheHit, cacheSource, queryLog: _reqQueryLog, ...(openForm ? { openForm } : {}), ...(openForecastDashboard ? { openForecastDashboard: true, forecastData } : {}), ...(openRushDashboard ? { openRushDashboard: true, rushData } : {}) });
  } catch(err) {
    console.error(err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/reset", (req,res) => { sessions.delete(req.body.sessionId); res.json({ok:true}); });

// ── Analytics AI summary ──────────────────────────────────────────────────────
app.post("/api/summarize", requireAuth, async (req, res) => {
  const { rows = [], question = '', source = '' } = req.body;
  if (!rows.length) return res.json({ summary: 'No data to summarize.' });

  const cols    = Object.keys(rows[0]);
  // Send up to 60 rows as a compact TSV so the AI gets real data, not just 15
  const preview = [cols.join('\t'), ...rows.slice(0, 60).map(r => cols.map(c => r[c] ?? '').join('\t'))].join('\n');
  const prompt  =
    `You are a senior SAP Business One data analyst. Summarize the query results below in 4-6 bullet points.\n` +
    `Rules: be specific with numbers, highlight the highest/lowest values, mention trends if visible, keep each bullet under 25 words.\n\n` +
    `Query: "${question}"\nSource: ${source} | Total rows: ${rows.length}\n\n` +
    `Data (up to 60 rows, tab-separated):\n${preview}`;

  try {
    let summary = '';
    const model = process.env.AZURE_CLAUDE_MODEL || 'claude-sonnet-4-6';

    if (AI_PROVIDER === 'gpt' && GPT_AVAILABLE) {
      // Azure GPT-4o
      const r = await fetch(process.env.AZURE_GPT_ENDPOINT, {
        method: 'POST',
        headers: { 'api-key': process.env.AZURE_OPENAI_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: prompt }], max_tokens: 600 })
      });
      if (!r.ok) throw new Error(`GPT HTTP ${r.status}: ${await r.text()}`);
      const d = await r.json();
      summary = d.choices?.[0]?.message?.content || '';

    } else if (AI_PROVIDER === 'azure' && process.env.AZURE_OPENAI_ENDPOINT) {
      // Azure Claude
      const endpoint = process.env.AZURE_OPENAI_ENDPOINT.replace(/\/$/, '');
      const r = await fetch(`${endpoint}/openai/deployments/${model}/chat/completions?api-version=2024-02-15-preview`, {
        method: 'POST',
        headers: { 'api-key': process.env.AZURE_OPENAI_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: prompt }], max_tokens: 600 })
      });
      if (!r.ok) throw new Error(`Azure Claude HTTP ${r.status}: ${await r.text()}`);
      const d = await r.json();
      summary = d.choices?.[0]?.message?.content || '';

    } else if (process.env.ANTHROPIC_API_KEY) {
      // Direct Anthropic
      const { default: Anthropic } = await import('@anthropic-ai/sdk');
      const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      const msg = await client.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 600,
        messages: [{ role: 'user', content: prompt }]
      });
      summary = msg.content?.[0]?.text || '';

    } else {
      // No AI — return basic stats
      const numCols = cols.filter(c => rows.slice(0, 5).every(r => !isNaN(parseFloat(r[c]))));
      const stats = numCols.slice(0, 4).map(c => {
        const vals = rows.map(r => parseFloat(r[c]) || 0);
        const sum  = vals.reduce((a, b) => a + b, 0);
        const max  = Math.max(...vals);
        return `- **${c}**: Total ${sum.toLocaleString(undefined,{maximumFractionDigits:2})}, Max ${max.toLocaleString(undefined,{maximumFractionDigits:2})}`;
      }).join('\n');
      summary = `**${rows.length} rows** from ${source}.\n\nKey metrics:\n${stats || '- No numeric columns detected.'}\n\n_Connect an AI provider (Anthropic/Azure) for intelligent summaries._`;
    }

    res.json({ summary: summary.trim() });
  } catch (e) {
    console.error('[summarize]', e.message);
    res.status(500).json({ error: e.message });
  }
});
app.get("/api/tools",  (_,res) => res.json({ tools: mcpTools.map(t=>({name:t.name,description:t.description})), aiAvailable: USE_AI, aiProvider: AI_PROVIDER, gptAvailable: GPT_AVAILABLE }));

// ── Query cache (prompt library) ──────────────────────────────────────────────
app.get("/api/query-cache", requireAuth, (_req, res) => {
  res.json(queryCacheRepo.list.all());
});
app.delete("/api/query-cache/:id", requireAuth, (req, res) => {
  queryCacheRepo.delete.run(Number(req.params.id));
  res.json({ ok: true });
});
app.delete("/api/query-cache", requireAuth, (req, res) => {
  if (req.user.role !== "admin") return res.status(403).json({ error: "Admin only" });
  queryCacheRepo.clear.run();
  res.json({ ok: true });
});

// ── DB Direct connection API ──────────────────────────────────────────────────
app.get("/api/db-connections", requireAuth, (_req, res) => {
  try {
    res.json(dbConnRepo.list.all());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/db-connections", requireAuth, (req, res) => {
  if (req.user.role !== "admin") return res.status(403).json({ error: "Admin only" });
  const { name, db_type, host, port, database, schema_name, query_name, username, password, password_encrypted } = req.body;
  if (!name || !host || !database || !username || !password)
    return res.status(400).json({ error: "name, host, database, username and password are required" });
  try {
    const r = dbConnRepo.create(name, db_type||"mssql", host, port||null, database, schema_name||"", query_name||"", username, password, password_encrypted||false);
    res.json({ id: r.lastInsertRowid, ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put("/api/db-connections/:id", requireAuth, (req, res) => {
  if (req.user.role !== "admin") return res.status(403).json({ error: "Admin only" });
  const { name, db_type, host, port, database, schema_name, query_name, username, password, password_encrypted } = req.body;
  try {
    dbConnRepo.update(Number(req.params.id), name, db_type||"mssql", host, port||null, database, schema_name||"", query_name||"", username, password, password_encrypted||false);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/db-connections/:id/activate", requireAuth, async (req, res) => {
  if (req.user.role !== "admin") return res.status(403).json({ error: "Admin only" });
  try {
    const cfg = dbConnRepo.getById.get(Number(req.params.id));
    if (!cfg) return res.status(404).json({ error: "Not found" });
    await connectDB(cfg);
    dbConnRepo.activate(cfg.id);
    res.json({ ok: true, db_type: cfg.db_type, host: cfg.host });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/db-connections/test", requireAuth, async (req, res) => {
  const { db_type, host, port, database, schema_name, username, password } = req.body;
  try {
    await testDBConn({ db_type: db_type||"mssql", host, port, database, schema_name, username, password });
    res.json({ ok: true, message: "Connection successful" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete("/api/db-connections/:id", requireAuth, async (req, res) => {
  if (req.user.role !== "admin") return res.status(403).json({ error: "Admin only" });
  dbConnRepo.delete.run(Number(req.params.id));
  // Deleting the row alone doesn't touch the live connection already open in
  // memory — without this, the app keeps using it (and the AI keeps answering
  // with real DB data) even though the UI shows "No connections configured".
  // If nothing is active anymore, actually drop the live connection too.
  if (!dbConnRepo.getActive()) await disconnectDB();
  res.json({ ok: true, disconnected: !dbConnRepo.getActive() });
});

app.get("/api/db-connections/status", requireAuth, (_req, res) => {
  res.json({ connected: isConnected(), db_type: getActiveType(), config: getActiveConfig() ? { host: getActiveConfig().host, database: getActiveConfig().database, db_type: getActiveConfig().db_type } : null });
});

// ── Schema Registry ─────────────────────────────────────────────────────────
app.get("/api/schema-registry", requireAuth, (req, res) => {
  const company = req.query.company || connRepo.getActive()?.company || "";
  if (!company) return res.status(400).json({ error: "company required" });
  res.json(schemaRepo.listByCompany.all(company));
});

app.post("/api/schema-registry", requireAuth, (req, res) => {
  const { company, type, name, table_name, definition, description } = req.body;
  if (!company || !type || !name) return res.status(400).json({ error: "company, type, name required" });
  const info = schemaRepo.create(company, type, name, table_name, definition, description);
  invalidateContextCache(company);
  res.json({ id: info.lastInsertRowid, ok: true });
});

app.put("/api/schema-registry/:id", requireAuth, (req, res) => {
  const { type, name, table_name, definition, description } = req.body;
  if (!type || !name) return res.status(400).json({ error: "type and name required" });
  schemaRepo.update(Number(req.params.id), type, name, table_name, definition, description);
  // find company for cache invalidation
  const row = schemaRepo.getById.get(Number(req.params.id));
  if (row) invalidateContextCache(row.company);
  res.json({ ok: true });
});

app.delete("/api/schema-registry/:id", requireAuth, (req, res) => {
  const row = schemaRepo.getById.get(Number(req.params.id));
  schemaRepo.delete.run(Number(req.params.id));
  if (row) invalidateContextCache(row.company);
  res.json({ ok: true });
});

// ── Sync UDFs from live HANA/MSSQL database into schemaRepo ─────────────────
app.post("/api/schema-registry/sync-udfs", requireAuth, async (req, res) => {
  try {
    if (!isConnected()) {
      const saved = dbConnRepo.getActive();
      if (saved) await connectDB(saved);
      else return res.status(503).json({ error: "No DB connection active. Activate a DB connection first." });
    }
    const rows = await fetchRawUDFs();
    if (!rows.length) return res.json({ ok: true, synced: 0, message: "No UDFs found in CUFD table." });

    // Determine company from active connection
    const cfg = getActiveConfig();
    const company = cfg?.database || cfg?.schema_name || 'default';

    // Remove existing UDFs for this company, then insert fresh ones
    const existing = schemaRepo.listByCompany.all(company).filter(r => r.type === 'udf');
    for (const row of existing) schemaRepo.delete.run(row.id);

    for (const r of rows) {
      const typeLabel = r.type === 'C' ? 'varchar' : r.type === 'N' ? 'numeric' : r.type === 'D' ? 'date' : r.type === 'L' ? 'link' : r.type;
      const definition = `${typeLabel}${r.size > 0 ? '('+r.size+')' : ''}${r.validValues ? ' values:['+r.validValues+']' : ''}`;
      schemaRepo.create(company, 'udf', r.name, r.tableId, definition, r.descr || '');
    }

    invalidateContextCache(company);
    invalidateUDFCache();
    res.json({ ok: true, synced: rows.length, company, message: `Synced ${rows.length} UDF fields from ${company}.` });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── DB Execute (direct SQL — SELECT only) ────────────────────────────────────
app.post("/api/db-execute", requireAuth, async (req, res) => {
  const { sql: querySql } = req.body;
  if (!querySql) return res.status(400).json({ error: "sql is required" });
  try {
    const rows = await executeSQL(querySql);
    res.json({ ok: true, rows, count: rows.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Pre-defined Reports ───────────────────────────────────────────────────────
app.get("/api/reports", requireAuth, (_req, res) => {
  res.json({ categories: REPORT_CATEGORIES, reports: listReports() });
});

app.post("/api/reports/:id/run", requireAuth, async (req, res) => {
  const report = getReport(req.params.id);
  if (!report) return res.status(404).json({ error: `Unknown report: ${req.params.id}` });
  if (report.type !== 'sql') return res.status(400).json({ error: 'This report uses AI — send the prompt to the chat endpoint instead', prompt: report.prompt });

  if (!isConnected()) {
    const saved = dbConnRepo.getActive();
    if (saved) {
      try { await connectDB(saved); } catch (e) {
        return res.status(503).json({ error: `DB connection failed: ${e.message}` });
      }
    } else {
      return res.status(400).json({ error: 'No database connected. Activate a DB connection in Settings first.' });
    }
  }

  const cfg    = getActiveConfig();
  const schema = cfg?.schema_name || cfg?.database || '';
  if (!schema) return res.status(400).json({ error: 'No schema name found on active DB connection.' });

  try {
    const rows = await runReportSQL(req.params.id, schema, executeSQL);
    res.json({ ok: true, reportId: req.params.id, title: report.title, rows, count: rows.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── DB Schema Browser ─────────────────────────────────────────────────────────
app.get('/api/db/schema', requireAuth, async (req, res) => {
  if (!isConnected()) return res.status(400).json({ error: 'No database connected. Activate a DB connection in Settings first.' });
  try {
    const type = getActiveType();
    const cfg  = getActiveConfig();
    let rows;
    if (type === 'hana') {
      const schema = cfg.schema_name || cfg.database || 'SBO_DB';
      rows = await executeSQL(
        `SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE_NAME as DATA_TYPE,
                TO_VARCHAR(LENGTH) as MAX_LENGTH, IS_NULLABLE, TO_VARCHAR(POSITION) as ORDINAL_POSITION
         FROM SYS.TABLE_COLUMNS
         WHERE SCHEMA_NAME = '${schema.replace(/'/g,"''")}'
         ORDER BY TABLE_NAME, POSITION`
      );
    } else {
      rows = await executeSQL(
        `SELECT c.TABLE_NAME, c.COLUMN_NAME, c.DATA_TYPE,
                CAST(COALESCE(c.CHARACTER_MAXIMUM_LENGTH, c.NUMERIC_PRECISION, 0) AS VARCHAR(20)) AS MAX_LENGTH,
                c.IS_NULLABLE, c.ORDINAL_POSITION
         FROM INFORMATION_SCHEMA.COLUMNS c
         JOIN INFORMATION_SCHEMA.TABLES t
           ON c.TABLE_NAME = t.TABLE_NAME AND c.TABLE_SCHEMA = t.TABLE_SCHEMA
         WHERE t.TABLE_TYPE = 'BASE TABLE' AND t.TABLE_SCHEMA = 'dbo'
         ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION`
      );
    }
    const tablesMap = {};
    rows.forEach(r => {
      const tbl = r.TABLE_NAME;
      if (!tablesMap[tbl]) tablesMap[tbl] = { name: tbl, columns: [] };
      tablesMap[tbl].columns.push({
        name:     r.COLUMN_NAME,
        type:     r.DATA_TYPE,
        maxLen:   r.MAX_LENGTH,
        nullable: r.IS_NULLABLE === 'YES',
        pos:      Number(r.ORDINAL_POSITION),
      });
    });
    const tables = Object.values(tablesMap).sort((a, b) => a.name.localeCompare(b.name));
    res.json({ ok: true, tables, count: tables.length, db_type: type, database: cfg.database });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/db/preview/:tableName', requireAuth, async (req, res) => {
  if (!isConnected()) return res.status(400).json({ error: 'No database connected.' });
  const { tableName } = req.params;
  if (!/^[A-Za-z0-9_@#$]+$/.test(tableName)) return res.status(400).json({ error: 'Invalid table name' });
  try {
    const cfg  = getActiveConfig();
    const type = getActiveType();
    const tRef = tableRef(tableName, cfg);
    const sql  = type === 'hana' ? `SELECT * FROM ${tRef} LIMIT 10` : `SELECT TOP 10 * FROM ${tRef}`;
    const rows = await executeSQL(sql);
    res.json({ ok: true, rows, count: rows.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── SAP B1 UDT Creation ──
app.post("/api/sap/udt", requireAuth, async (req, res) => {
  try {
    const body = req.body || {};
    const { tableName, description, tableType } = body;
    const fields = Array.isArray(body.fields) ? body.fields : [];
    if (!tableName) return res.status(400).json({ error: "tableName is required" });
    const name = String(tableName).toUpperCase().replace(/[^A-Z0-9_]/g, "");
    if (!name || name.length > 15) return res.status(400).json({ error: "tableName must be 1–15 alphanumeric characters" });
    // 1. Create User Defined Table
    const udtPayload = {
      TableName: name,
      TableDescription: description || name,
      TableType: tableType || "bott_NoObject",
    };
    await getActiveSap().post("/UserTablesMD", udtPayload);

    // 2. Create fields (sequential — each depends on table existing)
    const createdFields = [];
    for (const f of fields) {
      if (!f.fieldName) continue;
      const fname = String(f.fieldName).toUpperCase().replace(/[^A-Z0-9_]/g, "").substring(0, 8);
      if (!fname) continue;
      const fieldPayload = {
        TableName: name,
        FieldName: fname,
        Description: f.description || fname,
        FieldType: f.fieldType || "db_Alpha",
        ...(f.fieldType === "db_Alpha" || !f.fieldType
          ? { EditSize: Math.min(Math.max(parseInt(f.size) || 50, 1), 254) }
          : {}),
      };
      await getActiveSap().post("/UserFieldsMD", fieldPayload);
      createdFields.push(fname);
    }

    res.json({
      ok: true,
      tableName: name,
      storedAs: `@${name}`,
      tableType: tableType || "bott_NoObject",
      fieldCount: createdFields.length,
      fields: createdFields,
    });
  } catch (e) {
    // SAP B1 error messages come inside e.message as JSON string
    let msg = e.message || "UDT creation failed";
    try {
      const inner = JSON.parse(msg.replace(/^SAP \d+: /, ""));
      msg = inner?.error?.message?.value || inner?.message || msg;
    } catch {}
    res.status(500).json({ error: msg });
  }
});

// ── Direct action (from forms) ──
app.post("/api/action", async (req, res) => {
  const { tool, args } = req.body;
  try {
    const data = await callTool(tool, args);
    const map = { create_sales_quotation:formatQuotation, create_sales_order:formatSalesOrder,
      create_delivery:formatDelivery, create_ar_invoice:formatInvoice,
      apply_incoming_payment:formatPayment, confirm_delivery_pod:formatPod,
      check_atp:formatAtp, get_customer_list:formatCustomers,
      get_total_stock:formatStock, get_collections_worklist:formatCollections,
      create_purchase_order:formatPurchaseOrder, create_goods_receipt_po:formatGrpo,
      create_ap_invoice:formatApInvoice, apply_outgoing_payment:formatOutgoingPayment };
    res.json({ result: data, formatted: (map[tool]||JSON.stringify)(data) });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Suggest APIs ──
app.get("/api/suggest/vendors", async (req, res) => {
  try {
    const q = (req.query.q || "").trim();
    let filter = "CardType eq 'cSupplier' and Frozen eq 'tNO'";
    if (q) {
      const e2 = esc(q.toUpperCase());
      filter += ` and (substringof('${esc(q)}',CardCode) or substringof('${esc(q)}',CardName) or substringof('${e2}',CardCode) or substringof('${e2}',CardName))`;
    }
    const d = await getActiveSap().get("/BusinessPartners", { $filter:filter, $select:"CardCode,CardName,City,Country,Phone1,EmailAddress", $top:20, $orderby:"CardName asc" });
    res.json(d.value || []);
  } catch(e) { res.status(500).json({ error:e.message }); }
});

app.get("/api/suggest/customers", async (req, res) => {
  try {
    const q = (req.query.q || "").trim();
    const companyId = connRepo.getActive()?.company || 'default';
    // Cache-first
    const cached = cacheRepo.searchBPs ? null : null; // use direct query below
    const rows = db.prepare(`SELECT CardCode,CardName,City,Country,Phone1,EmailAddress FROM cache_business_partners
      WHERE company_id=? AND CardType='cCustomer' AND Frozen='tNO'
      AND (CardCode LIKE ? OR CardName LIKE ?) ORDER BY CardName LIMIT 20`)
      .all(companyId, `%${q}%`, `%${q}%`);
    if (rows.length) return res.json(rows);
    // Fallback to live SAP
    let filter = "CardType eq 'cCustomer'";
    if (q) { const e2 = esc(q.toUpperCase()); filter += ` and (substringof('${esc(q)}',CardCode) or substringof('${esc(q)}',CardName) or substringof('${e2}',CardCode) or substringof('${e2}',CardName))`; }
    const d = await getActiveSap().get("/BusinessPartners", { $filter:filter, $select:"CardCode,CardName,City,Country,Phone1,EmailAddress", $top:20, $orderby:"CardName asc" });
    res.json(d.value || []);
  } catch(e) { res.status(500).json({ error:e.message }); }
});

app.get("/api/suggest/items", async (req, res) => {
  try {
    const q = (req.query.q || "").trim();
    const companyId = connRepo.getActive()?.company || 'default';
    // Cache-first
    const rows = db.prepare(`SELECT ItemCode,ItemName,ManageBatchNumbers,ManageSerialNumbers,SalesUnit,PurchaseUnit,SalesVATGroup
      FROM cache_items WHERE company_id=? AND Frozen='tNO'
      AND (ItemCode LIKE ? OR ItemName LIKE ?) ORDER BY ItemName LIMIT 20`)
      .all(companyId, `%${q}%`, `%${q}%`);
    if (rows.length) return res.json(rows);
    // Fallback to live SAP
    let filter = "ItemType eq 'itItems' and Frozen eq 'tNO'";
    if (q) filter += ` and (substringof('${esc(q)}',ItemCode) or substringof('${esc(q)}',ItemName))`;
    const d = await getActiveSap().get("/Items", { $filter:filter, $select:"ItemCode,ItemName,ManageBatchNumbers,ManageSerialNumbers,SalesUnit,PurchaseUnit,SalesVATGroup", $top:20, $orderby:"ItemName asc" });
    res.json(d.value || []);
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// ── Tax codes (VAT Groups) — cache-first ─────────────────────────────────────
app.get("/api/suggest/tax-codes", async (req, res) => {
  try {
    const companyId = connRepo.getActive()?.company || 'default';
    const cached = cacheRepo.getTaxCodes(companyId);
    if (cached.length) return res.json(cached.map(v=>({ Code:v.Code, Name:v.Name })));
    const d = await getActiveSap().get("/VatGroups", { $select:"Code,Name", $orderby:"Code asc", $top:100 });
    res.json((d.value||d||[]).map(v=>({ Code:v.Code, Name:v.Name })));
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// ── BP Addresses (Bill-To / Ship-To) ─────────────────────────────────────────
app.get("/api/suggest/bp-addresses", async (req, res) => {
  try {
    const cc = (req.query.cardCode||"").trim();
    if (!cc) return res.json([]);
    const bp = await getActiveSap().get(`/BusinessPartners('${esc(cc)}')`,
      { $select:"CardCode,CardName,BPAddresses" });
    res.json(bp.BPAddresses || []);
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// ── Sales Order direct create ─────────────────────────────────────────────────
app.post("/api/sales-orders", requireAuth, async (req, res) => {
  try {
    const sap = getActiveSap();
    const b   = req.body;
    const today = () => new Date().toISOString().slice(0,10)+'T00:00:00';
    const sapDate = s => s ? `${s}T00:00:00` : today();
    const payload = {
      CardCode:    b.cardCode,
      DocDate:     sapDate(b.docDate),
      DocDueDate:  sapDate(b.dueDate),
      NumAtCard:   b.reference || '',
      Comments:    b.comments  || '',
      ...(b.billToAddress ? {
        BillToState:    b.billToAddress.state   || '',
        BillToStreet:   b.billToAddress.street  || '',
        BillToCity:     b.billToAddress.city    || '',
        BillToZipCode:  b.billToAddress.zip     || '',
        BillToCountry:  b.billToAddress.country || '',
      } : {}),
      ...(b.shipToAddress ? {
        ShipToStreet:   b.shipToAddress.street  || '',
        ShipToCity:     b.shipToAddress.city    || '',
        ShipToZipCode:  b.shipToAddress.zip     || '',
        ShipToCountry:  b.shipToAddress.country || '',
      } : {}),
      DocumentLines: (b.lines || []).map(l => ({
        ItemCode:        l.itemCode,
        Quantity:        Number(l.qty)         || 1,
        UnitPrice:       l.unitPrice != null ? Number(l.unitPrice) : undefined,
        DiscountPercent: Number(l.discount)    || 0,
        VatGroup:        l.taxCode             || undefined,
        WarehouseCode:   l.warehouseCode       || undefined,
      })).filter(l => l.ItemCode),
    };
    const result = await sap.post('/Orders', payload);
    res.json({ ok:true, docEntry:result.DocEntry, docNum:result.DocNum });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// ── Forecast: detect available data years in this company ────────────────────
app.get("/api/forecast/data-years", requireAuth, async (req, res) => {
  const useHana = isConnected() && getActiveType() === 'hana';

  // Prefer direct HANA — one MIN/MAX query across ORDR/OINV/OPOR instead of six
  // Service Layer round trips, and immune to the Service Layer being down.
  if (useHana) {
    try {
      const cfg = getActiveConfig();
      const rows = await executeSQL(`
        SELECT MIN("DocDate") AS "MinDate", MAX("DocDate") AS "MaxDate" FROM (
          SELECT "DocDate" FROM ${tableRef('ORDR', cfg)}
          UNION ALL
          SELECT "DocDate" FROM ${tableRef('OINV', cfg)}
          UNION ALL
          SELECT "DocDate" FROM ${tableRef('OPOR', cfg)}
        )`);
      const minDate = rows[0]?.MinDate, maxDate = rows[0]?.MaxDate;
      if (minDate && maxDate) {
        const minY = new Date(minDate).getFullYear();
        const maxY = new Date(maxDate).getFullYear();
        const years = [];
        for (let y = maxY; y >= minY; y--) years.push(y);
        return res.json({ ok:true, years, minYear:minY, maxYear:maxY, source:'HANA Direct' });
      }
    } catch(e) {
      console.warn('[ForecastDataYears] HANA direct query failed, falling back to Service Layer:', e.message);
    }
  }

  try {
    const sap = getActiveSap();
    const [ordR, invR, poR] = await Promise.allSettled([
      sap.get("/Orders",        { $select:"DocDate", $orderby:"DocDate asc",  $top:1 }),
      sap.get("/Invoices",      { $select:"DocDate", $orderby:"DocDate asc",  $top:1 }),
      sap.get("/PurchaseOrders",{ $select:"DocDate", $orderby:"DocDate asc",  $top:1 }),
    ]);
    const [ordL, invL, poL] = await Promise.allSettled([
      sap.get("/Orders",        { $select:"DocDate", $orderby:"DocDate desc", $top:1 }),
      sap.get("/Invoices",      { $select:"DocDate", $orderby:"DocDate desc", $top:1 }),
      sap.get("/PurchaseOrders",{ $select:"DocDate", $orderby:"DocDate desc", $top:1 }),
    ]);
    const dates = [
      ordR, invR, poR, ordL, invL, poL
    ].filter(r=>r.status==='fulfilled').flatMap(r=>r.value?.value||[]).map(d=>new Date(d.DocDate).getFullYear()).filter(y=>y>1990&&y<=new Date().getFullYear()+1);
    const minY = dates.length ? Math.min(...dates) : new Date().getFullYear();
    const maxY = dates.length ? Math.max(...dates) : new Date().getFullYear();
    const years = [];
    for (let y = maxY; y >= minY; y--) years.push(y);
    res.json({ ok:true, years, minYear:minY, maxYear:maxY, source:'Service Layer' });
  } catch(e) { res.status(500).json({ ok:false, error:e.message, years:[new Date().getFullYear()] }); }
});

// ── B1 Forecast: monthly sales + supply for one item ──────────────────────────
app.get("/api/b1/item-monthly-data", requireAuth, async (req, res) => {
  try {
    const itemCode = (req.query.itemCode || "").trim();
    let   year     = parseInt(req.query.year) || new Date().getFullYear();
    if (!itemCode) return res.status(400).json({ error: "itemCode required" });

    const sap = getActiveSap();
    const useHana = isConnected() && getActiveType() === 'hana';

    // Helper: load one year's demand + supply for the item — direct HANA SQL.
    // Column mapping verified live against the HANA schema (see forecasting.mjs
    // fetchItemMasterHana comment for the OITM field-name notes):
    //   Invoices → OINV/INV1, Sales Orders (fallback) → ORDR/RDR1
    //   GoodsReceiptPO → OPDN/PDN1, Purchase Orders (fallback) → OPOR/POR1
    async function loadYearHana(y) {
      const cfg  = getActiveConfig();
      const from = `${y}-01-01`, to = `${y}-12-31`;
      const demand = Array(12).fill(0), supply = Array(12).fill(0);
      const esc2 = itemCode.replace(/'/g, "''");

      async function monthlyQty(hdrTable, lineTable) {
        const rows = await executeSQL(`
          SELECT MONTH(T0."DocDate") AS "M", SUM(T1."Quantity") AS "Qty"
          FROM ${tableRef(hdrTable, cfg)} T0
          INNER JOIN ${tableRef(lineTable, cfg)} T1 ON T0."DocEntry" = T1."DocEntry"
          WHERE T1."ItemCode" = '${esc2}' AND T0."DocDate" >= '${from}' AND T0."DocDate" <= '${to}'
          GROUP BY MONTH(T0."DocDate")`);
        const arr = Array(12).fill(0);
        for (const r of rows) arr[Number(r.M) - 1] = Number(r.Qty || 0);
        return arr;
      }

      const invDemand = await monthlyQty('OINV', 'INV1');
      let demandArr = invDemand;
      if (invDemand.reduce((s, v) => s + v, 0) === 0) {
        demandArr = await monthlyQty('ORDR', 'RDR1'); // Sales Orders fallback
      }
      demandArr.forEach((v, i) => { demand[i] = v; });

      const grpoSupply = await monthlyQty('OPDN', 'PDN1');
      let supplyArr = grpoSupply;
      if (grpoSupply.reduce((s, v) => s + v, 0) === 0) {
        supplyArr = await monthlyQty('OPOR', 'POR1'); // open Purchase Orders fallback
      }
      supplyArr.forEach((v, i) => { supply[i] = v; });

      const total = demand.reduce((s, v) => s + v, 0) + supply.reduce((s, v) => s + v, 0);
      return { demand, supply, total };
    }

    // Helper: load one year's demand + supply for the item — Service Layer.
    async function loadYear(y) {
      const from = `${y}-01-01`, to = `${y}-12-31`;
      const demand = Array(12).fill(0), supply = Array(12).fill(0);
      let invoiceDemand = 0;
      try {
        const inv  = await sap.get("/Invoices", { $select:"DocEntry,DocDate", $filter:`DocDate ge '${from}' and DocDate le '${to}'`, $top:2000 });
        const docs = await fdLoadDocumentLines(sap, "Invoices", inv.value||[], itemCode);
        for (const doc of docs) {
          const lines = fdDocLinesForItem(doc, itemCode);
          if (!lines.length) continue;
          demand[new Date(doc.DocDate).getMonth()] += lines.reduce((s,l)=>s+fdLineQty(l),0);
        }
        invoiceDemand = demand.reduce((s,v)=>s+v,0);
      } catch(e) { console.log(`[B1Forecast] Invoices ${y}:`, e.message); }
      // Fallback: use Sales Orders as demand proxy when no AR Invoices exist
      if (invoiceDemand === 0) {
        try {
          const ords = await sap.get("/Orders", { $select:"DocEntry,DocDate", $filter:`DocDate ge '${from}' and DocDate le '${to}'`, $top:2000 });
          const docs = await fdLoadDocumentLines(sap, "Orders", ords.value||[], itemCode);
          for (const doc of docs) {
            const lines = fdDocLinesForItem(doc, itemCode);
            if (!lines.length) continue;
            demand[new Date(doc.DocDate).getMonth()] += lines.reduce((s,l)=>s+fdLineQty(l),0);
          }
        } catch(e) { console.log(`[B1Forecast] Orders fallback ${y}:`, e.message); }
      }
      try {
        const grpo = await sap.get("/GoodsReceiptsPO", { $select:"DocEntry,DocDate", $filter:`DocDate ge '${from}' and DocDate le '${to}'`, $top:2000 });
        const docs = await fdLoadDocumentLines(sap, "GoodsReceiptsPO", grpo.value||[], itemCode);
        for (const doc of docs) {
          const lines = fdDocLinesForItem(doc, itemCode);
          if (!lines.length) continue;
          supply[new Date(doc.DocDate).getMonth()] += lines.reduce((s,l)=>s+fdLineQty(l),0);
        }
      } catch(e) { console.log(`[B1Forecast] GRPO ${y}:`, e.message); }
      // Fallback: use open POs as supply proxy when no GRPOs exist
      const supplyTotal = supply.reduce((s,v)=>s+v,0);
      if (supplyTotal === 0) {
        try {
          const pos = await sap.get("/PurchaseOrders", { $select:"DocEntry,DocDate,TaxDate", $filter:`DocDate ge '${from}' and DocDate le '${to}'`, $top:2000 });
          const docs = await fdLoadDocumentLines(sap, "PurchaseOrders", pos.value||[], itemCode);
          for (const doc of docs) {
            const lines = fdDocLinesForItem(doc, itemCode);
            if (!lines.length) continue;
            supply[new Date(doc.TaxDate||doc.DocDate).getMonth()] += lines.reduce((s,l)=>s+fdLineQty(l),0);
          }
        } catch(e) { console.log(`[B1Forecast] PO fallback ${y}:`, e.message); }
      }
      const total = demand.reduce((s,v)=>s+v,0) + supply.reduce((s,v)=>s+v,0);
      return { demand, supply, total };
    }

    // Prefer direct HANA ODBC when connected for this company — falls back to
    // Service Layer on any failure (SAP outage, wrong item code, etc).
    async function loadYearPreferHana(y) {
      if (useHana) {
        try {
          const r = await loadYearHana(y);
          if (r.total > 0) return r;
        } catch (e) {
          console.warn(`[B1Forecast] HANA direct query failed for ${y}, falling back to Service Layer:`, e.message);
        }
      }
      return loadYear(y);
    }

    let { demand, supply, total } = await loadYearPreferHana(year);

    // If requested year has no data, scan backwards up to 15 years to find data
    if (total === 0) {
      for (let offset = 1; offset <= 15; offset++) {
        const tryYear = year - offset;
        if (tryYear < 1990) break;
        const result = await loadYearPreferHana(tryYear);
        if (result.total > 0) {
          ({ demand, supply, total } = result);
          year = tryYear;
          break;
        }
      }
    }

    // Item details — HANA direct first, Service Layer fallback
    let itemName = itemCode, onHand = 0;
    let gotItemInfo = false;
    if (useHana) {
      try {
        const cfg  = getActiveConfig();
        const esc2 = itemCode.replace(/'/g, "''");
        const rows = await executeSQL(`SELECT "ItemCode","ItemName","OnHand" FROM ${tableRef('OITM', cfg)} WHERE "ItemCode" = '${esc2}'`);
        if (rows[0]) {
          itemName = rows[0].ItemName || itemCode;
          onHand   = Number(rows[0].OnHand || 0);
          gotItemInfo = true;
        }
      } catch (e) { console.warn('[B1Forecast] HANA direct item-info failed, falling back to Service Layer:', e.message); }
    }
    if (!gotItemInfo) {
      try {
        const it = await sap.get(`/Items('${itemCode}')`, { $select:"ItemCode,ItemName,QuantityOnStock" });
        itemName = it.ItemName || itemCode;
        onHand   = Number(it.QuantityOnStock || 0);
      } catch { /* non-fatal */ }
    }

    res.json({ demand, supply, itemCode, itemName, onHand, year, dataYear: year });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Forecast Dashboard: Item master data ─────────────────────────────────────
const fdLineItemMatches = (line, itemCode) => !itemCode || String(line?.ItemCode || "").toLowerCase() === String(itemCode).toLowerCase();
const fdLineOpenQty = (line) => {
  const remaining = line?.RemainingOpenQuantity ?? line?.OpenQuantity;
  return Number(remaining ?? line?.Quantity ?? 0);
};
const fdLineQty = (line) => Number(line?.Quantity ?? fdLineOpenQty(line) ?? 0);
const fdLineAmount = (line) => {
  const amount = line?.LineTotal;
  if (amount != null) return Number(amount || 0);
  return Number(line?.Price || 0) * fdLineQty(line);
};
const fdDocLinesForItem = (doc, itemCode) =>
  (doc?.DocumentLines || []).filter(line => line?.LineStatus !== "bost_Close" && fdLineItemMatches(line, itemCode));
const fdLineRows = (lines) => lines.map(line => ({
  itemCode: line.ItemCode,
  description: line.ItemDescription,
  quantity: fdLineQty(line),
  openQty: fdLineOpenQty(line),
  unitPrice: Number(line.Price || 0),
  lineTotal: fdLineAmount(line),
  shipDate: line.ShipDate?.slice?.(0, 10) || null,
}));
const fdLoadDocumentLines = async (sap, entity, docs, itemCode) => {
  const rows = Array.isArray(docs) ? docs : [];
  if (!itemCode) return rows;
  const loaded = [];
  const concurrency = 8;
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, rows.length) }, async () => {
    while (next < rows.length) {
      const idx = next++;
      const doc = rows[idx];
    try {
      const full = await sap.get(`/${entity}(${doc.DocEntry})`);
        loaded[idx] = { ...doc, DocumentLines: full.DocumentLines || [] };
    } catch {
        loaded[idx] = { ...doc, DocumentLines: [] };
    }
    }
  });
  await Promise.all(workers);
  return loaded;
};

// ── HANA direct: fetch document headers + lines for one marketing-document
// family (Sales Orders/ORDR+RDR1, Purchase Orders/OPOR+POR1, Invoices/OINV+INV1,
// GoodsReceiptPO/OPDN+PDN1 — same base schema across all of them). Returns docs
// shaped exactly like `fdLoadDocumentLines`'s output so downstream code (which
// uses fdDocLinesForItem/fdLineQty/fdLineOpenQty/fdLineAmount/fdLineRows) needs
// no changes regardless of which data source served the request.
// Column mapping verified live against the schema:
//   DocumentStatus eq 'bost_Open' → DocStatus = 'O'   (line-level: LineStatus != 'C')
//   DocCurrency → DocCur, PaymentGroupCode → GroupNum, DownPayment → DpmAmnt
//   RemainingOpenQuantity → OpenQty, WarehouseCode → WhsCode
async function fdFetchDocsWithLinesHana({ hdrTable, lineTable, itemCode, from, to, openOnly = true, top = 500 }) {
  const cfg = getActiveConfig();
  const hdr = tableRef(hdrTable, cfg);
  const lin = tableRef(lineTable, cfg);
  const esc2 = (itemCode || '').replace(/'/g, "''");

  const conds = [];
  if (openOnly) conds.push(`T0."DocStatus" = 'O'`);
  if (!itemCode && from && to) conds.push(`T0."DocDate" >= '${from}' AND T0."DocDate" <= '${to}'`);
  if (itemCode) conds.push(`EXISTS (SELECT 1 FROM ${lin} TX WHERE TX."DocEntry" = T0."DocEntry" AND TX."ItemCode" = '${esc2}' AND TX."LineStatus" != 'C')`);
  const where = conds.length ? conds.join(' AND ') : '1=1';

  const headers = await executeSQL(`
    SELECT TOP ${parseInt(top, 10) || 500} T0."DocEntry" AS "DocEntry", T0."DocNum" AS "DocNum",
           T0."CardCode" AS "CardCode", T0."CardName" AS "CardName", T0."DocDate" AS "DocDate",
           T0."TaxDate" AS "TaxDate", T0."DocDueDate" AS "DocDueDate", T0."DocTotal" AS "DocTotal",
           T0."DocCur" AS "DocCur", T0."GroupNum" AS "GroupNum", T0."NumAtCard" AS "NumAtCard",
           T0."Comments" AS "Comments", T0."DpmAmnt" AS "DpmAmnt"
    FROM ${hdr} T0 WHERE ${where} ORDER BY T0."DocDate" DESC`);
  if (!headers.length) return [];

  const entries = headers.map(h => h.DocEntry).join(',');
  const lineWhere = itemCode
    ? `"DocEntry" IN (${entries}) AND "ItemCode" = '${esc2}' AND "LineStatus" != 'C'`
    : `"DocEntry" IN (${entries}) AND "LineStatus" != 'C'`;
  const lines = await executeSQL(`
    SELECT "DocEntry","ItemCode","Dscription","Quantity","OpenQty","Price","LineTotal","WhsCode","ShipDate"
    FROM ${lin} WHERE ${lineWhere}`);

  const byEntry = new Map();
  for (const l of lines) {
    if (!byEntry.has(l.DocEntry)) byEntry.set(l.DocEntry, []);
    byEntry.get(l.DocEntry).push({
      ItemCode: l.ItemCode, ItemDescription: l.Dscription,
      Quantity: Number(l.Quantity || 0), RemainingOpenQuantity: Number(l.OpenQty || 0),
      Price: Number(l.Price || 0), LineTotal: Number(l.LineTotal || 0),
      WarehouseCode: l.WhsCode, ShipDate: l.ShipDate, LineStatus: 'bost_Open',
    });
  }

  return headers.map(h => ({
    DocEntry: h.DocEntry, DocNum: h.DocNum, CardCode: h.CardCode, CardName: h.CardName,
    DocDate: h.DocDate, TaxDate: h.TaxDate, DocDueDate: h.DocDueDate,
    DocTotal: Number(h.DocTotal || 0), DocCurrency: h.DocCur,
    PaymentGroupCode: h.GroupNum, NumAtCard: h.NumAtCard, Comments: h.Comments,
    DownPayment: Number(h.DpmAmnt || 0),
    DocumentLines: byEntry.get(h.DocEntry) || [],
  }));
}
// Shared helper: try the HANA path, fall back to the Service-Layer loader (via
// `slLoader`, a thunk returning the doc array) on any failure or when not connected.
async function fdLoadDocsPreferHana(hanaOpts, slLoader) {
  if (isConnected() && getActiveType() === 'hana') {
    try {
      const docs = await fdFetchDocsWithLinesHana(hanaOpts);
      return { docs, source: 'hana' };
    } catch (e) {
      console.warn(`[ForecastDashboard] HANA direct query failed for ${hanaOpts.hdrTable}, falling back to Service Layer:`, e.message);
    }
  }
  return { docs: await slLoader(), source: 'service-layer' };
}

app.get("/api/forecast/item-info", requireAuth, async (req, res) => {
  try {
    const itemCode = (req.query.itemCode || "").trim();
    if (!itemCode) return res.status(400).json({ ok: false, error: "itemCode required" });

    // Prefer direct HANA — column mapping verified live against OITM:
    //   QuantityOnStock→OnHand, QuantityOrderedByCustomers→IsCommited,
    //   QuantityOrderedFromVendors→OnOrder, MinInventory→MinLevel, MaxInventory→MaxLevel,
    //   InventoryUOM→InvntryUom, Mainsupplier→CardCode, PurchaseItem/SalesItem→PrchseItem/SellItem ('Y')
    if (isConnected() && getActiveType() === 'hana') {
      try {
        const cfg  = getActiveConfig();
        const esc2 = itemCode.replace(/'/g, "''");
        const rows = await executeSQL(`
          SELECT "ItemCode","ItemName","OnHand","IsCommited","OnOrder","MinLevel","MaxLevel",
                 "InvntryUom","LeadTime","CardCode","PrchseItem","SellItem"
          FROM ${tableRef('OITM', cfg)} WHERE "ItemCode" = '${esc2}'`);
        const it = rows[0];
        if (it) {
          const onHand    = Number(it.OnHand || 0);
          const committed = Number(it.IsCommited || 0);
          const onOrder   = Number(it.OnOrder || 0);
          return res.json({ ok: true, item: {
            code: it.ItemCode, name: it.ItemName,
            onHand, committed, onOrder, available: onHand - committed,
            minStock: Number(it.MinLevel || 0), maxStock: Number(it.MaxLevel || 0),
            uom: it.InvntryUom || 'EA',
            leadTime: it.LeadTime || null,
            preferredVendor: it.CardCode || null,
            isPurchase: it.PrchseItem === 'Y', isSales: it.SellItem === 'Y',
          }});
        }
      } catch (e) { console.warn('[ForecastDashboard] HANA direct item-info failed, falling back to Service Layer:', e.message); }
    }

    const sap = getActiveSap();
    let it = null;
    try {
      it = await sap.get(`/Items('${esc(itemCode)}')`, {
        $select: "ItemCode,ItemName,QuantityOnStock,QuantityOrderedByCustomers,QuantityOrderedFromVendors,MinInventory,MaxInventory,PurchaseItem,SalesItem,LeadTime,InventoryUOM,Mainsupplier",
      });
    } catch {
      const r = await sap.get("/Items", {
        $filter: `ItemCode eq '${esc(itemCode)}'`,
        $select: "ItemCode,ItemName,QuantityOnStock,QuantityOrderedByCustomers,QuantityOrderedFromVendors,MinInventory,MaxInventory,PurchaseItem,SalesItem,LeadTime,InventoryUOM,Mainsupplier",
        $top: 1,
      });
      it = r.value?.[0] || null;
    }
    if (!it) return res.status(404).json({ ok: false, error: `Item ${itemCode} not found` });
    const onHand   = Number(it.QuantityOnStock || it.OnHand || 0);
    const committed= Number(it.QuantityOrderedByCustomers || 0);
    const onOrder  = Number(it.QuantityOrderedFromVendors || it.QuantityOrderedByVendors || 0);
    const available= onHand - committed;
    res.json({ ok: true, item: {
      code: it.ItemCode, name: it.ItemName,
      onHand, committed, onOrder, available,
      minStock: Number(it.MinInventory || 0), maxStock: Number(it.MaxInventory || 0),
      uom: it.InventoryUOM || it.InventoryUoM || it.BuyUnitMsr || 'EA',
      leadTime: it.LeadTime || null,
      preferredVendor: it.Mainsupplier || null,
      isPurchase: it.PurchaseItem === 'tYES', isSales: it.SalesItem === 'tYES',
    }});
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── Forecast Dashboard: Open Purchase Orders with delivery/lead/advance data ──
app.get("/api/forecast/open-pos", requireAuth, async (req, res) => {
  try {
    const year = parseInt(req.query.year) || new Date().getFullYear();
    const itemCode = (req.query.itemCode || "").trim();
    const from = `${year}-01-01`, to = `${year}-12-31`;
    const sap = getActiveSap();
    const { docs: pos } = await fdLoadDocsPreferHana(
      { hdrTable: 'OPOR', lineTable: 'POR1', itemCode, from, to, openOnly: true, top: itemCode ? 500 : 300 },
      async () => {
        const poData = itemCode
          ? await sap.get("/PurchaseOrders", {
              $filter: `DocumentStatus eq 'bost_Open'`,
              $select: "DocEntry,DocNum,CardCode,CardName,DocDate,TaxDate,DocDueDate,DocTotal,DocCurrency,PaymentGroupCode,NumAtCard,Comments,DownPayment",
              $orderby: "DocDate desc", $top: 500,
            })
          : await sap.get("/PurchaseOrders", {
              $filter: `DocumentStatus eq 'bost_Open' and DocDate ge '${from}' and DocDate le '${to}'`,
              $select: "DocEntry,DocNum,CardCode,CardName,DocDate,TaxDate,DocDueDate,DocTotal,DocCurrency,PaymentGroupCode,NumAtCard,Comments,DownPayment",
              $orderby: "DocDate desc", $top: 300,
            });
        return fdLoadDocumentLines(sap, "PurchaseOrders", poData.value || [], itemCode);
      },
    );
    // Advance payments per vendor
    let advMap = new Map();
    try {
      const dp = await sap.get("/PurchaseDownPayments", {
        $filter: "DocumentStatus eq 'bost_Open'",
        $select: "DocNum,CardCode,DocTotal,Remarks", $top: 300,
      });
      for (const a of (dp.value || [])) {
        if (!advMap.has(a.CardCode)) advMap.set(a.CardCode, { amount: 0, refs: [] });
        advMap.get(a.CardCode).amount += Number(a.DocTotal || 0);
        advMap.get(a.CardCode).refs.push(String(a.DocNum));
      }
    } catch { /* non-fatal */ }

    const result = pos.map(po => {
      const matchedLines = fdDocLinesForItem(po, itemCode);
      if (itemCode && !matchedLines.length) return null;
      const delivDate = po.TaxDate || po.DocDueDate;
      const leadDays = delivDate && po.DocDate
        ? Math.round((new Date(delivDate) - new Date(po.DocDate)) / 86400000) : null;
      const adv = advMap.get(po.CardCode) || { amount: 0, refs: [] };
      const lineTotal = matchedLines.reduce((sum, line) => sum + fdLineAmount(line), 0);
      const docTotal = itemCode ? lineTotal : Number(po.DocTotal || 0);
      return {
        docEntry: po.DocEntry, docNum: po.DocNum,
        vendorCode: po.CardCode, vendorName: po.CardName,
        docDate: po.DocDate?.slice(0,10), deliveryDate: delivDate?.slice(0,10),
        dueDate: po.DocDueDate?.slice(0,10),
        docTotal, currency: po.DocCurrency, leadDays,
        month: new Date(po.DocDate).getMonth(),
        paymentCode: po.PaymentGroupCode, vendorRef: po.NumAtCard,
        advanceAmount: adv.amount,
        advancePct: docTotal > 0 ? +((adv.amount / docTotal) * 100).toFixed(1) : 0,
        advanceStatus: adv.amount > 0 ? 'paid' : (Number(po.DownPayment || 0) > 0 ? 'required' : 'none'),
        advanceRef: adv.refs.join(', '),
        quantity: matchedLines.reduce((sum, line) => sum + fdLineQty(line), 0),
        openQty: matchedLines.reduce((sum, line) => sum + fdLineOpenQty(line), 0),
        lines: fdLineRows(itemCode ? matchedLines : (po.DocumentLines || [])),
      };
    }).filter(Boolean);
    res.json({ ok: true, pos: result, total: result.length });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── Forecast Dashboard: Open Sales Orders ────────────────────────────────────
app.get("/api/forecast/open-sos", requireAuth, async (req, res) => {
  try {
    const year = parseInt(req.query.year) || new Date().getFullYear();
    const itemCode = (req.query.itemCode || "").trim();
    const from = `${year}-01-01`, to = `${year}-12-31`;
    const sap = getActiveSap();

    const { docs: soRows } = await fdLoadDocsPreferHana(
      { hdrTable: 'ORDR', lineTable: 'RDR1', itemCode, from, to, openOnly: true, top: itemCode ? 500 : 300 },
      async () => {
        // For item-specific: fetch ALL open SOs (same approach as order-matrix — no date restriction)
        // The date filter causes SAP v1 to return different DocDate values vs the full document
        const soData = itemCode
          ? await sap.get("/Orders", {
              $filter: `DocumentStatus eq 'bost_Open'`,
              $select: "DocEntry,DocNum,CardCode,CardName,DocDate,DocDueDate,TaxDate,DocTotal,DocCurrency,NumAtCard",
              $orderby: "DocDate desc", $top: 500,
            })
          : await sap.get("/Orders", {
              $filter: `DocumentStatus eq 'bost_Open' and DocDate ge '${from}' and DocDate le '${to}'`,
              $select: "DocEntry,DocNum,CardCode,CardName,DocDate,DocDueDate,TaxDate,DocTotal,DocCurrency,NumAtCard",
              $orderby: "DocDate desc", $top: 300,
            });
        return fdLoadDocumentLines(sap, "Orders", soData.value || [], itemCode);
      },
    );
    const result = soRows.map(so => {
      const matchedLines = fdDocLinesForItem(so, itemCode);
      if (itemCode && !matchedLines.length) return null;
      return {
        docEntry: so.DocEntry, docNum: so.DocNum,
        customerCode: so.CardCode, customerName: so.CardName,
        docDate: so.DocDate?.slice(0,10),
        deliveryDate: (so.TaxDate || so.DocDueDate)?.slice(0,10),
        docTotal: itemCode ? matchedLines.reduce((sum, line) => sum + fdLineAmount(line), 0) : Number(so.DocTotal || 0),
        currency: so.DocCurrency,
        month: new Date(so.DocDate).getMonth(), customerRef: so.NumAtCard,
        quantity: matchedLines.reduce((sum, line) => sum + fdLineQty(line), 0),
        openQty: matchedLines.reduce((sum, line) => sum + fdLineOpenQty(line), 0),
        lines: fdLineRows(itemCode ? matchedLines : (so.DocumentLines || [])),
      };
    }).filter(Boolean);
    res.json({ ok: true, sos: result, total: result.length });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── Forecast Dashboard: Monthly Order Matrix (SO + PO) ───────────────────────
app.get("/api/forecast/order-matrix", requireAuth, async (req, res) => {
  try {
    const year = parseInt(req.query.year) || new Date().getFullYear();
    const itemCode = (req.query.itemCode || "").trim();
    const from = `${year}-01-01`, to = `${year}-12-31`;
    const sap = getActiveSap();
    // When itemCode specified: show all open docs (regardless of year) — item may be in old orders
    const soFilter = itemCode
      ? `DocumentStatus eq 'bost_Open'`
      : `DocumentStatus eq 'bost_Open' and DocDate ge '${from}' and DocDate le '${to}'`;
    const poFilter = itemCode
      ? `DocumentStatus eq 'bost_Open'`
      : `DocumentStatus eq 'bost_Open' and DocDate ge '${from}' and DocDate le '${to}'`;
    const MLBL = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const matrix = MLBL.map((label, i) => ({
      month: i, label,
      so: { count:0, qty:0, amount:0, docs:[] },
      po: { count:0, qty:0, amount:0, docs:[] },
    }));
    const [{ docs: soDocs }, { docs: poDocs }] = await Promise.all([
      fdLoadDocsPreferHana(
        { hdrTable: 'ORDR', lineTable: 'RDR1', itemCode, from, to, openOnly: true, top: 500 },
        async () => {
          const soR = await sap.get("/Orders", {
            $filter: soFilter,
            $select: "DocEntry,DocNum,CardCode,CardName,DocDate,DocDueDate,TaxDate,DocTotal,DocCurrency",
            $top: 500,
          }).catch(() => ({ value: [] }));
          return fdLoadDocumentLines(sap, "Orders", soR.value || [], itemCode);
        },
      ),
      fdLoadDocsPreferHana(
        { hdrTable: 'OPOR', lineTable: 'POR1', itemCode, from, to, openOnly: true, top: 500 },
        async () => {
          const poR = await sap.get("/PurchaseOrders", {
            $filter: poFilter,
            $select: "DocEntry,DocNum,CardCode,CardName,DocDate,DocDueDate,TaxDate,DocTotal,DocCurrency",
            $top: 500,
          }).catch(() => ({ value: [] }));
          return fdLoadDocumentLines(sap, "PurchaseOrders", poR.value || [], itemCode);
        },
      ),
    ]);
    for (const doc of soDocs) {
      const lines = fdDocLinesForItem(doc, itemCode);
      if (itemCode && !lines.length) continue;
      const qty = lines.reduce((sum, line) => sum + fdLineQty(line), 0);
      const amount = itemCode ? lines.reduce((sum, line) => sum + fdLineAmount(line), 0) : Number(doc.DocTotal||0);
      const m = new Date(doc.DocDate).getMonth();
      matrix[m].so.count++;
      matrix[m].so.qty += qty;
      matrix[m].so.amount += amount;
      matrix[m].so.docs.push({ docNum:doc.DocNum, docEntry:doc.DocEntry,
        cardCode:doc.CardCode, cardName:doc.CardName,
        docDate:doc.DocDate?.slice(0,10), dueDate:(doc.TaxDate||doc.DocDueDate)?.slice(0,10),
        total:amount, currency:doc.DocCurrency, qty, lines:fdLineRows(itemCode ? lines : (doc.DocumentLines || [])) });
    }
    for (const doc of poDocs) {
      const lines = fdDocLinesForItem(doc, itemCode);
      if (itemCode && !lines.length) continue;
      const qty = lines.reduce((sum, line) => sum + fdLineQty(line), 0);
      const amount = itemCode ? lines.reduce((sum, line) => sum + fdLineAmount(line), 0) : Number(doc.DocTotal||0);
      const m = new Date(doc.DocDate).getMonth();
      matrix[m].po.count++;
      matrix[m].po.qty += qty;
      matrix[m].po.amount += amount;
      matrix[m].po.docs.push({ docNum:doc.DocNum, docEntry:doc.DocEntry,
        cardCode:doc.CardCode, cardName:doc.CardName,
        docDate:doc.DocDate?.slice(0,10), dueDate:(doc.TaxDate||doc.DocDueDate)?.slice(0,10),
        total:amount, currency:doc.DocCurrency, qty, lines:fdLineRows(itemCode ? lines : (doc.DocumentLines || [])) });
    }
    res.json({ ok: true, year, itemCode: itemCode || "ALL", matrix });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── Forecast Dashboard: Supply vs Demand (monthly, by amount — no expand needed) ──
app.get("/api/forecast/supply-demand", requireAuth, async (req, res) => {
  try {
    let year = parseInt(req.query.year) || new Date().getFullYear();
    const itemCode = (req.query.itemCode || "").trim();
    const sap = getActiveSap();

    async function loadSD(y) {
      const from = `${y}-01-01`, to = `${y}-12-31`;
      const demand = Array(12).fill(0), supply = Array(12).fill(0), openPO = Array(12).fill(0);
      const [{ docs: invDocs }, { docs: grpoDocs }, { docs: poDocs }, { docs: soDocs }] = await Promise.all([
        fdLoadDocsPreferHana(
          { hdrTable: 'OINV', lineTable: 'INV1', itemCode, from, to, openOnly: false, top: 1000 },
          async () => {
            const r = await sap.get("/Invoices", { $filter:`DocDate ge '${from}' and DocDate le '${to}'`, $select:"DocEntry,DocDate,DocTotal", $top:1000 }).catch(() => ({ value: [] }));
            return fdLoadDocumentLines(sap, "Invoices", r.value || [], itemCode);
          },
        ),
        fdLoadDocsPreferHana(
          { hdrTable: 'OPDN', lineTable: 'PDN1', itemCode, from, to, openOnly: false, top: 1000 },
          async () => {
            const r = await sap.get("/GoodsReceiptsPO", { $filter:`DocDate ge '${from}' and DocDate le '${to}'`, $select:"DocEntry,DocDate,DocTotal", $top:1000 }).catch(() => ({ value: [] }));
            return fdLoadDocumentLines(sap, "GoodsReceiptsPO", r.value || [], itemCode);
          },
        ),
        fdLoadDocsPreferHana(
          // No date filter here — matches the Service Layer query below, which
          // pulls ALL currently-open POs regardless of year (open POs are still
          // "supply pipeline" even if raised in a prior year).
          { hdrTable: 'OPOR', lineTable: 'POR1', itemCode, openOnly: true, top: 500 },
          async () => {
            const r = await sap.get("/PurchaseOrders", { $filter:"DocumentStatus eq 'bost_Open'", $select:"DocEntry,TaxDate,DocDate,DocTotal", $top:500 }).catch(() => ({ value: [] }));
            return fdLoadDocumentLines(sap, "PurchaseOrders", r.value || [], itemCode);
          },
        ),
        fdLoadDocsPreferHana(
          { hdrTable: 'ORDR', lineTable: 'RDR1', itemCode, from, to, openOnly: false, top: 1000 },
          async () => {
            const r = await sap.get("/Orders", { $filter:`DocDate ge '${from}' and DocDate le '${to}'`, $select:"DocEntry,DocDate,DocTotal", $top:1000 }).catch(() => ({ value: [] }));
            return fdLoadDocumentLines(sap, "Orders", r.value || [], itemCode);
          },
        ),
      ]);
      // Invoices = actual fulfilled demand
      for (const doc of invDocs) {
        const lines = fdDocLinesForItem(doc, itemCode);
        if (itemCode && !lines.length) continue;
        demand[new Date(doc.DocDate).getMonth()] += itemCode ? lines.reduce((s,l)=>s+fdLineQty(l),0) : Number(doc.DocTotal||0);
      }
      // If no invoice demand, use Sales Orders as demand proxy
      const invDemand = demand.reduce((s,v)=>s+v,0);
      if (invDemand === 0) {
        for (const doc of soDocs) {
          const lines = fdDocLinesForItem(doc, itemCode);
          if (itemCode && !lines.length) continue;
          demand[new Date(doc.DocDate).getMonth()] += itemCode ? lines.reduce((s,l)=>s+fdLineQty(l),0) : Number(doc.DocTotal||0);
        }
      }
      for (const doc of grpoDocs) {
        const lines = fdDocLinesForItem(doc, itemCode);
        if (itemCode && !lines.length) continue;
        supply[new Date(doc.DocDate).getMonth()] += itemCode ? lines.reduce((s,l)=>s+fdLineQty(l),0) : Number(doc.DocTotal||0);
      }
      for (const doc of poDocs) {
        const poDate = doc.TaxDate || doc.DocDate;
        if (!poDate) continue;
        const lines = fdDocLinesForItem(doc, itemCode);
        if (itemCode && !lines.length) continue;
        openPO[new Date(poDate).getMonth()] += itemCode ? lines.reduce((s,l)=>s+fdLineOpenQty(l),0) : Number(doc.DocTotal||0);
      }
      const total = demand.reduce((s,v)=>s+v,0) + supply.reduce((s,v)=>s+v,0);
      return { demand, supply, openPO, total };
    }

    let { demand, supply, openPO, total } = await loadSD(year);
    // Auto-fallback to previous years if selected year has no data
    if (total === 0 && itemCode) {
      for (let offset=1; offset<=15; offset++) {
        const tryY = year - offset;
        if (tryY < 1990) break;
        const r = await loadSD(tryY);
        if (r.total > 0) { ({ demand, supply, openPO } = r); year = tryY; break; }
      }
    }
    res.json({ ok:true, year, itemCode:itemCode||'ALL', demand, supply, openPO, unit:itemCode?'quantity':'amount' });
  } catch(e) { res.status(500).json({ ok:false, error:e.message }); }
});

// ── Stock Reorder Monitor / Procurement Agent routes — extracted to controllers/procurement-agent.mjs ──
app.use('/api/procurement', createProcurementAgentRouter({ requireAuth, getActiveSap, gptChatComplete }));
app.use('/api/purchase-three-way-match', createPurchaseThreeWayMatchRouter({ requireAuth, getActiveSap }));


app.get("/api/suggest/warehouses", async (_req, res) => {
  try {
    const d = await getActiveSap().get("/Warehouses", { $filter:"Inactive eq 'tNO'", $select:"WarehouseCode,WarehouseName,EnableBinLocations", $top:100, $orderby:"WarehouseName asc" });
    res.json(d.value || []);
  } catch(e) { res.status(500).json({ error:e.message }); }
});

app.get("/api/suggest/bins", async (req, res) => {
  try {
    const { warehouse } = req.query;
    if (!warehouse) return res.json([]);
    const d = await getActiveSap().get("/BinLocations", { $filter:`WarehouseCode eq '${esc(warehouse)}' and Inactive eq 'tNO'`, $select:"AbsEntry,BinCode,WarehouseCode", $top:200, $orderby:"BinCode asc" });
    res.json(d.value || []);
  } catch(e) { res.status(500).json({ error:e.message }); }
});

app.get("/api/suggest/batches", async (req, res) => {
  try {
    const { item, warehouse } = req.query;
    if (!item) return res.json([]);
    let filter = `ItemCode eq '${esc(item)}' and Quantity gt 0`;
    if (warehouse) filter += ` and WhsCode eq '${esc(warehouse)}'`;
    const d = await getActiveSap().get("/BatchNumberDetails", { $filter:filter, $select:"BatchNumber,ItemCode,WhsCode,Quantity,ExpiryDate,AdmissionDate", $orderby:"ExpiryDate asc", $top:100 });
    res.json(d.value || []);
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// ── Fetch order for delivery form ──
app.get("/api/fetch/order/:entry", async (req, res) => {
  try {
    const doc = await getActiveSap().get(`/Orders(${req.params.entry})`);
    // Enrich each line with batch flag
    const lines = await Promise.all((doc.DocumentLines||[]).map(async (l) => {
      try {
        const item = await getActiveSap().get(`/Items('${esc(l.ItemCode)}')`);
        return { ...l, isBatch: item.ManageBatchNumbers === "tYES", isSerial: item.ManageSerialNumbers === "tYES" };
      } catch { return { ...l, isBatch: false, isSerial: false }; }
    }));
    res.json({ ...doc, DocumentLines: lines });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// ── Fetch PO for GRPO form ──
app.get("/api/fetch/po/:entry", async (req, res) => {
  try {
    const doc = await getActiveSap().get(`/PurchaseOrders(${req.params.entry})`);
    res.json(doc);
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// ── Fetch GRPO for AP Invoice form ──
app.get("/api/fetch/grpo/:entry", async (req, res) => {
  try {
    const doc = await getActiveSap().get(`/GoodsReceiptsPO(${req.params.entry})`);
    res.json(doc);
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// ── Print ──
app.get("/api/print/:docType/:docEntry", async (req, res) => {
  const { docType, docEntry } = req.params;
  const ENTITIES = { quotation:"Quotations", order:"Orders", delivery:"DeliveryNotes", invoice:"Invoices" };
  const entity = ENTITIES[docType.toLowerCase()];
  if (!entity) return res.status(400).send("Unknown doc type");
  try {
    const doc = await getActiveSap().get(`/${entity}(${docEntry})`);
    res.setHeader("Content-Type", "text/html");
    res.send(renderPrint(docType, doc));
  } catch(e) { res.status(500).send(`<pre>Error: ${e.message}</pre>`); }
});

// ── PO Agentic Workflow routes — extracted to controllers/po-workflow-agent.mjs ──
app.use('/api/workflow/po', createPoWorkflowAgentRouter({ requireAuth, getActiveSap, gptChatComplete, azureMessagesCreate, AI_PROVIDER }));

// ── Seed connections from .env COMPANY_N_* vars ───────────────────────────
(function seedEnvConnections() {
  let n = 1;
  while (process.env[`COMPANY_${n}_NAME`]) {
    const name     = process.env[`COMPANY_${n}_NAME`];
    const base_url = process.env[`COMPANY_${n}_URL`]  || process.env.SL_BASE_URL;
    const company  = process.env[`COMPANY_${n}_DB`]   || process.env[`COMPANY_${n}_COMPANY`];
    const sl_user  = process.env[`COMPANY_${n}_USER`] || process.env.SL_USER;
    const sl_pass  = process.env[`COMPANY_${n}_PASS`] || process.env[`COMPANY_${n}_PASSWORD`] || process.env.SL_PASSWORD;
    if (name && base_url && company && sl_user && sl_pass) {
      connRepo.upsertByCompany(name, base_url, company, sl_user, sl_pass);
      console.log(`[CONN] Seeded company: ${company} (${name})`);
    }
    n++;
  }
  // Ensure the current SL_COMPANY from .env exists, has up-to-date credentials,
  // AND is actually the active connection. Previously this only created the row
  // when missing (never refreshed credentials on an existing row) and never
  // touched is_active — so editing SL_COMPANY/SL_USER/SL_PASSWORD in .env had no
  // effect once a connection for that company already existed, and whichever
  // company was active before stayed active regardless of what .env said.
  const current = process.env.SL_COMPANY || process.env.SAP_B1_COMPANY;
  if (current) {
    const id = connRepo.upsertByCompany(
      current,
      process.env.SL_BASE_URL || process.env.SAP_B1_BASE_URL,
      current,
      process.env.SL_USER || process.env.SAP_B1_USER,
      process.env.SL_PASSWORD || process.env.SAP_B1_PASSWORD
    );
    console.log(`[CONN] Synced default company from .env: ${current}`);
    const active = connRepo.getActive();
    if (!active || active.company !== current) {
      connRepo.activate(id);
      console.log(`[CONN] Activated default company from .env: ${current}`);
    }
  }
})();

// ── Load mail config from DB into process.env on startup ──────────────────
(function seedMailConfig() {
  const cfg = mailConfigRepo.get();
  if (cfg?.mail_user) {
    if (cfg.imap_host) process.env.MAIL_IMAP_HOST = cfg.imap_host;
    if (cfg.imap_port) process.env.MAIL_IMAP_PORT = String(cfg.imap_port);
    process.env.MAIL_IMAP_TLS = cfg.imap_tls ? "true" : "false";
    if (cfg.mail_user) process.env.MAIL_USER      = cfg.mail_user;
    if (cfg.mail_pass) process.env.MAIL_PASS      = cfg.mail_pass;
    if (cfg.smtp_host) process.env.MAIL_SMTP_HOST = cfg.smtp_host;
    if (cfg.smtp_port) process.env.MAIL_SMTP_PORT = String(cfg.smtp_port);
    if (cfg.folder)    process.env.MAIL_FOLDER    = cfg.folder;
    if (cfg.poll_ms)   process.env.MAIL_POLL_MS   = String(cfg.poll_ms);
    console.log(`[MAIL] Loaded config from DB for ${cfg.mail_user}`);
  }
})();

// ── Branding (Company Setup / Developer Settings) ──────────────────────────
// Lets one deployed instance be re-skinned per client (product/company/developer
// name + logo) without code changes. GET is unauthenticated on purpose — the
// login page needs it before a session exists. PUT is admin-only.
function brandingToJson(row) {
  return {
    companyName:     row.company_name      || "",
    companyLogo:     row.company_logo      || "",
    developedBy:     row.developed_by      || "",
    developedByLogo: row.developed_by_logo || "",
    productName:     row.product_name      || "",
    productLogo:     row.product_logo      || "",
  };
}
function isValidLogoValue(v) {
  if (v == null || v === "") return true;
  if (typeof v !== "string") return false;
  return v.startsWith("data:image/") || v.startsWith("/assets/");
}

app.get("/api/branding", (_req, res) => {
  try {
    res.json(brandingToJson(brandingRepo.get()));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put("/api/branding", requireAuth, (req, res) => {
  if (req.user.role !== "admin" && req.user.role !== "superadmin") return res.status(403).json({ error: "Admin only" });
  const { companyName, companyLogo, developedBy, developedByLogo, productName, productLogo } = req.body || {};
  for (const [label, v] of [["companyLogo", companyLogo], ["developedByLogo", developedByLogo], ["productLogo", productLogo]]) {
    if (!isValidLogoValue(v)) return res.status(400).json({ error: `${label} must be an uploaded image or empty` });
  }
  try {
    const fields = {};
    if (companyName      !== undefined) fields.company_name      = String(companyName).slice(0, 200);
    if (companyLogo      !== undefined) fields.company_logo      = companyLogo;
    if (developedBy      !== undefined) fields.developed_by      = String(developedBy).slice(0, 200);
    if (developedByLogo  !== undefined) fields.developed_by_logo = developedByLogo;
    if (productName      !== undefined) fields.product_name      = String(productName).slice(0, 200);
    if (productLogo      !== undefined) fields.product_logo      = productLogo;
    const saved = brandingRepo.save(fields, req.user.username || req.user.email || "");
    res.json({ ok: true, branding: brandingToJson(saved) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Mail-PO→SO Agent routes — extracted to controllers/mail-po-agent.mjs ──
app.use('/api/mail-po', createMailPoAgentRouter({ requireAuth, getActiveSap, gptChatComplete, azureMessagesCreate, AI_PROVIDER }));


// ── Production Agent routes — extracted to controllers/production-agent.mjs ──
app.use('/api/production', createProductionAgentRouter({ requireAuth, getActiveSap, gptChatComplete }));

// ── MRP Reorder Auto-PO Agent routes — extracted to controllers/mrp-agent.mjs ──
app.use('/api/mrp', createMrpAgentRouter({ requireAuth, getActiveSap, gptChatComplete }));

// ── Dynamic Pricing Agent routes — extracted to controllers/pricing-agent.mjs ──
app.use('/api/pricing', createPricingAgentRouter({ requireAuth, getActiveSap, gptChatComplete, callSMLSVCPost, buildParamList, aggregateRows }));

// ── Purchase Request Chat Agent routes ─────────────────────────────────────
app.use('/api/pr-agent', createPurchaseRequestAgentRouter({
  requireAuth, getActiveSap, gptChatComplete, azureMessagesCreate, AI_PROVIDER, USE_AI,
}));

// ── Standalone Purchase Order Agent routes ─────────────────────────────────
app.use('/api/po-agent', createPurchaseOrderAgentRouter({ requireAuth, getActiveSap }));

// ── Standalone Sales Order Agent routes ────────────────────────────────────
app.use('/api/sales-order-agent', createSalesOrderAgentRouter({ requireAuth, getActiveSap }));

// ── PR to PO Conversion Agent routes ───────────────────────────────────────
app.use('/api/pr-to-po', createPRtoPOAgentRouter({
  requireAuth, getActiveSap, gptChatComplete, azureMessagesCreate, AI_PROVIDER, USE_AI,
}));

// ── PO to GRPO Receipt Agent routes ────────────────────────────────────────
app.use('/api/po-to-grpo', createPOtoGRPOAgentRouter({
  requireAuth, getActiveSap, gptChatComplete, azureMessagesCreate, AI_PROVIDER, USE_AI,
}));

// ── GRPO to AP Invoice OCR Agent routes ────────────────────────────────────
app.use('/api/grpo-apinv', createGRPOtoAPInvAgentRouter({
  requireAuth, getActiveSap, gptChatComplete, azureMessagesCreate, AI_PROVIDER, USE_AI,
}));

// ── OCR Processing suite routes ─────────────────────────────────────────────
const getActiveCompanyId = () => connRepo.getActive()?.company || 'default';
app.use('/api/ocr-po-scan', createOcrPoScanAgentRouter({
  requireAuth, getActiveSap, gptChatComplete, azureMessagesCreate, AI_PROVIDER, USE_AI, ocrDocumentsRepo, getActiveCompanyId,
}));
app.use('/api/ocr-expense', createOcrExpenseAgentRouter({
  requireAuth, getActiveSap, gptChatComplete, azureMessagesCreate, AI_PROVIDER, USE_AI, ocrDocumentsRepo, cacheRepo, getActiveCompanyId,
}));
app.use('/api/ocr-inward', createOcrInwardAgentRouter({
  requireAuth, gptChatComplete, azureMessagesCreate, AI_PROVIDER, USE_AI, ocrDocumentsRepo, getActiveCompanyId,
}));
app.use('/api/ocr-gatepass', createOcrGatePassAgentRouter({
  requireAuth, gptChatComplete, azureMessagesCreate, AI_PROVIDER, USE_AI, ocrDocumentsRepo, getActiveCompanyId,
}));
app.use('/api/ocr-document', createOcrDocumentAgentRouter({
  requireAuth, gptChatComplete, azureMessagesCreate, AI_PROVIDER, USE_AI, ocrDocumentsRepo, getActiveCompanyId,
}));

// ── Three-Way Match Agent routes ────────────────────────────────────────────
app.use('/api/three-way-match', createThreeWayMatchRouter({
  requireAuth, getActiveSap,
  isConnected, getActiveType, getActiveConfig, executeSQL, tableRef, getTableColumns, resolveFieldMap,
}));

// ── Menu Master Agent routes ─────────────────────────────────────────────────
app.use('/api/master', createMenuMasterRouter({ requireAuth, getActiveSap }));

// ── Service Call View Agent routes ───────────────────────────────────────────
app.use('/api/sc-agent',  createScViewRouter({ requireAuth, getActiveSap }));
app.use('/api/sc-form',   createScFormRouter({ requireAuth, getActiveSap }));
app.use('/api/sc-wizard', createScWizardRouter({ requireAuth, getActiveSap }));

// ── Roles & Permissions routes ───────────────────────────────────────────────
app.use('/api/roles', createRolesPermissionsRouter({ requireAuth }));

// ── Data Sync & Cache routes ─────────────────────────────────────────────────
app.use('/api', createDataSyncRouter({ requireAuth, getActiveSap }));

// ── Financial Agent routes — real-time P&L / Cash Flow, direct HANA/MSSQL ────
app.use('/api', createFinancialAgentRouter({ requireAuth }));

// ── AP Invoice to AP Credit Memo Agent routes ───────────────────────────────
app.use('/api/apinv-apcm', createAPInvToAPCMAgentRouter({
  requireAuth, getActiveSap,
}));

// ── Sales O2C Agent routes ──────────────────────────────────────────────────
app.use('/api/sales-quotation',    createSalesQuotationRouter({ requireAuth, getActiveSap }));
app.use('/api/quotation-comparison', createQuotationComparisonRouter({ requireAuth, getActiveSap }));
app.use('/api/quotation-order',    createQuotationToOrderRouter({ requireAuth, getActiveSap }));
app.use('/api/order-delivery',     createOrderToDeliveryRouter({ requireAuth, getActiveSap }));
app.use('/api/delivery-arinv',     createDeliveryToARInvRouter({ requireAuth, getActiveSap }));
app.use('/api/arinv-arcm',         createARInvToARCMRouter({ requireAuth, getActiveSap }));
app.use('/api/incoming-payment',   createIncomingPaymentRouter({ requireAuth, getActiveSap }));
app.use('/api/outgoing-payment',   createOutgoingPaymentRouter({ requireAuth, getActiveSap }));

// ── Order Intelligence Agent routes ──────────────────────────────────────
app.use('/api/order-intelligence', createOrderIntelligenceRouter({
  requireAuth, getActiveSap, gptChatComplete, azureMessagesCreate, AI_PROVIDER, USE_AI,
  isConnected, getActiveType, getActiveConfig, executeSQL, tableRef, getTableColumns, resolveFieldMap,
}));

// ── Purchasing Agent routes ───────────────────────────────────────────────
app.use('/api/purchasing', createPurchasingAgentRouter({
  requireAuth, getActiveSap, gptChatComplete, azureMessagesCreate, AI_PROVIDER, USE_AI,
  isConnected, getActiveType, getActiveConfig, executeSQL, tableRef, getTableColumns, resolveFieldMap,
}));

// ── Shipment Delay Prediction Agent routes ───────────────────────────────────
app.use('/api/shipment-delays', createShipmentDelayRouter({
  requireAuth, getActiveSap, gptChatComplete, azureMessagesCreate, AI_PROVIDER, USE_AI,
  isConnected, getActiveType, getActiveConfig, executeSQL, tableRef, getTableColumns, resolveFieldMap,
}));

// ── Activity Agent routes ──────────────────────────────────────────────────
app.use('/api/activity-agent', createActivityAgentRouter({
  requireAuth, getActiveSap, gptChatComplete, azureMessagesCreate, AI_PROVIDER, USE_AI,
}));

// ── Rush Order Prioritisation Agent routes ─────────────────────────────────
app.use('/api/rush-orders', createRushOrderRouter({
  requireAuth, getActiveSap, gptChatComplete, azureMessagesCreate, AI_PROVIDER, USE_AI,
  isConnected, getActiveType, getActiveConfig, executeSQL, tableRef, getTableColumns, resolveFieldMap,
}));

// ── Sales Analysis Dashboard routes ───────────────────────────────────────
app.use('/api/sales-analysis', createSalesAnalysisRouter({
  requireAuth,
  getActiveSap,
  getNamespace,
  gptChatComplete,
  azureMessagesCreate,
  AI_PROVIDER,
  USE_AI,
  isConnected, getActiveType, getActiveConfig, executeSQL, tableRef,
}));

// ── Purchase Analysis Dashboard routes ────────────────────────────────────
app.use('/api/purchase-analysis', createPurchaseAnalysisRouter({
  requireAuth,
  getActiveSap,
  getNamespace,
  gptChatComplete,
  azureMessagesCreate,
  AI_PROVIDER,
  USE_AI,
  isConnected, getActiveType, getActiveConfig, executeSQL, tableRef,
}));

// ── Vendor Payment Aging Agent routes ─────────────────────────────────────
app.use('/api/vendor-payment-aging', createVendorPaymentAgingRouter({
  requireAuth,
  getActiveSap,
  getNamespace,
  gptChatComplete,
  azureMessagesCreate,
  AI_PROVIDER,
  USE_AI,
}));

// ── Product Forecasting Agent routes ──────────────────────────────────────
app.use('/api/forecasting', createForecastingRouter({
  requireAuth,
  getActiveSap,
  callSMLSVCPost,
  buildParamList,
  aggregateRows,
  gptChatComplete,
  azureMessagesCreate,
  AI_PROVIDER,
  USE_AI,
}));

// ---------------------------------------------------------------------------
await startMcpClient();

// Auto-connect direct DB on startup — try db_connections active entry first, then SAP B1 connection HANA fields
{
  const savedDb = dbConnRepo.getActive();
  if (savedDb) {
    try {
      await connectDB(savedDb);
      console.log(`[Startup] DB auto-connected: ${savedDb.name} (${savedDb.db_type})`);
    } catch(e) {
      console.warn(`[Startup] DB auto-connect failed (${savedDb.name}): ${e.message}`);
      // Fall back to HANA credentials on the SAP B1 connection record
      const activeConn = connRepo.getActive();
      if (activeConn?.hana_host && activeConn?.hana_password) {
        try {
          await connectDB({ db_type:'hana', host:activeConn.hana_host, port:activeConn.hana_port||30015, database:activeConn.hana_database||activeConn.company, schema_name:activeConn.hana_schema||activeConn.company, username:activeConn.hana_user, password:activeConn.hana_password });
          console.log(`[Startup] HANA auto-connected via SAP B1 connection for ${activeConn.company}`);
        } catch(e2) { console.warn(`[Startup] HANA fallback also failed: ${e2.message}`); }
      }
    }
  } else {
    const activeConn = connRepo.getActive();
    if (activeConn?.hana_host && activeConn?.hana_password) {
      try {
        await connectDB({ db_type:'hana', host:activeConn.hana_host, port:activeConn.hana_port||30015, database:activeConn.hana_database||activeConn.company, schema_name:activeConn.hana_schema||activeConn.company, username:activeConn.hana_user, password:activeConn.hana_password });
        console.log(`[Startup] HANA DB auto-connected for ${activeConn.company}`);
      } catch(e) { console.warn(`[Startup] HANA auto-connect skipped: ${e.message}`); }
    }
  }
}

console.log(`Mode: ${USE_AI ? (AI_PROVIDER === "gpt" ? "AI (GPT-4o)" : "AI (Claude)") : "Standard (direct MCP)"}`);
app.listen(PORT, () => console.log(`\nSAP B1 Chat UI → http://localhost:${PORT}\n`));

if (existsSync(TLS_KEY_PATH) && existsSync(TLS_CERT_PATH)) {
  https
    .createServer({ key: readFileSync(TLS_KEY_PATH), cert: readFileSync(TLS_CERT_PATH) }, app)
    .on("error", (e) => console.warn(`[HTTPS] Failed to start on port ${HTTPS_PORT}: ${e.message}`))
    .listen(HTTPS_PORT, () => console.log(`SAP B1 Chat UI (HTTPS) → https://localhost:${HTTPS_PORT}\n`));
} else {
  console.log(`[HTTPS] Skipped — certs not found at ${TLS_KEY_PATH}. Run the cert generation step to enable it.\n`);
}
