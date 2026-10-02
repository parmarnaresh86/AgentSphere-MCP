/**
 * Inventory Workflow Agent — one conversational agent covering five SAP B1
 * inventory transactions (a "mode" per transaction):
 *
 *   str     Stock Transfer Request        → POST /InventoryTransferRequests
 *   st_req  Stock Transfer from Request   → POST /StockTransfers (lines based on an open request)
 *   st      Stock Transfer (direct)       → POST /StockTransfers
 *   gi      Goods Issue                   → POST /InventoryGenExits
 *   gr      Goods Receipt                 → POST /InventoryGenEntries
 *
 * Flow per mode:
 *   HEADER (warehouses) ─┐                     ┌─ REVIEW (dates/remarks) → post → DONE
 *                        └─ ADD_ITEM (lines) ──┘
 *   st_req instead goes SELECT_REQUEST → REQ_LINES (pick open qty per line) → REVIEW.
 *
 * UI pattern mirrors po-agent.mjs: the server renders the combo forms as HTML
 * wired to inline onclick handlers (inva* functions in public/index.html).
 * Lines can also be typed in the chat ("10 A00001, 5 A00002") — parsed
 * rule-based first, AI only as a fallback when it's configured.
 *
 * Unlike most agents, access is enforced here as well as in the sidebar: every
 * request is checked against the mode's permission key (INV_MODES[mode].perm),
 * because these endpoints post stock-moving documents.
 */
import { Router } from 'express';
import db, { connRepo, userPermRepo } from '../db.mjs';
import { callAI } from '../lib/insight-kit.mjs';
import { batchSerialRoute } from '../lib/copy-doc-flow.mjs';

export const INV_MODES = {
  str:    { label: 'Stock Transfer Request',      docName: 'Stock Transfer Request', perm: 'inventory.workflow.transfer_request',      endpoint: '/InventoryTransferRequests', kind: 'transfer', consumesStock: false, icon: '📝' },
  st_req: { label: 'Stock Transfer from Request', docName: 'Stock Transfer',         perm: 'inventory.workflow.transfer_from_request', endpoint: '/StockTransfers',            kind: 'transfer', consumesStock: true,  icon: '🔁' },
  st:     { label: 'Stock Transfer (Direct)',     docName: 'Stock Transfer',         perm: 'inventory.workflow.transfer_direct',       endpoint: '/StockTransfers',            kind: 'transfer', consumesStock: true,  icon: '🚚' },
  gi:     { label: 'Goods Issue',                 docName: 'Goods Issue',            perm: 'inventory.workflow.goods_issue',           endpoint: '/InventoryGenExits',         kind: 'issue',    consumesStock: true,  icon: '📤' },
  gr:     { label: 'Goods Receipt',               docName: 'Goods Receipt',          perm: 'inventory.workflow.goods_receipt',         endpoint: '/InventoryGenEntries',       kind: 'receipt',  consumesStock: false, icon: '📥' },
};

// SAP object type of an Inventory Transfer Request, used as BaseType on stock transfer lines
const ITR_OBJECT_TYPE = 1250000001;

// SAP S/4HANA Fiori palette (same as the Sales / Purchase agents; was teal)
const COLOR  = '#0a6ed1';
const BG     = '#f5f9fd';
const BORDER = '#b0d5f5';

const _sessions = new Map();
const SESSION_TTL_MS = 4 * 3600 * 1000;

function purgeStaleSessions() {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const [sid, s] of _sessions) if (s.touchedAt < cutoff) _sessions.delete(sid);
}

function initSession(mode, userId) {
  return {
    mode, userId,
    step:    mode === 'st_req' ? 'SELECT_REQUEST' : 'HEADER',
    header:  {},     // { fromWh, toWh } for transfers, { wh } for issue/receipt
    lines:   [],
    lineIdx: 0,
    request: null,   // st_req: { docEntry, docNum, fromWh, toWh, lines[] }
    result:  null,
    posting: false,  // true while a POST to SAP is in flight — blocks double-clicks
    touchedAt: Date.now(),
  };
}

function today() { return new Date().toISOString().slice(0, 10); }
function datePlusDays(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}
function sapDate(s) { const d = s || today(); return d.length === 10 ? `${d}T00:00:00` : d; }
function escHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function escOData(s) { return String(s || '').replace(/'/g, "''"); }
function fmtQty(n) { return Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 3 }); }

// "SAP 400: {"error":{"message":{"value":"..."}}}" → the human-readable part
function sapErrorText(e) {
  const m = String(e?.message || e);
  const json = m.replace(/^SAP \d+:\s*/, '');
  try {
    const j = JSON.parse(json);
    return j?.error?.message?.value || j?.error?.message || m;
  } catch { return m; }
}

// ── Permissions ────────────────────────────────────────────────────────────────

function allowedModes(user) {
  if (!user) return [];
  const perms = new Set(userPermRepo.getEffective(user.user_id, user.role));
  return Object.keys(INV_MODES).filter(m => perms.has(INV_MODES[m].perm));
}

// ── Cache helpers ──────────────────────────────────────────────────────────────

function getCompanyId() {
  const conn = connRepo.getActive();
  return conn ? conn.company : 'default';
}

function getCacheItems() {
  return db.prepare(`SELECT ItemCode, ItemName, InventoryUoM, ManageBatchNumbers, ManageSerialNumbers, QuantityOnStock
    FROM cache_items WHERE company_id=? AND Frozen='tNO' ORDER BY ItemName LIMIT 500`).all(getCompanyId());
}

function getCacheWarehouses() {
  return db.prepare(`SELECT WarehouseCode, WarehouseName FROM cache_warehouses
    WHERE company_id=? AND Inactive='tNO' ORDER BY WarehouseCode`).all(getCompanyId());
}

// ── SAP helpers ────────────────────────────────────────────────────────────────

// Item flags + per-warehouse stock, always live — stock figures must be current
// at the moment a line is added, the cache can be hours old.
async function getItemInfo(sap, itemCode) {
  const it = await sap.get(`/Items('${escOData(itemCode)}')`, {
    $select: 'ItemCode,ItemName,InventoryUOM,ManageBatchNumbers,ManageSerialNumbers,InventoryItem,Frozen,ItemWarehouseInfoCollection',
  });
  const stock = {};
  for (const w of it.ItemWarehouseInfoCollection || []) {
    stock[w.WarehouseCode] = { inStock: Number(w.InStock || 0), committed: Number(w.Committed || 0), ordered: Number(w.Ordered || 0) };
  }
  return {
    itemCode:  it.ItemCode,
    itemName:  it.ItemName,
    uom:       it.InventoryUOM || '',
    batch:     it.ManageBatchNumbers  === 'tYES',
    serial:    it.ManageSerialNumbers === 'tYES',
    inventory: it.InventoryItem !== 'tNO',
    frozen:    it.Frozen === 'tYES',
    stock,
  };
}

async function listOpenTransferRequests(sap, docNum) {
  const byNum = docNum ? `DocNum eq ${Number(docNum)}` : '';
  const query = filter => sap.get('/InventoryTransferRequests', {
    ...(filter ? { $filter: filter } : {}),
    $select:  'DocEntry,DocNum,DocDate,DueDate,FromWarehouse,ToWarehouse,Comments',
    $orderby: 'DocEntry desc',
    $top:     50,
  });
  let r;
  try {
    r = await query([`DocumentStatus eq 'bost_Open'`, byNum].filter(Boolean).join(' and '));
  } catch (e) {
    // Older Service Layer builds don't expose DocumentStatus here — list without it;
    // selecting a closed request is still refused in 'select_request'
    if (!/documentstatus/i.test(sapErrorText(e))) throw e;
    r = await query(byNum);
  }
  return Array.isArray(r.value) ? r.value : [];
}

