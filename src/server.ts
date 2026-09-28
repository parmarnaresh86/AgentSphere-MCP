import axios, { AxiosError, AxiosInstance, AxiosRequestConfig, Method } from "axios";
import dotenv from "dotenv";
import https from "node:https";
import mssql from "mssql";
import hdb from "hdb";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";

dotenv.config();

type JsonObject = Record<string, unknown>;

type ToolResponse = {
  content: Array<{ type: "text"; text: string }>;
};

type ServiceLayerConfig = {
  baseUrl: string;
  company: string;
  user: string;
  password: string;
  rejectUnauthorized: boolean;
};

const BASE_DOCUMENT_TYPE = {
  quotation: 23,
  salesOrder: 17,
  delivery: 15,
  purchaseOrder: 22,
  goodsReceiptPo: 20,
  purchaseRequest: 1470000013,
  purchaseQuotation: 540000006,
} as const;

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function getConfig(): ServiceLayerConfig {
  // Support both SL_* (new) and SAP_B1_* (legacy) env vars — SL_* takes priority
  let baseUrl = (process.env.SL_BASE_URL || process.env.SAP_B1_BASE_URL || "").replace(/\/+$/, "");
  if (!baseUrl) throw new Error("Missing SL_BASE_URL or SAP_B1_BASE_URL");
  // If URL already has /b1s/v1 or /b1s/v2, leave it; otherwise append /b1s/v1
  if (!/\/b1s\/v\d/.test(baseUrl)) baseUrl += "/b1s/v1";
  return {
    baseUrl,
    company: (process.env.SL_COMPANY || process.env.SAP_B1_COMPANY || "").trim() || (() => { throw new Error("Missing SL_COMPANY or SAP_B1_COMPANY"); })(),
    user:    (process.env.SL_USER    || process.env.SAP_B1_USER    || "").trim() || (() => { throw new Error("Missing SL_USER or SAP_B1_USER"); })(),
    password:(process.env.SL_PASSWORD|| process.env.SAP_B1_PASSWORD|| "").trim() || (() => { throw new Error("Missing SL_PASSWORD or SAP_B1_PASSWORD"); })(),
    rejectUnauthorized: process.env.NODE_TLS_REJECT_UNAUTHORIZED !== "0",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// NAMESPACE MAP — maps CompanyDB → SMLSVC namespace prefix
// ─────────────────────────────────────────────────────────────────────────────
const NAMESPACE_MAP: Record<string, string> = {
  "SBO_DEMO_GB":       "sap.sbodemogb",
  "SBO_DEMO_US":       "sap.sbodemos",
  "SBO_DEMO_IN":       "sap.sbodemoin",
  "SBO_DEMO_DE":       "sap.sbodemode",
  "SBO_DEMO_AU":       "sap.sbodemoau",
  "SILVERTOUCH_LIVE":  "sap.silvertouch",
  "SILVERTOUCH_TEST":  "sap.silvertouchtest",
  "ME0925_SADP":       "sap.me0925sadp",
  // Add your company DB here: "YOUR_DB": "your.namespace"
};

let activeNamespace: string | null = null;
let activeCompany: string = "";
let smlBase: string = ""; // set in main() — e.g. https://host:50000/b1s
// Set once the backend reports "Semantic Layer exposure is not enabled" (error 805) —
// that means this company DB runs on SQL Server, not HANA, so sml.svc will never work,
// not just this call. Once set, skip all further sml.svc attempts and go straight to
// the Service Layer fallback, instead of retrying a call that can never succeed.
let smlUnavailable = false;

async function resolveNamespace(companyDB: string): Promise<string | null> {
  if (NAMESPACE_MAP[companyDB]) return (activeNamespace = NAMESPACE_MAP[companyDB]);
  try {
    // sml.svc lives under /b1s/, NOT /b1s/v2/ — use smlBase
    const res = await client.smlGet<{ value?: Array<{ QueryName?: string }> }>(smlBase, "");
    const queries = Array.isArray(res.value) ? res.value : [];
    const match = queries.find(q => q.QueryName?.includes("SalesAnalysis"));
    if (match?.QueryName) {
      const ns = match.QueryName.split(".ar.case")[0];
      NAMESPACE_MAP[companyDB] = ns;
      return (activeNamespace = ns);
    }
  } catch (e) {
    const msg = (e as Error).message;
    if (/Semantic Layer exposure is not enabled|"code":"805"/.test(msg)) {
      smlUnavailable = true;
      console.error(`sml.svc unavailable for ${companyDB} (SQL Server-backed company) — using Service Layer fallback for all analytics queries`);
    } else {
      console.error("Namespace auto-discovery failed:", msg);
    }
  }
  return null;
}

// Build SMLSVC ParamList body — dates as YYYYMMDD (no dashes)
function buildParamList(args: {
  fromDate?: string; toDate?: string; cardCode?: string;
  itemCode?: string; whsCode?: string; slpCode?: string; branchCode?: string;
}): Array<{ Name: string; Value: string }> {
  const p: Array<{ Name: string; Value: string }> = [];
  const fmt = (d: string) => d.replace(/-/g, "");
  if (args.fromDate)   p.push({ Name: "FromDate",   Value: fmt(args.fromDate) });
  if (args.toDate)     p.push({ Name: "ToDate",     Value: fmt(args.toDate) });
  if (args.cardCode)   p.push({ Name: "CardCode",   Value: args.cardCode });
  if (args.itemCode)   p.push({ Name: "ItemCode",   Value: args.itemCode });
  if (args.whsCode)    p.push({ Name: "WhsCode",    Value: args.whsCode });
  if (args.slpCode)    p.push({ Name: "SlpCode",    Value: args.slpCode });
  if (args.branchCode) p.push({ Name: "BranchCode", Value: args.branchCode });
  return p;
}

// ── SL Fallback helpers (used when sml.svc / HANA views are unavailable) ─────
const _itemGroupCache = new Map<number, string>(); // ItemsGroupCode → GroupName
const _slpNameCache   = new Map<number, string>(); // SalesPersonCode → Name
let   _itemGroupFetched = false;
let   _slpFetched       = false;

async function fetchItemGroupsCache(): Promise<void> {
  if (_itemGroupFetched) return;
  _itemGroupFetched = true;
  try {
    const data = await client.get<{ value?: Array<{ Number: number; GroupName: string }> }>("/ItemGroups");
    for (const g of data.value ?? []) if (g.Number != null) _itemGroupCache.set(g.Number, g.GroupName);
  } catch { /* non-fatal */ }
}

async function fetchSlpNameCache(): Promise<void> {
  if (_slpFetched) return;
  _slpFetched = true;
  try {
    const data = await client.get<{ value?: Array<{ SalesEmployeeCode: number; SalesEmployeeName: string }> }>("/SalesPersons");
    for (const s of data.value ?? []) if (s.SalesEmployeeCode != null) _slpNameCache.set(s.SalesEmployeeCode, s.SalesEmployeeName);
  } catch { /* non-fatal */ }
}

function derivePostingFields(docDate: string): Record<string, unknown> {
  if (!docDate) return {};
  const d = new Date(docDate);
  if (isNaN(d.getTime())) return {};
  const y = d.getFullYear();
  const m = d.getMonth() + 1;
  const q = Math.ceil(m / 3);
  const jan1 = new Date(y, 0, 1);
  const week = Math.ceil((((d.getTime() - jan1.getTime()) / 86400000) + jan1.getDay() + 1) / 7);
  return {
    PostingDate:           docDate,
    PostingYear:           y,
    PostingMonth:          m,
    PostingQuarter:        q,
    PostingYearAndMonth:   +(String(y) + String(m).padStart(2, "0")),
    PostingYearAndQuarter: +(String(y) + String(q)),
    PostingYearAndWeek:    +(String(y) + String(week).padStart(2, "0")),
  };
}

interface SLInvoiceLine { ItemCode?: string; Dscription?: string; Quantity?: number; LineTotal?: number; WarehouseCode?: string; ItemsGroupCode?: number; }
interface SLInvoice     { DocEntry?: number; CardCode?: string; CardName?: string; SalesPersonCode?: number; DocDate?: string; DocTotal?: number; GrossProfit?: number; DocumentLines?: SLInvoiceLine[]; }

async function callSLFallback(
  queryType: "sales" | "purchase" | "inventory" | "financial",
  slFilters: string[]   // already in SL field names (DocDate, CardCode, etc.)
): Promise<JsonObject[]> {

  // ── Inventory: use /Items directly ──
  if (queryType === "inventory") {
    await fetchItemGroupsCache();
    const p: Record<string, unknown> = { "$select": "ItemCode,ItemName,QuantityOnStock,QuantityOnOrder,ItemsGroupCode" };
    if (slFilters.length) p["$filter"] = slFilters.join(" and ");
    const data = await client.get<{ value?: JsonObject[] }>("/Items", p);
    return (data.value ?? []).map(item => ({
      ItemCode:               item["ItemCode"],
      ItemDescription:        item["ItemName"],
      ItemGroup:              _itemGroupCache.get(item["ItemsGroupCode"] as number) ?? "General",
      NetSalesAmountLC:       0,
      GrossProfitLC:          0,
      QuantityInInventoryUoM: item["QuantityOnStock"] ?? 0,
      OpenQuantity:           item["QuantityOnOrder"] ?? 0,
    }));
  }

  // ── Financial: use JournalEntries summary ──
  if (queryType === "financial") {
    const p: Record<string, unknown> = { "$select": "JdtNum,RefDate,Debit,Credit,SystemBaseAmount" };
    if (slFilters.length) p["$filter"] = slFilters.join(" and ");
    const data = await client.get<{ value?: JsonObject[] }>("/JournalEntries", p);
    return (data.value ?? []).map(row => ({
      ...derivePostingFields(String(row["RefDate"] ?? "")),
      NetSalesAmountLC: (row["Credit"] as number ?? 0) - (row["Debit"] as number ?? 0),
      GrossProfitLC:    0,
      QuantityInInventoryUoM: 0,
    }));
  }

  // ── Sales / Purchase: fetch Invoices with DocumentLines expanded ──
  const endpoint = queryType === "purchase" ? "/PurchaseInvoices" : "/Invoices";
  await fetchItemGroupsCache();
  await fetchSlpNameCache();

  const p: Record<string, unknown> = {
    "$select": "DocEntry,CardCode,CardName,SalesPersonCode,DocDate,DocTotal,GrossProfit",
    "$expand": "DocumentLines($select=ItemCode,Dscription,Quantity,LineTotal,WarehouseCode,ItemsGroupCode)",
  };
  if (slFilters.length) p["$filter"] = slFilters.join(" and ");

  const data = await client.get<{ value?: SLInvoice[] }>(endpoint, p);
  const invoices = data.value ?? [];
  const rows: JsonObject[] = [];

  for (const inv of invoices) {
    const periodFields = derivePostingFields(inv.DocDate ?? "");
    const slpCode = inv.SalesPersonCode ?? 0;
    const header: JsonObject = {
      BusinessPartnerCode:       inv.CardCode ?? "",
      BusinessPartnerName:       inv.CardName ?? "",
      SalesEmployeeOrBuyerNumber: slpCode,
      SalesEmployeeOrBuyerName:  _slpNameCache.get(slpCode) ?? `SLP-${slpCode}`,
      ...periodFields,
    };

    const lines = inv.DocumentLines ?? [];
    if (lines.length === 0) {
      rows.push({
        ...header,
        ItemCode: "", ItemDescription: "", ItemGroup: "General",
        WarehouseCode: "", WarehouseName: "",
        NetSalesAmountLC:       inv.DocTotal ?? 0,
        GrossProfitLC:          inv.GrossProfit ?? 0,
        QuantityInInventoryUoM: 0,
      });
    } else {
      const docTotal = inv.DocTotal ?? 0;
      const docGP    = inv.GrossProfit ?? 0;
      for (const line of lines) {
        const lineTotal = line.LineTotal ?? 0;
        const gpShare   = docTotal > 0 ? (lineTotal / docTotal) * docGP : 0;
        rows.push({
          ...header,
          ItemCode:               line.ItemCode ?? "",
          ItemDescription:        line.Dscription ?? "",
          ItemGroup:              _itemGroupCache.get(line.ItemsGroupCode as number) ?? "General",
          WarehouseCode:          line.WarehouseCode ?? "",
          WarehouseName:          line.WarehouseCode ?? "",
          NetSalesAmountLC:       lineTotal,
          GrossProfitLC:          +gpShare.toFixed(4),
          QuantityInInventoryUoM: line.Quantity ?? 0,
        });
      }
    }
  }
  return rows;
}

// Converts SMLSVC-style field names → Service Layer field names for use in $filter
function toSLFilters(filters: string[]): string[] {
  return filters.map(f =>
    f.replace(/\bPostingDate\b/g,            "DocDate")
     .replace(/\bBusinessPartnerCode\b/g,    "CardCode")
     .replace(/\bSalesEmployeeOrBuyerNumber\b/g, "SalesPersonCode")
  );
}

// Call SMLSVC via OData GET — falls back to direct Service Layer if sml.svc unavailable
async function callSMLSVC(
  queryType: "sales" | "purchase" | "inventory" | "financial",
  paramList: Array<{ Name: string; Value: string }>,
  _companyDB: string
): Promise<JsonObject[]> {
  const viewMap: Record<string, string> = {
    sales:     "SalesAnalysisQuery",
    purchase:  "PurchaseAnalysisQuery",
    inventory: "InventoryStatusQuery",
    financial: "FinancialAnalysisQuery",
  };
  const viewName = viewMap[queryType];

  // Convert legacy ParamList → OData $filter (SMLSVC field names)
  const filters: string[] = [];
  for (const p of paramList) {
    switch (p.Name) {
      case "FromDate": {
        const d = p.Value; // YYYYMMDD
        filters.push(`PostingDate ge '${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)}'`);
        break;
      }
      case "ToDate": {
        const d = p.Value;
        filters.push(`PostingDate le '${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)}'`);
        break;
      }
      case "CardCode":
        filters.push(`BusinessPartnerCode eq '${p.Value.replace(/'/g, "''")}'`);
        break;
      case "ItemCode":
        filters.push(`ItemCode eq '${p.Value.replace(/'/g, "''")}'`);
        break;
      case "WhsCode":
        filters.push(`WarehouseCode eq '${p.Value.replace(/'/g, "''")}'`);
        break;
      case "SlpCode":
        if (!Number.isNaN(Number(p.Value))) filters.push(`SalesEmployeeOrBuyerNumber eq ${p.Value}`);
        break;
      case "BranchCode":
        if (!Number.isNaN(Number(p.Value))) filters.push(`BranchCode eq ${p.Value}`);
        break;
    }
  }

  // ── Tier 0: Namespace-based POST (most reliable — works on all HANA SAP B1) ──
  // This is the same approach used by chat-server.mjs Standard mode.
  if (activeNamespace) {
    const nsPathMap: Record<string, string> = {
      sales:     `${activeNamespace}.ar.case/SalesAnalysisQuery`,
      purchase:  `${activeNamespace}.ap.case/PurchaseAnalysis`,
      inventory: `${activeNamespace}.inv.case/InventoryStatus`,
      financial: `${activeNamespace}.fin.case/FinancialAnalysis`,
    };
    const nsPath = nsPathMap[queryType];
    if (nsPath) {
      try {
        const data = await client.smlPost<{ value?: JsonObject[] }>(smlBase, nsPath, { ParamList: paramList });
        // Return even empty array — 0 rows means no data for the period, not a POST failure
        if (Array.isArray(data.value)) return data.value;
      } catch (e) {
        console.error(`[callSMLSVC] Namespace POST failed: ${(e as Error).message} — trying OData GET`);
      }
    }
  }

  // ── Tier 1: OData GET (fallback when namespace is unknown) ───────────────
  if (!smlUnavailable) {
    try {
      const params: Record<string, unknown> = {};
      if (filters.length) params["$filter"] = filters.join(" and ");
      const data = await client.smlGet<{ value?: JsonObject[] }>(smlBase, viewName, params);
      if (Array.isArray(data.value)) return data.value;
    } catch {
      // sml.svc OData GET not available — fall through to SL fallback
    }
  }

  // ── Tier 2: Service Layer direct fallback ────────────────────────────────
  return callSLFallback(queryType, toSLFilters(filters));
}

// Aggregate raw SMLSVC rows by groupFields, summing measure fields
function aggregateRows(
  rows: JsonObject[],
  groupFields: string[],
  measures: string[] = ["NetSalesAmountLC", "GrossProfitLC", "QuantityInInventoryUoM"]
): (JsonObject & { GPMarginPct: number })[] {
  const map = new Map<string, JsonObject & { GPMarginPct: number }>();
  for (const row of rows) {
    const key = groupFields.map(f => String(row[f] ?? "")).join("||");
    if (!map.has(key)) {
      const rec: JsonObject & { GPMarginPct: number } = { GPMarginPct: 0 };
      for (const f of groupFields) rec[f] = row[f];
      for (const f of measures) rec[f] = 0;
      map.set(key, rec);
    }
    const rec = map.get(key)!;
    for (const f of measures) (rec[f] as number) += toNumber(row[f]);
  }
  for (const rec of map.values()) {
    const sales = toNumber(rec["NetSalesAmountLC"]);
    const gp    = toNumber(rec["GrossProfitLC"]);
    rec.GPMarginPct = sales > 0 ? +((gp / sales) * 100).toFixed(2) : 0;
  }
  return [...map.values()];
}

function sortLimitRows<T extends Record<string, unknown>>(rows: T[], field: string, order: "asc"|"desc" = "desc", n?: number): T[] {
  const sorted = [...rows].sort((a, b) =>
    order === "desc" ? toNumber(b[field]) - toNumber(a[field]) : toNumber(a[field]) - toNumber(b[field])
  );
  return n ? sorted.slice(0, n) : sorted;
}

// ─────────────────────────────────────────────────────────────────────────────
// FORECASTING UTILITIES — 9 statistical models, no external dependencies
// Models: SMA, WMA, EWMA, LinearTrend, Drift, Holt, HoltWinters, SeasonalNaive, Median
// ─────────────────────────────────────────────────────────────────────────────

type ForecastPoint = {
  sma:           number;
  wma:           number;
  ewma:          number;
  linearTrend:   number;
  drift:         number;
  holt:          number;
  holtWinters:   number;
  seasonalNaive: number;
  median:        number;
  ensemble:      number;
  recommended:   number;
};

type ModelAccuracy = {
  model:    string;
  mape:     number;
  mae:      number;
  rmse:     number;
};

/** Median of an array */
function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m];
}

/** Simple Moving Average of the last `window` values */
function calcSMA(data: number[], window: number): number {
  const slice = data.slice(-Math.max(1, window));
  return slice.reduce((s, v) => s + v, 0) / slice.length;
}

/** Weighted Moving Average — linearly increasing weights, most recent = highest */
function calcWMA(data: number[], window: number): number {
  const slice   = data.slice(-Math.max(1, window));
  const weights = slice.map((_, i) => i + 1);
  const wSum    = weights.reduce((s, w) => s + w, 0);
  return slice.reduce((s, v, i) => s + v * weights[i], 0) / wSum;
}

/** Exponential Weighted Moving Average — returns full smoothed series */
function calcEWMA(data: number[], alpha = 0.3): number[] {
  if (data.length === 0) return [];
  const out: number[] = [data[0]];
  for (let i = 1; i < data.length; i++) out.push(alpha * data[i] + (1 - alpha) * out[i - 1]);
  return out;
}

/** Ordinary Least Squares linear regression (index-based x axis) */
function calcLinearRegression(data: number[]): { slope: number; intercept: number; r2: number } {
  const n = data.length;
  if (n < 2) return { slope: 0, intercept: data[0] ?? 0, r2: 0 };
  const xMean = (n - 1) / 2;
  const yMean = data.reduce((s, v) => s + v, 0) / n;
  let ssXY = 0, ssXX = 0, ssTot = 0, ssRes = 0;
  for (let i = 0; i < n; i++) {
    ssXY  += (i - xMean) * (data[i] - yMean);
    ssXX  += (i - xMean) ** 2;
    ssTot += (data[i] - yMean) ** 2;
  }
  const slope     = ssXX > 0 ? ssXY / ssXX : 0;
  const intercept = yMean - slope * xMean;
  for (let i = 0; i < n; i++) ssRes += (data[i] - (intercept + slope * i)) ** 2;
  const r2 = ssTot > 0 ? Math.max(0, 1 - ssRes / ssTot) : 0;
  return { slope, intercept, r2 };
}

/**
 * Holt's Double Exponential Smoothing (level + trend).
 * Returns forecast values for h=1..horizon.
 * α = level smoothing, β = trend smoothing.
 */
function calcHolt(
  data: number[],
  horizon: number,
  alpha = 0.3,
  beta  = 0.1
): number[] {
  if (data.length < 2) return Array(horizon).fill(Math.max(0, data[0] ?? 0));
  let l = data[0];
  let b = data[1] - data[0];
  for (let t = 1; t < data.length; t++) {
    const lPrev = l;
    l = alpha * data[t] + (1 - alpha) * (l + b);
    b = beta  * (l - lPrev) + (1 - beta) * b;
  }
  return Array.from({ length: horizon }, (_, h) => Math.max(0, l + (h + 1) * b));
}

/**
 * Holt-Winters Additive Triple Exponential Smoothing (level + trend + seasonality).
 * m = season length (12 for monthly). Requires >= 2 full seasons.
 * Falls back to Holt's when data is insufficient.
 */
function calcHoltWinters(
  data: number[],
  horizon: number,
  m    = 12,
  alpha = 0.3,
  beta  = 0.1,
  gamma = 0.2
): number[] {
  if (data.length < m + 1) return calcHolt(data, horizon, alpha, beta);

  // Initialise seasonal indices from first season
  const firstSeasonAvg = data.slice(0, m).reduce((s, v) => s + v, 0) / m;
  const s: number[]    = data.slice(0, m).map(v => v - firstSeasonAvg);

  let l = firstSeasonAvg;
  let b = data.length >= 2 * m
    ? (data.slice(m, 2 * m).reduce((sum, v) => sum + v, 0) / m - firstSeasonAvg) / m
    : (data[data.length - 1] - data[0]) / (data.length - 1);

  for (let t = m; t < data.length; t++) {
    const lPrev = l;
    const si    = s[(t - m) % s.length];
    l = alpha * (data[t] - si) + (1 - alpha) * (l + b);
    b = beta  * (l - lPrev)   + (1 - beta)  * b;
    s.push(gamma * (data[t] - lPrev - b) + (1 - gamma) * si);
  }

  return Array.from({ length: horizon }, (_, h) => {
    const seasonIdx = (data.length + h) % m;
    const si = s[s.length - m + seasonIdx] ?? s[seasonIdx] ?? 0;
    return Math.max(0, l + (h + 1) * b + si);
  });
}

/**
 * Seasonal Naive — forecast(h) = value from same season period last cycle.
 * m = season length (12 for monthly).
 */
function calcSeasonalNaive(data: number[], horizon: number, m = 12): number[] {
  if (data.length < m) {
    // Not enough for a full season — use plain naive (last value)
    return Array(horizon).fill(Math.max(0, data[data.length - 1] ?? 0));
  }
  return Array.from({ length: horizon }, (_, h) => {
    const idx = data.length - m + (h % m);
    return Math.max(0, data[idx] ?? data[data.length - 1] ?? 0);
  });
}

/**
 * Drift Method — extends the average slope from first to last historical point.
 */
function calcDrift(data: number[], horizon: number): number[] {
  if (data.length < 2) return Array(horizon).fill(Math.max(0, data[0] ?? 0));
  const drift = (data[data.length - 1] - data[0]) / (data.length - 1);
  return Array.from({ length: horizon }, (_, h) =>
    Math.max(0, data[data.length - 1] + (h + 1) * drift)
  );
}

/**
 * Error metrics: MAPE, MAE, RMSE.
 * actual and predicted must be same length.
 */
function calcErrors(actual: number[], predicted: number[]): { mape: number; mae: number; rmse: number } {
  const n = Math.min(actual.length, predicted.length);
  if (n === 0) return { mape: 0, mae: 0, rmse: 0 };
  let sumAPE = 0, sumAE = 0, sumSE = 0, mapeCount = 0;
  for (let i = 0; i < n; i++) {
    const e = actual[i] - predicted[i];
    sumAE += Math.abs(e);
    sumSE += e * e;
    if (actual[i] !== 0) { sumAPE += Math.abs(e / actual[i]); mapeCount++; }
  }
  return {
    mape: mapeCount > 0 ? +((sumAPE / mapeCount) * 100).toFixed(2) : 0,
    mae:  +(sumAE / n).toFixed(2),
    rmse: +(Math.sqrt(sumSE / n)).toFixed(2),
  };
}

/**
 * Backtest all 9 models using a holdout of `holdout` periods.
 * Returns per-model accuracy and the name of the best model (lowest MAPE).
 */
function backtestModels(
  data: number[],
  holdout: number,
  m = 12
): { accuracy: ModelAccuracy[]; bestModel: string } {
  const train  = data.slice(0, data.length - holdout);
  const actual = data.slice(data.length - holdout);
  if (train.length < 2) return { accuracy: [], bestModel: "ensemble" };

  const smaW = Math.min(3, train.length);

  const predictions: Record<string, number[]> = {
    sma:           Array(holdout).fill(calcSMA(train, smaW)),
    wma:           Array(holdout).fill(calcWMA(train, smaW)),
    ewma:          Array(holdout).fill(calcEWMA(train).slice(-1)[0] ?? 0),
    linearTrend:   (() => {
      const { slope, intercept } = calcLinearRegression(train);
      return Array.from({ length: holdout }, (_, h) =>
        Math.max(0, intercept + slope * (train.length + h))
      );
    })(),
    drift:         calcDrift(train, holdout),
    holt:          calcHolt(train, holdout),
    holtWinters:   calcHoltWinters(train, holdout, m),
    seasonalNaive: calcSeasonalNaive(train, holdout, m),
    median:        Array(holdout).fill(median(train.slice(-Math.min(6, train.length)))),
  };

  const accuracy: ModelAccuracy[] = Object.entries(predictions).map(([model, pred]) => ({
    model,
    ...calcErrors(actual, pred),
  }));

  accuracy.sort((a, b) => a.mape - b.mape);
  const bestModel = accuracy[0]?.model ?? "ensemble";
  return { accuracy, bestModel };
}

// ─────────────────────────────────────────────────────────────────────────────
// SEASONALITY DETECTION — ACF, additive decomposition, seasonal strength
// ─────────────────────────────────────────────────────────────────────────────

/** Population variance */
function calcVariance(arr: number[]): number {
  if (arr.length < 2) return 0;
  const mean = arr.reduce((s, v) => s + v, 0) / arr.length;
  return arr.reduce((s, v) => s + (v - mean) ** 2, 0) / arr.length;
}

/** Autocorrelation coefficient at lag k */
function acfAtLag(data: number[], k: number): number {
  const n    = data.length;
  if (k >= n) return 0;
  const mean = data.reduce((s, v) => s + v, 0) / n;
  const v    = calcVariance(data);
  if (v === 0) return 0;
  let sum = 0;
  for (let t = 0; t < n - k; t++) sum += (data[t] - mean) * (data[t + k] - mean);
  return sum / (n * v);
}

/** Full ACF series for lags 1..maxLag */
function calcACFSeries(data: number[], maxLag: number): number[] {
  return Array.from({ length: maxLag }, (_, i) => +acfAtLag(data, i + 1).toFixed(4));
}

/**
 * Additive seasonal decomposition via centered moving average.
 * m = season length (12 for monthly).
 * Returns: trend (nulls at edges), seasonal (full length), residual, seasonalIndices[0..m-1].
 */
function seasonalDecompose(data: number[], m = 12): {
  trend:           (number | null)[];
  seasonal:        number[];
  residual:        (number | null)[];
  seasonalIndices: number[];
} {
  const n    = data.length;
  const half = Math.floor(m / 2);

  // Step 1: centered MA trend
  const trend: (number | null)[] = Array(n).fill(null);
  for (let t = half; t < n - half; t++) {
    let sum = 0, wSum = 0;
    for (let k = -half; k <= half; k++) {
      const w = (m % 2 === 0 && Math.abs(k) === half) ? 0.5 : 1;
      sum  += w * data[t + k];
      wSum += w;
    }
    trend[t] = sum / wSum;
  }

  // Step 2: detrended series
  const detrended: (number | null)[] = data.map((v, i) =>
    trend[i] != null ? v - trend[i]! : null
  );

  // Step 3: seasonal indices — avg detrended per season position, normalized to sum=0
  const sums:   number[] = Array(m).fill(0);
  const counts: number[] = Array(m).fill(0);
  for (let t = 0; t < n; t++) {
    if (detrended[t] != null) { sums[t % m] += detrended[t]!; counts[t % m]++; }
  }
  const raw     = sums.map((s, i) => counts[i] > 0 ? s / counts[i] : 0);
  const meanIdx = raw.reduce((s, v) => s + v, 0) / m;
  const seasonalIndices = raw.map(v => +(v - meanIdx).toFixed(2));

  // Step 4: apply seasonal pattern over full series
  const seasonal: number[] = data.map((_, t) => seasonalIndices[t % m]);

  // Step 5: residual = detrended − seasonal index
  const residual: (number | null)[] = detrended.map((d, i) =>
    d != null ? +(d - seasonal[i]).toFixed(2) : null
  );

  return { trend, seasonal, residual, seasonalIndices };
}

/**
 * Seasonal strength:  Fs = max(0, 1 − Var(R) / Var(S+R))
 * Interpretation: ≥0.64 strong · 0.40–0.64 moderate · 0.20–0.40 weak · <0.20 none
 */
function calcSeasonalStrength(seasonal: number[], residual: (number | null)[]): number {
  const rArr: number[] = [], srArr: number[] = [];
  for (let i = 0; i < Math.min(seasonal.length, residual.length); i++) {
    if (residual[i] != null) { rArr.push(residual[i]!); srArr.push(seasonal[i] + residual[i]!); }
  }
  if (rArr.length < 4) return 0;
  const varR = calcVariance(rArr), varSR = calcVariance(srArr);
  return varSR > 0 ? +Math.max(0, 1 - varR / varSR).toFixed(4) : 0;
}

type SeasonalityResult = {
  seasonalityDetected:      boolean;
  verdict:                  "strong" | "moderate" | "weak" | "none";
  seasonalStrength:         number;
  acfAtLag12:               number;
  acfAtLag6:                number;
  acfSignificanceThreshold: number;
  acfSeries:                number[];
  seasonalIndices:          Record<string, number>;
  peakMonth:                string;
  troughMonth:              string;
  peakMonthIndex:           number;
  troughMonthIndex:         number;
  dominantPeriod:           number;
  recommendation:           string;
};

const MONTH_NAMES = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

/**
 * Run the full seasonality analysis on a monthly time series.
 * Combines ACF significance test + decomposition strength score.
 */
function runSeasonalityCheck(data: number[], m = 12): SeasonalityResult {
  const maxLag   = Math.min(m * 2, data.length - 2);
  const acfSeries = calcACFSeries(data, maxLag);
  const sigThresh = +(2 / Math.sqrt(data.length)).toFixed(4);
  const acfAtLag12 = acfSeries[m - 1] ?? 0;
  const acfAtLag6  = acfSeries[5] ?? 0;

  // Dominant period: lag with highest |ACF| in [2, maxLag]
  let domPeriod = m, domACF = Math.abs(acfAtLag12);
  for (let k = 2; k <= maxLag; k++) {
    const a = Math.abs(acfSeries[k - 1] ?? 0);
    if (a > domACF) { domACF = a; domPeriod = k; }
  }

  let seasonalIndicesMap: Record<string, number> = {};
  let peakMonth = "N/A", troughMonth = "N/A", peakIdx = 0, troughIdx = 0, strength = 0;

  if (data.length >= m) {
    const { seasonal, residual, seasonalIndices } = seasonalDecompose(data, m);
    strength = calcSeasonalStrength(seasonal, residual);
    seasonalIndices.forEach((v, i) => { seasonalIndicesMap[String(i + 1).padStart(2, "0")] = v; });
    const maxI = seasonalIndices.indexOf(Math.max(...seasonalIndices));
    const minI = seasonalIndices.indexOf(Math.min(...seasonalIndices));
    peakIdx = maxI + 1; troughIdx = minI + 1;
    peakMonth   = MONTH_NAMES[maxI]  ?? String(peakIdx);
    troughMonth = MONTH_NAMES[minI] ?? String(troughIdx);
  }

  const verdict: SeasonalityResult["verdict"] =
    strength >= 0.64 ? "strong"   :
    strength >= 0.40 ? "moderate" :
    strength >= 0.20 ? "weak"     : "none";

  const seasonalityDetected = strength >= 0.20 || Math.abs(acfAtLag12) > sigThresh;

  const recommendation =
    verdict === "strong"   ? `Strong seasonal pattern detected (Fs=${strength.toFixed(2)}, ACF₁₂=${acfAtLag12.toFixed(3)}). Peak: ${peakMonth}, Trough: ${troughMonth}. → Recommended models: Holt-Winters, SeasonalNaive.` :
    verdict === "moderate" ? `Moderate seasonality (Fs=${strength.toFixed(2)}, ACF₁₂=${acfAtLag12.toFixed(3)}). Peak: ${peakMonth}. → Try Holt-Winters; compare with Holt.` :
    verdict === "weak"     ? `Weak seasonality (Fs=${strength.toFixed(2)}). Seasonal effect is minor. → LinearTrend or Holt likely better.` :
                             `No significant seasonality detected (Fs=${strength.toFixed(2)}, ACF₁₂=${acfAtLag12.toFixed(3)} < threshold ${sigThresh}). → Use LinearTrend, Holt, or Drift.`;

  return {
    seasonalityDetected,
    verdict,
    seasonalStrength:         strength,
    acfAtLag12,
    acfAtLag6,
    acfSignificanceThreshold: sigThresh,
    acfSeries,
    seasonalIndices:          seasonalIndicesMap,
    peakMonth,
    troughMonth,
    peakMonthIndex:   peakIdx,
    troughMonthIndex: troughIdx,
    dominantPeriod:   domPeriod,
    recommendation,
  };
}

