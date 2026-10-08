/**
 * MRP Reorder Auto-PO Agent — scans inventory vs reorder points, enriches
 * with vendor/pricing/payment-terms data, builds draft POs grouped by
 * vendor, posts them to SAP (triggering the approval workflow), emails the
 * vendor, and exposes an audit log + tool-calling AI chat over all of it.
 *
 * Extracted from chat-server.mjs (was ~615 inline lines under
 * "MRP REORDER AUTO-PO AGENT") as part of splitting that file into
 * per-agent modules, following the same createXRouter(deps) factory
 * pattern already used by po-agent.mjs / production-agent.mjs.
 */
import { Router } from 'express';
import nodemailer from 'nodemailer';
import { executeSQL, isConnected, getActiveType, getActiveConfig, tableRef, getTableColumns, resolveFieldMap } from '../db-connector.mjs';
import { qcol } from '../lib/sql-dialect.mjs';
import db, { connRepo } from '../db.mjs';

// ── Persisted draft POs ──────────────────────────────────────────────────────
// Draft POs survive page reloads and MRP re-runs until they are posted to SAP
// (or discarded). Items sitting in an open draft are flagged by
// /inventory-check so the UI does not offer them again.
db.exec(`
  CREATE TABLE IF NOT EXISTS mrp_draft_pos (
    id          TEXT PRIMARY KEY,
    company_id  TEXT NOT NULL,
    vendor_code TEXT,
    status      TEXT NOT NULL DEFAULT 'draft',
    doc_num     INTEGER,
    doc_entry   INTEGER,
    data        TEXT NOT NULL,
    created_by  TEXT,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    posted_at   DATETIME
  );
  CREATE INDEX IF NOT EXISTS idx_mrp_draft_pos_company ON mrp_draft_pos (company_id, status);
`);

function mrpCompanyId() {
  const conn = connRepo.getActive();
  return conn ? conn.company : 'default';
}

const draftRepo = {
  rowToDraft(r) {
    const d = JSON.parse(r.data);
    return { ...d, id: r.id, status: r.status, docNum: r.doc_num ?? undefined, docEntry: r.doc_entry ?? undefined,
      createdAt: r.created_at, postedAt: r.posted_at || undefined };
  },
  // Open drafts + anything posted in the last 24h (so the user still sees the result)
  list(companyId) {
    return db.prepare(`SELECT * FROM mrp_draft_pos WHERE company_id=? AND
        (status='draft' OR (status='posted' AND posted_at >= datetime('now','-1 day')))
        ORDER BY status='posted', created_at`).all(companyId).map(r => this.rowToDraft(r));
  },
  get(companyId, id) {
    const r = db.prepare(`SELECT * FROM mrp_draft_pos WHERE company_id=? AND id=?`).get(companyId, id);
    return r ? this.rowToDraft(r) : null;
  },
  openForVendor(companyId, vendorCode) {
    const r = vendorCode
      ? db.prepare(`SELECT * FROM mrp_draft_pos WHERE company_id=? AND status='draft' AND vendor_code=? LIMIT 1`).get(companyId, vendorCode)
      : db.prepare(`SELECT * FROM mrp_draft_pos WHERE company_id=? AND status='draft' AND vendor_code IS NULL LIMIT 1`).get(companyId);
    return r ? this.rowToDraft(r) : null;
  },
  openItemCodes(companyId) {
    const map = new Map();
    for (const d of this.list(companyId)) {
      if (d.status !== 'draft') continue;
      for (const l of d.lines || []) map.set(l.itemCode, d.id);
    }
    return map;
  },
  save(companyId, draft, user) {
    const { id, status = 'draft', docNum, docEntry, createdAt, postedAt, ...data } = draft;
    db.prepare(`INSERT INTO mrp_draft_pos (id, company_id, vendor_code, status, doc_num, doc_entry, data, created_by)
        VALUES (?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET vendor_code=excluded.vendor_code, status=excluded.status,
          doc_num=excluded.doc_num, doc_entry=excluded.doc_entry, data=excluded.data, updated_at=CURRENT_TIMESTAMP`)
      .run(id, companyId, data.vendorCode || null, status, docNum ?? null, docEntry ?? null, JSON.stringify(data), user || null);
  },
  markPosted(companyId, id, docNum, docEntry) {
    db.prepare(`UPDATE mrp_draft_pos SET status='posted', doc_num=?, doc_entry=?, posted_at=CURRENT_TIMESTAMP,
        updated_at=CURRENT_TIMESTAMP WHERE company_id=? AND id=?`).run(docNum, docEntry, companyId, id);
  },
  remove(companyId, id) {
    return db.prepare(`DELETE FROM mrp_draft_pos WHERE company_id=? AND id=? AND status='draft'`).run(companyId, id).changes;
  },
};

const recalcDraft = d => {
  d.lines = (d.lines || []).map(l => ({ ...l, lineTotal: Number(l.unitPrice || 0) * Number(l.qty || 0) }));
  d.totalAmount = d.lines.reduce((s, l) => s + l.lineTotal, 0);
  return d;
};

const _mrpAuditLog = [];
const _mrpSessions = new Map();

function mrpLog(action, details = {}) {
  const entry = { ts: new Date().toISOString(), action, ...details };
  _mrpAuditLog.unshift(entry);
  if (_mrpAuditLog.length > 300) _mrpAuditLog.length = 300;
  return entry;
}

// ── MRP data source: DB Direct (ODBC/HANA) preferred, Service Layer fallback ──
// Every logical field the agent needs is resolved against the LIVE column list
// of the active DB before any SQL is built. If a required field can't be
// resolved (or the SQL/DB call itself fails), the read falls back to the
// Service Layer path below rather than risking a wrong quantity/vendor on a
// PO that gets auto-posted.
export const OITM_FIELD_CANDIDATES = {
  itemCode:     ['ItemCode'],
  itemName:     ['ItemName'],
  onHand:       ['OnHand'],
  committed:    ['IsCommited'],
  onOrder:      ['OnOrder'],
  minInventory: ['MinLevel', 'MinInvntry'],
  maxInventory: ['MaxLevel', 'MaxInvntry'],
  leadTime:     ['LeadTime'],
  mainSupplier: ['CardCode'],
  uom:          ['InvntryUom', 'BuyUnitMsr'],
  purchaseItem: ['PrchseItem'],
};