// Retries once for two known Service Layer quirks rather than failing the user:
//  - items without UoM groups reject an explicit UoMCode
//  - some SL versions only accept BaseType as the numeric object type
async function postWithFallbacks(sap, endpoint, payload, linesKey) {
  try {
    return await sap.post(endpoint, payload);
  } catch (e) {
    const msg = sapErrorText(e);
    const lines = payload[linesKey] || [];
    if (/uom|unit of measure/i.test(msg) && lines.some(l => l.UoMCode)) {
      return sap.post(endpoint, { ...payload, [linesKey]: lines.map(({ UoMCode, ...l }) => l) });
    }
    if (/basetype|enum/i.test(msg) && lines.some(l => l.BaseType)) {
      return sap.post(endpoint, { ...payload, [linesKey]: lines.map(l => ({ ...l, BaseType: ITR_OBJECT_TYPE })) });
    }
    throw e;
  }
}

// ── Line validation (shared by the combo form and typed/AI-parsed lines) ──────

function lineSourceWh(mode, line) { return INV_MODES[mode].kind === 'transfer' ? line.fromWh : line.wh; }

// Quantity of this item already taken from `wh` by lines in the session
function qtyAlreadyTaken(session, itemCode, wh, exceptIdx = -1) {
  return session.lines.reduce((s, l, i) =>
    (i !== exceptIdx && l.itemCode === itemCode && lineSourceWh(session.mode, l) === wh) ? s + Number(l.quantity) : s, 0);
}

async function buildLine(session, sap, raw) {
  const mode = session.mode;
  const cfg  = INV_MODES[mode];
  const itemCode = String(raw.itemCode || '').trim();
  const quantity = Number(raw.quantity);
  if (!itemCode) return { error: 'Please select an item.' };
  if (!(quantity > 0)) return { error: `Quantity for <strong>${escHtml(itemCode)}</strong> must be greater than 0.` };

  let info;
  try { info = await getItemInfo(sap, itemCode); }
  catch (e) { return { error: `Item <strong>${escHtml(itemCode)}</strong> not found in SAP (${escHtml(sapErrorText(e))}).` }; }
  if (!info.inventory) return { error: `<strong>${escHtml(itemCode)}</strong> is not an inventory item — it can't be moved in stock.` };
  if (info.frozen)     return { error: `<strong>${escHtml(itemCode)}</strong> is inactive/frozen in SAP.` };

  // Batch/serial-managed items consumed from stock (transfer/issue) must be picked
  // from the actual warehouse stock (see /batch-serials) — a typed number can't be
  // trusted to exist there. Goods Receipt creates new batches, so the user types
  // one or more Batch Nos. (with qty) instead; serial creation on receipt is still
  // out of scope for this form.
  let batches = [];
  let serials = [];
  if (info.serial && mode !== 'str') {
    if (mode === 'gr') return { error: `<strong>${escHtml(itemCode)}</strong> is serial-managed. Serial numbers must be allocated in the SAP client for this transaction.` };
    serials = Array.isArray(raw.serials) ? raw.serials.filter(s => s && s.serial) : [];
    if (!serials.length) return { error: `<strong>${escHtml(itemCode)}</strong> is serial-managed — use the <strong>Select…</strong> button to pick serial numbers for this line.` };
    if (!Number.isInteger(quantity) || serials.length !== quantity)
      return { error: `Select exactly ${fmtQty(quantity)} serial number(s) for <strong>${escHtml(itemCode)}</strong> (selected ${serials.length}).` };
  }
  if (info.batch && mode !== 'str') {
    if (mode === 'gr') {
      const isDate = d => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ''));
      batches = (Array.isArray(raw.batches) ? raw.batches : raw.batch ? [{ batch: raw.batch, qty: quantity }] : [])
        .map(b => ({
          batch: String(b?.batch || '').trim(), qty: Number(b?.qty),
          ...(isDate(b?.expiry) ? { expiry: b.expiry } : {}),
          ...(isDate(b?.mfg)    ? { mfg: b.mfg }       : {}),
        }))
        .filter(b => b.batch && b.qty > 0);
      if (!batches.length) return { error: `<strong>${escHtml(itemCode)}</strong> is batch-managed — use the <strong>Add Batches…</strong> button to enter batch numbers for this line.` };
      const names = batches.map(b => b.batch.toLowerCase());
      if (new Set(names).size !== names.length) return { error: `Duplicate batch number entered for <strong>${escHtml(itemCode)}</strong>.` };
      const total = batches.reduce((s, b) => s + b.qty, 0);
      if (Math.abs(total - quantity) > 1e-6)
        return { error: `Batch quantity (${fmtQty(total)}) does not match line quantity (${fmtQty(quantity)}) for <strong>${escHtml(itemCode)}</strong>.` };
    } else {
      batches = Array.isArray(raw.batches) ? raw.batches.filter(b => b && b.batch && Number(b.qty) > 0) : [];
      if (!batches.length) return { error: `<strong>${escHtml(itemCode)}</strong> is batch-managed — use the <strong>Select…</strong> button to pick batches for this line.` };
      const total = batches.reduce((s, b) => s + Number(b.qty), 0);
      if (Math.abs(total - quantity) > 1e-6)
        return { error: `Selected batch quantity (${fmtQty(total)}) does not match line quantity (${fmtQty(quantity)}) for <strong>${escHtml(itemCode)}</strong>.` };
    }
  }

  const line = {
    itemCode: info.itemCode, itemName: info.itemName, uom: info.uom,
    quantity, batches, serials,
    isBatch: info.batch, isSerial: info.serial,
  };
  if (cfg.kind === 'transfer') {
    line.fromWh = raw.fromWh || session.header.fromWh;
    line.toWh   = raw.toWh   || session.header.toWh;
    if (!line.fromWh || !line.toWh) return { error: 'From and To warehouse are required.' };
    if (line.fromWh === line.toWh)  return { error: 'From and To warehouse cannot be the same.' };
  } else {
    line.wh = raw.wh || session.header.wh;
    if (!line.wh) return { error: 'Warehouse is required.' };
  }
  if (mode === 'gr' && raw.unitPrice !== undefined && raw.unitPrice !== '' && Number(raw.unitPrice) >= 0) {
    line.unitPrice = Number(raw.unitPrice);
  }
  if (raw.baseLine !== undefined) { line.baseLine = raw.baseLine; line.openQty = raw.openQty; }

  if (cfg.consumesStock) {
    const wh    = lineSourceWh(mode, line);
    const have  = info.stock[wh]?.inStock || 0;
    const taken = qtyAlreadyTaken(session, line.itemCode, wh);
    if (quantity + taken > have) {
      return { error: `Insufficient stock for <strong>${escHtml(itemCode)}</strong> in warehouse <strong>${escHtml(wh)}</strong> — available ${fmtQty(have - taken)} ${escHtml(info.uom)}, requested ${fmtQty(quantity)}.` };
    }
  }
  return { line };
}

// ── Natural-language line entry ────────────────────────────────────────────────

// Exact item-code lookup over the whole cache — the dropdown list is capped at
// 500, so typed codes must not depend on it
function findCachedItemCode(token) {
  const t = String(token || '').replace(/[()]/g, '');
  if (!t) return null;
  return db.prepare(`SELECT ItemCode FROM cache_items WHERE company_id=? AND ItemCode=? COLLATE NOCASE`).get(getCompanyId(), t)?.ItemCode || null;
}

// Cache entries whose code or name contains any of the words — the AI only
// sees these, not the whole catalog
function findCachedItemsByWords(words, limit = 60) {
  if (!words.length) return [];
  const where = words.map(() => `(ItemCode LIKE ? OR ItemName LIKE ?)`).join(' OR ');
  return db.prepare(`SELECT ItemCode, ItemName FROM cache_items WHERE company_id=? AND Frozen='tNO' AND (${where}) LIMIT ${limit}`)
    .all(getCompanyId(), ...words.flatMap(w => [`%${w}%`, `%${w}%`]));
}

