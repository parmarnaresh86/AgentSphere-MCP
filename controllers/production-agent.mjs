/**
 * Production Agent — open production orders with component shortage risk
 * analysis (which raw materials are blocking a production order, and by how
 * much), plus a tool-calling AI chat for asking about it in natural language.
 *
 * Extracted from chat-server.mjs (was ~610 inline lines under
 * "── Production Agent ──") as part of splitting that file into per-agent
 * modules, following the same createXRouter(deps) factory pattern already
 * used by po-agent.mjs / sales-order-agent.mjs / etc.
 */
import { Router } from 'express';
import { executeSQL, isConnected, getActiveType, getActiveConfig, tableRef, getTableColumns, resolveFieldMap } from '../db-connector.mjs';
import { qcol } from '../lib/sql-dialect.mjs';

// Paginate using $skip — works with the existing proven sap.get() method.
// Falls back to a single high-$top call if $skip is unsupported.
// Fetch ALL records from a SAP B1 OData collection.
// Strategy: follow odata.nextLink when SAP provides it (preferred),
// fall back to $skip increments when SAP omits the nextLink but returns a full page.
async function sapGetAll(sap, path, params = {}) {
  const all = [];
  const PAGE = 20;          // match SAP B1's actual default page size
  let skip = 0;
  let nextRelPath = null;

  for (let i = 0; i < 1000; i++) {         // safety cap: 20 000 records
    let data;
    if (nextRelPath) {
      // Follow odata.nextLink — SAP encodes all params in the link already
      data = await sap.get('/' + nextRelPath.replace(/^\//, ''), {});
      nextRelPath = null;
    } else {
      const p = { ...params, $top: PAGE };
      if (skip > 0) p.$skip = skip;
      data = await sap.get(path, p);
    }

    const page = data.value || [];
    all.push(...page);
    if (page.length === 0) break;

    const next = data['odata.nextLink'] || data['@odata.nextLink'];
    if (next) {
      // SAP signals more pages via nextLink
      nextRelPath = next;
    } else if (page.length < PAGE) {
      break;                  // partial page = last page
    } else {
      // Full page but no nextLink — increment $skip and keep going
      skip += page.length;
    }
  }
  return all;
}

// ── Production Orders: DB Direct (ODBC/HANA) reads, Service Layer fallback ──
// Same pattern as MRP/Purchasing/Procurement: resolve every logical field against
// the LIVE column list before building SQL — never guess — and fall back to Service
// Layer on any connection/mapping failure.
const OWOR_FIELD_CANDIDATES = {
  docEntry: ['DocEntry'], docNum: ['DocNum'], itemCode: ['ItemCode'],
  dueDate: ['DueDate'], postDate: ['PostDate'], plannedQty: ['PlannedQty'],
  cmpltQty: ['CmpltQty'], status: ['Status'], warehouse: ['Warehouse'],
};
const WOR1_FIELD_CANDIDATES = {
  docEntry: ['DocEntry'], itemCode: ['ItemCode'], itemName: ['ItemName'],
  plannedQty: ['PlannedQty'], issuedQty: ['IssuedQty'],
};
const PROD_STOCK_FIELD_CANDIDATES = {
  itemCode: ['ItemCode'], itemName: ['ItemName'], onHand: ['OnHand'],
  committed: ['IsCommited'], onOrder: ['OnOrder'], avgPrice: ['AvgPrice'], lastPurPrc: ['LastPurPrc'],
};

async function fetchProductionOrdersViaDB() {
  const cfg    = getActiveConfig();
  const isHana = getActiveType() === 'hana';
  const q      = n => qcol(n, isHana);

  const hCols = await getTableColumns('OWOR');
  const { resolved: rH, missing: mH } = resolveFieldMap(hCols, OWOR_FIELD_CANDIDATES);
  if (mH.length) throw new Error(`OWOR field mapping incomplete: ${mH.join(', ')}`);

  const lCols = await getTableColumns('WOR1');
  const { resolved: rL, missing: mL } = resolveFieldMap(lCols, WOR1_FIELD_CANDIDATES);
  if (mL.length) throw new Error(`WOR1 field mapping incomplete: ${mL.join(', ')}`);

  const headerSql = `SELECT ${q(rH.docEntry)} AS ${q('DocEntry')}, ${q(rH.docNum)} AS ${q('DocNum')}, ` +
    `${q(rH.itemCode)} AS ${q('ItemCode')}, ${q(rH.dueDate)} AS ${q('DueDate')}, ${q(rH.postDate)} AS ${q('PostDate')}, ` +
    `${q(rH.plannedQty)} AS ${q('PlannedQty')}, ${q(rH.cmpltQty)} AS ${q('CmpltQty')}, ` +
    `${q(rH.status)} AS ${q('Status')}, ${q(rH.warehouse)} AS ${q('Warehouse')} ` +
    `FROM ${tableRef('OWOR', cfg)}`;
  const headerRows = await executeSQL(headerSql);

  const lineSql = `SELECT ${q(rL.docEntry)} AS ${q('DocEntry')}, ${q(rL.itemCode)} AS ${q('ItemCode')}, ` +
    `${q(rL.itemName)} AS ${q('ItemName')}, ${q(rL.plannedQty)} AS ${q('PlannedQty')}, ${q(rL.issuedQty)} AS ${q('IssuedQty')} ` +
    `FROM ${tableRef('WOR1', cfg)}`;
  const lineRows = await executeSQL(lineSql);

  const linesByOrder = new Map();
  for (const l of lineRows) {
    if (!linesByOrder.has(l.DocEntry)) linesByOrder.set(l.DocEntry, []);
    linesByOrder.get(l.DocEntry).push({
      ItemNo: l.ItemCode, ItemDescription: l.ItemName,
      PlannedQuantity: l.PlannedQty, IssuedQuantity: l.IssuedQty,
    });
  }

  // Normalized to the same shape getProductionOrdersWithRisk() expects from the Service Layer.
  return headerRows.map(h => ({
    AbsoluteEntry: h.DocEntry, DocNum: h.DocNum,
    DocDate: h.PostDate, DueDate: h.DueDate,
    ItemNo: h.ItemCode, ProductDescription: '',
    Warehouse: h.Warehouse,
    PlannedQuantity: h.PlannedQty, CompletedQuantity: h.CmpltQty,
    ProductionOrderStatus: h.Status,
    ProductionOrderLines: linesByOrder.get(h.DocEntry) || [],
  }));
}

async function fetchStockMapViaDB(itemCodes) {
  const stockMap = new Map();
  if (!itemCodes.length) return stockMap;
  const cfg    = getActiveConfig();
  const isHana = getActiveType() === 'hana';
  const q      = n => qcol(n, isHana);
  const cols   = await getTableColumns('OITM');
  const { resolved, missing } = resolveFieldMap(cols, PROD_STOCK_FIELD_CANDIDATES);
  if (missing.length) throw new Error(`OITM field mapping incomplete: ${missing.join(', ')}`);
  const esc = s => String(s).replace(/'/g, "''");
  for (let i = 0; i < itemCodes.length; i += 200) {
    const chunk  = itemCodes.slice(i, i + 200);
    const inList = chunk.map(c => `'${esc(c)}'`).join(',');
    const sql = `SELECT ${q(resolved.itemCode)} AS ${q('ItemCode')}, ${q(resolved.itemName)} AS ${q('ItemName')}, ` +
      `${q(resolved.onHand)} AS ${q('OnHand')}, ${q(resolved.committed)} AS ${q('IsCommited')}, ${q(resolved.onOrder)} AS ${q('OnOrder')}, ` +
      `${q(resolved.avgPrice)} AS ${q('AvgPrice')}, ${q(resolved.lastPurPrc)} AS ${q('LastPurPrc')} ` +
      `FROM ${tableRef('OITM', cfg)} WHERE ${q(resolved.itemCode)} IN (${inList})`;
    const rows = await executeSQL(sql);
    for (const it of rows) {
      const onHand    = Number(it.OnHand || 0);
      const committed = Number(it.IsCommited || 0);
      stockMap.set(it.ItemCode, {
        onHand, committed, available: onHand - committed,
        onOrder:  Number(it.OnOrder || 0),
        itemName: it.ItemName || it.ItemCode,
        avgPrice: Number(it.AvgPrice || it.LastPurPrc || 0),
      });
    }
  }
  return stockMap;
}

// "How is this calculated?" popup for the Risk badge — built from the same
// component figures used to set the risk, so it cannot drift.
function prodRiskExplain(components, shortages, criticals, risk) {
  const f = n => Number(n || 0).toLocaleString('en-GB', { maximumFractionDigits: 2 });
  const lowCover = shortages.filter(s => s.pctCovered < 50);
  const shown = [...shortages].sort((a, b) => a.pctCovered - b.pctCovered).slice(0, 8);
  const steps = shown.map(c => ({
    label: c.itemCode,
    detail: c.itemName || '',
    formula: `Still needed ${f(c.needed)} (planned ${f(c.plannedQty)} − issued ${f(c.issuedQty)}) − available ${f(c.available)} · covers ${c.pctCovered}%`,
    value: `short ${f(c.shortage)}`,
  }));
  if (shortages.length > shown.length) steps.push({ label: `+${shortages.length - shown.length} more`, formula: 'Other short components (see Components tab)', value: '' });
  return {
    risk: {
      title: `Why risk is ${risk.toUpperCase()}`,
      steps: steps.length ? steps : [{ label: 'Components checked', formula: 'Every component has enough available stock for what is still needed', value: components.length }],
      rules: [
        { rule: `A needed component has no available stock (${criticals.length} found)`, result: 'CRITICAL', hit: risk === 'critical' },
        { rule: `A short component is covered less than 50% (${lowCover.length} found)`, result: 'HIGH', hit: risk === 'high' },
        { rule: `Any component is short (${shortages.length} found)`, result: 'MEDIUM', hit: risk === 'medium' },
        { rule: 'No component is short', result: 'OK', hit: risk === 'ok' },
      ],
      note: 'Shortage = still needed (planned − issued) − available stock (on hand − committed). Covered % = available ÷ still needed.',
    },
  };
}

async function getProductionOrdersWithRisk(sap) {
  let prodOrders = [];
  let stockMap;
  let source;

  if (isConnected()) {
    try {
      prodOrders = await fetchProductionOrdersViaDB();
      const componentCodes = new Set();
      for (const order of prodOrders) {
        if (order.ItemNo) componentCodes.add(order.ItemNo); // finished item too, for productName
        for (const line of (order.ProductionOrderLines || [])) {
          const code = line.ItemNo || line.ItemCode;
          if (code) componentCodes.add(code);
        }
      }
      stockMap = await fetchStockMapViaDB([...componentCodes]);
      for (const order of prodOrders) {
        order.ProductDescription = stockMap.get(order.ItemNo)?.itemName || '';
      }
      source = getActiveType();
    } catch (dbErr) {
      console.warn('[Production] DB Direct failed, falling back to Service Layer:', dbErr.message);
      prodOrders = [];
    }
  }

  // SAP B1 ProductionOrders: non-standard field names (AbsoluteEntry, ItemNo, DueDate,
  // CompletedQuantity, ProductionOrderStatus). Skip $select/$filter/$orderby in the SAP
  // query for maximum compatibility — do all filtering and sorting in JS.
  const CLOSED_STATUSES = new Set(['bost_Closed','C','Closed','L']);

  if (!stockMap) {
    // ── Service Layer fallback ──
    // SAP B1 ProductionOrderLines is returned INLINE on single-entity fetches but NOT
    // on collection fetches — components are lazy-loaded per order via the /lines endpoint.
    try {
      prodOrders = await sapGetAll(sap, "/ProductionOrders", {});
    } catch {
      try {
        const data = await sap.get("/ProductionOrders", { $top: 500 });
        prodOrders = data.value || [];
      } catch(e3) {
        throw new Error(`Failed to fetch production orders: ${e3.message}`);
      }
    }

    const getLinesSL = (order) => order.ProductionOrderLines || order.Lines || order.DocumentLines || [];

    // Collect all unique component item codes
    const componentCodes = new Set();
    for (const order of prodOrders) {
      for (const line of getLinesSL(order)) {
        const code = line.ItemNo || line.ItemCode;
        if (code) componentCodes.add(code);
      }
    }

    // Fetch stock for all components in batches of 20
    stockMap = new Map();
    if (componentCodes.size > 0) {
      const codes = [...componentCodes];
      const BATCH = 20;
      for (let i = 0; i < codes.length; i += BATCH) {
        const batch = codes.slice(i, i + BATCH);
        const filter = batch.map(c => `ItemCode eq '${c.replace(/'/g,"''")}'`).join(' or ');
        try {
          const r = await sap.get("/Items", {
            $filter: filter,
            $select: "ItemCode,ItemName,QuantityOnStock,QuantityOrderedByCustomers,QuantityOrderedFromVendors,AvgPrice,LastPurchasePrice,StdPrice",
            $top: BATCH,
          });
          for (const it of (r.value || [])) {
            const onHand = Number(it.QuantityOnStock || 0);
            const committed = Number(it.QuantityOrderedByCustomers || 0);
            const avgPrice = Number(it.AvgPrice || it.StdPrice || it.LastPurchasePrice || 0);
            stockMap.set(it.ItemCode, {
              onHand, committed,
              available: onHand - committed,
              onOrder: Number(it.QuantityOrderedFromVendors || 0),
              itemName: it.ItemName || it.ItemCode,
              avgPrice,
            });
          }
        } catch { /* non-fatal */ }
      }
    }
    source = 'service-layer';
  }

  // Filter out closed orders in JS (avoids $filter compatibility issues)
  prodOrders = prodOrders.filter(o =>
    !CLOSED_STATUSES.has(o.ProductionOrderStatus || o.Status || '')
  );

  // Sort by AbsoluteEntry descending — newest/highest order number first
  prodOrders.sort((a, b) => {
    const na = Number(a.AbsoluteEntry || a.DocEntry || 0);
    const nb = Number(b.AbsoluteEntry || b.DocEntry || 0);
    return nb - na;
  });

  const getLines = (order) =>
    order.ProductionOrderLines || order.Lines || order.DocumentLines || [];

  const today = new Date();
  const orders = prodOrders.map(order => {
    // Normalise field names — handle both v1 (ItemNo) and alternative naming
    const finishedItemCode = order.ItemNo || order.ItemCode || '';
    const dueRaw = order.DueDate || order.DocDueDate;
    const completedQty = Number(order.CompletedQuantity ?? order.CmpltQty ?? 0);

    const lines = getLines(order);
    const components = lines.map(line => {
      const compCode = line.ItemNo || line.ItemCode || '';
      const compName = line.ItemDescription || line.ProductDescription || '';
      const plannedQty  = Number(line.PlannedQuantity  || 0);
      const issuedQty   = Number(line.IssuedQuantity   || 0);
      const needed      = Math.max(0, plannedQty - issuedQty);
      const stock       = stockMap.get(compCode) || { onHand: 0, committed: 0, available: 0, onOrder: 0, itemName: compName, avgPrice: 0 };
      const shortage    = Math.max(0, needed - stock.available);
      const unitCost    = stock.avgPrice || 0;
      return {
        itemCode:     compCode,
        itemName:     compName || stock.itemName,
        plannedQty,   issuedQty,
        needed,
        available:    stock.available,
        onHand:       stock.onHand,
        onOrder:      stock.onOrder,
        shortage,
        pctCovered:   needed > 0 ? Math.max(0, Math.min(100, Math.round((stock.available / needed) * 100))) : 100,
        unitCost,
        plannedCost:  +(plannedQty  * unitCost).toFixed(2),
        actualCost:   +(issuedQty   * unitCost).toFixed(2),
      };
    });

    const shortages = components.filter(c => c.shortage > 0);
    const criticals = components.filter(c => c.available <= 0 && c.needed > 0);
    const risk = criticals.length > 0 ? 'critical'
               : shortages.some(s => s.pctCovered < 50) ? 'high'
               : shortages.length > 0 ? 'medium'
               : 'ok';
    const explain = prodRiskExplain(components, shortages, criticals, risk);

    const dueDate = dueRaw ? new Date(dueRaw) : null;
    const daysUntilDue = dueDate && !isNaN(dueDate) ? Math.ceil((dueDate - today) / 86400000) : null;

    return {
      docEntry: order.AbsoluteEntry || order.DocEntry,
      docNum: order.DocNum || order.AbsoluteEntry || order.DocEntry,
      docDate: order.DocDate?.slice(0,10),
      docDueDate: dueRaw?.slice(0,10) || null,
      daysUntilDue,
      itemCode: finishedItemCode,
      productName: order.ProductDescription || finishedItemCode,
      warehouse: order.Warehouse || '',
      plannedQty: Number(order.PlannedQuantity || 0),
      completedQty,
      status: order.ProductionOrderStatus || order.Status || '',
      risk,
      shortageCount: shortages.length,
      componentCount: lines.length,
      components,
      explain,
    };
  });

  const summary = {
    total: orders.length,
    critical: orders.filter(o => o.risk === 'critical').length,
    high:     orders.filter(o => o.risk === 'high').length,
    medium:   orders.filter(o => o.risk === 'medium').length,
    ok:       orders.filter(o => o.risk === 'ok').length,
    dueThisWeek: orders.filter(o => o.daysUntilDue !== null && o.daysUntilDue >= 0 && o.daysUntilDue <= 7).length,
    overdue:  orders.filter(o => o.daysUntilDue !== null && o.daysUntilDue < 0).length,
  };

  return { orders, summary, source };
}

const _prodSessions = new Map();

const PROD_GPT_TOOLS = [
  { type:"function", function:{ name:"get_production_orders",
    description:"Get open production orders with component shortage risk analysis. Returns each order's risk level (critical/high/medium/ok), component status, and days until due.",
    parameters:{ type:"object", properties:{
      riskFilter:{ type:"string", enum:["all","critical","high","medium","ok","at_risk"], description:"Filter by risk. at_risk = critical+high+medium. Default: all" }
    } } } },
  { type:"function", function:{ name:"get_component_shortages",
    description:"Aggregate component shortages across all open production orders — which raw materials are blocking production and by how much.",
    parameters:{ type:"object", properties:{} } } },
  { type:"function", function:{ name:"check_item_stock",
    description:"Check current stock level for a specific item/component by item code.",
    parameters:{ type:"object", properties:{
      itemCode:{ type:"string", description:"Exact item code (e.g. RM001)" }
    }, required:["itemCode"] } } },
  { type:"function", function:{ name:"get_open_purchase_orders",
    description:"Get open purchase orders in the pipeline, optionally filtered by item code — useful to see if replenishment is already ordered.",
    parameters:{ type:"object", properties:{
      itemCode:{ type:"string", description:"Filter by component item code (optional)" }
    } } } },
];

async function executeProdTool(name, args, sap) {
  if (name === 'get_production_orders') {
    const { orders, summary } = await getProductionOrdersWithRisk(sap);
    let filtered = orders;
    if (args.riskFilter === 'at_risk') filtered = orders.filter(o => o.risk !== 'ok');
    else if (args.riskFilter && args.riskFilter !== 'all') filtered = orders.filter(o => o.risk === args.riskFilter);
    return {
      summary,
      orders: filtered.map(o => ({
        docNum: o.docNum, productName: o.productName, itemCode: o.itemCode,
        docDueDate: o.docDueDate, daysUntilDue: o.daysUntilDue,
        plannedQty: o.plannedQty, completedQty: o.completedQty,
        risk: o.risk, shortageCount: o.shortageCount, componentCount: o.componentCount,
        shortComponents: o.components.filter(c => c.shortage > 0).slice(0, 5),
      })),
    };
  }
  if (name === 'get_component_shortages') {
    const { orders } = await getProductionOrdersWithRisk(sap);
    const map = new Map();
    for (const order of orders) {
      for (const comp of order.components) {
        if (comp.shortage <= 0) continue;
        if (!map.has(comp.itemCode)) {
          map.set(comp.itemCode, { itemCode: comp.itemCode, itemName: comp.itemName,
            totalNeeded: 0, totalShortage: 0, availableStock: comp.available, affectedOrders: [] });
        }
        const rec = map.get(comp.itemCode);
        rec.totalNeeded += comp.needed;
        rec.totalShortage += comp.shortage;
        if (!rec.affectedOrders.includes(order.docNum)) rec.affectedOrders.push(order.docNum);
      }
    }
    const shortages = [...map.values()].sort((a,b) => b.totalShortage - a.totalShortage);
    return { shortages, total: shortages.length };
  }
  if (name === 'check_item_stock') {
    const e = s => String(s).replace(/'/g,"''");
    const it = await sap.get(`/Items('${e(args.itemCode)}')`, {
      $select: "ItemCode,ItemName,QuantityOnStock,QuantityOrderedByCustomers,QuantityOrderedFromVendors,MinInventory,LeadTime,Mainsupplier",
    });
    const onHand = Number(it.QuantityOnStock || 0);
    const committed = Number(it.QuantityOrderedByCustomers || 0);
    return {
      itemCode: it.ItemCode, itemName: it.ItemName,
      onHand, committed, available: onHand - committed,
      onOrder: Number(it.QuantityOrderedFromVendors || 0),
      minStock: Number(it.MinInventory || 0),
      leadTime: it.LeadTime || null, preferredVendor: it.Mainsupplier || null,
    };
  }
  if (name === 'get_open_purchase_orders') {
    const r = await sap.get("/PurchaseOrders", {
      $filter: "DocumentStatus eq 'bost_Open'",
      $select: "DocNum,CardCode,CardName,DocDate,DocDueDate,DocTotal",
      $expand: "DocumentLines($select=ItemCode,ItemDescription,Quantity,OpenQuantity)",
      $orderby: "DocDueDate asc",
      $top: 100,
    });
    let orders = r.value || [];
    if (args.itemCode) orders = orders.filter(o => (o.DocumentLines||[]).some(l => l.ItemCode === args.itemCode));
    return { orders: orders.slice(0,30), total: orders.length };
  }
  return { error: `Unknown production tool: ${name}` };
}

export function createProductionAgentRouter(deps) {
  const { requireAuth, getActiveSap, gptChatComplete } = deps;
  const router = Router();

  router.get('/orders', requireAuth, async (req, res) => {
    try {
      const data = await getProductionOrdersWithRisk(getActiveSap());
      res.json({ ok: true, ...data });
    } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // Debug: probe what array properties a single production order has
  router.get('/probe/:docEntry', requireAuth, async (req, res) => {
    try {
      const sap = getActiveSap();
      const id  = req.params.docEntry;
      const raw = await sap.get(`/ProductionOrders(${id})`, {});
      const props = Object.entries(raw).map(([k,v]) => ({
        key: k, type: Array.isArray(v) ? `array(${v.length})` : typeof v,
        sample: Array.isArray(v) && v.length ? JSON.stringify(v[0]).slice(0,120) : undefined
      }));
      res.json({ ok: true, props });
    } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // Fetch components for a single production order (used as fallback when BOM lines were empty in bulk load)
  router.get('/order/:docEntry/lines', requireAuth, async (req, res) => {
    try {
      const sap      = getActiveSap();
      const docEntry = req.params.docEntry;   // AbsoluteEntry (may equal DocNum)
      const docNum   = req.query.num || docEntry;  // user-visible doc number fallback
      const isNum    = /^\d+$/.test(docEntry);

      console.log(`[PROD-LINES] docEntry=${docEntry} docNum=${docNum}`);

      // ── Fetch production order lines: DB Direct (ODBC/HANA) first, Service Layer fallback ──
      let lines = [];
      let stockMap;
      let dbSource = null;

      if (isNum && isConnected()) {
        try {
          const cfg    = getActiveConfig();
          const isHana = getActiveType() === 'hana';
          const q      = n => qcol(n, isHana);
          const lCols  = await getTableColumns('WOR1');
          const { resolved, missing } = resolveFieldMap(lCols, WOR1_FIELD_CANDIDATES);
          if (missing.length) throw new Error(`WOR1 field mapping incomplete: ${missing.join(', ')}`);
          const sql = `SELECT ${q(resolved.itemCode)} AS ${q('ItemCode')}, ${q(resolved.itemName)} AS ${q('ItemName')}, ` +
            `${q(resolved.plannedQty)} AS ${q('PlannedQty')}, ${q(resolved.issuedQty)} AS ${q('IssuedQty')} ` +
            `FROM ${tableRef('WOR1', cfg)} WHERE ${q(resolved.docEntry)} = ${Number(docEntry)}`;
          const rows = await executeSQL(sql);
          lines = rows.map(r => ({
            ItemNo: r.ItemCode, ItemDescription: r.ItemName,
            PlannedQuantity: r.PlannedQty, IssuedQuantity: r.IssuedQty,
          }));
          stockMap = await fetchStockMapViaDB([...new Set(lines.map(l => l.ItemNo).filter(Boolean))]);
          dbSource = getActiveType();
          console.log(`[PROD-LINES] DB Direct (${dbSource}) got ${lines.length} lines`);
        } catch (dbErr) {
          console.warn(`[PROD-LINES] DB Direct failed, falling back to Service Layer: ${dbErr.message}`);
          lines = []; stockMap = undefined;
        }
      }

      if (!stockMap) {
        // ── Service Layer fallback ──
        // ProductionOrderLines is returned INLINE on a raw entity GET (no $expand needed).
        if (isNum) {
          try {
            const raw = await sap.get(`/ProductionOrders(${docEntry})`, {});
            lines = raw.ProductionOrderLines || raw.Lines || [];
            console.log(`[PROD-LINES] raw fetch got ${lines.length} lines`);
          } catch(e) {
            console.log(`[PROD-LINES] raw fetch failed: ${e.message.slice(0,120)}`);
            // Last-resort: sub-collection URL
            try {
              const r = await sap.get(`/ProductionOrders(${docEntry})/ProductionOrderLines`, {});
              lines = r.value || (Array.isArray(r) ? r : []);
              console.log(`[PROD-LINES] sub-collection got ${lines.length} lines`);
            } catch(e2) { console.log(`[PROD-LINES] sub-collection failed: ${e2.message.slice(0,80)}`); }
          }
        }

        // ── Enrich lines with stock data ─────────────────────────────────────────
        const codes = [...new Set(lines.map(l => l.ItemNo || l.ItemCode).filter(Boolean))];
        stockMap = new Map();
        if (codes.length > 0) {
          const BATCH = 20;
          for (let i = 0; i < codes.length; i += BATCH) {
            const batch = codes.slice(i, i + BATCH);
            const filter = batch.map(c => `ItemCode eq '${c.replace(/'/g,"''")}'`).join(' or ');
            try {
              const r = await sap.get('/Items', { $filter: filter, $top: BATCH });
              for (const it of (r.value || [])) {
                const onHand    = Number(it.QuantityOnStock || it.OnHand || 0);
                const committed = Number(it.QuantityOrderedByCustomers || it.IsCommited || 0);
                stockMap.set(it.ItemCode, {
                  onHand, committed,
                  available: onHand - committed,
                  onOrder:   Number(it.QuantityOrderedFromVendors || it.OnOrder || 0),
                  itemName:  it.ItemName || it.ItemCode,
                  avgPrice:  Number(it.AvgPrice || it.AvgStdPrice || it.StdPrice || it.LastPurchasePrice || it.LastPurPrc || 0),
                });
              }
            } catch(e) { console.log(`[PROD-LINES] stock fetch failed: ${e.message.slice(0,120)}`); }
          }
        }
      }

      console.log(`[PROD-LINES] total lines found: ${lines.length}, stockMap size: ${stockMap.size}`);

      if (!lines.length) {
        return res.json({ ok: true, components: [], source: dbSource || 'empty' });
      }

      const components = lines.map(line => {
        const compCode   = line.ItemNo || line.ItemCode || '';
        const compName   = line.ItemDescription || line.ProductDescription || line.ItemName || '';
        const plannedQty = Number(line.PlannedQuantity || line.Quantity || 0);
        const issuedQty  = Number(line.IssuedQuantity  || 0);
        const needed     = Math.max(0, plannedQty - issuedQty);
        const stock      = stockMap.get(compCode) || { onHand:0, committed:0, available:0, onOrder:0, itemName:compName, avgPrice:0 };
        const shortage   = Math.max(0, needed - stock.available);
        const unitCost   = stock.avgPrice || 0;
        return {
          itemCode: compCode, itemName: compName || stock.itemName,
          plannedQty, issuedQty, needed,
          available: stock.available, onHand: stock.onHand, onOrder: stock.onOrder,
          shortage,
          pctCovered: needed > 0 ? Math.max(0, Math.min(100, Math.round((stock.available / needed) * 100))) : 100,
          unitCost,
          plannedCost: +(plannedQty * unitCost).toFixed(2),
          actualCost:  +(issuedQty  * unitCost).toFixed(2),
        };
      });

      res.json({ ok: true, components, source: dbSource || 'production_order_lines' });
    } catch(e) {
      console.error('[PROD-LINES] fatal:', e.message);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  router.post('/chat', requireAuth, async (req, res) => {
    try {
      const { message, sessionId = `prod_${Date.now()}` } = req.body;
      if (!message?.trim()) return res.status(400).json({ ok:false, error:'message required' });
      const sap = getActiveSap();
      const today = new Date().toISOString().slice(0,10);

      if (!_prodSessions.has(sessionId)) _prodSessions.set(sessionId, []);
      const history = _prodSessions.get(sessionId);
      history.push({ role:"user", content: message });
      if (history.length > 20) history.splice(0, history.length - 20);

      const systemPrompt = `You are a SAP B1 Production AI specialist. You help production managers proactively avoid delays by identifying material shortages early.

Today is ${today}. Always call the relevant tool to fetch live SAP data — never guess numbers.

Key rules:
- Risk levels: critical = one or more components have 0 available stock, high = a component is < 50% covered, medium = some shortage exists, ok = fully covered
- Available Stock = Physical Stock − Committed to Sales Orders
- Remaining component need = Planned Quantity − Already Issued Quantity
- Shortage = Remaining Need − Available Stock

When recommending actions:
- CRITICAL: Urgently expedite or emergency-source the short component; consider rescheduling the production order
- HIGH: Raise a Purchase Request now; check if open POs will arrive in time
- MEDIUM: Monitor closely; prepare contingency sourcing plan
- Always name the specific short components and their shortage quantities

After any analysis, give a concise, action-oriented summary.`;

      const messages = [{ role:"system", content: systemPrompt }, ...history];
      let response = null;
      for (let i = 0; i < 10; i++) {
        const body = { messages, tools: PROD_GPT_TOOLS, tool_choice:"auto", max_tokens:1500, temperature:0.2 };
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
            try { result = await executeProdTool(tc.function.name, args, sap); }
            catch(e) { result = { error: e.message }; }
            return { role:"tool", tool_call_id: tc.id, content: JSON.stringify(result) };
          }));
          messages.push(...toolResults);
        } else {
          response = msg.content || '';
          break;
        }
      }
      if (!response) response = "I was unable to complete that request. Please try again.";
      history.push({ role:"assistant", content: response });
      res.json({ ok:true, reply: response, sessionId });
    } catch(e) { res.status(500).json({ ok:false, error:e.message }); }
  });

  return router;
}
