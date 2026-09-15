/**
 * OCR Expense Invoice Agent
 *  1. Upload a supplier expense invoice (PDF / image)
 *  2. OCR extracts vendor, amount, description; vendor is matched against SAP Business Partners
 *  3. User selects Expense/GL Account + Indian Tax Code
 *  4. Review screen (extracted vs SAP selections) → post A/P Invoice (service line, no GRPO base)
 */
import { Router } from 'express';
import multer from 'multer';
import { extractPdfText, runVisionExtraction, escHtml, fmtN, today, sapDate, datePlusDays } from '../lib/ocr-extract.mjs';

const _sessions = new Map();
const _upload    = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

function initSession() {
  return { step: 'INIT', history: [], ocrData: null, vendor: null, accountCode: null, taxCode: null, result: null };
}

const EXPENSE_SYSTEM = `You are an expert OCR system for supplier expense invoices (e.g. courier, telephone, rent, professional fees, utilities).
Return ONLY valid JSON (no markdown) with this structure:
{
  "invoiceNumber": "string or null",
  "invoiceDate": "YYYY-MM-DD or null",
  "dueDate": "YYYY-MM-DD or null",
  "vendorName": "string or null",
  "vendorCode": "string or null",
  "expenseCategory": "string or null — best-guess category e.g. Telephone, Courier, Rent, Professional Fees",
  "currency": "INR",
  "subtotal": 0,
  "taxTotal": 0,
  "grandTotal": 0,
  "description": "string — short line description for the AP invoice"
}
Use null for strings that cannot be determined, 0 for numeric fields that cannot be determined.`;

async function fetchExpenseAccounts(sap) {
  try {
    const r = await sap.get('/ChartOfAccounts', {
      $filter: `AccountType eq 'at_Expenditure' and Postable eq 'tYES'`,
      $orderby: 'Code',
      $top: 200,
    });
    return Array.isArray(r.value) ? r.value.map(a => ({ code: a.Code, name: a.Name })) : [];
  } catch (e) {
    console.error('[OCR-EXPENSE] fetchExpenseAccounts error:', e.message);
    return [];
  }
}