// "10 A00001, 5 x A00002; A00003 7" → [{itemCode, quantity}]. Returns the chunks
// it could not resolve so the AI fallback only has to handle those.
function parseLinesRuleBased(text) {
  const found = [], unresolved = [];
  for (const chunk of text.split(/[,;\n]|\band\b/i).map(s => s.trim()).filter(Boolean)) {
    const tokens = chunk.split(/\s+/);
    const qtyTok = tokens.find(t => /^x?\d+(\.\d+)?$/i.test(t));
    const code = tokens.filter(t => t !== qtyTok).map(findCachedItemCode).find(Boolean);
    if (code && qtyTok) found.push({ itemCode: code, quantity: Number(qtyTok.replace(/^x/i, '')) });
    else unresolved.push(chunk);
  }
  return { found, unresolved };
}

async function parseLinesWithAI(aiDeps, text) {
  if (!aiDeps?.USE_AI) return [];
  const words = [...new Set(text.toLowerCase().split(/[^a-z0-9\-_.]+/).filter(w => w.length > 2))].slice(0, 8);
  const candidates = findCachedItemsByWords(words);
  if (!candidates.length) return [];
  const catalog = candidates.map(i => `${i.ItemCode} | ${i.ItemName}`).join('\n');
  const system = 'You extract inventory line items from a user message. Reply with ONLY a JSON array like '
    + '[{"itemCode":"A001","quantity":10}]. Use only item codes from the catalog. If nothing matches, reply [].';
  const raw = await callAI(aiDeps, [{ role: 'user', content: `Catalog (code | name):\n${catalog}\n\nMessage: ${text}` }], system, 400);
  try {
    const arr = JSON.parse(String(raw).match(/\[[\s\S]*\]/)?.[0] || '[]');
    const valid = new Set(candidates.map(i => i.ItemCode));
    return arr.filter(x => valid.has(x.itemCode) && Number(x.quantity) > 0)
      .map(x => ({ itemCode: x.itemCode, quantity: Number(x.quantity) }));
  } catch { return []; }
}

// "from 01 to 02", "wh 01", "in 01" → warehouse codes that exist in the cache
function parseWarehouses(text, warehouses) {
  const codes = new Map(warehouses.map(w => [w.WarehouseCode.toLowerCase(), w.WarehouseCode]));
  const pick = t => codes.get(String(t || '').toLowerCase());
  const ft = text.match(/from\s+(\S+)\s+to\s+(\S+)/i);
  if (ft) return { fromWh: pick(ft[1]), toWh: pick(ft[2]) };
  const one = text.match(/(?:warehouse|wh|in|at|into|from)\s+(\S+)/i);
  return { wh: pick(one?.[1]) || pick(text.trim()) };
}

// ── HTML builders ──────────────────────────────────────────────────────────────

const S = {
  card:   `background:${BG};border:1.5px solid ${COLOR};border-radius:8px;padding:14px;margin:6px 0`,
  title:  `font-size:12px;font-weight:700;color:${COLOR};margin-bottom:8px`,
  label:  'font-size:11px;color:#6b7280;margin-bottom:3px',
  input:  'width:100%;border:1.5px solid #d1d5db;border-radius:6px;padding:6px 8px;font-size:13px;box-sizing:border-box;background:#fff',
  btn:    `background:${COLOR};color:#fff;border:none;border-radius:6px;padding:8px 18px;font-size:13px;font-weight:700;cursor:pointer`,
  btn2:   'background:#f3f4f6;color:#374151;border:1px solid #d1d5db;border-radius:6px;padding:8px 14px;font-size:12.5px;cursor:pointer',
  th:     'padding:5px 8px;text-align:left;font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.03em',
  td:     'padding:5px 8px;font-size:12.5px;border-bottom:1px solid #e5e7eb',
  err:    'color:#b91c1c;margin-bottom:8px',
};

function whOptions(warehouses, selected, withBlank = '— Select —') {
  return [`<option value="">${withBlank}</option>`, ...warehouses.map(w =>
    `<option value="${escHtml(w.WarehouseCode)}"${w.WarehouseCode === selected ? ' selected' : ''}>${escHtml(w.WarehouseCode)}${w.WarehouseName ? ' — ' + escHtml(w.WarehouseName) : ''}</option>`)].join('');
}

function cacheWarning(what) {
  return `<div style="color:#ef4444;font-size:12px;margin-bottom:8px">⚠️ ${what} cache is empty — go to <strong>Tools → Data Sync</strong> to load master data.</div>`;
}

function buildHeaderHtml(mode, warehouses, header = {}) {
  const cfg = INV_MODES[mode];
  const warn = warehouses.length ? '' : cacheWarning('Warehouse');
  if (cfg.kind === 'transfer') {
    return `<div style="${S.card}">${warn}
      <div style="${S.title}">${cfg.icon} ${escHtml(cfg.label)} — Warehouses</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px">
        <div><div style="${S.label}">From Warehouse *</div>
          <select id="inva-h-from" style="${S.input}">${whOptions(warehouses, header.fromWh)}</select></div>
        <div><div style="${S.label}">To Warehouse *</div>
          <select id="inva-h-to" style="${S.input}">${whOptions(warehouses, header.toWh)}</select></div>
      </div>
      <button onclick="invaSubmitHeader()" style="${S.btn}">Continue →</button>
      <div style="font-size:11.5px;color:#6b7280;margin-top:8px">Or type e.g. <em>from 01 to 02</em> in the chat box.</div>
    </div>`;
  }
  return `<div style="${S.card}">${warn}
    <div style="${S.title}">${cfg.icon} ${escHtml(cfg.label)} — Warehouse</div>
    <div style="margin-bottom:10px"><div style="${S.label}">${mode === 'gi' ? 'Issue from' : 'Receive into'} Warehouse *</div>
      <select id="inva-h-wh" style="${S.input}">${whOptions(warehouses, header.wh)}</select></div>
    <button onclick="invaSubmitHeader()" style="${S.btn}">Continue →</button>
    <div style="font-size:11.5px;color:#6b7280;margin-top:8px">Or type the warehouse code in the chat box.</div>
  </div>`;
}

