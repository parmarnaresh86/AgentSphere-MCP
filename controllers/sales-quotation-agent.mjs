/**
 * Sales Quotation Agent
 *  1. Search & select customer
 *  2. Open form modal — fill header + line items (item search supported)
 *  3. Post new Sales Quotation to SAP B1
 *  4. Show success with print link
 */
import { Router } from 'express';
import { itemPriceRoute } from '../lib/item-price.mjs';
import db, { connRepo } from '../db.mjs';

const _sessions = new Map();

function initSession() {
  return {
    step:             'INIT',
    history:          [],
    selectedCustomer: null,  // { cardCode, cardName }
    result:           null,  // { docEntry, docNum } after post
  };
}

function today() { return new Date().toISOString().slice(0, 10); }
function datePlusDays(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}
function sapDate(s) { const d = s || today(); return d.length === 10 ? `${d}T00:00:00` : d; }
function fmtN(n, d = 2) {
  if (n == null || isNaN(Number(n))) return '—';
  return Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}
function escHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Cache helpers ──────────────────────────────────────────────────────────────

function getCompanyId() {
  const conn = connRepo.getActive();
  return conn ? conn.company : 'default';
}

function getCacheCustomers() {
  const cid = getCompanyId();
  return db.prepare(`SELECT CardCode, CardName, City FROM cache_business_partners
    WHERE company_id=? AND CardType='cCustomer' AND Frozen='tNO' ORDER BY CardName LIMIT 500`).all(cid);
}

function getCacheItems() {
  const cid = getCompanyId();
  return db.prepare(`SELECT ItemCode, ItemName, SalesUnit, SalesVATGroup, QuantityOnStock
    FROM cache_items WHERE company_id=? AND Frozen='tNO' ORDER BY ItemName LIMIT 500`).all(cid);
}

function getCacheTaxCodes() {
  const cid = getCompanyId();
  return db.prepare(`SELECT Code, Name FROM cache_tax_codes WHERE company_id=? ORDER BY Code`).all(cid);
}

function getCacheWarehouses() {
  const cid = getCompanyId();
  return db.prepare(`SELECT WarehouseCode, WarehouseName FROM cache_warehouses WHERE company_id=? AND Inactive='tNO' ORDER BY WarehouseCode`).all(cid);
}

// ── HTML combo builders (rendered inside agent reply) ─────────────────────────

function buildCustomerComboHtml(customers) {
  const opts = customers.map(c =>
    `<option value="${escHtml(c.CardCode)}">${escHtml(c.CardCode)} — ${escHtml(c.CardName)}${c.City ? ' ('+escHtml(c.City)+')' : ''}</option>`
  ).join('');
  const noCache = !customers.length
    ? `<div style="color:#ef4444;font-size:12px;margin-bottom:8px">⚠️ Customer cache is empty — go to <strong>Tools → Data Sync</strong> to load master data, or type in the box below to search live.</div>` : '';
  const customersJson = escHtml(JSON.stringify(customers.map(c => ({ code: c.CardCode, name: c.CardName, city: c.City || '' }))));
  return `<div style="background:#f0fdf4;border:1.5px solid #10b981;border-radius:8px;padding:14px;margin:6px 0" data-customers="${customersJson}">
    ${noCache}
    <div style="font-size:12px;font-weight:700;color:#065f46;margin-bottom:8px">Select Customer (${customers.length} available):</div>
    <input type="text" placeholder="🔍 Search customer by name or code…" oninput="sqFilterCustomers(this)"
      style="width:100%;border:1.5px solid #d1d5db;border-radius:6px;padding:7px 10px;font-size:13px;margin-bottom:6px;box-sizing:border-box;outline:none">
    <div style="display:flex;gap:8px;align-items:center;margin-bottom:6px">
      <select id="sq-cust-sel"
        style="flex:1;border:1.5px solid #10b981;border-radius:6px;padding:7px 10px;font-size:13px;background:#fff;outline:none">
        <option value="">— Select a Customer —</option>
        ${opts}
      </select>
      <button onclick="sqComboSelectCustomer()"
        style="background:#15803d;color:#fff;border:none;border-radius:6px;padding:8px 18px;font-size:13px;font-weight:700;cursor:pointer;white-space:nowrap">
        Select →
      </button>
    </div>
    <div style="font-size:11.5px;color:#6b7280">Type above to filter the list, or type a name / code in the chat box below to search live SAP data</div>
  </div>`;
}