/** Advance a YYYYMM string by `n` months (handles year roll-over) */
function addMonths(yyyymm: string, n: number): string {
  let y = parseInt(yyyymm.slice(0, 4), 10);
  let m = parseInt(yyyymm.slice(4, 6), 10) + n;
  while (m > 12) { m -= 12; y++; }
  while (m < 1)  { m += 12; y--; }
  return `${y}${String(m).padStart(2, "0")}`;
}

/**
 * Run all 9 models and return per-period forecast points.
 * Also returns model accuracy from backtesting and the recommended model name.
 */
function buildForecast(
  values:  number[],
  horizon: number,
  m = 12
): { forecasts: ForecastPoint[]; accuracy: ModelAccuracy[]; bestModel: string; r2: number } {
  const holdout = Math.min(3, Math.floor(values.length / 3));
  const { accuracy, bestModel } = holdout >= 1
    ? backtestModels(values, holdout, m)
    : { accuracy: [], bestModel: "ensemble" };

  const { slope, intercept, r2 } = calcLinearRegression(values);
  const smaW     = Math.min(3, values.length);
  const ewmaFull = calcEWMA(values);
  let   ewmaSt   = ewmaFull[ewmaFull.length - 1];

  const holtPts    = calcHolt(values, horizon);
  const hwPts      = calcHoltWinters(values, horizon, m);
  const snPts      = calcSeasonalNaive(values, horizon, m);
  const driftPts   = calcDrift(values, horizon);
  const medVal     = median(values.slice(-Math.min(6, values.length)));

  const forecasts: ForecastPoint[] = Array.from({ length: horizon }, (_, h) => {
    const i         = values.length + h;
    const linTrend  = Math.max(0, intercept + slope * i);
    ewmaSt          = 0.3 * linTrend + 0.7 * ewmaSt;
    const smaV      = Math.max(0, calcSMA(values.slice(-smaW), smaW));
    const wmaV      = Math.max(0, calcWMA(values.slice(-smaW), smaW));

    const all9 = [linTrend, ewmaSt, smaV, wmaV, holtPts[h], hwPts[h], snPts[h], driftPts[h], medVal];
    const ensemble = +( all9.reduce((s, v) => s + v, 0) / all9.length ).toFixed(2);

    const modelMap: Record<string, number> = {
      sma: smaV, wma: wmaV, ewma: ewmaSt, linearTrend: linTrend,
      drift: driftPts[h], holt: holtPts[h], holtWinters: hwPts[h],
      seasonalNaive: snPts[h], median: medVal, ensemble,
    };
    const recommended = +(modelMap[bestModel] ?? ensemble).toFixed(2);

    return {
      sma:           +smaV.toFixed(2),
      wma:           +wmaV.toFixed(2),
      ewma:          +ewmaSt.toFixed(2),
      linearTrend:   +linTrend.toFixed(2),
      drift:         +driftPts[h].toFixed(2),
      holt:          +holtPts[h].toFixed(2),
      holtWinters:   +hwPts[h].toFixed(2),
      seasonalNaive: +snPts[h].toFixed(2),
      median:        +medVal.toFixed(2),
      ensemble,
      recommended,
    };
  });

  return { forecasts, accuracy, bestModel, r2: +r2.toFixed(4) };
}

// Default year-to-date range
function ytdRange(): { fromDate: string; toDate: string } {
  const now = new Date();
  return { fromDate: `${now.getFullYear()}-01-01`, toDate: now.toISOString().slice(0, 10) };
}

function asObject(value: unknown, fieldName: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new McpError(ErrorCode.InvalidParams, `${fieldName} must be an object`);
  }
  return value as JsonObject;
}

function asArray(value: unknown, fieldName: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new McpError(ErrorCode.InvalidParams, `${fieldName} must be an array`);
  }
  return value;
}

function asString(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new McpError(ErrorCode.InvalidParams, `${fieldName} must be a non-empty string`);
  }
  return value.trim();
}

function optionalString(value: unknown, fieldName?: string): string | undefined {
  if (value == null) return undefined;
  return asString(value, fieldName ?? "value");
}

function asNumber(value: unknown, fieldName: string): number {
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new McpError(ErrorCode.InvalidParams, `${fieldName} must be a valid number`);
  }
  return value;
}

function optionalNumber(value: unknown, fieldName: string): number | undefined {
  if (value == null) return undefined;
  return asNumber(value, fieldName);
}

function parseDateOrToday(value: unknown, fieldName = "date"): string {
  if (value == null) return new Date().toISOString().slice(0, 10);
  const s = asString(value, fieldName);
  if (!ISO_DATE_RE.test(s)) {
    throw new McpError(ErrorCode.InvalidParams, `${fieldName} must be in YYYY-MM-DD format, got: ${s}`);
  }
  return s;
}

function textResult(payload: unknown): ToolResponse {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  };
}

function buildComment(parts: Array<string | undefined>): string {
  return parts.filter(Boolean).join(" | ");
}

function toNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  return 0;
}

function encodeEntityKey(key: string | number): string {
  return typeof key === "number" ? `${key}` : `'${String(key).replace(/'/g, "''")}'`;
}

class SapB1ServiceLayerClient {
  private readonly http: AxiosInstance;
  private sessionId?: string;
  private routeId?: string;
  private loginPromise?: Promise<void>;

  constructor(private readonly config: ServiceLayerConfig) {
    this.http = axios.create({
      baseURL: config.baseUrl,
      timeout: 120000,
      headers: {
        "Content-Type": "application/json",
        // Tell SAP B1 Service Layer to return ALL records with no server-side page limit.
        // getAll() already follows @odata.nextLink pagination as a safety net.
        "Prefer": "odata.maxpagesize=0",
      },
      httpsAgent: new https.Agent({ rejectUnauthorized: config.rejectUnauthorized }),
      validateStatus: () => true,
    });
  }

  async login(): Promise<void> {
    // Deduplicate concurrent login attempts
    if (this.loginPromise) return this.loginPromise;
    this.loginPromise = this._doLogin().finally(() => {
      this.loginPromise = undefined;
    });
    return this.loginPromise;
  }

  private async _doLogin(): Promise<void> {
    const response = await this.http.post("/Login", {
      CompanyDB: this.config.company,
      UserName: this.config.user,
      Password: this.config.password,
    });

    if (response.status < 200 || response.status >= 300) {
      throw new Error(`SAP B1 login failed: ${response.status} ${JSON.stringify(response.data)}`);
    }

    const rawCookies = response.headers["set-cookie"];
    const cookies = Array.isArray(rawCookies) ? rawCookies : [];

    for (const cookie of cookies) {
      const [pair] = cookie.split(";", 1);
      const [name, value] = pair.split("=", 2);
      if (name === "B1SESSION") this.sessionId = value;
      if (name === "ROUTEID") this.routeId = value;
    }

    if (!this.sessionId) {
      throw new Error("SAP B1 login succeeded but B1SESSION cookie was not returned.");
    }
  }

  private async ensureSession(): Promise<void> {
    if (!this.sessionId) await this.login();
  }

  private cookieHeader(): string {
    const cookies = [`B1SESSION=${this.sessionId}`];
    if (this.routeId) cookies.push(`ROUTEID=${this.routeId}`);
    return cookies.join("; ");
  }

  async request<T>(method: Method, path: string, data?: unknown, config: AxiosRequestConfig = {}): Promise<T> {
    await this.ensureSession();

    const execute = async (): Promise<T> => {
      const response = await this.http.request<T>({
        method,
        url: path,
        data,
        ...config,
        headers: {
          Cookie: this.cookieHeader(),
          ...(config.headers ?? {}),
        },
      });

      if (response.status >= 200 && response.status < 300) return response.data;
      throw new AxiosError(`SAP request failed with status ${response.status}`, undefined, undefined, undefined, response);
    };

    try {
      return await execute();
    } catch (error) {
      const axiosError = error as AxiosError;
      if (axiosError.response?.status === 401) {
        this.sessionId = undefined;
        this.routeId = undefined;
        await this.login();
        return execute();
      }
      const details = axiosError.response?.data ? JSON.stringify(axiosError.response.data) : axiosError.message;
      throw new Error(`SAP B1 request failed for ${method} ${path}: ${details}`);
    }
  }

  get<T>(path: string, params?: Record<string, unknown>): Promise<T> {
    return this.request<T>("GET", path, undefined, { params });
  }

  /** GET against the sml.svc base (not /b1s/v2 — sml.svc lives under /b1s/) */
  smlGet<T>(smlBase: string, viewPath: string, params?: Record<string, unknown>): Promise<T> {
    const fullUrl = `${smlBase}/sml.svc/${viewPath}`;
    return this.request<T>("GET", fullUrl, undefined, { params });
  }

  /** POST to sml.svc using namespace path (most reliable for analytics) */
  smlPost<T>(smlBase: string, viewPath: string, data: unknown): Promise<T> {
    const fullUrl = `${smlBase}/sml.svc/${viewPath}`;
    return this.request<T>("POST", fullUrl, data);
  }

  post<T>(path: string, data: unknown): Promise<T> {
    return this.request<T>("POST", path, data);
  }

  patch<T>(path: string, data: unknown): Promise<T> {
    return this.request<T>("PATCH", path, data);
  }

  /** Fetch all pages of an OData collection, following @odata.nextLink. */
  async getAll<T>(path: string, params: Record<string, unknown> = {}): Promise<T[]> {
    const results: T[] = [];
    let nextUrl: string | null = path;
    let isFirst = true;

    while (nextUrl) {
      const response: { value?: T[]; "@odata.nextLink"?: string } = isFirst
        ? await this.get(nextUrl, params)
        : await this.get(nextUrl);

      const page = Array.isArray(response.value) ? response.value : [];
      results.push(...page);
      nextUrl = response["@odata.nextLink"] ?? null;
      isFirst = false;
    }

    return results;
  }
}

let client: SapB1ServiceLayerClient;

async function getDocument<T>(entitySet: string, docEntry: number): Promise<T> {
  return client.get<T>(`/${entitySet}(${docEntry})`);
}

async function createSalesQuotation(args: unknown): Promise<ToolResponse> {
  const input = asObject(args, "arguments");
  const cardCode = asString(input.cardCode, "cardCode");
  const docDate = parseDateOrToday(input.docDate, "docDate");
  const docDueDate = parseDateOrToday(input.docDueDate, "docDueDate");
  const comments = optionalString(input.comments, "comments");
  const discountThresholdPct = optionalNumber(input.discountThresholdPct, "discountThresholdPct") ?? 10;

  const lines = asArray(input.lines, "lines").map((line, index) => {
    const item = asObject(line, `lines[${index}]`);
    return {
      ItemCode: asString(item.itemCode, `lines[${index}].itemCode`),
      Quantity: asNumber(item.quantity, `lines[${index}].quantity`),
      UnitPrice: optionalNumber(item.unitPrice, `lines[${index}].unitPrice`),
      DiscountPercent: optionalNumber(item.discountPercent, `lines[${index}].discountPercent`),
      TaxCode: optionalString(item.taxCode, `lines[${index}].taxCode`),
      WarehouseCode: optionalString(item.warehouseCode, `lines[${index}].warehouseCode`),
    };
  });

  const approvalReasons = lines
    .map((line, index) => ((line.DiscountPercent ?? 0) > discountThresholdPct ? `Line ${index} discount ${line.DiscountPercent}% exceeds threshold ${discountThresholdPct}%` : undefined))
    .filter((value): value is string => Boolean(value));

  const quotation = await client.post<JsonObject>("/Quotations", {
    CardCode: cardCode,
    DocDate: docDate,
    DocDueDate: docDueDate,
    Comments: comments,
    DocumentLines: lines,
  });

  return textResult({
    approvalRequired: approvalReasons.length > 0,
    approvalReasons,
    quotation: {
      DocEntry: quotation.DocEntry,
      DocNum: quotation.DocNum,
      CardCode: quotation.CardCode ?? cardCode,
      DocTotal: quotation.DocTotal,
      DocCurrency: quotation.DocCurrency,
    },
  });
}

async function createSalesOrder(args: unknown): Promise<ToolResponse> {
  const input = asObject(args, "arguments");
  // GPT-4o may pass non-numeric strings like "N/A" or "none" — treat those as absent
  const _rawQde = input.quotationDocEntry;
  const quotationDocEntry: number | undefined = (_rawQde == null)
    ? undefined
    : (typeof _rawQde === "number" && !Number.isNaN(_rawQde))
      ? _rawQde
      : (typeof _rawQde === "string" && _rawQde.trim() !== "" && !Number.isNaN(Number(_rawQde)))
        ? Number(_rawQde)
        : undefined;
  const docDate    = parseDateOrToday(input.docDate,    "docDate");
  const docDueDate = parseDateOrToday(input.docDueDate, "docDueDate");

  let cardCode: string;
  let creditLimit = 0, currentBalance = 0, ordersBalance = 0, orderTotal = 0;
  let orderLines: JsonObject[];
  let comments: string;

  if (quotationDocEntry != null) {
    // ── Path A: Convert existing quotation ──────────────────────────────────
    const quotation = await getDocument<JsonObject>("Quotations", quotationDocEntry);
    if (quotation.DocumentStatus === "bost_Close") {
      throw new McpError(ErrorCode.InvalidRequest, `Quotation ${quotationDocEntry} is already closed and cannot be converted.`);
    }
    cardCode = asString(quotation.CardCode, "quotation.CardCode");
    const bp = await client.get<JsonObject>(`/BusinessPartners(${encodeEntityKey(cardCode)})`);
    creditLimit    = toNumber(bp.CreditLimit);
    currentBalance = toNumber(bp.CurrentAccountBalance);
    ordersBalance  = toNumber(bp.OpenDeliveryNotesBalance) + toNumber(bp.OrdersBalance);
    orderTotal     = toNumber(quotation.DocTotal);
    orderLines = asArray(quotation.DocumentLines, "quotation.DocumentLines").map((line, index) => {
      const item = asObject(line, `quotation.DocumentLines[${index}]`);
      return {
        BaseType: BASE_DOCUMENT_TYPE.quotation,
        BaseEntry: quotationDocEntry,
        BaseLine: asNumber(item.LineNum, `quotation.DocumentLines[${index}].LineNum`),
        WarehouseCode: optionalString(item.WarehouseCode, "WarehouseCode"),
        TaxCode:       optionalString(item.TaxCode,       "TaxCode"),
      } as JsonObject;
    });
    comments = buildComment(["Created from quotation", `Quotation DocEntry ${quotationDocEntry}`]);

  } else {
    // ── Path B: Direct creation from cardCode + lines (PO→SO workflow) ──────
    cardCode = asString(input.cardCode, "cardCode");
    const rawLines = asArray(input.lines, "lines");
    const bp = await client.get<JsonObject>(`/BusinessPartners(${encodeEntityKey(cardCode)})`);
    creditLimit    = toNumber(bp.CreditLimit);
    currentBalance = toNumber(bp.CurrentAccountBalance);
    ordersBalance  = toNumber(bp.OpenDeliveryNotesBalance) + toNumber(bp.OrdersBalance);
    const rawItemLines = rawLines.map((line, index) => {
      const l = asObject(line, `lines[${index}]`);
      const lineObj: JsonObject = {
        ItemCode:      asString(l.itemCode ?? l.ItemCode, `lines[${index}].itemCode`),
        Quantity:      asNumber(l.quantity ?? l.Quantity ?? l.qty, `lines[${index}].quantity`),
        UnitPrice:     l.unitPrice ?? l.UnitPrice ?? l.price ?? 0,
      };
      if (l.warehouseCode ?? l.WarehouseCode) lineObj.WarehouseCode = l.warehouseCode ?? l.WarehouseCode;
      if (l.taxCode      ?? l.TaxCode)       lineObj.TaxCode        = l.taxCode      ?? l.TaxCode;
      if (l.description  ?? l.ItemDescription) lineObj.ItemDescription = l.description ?? l.ItemDescription;
      if (l.uomCode      ?? l.UoMCode)       lineObj.UoMCode        = l.uomCode      ?? l.UoMCode;
      orderTotal += toNumber(lineObj.UnitPrice) * toNumber(lineObj.Quantity);
      return lineObj;
    });
    const uomCodes = await Promise.all(
      rawItemLines.map((l) => (l.UoMCode ? Promise.resolve(l.UoMCode as string) : getDefaultUoMCode(l.ItemCode as string, "sales")))
    );
    orderLines = rawItemLines.map((l, index) => ({
      ...l,
      ...(uomCodes[index] ? { UoMCode: uomCodes[index] } : {}),
    }));
    const poRef = optionalString(input.poNumber ?? input.numAtCard, "poNumber");
    comments = buildComment(["Created from Purchase Order", poRef ? `PO Ref: ${poRef}` : ""]);
  }

  const projectedExposure = currentBalance + ordersBalance + orderTotal;
  if (creditLimit > 0 && projectedExposure > creditLimit) {
    return textResult({
      status: "BLOCKED_BY_CREDIT_LIMIT",
      cardCode, creditLimit, currentBalance, ordersBalance,
      orderTotal, projectedExposure,
    });
  }

  const payload: JsonObject = {
    CardCode: cardCode,
    DocDate:  docDate,
    DocDueDate: docDueDate,
    Comments: comments,
    DocumentLines: orderLines,
  };
  const requestedCurrency = optionalString(input.currency ?? input.docCurrency, "currency");
  if (requestedCurrency) payload.DocCurrency = requestedCurrency;
  if (optionalString(input.numAtCard ?? input.poNumber, "numAtCard"))
    payload.NumAtCard = input.numAtCard ?? input.poNumber;

  let order: JsonObject;
  try {
    order = await client.post<JsonObject>("/Orders", payload);
  } catch (error) {
    // This company DB rejects an explicit DocCur — neither the ISO code (e.g. "USD") nor
    // the "local currency" marker "##" validates against ORCR here, which means the company
    // isn't set up for multi-currency documents at all. Retry without DocCurrency so SAP
    // defaults the order to the BP's/company's own currency instead of us dictating one.
    // (Duplicate customer/vendor reference errors are intentionally left to propagate here —
    // the caller in chat-server.mjs's write-confirm flow already recovers from those generically.)
    const message = error instanceof Error ? error.message : String(error);
    if (requestedCurrency && payload.DocCurrency && /-5002|valid currency code/i.test(message)) {
      const { DocCurrency, ...payloadWithoutCurrency } = payload;
      order = await client.post<JsonObject>("/Orders", payloadWithoutCurrency);
    } else {
      throw error;
    }
  }

  return textResult({
    status: "CONFIRMED",
    salesOrder: {
      DocEntry:    order.DocEntry,
      DocNum:      order.DocNum,
      CardCode:    order.CardCode ?? cardCode,
      DocTotal:    order.DocTotal,
      DocCurrency: order.DocCurrency,
    },
    creditCheck: { creditLimit, currentBalance, ordersBalance, projectedExposure },
  });
}

async function checkAtp(args: unknown): Promise<ToolResponse> {
  const input = asObject(args, "arguments");
  const items = asArray(input.items, "items").map((entry, index) => {
    const item = asObject(entry, `items[${index}]`);
    return {
      itemCode: asString(item.itemCode, `items[${index}].itemCode`),
      warehouseCode: item.warehouseCode != null ? asString(item.warehouseCode, `items[${index}].warehouseCode`) : undefined,
      requiredQty: asNumber(item.requiredQty, `items[${index}].requiredQty`),
    };
  });

  const results = await Promise.all(items.map(async ({ itemCode, warehouseCode, requiredQty }) => {
    let itemData: JsonObject;
    try {
      itemData = await client.get<JsonObject>(`/Items(${encodeEntityKey(itemCode)})`, {
        $select: "ItemCode,ItemName,QuantityOnStock,QuantityOrderedFromVendors,QuantityOrderedByCustomers",
      });
    } catch {
      return { itemCode, warehouseCode, requiredQty, status: "ITEM_NOT_FOUND" };
    }

    const itemName = String(itemData.ItemName ?? "");
    const inStock = toNumber(itemData.QuantityOnStock);
    const committed = toNumber(itemData.QuantityOrderedByCustomers);
    const ordered = toNumber(itemData.QuantityOrderedFromVendors);
    const availableQty = inStock - committed + ordered;
    return {
      itemCode,
      itemName,
      ...(warehouseCode ? { warehouseCode, note: "Stock shown is total across all warehouses" } : {}),
      requiredQty,
      inStock,
      committed,
      onOrder: ordered,
      availableQty,
      status: availableQty >= requiredQty ? "CONFIRMED" : "BACKORDER",
      backOrderRequired: availableQty < requiredQty,
    };
  }));

  return textResult({ results });
}

type BinAllocation = {
  BinAbsEntry: number;
  Quantity: number;
  BaseLineNumber: number;
  SerialAndBatchNumbersBaseLine?: number;
};

type DeliveryLine = {
  BaseType: typeof BASE_DOCUMENT_TYPE.salesOrder;
  BaseEntry: number;
  BaseLine: number;
  Quantity: number;
  WarehouseCode: string | undefined;
  BatchNumbers?: Array<{ BatchNumber: string; Quantity: number }>;
  DocumentLinesBinAllocations?: BinAllocation[];
};

async function resolveBinAllocations(
  itemCode: string,
  warehouseCode: string,
  requiredQty: number
): Promise<Pick<DeliveryLine, "BatchNumbers" | "DocumentLinesBinAllocations">> {
  // Check if warehouse uses bin locations
  const wh = await client.get<JsonObject>(`/Warehouses('${warehouseCode.replace(/'/g, "''")}')`);
  if (wh.EnableBinLocations !== "tYES") return {};

  // Query batches FIFO (oldest admission date first)
  const batchResp = await client.get<{ value?: JsonObject[] }>("/BatchNumberDetails", {
    $filter: `ItemCode eq '${itemCode.replace(/'/g, "''")}' and WhsCode eq '${warehouseCode.replace(/'/g, "''")}'`,
    $orderby: "AdmissionDate asc",
    $select: "BatchNumber,Quantity,AdmissionDate,BinAbsEntry",
  });
  const batches = (Array.isArray(batchResp.value) ? batchResp.value : []).filter(
    (b) => toNumber(b.Quantity) > 0
  );

  if (batches.length > 0) {
    // Batch + bin: allocate FIFO
    let remaining = requiredQty;
    const batchNumbers: Array<{ BatchNumber: string; Quantity: number }> = [];
    const binAllocations: BinAllocation[] = [];
    let batchLine = 0;

    for (const batch of batches) {
      if (remaining <= 0) break;
      const allocQty = Math.min(toNumber(batch.Quantity), remaining);
      batchNumbers.push({ BatchNumber: String(batch.BatchNumber), Quantity: allocQty });
      if (batch.BinAbsEntry) {
        binAllocations.push({
          BinAbsEntry: toNumber(batch.BinAbsEntry),
          Quantity: allocQty,
          BaseLineNumber: 0,
          SerialAndBatchNumbersBaseLine: batchLine,
        });
      }
      batchLine++;
      remaining -= allocQty;
    }

    if (remaining > 0) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        `Insufficient batch stock for item ${itemCode} in warehouse ${warehouseCode}. Short by ${remaining} units.`
      );
    }
    return { BatchNumbers: batchNumbers, DocumentLinesBinAllocations: binAllocations };
  }

  // Bin-managed, no batches: allocate across active bins ordered by bin code (FIFO location order)
  const binResp = await client.get<{ value?: JsonObject[] }>("/BinLocations", {
    $filter: `WarehouseCode eq '${warehouseCode.replace(/'/g, "''")}' and Inactive eq 'tNO'`,
    $select: "AbsEntry,BinCode",
    $orderby: "BinCode asc",
  });
  const bins = Array.isArray(binResp.value) ? binResp.value : [];

  if (bins.length === 0) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      `No active bin locations found in warehouse ${warehouseCode}.`
    );
  }

  // Allocate entire quantity to the first bin (SAP validates bin stock server-side)
  return {
    DocumentLinesBinAllocations: [
      { BinAbsEntry: toNumber(bins[0].AbsEntry), Quantity: requiredQty, BaseLineNumber: 0 },
    ],
  };
}

async function createDelivery(args: unknown): Promise<ToolResponse> {
  const input = asObject(args, "arguments");
  const salesOrderDocEntry = asNumber(input.salesOrderDocEntry, "salesOrderDocEntry");
  const scheduledDate = parseDateOrToday(input.scheduledDate, "scheduledDate");
  const carrierName = optionalString(input.carrierName, "carrierName");
  const trackingNumber = optionalString(input.trackingNumber, "trackingNumber");

  const order = await getDocument<JsonObject>("Orders", salesOrderDocEntry);

  if (order.DocumentStatus === "bost_Close") {
    throw new McpError(ErrorCode.InvalidRequest, `Sales order ${salesOrderDocEntry} is already closed and cannot be delivered.`);
  }

  const rawLines = asArray(order.DocumentLines, "order.DocumentLines");
  const deliveryLines: DeliveryLine[] = [];

  for (let index = 0; index < rawLines.length; index++) {
    const item = asObject(rawLines[index], `order.DocumentLines[${index}]`);
    const openQuantity = toNumber(item.RemainingOpenQuantity ?? item.OpenQuantity);
    if (openQuantity <= 0) continue;

    const warehouseCode = optionalString(item.WarehouseCode, "WarehouseCode");
    const itemCode = String(item.ItemCode ?? "");
    const baseLine: DeliveryLine = {
      BaseType: BASE_DOCUMENT_TYPE.salesOrder,
      BaseEntry: salesOrderDocEntry,
      BaseLine: asNumber(item.LineNum, `order.DocumentLines[${index}].LineNum`),
      Quantity: openQuantity,
      WarehouseCode: warehouseCode,
    };

    if (warehouseCode && itemCode) {
      const allocations = await resolveBinAllocations(itemCode, warehouseCode, openQuantity);
      Object.assign(baseLine, allocations);
    }

    deliveryLines.push(baseLine);
  }

  if (deliveryLines.length === 0) {
    throw new McpError(ErrorCode.InvalidRequest, "No open sales order lines are available for delivery.");
  }

  const delivery = await client.post<JsonObject>("/DeliveryNotes", {
    CardCode: order.CardCode,
    DocDate: scheduledDate,
    Comments: buildComment([
      `Created from sales order ${salesOrderDocEntry}`,
      carrierName ? `Carrier ${carrierName}` : undefined,
      trackingNumber ? `Tracking ${trackingNumber}` : undefined,
    ]),
    DocumentLines: deliveryLines,
  });

  return textResult({
    delivery: {
      DocEntry: delivery.DocEntry,
      DocNum: delivery.DocNum,
      CardCode: delivery.CardCode ?? order.CardCode,
      scheduledDate,
      carrierName,
      trackingNumber,
    },
  });
}

async function getPickList(args: unknown): Promise<ToolResponse> {
  const input = asObject(args, "arguments");
  const salesOrderDocEntry = asNumber(input.salesOrderDocEntry, "salesOrderDocEntry");

  const pickLists = await client.getAll<JsonObject>("/PickLists", {
    $select: "Absoluteentry,Name,PickDate,Status",
    $expand: "PickListsLines",
  });

  const matched = pickLists
    .map((pickList) => {
      const rawLines = Array.isArray(pickList.PickListsLines) ? pickList.PickListsLines : [];
      const lines = rawLines
        .map((line) => asObject(line, "pickListLine"))
        .filter((line) => toNumber(line.OrderEntry) === salesOrderDocEntry)
        .map((line) => ({
          orderEntry: toNumber(line.OrderEntry),
          orderRowId: toNumber(line.OrderRowID),
          itemCode: line.ItemCode,
          releasedQuantity: toNumber(line.ReleasedQuantity),
          pickedQuantity: toNumber(line.PickedQuantity),
          binLocation: line.BinCode ?? line.BinLocation ?? line.BinAbsEntry ?? "N/A",
        }))
        .sort((a, b) => String(a.binLocation).localeCompare(String(b.binLocation)));

      return {
        pickListId: pickList.Absoluteentry,
        status: pickList.Status,
        pickDate: pickList.PickDate,
        lines,
      };
    })
    .filter((pickList) => pickList.lines.length > 0);

  return textResult({ salesOrderDocEntry, pickLists: matched });
}

async function confirmDeliveryPod(args: unknown): Promise<ToolResponse> {
  const input = asObject(args, "arguments");
  const deliveryDocEntry = asNumber(input.deliveryDocEntry, "deliveryDocEntry");
  const podReference = asString(input.podReference, "podReference");
  const exceptions = optionalString(input.exceptions, "exceptions");

  const delivery = await getDocument<JsonObject>("DeliveryNotes", deliveryDocEntry);
  const currentComments = typeof delivery.Comments === "string" ? delivery.Comments.trim() : "";
  const updatedComments = [
    currentComments,
    buildComment([`POD ${podReference}`, exceptions ? `Exceptions ${exceptions}` : "POD confirmed"]),
  ]
    .filter(Boolean)
    .join(" | ");

  await client.patch(`/DeliveryNotes(${deliveryDocEntry})`, { Comments: updatedComments });

  return textResult({
    deliveryDocEntry,
    podConfirmed: true,
    podReference,
    exceptions: exceptions ?? null,
  });
}

async function createArInvoice(args: unknown): Promise<ToolResponse> {
  const input = asObject(args, "arguments");
  const deliveryDocEntry = asNumber(input.deliveryDocEntry, "deliveryDocEntry");
  const dueInDays = optionalNumber(input.dueInDays, "dueInDays") ?? 30;
  const docDateText = parseDateOrToday(input.docDate, "docDate");
  const docDate = new Date(docDateText);
  const dueDate = new Date(docDate.getTime());
  dueDate.setDate(dueDate.getDate() + dueInDays);

  const delivery = await getDocument<JsonObject>("DeliveryNotes", deliveryDocEntry);
  const invoiceLines = asArray(delivery.DocumentLines, "delivery.DocumentLines").map((line, index) => {
    const item = asObject(line, `delivery.DocumentLines[${index}]`);
    return {
      BaseType: BASE_DOCUMENT_TYPE.delivery,
      BaseEntry: deliveryDocEntry,
      BaseLine: asNumber(item.LineNum, `delivery.DocumentLines[${index}].LineNum`),
    };
  });

  const invoice = await client.post<JsonObject>("/Invoices", {
    CardCode: delivery.CardCode,
    DocDate: docDate.toISOString().slice(0, 10),
    DocDueDate: dueDate.toISOString().slice(0, 10),
    TaxDate: docDate.toISOString().slice(0, 10),
    Comments: buildComment([`Created from delivery ${deliveryDocEntry}`, `Due in ${dueInDays} days`]),
    DocumentLines: invoiceLines,
  });

  return textResult({
    invoice: {
      DocEntry: invoice.DocEntry,
      DocNum: invoice.DocNum,
      CardCode: invoice.CardCode ?? delivery.CardCode,
      DocTotal: invoice.DocTotal,
      VatSum: invoice.VatSum,
      DocDueDate: invoice.DocDueDate ?? dueDate.toISOString().slice(0, 10),
    },
  });
}