function buildLineHtml(session, items, warehouses) {
  const mode = session.mode;
  const cfg  = INV_MODES[mode];
  const idx  = session.lineIdx;
  const itemOpts = items.map(i =>
    `<option value="${escHtml(i.ItemCode)}" data-batch="${i.ManageBatchNumbers === 'tYES' ? 1 : 0}" data-serial="${i.ManageSerialNumbers === 'tYES' ? 1 : 0}">${escHtml(i.ItemCode)} — ${escHtml(i.ItemName)}</option>`).join('');
  const itemsJson = escHtml(JSON.stringify(items.map(i => ({ code: i.ItemCode, name: i.ItemName, batch: i.ManageBatchNumbers === 'tYES', serial: i.ManageSerialNumbers === 'tYES' }))));
  const h = session.header;

  const whFields = cfg.kind === 'transfer'
    ? `<div><div style="${S.label}">From WH</div><select id="inva-from-${idx}" style="${S.input}" onchange="invaShowAvail(${idx})">${whOptions(warehouses, h.fromWh, '— Header —')}</select></div>
       <div><div style="${S.label}">To WH</div><select id="inva-to-${idx}" style="${S.input}">${whOptions(warehouses, h.toWh, '— Header —')}</select></div>`
    : `<div><div style="${S.label}">Warehouse</div><select id="inva-wh-${idx}" style="${S.input}" onchange="invaShowAvail(${idx})">${whOptions(warehouses, h.wh, '— Header —')}</select></div>`;
  const priceField = mode === 'gr'
    ? `<div><div style="${S.label}">Unit Price</div><input type="number" id="inva-price-${idx}" placeholder="Item cost" min="0" step="0.01" style="${S.input}"></div>` : '';
  // Batch/serial-managed items consumed from stock (transfer/issue) are picked from
  // actual warehouse stock via a modal (invaPickBatchSerial); Goods Receipt creates
  // new stock, so its modal (invaEnterGrBatches) lets the user type several batches.
  const batchField = mode === 'str' ? '' : mode === 'gr'
    ? `<div><div style="${S.label}">Batches</div>
         <button type="button" onclick="invaEnterGrBatches(${idx})" style="${S.btn2};width:100%;text-align:left">📦 Add Batches…</button>
         <div id="inva-alloc-${idx}" style="font-size:10.5px;color:#9ca3af;margin-top:2px">Not required</div>
       </div>`
    : `<div><div style="${S.label}">Batch / Serial</div>
         <button type="button" onclick="invaPickBatchSerial(${idx})" style="${S.btn2};width:100%;text-align:left">📦 Select…</button>
         <div id="inva-alloc-${idx}" style="font-size:10.5px;color:#9ca3af;margin-top:2px">Not required</div>
       </div>`;
  const cols = 1 + (cfg.kind === 'transfer' ? 2 : 1) + (mode === 'gr' ? 1 : 0) + (mode === 'str' ? 0 : 1);

  return `<div style="${S.card}" data-items="${itemsJson}" data-mode="${mode}">
    ${items.length ? '' : cacheWarning('Item')}
    <div style="${S.title}">Add Line Item (${items.length} items available):</div>
    <div style="margin-bottom:8px">
      <div style="${S.label}">Item *</div>
      <input type="text" placeholder="🔍 Search item by name or code…" oninput="invaFilterItems(this,${idx})" style="${S.input};margin-bottom:6px">
      <select id="inva-item-${idx}" onchange="invaItemChange(${idx})" style="${S.input}">
        <option value="">— Select an Item —</option>${itemOpts}
      </select>
    </div>
    <div style="display:grid;grid-template-columns:90px repeat(${cols - 1},1fr);gap:8px;margin-bottom:8px">
      <div><div style="${S.label}">Qty *</div><input type="number" id="inva-qty-${idx}" value="1" min="0.001" step="0.001" style="${S.input}" oninput="invaQtyChange(${idx})"></div>
      ${whFields}${priceField}${batchField}
    </div>
    <div id="inva-avail-${idx}" style="font-size:12px;color:#374151;margin-bottom:10px;min-height:16px"></div>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <button onclick="invaAddItem(${idx})" style="${S.btn}">+ Add Line</button>
      <button onclick="invaSend(JSON.stringify({action:'done_items'}))" style="${S.btn2}">✓ Done Adding Items</button>
      <button onclick="invaSend(JSON.stringify({action:'change_header'}))" style="${S.btn2}">⇄ Change Warehouse</button>
    </div>
    <div style="font-size:11.5px;color:#6b7280;margin-top:8px">💡 You can also type lines in the chat, e.g. <em>10 A00001, 5 A00002</em></div>
  </div>`;
}

// A line's batches/serials joined for display, e.g. "B001 (5), B002 (3)" or "SN01, SN02"
function batchSerialDisplay(l) {
  if (l.batches?.length) return l.batches.map(b => `${b.batch} (${fmtQty(b.qty)})`).join(', ');
  if (l.serials?.length) return l.serials.map(s => s.serial).join(', ');
  return '';
}

function linesTableHtml(session, { removable = false } = {}) {
  const mode = session.mode;
  const cfg  = INV_MODES[mode];
  const whHead = cfg.kind === 'transfer' ? `<th style="${S.th}">From</th><th style="${S.th}">To</th>` : `<th style="${S.th}">WH</th>`;
  const rows = session.lines.map((l, i) => `<tr>
      <td style="${S.td}">${i + 1}</td>
      <td style="${S.td}"><strong>${escHtml(l.itemCode)}</strong><div style="font-size:11px;color:#6b7280">${escHtml(l.itemName || '')}</div></td>
      <td style="${S.td};text-align:right">${fmtQty(l.quantity)} ${escHtml(l.uom || '')}</td>
      ${cfg.kind === 'transfer' ? `<td style="${S.td}">${escHtml(l.fromWh)}</td><td style="${S.td}">${escHtml(l.toWh)}</td>` : `<td style="${S.td}">${escHtml(l.wh)}</td>`}
      ${mode === 'gr' ? `<td style="${S.td};text-align:right">${l.unitPrice !== undefined ? Number(l.unitPrice).toFixed(2) : '—'}</td>` : ''}
      ${mode === 'str' ? '' : `<td style="${S.td}">${escHtml(batchSerialDisplay(l) || '—')}</td>`}
      ${removable ? `<td style="${S.td}"><button onclick="invaSend(JSON.stringify({action:'remove_line',index:${i}}))" title="Remove line" style="background:none;border:none;color:#b91c1c;cursor:pointer;font-size:14px">✕</button></td>` : ''}
    </tr>`).join('');
  const total = session.lines.reduce((s, l) => s + Number(l.quantity || 0), 0);
  return `<table style="width:100%;border-collapse:collapse;background:#fff">
    <tr style="background:#eef6fc;color:${COLOR}"><th style="${S.th}">#</th><th style="${S.th}">Item</th><th style="${S.th};text-align:right">Qty</th>${whHead}
      ${mode === 'gr' ? `<th style="${S.th};text-align:right">Price</th>` : ''}${mode === 'str' ? '' : `<th style="${S.th}">Batch</th>`}${removable ? '<th></th>' : ''}</tr>
    ${rows}
  </table>
  <div style="text-align:right;font-size:12px;padding:6px 4px 0;color:#374151">${session.lines.length} line(s) · Total qty <strong>${fmtQty(total)}</strong></div>`;
}

function headerSummary(session) {
  const cfg = INV_MODES[session.mode];
  const h = session.header;
  if (session.request) return `Request <strong>#${session.request.docNum}</strong> · ${escHtml(h.fromWh)} → ${escHtml(h.toWh)}`;
  return cfg.kind === 'transfer'
    ? `From <strong>${escHtml(h.fromWh)}</strong> → To <strong>${escHtml(h.toWh)}</strong>`
    : `Warehouse <strong>${escHtml(h.wh)}</strong>`;
}

function buildReviewHtml(session) {
  const cfg = INV_MODES[session.mode];
  return `<div style="${S.card}">
    <div style="font-size:13px;font-weight:700;color:${COLOR};margin-bottom:8px">📋 ${escHtml(cfg.docName)} Ready to Post</div>
    <div style="font-size:12.5px;margin-bottom:8px">${headerSummary(session)}</div>
    ${linesTableHtml(session)}
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:12px 0">
      <div><div style="${S.label}">Posting Date</div><input type="date" id="inva-rf-date" value="${today()}" style="${S.input}"></div>
      ${session.mode === 'str'
        ? `<div><div style="${S.label}">Required By (Due Date)</div><input type="date" id="inva-rf-due" value="${datePlusDays(3)}" style="${S.input}"></div>`
        : `<div><div style="${S.label}">Journal Remark</div><input type="text" id="inva-rf-memo" maxlength="50" placeholder="Optional" style="${S.input}"></div>`}
      <div style="grid-column:1/-1"><div style="${S.label}">Comments</div><input type="text" id="inva-rf-comments" maxlength="250" placeholder="Optional" style="${S.input}"></div>
    </div>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <button onclick="invaPost()" style="${S.btn};padding:9px 22px;font-size:13.5px">✅ Post ${escHtml(cfg.docName)}</button>
      ${session.mode === 'st_req'
        ? `<button onclick="invaSend(JSON.stringify({action:'back_to_request'}))" style="${S.btn2}">← Edit Quantities</button>`
        : `<button onclick="invaSend(JSON.stringify({action:'add_more_items'}))" style="${S.btn2}">+ Add More Items</button>`}
    </div>
  </div>`;
}