function buildItemLineHtml(items, taxCodes, warehouses, lineIdx) {
  const itemOpts = items.map(i =>
    `<option value="${escHtml(i.ItemCode)}" data-name="${escHtml(i.ItemName)}" data-unit="${escHtml(i.SalesUnit||'')}" data-vat="${escHtml(i.SalesVATGroup||'')}">${escHtml(i.ItemCode)} — ${escHtml(i.ItemName)}</option>`
  ).join('');
  const taxOpts = [`<option value="">— None —</option>`, ...taxCodes.map(t =>
    `<option value="${escHtml(t.Code)}">${escHtml(t.Code)}${t.Name?' — '+escHtml(t.Name):''}</option>`)].join('');
  const whOpts  = [`<option value="">— Default —</option>`, ...warehouses.map(w =>
    `<option value="${escHtml(w.WarehouseCode)}">${escHtml(w.WarehouseCode)}</option>`)].join('');
  const noCache = !items.length
    ? `<div style="color:#ef4444;font-size:12px;margin-bottom:8px">⚠️ Item cache is empty — go to <strong>Tools → Data Sync</strong> first, or type item code below.</div>` : '';
  const itemsJson = escHtml(JSON.stringify(items.map(i => ({ code: i.ItemCode, name: i.ItemName, unit: i.SalesUnit || '', vat: i.SalesVATGroup || '' }))));
  return `<div style="background:#f0fdf4;border:1.5px solid #10b981;border-radius:8px;padding:14px;margin:6px 0" data-items="${itemsJson}">
    ${noCache}
    <div style="font-size:12px;font-weight:700;color:#065f46;margin-bottom:8px">Add Line Item (${items.length} items available):</div>
    <div style="margin-bottom:8px">
      <div style="font-size:11px;color:#6b7280;margin-bottom:3px">Item *</div>
      <input type="text" placeholder="🔍 Search item by name or code…" oninput="sqFilterItems(this,${lineIdx})"
        style="width:100%;border:1.5px solid #d1d5db;border-radius:6px;padding:7px 10px;font-size:13px;margin-bottom:6px;box-sizing:border-box;outline:none">
      <select id="sq-item-sel-${lineIdx}" onchange="sqComboItemChange(this,${lineIdx})"
        style="width:100%;border:1.5px solid #d1d5db;border-radius:6px;padding:7px 10px;font-size:13px;background:#fff;outline:none">
        <option value="">— Select an Item —</option>
        ${itemOpts}
      </select>
    </div>
    <div style="display:grid;grid-template-columns:80px 110px 70px 1fr 1fr;gap:8px;margin-bottom:10px">
      <div>
        <div style="font-size:11px;color:#6b7280;margin-bottom:3px">Qty *</div>
        <input type="number" id="sq-qty-${lineIdx}" value="1" min="0.001" step="0.001" onchange="sqComboLoadPrice(${lineIdx})"
          style="width:100%;border:1.5px solid #d1d5db;border-radius:6px;padding:6px 8px;font-size:13px;box-sizing:border-box">
      </div>
      <div>
        <div style="font-size:11px;color:#6b7280;margin-bottom:3px">Unit Price</div>
        <input type="number" id="sq-price-${lineIdx}" placeholder="auto" min="0" step="0.01" oninput="this.dataset.manual='1'"
          style="width:100%;border:1.5px solid #d1d5db;border-radius:6px;padding:6px 8px;font-size:13px;box-sizing:border-box">
        <div id="sq-price-note-${lineIdx}" style="font-size:10.5px;color:#6b7280;margin-top:2px;min-height:13px"></div>
      </div>
      <div>
        <div style="font-size:11px;color:#6b7280;margin-bottom:3px">Disc%</div>
        <input type="number" id="sq-disc-${lineIdx}" value="0" min="0" max="100"
          style="width:100%;border:1.5px solid #d1d5db;border-radius:6px;padding:6px 8px;font-size:13px;box-sizing:border-box">
      </div>
      <div>
        <div style="font-size:11px;color:#6b7280;margin-bottom:3px">Tax Code</div>
        <select id="sq-tax-${lineIdx}"
          style="width:100%;border:1.5px solid #d1d5db;border-radius:6px;padding:6px 8px;font-size:12.5px;background:#fff">${taxOpts}</select>
      </div>
      <div>
        <div style="font-size:11px;color:#6b7280;margin-bottom:3px">Warehouse</div>
        <select id="sq-wh-${lineIdx}"
          style="width:100%;border:1.5px solid #d1d5db;border-radius:6px;padding:6px 8px;font-size:12.5px;background:#fff">${whOpts}</select>
      </div>
    </div>
    <div style="display:flex;gap:8px">
      <button onclick="sqComboAddItem(${lineIdx})"
        style="background:#15803d;color:#fff;border:none;border-radius:6px;padding:8px 18px;font-size:13px;font-weight:700;cursor:pointer">
        + Add Line
      </button>
      <button onclick="sqComboDoneItems()"
        style="background:#f3f4f6;color:#374151;border:1px solid #d1d5db;border-radius:6px;padding:8px 14px;font-size:12.5px;cursor:pointer">
        ✓ Done Adding Items
      </button>
    </div>
  </div>`;
}

