/**
 * Sales Quotation → Sales Order Agent
 *  1. Search & select customer
 *  2. Load open Sales Quotations for that customer
 *  3. Select a quotation → load full line detail
 *  4. Edit qty / unit price / discount per line
 *  5. Post Sales Order to SAP B1 (BaseType 23 — Quotation)
 */
import { Router } from 'express';
import db, { connRepo } from '../db.mjs';

function getCompanyId() { const c = connRepo.getActive(); return c ? c.company : 'default'; }
function getCacheTaxCodes()    { return db.prepare(`SELECT Code,Name,Rate FROM cache_tax_codes WHERE company_id=? ORDER BY Code`).all(getCompanyId()); }
function getCachePayTerms()    { return db.prepare(`SELECT GroupNumber,PaymentTermsGroupName FROM cache_payment_terms WHERE company_id=? ORDER BY PaymentTermsGroupName`).all(getCompanyId()); }
function getCacheWarehouses()  { return db.prepare(`SELECT WarehouseCode,WarehouseName FROM cache_warehouses WHERE company_id=? AND Inactive='tNO' ORDER BY WarehouseCode`).all(getCompanyId()); }

const _sessions = new Map();

function initSession() {
  return {
    step:             'INIT',
    history:          [],
    selectedCustomer: null,   // { cardCode, cardName }
    sourceDetail:     null,   // full quotation detail
    result:           null,   // { docEntry, docNum } after post
  };
}

function today()    { return new Date().toISOString().slice(0, 10); }
function sapDate(s) { const d = s || today(); return d.length === 10 ? `${d}T00:00:00` : d; }
function fmtN(n, d = 2) {
  if (n == null || isNaN(Number(n))) return '—';
  return Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}
function escHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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
    console.error('[QTO] searchCustomers error:', e.message);
    return [];
  }
}