function buildRequestListHtml(requests) {
  if (!requests.length) {
    return `<div style="${S.card}"><div style="${S.title}">No open Stock Transfer Requests found.</div>
      <div style="font-size:12.5px;color:#374151">Create one with <strong>Stock Transfer Request</strong>, or type a request number to search.</div></div>`;
  }
  const rows = requests.map(r => `<tr>
      <td style="${S.td}"><strong>#${r.DocNum}</strong></td>
      <td style="${S.td}">${escHtml(String(r.DocDate || '').slice(0, 10))}</td>
      <td style="${S.td}">${escHtml(String(r.DueDate || '').slice(0, 10))}</td>
      <td style="${S.td}">${escHtml(r.FromWarehouse)} → ${escHtml(r.ToWarehouse)}</td>
      <td style="${S.td};max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escHtml(r.Comments || '')}">${escHtml(r.Comments || '')}</td>
      <td style="${S.td}"><button onclick="invaSend(JSON.stringify({action:'select_request',docEntry:${Number(r.DocEntry)}}))" style="${S.btn};padding:5px 12px;font-size:12px">Select</button></td>
    </tr>`).join('');
  return `<div style="${S.card}">
    <div style="${S.title}">🔁 Open Stock Transfer Requests (${requests.length})</div>
    <div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;background:#fff;min-width:520px">
      <tr style="background:#eef6fc;color:${COLOR}"><th style="${S.th}">Request</th><th style="${S.th}">Date</th><th style="${S.th}">Due</th><th style="${S.th}">From → To</th><th style="${S.th}">Comments</th><th></th></tr>
      ${rows}
    </table></div>
    <div style="font-size:11.5px;color:#6b7280;margin-top:8px">Or type a request number in the chat box.</div>
  </div>`;
}

function buildRequestLinesHtml(req, items) {
  const batchItems  = new Set(items.filter(i => i.ManageBatchNumbers === 'tYES').map(i => i.ItemCode));
  const serialItems = new Set(items.filter(i => i.ManageSerialNumbers === 'tYES').map(i => i.ItemCode));
  const rows = req.lines.map(l => `<tr data-line="${l.lineNum}" data-item="${escHtml(l.itemCode)}" data-fromwh="${escHtml(l.fromWh)}">
      <td style="${S.td}"><input type="checkbox" class="inva-rl-chk" checked></td>
      <td style="${S.td}"><strong>${escHtml(l.itemCode)}</strong><div style="font-size:11px;color:#6b7280">${escHtml(l.itemName)}</div></td>
      <td style="${S.td}">${escHtml(l.fromWh)} → ${escHtml(l.toWh)}</td>
      <td style="${S.td};text-align:right">${fmtQty(l.quantity)}</td>
      <td style="${S.td};text-align:right">${fmtQty(l.openQty)}</td>
      <td style="${S.td}"><input type="number" class="inva-rl-qty" value="${l.openQty}" min="0" max="${l.openQty}" step="0.001" style="${S.input};width:90px" onchange="invaRlClearAlloc(${l.lineNum})"></td>
      <td style="${S.td}">${batchItems.has(l.itemCode) || serialItems.has(l.itemCode)
        ? `<button type="button" onclick="invaPickReqBatchSerial(${l.lineNum},'${serialItems.has(l.itemCode) ? 'serial' : 'batch'}')" style="${S.btn2}">📦 Select…</button>
           <div id="inva-rlalloc-${l.lineNum}" style="font-size:10.5px;color:#b91c1c;margin-top:2px">Not selected</div>`
        : '<span style="color:#9ca3af">—</span>'}</td>
    </tr>`).join('');
  return `<div style="${S.card}">
    <div style="${S.title}">🔁 Request #${req.docNum} — ${escHtml(req.fromWh)} → ${escHtml(req.toWh)}</div>
    ${req.comments ? `<div style="font-size:12px;color:#374151;margin-bottom:8px">📝 ${escHtml(req.comments)}</div>` : ''}
    <div style="overflow-x:auto"><table id="inva-rl-table" style="width:100%;border-collapse:collapse;background:#fff;min-width:560px">
      <tr style="background:#eef6fc;color:${COLOR}"><th></th><th style="${S.th}">Item</th><th style="${S.th}">From → To</th><th style="${S.th};text-align:right">Requested</th><th style="${S.th};text-align:right">Open</th><th style="${S.th}">Transfer Qty</th><th style="${S.th}">Batch / Serial</th></tr>
      ${rows}
    </table></div>
    <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">
      <button onclick="invaSubmitRequestLines()" style="${S.btn}">Review Transfer →</button>
      <button onclick="invaSend(JSON.stringify({action:'list_requests'}))" style="${S.btn2}">← Other Request</button>
    </div>
  </div>`;
}

function buildSuccessHtml(session, result, printUrl) {
  const cfg = INV_MODES[session.mode];
  return `<div style="${S.card};border-radius:10px;padding:16px">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;gap:10px">
      <div style="font-size:15px;font-weight:700;color:${COLOR}">✅ ${escHtml(cfg.docName)} Created Successfully</div>
      <button onclick="poaShowPrintModal('${printUrl}','${escHtml(cfg.docName)} #${result.DocNum}')" style="${S.btn};padding:7px 18px">🖨️ Print</button>
    </div>
    <table style="width:100%;border-collapse:collapse;margin-bottom:12px;background:#fff">
      <tr style="background:#eef6fc"><td style="padding:7px 12px;font-size:12px;font-weight:700;color:${COLOR};width:35%">Document No.</td><td style="padding:7px 12px;font-size:13.5px;font-weight:700;color:${COLOR}">#${result.DocNum}</td></tr>
      <tr><td style="padding:7px 12px;font-size:12px;color:#6b7280">Doc Entry</td><td style="padding:7px 12px;font-size:12.5px">${result.DocEntry}</td></tr>
      <tr style="background:#f9fafb"><td style="padding:7px 12px;font-size:12px;color:#6b7280">Details</td><td style="padding:7px 12px;font-size:12.5px">${headerSummary(session)}</td></tr>
      <tr><td style="padding:7px 12px;font-size:12px;color:#6b7280">Posting Date</td><td style="padding:7px 12px;font-size:12.5px">${escHtml(String(result.DocDate || today()).slice(0, 10))}</td></tr>
    </table>
    ${linesTableHtml(session)}
  </div>`;
}

// ── SAP payload builders ───────────────────────────────────────────────────────

function buildPayload(session, action) {
  const mode = session.mode;
  const cfg  = INV_MODES[mode];
  const common = {
    DocDate: sapDate(action.docDate || today()),
    ...(action.comments ? { Comments: String(action.comments).slice(0, 254) } : {}),
    ...(action.memo     ? { JournalMemo: String(action.memo).slice(0, 50) }   : {}),
  };
  const batchOf  = l => (l.batches?.length ? { BatchNumbers: l.batches.map(b => ({
    BatchNumber: String(b.batch), Quantity: Number(b.qty),
    ...(b.expiry ? { ExpiryDate: sapDate(b.expiry) } : {}),
    ...(b.mfg    ? { ManufacturingDate: sapDate(b.mfg) } : {}),
  })) } : {});
  const serialOf = l => (l.serials?.length ? { SerialNumbers: l.serials.map(s => ({ InternalSerialNumber: String(s.serial), ...(s.sysNumber ? { SystemSerialNumber: Number(s.sysNumber) } : {}), Quantity: 1 })) } : {});
  const uomOf    = l => (l.uom ? { UoMCode: l.uom } : {});

  if (cfg.kind === 'transfer') {
    return {
      linesKey: 'StockTransferLines',
      payload: {
        ...common,
        ...(mode === 'str' ? { DueDate: sapDate(action.dueDate || datePlusDays(3)) } : {}),
        FromWarehouse: session.header.fromWh,
        ToWarehouse:   session.header.toWh,
        ...(session.request ? { Comments: action.comments || `Based on Stock Transfer Request #${session.request.docNum}` } : {}),
        StockTransferLines: session.lines.map(l => ({
          ItemCode:          l.itemCode,
          Quantity:          Number(l.quantity),
          FromWarehouseCode: l.fromWh,
          WarehouseCode:     l.toWh,
          ...(session.request ? { BaseType: 'InventoryTransferRequest', BaseEntry: session.request.docEntry, BaseLine: l.baseLine } : uomOf(l)),
          ...(mode === 'str' ? {} : { ...batchOf(l), ...serialOf(l) }),
        })),
      },
    };
  }
  return {
    linesKey: 'DocumentLines',
    payload: {
      ...common,
      DocumentLines: session.lines.map(l => ({
        ItemCode:      l.itemCode,
        Quantity:      Number(l.quantity),
        WarehouseCode: l.wh,
        ...(mode === 'gr' && l.unitPrice !== undefined ? { UnitPrice: l.unitPrice } : {}),
        ...uomOf(l),
        ...batchOf(l),
        ...serialOf(l),
      })),
    },
  };
}

