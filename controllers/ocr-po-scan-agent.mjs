/**
 * OCR Purchase Order Scan Agent
 *  1. Upload a supplier quotation / PO-style PDF or image
 *  2. OCR extracts vendor + line items
 *  3. Match vendor against SAP Business Partners, match lines against SAP Item Master
 *  4. Review screen (extracted vs matched SAP data) → post Purchase Order to SAP B1
 */
import { Router } from 'express';
import multer from 'multer';
import { extractPdfText, runVisionExtraction, similarity, escHtml, fmtN, today, sapDate, datePlusDays } from '../lib/ocr-extract.mjs';

const _sessions = new Map();
const _upload    = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

function initSession() {
  return { step: 'INIT', history: [], ocrData: null, vendor: null, matchedLines: null, result: null };
}

const PO_SYSTEM = `You are an expert OCR system for supplier quotations / purchase-order style documents.
Return ONLY valid JSON (no markdown) with this structure:
{
  "docNumber": "string or null",
  "docDate": "YYYY-MM-DD or null",
  "vendorName": "string or null",
  "vendorCode": "string or null",
  "currency": "INR",
  "lines": [
    {
      "lineNum": 1,
      "itemCode": "string or null",
      "description": "string",
      "qty": 0,
      "unit": "EA",
      "unitPrice": 0,
      "lineTotal": 0
    }
  ]
}
Use null for strings that cannot be determined, 0 for numbers that cannot be determined.`;

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
    console.error('[OCR-PO-SCAN] fetchExchangeRate error:', e.message);
    return { rate: null, error: e.message };
  }
}

