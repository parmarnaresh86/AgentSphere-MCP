/**
 * AP Invoice → AP Credit Memo Agent
 *  1. Search & select vendor
 *  2. Load open AP invoices for that vendor (only open, not closed)
 *  3. Select an invoice → load full line detail
 *  4. Edit qty / unit price at row level
 *  5. Post AP Credit Memo to SAP B1
 */
import { Router } from 'express';

const _sessions = new Map();

function initSession() {
  return {
    step:          'INIT',
    history:       [],
    selectedVendor: null,  // { cardCode, cardName }
    apInvDetail:   null,   // full AP invoice detail
    result:        null,   // { docEntry, docNum } after post
  };
}

function today()    { return new Date().toISOString().slice(0, 10); }
function sapDate(s) { const d = s || today(); return d.length === 10 ? `${d}T00:00:00` : d; }
function fmtN(n, d = 2) {
  if (n == null || isNaN(Number(n))) return '—';
  return Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}
function escHtml(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
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
    console.error('[APCM] searchVendors error:', e.message);
    return [];
  }
}

async function fetchOpenAPInvoicesByVendor(sap, cardCode) {
  const cc = cardCode.replace(/'/g, "''");
  const base = {
    $filter:  `DocumentStatus eq 'bost_Open' and CardCode eq '${cc}'`,
    $orderby: 'DocDate desc',
    $top:     50,
  };
  try {
    const r = await sap.get('/PurchaseInvoices', {
      ...base,
      $select: 'DocEntry,DocNum,DocDate,DocDueDate,CardCode,CardName,DocTotal,NumAtCard',
    });
    if (Array.isArray(r.value)) return r.value;
  } catch { /* $select rejected */ }
  try {
    const r = await sap.get('/PurchaseInvoices', base);
    return Array.isArray(r.value) ? r.value : [];
  } catch (e) {
    console.error('[APCM] fetchOpenAPInvoices error:', e.message);
    return [];
  }
}

async function fetchAPInvByEntry(sap, docEntry) {
  try {
    return await sap.get(`/PurchaseInvoices(${parseInt(docEntry, 10)})`);
  } catch (e) {
    console.error('[APCM] fetchAPInvByEntry error:', e.message);
    return null;
  }
}

async function fetchAPInvByNum(sap, docNum) {
  try {
    const r = await sap.get('/PurchaseInvoices', {
      $filter: `DocNum eq ${parseInt(docNum, 10)} and DocumentStatus eq 'bost_Open'`,
      $top:    1,
    });
    const entry = r.value?.[0];
    if (!entry) return null;
    return await sap.get(`/PurchaseInvoices(${entry.DocEntry})`);
  } catch { return null; }
}

function buildAPInvDetail(doc) {
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

function renderAPCMPrint(doc) {
  const company    = process.env.SAP_B1_COMPANY || process.env.SL_COMPANY || 'Company';
  const lines      = doc.DocumentLines || [];
  const docDate    = doc.DocDate    ? doc.DocDate.slice(0, 10)    : '—';
  const dueDate    = doc.DocDueDate ? doc.DocDueDate.slice(0, 10) : '—';
  const printedOn  = new Date().toLocaleDateString('en-GB', { day:'2-digit', month:'short', year:'numeric' });
  const grandTotal = lines.reduce((s, l) => s + Number(l.LineTotal || 0), 0);
  const taxTotal   = lines.reduce((s, l) => s + Number(l.VatSum   || 0), 0);

  const linesHtml = lines.map((l, i) => `
    <tr>
      <td>${i + 1}</td>
      <td><strong>${l.ItemCode || ''}</strong></td>
      <td>${l.ItemDescription || ''}</td>
      <td style="text-align:right">${Number(l.Quantity   || 0).toFixed(2)}</td>
      <td>${l.UoMCode || l.MeasureUnit || ''}</td>
      <td style="text-align:right">${Number(l.UnitPrice  || 0).toFixed(2)}</td>
      <td style="text-align:right">${Number(l.LineTotal  || 0).toFixed(2)}</td>
      <td>${l.TaxCode || ''}</td>
    </tr>`).join('');

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<title>A/P Credit Memo #${doc.DocNum}</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:Arial,sans-serif;font-size:11px;color:#222;padding:28px 36px;max-width:980px;margin:auto}
  .print-btn{margin-bottom:16px;display:flex;gap:8px;justify-content:flex-end}
  .print-btn button{padding:8px 18px;border:none;border-radius:6px;cursor:pointer;font-size:13px;font-weight:600}
  .btn-print{background:#b91c1c;color:#fff}.btn-close{background:#eee;color:#333}
  .header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:24px;padding-bottom:16px;border-bottom:3px solid #b91c1c}
  .co-name{font-size:20px;font-weight:700;color:#1a1d27}
  .doc-title{font-size:18px;font-weight:700;color:#b91c1c;text-align:right}
  .info-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-bottom:20px}
  .info-box{border:1px solid #ddd;border-radius:6px;padding:12px}
  .info-label{font-size:9px;font-weight:700;text-transform:uppercase;color:#888;letter-spacing:.06em;margin-bottom:6px}
  .info-val{font-size:12px;color:#222;margin-bottom:2px}
  table{width:100%;border-collapse:collapse;margin-bottom:16px}
  thead tr{background:#b91c1c}
  th{padding:8px 10px;text-align:left;font-size:10px;font-weight:700;text-transform:uppercase;color:#fff}
  td{padding:7px 10px;border-bottom:1px solid #eee;font-size:11px}
  tr:nth-child(even) td{background:#fff5f5}
  .totals{text-align:right;padding:8px 0 20px}
  .total-row{font-size:12px;color:#374151;margin-bottom:4px}
  .total-grand{font-size:15px;font-weight:700;color:#b91c1c;margin-top:6px}
  .footer{text-align:center;margin-top:24px;font-size:9px;color:#aaa;border-top:1px solid #eee;padding-top:12px}
  .watermark{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%) rotate(-30deg);font-size:52px;color:rgba(0,0,0,.04);font-weight:900;pointer-events:none;z-index:0}
  @media print{.print-btn{display:none}}
</style></head><body>
<div class="watermark">A/P CREDIT MEMO</div>
<div class="print-btn">
  <button class="btn-close" onclick="window.close()">✕ Close</button>
  <button class="btn-print" onclick="window.print()">🖨️ Print</button>
</div>
<div class="header">
  <div><div class="co-name">${company}</div><div style="color:#888;font-size:11px;margin-top:2px">SAP Business One — A/P Credit Memo</div></div>
  <div><div class="doc-title">A/P Credit Memo</div><div style="font-size:13px;color:#444;text-align:right">CM # ${doc.DocNum}</div></div>
</div>
<div class="info-grid">
  <div class="info-box">
    <div class="info-label">Vendor</div>
    <div class="info-val"><strong>${doc.CardName || '—'}</strong></div>
    ${doc.CardCode ? `<div class="info-val" style="color:#666">${doc.CardCode}</div>` : ''}
  </div>
  <div class="info-box">
    <div class="info-label">Posting Date / Due Date</div>
    <div class="info-val"><strong>${docDate}</strong></div>
    <div class="info-val" style="color:#666">Due: ${dueDate}</div>
  </div>
  <div class="info-box">
    <div class="info-label">Ref / Source Invoice</div>
    <div class="info-val"><strong>${doc.NumAtCard || '—'}</strong></div>
    <div class="info-val" style="color:#666">CM # ${doc.DocNum}</div>
  </div>
</div>
${doc.Comments ? `<div style="border:1px solid #fecaca;border-radius:6px;padding:12px;margin-bottom:20px;background:#fff5f5;font-size:11px;line-height:1.6"><strong>📝 Remarks:</strong><br><br>${doc.Comments}</div>` : ''}
<table>
  <thead><tr>
    <th>#</th><th>Item Code</th><th>Description</th>
    <th style="text-align:right">Qty</th><th>Unit</th>
    <th style="text-align:right">Unit Price</th><th style="text-align:right">Total</th>
    <th>Tax</th>
  </tr></thead>
  <tbody>${linesHtml}</tbody>
</table>
<div class="totals">
  ${taxTotal > 0 ? `<div class="total-row">Subtotal: ${(grandTotal - taxTotal).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}</div>` : ''}
  ${taxTotal > 0 ? `<div class="total-row">Tax: ${taxTotal.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}</div>` : ''}
  <div class="total-grand">Credit Total: ${grandTotal.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}</div>
</div>
<div class="footer">Printed on ${printedOn} &nbsp;|&nbsp; ${company} — SAP B1 A/P Credit Memo #${doc.DocNum} &nbsp;|&nbsp; Powered by AgentSphere AI</div>
</body></html>`;
}

// ── Router factory ─────────────────────────────────────────────────────────────

export function createAPInvToAPCMAgentRouter(deps) {
  const { requireAuth, getActiveSap } = deps;
  const router = Router();

  // ── POST /chat ─────────────────────────────────────────────────────────────
  router.post('/chat', requireAuth, async (req, res) => {
    try {
      const { message = '', sessionId } = req.body;
      const sid = sessionId || `apcm_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      if (!_sessions.has(sid)) _sessions.set(sid, initSession());
      const session = _sessions.get(sid);
      const sap     = getActiveSap();
      const msg     = message.trim();
      const msgL    = msg.toLowerCase();

      if (msg) session.history.push({ role: 'user', content: msg });

      let reply        = '';
      let quickReplies = [];
      let meta         = {};
      let vendorList   = null;
      let apInvList    = null;
      let formData     = null;

      // ── JSON actions ───────────────────────────────────────────────────────
      if (msg.startsWith('{')) {
        let action = null;
        try { action = JSON.parse(msg); } catch {}

        // ── Post AP Credit Memo ────────────────────────────────────────────
        if (action?.action === 'post_apcm') {
          const lines = action.lines || [];
          if (!lines.length) {
            reply = '❌ No lines selected. Please select at least one line.';
          } else {
            try {
              const inv = session.apInvDetail;
              const payload = {
                DocDate:    sapDate(action.docDate  || today()),
                DocDueDate: sapDate(action.dueDate  || today()),
                CardCode:   inv.cardCode || undefined,
                NumAtCard:  action.remarks || inv.numAtCard || undefined,
                ...(action.comments ? { Comments: action.comments } : {}),
                DocumentLines: lines.map(l => ({
                  BaseType:  18,                    // oPurchaseInvoices
                  BaseEntry: Number(inv.docEntry),
                  BaseLine:  Number(l.baseLine),
                  Quantity:  Number(l.qty),
                  UnitPrice: Number(l.unitPrice),
                  ...(l.taxCode   ? { TaxCode: l.taxCode }        : {}),
                  ...(l.warehouse ? { WarehouseCode: l.warehouse } : {}),
                })),
              };

              const result = await sap.post('/PurchaseCreditNotes', payload);
              session.result = { docEntry: result.DocEntry, docNum: result.DocNum };
              session.step   = 'DONE';

              reply = `### ✅ A/P Credit Memo Posted!\n\n` +
                `| Field | Value |\n|---|---|\n` +
                `| **Credit Memo #** | ${result.DocNum} |\n` +
                `| **Doc Entry** | ${result.DocEntry} |\n` +
                `| **Vendor** | ${inv.cardName || inv.cardCode || '—'} |\n` +
                `| **Source AP Invoice** | AP Inv #${inv.docNum} |\n` +
                `| **Lines** | ${lines.length} |\n\n` +
                `[🖨️ Print A/P Credit Memo](/api/apinv-apcm/print/${result.DocEntry})\n\nWould you like to process another credit memo?`;
              quickReplies = ['Yes, Process Another', 'No, Done'];
              meta = {
                docEntry: result.DocEntry,
                docNum:   result.DocNum,
                printUrl: `/api/apinv-apcm/print/${result.DocEntry}`,
              };
            } catch (e) {
              reply = `❌ **Failed to post A/P Credit Memo**\n\nSAP Error: _${e.message}_\n\nWould you like to **retry** or **cancel**?`;
              quickReplies = ['Open Credit Memo Form', 'Cancel'];
            }
          }
        }

        // ── Select AP invoice from vendor list (table row click) ───────────
        else if (action?.action === 'select_apinv') {
          const doc = await fetchAPInvByEntry(sap, action.docEntry);
          if (doc) {
            session.apInvDetail = buildAPInvDetail(doc);
            session.step = 'REVIEW_FORM';
            formData = buildFormData(session.apInvDetail);
            reply = `### AP Invoice #${doc.DocNum} — ${doc.CardName || doc.CardCode}\n\n` +
              `| Field | Value |\n|---|---|\n` +
              `| **Vendor** | ${doc.CardName || '—'} (${doc.CardCode || '—'}) |\n` +
              `| **Date** | ${session.apInvDetail.docDate || '—'} |\n` +
              `| **Supplier Ref** | ${doc.NumAtCard || '—'} |\n` +
              `| **Lines** | ${session.apInvDetail.lines.length} |\n` +
              `| **Total** | ${fmtN(session.apInvDetail.docTotal)} |\n\n` +
              `Open the Credit Memo form to review lines and adjust quantities/prices:`;
            quickReplies = ['Open Credit Memo Form'];
          } else {
            reply = '❌ Could not load AP Invoice detail. Please try again.';
          }
        }

        // ── Select vendor from search result table ─────────────────────────
        else if (action?.action === 'select_vendor') {
          const { cardCode, cardName } = action;
          session.selectedVendor = { cardCode, cardName };
          session.step = 'SELECT_APINV';
          const invs = await fetchOpenAPInvoicesByVendor(sap, cardCode);
          if (!invs.length) {
            reply = `No open AP invoices found for **${cardName}** (${cardCode}).`;
            quickReplies = ['Search Another Vendor', 'Start Over'];
            session.step = 'INIT';
          } else {
            apInvList = mapInvList(invs);
            reply = `Found **${invs.length}** open AP invoice${invs.length !== 1 ? 's' : ''} for **${cardName}**. Click one to load its details:`;
          }
        }

        else {
          reply = 'Unexpected action. Please start over.';
        }
      }

      // ── INIT / SELECT_VENDOR — vendor search ──────────────────────────────
      else if (session.step === 'INIT' || session.step === 'SELECT_VENDOR') {
        if (!msg) {
          reply = `## 🔴 A/P Invoice → Credit Memo Agent\n\n` +
            `*Select a vendor to view their open A/P invoices, then create a credit memo.*\n\n` +
            `Type a **vendor name or code** to begin:`;
          session.step = 'INIT';
        } else if (/start over|reset|cancel/i.test(msgL)) {
          Object.assign(session, initSession());
          reply = 'Session reset. Type a vendor name or code to begin:';
          session.step = 'INIT';
        } else {
          const vendors = await searchVendors(sap, msg);
          if (!vendors.length) {
            reply = `No vendors found matching **"${msg}"**. Please try a different name or code.`;
            quickReplies = ['Start Over'];
          } else if (vendors.length === 1) {
            const v = vendors[0];
            session.selectedVendor = { cardCode: v.CardCode, cardName: v.CardName };
            session.step = 'SELECT_APINV';
            const invs = await fetchOpenAPInvoicesByVendor(sap, v.CardCode);
            if (!invs.length) {
              reply = `No open AP invoices found for **${v.CardName}** (${v.CardCode}).`;
              quickReplies = ['Search Another Vendor', 'Start Over'];
              session.step = 'INIT';
            } else {
              apInvList = mapInvList(invs);
              reply = `Found **${invs.length}** open AP invoice${invs.length !== 1 ? 's' : ''} for **${v.CardName}**. Click one to load its details:`;
            }
          } else {
            vendorList = vendors.map(v => ({ cardCode: v.CardCode, cardName: v.CardName }));
            reply = `Found **${vendors.length}** vendors matching **"${msg}"**. Select one:`;
            session.step = 'SELECT_VENDOR';
          }
        }
      }

      // ── SELECT_APINV — invoice list shown, awaiting selection ─────────────
      else if (session.step === 'SELECT_APINV') {
        if (/back|vendor|change|another/i.test(msgL)) {
          session.selectedVendor = null;
          session.step = 'INIT';
          reply = 'Returning to vendor search. Type a vendor name or code:';
        } else {
          const numMatch = msg.match(/^(?:AP#?|INV#?)?(\d+)$/i);
          if (numMatch) {
            const doc = await fetchAPInvByNum(sap, numMatch[1]);
            if (doc) {
              session.apInvDetail = buildAPInvDetail(doc);
              session.step = 'REVIEW_FORM';
              formData = buildFormData(session.apInvDetail);
              reply = `### AP Invoice #${doc.DocNum} loaded\n\n` +
                `**${doc.CardName || doc.CardCode}** — ${session.apInvDetail.lines.length} lines — Total: ${fmtN(session.apInvDetail.docTotal)}\n\nOpen the Credit Memo form:`;
              quickReplies = ['Open Credit Memo Form'];
            } else {
              reply = `AP Invoice #${numMatch[1]} not found or already closed. Please click an invoice from the list above.`;
            }
          } else if (session.selectedVendor) {
            const invs = await fetchOpenAPInvoicesByVendor(sap, session.selectedVendor.cardCode);
            apInvList = mapInvList(invs);
            reply = `Click an AP invoice to load it:`;
          } else {
            reply = 'Please click an invoice from the list or type an AP invoice number.';
          }
        }
      }

      // ── REVIEW_FORM ───────────────────────────────────────────────────────
      else if (session.step === 'REVIEW_FORM') {
        if (/open|form|credit|post|review/i.test(msgL)) {
          formData = buildFormData(session.apInvDetail);
          reply = 'Opening Credit Memo form…';
        } else if (/back|change|invoice/i.test(msgL)) {
          session.apInvDetail = null;
          session.step = 'SELECT_APINV';
          if (session.selectedVendor) {
            const invs = await fetchOpenAPInvoicesByVendor(sap, session.selectedVendor.cardCode);
            apInvList = mapInvList(invs);
            reply = `Select a different AP invoice for **${session.selectedVendor.cardName}**:`;
          } else {
            reply = 'Please select an AP invoice:';
          }
        } else if (/cancel|start over/i.test(msgL)) {
          Object.assign(session, initSession());
          reply = 'Cancelled. Type a vendor name or code to start again:';
          session.step = 'INIT';
        } else {
          reply = 'What would you like to do?';
          quickReplies = ['Open Credit Memo Form', 'Change Invoice', 'Cancel'];
        }
      }

      // ── DONE ──────────────────────────────────────────────────────────────
      else if (session.step === 'DONE') {
        if (/yes|another|more|process/i.test(msgL)) {
          Object.assign(session, initSession());
          reply = 'Ready. Type a vendor name or code to begin a new credit memo:';
          session.step = 'INIT';
        } else {
          reply = 'Workflow complete. Click "Process Another" to start again.';
          quickReplies = ['Process Another'];
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
        apInvDetail: session.apInvDetail,
        meta, vendorList, apInvList, formData,
      });

    } catch (e) {
      console.error('[APCM] chat error:', e);
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
  router.get('/print/:docEntry', async (req, res) => {
    try {
      const sap = getActiveSap();
      const doc = await sap.get(`/PurchaseCreditNotes(${parseInt(req.params.docEntry, 10)})`);
      res.setHeader('Content-Type', 'text/html');
      res.send(renderAPCMPrint(doc));
    } catch (e) {
      res.status(500).send(`<pre style="color:red">Error loading A/P Credit Memo #${req.params.docEntry}: ${e.message}</pre>`);
    }
  });

  return router;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function mapInvList(invs) {
  return invs.map(i => ({
    docEntry:  i.DocEntry,
    docNum:    i.DocNum,
    docDate:   i.DocDate    ? i.DocDate.slice(0, 10)    : null,
    dueDate:   i.DocDueDate ? i.DocDueDate.slice(0, 10) : null,
    numAtCard: i.NumAtCard  || '',
    docTotal:  Number(i.DocTotal || 0),
  }));
}

function buildFormData(inv) {
  return {
    docEntry:  inv.docEntry,
    docNum:    inv.docNum,
    cardCode:  inv.cardCode,
    cardName:  inv.cardName,
    numAtCard: inv.numAtCard || '',
    docDate:   today(),
    dueDate:   today(),
    docTotal:  inv.docTotal,
    lines:     inv.lines,
  };
}
