/**
 * Stock Reorder Monitor (formerly "Procurement Create Agent" / "Procure-to-Pay
 * Agent") — scans items below minimum stock, cross-references open PO/SO
 * exposure, runs a PO↔GRPO↔AP-Invoice three-way match by vendor, builds
 * draft POs grouped by preferred vendor, posts them (or raises a Purchase
 * Request instead), and exposes a tool-calling AI chat over all of it.
 *
 * Extracted from chat-server.mjs (was ~520 inline lines under
 * "STOCK REORDER MONITOR") as part of splitting that file into per-agent
 * modules, following the same createXRouter(deps) factory pattern already
 * used by production-agent.mjs / mrp-agent.mjs / pricing-agent.mjs.
 *
 * mrpFetchVendorsViaDB/mrpFetchPricesViaDB/OITM_FIELD_CANDIDATES are
 * imported directly from mrp-agent.mjs (exported there) rather than
 * duplicated — this agent's draft-PO builder reuses the MRP agent's vendor
 * and pricing lookups, same as the original inline code did (previously via
 * function hoisting within one file; now an explicit cross-module import).
 */
import { Router } from 'express';
import { executeSQL, isConnected, getActiveType, getActiveConfig, tableRef, getTableColumns, resolveFieldMap } from '../db-connector.mjs';
import { qcol } from '../lib/sql-dialect.mjs';
import { OITM_FIELD_CANDIDATES, mrpFetchVendorsViaDB, mrpFetchPricesViaDB } from './mrp-agent.mjs';