// ── Print layout ───────────────────────────────────────────────────────────────

function renderPrint(mode, doc) {
  const cfg      = INV_MODES[mode];
  const company  = process.env.SAP_B1_COMPANY || process.env.SL_COMPANY || 'Company';
  const transfer = cfg.kind === 'transfer';
  const lines    = (transfer ? doc.StockTransferLines : doc.DocumentLines) || [];
  const printedOn = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  const totalQty  = lines.reduce((s, l) => s + Number(l.Quantity || 0), 0);

  const linesHtml = lines.map((l, i) => `<tr>
      <td>${i + 1}</td><td><strong>${escHtml(l.ItemCode)}</strong></td><td>${escHtml(l.ItemDescription || '')}</td>
      <td style="text-align:right">${fmtQty(l.Quantity)}</td><td>${escHtml(l.UoMCode || l.MeasureUnit || '')}</td>
      ${transfer ? `<td>${escHtml(l.FromWarehouseCode)}</td><td>${escHtml(l.WarehouseCode)}</td>` : `<td>${escHtml(l.WarehouseCode)}</td>`}
      ${mode === 'gr' ? `<td style="text-align:right">${Number(l.UnitPrice || l.Price || 0).toFixed(2)}</td>` : ''}
      <td>${escHtml([...(l.BatchNumbers || []).map(b => b.BatchNumber), ...(l.SerialNumbers || []).map(s => s.InternalSerialNumber || s.SystemSerialNumber)].join(', '))}</td>
    </tr>`).join('');

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<title>${escHtml(cfg.docName)} #${doc.DocNum}</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:Arial,sans-serif;font-size:11px;color:#222;padding:28px 36px;max-width:980px;margin:auto}
  .print-btn{margin-bottom:16px;display:flex;gap:8px;justify-content:flex-end}
  .print-btn button{padding:8px 18px;border:none;border-radius:6px;cursor:pointer;font-size:13px;font-weight:600}
  .btn-print{background:#354A5E;color:#fff}.btn-close{background:#eee;color:#333}
  .header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:24px;padding-bottom:16px;border-bottom:3px solid #354A5E}
  .co-name{font-size:20px;font-weight:700;color:#1a1d27}
  .doc-title{font-size:18px;font-weight:700;color:#354A5E;text-align:right}
  .info-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-bottom:20px}
  .info-box{border:1px solid #ddd;border-radius:6px;padding:12px}
  .info-label{font-size:9px;font-weight:700;text-transform:uppercase;color:#888;letter-spacing:.06em;margin-bottom:6px}
  .info-val{font-size:12px;color:#222;margin-bottom:2px}
  table{width:100%;border-collapse:collapse;margin-bottom:16px}
  thead tr{background:#354A5E}
  th{padding:8px 10px;text-align:left;font-size:10px;font-weight:700;text-transform:uppercase;color:#fff}
  td{padding:7px 10px;border-bottom:1px solid #eee;font-size:11px}
  tr:nth-child(even) td{background:#fafbfe}
  .totals{text-align:right;padding:8px 0 20px;font-size:13px;font-weight:700;color:#354A5E}
  .sign{display:grid;grid-template-columns:repeat(3,1fr);gap:24px;margin-top:48px}
  .sign div{border-top:1px solid #999;padding-top:6px;text-align:center;font-size:10px;color:#666}
  .footer{text-align:center;margin-top:24px;font-size:9px;color:#aaa;border-top:1px solid #eee;padding-top:12px}
  @media print{.print-btn{display:none}}
</style></head><body>
<div class="print-btn">
  <button class="btn-close" onclick="window.parent!==window ? window.parent.postMessage({type:'poa-print-close'},'*') : window.close()">✕ Close</button>
  <button class="btn-print" onclick="window.print()">🖨️ Print</button>
</div>
<div class="header">
  <div><div class="co-name">${escHtml(company)}</div><div style="color:#888;font-size:11px;margin-top:2px">SAP Business One — ${escHtml(cfg.docName)}</div></div>
  <div><div class="doc-title">${escHtml(cfg.docName)}</div><div style="font-size:13px;color:#444;text-align:right"># ${doc.DocNum}</div></div>
</div>
<div class="info-grid">
  <div class="info-box"><div class="info-label">${transfer ? 'Warehouses' : 'Document'}</div>
    <div class="info-val"><strong>${transfer ? `${escHtml(doc.FromWarehouse)} → ${escHtml(doc.ToWarehouse)}` : escHtml(cfg.docName)}</strong></div></div>
  <div class="info-box"><div class="info-label">Posting Date${doc.DueDate ? ' / Due Date' : ''}</div>
    <div class="info-val"><strong>${escHtml(String(doc.DocDate || '').slice(0, 10))}</strong></div>
    ${doc.DueDate ? `<div class="info-val" style="color:#666">Due: ${escHtml(String(doc.DueDate).slice(0, 10))}</div>` : ''}</div>
  <div class="info-box"><div class="info-label">Journal Remark</div><div class="info-val">${escHtml(doc.JournalMemo || '—')}</div></div>
</div>
${doc.Comments ? `<div style="border:1px solid #ddd;border-radius:6px;padding:12px;margin-bottom:20px;font-size:11px;line-height:1.6"><strong>📝 Comments:</strong> ${escHtml(doc.Comments)}</div>` : ''}
<table>
  <thead><tr><th>#</th><th>Item Code</th><th>Description</th><th style="text-align:right">Qty</th><th>UoM</th>
    ${transfer ? '<th>From WH</th><th>To WH</th>' : '<th>Warehouse</th>'}${mode === 'gr' ? '<th style="text-align:right">Unit Price</th>' : ''}<th>Batch</th></tr></thead>
  <tbody>${linesHtml}</tbody>
</table>
<div class="totals">Total Quantity: ${fmtQty(totalQty)}</div>
<div class="sign"><div>Prepared By</div><div>Checked By</div><div>${mode === 'gr' ? 'Received By' : mode === 'gi' ? 'Issued To' : 'Received By'}</div></div>
<div class="footer">Printed on ${escHtml(printedOn)} &nbsp;|&nbsp; ${escHtml(company)} — SAP B1 ${escHtml(cfg.docName)} #${doc.DocNum} &nbsp;|&nbsp; Powered by Henny AI Solution</div>
</body></html>`;
}

// ── Router factory ─────────────────────────────────────────────────────────────

export function createInventoryAgentRouter(deps) {
  const { requireAuth, printAuth, getActiveSap, gptChatComplete, azureMessagesCreate, AI_PROVIDER, USE_AI } = deps;
  const aiDeps = { gptChatComplete, azureMessagesCreate, AI_PROVIDER, USE_AI };
  const router = Router();

  // Modes the current user may use — each menu item's screen opens only if its mode is listed
  router.get('/modes', requireAuth, (req, res) => {
    res.json({ modes: allowedModes(req.user).map(m => ({ mode: m, label: INV_MODES[m].label, icon: INV_MODES[m].icon })) });
  });

  // Live per-warehouse stock for one item (line form availability hint)
  router.get('/stock', requireAuth, async (req, res) => {
    if (!allowedModes(req.user).length) return res.status(403).json({ error: 'No inventory workflow permission' });
    try {
      res.json(await getItemInfo(getActiveSap(), String(req.query.itemCode || '')));
    } catch (e) {
      res.status(404).json({ error: sapErrorText(e) });
    }
  });

  // Batches/serials actually in stock for one item in one warehouse (?kind=batch|serial&itemCode=&whs=)
  router.get('/batch-serials', requireAuth, (req, res, next) => {
    if (!allowedModes(req.user).length) return res.status(403).json({ ok: false, error: 'No inventory workflow permission' });
    next();
  }, batchSerialRoute());

  router.post('/chat', requireAuth, async (req, res) => {
    try {
      const { message = '', sessionId, mode: reqMode } = req.body;
      const modes = allowedModes(req.user);

      let sid = sessionId;
      let session = sid ? _sessions.get(sid) : null;
      // A session belongs to one user and one mode; anything else starts fresh
      if (!session || session.userId !== req.user.user_id || (reqMode && reqMode !== session.mode)) {
        const mode = reqMode || session?.mode;
        if (!INV_MODES[mode]) return res.status(400).json({ ok: false, error: 'Unknown inventory transaction type' });
        sid = `inv_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        session = initSession(mode, req.user.user_id);
        purgeStaleSessions();
        _sessions.set(sid, session);
      }
      session.touchedAt = Date.now();
      const mode = session.mode;
      const cfg  = INV_MODES[mode];
      if (!modes.includes(mode)) {
        return res.status(403).json({ ok: false, sessionId: sid, reply: `🔒 You don't have permission for <strong>${escHtml(cfg.label)}</strong>. Ask an administrator to grant it under <strong>Admin → Roles &amp; Permissions → Inventory</strong>.` });
      }

      const sap  = getActiveSap();
      const msg  = String(message).trim();
      const msgL = msg.toLowerCase();
      let reply = '';
      let quickReplies = [];
      let meta = {};

      const items      = () => getCacheItems();
      const warehouses = () => getCacheWarehouses();
      // Each rendered form gets a fresh index — earlier forms stay in the chat DOM, so ids must not repeat
      const lineForm   = (prefix = '') => { session.step = 'ADD_ITEM'; session.lineIdx++; return prefix + buildLineHtml(session, items(), warehouses()); };
      const addedBlock = (note = '') => `<div style="background:${BG};border:1px solid ${COLOR};border-radius:6px;padding:8px 12px;margin-bottom:8px">
          <div style="font-size:12px;font-weight:700;color:${COLOR};margin-bottom:6px">${note || '✅ Lines so far'}</div>${linesTableHtml(session, { removable: true })}</div>`;
      const showRequests = async (docNum) => {
        session.step = 'SELECT_REQUEST';
        try { return buildRequestListHtml(await listOpenTransferRequests(sap, docNum)); }
        catch (e) { return `<div style="${S.err}">❌ Could not load transfer requests: ${escHtml(sapErrorText(e))}</div>`; }
      };
      const welcome = async () => {
        const intro = `<div style="font-size:13.5px;font-weight:600;margin-bottom:6px">${cfg.icon} <strong>${escHtml(cfg.label)}</strong></div>`;
        if (mode === 'st_req') return intro + `<div style="font-size:13px;color:#374151;margin-bottom:6px">Select an open request to transfer against:</div>` + await showRequests();
        session.step = 'HEADER';
        return intro + buildHeaderHtml(mode, warehouses(), session.header);
      };

      if (msg.startsWith('{')) {
        let action = null;
        try { action = JSON.parse(msg); } catch {}

        if (session.posting) {
          reply = `⏳ The ${escHtml(cfg.docName)} is being posted to SAP — please wait.`;
        }
        else if (session.step === 'DONE') {
          reply = `This ${escHtml(cfg.docName)} was already posted (#${session.result?.docNum}). Start a new one to make changes.`;
          quickReplies = [`New ${cfg.label}`];
        }

        else if (action?.action === 'set_header') {
          const whs = new Set(warehouses().map(w => w.WarehouseCode));
          const known = c => !whs.size || whs.has(c);  // empty cache → let SAP validate
          if (cfg.kind === 'transfer') {
            if (!action.fromWh || !action.toWh)      reply = `<div style="${S.err}">⚠️ Select both From and To warehouse.</div>`;
            else if (action.fromWh === action.toWh)  reply = `<div style="${S.err}">⚠️ From and To warehouse cannot be the same.</div>`;
            else if (!known(action.fromWh) || !known(action.toWh)) reply = `<div style="${S.err}">⚠️ Unknown warehouse code.</div>`;
            else session.header = { fromWh: action.fromWh, toWh: action.toWh };
          } else if (!action.wh || !known(action.wh)) {
            reply = `<div style="${S.err}">⚠️ Select a valid warehouse.</div>`;
          } else session.header = { wh: action.wh };

          if (reply) reply += buildHeaderHtml(mode, warehouses(), session.header);
          else reply = lineForm(`<div style="background:${BG};border:1px solid ${COLOR};border-radius:6px;padding:8px 12px;margin-bottom:8px">✅ ${headerSummary(session)}</div>
            ${session.lines.length ? addedBlock() : ''}`);
        }

        else if (action?.action === 'change_header') {
          session.step = 'HEADER';
          reply = `<div style="font-size:13px;margin-bottom:6px">Change the warehouse(s) — new lines will use them; existing lines keep theirs.</div>${buildHeaderHtml(mode, warehouses(), session.header)}`;
        }

        else if (action?.action === 'add_item') {
          const { line, error } = await buildLine(session, sap, action);
          if (error) reply = lineForm(`<div style="${S.err}">⚠️ ${error}</div>${session.lines.length ? addedBlock() : ''}`);
          else {
            session.lines.push(line);
            reply = lineForm(addedBlock(`✅ ${escHtml(line.itemCode)} added — ${session.lines.length} line(s):`)
              + `<div style="font-size:13px;color:#374151;margin-bottom:6px">Add another item or click <strong>Done Adding Items</strong>:</div>`);
          }
        }

        else if (action?.action === 'remove_line') {
          const i = Number(action.index);
          if (session.lines[i]) session.lines.splice(i, 1);
          if (mode === 'st_req') {
            reply = session.lines.length ? buildReviewHtml(session) : buildRequestLinesHtml(session.request, items());
            session.step = session.lines.length ? 'REVIEW' : 'REQ_LINES';
          } else {
            reply = lineForm(session.lines.length ? addedBlock('Line removed') : '<div style="margin-bottom:6px">Line removed — no lines left.</div>');
          }
        }

        else if (action?.action === 'done_items') {
          if (!session.lines.length) reply = lineForm(`<div style="${S.err}">⚠️ Please add at least one item.</div>`);
          else { session.step = 'REVIEW'; reply = buildReviewHtml(session); }
        }

        else if (action?.action === 'add_more_items') {
          reply = lineForm(addedBlock());
        }

        else if (action?.action === 'list_requests') {
          session.request = null; session.lines = []; session.header = {};
          reply = await showRequests();
        }

        else if (action?.action === 'select_request') {
          try {
            const r = await sap.get(`/InventoryTransferRequests(${parseInt(action.docEntry, 10)})`);
            if (r.DocumentStatus && r.DocumentStatus !== 'bost_Open') throw new Error(`Request #${r.DocNum} is closed`);
            const lines = (r.StockTransferLines || [])
              .filter(l => l.LineStatus !== 'bost_Close')
              .map(l => ({
                lineNum: l.LineNum, itemCode: l.ItemCode, itemName: l.ItemDescription || '',
                fromWh: l.FromWarehouseCode || r.FromWarehouse, toWh: l.WarehouseCode || r.ToWarehouse,
                quantity: Number(l.Quantity || 0),
                openQty:  Number(l.RemainingOpenQuantity ?? l.OpenQuantity ?? l.Quantity ?? 0),
              }))
              .filter(l => l.openQty > 0);
            if (!lines.length) throw new Error(`Request #${r.DocNum} has no open quantity left`);
            session.request = { docEntry: r.DocEntry, docNum: r.DocNum, fromWh: r.FromWarehouse, toWh: r.ToWarehouse, comments: r.Comments || '', lines };
            session.header  = { fromWh: r.FromWarehouse, toWh: r.ToWarehouse };
            session.lines   = [];
            session.step    = 'REQ_LINES';
            reply = buildRequestLinesHtml(session.request, items());
          } catch (e) {
            reply = `<div style="${S.err}">❌ ${escHtml(sapErrorText(e))}</div>` + await showRequests();
          }
        }

        else if (action?.action === 'req_lines') {
          const req = session.request;
          if (!req) reply = await showRequests();
          else {
            const picked = (action.lines || []).filter(p => Number(p.quantity) > 0);
            const errors = [];
            session.lines = [];
            for (const p of picked) {
              const base = req.lines.find(l => l.lineNum === Number(p.lineNum));
              if (!base) continue;
              if (Number(p.quantity) > base.openQty + 1e-9) {
                errors.push(`<strong>${escHtml(base.itemCode)}</strong>: transfer qty ${fmtQty(p.quantity)} exceeds open qty ${fmtQty(base.openQty)}.`);
                continue;
              }
              const { line, error } = await buildLine(session, sap, {
                itemCode: base.itemCode, quantity: Number(p.quantity), batches: p.batches, serials: p.serials,
                fromWh: base.fromWh, toWh: base.toWh, baseLine: base.lineNum, openQty: base.openQty,
              });
              if (error) errors.push(error); else session.lines.push(line);
            }
            if (!picked.length) errors.push('Select at least one line with a quantity greater than 0.');
            if (errors.length) {
              session.lines = [];
              reply = `<div style="${S.err}">⚠️ ${errors.join('<br>')}</div>` + buildRequestLinesHtml(req, items());
            } else {
              session.step = 'REVIEW';
              reply = buildReviewHtml(session);
            }
          }
        }

        else if (action?.action === 'back_to_request') {
          session.lines = []; session.step = 'REQ_LINES';
          reply = buildRequestLinesHtml(session.request, items());
        }

        else if (action?.action === 'post') {
          if (!session.lines.length) {
            reply = `<div style="${S.err}">❌ No lines to post.</div>`;
          } else {
            const { payload, linesKey } = buildPayload(session, action);
            session.posting = true;
            try {
              const result = await postWithFallbacks(sap, cfg.endpoint, payload, linesKey);
              session.result = { docEntry: result.DocEntry, docNum: result.DocNum };
              session.step   = 'DONE';
              const printUrl = `/api/inventory-agent/print/${mode}/${result.DocEntry}`;
              reply = buildSuccessHtml(session, result, printUrl);
              quickReplies = [`New ${cfg.label}`];
              meta = { docEntry: result.DocEntry, docNum: result.DocNum, printUrl };
              console.log(`[Inventory-Agent] ${req.user.username} posted ${cfg.docName} #${result.DocNum}`);
            } catch (e) {
              reply = `❌ <strong>Failed to post ${escHtml(cfg.docName)}</strong><br><br>SAP Error: <em>${escHtml(sapErrorText(e))}</em>`
                + buildReviewHtml(session);
            } finally {
              session.posting = false;
            }
          }
        }

        else {
          reply = 'Unexpected action. Please start over.';
          quickReplies = ['Start Over'];
        }
      }

      // ── Free text ─────────────────────────────────────────────────────────
      else if (!msg) {
        reply = await welcome();
      }
      else if (/^(start over|reset|cancel|new\b)/i.test(msgL) || (session.step === 'DONE' && /new|another|create|yes/i.test(msgL))) {
        Object.assign(session, initSession(mode, req.user.user_id));
        reply = await welcome();
      }
      else if (session.step === 'HEADER') {
        const w = parseWarehouses(msg, warehouses());
        const ok = cfg.kind === 'transfer' ? (w.fromWh && w.toWh && w.fromWh !== w.toWh) : !!w.wh;
        if (ok) {
          session.header = cfg.kind === 'transfer' ? { fromWh: w.fromWh, toWh: w.toWh } : { wh: w.wh };
          reply = lineForm(`<div style="background:${BG};border:1px solid ${COLOR};border-radius:6px;padding:8px 12px;margin-bottom:8px">✅ ${headerSummary(session)}</div>`);
        } else {
          reply = `<div style="${S.err}">I couldn't recognise ${cfg.kind === 'transfer' ? 'two different warehouse codes (try <em>from 01 to 02</em>)' : 'a warehouse code'}. Please pick from the list:</div>`
            + buildHeaderHtml(mode, warehouses(), session.header);
        }
      }
      else if (session.step === 'SELECT_REQUEST') {
        const n = msg.match(/\d+/)?.[0];
        reply = n ? await showRequests(n) : 'Type a request number, or select one from the list above.';
      }
      else if (session.step === 'ADD_ITEM') {
        let { found, unresolved } = parseLinesRuleBased(msg);
        let viaAI = false;
        if (unresolved.length) {
          const ai = await parseLinesWithAI(aiDeps, unresolved.join(', '));
          if (ai.length) { found = found.concat(ai); viaAI = true; }
        }
        if (!found.length) {
          reply = lineForm(`<div style="${S.err}">I couldn't find item codes and quantities in that message. Try <em>10 A00001, 5 A00002</em>, or use the form:</div>`);
        } else {
          const errors = [];
          let added = 0;
          for (const f of found) {
            const { line, error } = await buildLine(session, sap, f);
            if (error) errors.push(error); else { session.lines.push(line); added++; }
          }
          reply = lineForm(
            (added ? addedBlock(`✅ ${added} line(s) added${viaAI ? ' (AI-assisted — please check)' : ''}:`) : '')
            + (errors.length ? `<div style="${S.err}">⚠️ ${errors.join('<br>')}</div>` : ''));
        }
      }
      else if (session.step === 'REVIEW') {
        reply = 'Use the buttons above to post the document, or type <em>start over</em>.';
      }
      else if (session.step === 'REQ_LINES') {
        reply = 'Adjust the transfer quantities above and click <strong>Review Transfer</strong>.';
      }
      else if (session.step === 'DONE') {
        reply = `${escHtml(cfg.docName)} complete.`;
        quickReplies = [`New ${cfg.label}`];
      }

      res.json({
        ok: true, reply, quickReplies, sessionId: sid, meta,
        mode, step: session.step,
        header: session.header, lines: session.lines,
        request: session.request ? { docNum: session.request.docNum } : null,
      });
    } catch (e) {
      console.error('[Inventory-Agent] chat error:', e);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  router.post('/reset', requireAuth, (req, res) => {
    const { sessionId } = req.body || {};
    const s = _sessions.get(sessionId);
    if (s && s.userId === req.user.user_id) _sessions.delete(sessionId);
    res.json({ ok: true });
  });

  router.get('/print/:mode/:docEntry', printAuth, async (req, res) => {
    const mode = req.params.mode;
    const cfg  = INV_MODES[mode];
    if (!cfg) return res.status(404).send('Unknown document type');
    if (!allowedModes(req.user).includes(mode)) return res.status(403).send('Permission denied');
    try {
      const doc = await getActiveSap().get(`${cfg.endpoint}(${parseInt(req.params.docEntry, 10)})`);
      res.setHeader('Content-Type', 'text/html');
      res.send(renderPrint(mode, doc));
    } catch (e) {
      res.status(500).send(`<pre style="color:red">Error loading ${escHtml(cfg.docName)} #${escHtml(req.params.docEntry)}: ${escHtml(sapErrorText(e))}</pre>`);
    }
  });

  return router;
}