async function applyIncomingPayment(args: unknown): Promise<ToolResponse> {
  const input = asObject(args, "arguments");
  const cardCode = asString(input.cardCode, "cardCode");
  const amount = asNumber(input.amount, "amount");
  const invoiceDocEntries = asArray(input.invoiceDocEntries, "invoiceDocEntries").map((entry, index) =>
    asNumber(entry, `invoiceDocEntries[${index}]`)
  );
  const cashAccount = optionalString(input.cashAccount, "cashAccount");
  const transferAccount = optionalString(input.transferAccount, "transferAccount");
  const transferReference = optionalString(input.transferReference, "transferReference");

  if (!cashAccount && !transferAccount) {
    throw new McpError(ErrorCode.InvalidParams, "Provide either cashAccount or transferAccount so SAP can post the incoming payment.");
  }

  const invoices = await Promise.all(invoiceDocEntries.map((docEntry) => getDocument<JsonObject>("Invoices", docEntry)));

  // Calculate open balance per invoice, then distribute the payment amount proportionally
  const openBalances = invoices.map((invoice) => ({
    DocEntry: invoice.DocEntry as number,
    openBalance: toNumber(invoice.DocTotal) - toNumber(invoice.PaidToDate),
  }));

  const totalOpen = openBalances.reduce((sum, inv) => sum + inv.openBalance, 0);

  if (totalOpen <= 0) {
    throw new McpError(ErrorCode.InvalidRequest, "All specified invoices are already fully paid.");
  }

  // Pro-rate the payment across invoices; cap each at its open balance
  let remaining = amount;
  const paymentInvoices = openBalances.map(({ DocEntry, openBalance }) => {
    const proportional = totalOpen > 0 ? (openBalance / totalOpen) * amount : 0;
    const sumApplied = Math.min(proportional, openBalance, remaining);
    remaining -= sumApplied;
    return {
      DocEntry,
      SumApplied: Math.round(sumApplied * 100) / 100,
      InvoiceType: "it_Invoice",
    };
  });

  const payload: JsonObject = {
    CardCode: cardCode,
    DocDate: parseDateOrToday(input.docDate, "docDate"),
    TransferDate: parseDateOrToday(input.docDate, "docDate"),
    Remarks: optionalString(input.remarks, "remarks") ?? "Applied by MCP payment agent",
    PaymentInvoices: paymentInvoices,
  };

  if (cashAccount) {
    payload.CashAccount = cashAccount;
    payload.CashSum = amount;
  }

  if (transferAccount) {
    payload.TransferAccount = transferAccount;
    payload.TransferSum = amount;
    if (transferReference) payload.TransferReference = transferReference;
  }

  const payment = await client.post<JsonObject>("/IncomingPayments", payload);

  return textResult({
    payment: {
      DocEntry: payment.DocEntry,
      DocNum: payment.DocNum,
      CardCode: payment.CardCode ?? cardCode,
      TransferSum: payment.TransferSum,
      CashSum: payment.CashSum,
    },
    clearedInvoices: paymentInvoices,
  });
}

async function getTotalStock(args: unknown): Promise<ToolResponse> {
  const input = asObject(args ?? {}, "arguments");
  const search = optionalString(input.search, "search");
  const inStockOnly = input.inStockOnly === true;
  const topN = optionalNumber(input.topN, "topN"); // undefined = return ALL items

  const filters: string[] = ["ItemType eq 'itItems'", "Frozen eq 'tNO'"];
  if (search) {
    const escaped = search.replace(/'/g, "''");
    filters.push(`(contains(ItemCode,'${escaped}') or contains(ItemName,'${escaped}'))`);
  }
  if (inStockOnly) filters.push("QuantityOnStock gt 0");

  // Fetch ALL items — Prefer: odata.maxpagesize=0 is set globally on the client
  // getAll follows @odata.nextLink as a safety net if SAP still paginates
  let items = await client.getAll<JsonObject>("/Items", {
    $select: "ItemCode,ItemName,QuantityOnStock,QuantityOrderedFromVendors,QuantityOrderedByCustomers,MinInventory,PurchaseUnit,SalesUnit",
    $filter: filters.join(" and "),
    $orderby: "ItemName asc",
  });

  // Apply topN only when caller explicitly requests a slice
  if (topN != null && topN > 0) items = items.slice(0, topN);

  const totalOnStock = items.reduce((sum, item) => sum + toNumber(item.QuantityOnStock), 0);
  const totalCommitted = items.reduce((sum, item) => sum + toNumber(item.QuantityOrderedByCustomers), 0);
  const totalOnOrder = items.reduce((sum, item) => sum + toNumber(item.QuantityOrderedFromVendors), 0);
  const totalAvailable = totalOnStock - totalCommitted + totalOnOrder;

  return textResult({
    summary: {
      itemCount: items.length,
      totalOnStock,
      totalCommitted,
      totalOnOrder,
      totalAvailable,
    },
    items: items.map((item) => {
      const onStock = toNumber(item.QuantityOnStock);
      const committed = toNumber(item.QuantityOrderedByCustomers);
      const onOrder = toNumber(item.QuantityOrderedFromVendors);
      return {
        itemCode: item.ItemCode,
        itemName: item.ItemName,
        onStock,
        committed,
        onOrder,
        available: onStock - committed + onOrder,
        minInventory: toNumber(item.MinInventory),
        belowMin: onStock < toNumber(item.MinInventory),
        unit: item.SalesUnit ?? item.PurchaseUnit ?? null,
      };
    }),
  });
}

async function getCustomerList(args: unknown): Promise<ToolResponse> {
  const input = asObject(args ?? {}, "arguments");
  const search = optionalString(input.search, "search");
  const activeOnly = input.activeOnly !== false; // defaults to true
  const topN = optionalNumber(input.topN, "topN") ?? 50;

  const filters: string[] = ["CardType eq 'cCustomer'"];
  if (activeOnly) filters.push("Frozen eq 'tNO'");
  if (search) {
    const escaped = search.replace(/'/g, "''");
    filters.push(`(contains(CardCode,'${escaped}') or contains(CardName,'${escaped}'))`);
  }

  const params: Record<string, unknown> = {
    $select: "CardCode,CardName,CardType,Phone1,EmailAddress,CurrentAccountBalance,CreditLimit,Currency,Frozen,City,Country",
    $filter: filters.join(" and "),
    $top: topN,
    $orderby: "CardName asc",
  };

  const response = await client.get<{ value?: JsonObject[] }>("/BusinessPartners", params);
  const customers = Array.isArray(response.value) ? response.value : [];

  return textResult({
    total: customers.length,
    customers: customers.map((bp) => ({
      cardCode: bp.CardCode,
      cardName: bp.CardName,
      phone: bp.Phone1 ?? null,
      email: bp.EmailAddress ?? null,
      city: bp.City ?? null,
      country: bp.Country ?? null,
      currency: bp.Currency ?? null,
      currentBalance: toNumber(bp.CurrentAccountBalance),
      creditLimit: toNumber(bp.CreditLimit),
      frozen: bp.Frozen === "tYES",
    })),
  });
}

async function getCollectionsWorklist(args: unknown): Promise<ToolResponse> {
  const input = asObject(args ?? {}, "arguments");
  const overdueMoreThanDays = optionalNumber(input.overdueMoreThanDays, "overdueMoreThanDays") ?? 30;
  const topN = optionalNumber(input.topN, "topN") ?? 10;
  const asOfDate = new Date(parseDateOrToday(input.asOfDate, "asOfDate"));
  const asOfDateStr = asOfDate.toISOString().slice(0, 10);

  // Server-side filter: open invoices due before asOfDate
  const allInvoices = await client.getAll<JsonObject>("/Invoices", {
    $select: "DocEntry,DocNum,CardCode,CardName,DocDueDate,DocTotal,PaidToDate,DocumentStatus",
    $filter: `DocumentStatus eq 'bost_Open' and DocDueDate le '${asOfDateStr}'`,
  });

  const invoices = allInvoices
    .map((invoice) => {
      const dueDate = new Date(asString(invoice.DocDueDate, "DocDueDate"));
      const outstanding = toNumber(invoice.DocTotal) - toNumber(invoice.PaidToDate);
      const overdueDays = Math.floor((asOfDate.getTime() - dueDate.getTime()) / 86400000);
      const riskScore = outstanding > 0 && overdueDays > 0 ? outstanding * Math.log(overdueDays + 1) : 0;
      return {
        docEntry: toNumber(invoice.DocEntry),
        docNum: toNumber(invoice.DocNum),
        cardCode: asString(invoice.CardCode, "CardCode"),
        cardName: asString(invoice.CardName, "CardName"),
        dueDate: dueDate.toISOString().slice(0, 10),
        outstanding,
        overdueDays,
        riskScore,
        documentStatus: invoice.DocumentStatus,
      };
    })
    .filter((invoice) => invoice.outstanding > 0)
    .filter((invoice) => invoice.overdueDays > overdueMoreThanDays);

  type WorklistInvoice = (typeof invoices)[number];
  type WorklistCustomer = {
    cardCode: string;
    cardName: string;
    totalOutstanding: number;
    totalRiskScore: number;
    invoices: WorklistInvoice[];
  };

  const grouped = new Map<string, WorklistCustomer>();
  for (const invoice of invoices) {
    const existing = grouped.get(invoice.cardCode) ?? {
      cardCode: invoice.cardCode,
      cardName: invoice.cardName,
      totalOutstanding: 0,
      totalRiskScore: 0,
      invoices: [],
    };
    existing.totalOutstanding += invoice.outstanding;
    existing.totalRiskScore += invoice.riskScore;
    existing.invoices.push(invoice);
    grouped.set(invoice.cardCode, existing);
  }

  const customers = [...grouped.values()]
    .sort((a, b) => b.totalRiskScore - a.totalRiskScore)
    .slice(0, topN)
    .map((customer) => ({ ...customer, dunningRecommended: customer.totalRiskScore > 0 }));

  return textResult({ asOfDate: asOfDateStr, overdueMoreThanDays, topN, customers });
}

// ─────────────────────────────────────────────────────────────────────────────
// ANALYTICAL TOOLS
// ─────────────────────────────────────────────────────────────────────────────

// ObjType values in SalesAnalysisQuery (SMLSVC returns all doc types together)
const DOC_TYPE_OBJTYPE: Record<string, number> = {
  invoice: 13, credit_memo: 14, return: 16, order: 17, delivery: 23,
};

async function getSalesAnalysis(args: unknown): Promise<ToolResponse> {
  const input    = asObject(args ?? {}, "arguments");
  const { fromDate: defFrom, toDate: defTo } = ytdRange();
  const fromDate = optionalString(input.fromDate, "fromDate") ?? defFrom;
  const toDate   = optionalString(input.toDate,   "toDate")   ?? defTo;
  const groupBy  = optionalString(input.groupBy,  "groupBy")  ?? "BusinessPartnerCode,BusinessPartnerName";
  const topN     = optionalNumber(input.topN,     "topN")     ?? 50;
  const cardCode = optionalString(input.cardCode, "cardCode");
  const itemCode = optionalString(input.itemCode, "itemCode");
  const orderBy  = optionalString(input.orderBy,  "orderBy")  ?? "NetSalesAmountLC desc";
  const docType  = optionalString(input.docType,  "docType");  // "order"|"invoice"|"delivery" etc.

  // HANA CogsOcr* fields → SL DocumentLines CostingCode* equivalents
  const HANA_TO_SL: Record<string, string> = {
    CogsOcrCod: "CostingCode",  CogsOcrCo2: "CostingCode2",
    CogsOcrCo3: "CostingCode3", CogsOcrCo4: "CostingCode4", CogsOcrCo5: "CostingCode5",
  };
  const SL_DOC_ENDPOINT: Record<string, string> = {
    order: "/Orders", delivery: "/DeliveryNotes", credit_memo: "/CreditNotes", return: "/Returns",
  };

  const groupFields = groupBy.split(",").map(s => s.trim());
  const needsSLFallback = docType && SL_DOC_ENDPOINT[docType] &&
    groupFields.some(f => HANA_TO_SL[f]);

  // ── Path A: Sales Orders / Deliveries grouped by brand — use SL directly ──
  // SalesAnalysisQuery (SMLSVC) is an AR Invoice view; ObjType 17/23 may not appear.
  // Service Layer /Orders + DocumentLines(CostingCode) is the reliable source.
  if (needsSLFallback) {
    const endpoint = SL_DOC_ENDPOINT[docType!];
    const slFields = groupFields.map(f => HANA_TO_SL[f] ?? f);
    const filter   = [`DocDate ge '${fromDate}' and DocDate le '${toDate}'`,
      cardCode ? `CardCode eq '${cardCode.replace(/'/g,"''")}'` : "",
    ].filter(Boolean).join(" and ");
    const docs = await client.getAll<JsonObject>(endpoint, {
      $filter: filter,
      $expand: `DocumentLines($select=${[...new Set(slFields)].join(",")},LineTotal,Quantity)`,
      $select: "DocEntry,DocDate,DocNum,CardCode,CardName",
    });
    // Flatten lines and map SL field names back to HANA names for aggregation
    const flatRows: JsonObject[] = [];
    for (const doc of docs) {
      for (const line of (doc["DocumentLines"] as JsonObject[] | undefined ?? [])) {
        const row: JsonObject = { CardCode: doc["CardCode"], CardName: doc["CardName"],
          DocNum: doc["DocNum"], DocDate: doc["DocDate"] };
        for (const hana of groupFields) {
          row[hana] = (HANA_TO_SL[hana] ? line[HANA_TO_SL[hana]] : line[hana]) ?? "(none)";
        }
        row["NetSalesAmountLC"]       = toNumber(line["LineTotal"]);
        row["QuantityInInventoryUoM"] = toNumber(line["Quantity"]);
        row["GrossProfitLC"]          = 0;
        flatRows.push(row);
      }
    }

    const docCount = docs.length;
    if (docCount === 0) {
      return textResult({ rows: [], fromDate, toDate, docType, count: 0,
        source: `Service Layer ${endpoint}`,
        diagnostic: `No ${docType} documents found between ${fromDate} and ${toDate}. Verify the date range contains actual SAP B1 sales orders.` });
    }

    let aggregated = aggregateRows(flatRows, groupFields);
    // Check if all brand values are empty — means CostingCode not set on order lines
    const noBrandData = aggregated.every(r => String(r["CogsOcrCod"] ?? r[groupFields[0]] ?? "").trim() === "(none)" || String(r[groupFields[0]] ?? "").trim() === "");
    const [sf, sd] = orderBy.split(" ");
    aggregated = sortLimitRows(aggregated, sf, sd === "asc" ? "asc" : "desc", topN);
    return textResult({ rows: aggregated, fromDate, toDate, docType, count: aggregated.length,
      documentCount: docCount,
      source: `Service Layer ${endpoint} + DocumentLines (CostingCode)`,
      brandFieldNote: noBrandData
        ? `WARNING: ${docCount} orders found but CostingCode (Brand) is not assigned on any order lines. Ask SAP B1 admin to set CostingCode on sales order lines, or group by customer/item instead.`
        : `Brand data from DocumentLines.CostingCode. GP not available via this source.` });
  }

  // ── Path B: SMLSVC POST (AR Invoices / all types) ─────────────────────────
  const paramList = buildParamList({ fromDate, toDate, cardCode, itemCode });
  let rows = await callSMLSVC("sales", paramList, activeCompany);

  // Client-side ObjType filter
  if (docType && DOC_TYPE_OBJTYPE[docType] != null) {
    const objType = DOC_TYPE_OBJTYPE[docType];
    rows = rows.filter(r => Number(r["ObjType"]) === objType);
  }

  let aggregated = aggregateRows(rows, groupFields);
  const [sf, sd] = orderBy.split(" ");
  aggregated = sortLimitRows(aggregated, sf, sd === "asc" ? "asc" : "desc", topN);
  return textResult({ rows: aggregated, fromDate, toDate, docType: docType ?? "all", count: aggregated.length });
}

async function getPurchaseAnalysis(args: unknown): Promise<ToolResponse> {
  const input    = asObject(args ?? {}, "arguments");
  const year     = new Date().getFullYear();
  const fromDate = optionalString(input.fromDate, "fromDate") ?? `${year}-01-01`;
  const toDate   = optionalString(input.toDate, "toDate") ?? new Date().toISOString().slice(0, 10);
  const topN     = optionalNumber(input.topN, "topN") ?? 20;

  const invoices = await client.getAll<JsonObject>("/PurchaseInvoices", {
    $select: "CardCode,CardName,DocDate,DocTotal,DocNum",
    $filter: `DocDate ge '${fromDate}' and DocDate le '${toDate}'`,
    $orderby: "DocDate desc",
  });

  const map = new Map<string, { cardCode: string; cardName: string; total: number; count: number }>();
  for (const inv of invoices) {
    const key = String(inv.CardCode ?? "");
    const e = map.get(key) ?? { cardCode: key, cardName: String(inv.CardName ?? ""), total: 0, count: 0 };
    e.total += toNumber(inv.DocTotal);
    e.count++;
    map.set(key, e);
  }
  const vendors = [...map.values()].sort((a, b) => b.total - a.total).slice(0, topN);
  return textResult({ fromDate, toDate, vendors, totalInvoices: invoices.length });
}

async function getArAging(args: unknown): Promise<ToolResponse> {
  const input     = asObject(args ?? {}, "arguments");
  const asOfDate  = new Date(parseDateOrToday(input.asOfDate, "asOfDate"));
  const asOfStr   = asOfDate.toISOString().slice(0, 10);

  const invoices = await client.getAll<JsonObject>("/Invoices", {
    $select: "CardCode,CardName,DocNum,DocDueDate,DocTotal,PaidToDate",
    $filter: "DocumentStatus eq 'bost_Open'",
  });

  const buckets = { current: 0, days1_30: 0, days31_60: 0, days61_90: 0, over90: 0, total: 0 };
  const rows: JsonObject[] = [];

  for (const inv of invoices) {
    const outstanding = toNumber(inv.DocTotal) - toNumber(inv.PaidToDate);
    if (outstanding <= 0) continue;
    const due = new Date(String(inv.DocDueDate));
    const days = Math.floor((asOfDate.getTime() - due.getTime()) / 86_400_000);
    if (days <= 0) buckets.current += outstanding;
    else if (days <= 30) buckets.days1_30 += outstanding;
    else if (days <= 60) buckets.days31_60 += outstanding;
    else if (days <= 90) buckets.days61_90 += outstanding;
    else buckets.over90 += outstanding;
    buckets.total += outstanding;
    rows.push({ cardCode: inv.CardCode, cardName: inv.CardName, docNum: inv.DocNum,
      dueDate: String(inv.DocDueDate).slice(0, 10), outstanding, overdueDays: days });
  }

  rows.sort((a, b) => toNumber(b.outstanding) - toNumber(a.outstanding));
  return textResult({ asOfDate: asOfStr, buckets, invoices: rows });
}

async function getApAging(args: unknown): Promise<ToolResponse> {
  const input     = asObject(args ?? {}, "arguments");
  const asOfDate  = new Date(parseDateOrToday(input.asOfDate, "asOfDate"));
  const asOfStr   = asOfDate.toISOString().slice(0, 10);

  const invoices = await client.getAll<JsonObject>("/PurchaseInvoices", {
    $select: "CardCode,CardName,DocNum,DocDueDate,DocTotal,PaidToDate",
    $filter: "DocumentStatus eq 'bost_Open'",
  });

  const buckets = { current: 0, days1_30: 0, days31_60: 0, days61_90: 0, over90: 0, total: 0 };
  const rows: JsonObject[] = [];

  for (const inv of invoices) {
    const outstanding = toNumber(inv.DocTotal) - toNumber(inv.PaidToDate);
    if (outstanding <= 0) continue;
    const due = new Date(String(inv.DocDueDate));
    const days = Math.floor((asOfDate.getTime() - due.getTime()) / 86_400_000);
    if (days <= 0) buckets.current += outstanding;
    else if (days <= 30) buckets.days1_30 += outstanding;
    else if (days <= 60) buckets.days31_60 += outstanding;
    else if (days <= 90) buckets.days61_90 += outstanding;
    else buckets.over90 += outstanding;
    buckets.total += outstanding;
    rows.push({ cardCode: inv.CardCode, cardName: inv.CardName, docNum: inv.DocNum,
      dueDate: String(inv.DocDueDate).slice(0, 10), outstanding, overdueDays: days });
  }

  rows.sort((a, b) => toNumber(b.outstanding) - toNumber(a.outstanding));
  return textResult({ asOfDate: asOfStr, buckets, invoices: rows });
}

async function getWarehouseList(args: unknown): Promise<ToolResponse> {
  const input  = asObject(args ?? {}, "arguments");
  const search = optionalString(input.search, "search");

  const filters = ["Inactive eq 'tNO'"];
  if (search) {
    const esc = search.replace(/'/g, "''");
    filters.push(`(contains(WarehouseCode,'${esc}') or contains(WarehouseName,'${esc}'))`);
  }
  const response = await client.get<{ value?: JsonObject[] }>("/Warehouses", {
    $select: "WarehouseCode,WarehouseName,Location,BinLocationEnabled",
    $filter: filters.join(" and "),
    $orderby: "WarehouseCode asc",
  });

  const warehouses = (response.value ?? []).map((w) => ({
    warehouseCode: w.WarehouseCode,
    warehouseName: w.WarehouseName,
    location: w.Location ?? "",
    binLocationEnabled: w.BinLocationEnabled === "tYES",
  }));

  return textResult({ warehouses });
}

async function getVendorList(args: unknown): Promise<ToolResponse> {
  const input  = asObject(args ?? {}, "arguments");
  const search = optionalString(input.search, "search");
  const topN   = optionalNumber(input.topN, "topN") ?? 50;

  const filters = ["CardType eq 'cSupplier'", "Frozen eq 'tNO'"];
  if (search) {
    const esc = search.replace(/'/g, "''");
    filters.push(`(contains(CardCode,'${esc}') or contains(CardName,'${esc}'))`);
  }
  const response = await client.get<{ value?: JsonObject[] }>("/BusinessPartners", {
    $select: "CardCode,CardName,Phone1,EmailAddress,CurrentAccountBalance,Currency,City,Country",
    $filter: filters.join(" and "),
    $top: topN,
    $orderby: "CardName asc",
  });
  return textResult({ vendors: Array.isArray(response.value) ? response.value : [] });
}

async function getOpenOrders(args: unknown): Promise<ToolResponse> {
  const input    = asObject(args ?? {}, "arguments");
  const topN     = optionalNumber(input.topN, "topN") ?? 50;
  const cardCode = optionalString(input.cardCode, "cardCode");

  const filters = ["DocumentStatus eq 'bost_Open'"];
  if (cardCode) filters.push(`CardCode eq '${cardCode.replace(/'/g, "''")}'`);

  const response = await client.get<{ value?: JsonObject[] }>("/Orders", {
    $select: "DocEntry,DocNum,CardCode,CardName,DocDate,DocDueDate,DocTotal,DocCurrency",
    $filter: filters.join(" and "),
    $top: topN,
    $orderby: "DocDate desc",
  });
  return textResult({ orders: Array.isArray(response.value) ? response.value : [] });
}

async function getOpenQuotations(args: unknown): Promise<ToolResponse> {
  const input    = asObject(args ?? {}, "arguments");
  const topN     = optionalNumber(input.topN, "topN") ?? 50;
  const cardCode = optionalString(input.cardCode, "cardCode");

  const filters = ["DocumentStatus eq 'bost_Open'"];
  if (cardCode) filters.push(`CardCode eq '${cardCode.replace(/'/g, "''")}'`);

  const response = await client.get<{ value?: JsonObject[] }>("/Quotations", {
    $select: "DocEntry,DocNum,CardCode,CardName,DocDate,DocDueDate,DocTotal,DocCurrency",
    $filter: filters.join(" and "),
    $top: topN,
    $orderby: "DocDate desc",
  });
  return textResult({ quotations: Array.isArray(response.value) ? response.value : [] });
}

// ─────────────────────────────────────────────────────────────────────────────
// GENERIC SERVICE LAYER TOOL — covers ALL SAP B1 REST endpoints
// Claude uses this to call any /b1s/v1/* endpoint not covered by specific tools
// ─────────────────────────────────────────────────────────────────────────────

async function callServiceLayer(args: unknown): Promise<ToolResponse> {
  const input    = asObject(args, "arguments");
  const method   = asString(input.method,   "method").toUpperCase();
  const endpoint = asString(input.endpoint, "endpoint");

  if (!["GET","POST","PATCH","DELETE"].includes(method))
    throw new McpError(ErrorCode.InvalidParams, `method must be GET | POST | PATCH | DELETE, got: ${method}`);

  // Safety guard: block any non-b1s paths
  const safePath = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;

  let data: unknown;
  if (method === "GET") {
    const params = (input.params && typeof input.params === "object" && !Array.isArray(input.params))
      ? input.params as Record<string, unknown>
      : {};
    data = await client.get(safePath, params);
  } else if (method === "POST") {
    data = await client.post(safePath, input.body ?? {});
  } else if (method === "PATCH") {
    data = await client.patch(safePath, input.body ?? {});
  } else {
    // DELETE
    data = await client.request("DELETE", safePath);
  }

  return textResult(data);
}

// ─────────────────────────────────────────────────────────────────────────────
// DIRECT SQL SERVER ACCESS (bypasses Service Layer — read-only)
// Lets an AI generate T-SQL against the SAP B1 database itself. Useful when
// Service Layer is unavailable/misconfigured for a company but the underlying
// SQL Server is reachable directly.
// ─────────────────────────────────────────────────────────────────────────────

const SAP_B1_SQL_SCHEMA = `
SAP Business One key tables (T-SQL / MSSQL):

SALES & QUOTATIONS:
  OQUT(DocEntry,DocNum,CardCode,CardName,SlpCode,DocDate,DocDueDate,DocTotal,GrossProfit,DocStatus,Comments)
  QUT1(DocEntry,LineNum,ItemCode,Dscription,Quantity,Price,LineTotal,WhsCode,GrssProfit)
  ORDR(DocEntry,DocNum,CardCode,CardName,SlpCode,DocDate,DocDueDate,DocTotal,GrossProfit,DocStatus,Comments)
  RDR1(DocEntry,LineNum,ItemCode,Dscription,Quantity,Price,LineTotal,WhsCode,GrssProfit)

AR INVOICES & DELIVERY:
  OINV(DocEntry,DocNum,CardCode,CardName,SlpCode,DocDate,DocDueDate,DocTotal,GrossProfit,PaidToDate,DocStatus)
  INV1(DocEntry,LineNum,ItemCode,Dscription,Quantity,Price,LineTotal,WhsCode,GrssProfit)
  ODLN(DocEntry,DocNum,CardCode,CardName,DocDate,DocTotal,DocStatus)
  DLN1(DocEntry,LineNum,ItemCode,Dscription,Quantity,Price,LineTotal,WhsCode)
  ORIN(DocEntry,DocNum,CardCode,CardName,DocDate,DocTotal,DocStatus)
  RIN1(DocEntry,LineNum,ItemCode,Dscription,Quantity,LineTotal,WhsCode)

PURCHASING:
  OPQT(DocEntry,DocNum,CardCode,CardName,DocDate,DocTotal,DocStatus)
  PQT1(DocEntry,LineNum,ItemCode,Dscription,Quantity,Price,LineTotal,WhsCode)
  OPOR(DocEntry,DocNum,CardCode,CardName,DocDate,DocDueDate,DocTotal,DocStatus)
  POR1(DocEntry,LineNum,ItemCode,Dscription,Quantity,Price,LineTotal,WhsCode)
  OPDN(DocEntry,DocNum,CardCode,CardName,DocDate,DocTotal,DocStatus)
  PDN1(DocEntry,LineNum,ItemCode,Dscription,Quantity,Price,LineTotal,WhsCode)
  OPCH(DocEntry,DocNum,CardCode,CardName,DocDate,DocDueDate,DocTotal,DocStatus)
  PCH1(DocEntry,LineNum,ItemCode,Dscription,Quantity,Price,LineTotal,WhsCode)

INVENTORY:
  OITM(ItemCode,ItemName,ItmsGrpCod,InvntItem,SellItem,PrchseItem,OnHand,IsCommited,OnOrder,LastPurPrc,AvgPrice)
  OITW(ItemCode,WhsCode,OnHand,IsCommited,OnOrder)
  OWHS(WhsCode,WhsName,Street,City)
  OITB(ItmsGrpCod,ItmsGrpNam)

BUSINESS PARTNERS:
  OCRD(CardCode,CardName,CardType,GroupCode,Phone1,E_Mail,CntctPrsn,Balance,SlpCode,Territory)
  OSLP(SlpCode,SlpName,Memo,Commission,Phone,Email)
  OCRG(GroupCode,GroupName,GroupType)

FINANCE:
  OJDT(TransId,TransType,RefDate,Memo,Ref1,Ref2,Ref3,CreatedBy)
  JDT1(TransId,Line_ID,Account,Debit,Credit,SYSDebit,SYSCredit,FCDebit,FCCredit,RefDate,LineMemo,ContraAct)
  OACT(AcctCode,AcctName,GroupMask,ActType,Blocked,CurrTotal,LocTotal)

STATUS CODES: DocStatus = 'O' (Open) | 'C' (Closed) | 'W' (Cancelled)
CardType: 'C' (Customer) | 'S' (Supplier) | 'L' (Lead)
`;

const NCPL_110126_BROKERAGE_RULES = `
NCPL_110126 SALES ORDER BROKERAGE — field names verified against live data, do not substitute others:
  RDR1.U_Brok_Seller  = Seller Brokerage Rate (numeric, per-unit, e.g. rupees per Ton)
  RDR1.U_Brok_Buyer   = Buyer Brokerage Rate (numeric, per-unit)
  RDR1.U_Sel_Brok_AP  = basis flag (observed value "Amount" = the rate above is a flat per-unit amount, not a percentage)
  Do NOT use U_S_BrokPerQty, U_Seller_Brok_Per, or U_SPLRBT — these are unused/always NULL in this database and will silently produce wrong or zero results.
  If U_Brok_Seller or U_Brok_Buyer is NULL, treat as zero unless told otherwise.

  Calculation:
    Seller Brokerage Amount = RDR1.Quantity * RDR1.U_Brok_Seller
    Buyer Brokerage Amount  = RDR1.Quantity * RDR1.U_Brok_Buyer
    Total Brokerage = Seller Brokerage Amount + Buyer Brokerage Amount

  A brokerage query/report should join ORDR (DocEntry, DocNum, DocDate, CardCode, CardName) to RDR1 (ItemCode, Dscription,
  Quantity, Price, LineTotal, U_Brok_Seller, U_Brok_Buyer) on DocEntry, and return both rates and both calculated amounts
  plus Total Brokerage per line. SAP B1's financial year is April-March — "April 2026" means DocDate between
  2026-04-01 and 2026-04-30 unless the user says otherwise.
`;

// Keyed by database name — all companies live on the same SQL Server instance,
// so each gets its own pool rather than reconnecting/switching on a shared one.
const mssqlPools = new Map<string, any>();

async function getMssqlPool(databaseOverride?: string): Promise<any> {
  const host     = (process.env.MSSQL_HOST || "").trim();
  const instance = (process.env.MSSQL_INSTANCE || "").trim();
  const port     = process.env.MSSQL_PORT ? Number(process.env.MSSQL_PORT) : undefined;
  const database = (databaseOverride || process.env.MSSQL_DATABASE || "").trim();
  const user     = (process.env.MSSQL_USER || "").trim();
  const password = (process.env.MSSQL_PASSWORD || "").trim();

  if (!host || !database || !user || !password) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      "Direct SQL access is not configured. Set MSSQL_HOST, MSSQL_DATABASE, MSSQL_USER, MSSQL_PASSWORD " +
      "(and MSSQL_INSTANCE or MSSQL_PORT for a named instance) in this connector's environment."
    );
  }

  const cached = mssqlPools.get(database);
  if (cached) return cached;

  const pool = await new mssql.ConnectionPool({
    server: host,
    ...(instance ? { options: { instanceName: instance, encrypt: false, trustServerCertificate: true } }
                 : { port: port || 1433, options: { encrypt: false, trustServerCertificate: true } }),
    database,
    user,
    password,
    connectionTimeout: 15000,
    requestTimeout: 60000,
  }).connect();

  mssqlPools.set(database, pool);
  return pool;
}

async function querySqlDirect(args: unknown): Promise<ToolResponse> {
  const input = asObject(args, "arguments");
  const query = asString(input.query, "query");
  const database = optionalString(input.database, "database");

  const trimmed = query.trim();
  if (!/^SELECT\b/i.test(trimmed)) {
    throw new McpError(ErrorCode.InvalidRequest, "Only SELECT queries are allowed via query_sql_direct.");
  }

  const pool = await getMssqlPool(database);
  const result = await pool.request().query(trimmed);
  return textResult({ database: database || process.env.MSSQL_DATABASE, rowCount: result.recordset?.length ?? 0, rows: result.recordset ?? [] });
}

// ─────────────────────────────────────────────────────────────────────────────
// DIRECT HANA ACCESS (bypasses Service Layer — read-only)
// Same rationale as query_sql_direct, for SAP B1 installs running on HANA.
// A single HANA tenant DB connection can see every company's schema, so
// queries must fully qualify tables as "SCHEMA_NAME"."TABLE_NAME".
// ─────────────────────────────────────────────────────────────────────────────

let hanaClient: any = null;

async function getHanaClient(): Promise<any> {
  if (hanaClient) return hanaClient;

  const host         = (process.env.HANA_HOST || "").trim();
  const port         = process.env.HANA_PORT ? Number(process.env.HANA_PORT) : undefined;
  const user         = (process.env.HANA_USER || "").trim();
  const password     = (process.env.HANA_PASSWORD || "").trim();
  const databaseName = (process.env.HANA_TENANT || "").trim(); // e.g. "HDB" for multi-tenant (MDC) systems

  if (!host || !port || !user || !password) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      "Direct HANA access is not configured. Set HANA_HOST, HANA_PORT, HANA_USER, HANA_PASSWORD " +
      "(and HANA_TENANT for a multi-tenant/MDC system) in this connector's environment."
    );
  }

  const client = hdb.createClient({
    host,
    port,
    user,
    password,
    ...(databaseName ? { databaseName } : {}),
  });

  await new Promise<void>((resolve, reject) => {
    client.connect((err: unknown) => (err ? reject(err) : resolve()));
  });

  hanaClient = client;
  return client;
}