async function mrpInventoryCheckViaDB() {
  const cfg = getActiveConfig();
  const isHana = getActiveType() === 'hana';
  const q = n => qcol(n, isHana);
  const cols = await getTableColumns('OITM');
  const { resolved, missing } = resolveFieldMap(cols, OITM_FIELD_CANDIDATES);
  if (missing.length) {
    throw new Error(`OITM field mapping incomplete — no matching column found for: ${missing.join(', ')}`);
  }
  const oitm = tableRef('OITM', cfg);
  const sql = `SELECT ${q(resolved.itemCode)} AS ${q('ItemCode')}, ${q(resolved.itemName)} AS ${q('ItemName')}, ` +
    `${q(resolved.onHand)} AS ${q('OnHand')}, ${q(resolved.committed)} AS ${q('IsCommited')}, ${q(resolved.onOrder)} AS ${q('OnOrder')}, ` +
    `${q(resolved.minInventory)} AS ${q('MinInventory')}, ${q(resolved.maxInventory)} AS ${q('MaxInventory')}, ` +
    `${q(resolved.leadTime)} AS ${q('LeadTime')}, ${q(resolved.mainSupplier)} AS ${q('CardCode')}, ${q(resolved.uom)} AS ${q('Uom')} ` +
    `FROM ${oitm} WHERE ${q(resolved.purchaseItem)} = 'Y' AND ${q(resolved.minInventory)} > 0`;
  const rows = await executeSQL(sql);
  return rows.map(r => ({
    ItemCode: r.ItemCode, ItemName: r.ItemName,
    QuantityOnStock: r.OnHand, QuantityOrderedByCustomers: r.IsCommited,
    QuantityOrderedFromVendors: r.OnOrder,
    MinInventory: r.MinInventory, MaxInventory: r.MaxInventory,
    LeadTime: r.LeadTime, Mainsupplier: r.CardCode, InventoryUOM: r.Uom,
  }));
}

async function mrpInventoryCheckViaServiceLayer(sap) {
  const r = await sap.get("/Items", {
    $filter: "PurchaseItem eq 'tYES' and Frozen eq 'tNO' and MinInventory gt 0",
    $select: "ItemCode,ItemName,QuantityOnStock,MinInventory,MaxInventory,LeadTime,Mainsupplier,InventoryUOM,QuantityOrderedFromVendors,QuantityOrderedByCustomers",
    $top: 2000,
  });
  return r.value || [];
}

// ── ai-analyze enrichment: DB Direct (OCRD/OCTG/OITM) with SL fallback ──────
const OCRD_FIELD_CANDIDATES = {
  cardCode: ['CardCode'], cardName: ['CardName'],
  email: ['E_Mail', 'EmailAddress'], currency: ['Currency'],
  paymentGroupCode: ['GroupNum'], phone: ['Phone1'], city: ['City'],
};
const OCTG_FIELD_CANDIDATES = {
  groupNumber: ['GroupNum'], groupName: ['PymntGroup'],
};
const OITM_PRICE_FIELD_CANDIDATES = {
  itemCode: ['ItemCode'], lastPurPrc: ['LastPurPrc'],
  buyUnitMsr: ['BuyUnitMsr'], invntryUom: ['InvntryUom'],
};