async function searchVendors(sap, query) {
  const esc = (query || '').replace(/'/g, "''");
  const base = `CardType eq 'cSupplier' and Frozen eq 'tNO'`;
  const filter = esc ? `(CardCode eq '${esc}' or contains(CardName,'${esc}')) and ${base}` : base;
  try {
    const r = await sap.get('/BusinessPartners', { $select: 'CardCode,CardName,Currency', $filter: filter, $top: 20, $orderby: 'CardName asc' });
    return Array.isArray(r.value) ? r.value : [];
  } catch { return []; }
}

// '##' (or blank) on a BP means "local currency" — no DocRate needed in that case.
// Returns { rate, error } — rate is null (with error set) when the lookup itself
// failed vs. genuinely finding no rate on file, so callers can show the real cause.
async function fetchExchangeRate(sap, currency, dateStr) {
  if (!currency || currency === '##') return { rate: null, error: null };
  const yyyymmdd = (dateStr || today()).slice(0, 10).replace(/-/g, '');
  try {
    const r = await sap.post('/SBOBobService_GetCurrencyRate', { Currency: currency, Date: yyyymmdd });
    const rate = Number(r?.value ?? r?.Rate ?? r);
    return Number.isFinite(rate) && rate > 0 ? { rate, error: null } : { rate: null, error: null };
  } catch (e) {
    console.error('[OCR-EXPENSE] fetchExchangeRate error:', e.message);
    return { rate: null, error: e.message };
  }
}

function buildReviewHTML(session) {
  const od = session.ocrData;
  const rows = [
    ['Invoice #', od.invoiceNumber],
    ['Invoice Date', od.invoiceDate],
    ['Vendor (extracted)', od.vendorName],
    ['Vendor (matched in SAP)', session.vendor ? `${escHtml(session.vendor.CardCode)} — ${escHtml(session.vendor.CardName)}` : '⚠️ Not selected'],
    ['Category (suggested)', od.expenseCategory],
    ['Description', od.description],
    ['Subtotal', fmtN(od.subtotal)],
    ['Tax', fmtN(od.taxTotal)],
    ['Grand Total', fmtN(od.grandTotal)],
    ['Selected Expense Account', session.accountCode ? `${escHtml(session.accountCode)} — ${escHtml(session.accountName || '')}` : '⚠️ Not selected'],
    ['Selected Tax Code', session.taxCode ? `${escHtml(session.taxCode)} — ${escHtml(session.taxName || '')}` : '⚠️ Not selected'],
  ];
  const trs = rows.map(([label, val]) => `
    <tr>
      <td style="padding:6px 8px;font-size:11.5px;font-weight:700;color:#374151;width:38%">${escHtml(label)}</td>
      <td style="padding:6px 8px;font-size:11.5px;color:#111">${val ?? '—'}</td>
    </tr>`).join('');
  return `<div style="font-family:var(--font);font-size:12px">
    <div style="font-size:11px;font-weight:700;color:#374151;margin-bottom:6px">🧾 Extracted Expense Invoice — matched against SAP Vendor / Chart of Accounts / Tax Codes</div>
    <table style="width:100%;border-collapse:collapse;font-size:11.5px">${trs}</table>
  </div>`;
}

export function createOcrExpenseAgentRouter(deps) {
  const { requireAuth, getActiveSap, gptChatComplete, azureMessagesCreate, AI_PROVIDER, USE_AI, ocrDocumentsRepo, cacheRepo, getActiveCompanyId } = deps;
  const aiDeps = { AI_PROVIDER, gptChatComplete, azureMessagesCreate, USE_AI };
  const router = Router();

  async function loadAccountsData(sap) {
    const companyId = getActiveCompanyId ? getActiveCompanyId() : '';
    return {
      accounts: await fetchExpenseAccounts(sap),
      taxCodes: cacheRepo?.getTaxCodes ? cacheRepo.getTaxCodes(companyId) : [],
    };
  }

  router.get('/accounts', requireAuth, async (req, res) => {
    try {
      res.json({ ok: true, ...(await loadAccountsData(getActiveSap())) });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  router.post('/upload', requireAuth, _upload.single('file'), async (req, res) => {
    try {
      const file = req.file;
      if (!file) return res.status(400).json({ ok: false, error: 'No file uploaded.' });
      const mimeType = file.mimetype;
      let extractedText = null;
      if (mimeType === 'application/pdf') extractedText = await extractPdfText(file.buffer);

      const ocrData = await runVisionExtraction(file.buffer, mimeType, extractedText, aiDeps, EXPENSE_SYSTEM, null);
      if (!ocrData) return res.status(422).json({ ok: false, error: 'Could not extract expense invoice data. Please ensure the file is a clear PDF or image.' });

      res.json({ ok: true, ocrData, fileName: file.originalname, fileSize: file.size, mimeType });
    } catch (e) {
      console.error('[OCR-EXPENSE] upload error:', e);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  router.post('/chat', requireAuth, async (req, res) => {
    try {
      const { message = '', sessionId } = req.body;
      const sid = sessionId || `expense_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      if (!_sessions.has(sid)) _sessions.set(sid, initSession());
      const session = _sessions.get(sid);
      const sap = getActiveSap();
      const msg = message.trim();
      const msgL = msg.toLowerCase();

      let reply = '', quickReplies = [], reviewHTML = null, uploadReady = false, meta = {}, accountsData = null, vendorList = null;

      async function doPost() {
        try {
          const od = session.ocrData;
          const grandTotal = Number(od.grandTotal || 0);
          const docDate = od.invoiceDate || today();
          const currency = session.vendor.Currency;
          let docRate = null;
          if (currency && currency !== '##') {
            const rateResult = await fetchExchangeRate(sap, currency, docDate);
            docRate = rateResult.rate;
            if (!docRate) {
              reply = rateResult.error
                ? `⚠️ Could not look up the ${currency} exchange rate (technical error: _${rateResult.error}_). ` +
                  `Please retry — if this keeps happening, try posting without the exchange rate check.`
                : `⚠️ Vendor **${session.vendor.CardName}** is set up in **${currency}**, but SAP has no exchange rate for ${docDate}. ` +
                  `Please add an exchange rate for ${currency} on that date in SAP B1 (Administration → Exchange Rates), then retry.`;
              quickReplies = ['Retry', 'Cancel'];
              return;
            }
          }
          const payload = {
            DocDate:    sapDate(docDate),
            DocDueDate: sapDate(od.dueDate || datePlusDays(30)),
            CardCode:   session.vendor.CardCode,
            NumAtCard:  od.invoiceNumber || undefined,
            Comments:   od.description || od.expenseCategory || undefined,
            ...(currency && currency !== '##' ? { DocCurrency: currency, DocRate: docRate } : {}),
            DocumentLines: [{
              AccountCode: session.accountCode,
              LineTotal:   grandTotal > 0 ? grandTotal : Number(od.subtotal || 0),
              TaxCode:     session.taxCode,
              Description: od.description || od.expenseCategory || 'Expense',
            }],
          };
          const result = await sap.post('/PurchaseInvoices', payload);
          session.result = { docEntry: result.DocEntry, docNum: result.DocNum };
          session.step = 'DONE';

          const companyId = getActiveCompanyId ? getActiveCompanyId() : '';
          const recId = ocrDocumentsRepo.insert({
            company_id: companyId, doc_type: 'expense', session_id: sid,
            file_name: session.fileName || '', uploaded_by: req.user?.username || req.user?.email || '',
            extracted_json: od, status: 'posted',
            sap_doc_type: 'PurchaseInvoices', sap_doc_entry: result.DocEntry, sap_doc_num: result.DocNum,
            notes: `Vendor ${session.vendor.CardCode}, Account ${session.accountCode}, Tax ${session.taxCode}`,
          });

          reply = `### ✅ A/P Invoice Posted!\n\n` +
            `| Field | Value |\n|---|---|\n` +
            `| **AP Invoice #** | ${result.DocNum} |\n` +
            `| **Doc Entry** | ${result.DocEntry} |\n` +
            `| **Vendor** | ${session.vendor.CardName} (${session.vendor.CardCode}) |\n` +
            `| **Expense Account** | ${session.accountCode} — ${session.accountName || ''} |\n` +
            `| **Tax Code** | ${session.taxCode} |\n` +
            `| **Amount** | ${fmtN(grandTotal)} |\n\n` +
            `Would you like to process another expense invoice?`;
          quickReplies = ['Yes, Process Another', 'No, Done'];
          meta = { docEntry: result.DocEntry, docNum: result.DocNum, id: recId };
        } catch (e) {
          reply = `❌ **Failed to post A/P Invoice**\n\nSAP Error: _${e.message}_\n\nWould you like to **retry** or **cancel**?`;
          quickReplies = ['Retry', 'Cancel'];
        }
      }

      if (msg.startsWith('{')) {
        let action = null;
        try { action = JSON.parse(msg); } catch {}

        if (action?.action === 'ocr_result') {
          session.ocrData = action.ocrData;
          session.fileName = action.fileName;
          const candidates = await searchVendors(sap, session.ocrData.vendorCode || session.ocrData.vendorName || '');
          if (candidates.length === 1) {
            session.vendor = candidates[0];
            accountsData = await loadAccountsData(sap);
            reply = `### 🧾 Expense Invoice Scanned\n\nVendor auto-matched: **${session.vendor.CardName}**.\n\nSelect an **Expense (GL) Account** and **Tax Code** to continue.`;
            session.step = 'SELECT_ACCOUNT';
          } else {
            vendorList = candidates.slice(0, 15).map(v => ({ cardCode: v.CardCode, cardName: v.CardName }));
            reply = candidates.length
              ? `Found ${candidates.length} possible vendors for "${session.ocrData.vendorName || session.ocrData.vendorCode}". Select one:`
              : `No SAP vendor match found for "${session.ocrData.vendorName || session.ocrData.vendorCode || '—'}". Enter a vendor name or code to search:`;
            session.step = 'SELECT_VENDOR';
          }
        } else if (action?.action === 'select_vendor') {
          let currency = null;
          try {
            const full = await sap.get(`/BusinessPartners('${String(action.cardCode).replace(/'/g, "''")}')`, { $select: 'CardCode,CardName,Currency' });
            currency = full?.Currency ?? null;
          } catch { /* fall back to no currency — will post in local currency */ }
          session.vendor = { CardCode: action.cardCode, CardName: action.cardName, Currency: currency };
          accountsData = await loadAccountsData(sap);
          reply = `### ✅ Vendor Set — ${session.vendor.CardName}\n\nSelect an **Expense (GL) Account** and **Tax Code** to continue.`;
          session.step = 'SELECT_ACCOUNT';
        } else if (action?.action === 'select_account') {
          session.accountCode = action.accountCode || null;
          session.accountName = action.accountName || null;
          session.taxCode = action.taxCode || null;
          session.taxName = action.taxName || null;
          if (!session.accountCode || !session.taxCode) {
            reply = '⚠️ Please select both an Expense Account and a Tax Code.';
            accountsData = await loadAccountsData(sap);
          } else {
            reviewHTML = buildReviewHTML(session);
            reply = `### ✅ Ready to Post\n\nReview the details below, then confirm to post the A/P Invoice to SAP.`;
            quickReplies = ['Post A/P Invoice', 'Change Account/Tax', 'Re-upload'];
            session.step = 'REVIEW';
          }
        } else if (action?.action === 'post_expense_apinv') {
          await doPost();
        } else {
          reply = 'Unexpected action. Please start over.';
        }
      } else if (session.step === 'INIT' || !msg) {
        reply = `## 🧾 Expense Invoice Agent\n\n*Scan an expense invoice, match the vendor, select the expense account and Indian tax code, then post as an A/P Invoice.*\n\nUpload a file to begin:`;
        uploadReady = true;
        session.step = 'UPLOAD';
      } else if (session.step === 'UPLOAD') {
        reply = 'Please upload the expense invoice using the upload button below.';
        uploadReady = true;
      } else if (session.step === 'SELECT_VENDOR') {
        const candidates = await searchVendors(sap, msg);
        if (candidates.length) {
          vendorList = candidates.slice(0, 15).map(v => ({ cardCode: v.CardCode, cardName: v.CardName }));
          reply = `Found ${candidates.length} vendor(s) for "${msg}". Select one:`;
        } else {
          reply = `No vendors found for "${msg}". Try a different name or code:`;
        }
      } else if (session.step === 'SELECT_ACCOUNT') {
        reply = 'Please select the Expense Account and Tax Code from the dropdowns above.';
        accountsData = await loadAccountsData(sap);
      } else if (session.step === 'REVIEW') {
        if (/^post/i.test(msgL)) {
          await doPost();
        } else if (/re-?upload|new invoice/i.test(msgL)) {
          Object.assign(session, initSession());
          session.step = 'UPLOAD';
          reply = 'Ready for a new upload. Please upload the corrected expense invoice:';
          uploadReady = true;
        } else if (/change|account|tax/i.test(msgL)) {
          session.step = 'SELECT_ACCOUNT';
          accountsData = await loadAccountsData(sap);
          reply = 'Select a different Expense Account / Tax Code:';
        } else {
          reply = 'What would you like to do?';
          quickReplies = ['Post A/P Invoice', 'Change Account/Tax', 'Re-upload'];
        }
      } else if (session.step === 'DONE') {
        if (/yes|another|more|process/i.test(msgL)) {
          Object.assign(session, initSession());
          session.step = 'UPLOAD';
          reply = 'Ready — upload the next expense invoice:';
          uploadReady = true;
        } else {
          reply = 'Workflow complete. Click "Process Another" to start again.';
          quickReplies = ['Process Another'];
        }
      } else {
        session.step = 'UPLOAD';
        reply = 'Session reset. Please upload an expense invoice to begin.';
        uploadReady = true;
      }

      session.history.push({ role: 'user', content: msg }, { role: 'assistant', content: reply });
      if (session.history.length > 40) session.history.splice(0, session.history.length - 40);

      res.json({ ok: true, reply, quickReplies, sessionId: sid, step: session.step, reviewHTML, uploadReady, meta, accountsData, vendorList });
    } catch (e) {
      console.error('[OCR-EXPENSE] chat error:', e);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  router.post('/reset', requireAuth, (req, res) => {
    const { sessionId } = req.body || {};
    if (sessionId) _sessions.delete(sessionId);
    res.json({ ok: true });
  });

  return router;
}
