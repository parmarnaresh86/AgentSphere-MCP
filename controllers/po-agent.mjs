/**
 * Standalone Purchase Order Agent
 *  1. Search & select vendor (from local master-data cache, live SAP fallback)
 *  2. Add line items via an inline combo form (item dropdown + qty/price/disc/tax/warehouse)
 *  3. Post new Purchase Order to SAP B1
 *  4. Show success with print link
 *
 * UI pattern mirrors sales-quotation-agent.mjs: the server renders full HTML
 * (dropdowns + buttons wired to inline onclick handlers) as the chat reply —
 * the frontend just injects it, no separate combo-list JS needed.
 */
import { Router } from 'express';
import { getItemPrice } from '../lib/item-price.mjs';
import { buildReviewCard, readReviewPost } from '../lib/o2c-review.mjs';
import { docAmounts, resultAmounts, cardTotalsHtml, printTotalsHtml, printTaxHeads, printTaxCells, money } from '../lib/doc-totals.mjs';
import db, { connRepo } from '../db.mjs';

const HEADER_KEYS = ['docDate', 'deliveryDate', 'reference', 'comments'];
// The step each card's action belongs to — an action from an earlier card is refused.
const STEP_OF = { select_vendor: ['INIT', 'SELECT_VENDOR'], add_item: ['ADD_ITEM'], done_items: ['ADD_ITEM'], add_more_items: ['REVIEW_FORM'], post_po: ['REVIEW_FORM'] };

const _sessions = new Map();