async function queryHanaDirect(args: unknown): Promise<ToolResponse> {
  const input = asObject(args, "arguments");
  const query = asString(input.query, "query");

  const trimmed = query.trim();
  if (!/^SELECT\b/i.test(trimmed)) {
    throw new McpError(ErrorCode.InvalidRequest, "Only SELECT queries are allowed via query_hana_direct.");
  }

  const client = await getHanaClient();
  const rows = await new Promise<unknown[]>((resolve, reject) => {
    client.exec(trimmed, (err: unknown, result: unknown[]) => (err ? reject(err) : resolve(result)));
  });

  return textResult({ rowCount: rows.length, rows });
}

async function listHanaSchemas(): Promise<ToolResponse> {
  const client = await getHanaClient();
  const rows = await new Promise<unknown[]>((resolve, reject) => {
    client.exec(
      `SELECT SCHEMA_NAME FROM SCHEMAS
       WHERE SCHEMA_NAME NOT LIKE '\\_SYS%' ESCAPE '\\'
         AND SCHEMA_NAME NOT LIKE 'B1\\_%' ESCAPE '\\'
         AND SCHEMA_NAME NOT LIKE 'XSSQLCC%'
         AND SCHEMA_NAME NOT IN (
           'SYS','SYSTEM','PUBLIC','SYS_DATABASES','HANA_XS_BASE','SAP_REST_API',
           'SAP_XS_LM','SAP_XS_LM_PE','SAP_XS_LM_PE_TMP','SAP_XS_USAGE','UIS',
           'COMMON','IFDBUSR_B1IF','IFDBUSR_IFSERV','SAPDBCTRL','SBOCOMMON','SLDDATA'
         )
       ORDER BY SCHEMA_NAME`,
      (err: unknown, result: unknown[]) => (err ? reject(err) : resolve(result))
    );
  });
  return textResult({ schemas: rows });
}

// ─────────────────────────────────────────────────────────────────────────────
// NEW SMLSVC-BASED ANALYTICAL TOOLS (POST+ParamList+namespace protocol)
// ─────────────────────────────────────────────────────────────────────────────

async function getTopCustomers(args: unknown): Promise<ToolResponse> {
  const input = asObject(args ?? {}, "arguments");
  const { fromDate: defFrom, toDate: defTo } = ytdRange();
  const fromDate = optionalString(input.fromDate, "fromDate") ?? defFrom;
  const toDate   = optionalString(input.toDate,   "toDate")   ?? defTo;
  const topN     = optionalNumber(input.topN,     "topN")     ?? 10;

  const rows = await callSMLSVC("sales", buildParamList({ fromDate, toDate }), activeCompany);
  const grouped = aggregateRows(rows, ["BusinessPartnerCode", "BusinessPartnerName"]);
  const result  = sortLimitRows(grouped, "NetSalesAmountLC", "desc", topN);
  const grandTotal = result.reduce((s, r) => s + toNumber(r["NetSalesAmountLC"]), 0);
  return textResult({ fromDate, toDate, count: result.length, grandTotal, data: result });
}

async function getTopItems(args: unknown): Promise<ToolResponse> {
  const input = asObject(args ?? {}, "arguments");
  const { fromDate: defFrom, toDate: defTo } = ytdRange();
  const fromDate = optionalString(input.fromDate, "fromDate") ?? defFrom;
  const toDate   = optionalString(input.toDate,   "toDate")   ?? defTo;
  const topN     = optionalNumber(input.topN,     "topN")     ?? 10;
  const sortBy   = optionalString(input.sortBy,   "sortBy")   ?? "NetSalesAmountLC";

  const rows    = await callSMLSVC("sales", buildParamList({ fromDate, toDate }), activeCompany);
  const grouped = aggregateRows(rows, ["ItemCode", "ItemDescription", "ItemGroup"]);
  const result  = sortLimitRows(grouped, sortBy, "desc", topN);
  return textResult({ fromDate, toDate, sortBy, count: result.length, data: result });
}

async function getSalesByPeriod(args: unknown): Promise<ToolResponse> {
  const input = asObject(args ?? {}, "arguments");
  const { fromDate: defFrom, toDate: defTo } = ytdRange();
  const fromDate    = optionalString(input.fromDate,    "fromDate")    ?? defFrom;
  const toDate      = optionalString(input.toDate,      "toDate")      ?? defTo;
  const periodType  = optionalString(input.periodType,  "periodType")  ?? "month";

  const PERIOD_FIELD: Record<string, string> = {
    day: "PostingDate", week: "PostingYearAndWeek",
    month: "PostingYearAndMonth", quarter: "PostingYearAndQuarter", year: "PostingYear",
  };
  const field = PERIOD_FIELD[periodType] ?? "PostingYearAndMonth";

  const rows    = await callSMLSVC("sales", buildParamList({ fromDate, toDate }), activeCompany);
  const grouped = aggregateRows(rows, [field]);
  const result  = sortLimitRows(grouped, field, "asc");
  return textResult({ fromDate, toDate, periodType, field, count: result.length, data: result });
}

async function getSalespersonPerformance(args: unknown): Promise<ToolResponse> {
  const input = asObject(args ?? {}, "arguments");
  const { fromDate: defFrom, toDate: defTo } = ytdRange();
  const fromDate = optionalString(input.fromDate, "fromDate") ?? defFrom;
  const toDate   = optionalString(input.toDate,   "toDate")   ?? defTo;

  const rows    = await callSMLSVC("sales", buildParamList({ fromDate, toDate }), activeCompany);
  const grouped = aggregateRows(rows, ["SalesEmployeeOrBuyerNumber", "SalesEmployeeOrBuyerName"]);
  const result  = sortLimitRows(grouped, "NetSalesAmountLC", "desc");
  return textResult({ fromDate, toDate, count: result.length, data: result });
}

async function getItemGroupSales(args: unknown): Promise<ToolResponse> {
  const input = asObject(args ?? {}, "arguments");
  const { fromDate: defFrom, toDate: defTo } = ytdRange();
  const fromDate = optionalString(input.fromDate, "fromDate") ?? defFrom;
  const toDate   = optionalString(input.toDate,   "toDate")   ?? defTo;

  const rows    = await callSMLSVC("sales", buildParamList({ fromDate, toDate }), activeCompany);
  const grouped = aggregateRows(rows, ["ItemGroup"]);
  const result  = sortLimitRows(grouped, "NetSalesAmountLC", "desc");
  return textResult({ fromDate, toDate, count: result.length, data: result });
}

async function getWarehouseSales(args: unknown): Promise<ToolResponse> {
  const input = asObject(args ?? {}, "arguments");
  const { fromDate: defFrom, toDate: defTo } = ytdRange();
  const fromDate = optionalString(input.fromDate, "fromDate") ?? defFrom;
  const toDate   = optionalString(input.toDate,   "toDate")   ?? defTo;

  const rows    = await callSMLSVC("sales", buildParamList({ fromDate, toDate }), activeCompany);
  const grouped = aggregateRows(rows, ["WarehouseCode", "WarehouseName"]);
  const result  = sortLimitRows(grouped, "NetSalesAmountLC", "desc");
  return textResult({ fromDate, toDate, count: result.length, data: result });
}

async function getYearOverYear(args: unknown): Promise<ToolResponse> {
  const input = asObject(args ?? {}, "arguments");
  const now   = new Date();
  const y1    = optionalNumber(input.year1, "year1") ?? now.getFullYear();
  const y2    = optionalNumber(input.year2, "year2") ?? y1 - 1;
  const from  = `${Math.min(y1, y2)}-01-01`;
  const to    = `${Math.max(y1, y2)}-12-31`;

  const rows    = await callSMLSVC("sales", buildParamList({ fromDate: from, toDate: to }), activeCompany);
  const grouped = aggregateRows(rows, ["PostingYear"]);
  const result  = sortLimitRows(grouped, "PostingYear", "asc");
  return textResult({ year1: y1, year2: y2, data: result });
}

// ─────────────────────────────────────────────────────────────────────────────
// FORECASTING TOOLS
// ─────────────────────────────────────────────────────────────────────────────

async function forecastSales(args: unknown): Promise<ToolResponse> {
  const input         = asObject(args ?? {}, "arguments");
  const horizonMonths = Math.min(optionalNumber(input.horizonMonths, "horizonMonths") ?? 3, 12);
  const historyMonths = Math.min(optionalNumber(input.historyMonths, "historyMonths") ?? 24, 36);
  const measure       = (optionalString(input.measure, "measure") ?? "revenue") as string;
  const cardCode      = optionalString(input.cardCode, "cardCode");
  const itemCode      = optionalString(input.itemCode, "itemCode");

  const MEASURE_FIELD: Record<string, string> = {
    revenue:  "NetSalesAmountLC",
    quantity: "QuantityInInventoryUoM",
    gp:       "GrossProfitLC",
  };
  const field = MEASURE_FIELD[measure] ?? "NetSalesAmountLC";

  const now     = new Date();
  const toDate  = now.toISOString().slice(0, 10);
  const fromDt  = new Date(now);
  fromDt.setMonth(fromDt.getMonth() - historyMonths);
  const fromDate = fromDt.toISOString().slice(0, 10);

  const rows    = await callSMLSVC("sales", buildParamList({ fromDate, toDate, cardCode, itemCode }), activeCompany);
  const grouped = aggregateRows(rows, ["PostingYearAndMonth"]);
  const sorted  = sortLimitRows(grouped, "PostingYearAndMonth", "asc");

  if (sorted.length < 2) {
    throw new McpError(ErrorCode.InvalidRequest, "Insufficient historical data — need at least 2 periods.");
  }

  const historical = sorted.map(r => ({
    period: String(r["PostingYearAndMonth"]),
    value:  +toNumber(r[field]).toFixed(2),
  }));
  const values = historical.map(h => h.value);

  const { forecasts: raw, accuracy, bestModel, r2 } = buildForecast(values, horizonMonths);
  const lastPeriod = historical[historical.length - 1].period;

  const forecasts = raw.map((f, h) => ({
    period: addMonths(lastPeriod, h + 1),
    ...f,
  }));

  const { slope } = calcLinearRegression(values);
  const avgValue   = values.reduce((s, v) => s + v, 0) / values.length;
  const growthRate = avgValue > 0 ? +((slope / avgValue) * 100).toFixed(2) : 0;
  const threshold  = avgValue * 0.01;
  const trendDir   = slope > threshold ? "up" : slope < -threshold ? "down" : "stable";
  const seasonalityCheck = runSeasonalityCheck(values);

  return textResult({
    measure,
    field,
    historyPeriods:     historical.length,
    forecastPeriods:    horizonMonths,
    rSquared:           r2,
    trendDirection:     trendDir,
    growthRatePerMonth: growthRate,
    recommendedModel:   bestModel,
    models: ["sma","wma","ewma","linearTrend","drift","holt","holtWinters","seasonalNaive","median","ensemble"],
    modelAccuracy:      accuracy,
    seasonalityCheck,
    historical,
    forecasts,
  });
}

async function forecastItemDemand(args: unknown): Promise<ToolResponse> {
  const input         = asObject(args, "arguments");
  const itemCode      = asString(input.itemCode, "itemCode");
  const horizonMonths = Math.min(optionalNumber(input.horizonMonths, "horizonMonths") ?? 3, 12);
  const historyMonths = Math.min(optionalNumber(input.historyMonths, "historyMonths") ?? 12, 36);

  const now     = new Date();
  const toDate  = now.toISOString().slice(0, 10);
  const fromDt  = new Date(now);
  fromDt.setMonth(fromDt.getMonth() - historyMonths);
  const fromDate = fromDt.toISOString().slice(0, 10);

  const rows    = await callSMLSVC("sales", buildParamList({ fromDate, toDate, itemCode }), activeCompany);
  const grouped = aggregateRows(rows, ["PostingYearAndMonth"]);
  const sorted  = sortLimitRows(grouped, "PostingYearAndMonth", "asc");

  if (sorted.length < 2) {
    throw new McpError(ErrorCode.InvalidRequest, `Insufficient demand history for item ${itemCode} — need at least 2 periods.`);
  }

  const historical = sorted.map(r => ({
    period:   String(r["PostingYearAndMonth"]),
    quantity: +toNumber(r["QuantityInInventoryUoM"]).toFixed(2),
    revenue:  +toNumber(r["NetSalesAmountLC"]).toFixed(2),
  }));
  const quantities = historical.map(h => h.quantity);

  const { forecasts: raw, accuracy, bestModel, r2 } = buildForecast(quantities, horizonMonths);
  const lastPeriod = historical[historical.length - 1].period;

  const forecasts = raw.map((f, h) => ({
    period: addMonths(lastPeriod, h + 1),
    ...f,
  }));

  const { slope } = calcLinearRegression(quantities);
  const totalForecastQty = +forecasts.reduce((s, f) => s + f.recommended, 0).toFixed(2);
  const avgMonthly       = +( quantities.reduce((s, v) => s + v, 0) / quantities.length ).toFixed(2);
  const safetyStock      = +(avgMonthly * 0.2).toFixed(2);
  const seasonalityCheck = runSeasonalityCheck(quantities);

  return textResult({
    itemCode,
    historyPeriods:   historical.length,
    forecastPeriods:  horizonMonths,
    rSquared:         r2,
    trendDirection:   slope > 0 ? "up" : slope < 0 ? "down" : "stable",
    recommendedModel: bestModel,
    models: ["sma","wma","ewma","linearTrend","drift","holt","holtWinters","seasonalNaive","median","ensemble"],
    modelAccuracy:    accuracy,
    seasonalityCheck,
    historical,
    forecasts,
    procurementSuggestion: {
      totalForecastQty,
      safetyStock,
      suggestedOrderQty: +(totalForecastQty + safetyStock).toFixed(2),
      basis:             `${horizonMonths}-month horizon using ${bestModel} model + 20% safety stock`,
    },
  });
}

