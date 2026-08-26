/**
 * Product Forecasting Agent — backend controller
 * Mounted at /api/forecasting by chat-server.mjs
 *
 * Primary data source:
 *   GET /sml.svc/SalesAnalysisQuery with PostingYearAndMonth dimension
 *   Returns one row per item per month — same endpoint proven by chat engine Tier 2.
 *
 * Fallback: /Invoices with DocumentLines expand
 */
import { Router } from 'express';
import { isConnected as dbIsConnected, getActiveType as dbGetActiveType, getActiveConfig, executeSQL, tableRef } from '../db-connector.mjs';

const _sessions = new Map();

// ── HANA direct availability ──────────────────────────────────────────────────
// The Forecast Dashboard prefers a live HANA ODBC connection for this company
// (faster, no Service Layer row limits, immune to Service Layer outages) and
// falls back to the SAP Service Layer (via `sap`) whenever no HANA connection
// is active or the direct query fails for any reason.
function hanaAvailable() {
  return dbIsConnected() && dbGetActiveType() === 'hana';
}

// ── AI helper ─────────────────────────────────────────────────────────────────
async function callAI(aiDeps, messages, systemPrompt, maxTokens = 2048) {
  if (!aiDeps) return '';
  const { AI_PROVIDER, gptChatComplete, azureMessagesCreate } = aiDeps;
  if (AI_PROVIDER === 'gpt' && process.env.AZURE_GPT_ENDPOINT) {
    const msgs = systemPrompt ? [{ role: 'system', content: systemPrompt }, ...messages] : messages;
    const r = await gptChatComplete({ messages: msgs, max_tokens: maxTokens });
    return r.choices?.[0]?.message?.content || '';
  }
  if (AI_PROVIDER === 'azure' && process.env.AZURE_OPENAI_API_KEY) {
    const model = process.env.AZURE_CLAUDE_MODEL || 'claude-3-5-sonnet-20241022';
    const msgs = systemPrompt ? [{ role: 'system', content: systemPrompt }, ...messages] : messages;
    const r = await azureMessagesCreate({ model, messages: msgs, max_tokens: maxTokens });
    return r.content?.[0]?.text || r.choices?.[0]?.message?.content || '';
  }
  if (process.env.ANTHROPIC_API_KEY) {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const resp = await client.messages.create({
      model: 'claude-sonnet-4-6', max_tokens: maxTokens,
      system: systemPrompt || undefined, messages,
    });
    return resp.content?.[0]?.text || '';
  }
  return '';
}

// ── Paginated Service Layer fetch ─────────────────────────────────────────────
async function fetchAllPaginated(sap, path, params, { pageSize = 100, maxItems = 3000 } = {}) {
  let skip = 0;
  const all = [];
  while (true) {
    const r = await sap.get(path, { ...params, $top: pageSize, $skip: skip });
    const batch = r.value || [];
    all.push(...batch);
    if (batch.length < pageSize || all.length >= maxItems) break;
    skip += pageSize;
  }
  return all;
}

