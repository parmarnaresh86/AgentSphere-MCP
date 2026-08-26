/**
 * Incoming Payment (A/R Receipt) Agent
 *  1. Search & select customer
 *  2. Load open AR invoices for that customer
 *  3. Select invoices (subset or all) to apply payment against
 *  4. Review/edit payment form (payment means: cash, transfer, cheques, cards, BoE)
 *  5. Post IncomingPayment to SAP B1
 */
import { Router } from 'express';

const _sessions = new Map();

function initSession() {
  return {
    step:          'INIT',
    history:       [],
    selectedBP:    null,   // { cardCode, cardName }
    openInvoices:  [],     // list of open AR invoices
    selectedDocs:  [],     // chosen invoice entries for payment
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
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── SAP helpers ────────────────────────────────────────────────────────────────

async function searchCustomers(sap, query) {
  try {
    const q = query.replace(/'/g, "''");
    const r = await sap.get('/BusinessPartners', {
      $filter:  `CardType eq 'cCustomer' and (substringof('${q}',CardName) or substringof('${q}',CardCode))`,
      $select:  'CardCode,CardName,Balance',
      $orderby: 'CardName',
      $top:     20,
    });
    return Array.isArray(r.value) ? r.value : [];
  } catch (e) {
    console.error('[INPAY] searchCustomers error:', e.message);
    return [];
  }
}

async function fetchOpenARInvoices(sap, cardCode) {
  const cc = cardCode.replace(/'/g, "''");
  try {
    const r = await sap.get('/Invoices', {
      $filter:  `DocumentStatus eq 'bost_Open' and Cancelled eq 'tNO' and CardCode eq '${cc}'`,
      $select:  'DocEntry,DocNum,DocDate,DocDueDate,DocTotal,PaidToDate,DocCurrency',
      $orderby: 'DocDate desc',
      $top:     100,
    });
    return Array.isArray(r.value) ? r.value : [];
  } catch (e) {
    console.error('[INPAY] fetchOpenARInvoices error:', e.message);
    return [];
  }
}

async function fetchIncomingPayment(sap, docEntry) {
  try {
    return await sap.get(`/IncomingPayments(${parseInt(docEntry, 10)})`);
  } catch (e) {
    console.error('[INPAY] fetchIncomingPayment error:', e.message);
    return null;
  }
}

function mapInvoiceList(invs) {
  return invs.map(i => ({
    docEntry:   i.DocEntry,
    docNum:     i.DocNum,
    docDate:    i.DocDate    ? i.DocDate.slice(0, 10)    : null,
    docDueDate: i.DocDueDate ? i.DocDueDate.slice(0, 10) : null,
    docTotal:   Number(i.DocTotal   || 0),
    paidToDate: Number(i.PaidToDate || 0),
    openAmount: Math.max(0, Number(i.DocTotal || 0) - Number(i.PaidToDate || 0)),
    currency:   i.DocCurrency || '',
  }));
}

// ── Payment posting ────────────────────────────────────────────────────────────

function buildPaymentPayload(action) {
  const payload = {
    CardCode: action.CardCode,
    DocDate:  sapDate(action.DocDate),
  };

  if (action.CounterReference) payload.CounterReference = action.CounterReference;
  if (action.Remarks)          payload.Remarks          = action.Remarks;

  // PaymentInvoices
  if (Array.isArray(action.PaymentInvoices) && action.PaymentInvoices.length > 0) {
    payload.PaymentInvoices = action.PaymentInvoices.map(pi => ({
      DocEntry:    Number(pi.DocEntry),
      InvoiceType: pi.InvoiceType || 'it_Invoice',
      SumApplied:  Number(pi.SumApplied || 0),
    }));
  }

  // Cash
  const cashSum = Number(action.CashSum || 0);
  if (cashSum > 0) {
    payload.CashSum = cashSum;
    if (action.CashAccount) payload.CashAccount = action.CashAccount;
  }

  // Bank Transfer
  const transferSum = Number(action.TransferSum || 0);
  if (transferSum > 0) {
    payload.TransferSum       = transferSum;
    payload.TransferAccount   = action.TransferAccount   || '';
    payload.TransferDate      = sapDate(action.TransferDate || action.DocDate);
    payload.TransferReference = action.TransferReference || '';
  }

  // Cheques — filter out rows with CheckSum <= 0
  if (Array.isArray(action.Checks)) {
    const validChecks = action.Checks.filter(c => Number(c.CheckSum || 0) > 0);
    if (validChecks.length > 0) {
      payload.PaymentChecks = validChecks.map(c => ({
        CheckSum:    Number(c.CheckSum),
        CheckNumber: c.CheckNumber || '',
        BankCode:    c.BankCode    || '',
        Branch:      c.Branch      || '',
        DueDate:     sapDate(c.DueDate || action.DocDate),
        Trnsfrable:  c.Transferable ? 'tYES' : 'tNO',
      }));
    }
  }

  // Credit Cards — filter out rows with CreditSum <= 0
  if (Array.isArray(action.CreditCards)) {
    const validCards = action.CreditCards.filter(c => Number(c.CreditSum || 0) > 0);
    if (validCards.length > 0) {
      payload.PaymentCreditCards = validCards.map(c => ({
        CreditCard:       c.CreditCard       || '',
        CreditCardNumber: c.CreditCardNumber || '',
        CardValidUntil:   sapDate(c.CardValidUntil || action.DocDate),
        VoucherNum:       c.VoucherNum        || '',
        CreditSum:        Number(c.CreditSum),
      }));
    }
  }

  // Bill of Exchange
  const boeAmount = Number(action.BillOfExchangeAmount || 0);
  if (boeAmount > 0) {
    payload.BillOfExchangeAmount  = boeAmount;
    if (action.BillOfExchangeDueDate)
      payload.BillOfExchangeDueDate = sapDate(action.BillOfExchangeDueDate);
  }

  return payload;
}

// ── Print layout ───────────────────────────────────────────────────────────────

function renderPaymentPrint(doc) {
  const company   = process.env.SAP_B1_COMPANY || process.env.SL_COMPANY || 'Company';
  const docDate   = doc.DocDate   ? doc.DocDate.slice(0, 10)   : '—';
  const printedOn = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });

  // Payment means
  const cashSum     = Number(doc.CashSum     || 0);
  const transferSum = Number(doc.TransferSum || 0);

  const checks = (doc.PaymentChecks      || []).filter(c => Number(c.CheckSum  || 0) > 0);
  const cards  = (doc.PaymentCreditCards || []).filter(c => Number(c.CreditSum || 0) > 0);
  const boeAmt = Number(doc.BillOfExchangeAmount || 0);

  const checksTotal = checks.reduce((s, c) => s + Number(c.CheckSum  || 0), 0);
  const cardsTotal  = cards.reduce( (s, c) => s + Number(c.CreditSum || 0), 0);
  const grandTotal  = cashSum + transferSum + checksTotal + cardsTotal + boeAmt;

  // Applied invoices
  const invoices = doc.PaymentInvoices || [];
  const invoiceRows = invoices.map((inv, i) => `
    <tr>
      <td>${i + 1}</td>
      <td><strong>${inv.DocNum || inv.DocEntry}</strong></td>
      <td>${inv.InvoiceType === 'it_Invoice' ? 'AR Invoice' : inv.InvoiceType || '—'}</td>
      <td style="text-align:right">${fmtN(inv.SumApplied)}</td>
    </tr>`).join('');

  // Cheque rows
  const chequeRows = checks.map((c, i) => `
    <tr>
      <td>${i + 1}</td>
      <td>${escHtml(c.CheckNumber || '—')}</td>
      <td>${escHtml(c.BankCode || '—')}</td>
      <td>${escHtml(c.Branch   || '—')}</td>
      <td>${c.DueDate ? c.DueDate.slice(0, 10) : '—'}</td>
      <td style="text-align:right">${fmtN(c.CheckSum)}</td>
    </tr>`).join('');

  // Card rows
  const cardRows = cards.map((c, i) => `
    <tr>
      <td>${i + 1}</td>
      <td>${escHtml(c.CreditCard || '—')}</td>
      <td>${escHtml(c.VoucherNum || '—')}</td>
      <td style="text-align:right">${fmtN(c.CreditSum)}</td>
    </tr>`).join('');

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<title>Incoming Payment #${doc.DocNum}</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:Arial,sans-serif;font-size:11px;color:#222;padding:28px 36px;max-width:980px;margin:auto}
  .print-btn{margin-bottom:16px;display:flex;gap:8px;justify-content:flex-end}
  .print-btn button{padding:8px 18px;border:none;border-radius:6px;cursor:pointer;font-size:13px;font-weight:600}
  .btn-print{background:#047857;color:#fff}.btn-close{background:#eee;color:#333}
  .header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:24px;padding-bottom:16px;border-bottom:3px solid #047857}
  .co-name{font-size:20px;font-weight:700;color:#1a1d27}
  .doc-title{font-size:18px;font-weight:700;color:#047857;text-align:right}
  .info-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-bottom:20px}
  .info-box{border:1px solid #d1fae5;border-radius:6px;padding:12px;background:#f0fdf4}
  .info-label{font-size:9px;font-weight:700;text-transform:uppercase;color:#065f46;letter-spacing:.06em;margin-bottom:6px}
  .info-val{font-size:12px;color:#222;margin-bottom:2px}
  .section-title{font-size:12px;font-weight:700;color:#047857;text-transform:uppercase;letter-spacing:.05em;margin:18px 0 8px;padding-bottom:4px;border-bottom:2px solid #d1fae5}
  table{width:100%;border-collapse:collapse;margin-bottom:16px}
  thead tr{background:#047857}
  th{padding:8px 10px;text-align:left;font-size:10px;font-weight:700;text-transform:uppercase;color:#fff}
  td{padding:7px 10px;border-bottom:1px solid #d1fae5;font-size:11px}
  tr:nth-child(even) td{background:#f0fdf4}
  .means-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:12px;margin-bottom:20px}
  .means-box{border:1px solid #d1fae5;border-radius:6px;padding:12px}
  .means-label{font-size:10px;font-weight:700;color:#065f46;text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px}
  .means-amount{font-size:14px;font-weight:700;color:#047857}
  .totals{text-align:right;padding:8px 0 20px}
  .total-grand{font-size:16px;font-weight:700;color:#047857;margin-top:6px}
  .footer{text-align:center;margin-top:24px;font-size:9px;color:#aaa;border-top:1px solid #eee;padding-top:12px}
  .watermark{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%) rotate(-30deg);font-size:52px;color:rgba(0,0,0,.04);font-weight:900;pointer-events:none;z-index:0}
  @media print{.print-btn{display:none}}
</style></head><body>
<div class="watermark">PAYMENT RECEIPT</div>
<div class="print-btn">
  <button class="btn-close" onclick="window.close()">&#10005; Close</button>
  <button class="btn-print" onclick="window.print()">&#128424; Print</button>
</div>
<div class="header">
  <div>
    <div class="co-name">${escHtml(company)}</div>
    <div style="color:#888;font-size:11px;margin-top:2px">SAP Business One &mdash; Incoming Payment Receipt</div>
  </div>
  <div>
    <div class="doc-title">Incoming Payment</div>
    <div style="font-size:13px;color:#444;text-align:right">Receipt # ${escHtml(String(doc.DocNum || '—'))}</div>
  </div>
</div>

<div class="info-grid">
  <div class="info-box">
    <div class="info-label">Customer</div>
    <div class="info-val"><strong>${escHtml(doc.CardName || '—')}</strong></div>
    ${doc.CardCode ? `<div class="info-val" style="color:#666">${escHtml(doc.CardCode)}</div>` : ''}
  </div>
  <div class="info-box">
    <div class="info-label">Payment Date</div>
    <div class="info-val"><strong>${escHtml(docDate)}</strong></div>
    ${doc.CounterReference ? `<div class="info-val" style="color:#666">Ref: ${escHtml(doc.CounterReference)}</div>` : ''}
  </div>
  <div class="info-box">
    <div class="info-label">Total Received</div>
    <div class="info-val" style="font-size:16px;font-weight:700;color:#047857">${fmtN(grandTotal)}</div>
    ${doc.DocCurrency ? `<div class="info-val" style="color:#666">${escHtml(doc.DocCurrency)}</div>` : ''}
  </div>
</div>

${doc.Remarks ? `<div style="border:1px solid #d1fae5;border-radius:6px;padding:12px;margin-bottom:20px;background:#f0fdf4;font-size:11px;line-height:1.6"><strong>Remarks:</strong> ${escHtml(doc.Remarks)}</div>` : ''}

<div class="section-title">Payment Means</div>
<div class="means-grid">
  ${cashSum > 0 ? `<div class="means-box"><div class="means-label">Cash</div><div class="means-amount">${fmtN(cashSum)}</div>${doc.CashAccount ? `<div style="font-size:10px;color:#666;margin-top:4px">Account: ${escHtml(doc.CashAccount)}</div>` : ''}</div>` : ''}
  ${transferSum > 0 ? `<div class="means-box"><div class="means-label">Bank Transfer</div><div class="means-amount">${fmtN(transferSum)}</div>${doc.TransferReference ? `<div style="font-size:10px;color:#666;margin-top:4px">Ref: ${escHtml(doc.TransferReference)}</div>` : ''}${doc.TransferAccount ? `<div style="font-size:10px;color:#666">Account: ${escHtml(doc.TransferAccount)}</div>` : ''}</div>` : ''}
  ${checksTotal > 0 ? `<div class="means-box"><div class="means-label">Cheques (${checks.length})</div><div class="means-amount">${fmtN(checksTotal)}</div></div>` : ''}
  ${cardsTotal  > 0 ? `<div class="means-box"><div class="means-label">Credit Cards (${cards.length})</div><div class="means-amount">${fmtN(cardsTotal)}</div></div>` : ''}
  ${boeAmt      > 0 ? `<div class="means-box"><div class="means-label">Bill of Exchange</div><div class="means-amount">${fmtN(boeAmt)}</div>${doc.BillOfExchangeDueDate ? `<div style="font-size:10px;color:#666;margin-top:4px">Due: ${doc.BillOfExchangeDueDate.slice(0,10)}</div>` : ''}</div>` : ''}
</div>

${invoices.length > 0 ? `
<div class="section-title">Applied Invoices</div>
<table>
  <thead><tr>
    <th>#</th><th>Invoice No.</th><th>Type</th><th style="text-align:right">Amount Applied</th>
  </tr></thead>
  <tbody>${invoiceRows}</tbody>
</table>` : ''}

${checks.length > 0 ? `
<div class="section-title">Cheque Details</div>
<table>
  <thead><tr>
    <th>#</th><th>Cheque No.</th><th>Bank</th><th>Branch</th><th>Due Date</th><th style="text-align:right">Amount</th>
  </tr></thead>
  <tbody>${chequeRows}</tbody>
</table>` : ''}

${cards.length > 0 ? `
<div class="section-title">Credit Card Details</div>
<table>
  <thead><tr>
    <th>#</th><th>Card Type</th><th>Voucher</th><th style="text-align:right">Amount</th>
  </tr></thead>
  <tbody>${cardRows}</tbody>
</table>` : ''}

<div class="totals">
  <div class="total-grand">Total Payment: ${fmtN(grandTotal)}</div>
</div>

<div class="footer">Printed on ${printedOn} &nbsp;|&nbsp; ${escHtml(company)} &mdash; Incoming Payment Receipt #${escHtml(String(doc.DocNum || '—'))} &nbsp;|&nbsp; Powered by AgentSphere AI</div>
</body>
<script>window.onload = function(){ window.print(); }</script>
</html>`;
}

// ── Router factory ─────────────────────────────────────────────────────────────

export function createIncomingPaymentRouter(deps) {
  const { requireAuth, getActiveSap } = deps;
  const router = Router();

  // ── POST /chat ─────────────────────────────────────────────────────────────
  router.post('/chat', requireAuth, async (req, res) => {
    try {
      const { message = '', sessionId } = req.body;
      const sid = sessionId || `inpay_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      if (!_sessions.has(sid)) _sessions.set(sid, initSession());
      const session = _sessions.get(sid);
      const sap     = getActiveSap();
      const msg     = message.trim();
      const msgL    = msg.toLowerCase();

      if (msg) session.history.push({ role: 'user', content: msg });

      let reply        = '';
      let quickReplies = [];
      let meta         = {};
      let bpList       = null;   // for customer search results
      let invoiceList  = null;   // for open AR invoice list
      let actionType   = null;   // 'open_form' when form should open
      let formDocs     = [];     // docs passed to open_form

      // ── JSON actions ───────────────────────────────────────────────────────
      if (msg.startsWith('{')) {
        let action = null;
        try { action = JSON.parse(msg); } catch {}

        // ── select_bp: user clicked a customer from search results ─────────
        if (action?.action === 'select_bp') {
          const { cardCode, cardName } = action;
          session.selectedBP = { cardCode, cardName };
          session.step = 'SELECT_INVOICES';

          const invs = await fetchOpenARInvoices(sap, cardCode);
          if (!invs.length) {
            reply = `No open AR invoices found for **${escHtml(cardName)}** (${escHtml(cardCode)}).`;
            quickReplies = ['Search Another Customer', 'Start Over'];
            session.step = 'INIT';
          } else {
            session.openInvoices = mapInvoiceList(invs);
            invoiceList = session.openInvoices;
            reply = `Found **${invs.length}** open AR invoice${invs.length !== 1 ? 's' : ''} for **${escHtml(cardName)}**.\n\nSelect the invoices to pay (or click **Pay All**):`;
            quickReplies = ['Pay All'];
          }
        }

        // ── select_invoices: user chose which invoices to pay ──────────────
        else if (action?.action === 'select_invoices') {
          const entries = Array.isArray(action.docEntries) ? action.docEntries.map(Number) : [];
          if (!entries.length) {
            reply = '❌ No invoices selected. Please select at least one invoice.';
            quickReplies = ['Pay All'];
          } else {
            const chosen = session.openInvoices.filter(i => entries.includes(i.docEntry));
            if (!chosen.length) {
              reply = '❌ Selected invoices not found. Please try again.';
            } else {
              session.selectedDocs = chosen;
              session.step = 'REVIEW_FORM';
              actionType = 'open_form';
              formDocs   = chosen;
              const totalOpen = chosen.reduce((s, d) => s + d.openAmount, 0);
              reply = `**${chosen.length}** invoice${chosen.length !== 1 ? 's' : ''} selected — outstanding total: **${fmtN(totalOpen)}**\n\nOpening the payment form…`;
            }
          }
        }

        // ── post_payment: user submitted the payment form ──────────────────
        else if (action?.action === 'post_payment') {
          if (!action.CardCode) {
            reply = '❌ Customer code is required.';
          } else if (!Array.isArray(action.PaymentInvoices) || !action.PaymentInvoices.length) {
            reply = '❌ No invoices selected. At least one PaymentInvoice is required.';
          } else {
            try {
              const payload = buildPaymentPayload(action);
              const result  = await sap.post('/IncomingPayments', payload);
              session.result = { docEntry: result.DocEntry, docNum: result.DocNum };
              session.step   = 'DONE';

              const totalPaid = (action.PaymentInvoices || []).reduce((s, p) => s + Number(p.SumApplied || 0), 0);

              reply = `### Payment Posted Successfully!\n\n` +
                `| Field | Value |\n|---|---|\n` +
                `| **Payment #** | ${result.DocNum} |\n` +
                `| **Doc Entry** | ${result.DocEntry} |\n` +
                `| **Customer** | ${escHtml(action.CardCode)} |\n` +
                `| **Date** | ${action.DocDate || today()} |\n` +
                `| **Invoices Paid** | ${action.PaymentInvoices.length} |\n` +
                `| **Total Applied** | ${fmtN(totalPaid)} |\n\n` +
                `[Print Receipt](/api/incoming-payment/print/${result.DocEntry})\n\nWould you like to process another payment?`;
              quickReplies = ['Yes, Process Another', 'No, Done'];
              meta = {
                docEntry: result.DocEntry,
                docNum:   result.DocNum,
                printUrl: `/api/incoming-payment/print/${result.DocEntry}`,
              };
            } catch (e) {
              reply = `**Failed to post Incoming Payment**\n\nSAP Error: _${escHtml(e.message)}_\n\nWould you like to **retry** or **cancel**?`;
              quickReplies = ['Open Payment Form', 'Cancel'];
            }
          }
        }

        else {
          reply = 'Unexpected action. Please start over.';
          quickReplies = ['Start Over'];
        }
      }

      // ── "Pay All" shortcut text ───────────────────────────────────────────
      else if (/^pay all$/i.test(msg.trim()) && session.step === 'SELECT_INVOICES' && session.openInvoices.length > 0) {
        session.selectedDocs = session.openInvoices;
        session.step = 'REVIEW_FORM';
        actionType = 'open_form';
        formDocs   = session.openInvoices;
        const totalOpen = session.openInvoices.reduce((s, d) => s + d.openAmount, 0);
        reply = `**All ${session.openInvoices.length}** invoice${session.openInvoices.length !== 1 ? 's' : ''} selected — outstanding total: **${fmtN(totalOpen)}**\n\nOpening the payment form…`;
      }

      // ── INIT / new session — customer search ──────────────────────────────
      else if (session.step === 'INIT' || session.step === 'SELECT_BP') {
        if (!msg) {
          reply = `## Incoming Payment Agent\n\n` +
            `*Apply customer payments against open AR invoices.*\n\n` +
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
            session.selectedBP = { cardCode: c.CardCode, cardName: c.CardName };
            session.step = 'SELECT_INVOICES';
            const invs = await fetchOpenARInvoices(sap, c.CardCode);
            if (!invs.length) {
              reply = `No open AR invoices found for **${escHtml(c.CardName)}** (${escHtml(c.CardCode)}).`;
              quickReplies = ['Search Another Customer', 'Start Over'];
              session.step = 'INIT';
            } else {
              session.openInvoices = mapInvoiceList(invs);
              invoiceList = session.openInvoices;
              reply = `Found **${invs.length}** open AR invoice${invs.length !== 1 ? 's' : ''} for **${escHtml(c.CardName)}**.\n\nSelect the invoices to pay (or click **Pay All**):`;
              quickReplies = ['Pay All'];
            }
          } else {
            bpList = customers.map(c => ({
              cardCode: c.CardCode,
              cardName: c.CardName,
              balance:  Number(c.Balance || 0),
            }));
            reply = `Found **${customers.length}** customers matching **"${escHtml(msg)}"**. Select one:`;
            session.step = 'SELECT_BP';
          }
        }
      }

      // ── SELECT_INVOICES — invoice list shown, awaiting selection ──────────
      else if (session.step === 'SELECT_INVOICES') {
        if (/back|customer|change|another/i.test(msgL)) {
          session.selectedBP   = null;
          session.openInvoices = [];
          session.step = 'INIT';
          reply = 'Returning to customer search. Type a customer name or code:';
        } else if (/pay all/i.test(msgL) && session.openInvoices.length > 0) {
          session.selectedDocs = session.openInvoices;
          session.step = 'REVIEW_FORM';
          actionType = 'open_form';
          formDocs   = session.openInvoices;
          const totalOpen = session.openInvoices.reduce((s, d) => s + d.openAmount, 0);
          reply = `**All ${session.openInvoices.length}** invoices selected — outstanding total: **${fmtN(totalOpen)}**\n\nOpening the payment form…`;
        } else if (session.selectedBP) {
          const invs = await fetchOpenARInvoices(sap, session.selectedBP.cardCode);
          session.openInvoices = mapInvoiceList(invs);
          invoiceList = session.openInvoices;
          reply = `Click one or more invoices to select them, or click **Pay All**:`;
          quickReplies = ['Pay All'];
        } else {
          reply = 'Please select invoices from the list above or click Pay All.';
          quickReplies = ['Pay All', 'Start Over'];
        }
      }

      // ── REVIEW_FORM ───────────────────────────────────────────────────────
      else if (session.step === 'REVIEW_FORM') {
        if (/open|form|payment|pay|review/i.test(msgL)) {
          actionType = 'open_form';
          formDocs   = session.selectedDocs;
          reply = 'Opening payment form…';
        } else if (/back|change|invoice/i.test(msgL)) {
          session.selectedDocs = [];
          session.step = 'SELECT_INVOICES';
          if (session.selectedBP && session.openInvoices.length > 0) {
            invoiceList = session.openInvoices;
            reply = `Select invoices to pay for **${escHtml(session.selectedBP.cardName)}**:`;
            quickReplies = ['Pay All'];
          } else if (session.selectedBP) {
            const invs = await fetchOpenARInvoices(sap, session.selectedBP.cardCode);
            session.openInvoices = mapInvoiceList(invs);
            invoiceList = session.openInvoices;
            reply = `Select invoices to pay for **${escHtml(session.selectedBP.cardName)}**:`;
            quickReplies = ['Pay All'];
          } else {
            reply = 'Please select invoices:';
          }
        } else if (/cancel|start over/i.test(msgL)) {
          Object.assign(session, initSession());
          reply = 'Cancelled. Type a customer name or code to start again:';
          session.step = 'INIT';
        } else {
          reply = 'What would you like to do?';
          quickReplies = ['Open Payment Form', 'Change Invoices', 'Cancel'];
        }
      }

      // ── DONE ──────────────────────────────────────────────────────────────
      else if (session.step === 'DONE') {
        if (/yes|another|more|process/i.test(msgL)) {
          Object.assign(session, initSession());
          reply = 'Ready. Type a customer name or code to begin a new payment:';
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

      const responseBody = {
        ok:          true,
        reply,
        quickReplies,
        sessionId:   sid,
        step:        session.step,
        meta,
      };

      // Optional fields only added when populated
      if (bpList)              responseBody.bpList       = bpList;
      if (invoiceList)         responseBody.invoiceList  = invoiceList;
      if (actionType)          responseBody.action       = actionType;
      if (formDocs.length > 0) responseBody.docs         = formDocs;
      if (session.selectedBP)  responseBody.bp           = session.selectedBP;

      res.json(responseBody);

    } catch (e) {
      console.error('[INPAY] chat error:', e);
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
      const doc = await fetchIncomingPayment(sap, req.params.docEntry);
      if (!doc) {
        return res.status(404).send(`<pre style="color:red">Incoming Payment #${escHtml(req.params.docEntry)} not found.</pre>`);
      }
      res.setHeader('Content-Type', 'text/html');
      res.send(renderPaymentPrint(doc));
    } catch (e) {
      res.status(500).send(`<pre style="color:red">Error loading Incoming Payment #${escHtml(req.params.docEntry)}: ${escHtml(e.message)}</pre>`);
    }
  });

  return router;
}