async function matchItem(sap, ocrLine) {
  if (ocrLine.itemCode) {
    try {
      const item = await sap.get(`/Items('${ocrLine.itemCode.replace(/'/g, "''")}')`);
      if (item?.ItemCode) return { itemCode: item.ItemCode, itemName: item.ItemName, unit: item.SalesUnit || item.PurchaseUnit || 'EA', score: 1 };
    } catch { /* fall through to description search */ }
  }
  try {
    const esc = (ocrLine.description || '').replace(/'/g, "''").slice(0, 40);
    if (!esc) return null;
    const r = await sap.get('/Items', { $select: 'ItemCode,ItemName,SalesUnit,PurchaseUnit', $filter: `contains(ItemName,'${esc}')`, $top: 5 });
    const candidates = Array.isArray(r.value) ? r.value : [];
    if (!candidates.length) return null;
    let best = null, bestScore = 0;
    candidates.forEach(c => {
      const s = similarity(c.ItemName, ocrLine.description);
      if (s > bestScore) { bestScore = s; best = c; }
    });
    if (!best || bestScore < 0.3) return null;
    return { itemCode: best.ItemCode, itemName: best.ItemName, unit: best.SalesUnit || best.PurchaseUnit || 'EA', score: bestScore };
  } catch { return null; }
}

function buildMatchHTML(ocrData, vendor, matchedLines) {
  const rows = matchedLines.map(l => {
    const matched = !!l.match;
    const icon = matched ? (l.match.score >= 0.9 ? '✅' : '⚠️') : '❌';
    const status = matched ? (l.match.score >= 0.9 ? 'Matched' : 'Fuzzy Match') : 'No SAP Match';
    return `<tr style="${matched ? '' : 'background:#fff1f1;'}">
      <td style="padding:6px 8px;font-size:11.5px">${escHtml(l.ocrLine.description || '')}</td>
      <td style="padding:6px 8px;font-size:11px;font-weight:700;color:#0f766e">${escHtml(l.match?.itemCode || '—')}</td>
      <td style="padding:6px 8px;text-align:right;font-size:11px">${fmtN(l.ocrLine.qty, 2)}</td>
      <td style="padding:6px 8px;text-align:right;font-size:11px">${fmtN(l.ocrLine.unitPrice)}</td>
      <td style="padding:6px 8px;text-align:center;font-size:11px;white-space:nowrap">${icon} ${status}</td>
    </tr>`;
  }).join('');

  return `<div style="font-family:var(--font);font-size:12px">
    <div style="margin-bottom:10px;font-size:12px;display:flex;gap:20px;flex-wrap:wrap">
      <span><strong>Doc #:</strong> ${escHtml(ocrData.docNumber || '—')}</span>
      <span><strong>Date:</strong> ${escHtml(ocrData.docDate || '—')}</span>
      <span><strong>Vendor (SAP):</strong> ${vendor ? `${escHtml(vendor.CardName)} (${escHtml(vendor.CardCode)})` : '⚠️ Not matched'}</span>
    </div>
    <div style="font-size:11px;font-weight:700;color:#374151;margin-bottom:6px">Extracted Lines vs SAP Item Master</div>
    <div style="overflow-x:auto">
    <table style="width:100%;border-collapse:collapse;font-size:11.5px">
      <thead><tr style="background:#6366f1;color:#fff">
        <th style="padding:7px 8px;text-align:left">Description</th>
        <th style="padding:7px 8px;text-align:left">SAP Item Code</th>
        <th style="padding:7px 8px;text-align:right">Qty</th>
        <th style="padding:7px 8px;text-align:right">Unit Price</th>
        <th style="padding:7px 8px;text-align:center">Status</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
    </div>
  </div>`;
}

export function createOcrPoScanAgentRouter(deps) {
  const { requireAuth, getActiveSap, gptChatComplete, azureMessagesCreate, AI_PROVIDER, USE_AI, ocrDocumentsRepo, getActiveCompanyId } = deps;
  const aiDeps = { AI_PROVIDER, gptChatComplete, azureMessagesCreate, USE_AI };
  const router = Router();

  router.post('/upload', requireAuth, _upload.single('file'), async (req, res) => {
    try {
      const file = req.file;
      if (!file) return res.status(400).json({ ok: false, error: 'No file uploaded.' });
      const mimeType = file.mimetype;
      let extractedText = null;
      if (mimeType === 'application/pdf') extractedText = await extractPdfText(file.buffer);

      const ocrData = await runVisionExtraction(file.buffer, mimeType, extractedText, aiDeps, PO_SYSTEM, null);
      if (!ocrData) return res.status(422).json({ ok: false, error: 'Could not extract PO/quotation data. Please ensure the file is a clear PDF or image.' });

      res.json({ ok: true, ocrData, fileName: file.originalname, fileSize: file.size, mimeType });
    } catch (e) {
      console.error('[OCR-PO-SCAN] upload error:', e);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  router.post('/chat', requireAuth, async (req, res) => {
    try {
      const { message = '', sessionId } = req.body;
      const sid = sessionId || `poscan_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      if (!_sessions.has(sid)) _sessions.set(sid, initSession());
      const session = _sessions.get(sid);
      const sap = getActiveSap();
      const msg = message.trim();
      const msgL = msg.toLowerCase();

      let reply = '', quickReplies = [], matchHTML = null, uploadReady = false, meta = {}, vendorList = null;

      async function doPostPO(explicitLines) {
        const lines = explicitLines || session.matchedLines.filter(l => l.match).map(l => ({
          itemCode: l.match.itemCode, qty: l.ocrLine.qty, unitPrice: l.ocrLine.unitPrice, unit: l.match.unit,
        }));
        if (!lines.length) {
          reply = '❌ No matched lines to order. Please ensure at least one line matches a SAP item.';
          return;
        }
        try {
          const docDate = session.ocrData.docDate || today();
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
            DocDueDate: sapDate(datePlusDays(14)),
            CardCode:   session.vendor.CardCode,
            NumAtCard:  session.ocrData.docNumber || undefined,
            ...(currency && currency !== '##' ? { DocCurrency: currency, DocRate: docRate } : {}),
            DocumentLines: lines.map(l => ({
              ItemCode:  l.itemCode,
              Quantity:  Number(l.qty || 1),
              UnitPrice: Number(l.unitPrice || 0),
              ...(l.unit ? { UoMCode: l.unit } : {}),
            })),
          };
          const result = await sap.post('/PurchaseOrders', payload);
          session.result = { docEntry: result.DocEntry, docNum: result.DocNum };
          session.step = 'DONE';

          const companyId = getActiveCompanyId ? getActiveCompanyId() : '';
          const recId = ocrDocumentsRepo.insert({
            company_id: companyId, doc_type: 'po_scan', session_id: sid,
            file_name: session.fileName || '', uploaded_by: req.user?.username || req.user?.email || '',
            extracted_json: session.ocrData, match_json: session.matchedLines, status: 'posted',
            sap_doc_type: 'PurchaseOrders', sap_doc_entry: result.DocEntry, sap_doc_num: result.DocNum,
          });

          reply = `### ✅ Purchase Order Posted!\n\n` +
            `| Field | Value |\n|---|---|\n` +
            `| **PO #** | ${result.DocNum} |\n` +
            `| **Doc Entry** | ${result.DocEntry} |\n` +
            `| **Vendor** | ${session.vendor.CardName} (${session.vendor.CardCode}) |\n` +
            `| **Lines** | ${lines.length} |\n\n` +
            `Scan another purchase order document?`;
          quickReplies = ['Yes, Scan Another', 'No, Done'];
          meta = { docEntry: result.DocEntry, docNum: result.DocNum, id: recId };
        } catch (e) {
          reply = `❌ **Failed to post Purchase Order**\n\nSAP Error: _${e.message}_\n\nWould you like to **retry** or **cancel**?`;
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
            const matched = await Promise.all((session.ocrData.lines || []).map(async ol => ({ ocrLine: ol, match: await matchItem(sap, ol) })));
            session.matchedLines = matched;
            matchHTML = buildMatchHTML(session.ocrData, session.vendor, matched);
            reply = `### 📦 Purchase Order Document Scanned\n\nVendor auto-matched. Review the line matches below, then post to SAP.`;
            quickReplies = ['Post Purchase Order', 'Change Vendor', 'Re-upload'];
            session.step = 'REVIEW';
          } else {
            vendorList = candidates.slice(0, 15).map(v => ({ cardCode: v.CardCode, cardName: v.CardName }));
            reply = candidates.length
              ? `Found ${candidates.length} possible vendors for "${session.ocrData.vendorName || session.ocrData.vendorCode}". Select one:`
              : `No SAP vendor match found for "${session.ocrData.vendorName || session.ocrData.vendorCode || '—'}". Enter a vendor name or code to search:`;
            session.step = 'SELECT_VENDOR';
          }
        } else if (action?.action === 'select_vendor') {
          try {
            let currency = null;
            try {
              const full = await sap.get(`/BusinessPartners('${String(action.cardCode).replace(/'/g, "''")}')`, { $select: 'CardCode,CardName,Currency' });
              currency = full?.Currency ?? null;
            } catch { /* fall back to no currency — will post in local currency */ }
            session.vendor = { CardCode: action.cardCode, CardName: action.cardName, Currency: currency };
            const matched = await Promise.all((session.ocrData.lines || []).map(async ol => ({ ocrLine: ol, match: await matchItem(sap, ol) })));
            session.matchedLines = matched;
            matchHTML = buildMatchHTML(session.ocrData, session.vendor, matched);
            reply = `### ✅ Vendor Set — ${session.vendor.CardName}\n\nReview the line matches below, then post to SAP.`;
            quickReplies = ['Post Purchase Order', 'Change Vendor', 'Re-upload'];
            session.step = 'REVIEW';
          } catch (e) {
            reply = `Error setting vendor: ${e.message}`;
          }
        } else if (action?.action === 'post_po') {
          await doPostPO(action.lines);
        } else {
          reply = 'Unexpected action. Please start over.';
        }
      } else if (session.step === 'INIT' || !msg) {
        reply = `## 📦 Purchase Order Scan Agent\n\n*Scan a supplier quotation / PO document — matched against SAP vendors and item master, then posted as a Purchase Order.*\n\nUpload a file to begin:`;
        uploadReady = true;
        session.step = 'UPLOAD';
      } else if (session.step === 'UPLOAD') {
        reply = 'Please upload the purchase order / quotation document using the upload button below.';
        uploadReady = true;
      } else if (session.step === 'SELECT_VENDOR') {
        const candidates = await searchVendors(sap, msg);
        if (candidates.length) {
          vendorList = candidates.slice(0, 15).map(v => ({ cardCode: v.CardCode, cardName: v.CardName }));
          reply = `Found ${candidates.length} vendor(s) for "${msg}". Select one:`;
        } else {
          reply = `No vendors found for "${msg}". Try a different name or code:`;
        }
      } else if (session.step === 'REVIEW') {
        if (/^post/i.test(msgL)) {
          await doPostPO();
        } else if (/re-?upload|new/i.test(msgL)) {
          Object.assign(session, initSession());
          session.step = 'UPLOAD';
          reply = 'Ready for a new upload. Please upload the corrected document:';
          uploadReady = true;
        } else if (/change vendor|vendor/i.test(msgL)) {
          session.step = 'SELECT_VENDOR';
          reply = 'Enter a vendor name or code to search:';
        } else {
          reply = 'What would you like to do?';
          quickReplies = ['Post Purchase Order', 'Change Vendor', 'Re-upload'];
        }
      } else if (session.step === 'DONE') {
        if (/yes|another|more|scan/i.test(msgL)) {
          Object.assign(session, initSession());
          session.step = 'UPLOAD';
          reply = 'Ready — upload the next document:';
          uploadReady = true;
        } else {
          reply = 'Workflow complete. Click "Scan Another" to start again.';
          quickReplies = ['Scan Another'];
        }
      } else {
        session.step = 'UPLOAD';
        reply = 'Session reset. Please upload a document to begin.';
        uploadReady = true;
      }

      session.history.push({ role: 'user', content: msg }, { role: 'assistant', content: reply });
      if (session.history.length > 40) session.history.splice(0, session.history.length - 40);

      res.json({ ok: true, reply, quickReplies, sessionId: sid, step: session.step, matchHTML, uploadReady, meta, vendorList });
    } catch (e) {
      console.error('[OCR-PO-SCAN] chat error:', e);
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