async function forecastCashFlow(args: unknown): Promise<ToolResponse> {
  const input       = asObject(args ?? {}, "arguments");
  const forecastDays = Math.min(optionalNumber(input.forecastDays, "forecastDays") ?? 90, 180);
  const today       = new Date();
  const todayStr    = today.toISOString().slice(0, 10);

  const bucketDefs = [
    { label: "0_30",  min: 0,  max: 30  },
    { label: "31_60", min: 31, max: 60  },
    { label: "61_90", min: 61, max: 90  },
    ...(forecastDays > 90 ? [{ label: "91_180", min: 91, max: 180 }] : []),
  ].filter(b => b.min < forecastDays);

  // Fetch open AR invoices (expected cash in) and AP invoices (expected cash out)
  const [arInvoices, apInvoices] = await Promise.all([
    client.getAll<JsonObject>("/Invoices", {
      $select: "CardCode,CardName,DocNum,DocDueDate,DocTotal,PaidToDate",
      $filter:  "DocumentStatus eq 'bost_Open'",
    }),
    client.getAll<JsonObject>("/PurchaseInvoices", {
      $select: "CardCode,CardName,DocNum,DocDueDate,DocTotal,PaidToDate",
      $filter:  "DocumentStatus eq 'bost_Open'",
    }),
  ]);

  function bucketInvoices(invoices: JsonObject[]): {
    buckets: Record<string, number>;
    overdue: number;
    items: JsonObject[];
  } {
    const buckets: Record<string, number> = Object.fromEntries(bucketDefs.map(b => [b.label, 0]));
    let overdue = 0;
    const items: JsonObject[] = [];

    for (const inv of invoices) {
      const outstanding = toNumber(inv.DocTotal) - toNumber(inv.PaidToDate);
      if (outstanding <= 0) continue;
      const due  = new Date(String(inv.DocDueDate));
      const days = Math.ceil((due.getTime() - today.getTime()) / 86_400_000);

      if (days < 0) {
        overdue += outstanding;
      } else {
        const bucket = bucketDefs.find(b => days >= b.min && days <= b.max);
        if (bucket) buckets[bucket.label] += outstanding;
      }
      items.push({
        cardCode:    inv.CardCode,
        cardName:    inv.CardName,
        docNum:      inv.DocNum,
        dueDate:     String(inv.DocDueDate).slice(0, 10),
        outstanding: +outstanding.toFixed(2),
        daysUntilDue: days,
      });
    }
    items.sort((a, b) => toNumber(a.daysUntilDue) - toNumber(b.daysUntilDue));
    return { buckets, overdue, items };
  }

  const ar = bucketInvoices(arInvoices);
  const ap = bucketInvoices(apInvoices);

  // Net cash position per bucket
  const netByBucket = Object.fromEntries(
    bucketDefs.map(b => [
      b.label,
      +((ar.buckets[b.label] ?? 0) - (ap.buckets[b.label] ?? 0)).toFixed(2),
    ])
  );

  const totalInflow  = +( Object.values(ar.buckets).reduce((s, v) => s + v, 0) + ar.overdue ).toFixed(2);
  const totalOutflow = +( Object.values(ap.buckets).reduce((s, v) => s + v, 0) + ap.overdue ).toFixed(2);

  return textResult({
    asOfDate:      todayStr,
    forecastDays,
    summary: {
      totalExpectedInflow:  totalInflow,
      totalExpectedOutflow: totalOutflow,
      netCashPosition:      +(totalInflow - totalOutflow).toFixed(2),
      overdueAR:            +ar.overdue.toFixed(2),
      overdueAP:            +ap.overdue.toFixed(2),
    },
    inflowByBucket:  Object.fromEntries(bucketDefs.map(b => [b.label, +ar.buckets[b.label].toFixed(2)])),
    outflowByBucket: Object.fromEntries(bucketDefs.map(b => [b.label, +ap.buckets[b.label].toFixed(2)])),
    netByBucket,
    arInvoices:  ar.items,
    apInvoices:  ap.items,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// BUSINESS INTELLIGENCE TOOLS
// ─────────────────────────────────────────────────────────────────────────────

async function analyzeAbcXyz(args: unknown): Promise<ToolResponse> {
  const input         = asObject(args ?? {}, "arguments");
  const historyMonths = Math.min(optionalNumber(input.historyMonths, "historyMonths") ?? 12, 24);
  const topN          = optionalNumber(input.topN, "topN") ?? 300;

  const now = new Date();
  const toDate = now.toISOString().slice(0, 10);
  const fromDt = new Date(now); fromDt.setMonth(fromDt.getMonth() - historyMonths);
  const fromDate = fromDt.toISOString().slice(0, 10);

  // Helper: derive YYYYMM month key from any row
  function monthKey(row: JsonObject): string {
    const ym = String(row.PostingYearAndMonth ?? "");
    if (ym && ym.length >= 6) return ym.slice(0, 6);
    const yr = row.PostingYear;
    const mo = row.PostingMonth;
    if (yr && mo) return `${yr}${String(mo).padStart(2, "0")}`;
    const dt = String(row.PostingDate ?? row.DocDate ?? "").slice(0, 7).replace("-", "");
    return dt || "000000";
  }

  // Build item × month matrix for XYZ CV calculation
  const itemMap = new Map<string, { desc: string; revenue: number; qty: number; months: Record<string, number> }>();

  function processRows(rows: JsonObject[], revenueField: string, qtyField: string, descField: string) {
    for (const row of rows) {
      const code = String(row.ItemCode ?? row.itemCode ?? "");
      if (!code) continue;
      const mk = monthKey(row);
      if (!itemMap.has(code)) itemMap.set(code, { desc: String(row[descField] ?? ""), revenue: 0, qty: 0, months: {} });
      const item = itemMap.get(code)!;
      item.revenue += toNumber(row[revenueField]);
      item.qty     += toNumber(row[qtyField]);
      item.months[mk] = (item.months[mk] ?? 0) + toNumber(row[revenueField]);
    }
  }

  // Primary: SMLSVC SalesAnalysisQuery
  let usedFallback = false;
  try {
    const rows = await callSMLSVC("sales", buildParamList({ fromDate, toDate }), activeCompany);
    if (rows.length > 0) {
      processRows(rows, "NetSalesAmountLC", "QuantityInInventoryUoM", "ItemDescription");
    } else {
      throw new Error("empty");
    }
  } catch {
    // Fallback: AR invoice lines from Service Layer
    usedFallback = true;
    const invoices = await client.getAll<JsonObject>("/Invoices", {
      $select: "DocDate,DocumentLines/ItemCode,DocumentLines/ItemDescription,DocumentLines/LineTotal,DocumentLines/Quantity",
      $expand: "DocumentLines",
      $filter: `DocumentStatus ne 'bost_Cancelled' and DocDate ge '${fromDate}' and DocDate le '${toDate}'`,
    });
    const flatLines: JsonObject[] = [];
    for (const inv of invoices) {
      const lines = asArray(inv.DocumentLines ?? [], "DocumentLines");
      for (const line of lines) {
        const l = asObject(line, "line");
        flatLines.push({ ...l, PostingDate: inv.DocDate });
      }
    }
    processRows(flatLines, "LineTotal", "Quantity", "ItemDescription");
  }

  const all = [...itemMap.entries()].map(([code, d]) => {
    const mv  = Object.values(d.months);
    const avg = mv.reduce((s, v) => s + v, 0) / Math.max(mv.length, 1);
    const v   = mv.reduce((s, v) => s + (v - avg) ** 2, 0) / Math.max(mv.length, 1);
    return { code, desc: d.desc, revenue: d.revenue, qty: +d.qty.toFixed(2), cv: avg > 0 ? +(Math.sqrt(v) / avg).toFixed(3) : 99 };
  }).sort((a, b) => b.revenue - a.revenue).slice(0, topN);

  const total = all.reduce((s, i) => s + i.revenue, 0);
  let cum = 0;
  const classified = all.map(item => {
    cum += item.revenue;
    const cumPct = total > 0 ? (cum / total) * 100 : 0;
    const prevPct = cumPct - (item.revenue / total * 100);
    const abc = prevPct < 80 ? "A" : prevPct < 95 ? "B" : "C";
    const xyz = item.cv < 0.5 ? "X" : item.cv < 1.0 ? "Y" : "Z";
    return { ...item, revenue: +item.revenue.toFixed(2), abc, xyz, class: abc + xyz, cumRevPct: +cumPct.toFixed(1) };
  });

  const summary: Record<string, { count: number; revenue: number; pct: number }> = {};
  for (const i of classified) {
    if (!summary[i.class]) summary[i.class] = { count: 0, revenue: 0, pct: 0 };
    summary[i.class].count++;
    summary[i.class].revenue += i.revenue;
  }
  for (const k of Object.keys(summary)) summary[k].pct = total > 0 ? +(summary[k].revenue / total * 100).toFixed(1) : 0;

  return textResult({ fromDate, toDate, dataSource: usedFallback ? "AR Invoices (Service Layer)" : "SalesAnalysisQuery (SMLSVC)",
    totalItems: classified.length, totalRevenue: +total.toFixed(2), summary, items: classified,
    guide: { A: "Top 80% revenue — critical stock", B: "Next 15% revenue — important stock", C: "Bottom 5% — review for rationalization",
             X: "CV<0.5 stable demand", Y: "CV 0.5–1 variable", Z: "CV>1 erratic — carry safety stock" } });
}

async function segmentCustomersRfm(args: unknown): Promise<ToolResponse> {
  const input  = asObject(args ?? {}, "arguments");
  const days   = Math.min(optionalNumber(input.lookbackDays, "lookbackDays") ?? 365, 730);
  const today  = new Date();
  const fromDt = new Date(today); fromDt.setDate(fromDt.getDate() - days);
  const fromDate = fromDt.toISOString().slice(0, 10);

  const invoices = await client.getAll<JsonObject>("/Invoices", {
    $select: "CardCode,CardName,DocDate,DocTotal,DocNum",
    $filter:  `DocumentStatus ne 'bost_Cancelled' and DocDate ge '${fromDate}'`,
  });

  const custMap = new Map<string, { name: string; lastDate: string; count: number; total: number }>();
  for (const inv of invoices) {
    const code = String(inv.CardCode ?? "");
    if (!code) continue;
    const date  = String(inv.DocDate ?? "").slice(0, 10);
    const total = toNumber(inv.DocTotal);
    if (!custMap.has(code)) custMap.set(code, { name: String(inv.CardName ?? ""), lastDate: date, count: 0, total: 0 });
    const c = custMap.get(code)!;
    c.count++;
    c.total += total;
    if (date > c.lastDate) c.lastDate = date;
  }

  const todayStr = today.toISOString().slice(0, 10);
  const customers = [...custMap.entries()].map(([code, d]) => {
    const recencyDays = Math.floor((today.getTime() - new Date(d.lastDate).getTime()) / 86_400_000);
    return { code, name: d.name, lastOrder: d.lastDate, recencyDays, frequency: d.count, monetaryTotal: +d.total.toFixed(2), avgOrderValue: +(d.total / d.count).toFixed(2) };
  });

  // Score R/F/M on 1-5 using quintiles
  function quintileScore(values: number[], val: number, ascending: boolean): number {
    const sorted = [...values].sort((a, b) => a - b);
    const p = sorted.findIndex(v => val <= v) / sorted.length;
    const score = Math.ceil(p * 5) || 1;
    return ascending ? score : 6 - score;
  }
  const recencies   = customers.map(c => c.recencyDays);
  const frequencies = customers.map(c => c.frequency);
  const monetaries  = customers.map(c => c.monetaryTotal);

  const scored = customers.map(c => {
    const r = quintileScore(recencies,   c.recencyDays,    false); // lower recency = better
    const f = quintileScore(frequencies, c.frequency,      true);
    const m = quintileScore(monetaries,  c.monetaryTotal,  true);
    const rfm = r * 100 + f * 10 + m;
    const segment =
      r >= 4 && f >= 4 && m >= 4 ? "Champions" :
      r >= 3 && f >= 3           ? "Loyal" :
      r >= 4 && f <= 2           ? "New Customers" :
      r >= 3 && m >= 3           ? "Potential Loyalists" :
      r <= 2 && f >= 3 && m >= 3 ? "At Risk" :
      r <= 2 && f >= 4           ? "Cannot Lose Them" :
      r <= 1 && f <= 1           ? "Lost" : "Needs Attention";
    return { ...c, rScore: r, fScore: f, mScore: m, rfmScore: rfm, segment };
  }).sort((a, b) => b.rfmScore - a.rfmScore);

  const segCount: Record<string, { count: number; totalRevenue: number }> = {};
  for (const c of scored) {
    if (!segCount[c.segment]) segCount[c.segment] = { count: 0, totalRevenue: 0 };
    segCount[c.segment].count++;
    segCount[c.segment].totalRevenue += c.monetaryTotal;
  }

  return textResult({ asOfDate: todayStr, lookbackDays: days, totalCustomers: scored.length,
    segmentSummary: segCount, customers: scored });
}

async function calcWorkingCapital(args: unknown): Promise<ToolResponse> {
  const input = asObject(args ?? {}, "arguments");
  const periodDays = optionalNumber(input.periodDays, "periodDays") ?? 90;
  const today  = new Date();
  const fromDt = new Date(today); fromDt.setDate(fromDt.getDate() - periodDays);
  const fromDate = fromDt.toISOString().slice(0, 10);
  const toDate   = today.toISOString().slice(0, 10);

  const [arOpen, apOpen, salesRows, stockRows] = await Promise.all([
    client.getAll<JsonObject>("/Invoices",         { $select: "DocTotal,PaidToDate", $filter: "DocumentStatus eq 'bost_Open'" }),
    client.getAll<JsonObject>("/PurchaseInvoices", { $select: "DocTotal,PaidToDate", $filter: "DocumentStatus eq 'bost_Open'" }),
    callSMLSVC("sales",    buildParamList({ fromDate, toDate }), activeCompany),
    client.getAll<JsonObject>("/Items", { $select: "ItemCode,QuantityOnStock,LastPurchasePrice", $filter: "ItemType eq 'itItems' and QuantityOnStock gt 0" }),
  ]);

  const openAR = arOpen.reduce((s, r) => s + toNumber(r.DocTotal) - toNumber(r.PaidToDate), 0);
  const openAP = apOpen.reduce((s, r) => s + toNumber(r.DocTotal) - toNumber(r.PaidToDate), 0);
  const revenue = salesRows.reduce((s, r) => s + toNumber(r.NetSalesAmountLC), 0);
  const cogs    = salesRows.reduce((s, r) => s + (toNumber(r.NetSalesAmountLC) - toNumber(r.GrossProfitLC)), 0);
  const stockValue = stockRows.reduce((s, r) => s + toNumber(r.QuantityOnStock) * toNumber(r.LastPurchasePrice), 0);

  const dailyRev  = revenue  / periodDays;
  const dailyCogs = cogs     / periodDays;

  const dso = dailyRev  > 0 ? +(openAR     / dailyRev).toFixed(1)  : null;
  const dpo = dailyCogs > 0 ? +(openAP     / dailyCogs).toFixed(1) : null;
  const dsi = dailyCogs > 0 ? +(stockValue / dailyCogs).toFixed(1) : null;
  const ccc = (dso != null && dpo != null && dsi != null) ? +(dsi + dso - dpo).toFixed(1) : null;

  return textResult({
    asOfDate: toDate, periodDays,
    metrics: {
      openAR: +openAR.toFixed(2), openAP: +openAP.toFixed(2),
      revenue: +revenue.toFixed(2), cogs: +cogs.toFixed(2), stockValue: +stockValue.toFixed(2),
    },
    workingCapital: {
      DSO: { value: dso, unit: "days", desc: "Days Sales Outstanding — how long to collect AR" },
      DPO: { value: dpo, unit: "days", desc: "Days Payable Outstanding — how long to pay vendors" },
      DSI: { value: dsi, unit: "days", desc: "Days Sales of Inventory — how long stock sits" },
      CCC: { value: ccc, unit: "days", desc: "Cash Conversion Cycle = DSI + DSO - DPO (lower = better)" },
    },
    interpretation: ccc != null
      ? (ccc < 30 ? "✅ Healthy cash cycle" : ccc < 60 ? "⚠️ Moderate cash cycle — monitor closely" : "🔴 Long cash cycle — cash tied up in operations")
      : "Insufficient data for full CCC calculation",
  });
}

async function predictStockout(args: unknown): Promise<ToolResponse> {
  const input     = asObject(args ?? {}, "arguments");
  const demandDays = optionalNumber(input.demandDays, "demandDays") ?? 90;
  const topN       = optionalNumber(input.topN, "topN") ?? 50;

  const today  = new Date();
  const fromDt = new Date(today); fromDt.setDate(fromDt.getDate() - demandDays);
  const fromDate = fromDt.toISOString().slice(0, 10);
  const toDate   = today.toISOString().slice(0, 10);

  const [stockRows, demandRows] = await Promise.all([
    client.getAll<JsonObject>("/Items", {
      $select: "ItemCode,ItemName,QuantityOnStock,MinInventory",
      $filter:  "ItemType eq 'itItems' and Frozen eq 'tNO' and QuantityOnStock gt 0",
    }),
    callSMLSVC("sales", buildParamList({ fromDate, toDate }), activeCompany),
  ]);

  const demandMap = new Map<string, number>();
  for (const row of demandRows) {
    const code = String(row.ItemCode ?? "");
    demandMap.set(code, (demandMap.get(code) ?? 0) + toNumber(row.QuantityInInventoryUoM));
  }

  const items = stockRows
    .map(r => {
      const code       = String(r.ItemCode ?? "");
      const stock      = toNumber(r.QuantityOnStock);
      const totalDemand = demandMap.get(code) ?? 0;
      const dailyDemand = totalDemand / demandDays;
      const daysLeft    = dailyDemand > 0 ? +(stock / dailyDemand).toFixed(0) : null;
      const risk        = daysLeft == null ? "no-demand" : daysLeft <= 7 ? "critical" : daysLeft <= 30 ? "low" : daysLeft <= 60 ? "moderate" : "ok";
      return { code, name: String(r.ItemName ?? ""), stock: +stock.toFixed(2), dailyDemand: +dailyDemand.toFixed(3), daysLeft, minStock: toNumber(r.MinInventory), risk };
    })
    .filter(i => i.risk !== "no-demand")
    .sort((a, b) => (a.daysLeft ?? 9999) - (b.daysLeft ?? 9999))
    .slice(0, topN);

  const critical = items.filter(i => i.risk === "critical").length;
  const low      = items.filter(i => i.risk === "low").length;

  return textResult({ asOfDate: toDate, demandDays, summary: { critical, low, moderate: items.filter(i=>i.risk==="moderate").length, ok: items.filter(i=>i.risk==="ok").length }, items });
}

async function detectDeadSlowStock(args: unknown): Promise<ToolResponse> {
  const input      = asObject(args ?? {}, "arguments");
  const deadDays   = optionalNumber(input.deadDays,   "deadDays")   ?? 180;
  const slowFactor = optionalNumber(input.slowFactor, "slowFactor") ?? 0.2; // < 20% of avg = slow

  const today  = new Date();
  const toDate = today.toISOString().slice(0, 10);
  const fromDt = new Date(today); fromDt.setDate(fromDt.getDate() - deadDays);
  const fromDate = fromDt.toISOString().slice(0, 10);

  const [stockRows, demandRows] = await Promise.all([
    client.getAll<JsonObject>("/Items", {
      $select: "ItemCode,ItemName,QuantityOnStock,LastPurchasePrice",
      $filter:  "ItemType eq 'itItems' and Frozen eq 'tNO' and QuantityOnStock gt 0",
    }),
    callSMLSVC("sales", buildParamList({ fromDate, toDate }), activeCompany),
  ]);

  const demandMap = new Map<string, number>();
  for (const r of demandRows) {
    const code = String(r.ItemCode ?? "");
    demandMap.set(code, (demandMap.get(code) ?? 0) + toNumber(r.QuantityInInventoryUoM));
  }

  const avgDemand = demandMap.size > 0
    ? [...demandMap.values()].reduce((s, v) => s + v, 0) / demandMap.size : 0;

  const result = stockRows.map(r => {
    const code        = String(r.ItemCode ?? "");
    const stock       = toNumber(r.QuantityOnStock);
    const demand      = demandMap.get(code) ?? 0;
    const stockValue  = +(stock * toNumber(r.LastPurchasePrice)).toFixed(2);
    const status      = demand === 0 ? "dead" : demand < avgDemand * slowFactor ? "slow" : "moving";
    return { code, name: String(r.ItemName ?? ""), stock: +stock.toFixed(2), demandInPeriod: +demand.toFixed(2), stockValue, status };
  }).filter(i => i.status !== "moving").sort((a, b) => b.stockValue - a.stockValue);

  const deadValue = result.filter(i => i.status === "dead").reduce((s, i) => s + i.stockValue, 0);
  const slowValue = result.filter(i => i.status === "slow").reduce((s, i) => s + i.stockValue, 0);

  return textResult({
    analysisDate: toDate, deadDays, slowFactor,
    summary: { deadItems: result.filter(i=>i.status==="dead").length, slowItems: result.filter(i=>i.status==="slow").length,
               deadStockValue: +deadValue.toFixed(2), slowStockValue: +slowValue.toFixed(2),
               totalAtRiskValue: +(deadValue + slowValue).toFixed(2) },
    items: result,
  });
}

async function calcReorderPoint(args: unknown): Promise<ToolResponse> {
  const input       = asObject(args ?? {}, "arguments");
  const demandDays  = optionalNumber(input.demandDays, "demandDays") ?? 90;
  const leadTimeDays = optionalNumber(input.leadTimeDays, "leadTimeDays") ?? 14;
  const safetyDays  = optionalNumber(input.safetyDays, "safetyDays") ?? 7;
  const topN        = optionalNumber(input.topN, "topN") ?? 50;

  const today  = new Date();
  const fromDt = new Date(today); fromDt.setDate(fromDt.getDate() - demandDays);
  const fromDate = fromDt.toISOString().slice(0, 10);

  const [stockRows, demandRows] = await Promise.all([
    client.getAll<JsonObject>("/Items", {
      $select: "ItemCode,ItemName,QuantityOnStock,MinInventory",
      $filter:  "ItemType eq 'itItems' and Frozen eq 'tNO'",
    }),
    callSMLSVC("sales", buildParamList({ fromDate, toDate: today.toISOString().slice(0, 10) }), activeCompany),
  ]);

  const demandMap = new Map<string, number>();
  for (const r of demandRows) {
    const code = String(r.ItemCode ?? "");
    demandMap.set(code, (demandMap.get(code) ?? 0) + toNumber(r.QuantityInInventoryUoM));
  }

  const items = stockRows
    .filter(r => demandMap.has(String(r.ItemCode ?? "")))
    .map(r => {
      const code       = String(r.ItemCode ?? "");
      const stock      = toNumber(r.QuantityOnStock);
      const totalDemand = demandMap.get(code) ?? 0;
      const daily      = totalDemand / demandDays;
      const rop        = +(daily * (leadTimeDays + safetyDays)).toFixed(2);
      const reorderNow = stock <= rop;
      return { code, name: String(r.ItemName ?? ""), currentStock: +stock.toFixed(2), dailyDemand: +daily.toFixed(3),
        rop, safetyStock: +(daily * safetyDays).toFixed(2), suggestedOrderQty: reorderNow ? +(rop * 2 - stock).toFixed(2) : 0, reorderNow };
    })
    .sort((a, b) => (b.reorderNow ? 1 : 0) - (a.reorderNow ? 1 : 0))
    .slice(0, topN);

  return textResult({
    parameters: { demandDays, leadTimeDays, safetyDays },
    reorderNowCount: items.filter(i => i.reorderNow).length,
    items,
  });
}

async function detectCustomerChurn(args: unknown): Promise<ToolResponse> {
  const input       = asObject(args ?? {}, "arguments");
  const lookback    = optionalNumber(input.lookbackDays,  "lookbackDays")  ?? 365;
  const churnDays   = optionalNumber(input.churnThreshold,"churnThreshold") ?? 90;

  const today  = new Date();
  const fromDt = new Date(today); fromDt.setDate(fromDt.getDate() - lookback);
  const fromDate = fromDt.toISOString().slice(0, 10);

  const invoices = await client.getAll<JsonObject>("/Invoices", {
    $select: "CardCode,CardName,DocDate,DocTotal",
    $filter: `DocumentStatus ne 'bost_Cancelled' and DocDate ge '${fromDate}'`,
  });

  const custMap = new Map<string, { name: string; dates: string[]; total: number }>();
  for (const inv of invoices) {
    const code = String(inv.CardCode ?? "");
    if (!code) continue;
    if (!custMap.has(code)) custMap.set(code, { name: String(inv.CardName ?? ""), dates: [], total: 0 });
    const c = custMap.get(code)!;
    c.dates.push(String(inv.DocDate ?? "").slice(0, 10));
    c.total += toNumber(inv.DocTotal);
  }

  const analyzed = [...custMap.entries()].map(([code, d]) => {
    const sorted      = d.dates.sort();
    const lastOrder   = sorted[sorted.length - 1];
    const daysSince   = Math.floor((today.getTime() - new Date(lastOrder).getTime()) / 86_400_000);
    const frequency   = d.dates.length;
    const avgInterval = sorted.length > 1
      ? Math.floor((new Date(sorted[sorted.length-1]).getTime() - new Date(sorted[0]).getTime()) / 86_400_000 / (sorted.length - 1))
      : lookback;
    const expectedNextOrder = new Date(lastOrder);
    expectedNextOrder.setDate(expectedNextOrder.getDate() + avgInterval);
    const overdue  = daysSince - avgInterval;
    const churnRisk = daysSince >= churnDays ? "high" : overdue > 0 ? "medium" : "low";
    return { code, name: d.name, lastOrder, daysSinceLastOrder: daysSince, orderFrequency: frequency,
      avgDaysBetweenOrders: avgInterval, expectedNextOrder: expectedNextOrder.toISOString().slice(0, 10),
      totalRevenue: +d.total.toFixed(2), churnRisk };
  }).sort((a, b) => b.daysSinceLastOrder - a.daysSinceLastOrder);

  return textResult({
    asOfDate: today.toISOString().slice(0, 10), lookbackDays: lookback, churnThresholdDays: churnDays,
    summary: { high: analyzed.filter(c=>c.churnRisk==="high").length, medium: analyzed.filter(c=>c.churnRisk==="medium").length, low: analyzed.filter(c=>c.churnRisk==="low").length },
    customers: analyzed,
  });
}

async function calcCustomerClv(args: unknown): Promise<ToolResponse> {
  const input   = asObject(args ?? {}, "arguments");
  const lookback = optionalNumber(input.lookbackDays, "lookbackDays") ?? 730;
  const horizon  = optionalNumber(input.projectionYears, "projectionYears") ?? 3;

  const today  = new Date();
  const fromDt = new Date(today); fromDt.setDate(fromDt.getDate() - lookback);
  const fromDate = fromDt.toISOString().slice(0, 10);
  const yearsBack = lookback / 365;

  const invoices = await client.getAll<JsonObject>("/Invoices", {
    $select: "CardCode,CardName,DocDate,DocTotal",
    $filter: `DocumentStatus ne 'bost_Cancelled' and DocDate ge '${fromDate}'`,
  });

  const custMap = new Map<string, { name: string; count: number; total: number; firstDate: string; lastDate: string }>();
  for (const inv of invoices) {
    const code = String(inv.CardCode ?? "");
    if (!code) continue;
    const date = String(inv.DocDate ?? "").slice(0, 10);
    if (!custMap.has(code)) custMap.set(code, { name: String(inv.CardName ?? ""), count: 0, total: 0, firstDate: date, lastDate: date });
    const c = custMap.get(code)!;
    c.count++;
    c.total += toNumber(inv.DocTotal);
    if (date < c.firstDate) c.firstDate = date;
    if (date > c.lastDate) c.lastDate = date;
  }

  const customers = [...custMap.entries()].map(([code, d]) => {
    const avgOrderValue  = d.total / d.count;
    const purchaseFreqPerYear = d.count / yearsBack;
    const clv = +(avgOrderValue * purchaseFreqPerYear * horizon).toFixed(2);
    const tier = clv > 50000 ? "platinum" : clv > 10000 ? "gold" : clv > 2000 ? "silver" : "bronze";
    return { code, name: d.name, totalRevenue: +d.total.toFixed(2), orderCount: d.count,
      avgOrderValue: +avgOrderValue.toFixed(2), purchaseFreqPerYear: +purchaseFreqPerYear.toFixed(2),
      projectedClv: clv, projectionYears: horizon, tier };
  }).sort((a, b) => b.projectedClv - a.projectedClv);

  return textResult({
    lookbackDays: lookback, projectionYears: horizon, totalCustomers: customers.length,
    totalProjectedRevenue: +customers.reduce((s, c) => s + c.projectedClv, 0).toFixed(2),
    tierSummary: {
      platinum: customers.filter(c=>c.tier==="platinum").length,
      gold:     customers.filter(c=>c.tier==="gold").length,
      silver:   customers.filter(c=>c.tier==="silver").length,
      bronze:   customers.filter(c=>c.tier==="bronze").length,
    },
    customers,
  });
}

async function analyzeRevenueConcentration(args: unknown): Promise<ToolResponse> {
  const input = asObject(args ?? {}, "arguments");
  const { fromDate: defFrom, toDate: defTo } = ytdRange();
  const fromDate = optionalString(input.fromDate, "fromDate") ?? defFrom;
  const toDate   = optionalString(input.toDate,   "toDate")   ?? defTo;

  const rows    = await callSMLSVC("sales", buildParamList({ fromDate, toDate }), activeCompany);
  const grouped = aggregateRows(rows, ["BusinessPartnerCode", "BusinessPartnerName"]);
  const sorted  = sortLimitRows(grouped, "NetSalesAmountLC", "desc");
  const total   = sorted.reduce((s, r) => s + toNumber(r.NetSalesAmountLC), 0);

  let cum = 0;
  const customers = sorted.map((r, i) => {
    cum += toNumber(r.NetSalesAmountLC);
    return {
      rank:       i + 1,
      code:       String(r.BusinessPartnerCode ?? ""),
      name:       String(r.BusinessPartnerName ?? ""),
      revenue:    +toNumber(r.NetSalesAmountLC).toFixed(2),
      revPct:     total > 0 ? +(toNumber(r.NetSalesAmountLC) / total * 100).toFixed(2) : 0,
      cumRevPct:  total > 0 ? +(cum / total * 100).toFixed(1) : 0,
    };
  });

  const top10Revenue  = customers.slice(0, 10).reduce((s, c) => s + c.revenue, 0);
  const top10Pct      = total > 0 ? +(top10Revenue / total * 100).toFixed(1) : 0;
  const cust80Pct     = customers.findIndex(c => c.cumRevPct >= 80) + 1;
  const hhi           = +customers.reduce((s, c) => s + (c.revPct / 100) ** 2, 0).toFixed(4);

  return textResult({
    fromDate, toDate, totalCustomers: customers.length, totalRevenue: +total.toFixed(2),
    paretoAnalysis: {
      customersFor80pctRevenue: cust80Pct,
      top10CustomerRevenuePct:  top10Pct,
      hhiConcentrationIndex:    hhi,
      riskLevel:                hhi > 0.25 ? "high — concentrated" : hhi > 0.15 ? "moderate" : "low — diversified",
    },
    customers,
  });
}

async function detectMarginErosion(args: unknown): Promise<ToolResponse> {
  const input = asObject(args ?? {}, "arguments");
  const months = Math.min(optionalNumber(input.months, "months") ?? 12, 24);
  const erosionThresholdPct = optionalNumber(input.erosionThresholdPct, "erosionThresholdPct") ?? 5;

  const now    = new Date();
  const toDate = now.toISOString().slice(0, 10);
  const fromDt = new Date(now); fromDt.setMonth(fromDt.getMonth() - months);
  const fromDate = fromDt.toISOString().slice(0, 10);

  const rows    = await callSMLSVC("sales", buildParamList({ fromDate, toDate }), activeCompany);
  const byItemMonth = aggregateRows(rows, ["ItemCode", "ItemDescription", "PostingYearAndMonth"]);

  const itemMap = new Map<string, { desc: string; periods: { period: string; gp: number }[] }>();
  for (const r of byItemMonth) {
    const code = String(r.ItemCode ?? "");
    const rev  = toNumber(r.NetSalesAmountLC);
    const gp   = toNumber(r.GrossProfitLC);
    const gpPct = rev > 0 ? (gp / rev) * 100 : 0;
    if (!itemMap.has(code)) itemMap.set(code, { desc: String(r.ItemDescription ?? ""), periods: [] });
    itemMap.get(code)!.periods.push({ period: String(r.PostingYearAndMonth ?? ""), gp: +gpPct.toFixed(2) });
  }

  const analyzed = [...itemMap.entries()].map(([code, d]) => {
    const pts = d.periods.sort((a, b) => a.period.localeCompare(b.period));
    if (pts.length < 2) return null;
    const firstGP = pts[0].gp;
    const lastGP  = pts[pts.length - 1].gp;
    const change  = +(lastGP - firstGP).toFixed(2);
    const { slope } = calcLinearRegression(pts.map(p => p.gp));
    const status    = change <= -erosionThresholdPct ? "eroding" : change >= erosionThresholdPct ? "improving" : "stable";
    return { code, desc: d.desc, firstPeriodGP: firstGP, latestGP: lastGP, changeGP: change, trendSlope: +slope.toFixed(3), status, periods: pts };
  }).filter((i): i is NonNullable<typeof i> => i !== null && i.status === "eroding")
    .sort((a, b) => a.changeGP - b.changeGP);

  return textResult({
    fromDate, toDate, erosionThresholdPct,
    erodingItemCount: analyzed.length,
    items: analyzed,
  });
}

async function detectTransactionOutliers(args: unknown): Promise<ToolResponse> {
  const input      = asObject(args ?? {}, "arguments");
  const zThreshold = optionalNumber(input.zThreshold, "zThreshold") ?? 3;
  const lookback   = optionalNumber(input.lookbackDays, "lookbackDays") ?? 90;
  const docType    = (optionalString(input.docType, "docType") ?? "ar") as "ar" | "ap";

  const today  = new Date();
  const fromDt = new Date(today); fromDt.setDate(fromDt.getDate() - lookback);
  const fromDate = fromDt.toISOString().slice(0, 10);
  const endpoint  = docType === "ar" ? "/Invoices" : "/PurchaseInvoices";

  const invoices = await client.getAll<JsonObject>(endpoint, {
    $select: "DocEntry,DocNum,CardCode,CardName,DocDate,DocTotal",
    $filter: `DocumentStatus ne 'bost_Cancelled' and DocDate ge '${fromDate}'`,
  });

  const amounts = invoices.map(i => toNumber(i.DocTotal));
  const mean    = amounts.reduce((s, v) => s + v, 0) / Math.max(amounts.length, 1);
  const std     = Math.sqrt(amounts.reduce((s, v) => s + (v - mean) ** 2, 0) / Math.max(amounts.length, 1));

  const outliers = invoices
    .map(inv => {
      const amount = toNumber(inv.DocTotal);
      const zScore = std > 0 ? +((amount - mean) / std).toFixed(2) : 0;
      return { docEntry: inv.DocEntry, docNum: inv.DocNum, cardCode: inv.CardCode, cardName: inv.CardName,
        docDate: String(inv.DocDate ?? "").slice(0, 10), amount: +amount.toFixed(2), zScore };
    })
    .filter(i => Math.abs(i.zScore) >= zThreshold)
    .sort((a, b) => Math.abs(b.zScore) - Math.abs(a.zScore));

  return textResult({
    docType: docType === "ar" ? "AR Invoices" : "AP Invoices",
    lookbackDays: lookback, zThreshold,
    statistics: { totalInvoices: invoices.length, mean: +mean.toFixed(2), stdDev: +std.toFixed(2) },
    outlierCount: outliers.length,
    outliers,
  });
}

async function analyzeVendorLeadTime(args: unknown): Promise<ToolResponse> {
  const input   = asObject(args ?? {}, "arguments");
  const months  = Math.min(optionalNumber(input.months, "months") ?? 6, 24);
  const today   = new Date();
  const fromDt  = new Date(today); fromDt.setMonth(fromDt.getMonth() - months);
  const fromDate = fromDt.toISOString().slice(0, 10);

  // Use PO DocDate → DocDueDate as planned lead time proxy
  const pos = await client.getAll<JsonObject>("/PurchaseOrders", {
    $select: "DocEntry,DocNum,CardCode,CardName,DocDate,DocDueDate,DocumentStatus",
    $filter: `DocDate ge '${fromDate}'`,
  });

  const vendorMap = new Map<string, { name: string; leadTimes: number[] }>();
  for (const po of pos) {
    const code = String(po.CardCode ?? "");
    if (!code) continue;
    const created  = new Date(String(po.DocDate    ?? "")).getTime();
    const dueDate  = new Date(String(po.DocDueDate ?? "")).getTime();
    const lead     = Math.round((dueDate - created) / 86_400_000);
    if (lead < 0 || lead > 365) continue;
    if (!vendorMap.has(code)) vendorMap.set(code, { name: String(po.CardName ?? ""), leadTimes: [] });
    vendorMap.get(code)!.leadTimes.push(lead);
  }

  const vendors = [...vendorMap.entries()].map(([code, d]) => {
    const avg = d.leadTimes.reduce((s, v) => s + v, 0) / d.leadTimes.length;
    const std = Math.sqrt(d.leadTimes.reduce((s, v) => s + (v - avg) ** 2, 0) / d.leadTimes.length);
    return { code, name: d.name, poCount: d.leadTimes.length, avgLeadDays: +avg.toFixed(1),
      stdDevDays: +std.toFixed(1), minDays: Math.min(...d.leadTimes), maxDays: Math.max(...d.leadTimes),
      reliability: std < 5 ? "high" : std < 15 ? "medium" : "low" };
  }).sort((a, b) => a.avgLeadDays - b.avgLeadDays);

  return textResult({ fromDate, toDate: today.toISOString().slice(0, 10), totalVendors: vendors.length, vendors });
}

async function analyzeOnTimeDelivery(args: unknown): Promise<ToolResponse> {
  const input  = asObject(args ?? {}, "arguments");
  const months = Math.min(optionalNumber(input.months, "months") ?? 6, 24);
  const today  = new Date();
  const fromDt = new Date(today); fromDt.setMonth(fromDt.getMonth() - months);
  const fromDate = fromDt.toISOString().slice(0, 10);

  const grpos = await client.getAll<JsonObject>("/GoodsReceiptsPO", {
    $select: "DocEntry,DocDate,CardCode,CardName,Comments",
    $filter: `DocumentStatus ne 'bost_Cancelled' and DocDate ge '${fromDate}'`,
  });

  const pos = await client.getAll<JsonObject>("/PurchaseOrders", {
    $select: "DocEntry,DocNum,CardCode,CardName,DocDueDate",
    $filter: `DocDate ge '${fromDate}'`,
  });

  const poMap = new Map<number, { dueDate: string; cardCode: string; cardName: string }>();
  for (const po of pos) poMap.set(toNumber(po.DocEntry), { dueDate: String(po.DocDueDate ?? "").slice(0, 10), cardCode: String(po.CardCode ?? ""), cardName: String(po.CardName ?? "") });

  // For each GRPO, find related PO by vendor proximity (same vendor, GRPO date after PO date within window)
  const vendorDeliveries = new Map<string, { name: string; onTime: number; late: number; early: number; delays: number[] }>();

  for (const grpo of grpos) {
    const code = String(grpo.CardCode ?? "");
    if (!code) continue;
    const grpoDate = String(grpo.DocDate ?? "").slice(0, 10);
    // Find closest PO for this vendor
    const vendorPos = [...poMap.entries()].filter(([, v]) => v.cardCode === code && v.dueDate);
    if (!vendorPos.length) continue;
    const closest = vendorPos.reduce((best, cur) => {
      const dDiff = Math.abs(new Date(grpoDate).getTime() - new Date(cur[1].dueDate).getTime());
      const bDiff = Math.abs(new Date(grpoDate).getTime() - new Date(best[1].dueDate).getTime());
      return dDiff < bDiff ? cur : best;
    });
    const daysVsDue = Math.round((new Date(grpoDate).getTime() - new Date(closest[1].dueDate).getTime()) / 86_400_000);
    if (!vendorDeliveries.has(code)) vendorDeliveries.set(code, { name: String(grpo.CardName ?? ""), onTime: 0, late: 0, early: 0, delays: [] });
    const vd = vendorDeliveries.get(code)!;
    if (daysVsDue <= 0) { daysVsDue < -1 ? vd.early++ : vd.onTime++; }
    else { vd.late++; vd.delays.push(daysVsDue); }
  }

  const vendors = [...vendorDeliveries.entries()].map(([code, d]) => {
    const total  = d.onTime + d.late + d.early;
    const onTimePct = total > 0 ? +(( (d.onTime + d.early) / total) * 100).toFixed(1) : 0;
    const avgDelay  = d.delays.length > 0 ? +(d.delays.reduce((s, v) => s + v, 0) / d.delays.length).toFixed(1) : 0;
    return { code, name: d.name, totalDeliveries: total, onTime: d.onTime, early: d.early, late: d.late, onTimePct, avgDelayDays: avgDelay };
  }).sort((a, b) => a.onTimePct - b.onTimePct);

  const overallOnTime = vendors.reduce((s, v) => s + v.onTime + v.early, 0);
  const overallTotal  = vendors.reduce((s, v) => s + v.totalDeliveries, 0);

  return textResult({
    fromDate, toDate: today.toISOString().slice(0, 10),
    overallOnTimePct: overallTotal > 0 ? +((overallOnTime / overallTotal) * 100).toFixed(1) : 0,
    vendors,
  });
}

async function analyzeVendorConcentration(args: unknown): Promise<ToolResponse> {
  const input = asObject(args ?? {}, "arguments");
  const { fromDate: defFrom, toDate: defTo } = ytdRange();
  const fromDate = optionalString(input.fromDate, "fromDate") ?? defFrom;
  const toDate   = optionalString(input.toDate,   "toDate")   ?? defTo;

  const invoices = await client.getAll<JsonObject>("/PurchaseInvoices", {
    $select: "CardCode,CardName,DocTotal",
    $filter:  `DocumentStatus ne 'bost_Cancelled' and DocDate ge '${fromDate}' and DocDate le '${toDate}'`,
  });

  const vendorMap = new Map<string, { name: string; total: number; count: number }>();
  for (const inv of invoices) {
    const code = String(inv.CardCode ?? "");
    if (!code) continue;
    if (!vendorMap.has(code)) vendorMap.set(code, { name: String(inv.CardName ?? ""), total: 0, count: 0 });
    const v = vendorMap.get(code)!;
    v.total += toNumber(inv.DocTotal);
    v.count++;
  }

  const total = [...vendorMap.values()].reduce((s, v) => s + v.total, 0);
  let cum = 0;
  const vendors = [...vendorMap.entries()]
    .map(([code, d]) => ({ code, name: d.name, spend: +d.total.toFixed(2), invoiceCount: d.count }))
    .sort((a, b) => b.spend - a.spend)
    .map((v, i) => {
      cum += v.spend;
      return { ...v, spendPct: total > 0 ? +(v.spend / total * 100).toFixed(2) : 0, cumSpendPct: total > 0 ? +(cum / total * 100).toFixed(1) : 0, rank: i + 1 };
    });

  const top3Pct  = vendors.slice(0, 3).reduce((s, v) => s + v.spendPct, 0);
  const top5Pct  = vendors.slice(0, 5).reduce((s, v) => s + v.spendPct, 0);
  const hhi      = +vendors.reduce((s, v) => s + (v.spendPct / 100) ** 2, 0).toFixed(4);

  return textResult({
    fromDate, toDate, totalVendors: vendors.length, totalSpend: +total.toFixed(2),
    concentrationMetrics: { top3SpendPct: +top3Pct.toFixed(1), top5SpendPct: +top5Pct.toFixed(1), hhiIndex: hhi,
      riskLevel: hhi > 0.3 ? "high — too few vendors" : hhi > 0.18 ? "moderate" : "low — well diversified" },
    vendors,
  });
}

async function calcEoq(args: unknown): Promise<ToolResponse> {
  const input         = asObject(args ?? {}, "arguments");
  const orderingCost  = optionalNumber(input.orderingCost,  "orderingCost")  ?? 50;   // cost per order
  const holdingRate   = optionalNumber(input.holdingRate,   "holdingRate")   ?? 0.25; // 25% of unit cost per year
  const demandMonths  = Math.min(optionalNumber(input.demandMonths, "demandMonths") ?? 12, 24);
  const topN          = optionalNumber(input.topN, "topN") ?? 50;

  const now    = new Date();
  const toDate = now.toISOString().slice(0, 10);
  const fromDt = new Date(now); fromDt.setMonth(fromDt.getMonth() - demandMonths);
  const fromDate = fromDt.toISOString().slice(0, 10);

  const [demandRows, priceRows] = await Promise.all([
    callSMLSVC("sales", buildParamList({ fromDate, toDate }), activeCompany),
    client.getAll<JsonObject>("/Items", {
      $select: "ItemCode,LastPurchasePrice",
      $filter:  "ItemType eq 'itItems' and Frozen eq 'tNO'",
    }),
  ]);

  const demandMap = new Map<string, number>();
  for (const r of demandRows) {
    const code = String(r.ItemCode ?? "");
    demandMap.set(code, (demandMap.get(code) ?? 0) + toNumber(r.QuantityInInventoryUoM));
  }

  const priceMap = new Map<string, number>(priceRows.map(r => [String(r.ItemCode ?? ""), toNumber(r.LastPurchasePrice)]));

  const items = [...demandMap.entries()]
    .filter(([, qty]) => qty > 0)
    .map(([code, totalQty]) => {
      const annualDemand = (totalQty / demandMonths) * 12;
      const unitCost     = priceMap.get(code) ?? 1;
      const holdingCostPerUnit = unitCost * holdingRate;
      const eoq = holdingCostPerUnit > 0 ? +Math.sqrt((2 * annualDemand * orderingCost) / holdingCostPerUnit).toFixed(2) : 0;
      const ordersPerYear = eoq > 0 ? +(annualDemand / eoq).toFixed(1) : 0;
      return { code, annualDemand: +annualDemand.toFixed(0), unitCost: +unitCost.toFixed(2), eoq, ordersPerYear };
    })
    .filter(i => i.eoq > 0)
    .sort((a, b) => b.annualDemand - a.annualDemand)
    .slice(0, topN);

  return textResult({
    parameters: { orderingCost, holdingRate, demandMonths },
    totalItems: items.length,
    items,
  });
}

async function getQuotationWinRate(args: unknown): Promise<ToolResponse> {
  const input = asObject(args ?? {}, "arguments");
  const { fromDate: defFrom, toDate: defTo } = ytdRange();
  const fromDate = optionalString(input.fromDate, "fromDate") ?? defFrom;
  const toDate   = optionalString(input.toDate,   "toDate")   ?? defTo;

  const [quotations, orders] = await Promise.all([
    client.getAll<JsonObject>("/Quotations", {
      $select: "DocEntry,DocNum,CardCode,CardName,DocDate,DocTotal,DocumentStatus",
      $filter: `DocDate ge '${fromDate}' and DocDate le '${toDate}'`,
    }),
    client.getAll<JsonObject>("/Orders", {
      $select: "DocEntry,DocNum,CardCode,DocDate,DocTotal",
      $filter: `DocDate ge '${fromDate}' and DocDate le '${toDate}'`,
    }),
  ]);

  const totalQuotations = quotations.length;
  const converted       = quotations.filter(q => q.DocumentStatus === "bost_Close").length;
  const open            = quotations.filter(q => q.DocumentStatus === "bost_Open").length;
  const cancelled       = totalQuotations - converted - open;
  const winRate         = totalQuotations > 0 ? +(converted / totalQuotations * 100).toFixed(1) : 0;

  const totalQuoteValue = quotations.reduce((s, q) => s + toNumber(q.DocTotal), 0);
  const wonValue        = quotations.filter(q => q.DocumentStatus === "bost_Close").reduce((s, q) => s + toNumber(q.DocTotal), 0);

  // By customer
  const custMap = new Map<string, { name: string; total: number; won: number; value: number }>();
  for (const q of quotations) {
    const code = String(q.CardCode ?? "");
    if (!code) continue;
    if (!custMap.has(code)) custMap.set(code, { name: String(q.CardName ?? ""), total: 0, won: 0, value: 0 });
    const c = custMap.get(code)!;
    c.total++;
    c.value += toNumber(q.DocTotal);
    if (q.DocumentStatus === "bost_Close") c.won++;
  }

  const byCustomer = [...custMap.entries()].map(([code, d]) => ({
    code, name: d.name, quotations: d.total, won: d.won, winRate: +(d.won / d.total * 100).toFixed(1), totalValue: +d.value.toFixed(2),
  })).sort((a, b) => b.winRate - a.winRate);

  return textResult({
    fromDate, toDate,
    summary: { totalQuotations, converted, open, cancelled, winRate, totalQuoteValue: +totalQuoteValue.toFixed(2), wonValue: +wonValue.toFixed(2) },
    salesOrders: orders.length,
    byCustomer,
  });
}

async function detectSeasonality(args: unknown): Promise<ToolResponse> {
  const input         = asObject(args ?? {}, "arguments");
  const historyMonths = Math.min(optionalNumber(input.historyMonths, "historyMonths") ?? 36, 60);
  const measure       = (optionalString(input.measure, "measure") ?? "revenue") as string;
  const cardCode      = optionalString(input.cardCode, "cardCode");
  const itemCode      = optionalString(input.itemCode, "itemCode");

  const MEASURE_FIELD: Record<string, string> = {
    revenue:  "NetSalesAmountLC",
    quantity: "QuantityInInventoryUoM",
    gp:       "GrossProfitLC",
  };
  const field = MEASURE_FIELD[measure] ?? "NetSalesAmountLC";

  const now     = new Date();
  const toDate  = now.toISOString().slice(0, 10);
  const fromDt  = new Date(now);
  fromDt.setMonth(fromDt.getMonth() - historyMonths);
  const fromDate = fromDt.toISOString().slice(0, 10);

  const rows    = await callSMLSVC("sales", buildParamList({ fromDate, toDate, cardCode, itemCode }), activeCompany);
  const grouped = aggregateRows(rows, ["PostingYearAndMonth"]);
  const sorted  = sortLimitRows(grouped, "PostingYearAndMonth", "asc");

  if (sorted.length < 6) {
    throw new McpError(ErrorCode.InvalidRequest, "Need at least 6 periods of data for seasonality analysis.");
  }

  const historical = sorted.map(r => ({
    period: String(r["PostingYearAndMonth"]),
    value:  +toNumber(r[field]).toFixed(2),
  }));
  const values = historical.map(h => h.value);

  const seasonality = runSeasonalityCheck(values);

  // Full decomposition series (trend + seasonal + residual per period)
  let decomposition: object[] = [];
  if (values.length >= 12) {
    const { trend, seasonal, residual } = seasonalDecompose(values);
    decomposition = historical.map((h, i) => ({
      period:   h.period,
      actual:   h.value,
      trend:    trend[i]    != null ? +trend[i]!.toFixed(2) : null,
      seasonal: +seasonal[i].toFixed(2),
      residual: residual[i] != null ? +residual[i]!.toFixed(2) : null,
    }));
  }

  return textResult({ measure, field, periods: historical.length, seasonality, decomposition });
}

async function getCustomerDetails(args: unknown): Promise<ToolResponse> {
  const input    = asObject(args, "arguments");
  const cardCode = asString(input.cardCode, "cardCode");
  const data     = await client.get<JsonObject>(`/BusinessPartners(${encodeEntityKey(cardCode)})`);
  return textResult(data);
}

async function getCompanyInfo(_args: unknown): Promise<ToolResponse> {
  try {
    const data = await client.post<JsonObject>("/CompanyService/GetCompanyInfo", {});
    return textResult({ ...data, ActiveDatabase: activeCompany, Namespace: activeNamespace });
  } catch {
    return textResult({ ActiveDatabase: activeCompany, Namespace: activeNamespace });
  }
}

async function switchCompany(args: unknown): Promise<ToolResponse> {
  const input  = asObject(args, "arguments");
  const dbName = asString(input.dbName, "dbName");

  // Logout current session
  try { await client.post("/Logout", {}); } catch { /* ignore */ }

  // Update the client config and login with new DB
  const cfg = getConfig();
  (cfg as { company: string }).company = dbName;
  client = new SapB1ServiceLayerClient({ ...cfg, company: dbName });
  await client.login();
  activeCompany   = dbName;
  activeNamespace = null;
  smlUnavailable  = false; // re-probe — the new company may be on a different (HANA) backend
  await resolveNamespace(dbName);

  return textResult({ message: `Switched to ${dbName}`, namespace: activeNamespace, company: dbName });
}

// ─────────────────────────────────────────────────────────────────────────────
// GENERIC HANA MODEL VIEW QUERY — sml.svc OData GET
// ─────────────────────────────────────────────────────────────────────────────
// ── Fallback map: HANA view → equivalent Service Layer endpoint + hints ──────
const SML_FALLBACK: Record<string, { endpoint: string; expand?: string; note: string }> = {
  SalesOrderHeaderQuery:              { endpoint: "/Orders",          note: "Use $filter=DocumentStatus eq 'O' for open orders. Key fields: DocNum, CardCode, CardName, DocDate, DocTotal." },
  SalesOrderDetailQuery:              { endpoint: "/Orders",          expand: "DocumentLines", note: "Expand DocumentLines for line-level data. Fields: ItemCode, ItemDescription, Quantity, Price, LineTotal." },
  SalesQuotationHeaderQuery:          { endpoint: "/Quotations",      note: "Key fields: DocNum, CardCode, CardName, DocDate, DocTotal, DocumentStatus." },
  SalesQuotationDetailQuery:          { endpoint: "/Quotations",      expand: "DocumentLines", note: "Expand DocumentLines for item detail." },
  ARInvoiceHeaderQuery:               { endpoint: "/Invoices",        note: "Key fields: DocNum, CardCode, CardName, DocDate, DocTotal, DocumentStatus, PaidToDate." },
  ARInvoiceDetailQuery:               { endpoint: "/Invoices",        expand: "DocumentLines", note: "Expand DocumentLines for line-level invoice data." },
  ARCreditMemoHeaderQuery:            { endpoint: "/CreditNotes",     note: "AR credit memos. Key fields: DocNum, CardCode, DocTotal." },
  ARCreditMemoDetailQuery:            { endpoint: "/CreditNotes",     expand: "DocumentLines", note: "Expand DocumentLines for credit memo line detail." },
  DeliveryHeaderQuery:                { endpoint: "/DeliveryNotes",   note: "Key fields: DocNum, CardCode, CardName, DocDate, DocumentStatus." },
  DeliveryDetailQuery:                { endpoint: "/DeliveryNotes",   expand: "DocumentLines", note: "Expand DocumentLines for delivery line detail." },
  ReturnHeaderQuery:                  { endpoint: "/Returns",         note: "Sales return documents." },
  ReturnDetailQuery:                  { endpoint: "/Returns",         expand: "DocumentLines", note: "Expand DocumentLines for return line detail." },
  PurchaseOrderHeaderQuery:           { endpoint: "/PurchaseOrders",  note: "Key fields: DocNum, CardCode, CardName, DocDate, DocTotal, DocumentStatus." },
  PurchaseOrderDetailQuery:           { endpoint: "/PurchaseOrders",  expand: "DocumentLines", note: "Expand DocumentLines for PO line detail." },
  GoodsReceiptPOHeaderQuery:          { endpoint: "/PurchaseDeliveryNotes", note: "Goods Receipt PO headers." },
  GoodsReceiptPODetailQuery:          { endpoint: "/PurchaseDeliveryNotes", expand: "DocumentLines", note: "Expand DocumentLines for GRPO line detail." },
  APInvoiceHeaderQuery:               { endpoint: "/PurchaseInvoices", note: "AP invoice headers." },
  APInvoiceDetailQuery:               { endpoint: "/PurchaseInvoices", expand: "DocumentLines", note: "Expand DocumentLines for AP invoice line detail." },
  APCreditMemoHeaderQuery:            { endpoint: "/PurchaseCreditNotes", note: "AP credit memo headers." },
  GoodsReturnHeaderQuery:             { endpoint: "/PurchaseReturns", note: "Purchase return headers." },
  GoodsReturnDetailQuery:             { endpoint: "/PurchaseReturns", expand: "DocumentLines", note: "Expand DocumentLines for purchase return line detail." },
  InventoryStatusQuery:               { endpoint: "/Items",           note: "Use $select=ItemCode,ItemName,QuantityOnStock,QuantityOnOrder. For warehouse-level stock use /ItemWarehouseInfoCollection." },
  SalesAnalysisQuery:                 { endpoint: "/Invoices",        note: "Aggregate DocTotal and GrossProfit from AR Invoices grouped by CardCode or ItemCode via $filter and $orderby." },
  PurchaseAnalysisQuery:              { endpoint: "/PurchaseInvoices", note: "Aggregate from AP Invoices." },
  CustomerReceivableAgingQuery:       { endpoint: "/Invoices",        note: "Filter by DocumentStatus eq 'O' and DocDate for aging buckets." },
  AgingQuery:                         { endpoint: "/Invoices",        note: "Filter open invoices by DocDate ranges for aging analysis." },
  VendorPaymentAgingQuery:            { endpoint: "/PurchaseInvoices", note: "Filter open AP invoices by DocDate ranges." },
};

async function querySmlView(args: unknown): Promise<ToolResponse> {
  const input = asObject(args, "arguments");
  const viewName = asString(input.viewName, "viewName");
  // Prevent path traversal: only alphanumeric + underscore allowed
  if (!/^[A-Za-z0-9_]+$/.test(viewName)) {
    throw new McpError(ErrorCode.InvalidParams, `viewName must be alphanumeric (no slashes or special chars): ${viewName}`);
  }
  const top = optionalNumber(input.top, "top");
  const params: Record<string, unknown> = {};
  if (top != null && top > 0) params["$top"] = top;
  if (input.filter)  params["$filter"]  = asString(input.filter,  "filter");
  if (input.select)  params["$select"]  = asString(input.select,  "select");
  if (input.orderby) params["$orderby"] = asString(input.orderby, "orderby");
  if (input.skip != null) params["$skip"] = asNumber(input.skip, "skip");

  // ── Tier 0: Namespace POST for analytics views (most reliable on HANA) ───
  const NS_QUERY_TYPE: Record<string, string> = {
    SalesAnalysisQuery:    "sales",
    PurchaseAnalysisQuery: "purchase",
    InventoryStatusQuery:  "inventory",
  };
  if (activeNamespace && NS_QUERY_TYPE[viewName]) {
    const qt = NS_QUERY_TYPE[viewName] as "sales" | "purchase" | "inventory";
    // Convert OData filter → ParamList (best-effort date extraction)
    const rawFilter = input.filter ? asString(input.filter, "filter") : "";
    const fromMatch = rawFilter.match(/(?:PostingDate|DocDate)\s+ge\s+'?(\d{4}-\d{2}-\d{2})'?/i);
    const toMatch   = rawFilter.match(/(?:PostingDate|DocDate)\s+le\s+'?(\d{4}-\d{2}-\d{2})'?/i);
    const yearMatch = rawFilter.match(/PostingYear\s+eq\s+(\d{4})/i);
    const moMatch   = rawFilter.match(/PostingMonth\s+eq\s+(\d{1,2})/i);
    let fromDate = fromMatch?.[1] ?? "";
    let toDate   = toMatch?.[1]   ?? "";
    // Translate PostingYear/PostingMonth to date range
    if (!fromDate && yearMatch) {
      const y = yearMatch[1], mo = moMatch ? moMatch[1].padStart(2,"0") : "01";
      const lastDay = moMatch ? new Date(Number(y), Number(mo), 0).getDate() : 31;
      fromDate = `${y}-${mo}-01`;
      toDate   = toDate || `${y}-${moMatch ? mo : "12"}-${String(lastDay).padStart(2,"0")}`;
    }
    const plArgs: Parameters<typeof buildParamList>[0] = {};
    if (fromDate) plArgs.fromDate = fromDate;
    if (toDate)   plArgs.toDate   = toDate;
    const pl = buildParamList(plArgs);
    const nsPathMap: Record<string, string> = {
      sales:     `${activeNamespace}.ar.case/SalesAnalysisQuery`,
      purchase:  `${activeNamespace}.ap.case/PurchaseAnalysis`,
      inventory: `${activeNamespace}.inv.case/InventoryStatus`,
    };
    try {
      const nsData = await client.smlPost<{ value?: JsonObject[] }>(smlBase, nsPathMap[qt], { ParamList: pl });
      if (Array.isArray(nsData.value)) {
        // Client-side ObjType filter (ObjType eq '17' etc.)
        const objTypeMatch = rawFilter.match(/ObjType\s+eq\s+'?(\d+)'?/i);
        let rows: JsonObject[] = nsData.value;
        if (objTypeMatch) {
          const ot = Number(objTypeMatch[1]);
          rows = rows.filter(r => Number(r["ObjType"]) === ot);
        }
        const clean = rows.map(r => { const c = { ...r }; delete c["id__"]; return c; });
        return textResult({ viewName, source: "SMLSVC POST (namespace)", count: clean.length, rows: clean });
      }
    } catch {
      // namespace POST failed — fall through to OData GET
    }
  }

  try {
    if (smlUnavailable) throw new Error("sml.svc unavailable for this company (SQL Server-backed)");
    // sml.svc lives under /b1s/ not /b1s/v2/ — use smlBase
    const data = await client.smlGet<{ value?: JsonObject[] }>(smlBase, viewName, params);
    const rows = Array.isArray(data.value) ? data.value : [];
    // Strip internal SAP key field
    const clean = rows.map(r => { const c = { ...r }; delete c["id__"]; return c; });
    return textResult({ viewName, count: clean.length, rows: clean });
  } catch (err: unknown) {
    // sml.svc view not available — fall back to Service Layer with translated filter
    const fbMap = SML_FALLBACK[viewName];
    if (fbMap) {
      // Translate HANA-specific OData fields to Service Layer equivalents
      const rawFilter = input.filter ? asString(input.filter, "filter") : "";

      // Detect ObjType to pick the right SL endpoint
      let slEndpoint = fbMap.endpoint;
      const objTypeMatch = rawFilter.match(/ObjType\s+eq\s+'?(\d+)'?/i);
      if (objTypeMatch) {
        const ot = objTypeMatch[1];
        if (ot === "17") slEndpoint = "/Orders";
        else if (ot === "23") slEndpoint = "/DeliveryNotes";
        else if (ot === "14") slEndpoint = "/CreditNotes";
      }

      // Translate HANA filter fields → SL OData fields
      let slFilter = rawFilter
        .replace(/PostingYear\s+eq\s+(\d{4})\s+and\s+PostingMonth\s+eq\s+(\d{1,2})/gi,
          (_m: string, y: string, mo: string) => {
            const lastDay = new Date(Number(y), Number(mo), 0).getDate();
            return `DocDate ge '${y}-${mo.padStart(2,"0")}-01' and DocDate le '${y}-${mo.padStart(2,"0")}-${String(lastDay).padStart(2,"0")}'`;
          })
        .replace(/PostingYear\s+eq\s+(\d{4})/gi, (_m: string, y: string) =>
          `DocDate ge '${y}-01-01' and DocDate le '${y}-12-31'`)
        .replace(/PostingMonth\s+eq\s+(\d{1,2})/gi, "")
        .replace(/ObjType\s+eq\s+'?\d+'?/gi, "")
        .replace(/\s+and\s+and\s+/gi, " and ")
        .replace(/^\s*and\s+|\s+and\s*$/gi, "")
        .trim();

      const slParams: Record<string, unknown> = {};
      if (slFilter)       slParams["$filter"]  = slFilter;
      if (input.select)   slParams["$select"]  = asString(input.select,  "select");
      if (input.orderby)  slParams["$orderby"] = asString(input.orderby, "orderby");
      if (input.skip != null) slParams["$skip"] = asNumber(input.skip, "skip");
      const top = optionalNumber(input.top, "top");
      if (top != null && top > 0) slParams["$top"] = top;
      if (fbMap.expand) slParams["$expand"] = fbMap.expand;
      try {
        const slData = await client.get<{ value?: JsonObject[] }>(slEndpoint, slParams);
        const rows   = Array.isArray(slData.value) ? slData.value : [];
        return textResult({ viewName, fallbackEndpoint: slEndpoint, count: rows.length, rows,
          note: "Fetched via Service Layer fallback (sml.svc unavailable). Brand/cost-centre fields not available in this fallback." });
      } catch (slErr: unknown) {
        // Both sml.svc and SL fallback failed — return actionable hint
        return textResult({
          viewName,
          error: `View '${viewName}' unavailable and Service Layer fallback (${slEndpoint}) also failed: ${slErr instanceof Error ? slErr.message : String(slErr)}`,
          suggestion: `Use get_sales_analysis tool instead: it calls SMLSVC POST which works without sml.svc GET. Example: get_sales_analysis(fromDate='2025-06-01', toDate='2025-06-30', groupBy='CogsOcrCod', docType='order')`,
        });
      }
    }
    // No known fallback — try generic Service Layer call_service_layer hint
    return textResult({
      viewName,
      notice: `View '${viewName}' is not available on this SAP B1 instance. Use call_service_layer with standard endpoints: /Orders, /Invoices, /Quotations, /PurchaseOrders, /Items, /BusinessPartners.`,
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// P2P (PURCHASE-TO-PAY) WORKFLOW TOOLS
// ─────────────────────────────────────────────────────────────────────────────

async function createPurchaseRequest(args: unknown): Promise<ToolResponse> {
  const input = asObject(args, "arguments");
  const cardCode = optionalString(input.cardCode, "cardCode");
  const docDate = parseDateOrToday(input.docDate, "docDate");
  const docDueDate = parseDateOrToday(input.docDueDate, "docDueDate");
  const comments = optionalString(input.comments, "comments");

  const requester = optionalString(input.requester, "requester") ?? getConfig().user;

  const rawLines = asArray(input.lines, "lines").map((line, index) => {
    const item = asObject(line, `lines[${index}]`);
    return {
      ItemCode:      asString(item.itemCode,   `lines[${index}].itemCode`),
      Quantity:      asNumber(item.quantity,   `lines[${index}].quantity`),
      UnitPrice:     optionalNumber(item.unitPrice,     `lines[${index}].unitPrice`),
      WarehouseCode: asString(item.warehouseCode, `lines[${index}].warehouseCode`),
      RequiredDate:  optionalString(item.requiredDate, `lines[${index}].requiredDate`) ?? docDueDate,
    };
  });
  const uomCodes = await Promise.all(rawLines.map((line) => getDefaultUoMCode(line.ItemCode)));
  const lines = rawLines.map((line, index) => ({
    ...line,
    ...(uomCodes[index] ? { UoMCode: uomCodes[index] } : {}),
  }));

  // SAP B1 rejects PurchaseRequests with no Requester on companies where the field is mandatory.
  const pr = await client.post<JsonObject>("/PurchaseRequests", {
    ...(cardCode ? { CardCode: cardCode } : {}),
    DocDate: docDate,
    DocDueDate: docDueDate,
    Requester: requester,
    Comments: comments,
    DocumentLines: lines,
  });

  return textResult({
    purchaseRequest: {
      DocEntry: pr.DocEntry,
      DocNum:   pr.DocNum,
      CardCode: pr.CardCode ?? cardCode,
    },
  });
}

async function createPurchaseQuotation(args: unknown): Promise<ToolResponse> {
  const input = asObject(args, "arguments");
  const purchaseRequestDocEntry = optionalNumber(input.purchaseRequestDocEntry, "purchaseRequestDocEntry");
  const cardCode = asString(input.cardCode, "cardCode");
  const docDate = parseDateOrToday(input.docDate, "docDate");
  const docDueDate = parseDateOrToday(input.docDueDate, "docDueDate");
  const comments = optionalString(input.comments, "comments");

  let documentLines: JsonObject[];

  if (purchaseRequestDocEntry != null) {
    // Copy lines from an existing Purchase Request
    const pr = await getDocument<JsonObject>("PurchaseRequests", purchaseRequestDocEntry);
    if (pr.DocumentStatus === "bost_Close") {
      throw new McpError(ErrorCode.InvalidRequest, `Purchase request ${purchaseRequestDocEntry} is already closed.`);
    }
    const prLines = asArray(pr.DocumentLines, "pr.DocumentLines");
    documentLines = prLines
      .map((line, index) => {
        const item = asObject(line, `pr.DocumentLines[${index}]`);
        const openQty = toNumber(item.RemainingOpenQuantity ?? item.OpenQuantity ?? item.Quantity);
        if (openQty <= 0) return null;
        return {
          BaseType:  BASE_DOCUMENT_TYPE.purchaseRequest,
          BaseEntry: purchaseRequestDocEntry,
          BaseLine:  asNumber(item.LineNum, `pr.DocumentLines[${index}].LineNum`),
          Quantity:  openQty,
        } as JsonObject;
      })
      .filter((l): l is JsonObject => l !== null);

    if (documentLines.length === 0) {
      throw new McpError(ErrorCode.InvalidRequest, "No open purchase request lines available for quotation.");
    }
  } else {
    // Create from scratch
    const rawLines = asArray(input.lines, "lines").map((line, index) => {
      const item = asObject(line, `lines[${index}]`);
      return {
        ItemCode:      asString(item.itemCode,   `lines[${index}].itemCode`),
        Quantity:      asNumber(item.quantity,   `lines[${index}].quantity`),
        UnitPrice:     optionalNumber(item.unitPrice,     `lines[${index}].unitPrice`),
        TaxCode:       optionalString(item.taxCode,       `lines[${index}].taxCode`),
        WarehouseCode: optionalString(item.warehouseCode, `lines[${index}].warehouseCode`),
      } as JsonObject;
    });
    const uomCodes = await Promise.all(rawLines.map((line) => getDefaultUoMCode(line.ItemCode as string)));
    documentLines = rawLines.map((line, index) => ({
      ...line,
      ...(uomCodes[index] ? { UoMCode: uomCodes[index] } : {}),
    }));
  }

  const pq = await client.post<JsonObject>("/PurchaseQuotations", {
    CardCode: cardCode,
    DocDate: docDate,
    DocDueDate: docDueDate,
    Comments: comments ?? (purchaseRequestDocEntry != null
      ? buildComment(["Created from purchase request", `PR DocEntry ${purchaseRequestDocEntry}`])
      : undefined),
    DocumentLines: documentLines,
  });

  return textResult({
    purchaseQuotation: {
      DocEntry: pq.DocEntry,
      DocNum:   pq.DocNum,
      CardCode: pq.CardCode ?? cardCode,
      ...(purchaseRequestDocEntry != null ? { basedOnPurchaseRequest: purchaseRequestDocEntry } : {}),
    },
  });
}

async function createPoFromQuotation(args: unknown): Promise<ToolResponse> {
  const input = asObject(args, "arguments");
  const purchaseQuotationDocEntry = asNumber(input.purchaseQuotationDocEntry, "purchaseQuotationDocEntry");
  const docDate = parseDateOrToday(input.docDate, "docDate");
  const docDueDate = parseDateOrToday(input.docDueDate, "docDueDate");
  const comments = optionalString(input.comments, "comments");

  const pq = await getDocument<JsonObject>("PurchaseQuotations", purchaseQuotationDocEntry);
  if (pq.DocumentStatus === "bost_Close") {
    throw new McpError(ErrorCode.InvalidRequest, `Purchase quotation ${purchaseQuotationDocEntry} is already closed.`);
  }

  const poLines = (asArray(pq.DocumentLines, "pq.DocumentLines")
    .map((line, index) => {
      const item = asObject(line, `pq.DocumentLines[${index}]`);
      const openQty = toNumber(item.RemainingOpenQuantity ?? item.OpenQuantity ?? item.Quantity);
      if (openQty <= 0) return null;
      return {
        BaseType:  BASE_DOCUMENT_TYPE.purchaseQuotation,
        BaseEntry: purchaseQuotationDocEntry,
        BaseLine:  asNumber(item.LineNum, `pq.DocumentLines[${index}].LineNum`),
        Quantity:  openQty,
      } as JsonObject;
    })
    .filter((l): l is JsonObject => l !== null));

  if (poLines.length === 0) {
    throw new McpError(ErrorCode.InvalidRequest, "No open purchase quotation lines available for purchase order.");
  }

  const po = await client.post<JsonObject>("/PurchaseOrders", {
    CardCode: asString(pq.CardCode, "pq.CardCode"),
    DocDate: docDate,
    DocDueDate: docDueDate,
    Comments: comments ?? buildComment(["Created from purchase quotation", `PQ DocEntry ${purchaseQuotationDocEntry}`]),
    DocumentLines: poLines,
  });

  return textResult({
    purchaseOrder: {
      DocEntry:           po.DocEntry,
      DocNum:             po.DocNum,
      CardCode:           po.CardCode ?? pq.CardCode,
      DocTotal:           po.DocTotal,
      DocCurrency:        po.DocCurrency,
      basedOnQuotation:   purchaseQuotationDocEntry,
    },
  });
}

// SAP B1 rejects DocumentLines with no UoMCode once UoM management is enabled on the item —
// resolve the item's default purchasing/sales UoM so callers don't need to know it up front.
async function getDefaultUoMCode(itemCode: string, kind: "purchase" | "sales" = "purchase"): Promise<string | undefined> {
  try {
    const item = await client.get<JsonObject>(`/Items(${encodeEntityKey(itemCode)})`, {
      $select: "ItemCode,PurchaseUnit,InventoryUOM,SalesUnit",
    });
    const primary = kind === "sales" ? item.SalesUnit : item.PurchaseUnit;
    return (
      (primary as string | undefined) ||
      (item.InventoryUOM as string | undefined) ||
      (item.PurchaseUnit as string | undefined) ||
      (item.SalesUnit as string | undefined) ||
      undefined
    );
  } catch {
    return undefined;
  }
}

async function createPurchaseOrder(args: unknown): Promise<ToolResponse> {
  const input = asObject(args, "arguments");
  const cardCode = asString(input.cardCode, "cardCode");
  const docDate = parseDateOrToday(input.docDate, "docDate");
  const docDueDate = parseDateOrToday(input.docDueDate, "docDueDate");
  const comments = optionalString(input.comments, "comments");

  const rawLines = asArray(input.lines, "lines").map((line, index) => {
    const item = asObject(line, `lines[${index}]`);
    return {
      ItemCode:      asString(item.itemCode,   `lines[${index}].itemCode`),
      Quantity:      asNumber(item.quantity,   `lines[${index}].quantity`),
      UnitPrice:     optionalNumber(item.unitPrice,     `lines[${index}].unitPrice`),
      TaxCode:       optionalString(item.taxCode,       `lines[${index}].taxCode`),
      WarehouseCode: optionalString(item.warehouseCode, `lines[${index}].warehouseCode`),
    };
  });

  const uomCodes = await Promise.all(rawLines.map((line) => getDefaultUoMCode(line.ItemCode)));
  const lines = rawLines.map((line, index) => ({
    ...line,
    ...(uomCodes[index] ? { UoMCode: uomCodes[index] } : {}),
  }));

  const po = await client.post<JsonObject>("/PurchaseOrders", {
    CardCode: cardCode,
    DocDate: docDate,
    DocDueDate: docDueDate,
    Comments: comments,
    DocumentLines: lines,
  });

  return textResult({
    purchaseOrder: {
      DocEntry: po.DocEntry,
      DocNum: po.DocNum,
      CardCode: po.CardCode ?? cardCode,
      DocTotal: po.DocTotal,
      DocCurrency: po.DocCurrency,
    },
  });
}

async function createGoodsReceiptPo(args: unknown): Promise<ToolResponse> {
  const input = asObject(args, "arguments");
  const purchaseOrderDocEntry = asNumber(input.purchaseOrderDocEntry, "purchaseOrderDocEntry");
  const receivedDate = parseDateOrToday(input.receivedDate, "receivedDate");

  const po = await getDocument<JsonObject>("PurchaseOrders", purchaseOrderDocEntry);

  if (po.DocumentStatus === "bost_Close") {
    throw new McpError(ErrorCode.InvalidRequest, `Purchase order ${purchaseOrderDocEntry} is already closed.`);
  }

  const grpoLines = (asArray(po.DocumentLines, "po.DocumentLines")
    .map((line, index) => {
      const item = asObject(line, `po.DocumentLines[${index}]`);
      const openQty = toNumber(item.RemainingOpenQuantity ?? item.OpenQuantity);
      if (openQty <= 0) return null;
      return {
        BaseType:      BASE_DOCUMENT_TYPE.purchaseOrder,
        BaseEntry:     purchaseOrderDocEntry,
        BaseLine:      asNumber(item.LineNum, `po.DocumentLines[${index}].LineNum`),
        Quantity:      openQty,
        WarehouseCode: optionalString(item.WarehouseCode, "WarehouseCode"),
      };
    })
    .filter(Boolean)) as Array<{
    BaseType: typeof BASE_DOCUMENT_TYPE.purchaseOrder;
    BaseEntry: number;
    BaseLine: number;
    Quantity: number;
    WarehouseCode: string | undefined;
  }>;

  if (grpoLines.length === 0) {
    throw new McpError(ErrorCode.InvalidRequest, "No open purchase order lines available for goods receipt.");
  }

  const grpo = await client.post<JsonObject>("/GoodsReceiptsPO", {
    CardCode: po.CardCode,
    DocDate: receivedDate,
    Comments: buildComment(["Created from purchase order", `PO DocEntry ${purchaseOrderDocEntry}`]),
    DocumentLines: grpoLines,
  });

  return textResult({
    goodsReceiptPO: {
      DocEntry: grpo.DocEntry,
      DocNum: grpo.DocNum,
      CardCode: grpo.CardCode ?? po.CardCode,
      DocDate: receivedDate,
      DocTotal: grpo.DocTotal,
    },
  });
}

async function createApInvoice(args: unknown): Promise<ToolResponse> {
  const input = asObject(args, "arguments");
  const grpoDocEntry = asNumber(input.grpoDocEntry, "grpoDocEntry");
  const dueInDays = optionalNumber(input.dueInDays, "dueInDays") ?? 30;
  const docDateText = parseDateOrToday(input.docDate, "docDate");
  const docDate = new Date(docDateText);
  const dueDate = new Date(docDate.getTime());
  dueDate.setDate(dueDate.getDate() + dueInDays);

  const grpo = await getDocument<JsonObject>("GoodsReceiptsPO", grpoDocEntry);
  const invoiceLines = asArray(grpo.DocumentLines, "grpo.DocumentLines").map((line, index) => {
    const item = asObject(line, `grpo.DocumentLines[${index}]`);
    return {
      BaseType:  BASE_DOCUMENT_TYPE.goodsReceiptPo,
      BaseEntry: grpoDocEntry,
      BaseLine:  asNumber(item.LineNum, `grpo.DocumentLines[${index}].LineNum`),
    };
  });

  const invoice = await client.post<JsonObject>("/PurchaseInvoices", {
    CardCode:    grpo.CardCode,
    DocDate:     docDate.toISOString().slice(0, 10),
    DocDueDate:  dueDate.toISOString().slice(0, 10),
    TaxDate:     docDate.toISOString().slice(0, 10),
    Comments:    buildComment([`Created from GRPO ${grpoDocEntry}`, `Due in ${dueInDays} days`]),
    DocumentLines: invoiceLines,
  });

  return textResult({
    apInvoice: {
      DocEntry:    invoice.DocEntry,
      DocNum:      invoice.DocNum,
      CardCode:    invoice.CardCode ?? grpo.CardCode,
      DocTotal:    invoice.DocTotal,
      VatSum:      invoice.VatSum,
      DocDueDate:  invoice.DocDueDate ?? dueDate.toISOString().slice(0, 10),
    },
  });
}

async function applyOutgoingPayment(args: unknown): Promise<ToolResponse> {
  const input = asObject(args, "arguments");
  const cardCode = asString(input.cardCode, "cardCode");
  const amount = asNumber(input.amount, "amount");
  const invoiceDocEntries = asArray(input.invoiceDocEntries, "invoiceDocEntries").map((entry, index) =>
    asNumber(entry, `invoiceDocEntries[${index}]`)
  );
  const cashAccount = optionalString(input.cashAccount, "cashAccount");
  const transferAccount = optionalString(input.transferAccount, "transferAccount");
  const transferReference = optionalString(input.transferReference, "transferReference");

  if (!cashAccount && !transferAccount) {
    throw new McpError(ErrorCode.InvalidParams, "Provide either cashAccount or transferAccount so SAP can post the outgoing payment.");
  }

  const invoices = await Promise.all(
    invoiceDocEntries.map((docEntry) => getDocument<JsonObject>("PurchaseInvoices", docEntry))
  );

  const openBalances = invoices.map((invoice) => ({
    DocEntry:    invoice.DocEntry as number,
    openBalance: toNumber(invoice.DocTotal) - toNumber(invoice.PaidToDate),
  }));

  const totalOpen = openBalances.reduce((sum, inv) => sum + inv.openBalance, 0);
  if (totalOpen <= 0) {
    throw new McpError(ErrorCode.InvalidRequest, "All specified invoices are already fully paid.");
  }

  let remaining = amount;
  const paymentInvoices = openBalances.map(({ DocEntry, openBalance }) => {
    const proportional = totalOpen > 0 ? (openBalance / totalOpen) * amount : 0;
    const sumApplied = Math.min(proportional, openBalance, remaining);
    remaining -= sumApplied;
    return {
      DocEntry,
      SumApplied:  Math.round(sumApplied * 100) / 100,
      InvoiceType: "it_PurchaseInvoice",
    };
  });

  const payload: JsonObject = {
    CardCode:      cardCode,
    DocDate:       parseDateOrToday(input.docDate, "docDate"),
    TransferDate:  parseDateOrToday(input.docDate, "docDate"),
    Remarks:       optionalString(input.remarks, "remarks") ?? "Applied by MCP payment agent",
    PaymentInvoices: paymentInvoices,
  };

  if (cashAccount) {
    payload.CashAccount = cashAccount;
    payload.CashSum = amount;
  }
  if (transferAccount) {
    payload.TransferAccount = transferAccount;
    payload.TransferSum = amount;
    if (transferReference) payload.TransferReference = transferReference;
  }

  const payment = await client.post<JsonObject>("/VendorPayments", payload);

  return textResult({
    payment: {
      DocEntry:     payment.DocEntry,
      DocNum:       payment.DocNum,
      CardCode:     payment.CardCode ?? cardCode,
      TransferSum:  payment.TransferSum,
      CashSum:      payment.CashSum,
    },
    clearedInvoices: paymentInvoices,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// PROCUREMENT & REORDER AGENT
// ─────────────────────────────────────────────────────────────────────────────

async function monitorReorderItems(args: unknown): Promise<ToolResponse> {
  const input         = asObject(args ?? {}, "arguments");
  const warehouseCode = optionalString(input.warehouseCode, "warehouseCode");
  const topN          = optionalNumber(input.topN, "topN") ?? 100;
  const today         = new Date().toISOString().slice(0, 10);

  const items = await client.getAll<JsonObject>("/Items", {
    $select: "ItemCode,ItemName,QuantityOnStock,QuantityOnOrder,MinInventory,DefaultVendor,LastPurchasePrice",
    $filter:  "ItemType eq 'itItems' and Frozen eq 'tNO'",
  });

  const whseStockMap = new Map<string, number>();
  const whseMinMap   = new Map<string, number>();
  if (warehouseCode) {
    const rows = await client.getAll<JsonObject>("/ItemWarehouseInfoCollection", {
      $select: "ItemCode,WarehouseCode,InStock,MinStock",
      $filter: `WarehouseCode eq '${warehouseCode.replace(/'/g, "''")}'`,
    });
    for (const r of rows) {
      const code = String(r.ItemCode ?? "");
      whseStockMap.set(code, toNumber(r.InStock));
      whseMinMap.set(code,   toNumber(r.MinStock));
    }
  }

  const belowMin: JsonObject[] = [];
  for (const item of items) {
    const code     = String(item.ItemCode ?? "");
    const inStock  = warehouseCode ? (whseStockMap.get(code) ?? 0) : toNumber(item.QuantityOnStock);
    const minStock = warehouseCode
      ? (whseMinMap.get(code) ?? toNumber(item.MinInventory))
      : toNumber(item.MinInventory);

    if (minStock <= 0 || inStock >= minStock) continue;

    const deficit    = +(minStock - inStock).toFixed(2);
    const suggestQty = Math.max(0, +(minStock * 2 - inStock).toFixed(2));
    const vendor     = optionalString(item.DefaultVendor, "DefaultVendor") ?? null;
    const price      = toNumber(item.LastPurchasePrice);

    belowMin.push({
      itemCode:          code,
      itemName:          String(item.ItemName ?? ""),
      currentStock:      +inStock.toFixed(2),
      minimumStock:      +minStock.toFixed(2),
      onOrder:           +toNumber(item.QuantityOnOrder).toFixed(2),
      deficit,
      suggestedOrderQty: suggestQty,
      preferredVendor:   vendor,
      lastPurchasePrice: +price.toFixed(4),
      estimatedCost:     +(suggestQty * price).toFixed(2),
    });
  }

  belowMin.sort((a, b) => toNumber(b.deficit) - toNumber(a.deficit));
  const limited    = belowMin.slice(0, topN);
  const withVendor = limited.filter(i => i.preferredVendor).length;
  const totalCost  = limited.reduce((s, i) => s + toNumber(i.estimatedCost), 0);

  return textResult({
    asOfDate: today,
    warehouseCode: warehouseCode ?? "all",
    summary: {
      itemsBelowMinimum:              belowMin.length,
      returnedCount:                  limited.length,
      withPreferredVendor:            withVendor,
      withoutPreferredVendor:         limited.length - withVendor,
      totalEstimatedReplenishmentCost: +totalCost.toFixed(2),
    },
    items: limited,
  });
}

async function aggregateProcurementDemand(args: unknown): Promise<ToolResponse> {
  const input = asObject(args ?? {}, "arguments");
  const topN  = optionalNumber(input.topN, "topN") ?? 100;
  const today = new Date().toISOString().slice(0, 10);

  const [soHeaders, prodOrders, stockRows] = await Promise.all([
    client.getAll<JsonObject>("/Orders", {
      $select: "DocEntry,DocNum,CardCode,DocDate",
      $filter: "DocumentStatus eq 'bost_Open'",
      $expand: "DocumentLines($select=ItemCode,OpenQuantity,Quantity,ShippedQuantity)",
    }),
    client.getAll<JsonObject>("/ProductionOrders", {
      $select: "AbsoluteEntry,DocumentNumber,ItemNo,PlannedQuantity,CompletedQuantity,ProductionOrderStatus",
      $filter: "ProductionOrderStatus eq 'boposReleased' or ProductionOrderStatus eq 'boposPlanned'",
    }),
    client.getAll<JsonObject>("/Items", {
      $select: "ItemCode,ItemName,QuantityOnStock,QuantityOnOrder,DefaultVendor",
      $filter:  "ItemType eq 'itItems' and Frozen eq 'tNO'",
    }),
  ]);

  const stockMap = new Map<string, { stock: number; onOrder: number; name: string; vendor: string | null }>();
  for (const r of stockRows) {
    stockMap.set(String(r.ItemCode ?? ""), {
      stock:   toNumber(r.QuantityOnStock),
      onOrder: toNumber(r.QuantityOnOrder),
      name:    String(r.ItemName ?? ""),
      vendor:  optionalString(r.DefaultVendor, "DefaultVendor") ?? null,
    });
  }

  type DemandEntry = { soDemand: number; prodDemand: number; soRefs: string[]; prodRefs: string[] };
  const demandMap   = new Map<string, DemandEntry>();
  const ensureDemand = (code: string): DemandEntry => {
    if (!demandMap.has(code)) demandMap.set(code, { soDemand: 0, prodDemand: 0, soRefs: [], prodRefs: [] });
    return demandMap.get(code)!;
  };

  for (const so of soHeaders) {
    const lines = Array.isArray(so.DocumentLines) ? so.DocumentLines as JsonObject[] : [];
    const ref   = `SO#${so.DocNum ?? so.DocEntry}`;
    for (const line of lines) {
      const code    = String(line.ItemCode ?? "");
      const openQty = toNumber(line.OpenQuantity ?? (toNumber(line.Quantity) - toNumber(line.ShippedQuantity ?? 0)));
      if (!code || openQty <= 0) continue;
      const d = ensureDemand(code);
      d.soDemand += openQty;
      if (!d.soRefs.includes(ref)) d.soRefs.push(ref);
    }
  }

  for (const wo of prodOrders) {
    const code    = String(wo.ItemNo ?? "");
    const openQty = toNumber(wo.PlannedQuantity) - toNumber(wo.CompletedQuantity ?? 0);
    if (!code || openQty <= 0) continue;
    const d   = ensureDemand(code);
    const ref = `WO#${wo.DocumentNumber ?? wo.AbsoluteEntry}`;
    d.prodDemand += openQty;
    if (!d.prodRefs.includes(ref)) d.prodRefs.push(ref);
  }

  const result = [...demandMap.entries()]
    .map(([code, d]) => {
      const s            = stockMap.get(code);
      const totalDemand  = d.soDemand + d.prodDemand;
      const netShortfall = Math.max(0, totalDemand - (s?.stock ?? 0) - (s?.onOrder ?? 0));
      return {
        itemCode:        code,
        itemName:        s?.name ?? "",
        preferredVendor: s?.vendor ?? null,
        currentStock:    +(s?.stock  ?? 0).toFixed(2),
        onOrder:         +(s?.onOrder ?? 0).toFixed(2),
        openSODemand:    +d.soDemand.toFixed(2),
        prodOrderDemand: +d.prodDemand.toFixed(2),
        totalDemand:     +totalDemand.toFixed(2),
        netShortfall:    +netShortfall.toFixed(2),
        actionRequired:  netShortfall > 0,
        soRefs:          d.soRefs,
        prodRefs:        d.prodRefs,
      };
    })
    .sort((a, b) => b.netShortfall - a.netShortfall)
    .slice(0, topN);

  const itemsNeedingAction = result.filter(i => i.actionRequired).length;
  const totalShortfall     = result.reduce((s, i) => s + i.netShortfall, 0);

  return textResult({
    asOfDate: today,
    openSalesOrders:       soHeaders.length,
    releasedProdOrders:    prodOrders.length,
    uniqueItemsWithDemand: demandMap.size,
    summary: { itemsNeedingAction, totalShortfall: +totalShortfall.toFixed(2) },
    items: result,
  });
}

async function generateDraftPos(args: unknown): Promise<ToolResponse> {
  const input    = asObject(args, "arguments");
  const dryRun   = (input.dryRun as boolean | undefined) ?? false;
  const comments = optionalString(input.comments, "comments");

  const today      = new Date();
  const dueFallback = new Date(today); dueFallback.setDate(today.getDate() + 14);
  const docDueDate  = optionalString(input.docDueDate, "docDueDate")
    ? parseDateOrToday(input.docDueDate, "docDueDate")
    : dueFallback.toISOString().slice(0, 10);
  const docDate     = today.toISOString().slice(0, 10);

  const rawItems = asArray(input.items, "items").map((entry, index) => {
    const item = asObject(entry, `items[${index}]`);
    return {
      itemCode:      asString(item.itemCode,   `items[${index}].itemCode`),
      quantity:      asNumber(item.quantity,   `items[${index}].quantity`),
      unitPrice:     optionalNumber(item.unitPrice,     `items[${index}].unitPrice`),
      warehouseCode: optionalString(item.warehouseCode, `items[${index}].warehouseCode`),
      vendorCode:    optionalString(item.vendorCode,    `items[${index}].vendorCode`),
    };
  });

  if (rawItems.length === 0) throw new McpError(ErrorCode.InvalidParams, "items array is empty.");

  // Resolve preferred vendor for items without an explicit override
  const vendorMap  = new Map<string, string>();
  for (const i of rawItems) { if (i.vendorCode) vendorMap.set(i.itemCode, i.vendorCode); }

  const unresolved = rawItems.filter(i => !vendorMap.has(i.itemCode)).map(i => i.itemCode);
  const batchSize  = 20;
  for (let b = 0; b < unresolved.length; b += batchSize) {
    const batch      = unresolved.slice(b, b + batchSize);
    const filterExpr = batch.map(c => `ItemCode eq '${c.replace(/'/g, "''")}'`).join(" or ");
    const rows       = await client.getAll<JsonObject>("/Items", {
      $select: "ItemCode,DefaultVendor",
      $filter: filterExpr,
    });
    for (const r of rows) {
      const code   = String(r.ItemCode ?? "");
      const vendor = optionalString(r.DefaultVendor, "DefaultVendor");
      if (code && vendor) vendorMap.set(code, vendor);
    }
  }

  // Group by vendor
  const vendorGroups  = new Map<string, typeof rawItems>();
  const noVendorItems: string[] = [];
  for (const item of rawItems) {
    const vendor = vendorMap.get(item.itemCode);
    if (!vendor) { noVendorItems.push(item.itemCode); continue; }
    if (!vendorGroups.has(vendor)) vendorGroups.set(vendor, []);
    vendorGroups.get(vendor)!.push(item);
  }

  const purchaseOrders: JsonObject[] = [];

  for (const [vendorCode, vendorItems] of vendorGroups) {
    const entry: JsonObject = {
      vendorCode,
      lineCount: vendorItems.length,
      items: vendorItems.map(i => ({ itemCode: i.itemCode, quantity: i.quantity })),
    };

    if (!dryRun) {
      try {
        const po = await client.post<JsonObject>("/PurchaseOrders", {
          CardCode:      vendorCode,
          DocDate:       docDate,
          DocDueDate:    docDueDate,
          Comments:      comments ?? buildComment(["Auto-generated by Reorder Agent", `${vendorItems.length} line(s)`]),
          DocumentLines: vendorItems.map(i => ({
            ItemCode:  i.itemCode,
            Quantity:  i.quantity,
            ...(i.unitPrice     ? { UnitPrice:     i.unitPrice     } : {}),
            ...(i.warehouseCode ? { WarehouseCode: i.warehouseCode } : {}),
          })),
        });
        entry.status      = "created";
        entry.docEntry    = po.DocEntry;
        entry.docNum      = po.DocNum;
        entry.docTotal    = po.DocTotal;
        entry.docCurrency = po.DocCurrency;
      } catch (err) {
        entry.status = "error";
        entry.error  = (err as Error).message ?? String(err);
      }
    } else {
      entry.status = "dry-run";
    }

    purchaseOrders.push(entry);
  }

  return textResult({
    dryRun, docDate, docDueDate,
    totalVendors:    vendorGroups.size,
    totalItems:      rawItems.length - noVendorItems.length,
    skippedNoVendor: noVendorItems,
    ...(dryRun ? {} : {
      createdPOs: purchaseOrders.filter(p => p.status === "created").length,
      failedPOs:  purchaseOrders.filter(p => p.status === "error").length,
    }),
    purchaseOrders,
  });
}

async function runThreeWayMatch(args: unknown): Promise<ToolResponse> {
  const input       = asObject(args, "arguments");
  const poDocEntry  = asNumber(input.poDocEntry, "poDocEntry");
  const priceTolPct = optionalNumber(input.priceTolerancePct, "priceTolerancePct") ?? 2;
  const qtyTolPct   = optionalNumber(input.qtyTolerancePct,   "qtyTolerancePct")   ?? 0;

  // 1. Fetch PO with lines
  const po = await client.get<JsonObject>(`/PurchaseOrders(${poDocEntry})?$expand=DocumentLines`);
  const cardCode = String(po.CardCode ?? "");
  if (!cardCode) throw new McpError(ErrorCode.InvalidRequest, "PO has no CardCode.");

  const poLines = (Array.isArray(po.DocumentLines) ? po.DocumentLines as JsonObject[] : []).map(l => ({
    lineNum:   toNumber(l.LineNum),
    itemCode:  String(l.ItemCode ?? ""),
    qty:       toNumber(l.Quantity),
    unitPrice: toNumber(l.UnitPrice ?? l.Price ?? 0),
  }));

  // 2. Fetch GRPOs for this vendor, keep those referencing this PO
  const allGrpos = await client.getAll<JsonObject>("/GoodsReceiptsPO", {
    $select: "DocEntry,DocNum,DocDate,CardCode,DocumentStatus",
    $filter: `CardCode eq '${cardCode.replace(/'/g, "''")}' and DocumentStatus ne 'bost_Cancelled'`,
    $expand: "DocumentLines($select=LineNum,ItemCode,Quantity,UnitPrice,BaseEntry,BaseLine,BaseType)",
  });

  const relatedGrpos = allGrpos.filter(g =>
    (Array.isArray(g.DocumentLines) ? g.DocumentLines as JsonObject[] : [])
      .some(l => toNumber(l.BaseEntry) === poDocEntry)
  );

  const receivedMap  = new Map<number, { receivedQty: number; unitPrice: number }>();
  const grpoDocEntries: number[] = [];

  for (const grpo of relatedGrpos) {
    const gde   = toNumber(grpo.DocEntry);
    grpoDocEntries.push(gde);
    const lines = Array.isArray(grpo.DocumentLines) ? grpo.DocumentLines as JsonObject[] : [];
    for (const l of lines) {
      if (toNumber(l.BaseEntry) !== poDocEntry) continue;
      const poLn = toNumber(l.BaseLine);
      const prev = receivedMap.get(poLn);
      receivedMap.set(poLn, {
        receivedQty: (prev?.receivedQty ?? 0) + toNumber(l.Quantity),
        unitPrice:   toNumber(l.UnitPrice ?? l.Price ?? 0),
      });
    }
  }

  // 3. Fetch AP Invoices that reference the related GRPOs
  const invoicedMap = new Map<number, { invoicedQty: number; unitPrice: number; apDocEntry: number }>();

  if (grpoDocEntries.length > 0) {
    const allAp = await client.getAll<JsonObject>("/PurchaseInvoices", {
      $select: "DocEntry,DocNum,DocDate,CardCode,DocumentStatus",
      $filter: `CardCode eq '${cardCode.replace(/'/g, "''")}' and DocumentStatus ne 'bost_Cancelled'`,
      $expand: "DocumentLines($select=LineNum,ItemCode,Quantity,UnitPrice,BaseEntry,BaseLine,BaseType)",
    });

    const relatedAp = allAp.filter(inv =>
      (Array.isArray(inv.DocumentLines) ? inv.DocumentLines as JsonObject[] : [])
        .some(l => grpoDocEntries.includes(toNumber(l.BaseEntry)))
    );

    for (const inv of relatedAp) {
      const apDocEntry = toNumber(inv.DocEntry);
      const invLines   = Array.isArray(inv.DocumentLines) ? inv.DocumentLines as JsonObject[] : [];
      for (const l of invLines) {
        const grpoDocEntry = toNumber(l.BaseEntry);
        if (!grpoDocEntries.includes(grpoDocEntry)) continue;
        const grpoBaseLine = toNumber(l.BaseLine);

        // Map this AP invoice line back to the PO line via the GRPO
        const grpo      = relatedGrpos.find(g => toNumber(g.DocEntry) === grpoDocEntry);
        if (!grpo) continue;
        const grpoLines = Array.isArray(grpo.DocumentLines) ? grpo.DocumentLines as JsonObject[] : [];
        const grpoLine  = grpoLines.find(gl => toNumber(gl.LineNum) === grpoBaseLine);
        if (!grpoLine) continue;
        const poLineNum = toNumber(grpoLine.BaseLine);

        const prev = invoicedMap.get(poLineNum);
        invoicedMap.set(poLineNum, {
          invoicedQty: (prev?.invoicedQty ?? 0) + toNumber(l.Quantity),
          unitPrice:   toNumber(l.UnitPrice ?? l.Price ?? 0),
          apDocEntry,
        });
      }
    }
  }

  // 4. Build three-way comparison per PO line
  const lines = poLines.map(poLine => {
    const rcv = receivedMap.get(poLine.lineNum);
    const inv = invoicedMap.get(poLine.lineNum);

    const receivedQty   = rcv?.receivedQty ?? 0;
    const receivedPrice = rcv?.unitPrice   ?? 0;
    const invoicedQty   = inv?.invoicedQty ?? 0;
    const invoicedPrice = inv?.unitPrice   ?? 0;

    const priceVarGrpo = poLine.unitPrice > 0 && receivedPrice > 0
      ? +(Math.abs(poLine.unitPrice - receivedPrice) / poLine.unitPrice * 100).toFixed(2) : 0;
    const priceVarAp   = receivedPrice > 0 && invoicedPrice > 0
      ? +(Math.abs(receivedPrice - invoicedPrice) / receivedPrice * 100).toFixed(2) : 0;

    const discrepancies: string[] = [];
    if (receivedQty === 0)                                           discrepancies.push("NO_GRPO");
    else if (receivedQty < poLine.qty * (1 - qtyTolPct / 100))      discrepancies.push("UNDER_RECEIVED");
    else if (receivedQty > poLine.qty * (1 + qtyTolPct / 100))      discrepancies.push("OVER_RECEIVED");
    if (receivedQty > 0 && invoicedQty === 0)                        discrepancies.push("NO_AP_INVOICE");
    if (invoicedQty > receivedQty)                                   discrepancies.push("OVER_INVOICED");
    if (priceVarGrpo > priceTolPct)  discrepancies.push(`PRICE_VAR_PO_GRPO_${priceVarGrpo}pct`);
    if (priceVarAp   > priceTolPct)  discrepancies.push(`PRICE_VAR_GRPO_INV_${priceVarAp}pct`);

    return {
      lineNum:     poLine.lineNum,
      itemCode:    poLine.itemCode,
      poQty:       poLine.qty,
      poUnitPrice: poLine.unitPrice,
      receivedQty,
      receivedPrice,
      invoicedQty,
      invoicedPrice,
      qtyMatchPct: poLine.qty > 0 ? +(receivedQty / poLine.qty * 100).toFixed(1) : 0,
      matchStatus: discrepancies.length === 0 ? "matched" : "discrepancy",
      discrepancies,
    };
  });

  const discrepancyCount = lines.filter(l => l.matchStatus === "discrepancy").length;
  const overallStatus    = discrepancyCount === 0
    ? (relatedGrpos.length === 0 ? "pending_receipt" : "matched")
    : "discrepancy";

  return textResult({
    poDocEntry,
    vendor:     cardCode,
    vendorName: String(po.CardName ?? ""),
    poDocNum:   po.DocNum,
    poDate:     String(po.DocDate    ?? "").slice(0, 10),
    poDueDate:  String(po.DocDueDate ?? "").slice(0, 10),
    tolerances: { priceTolerancePct: priceTolPct, qtyTolerancePct: qtyTolPct },
    relatedGrpos:      relatedGrpos.map(g => ({ docEntry: g.DocEntry, docNum: g.DocNum, docDate: String(g.DocDate ?? "").slice(0, 10) })),
    relatedApInvoices: [...new Set([...invoicedMap.values()].map(i => i.apDocEntry))],
    summary: {
      totalLines:       lines.length,
      matchedLines:     lines.filter(l => l.matchStatus === "matched").length,
      discrepancyLines: discrepancyCount,
      overallStatus,
    },
    lines,
  });
}

const toolDefinitions = [
  {
    name: "create_sales_quotation",
    description: "Create an SAP Business One sales quotation from customer and line-item inputs.",
    inputSchema: {
      type: "object",
      properties: {
        cardCode: { type: "string" },
        comments: { type: "string" },
        docDate: { type: "string", format: "date", description: "YYYY-MM-DD" },
        docDueDate: { type: "string", format: "date", description: "YYYY-MM-DD" },
        discountThresholdPct: { type: "number" },
        lines: {
          type: "array",
          items: {
            type: "object",
            properties: {
              itemCode: { type: "string" },
              quantity: { type: "number" },
              unitPrice: { type: "number" },
              discountPercent: { type: "number" },
              taxCode: { type: "string" },
              warehouseCode: { type: "string" },
            },
            required: ["itemCode", "quantity"],
          },
        },
      },
      required: ["cardCode", "lines"],
    },
  },
  {
    name: "create_sales_order",
    description: "Create a sales order. Either supply quotationDocEntry to convert an existing quotation, OR supply cardCode + lines for direct creation (e.g. from a purchase order). Validates customer credit before posting.",
    inputSchema: {
      type: "object",
      properties: {
        quotationDocEntry: { type: "number", description: "DocEntry of an existing Sales Quotation to convert. Optional — omit for direct creation." },
        cardCode:    { type: "string",  description: "SAP B1 customer CardCode. Required when quotationDocEntry is not provided." },
        lines: {
          type: "array",
          description: "Order lines. Required when quotationDocEntry is not provided.",
          items: {
            type: "object",
            properties: {
              itemCode:      { type: "string" },
              quantity:      { type: "number" },
              unitPrice:     { type: "number" },
              taxCode:       { type: "string" },
              warehouseCode: { type: "string" },
              description:   { type: "string" },
            },
            required: ["itemCode", "quantity"],
          },
        },
        poNumber:    { type: "string",  description: "Buyer's PO reference number — stored in NumAtCard." },
        currency:    { type: "string",  description: "3-letter ISO currency code, e.g. GBP, USD." },
        docDate:     { type: "string",  format: "date", description: "YYYY-MM-DD" },
        docDueDate:  { type: "string",  format: "date", description: "YYYY-MM-DD" },
      },
      required: [],
    },
  },
  {
    name: "check_atp",
    description: "Check available-to-promise stock for one or more items. warehouseCode is optional; if omitted, totals across all warehouses are returned.",
    inputSchema: {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              itemCode: { type: "string" },
              warehouseCode: { type: "string" },
              requiredQty: { type: "number" },
            },
            required: ["itemCode", "requiredQty"],
          },
        },
      },
      required: ["items"],
    },
  },
  {
    name: "create_delivery",
    description: "Create a delivery note from an open sales order and attach carrier references in comments.",
    inputSchema: {
      type: "object",
      properties: {
        salesOrderDocEntry: { type: "number" },
        scheduledDate: { type: "string", format: "date", description: "YYYY-MM-DD" },
        carrierName: { type: "string" },
        trackingNumber: { type: "string" },
      },
      required: ["salesOrderDocEntry"],
    },
  },
  {
    name: "get_pick_list",
    description: "Return pick list lines for a sales order, sorted by bin location.",
    inputSchema: {
      type: "object",
      properties: {
        salesOrderDocEntry: { type: "number" },
      },
      required: ["salesOrderDocEntry"],
    },
  },
  {
    name: "confirm_delivery_pod",
    description: "Append proof-of-delivery information to a delivery note.",
    inputSchema: {
      type: "object",
      properties: {
        deliveryDocEntry: { type: "number" },
        podReference: { type: "string" },
        exceptions: { type: "string" },
      },
      required: ["deliveryDocEntry", "podReference"],
    },
  },
  {
    name: "create_ar_invoice",
    description: "Generate an A/R invoice from a delivery document.",
    inputSchema: {
      type: "object",
      properties: {
        deliveryDocEntry: { type: "number" },
        dueInDays: { type: "number" },
        docDate: { type: "string", format: "date", description: "YYYY-MM-DD" },
      },
      required: ["deliveryDocEntry"],
    },
  },
  {
    name: "apply_incoming_payment",
    description: "Apply an incoming payment to one or more invoices and reconcile A/R. Amount is distributed proportionally across open invoice balances.",
    inputSchema: {
      type: "object",
      properties: {
        cardCode: { type: "string" },
        amount: { type: "number" },
        invoiceDocEntries: { type: "array", items: { type: "number" } },
        cashAccount: { type: "string" },
        transferAccount: { type: "string" },
        transferReference: { type: "string" },
        remarks: { type: "string" },
        docDate: { type: "string", format: "date", description: "YYYY-MM-DD" },
      },
      required: ["cardCode", "amount", "invoiceDocEntries"],
    },
  },
  {
    name: "get_total_stock",
    description: "Retrieve total stock levels for all inventory items in SAP B1, including on-stock, committed, on-order, and available quantities.",
    inputSchema: {
      type: "object",
      properties: {
        search: { type: "string", description: "Filter by ItemCode or ItemName (contains)" },
        inStockOnly: { type: "boolean", description: "If true, return only items with stock > 0" },
        topN: { type: "number", description: "Limit result to N items — omit to return ALL items (recommended)" },
      },
    },
  },
  {
    name: "get_customer_list",
    description: "Retrieve a list of customers (business partners) from SAP B1. Supports filtering by name/code search, active status, and result count.",
    inputSchema: {
      type: "object",
      properties: {
        search: { type: "string", description: "Filter by CardCode or CardName (case-insensitive contains)" },
        activeOnly: { type: "boolean", description: "If true (default), return only non-frozen customers" },
        topN: { type: "number", description: "Maximum number of customers to return (default 50)" },
      },
    },
  },
  {
    name: "get_collections_worklist",
    description: "Rank overdue receivables by customer risk score for collections prioritization.",
    inputSchema: {
      type: "object",
      properties: {
        asOfDate: { type: "string", format: "date", description: "YYYY-MM-DD" },
        overdueMoreThanDays: { type: "number" },
        topN: { type: "number" },
      },
    },
  },
  {
    name: "get_sales_analysis",
    description: "Query SAP HANA Sales Analysis via sml.svc — group by customer, item, salesperson, brand (CogsOcrCod), sub-brand (CogsOcrCo2), universe (CogsOcrCo4), warehouse, period etc. Supports filtering by doc type (invoice/order/delivery). Use groupBy='CogsOcrCod' for brand-wise analysis.",
    inputSchema: {
      type: "object",
      properties: {
        fromDate:  { type: "string", format: "date", description: "YYYY-MM-DD" },
        toDate:    { type: "string", format: "date", description: "YYYY-MM-DD" },
        groupBy:   { type: "string", description: "Comma-separated field names. Brand: CogsOcrCod, SubBrand: CogsOcrCo2, Budget: CogsOcrCo3, Universe: CogsOcrCo4, Customer: BusinessPartnerCode,BusinessPartnerName, Item: ItemCode,ItemDescription" },
        topN:      { type: "number" },
        cardCode:  { type: "string" },
        itemCode:  { type: "string" },
        orderBy:   { type: "string", description: "e.g. NetSalesAmountLC desc" },
        docType:   { type: "string", description: "Filter by document type: 'order' (Sales Orders), 'invoice' (AR Invoices), 'delivery' (Deliveries), 'credit_memo', 'return'. Omit for all types combined." },
      },
    },
  },
  {
    name: "get_purchase_analysis",
    description: "Aggregate purchase invoices by vendor for a date range to show top suppliers.",
    inputSchema: {
      type: "object",
      properties: {
        fromDate: { type: "string", format: "date" },
        toDate:   { type: "string", format: "date" },
        topN:     { type: "number" },
      },
    },
  },
  {
    name: "get_ar_aging",
    description: "AR aging report — buckets open AR invoices by overdue days (Current, 1-30, 31-60, 61-90, 90+).",
    inputSchema: {
      type: "object",
      properties: {
        asOfDate: { type: "string", format: "date", description: "YYYY-MM-DD, defaults to today" },
      },
    },
  },
  {
    name: "get_ap_aging",
    description: "AP aging report — buckets open purchase invoices by overdue days.",
    inputSchema: {
      type: "object",
      properties: {
        asOfDate: { type: "string", format: "date", description: "YYYY-MM-DD, defaults to today" },
      },
    },
  },
  {
    name: "get_vendor_list",
    description: "List suppliers/vendors from SAP B1 with balance and contact info.",
    inputSchema: {
      type: "object",
      properties: {
        search: { type: "string" },
        topN:   { type: "number" },
      },
    },
  },
  {
    name: "get_warehouse_list",
    description: "List active warehouses from SAP B1 (code, name, location). Use this to let the user pick a valid warehouseCode before creating documents like purchase requests.",
    inputSchema: {
      type: "object",
      properties: {
        search: { type: "string", description: "Filter by warehouse code or name (optional)" },
      },
    },
  },
  {
    name: "get_open_orders",
    description: "List open sales orders from SAP B1, optionally filtered by customer.",
    inputSchema: {
      type: "object",
      properties: {
        cardCode: { type: "string" },
        topN:     { type: "number" },
      },
    },
  },
  {
    name: "get_open_quotations",
    description: "List open sales quotations from SAP B1, optionally filtered by customer.",
    inputSchema: {
      type: "object",
      properties: {
        cardCode: { type: "string" },
        topN:     { type: "number" },
      },
    },
  },
  // ── NEW SMLSVC POST analytical tools ──────────────────────────────────────
  {
    name: "call_service_layer",
    description: `Generic SAP B1 Service Layer REST call. Use this for ANY endpoint not covered by other tools.
Examples:
  GET  /ProductionOrders  { $filter:"Status ne 'R'", $top:20 }
  GET  /ServiceCalls      { $filter:"Status ne 'scsClosed'" }
  GET  /JournalEntries    { $filter:"ReferenceDate ge '2026-01-01'" }
  GET  /StockTransfers    { $filter:"DocDate ge '2026-01-01'" }
  GET  /InventoryGenEntries  { $filter:"DocDate eq '2026-04-11'" }
  GET  /CostCenterList    {}
  POST /SQLQueries('Q1')/List  {}
Common OData params: $filter, $select, $orderby, $top, $skip, $expand
Status values — DocumentStatus: 'O'=Open 'C'=Closed | CardType: 'C'=Customer 'S'=Supplier`,
    inputSchema: {
      type: "object",
      properties: {
        method:   { type: "string", description: "GET | POST | PATCH | DELETE" },
        endpoint: { type: "string", description: "Service Layer path e.g. /ProductionOrders or /BusinessPartners('C00001')" },
        params:   {
          type: "object",
          description: "OData query params for GET requests: { $filter, $select, $orderby, $top, $skip }",
          additionalProperties: true,
        },
        body: {
          type: "object",
          description: "Request body for POST / PATCH",
          additionalProperties: true,
        },
      },
      required: ["method", "endpoint"],
    },
  },
  {
    name: "query_sql_direct",
    description: `Run a read-only T-SQL SELECT directly against a SAP B1 SQL Server database, bypassing Service Layer entirely. Use this when Service Layer is unavailable/misconfigured for a company, or when a question needs a join/aggregation across tables that's awkward via OData.
Requires MSSQL_HOST, MSSQL_DATABASE, MSSQL_USER, MSSQL_PASSWORD (and MSSQL_INSTANCE for a named instance like SERVER\\\\SQLEXPRESS01) to be set in this connector's environment — if not configured, this tool will error saying so.
Multiple companies can live on the same SQL Server instance — pass "database" to target a specific one instead of the connector's default. Known databases on this server:
  DC_LiveDB    — Dewang Corporation
  NCPL_110126  — Neshiel Agrochem Pvt Ltd
  NC_LIVE      — Neshiel Corporation
  NOCPL_LIVE   — Neshiel Ventures Private Limited
Only SELECT statements are allowed; anything else is rejected.
${SAP_B1_SQL_SCHEMA}
${NCPL_110126_BROKERAGE_RULES}`,
    inputSchema: {
      type: "object",
      properties: {
        query:    { type: "string", description: "A single T-SQL SELECT statement" },
        database: { type: "string", description: "Database to query, e.g. NCPL_110126, NC_LIVE, DC_LiveDB, NOCPL_LIVE. Omit to use this connector's default (MSSQL_DATABASE)." },
      },
      required: ["query"],
    },
  },
  {
    name: "query_hana_direct",
    description: `Run a read-only SQL SELECT directly against a SAP B1 HANA database, bypassing Service Layer entirely. Use this when Service Layer is unavailable/misconfigured, or when a question needs a join/aggregation across tables that's awkward via OData.
Requires HANA_HOST, HANA_PORT, HANA_USER, HANA_PASSWORD (and HANA_TENANT for a multi-tenant/MDC system) to be set in this connector's environment — if not configured, this tool will error saying so.
This is a single tenant-DB connection that can see every company's schema — table names MUST be fully qualified as "SCHEMA_NAME"."TABLE_NAME" (HANA identifiers are double-quoted and case-sensitive), e.g. SELECT * FROM "JKL_LIVEDB"."OCRD". If you don't already know the exact schema name for a company, call list_hana_schemas first rather than guessing.
Only SELECT statements are allowed; anything else is rejected.
${SAP_B1_SQL_SCHEMA}`,
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: `A single SQL SELECT statement with fully schema-qualified table names, e.g. SELECT TOP 5 "CardCode","CardName" FROM "JKL_LIVEDB"."OCRD"` },
      },
      required: ["query"],
    },
  },
  {
    name: "list_hana_schemas",
    description: "List company schemas available on this HANA tenant (excludes SAP/HANA system schemas). Use this to discover valid schema names for query_hana_direct instead of guessing.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "get_top_customers",
    description: "Top customers by net sales — uses SMLSVC POST ParamList. Aggregates by BusinessPartnerCode.",
    inputSchema: {
      type: "object",
      properties: {
        fromDate: { type: "string", format: "date", description: "YYYY-MM-DD (default: Jan 1 this year)" },
        toDate:   { type: "string", format: "date", description: "YYYY-MM-DD (default: today)" },
        topN:     { type: "number", description: "Number of customers to return (default 10)" },
      },
    },
  },
  {
    name: "get_top_items",
    description: "Top selling items by sales amount or quantity — uses SMLSVC POST. Aggregates by ItemCode.",
    inputSchema: {
      type: "object",
      properties: {
        fromDate: { type: "string", format: "date" },
        toDate:   { type: "string", format: "date" },
        topN:     { type: "number", description: "Default 10" },
        sortBy:   { type: "string", description: "NetSalesAmountLC | QuantityInInventoryUoM | GrossProfitLC" },
      },
    },
  },
  {
    name: "get_sales_by_period",
    description: "Sales trend by period — day/week/month/quarter/year. Uses SMLSVC POST aggregation.",
    inputSchema: {
      type: "object",
      properties: {
        fromDate:   { type: "string", format: "date" },
        toDate:     { type: "string", format: "date" },
        periodType: { type: "string", description: "day | week | month | quarter | year" },
      },
    },
  },
  {
    name: "get_salesperson_performance",
    description: "Sales and GP by sales employee — uses SMLSVC POST. Groups by SalesEmployeeOrBuyerNumber.",
    inputSchema: {
      type: "object",
      properties: {
        fromDate: { type: "string", format: "date" },
        toDate:   { type: "string", format: "date" },
      },
    },
  },
  {
    name: "get_item_group_sales",
    description: "Sales performance by item group/category — uses SMLSVC POST.",
    inputSchema: {
      type: "object",
      properties: {
        fromDate: { type: "string", format: "date" },
        toDate:   { type: "string", format: "date" },
      },
    },
  },
  {
    name: "get_warehouse_sales",
    description: "Sales breakdown by warehouse — uses SMLSVC POST. Groups by WarehouseCode.",
    inputSchema: {
      type: "object",
      properties: {
        fromDate: { type: "string", format: "date" },
        toDate:   { type: "string", format: "date" },
      },
    },
  },
  {
    name: "get_year_over_year",
    description: "Compare total sales and GP between two years side-by-side — uses SMLSVC POST.",
    inputSchema: {
      type: "object",
      properties: {
        year1: { type: "number", description: "Primary year (default current year)" },
        year2: { type: "number", description: "Comparison year (default year1-1)" },
      },
    },
  },
  // ── Forecasting & Prediction tools ──────────────────────────────────────────
  {
    name: "forecast_sales",
    description: "Predict future sales revenue, quantity, or gross profit using 9 statistical models: SMA, WMA, EWMA, LinearTrend, Drift, Holt Double-Smoothing, Holt-Winters Triple-Smoothing (seasonal), SeasonalNaive, and Median. Auto-backtests all models and recommends the best one by MAPE. Returns per-period forecasts for every model plus model accuracy table.",
    inputSchema: {
      type: "object",
      properties: {
        horizonMonths: { type: "number", description: "Number of months to forecast ahead (default 3, max 12)" },
        historyMonths: { type: "number", description: "Months of history to train on (default 24, max 36)" },
        measure:       { type: "string", description: "revenue | quantity | gp (default: revenue)" },
        cardCode:      { type: "string", description: "Filter by customer card code (optional)" },
        itemCode:      { type: "string", description: "Filter by item code (optional)" },
      },
    },
  },
  {
    name: "forecast_item_demand",
    description: "Predict future demand quantity for a specific item using all 9 models (SMA, WMA, EWMA, LinearTrend, Drift, Holt, Holt-Winters, SeasonalNaive, Median). Auto-selects best model via backtesting. Returns monthly forecasts per model, model accuracy (MAPE/MAE/RMSE), and a procurement suggestion (forecast qty + 20% safety stock).",
    inputSchema: {
      type: "object",
      properties: {
        itemCode:      { type: "string", description: "SAP B1 item code" },
        horizonMonths: { type: "number", description: "Number of months to forecast ahead (default 3, max 12)" },
        historyMonths: { type: "number", description: "Months of history to train on (default 12, max 36)" },
      },
      required: ["itemCode"],
    },
  },
  {
    name: "forecast_cash_flow",
    description: "Forecast cash inflows (open AR invoices) and outflows (open AP invoices) by due-date bucket — returns net cash position for 0-30, 31-60, 61-90 day windows.",
    inputSchema: {
      type: "object",
      properties: {
        forecastDays: { type: "number", description: "Forecast horizon in days (default 90, max 180)" },
      },
    },
  },
  {
    name: "detect_seasonality",
    description: "Analyse a historical monthly time series for seasonal patterns. Runs full additive decomposition (trend + seasonal + residual), computes ACF up to lag 24, seasonal strength score (Fs), peak/trough months, dominant cycle period, and recommends which forecast model to use. Works on revenue, quantity, or gross profit — optionally filtered by customer or item.",
    inputSchema: {
      type: "object",
      properties: {
        historyMonths: { type: "number", description: "Months of history to analyse (default 36, max 60)" },
        measure:       { type: "string", description: "revenue | quantity | gp (default: revenue)" },
        cardCode:      { type: "string", description: "Filter by customer card code (optional)" },
        itemCode:      { type: "string", description: "Filter by item code (optional)" },
      },
    },
  },
  {
    name: "get_customer_details",
    description: "Fetch full business partner master data record for a customer or supplier by card code.",
    inputSchema: {
      type: "object",
      properties: {
        cardCode: { type: "string" },
      },
      required: ["cardCode"],
    },
  },
  {
    name: "query_sml_view",
    description: `Query any SAP B1 Standard HANA Model view via sml.svc. Use this for all analytics, reporting, and document queries. Simple OData GET — no namespace needed.

SALES / QUOTATION: SalesQuotationHeaderQuery, SalesQuotationDetailQuery, SalesOrderHeaderQuery, SalesOrderDetailQuery, SalesAnalysisQuery, AverageSellingPriceQuery, SalesReturnStatisticsQuery, BackOrderStatusQuery, SalesOrderFulfillmentCycleTimeQuery, SalesOrderDeliveredOnTimeQuery
AR / RECEIVABLES: ARInvoiceHeaderQuery, ARInvoiceDetailQuery, ARCreditMemoHeaderQuery, ARCreditMemoDetailQuery, ARReserveInvoiceHeaderQuery, CustomerReceivableAgingQuery, AgingQuery
DELIVERY: DeliveryHeaderQuery, DeliveryDetailQuery, OnTimeDeliveryStatisticsQuery
PURCHASE / AP: PurchaseAnalysisQuery, PurchaseAnalysisByDocumentQuery, PurchaseOrderHeaderQuery, PurchaseOrderDetailQuery, AveragePurchasingPriceQuery, PurchaseReturnStatisticsQuery, OnTimeReceiptStatisticsQuery, GoodsReceiptPOHeaderQuery, GoodsReceiptPODetailQuery, APInvoiceHeaderQuery, APInvoiceDetailQuery, APCreditMemoHeaderQuery, VendorBalanceAnalysisQuery, VendorPaymentAgingQuery
INVENTORY: InventoryStatusQuery, InventoryTransactionDocumentsQuery, WMSSTOCK
RETURNS: ReturnHeaderQuery, ReturnDetailQuery, GoodsReturnHeaderQuery, GoodsReturnDetailQuery
FINANCE / GL: FinancialAnalysisQuery, ProfitAndLossQuery, ProfitAndLossComparisonQuery, BalanceSheetQuery, BalanceSheetComparisonQuery, GeneralLedgerBPQuery, GeneralLedgerAccountQuery, GLAccountPeriodAmountQuery, GLAccountPeriodBalanceQuery, TransactionalJournalQuery, SubLedgerQuery, BudgetVSActualQuery, BudgetAnalysisQuery, CostCenterBudgetVSActualQuery, CostAccountingAnalysisQuery, CashFlowStatementQuery, VATReportQuery, TaxReportQuery
KPI: KPIProfitAndLossQuery, KPICashFlowStatementQuery, KPIBalanceSheetQuery
CRM: OpportunityQuery, OpportunityWinRateQuery, CustomerAttritionRatePredictionQuery, ItemRecommendationQuery, ItemAlsoRecommendedQuery

COMMON FIELDS (header views): DocumentNumber, BusinessPartnerCode, BusinessPartnerName, SalesEmployeeOrBuyerName, BranchCode, PostingDate, PostingYear, PostingMonth, PostingQuarter, DocumentStatus, TotalAmountLC, GrossProfitLC, OpenAmountLC, TaxAmountLC
COMMON FIELDS (detail views): + ItemCode, ItemDescription, ItemGroup, Quantity, OpenQuantity, LineTotalAmountLC, WarehouseCode, ProjectCode

DATE FILTERS:
  PostingDate ge '2026-01-01' and PostingDate le '2026-03-31'
  PostingYear eq 2026 and PostingQuarter eq 1
  PostingYearAndMonth eq '202601'

STATUS: DocumentStatus eq 'O' (Open) | eq 'C' (Closed)`,
    inputSchema: {
      type: "object",
      properties: {
        viewName: { type: "string", description: "HANA view name, e.g. SalesQuotationHeaderQuery" },
        filter:   { type: "string", description: "OData $filter expression" },
        select:   { type: "string", description: "Comma-separated fields to return (omit for all)" },
        orderby:  { type: "string", description: "e.g. TotalAmountLC desc" },
        top:      { type: "number", description: "Max rows to return — omit to retrieve ALL records (server page limit disabled)" },
        skip:     { type: "number", description: "Rows to skip for pagination" },
      },
      required: ["viewName"],
    },
  },
  // ── P2P workflow tools ────────────────────────────────────────────────────
  {
    name: "create_purchase_request",
    description: "Create an SAP Business One purchase request (internal requisition) for required goods or services. Each line requires a warehouseCode — call get_warehouse_list first and have the user pick one if it isn't already known. Collect inputs one at a time in conversation rather than asking for everything in one message: for each line, ask for item code, then quantity, then warehouse (offer the get_warehouse_list options), then required date (offer to default to docDueDate) — confirm each line before starting the next, then confirm the full request before calling this tool.",
    inputSchema: {
      type: "object",
      properties: {
        cardCode:   { type: "string", description: "Preferred vendor card code (optional)" },
        docDate:    { type: "string", format: "date", description: "YYYY-MM-DD (defaults to today)" },
        docDueDate: { type: "string", format: "date", description: "YYYY-MM-DD required-by date (defaults to today)" },
        requester:  { type: "string", description: "SAP B1 user name to record as requester (defaults to the connector's logged-in user; required on companies where the Requester field is mandatory)" },
        comments:   { type: "string" },
        lines: {
          type: "array",
          items: {
            type: "object",
            properties: {
              itemCode:      { type: "string" },
              quantity:      { type: "number" },
              unitPrice:     { type: "number" },
              warehouseCode: { type: "string", description: "Required — get valid codes from get_warehouse_list" },
              requiredDate:  { type: "string", format: "date", description: "YYYY-MM-DD (defaults to docDueDate)" },
            },
            required: ["itemCode", "quantity", "warehouseCode"],
          },
        },
      },
      required: ["lines"],
    },
  },
  {
    name: "create_purchase_quotation",
    description: "Create a purchase quotation (RFQ) for a vendor. Can be created from scratch with line items, or copied from an existing purchase request by providing purchaseRequestDocEntry.",
    inputSchema: {
      type: "object",
      properties: {
        cardCode:                   { type: "string", description: "Vendor card code" },
        purchaseRequestDocEntry:    { type: "number", description: "DocEntry of source purchase request — if provided, lines are copied from it" },
        docDate:    { type: "string", format: "date", description: "YYYY-MM-DD (defaults to today)" },
        docDueDate: { type: "string", format: "date", description: "YYYY-MM-DD quote validity / required-by date (defaults to today)" },
        comments:   { type: "string" },
        lines: {
          type: "array",
          description: "Required when NOT copying from a purchase request",
          items: {
            type: "object",
            properties: {
              itemCode:      { type: "string" },
              quantity:      { type: "number" },
              unitPrice:     { type: "number" },
              taxCode:       { type: "string" },
              warehouseCode: { type: "string" },
            },
            required: ["itemCode", "quantity"],
          },
        },
      },
      required: ["cardCode"],
    },
  },
  {
    name: "create_po_from_quotation",
    description: "Create a purchase order from an accepted purchase quotation — copies all open lines from the quotation and records the vendor commitment.",
    inputSchema: {
      type: "object",
      properties: {
        purchaseQuotationDocEntry: { type: "number", description: "DocEntry of the source purchase quotation" },
        docDate:    { type: "string", format: "date", description: "YYYY-MM-DD (defaults to today)" },
        docDueDate: { type: "string", format: "date", description: "YYYY-MM-DD required delivery date (defaults to today)" },
        comments:   { type: "string" },
      },
      required: ["purchaseQuotationDocEntry"],
    },
  },
  {
    name: "create_purchase_order",
    description: "Create an SAP Business One purchase order for a vendor with line items.",
    inputSchema: {
      type: "object",
      properties: {
        cardCode:   { type: "string", description: "Vendor card code" },
        docDate:    { type: "string", format: "date", description: "YYYY-MM-DD" },
        docDueDate: { type: "string", format: "date", description: "YYYY-MM-DD (required delivery date)" },
        comments:   { type: "string" },
        lines: {
          type: "array",
          items: {
            type: "object",
            properties: {
              itemCode:      { type: "string" },
              quantity:      { type: "number" },
              unitPrice:     { type: "number" },
              taxCode:       { type: "string" },
              warehouseCode: { type: "string" },
            },
            required: ["itemCode", "quantity"],
          },
        },
      },
      required: ["cardCode", "lines"],
    },
  },
  {
    name: "create_goods_receipt_po",
    description: "Create a Goods Receipt PO (GRPO) from an open purchase order — records physical receipt of goods into warehouse.",
    inputSchema: {
      type: "object",
      properties: {
        purchaseOrderDocEntry: { type: "number", description: "DocEntry of the source purchase order" },
        receivedDate: { type: "string", format: "date", description: "YYYY-MM-DD date goods were received" },
      },
      required: ["purchaseOrderDocEntry"],
    },
  },
  {
    name: "create_ap_invoice",
    description: "Generate an A/P invoice from a Goods Receipt PO (GRPO) to record the vendor payable.",
    inputSchema: {
      type: "object",
      properties: {
        grpoDocEntry: { type: "number", description: "DocEntry of the source Goods Receipt PO" },
        dueInDays:    { type: "number", description: "Payment terms — days until due (default 30)" },
        docDate:      { type: "string", format: "date", description: "YYYY-MM-DD" },
      },
      required: ["grpoDocEntry"],
    },
  },
  {
    name: "apply_outgoing_payment",
    description: "Apply an outgoing payment to one or more A/P invoices and reconcile vendor payables. Amount is distributed proportionally across open invoice balances.",
    inputSchema: {
      type: "object",
      properties: {
        cardCode:           { type: "string", description: "Vendor card code" },
        amount:             { type: "number" },
        invoiceDocEntries:  { type: "array", items: { type: "number" }, description: "DocEntry values of A/P invoices to pay" },
        cashAccount:        { type: "string" },
        transferAccount:    { type: "string" },
        transferReference:  { type: "string" },
        remarks:            { type: "string" },
        docDate:            { type: "string", format: "date", description: "YYYY-MM-DD" },
      },
      required: ["cardCode", "amount", "invoiceDocEntries"],
    },
  },
  {
    name: "get_company_info",
    description: "Return active SAP B1 company database name, namespace, and server info.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "switch_company",
    description: "Switch to a different SAP B1 company database. Logs out current session, logs in to new DB, resolves namespace.",
    inputSchema: {
      type: "object",
      properties: {
        dbName: { type: "string", description: "Company DB name, e.g. SBO_DEMO_GB" },
      },
      required: ["dbName"],
    },
  },
  // ── BI Analytics / Intelligence tools ────────────────────────────────────
  {
    name: "analyze_abc_xyz",
    description: "ABC-XYZ inventory classification. ABC ranks items by cumulative revenue contribution (A=top 80%, B=next 15%, C=bottom 5%). XYZ scores demand variability by coefficient of variation (X=stable, Y=variable, Z=erratic). Useful for prioritising stock holding and replenishment policies.",
    inputSchema: {
      type: "object",
      properties: {
        historyMonths: { type: "number", description: "Months of sales history to use (default 12, max 24)" },
        topN:          { type: "number", description: "Max items to return (default 300)" },
      },
    },
  },
  {
    name: "segment_customers_rfm",
    description: "RFM (Recency, Frequency, Monetary) customer segmentation. Scores each customer 1-5 on how recently they bought, how often, and how much — then classifies them as Champions, Loyal, At Risk, Cannot Lose Them, New Customers, Potential Loyalists, Needs Attention, or Lost.",
    inputSchema: {
      type: "object",
      properties: {
        lookbackDays: { type: "number", description: "History window in days (default 365, max 730)" },
      },
    },
  },
  {
    name: "calc_working_capital",
    description: "Working capital efficiency metrics: DSO (Days Sales Outstanding), DPO (Days Payable Outstanding), DSI (Days Sales of Inventory), and CCC (Cash Conversion Cycle = DSI + DSO − DPO). Pulls open AR, open AP, sales, and inventory from SAP B1.",
    inputSchema: {
      type: "object",
      properties: {
        periodDays: { type: "number", description: "Period to calculate revenue/COGS rate from (default 90)" },
      },
    },
  },
  {
    name: "predict_stockout",
    description: "Predict which inventory items are at risk of stockout based on current stock and recent daily demand. Returns days-of-stock-remaining per item with risk levels: critical (≤7 days), low (≤30), moderate (≤60), ok.",
    inputSchema: {
      type: "object",
      properties: {
        demandDays: { type: "number", description: "Days of sales history to derive daily demand (default 90)" },
        topN:       { type: "number", description: "Max items to return (default 50)" },
      },
    },
  },
  {
    name: "detect_dead_slow_stock",
    description: "Identify dead stock (zero demand in the period) and slow-moving stock (demand < slowFactor × average) with their tied-up inventory value. Helps prioritise clearance or write-off decisions.",
    inputSchema: {
      type: "object",
      properties: {
        deadDays:   { type: "number", description: "Analysis window in days (default 180)" },
        slowFactor: { type: "number", description: "Fraction of average demand below which an item is 'slow' (default 0.2 = 20%)" },
      },
    },
  },
  {
    name: "calc_reorder_point",
    description: "Calculate Reorder Point (ROP = daily demand × (lead time + safety days)) for each stocked item and flag which items need ordering now (current stock ≤ ROP).",
    inputSchema: {
      type: "object",
      properties: {
        demandDays:   { type: "number", description: "Days of history to compute daily demand (default 90)" },
        leadTimeDays: { type: "number", description: "Expected vendor lead time in days (default 14)" },
        safetyDays:   { type: "number", description: "Safety buffer in days (default 7)" },
        topN:         { type: "number", description: "Max items to return (default 50)" },
      },
    },
  },
  {
    name: "detect_customer_churn",
    description: "Predict customer churn risk. Computes each customer's average order interval and flags those overdue as medium risk, or silent for ≥ churnThreshold days as high risk. Helps target re-engagement campaigns.",
    inputSchema: {
      type: "object",
      properties: {
        lookbackDays:    { type: "number", description: "History window for purchase pattern learning (default 365)" },
        churnThreshold:  { type: "number", description: "Days of silence = high churn risk (default 90)" },
      },
    },
  },
  {
    name: "calc_customer_clv",
    description: "Calculate projected Customer Lifetime Value (CLV = avg order value × purchase frequency per year × projection years) and tier customers as Platinum / Gold / Silver / Bronze.",
    inputSchema: {
      type: "object",
      properties: {
        lookbackDays:     { type: "number", description: "History window for frequency/value calculation (default 730 = 2 years)" },
        projectionYears:  { type: "number", description: "Forecast horizon in years for CLV (default 3)" },
      },
    },
  },
  {
    name: "analyze_revenue_concentration",
    description: "Pareto / revenue concentration analysis. Shows what percentage of revenue comes from the top N customers, calculates the Herfindahl-Hirschman Index (HHI), and identifies how many customers deliver 80% of revenue. High HHI indicates single-customer dependency risk.",
    inputSchema: {
      type: "object",
      properties: {
        fromDate: { type: "string", format: "date", description: "YYYY-MM-DD (default: Jan 1 this year)" },
        toDate:   { type: "string", format: "date", description: "YYYY-MM-DD (default: today)" },
      },
    },
  },
  {
    name: "detect_margin_erosion",
    description: "Detect items whose gross profit percentage has declined by more than a threshold over recent months. Uses linear regression on per-item monthly GP% to identify a downward trend — flags items at risk of becoming unprofitable.",
    inputSchema: {
      type: "object",
      properties: {
        months:               { type: "number", description: "Analysis window in months (default 12, max 24)" },
        erosionThresholdPct:  { type: "number", description: "Minimum GP% drop to flag as eroding (default 5)" },
      },
    },
  },
  {
    name: "detect_transaction_outliers",
    description: "Statistical outlier detection on AR or AP invoice amounts using z-score analysis. Transactions with |z| ≥ threshold are flagged as unusual — useful for fraud detection, data-entry errors, and pricing anomalies.",
    inputSchema: {
      type: "object",
      properties: {
        lookbackDays: { type: "number", description: "Days of transaction history to scan (default 90)" },
        zThreshold:   { type: "number", description: "Z-score threshold for outlier flag (default 3.0)" },
        docType:      { type: "string", description: "ar (AR invoices) | ap (AP/purchase invoices) — default ar" },
      },
    },
  },
  {
    name: "analyze_vendor_lead_time",
    description: "Analyse vendor lead time reliability using purchase order data (PO creation date → due date). Returns average lead days, standard deviation, min/max per vendor, and a reliability rating (high/medium/low based on std dev).",
    inputSchema: {
      type: "object",
      properties: {
        months: { type: "number", description: "Months of PO history to analyse (default 6, max 24)" },
      },
    },
  },
  {
    name: "analyze_on_time_delivery",
    description: "Vendor on-time delivery performance. Matches Goods Receipt POs to the closest Purchase Order due date and calculates on-time%, early, late counts, and average delay days per vendor.",
    inputSchema: {
      type: "object",
      properties: {
        months: { type: "number", description: "Months of delivery history to analyse (default 6, max 24)" },
      },
    },
  },
  {
    name: "analyze_vendor_concentration",
    description: "Vendor spend concentration analysis — mirrors the customer revenue concentration model but for AP spend. Shows top vendor spend%, cumulative spend%, and HHI index to assess supply-chain dependency risk.",
    inputSchema: {
      type: "object",
      properties: {
        fromDate: { type: "string", format: "date", description: "YYYY-MM-DD (default: Jan 1 this year)" },
        toDate:   { type: "string", format: "date", description: "YYYY-MM-DD (default: today)" },
      },
    },
  },
  {
    name: "calc_eoq",
    description: "Economic Order Quantity (EOQ = √(2DS / H)) for each item. D = annual demand, S = ordering cost per order, H = holding cost per unit per year (unit cost × holding rate). Returns optimal order quantities and expected orders per year.",
    inputSchema: {
      type: "object",
      properties: {
        orderingCost:  { type: "number", description: "Fixed cost per purchase order (default 50)" },
        holdingRate:   { type: "number", description: "Annual holding cost as fraction of unit cost (default 0.25 = 25%)" },
        demandMonths:  { type: "number", description: "Months of sales history for demand estimate (default 12, max 24)" },
        topN:          { type: "number", description: "Max items to return (default 50)" },
      },
    },
  },
  {
    name: "get_quotation_win_rate",
    description: "Sales quotation win-rate analysis. Shows conversion rate (quoted→order), average deal value, open/won/cancelled counts, and a by-customer breakdown. Useful for sales pipeline and forecast accuracy assessment.",
    inputSchema: {
      type: "object",
      properties: {
        fromDate: { type: "string", format: "date", description: "YYYY-MM-DD (default: Jan 1 this year)" },
        toDate:   { type: "string", format: "date", description: "YYYY-MM-DD (default: today)" },
      },
    },
  },
  // ── Procurement & Reorder Agent tools ────────────────────────────────────
  {
    name: "monitor_reorder_items",
    description: "Scan inventory items and return those whose current stock is below the defined minimum (MinInventory). Optionally restrict to a specific warehouse. Returns deficit, suggested replenishment quantity (to 2× minimum), preferred vendor, and estimated cost per item.",
    inputSchema: {
      type: "object",
      properties: {
        warehouseCode: { type: "string", description: "Restrict to a specific warehouse code (omit for company-wide totals)" },
        topN:          { type: "number", description: "Max items to return, sorted by deficit desc (default 100)" },
      },
    },
  },
  {
    name: "aggregate_procurement_demand",
    description: "Aggregate open procurement demand across all open Sales Orders and released/planned Production Orders. Groups demand by item, cross-references current stock and on-order quantities, and computes net shortfall per item so you know what needs to be procured.",
    inputSchema: {
      type: "object",
      properties: {
        topN: { type: "number", description: "Max items to return, sorted by net shortfall desc (default 100)" },
      },
    },
  },
  {
    name: "generate_draft_pos",
    description: "Group a list of items-with-quantities by their preferred vendor (DefaultVendor on the item master) and create one Purchase Order per vendor. Pass dryRun:true to preview the grouping without creating documents. Items without a preferred vendor are skipped and listed in skippedNoVendor.",
    inputSchema: {
      type: "object",
      properties: {
        items: {
          type: "array",
          description: "Items to procure",
          items: {
            type: "object",
            properties: {
              itemCode:      { type: "string" },
              quantity:      { type: "number" },
              unitPrice:     { type: "number" },
              warehouseCode: { type: "string" },
              vendorCode:    { type: "string", description: "Override preferred vendor for this line" },
            },
            required: ["itemCode", "quantity"],
          },
        },
        docDueDate: { type: "string", format: "date", description: "Required delivery date YYYY-MM-DD (default: today + 14 days)" },
        dryRun:     { type: "boolean", description: "Preview grouping without creating POs (default false)" },
        comments:   { type: "string" },
      },
      required: ["items"],
    },
  },
  {
    name: "run_three_way_match",
    description: "Run a three-way match for a Purchase Order — compares PO lines (committed quantity and price) against the Goods Receipt PO (received) and AP Invoice (invoiced). Flags: NO_GRPO, NO_AP_INVOICE, UNDER/OVER_RECEIVED, OVER_INVOICED, PRICE_VAR_PO_GRPO, PRICE_VAR_GRPO_INV beyond configurable tolerances.",
    inputSchema: {
      type: "object",
      properties: {
        poDocEntry:        { type: "number", description: "DocEntry of the Purchase Order to verify" },
        priceTolerancePct: { type: "number", description: "Acceptable price variance % before flagging (default 2)" },
        qtyTolerancePct:   { type: "number", description: "Acceptable quantity variance % before flagging (default 0 = exact match)" },
      },
      required: ["poDocEntry"],
    },
  },
] as const;

const toolHandlers: Record<string, (args: unknown) => Promise<ToolResponse>> = {
  // ── O2C workflow tools ───────────────────────────────────────────────────
  create_sales_quotation:    createSalesQuotation,
  create_sales_order:        createSalesOrder,
  check_atp:                 checkAtp,
  create_delivery:           createDelivery,
  get_pick_list:             getPickList,
  confirm_delivery_pod:      confirmDeliveryPod,
  create_ar_invoice:         createArInvoice,
  apply_incoming_payment:    applyIncomingPayment,
  get_total_stock:           getTotalStock,
  get_customer_list:         getCustomerList,
  get_collections_worklist:  getCollectionsWorklist,
  // ── Legacy analytical tools (OData GET / Service Layer) ──────────────────
  get_sales_analysis:        getSalesAnalysis,
  get_purchase_analysis:     getPurchaseAnalysis,
  get_ar_aging:              getArAging,
  get_ap_aging:              getApAging,
  get_vendor_list:           getVendorList,
  get_warehouse_list:        getWarehouseList,
  get_open_orders:           getOpenOrders,
  get_open_quotations:       getOpenQuotations,
  // ── Generic Service Layer tool (covers ALL SAP B1 endpoints) ────────────
  call_service_layer:        callServiceLayer,
  query_sql_direct:          querySqlDirect,
  query_hana_direct:         queryHanaDirect,
  list_hana_schemas:         listHanaSchemas,
  // ── New SMLSVC POST analytical tools ────────────────────────────────────
  get_top_customers:         getTopCustomers,
  get_top_items:             getTopItems,
  get_sales_by_period:       getSalesByPeriod,
  get_salesperson_performance: getSalespersonPerformance,
  get_item_group_sales:      getItemGroupSales,
  get_warehouse_sales:       getWarehouseSales,
  get_year_over_year:        getYearOverYear,
  // ── Forecasting tools ────────────────────────────────────────────────────
  forecast_sales:            forecastSales,
  forecast_item_demand:      forecastItemDemand,
  forecast_cash_flow:        forecastCashFlow,
  detect_seasonality:        detectSeasonality,
  get_customer_details:      getCustomerDetails,
  get_company_info:          getCompanyInfo,
  switch_company:            switchCompany,
  // ── P2P workflow tools ───────────────────────────────────────────────────
  create_purchase_request:   createPurchaseRequest,
  create_purchase_quotation: createPurchaseQuotation,
  create_po_from_quotation:  createPoFromQuotation,
  create_purchase_order:     createPurchaseOrder,
  create_goods_receipt_po:   createGoodsReceiptPo,
  create_ap_invoice:         createApInvoice,
  apply_outgoing_payment:    applyOutgoingPayment,
  // ── Generic HANA Model View query (sml.svc OData GET) ───────────────────
  query_sml_view:            querySmlView,
  // ── BI Analytics / Intelligence tools ───────────────────────────────────
  analyze_abc_xyz:              analyzeAbcXyz,
  segment_customers_rfm:        segmentCustomersRfm,
  calc_working_capital:         calcWorkingCapital,
  predict_stockout:             predictStockout,
  detect_dead_slow_stock:       detectDeadSlowStock,
  calc_reorder_point:           calcReorderPoint,
  detect_customer_churn:        detectCustomerChurn,
  calc_customer_clv:            calcCustomerClv,
  analyze_revenue_concentration: analyzeRevenueConcentration,
  detect_margin_erosion:        detectMarginErosion,
  detect_transaction_outliers:  detectTransactionOutliers,
  analyze_vendor_lead_time:     analyzeVendorLeadTime,
  analyze_on_time_delivery:     analyzeOnTimeDelivery,
  analyze_vendor_concentration: analyzeVendorConcentration,
  calc_eoq:                     calcEoq,
  get_quotation_win_rate:       getQuotationWinRate,
  // ── Procurement & Reorder Agent ──────────────────────────────────────────
  monitor_reorder_items:        monitorReorderItems,
  aggregate_procurement_demand: aggregateProcurementDemand,
  generate_draft_pos:           generateDraftPos,
  run_three_way_match:          runThreeWayMatch,
};

const SERVER_INSTRUCTIONS = `This connector gives you access to one SAP Business One company through up to three independent paths. Not every path is configured on every connector — check what's available and degrade gracefully.

WORKFLOW for any data question:
1. Prefer a purpose-built tool if one exists (get_customer_list, get_ar_aging, create_purchase_request, etc.) — it already has the right filters/joins baked in.
2. If no purpose-built tool fits, or Service Layer is unavailable/erroring for this company, GENERATE the query yourself:
   - SQL Server backend → write a T-SQL SELECT, call query_sql_direct (pass "database" to target a specific company if this connector serves more than one)
   - HANA backend → write a SELECT with fully schema-qualified "SCHEMA"."TABLE" names, call query_hana_direct (call list_hana_schemas first if you don't already know the exact schema name)
   - Neither configured → call_service_layer with the right OData endpoint/$filter
3. Only SELECT/GET is available through the direct-SQL and HANA paths — they are intentionally read-only. Any create/update (purchase requests, orders, invoices, payments) MUST go through the Service Layer tools, never through query_sql_direct or query_hana_direct.
4. If Service Layer returns a login/auth error (e.g. SAP code 206, or HTTP 401) but query_sql_direct/query_hana_direct are configured, fall back to those for read questions rather than reporting failure — tell the user Service Layer itself needs attention, but still answer the question if the data is reachable another way.
5. Present results in plain language with the key numbers highlighted — don't just dump raw JSON/rows back at the user.`;

const server = new Server(
  { name: "sap-b1-mcp-server", version: "1.0.0" },
  { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [...toolDefinitions] }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const handler = toolHandlers[request.params.name];
  if (!handler) {
    throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${request.params.name}`);
  }
  return handler(request.params.arguments ?? {});
});

async function main(): Promise<void> {
  const config = getConfig();
  client = new SapB1ServiceLayerClient(config);
  activeCompany = config.company;
  // sml.svc lives at /b1s/v2/sml.svc/ — same base as Service Layer
  smlBase = config.baseUrl;

  // Use SL_NAMESPACE env var first (avoids a SAP login round-trip at startup)
  if (process.env.SL_NAMESPACE) {
    activeNamespace = process.env.SL_NAMESPACE;
    NAMESPACE_MAP[activeCompany] = activeNamespace;
    console.error(`Namespace from env: ${activeNamespace}`);
  } else {
    // Auto-discover from sml.svc root (non-fatal if it fails)
    await resolveNamespace(activeCompany).catch(e =>
      console.error("Namespace resolution deferred:", (e as Error).message)
    );
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("SAP B1 MCP server running (stdio)");
}

main().catch((error) => {
  console.error("Fatal startup error:", error);
  process.exit(1);
});
