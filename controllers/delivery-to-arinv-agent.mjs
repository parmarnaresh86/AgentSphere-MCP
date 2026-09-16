/**
 * Delivery Note → A/R Invoice Agent
 *  1. Search & select customer
 *  2. Load open delivery notes for that customer
 *  3. Select a delivery note → load full line detail
 *  4. Edit invoice qty / unit price at row level
 *  5. Post A/R Invoice to SAP B1
 */
import { Router } from 'express';

const _sessions = new Map();

function initSession() {
  return {
    step:             'INIT',
    history:          [],
    selectedCustomer: null,   // { cardCode, cardName }
    deliveryDetail:   null,   // full delivery note detail
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
    console.error('[ARINV] searchCustomers error:', e.message);
    return [];
  }
}

async function fetchOpenDeliveriesByCustomer(sap, cardCode) {
  const cc = cardCode.replace(/'/g, "''");
  const base = {
    $filter:  `DocumentStatus eq 'bost_Open' and CardCode eq '${cc}'`,
    $orderby: 'DocDate desc',
    $top:     50,
  };
  try {
    const r = await sap.get('/DeliveryNotes', {
      ...base,
      $select: 'DocEntry,DocNum,DocDate,DocDueDate,CardCode,CardName,DocTotal,NumAtCard',
    });
    if (Array.isArray(r.value)) return r.value;
  } catch { /* $select rejected */ }
  try {
    const r = await sap.get('/DeliveryNotes', base);
    return Array.isArray(r.value) ? r.value : [];
  } catch (e) {
    console.error('[ARINV] fetchOpenDeliveries error:', e.message);
    return [];
  }
}

async function fetchDeliveryByEntry(sap, docEntry) {
  try {
    return await sap.get(`/DeliveryNotes(${parseInt(docEntry, 10)})`);
  } catch (e) {
    console.error('[ARINV] fetchDeliveryByEntry error:', e.message);
    return null;
  }
}

async function fetchDeliveryByNum(sap, docNum) {
  try {
    const r = await sap.get('/DeliveryNotes', {
      $filter: `DocNum eq ${parseInt(docNum, 10)} and DocumentStatus eq 'bost_Open'`,
      $top:    1,
    });
    const entry = r.value?.[0];
    if (!entry) return null;
    return await sap.get(`/DeliveryNotes(${entry.DocEntry})`);
  } catch { return null; }
}

function buildDeliveryDetail(doc) {
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
        lineNum:   l.LineNum,
        itemCode:  l.ItemCode,
        itemName:  l.ItemDescription || l.ItemCode,
        qty:       Number(l.Quantity    || 0),
        unitPrice: Number(l.UnitPrice   || l.Price || 0),
        lineTotal: Number(l.LineTotal   || 0),
        unit:      l.UoMCode || l.MeasureUnit || 'EA',
        warehouse: l.WarehouseCode || '',
        taxCode:   l.TaxCode || null,
      })),
  };
}

// ── Print layout ───────────────────────────────────────────────────────────────