async function fetchOpenSourceDocs(sap, cardCode) {
  const cc   = cardCode.replace(/'/g, "''");
  const base = {
    $filter:  `DocumentStatus eq 'bost_Open' and CardCode eq '${cc}'`,
    $orderby: 'DocDate desc',
    $top:     50,
  };
  try {
    const r = await sap.get('/Quotations', {
      ...base,
      $select: 'DocEntry,DocNum,DocDate,DocDueDate,CardCode,CardName,DocTotal,NumAtCard',
    });
    if (Array.isArray(r.value)) return r.value;
  } catch { /* $select rejected by some SL versions */ }
  try {
    const r = await sap.get('/Quotations', base);
    return Array.isArray(r.value) ? r.value : [];
  } catch (e) {
    console.error('[QTO] fetchOpenSourceDocs error:', e.message);
    return [];
  }
}

async function fetchSourceByEntry(sap, docEntry) {
  try {
    return await sap.get(`/Quotations(${parseInt(docEntry, 10)})`);
  } catch (e) {
    console.error('[QTO] fetchSourceByEntry error:', e.message);
    return null;
  }
}

async function fetchSourceByNum(sap, docNum) {
  try {
    const r = await sap.get('/Quotations', {
      $filter: `DocNum eq ${parseInt(docNum, 10)} and DocumentStatus eq 'bost_Open'`,
      $top:    1,
    });
    const entry = r.value?.[0];
    if (!entry) return null;
    return await sap.get(`/Quotations(${entry.DocEntry})`);
  } catch { return null; }
}

function buildSourceDetail(doc) {
  return {
    docEntry:  doc.DocEntry,
    docNum:    doc.DocNum,
    docDate:   doc.DocDate    ? doc.DocDate.slice(0, 10)    : null,
    dueDate:   doc.DocDueDate ? doc.DocDueDate.slice(0, 10) : null,
    cardCode:  doc.CardCode   || null,
    cardName:  doc.CardName   || null,
    numAtCard: doc.NumAtCard  || null,
    comments:  doc.Comments   || null,
    docTotal:  Number(doc.DocTotal || 0),
    lines: (doc.DocumentLines || [])
      .filter(l => l.ItemCode)
      .map(l => ({
        lineNum:         l.LineNum,
        itemCode:        l.ItemCode,
        itemName:        l.ItemDescription || l.ItemCode,
        qty:             Number(l.Quantity        || 0),
        unitPrice:       Number(l.UnitPrice       || l.Price || 0),
        discountPercent: Number(l.DiscountPercent || 0),
        lineTotal:       Number(l.LineTotal       || 0),
        unit:            l.UoMCode || l.MeasureUnit || 'EA',
        warehouse:       l.WarehouseCode || '',
        taxCode:         l.TaxCode || null,
      })),
  };
}

// ── Print layout ───────────────────────────────────────────────────────────────
// Color theme: #0e7490 (cyan-700)

function renderPrintLayout(doc) {
  const company   = process.env.SAP_B1_COMPANY || process.env.SL_COMPANY || 'Company';
  const lines     = doc.DocumentLines || [];
  const docDate   = doc.DocDate    ? doc.DocDate.slice(0, 10)    : '—';
  const dueDate   = doc.DocDueDate ? doc.DocDueDate.slice(0, 10) : '—';
  const printedOn = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  const grandTotal = lines.reduce((s, l) => s + Number(l.LineTotal || 0), 0);
  const taxTotal   = lines.reduce((s, l) => s + Number(l.VatSum   || 0), 0);

  const linesHtml = lines.map((l, i) => `
    <tr>
      <td>${i + 1}</td>
      <td><strong>${escHtml(l.ItemCode || '')}</strong></td>
      <td>${escHtml(l.ItemDescription || '')}</td>
      <td style="text-align:right">${Number(l.Quantity        || 0).toFixed(2)}</td>
      <td>${escHtml(l.UoMCode || l.MeasureUnit || '')}</td>
      <td style="text-align:right">${Number(l.UnitPrice       || 0).toFixed(2)}</td>
      <td style="text-align:right">${Number(l.DiscountPercent || 0).toFixed(2)}%</td>
      <td style="text-align:right">${Number(l.LineTotal       || 0).toFixed(2)}</td>
      <td>${escHtml(l.TaxCode || '')}</td>
    </tr>`).join('');

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<title>Sales Order #${doc.DocNum}</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:Arial,sans-serif;font-size:11px;color:#222;padding:28px 36px;max-width:980px;margin:auto}
  .print-btn{margin-bottom:16px;display:flex;gap:8px;justify-content:flex-end}
  .print-btn button{padding:8px 18px;border:none;border-radius:6px;cursor:pointer;font-size:13px;font-weight:600}
  .btn-print{background:#0e7490;color:#fff}.btn-close{background:#eee;color:#333}
  .header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:24px;padding-bottom:16px;border-bottom:3px solid #0e7490}
  .co-name{font-size:20px;font-weight:700;color:#1a1d27}
  .doc-title{font-size:18px;font-weight:700;color:#0e7490;text-align:right}
  .info-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-bottom:20px}
  .info-box{border:1px solid #ddd;border-radius:6px;padding:12px}
  .info-label{font-size:9px;font-weight:700;text-transform:uppercase;color:#888;letter-spacing:.06em;margin-bottom:6px}
  .info-val{font-size:12px;color:#222;margin-bottom:2px}
  table{width:100%;border-collapse:collapse;margin-bottom:16px}
  thead tr{background:#0e7490}
  th{padding:8px 10px;text-align:left;font-size:10px;font-weight:700;text-transform:uppercase;color:#fff}
  td{padding:7px 10px;border-bottom:1px solid #eee;font-size:11px}
  tr:nth-child(even) td{background:#ecfeff}
  .totals{text-align:right;padding:8px 0 20px}
  .total-row{font-size:12px;color:#374151;margin-bottom:4px}
  .total-grand{font-size:15px;font-weight:700;color:#0e7490;margin-top:6px}
  .footer{text-align:center;margin-top:24px;font-size:9px;color:#aaa;border-top:1px solid #eee;padding-top:12px}
  .watermark{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%) rotate(-30deg);font-size:52px;color:rgba(0,0,0,.04);font-weight:900;pointer-events:none;z-index:0}
  @media print{.print-btn{display:none}}
</style></head><body>
<div class="watermark">SALES ORDER</div>
<div class="print-btn">
  <button class="btn-close" onclick="window.close()">✕ Close</button>
  <button class="btn-print" onclick="window.print()">🖨️ Print</button>
</div>
<div class="header">
  <div><div class="co-name">${escHtml(company)}</div><div style="color:#888;font-size:11px;margin-top:2px">SAP Business One — Sales Order</div></div>
  <div><div class="doc-title">Sales Order</div><div style="font-size:13px;color:#444;text-align:right">SO # ${doc.DocNum}</div></div>
</div>
<div class="info-grid">
  <div class="info-box">
    <div class="info-label">Customer</div>
    <div class="info-val"><strong>${escHtml(doc.CardName || '—')}</strong></div>
    ${doc.CardCode ? `<div class="info-val" style="color:#666">${escHtml(doc.CardCode)}</div>` : ''}
  </div>
  <div class="info-box">
    <div class="info-label">Order Date / Delivery Date</div>
    <div class="info-val"><strong>${escHtml(docDate)}</strong></div>
    <div class="info-val" style="color:#666">Delivery: ${escHtml(dueDate)}</div>
  </div>
  <div class="info-box">
    <div class="info-label">Customer PO Ref / SO #</div>
    <div class="info-val"><strong>${escHtml(doc.NumAtCard || '—')}</strong></div>
    <div class="info-val" style="color:#666">SO # ${doc.DocNum}</div>
  </div>
</div>
${doc.Comments ? `<div style="border:1px solid #a5f3fc;border-radius:6px;padding:12px;margin-bottom:20px;background:#ecfeff;font-size:11px;line-height:1.6"><strong>📝 Remarks:</strong><br><br>${escHtml(doc.Comments)}</div>` : ''}
<table>
  <thead><tr>
    <th>#</th><th>Item Code</th><th>Description</th>
    <th style="text-align:right">Qty</th><th>Unit</th>
    <th style="text-align:right">Unit Price</th>
    <th style="text-align:right">Disc%</th>
    <th style="text-align:right">Total</th>
    <th>Tax</th>
  </tr></thead>
  <tbody>${linesHtml}</tbody>
</table>
<div class="totals">
  ${taxTotal > 0 ? `<div class="total-row">Subtotal: ${(grandTotal - taxTotal).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>` : ''}
  ${taxTotal > 0 ? `<div class="total-row">Tax: ${taxTotal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>` : ''}
  <div class="total-grand">Order Total: ${grandTotal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
</div>
<div class="footer">Printed on ${printedOn} &nbsp;|&nbsp; ${escHtml(company)} — SAP B1 Sales Order #${doc.DocNum} &nbsp;|&nbsp; Powered by Henny AI Solution</div>
</body></html>`;
}

// ── Router factory ─────────────────────────────────────────────────────────────

export function createQuotationToOrderRouter(deps) {
  const { requireAuth, printAuth, getActiveSap } = deps;
  const router = Router();

  // ── GET /customers-with-quotations — for the customer combo ──────────────────
  router.get('/customers-with-quotations', requireAuth, async (req, res) => {
    try {
      const sap = getActiveSap();
      // Fetch all open quotations and extract unique customers
      const r = await sap.get('/Quotations', {
        $filter:  `DocumentStatus eq 'bost_Open' and Cancelled eq 'tNO'`,
        $select:  'CardCode,CardName',
        $orderby: 'CardName asc',
        $top:     500,
      });
      const rows = Array.isArray(r.value) ? r.value : [];
      // Deduplicate by CardCode
      const seen = new Map();
      rows.forEach(q => { if (!seen.has(q.CardCode)) seen.set(q.CardCode, q.CardName); });
      const customers = [...seen.entries()].map(([cardCode, cardName]) => ({ cardCode, cardName }));
      res.json({ ok: true, customers });
    } catch(e) { res.json({ ok: false, customers: [], error: e.message }); }
  });

  // ── GET /open-quotations?cardCode=xxx — quotations for selected customer ──────
  router.get('/open-quotations', requireAuth, async (req, res) => {
    try {
      const sap      = getActiveSap();
      const cardCode = (req.query.cardCode || '').trim();
      if (!cardCode) return res.json({ ok: false, quotations: [], error: 'cardCode required' });
      const docs = await fetchOpenSourceDocs(sap, cardCode);
      const quotations = docs.map(q => ({
        docEntry:  q.DocEntry,
        docNum:    q.DocNum,
        docDate:   (q.DocDate    || '').slice(0, 10),
        validUntil:(q.DocDueDate || '').slice(0, 10),
        reference: q.NumAtCard || '',
        docTotal:  Number(q.DocTotal || 0),
      }));
      res.json({ ok: true, quotations });
    } catch(e) { res.json({ ok: false, quotations: [], error: e.message }); }
  });

  // ── POST /chat ─────────────────────────────────────────────────────────────
  router.post('/chat', requireAuth, async (req, res) => {
    try {
      const { message = '', sessionId } = req.body;
      const sid = sessionId || `qto_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
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
      let sourceList   = null;
      let formData     = null;

      // ── JSON actions ───────────────────────────────────────────────────────
      if (msg.startsWith('{')) {
        let action = null;
        try { action = JSON.parse(msg); } catch {}

        // ── Post Sales Order (with editable fields) ────────────────────────
        if (action?.action === 'post_target') {
          const lines = action.lines || [];
          if (!lines.length) {
            reply = '❌ No lines selected. Please select at least one line.';
          } else {
            try {
              const quot = session.sourceDetail;
              const payload = {
                DocDate:    sapDate(action.docDate    || today()),
                DocDueDate: sapDate(action.deliveryDate || action.dueDate || today()),
                CardCode:   quot.cardCode || undefined,
                NumAtCard:  action.customerPoRef || quot.numAtCard || undefined,
                ...(action.paymentTerms != null && action.paymentTerms !== '' ? { PayTermsGrpCode: Number(action.paymentTerms) } : {}),
                ...(action.comments ? { Comments: action.comments } : {}),
                DocumentLines: lines.map(l => ({
                  BaseType:        23,
                  BaseEntry:       Number(quot.docEntry),
                  BaseLine:        Number(l.baseLine ?? l.lineNum ?? 0),
                  Quantity:        Number(l.qty),
                  UnitPrice:       Number(l.unitPrice),
                  ...(l.discountPercent != null ? { DiscountPercent: Number(l.discountPercent) } : {}),
                  ...(l.taxCode        ? { TaxCode:       l.taxCode        } : {}),
                  ...(l.warehouse      ? { WarehouseCode: l.warehouse      } : {}),
                })),
              };

              const result = await sap.post('/Orders', payload);
              session.result = { docEntry: result.DocEntry, docNum: result.DocNum };
              session.step   = 'DONE';

              const printUrl = `/api/quotation-order/print/${result.DocEntry}`;
              const linesHtml = lines.map((l, i) => `
                <tr style="border-bottom:1px solid #f3f4f6">
                  <td style="padding:6px 10px;font-size:12.5px;font-weight:600">${i+1}</td>
                  <td style="padding:6px 10px;font-size:12.5px;font-weight:600">${escHtml(l.itemCode||'')}</td>
                  <td style="padding:6px 10px;font-size:12.5px;text-align:right">${l.qty}</td>
                  <td style="padding:6px 10px;font-size:12.5px;text-align:right">${fmtN(l.unitPrice)}</td>
                  <td style="padding:6px 10px;font-size:12px;text-align:right">${l.discountPercent||0}%</td>
                  <td style="padding:6px 10px;font-size:12px">${escHtml(l.taxCode||'')}</td>
                  <td style="padding:6px 10px;font-size:12.5px;text-align:right;font-weight:600">${fmtN(Number(l.qty)*Number(l.unitPrice)*(1-(Number(l.discountPercent||0)/100)))}</td>
                </tr>`).join('');

              reply = `<div style="background:#f0fdf4;border:1.5px solid #10b981;border-radius:10px;padding:16px;margin:4px 0">
                <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
                  <div style="font-size:15px;font-weight:700;color:#065f46">✅ Sales Order Created Successfully</div>
                  <button onclick="window.open('${printUrl}','_blank')"
                    style="background:#0e7490;color:#fff;border:none;border-radius:6px;padding:7px 18px;font-size:13px;font-weight:600;cursor:pointer;display:flex;align-items:center;gap:6px">
                    🖨️ Print Order
                  </button>
                </div>
                <table style="width:100%;border-collapse:collapse;margin-bottom:14px">
                  <tbody>
                    <tr style="background:#dcfce7"><td style="padding:7px 12px;font-size:12px;font-weight:700;color:#065f46;width:38%">Sales Order #</td><td style="padding:7px 12px;font-size:14px;font-weight:700;color:#0e7490">#${result.DocNum}</td></tr>
                    <tr><td style="padding:7px 12px;font-size:12px;color:#6b7280">Doc Entry</td><td style="padding:7px 12px;font-size:12.5px">${result.DocEntry}</td></tr>
                    <tr style="background:#f9fafb"><td style="padding:7px 12px;font-size:12px;color:#6b7280">Customer</td><td style="padding:7px 12px;font-size:12.5px;font-weight:600">${escHtml(quot.cardName||quot.cardCode||'')}</td></tr>
                    <tr><td style="padding:7px 12px;font-size:12px;color:#6b7280">Source Quotation</td><td style="padding:7px 12px;font-size:12.5px">Quotation #${quot.docNum}</td></tr>
                    <tr style="background:#f9fafb"><td style="padding:7px 12px;font-size:12px;color:#6b7280">Delivery Date</td><td style="padding:7px 12px;font-size:12.5px">${action.deliveryDate||today()}</td></tr>
                    <tr><td style="padding:7px 12px;font-size:12px;color:#6b7280">Lines</td><td style="padding:7px 12px;font-size:12.5px">${lines.length} item(s)</td></tr>
                  </tbody>
                </table>
                <div style="font-size:11px;font-weight:700;color:#374151;text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px">Order Lines</div>
                <div style="overflow-x:auto">
                  <table style="width:100%;border-collapse:collapse;min-width:480px">
                    <thead><tr style="background:#dcfce7;font-size:10.5px;font-weight:700;color:#065f46;text-transform:uppercase">
                      <th style="padding:6px 10px">#</th><th style="padding:6px 10px;text-align:left">Item</th>
                      <th style="padding:6px 10px;text-align:right">Qty</th><th style="padding:6px 10px;text-align:right">Price</th>
                      <th style="padding:6px 10px;text-align:right">Disc%</th><th style="padding:6px 10px">Tax</th>
                      <th style="padding:6px 10px;text-align:right">Total</th>
                    </tr></thead>
                    <tbody>${linesHtml}</tbody>
                  </table>
                </div>
              </div>`;
              quickReplies = ['Process Another Quotation'];
              meta = { docEntry: result.DocEntry, docNum: result.DocNum, printUrl };
            } catch (e) {
              reply = `<div style="background:#fef2f2;border:1.5px solid #f87171;border-radius:8px;padding:12px 16px;color:#b91c1c;font-size:13px">
                ❌ <strong>Failed to create Sales Order</strong><br><br>${escHtml(e.message)}
              </div>`;
            }
          }
        }

        // ── Select quotation from list (table row click) ───────────────────
        else if (action?.action === 'select_source') {
          const doc = await fetchSourceByEntry(sap, action.docEntry);
          if (doc) {
            session.sourceDetail = buildSourceDetail(doc);
            session.step = 'REVIEW_FORM';
            formData = buildFormData(session.sourceDetail);
            reply = `### Quotation #${doc.DocNum} — ${escHtml(doc.CardName || doc.CardCode)}\n\n` +
              `| Field | Value |\n|---|---|\n` +
              `| **Customer** | ${escHtml(doc.CardName || '—')} (${escHtml(doc.CardCode || '—')}) |\n` +
              `| **Date** | ${session.sourceDetail.docDate || '—'} |\n` +
              `| **Customer PO Ref** | ${escHtml(doc.NumAtCard || '—')} |\n` +
              `| **Lines** | ${session.sourceDetail.lines.length} |\n` +
              `| **Total** | ${fmtN(session.sourceDetail.docTotal)} |\n\n` +
              `Open the Sales Order form to review lines and adjust quantities/prices:`;
            quickReplies = ['Open Order Form'];
          } else {
            reply = '❌ Could not load Quotation detail. Please try again.';
          }
        }

        // ── Select customer from search result table ───────────────────────
        else if (action?.action === 'select_customer') {
          const { cardCode, cardName } = action;
          session.selectedCustomer = { cardCode, cardName };
          session.step = 'SELECT_SOURCE';
          const docs = await fetchOpenSourceDocs(sap, cardCode);
          if (!docs.length) {
            reply = `No open quotations found for **${escHtml(cardName)}** (${escHtml(cardCode)}).`;
            quickReplies = ['Search Another Customer', 'Start Over'];
            session.step = 'INIT';
          } else {
            sourceList = mapSourceList(docs);
            reply = `Found **${docs.length}** open quotation${docs.length !== 1 ? 's' : ''} for **${escHtml(cardName)}**. Click one to load its details:`;
          }
        }

        // ── Load quotation from GUI selector → return data; client builds editable form ─
        else if (action?.action === 'load_quotation') {
          const { docEntry, cardCode, cardName } = action;
          if (cardCode) session.selectedCustomer = { cardCode, cardName: cardName || cardCode };
          const doc = await fetchSourceByEntry(sap, docEntry);
          if (!doc) {
            reply = `❌ Could not load quotation (DocEntry: ${docEntry}). It may have been closed or cancelled.`;
            quickReplies = ['Start Over'];
          } else {
            session.sourceDetail = buildSourceDetail(doc);
            session.step         = 'REVIEW_TARGET';
            const d              = session.sourceDetail;

            // Attach master-data for client-side dropdowns
            const taxCodes   = getCacheTaxCodes();
            const payTerms   = getCachePayTerms();
            const warehouses = getCacheWarehouses();
            formData = { ...d, taxCodes, payTerms, warehouses };

            reply = `✅ **Quotation #${d.docNum}** loaded for **${escHtml(d.cardName || d.cardCode || '')}**.\n\n` +
              `${d.lines.length} line(s) &nbsp;·&nbsp; Total: **${fmtN(d.docTotal)}**\n\n` +
              `Review and edit the order details in the form below, then click **Convert to Sales Order**.`;
          }
        }

        else {
          reply = 'Unexpected action. Please start over.';
        }
      }

      // ── INIT / SELECT_CUSTOMER — customer search ───────────────────────────
      else if (session.step === 'INIT' || session.step === 'SELECT_CUSTOMER') {
        if (!msg) {
          reply = `## 🔵 Sales Quotation → Sales Order Agent\n\n` +
            `*Select a customer to view their open quotations, then convert one to a Sales Order.*\n\n` +
            `Type a **customer name or code** to begin:`;
          session.step = 'INIT';
        } else if (/start over|reset|cancel/i.test(msgL)) {
          Object.assign(session, initSession());
          reply = 'Session reset. Type a customer name or code to begin:';
          session.step = 'INIT';
        } else {
          const customers = await searchCustomers(sap, msg);
          if (!customers.length) {
            reply = `No customers found matching **"${escHtml(msg)}"**. Please try a different name or code.`;
            quickReplies = ['Start Over'];
          } else if (customers.length === 1) {
            const c = customers[0];
            session.selectedCustomer = { cardCode: c.CardCode, cardName: c.CardName };
            session.step = 'SELECT_SOURCE';
            const docs = await fetchOpenSourceDocs(sap, c.CardCode);
            if (!docs.length) {
              reply = `No open quotations found for **${escHtml(c.CardName)}** (${escHtml(c.CardCode)}).`;
              quickReplies = ['Search Another Customer', 'Start Over'];
              session.step = 'INIT';
            } else {
              sourceList = mapSourceList(docs);
              reply = `Found **${docs.length}** open quotation${docs.length !== 1 ? 's' : ''} for **${escHtml(c.CardName)}**. Click one to load its details:`;
            }
          } else {
            customerList = customers.map(c => ({ cardCode: c.CardCode, cardName: c.CardName }));
            reply = `Found **${customers.length}** customers matching **"${escHtml(msg)}"**. Select one:`;
            session.step = 'SELECT_CUSTOMER';
          }
        }
      }

      // ── SELECT_SOURCE — quotation list shown, awaiting selection ───────────
      else if (session.step === 'SELECT_SOURCE') {
        if (/back|customer|change|another/i.test(msgL)) {
          session.selectedCustomer = null;
          session.step = 'INIT';
          reply = 'Returning to customer search. Type a customer name or code:';
        } else {
          const numMatch = msg.match(/^(?:Q#?|QUOT#?|QT#?)?(\d+)$/i);
          if (numMatch) {
            const doc = await fetchSourceByNum(sap, numMatch[1]);
            if (doc) {
              session.sourceDetail = buildSourceDetail(doc);
              session.step = 'REVIEW_FORM';
              formData = buildFormData(session.sourceDetail);
              reply = `### Quotation #${doc.DocNum} loaded\n\n` +
                `**${escHtml(doc.CardName || doc.CardCode)}** — ${session.sourceDetail.lines.length} lines — Total: ${fmtN(session.sourceDetail.docTotal)}\n\nOpen the Sales Order form:`;
              quickReplies = ['Open Order Form'];
            } else {
              reply = `Quotation #${numMatch[1]} not found or already closed. Please click a quotation from the list above.`;
            }
          } else if (session.selectedCustomer) {
            const docs = await fetchOpenSourceDocs(sap, session.selectedCustomer.cardCode);
            sourceList = mapSourceList(docs);
            reply = `Click a quotation to load it:`;
          } else {
            reply = 'Please click a quotation from the list or type a quotation number.';
          }
        }
      }

      // ── REVIEW_FORM ───────────────────────────────────────────────────────
      else if (session.step === 'REVIEW_FORM') {
        if (/open|form|order|post|review/i.test(msgL)) {
          formData = buildFormData(session.sourceDetail);
          reply = 'Opening Sales Order form…';
        } else if (/back|change|quotat/i.test(msgL)) {
          session.sourceDetail = null;
          session.step = 'SELECT_SOURCE';
          if (session.selectedCustomer) {
            const docs = await fetchOpenSourceDocs(sap, session.selectedCustomer.cardCode);
            sourceList = mapSourceList(docs);
            reply = `Select a different quotation for **${escHtml(session.selectedCustomer.cardName)}**:`;
          } else {
            reply = 'Please select a quotation:';
          }
        } else if (/cancel|start over/i.test(msgL)) {
          Object.assign(session, initSession());
          reply = 'Cancelled. Type a customer name or code to start again:';
          session.step = 'INIT';
        } else {
          reply = 'What would you like to do?';
          quickReplies = ['Open Order Form', 'Change Quotation', 'Cancel'];
        }
      }

      // ── DONE ──────────────────────────────────────────────────────────────
      else if (session.step === 'DONE') {
        if (/yes|another|more|process/i.test(msgL)) {
          Object.assign(session, initSession());
          reply = 'Ready. Type a customer name or code to begin a new Sales Order:';
          session.step = 'INIT';
        } else {
          reply = 'Workflow complete. Click "Process Another" to start again.';
          quickReplies = ['Process Another'];
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
        sourceDetail: session.sourceDetail,
        meta, customerList, sourceList, formData,
      });

    } catch (e) {
      console.error('[QTO] chat error:', e);
      res.status(500).json({ ok: false, error: e.message });
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
      const doc = await sap.get(`/Orders(${parseInt(req.params.docEntry, 10)})`);
      res.setHeader('Content-Type', 'text/html');
      res.send(renderPrintLayout(doc));
    } catch (e) {
      res.status(500).send(`<pre style="color:red">Error loading Sales Order #${req.params.docEntry}: ${escHtml(e.message)}</pre>`);
    }
  });

  return router;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function mapSourceList(docs) {
  return docs.map(d => ({
    docEntry:  d.DocEntry,
    docNum:    d.DocNum,
    docDate:   d.DocDate    ? d.DocDate.slice(0, 10)    : null,
    dueDate:   d.DocDueDate ? d.DocDueDate.slice(0, 10) : null,
    numAtCard: d.NumAtCard  || '',
    docTotal:  Number(d.DocTotal || 0),
  }));
}

function buildFormData(quot) {
  return {
    docEntry:       quot.docEntry,
    docNum:         quot.docNum,
    cardCode:       quot.cardCode,
    cardName:       quot.cardName,
    customerPoRef:  quot.numAtCard || '',
    docDate:        today(),
    dueDate:        today(),
    comments:       quot.comments  || '',
    docTotal:       quot.docTotal,
    lines: quot.lines.map(l => ({
      lineNum:         l.lineNum,
      itemCode:        l.itemCode,
      itemName:        l.itemName,
      quotQty:         l.qty,
      qty:             l.qty,
      unitPrice:       l.unitPrice,
      discountPercent: l.discountPercent,
      lineTotal:       l.lineTotal,
      unit:            l.unit,
      warehouse:       l.warehouse,
      taxCode:         l.taxCode,
    })),
  };
}