function initSession() {
  return {
    step:           'INIT',
    history:        [],
    selectedVendor: null,  // { cardCode, cardName }
    result:         null,  // { docEntry, docNum } after post
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
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Cache helpers ──────────────────────────────────────────────────────────────

function getCompanyId() {
  const conn = connRepo.getActive();
  return conn ? conn.company : 'default';
}

function getCacheVendors() {
  const cid = getCompanyId();
  return db.prepare(`SELECT CardCode, CardName, City FROM cache_business_partners
    WHERE company_id=? AND CardType='cSupplier' AND Frozen='tNO' ORDER BY CardName LIMIT 500`).all(cid);
}

function getCacheItems() {
  const cid = getCompanyId();
  return db.prepare(`SELECT ItemCode, ItemName, PurchaseUnit, PurchVATGroup, QuantityOnStock
    FROM cache_items WHERE company_id=? AND Frozen='tNO' ORDER BY ItemName LIMIT 500`).all(cid);
}

// Items matching text typed in the chat box at the ADD_ITEM step. Searches the whole
// item cache (the combo list is capped at 500 rows), every word must match code or
// name; falls back to a live SAP search when the cache has no match.
async function searchItems(sap, query) {
  const words = query.split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const where = words.map(() => '(ItemCode LIKE ? OR ItemName LIKE ?)').join(' AND ');
  const rows = db.prepare(`SELECT ItemCode, ItemName, PurchaseUnit, PurchVATGroup, QuantityOnStock
    FROM cache_items WHERE company_id=? AND Frozen='tNO' AND ${where} ORDER BY ItemName LIMIT 50`)
    .all(getCompanyId(), ...words.flatMap(w => [`%${w}%`, `%${w}%`]));
  if (rows.length) return rows;
  try {
    const q = query.replace(/'/g, "''");
    const r = await sap.get('/Items', {
      $filter:  `Frozen eq 'tNO' and (substringof('${q}',ItemCode) or substringof('${q}',ItemName))`,
      $select:  'ItemCode,ItemName,PurchaseUnit,PurchVATGroup,QuantityOnStock',
      $orderby: 'ItemName',
      $top:     50,
    });
    return Array.isArray(r.value) ? r.value : [];
  } catch (e) {
    console.error('[PO-Agent] searchItems error:', e.message);
    return [];
  }
}

// Default purchasing UoM code for a single item — cache first, live SAP fallback.
// SAP B1 rejects DocumentLines with no UoMCode once UoM management is enabled on the item.
async function getDefaultUoMCode(itemCode, sap) {
  const cid = getCompanyId();
  const cached = db.prepare(`SELECT PurchaseUnit FROM cache_items WHERE company_id=? AND ItemCode=?`).get(cid, itemCode);
  if (cached?.PurchaseUnit) return cached.PurchaseUnit;
  try {
    const item = await sap.get(`/Items('${itemCode}')`, { $select: 'ItemCode,PurchaseUnit,InventoryUOM,SalesUnit' });
    return item?.PurchaseUnit || item?.InventoryUOM || item?.SalesUnit || undefined;
  } catch {
    return undefined;
  }
}

function getCacheTaxCodes() {
  const cid = getCompanyId();
  return db.prepare(`SELECT Code, Name, Rate FROM cache_tax_codes WHERE company_id=? ORDER BY Code`).all(cid);
}

// Qty × Unit Price, less line discount, plus tax computed off the selected tax code's rate.
function calcLineAmounts(quantity, unitPrice, discountPercent, taxRate) {
  const net     = Number(quantity || 0) * Number(unitPrice || 0) * (1 - (Number(discountPercent || 0) / 100));
  const taxAmt  = net * (Number(taxRate || 0) / 100);
  return { netAmount: net, taxAmount: taxAmt, lineTotal: net + taxAmt };
}

// (Re)compute the line amounts the "PO Builder" sidebar and the add-item summary show.
function withAmounts(lines) {
  const rates = new Map(getCacheTaxCodes().map(t => [t.Code, t.Rate]));
  return (lines || []).map(l => ({ ...l, ...calcLineAmounts(l.quantity, l.unitPrice, l.discountPercent, rates.get(l.taxCode) || 0) }));
}

function sumTotals(lines) {
  return lines.reduce((acc, l) => {
    acc.net   += Number(l.netAmount  || 0);
    acc.tax   += Number(l.taxAmount  || 0);
    acc.total += Number(l.lineTotal  || 0);
    return acc;
  }, { net: 0, tax: 0, total: 0 });
}

function totalsFooterHtml(lines) {
  const t = sumTotals(lines);
  return `<div style="display:flex;justify-content:flex-end;gap:20px;padding:8px 6px 2px;border-top:1px solid #bfdbfe;margin-top:2px;font-size:12.5px">
    <div style="color:#374151">Subtotal: <strong>${t.net.toFixed(2)}</strong></div>
    <div style="color:#374151">Tax: <strong>${t.tax.toFixed(2)}</strong></div>
    <div style="color:#0070F2;font-weight:700">Grand Total: ${t.total.toFixed(2)}</div>
  </div>`;
}

function getCacheWarehouses() {
  const cid = getCompanyId();
  return db.prepare(`SELECT WarehouseCode, WarehouseName FROM cache_warehouses WHERE company_id=? AND Inactive='tNO' ORDER BY WarehouseCode`).all(cid);
}

// ── HTML combo builders (rendered inside agent reply) ─────────────────────────

function buildVendorComboHtml(vendors) {
  const opts = vendors.map(v =>
    `<option value="${escHtml(v.CardCode)}">${escHtml(v.CardCode)} — ${escHtml(v.CardName)}${v.City ? ' ('+escHtml(v.City)+')' : ''}</option>`
  ).join('');
  const noCache = !vendors.length
    ? `<div style="color:#ef4444;font-size:12px;margin-bottom:8px">⚠️ Vendor cache is empty — go to <strong>Tools → Data Sync</strong> to load master data, or type in the box below to search live.</div>` : '';
  const vendorsJson = escHtml(JSON.stringify(vendors.map(v => ({ code: v.CardCode, name: v.CardName, city: v.City || '' }))));
  return `<div style="background:#eff6ff;border:1.5px solid #0070F2;border-radius:8px;padding:14px;margin:6px 0" data-vendors="${vendorsJson}">
    ${noCache}
    <div style="font-size:12px;font-weight:700;color:#1d4ed8;margin-bottom:8px">Select Vendor (${vendors.length} available):</div>
    <input type="text" placeholder="🔍 Search vendor by name or code…" oninput="poaFilterVendors(this)"
      style="width:100%;border:1.5px solid #d1d5db;border-radius:6px;padding:7px 10px;font-size:13px;margin-bottom:6px;box-sizing:border-box;outline:none">
    <div style="display:flex;gap:8px;align-items:center;margin-bottom:6px">
      <select id="poa-vendor-sel"
        style="flex:1;border:1.5px solid #0070F2;border-radius:6px;padding:7px 10px;font-size:13px;background:#fff;outline:none">
        <option value="">— Select a Vendor —</option>
        ${opts}
      </select>
      <button onclick="poaComboSelectVendor()"
        style="background:#0070F2;color:#fff;border:none;border-radius:6px;padding:8px 18px;font-size:13px;font-weight:700;cursor:pointer;white-space:nowrap">
        Select →
      </button>
    </div>
    <div style="font-size:11.5px;color:#6b7280">Type above to filter the list, or type a name / code in the chat box below to search live SAP data</div>
  </div>`;
}

// hasLines: items already on the order — "Done Adding Items" stays disabled until there is at least one.
function buildItemLineHtml(items, taxCodes, warehouses, lineIdx, hasLines = false) {
  const itemOpts = items.map(i =>
    `<option value="${escHtml(i.ItemCode)}" data-name="${escHtml(i.ItemName)}" data-unit="${escHtml(i.PurchaseUnit||'')}" data-vat="${escHtml(i.PurchVATGroup||'')}">${escHtml(i.ItemCode)} — ${escHtml(i.ItemName)}</option>`
  ).join('');
  const taxOpts = [`<option value="" data-rate="0">— None —</option>`, ...taxCodes.map(t =>
    `<option value="${escHtml(t.Code)}" data-rate="${Number(t.Rate||0)}">${escHtml(t.Code)}${t.Name?' — '+escHtml(t.Name):''} (${Number(t.Rate||0)}%)</option>`)].join('');
  const whOpts  = [`<option value="">— Default —</option>`, ...warehouses.map(w =>
    `<option value="${escHtml(w.WarehouseCode)}">${escHtml(w.WarehouseCode)}</option>`)].join('');
  const noCache = !items.length
    ? `<div style="color:#ef4444;font-size:12px;margin-bottom:8px">⚠️ Item cache is empty — go to <strong>Tools → Data Sync</strong> first, or type item code below.</div>` : '';
  const itemsJson = escHtml(JSON.stringify(items.map(i => ({ code: i.ItemCode, name: i.ItemName, unit: i.PurchaseUnit || '', vat: i.PurchVATGroup || '' }))));
  return `<div style="background:#eff6ff;border:1.5px solid #0070F2;border-radius:8px;padding:14px;margin:6px 0" data-items="${itemsJson}">
    ${noCache}
    <div style="font-size:12px;font-weight:700;color:#1d4ed8;margin-bottom:8px">Add Line Item (${items.length} items available):</div>
    <div style="margin-bottom:8px">
      <div style="font-size:11px;color:#6b7280;margin-bottom:3px">Item *</div>
      <input type="text" placeholder="🔍 Search item by name or code…" oninput="poaFilterItems(this,${lineIdx})"
        style="width:100%;border:1.5px solid #d1d5db;border-radius:6px;padding:7px 10px;font-size:13px;margin-bottom:6px;box-sizing:border-box;outline:none">
      <select id="poa-item-sel-${lineIdx}" onchange="poaComboItemChange(this,${lineIdx})"
        style="width:100%;border:1.5px solid #d1d5db;border-radius:6px;padding:7px 10px;font-size:13px;background:#fff;outline:none">
        <option value="">— Select an Item —</option>
        ${itemOpts}
      </select>
    </div>
    <div style="display:grid;grid-template-columns:80px 110px 70px 1fr 1fr;gap:8px;margin-bottom:10px">
      <div>
        <div style="font-size:11px;color:#6b7280;margin-bottom:3px">Qty *</div>
        <input type="number" id="poa-qty-${lineIdx}" value="1" min="0.001" step="0.001" oninput="poaCalcLine(${lineIdx})"
          style="width:100%;border:1.5px solid #d1d5db;border-radius:6px;padding:6px 8px;font-size:13px;box-sizing:border-box">
      </div>
      <div>
        <div style="font-size:11px;color:#6b7280;margin-bottom:3px">Unit Price *</div>
        <input type="number" id="poa-price-${lineIdx}" placeholder="0.00" min="0" step="0.01" oninput="poaCalcLine(${lineIdx})"
          style="width:100%;border:1.5px solid #d1d5db;border-radius:6px;padding:6px 8px;font-size:13px;box-sizing:border-box">
      </div>
      <div>
        <div style="font-size:11px;color:#6b7280;margin-bottom:3px">Disc%</div>
        <input type="number" id="poa-disc-${lineIdx}" value="0" min="0" max="100" oninput="poaCalcLine(${lineIdx})"
          style="width:100%;border:1.5px solid #d1d5db;border-radius:6px;padding:6px 8px;font-size:13px;box-sizing:border-box">
      </div>
      <div>
        <div style="font-size:11px;color:#6b7280;margin-bottom:3px">Tax Code</div>
        <select id="poa-tax-${lineIdx}" onchange="poaCalcLine(${lineIdx})"
          style="width:100%;border:1.5px solid #d1d5db;border-radius:6px;padding:6px 8px;font-size:12.5px;background:#fff">${taxOpts}</select>
      </div>
      <div>
        <div style="font-size:11px;color:#6b7280;margin-bottom:3px">Warehouse</div>
        <select id="poa-wh-${lineIdx}"
          style="width:100%;border:1.5px solid #d1d5db;border-radius:6px;padding:6px 8px;font-size:12.5px;background:#fff">${whOpts}</select>
      </div>
    </div>
    <div style="display:flex;justify-content:flex-end;gap:16px;margin:-4px 0 10px;font-size:12px;color:#374151">
      <div>Net: <strong id="poa-net-${lineIdx}">0.00</strong></div>
      <div>Tax: <strong id="poa-taxamt-${lineIdx}">0.00</strong></div>
      <div>Line Total: <strong id="poa-linetotal-${lineIdx}" style="color:#0070F2">0.00</strong></div>
    </div>
    <div style="display:flex;gap:8px">
      <button id="poa-add-btn-${lineIdx}" disabled title="Select an item first" onclick="poaComboAddItem(${lineIdx})"
        style="background:#0070F2;color:#fff;border:none;border-radius:6px;padding:8px 18px;font-size:13px;font-weight:700;cursor:pointer">
        + Add Line
      </button>
      <button id="poa-done-btn-${lineIdx}" ${hasLines ? '' : 'disabled title="Add at least one item first"'} onclick="poaComboDoneItems(${lineIdx})"
        style="background:#f3f4f6;color:#374151;border:1px solid #d1d5db;border-radius:6px;padding:8px 14px;font-size:12.5px;cursor:pointer">
        ✓ Done Adding Items
      </button>
    </div>
  </div>`;
}

// ── SAP helpers ────────────────────────────────────────────────────────────────

async function searchVendors(sap, query) {
  try {
    const q = query.replace(/'/g, "''");
    const r = await sap.get('/BusinessPartners', {
      $filter:  `CardType eq 'cSupplier' and (substringof('${q}',CardName) or substringof('${q}',CardCode))`,
      $select:  'CardCode,CardName',
      $orderby: 'CardName',
      $top:     20,
    });
    return Array.isArray(r.value) ? r.value : [];
  } catch (e) {
    console.error('[PO-Agent] searchVendors error:', e.message);
    return [];
  }
}

function linesSummaryTable(lines) {
  const rows = lines.map((l, i) =>
    `<tr>
      <td style="padding:4px 8px;font-size:12.5px">${i+1}</td>
      <td style="padding:4px 8px;font-size:12.5px">${escHtml(l.itemCode)}</td>
      <td style="padding:4px 8px;font-size:12.5px;text-align:right">${l.quantity}</td>
      <td style="padding:4px 8px;font-size:12.5px;text-align:right">${l.unitPrice??'—'}</td>
      <td style="padding:4px 8px;font-size:12.5px">${escHtml(l.taxCode||'')}</td>
      <td style="padding:4px 8px;font-size:12.5px;text-align:right">${Number(l.taxAmount||0).toFixed(2)}</td>
      <td style="padding:4px 8px;font-size:12.5px;text-align:right;font-weight:600">${Number(l.lineTotal||0).toFixed(2)}</td>
    </tr>`
  ).join('');
  return `<table style="width:100%;border-collapse:collapse;font-size:12px">
    <tr style="background:#dbeafe"><th style="padding:4px 8px;text-align:left">#</th><th style="padding:4px 8px;text-align:left">Item</th><th style="padding:4px 8px;text-align:right">Qty</th><th style="padding:4px 8px;text-align:right">Price</th><th style="padding:4px 8px;text-align:left">Tax</th><th style="padding:4px 8px;text-align:right">Tax Amt</th><th style="padding:4px 8px;text-align:right">Total</th></tr>
    ${rows}
  </table>${totalsFooterHtml(lines)}`;
}

// ── Print layout ───────────────────────────────────────────────────────────────

function renderPOPrint(doc) {
  const company  = process.env.SAP_B1_COMPANY || process.env.SL_COMPANY || 'Company';
  const lines    = doc.DocumentLines || [];
  const docDate  = doc.DocDate    ? doc.DocDate.slice(0, 10)    : '—';
  const dueDate  = doc.DocDueDate ? doc.DocDueDate.slice(0, 10) : '—';
  const printedOn = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  // SAP's own amounts of the document (tax per row, freight / rounding, foreign currency)
  const amt = docAmounts(doc);

  const linesHtml = lines.map((l, i) => `
    <tr>
      <td>${i + 1}</td>
      <td><strong>${escHtml(l.ItemCode || '')}</strong></td>
      <td>${escHtml(l.ItemDescription || '')}</td>
      <td style="text-align:right">${Number(l.Quantity || 0).toFixed(2)}</td>
      <td>${escHtml(l.UoMCode || l.MeasureUnit || '')}</td>
      <td style="text-align:right">${Number(l.UnitPrice || 0).toFixed(2)}</td>
      <td style="text-align:right">${Number(l.DiscountPercent || 0).toFixed(1)}%</td>
      <td>${escHtml(l.TaxCode || '')}</td>
      <td>${escHtml(l.WarehouseCode || '')}</td>
      ${printTaxCells(amt, i)}
    </tr>`).join('');

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<title>Purchase Order #${doc.DocNum}</title>
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
  .totals{text-align:right;padding:8px 0 20px}
  .total-row{font-size:12px;color:#374151;margin-bottom:4px}
  .total-grand{font-size:15px;font-weight:700;color:#354A5E;margin-top:6px}
  .footer{text-align:center;margin-top:24px;font-size:9px;color:#aaa;border-top:1px solid #eee;padding-top:12px}
  .watermark{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%) rotate(-30deg);font-size:52px;color:rgba(0,0,0,.04);font-weight:900;pointer-events:none;z-index:0}
  @media print{.print-btn{display:none}}
</style></head><body>
<div class="watermark">PURCHASE ORDER</div>
<div class="print-btn">
  <button class="btn-close" onclick="window.parent!==window ? window.parent.postMessage({type:'poa-print-close'},'*') : window.close()">✕ Close</button>
  <button class="btn-print" onclick="window.print()">🖨️ Print</button>
</div>
<div class="header">
  <div><div class="co-name">${escHtml(company)}</div><div style="color:#888;font-size:11px;margin-top:2px">SAP Business One — Purchase Order</div></div>
  <div><div class="doc-title">Purchase Order</div><div style="font-size:13px;color:#444;text-align:right">PO # ${doc.DocNum}</div></div>
</div>
<div class="info-grid">
  <div class="info-box">
    <div class="info-label">Vendor</div>
    <div class="info-val"><strong>${escHtml(doc.CardName || '—')}</strong></div>
    ${doc.CardCode ? `<div class="info-val" style="color:#666">${escHtml(doc.CardCode)}</div>` : ''}
  </div>
  <div class="info-box">
    <div class="info-label">Doc Date / Delivery Date</div>
    <div class="info-val"><strong>${escHtml(docDate)}</strong></div>
    <div class="info-val" style="color:#666">Delivery: ${escHtml(dueDate)}</div>
  </div>
  <div class="info-box">
    <div class="info-label">Reference</div>
    <div class="info-val"><strong>${escHtml(doc.NumAtCard || '—')}</strong></div>
    <div class="info-val" style="color:#666">PO # ${doc.DocNum}</div>
  </div>
</div>
${doc.Comments ? `<div style="border:1px solid #bfdbfe;border-radius:6px;padding:12px;margin-bottom:20px;background:#eff6ff;font-size:11px;line-height:1.6"><strong>📝 Comments:</strong><br><br>${escHtml(doc.Comments)}</div>` : ''}
<table>
  <thead><tr>
    <th>#</th><th>Item Code</th><th>Description</th>
    <th style="text-align:right">Qty</th><th>Unit</th>
    <th style="text-align:right">Unit Price</th><th style="text-align:right">Disc%</th>
    <th>Tax Code</th><th>Warehouse</th>
    ${printTaxHeads()}
  </tr></thead>
  <tbody>${linesHtml}</tbody>
</table>
${printTotalsHtml(amt, { color: '#354A5E', label: 'PO Total' })}
<div class="footer">Printed on ${escHtml(printedOn)} &nbsp;|&nbsp; ${escHtml(company)} — SAP B1 Purchase Order #${doc.DocNum} &nbsp;|&nbsp; Powered by Henny AI Solution</div>
</body></html>`;
}

// ── Router factory ─────────────────────────────────────────────────────────────

// Item-form index for element ids — never reused, so a new form can't clash with an older (locked) one still in the chat.
let _formSeq = Date.now() % 1e6;
const nextFormIdx = () => ++_formSeq;

export function createPurchaseOrderAgentRouter(deps) {
  const { requireAuth, printAuth, getActiveSap } = deps;
  const router = Router();

  // ── POST /chat ─────────────────────────────────────────────────────────────
  router.post('/chat', requireAuth, async (req, res) => {
    try {
      const { message = '', sessionId } = req.body;
      const sid = sessionId || `po_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      if (!_sessions.has(sid)) _sessions.set(sid, initSession());
      const session = _sessions.get(sid);
      const sap     = getActiveSap();
      let   msg     = message.trim();
      // Typing "done" at the add-item step does the same as the Done Adding Items button.
      if (session.step === 'ADD_ITEM' && /^(done|finish(ed)?|review|no more( items)?|that'?s all)[.!]?$/i.test(msg)) {
        msg = JSON.stringify({ action: 'done_items' });
      }
      // "Retry" after a failed post re-sends the same order.
      if (session.step === 'REVIEW_FORM' && session._failedPost && /^retry[.!]?$/i.test(msg)) {
        msg = JSON.stringify(session._failedPost);
      }
      const msgL    = msg.toLowerCase();

      if (msg) session.history.push({ role: 'user', content: msg });

      let reply        = '';
      let quickReplies = [];
      let meta         = {};
      let vendorList   = null;

      // Final review card: header + rows editable through ✏️ buttons; every render gets a new seq and only
      // the newest card can post.
      const reviewCard = () => {
        session.reviewSeq = (session.reviewSeq || 0) + 1;
        const h = session._header || {};
        const items = getCacheItems();
        const names = new Map(items.map(i => [i.ItemCode, i.ItemName]));
        return buildReviewCard({
          title: '📋 Purchase Order Ready to Post', partyLabel: 'Vendor',
          party: { code: session.selectedVendor?.cardCode, name: session.selectedVendor?.cardName },
          seq: session.reviewSeq, send: 'poaSend', postAction: 'post_po', postLabel: '✅ Post Purchase Order',
          addRow: { items: items.map(i => ({ code: i.ItemCode, name: i.ItemName })), priceApi: '/api/po-agent', sessionId: sid },
          header: [
            { key: 'docDate', label: 'Posting Date', type: 'date', value: h.docDate || today() },
            { key: 'deliveryDate', label: 'Delivery Date', type: 'date', value: h.deliveryDate || datePlusDays(7) },
            { key: 'reference', label: 'Vendor Reference', value: h.reference || '', placeholder: 'Optional — vendor ref. no.' },
            { key: 'comments', label: 'Comments', value: h.comments || '', placeholder: 'Optional' },
          ],
          lines: (session._lines || []).map(l => ({ ...l, itemName: names.get(l.itemCode) || '' })),
          taxCodes: getCacheTaxCodes(), warehouses: getCacheWarehouses(),
        });
      };

      // ── JSON actions ───────────────────────────────────────────────────────
      if (msg.startsWith('{')) {
        let action = null;
        try { action = JSON.parse(msg); } catch {}

        // ── Card from an earlier step → refused; edits happen only on the latest card ──
        if (action?.action && STEP_OF[action.action] && !STEP_OF[action.action].includes(session.step)) {
          if (session.step === 'DONE') {
            reply = `This Purchase Order is already posted (#${escHtml(session.result?.docNum ?? '')}). Start a new one to create another.`;
            quickReplies = ['Create New Purchase Order'];
          } else {
            reply = `<div style="color:#b45309;margin-bottom:6px">⚠️ That step is already finished — use the latest card${session.step === 'REVIEW_FORM' ? ' (✏️ Edit Header, or ✏️ on a row)' : ''}.</div>${session.step === 'REVIEW_FORM' ? reviewCard() : ''}`;
          }
        }

        // ── Post Purchase Order (once, from the newest review card only) ────
        else if (action?.action === 'post_po' && Number(action.seq) !== session.reviewSeq) {
          reply = `<div style="color:#b45309;margin-bottom:6px">⚠️ That review card is out of date — use this one.</div>${reviewCard()}`;
        }
        else if (action?.action === 'post_po' && session._posting) {
          reply = '⏳ This Purchase Order is already being posted — please wait.';
        }
        else if (action?.action === 'post_po') {
          // lock before the first await (the SAP item checks) so a second click can't slip in
          session._posting = true;
          try {
            const rp = readReviewPost(action, session._lines, HEADER_KEYS, { allowNew: true });
            if (rp.ok) {
              const noPrice = rp.lines.findIndex(l => !(Number(l.unitPrice) > 0));
              if (noPrice >= 0) { rp.ok = false; rp.error = `Row ${noPrice + 1} (${rp.lines[noPrice].itemCode}): a Purchase Order needs a unit price greater than 0 on every line.`; }
            }
            if (rp.ok) {
              for (const l of rp.lines.filter(x => x.isNew)) {
                let it = null;
                try { it = await sap.get(`/Items('${encodeURIComponent(l.itemCode.replace(/'/g, "''"))}')`, { $select: 'ItemCode,ItemName,PurchaseItem,Frozen' }); } catch { it = null; }
                if (!it?.ItemCode) { rp.ok = false; rp.error = `Item ${l.itemCode} was not found in SAP.`; break; }
                if (it.PurchaseItem === 'tNO') { rp.ok = false; rp.error = `${it.ItemCode} is not a purchase item.`; break; }
                if (it.Frozen === 'tYES') { rp.ok = false; rp.error = `${it.ItemCode} is inactive (frozen) in SAP.`; break; }
                l.itemCode = it.ItemCode;
                delete l.isNew;
              }
            }
            if (!rp.ok) {
              reply = `<div style="color:#b91c1c;margin-bottom:6px">❌ ${escHtml(rp.error)}</div>${reviewCard()}`;
            } else {
              session._lines = withAmounts(rp.lines);
              session._header = rp.header;
              const lines = session._lines, h = rp.header;
              try {
                const uomCodes = await Promise.all(lines.map(l => getDefaultUoMCode(l.itemCode, sap)));
                const payload = {
                  CardCode:    session.selectedVendor.cardCode,
                  DocDate:     sapDate(h.docDate       || today()),
                  DocDueDate:  sapDate(h.deliveryDate  || datePlusDays(7)),
                  ...(h.reference ? { NumAtCard: h.reference } : {}),
                  ...(h.comments  ? { Comments:  h.comments  } : {}),
                  DocumentLines: lines.map((l, i) => ({
                    ItemCode:        l.itemCode,
                    Quantity:        Number(l.quantity  || 1),
                    UnitPrice:       Number(l.unitPrice || 0),
                    DiscountPercent: Number(l.discountPercent || 0),
                    ...(l.taxCode       ? { TaxCode: l.taxCode }             : {}),
                    ...(l.warehouseCode ? { WarehouseCode: l.warehouseCode } : {}),
                    ...(uomCodes[i]     ? { UoMCode: uomCodes[i] }           : {}),
                  })),
                };

                const result = await sap.post('/PurchaseOrders', payload);
                session.result = { docEntry: result.DocEntry, docNum: result.DocNum };
                session.step   = 'DONE';
                delete session._failedPost;

                // amounts as SAP calculated them; if SAP didn't send the document back, estimate from the rates
                const amt = resultAmounts(result, lines, getCacheTaxCodes());
                const cur = escHtml(amt.currency);

                const linesHtml = lines.map((l, i) => `
                  <tr style="border-bottom:1px solid #f3f4f6">
                    <td style="padding:6px 10px;font-size:12.5px;text-align:center">${i+1}</td>
                    <td style="padding:6px 10px;font-size:12.5px;font-weight:600">${escHtml(l.itemCode)}</td>
                    <td style="padding:6px 10px;font-size:12.5px;text-align:right">${l.quantity}</td>
                    <td style="padding:6px 10px;font-size:12.5px;text-align:right">${Number(l.unitPrice).toFixed(2)}</td>
                    <td style="padding:6px 10px;font-size:12.5px;text-align:right">${l.discountPercent || 0}%</td>
                    <td style="padding:6px 10px;font-size:12.5px">${escHtml(l.taxCode||'')}</td>
                    <td style="padding:6px 10px;font-size:12.5px">${escHtml(l.warehouseCode||'')}</td>
                    <td style="padding:6px 10px;font-size:12.5px;text-align:right">${money(amt.lines[i].net)}</td>
                    <td style="padding:6px 10px;font-size:12.5px;text-align:right;color:#6b7280">${money(amt.lines[i].tax)}</td>
                    <td style="padding:6px 10px;font-size:12.5px;text-align:right;font-weight:600">${money(amt.lines[i].gross)}</td>
                  </tr>`).join('');

                const printUrl = `/api/po-agent/print/${result.DocEntry}`;

                reply = `<div style="background:#eff6ff;border:1.5px solid #0070F2;border-radius:10px;padding:16px;margin:4px 0">
                  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
                    <div style="font-size:15px;font-weight:700;color:#1d4ed8">✅ Purchase Order Created Successfully</div>
                    <button onclick="poaShowPrintModal('${printUrl}')"
                      style="background:#0070F2;color:#fff;border:none;border-radius:6px;padding:7px 18px;font-size:13px;font-weight:600;cursor:pointer;display:flex;align-items:center;gap:6px">
                      🖨️ Print
                    </button>
                  </div>
                  <table style="width:100%;border-collapse:collapse;margin-bottom:14px">
                    <tbody>
                      <tr style="background:#dbeafe">
                        <td style="padding:7px 12px;font-size:12px;font-weight:700;color:#1d4ed8;width:35%">PO Number</td>
                        <td style="padding:7px 12px;font-size:13.5px;font-weight:700;color:#0070F2">#${result.DocNum}</td>
                      </tr>
                      <tr><td style="padding:7px 12px;font-size:12px;color:#6b7280">Doc Entry</td><td style="padding:7px 12px;font-size:12.5px">${result.DocEntry}</td></tr>
                      <tr style="background:#f9fafb"><td style="padding:7px 12px;font-size:12px;color:#6b7280">Vendor</td><td style="padding:7px 12px;font-size:12.5px;font-weight:600">${escHtml(session.selectedVendor.cardName||'')} (${escHtml(session.selectedVendor.cardCode||'')})</td></tr>
                      <tr><td style="padding:7px 12px;font-size:12px;color:#6b7280">Posting Date</td><td style="padding:7px 12px;font-size:12.5px">${escHtml(h.docDate||today())}</td></tr>
                      <tr style="background:#f9fafb"><td style="padding:7px 12px;font-size:12px;color:#6b7280">Delivery Date</td><td style="padding:7px 12px;font-size:12.5px">${escHtml(h.deliveryDate||datePlusDays(7))}</td></tr>
                      ${h.reference ? `<tr><td style="padding:7px 12px;font-size:12px;color:#6b7280">Vendor Reference</td><td style="padding:7px 12px;font-size:12.5px">${escHtml(h.reference)}</td></tr>` : ''}
                      <tr><td style="padding:7px 12px;font-size:12px;color:#6b7280">Total Lines</td><td style="padding:7px 12px;font-size:12.5px">${lines.length} item(s)</td></tr>
                      <tr style="background:#f9fafb"><td style="padding:7px 12px;font-size:12px;color:#6b7280">PO Total</td><td style="padding:7px 12px;font-size:13px;font-weight:700;color:#0070F2">${money(amt.total)} ${cur} <span style="font-size:11.5px;font-weight:400;color:#6b7280">(tax ${money(amt.tax)})</span></td></tr>
                    </tbody>
                  </table>
                  <div style="font-size:11px;font-weight:700;color:#374151;text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px">Line Items</div>
                  <div style="overflow-x:auto">
                    <table style="width:100%;border-collapse:collapse;min-width:460px">
                      <thead>
                        <tr style="background:#dbeafe;font-size:10.5px;font-weight:700;color:#1d4ed8;text-transform:uppercase;letter-spacing:.04em">
                          <th style="padding:6px 10px;text-align:center;width:32px">#</th>
                          <th style="padding:6px 10px;text-align:left">Item Code</th>
                          <th style="padding:6px 10px;text-align:right">Qty</th>
                          <th style="padding:6px 10px;text-align:right">Unit Price</th>
                          <th style="padding:6px 10px;text-align:right">Disc%</th>
                          <th style="padding:6px 10px;text-align:left">Tax</th>
                          <th style="padding:6px 10px;text-align:left">WH</th>
                          <th style="padding:6px 10px;text-align:right">Net</th>
                          <th style="padding:6px 10px;text-align:right">Tax</th>
                          <th style="padding:6px 10px;text-align:right">Total</th>
                        </tr>
                      </thead>
                      <tbody>${linesHtml}</tbody>
                    </table>
                  </div>
                  ${cardTotalsHtml(amt, { color: '#1d4ed8', label: 'PO Total' })}
                </div>`;
                quickReplies = ['Create New Purchase Order'];
                meta = { docEntry: result.DocEntry, docNum: result.DocNum, printUrl };
              } catch (e) {
                // fresh editable card with the values just sent; "Retry" re-posts them from that card
                const card = reviewCard();
                session._failedPost = { ...action, seq: session.reviewSeq };
                reply = `<div style="color:#b91c1c;font-weight:700;margin-bottom:4px">❌ Failed to post Purchase Order</div>
                  <div style="font-size:13px;margin-bottom:6px">SAP Error: <em>${escHtml(e.message)}</em></div>
                  <div style="font-size:13px;margin-bottom:6px">Fix it on the card below (✏️ Edit Header / ✏️ on a row) and post again, click <strong>Retry</strong> to post it unchanged, or <strong>Cancel</strong>.</div>${card}`;
                quickReplies = ['Retry', 'Cancel'];
              }
            }
          } finally {
            session._posting = false;
          }
        }

        // ── Select vendor from combo ────────────────────────────────────────
        else if (action?.action === 'select_vendor') {
          const { cardCode, cardName } = action;
          session.selectedVendor = { cardCode, cardName };
          session.step = 'ADD_ITEM';
          session._lineIdx = nextFormIdx();
          session._lines   = [];
          const items = getCacheItems(); const taxes = getCacheTaxCodes(); const whs = getCacheWarehouses();
          reply = `<div style="background:#eff6ff;border:1px solid #0070F2;border-radius:6px;padding:10px 14px;margin-bottom:8px">
            ✅ Vendor: <strong>${escHtml(cardName)}</strong> (${escHtml(cardCode)})
          </div>
          <div style="font-size:13px;color:#374151;margin-bottom:6px">Now add <strong>line items</strong> to the purchase order:</div>
          ${buildItemLineHtml(items, taxes, whs, session._lineIdx, !!session._lines?.length)}`;
        }

        // ── Add line item from combo ────────────────────────────────────────
        else if (action?.action === 'add_item') {
          if (!action.itemCode) {
            reply = '❌ Please select an item first.';
          } else if (!(Number(action.unitPrice) > 0)) {
            const items = getCacheItems(); const taxes = getCacheTaxCodes(); const whs = getCacheWarehouses();
            session._lineIdx = nextFormIdx();
            reply = `<div style="color:#b91c1c;margin-bottom:8px">⚠️ A Purchase Order needs a <strong>unit price</strong> greater than 0 for every line. Please enter a price.</div>${buildItemLineHtml(items, taxes, whs, session._lineIdx, !!session._lines?.length)}`;
          } else {
            if (!session._lines) session._lines = [];
            const { action: _a, ...line } = action;
            session._lines.push(withAmounts([line])[0]);
            session._lineIdx = nextFormIdx();
            const items = getCacheItems(); const taxes = getCacheTaxCodes(); const whs = getCacheWarehouses();
            reply = `<div style="background:#eff6ff;border:1px solid #0070F2;border-radius:6px;padding:8px 14px;margin-bottom:8px">
              <div style="font-size:12px;font-weight:700;color:#1d4ed8;margin-bottom:6px">✅ Item added — ${session._lines.length} line(s) so far:</div>
              ${linesSummaryTable(session._lines)}
            </div>
            <div style="font-size:13px;color:#374151;margin-bottom:6px">Add another item or click <strong>Done Adding Items</strong>:</div>
            ${buildItemLineHtml(items, taxes, whs, session._lineIdx, !!session._lines?.length)}`;
            session.step = 'ADD_ITEM';
          }
        }

        // ── Done adding items → show review / post card ─────────────────────
        else if (action?.action === 'done_items') {
          if (!session._lines?.length) {
            const items = getCacheItems(); const taxes = getCacheTaxCodes(); const whs = getCacheWarehouses();
            session._lineIdx = nextFormIdx();
            reply = `<div style="color:#b91c1c;margin-bottom:8px">⚠️ Please add at least one item.</div>${buildItemLineHtml(items, taxes, whs, session._lineIdx, !!session._lines?.length)}`;
          } else {
            session.step = 'REVIEW_FORM';
            reply = reviewCard();
          }
        }

        // ── Add more items ───────────────────────────────────────────────────
        else if (action?.action === 'add_more_items') {
          session.step = 'ADD_ITEM';
          session._lineIdx = nextFormIdx();
          const items = getCacheItems(); const taxes = getCacheTaxCodes(); const whs = getCacheWarehouses();
          reply = `<div style="font-size:13px;margin-bottom:6px">Add another item:</div>${buildItemLineHtml(items, taxes, whs, session._lineIdx, !!session._lines?.length)}`;
        }

        else {
          reply = 'Unexpected action. Please start over.';
          quickReplies = ['Start Over'];
        }
      }

      // ── INIT / SELECT_VENDOR — vendor combo from cache ─────────────────────
      else if (session.step === 'INIT' || session.step === 'SELECT_VENDOR') {
        if (!msg) {
          const cached = getCacheVendors();
          reply = `<div style="font-size:13.5px;font-weight:600;margin-bottom:6px">📦 Welcome to the <strong>Purchase Order Agent</strong>!</div>
            <div style="font-size:13px;color:#374151;margin-bottom:8px">Select the <strong>Vendor</strong> for this purchase order:</div>
            ${buildVendorComboHtml(cached)}`;
          session.step = 'INIT';
        } else if (/start over|reset|cancel/i.test(msgL)) {
          Object.assign(session, initSession());
          const cached = getCacheVendors();
          reply = `<div style="margin-bottom:6px">Session reset.</div>${buildVendorComboHtml(cached)}`;
          session.step = 'INIT';
        } else {
          const vendors = await searchVendors(sap, msg);
          if (!vendors.length) {
            const cached = getCacheVendors();
            reply = `<div style="color:#b91c1c;margin-bottom:8px">No vendors found matching <strong>"${escHtml(msg)}"</strong>. Try selecting from the list:</div>${buildVendorComboHtml(cached)}`;
          } else if (vendors.length === 1) {
            const v = vendors[0];
            session.selectedVendor = { cardCode: v.CardCode, cardName: v.CardName };
            session.step = 'ADD_ITEM';
            session._lineIdx = nextFormIdx(); session._lines = [];
            const items = getCacheItems(); const taxes = getCacheTaxCodes(); const whs = getCacheWarehouses();
            reply = `<div style="background:#eff6ff;border:1px solid #0070F2;border-radius:6px;padding:10px 14px;margin-bottom:8px">
              ✅ Vendor: <strong>${escHtml(v.CardName)}</strong> (${escHtml(v.CardCode)})
            </div>${buildItemLineHtml(items, taxes, whs, session._lineIdx, !!session._lines?.length)}`;
          } else {
            vendorList = vendors.map(v => ({ cardCode: v.CardCode, cardName: v.CardName }));
            reply = `<div style="margin-bottom:8px">Found <strong>${vendors.length}</strong> matches. Select one:</div>${buildVendorComboHtml(vendors)}`;
            session.step = 'SELECT_VENDOR';
          }
        }
      }

      // ── ADD_ITEM — text typed in the chat box: cancel, or search items ────
      else if (session.step === 'ADD_ITEM') {
        if (/start over|reset|cancel/i.test(msgL)) {
          Object.assign(session, initSession());
          reply = `<div style="margin-bottom:6px">Session reset.</div>${buildVendorComboHtml(getCacheVendors())}`;
          session.step = 'INIT';
        } else {
          const found = await searchItems(sap, msg);
          const taxes = getCacheTaxCodes(); const whs = getCacheWarehouses();
          // New form index so its element ids don't clash with the form already in the chat.
          session._lineIdx = nextFormIdx();
          reply = found.length
            ? `<div style="font-size:13px;margin-bottom:6px">Found <strong>${found.length}</strong> item(s) matching <strong>"${escHtml(msg)}"</strong>. Select one:</div>${buildItemLineHtml(found, taxes, whs, session._lineIdx, !!session._lines?.length)}`
            : `<div style="color:#b91c1c;margin-bottom:8px">No items found matching <strong>"${escHtml(msg)}"</strong>. Try another code or name, or select from the list:</div>${buildItemLineHtml(getCacheItems(), taxes, whs, session._lineIdx, !!session._lines?.length)}`;
          quickReplies = (session._lines || []).length ? ['Done'] : [];
        }
      }

      // ── REVIEW_FORM — awaiting post; earlier steps are closed ─────────────
      else if (session.step === 'REVIEW_FORM') {
        if (/cancel|start over/i.test(msgL)) {
          Object.assign(session, initSession());
          reply = 'Cancelled. Type a vendor name or code to start again:';
          session.step = 'INIT';
        } else {
          // earlier steps are closed — changes happen on the review card itself
          reply = `<div style="margin-bottom:6px">Make changes on the review card: <strong>✏️ Edit Header</strong> for dates / vendor reference / comments, <strong>✏️</strong> on a row for qty / price / disc / tax / warehouse, <strong>+ Add Row</strong> to add an item. To pick another vendor, type <strong>cancel</strong> and start again.</div>${reviewCard()}`;
        }
      }

      // ── DONE ──────────────────────────────────────────────────────────────
      else if (session.step === 'DONE') {
        if (/yes|another|more|create|new/i.test(msgL)) {
          Object.assign(session, initSession());
          const cached = getCacheVendors();
          reply = `<div style="margin-bottom:6px;font-size:13px">Starting a new purchase order. Select the vendor:</div>${buildVendorComboHtml(cached)}`;
          session.step = 'INIT';
        } else {
          reply = 'Purchase order complete.';
          quickReplies = ['Create Another'];
        }
      }

      // ── Fallback ──────────────────────────────────────────────────────────
      else {
        Object.assign(session, initSession());
        reply = 'Session reset. Type a vendor name or code to begin:';
        session.step = 'INIT';
      }

      session.history.push({ role: 'assistant', content: reply });
      if (session.history.length > 40) session.history.splice(0, session.history.length - 40);

      res.json({
        ok: true, reply, quickReplies, sessionId: sid,
        step: session.step,
        meta, vendorList,
        // Feeds the "PO Builder" sidebar
        summary: { vendor: session.selectedVendor || null, lines: session._lines || [], result: session.result || null },
      });

    } catch (e) {
      console.error('[PO-Agent] chat error:', e);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ── GET /item-price — the vendor's price for an item added on the review card ─
  // SAP's own pricing for the vendor (CompanyService_GetItemPrice: the vendor's price list, special
  // prices, discounts). getItemPrice's fallback (a base price list other than the BP's) is meant for
  // sales, so it is not used here — with no vendor price the card asks for the price to be entered.
  router.get('/item-price', requireAuth, async (req, res) => {
    try {
      const cardCode = _sessions.get(String(req.query.sessionId || ''))?.selectedVendor?.cardCode;
      const itemCode = String(req.query.itemCode || '').trim();
      if (!cardCode || !itemCode) return res.json({ ok: false, error: 'vendor and item required' });
      const r = await getItemPrice(getActiveSap(), { cardCode, itemCode, qty: req.query.qty });
      if (r.source !== 'customer') return res.json({ ok: true, price: 0, currency: '', source: 'none' });
      res.json({ ok: true, ...r, source: 'vendor' });
    } catch (e) {
      res.json({ ok: false, error: e.message });
    }
  });

  // ── POST /reset ────────────────────────────────────────────────────────────
  router.post('/reset', requireAuth, (req, res) => {
    const { sessionId } = req.body || {};
    if (sessionId) _sessions.delete(sessionId);
    res.json({ ok: true });
  });

  // ── GET /print/:docEntry ───────────────────────────────────────────────────
  router.get('/print/:docEntry', printAuth, async (req, res) => {
    try {
      const sap = getActiveSap();
      const doc = await sap.get(`/PurchaseOrders(${parseInt(req.params.docEntry, 10)})`);
      res.setHeader('Content-Type', 'text/html');
      res.send(renderPOPrint(doc));
    } catch (e) {
      res.status(500).send(`<pre style="color:red">Error loading purchase order #${req.params.docEntry}: ${e.message}</pre>`);
    }
  });

  return router;
}
