/**
 * Outgoing Payment (A/P Disbursement) Agent
 *  1. Search & select vendor (supplier)
 *  2. Show open AP invoices for that vendor (oldest-first for aging priority)
 *  3. User picks subset or "all" invoices
 *  4. Review/edit payment form (cash, transfer, cheque, credit card, BOE)
 *  5. POST to /VendorPayments
 */
import { Router } from 'express';

const _sessions = new Map();

function initSession() {
  return {
    step:          'INIT',
    history:       [],
    selectedVendor: null,   // { cardCode, cardName }
    openInvoices:  [],      // raw invoice rows from SAP
    selectedDocs:  [],      // [{ DocEntry, InvoiceType, SumApplied, DocNum, DocDate, DocDueDate, openAmt, currency }]
    result:        null,    // { docEntry, docNum } after post
  };
}

function today()    { return new Date().toISOString().slice(0, 10); }
function sapDate(s) { const d = (s || today()).slice(0, 10); return `${d}T00:00:00`; }

function fmtN(n, d = 2) {
  if (n == null || isNaN(Number(n))) return '—';
  return Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}

function escHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function daysOverdue(dueDateStr) {
  if (!dueDateStr) return 0;
  const due  = new Date(dueDateStr.slice(0, 10));
  const now  = new Date(today());
  return Math.floor((now - due) / 86400000);
}

// ── SAP helpers ────────────────────────────────────────────────────────────────