// ── Parse SAP PostingYearAndMonth → 'YYYY-MM' ─────────────────────────────────
function parseYearMonth(val) {
  if (!val) return null;
  const s = String(val).trim();
  if (/^\d{6}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}`;
  if (/^\d{4}[-/]\d{2}$/.test(s)) return s.slice(0, 4) + '-' + s.slice(5, 7);
  if (/^\d{2}[-/]\d{4}$/.test(s)) return `${s.slice(3, 7)}-${s.slice(0, 2)}`;
  if (/^\d{4}-\d{2}/.test(s)) return s.slice(0, 7);
  return null;
}

// ── HANA direct: monthly sales history from OINV/INV1 ──────────────────────────
async function fetchMonthlyFromHanaSales(fromDate, toDate) {
  const cfg  = getActiveConfig();
  const oinv = tableRef('OINV', cfg);
  const inv1 = tableRef('INV1', cfg);
  const sqlText = `
    SELECT T1."ItemCode" AS "ItemCode", T1."Dscription" AS "ItemDescription",
           TO_VARCHAR(T0."DocDate", 'YYYY-MM') AS "Ym",
           SUM(T1."Quantity") AS "Qty", SUM(T1."LineTotal") AS "Revenue"
    FROM ${oinv} T0
    INNER JOIN ${inv1} T1 ON T0."DocEntry" = T1."DocEntry"
    WHERE T0."DocDate" >= '${fromDate}' AND T0."DocDate" <= '${toDate}'
    GROUP BY T1."ItemCode", T1."Dscription", TO_VARCHAR(T0."DocDate", 'YYYY-MM')`;
  const rows = await executeSQL(sqlText);
  const monthly = {}; const names = {};
  for (const row of rows) {
    const code = row.ItemCode || ''; const month = row.Ym;
    if (!code || !month) continue;
    names[code] = names[code] || row.ItemDescription || code;
    if (!monthly[code]) monthly[code] = {};
    monthly[code][month] = { qty: Number(row.Qty || 0), revenue: Number(row.Revenue || 0) };
  }
  return { monthly, names, rowCount: rows.length, source: 'HANA Direct (Invoices)' };
}

// ── HANA direct: monthly purchase history from OPDN/PDN1, fallback OPOR/POR1 ──
async function fetchMonthlyFromHanaPurchase(fromDate, toDate) {
  const cfg = getActiveConfig();
  async function fromTables(hdrTable, lineTable) {
    const hdr = tableRef(hdrTable, cfg);
    const lin = tableRef(lineTable, cfg);
    const sqlText = `
      SELECT T1."ItemCode" AS "ItemCode", T1."Dscription" AS "ItemDescription",
             TO_VARCHAR(T0."DocDate", 'YYYY-MM') AS "Ym",
             SUM(T1."Quantity") AS "Qty", SUM(T1."LineTotal") AS "Revenue"
      FROM ${hdr} T0
      INNER JOIN ${lin} T1 ON T0."DocEntry" = T1."DocEntry"
      WHERE T0."DocDate" >= '${fromDate}' AND T0."DocDate" <= '${toDate}'
      GROUP BY T1."ItemCode", T1."Dscription", TO_VARCHAR(T0."DocDate", 'YYYY-MM')`;
    return executeSQL(sqlText);
  }
  let rows = await fromTables('OPDN', 'PDN1'); // Goods Receipt PO — actual buying history
  let source = 'HANA Direct (GoodsReceiptPO)';
  if (!rows.length) {
    rows = await fromTables('OPOR', 'POR1');   // fallback: open/all Purchase Orders
    source = 'HANA Direct (PurchaseOrders)';
  }
  const monthly = {}; const names = {};
  for (const row of rows) {
    const code = row.ItemCode || ''; const month = row.Ym;
    if (!code || !month) continue;
    names[code] = names[code] || row.ItemDescription || code;
    if (!monthly[code]) monthly[code] = {};
    monthly[code][month] = { qty: Number(row.Qty || 0), revenue: Number(row.Revenue || 0) };
  }
  return { monthly, names, rowCount: rows.length, source };
}

// ── HANA direct: item master snapshot from OITM ─────────────────────────────────
// Column names verified live against OITM (SYS.TABLE_COLUMNS + sample rows) —
// Service Layer's OData names don't match the underlying SQL columns 1:1:
//   SalesItem eq 'tYES'    → SellItem = 'Y'
//   PurchaseItem eq 'tYES' → PrchseItem = 'Y'
//   Frozen eq 'tNO'        → frozenFor = 'N'  (validFor = 'Y' is the paired inverse)
//   MinInventory           → MinLevel   (NOT MinInvtry — that column doesn't exist)
//   MaxInventory           → MaxLevel   (NOT MaxInvtry)
//   AvgStdPrice            → AvgPrice
//   PreferredVendor        → CardCode
async function fetchItemMasterHana({ groupCode, type = 'sales' } = {}) {
  const cfg  = getActiveConfig();
  const oitm = tableRef('OITM', cfg);
  const itemTypeCol = type === 'purchase' ? 'PrchseItem' : 'SellItem';
  let sqlText = `
    SELECT "ItemCode", "ItemName", "ItmsGrpCod", "OnHand", "MinLevel", "MaxLevel", "AvgPrice", "CardCode"
    FROM ${oitm}
    WHERE "${itemTypeCol}" = 'Y' AND "frozenFor" = 'N'`;
  if (groupCode) sqlText += ` AND "ItmsGrpCod" = ${parseInt(groupCode, 10)}`;
  const rows = await executeSQL(sqlText);
  return rows.map(r => ({
    ItemCode: r.ItemCode, ItemName: r.ItemName, ItemsGroupCode: r.ItmsGrpCod,
    QuantityOnStock: Number(r.OnHand || 0), MinInventory: Number(r.MinLevel || 0), MaxInventory: Number(r.MaxLevel || 0),
    AvgStdPrice: Number(r.AvgPrice || 0), PreferredVendor: r.CardCode || '',
  }));
}

// ── HANA direct: item groups from OITB ──────────────────────────────────────
async function fetchItemGroupsHana() {
  const cfg  = getActiveConfig();
  const oitb = tableRef('OITB', cfg);
  const rows = await executeSQL(`SELECT "ItmsGrpCod", "ItmsGrpNam" FROM ${oitb} ORDER BY "ItmsGrpNam"`);
  return rows.map(r => ({ Number: r.ItmsGrpCod, GroupName: r.ItmsGrpNam }));
}

// ── HANA direct: single item + analogous items in the same group, from OITM ──
async function fetchSingleItemHana(itemCode) {
  const cfg  = getActiveConfig();
  const oitm = tableRef('OITM', cfg);
  const esc  = String(itemCode).replace(/'/g, "''");
  const rows = await executeSQL(`
    SELECT "ItemCode", "ItemName", "ItmsGrpCod", "OnHand", "AvgPrice"
    FROM ${oitm} WHERE "ItemCode" = '${esc}'`);
  const r = rows[0];
  if (!r) return null;
  return {
    ItemCode: r.ItemCode, ItemName: r.ItemName, ItemsGroupCode: r.ItmsGrpCod,
    QuantityOnStock: Number(r.OnHand || 0), AvgStdPrice: Number(r.AvgPrice || 0),
  };
}

async function fetchAnalogousItemsHana(groupCode, excludeItemCode) {
  const cfg  = getActiveConfig();
  const oitm = tableRef('OITM', cfg);
  const rows = await executeSQL(`
    SELECT "ItemCode", "ItemName", "OnHand", "AvgPrice"
    FROM ${oitm}
    WHERE "ItmsGrpCod" = ${parseInt(groupCode, 10)} AND "SellItem" = 'Y' AND "frozenFor" = 'N'
    LIMIT 20`);
  return rows
    .filter(r => r.ItemCode !== excludeItemCode)
    .map(r => ({ ItemCode: r.ItemCode, ItemName: r.ItemName, QuantityOnStock: Number(r.OnHand || 0), AvgStdPrice: Number(r.AvgPrice || 0) }));
}

// ── Primary: SalesAnalysisQuery GET with monthly dimension ────────────────────
async function fetchMonthlyFromSalesAnalysis(sap, fromDate, toDate) {
  const monthly = {};
  const names   = {};
  let   total   = 0;
  const PAGE    = 1000;
  let   skip    = 0;
  while (true) {
    let batch;
    try {
      const r = await sap.get('/sml.svc/SalesAnalysisQuery', {
        $select: 'ItemCode,ItemDescription,PostingYearAndMonth,QuantityInInventoryUoM,NetSalesAmountLC',
        $filter: `PostingDate ge '${fromDate}' and PostingDate le '${toDate}'`,
        $top: PAGE, $skip: skip,
      });
      batch = Array.isArray(r.value) ? r.value : [];
    } catch (e) {
      console.warn('[Forecast/SalesAnalysis] GET failed (skip=%d):', skip, e.message);
      break;
    }
    total += batch.length;
    for (const row of batch) {
      const code  = row.ItemCode || '';
      const month = parseYearMonth(row.PostingYearAndMonth);
      if (!code || !month) continue;
      names[code] = names[code] || row.ItemDescription || code;
      if (!monthly[code])        monthly[code] = {};
      if (!monthly[code][month]) monthly[code][month] = { qty: 0, revenue: 0 };
      monthly[code][month].qty     += Number(row.QuantityInInventoryUoM || 0);
      monthly[code][month].revenue += Number(row.NetSalesAmountLC       || 0);
    }
    if (batch.length < PAGE) break;
    skip += PAGE;
  }
  return { monthly, names, rowCount: total, source: 'SalesAnalysisQuery' };
}

// ── Fallback: AR Invoices with DocumentLines expand ───────────────────────────
async function fetchMonthlyFromInvoices(sap, fromDate, toDate) {
  const monthly = {};
  const names   = {};
  let   total   = 0;
  const PAGE    = 30;
  let   skip    = 0;
  while (true) {
    let page;
    try {
      page = await sap.get('/Invoices', {
        $select: 'DocEntry,DocDate', $filter: `DocDate ge '${fromDate}' and DocDate le '${toDate}'`,
        $expand: 'DocumentLines($select=ItemCode,ItemDescription,Quantity,LineTotal)',
        $orderby: 'DocDate asc', $top: PAGE, $skip: skip,
      });
    } catch (err) {
      try {
        page = await sap.get('/Invoices', {
          $select: 'DocEntry,DocDate', $filter: `DocDate ge '${fromDate}' and DocDate le '${toDate}'`,
          $expand: 'DocumentLines', $orderby: 'DocDate asc', $top: PAGE, $skip: skip,
        });
      } catch (err2) { console.warn('[Forecast/Invoices] expand failed:', err2.message); break; }
    }
    const invoices = page.value || [];
    total += invoices.length;
    for (const inv of invoices) {
      const d = new Date(inv.DocDate);
      if (isNaN(d)) continue;
      const month = d.toISOString().slice(0, 7);
      for (const line of inv.DocumentLines || []) {
        const code = line.ItemCode || '';
        if (!code) continue;
        names[code] = names[code] || line.ItemDescription || code;
        if (!monthly[code])        monthly[code] = {};
        if (!monthly[code][month]) monthly[code][month] = { qty: 0, revenue: 0 };
        monthly[code][month].qty     += Number(line.Quantity  || 0);
        monthly[code][month].revenue += Number(line.LineTotal || 0);
      }
    }
    if (invoices.length < PAGE) break;
    skip += PAGE;
  }
  return { monthly, names, rowCount: total, source: 'Invoices' };
}

// ── Purchase side: Goods Receipt PO with DocumentLines expand ─────────────────
async function fetchMonthlyFromGRPO(sap, fromDate, toDate) {
  const monthly = {};
  const names   = {};
  let   total   = 0;
  const PAGE    = 30;
  let   skip    = 0;
  while (true) {
    let page;
    try {
      page = await sap.get('/GoodsReceiptsPO', {
        $select: 'DocEntry,DocDate', $filter: `DocDate ge '${fromDate}' and DocDate le '${toDate}'`,
        $expand: 'DocumentLines($select=ItemCode,ItemDescription,Quantity,LineTotal)',
        $orderby: 'DocDate asc', $top: PAGE, $skip: skip,
      });
    } catch (err) {
      try {
        page = await sap.get('/GoodsReceiptsPO', {
          $select: 'DocEntry,DocDate', $filter: `DocDate ge '${fromDate}' and DocDate le '${toDate}'`,
          $expand: 'DocumentLines', $orderby: 'DocDate asc', $top: PAGE, $skip: skip,
        });
      } catch (err2) { console.warn('[Forecast/GRPO] expand failed:', err2.message); break; }
    }
    const grpos = page.value || [];
    total += grpos.length;
    for (const doc of grpos) {
      const d = new Date(doc.DocDate);
      if (isNaN(d)) continue;
      const month = d.toISOString().slice(0, 7);
      for (const line of doc.DocumentLines || []) {
        const code = line.ItemCode || '';
        if (!code) continue;
        names[code] = names[code] || line.ItemDescription || code;
        if (!monthly[code])        monthly[code] = {};
        if (!monthly[code][month]) monthly[code][month] = { qty: 0, revenue: 0 };
        monthly[code][month].qty     += Number(line.Quantity  || 0);
        monthly[code][month].revenue += Number(line.LineTotal || 0);
      }
    }
    if (grpos.length < PAGE) break;
    skip += PAGE;
  }
  return { monthly, names, rowCount: total, source: 'GoodsReceiptsPO' };
}

// ── Fallback: Purchase Orders with DocumentLines expand (no receipt history yet) ──
async function fetchMonthlyFromPurchaseOrders(sap, fromDate, toDate) {
  const monthly = {};
  const names   = {};
  let   total   = 0;
  const PAGE    = 30;
  let   skip    = 0;
  while (true) {
    let page;
    try {
      page = await sap.get('/PurchaseOrders', {
        $select: 'DocEntry,DocDate', $filter: `DocDate ge '${fromDate}' and DocDate le '${toDate}'`,
        $expand: 'DocumentLines($select=ItemCode,ItemDescription,Quantity,LineTotal)',
        $orderby: 'DocDate asc', $top: PAGE, $skip: skip,
      });
    } catch (err2) { console.warn('[Forecast/PO] expand failed:', err2.message); break; }
    const pos = page.value || [];
    total += pos.length;
    for (const doc of pos) {
      const d = new Date(doc.DocDate);
      if (isNaN(d)) continue;
      const month = d.toISOString().slice(0, 7);
      for (const line of doc.DocumentLines || []) {
        const code = line.ItemCode || '';
        if (!code) continue;
        names[code] = names[code] || line.ItemDescription || code;
        if (!monthly[code])        monthly[code] = {};
        if (!monthly[code][month]) monthly[code][month] = { qty: 0, revenue: 0 };
        monthly[code][month].qty     += Number(line.Quantity  || 0);
        monthly[code][month].revenue += Number(line.LineTotal || 0);
      }
    }
    if (pos.length < PAGE) break;
    skip += PAGE;
  }
  return { monthly, names, rowCount: total, source: 'PurchaseOrders' };
}

// ── Statistical helpers ───────────────────────────────────────────────────────
function linearSlope(values) {
  const n = values.length;
  if (n < 2) return 0;
  const xm = (n - 1) / 2;
  const ym = values.reduce((s, v) => s + v, 0) / n;
  const nd = values.reduce((s, v, i) => s + (i - xm) * (v - ym), 0);
  const dd = values.reduce((s, _, i) => s + (i - xm) ** 2, 0);
  return dd === 0 ? 0 : nd / dd;
}

function seasonalIndex(monthlyHistory) {
  const buckets = Array.from({ length: 12 }, () => []);
  for (const { month, qty } of monthlyHistory) {
    const m = parseInt(month.slice(5, 7), 10) - 1;
    buckets[m].push(qty);
  }
  const overall = monthlyHistory.reduce((s, r) => s + r.qty, 0) / (monthlyHistory.length || 1);
  return buckets.map(b =>
    b.length ? (b.reduce((s, v) => s + v, 0) / b.length) / (overall || 1) : 1,
  );
}

function projectFuture(history, n, slope, seasonal) {
  const base   = history.slice(-6).reduce((s, r) => s + r.qty, 0) / Math.min(6, history.length || 1);
  const anchor = history.length ? new Date(history[history.length - 1].month + '-01') : new Date();
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(anchor);
    d.setMonth(d.getMonth() + i + 1);
    const key = d.toISOString().slice(0, 7);
    const s   = seasonal[d.getMonth()] || 1;
    const qty = Math.max(0, Math.round((base + slope * (i + 1)) * s));
    return { month: key, qty };
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// EXPORTED CORE FUNCTION — called by main chat handler & router /analyze route
// ══════════════════════════════════════════════════════════════════════════════
export async function runForecastCore(sap, {
  years           = 2,
  forecastHorizon = 12,
  groupCode,
  aiDeps          = null,   // { AI_PROVIDER, gptChatComplete, azureMessagesCreate } or null
  aiTokens        = 1800,   // 1800 for full dashboard, 900 for inline chat summary
} = {}) {
  const historyYears = Math.min(Math.max(Number(years) || 2, 1), 3);
  const today        = new Date();
  const currentYear  = today.getFullYear();
  const fromDate     = `${currentYear - historyYears + 1}-01-01`;
  const toDate       = today.toISOString().slice(0, 10);

  // Step 1: Monthly sales data — prefer direct HANA ODBC when connected for
  // this company (no Service Layer row limits, immune to Service Layer outages),
  // falling back to Service Layer on any failure or when HANA isn't connected.
  let salesData = null;
  if (hanaAvailable()) {
    try {
      salesData = await fetchMonthlyFromHanaSales(fromDate, toDate);
      if (Object.keys(salesData.monthly).length === 0) salesData = null;
    } catch (e) {
      console.warn('[Forecast] HANA direct sales query failed, falling back to Service Layer:', e.message);
      salesData = null;
    }
  }
  if (!salesData) {
    salesData = await fetchMonthlyFromSalesAnalysis(sap, fromDate, toDate);
    if (Object.keys(salesData.monthly).length === 0) {
      console.log('[Forecast] SalesAnalysisQuery returned 0 items — trying Invoice fallback');
      salesData = await fetchMonthlyFromInvoices(sap, fromDate, toDate);
    }
  }
  const { monthly, names, rowCount, source } = salesData;

  // Step 2: Stock snapshot — same HANA-first, Service-Layer-fallback pattern
  let allItems = null;
  if (hanaAvailable()) {
    try {
      allItems = await fetchItemMasterHana({ groupCode });
      if (!allItems.length) allItems = null;
    } catch (e) {
      console.warn('[Forecast] HANA direct item master query failed, falling back to Service Layer:', e.message);
      allItems = null;
    }
  }
  if (!allItems) {
    let itemFilter = "SalesItem eq 'tYES' and Frozen eq 'tNO'";
    if (groupCode) itemFilter += ` and ItemsGroupCode eq ${groupCode}`;
    allItems = await fetchAllPaginated(sap, '/Items', {
      $filter: itemFilter,
      $select: 'ItemCode,ItemName,ItemsGroupCode,QuantityOnStock,MinInventory,MaxInventory,AvgStdPrice',
    });
  }
  const itemMap = Object.fromEntries(allItems.map(it => [it.ItemCode, it]));

  // Step 3: Build forecast per item
  const results = [];
  for (const [itemCode, byMonth] of Object.entries(monthly)) {
    if (groupCode && !itemMap[itemCode]) continue;
    const sortedMonths = Object.keys(byMonth).sort();
    if (sortedMonths.length === 0) continue;

    const history    = sortedMonths.map(m => ({ month: m, qty: Math.round(byMonth[m].qty), revenue: Math.round(byMonth[m].revenue) }));
    const qtyValues  = history.map(h => h.qty);
    const slope      = linearSlope(qtyValues);
    const seasonal   = seasonalIndex(history);

    const trail12    = history.slice(-12);
    const t12qty     = trail12.reduce((s, r) => s + r.qty, 0);
    const t12rev     = trail12.reduce((s, r) => s + r.revenue, 0);
    const avgMonthly = Math.round(t12qty / (trail12.length || 1));

    const trendPct   = avgMonthly > 0 ? Math.round((slope / avgMonthly) * 1000) / 10 : 0;
    const trendLabel = trendPct > 8 ? 'Growing' : trendPct < -8 ? 'Declining' : 'Stable';

    const prevYearStart = `${currentYear - 1}-01`, prevYearEnd = `${currentYear - 1}-12`;
    const currYearStart = `${currentYear}-01`;
    const prevY12   = history.filter(h => h.month >= prevYearStart && h.month <= prevYearEnd).reduce((s, r) => s + r.qty, 0);
    const currYtd   = history.filter(h => h.month >= currYearStart).reduce((s, r) => s + r.qty, 0);
    const yoyGrowth = prevY12 > 0 ? Math.round(((currYtd - prevY12) / prevY12) * 1000) / 10 : 0;

    const projected  = projectFuture(history, forecastHorizon, slope, seasonal);
    const fc3m       = projected.slice(0, 3).reduce((s, r) => s + r.qty, 0);
    const fc6m       = projected.slice(0, 6).reduce((s, r) => s + r.qty, 0);
    const fc12m      = projected.reduce((s, r) => s + r.qty, 0);

    const detail       = itemMap[itemCode] || {};
    const stockOnHand  = Number(detail.QuantityOnStock || 0);
    const minStock     = Number(detail.MinInventory    || 0);
    const monthlyRate  = projected[0]?.qty || avgMonthly || 1;
    const woc          = stockOnHand > 0 ? (stockOnHand / monthlyRate) * 4.33 : 0;
    const stockoutRisk = woc === 0 ? 'HIGH' : woc < 4 ? 'HIGH' : woc < 10 ? 'MEDIUM' : 'LOW';

    const dataScore  = Math.min(sortedMonths.length / (historyYears * 12), 1) * 50;
    const stabScore  = Math.max(0, 50 - Math.abs(trendPct) * 0.5);
    const confidence = Math.round(dataScore + stabScore);

    results.push({
      itemCode, itemName: names[itemCode] || detail.ItemName || itemCode,
      itemGroup: detail.ItemsGroupCode || '', stockOnHand, minStock,
      avgCost: Number(detail.AvgStdPrice || 0), last12mQty: t12qty, last12mRevenue: t12rev,
      avgMonthlyQty: avgMonthly, trendPct, trendLabel, yoyGrowth,
      forecastQty3m: fc3m, forecastQty6m: fc6m, forecastQty12m: fc12m,
      stockoutRisk, weeksOfCover: Math.round(woc), confidence,
      monthlyHistory: history.slice(-12), forecastMonthly: projected, dataMonths: sortedMonths.length,
    });
  }

  const riskOrder = { HIGH: 0, MEDIUM: 1, LOW: 2 };
  results.sort((a, b) => riskOrder[a.stockoutRisk] - riskOrder[b.stockoutRisk] || b.forecastQty12m - a.forecastQty12m);

  const summary = {
    totalItems:   results.length,
    growing:      results.filter(r => r.trendLabel === 'Growing').length,
    stable:       results.filter(r => r.trendLabel === 'Stable').length,
    declining:    results.filter(r => r.trendLabel === 'Declining').length,
    highStockout: results.filter(r => r.stockoutRisk === 'HIGH').length,
    medStockout:  results.filter(r => r.stockoutRisk === 'MEDIUM').length,
    totalFc12m:   results.reduce((s, r) => s + r.forecastQty12m, 0),
    historyYears, rowCount, dataSource: source, periodFrom: fromDate, periodTo: toDate,
  };

  // AI narrative
  let aiInsights = null;
  if (aiDeps && results.length > 0) {
    const snap = results.slice(0, 15).map(r => ({
      code: r.itemCode, name: r.itemName, trend: r.trendLabel, trendPct: r.trendPct,
      yoyGrowth: r.yoyGrowth, avgMonthly: r.avgMonthlyQty, fc12m: r.forecastQty12m,
      stockoutRisk: r.stockoutRisk, weeksOfCover: r.weeksOfCover, confidence: r.confidence,
    }));

    const isShort = aiTokens < 1000;
    const prompt = isShort
      ? `SAP B1 Demand Forecast — ${fromDate} to ${toDate} (${historyYears}yr, ${source}, ${rowCount} rows).
Portfolio: ${results.length} items | Growing: ${summary.growing} | Stable: ${summary.stable} | Declining: ${summary.declining} | HIGH risk: ${summary.highStockout} | 12m fc: ${summary.totalFc12m.toLocaleString()} units.

Top items (JSON):
${JSON.stringify(snap.slice(0, 10), null, 2)}

Write a concise executive summary with:
## 📊 Executive Summary
(2-3 sentences on overall demand health)

## 🔴 Critical Stockout Risks
(bullet list: item code, name, weeks cover, suggested order qty)

## 📈 Top Growth Opportunities
(bullet list: item code, growth %, 12m forecast)

## 💡 Key Recommendations
(3 actionable bullet points)

Be specific, reference item codes, keep it under 400 words.`
      : `You are a supply-chain demand-forecasting analyst for SAP Business One.
Period: ${fromDate} → ${toDate} (${historyYears} yr). Source: ${source} (${rowCount} rows).
Forecast: next 12 months.

Top products:
${JSON.stringify(snap, null, 2)}

Portfolio: ${JSON.stringify(summary)}

## Executive Summary
2–3 sentences on overall demand health and portfolio momentum.

## Top Growth Opportunities
Top 3 growing products — suggest stock build-up quantities.

## Critical Stockout Risks
HIGH-risk items — include suggested immediate order quantities.

## Declining Products
Significant downward trend — promotion, liquidation, or discontinue.

## Strategic Recommendations
3–5 actionable supply-chain actions.

Concise, specific, reference item codes.`;

    try {
      aiInsights = await callAI(aiDeps, [{ role: 'user', content: prompt }], null, aiTokens);
    } catch (e) { aiInsights = `AI insights unavailable: ${e.message}`; }
  }

  return { items: results, summary, aiInsights, periodFrom: fromDate, periodTo: toDate };
}

// ══════════════════════════════════════════════════════════════════════════════
// PURCHASE FORECAST — same statistical model as runForecastCore, sourced from
// Goods Receipt POs (actual buying history) instead of sales. Answers "how much
// will we need to purchase" rather than "how much will we sell". Falls back to
// open Purchase Orders when no GRPO history exists yet.
// ══════════════════════════════════════════════════════════════════════════════
export async function runPurchaseForecastCore(sap, {
  years           = 2,
  forecastHorizon = 12,
  groupCode,
  aiDeps          = null,
  aiTokens        = 1800,
} = {}) {
  const historyYears = Math.min(Math.max(Number(years) || 2, 1), 3);
  const today        = new Date();
  const currentYear  = today.getFullYear();
  const fromDate     = `${currentYear - historyYears + 1}-01-01`;
  const toDate       = today.toISOString().slice(0, 10);

  // Step 1: Monthly purchase data — prefer direct HANA ODBC when connected for
  // this company, falling back to Service Layer on any failure or when not connected.
  let purchaseData = null;
  if (hanaAvailable()) {
    try {
      purchaseData = await fetchMonthlyFromHanaPurchase(fromDate, toDate);
      if (Object.keys(purchaseData.monthly).length === 0) purchaseData = null;
    } catch (e) {
      console.warn('[Forecast/Purchase] HANA direct purchase query failed, falling back to Service Layer:', e.message);
      purchaseData = null;
    }
  }
  if (!purchaseData) {
    purchaseData = await fetchMonthlyFromGRPO(sap, fromDate, toDate);
    if (Object.keys(purchaseData.monthly).length === 0) {
      console.log('[Forecast/Purchase] GoodsReceiptsPO returned 0 items — trying PurchaseOrders fallback');
      purchaseData = await fetchMonthlyFromPurchaseOrders(sap, fromDate, toDate);
    }
  }
  const { monthly, names, rowCount, source } = purchaseData;

  // Step 2: Stock + vendor/purchasing snapshot — same HANA-first pattern
  let allItems = null;
  if (hanaAvailable()) {
    try {
      allItems = await fetchItemMasterHana({ groupCode, type: 'purchase' });
      if (!allItems.length) allItems = null;
    } catch (e) {
      console.warn('[Forecast/Purchase] HANA direct item master query failed, falling back to Service Layer:', e.message);
      allItems = null;
    }
  }
  if (!allItems) {
    let itemFilter = "PurchaseItem eq 'tYES' and Frozen eq 'tNO'";
    if (groupCode) itemFilter += ` and ItemsGroupCode eq ${groupCode}`;
    allItems = await fetchAllPaginated(sap, '/Items', {
      $filter: itemFilter,
      $select: 'ItemCode,ItemName,ItemsGroupCode,QuantityOnStock,MinInventory,MaxInventory,AvgStdPrice,PreferredVendor',
    });
  }
  const itemMap = Object.fromEntries(allItems.map(it => [it.ItemCode, it]));

  // Step 3: Build forecast per item
  const results = [];
  for (const [itemCode, byMonth] of Object.entries(monthly)) {
    if (groupCode && !itemMap[itemCode]) continue;
    const sortedMonths = Object.keys(byMonth).sort();
    if (sortedMonths.length === 0) continue;

    const history    = sortedMonths.map(m => ({ month: m, qty: Math.round(byMonth[m].qty), revenue: Math.round(byMonth[m].revenue) }));
    const qtyValues  = history.map(h => h.qty);
    const slope      = linearSlope(qtyValues);
    const seasonal   = seasonalIndex(history);

    const trail12    = history.slice(-12);
    const t12qty     = trail12.reduce((s, r) => s + r.qty, 0);
    const t12spend   = trail12.reduce((s, r) => s + r.revenue, 0);
    const avgMonthly = Math.round(t12qty / (trail12.length || 1));

    const trendPct   = avgMonthly > 0 ? Math.round((slope / avgMonthly) * 1000) / 10 : 0;
    const trendLabel = trendPct > 8 ? 'Growing' : trendPct < -8 ? 'Declining' : 'Stable';

    const prevYearStart = `${currentYear - 1}-01`, prevYearEnd = `${currentYear - 1}-12`;
    const currYearStart = `${currentYear}-01`;
    const prevY12   = history.filter(h => h.month >= prevYearStart && h.month <= prevYearEnd).reduce((s, r) => s + r.qty, 0);
    const currYtd   = history.filter(h => h.month >= currYearStart).reduce((s, r) => s + r.qty, 0);
    const yoyGrowth = prevY12 > 0 ? Math.round(((currYtd - prevY12) / prevY12) * 1000) / 10 : 0;

    const projected  = projectFuture(history, forecastHorizon, slope, seasonal);
    const fc3m       = projected.slice(0, 3).reduce((s, r) => s + r.qty, 0);
    const fc6m       = projected.slice(0, 6).reduce((s, r) => s + r.qty, 0);
    const fc12m      = projected.reduce((s, r) => s + r.qty, 0);

    const detail       = itemMap[itemCode] || {};
    const stockOnHand  = Number(detail.QuantityOnStock || 0);
    const minStock     = Number(detail.MinInventory    || 0);
    const maxStock     = Number(detail.MaxInventory    || 0);
    const monthlyRate  = projected[0]?.qty || avgMonthly || 1;
    const woc          = stockOnHand > 0 ? (stockOnHand / monthlyRate) * 4.33 : 0;
    // Reorder urgency: below min stock (or out) needs a PO regardless of trend
    const belowMin     = minStock > 0 && stockOnHand < minStock;
    const reorderRisk  = (stockOnHand === 0 || belowMin) ? 'HIGH' : woc < 6 ? 'MEDIUM' : 'LOW';
    // Suggested next-order qty: top up to Max (or to 3 months of demand if no Max set)
    const suggestedOrderQty = Math.max(0, Math.round((maxStock > 0 ? maxStock : monthlyRate * 3) - stockOnHand));

    const dataScore  = Math.min(sortedMonths.length / (historyYears * 12), 1) * 50;
    const stabScore  = Math.max(0, 50 - Math.abs(trendPct) * 0.5);
    const confidence = Math.round(dataScore + stabScore);

    results.push({
      itemCode, itemName: names[itemCode] || detail.ItemName || itemCode,
      itemGroup: detail.ItemsGroupCode || '', stockOnHand, minStock, maxStock,
      preferredVendor: detail.PreferredVendor || '',
      avgCost: Number(detail.AvgStdPrice || 0), last12mQty: t12qty, last12mSpend: t12spend,
      avgMonthlyQty: avgMonthly, trendPct, trendLabel, yoyGrowth,
      forecastQty3m: fc3m, forecastQty6m: fc6m, forecastQty12m: fc12m,
      reorderRisk, weeksOfCover: Math.round(woc), suggestedOrderQty, confidence,
      monthlyHistory: history.slice(-12), forecastMonthly: projected, dataMonths: sortedMonths.length,
    });
  }

  const riskOrder = { HIGH: 0, MEDIUM: 1, LOW: 2 };
  results.sort((a, b) => riskOrder[a.reorderRisk] - riskOrder[b.reorderRisk] || b.forecastQty12m - a.forecastQty12m);

  const summary = {
    totalItems:    results.length,
    growing:       results.filter(r => r.trendLabel === 'Growing').length,
    stable:        results.filter(r => r.trendLabel === 'Stable').length,
    declining:     results.filter(r => r.trendLabel === 'Declining').length,
    highReorder:   results.filter(r => r.reorderRisk === 'HIGH').length,
    medReorder:    results.filter(r => r.reorderRisk === 'MEDIUM').length,
    totalFc12m:    results.reduce((s, r) => s + r.forecastQty12m, 0),
    totalSuggestedQty: results.reduce((s, r) => s + r.suggestedOrderQty, 0),
    historyYears, rowCount, dataSource: source, periodFrom: fromDate, periodTo: toDate,
  };

  // AI narrative
  let aiInsights = null;
  if (aiDeps && results.length > 0) {
    const snap = results.slice(0, 15).map(r => ({
      code: r.itemCode, name: r.itemName, trend: r.trendLabel, trendPct: r.trendPct,
      avgMonthly: r.avgMonthlyQty, fc12m: r.forecastQty12m, reorderRisk: r.reorderRisk,
      weeksOfCover: r.weeksOfCover, suggestedOrderQty: r.suggestedOrderQty, vendor: r.preferredVendor,
    }));

    const isShort = aiTokens < 1000;
    const prompt = isShort
      ? `SAP B1 Purchase Forecast — ${fromDate} to ${toDate} (${historyYears}yr, ${source}, ${rowCount} rows).
Portfolio: ${results.length} items | Growing demand: ${summary.growing} | Stable: ${summary.stable} | Declining: ${summary.declining} | HIGH reorder risk: ${summary.highReorder} | 12m purchase fc: ${summary.totalFc12m.toLocaleString()} units.

Top items (JSON):
${JSON.stringify(snap.slice(0, 10), null, 2)}

Write a concise executive summary with:
## 📊 Executive Summary
(2-3 sentences on overall procurement outlook)

## 🔴 Urgent Reorders
(bullet list: item code, name, weeks cover, suggested PO qty, vendor)

## 📈 Rising Purchase Demand
(bullet list: item code, growth %, 12m purchase forecast)

## 💡 Key Recommendations
(3 actionable procurement bullet points)

Be specific, reference item codes, keep it under 400 words.`
      : `You are a procurement/purchasing forecasting analyst for SAP Business One.
Period: ${fromDate} → ${toDate} (${historyYears} yr). Source: ${source} (${rowCount} rows).
Forecast: next 12 months of purchase demand.

Top products:
${JSON.stringify(snap, null, 2)}

Portfolio: ${JSON.stringify(summary)}

## Executive Summary
2–3 sentences on overall procurement outlook and vendor exposure.

## Urgent Reorders
HIGH-risk items — include suggested PO quantities and preferred vendor.

## Rising Purchase Demand
Top 3 items with growing purchase volume — suggest advance PO planning.

## Declining Purchases
Items with falling buy volume — consider reducing order quantities or renegotiating MOQs.

## Strategic Recommendations
3–5 actionable procurement actions.

Concise, specific, reference item codes.`;

    try {
      aiInsights = await callAI(aiDeps, [{ role: 'user', content: prompt }], null, aiTokens);
    } catch (e) { aiInsights = `AI insights unavailable: ${e.message}`; }
  }

  return { items: results, summary, aiInsights, periodFrom: fromDate, periodTo: toDate };
}

// Shared by GET /analogous/:itemCode and the get_analogous_items chat tool.
async function getAnalogousItemsCore(sap, code) {
  let itemR, analogousItems, source = 'service-layer';
  if (hanaAvailable()) {
    try {
      itemR = await fetchSingleItemHana(code);
      if (itemR) analogousItems = await fetchAnalogousItemsHana(itemR.ItemsGroupCode, code);
      source = 'hana';
    } catch (e) {
      console.warn('[Forecast/analogous] HANA direct failed, falling back to Service Layer:', e.message);
      itemR = null;
    }
  }
  if (!itemR) {
    itemR = await sap.get(`/Items('${encodeURIComponent(code)}')`, {
      $select: 'ItemCode,ItemName,ItemsGroupCode,QuantityOnStock,AvgStdPrice',
    });
    const analogous = await sap.get('/Items', {
      $filter: `ItemsGroupCode eq ${itemR.ItemsGroupCode} and SalesItem eq 'tYES' and Frozen eq 'tNO'`,
      $select: 'ItemCode,ItemName,QuantityOnStock,AvgStdPrice', $top: 20,
    });
    analogousItems = analogous.value || [];
    source = 'service-layer';
  }

  const today    = new Date();
  const fromDate = `${today.getFullYear() - 1}-01-01`;
  const toDate   = today.toISOString().slice(0, 10);
  const velData  = hanaAvailable()
    ? await fetchMonthlyFromHanaSales(fromDate, toDate).catch(() => ({ monthly: {} }))
    : await fetchMonthlyFromSalesAnalysis(sap, fromDate, toDate).catch(() => ({ monthly: {} }));
  const velMap   = {};
  for (const [c, bm] of Object.entries(velData.monthly))
    velMap[c] = Object.values(bm).reduce((s, v) => s + v.qty, 0);
  const items = analogousItems.map(it => ({ ...it, annualQty: Math.round(velMap[it.ItemCode] || 0) }));
  return { targetItem: itemR, analogous: items, source };
}

// ── GPT-4o tool-calling chat — live SAP/HANA data, not just a static context
// blob, same pattern as the MRP/Procurement/Production/Pricing/OrderIntel agents.
const FORECAST_GPT_TOOLS = [
  { type:"function", function:{ name:"get_demand_forecast",
    description:"Get sales demand forecast for products — trend, seasonality, YoY growth, 12-month forecast, and stockout risk. Returns up to `limit` items, sorted by stockout risk then forecast volume.",
    parameters:{ type:"object", properties:{
      itemCode:  { type:"string",  description:"Filter to one specific item code" },
      groupCode: { type:"integer", description:"Filter to one item group number" },
      years:     { type:"integer", description:"Years of history to analyse, 1-3 (default 2)" },
      stockoutRisk: { type:"string", enum:["HIGH","MEDIUM","LOW","all"], description:"Filter by stockout risk. Default: all" },
      limit:     { type:"integer", description:"Max items to return (default 20, max 100)" },
    } } } },
  { type:"function", function:{ name:"get_purchase_forecast",
    description:"Get purchase/replenishment forecast for products — how much to buy, reorder risk, suggested order quantity and preferred vendor. Returns up to `limit` items, sorted by reorder risk then forecast volume.",
    parameters:{ type:"object", properties:{
      itemCode:  { type:"string",  description:"Filter to one specific item code" },
      groupCode: { type:"integer", description:"Filter to one item group number" },
      years:     { type:"integer", description:"Years of history to analyse, 1-3 (default 2)" },
      reorderRisk: { type:"string", enum:["HIGH","MEDIUM","LOW","all"], description:"Filter by reorder risk. Default: all" },
      limit:     { type:"integer", description:"Max items to return (default 20, max 100)" },
    } } } },
  { type:"function", function:{ name:"get_analogous_items",
    description:"For a specific item, find other items in the same item group and their annual sales velocity — useful for forecasting a new or low-history item by comparison.",
    parameters:{ type:"object", properties:{ itemCode:{ type:"string" } }, required:["itemCode"] } } },
  { type:"function", function:{ name:"get_item_groups",
    description:"Get all SAP B1 item groups (number and name) — useful to resolve a group name the user mentions to its group number.",
    parameters:{ type:"object", properties:{} } } },
];

async function executeForecastTool(name, args, sap) {
  if (name === 'get_demand_forecast') {
    const limit = Math.min(parseInt(args.limit) || 20, 100);
    const data  = await runForecastCore(sap, { years: args.years || 2, groupCode: args.groupCode });
    let items   = data.items;
    if (args.itemCode) items = items.filter(i => i.itemCode === args.itemCode);
    else if (args.stockoutRisk && args.stockoutRisk !== 'all') items = items.filter(i => i.stockoutRisk === args.stockoutRisk);
    return { items: items.slice(0, limit), summary: data.summary, totalMatching: items.length };
  }
  if (name === 'get_purchase_forecast') {
    const limit = Math.min(parseInt(args.limit) || 20, 100);
    const data  = await runPurchaseForecastCore(sap, { years: args.years || 2, groupCode: args.groupCode });
    let items   = data.items;
    if (args.itemCode) items = items.filter(i => i.itemCode === args.itemCode);
    else if (args.reorderRisk && args.reorderRisk !== 'all') items = items.filter(i => i.reorderRisk === args.reorderRisk);
    return { items: items.slice(0, limit), summary: data.summary, totalMatching: items.length };
  }
  if (name === 'get_analogous_items') {
    return getAnalogousItemsCore(sap, args.itemCode);
  }
  if (name === 'get_item_groups') {
    if (hanaAvailable()) {
      try { return { groups: await fetchItemGroupsHana(), source: 'hana' }; }
      catch { /* fall through to SL */ }
    }
    const r = await sap.get('/ItemGroups', { $select: 'Number,GroupName', $top: 200 });
    return { groups: r.value || [], source: 'service-layer' };
  }
  return { error: `Unknown forecasting tool: ${name}` };
}

// ── Router factory ────────────────────────────────────────────────────────────
export function createForecastingRouter(deps) {
  const { requireAuth, getActiveSap, AI_PROVIDER, USE_AI, gptChatComplete, azureMessagesCreate } = deps;
  const router = Router();
  const _aiDeps = () => USE_AI ? { AI_PROVIDER, gptChatComplete, azureMessagesCreate } : null;

  // ── GET /api/forecasting/debug ───────────────────────────────────────────
  router.get('/debug', requireAuth, async (req, res) => {
    try {
      const sap      = getActiveSap();
      const toDate   = new Date().toISOString().slice(0, 10);
      const fromDate = `${new Date().getFullYear() - 1}-01-01`;

      let saqTest = null, saqError = null;
      try {
        const r = await sap.get('/sml.svc/SalesAnalysisQuery', {
          $select: 'ItemCode,ItemDescription,PostingYearAndMonth,QuantityInInventoryUoM,NetSalesAmountLC',
          $filter: `PostingDate ge '${fromDate}' and PostingDate le '${toDate}'`, $top: 5,
        });
        saqTest = { rowCount: r.value?.length || 0, sample: r.value?.[0] || null };
      } catch (e) { saqError = e.message; }

      let saqTotals = null, saqTotErr = null;
      try {
        const r = await sap.get('/sml.svc/SalesAnalysisQuery', {
          $select: 'ItemCode,QuantityInInventoryUoM,NetSalesAmountLC',
          $filter: `PostingDate ge '${fromDate}' and PostingDate le '${toDate}'`, $top: 5,
        });
        saqTotals = { rowCount: r.value?.length || 0, sample: r.value?.[0] || null };
      } catch (e) { saqTotErr = e.message; }

      let invTest = null, invError = null;
      try {
        const r = await sap.get('/Invoices', {
          $select: 'DocEntry,DocDate', $filter: `DocDate ge '${fromDate}' and DocDate le '${toDate}'`, $top: 3,
        });
        invTest = { rowCount: r.value?.length, sample: r.value?.[0] || null };
      } catch (e) { invError = e.message; }

      let expTest = null, expError = null;
      try {
        const r = await sap.get('/Invoices', {
          $select: 'DocEntry,DocDate', $filter: `DocDate ge '${fromDate}' and DocDate le '${toDate}'`,
          $expand: 'DocumentLines($select=ItemCode,Quantity,LineTotal)', $top: 2,
        });
        expTest = (r.value || []).map(inv => ({
          DocDate: inv.DocDate, lineCount: (inv.DocumentLines || []).length, firstItem: inv.DocumentLines?.[0]?.ItemCode,
        }));
      } catch (e) { expError = e.message; }

      res.json({
        ok: true, period: { fromDate, toDate },
        test1_SalesAnalysisWithMonth: saqTest   || { error: saqError },
        test2_SalesAnalysisTotal:    saqTotals  || { error: saqTotErr },
        test3_InvoiceHeaders:        invTest    || { error: invError },
        test4_InvoiceExpand:         expTest    || { error: expError },
      });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // ── GET /api/forecasting/groups ──────────────────────────────────────────
  router.get('/groups', requireAuth, async (req, res) => {
    try {
      let groups, source = 'service-layer';
      if (hanaAvailable()) {
        try { groups = await fetchItemGroupsHana(); source = 'hana'; }
        catch (e) { console.warn('[Forecast/groups] HANA direct failed, falling back to Service Layer:', e.message); }
      }
      if (!groups) {
        const r = await getActiveSap().get('/ItemGroups', { $select: 'Number,GroupName', $top: 200 });
        groups = r.value || [];
        source = 'service-layer';
      }
      res.json({ ok: true, groups, source });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // ── GET /api/forecasting/items ───────────────────────────────────────────
  router.get('/items', requireAuth, async (req, res) => {
    try {
      const sap = getActiveSap();
      const { group, search } = req.query;

      let items, source = 'service-layer';
      if (hanaAvailable()) {
        try { items = await fetchItemMasterHana({ groupCode: group }); source = 'hana'; }
        catch (e) { console.warn('[Forecast/items] HANA direct failed, falling back to Service Layer:', e.message); }
      }
      if (!items) {
        let filter = "SalesItem eq 'tYES' and Frozen eq 'tNO'";
        if (group) filter += ` and ItemsGroupCode eq ${group}`;
        items = await fetchAllPaginated(sap, '/Items', {
          $filter: filter, $orderby: 'ItemCode',
          $select: 'ItemCode,ItemName,ItemsGroupCode,QuantityOnStock,MinInventory,MaxInventory,AvgStdPrice',
        });
        source = 'service-layer';
      }
      const out = search
        ? items.filter(it => it.ItemCode.toLowerCase().includes(search.toLowerCase()) || (it.ItemName || '').toLowerCase().includes(search.toLowerCase()))
        : items;
      res.json({ ok: true, items: out, total: out.length, source });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // ── POST /api/forecasting/analyze ────────────────────────────────────────
  router.post('/analyze', requireAuth, async (req, res) => {
    try {
      const { years = 2, groupCode, forecastHorizon = 12, useAI = true } = req.body || {};
      const result = await runForecastCore(getActiveSap(), {
        years, groupCode, forecastHorizon,
        aiDeps: useAI ? _aiDeps() : null,
        aiTokens: 1800,
      });
      res.json({ ok: true, ...result });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // ── POST /api/forecasting/analyze-purchase ───────────────────────────────
  router.post('/analyze-purchase', requireAuth, async (req, res) => {
    try {
      const { years = 2, groupCode, forecastHorizon = 12, useAI = true } = req.body || {};
      const result = await runPurchaseForecastCore(getActiveSap(), {
        years, groupCode, forecastHorizon,
        aiDeps: useAI ? _aiDeps() : null,
        aiTokens: 1800,
      });
      res.json({ ok: true, ...result });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // ── GET /api/forecasting/analogous/:itemCode ─────────────────────────────
  router.get('/analogous/:itemCode', requireAuth, async (req, res) => {
    try {
      const result = await getAnalogousItemsCore(getActiveSap(), req.params.itemCode);
      res.json({ ok: true, ...result });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // ── POST /api/forecasting/chat — GPT-4o tool-calling agent ──────────────
  router.post('/chat', requireAuth, async (req, res) => {
    try {
      const { message, sessionId = `fc_${Date.now()}` } = req.body;
      if (!message?.trim()) return res.status(400).json({ ok: false, error: 'message required' });
      if (!USE_AI || !gptChatComplete) return res.json({ ok: true, reply: 'AI not configured.', sessionId });

      const sap   = getActiveSap();
      const today = new Date().toISOString().slice(0, 10);

      const history = _sessions.get(sessionId) || [];
      history.push({ role: 'user', content: message });
      if (history.length > 20) history.splice(0, history.length - 20);
      _sessions.set(sessionId, history);

      const systemPrompt = `You are a Product Demand Forecasting AI for SAP Business One.
Today is ${today}. Expertise: demand trends, seasonality, stockout risk, replenishment, analogous-product comparisons.
Always call the relevant tool to fetch live data before answering — never guess numbers. Be concise, data-driven, reference item codes, and give actionable recommendations.`;

      const messages = [{ role:"system", content: systemPrompt }, ...history];
      let response = null;
      for (let i = 0; i < 10; i++) {
        const body = { messages, tools: FORECAST_GPT_TOOLS, tool_choice:"auto", max_tokens:1500, temperature:0.2 };
        const raw = await gptChatComplete(body);
        const choice = raw?.choices?.[0];
        if (!choice) throw new Error('No response from AI');
        const msg = choice.message;
        messages.push(msg);
        if (choice.finish_reason === 'tool_calls' && msg.tool_calls?.length) {
          const toolResults = await Promise.all(msg.tool_calls.map(async tc => {
            let args = {};
            try { args = JSON.parse(tc.function.arguments || '{}'); } catch {}
            let result;
            try { result = await executeForecastTool(tc.function.name, args, sap); }
            catch(e) { result = { error: e.message }; }
            return { role:"tool", tool_call_id: tc.id, content: JSON.stringify(result) };
          }));
          messages.push(...toolResults);
        } else {
          response = msg.content || '';
          break;
        }
      }
      if (!response) response = "Unable to complete that request. Please try again.";
      history.push({ role:"assistant", content: response });
      res.json({ ok: true, reply: response, sessionId });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  return router;
}