const esc = s => String(s || '').replace(/'/g, "''");

// ── DB Direct (ODBC/HANA) reads, Service Layer fallback ────────────────────
// Same pattern as the MRP and Purchasing agents: resolve every logical field
// against the LIVE column list first, never guess. Falls back to Service
// Layer on any connection/mapping failure.
const PROC_HEADER_CANDIDATES = {
  docEntry: ['DocEntry'], docNum: ['DocNum'], cardCode: ['CardCode'], cardName: ['CardName'],
  docDate: ['DocDate'], docTotal: ['DocTotal'], docStatus: ['DocStatus'], docCur: ['DocCur'],
};

// Fetches header rows from a marketing-document table (OPOR/OPDN/OPCH/ORDR share this shape)
// and normalizes DocStatus ('O'/'C') to the Service Layer's DocumentStatus ('bost_Open'/'bost_Close')
// so downstream aggregation code works unchanged regardless of source.
async function procFetchHeadersViaDB(table, { fromDate, toDate, cardCode, statusOpenOnly } = {}) {
  const cfg    = getActiveConfig();
  const isHana = getActiveType() === 'hana';
  const q      = n => qcol(n, isHana);
  const cols   = await getTableColumns(table);
  const { resolved, missing } = resolveFieldMap(cols, PROC_HEADER_CANDIDATES);
  if (missing.length) throw new Error(`${table} field mapping incomplete: ${missing.join(', ')}`);
  const conds = [];
  if (fromDate) conds.push(`${q(resolved.docDate)} >= '${fromDate}'`);
  if (toDate)   conds.push(`${q(resolved.docDate)} <= '${toDate}'`);
  if (cardCode) conds.push(`${q(resolved.cardCode)} = '${esc(cardCode)}'`);
  if (statusOpenOnly) conds.push(`${q(resolved.docStatus)} = 'O'`);
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const sql = `SELECT ${q(resolved.docEntry)} AS ${q('DocEntry')}, ${q(resolved.docNum)} AS ${q('DocNum')}, ` +
    `${q(resolved.cardCode)} AS ${q('CardCode')}, ${q(resolved.cardName)} AS ${q('CardName')}, ` +
    `${q(resolved.docDate)} AS ${q('DocDate')}, ${q(resolved.docTotal)} AS ${q('DocTotal')}, ` +
    `${q(resolved.docStatus)} AS ${q('DocStatus')}, ${q(resolved.docCur)} AS ${q('DocCur')} ` +
    `FROM ${tableRef(table, cfg)} ${where}`;
  const rows = await executeSQL(sql);
  return rows.map(r => ({
    DocEntry: r.DocEntry, DocNum: r.DocNum, CardCode: r.CardCode, CardName: r.CardName,
    DocDate: r.DocDate, DocTotal: r.DocTotal, DocCurrency: r.DocCur,
    DocumentStatus: r.DocStatus === 'O' ? 'bost_Open' : 'bost_Close',
  }));
}

// OITM reorder-scan for the Procurement agent — same field candidates as the MRP agent
// but with the Procurement agent's own filter shape (optional single-item lookup that
// bypasses the MinInventory filter, matching the Service Layer branch below).
async function procReorderItemsViaDB(filterItemCode) {
  const cfg    = getActiveConfig();
  const isHana = getActiveType() === 'hana';
  const q      = n => qcol(n, isHana);
  const cols   = await getTableColumns('OITM');
  const { resolved, missing } = resolveFieldMap(cols, OITM_FIELD_CANDIDATES);
  if (missing.length) throw new Error(`OITM field mapping incomplete: ${missing.join(', ')}`);
  const conds = [`${q(resolved.purchaseItem)} = 'Y'`];
  if (filterItemCode) conds.push(`${q(resolved.itemCode)} = '${esc(filterItemCode)}'`);
  else conds.push(`${q(resolved.minInventory)} > 0`);
  const sql = `SELECT ${q(resolved.itemCode)} AS ${q('ItemCode')}, ${q(resolved.itemName)} AS ${q('ItemName')}, ` +
    `${q(resolved.onHand)} AS ${q('OnHand')}, ${q(resolved.committed)} AS ${q('IsCommited')}, ${q(resolved.onOrder)} AS ${q('OnOrder')}, ` +
    `${q(resolved.minInventory)} AS ${q('MinInventory')}, ${q(resolved.maxInventory)} AS ${q('MaxInventory')}, ` +
    `${q(resolved.leadTime)} AS ${q('LeadTime')}, ${q(resolved.mainSupplier)} AS ${q('CardCode')}, ${q(resolved.uom)} AS ${q('Uom')} ` +
    `FROM ${tableRef('OITM', cfg)} WHERE ${conds.join(' AND ')}`;
  const rows = await executeSQL(sql);
  return rows.map(r => ({
    ItemCode: r.ItemCode, ItemName: r.ItemName, QuantityOnStock: r.OnHand,
    QuantityOrderedByCustomers: r.IsCommited, QuantityOrderedFromVendors: r.OnOrder,
    MinInventory: r.MinInventory, MaxInventory: r.MaxInventory,
    LeadTime: r.LeadTime, Mainsupplier: r.CardCode, InventoryUOM: r.Uom,
  }));
}

const _procSessions = new Map(); // sessionId → messages[]

const PROC_GPT_TOOLS = [
  { type:"function", function:{ name:"get_reorder_items",
    description:"Get all items currently below minimum stock. Returns item code, name, physical stock, committed, available, min stock, gap, reorder qty, urgency.",
    parameters:{ type:"object", properties:{} } } },
  { type:"function", function:{ name:"search_item",
    description:"Look up a specific item by code. Returns stock levels, min/max, committed demand, on-order qty, lead time, preferred vendor.",
    parameters:{ type:"object", properties:{ itemCode:{ type:"string", description:"Exact item code e.g. 10000AB" } }, required:["itemCode"] } } },
  { type:"function", function:{ name:"get_open_purchase_orders",
    description:"Get open purchase orders. Optionally filter by vendor code.",
    parameters:{ type:"object", properties:{ vendorCode:{ type:"string", description:"Vendor card code (optional)" } } } } },
  { type:"function", function:{ name:"get_open_sales_orders",
    description:"Get open sales orders. Optionally filter by item code to see demand.",
    parameters:{ type:"object", properties:{ itemCode:{ type:"string", description:"Item code to filter (optional)" } } } } },
  { type:"function", function:{ name:"create_purchase_request",
    description:"Create a Purchase Request (internal requisition) in SAP B1. Call once per vendor group. Set docDueDate to today + item lead time. Use this when user wants to raise a PR or requisition for restock items.",
    parameters:{ type:"object",
      properties:{
        vendorCode:  { type:"string",  description:"Preferred vendor CardCode (optional — omit if unknown)" },
        docDueDate:  { type:"string",  description:"Required-by date YYYY-MM-DD (today + lead time)" },
        comments:    { type:"string",  description:"Comments on the PR — include urgency and reason" },
        lines: { type:"array", items:{ type:"object",
          properties:{
            itemCode:      { type:"string" },
            quantity:      { type:"number" },
            warehouseCode: { type:"string", description:"Warehouse code (optional)" },
          }, required:["itemCode","quantity"] } }
      },
      required:["lines"] } } },
];

async function executeProcTool(name, args, sap) {
  const esc = s => String(s).replace(/'/g,"''");
  if (name === 'get_reorder_items') {
    const r = await sap.get("/Items", {
      $filter: "PurchaseItem eq 'tYES' and Frozen eq 'tNO' and MinInventory gt 0",
      $select: "ItemCode,ItemName,QuantityOnStock,MinInventory,MaxInventory,LeadTime,Mainsupplier,InventoryUOM,QuantityOrderedFromVendors,QuantityOrderedByCustomers",
      $top: 2000,
    });
    const items = (r.value||[]).map(it => {
      const onHand = Number(it.QuantityOnStock||0), committed = Number(it.QuantityOrderedByCustomers||0);
      const onOrder = Number(it.QuantityOrderedFromVendors||it.QuantityOrderedByVendors||0);
      const minStock = Number(it.MinInventory||0), maxStock = Number(it.MaxInventory||0);
      const available = onHand - committed;
      if (available >= minStock) return null;
      const gap = minStock - available;
      const reorderQty = Math.max(1, maxStock > 0 ? maxStock - available - onOrder : gap * 2);
      const urgency = available <= 0 ? 'critical' : gap/minStock >= 0.7 ? 'high' : 'medium';
      return { itemCode:it.ItemCode, itemName:it.ItemName, onHand, committed, available, onOrder, minStock, maxStock, gap, reorderQty, urgency, leadTime:it.LeadTime||null, uom:it.InventoryUOM||'EA', preferredVendor:it.Mainsupplier||null };
    }).filter(Boolean);
    return { items, total: items.length };
  }
  if (name === 'search_item') {
    const it = await sap.get(`/Items('${esc(args.itemCode)}')`, {
      $select: "ItemCode,ItemName,QuantityOnStock,MinInventory,MaxInventory,LeadTime,Mainsupplier,InventoryUOM,QuantityOrderedFromVendors,QuantityOrderedByCustomers,PurchaseItem,SalesItem",
    });
    const onHand = Number(it.QuantityOnStock||0), committed = Number(it.QuantityOrderedByCustomers||0);
    const onOrder = Number(it.QuantityOrderedFromVendors||0), minStock = Number(it.MinInventory||0);
    const available = onHand - committed;
    const status = minStock > 0 && available < minStock ? (available<=0?'critical':'below-min') : 'ok';
    return { itemCode:it.ItemCode, itemName:it.ItemName, onHand, committed, available, onOrder, minStock, maxStock:Number(it.MaxInventory||0), leadTime:it.LeadTime||null, uom:it.InventoryUOM||'EA', preferredVendor:it.Mainsupplier||null, status };
  }
  if (name === 'get_open_purchase_orders') {
    let filter = "DocumentStatus eq 'bost_Open'";
    if (args.vendorCode) filter += ` and CardCode eq '${esc(args.vendorCode)}'`;
    const r = await sap.get("/PurchaseOrders", { $filter:filter, $select:"DocNum,CardCode,CardName,DocDate,DocDueDate,DocTotal,DocCurrency", $orderby:"DocDate desc", $top:50 });
    return { orders: r.value||[], total:(r.value||[]).length };
  }
  if (name === 'get_open_sales_orders') {
    let filter = "DocumentStatus eq 'bost_Open'";
    const r = await sap.get("/Orders", { $filter:filter, $select:"DocNum,CardCode,CardName,DocDate,DocDueDate,DocTotal,DocCurrency", $expand:"DocumentLines($select=ItemCode,ItemDescription,Quantity,OpenQty,UnitPrice)", $orderby:"DocDate desc", $top:100 });
    let orders = r.value||[];
    if (args.itemCode) orders = orders.filter(o => (o.DocumentLines||[]).some(l=>l.ItemCode===args.itemCode));
    return { orders: orders.slice(0,30), total: orders.length };
  }
  // Always via Service Layer: DB Direct (executeSQL) is SELECT-only by design, so writes
  // (PR creation) cannot go through ODBC/HANA regardless of which source read the data.
  if (name === 'create_purchase_request') {
    const today = new Date().toISOString().slice(0,10);
    const lines  = (args.lines||[]).map(l => ({
      ItemCode:      String(l.itemCode),
      Quantity:      Number(l.quantity),
      ...(l.warehouseCode ? { WarehouseCode: l.warehouseCode } : {}),
    }));
    if (!lines.length) return { error: 'No lines provided' };
    const body = {
      DocDate:    today,
      DocDueDate: args.docDueDate || today,
      Comments:   args.comments  || 'Auto-generated by Procurement AI – critical restock',
      DocumentLines: lines,
      ...(args.vendorCode ? { CardCode: args.vendorCode } : {}),
    };
    const pr = await sap.post('/PurchaseRequests', body);
    return { created: true, docNum: pr.DocNum, docEntry: pr.DocEntry, cardCode: pr.CardCode||args.vendorCode||null, lines: lines.length };
  }
  return { error: `Unknown tool: ${name}` };
}

export function createProcurementAgentRouter(deps) {
  const { requireAuth, getActiveSap, gptChatComplete } = deps;
  const router = Router();

  // ── 1. Reorder Analysis: items below min stock + demand aggregation ────────
  router.get('/reorder-analysis', requireAuth, async (req, res) => {
    try {
      const sap = getActiveSap();
      const filterItemCode = (req.query.itemCode || '').trim().toUpperCase();

      let items, openPOs, openSOs, source;
      if (isConnected()) {
        try {
          [items, openPOs, openSOs] = await Promise.all([
            procReorderItemsViaDB(filterItemCode || null),
            procFetchHeadersViaDB('OPOR', { statusOpenOnly: true }),
            procFetchHeadersViaDB('ORDR', { statusOpenOnly: true }),
          ]);
          source = getActiveType();
        } catch (dbErr) {
          console.warn('[Procurement/reorder-analysis] DB Direct failed, falling back to Service Layer:', dbErr.message);
        }
      }
      if (!items) {
        const itemFilter = filterItemCode
          ? `(PurchaseItem eq 'tYES' and Frozen eq 'tNO') and ItemCode eq '${filterItemCode.replace(/'/g,"''")}'`
          : "PurchaseItem eq 'tYES' and Frozen eq 'tNO' and MinInventory gt 0";
        const [itemsR, posR, sosR] = await Promise.allSettled([
          sap.get("/Items", {
            $filter: itemFilter,
            $select: "ItemCode,ItemName,QuantityOnStock,MinInventory,MaxInventory,LeadTime,Mainsupplier,InventoryUOM,QuantityOrderedFromVendors,QuantityOrderedByCustomers",
            $top: filterItemCode ? 10 : 2000,
          }),
          sap.get("/PurchaseOrders", {
            $filter: "DocumentStatus eq 'bost_Open'",
            $select: "DocEntry,DocNum,CardCode,DocTotal,DocDate,TaxDate",
            $top: 300,
          }),
          sap.get("/Orders", {
            $filter: "DocumentStatus eq 'bost_Open'",
            $select: "DocEntry,DocNum,CardCode,DocTotal,DocDate",
            $top: 300,
          }),
        ]);
        items   = itemsR.status==='fulfilled' ? (itemsR.value?.value||[]) : [];
        openPOs = posR.status==='fulfilled'   ? (posR.value?.value||[])   : [];
        openSOs = sosR.status==='fulfilled'   ? (sosR.value?.value||[])   : [];
        source  = 'service-layer';
      }

      // Open PO totals per vendor
      const vendorPOAmt = new Map();
      for (const po of openPOs) {
        vendorPOAmt.set(po.CardCode, (vendorPOAmt.get(po.CardCode)||0) + Number(po.DocTotal||0));
      }
      const totalOpenSOAmt = openSOs.reduce((s,o)=>s+Number(o.DocTotal||0), 0);

      const belowMin = [];
      for (const it of items) {
        const onHand   = Number(it.QuantityOnStock || it.OnHand || 0);
        const minStock = Number(it.MinInventory || 0);
        const onOrder   = Number(it.QuantityOrderedFromVendors || it.QuantityOrderedByVendors || 0);
        const committed = Number(it.QuantityOrderedByCustomers || 0);
        // Available = physical stock minus already-committed sales demand
        const available = onHand - committed;
        // When a specific item is requested, always include it even if above min
        if (!filterItemCode) {
          if (minStock <= 0) continue;
          if (available >= minStock) continue;
        }
        const maxStock   = Number(it.MaxInventory || 0);
        const gap        = minStock - available;
        const reorderQty = Math.max(1, maxStock > 0 ? maxStock - available - onOrder : gap * 2);
        const urgency    = available <= 0 ? 'critical' : gap / minStock >= 0.7 ? 'high' : 'medium';
        belowMin.push({
          itemCode: it.ItemCode, itemName: it.ItemName,
          onHand, committed, available, onOrder, minStock, maxStock, reorderQty, gap, urgency,
          leadTime: it.LeadTime || null, uom: it.InventoryUOM || it.InventoryUoM || 'EA',
          preferredVendor: it.Mainsupplier || it.PrfldVendor || null,
          vendorOpenPOAmt: (it.Mainsupplier||it.PrfldVendor) ? (vendorPOAmt.get(it.Mainsupplier||it.PrfldVendor)||0) : 0,
          selected: true,
        });
      }
      const urgOrder = { critical:0, high:1, medium:2 };
      belowMin.sort((a,b) => (urgOrder[a.urgency]||3)-(urgOrder[b.urgency]||3));
      res.json({ ok:true, items:belowMin, total:belowMin.length,
        filteredByItem: filterItemCode || null, source,
        summary:{ openPOs:openPOs.length, openSOs:openSOs.length, openSOAmt:totalOpenSOAmt } });
    } catch(e) { res.status(500).json({ ok:false, error:e.message }); }
  });

  // ── 3. Generate Draft POs grouped by preferred vendor ───────────────────────
  router.post('/generate-draft-pos', requireAuth, async (req, res) => {
    try {
      const { items } = req.body;
      if (!Array.isArray(items)||!items.length) return res.status(400).json({ ok:false, error:'items required' });
      const sap = getActiveSap();
      const dbAvailable = isConnected();

      // Fetch vendor names + currencies — DB Direct preferred (shares the MRP agent's OCRD helper), SL fallback
      const vendorCodes = [...new Set(items.filter(i=>i.preferredVendor).map(i=>i.preferredVendor))];
      const vendorMap = new Map();
      if (vendorCodes.length) {
        let rows = null;
        if (dbAvailable) {
          try { rows = await mrpFetchVendorsViaDB(vendorCodes); }
          catch (e) { console.warn('[Procurement/generate-draft-pos] vendor DB fallback:', e.message); }
        }
        if (!rows) {
          try {
            const filter = vendorCodes.map(v=>`CardCode eq '${esc(v)}'`).join(' or ');
            const vd = await sap.get("/BusinessPartners", { $filter:filter, $select:"CardCode,CardName,Currency,PaymentGroupCode", $top:100 });
            rows = vd.value || [];
          } catch { rows = []; /* non-fatal */ }
        }
        for (const v of rows) vendorMap.set(v.CardCode, v);
      }
      // Fetch last purchase prices — DB Direct preferred (shares the MRP agent's OITM price helper), SL fallback
      const priceMap = new Map();
      {
        let rows = null;
        if (dbAvailable) {
          try { rows = await mrpFetchPricesViaDB(items.map(i => i.itemCode)); }
          catch (e) { console.warn('[Procurement/generate-draft-pos] price DB fallback:', e.message); }
        }
        if (!rows) {
          rows = [];
          try {
            const filter = items.map(i=>`ItemCode eq '${esc(i.itemCode)}'`).join(' or ');
            const pd = await sap.get("/Items", { $filter:filter, $select:"ItemCode,LastPurchasePrice,BuyUnitMsr,InventoryUoM", $top:200 });
            rows = pd.value || [];
          } catch { /* non-fatal */ }
        }
        for (const it of rows) priceMap.set(it.ItemCode, it);
      }

      // Suggested delivery date = today + max lead time across items in the PO
      const today = new Date();
      const byVendor = new Map();
      const noVendorItems = [];
      for (const item of items) {
        if (!item.preferredVendor) { noVendorItems.push(item); continue; }
        if (!byVendor.has(item.preferredVendor)) byVendor.set(item.preferredVendor, []);
        const pi = priceMap.get(item.itemCode);
        const qty = Math.max(1, Number(item.reorderQty)||0);
        const price = Number(pi?.LastPurchasePrice||0);
        byVendor.get(item.preferredVendor).push({
          itemCode: item.itemCode, itemName: item.itemName,
          qty, uom: pi?.BuyUnitMsr || pi?.InventoryUoM || item.uom || 'EA',
          unitPrice: price, lineTotal: qty*price,
          leadTime: item.leadTime || null,
          onHand: item.onHand, minStock: item.minStock, urgency: item.urgency,
        });
      }
      const suggestDate = (lines) => {
        const maxLead = lines.reduce((m,l)=>Math.max(m,l.leadTime||7),7);
        const d = new Date(today.getTime() + maxLead*86400000);
        return d.toISOString().slice(0,10);
      };
      const draftPOs = [...byVendor.entries()].map(([vendorCode, lines]) => {
        const vendor = vendorMap.get(vendorCode);
        return {
          vendorCode, vendorName: vendor?.CardName || vendorCode,
          currency: vendor?.Currency || 'GBP',
          paymentGroup: vendor?.PaymentGroupCode ?? null,
          orderDate: today.toISOString().slice(0,10),
          deliveryDate: suggestDate(lines),
          lines, totalAmount: lines.reduce((s,l)=>s+l.lineTotal,0),
          status: 'draft',
        };
      }).sort((a,b) => b.totalAmount - a.totalAmount);

      res.json({ ok:true, draftPOs, noVendorItems, generatedAt: today.toISOString() });
    } catch(e) { res.status(500).json({ ok:false, error:e.message }); }
  });

  // ── 3b. Post a draft PO to SAP B1 ────────────────────────────────────────────
  // Always via Service Layer: DB Direct (executeSQL) is SELECT-only by design, so writes
  // (PO creation) cannot go through ODBC/HANA regardless of which source read the data.
  // Posting increases the item's QuantityOrderedFromVendors in SAP, so a re-run of
  // reorder-analysis naturally drops it below the reorder threshold — no separate
  // "already posted" tracking is needed for it to disappear from the next draft list.
  router.post('/post-po', requireAuth, async (req, res) => {
    try {
      const { draftPO } = req.body;
      if (!draftPO) return res.status(400).json({ ok:false, error:'draftPO required' });
      const sap = getActiveSap();
      const today = new Date().toISOString().slice(0, 10);

      const body = {
        CardCode:    draftPO.vendorCode,
        DocDate:     draftPO.orderDate    || today,
        DocDueDate:  draftPO.deliveryDate || today,
        Comments:    `Procurement Create Agent — Auto-PO — ${today}`,
        ...(draftPO.paymentGroup != null ? { PaymentGroupCode: draftPO.paymentGroup } : {}),
        DocumentLines: (draftPO.lines || []).map(l => ({
          ItemCode:  l.itemCode,
          Quantity:  Number(l.qty),
          UnitPrice: Number(l.unitPrice || 0),
          UoMCode:   l.uom || undefined,
        })),
      };

      const po = await sap.post('/PurchaseOrders', body);
      res.json({ ok:true, docNum: po.DocNum, docEntry: po.DocEntry, docStatus: po.DocumentStatus || 'bost_Open' });
    } catch(e) {
      res.status(500).json({ ok:false, error:e.message });
    }
  });

  // ── 4. Procurement AI Chat ───────────────────────────────────────────────────
  router.post('/chat', requireAuth, async (req, res) => {
    try {
      const { message, sessionId = `proc_${Date.now()}` } = req.body;
      if (!message?.trim()) return res.status(400).json({ ok:false, error:'message required' });
      const sap = getActiveSap();
      const today = new Date().toISOString().slice(0,10);

      if (!_procSessions.has(sessionId)) _procSessions.set(sessionId, []);
      const history = _procSessions.get(sessionId);
      history.push({ role:"user", content: message });
      if (history.length > 20) history.splice(0, history.length - 20);

      const systemPrompt = `You are a SAP B1 Stock Reorder Monitor AI specialist. You help users analyse inventory levels, reorder needs, and open purchase/sales orders. You can also CREATE Purchase Requests directly in SAP B1. (Three-way match analysis has moved to the separate Purchase Three Way Match agent — if asked about it, tell the user to open that agent.)

Today is ${today}. Always call the relevant tool to fetch live data before answering — never guess numbers.

Key rules:
- Available Stock = Physical Stock − Committed to Sales Orders
- Item needs reordering when Available < Minimum Stock
- Urgency: critical = available ≤ 0, high = gap ≥ 70% of min, medium = below min
- Reorder Qty = Max Stock − Available − On Order (if max set), else 2 × Gap

When creating Purchase Requests:
- Set docDueDate = today + item's lead time days (e.g. lead 30d → ${new Date(Date.now()+30*86400000).toISOString().slice(0,10)})
- Group items by preferred vendor — one PR per vendor; items with no vendor go in one combined PR
- Include urgency + reason in comments
- After creation, confirm each PR with its DocNum
- If multiple vendors, call create_purchase_request once per vendor group

After any action, give a concise summary of what was done and any follow-up recommendations.
Be concise, data-driven, and use plain text with simple formatting.`;

      const messages = [{ role:"system", content: systemPrompt }, ...history];
      let response = null;
      for (let i = 0; i < 10; i++) {
        const body = { messages, tools: PROC_GPT_TOOLS, tool_choice:"auto", max_tokens:1500, temperature:0.2 };
        const raw = await gptChatComplete(body);
        const choice = raw?.choices?.[0];
        if (!choice) throw new Error('No response from AI');
        const msg = choice.message;
        messages.push(msg);

        if (choice.finish_reason === 'tool_calls' && msg.tool_calls?.length) {
          const toolResults = await Promise.all(msg.tool_calls.map(async tc => {
            let args = {};
            try { args = JSON.parse(tc.function.arguments||'{}'); } catch {}
            let result;
            try { result = await executeProcTool(tc.function.name, args, sap); }
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

// ── Purchase Three-Way Match Agent: PO ↔ GRPO ↔ AP Invoice by vendor ─────────
// A separate route (mounted at its own top-level path by chat-server.mjs,
// not under /api/procurement) but kept in this file since it shares
// procFetchHeadersViaDB with the reorder-analysis logic above.
export function createPurchaseThreeWayMatchRouter(deps) {
  const { requireAuth, getActiveSap } = deps;
  const router = Router();

  router.get('/scan', requireAuth, async (req, res) => {
    try {
      const year = parseInt(req.query.year) || new Date().getFullYear();
      const from = `${year}-01-01`, to = `${year}-12-31`;
      const vendorFilter = (req.query.vendorCode || '').trim();  // optional vendor filter
      const sap = getActiveSap();

      let pos, grpos, apInv, source;
      if (isConnected()) {
        try {
          [pos, grpos, apInv] = await Promise.all([
            procFetchHeadersViaDB('OPOR', { fromDate: from, toDate: to, cardCode: vendorFilter || null }),
            procFetchHeadersViaDB('OPDN', { fromDate: from, toDate: to, cardCode: vendorFilter || null }),
            procFetchHeadersViaDB('OPCH', { fromDate: from, toDate: to, cardCode: vendorFilter || null }),
          ]);
          source = getActiveType();
        } catch (dbErr) {
          console.warn('[PurchaseThreeWayMatch] DB Direct failed, falling back to Service Layer:', dbErr.message);
        }
      }
      if (!pos) {
        const dateFilter = `DocDate ge '${from}' and DocDate le '${to}'`;
        const mkFilter    = (extra) => extra ? `${dateFilter} and CardCode eq '${extra.replace(/'/g,"''")}'` : dateFilter;
        const [posR, grposR, apInvR] = await Promise.allSettled([
          sap.get("/PurchaseOrders", {
            $filter: mkFilter(vendorFilter),
            $select: "DocEntry,DocNum,CardCode,CardName,DocDate,DocTotal,DocCurrency,DocumentStatus",
            $orderby: "CardCode asc,DocDate desc", $top: 500,
          }),
          sap.get("/GoodsReceiptsPO", {
            $filter: mkFilter(vendorFilter),
            $select: "DocEntry,DocNum,CardCode,CardName,DocDate,DocTotal,DocCurrency",
            $orderby: "CardCode asc,DocDate desc", $top: 500,
          }),
          sap.get("/PurchaseInvoices", {
            $filter: mkFilter(vendorFilter),
            $select: "DocEntry,DocNum,CardCode,CardName,DocDate,DocTotal,DocCurrency",
            $orderby: "CardCode asc,DocDate desc", $top: 500,
          }),
        ]);
        pos    = posR.status==='fulfilled'   ? (posR.value?.value||[])   : [];
        grpos  = grposR.status==='fulfilled' ? (grposR.value?.value||[]) : [];
        apInv  = apInvR.status==='fulfilled' ? (apInvR.value?.value||[]) : [];
        source = 'service-layer';
      }

      const vendors = new Map();
      const add = (type, docs) => docs.forEach(d => {
        if (!vendors.has(d.CardCode)) vendors.set(d.CardCode, { vendorCode:d.CardCode, vendorName:d.CardName||d.CardCode, pos:[], grpos:[], invoices:[] });
        vendors.get(d.CardCode)[type].push({ docNum:d.DocNum, docDate:d.DocDate?.slice(0,10), total:Number(d.DocTotal||0), currency:d.DocCurrency, status:d.DocumentStatus });
      });
      add('pos', pos); add('grpos', grpos); add('invoices', apInv);

      const result = [...vendors.values()].map(v => {
        const poAmt   = v.pos.reduce((s,d)=>s+d.total,0);
        const grpoAmt = v.grpos.reduce((s,d)=>s+d.total,0);
        const invAmt  = v.invoices.reduce((s,d)=>s+d.total,0);
        const poOpen  = v.pos.filter(d=>d.status==='bost_Open').length;
        const variance= invAmt - poAmt;
        const matchPct= poAmt > 0 ? Math.round((invAmt/poAmt)*100) : 0;
        const status  = Math.abs(variance) < 1 ? 'matched'
          : poOpen > 0 && grpoAmt < poAmt ? 'grpo-pending'
          : grpoAmt > invAmt ? 'invoice-pending'
          : Math.abs(variance/Math.max(poAmt,1)) > 0.05 ? 'variance' : 'matched';
        return { ...v, poAmt, grpoAmt, invAmt, variance, matchPct, poOpen, status };
      }).sort((a,b) => b.poAmt - a.poAmt);

      res.json({ ok:true, vendors:result,
        filteredByVendor: vendorFilter || null, source,
        counts:{ pos:pos.length, grpos:grpos.length, invoices:apInv.length },
        totals:{ poAmt:pos.reduce((s,d)=>s+Number(d.DocTotal||0),0),
                 grpoAmt:grpos.reduce((s,d)=>s+Number(d.DocTotal||0),0),
                 invAmt:apInv.reduce((s,d)=>s+Number(d.DocTotal||0),0) } });
    } catch(e) { res.status(500).json({ ok:false, error:e.message }); }
  });

  return router;
}