// ── SAP helpers ────────────────────────────────────────────────────────────────

async function searchCustomers(sap, query) {
  try {
    const q = query.replace(/'/g, "''");
    const r = await sap.get('/BusinessPartners', {
      $filter:  `CardType eq 'cCustomer' and (substringof('${q}',CardName) or substringof('${q}',CardCode))`,
      $select:  'CardCode,CardName',
      $orderby: 'CardName',
      $top:     20,
    });
    return Array.isArray(r.value) ? r.value : [];
  } catch (e) {
    console.error('[SQ] searchCustomers error:', e.message);
    return [];
  }
}

function buildFormData(customer) {
  return {
    cardCode:   customer.cardCode,
    cardName:   customer.cardName,
    docDate:    today(),
    validUntil: datePlusDays(30),
    reference:  '',
    comments:   '',
    lines:      [],
  };
}

// ── Print layout ───────────────────────────────────────────────────────────────

function renderPrintLayout(doc) {
  const company   = process.env.SAP_B1_COMPANY || process.env.SL_COMPANY || 'Company';
  const lines     = doc.DocumentLines || [];
  const docDate   = doc.DocDate    ? doc.DocDate.slice(0, 10)    : '—';
  const validUntil = doc.DocDueDate ? doc.DocDueDate.slice(0, 10) : '—';
  const printedOn = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  const grandTotal = lines.reduce((s, l) => s + Number(l.LineTotal || 0), 0);
  const taxTotal   = lines.reduce((s, l) => s + Number(l.VatSum   || 0), 0);

  const linesHtml = lines.map((l, i) => `
    <tr>
      <td>${i + 1}</td>
      <td><strong>${escHtml(l.ItemCode || '')}</strong></td>
      <td>${escHtml(l.ItemDescription || '')}</td>
      <td style="text-align:right">${Number(l.Quantity   || 0).toFixed(2)}</td>
      <td>${escHtml(l.UoMCode || l.MeasureUnit || '')}</td>
      <td style="text-align:right">${Number(l.UnitPrice  || 0).toFixed(2)}</td>
      <td style="text-align:right">${Number(l.DiscountPercent || 0).toFixed(1)}%</td>
      <td style="text-align:right">${Number(l.LineTotal  || 0).toFixed(2)}</td>
      <td>${escHtml(l.TaxCode || '')}</td>
    </tr>`).join('');

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<title>Sales Quotation #${doc.DocNum}</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:Arial,sans-serif;font-size:11px;color:#222;padding:28px 36px;max-width:980px;margin:auto}
  .print-btn{margin-bottom:16px;display:flex;gap:8px;justify-content:flex-end}
  .print-btn button{padding:8px 18px;border:none;border-radius:6px;cursor:pointer;font-size:13px;font-weight:600}
  .btn-print{background:#15803d;color:#fff}.btn-close{background:#eee;color:#333}
  .header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:24px;padding-bottom:16px;border-bottom:3px solid #15803d}
  .co-name{font-size:20px;font-weight:700;color:#1a1d27}
  .doc-title{font-size:18px;font-weight:700;color:#15803d;text-align:right}
  .info-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-bottom:20px}
  .info-box{border:1px solid #ddd;border-radius:6px;padding:12px}
  .info-label{font-size:9px;font-weight:700;text-transform:uppercase;color:#888;letter-spacing:.06em;margin-bottom:6px}
  .info-val{font-size:12px;color:#222;margin-bottom:2px}
  table{width:100%;border-collapse:collapse;margin-bottom:16px}
  thead tr{background:#15803d}
  th{padding:8px 10px;text-align:left;font-size:10px;font-weight:700;text-transform:uppercase;color:#fff}
  td{padding:7px 10px;border-bottom:1px solid #eee;font-size:11px}
  tr:nth-child(even) td{background:#f0fdf4}
  .totals{text-align:right;padding:8px 0 20px}
  .total-row{font-size:12px;color:#374151;margin-bottom:4px}
  .total-grand{font-size:15px;font-weight:700;color:#15803d;margin-top:6px}
  .footer{text-align:center;margin-top:24px;font-size:9px;color:#aaa;border-top:1px solid #eee;padding-top:12px}
  .watermark{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%) rotate(-30deg);font-size:52px;color:rgba(0,0,0,.04);font-weight:900;pointer-events:none;z-index:0}
  @media print{.print-btn{display:none}}
</style></head><body>
<div class="watermark">SALES QUOTATION</div>
<div class="print-btn">
  <button class="btn-close" onclick="window.close()">✕ Close</button>
  <button class="btn-print" onclick="window.print()">🖨️ Print</button>
</div>
<div class="header">
  <div><div class="co-name">${escHtml(company)}</div><div style="color:#888;font-size:11px;margin-top:2px">SAP Business One — Sales Quotation</div></div>
  <div><div class="doc-title">Sales Quotation</div><div style="font-size:13px;color:#444;text-align:right">SQ # ${doc.DocNum}</div></div>
</div>
<div class="info-grid">
  <div class="info-box">
    <div class="info-label">Customer</div>
    <div class="info-val"><strong>${escHtml(doc.CardName || '—')}</strong></div>
    ${doc.CardCode ? `<div class="info-val" style="color:#666">${escHtml(doc.CardCode)}</div>` : ''}
  </div>
  <div class="info-box">
    <div class="info-label">Quotation Date / Valid Until</div>
    <div class="info-val"><strong>${escHtml(docDate)}</strong></div>
    <div class="info-val" style="color:#666">Valid until: ${escHtml(validUntil)}</div>
  </div>
  <div class="info-box">
    <div class="info-label">Customer Reference</div>
    <div class="info-val"><strong>${escHtml(doc.NumAtCard || '—')}</strong></div>
    <div class="info-val" style="color:#666">SQ # ${doc.DocNum}</div>
  </div>
</div>
${doc.Comments ? `<div style="border:1px solid #bbf7d0;border-radius:6px;padding:12px;margin-bottom:20px;background:#f0fdf4;font-size:11px;line-height:1.6"><strong>📝 Remarks:</strong><br><br>${escHtml(doc.Comments)}</div>` : ''}
<table>
  <thead><tr>
    <th>#</th><th>Item Code</th><th>Description</th>
    <th style="text-align:right">Qty</th><th>Unit</th>
    <th style="text-align:right">Unit Price</th><th style="text-align:right">Disc%</th>
    <th style="text-align:right">Total</th><th>Tax</th>
  </tr></thead>
  <tbody>${linesHtml}</tbody>
</table>
<div class="totals">
  ${taxTotal > 0 ? `<div class="total-row">Subtotal: ${(grandTotal - taxTotal).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>` : ''}
  ${taxTotal > 0 ? `<div class="total-row">Tax: ${taxTotal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>` : ''}
  <div class="total-grand">Quotation Total: ${grandTotal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
</div>
<div class="footer">Printed on ${escHtml(printedOn)} &nbsp;|&nbsp; ${escHtml(company)} — SAP B1 Sales Quotation #${doc.DocNum} &nbsp;|&nbsp; Powered by Henny AI Solution</div>
</body></html>`;
}

// ── Router factory ─────────────────────────────────────────────────────────────

export function createSalesQuotationRouter(deps) {
  const { requireAuth, printAuth, getActiveSap } = deps;
  const router = Router();

  // ── GET /items/search ──────────────────────────────────────────────────────
  router.get('/items/search', requireAuth, async (req, res) => {
    const q = (req.query.q || '').trim().replace(/'/g, "''");
    if (!q || q.length < 2) return res.json({ ok: true, items: [] });
    const sap = getActiveSap();
    try {
      const r = await sap.get('/Items', {
        $filter: `ItemType eq 'itItems' and (substringof('${q}',ItemCode) or substringof('${q}',ItemName))`,
        $select: 'ItemCode,ItemName,SalesVATGroup,SalesUnit',
        $top:    15,
      });
      res.json({
        ok: true,
        items: (r.value || []).map(i => ({
          itemCode: i.ItemCode,
          itemName: i.ItemName,
          unit:     i.SalesUnit    || 'EA',
          vatCode:  i.SalesVATGroup || '',
        })),
      });
    } catch (e) {
      console.error('[SQ] items/search error:', e.message);
      res.json({ ok: true, items: [] });
    }
  });

  // ── POST /chat ─────────────────────────────────────────────────────────────
  router.post('/chat', requireAuth, async (req, res) => {
    try {
      const { message = '', sessionId } = req.body;
      const sid = sessionId || `sq_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      if (!_sessions.has(sid)) _sessions.set(sid, initSession());
      const session = _sessions.get(sid);
      const sap     = getActiveSap();
      const msg     = message.trim();
      const msgL    = msg.toLowerCase();

      if (msg) session.history.push({ role: 'user', content: msg });

      let reply        = '';
      let quickReplies = [];
      let meta         = {};
      let customerList = null;
      let formData     = null;

      // ── JSON actions ───────────────────────────────────────────────────────
      if (msg.startsWith('{')) {
        let action = null;
        try { action = JSON.parse(msg); } catch {}

        // ── Post Sales Quotation ───────────────────────────────────────────
        if (action?.action === 'post_quotation') {
          const lines = action.lines || [];
          if (!lines.length) {
            reply = '❌ No lines added. Please add at least one item line before posting.';
            quickReplies = ['Open Quotation Form'];
          } else {
            try {
              const payload = {
                CardCode:    session.selectedCustomer.cardCode,
                DocDate:     sapDate(action.docDate    || today()),
                DocDueDate:  sapDate(action.validUntil || datePlusDays(30)),
                ...(action.reference ? { NumAtCard: action.reference } : {}),
                ...(action.comments  ? { Comments:  action.comments  } : {}),
                DocumentLines: lines.map(l => ({
                  ItemCode:        l.itemCode,
                  Quantity:        Number(l.quantity        || 1),
                  UnitPrice:       Number(l.unitPrice       || 0),
                  DiscountPercent: Number(l.discountPercent || 0),
                  ...(l.taxCode       ? { TaxCode: l.taxCode }             : {}),
                  ...(l.warehouseCode ? { WarehouseCode: l.warehouseCode } : {}),
                })),
              };

              const result = await sap.post('/Quotations', payload);
              session.result = { docEntry: result.DocEntry, docNum: result.DocNum };
              session.step   = 'DONE';

              // Build line items HTML rows
              const linesHtml = lines.map((l, i) => `
                <tr style="border-bottom:1px solid #f3f4f6">
                  <td style="padding:6px 10px;font-size:12.5px;text-align:center">${i+1}</td>
                  <td style="padding:6px 10px;font-size:12.5px;font-weight:600">${escHtml(l.itemCode)}</td>
                  <td style="padding:6px 10px;font-size:12.5px;text-align:right">${l.quantity}</td>
                  <td style="padding:6px 10px;font-size:12.5px;text-align:right">${l.unitPrice != null ? Number(l.unitPrice).toFixed(2) : '—'}</td>
                  <td style="padding:6px 10px;font-size:12.5px;text-align:right">${l.discountPercent || 0}%</td>
                  <td style="padding:6px 10px;font-size:12.5px">${escHtml(l.taxCode||'')}</td>
                  <td style="padding:6px 10px;font-size:12.5px">${escHtml(l.warehouseCode||'')}</td>
                </tr>`).join('');

              const printUrl = `/api/sales-quotation/print/${result.DocEntry}`;

              reply = `<div style="background:#f0fdf4;border:1.5px solid #10b981;border-radius:10px;padding:16px;margin:4px 0">
                <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
                  <div style="font-size:15px;font-weight:700;color:#065f46">✅ Sales Quotation Created Successfully</div>
                  <a href="${printUrl}" target="_blank"
                    style="background:#15803d;color:#fff;border:none;border-radius:6px;padding:7px 18px;font-size:13px;font-weight:600;cursor:pointer;display:flex;align-items:center;gap:6px;text-decoration:none">
                    🖨️ Print
                  </a>
                </div>
                <table style="width:100%;border-collapse:collapse;margin-bottom:14px">
                  <tbody>
                    <tr style="background:#dcfce7">
                      <td style="padding:7px 12px;font-size:12px;font-weight:700;color:#065f46;width:35%">Quotation Number</td>
                      <td style="padding:7px 12px;font-size:13.5px;font-weight:700;color:#15803d">#${result.DocNum}</td>
                    </tr>
                    <tr><td style="padding:7px 12px;font-size:12px;color:#6b7280">Doc Entry</td><td style="padding:7px 12px;font-size:12.5px">${result.DocEntry}</td></tr>
                    <tr style="background:#f9fafb"><td style="padding:7px 12px;font-size:12px;color:#6b7280">Customer</td><td style="padding:7px 12px;font-size:12.5px;font-weight:600">${escHtml(session.selectedCustomer.cardName||'')} (${escHtml(session.selectedCustomer.cardCode||'')})</td></tr>
                    <tr><td style="padding:7px 12px;font-size:12px;color:#6b7280">Posting Date</td><td style="padding:7px 12px;font-size:12.5px">${action.docDate||today()}</td></tr>
                    <tr style="background:#f9fafb"><td style="padding:7px 12px;font-size:12px;color:#6b7280">Valid Until</td><td style="padding:7px 12px;font-size:12.5px">${action.validUntil||datePlusDays(30)}</td></tr>
                    <tr><td style="padding:7px 12px;font-size:12px;color:#6b7280">Total Lines</td><td style="padding:7px 12px;font-size:12.5px">${lines.length} item(s)</td></tr>
                  </tbody>
                </table>
                <div style="font-size:11px;font-weight:700;color:#374151;text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px">Line Items</div>
                <div style="overflow-x:auto">
                  <table style="width:100%;border-collapse:collapse;min-width:460px">
                    <thead>
                      <tr style="background:#dcfce7;font-size:10.5px;font-weight:700;color:#065f46;text-transform:uppercase;letter-spacing:.04em">
                        <th style="padding:6px 10px;text-align:center;width:32px">#</th>
                        <th style="padding:6px 10px;text-align:left">Item Code</th>
                        <th style="padding:6px 10px;text-align:right">Qty</th>
                        <th style="padding:6px 10px;text-align:right">Unit Price</th>
                        <th style="padding:6px 10px;text-align:right">Disc%</th>
                        <th style="padding:6px 10px;text-align:left">Tax</th>
                        <th style="padding:6px 10px;text-align:left">WH</th>
                      </tr>
                    </thead>
                    <tbody>${linesHtml}</tbody>
                  </table>
                </div>
              </div>`;
              quickReplies = ['Create New Quotation'];
              meta = {
                docEntry: result.DocEntry,
                docNum:   result.DocNum,
                printUrl: `/api/sales-quotation/print/${result.DocEntry}`,
              };
            } catch (e) {
              reply = `❌ **Failed to post Sales Quotation**\n\nSAP Error: _${e.message}_\n\nWould you like to **retry** or **cancel**?`;
              quickReplies = ['Open Quotation Form', 'Cancel'];
            }
          }
        }

        // ── Select customer from combo ─────────────────────────────────────
        else if (action?.action === 'select_customer') {
          const { cardCode, cardName } = action;
          session.selectedCustomer = { cardCode, cardName };
          session.step = 'ADD_ITEM';
          session._lineIdx = 0;
          session._lines   = [];
          const items = getCacheItems(); const taxes = getCacheTaxCodes(); const whs = getCacheWarehouses();
          reply = `<div style="background:#f0fdf4;border:1px solid #10b981;border-radius:6px;padding:10px 14px;margin-bottom:8px">
            ✅ Customer: <strong>${escHtml(cardName)}</strong> (${escHtml(cardCode)})
          </div>
          <div style="font-size:13px;color:#374151;margin-bottom:6px">Now add <strong>line items</strong> to the quotation:</div>
          ${buildItemLineHtml(items, taxes, whs, session._lineIdx)}`;
        }

        // ── Add line item from combo ───────────────────────────────────────
        else if (action?.action === 'add_item') {
          if (!session._lines) session._lines = [];
          session._lines.push(action);
          session._lineIdx = (session._lineIdx || 0) + 1;
          const items = getCacheItems(); const taxes = getCacheTaxCodes(); const whs = getCacheWarehouses();
          const linesSummary = session._lines.map((l, i) =>
            `<tr><td style="padding:4px 8px;font-size:12.5px">${i+1}</td><td style="padding:4px 8px;font-size:12.5px">${escHtml(l.itemCode)}</td><td style="padding:4px 8px;font-size:12.5px;text-align:right">${l.quantity}</td><td style="padding:4px 8px;font-size:12.5px;text-align:right">${l.unitPrice??'—'}</td><td style="padding:4px 8px;font-size:12.5px">${escHtml(l.taxCode||'')}</td></tr>`
          ).join('');
          reply = `<div style="background:#f0fdf4;border:1px solid #10b981;border-radius:6px;padding:8px 14px;margin-bottom:8px">
            <div style="font-size:12px;font-weight:700;color:#065f46;margin-bottom:6px">✅ Item added — ${session._lines.length} line(s) so far:</div>
            <table style="width:100%;border-collapse:collapse;font-size:12px">
              <tr style="background:#dcfce7"><th style="padding:4px 8px;text-align:left">#</th><th style="padding:4px 8px;text-align:left">Item</th><th style="padding:4px 8px;text-align:right">Qty</th><th style="padding:4px 8px;text-align:right">Price</th><th style="padding:4px 8px;text-align:left">Tax</th></tr>
              ${linesSummary}
            </table>
          </div>
          <div style="font-size:13px;color:#374151;margin-bottom:6px">Add another item or click <strong>Done Adding Items</strong>:</div>
          ${buildItemLineHtml(items, taxes, whs, session._lineIdx)}`;
          session.step = 'ADD_ITEM';
        }

        // ── Done adding items → show review / post form ────────────────────
        else if (action?.action === 'done_items') {
          if (!session._lines?.length) {
            const items = getCacheItems(); const taxes = getCacheTaxCodes(); const whs = getCacheWarehouses();
            reply = `<div style="color:#b91c1c;margin-bottom:8px">⚠️ Please add at least one item.</div>${buildItemLineHtml(items, taxes, whs, session._lineIdx||0)}`;
          } else {
            session.step = 'REVIEW_FORM';
            formData = { ...buildFormData(session.selectedCustomer), lines: session._lines };
            const linesSummary = session._lines.map((l, i) =>
              `<tr><td style="padding:4px 8px">${i+1}</td><td style="padding:4px 8px;font-weight:600">${escHtml(l.itemCode)}</td><td style="padding:4px 8px;text-align:right">${l.quantity}</td><td style="padding:4px 8px;text-align:right">${l.unitPrice??'auto'}</td><td style="padding:4px 8px">${escHtml(l.taxCode||'')}</td></tr>`
            ).join('');
            reply = `<div style="background:#f0fdf4;border:1.5px solid #10b981;border-radius:8px;padding:14px;margin:6px 0">
              <div style="font-size:13px;font-weight:700;color:#065f46;margin-bottom:10px">📋 Quotation Ready to Post</div>
              <div style="font-size:12.5px;margin-bottom:6px">Customer: <strong>${escHtml(session.selectedCustomer.cardName)}</strong></div>
              <table style="width:100%;border-collapse:collapse;font-size:12px;margin-bottom:12px">
                <tr style="background:#dcfce7"><th style="padding:4px 8px;text-align:left">#</th><th style="padding:4px 8px;text-align:left">Item</th><th style="padding:4px 8px;text-align:right">Qty</th><th style="padding:4px 8px;text-align:right">Price</th><th style="padding:4px 8px;text-align:left">Tax</th></tr>
                ${linesSummary}
              </table>
              <div style="display:flex;gap:8px">
                <button onclick="sqSend(JSON.stringify({action:'post_quotation',lines:${JSON.stringify(session._lines).replace(/"/g,'&quot;')},docDate:'${today()}',validUntil:'${datePlusDays(30)}'}))"
                  style="background:#15803d;color:#fff;border:none;border-radius:6px;padding:9px 22px;font-size:13.5px;font-weight:700;cursor:pointer">✅ Post Quotation</button>
                <button onclick="sqSend(JSON.stringify({action:'add_more_items'}))"
                  style="background:#f3f4f6;color:#374151;border:1px solid #d1d5db;border-radius:6px;padding:9px 14px;font-size:13px;cursor:pointer">+ Add More Items</button>
              </div>
            </div>`;
          }
        }

        // ── Add more items ─────────────────────────────────────────────────
        else if (action?.action === 'add_more_items') {
          session.step = 'ADD_ITEM';
          const items = getCacheItems(); const taxes = getCacheTaxCodes(); const whs = getCacheWarehouses();
          reply = `<div style="font-size:13px;margin-bottom:6px">Add another item:</div>${buildItemLineHtml(items, taxes, whs, session._lineIdx||0)}`;
        }

        else {
          reply = 'Unexpected action. Please start over.';
          quickReplies = ['Start Over'];
        }
      }

      // ── INIT / SELECT_CUSTOMER — customer combo from cache ────────────────
      else if (session.step === 'INIT' || session.step === 'SELECT_CUSTOMER') {
        if (!msg) {
          // Load customers from cache and show combo
          const cached = getCacheCustomers();
          const comboHtml = buildCustomerComboHtml(cached);
          reply = `<div style="font-size:13.5px;font-weight:600;margin-bottom:6px">🟢 Welcome to <strong>Sales Quotation Agent</strong>!</div>
            <div style="font-size:13px;color:#374151;margin-bottom:8px">Select the <strong>Customer</strong> for this quotation:</div>
            ${comboHtml}`;
          session.step = 'INIT';
        } else if (/start over|reset|cancel/i.test(msgL)) {
          Object.assign(session, initSession());
          const cached = getCacheCustomers();
          reply = `<div style="margin-bottom:6px">Session reset.</div>${buildCustomerComboHtml(cached)}`;
          session.step = 'INIT';
        } else {
          // Text search fallback (live SAP)
          const customers = await searchCustomers(sap, msg);
          if (!customers.length) {
            const cached = getCacheCustomers();
            reply = `<div style="color:#b91c1c;margin-bottom:8px">No customers found matching <strong>"${escHtml(msg)}"</strong>. Try selecting from the list:</div>${buildCustomerComboHtml(cached)}`;
          } else if (customers.length === 1) {
            const c = customers[0];
            session.selectedCustomer = { cardCode: c.CardCode, cardName: c.CardName };
            session.step = 'ADD_ITEM';
            const items = getCacheItems(); const taxes = getCacheTaxCodes(); const whs = getCacheWarehouses();
            session._lineIdx = (session._lineIdx || 0);
            reply = `<div style="background:#f0fdf4;border:1px solid #10b981;border-radius:6px;padding:10px 14px;margin-bottom:8px">
              ✅ Customer: <strong>${escHtml(c.CardName)}</strong> (${escHtml(c.CardCode)})
            </div>${buildItemLineHtml(items, taxes, whs, session._lineIdx)}`;
          } else {
            customerList = customers.map(c => ({ cardCode: c.CardCode, cardName: c.CardName }));
            const cached = getCacheCustomers();
            reply = `<div style="margin-bottom:8px">Found <strong>${customers.length}</strong> matches. Select one:</div>${buildCustomerComboHtml(cached)}`;
            session.step = 'SELECT_CUSTOMER';
          }
        }
      }

      // ── REVIEW_FORM — form open, awaiting post or navigation ───────────────
      else if (session.step === 'REVIEW_FORM') {
        if (/open|form|quotation|create|post/i.test(msgL)) {
          formData = buildFormData(session.selectedCustomer);
          reply = 'Opening Quotation form…';
        } else if (/back|change|customer/i.test(msgL)) {
          session.selectedCustomer = null;
          session.step = 'INIT';
          reply = 'Returning to customer search. Type a customer name or code:';
        } else if (/cancel|start over/i.test(msgL)) {
          Object.assign(session, initSession());
          reply = 'Cancelled. Type a customer name or code to start again:';
          session.step = 'INIT';
        } else {
          reply = 'What would you like to do?';
          quickReplies = ['Open Quotation Form', 'Change Customer', 'Cancel'];
        }
      }

      // ── DONE ──────────────────────────────────────────────────────────────
      else if (session.step === 'DONE') {
        if (/yes|another|more|create|new/i.test(msgL)) {
          Object.assign(session, initSession());
          const cached = getCacheCustomers();
          reply = `<div style="margin-bottom:6px;font-size:13px">Starting a new quotation. Select the customer:</div>${buildCustomerComboHtml(cached)}`;
          session.step = 'INIT';
        } else {
          reply = 'Quotation complete.';
          quickReplies = ['Create Another'];
        }
      }

      // ── Fallback ──────────────────────────────────────────────────────────
      else {
        Object.assign(session, initSession());
        reply = 'Session reset. Type a customer name or code to begin:';
        session.step = 'INIT';
      }

      session.history.push({ role: 'assistant', content: reply });
      if (session.history.length > 40) session.history.splice(0, session.history.length - 40);

      res.json({
        ok: true, reply, quickReplies, sessionId: sid,
        step: session.step,
        meta, customerList, formData,
      });

    } catch (e) {
      console.error('[SQ] chat error:', e);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ── POST /reset ────────────────────────────────────────────────────────────
  // ── GET /item-price — customer price for the item picked in the Add Line combo ─
  router.get('/item-price', requireAuth, itemPriceRoute(getActiveSap, sid => _sessions.get(sid)?.selectedCustomer?.cardCode));

  router.post('/reset', requireAuth, (req, res) => {
    const { sessionId } = req.body || {};
    if (sessionId) _sessions.delete(sessionId);
    res.json({ ok: true });
  });

  // ── GET /print/:docEntry ───────────────────────────────────────────────────
  router.get('/print/:docEntry', printAuth, async (req, res) => {
    try {
      const sap = getActiveSap();
      const doc = await sap.get(`/Quotations(${parseInt(req.params.docEntry, 10)})`);
      res.setHeader('Content-Type', 'text/html');
      res.send(renderPrintLayout(doc));
    } catch (e) {
      res.status(500).send(`<pre style="color:red">Error loading Sales Quotation #${req.params.docEntry}: ${e.message}</pre>`);
    }
  });

  return router;
}