function renderARInvPrint(doc) {
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
      <td style="text-align:right">${Number(l.Quantity  || 0).toFixed(2)}</td>
      <td>${escHtml(l.UoMCode || l.MeasureUnit || '')}</td>
      <td style="text-align:right">${Number(l.UnitPrice || 0).toFixed(2)}</td>
      <td style="text-align:right">${Number(l.LineTotal || 0).toFixed(2)}</td>
      <td>${escHtml(l.TaxCode || '')}</td>
      <td>${escHtml(l.WarehouseCode || '')}</td>
    </tr>`).join('');

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<title>A/R Invoice #${doc.DocNum}</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:Arial,sans-serif;font-size:11px;color:#222;padding:28px 36px;max-width:1020px;margin:auto}
  .print-btn{margin-bottom:16px;display:flex;gap:8px;justify-content:flex-end}
  .print-btn button{padding:8px 18px;border:none;border-radius:6px;cursor:pointer;font-size:13px;font-weight:600}
  .btn-print{background:#0369a1;color:#fff}.btn-close{background:#eee;color:#333}
  .header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:24px;padding-bottom:16px;border-bottom:3px solid #0369a1}
  .co-name{font-size:20px;font-weight:700;color:#1a1d27}
  .doc-title{font-size:18px;font-weight:700;color:#0369a1;text-align:right}
  .info-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-bottom:20px}
  .info-box{border:1px solid #ddd;border-radius:6px;padding:12px}
  .info-label{font-size:9px;font-weight:700;text-transform:uppercase;color:#888;letter-spacing:.06em;margin-bottom:6px}
  .info-val{font-size:12px;color:#222;margin-bottom:2px}
  table{width:100%;border-collapse:collapse;margin-bottom:16px}
  thead tr{background:#0369a1}
  th{padding:8px 10px;text-align:left;font-size:10px;font-weight:700;text-transform:uppercase;color:#fff}
  td{padding:7px 10px;border-bottom:1px solid #eee;font-size:11px}
  tr:nth-child(even) td{background:#f0f9ff}
  .totals{text-align:right;padding:8px 0 20px}
  .total-row{font-size:12px;color:#374151;margin-bottom:4px}
  .total-grand{font-size:15px;font-weight:700;color:#0369a1;margin-top:6px}
  .sig-section{display:grid;grid-template-columns:repeat(3,1fr);gap:24px;margin-top:40px;border-top:1px solid #e5e7eb;padding-top:24px}
  .sig-box{text-align:center}
  .sig-line{border-top:1px solid #374151;margin-top:36px;padding-top:6px;font-size:10px;color:#6b7280;font-weight:600;text-transform:uppercase;letter-spacing:.05em}
  .footer{text-align:center;margin-top:24px;font-size:9px;color:#aaa;border-top:1px solid #eee;padding-top:12px}
  .watermark{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%) rotate(-30deg);font-size:52px;color:rgba(0,0,0,.04);font-weight:900;pointer-events:none;z-index:0}
  @media print{.print-btn{display:none}}
</style></head><body>
<div class="watermark">A/R INVOICE</div>
<div class="print-btn">
  <button class="btn-close" onclick="window.close()">&#x2715; Close</button>
  <button class="btn-print" onclick="window.print()">&#x1F5A8; Print</button>
</div>
<div class="header">
  <div>
    <div class="co-name">${escHtml(company)}</div>
    <div style="color:#888;font-size:11px;margin-top:2px">SAP Business One &mdash; A/R Invoice</div>
  </div>
  <div>
    <div class="doc-title">A/R Invoice</div>
    <div style="font-size:13px;color:#444;text-align:right">Invoice # ${escHtml(String(doc.DocNum))}</div>
  </div>
</div>
<div class="info-grid">
  <div class="info-box">
    <div class="info-label">Bill To / Customer</div>
    <div class="info-val"><strong>${escHtml(doc.CardName || '—')}</strong></div>
    ${doc.CardCode ? `<div class="info-val" style="color:#666">${escHtml(doc.CardCode)}</div>` : ''}
  </div>
  <div class="info-box">
    <div class="info-label">Invoice Date / Due Date</div>
    <div class="info-val"><strong>${escHtml(docDate)}</strong></div>
    <div class="info-val" style="color:#666">Due: ${escHtml(dueDate)}</div>
  </div>
  <div class="info-box">
    <div class="info-label">Customer Ref / Invoice #</div>
    <div class="info-val"><strong>${escHtml(doc.NumAtCard || '—')}</strong></div>
    <div class="info-val" style="color:#666">Invoice # ${escHtml(String(doc.DocNum))}</div>
  </div>
</div>
${doc.Comments ? `<div style="border:1px solid #bae6fd;border-radius:6px;padding:12px;margin-bottom:20px;background:#f0f9ff;font-size:11px;line-height:1.6"><strong>&#x1F4DD; Remarks:</strong><br><br>${escHtml(doc.Comments)}</div>` : ''}
<table>
  <thead><tr>
    <th>#</th><th>Item Code</th><th>Description</th>
    <th style="text-align:right">Qty</th><th>Unit</th>
    <th style="text-align:right">Unit Price</th><th style="text-align:right">Total</th>
    <th>Tax</th><th>WH</th>
  </tr></thead>
  <tbody>${linesHtml}</tbody>
</table>
<div class="totals">
  ${taxTotal > 0 ? `<div class="total-row">Subtotal: ${(grandTotal - taxTotal).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>` : ''}
  ${taxTotal > 0 ? `<div class="total-row">Tax: ${taxTotal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>` : ''}
  <div class="total-grand">Invoice Total: ${grandTotal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
</div>
<div class="sig-section">
  <div class="sig-box"><div class="sig-line">Prepared By</div></div>
  <div class="sig-box"><div class="sig-line">Approved By</div></div>
  <div class="sig-box"><div class="sig-line">Finance Manager</div></div>
</div>
<div class="footer">Printed on ${escHtml(printedOn)} &nbsp;|&nbsp; ${escHtml(company)} &mdash; SAP B1 A/R Invoice #${escHtml(String(doc.DocNum))} &nbsp;|&nbsp; Powered by Henny AI Solution</div>
</body></html>`;
}

// ── Router factory ─────────────────────────────────────────────────────────────

export function createDeliveryToARInvRouter(deps) {
  const { requireAuth, printAuth, getActiveSap } = deps;
  const router = Router();

  // ── POST /chat ─────────────────────────────────────────────────────────────
  router.post('/chat', requireAuth, async (req, res) => {
    try {
      const { message = '', sessionId } = req.body;
      const sid = sessionId || `arinv_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      if (!_sessions.has(sid)) _sessions.set(sid, initSession());
      const session = _sessions.get(sid);
      const sap     = getActiveSap();
      const msg     = message.trim();
      const msgL    = msg.toLowerCase();

      if (msg) session.history.push({ role: 'user', content: msg });

      let reply          = '';
      let quickReplies   = [];
      let meta           = {};
      let customerList   = null;
      let deliveryList   = null;
      let formData       = null;

      // ── JSON actions ───────────────────────────────────────────────────────
      if (msg.startsWith('{')) {
        let action = null;
        try { action = JSON.parse(msg); } catch {}

        // ── Post A/R Invoice ───────────────────────────────────────────────
        if (action?.action === 'post_arinv') {
          const lines = action.lines || [];
          if (!lines.length) {
            reply = '&#x274C; No lines selected. Please select at least one line.';
          } else {
            try {
              const del = session.deliveryDetail;
              const payload = {
                DocDate:    sapDate(action.invoiceDate || today()),
                DocDueDate: sapDate(action.dueDate     || today()),
                CardCode:   del.cardCode || undefined,
                NumAtCard:  action.numAtCard || del.numAtCard || undefined,
                ...(action.comments ? { Comments: action.comments } : {}),
                DocumentLines: lines.map(l => ({
                  BaseType:  15,                      // oDeliveryNotes
                  BaseEntry: Number(del.docEntry),
                  BaseLine:  Number(l.baseLine),
                  Quantity:  Number(l.qty),
                  UnitPrice: Number(l.unitPrice),
                  ...(l.taxCode   ? { TaxCode: l.taxCode }        : {}),
                  ...(l.warehouse ? { WarehouseCode: l.warehouse } : {}),
                })),
              };

              const result = await sap.post('/Invoices', payload);
              session.result = { docEntry: result.DocEntry, docNum: result.DocNum };
              session.step   = 'DONE';

              reply = `### &#x2705; A/R Invoice Posted!\n\n` +
                `| Field | Value |\n|---|---|\n` +
                `| **Invoice #** | ${result.DocNum} |\n` +
                `| **Doc Entry** | ${result.DocEntry} |\n` +
                `| **Customer** | ${del.cardName || del.cardCode || '—'} |\n` +
                `| **Source Delivery** | DN #${del.docNum} |\n` +
                `| **Lines** | ${lines.length} |\n\n` +
                `[&#x1F5A8;&#xFE0F; Print A/R Invoice](/api/delivery-arinv/print/${result.DocEntry})\n\nWould you like to invoice another delivery?`;
              quickReplies = ['Yes, Invoice Another', 'No, Done'];
              meta = {
                docEntry: result.DocEntry,
                docNum:   result.DocNum,
                printUrl: `/api/delivery-arinv/print/${result.DocEntry}`,
              };
            } catch (e) {
              reply = `&#x274C; **Failed to post A/R Invoice**\n\nSAP Error: _${e.message}_\n\nWould you like to **retry** or **cancel**?`;
              quickReplies = ['Open Invoice Form', 'Cancel'];
            }
          }
        }

        // ── Select delivery from list (table row click) ────────────────────
        else if (action?.action === 'select_delivery') {
          const doc = await fetchDeliveryByEntry(sap, action.docEntry);
          if (doc) {
            session.deliveryDetail = buildDeliveryDetail(doc);
            session.step = 'REVIEW_FORM';
            formData = buildFormData(session.deliveryDetail);
            reply = `### Delivery Note #${doc.DocNum} — ${doc.CardName || doc.CardCode}\n\n` +
              `| Field | Value |\n|---|---|\n` +
              `| **Customer** | ${doc.CardName || '—'} (${doc.CardCode || '—'}) |\n` +
              `| **Delivery Date** | ${session.deliveryDetail.docDate || '—'} |\n` +
              `| **Customer Ref** | ${doc.NumAtCard || '—'} |\n` +
              `| **Lines** | ${session.deliveryDetail.lines.length} |\n` +
              `| **Total** | ${fmtN(session.deliveryDetail.docTotal)} |\n\n` +
              `Open the A/R Invoice form to review lines and adjust quantities/prices:`;
            quickReplies = ['Open Invoice Form'];
          } else {
            reply = '&#x274C; Could not load Delivery Note detail. Please try again.';
          }
        }

        // ── Select customer from search result ─────────────────────────────
        else if (action?.action === 'select_customer') {
          const { cardCode, cardName } = action;
          session.selectedCustomer = { cardCode, cardName };
          session.step = 'SELECT_DELIVERY';
          const dels = await fetchOpenDeliveriesByCustomer(sap, cardCode);
          if (!dels.length) {
            reply = `No open delivery notes found for **${cardName}** (${cardCode}).`;
            quickReplies = ['Search Another Customer', 'Start Over'];
            session.step = 'INIT';
          } else {
            deliveryList = mapSourceList(dels);
            reply = `Found **${dels.length}** open delivery note${dels.length !== 1 ? 's' : ''} for **${cardName}**. Click one to load its details:`;
          }
        }

        else {
          reply = 'Unexpected action. Please start over.';
        }
      }

      // ── INIT / SELECT_CUSTOMER — customer search ───────────────────────────
      else if (session.step === 'INIT' || session.step === 'SELECT_CUSTOMER') {
        if (!msg) {
          reply = `## &#x1F535; Delivery Note &#x2192; A/R Invoice Agent\n\n` +
            `*Select a customer to view their open delivery notes, then create an A/R invoice.*\n\n` +
            `Type a **customer name or code** to begin:`;
          session.step = 'INIT';
        } else if (/start over|reset|cancel/i.test(msgL)) {
          Object.assign(session, initSession());
          reply = 'Session reset. Type a customer name or code to begin:';
          session.step = 'INIT';
        } else {
          const customers = await searchCustomers(sap, msg);
          if (!customers.length) {
            reply = `No customers found matching **"${msg}"**. Please try a different name or code.`;
            quickReplies = ['Start Over'];
          } else if (customers.length === 1) {
            const c = customers[0];
            session.selectedCustomer = { cardCode: c.CardCode, cardName: c.CardName };
            session.step = 'SELECT_DELIVERY';
            const dels = await fetchOpenDeliveriesByCustomer(sap, c.CardCode);
            if (!dels.length) {
              reply = `No open delivery notes found for **${c.CardName}** (${c.CardCode}).`;
              quickReplies = ['Search Another Customer', 'Start Over'];
              session.step = 'INIT';
            } else {
              deliveryList = mapSourceList(dels);
              reply = `Found **${dels.length}** open delivery note${dels.length !== 1 ? 's' : ''} for **${c.CardName}**. Click one to load its details:`;
            }
          } else {
            customerList = customers.map(c => ({ cardCode: c.CardCode, cardName: c.CardName }));
            reply = `Found **${customers.length}** customers matching **"${msg}"**. Select one:`;
            session.step = 'SELECT_CUSTOMER';
          }
        }
      }

      // ── SELECT_DELIVERY — delivery list shown, awaiting selection ──────────
      else if (session.step === 'SELECT_DELIVERY') {
        if (/back|customer|change|another/i.test(msgL)) {
          session.selectedCustomer = null;
          session.step = 'INIT';
          reply = 'Returning to customer search. Type a customer name or code:';
        } else {
          const numMatch = msg.match(/^(?:DN#?|DEL#?|DELN#?)?(\d+)$/i);
          if (numMatch) {
            const doc = await fetchDeliveryByNum(sap, numMatch[1]);
            if (doc) {
              session.deliveryDetail = buildDeliveryDetail(doc);
              session.step = 'REVIEW_FORM';
              formData = buildFormData(session.deliveryDetail);
              reply = `### Delivery Note #${doc.DocNum} loaded\n\n` +
                `**${doc.CardName || doc.CardCode}** — ${session.deliveryDetail.lines.length} lines — Total: ${fmtN(session.deliveryDetail.docTotal)}\n\nOpen the Invoice form:`;
              quickReplies = ['Open Invoice Form'];
            } else {
              reply = `Delivery Note #${numMatch[1]} not found or already closed. Please click a delivery from the list above.`;
            }
          } else if (session.selectedCustomer) {
            const dels = await fetchOpenDeliveriesByCustomer(sap, session.selectedCustomer.cardCode);
            deliveryList = mapSourceList(dels);
            reply = `Click a delivery note to load it:`;
          } else {
            reply = 'Please click a delivery note from the list or type a delivery number.';
          }
        }
      }

      // ── REVIEW_FORM ───────────────────────────────────────────────────────
      else if (session.step === 'REVIEW_FORM') {
        if (/open|form|invoice|post|review/i.test(msgL)) {
          formData = buildFormData(session.deliveryDetail);
          reply = 'Opening A/R Invoice form…';
        } else if (/back|change|delivery/i.test(msgL)) {
          session.deliveryDetail = null;
          session.step = 'SELECT_DELIVERY';
          if (session.selectedCustomer) {
            const dels = await fetchOpenDeliveriesByCustomer(sap, session.selectedCustomer.cardCode);
            deliveryList = mapSourceList(dels);
            reply = `Select a different delivery note for **${session.selectedCustomer.cardName}**:`;
          } else {
            reply = 'Please select a delivery note:';
          }
        } else if (/cancel|start over/i.test(msgL)) {
          Object.assign(session, initSession());
          reply = 'Cancelled. Type a customer name or code to start again:';
          session.step = 'INIT';
        } else {
          reply = 'What would you like to do?';
          quickReplies = ['Open Invoice Form', 'Change Delivery Note', 'Cancel'];
        }
      }

      // ── DONE ──────────────────────────────────────────────────────────────
      else if (session.step === 'DONE') {
        if (/yes|another|more|invoice/i.test(msgL)) {
          Object.assign(session, initSession());
          reply = 'Ready. Type a customer name or code to begin a new invoice:';
          session.step = 'INIT';
        } else {
          reply = 'Workflow complete. Click "Invoice Another" to start again.';
          quickReplies = ['Invoice Another'];
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
        deliveryDetail: session.deliveryDetail,
        meta, customerList, deliveryList, formData,
      });

    } catch (e) {
      console.error('[ARINV] chat error:', e);
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
      const doc = await sap.get(`/Invoices(${parseInt(req.params.docEntry, 10)})`);
      res.setHeader('Content-Type', 'text/html');
      res.send(renderARInvPrint(doc));
    } catch (e) {
      res.status(500).send(`<pre style="color:red">Error loading A/R Invoice #${req.params.docEntry}: ${e.message}</pre>`);
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

function buildFormData(del) {
  return {
    docEntry:    del.docEntry,
    docNum:      del.docNum,
    cardCode:    del.cardCode,
    cardName:    del.cardName,
    numAtCard:   del.numAtCard || '',
    invoiceDate: today(),
    dueDate:     today(),
    comments:    del.comments  || '',
    docTotal:    del.docTotal,
    lines:       del.lines.map(l => ({
      ...l,
      invoiceQty: l.qty,   // editable, must be <= delivery qty
    })),
  };
}