export async function mrpFetchVendorsViaDB(vendorCodes) {
  const cfg = getActiveConfig();
  const isHana = getActiveType() === 'hana';
  const q = n => qcol(n, isHana);
  const cols = await getTableColumns('OCRD');
  const { resolved, missing } = resolveFieldMap(cols, OCRD_FIELD_CANDIDATES);
  if (missing.length) throw new Error(`OCRD field mapping incomplete: ${missing.join(', ')}`);
  const esc = s => String(s).replace(/'/g, "''");
  const inList = vendorCodes.map(v => `'${esc(v)}'`).join(',');
  const sql = `SELECT ${q(resolved.cardCode)} AS ${q('CardCode')}, ${q(resolved.cardName)} AS ${q('CardName')}, ` +
    `${q(resolved.email)} AS ${q('EmailAddress')}, ${q(resolved.currency)} AS ${q('Currency')}, ` +
    `${q(resolved.paymentGroupCode)} AS ${q('PaymentGroupCode')}, ${q(resolved.phone)} AS ${q('Phone1')}, ${q(resolved.city)} AS ${q('City')} ` +
    `FROM ${tableRef('OCRD', cfg)} WHERE ${q(resolved.cardCode)} IN (${inList})`;
  return executeSQL(sql);
}

async function mrpFetchPaymentTermsViaDB() {
  const cfg = getActiveConfig();
  const isHana = getActiveType() === 'hana';
  const q = n => qcol(n, isHana);
  const cols = await getTableColumns('OCTG');
  const { resolved, missing } = resolveFieldMap(cols, OCTG_FIELD_CANDIDATES);
  if (missing.length) throw new Error(`OCTG field mapping incomplete: ${missing.join(', ')}`);
  const sql = `SELECT ${q(resolved.groupNumber)} AS ${q('GroupNumber')}, ${q(resolved.groupName)} AS ${q('PaymentTermsGroupName')} ` +
    `FROM ${tableRef('OCTG', cfg)}`;
  return executeSQL(sql);
}

export async function mrpFetchPricesViaDB(itemCodes) {
  const cfg = getActiveConfig();
  const isHana = getActiveType() === 'hana';
  const q = n => qcol(n, isHana);
  const cols = await getTableColumns('OITM');
  const { resolved, missing } = resolveFieldMap(cols, OITM_PRICE_FIELD_CANDIDATES);
  if (missing.length) throw new Error(`OITM price field mapping incomplete: ${missing.join(', ')}`);
  const esc = s => String(s).replace(/'/g, "''");
  const rows = [];
  for (let i = 0; i < itemCodes.length; i += 200) {
    const chunk = itemCodes.slice(i, i + 200);
    const inList = chunk.map(c => `'${esc(c)}'`).join(',');
    const sql = `SELECT ${q(resolved.itemCode)} AS ${q('ItemCode')}, ${q(resolved.lastPurPrc)} AS ${q('LastPurchasePrice')}, ` +
      `${q(resolved.buyUnitMsr)} AS ${q('BuyUnitMsr')}, ${q(resolved.invntryUom)} AS ${q('InventoryUoM')} ` +
      `FROM ${tableRef('OITM', cfg)} WHERE ${q(resolved.itemCode)} IN (${inList})`;
    rows.push(...await executeSQL(sql));
  }
  return rows;
}

// Vendor details for a draft PO header — local cache first, then Service Layer
async function mrpLookupVendor(sap, vendorCode) {
  const cid = mrpCompanyId();
  let v = null;
  try {
    const c = db.prepare(`SELECT CardCode, CardName, EmailAddress, Currency, PayTermsGrpCode FROM cache_business_partners
        WHERE company_id=? AND CardCode=?`).get(cid, vendorCode);
    if (c) v = { CardCode: c.CardCode, CardName: c.CardName, EmailAddress: c.EmailAddress, Currency: c.Currency, PaymentGroupCode: c.PayTermsGrpCode };
  } catch { /* cache table may be empty */ }
  if (!v) {
    v = await sap.get(`/BusinessPartners('${String(vendorCode).replace(/'/g, "''")}')`,
      { $select: "CardCode,CardName,EmailAddress,Currency,PaymentGroupCode" });
  }
  let paymentTerms = null;
  if (v.PaymentGroupCode != null) {
    try {
      paymentTerms = db.prepare(`SELECT PaymentTermsGroupName FROM cache_payment_terms WHERE company_id=? AND GroupNumber=?`)
        .get(cid, v.PaymentGroupCode)?.PaymentTermsGroupName || null;
    } catch {}
    if (!paymentTerms) {
      try { paymentTerms = (await sap.get(`/PaymentTermsTypes(${v.PaymentGroupCode})`, { $select: "PaymentTermsGroupName" }))?.PaymentTermsGroupName || null; } catch {}
    }
  }
  return {
    vendorCode: v.CardCode, vendorName: v.CardName || v.CardCode,
    vendorEmail: v.EmailAddress || null, vendorCurrency: v.Currency && v.Currency !== '##' ? v.Currency : 'GBP',
    paymentGroupCode: v.PaymentGroupCode ?? null, paymentTerms,
  };
}

// Re-read stock for the given items from SAP after a PO post and refresh the local
// item cache, so on-order quantities are current everywhere. Non-fatal by design.
async function mrpSyncItemStock(sap, itemCodes) {
  const cid = mrpCompanyId();
  const esc = s => String(s).replace(/'/g, "''");
  const out = [];
  for (let i = 0; i < itemCodes.length; i += 50) {
    const chunk = itemCodes.slice(i, i + 50);
    const r = await sap.get('/Items', {
      $filter: chunk.map(c => `ItemCode eq '${esc(c)}'`).join(' or '),
      $select: 'ItemCode,QuantityOnStock,QuantityOrderedByCustomers,QuantityOrderedFromVendors,MinInventory',
      $top: 50,
    });
    out.push(...(r.value || []));
  }
  const upd = db.prepare(`UPDATE cache_items SET QuantityOnStock=? WHERE company_id=? AND ItemCode=?`);
  return out.map(it => {
    try { upd.run(Number(it.QuantityOnStock || 0), cid, it.ItemCode); } catch {}
    const onHand = Number(it.QuantityOnStock || 0), committed = Number(it.QuantityOrderedByCustomers || 0);
    const onOrder = Number(it.QuantityOrderedFromVendors || 0), minStock = Number(it.MinInventory || 0);
    return { itemCode: it.ItemCode, onHand, committed, onOrder, minStock,
      available: onHand - committed, projected: onHand - committed + onOrder };
  });
}

const MRP_GPT_TOOLS = [
  { type:"function", function:{ name:"run_mrp_check",
    description:"Scan all inventory items vs reorder points. Returns items below min stock with urgency, gap, reorder qty, preferred vendor and last price.",
    parameters:{ type:"object", properties:{} } } },
  { type:"function", function:{ name:"get_vendor_info",
    description:"Get vendor (OCRD) details — email, phone, currency, payment terms.",
    parameters:{ type:"object", properties:{ vendorCode:{ type:"string" } }, required:["vendorCode"] } } },
  { type:"function", function:{ name:"get_item_price",
    description:"Get last purchase price and preferred vendor for an item (ITM1/OITM).",
    parameters:{ type:"object", properties:{ itemCode:{ type:"string" } }, required:["itemCode"] } } },
  { type:"function", function:{ name:"get_open_pos",
    description:"Get open purchase orders, optionally filtered by vendor.",
    parameters:{ type:"object", properties:{ vendorCode:{ type:"string" } } } } },
  { type:"function", function:{ name:"check_approval_status",
    description:"Check pending SAP approval requests for purchase orders.",
    parameters:{ type:"object", properties:{} } } },
];

async function executeMrpTool(name, args, sap) {
  const esc = s => String(s).replace(/'/g, "''");
  if (name === 'run_mrp_check') {
    const r = await sap.get("/Items", {
      $filter: "PurchaseItem eq 'tYES' and Frozen eq 'tNO' and MinInventory gt 0",
      $select: "ItemCode,ItemName,QuantityOnStock,MinInventory,MaxInventory,LeadTime,Mainsupplier,InventoryUOM,QuantityOrderedFromVendors,QuantityOrderedByCustomers",
      $top: 2000,
    });
    const items = (r.value || []).map(it => {
      const onHand=Number(it.QuantityOnStock||0), committed=Number(it.QuantityOrderedByCustomers||0);
      const onOrder=Number(it.QuantityOrderedFromVendors||0), minStock=Number(it.MinInventory||0), maxStock=Number(it.MaxInventory||0);
      const available=onHand-committed;
      if (available>=minStock) return null;
      const gap=minStock-available, reorderQty=Math.max(1,maxStock>0?maxStock-available-onOrder:gap*2);
      const urgency=available<=0?'critical':gap/minStock>=0.7?'high':'medium';
      return { itemCode:it.ItemCode, itemName:it.ItemName, onHand, committed, available, onOrder, minStock, gap, reorderQty, urgency, leadTime:it.LeadTime||7, preferredVendor:it.Mainsupplier||null };
    }).filter(Boolean);
    return { items, total:items.length, critical:items.filter(i=>i.urgency==='critical').length, high:items.filter(i=>i.urgency==='high').length };
  }
  if (name === 'get_vendor_info') {
    const v = await sap.get(`/BusinessPartners('${esc(args.vendorCode)}')`, { $select:"CardCode,CardName,EmailAddress,Phone1,Currency,PaymentGroupCode,City,Country" });
    let paymentTerms = null;
    try { const pt = await sap.get(`/PaymentTermsTypes(${v.PaymentGroupCode})`, { $select:"PaymentTermsGroupName" }); paymentTerms = pt?.PaymentTermsGroupName; } catch {}
    return { cardCode:v.CardCode, cardName:v.CardName, email:v.EmailAddress, phone:v.Phone1, currency:v.Currency, city:v.City, country:v.Country, paymentTerms };
  }
  if (name === 'get_item_price') {
    const it = await sap.get(`/Items('${esc(args.itemCode)}')`, { $select:"ItemCode,ItemName,LastPurchasePrice,BuyUnitMsr,Mainsupplier" });
    return { itemCode:it.ItemCode, itemName:it.ItemName, lastPurchasePrice:Number(it.LastPurchasePrice||0), uom:it.BuyUnitMsr, preferredVendor:it.Mainsupplier };
  }
  if (name === 'get_open_pos') {
    let filter = "DocumentStatus eq 'bost_Open'";
    if (args.vendorCode) filter += ` and CardCode eq '${esc(args.vendorCode)}'`;
    const r = await sap.get("/PurchaseOrders", { $filter:filter, $select:"DocNum,CardCode,CardName,DocDate,DocDueDate,DocTotal,DocCurrency", $orderby:"DocDate desc", $top:30 });
    return { orders:r.value||[], total:(r.value||[]).length };
  }
  if (name === 'check_approval_status') {
    try {
      const r = await sap.get("/ApprovalRequests", { $filter:"Status eq 'arpd_Pending'", $select:"Code,ObjectType,ObjectEntry,Status,Remarks,CreationDate", $top:20 });
      return { requests:r.value||[], total:(r.value||[]).length };
    } catch { return { requests:[], total:0, note:'Approval Requests not accessible' }; }
  }
  return { error: `Unknown tool: ${name}` };
}

// "How is this calculated?" popups — built from the same variables used above so the
// explanation can never drift from the value shown in the table.
function mrpExplain({ onHand, committed, available, onOrder, minStock, maxStock, projected, gap, reorderQty, urgency }) {
  const f = n => Number(n || 0).toLocaleString('en-GB', { maximumFractionDigits: 2 });
  const gapPct = minStock > 0 ? Math.round(gap / minStock * 100) : 0;
  const base = [
    { label: 'Available stock', formula: `In stock ${f(onHand)} − committed to sales orders ${f(committed)}`, value: available },
    { label: 'Projected stock', formula: `Available ${f(available)} + already on order from vendors ${f(onOrder)}`, value: projected },
    { label: 'Gap to minimum', formula: `Minimum stock ${f(minStock)} − projected ${f(projected)}`, value: gap },
  ];
  return {
    urgency: {
      title: `Why urgency is ${urgency.toUpperCase()}`,
      steps: [...base, { label: 'Gap as % of minimum', formula: `Gap ${f(gap)} ÷ minimum ${f(minStock)}`, value: `${gapPct}%` }],
      rules: [
        { rule: 'Available stock is 0 or less', result: 'CRITICAL', hit: urgency === 'critical' },
        { rule: 'Gap is 70% or more of the minimum stock', result: 'HIGH', hit: urgency === 'high' },
        { rule: 'Otherwise (projected stock below minimum)', result: 'MEDIUM', hit: urgency === 'medium' },
      ],
      note: 'Only items whose projected stock (available + on order) is below the minimum are listed.',
    },
    gap: {
      title: 'How the gap is calculated',
      steps: base,
      result: { label: 'Gap', value: gap },
    },
    reorderQty: {
      title: 'How the reorder quantity is calculated',
      steps: [
        ...base,
        maxStock > 0
          ? { label: 'Fill up to maximum', formula: `Maximum stock ${f(maxStock)} − projected ${f(projected)}`, value: maxStock - projected }
          : { label: 'Twice the gap', formula: `Gap ${f(gap)} × 2 (no maximum stock set)`, value: gap * 2 },
      ],
      result: { label: 'Reorder quantity (at least 1)', value: reorderQty },
      rules: [
        { rule: 'Maximum stock is set on the item', result: 'Maximum − projected stock', hit: maxStock > 0 },
        { rule: 'No maximum stock set', result: 'Gap × 2', hit: !(maxStock > 0) },
      ],
    },
  };
}

export function createMrpAgentRouter(deps) {
  const { requireAuth, getActiveSap, gptChatComplete } = deps;
  const router = Router();

  // 1. MRP Inventory Threshold Check — DB Direct (ODBC/HANA) when available, else /Items
  router.get('/inventory-check', requireAuth, async (req, res) => {
    try {
      let raw, source;
      if (isConnected()) {
        try {
          raw = await mrpInventoryCheckViaDB();
          source = getActiveType(); // 'mssql' | 'hana'
        } catch (dbErr) {
          mrpLog('MRP_DB_FALLBACK', { reason: dbErr.message });
          console.warn('[MRP inventory-check] DB Direct failed, falling back to Service Layer:', dbErr.message);
        }
      }
      if (!raw) {
        raw = await mrpInventoryCheckViaServiceLayer(getActiveSap());
        source = 'service-layer';
      }

      const items = raw.map(it => {
        const onHand    = Number(it.QuantityOnStock || it.OnHand || 0);
        const committed = Number(it.QuantityOrderedByCustomers || 0);
        const onOrder   = Number(it.QuantityOrderedFromVendors || it.QuantityOrderedByVendors || 0);
        const minStock  = Number(it.MinInventory || 0);
        const maxStock  = Number(it.MaxInventory || 0);
        const available = onHand - committed;
        // Open PO quantity counts toward supply, so an item whose shortfall is already
        // covered by a posted PO is not suggested again.
        const projected = available + onOrder;
        if (projected >= minStock) return null;
        const gap        = minStock - projected;
        const reorderQty = Math.max(1, maxStock > 0 ? maxStock - projected : gap * 2);
        const urgency    = available <= 0 ? 'critical' : gap / minStock >= 0.7 ? 'high' : 'medium';
        const explain    = mrpExplain({ onHand, committed, available, onOrder, minStock, maxStock, projected, gap, reorderQty, urgency });
        return {
          itemCode: it.ItemCode, itemName: it.ItemName,
          onHand, committed, available, onOrder, minStock, maxStock, gap, reorderQty, urgency, explain,
          leadTime: Number(it.LeadTime || 7),
          uom: it.InventoryUOM || it.InventoryUoM || 'EA',
          preferredVendor: it.Mainsupplier || null,
          lastPurchasePrice: 0, // fetched per-item in ai-analyze step
        };
      }).filter(Boolean);

      // Flag items already sitting in an open (unposted) draft PO
      const inDraft = draftRepo.openItemCodes(mrpCompanyId());
      for (const it of items) it.draftId = inDraft.get(it.itemCode) || null;

      const summary = {
        total: items.length,
        critical: items.filter(i => i.urgency === 'critical').length,
        high:     items.filter(i => i.urgency === 'high').length,
        medium:   items.filter(i => i.urgency === 'medium').length,
      };
      mrpLog('MRP_RUN', { itemsFound: items.length, source, ...summary });
      res.json({ ok: true, items, summary, source, scannedAt: new Date().toISOString() });
    } catch(e) {
      console.error('[MRP inventory-check]', e.message);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // 2. AI Analysis — reads OCRD (vendors), OCTG (payment terms), ITM1 pricing, enriches items
  router.post('/ai-analyze', requireAuth, async (req, res) => {
    try {
      const { items } = req.body;
      if (!Array.isArray(items) || !items.length) return res.status(400).json({ ok: false, error: 'items required' });
      const sap = getActiveSap();
      const esc = s => String(s).replace(/'/g, "''");
      const dbAvailable = isConnected();

      // Fetch vendors (OCRD) for all preferred vendors — DB Direct preferred, SL fallback
      const vendorCodes = [...new Set(items.filter(i => i.preferredVendor).map(i => i.preferredVendor))];
      const vendorMap = new Map();
      if (vendorCodes.length) {
        let rows = null;
        if (dbAvailable) {
          try { rows = await mrpFetchVendorsViaDB(vendorCodes); }
          catch (e) { mrpLog('MRP_DB_FALLBACK', { step: 'vendors', reason: e.message }); }
        }
        if (!rows) {
          try {
            const filter = vendorCodes.map(v => `CardCode eq '${esc(v)}'`).join(' or ');
            const vd = await sap.get("/BusinessPartners", {
              $filter: filter,
              $select: "CardCode,CardName,EmailAddress,Currency,PaymentGroupCode,Phone1,City,Country",
              $top: 200,
            });
            rows = vd.value || [];
          } catch { rows = []; /* non-fatal */ }
        }
        for (const v of rows) vendorMap.set(v.CardCode, v);
      }

      // Fetch payment terms (OCTG) — DB Direct preferred, SL fallback
      const ptMap = new Map();
      {
        let rows = null;
        if (dbAvailable) {
          try { rows = await mrpFetchPaymentTermsViaDB(); }
          catch (e) { mrpLog('MRP_DB_FALLBACK', { step: 'paymentTerms', reason: e.message }); }
        }
        if (!rows) {
          try {
            const pts = await sap.get("/PaymentTermsTypes", {
              $select: "GroupNumber,PaymentTermsGroupName,ExtraMonth,ExtraDays,CashDiscountPercent",
              $top: 100,
            });
            rows = pts.value || [];
          } catch { rows = []; /* non-fatal */ }
        }
        for (const pt of rows) ptMap.set(pt.GroupNumber, pt);
      }

      // Fetch last purchase prices + buy UoM per item (ITM1/OITM) — DB Direct preferred, SL fallback
      const priceMap = new Map();
      {
        const itemCodes = items.map(i => i.itemCode);
        let rows = null;
        if (dbAvailable) {
          try { rows = await mrpFetchPricesViaDB(itemCodes); }
          catch (e) { mrpLog('MRP_DB_FALLBACK', { step: 'prices', reason: e.message }); }
        }
        if (!rows) {
          rows = [];
          try {
            // Batch in chunks of 50 to stay within URL length limits
            for (let i = 0; i < itemCodes.length; i += 50) {
              const chunk = itemCodes.slice(i, i + 50);
              const filter = chunk.map(c => `ItemCode eq '${esc(c)}'`).join(' or ');
              const pd = await sap.get("/Items", {
                $filter: filter,
                $select: "ItemCode,LastPurchasePrice,BuyUnitMsr,InventoryUoM",
                $top: 50,
              });
              rows.push(...(pd.value || []));
            }
          } catch { /* non-fatal — prices will default to 0 */ }
        }
        for (const it of rows) priceMap.set(it.ItemCode, it);
      }

      const enriched = items.map(item => {
        const vendor    = vendorMap.get(item.preferredVendor) || null;
        const pt        = vendor ? ptMap.get(vendor.PaymentGroupCode) : null;
        const priceInfo = priceMap.get(item.itemCode);
        const unitPrice = Number(priceInfo?.LastPurchasePrice || item.lastPurchasePrice || 0);
        const uom       = priceInfo?.BuyUnitMsr || priceInfo?.InventoryUoM || item.uom || 'EA';
        return {
          ...item,
          uom,
          vendorName:       vendor?.CardName || null,
          vendorEmail:      vendor?.EmailAddress || null,
          vendorPhone:      vendor?.Phone1 || null,
          vendorCurrency:   vendor?.Currency || 'GBP',
          vendorCity:       vendor?.City || null,
          paymentTerms:     pt?.PaymentTermsGroupName || null,
          paymentGroupCode: vendor?.PaymentGroupCode ?? null,
          unitPrice,
          lineTotal:        unitPrice * item.reorderQty,
        };
      });

      mrpLog('AI_ANALYSIS', { enrichedCount: enriched.length, vendorCount: vendorMap.size });
      res.json({
        ok: true,
        enrichedItems: enriched,
        noVendorItems: enriched.filter(i => !i.preferredVendor),
        vendorCount:   vendorMap.size,
        analyzedAt:    new Date().toISOString(),
      });
    } catch(e) {
      console.error('[MRP ai-analyze]', e.message);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // 3. Build Draft POs — group selected items by vendor and persist them (no SAP write yet).
  // Items merge into an existing open draft for the same vendor. Items with no preferred
  // vendor go into an "unassigned" draft where the user picks the vendor before posting.
  router.post('/build-draft-pos', requireAuth, async (req, res) => {
    try {
      const { items } = req.body;
      if (!Array.isArray(items) || !items.length) return res.status(400).json({ ok: false, error: 'items required' });
      const cid   = mrpCompanyId();
      const today = new Date();
      const todayStr = today.toISOString().slice(0, 10);

      const byVendor = new Map();
      const noVendorItems = [];
      for (const item of items) {
        const vc = item.preferredVendor || null;
        if (!vc) noVendorItems.push(item);
        if (!byVendor.has(vc)) byVendor.set(vc, []);
        byVendor.get(vc).push(item);
      }

      const suggestDate = lines => {
        const maxLead = lines.reduce((m, l) => Math.max(m, l.leadTime || 7), 7);
        return new Date(today.getTime() + maxLead * 86400000).toISOString().slice(0, 10);
      };
      const toLine = l => ({
        itemCode:  l.itemCode, itemName: l.itemName,
        qty:       l.reorderQty, uom: l.uom,
        unitPrice: l.unitPrice || 0,
        lineTotal: (l.unitPrice || 0) * l.reorderQty,
        urgency:   l.urgency,
        leadTime:  l.leadTime || 7,
      });

      const touched = [];
      for (const [vendorCode, lines] of byVendor.entries()) {
        let draft = draftRepo.openForVendor(cid, vendorCode);
        if (draft) {
          const codes = new Set(lines.map(l => l.itemCode));
          draft.lines = [...draft.lines.filter(l => !codes.has(l.itemCode)), ...lines.map(toLine)];
          draft.deliveryDate = suggestDate(draft.lines);
        } else {
          draft = {
            id:               `mrp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            vendorCode,
            vendorName:       vendorCode ? (lines[0].vendorName || vendorCode) : null,
            vendorEmail:      lines[0].vendorEmail || null,
            vendorCurrency:   lines[0].vendorCurrency || 'GBP',
            paymentGroupCode: lines[0].paymentGroupCode ?? null,
            paymentTerms:     lines[0].paymentTerms || null,
            orderDate:        todayStr,
            deliveryDate:     suggestDate(lines),
            status:           'draft',
            lines:            lines.map(toLine),
          };
        }
        recalcDraft(draft);
        draftRepo.save(cid, draft, req.user?.username);
        touched.push(draft.id);
      }

      mrpLog('DRAFT_POS_BUILT', { count: touched.length, items: items.length, noVendor: noVendorItems.length });
      res.json({ ok: true, draftPOs: draftRepo.list(cid), touched, noVendorItems, generatedAt: today.toISOString() });
    } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // 3b. Saved draft POs — list / update (vendor, qty, price, delivery date) / discard
  router.get('/drafts', requireAuth, (req, res) => {
    try { res.json({ ok: true, draftPOs: draftRepo.list(mrpCompanyId()) }); }
    catch(e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  router.put('/drafts/:id', requireAuth, async (req, res) => {
    try {
      const cid = mrpCompanyId();
      const draft = draftRepo.get(cid, req.params.id);
      if (!draft) return res.status(404).json({ ok: false, error: 'Draft not found' });
      if (draft.status !== 'draft') return res.status(400).json({ ok: false, error: 'Draft already posted' });
      const { vendorCode, lines, deliveryDate } = req.body || {};

      if (Array.isArray(lines)) {
        const upd = new Map(lines.map(l => [l.itemCode, l]));
        draft.lines = draft.lines
          .filter(l => upd.has(l.itemCode))
          .map(l => {
            const u = upd.get(l.itemCode);
            return { ...l,
              qty:       u.qty != null ? Math.max(0, Number(u.qty)) : l.qty,
              unitPrice: u.unitPrice != null ? Math.max(0, Number(u.unitPrice)) : l.unitPrice };
          });
        if (!draft.lines.length) {
          draftRepo.remove(cid, draft.id);
          mrpLog('DRAFT_DISCARDED', { draftId: draft.id, reason: 'all lines removed' });
          return res.json({ ok: true, removed: true, draftPOs: draftRepo.list(cid) });
        }
      }
      if (deliveryDate) draft.deliveryDate = String(deliveryDate).slice(0, 10);

      if (vendorCode && vendorCode !== draft.vendorCode) {
        const v = await mrpLookupVendor(getActiveSap(), vendorCode);
        const other = draftRepo.openForVendor(cid, v.vendorCode);
        if (other && other.id !== draft.id) {
          // Vendor already has an open draft — merge this one into it
          const codes = new Set(draft.lines.map(l => l.itemCode));
          other.lines = [...other.lines.filter(l => !codes.has(l.itemCode)), ...draft.lines];
          draftRepo.save(cid, recalcDraft(other), req.user?.username);
          draftRepo.remove(cid, draft.id);
          mrpLog('DRAFT_VENDOR_SET', { draftId: other.id, vendorCode: v.vendorCode, merged: true });
          return res.json({ ok: true, mergedInto: other.id, draftPOs: draftRepo.list(cid) });
        }
        Object.assign(draft, v);
        mrpLog('DRAFT_VENDOR_SET', { draftId: draft.id, vendorCode: v.vendorCode });
      }

      draftRepo.save(cid, recalcDraft(draft), req.user?.username);
      res.json({ ok: true, draft, draftPOs: draftRepo.list(cid) });
    } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  router.delete('/drafts/:id', requireAuth, (req, res) => {
    try {
      const cid = mrpCompanyId();
      if (!draftRepo.remove(cid, req.params.id)) return res.status(404).json({ ok: false, error: 'Draft not found or already posted' });
      mrpLog('DRAFT_DISCARDED', { draftId: req.params.id });
      res.json({ ok: true, draftPOs: draftRepo.list(cid) });
    } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // Vendor search for assigning a vendor to a draft — local BP cache first, SL fallback
  router.get('/vendors', requireAuth, async (req, res) => {
    try {
      const q = String(req.query.q || '').trim();
      let rows = [];
      try {
        rows = db.prepare(`SELECT CardCode, CardName FROM cache_business_partners
            WHERE company_id=? AND CardType='cSupplier' AND (CardCode LIKE ? OR CardName LIKE ?)
            ORDER BY CardName LIMIT 30`).all(mrpCompanyId(), `%${q}%`, `%${q}%`);
      } catch {}
      if (!rows.length) {
        const esc = s => s.replace(/'/g, "''");
        const filter = "CardType eq 'cSupplier'" + (q ? ` and (contains(CardCode,'${esc(q)}') or contains(CardName,'${esc(q)}'))` : '');
        const r = await getActiveSap().get('/BusinessPartners', { $filter: filter, $select: 'CardCode,CardName', $orderby: 'CardName', $top: 30 });
        rows = r.value || [];
      }
      res.json({ ok: true, vendors: rows.map(v => ({ code: v.CardCode, name: v.CardName })) });
    } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // 4. Post PO to SAP B1 — triggers approval workflow automatically
  // Always via Service Layer: DB Direct (executeSQL) is SELECT-only by design, so writes
  // (PO creation) cannot go through ODBC/HANA regardless of which source read the data.
  // Posts the saved draft (by draftId) so edits made in the Draft POs tab are what goes to SAP.
  router.post('/post-po', requireAuth, async (req, res) => {
    try {
      const cid = mrpCompanyId();
      const { draftId } = req.body;
      const draftPO = draftId ? draftRepo.get(cid, draftId) : req.body.draftPO;
      if (!draftPO) return res.status(400).json({ ok: false, error: 'draftId required' });
      if (draftPO.status === 'posted') return res.status(400).json({ ok: false, error: `Already posted as PO #${draftPO.docNum}` });
      if (!draftPO.vendorCode) return res.status(400).json({ ok: false, error: 'Assign a vendor before posting' });
      const lines = (draftPO.lines || []).filter(l => Number(l.qty) > 0);
      if (!lines.length) return res.status(400).json({ ok: false, error: 'No lines with quantity > 0' });
      const sap = getActiveSap();
      const today = new Date().toISOString().slice(0, 10);
      // A draft saved on an earlier day posts with today's date
      const docDate = draftPO.orderDate && draftPO.orderDate > today ? draftPO.orderDate : today;
      const dueDate = draftPO.deliveryDate && draftPO.deliveryDate >= docDate ? draftPO.deliveryDate : docDate;

      const body = {
        CardCode:    draftPO.vendorCode,
        DocDate:     docDate,
        DocDueDate:  dueDate,
        Comments:    `MRP Auto-PO — AI Procurement Agent — ${today}`,
        ...(draftPO.paymentGroupCode != null ? { PaymentGroupCode: draftPO.paymentGroupCode } : {}),
        DocumentLines: lines.map(l => ({
          ItemCode:  l.itemCode,
          Quantity:  Number(l.qty),
          UnitPrice: Number(l.unitPrice || 0),
          UoMCode:   l.uom || undefined,
        })),
      };

      const po = await sap.post('/PurchaseOrders', body);
      if (draftId) draftRepo.markPosted(cid, draftId, po.DocNum, po.DocEntry);
      const entry = mrpLog('PO_POSTED', {
        docNum: po.DocNum, docEntry: po.DocEntry,
        vendorCode: draftPO.vendorCode, vendorName: draftPO.vendorName,
        totalAmount: draftPO.totalAmount,
      });

      // Sync stock for the posted items (on-order qty now includes this PO)
      let stock = [], stockSyncError = null;
      try {
        stock = await mrpSyncItemStock(sap, lines.map(l => l.itemCode));
        mrpLog('STOCK_SYNCED', { docNum: po.DocNum, items: stock.length });
      } catch (e) {
        stockSyncError = e.message;
        mrpLog('STOCK_SYNC_ERROR', { docNum: po.DocNum, error: e.message });
      }

      res.json({ ok: true, docNum: po.DocNum, docEntry: po.DocEntry, docStatus: po.DocumentStatus || 'bost_Open', logEntry: entry,
        stock, stockSyncError, draftPOs: draftRepo.list(cid) });
    } catch(e) {
      mrpLog('PO_POST_ERROR', { error: e.message, draftId: req.body?.draftId, vendorCode: req.body?.draftPO?.vendorCode });
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // 5. SAP Approval Status — checks ApprovalRequests
  router.get('/approval-status', requireAuth, async (req, res) => {
    try {
      const sap = getActiveSap();
      const r = await sap.get("/ApprovalRequests", {
        $filter: "Status eq 'arpd_Pending'",
        $select: "Code,ObjectType,ObjectEntry,Status,Remarks,ApprovalTemplatesID,CreationDate",
        $orderby: "CreationDate desc",
        $top: 50,
      });
      const requests = (r.value || []).map(ar => ({
        code:        ar.Code,
        objectType:  ar.ObjectType,
        objectEntry: ar.ObjectEntry,
        status:      ar.Status,
        remarks:     ar.Remarks,
        templateId:  ar.ApprovalTemplatesID,
        creationDate: ar.CreationDate?.slice(0, 10),
      }));
      res.json({ ok: true, requests, total: requests.length });
    } catch(e) {
      res.json({ ok: true, requests: [], total: 0, note: e.message });
    }
  });

  // 6. Get posted PO data (for PDF preview)
  router.get('/po-data/:docEntry', requireAuth, async (req, res) => {
    try {
      const sap = getActiveSap();
      const po  = await sap.get(`/PurchaseOrders(${req.params.docEntry})`, { $expand: "DocumentLines" });
      res.json({ ok: true, po });
    } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // 7. Email vendor — sends PO details as formatted HTML email
  router.post('/email-vendor', requireAuth, async (req, res) => {
    try {
      const { vendorEmail, vendorName, docNum, lines = [], totalAmount = 0, currency = '' } = req.body;
      if (!vendorEmail) return res.status(400).json({ ok: false, error: 'vendorEmail required' });

      const smtpHost = process.env.MAIL_SMTP_HOST;
      const smtpPort = parseInt(process.env.MAIL_SMTP_PORT || '587');
      const mailUser = process.env.MAIL_USER;
      const mailPass = process.env.MAIL_PASS;
      if (!smtpHost || !mailUser) return res.status(400).json({ ok: false, error: 'SMTP not configured — set it in Mail PO → Settings' });

      const fmt = n => Number(n || 0).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      const linesHtml = lines.map((l, i) => `
        <tr style="background:${i % 2 ? '#f9f9f9' : '#fff'}">
          <td style="padding:7px 10px;border-bottom:1px solid #eee">${l.itemCode || ''}</td>
          <td style="padding:7px 10px;border-bottom:1px solid #eee">${l.itemName || l.itemDescription || ''}</td>
          <td style="padding:7px 10px;border-bottom:1px solid #eee;text-align:right">${fmt(l.qty || l.quantity)}</td>
          <td style="padding:7px 10px;border-bottom:1px solid #eee;text-align:right">${fmt(l.unitPrice)}</td>
          <td style="padding:7px 10px;border-bottom:1px solid #eee;text-align:right;font-weight:600">${fmt(l.lineTotal || (l.qty || 0) * (l.unitPrice || 0))}</td>
        </tr>`).join('');

      const html = `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;max-width:700px;margin:0 auto;color:#333;padding:20px">
<div style="background:linear-gradient(135deg,#1a3a5c,#2563eb);padding:22px 28px;border-radius:6px 6px 0 0">
  <h2 style="color:#fff;margin:0;font-size:22px">Purchase Order #${docNum}</h2>
  <p style="color:rgba(255,255,255,.75);margin:5px 0 0;font-size:13px">AI-Generated by MRP Auto-PO Agent · SAP Business One</p>
</div>
<div style="background:#fff;border:1px solid #ddd;border-top:none;padding:24px 28px;border-radius:0 0 6px 6px">
  <p style="font-size:14px">Dear <strong>${vendorName}</strong>,</p>
  <p style="font-size:13px;color:#555">Please find below our Purchase Order <strong>#${docNum}</strong> generated automatically by our MRP system. Kindly confirm receipt and advise expected delivery date.</p>
  <table style="width:100%;border-collapse:collapse;margin:18px 0;font-size:13px">
    <thead><tr style="background:#1a3a5c;color:#fff">
      <th style="padding:9px 10px;text-align:left">Item Code</th>
      <th style="padding:9px 10px;text-align:left">Description</th>
      <th style="padding:9px 10px;text-align:right">Qty</th>
      <th style="padding:9px 10px;text-align:right">Unit Price</th>
      <th style="padding:9px 10px;text-align:right">Line Total</th>
    </tr></thead>
    <tbody>${linesHtml}</tbody>
    <tfoot><tr style="background:#EEF2FF">
      <td colspan="4" style="padding:9px 10px;font-weight:700;text-align:right;font-size:14px">Total ${currency}:</td>
      <td style="padding:9px 10px;font-weight:700;text-align:right;font-size:14px">${fmt(totalAmount)}</td>
    </tr></tfoot>
  </table>
  <p style="font-size:12px;color:#888;margin-top:24px;border-top:1px solid #eee;padding-top:14px">This email was automatically generated by the AI-Driven Auto Purchase Order System (MRP Agent) integrated with SAP Business One.</p>
</div></body></html>`;

      const transporter = nodemailer.createTransport({
        host: smtpHost, port: smtpPort,
        secure: smtpPort === 465,
        auth: { user: mailUser, pass: mailPass },
        tls: { rejectUnauthorized: false },
      });
      await transporter.sendMail({
        from: mailUser,
        to:   vendorEmail,
        subject: `Purchase Order #${docNum} — Please Confirm`,
        html,
      });

      mrpLog('EMAIL_SENT', { vendorEmail, vendorName, docNum });
      res.json({ ok: true, message: `PO #${docNum} emailed to ${vendorEmail}` });
    } catch(e) {
      mrpLog('EMAIL_ERROR', { error: e.message, docNum: req.body?.docNum });
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // 8. Audit Log
  router.get('/audit-log', requireAuth, (req, res) => {
    res.json({ ok: true, logs: _mrpAuditLog.slice(0, 100) });
  });

  // 9. MRP AI Chat
  router.post('/chat', requireAuth, async (req, res) => {
    try {
      const { message, sessionId = `mrp_${Date.now()}` } = req.body;
      if (!message?.trim()) return res.status(400).json({ ok: false, error: 'message required' });
      const sap = getActiveSap();
      const today = new Date().toISOString().slice(0, 10);

      if (!_mrpSessions.has(sessionId)) _mrpSessions.set(sessionId, []);
      const history = _mrpSessions.get(sessionId);
      history.push({ role:"user", content: message });
      if (history.length > 20) history.splice(0, history.length - 20);

      const systemPrompt = `You are an MRP Auto-PO AI Agent for SAP Business One. You automate the full purchase order lifecycle:
1. MRP Run → scan inventory vs reorder points (OITM)
2. Threshold Check → identify items below min stock
3. AI Analysis → read vendor (OCRD), pricing (ITM1), payment terms (OCTG)
4. Draft PO → items grouped by preferred vendor
5. Post to SAP → triggers approval workflow
6. Approval → manager reviews in SAP
7. Auto-Convert → PO posted after approval
8. Email Vendor → send PO confirmation

Today is ${today}. Always call tools first. Be concise and action-oriented. When listing items needing reorder, show urgency, gap, and estimated cost.`;

      const messages = [{ role:"system", content: systemPrompt }, ...history];
      let response = null;
      for (let i = 0; i < 10; i++) {
        const body = { messages, tools: MRP_GPT_TOOLS, tool_choice:"auto", max_tokens:1500, temperature:0.2 };
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
            try { result = await executeMrpTool(tc.function.name, args, sap); }
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
    } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  return router;
}