async function searchVendors(sap, query) {
  try {
    const q = query.replace(/'/g, "''");
    const r = await sap.get('/BusinessPartners', {
      $filter:  `CardType eq 'cSupplier' and (substringof('${q}',CardName) or substringof('${q}',CardCode))`,
      $select:  'CardCode,CardName,Balance',
      $orderby: 'CardName',
      $top:     20,
    });
    return Array.isArray(r.value) ? r.value : [];
  } catch (e) {
    console.error('[OutPay] searchVendors error:', e.message);
    return [];
  }
}

async function fetchOpenAPInvoices(sap, cardCode) {
  const cc = cardCode.replace(/'/g, "''");
  const base = {
    $filter:  `DocumentStatus eq 'bost_Open' and Cancelled eq 'tNO' and CardCode eq '${cc}'`,
    $orderby: 'DocDate asc',
    $top:     100,
  };
  try {
    const r = await sap.get('/PurchaseInvoices', {
      ...base,
      $select: 'DocEntry,DocNum,DocDate,DocDueDate,DocTotal,PaidToDate,DocCurrency',
    });
    if (Array.isArray(r.value)) return r.value;
  } catch { /* $select may be rejected */ }
  try {
    const r = await sap.get('/PurchaseInvoices', base);
    return Array.isArray(r.value) ? r.value : [];
  } catch (e) {
    console.error('[OutPay] fetchOpenAPInvoices error:', e.message);
    return [];
  }
}

// ── Print layout ───────────────────────────────────────────────────────────────

function renderPaymentVoucher(doc) {
  const company   = process.env.SAP_B1_COMPANY || process.env.SL_COMPANY || 'Company';
  const docDate   = doc.DocDate    ? doc.DocDate.slice(0, 10)    : '—';
  const printedOn = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });

  // Payment means rows
  const means = [];
  if (Number(doc.CashSum || 0) > 0) {
    means.push(`<tr><td>Cash</td><td>${doc.CashAccount || '—'}</td><td>—</td><td style="text-align:right"><strong>${fmtN(doc.CashSum)}</strong></td></tr>`);
  }
  if (Number(doc.TransferSum || 0) > 0) {
    const tDate = doc.TransferDate ? doc.TransferDate.slice(0, 10) : '—';
    means.push(`<tr><td>Bank Transfer</td><td>${doc.TransferAccount || '—'}</td><td>${doc.TransferReference || '—'} / ${tDate}</td><td style="text-align:right"><strong>${fmtN(doc.TransferSum)}</strong></td></tr>`);
  }
  const checks = Array.isArray(doc.PaymentChecks) ? doc.PaymentChecks : [];
  checks.forEach(c => {
    if (Number(c.CheckSum || 0) > 0) {
      means.push(`<tr><td>Cheque</td><td>${c.BankCode || '—'} / ${c.Branch || '—'}</td><td>#${c.CheckNumber || '—'} Due: ${c.DueDate ? c.DueDate.slice(0,10) : '—'}</td><td style="text-align:right"><strong>${fmtN(c.CheckSum)}</strong></td></tr>`);
    }
  });
  const cards = Array.isArray(doc.PaymentCreditCards) ? doc.PaymentCreditCards : [];
  cards.forEach(c => {
    if (Number(c.CreditSum || 0) > 0) {
      means.push(`<tr><td>Credit Card</td><td>${c.CreditCard || '—'}</td><td>${c.VoucherNum || '—'}</td><td style="text-align:right"><strong>${fmtN(c.CreditSum)}</strong></td></tr>`);
    }
  });
  if (Number(doc.BillOfExchangeAmount || 0) > 0) {
    const boeDate = doc.BillOfExchangeDueDate ? doc.BillOfExchangeDueDate.slice(0, 10) : '—';
    means.push(`<tr><td>Bill of Exchange</td><td>—</td><td>Due: ${boeDate}</td><td style="text-align:right"><strong>${fmtN(doc.BillOfExchangeAmount)}</strong></td></tr>`);
  }

  // Applied invoices rows
  const invoices = Array.isArray(doc.PaymentInvoices) ? doc.PaymentInvoices : [];
  const invoiceRows = invoices.map(i => `
    <tr>
      <td>${i.DocEntry || '—'}</td>
      <td>${i.InvoiceType === 'it_PurchaseInvoice' ? 'AP Invoice' : (i.InvoiceType || '—')}</td>
      <td style="text-align:right"><strong>${fmtN(i.SumApplied)}</strong></td>
    </tr>`).join('');

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<title>Outgoing Payment #${doc.DocNum}</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:Arial,sans-serif;font-size:11px;color:#1e293b;padding:28px 36px;max-width:980px;margin:auto}
  .print-btn{margin-bottom:16px;display:flex;gap:8px;justify-content:flex-end}
  .print-btn button{padding:8px 18px;border:none;border-radius:6px;cursor:pointer;font-size:13px;font-weight:600}
  .btn-print{background:#1e40af;color:#fff}
  .btn-close{background:#e2e8f0;color:#334155}
  .header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:24px;padding-bottom:16px;border-bottom:3px solid #1e40af}
  .co-name{font-size:20px;font-weight:700;color:#0f172a}
  .doc-title{font-size:18px;font-weight:700;color:#1e40af;text-align:right}
  .info-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-bottom:20px}
  .info-box{border:1px solid #cbd5e1;border-radius:6px;padding:12px;background:#f8fafc}
  .info-label{font-size:9px;font-weight:700;text-transform:uppercase;color:#64748b;letter-spacing:.06em;margin-bottom:6px}
  .info-val{font-size:12px;color:#1e293b;margin-bottom:2px}
  .section-title{font-size:12px;font-weight:700;color:#1e40af;text-transform:uppercase;letter-spacing:.05em;margin:20px 0 8px;padding-bottom:4px;border-bottom:2px solid #bfdbfe}
  table{width:100%;border-collapse:collapse;margin-bottom:16px}
  thead tr{background:#1e40af}
  th{padding:8px 10px;text-align:left;font-size:10px;font-weight:700;text-transform:uppercase;color:#fff}
  td{padding:7px 10px;border-bottom:1px solid #e2e8f0;font-size:11px}
  tr:nth-child(even) td{background:#eff6ff}
  .totals{text-align:right;padding:8px 0 20px}
  .total-row{font-size:12px;color:#334155;margin-bottom:4px}
  .total-grand{font-size:16px;font-weight:700;color:#1e40af;margin-top:6px;padding-top:6px;border-top:2px solid #bfdbfe}
  .footer{text-align:center;margin-top:24px;font-size:9px;color:#94a3b8;border-top:1px solid #e2e8f0;padding-top:12px}
  .watermark{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%) rotate(-30deg);font-size:48px;color:rgba(30,64,175,.04);font-weight:900;pointer-events:none;z-index:0}
  .badge-paid{display:inline-block;background:#1e40af;color:#fff;border-radius:9999px;padding:2px 10px;font-size:10px;font-weight:700;margin-left:6px;vertical-align:middle}
  @media print{.print-btn{display:none}}
</style></head><body>
<div class="watermark">OUTGOING PAYMENT</div>
<div class="print-btn">
  <button class="btn-close" onclick="window.close()">&#x2715; Close</button>
  <button class="btn-print" onclick="window.print()">&#x1F5A8; Print</button>
</div>
<div class="header">
  <div>
    <div class="co-name">${escHtml(company)}</div>
    <div style="color:#64748b;font-size:11px;margin-top:2px">SAP Business One — Outgoing Payment (A/P Disbursement)</div>
  </div>
  <div>
    <div class="doc-title">Payment Voucher <span class="badge-paid">PAID</span></div>
    <div style="font-size:13px;color:#334155;text-align:right">Payment # ${doc.DocNum}</div>
  </div>
</div>
<div class="info-grid">
  <div class="info-box">
    <div class="info-label">Vendor</div>
    <div class="info-val"><strong>${escHtml(doc.CardName || '—')}</strong></div>
    ${doc.CardCode ? `<div class="info-val" style="color:#64748b">${escHtml(doc.CardCode)}</div>` : ''}
  </div>
  <div class="info-box">
    <div class="info-label">Payment Date</div>
    <div class="info-val"><strong>${docDate}</strong></div>
    <div class="info-val" style="color:#64748b">Posted: ${printedOn}</div>
  </div>
  <div class="info-box">
    <div class="info-label">Reference / Remarks</div>
    <div class="info-val"><strong>${escHtml(doc.CounterReference || '—')}</strong></div>
    ${doc.Remarks ? `<div class="info-val" style="color:#64748b">${escHtml(doc.Remarks)}</div>` : ''}
  </div>
</div>

${means.length ? `
<div class="section-title">Payment Means</div>
<table>
  <thead><tr><th>Method</th><th>Account / Card</th><th>Reference</th><th style="text-align:right">Amount</th></tr></thead>
  <tbody>${means.join('')}</tbody>
</table>` : ''}

${invoiceRows ? `
<div class="section-title">Applied to Invoices</div>
<table>
  <thead><tr><th>Doc Entry</th><th>Type</th><th style="text-align:right">Amount Applied</th></tr></thead>
  <tbody>${invoiceRows}</tbody>
</table>` : ''}

<div class="totals">
  <div class="total-grand">Total Payment: ${fmtN(doc.DocTotal || doc.CashSum || doc.TransferSum || 0)}</div>
</div>
<div class="footer">Printed on ${printedOn} &nbsp;|&nbsp; ${escHtml(company)} — SAP B1 Outgoing Payment #${doc.DocNum} &nbsp;|&nbsp; Powered by Henny AI Solution</div>
<script>window.onload = function(){ window.print(); };</script>
</body></html>`;
}

// ── Router factory ─────────────────────────────────────────────────────────────

export function createOutgoingPaymentRouter(deps) {
  const { requireAuth, getActiveSap } = deps;
  const router = Router();

  // ── POST /chat ─────────────────────────────────────────────────────────────
  router.post('/chat', requireAuth, async (req, res) => {
    try {
      const { message = '', sessionId } = req.body;
      const sid = sessionId || `outpay_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
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
      let docs         = null;
      let bp           = null;
      let actionOut    = undefined;
      let step         = session.step;

      // ── JSON actions ───────────────────────────────────────────────────────
      if (msg.startsWith('{')) {
        let action = null;
        try { action = JSON.parse(msg); } catch {}

        // ── select_bp ─────────────────────────────────────────────────────
        if (action?.action === 'select_bp') {
          const { cardCode, cardName } = action;
          session.selectedVendor = { cardCode, cardName };
          session.step = 'SELECT_INVOICES';

          const invs = await fetchOpenAPInvoices(sap, cardCode);
          if (!invs.length) {
            session.step = 'INIT';
            reply = `No open AP invoices found for **${escHtml(cardName)}** (${escHtml(cardCode)}).`;
            quickReplies = ['Search Another Vendor', 'Start Over'];
          } else {
            session.openInvoices = invs;
            docs = mapInvoiceList(invs);
            bp   = { cardCode, cardName };
            reply = buildInvoiceListReply(cardName, invs);
            quickReplies = ['Select All', 'Cancel'];
            step = 'SELECT_INVOICES';
          }
        }

        // ── select_invoices ────────────────────────────────────────────────
        else if (action?.action === 'select_invoices') {
          const entries = Array.isArray(action.docEntries) ? action.docEntries : [];
          if (!entries.length) {
            reply = '&#x26A0;&#xFE0F; Please select at least one invoice.';
            quickReplies = ['Select All'];
          } else {
            const selected = session.openInvoices.filter(i => entries.includes(Number(i.DocEntry)));
            if (!selected.length) {
              reply = '&#x26A0;&#xFE0F; None of the selected entries matched. Please try again.';
            } else {
              session.selectedDocs = selected.map(i => ({
                DocEntry:    Number(i.DocEntry),
                InvoiceType: 'it_PurchaseInvoice',
                SumApplied:  Number(i.DocTotal || 0) - Number(i.PaidToDate || 0),
                DocNum:      i.DocNum,
                DocDate:     i.DocDate    ? i.DocDate.slice(0, 10)    : null,
                DocDueDate:  i.DocDueDate ? i.DocDueDate.slice(0, 10) : null,
                openAmt:     Number(i.DocTotal || 0) - Number(i.PaidToDate || 0),
                currency:    i.DocCurrency || '',
              }));
              session.step = 'REVIEW_FORM';
              step = 'REVIEW_FORM';
              docs = mapInvoiceList(selected);
              bp   = session.selectedVendor;
              actionOut = 'open_form';
              reply = buildSelectedSummary(session.selectedDocs, session.selectedVendor);
              quickReplies = ['Post Payment', 'Change Selection', 'Cancel'];
            }
          }
        }

        // ── post_payment ───────────────────────────────────────────────────
        else if (action?.action === 'post_payment') {
          try {
            const payload = buildVendorPaymentPayload(action);
            const result  = await sap.post('/VendorPayments', payload);
            session.result = { docEntry: result.DocEntry, docNum: result.DocNum };
            session.step   = 'DONE';
            step = 'DONE';

            const totalPaid = (action.CashSum || 0) + (action.TransferSum || 0) +
              ((action.Checks  || []).reduce((s, c) => s + Number(c.CheckSum  || 0), 0)) +
              ((action.CreditCards || []).reduce((s, c) => s + Number(c.CreditSum || 0), 0)) +
              (action.BillOfExchangeAmount || 0);

            reply = `### &#x2705; Outgoing Payment Posted!\n\n` +
              `| Field | Value |\n|---|---|\n` +
              `| **Payment #** | ${result.DocNum} |\n` +
              `| **Doc Entry** | ${result.DocEntry} |\n` +
              `| **Vendor** | ${escHtml(action.CardCode)} |\n` +
              `| **Payment Date** | ${(action.DocDate || '').slice(0, 10)} |\n` +
              `| **Total Paid** | ${fmtN(totalPaid)} |\n` +
              `| **Invoices Applied** | ${(action.PaymentInvoices || []).length} |\n\n` +
              `[&#x1F5A8;&#xFE0F; Print Payment Voucher](/api/outgoing-payment/print/${result.DocEntry})\n\n` +
              `Would you like to process another payment?`;
            quickReplies = ['Yes, Process Another', 'No, Done'];
            meta = {
              docEntry: result.DocEntry,
              docNum:   result.DocNum,
              printUrl: `/api/outgoing-payment/print/${result.DocEntry}`,
            };
          } catch (e) {
            reply = `&#x274C; **Failed to post Outgoing Payment**\n\nSAP Error: _${escHtml(e.message)}_\n\nPlease review the form and try again.`;
            quickReplies = ['Open Payment Form', 'Cancel'];
            step = 'REVIEW_FORM';
          }
        }

        else {
          reply = 'Unexpected action. Please start over.';
          quickReplies = ['Start Over'];
        }
      }

      // ── INIT / SELECT_BP — vendor search ──────────────────────────────────
      else if (session.step === 'INIT' || session.step === 'SELECT_BP') {
        if (!msg) {
          reply = buildWelcomeMessage();
          session.step = 'INIT';
          step = 'INIT';
        } else if (/start over|reset|cancel/i.test(msgL)) {
          Object.assign(session, initSession());
          step = 'INIT';
          reply = 'Session reset. Type a vendor name or code to begin:';
        } else {
          const vendors = await searchVendors(sap, msg);
          if (!vendors.length) {
            reply = `No vendors found matching **"${escHtml(msg)}"**. Please try a different name or code.`;
            quickReplies = ['Start Over'];
          } else if (vendors.length === 1) {
            const v = vendors[0];
            session.selectedVendor = { cardCode: v.CardCode, cardName: v.CardName };
            const invs = await fetchOpenAPInvoices(sap, v.CardCode);
            if (!invs.length) {
              reply = `No open AP invoices found for **${escHtml(v.CardName)}** (${escHtml(v.CardCode)}).`;
              quickReplies = ['Search Another Vendor', 'Start Over'];
              session.step = 'INIT';
              step = 'INIT';
            } else {
              session.openInvoices = invs;
              session.step = 'SELECT_INVOICES';
              step = 'SELECT_INVOICES';
              docs = mapInvoiceList(invs);
              bp   = { cardCode: v.CardCode, cardName: v.CardName };
              reply = buildInvoiceListReply(v.CardName, invs);
              quickReplies = ['Select All', 'Cancel'];
            }
          } else {
            vendorList = vendors.map(v => ({
              cardCode: v.CardCode,
              cardName: v.CardName,
              balance:  Number(v.Balance || 0),
            }));
            reply = `Found **${vendors.length}** vendors matching **"${escHtml(msg)}"**. Select one:`;
            session.step = 'SELECT_BP';
            step = 'SELECT_BP';
          }
        }
      }

      // ── SELECT_INVOICES — invoice list shown, user picks ──────────────────
      else if (session.step === 'SELECT_INVOICES') {
        if (/select all|all invoices/i.test(msgL)) {
          // Auto-select all open invoices
          const all = session.openInvoices;
          if (!all.length) {
            reply = 'No open invoices to select.';
          } else {
            session.selectedDocs = all.map(i => ({
              DocEntry:    Number(i.DocEntry),
              InvoiceType: 'it_PurchaseInvoice',
              SumApplied:  Number(i.DocTotal || 0) - Number(i.PaidToDate || 0),
              DocNum:      i.DocNum,
              DocDate:     i.DocDate    ? i.DocDate.slice(0, 10)    : null,
              DocDueDate:  i.DocDueDate ? i.DocDueDate.slice(0, 10) : null,
              openAmt:     Number(i.DocTotal || 0) - Number(i.PaidToDate || 0),
              currency:    i.DocCurrency || '',
            }));
            session.step = 'REVIEW_FORM';
            step = 'REVIEW_FORM';
            docs = mapInvoiceList(all);
            bp   = session.selectedVendor;
            actionOut = 'open_form';
            reply = buildSelectedSummary(session.selectedDocs, session.selectedVendor);
            quickReplies = ['Post Payment', 'Change Selection', 'Cancel'];
          }
        } else if (/back|change vendor|another vendor/i.test(msgL)) {
          session.selectedVendor = null;
          session.openInvoices   = [];
          session.step = 'INIT';
          step = 'INIT';
          reply = 'Returning to vendor search. Type a vendor name or code:';
        } else if (/cancel|start over/i.test(msgL)) {
          Object.assign(session, initSession());
          step = 'INIT';
          reply = 'Cancelled. Type a vendor name or code to start again:';
        } else {
          // Refresh / re-show invoice list
          if (session.selectedVendor && session.openInvoices.length) {
            docs = mapInvoiceList(session.openInvoices);
            bp   = session.selectedVendor;
            reply = buildInvoiceListReply(session.selectedVendor.cardName, session.openInvoices);
            quickReplies = ['Select All', 'Cancel'];
          } else {
            reply = 'Please select one or more invoices from the list, or type "select all".';
            quickReplies = ['Select All', 'Cancel'];
          }
        }
      }

      // ── REVIEW_FORM — form open, waiting for post_payment action ─────────
      else if (session.step === 'REVIEW_FORM') {
        if (/open|form|payment|post|review/i.test(msgL)) {
          docs = session.selectedDocs.length ? mapInvoiceList(
            session.openInvoices.filter(i =>
              session.selectedDocs.some(d => d.DocEntry === Number(i.DocEntry))
            )
          ) : null;
          bp = session.selectedVendor;
          actionOut = 'open_form';
          step = 'REVIEW_FORM';
          reply = 'Opening Payment form…';
        } else if (/change|back|invoice/i.test(msgL)) {
          session.selectedDocs = [];
          session.step = 'SELECT_INVOICES';
          step = 'SELECT_INVOICES';
          if (session.openInvoices.length) {
            docs = mapInvoiceList(session.openInvoices);
            bp   = session.selectedVendor;
            reply = buildInvoiceListReply(session.selectedVendor?.cardName || 'Vendor', session.openInvoices);
            quickReplies = ['Select All', 'Cancel'];
          } else {
            reply = 'Please select invoices:';
          }
        } else if (/cancel|start over/i.test(msgL)) {
          Object.assign(session, initSession());
          step = 'INIT';
          reply = 'Cancelled. Type a vendor name or code to start again:';
        } else {
          docs = null;
          step = 'REVIEW_FORM';
          reply = 'What would you like to do?';
          quickReplies = ['Open Payment Form', 'Change Invoice Selection', 'Cancel'];
        }
      }

      // ── DONE ──────────────────────────────────────────────────────────────
      else if (session.step === 'DONE') {
        if (/yes|another|more|process/i.test(msgL)) {
          Object.assign(session, initSession());
          step = 'INIT';
          reply = 'Ready. Type a vendor name or code to begin a new payment:';
        } else {
          step = 'DONE';
          reply = 'Workflow complete. Click "Process Another" to start again.';
          quickReplies = ['Process Another'];
          if (session.result) {
            meta = {
              docEntry: session.result.docEntry,
              docNum:   session.result.docNum,
              printUrl: `/api/outgoing-payment/print/${session.result.docEntry}`,
            };
          }
        }
      }

      // ── Fallback ──────────────────────────────────────────────────────────
      else {
        Object.assign(session, initSession());
        step = 'INIT';
        reply = 'Session reset. Type a vendor name or code to begin:';
      }

      // Sync session.step back (in case sub-branches updated step but not session.step)
      session.step = step;

      session.history.push({ role: 'assistant', content: reply });
      if (session.history.length > 40) session.history.splice(0, session.history.length - 40);

      const responseObj = {
        ok:           true,
        reply,
        sessionId:    sid,
        quickReplies,
        step,
        meta,
        bp:           bp || session.selectedVendor,
        docs:         docs || null,
        vendorList:   vendorList || null,
        selectedDocs: session.selectedDocs,
      };
      if (actionOut) responseObj.action = actionOut;

      res.json(responseObj);

    } catch (e) {
      console.error('[OutPay] chat error:', e);
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
  router.get('/print/:docEntry', requireAuth, async (req, res) => {
    try {
      const sap = getActiveSap();
      const doc = await sap.get(`/VendorPayments(${parseInt(req.params.docEntry, 10)})`);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(renderPaymentVoucher(doc));
    } catch (e) {
      res.status(500).send(`<pre style="color:red;padding:20px">Error loading Outgoing Payment #${parseInt(req.params.docEntry, 10)}: ${escHtml(e.message)}</pre>`);
    }
  });

  return router;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function mapInvoiceList(invs) {
  const now = today();
  return invs.map(i => {
    const openAmt  = Number(i.DocTotal || 0) - Number(i.PaidToDate || 0);
    const overdue  = daysOverdue(i.DocDueDate);
    return {
      docEntry:  Number(i.DocEntry),
      docNum:    i.DocNum,
      docDate:   i.DocDate    ? i.DocDate.slice(0, 10)    : null,
      dueDate:   i.DocDueDate ? i.DocDueDate.slice(0, 10) : null,
      docTotal:  Number(i.DocTotal   || 0),
      paidToDate:Number(i.PaidToDate || 0),
      openAmt,
      currency:  i.DocCurrency || '',
      overdue,
      isOverdue: overdue > 0,
    };
  });
}

function buildWelcomeMessage() {
  return `## &#x1F4B8; Outgoing Payment Agent\n\n` +
    `*Post vendor payments (A/P disbursements) directly to SAP Business One.*\n\n` +
    `**How it works:**\n` +
    `1. Search for a vendor by name or code\n` +
    `2. Select one or more open AP invoices to pay\n` +
    `3. Enter payment details (transfer, cash, cheque, etc.)\n` +
    `4. Post the payment to SAP B1\n\n` +
    `Type a **vendor name or code** to begin:`;
}

function buildInvoiceListReply(vendorName, invs) {
  const total = invs.reduce((s, i) => s + (Number(i.DocTotal || 0) - Number(i.PaidToDate || 0)), 0);
  const overdueCount = invs.filter(i => daysOverdue(i.DocDueDate) > 0).length;

  let msg = `Found **${invs.length}** open AP invoice${invs.length !== 1 ? 's' : ''} for **${escHtml(vendorName)}** — ` +
    `Total outstanding: **${fmtN(total)}**`;
  if (overdueCount > 0) {
    msg += ` *(${overdueCount} overdue)*`;
  }
  msg += `\n\nInvoices are sorted oldest-first to prioritise aging payables. Select invoices to pay:`;
  return msg;
}

function buildSelectedSummary(selectedDocs, vendor) {
  const totalApplied = selectedDocs.reduce((s, d) => s + Number(d.SumApplied || 0), 0);
  const overdueItems = selectedDocs.filter(d => daysOverdue(d.DocDueDate) > 0);

  let msg = `### Payment Summary for **${escHtml(vendor?.cardName || '')}**\n\n` +
    `| # | AP Invoice | Date | Due Date | Amount |\n|---|---|---|---|---|\n`;

  selectedDocs.forEach((d, i) => {
    const overdue  = daysOverdue(d.DocDueDate);
    const overdueStr = overdue > 0
      ? ` <span style="color:#dc2626">&#x26A0; ${overdue}d overdue</span>`
      : '';
    msg += `| ${i + 1} | #${d.DocNum} | ${d.DocDate || '—'} | ${d.DocDueDate || '—'}${overdueStr} | **${fmtN(d.SumApplied)}** |\n`;
  });

  msg += `\n**Total to Pay: ${fmtN(totalApplied)}**`;
  if (overdueItems.length > 0) {
    msg += `\n\n> &#x26A0;&#xFE0F; **${overdueItems.length}** invoice${overdueItems.length !== 1 ? 's are' : ' is'} overdue. Paying these will clear aging payables.`;
  }
  msg += `\n\nOpen the payment form to enter payment means and post:`;
  return msg;
}

function buildVendorPaymentPayload(action) {
  const payload = {
    CardCode:  action.CardCode,
    DocDate:   sapDate(action.DocDate),
    CounterReference: action.CounterReference || undefined,
    Remarks:   action.Remarks || undefined,
    PaymentInvoices: (action.PaymentInvoices || []).map(pi => ({
      DocEntry:    Number(pi.DocEntry),
      InvoiceType: 'it_PurchaseInvoice',
      SumApplied:  Number(pi.SumApplied || 0),
    })),
  };

  // Cash
  if (Number(action.CashSum || 0) > 0) {
    payload.CashSum     = Number(action.CashSum);
    payload.CashAccount = action.CashAccount || undefined;
  }

  // Bank Transfer
  if (Number(action.TransferSum || 0) > 0) {
    payload.TransferSum       = Number(action.TransferSum);
    payload.TransferAccount   = action.TransferAccount   || undefined;
    payload.TransferDate      = sapDate(action.TransferDate || action.DocDate);
    payload.TransferReference = action.TransferReference || undefined;
  }

  // Cheques
  const checks = Array.isArray(action.Checks) ? action.Checks.filter(c => Number(c.CheckSum || 0) > 0) : [];
  if (checks.length) {
    payload.PaymentChecks = checks.map(c => ({
      CheckSum:     Number(c.CheckSum),
      CheckNumber:  c.CheckNumber  || undefined,
      BankCode:     c.BankCode     || undefined,
      Branch:       c.Branch       || undefined,
      DueDate:      c.DueDate      ? sapDate(c.DueDate) : undefined,
      Trnsfrable:   c.Transferable ? 'tYES' : 'tNO',
    }));
  }

  // Credit Cards
  const cards = Array.isArray(action.CreditCards) ? action.CreditCards.filter(c => Number(c.CreditSum || 0) > 0) : [];
  if (cards.length) {
    payload.PaymentCreditCards = cards.map(c => ({
      CreditCard:       c.CreditCard       || undefined,
      CreditCardNumber: c.CreditCardNumber || undefined,
      CardValidUntil:   c.CardValidUntil   ? sapDate(c.CardValidUntil) : undefined,
      VoucherNum:       c.VoucherNum        || undefined,
      CreditSum:        Number(c.CreditSum),
    }));
  }

  // Bill of Exchange
  if (Number(action.BillOfExchangeAmount || 0) > 0) {
    payload.BillOfExchangeAmount  = Number(action.BillOfExchangeAmount);
    payload.BillOfExchangeDueDate = action.BillOfExchangeDueDate
      ? sapDate(action.BillOfExchangeDueDate)
      : undefined;
  }

  return payload;
}
