/**
 * OCR Document Mode Agent — generic/unclassified scan
 *  1. Upload any document (PDF / image)
 *  2. OCR extracts generic fields (title, parties, dates, amounts, raw text)
 *  3. User picks which workflow it belongs to (PO / Expense / A/P Invoice / Inward / Gate Pass / Archive only)
 *  4. Saved to ocr_documents with the chosen doc_type; user continues in that workflow's panel
 */
import { Router } from 'express';
import multer from 'multer';
import { extractPdfText, runVisionExtraction, escHtml } from '../lib/ocr-extract.mjs';

const _sessions = new Map();
const _upload    = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

function initSession() {
  return { step: 'INIT', history: [], ocrData: null, result: null };
}

const GENERIC_SYSTEM = `You are an expert OCR system for classifying an unknown business document.
Return ONLY valid JSON (no markdown) with this structure:
{
  "title": "string or null — document title/heading",
  "docNumber": "string or null",
  "docDate": "YYYY-MM-DD or null",
  "parties": ["string", "..."],
  "amounts": [0],
  "suggestedType": "purchase_order | expense_invoice | ap_invoice | inward | gate_pass | unknown",
  "summary": "string — one-sentence summary of what this document appears to be"
}
Use null/[] for fields that cannot be determined.`;

const TARGET_LABELS = {
  po_scan:  { label: 'Purchase Order', panel: 'ocr-po-scan-panel', open: 'showOcrPoScanPanel' },
  expense:  { label: 'Expense Invoice', panel: 'ocr-expense-panel', open: 'showOcrExpensePanel' },
  apinv:    { label: 'A/P Invoice',     panel: 'scan-apinv-panel',  open: 'showScanAPInvPanel' },
  inward:   { label: 'Inward Register', panel: 'ocr-inward-panel',  open: 'showOcrInwardPanel' },
  gatepass: { label: 'Gate Pass Register', panel: 'ocr-gatepass-panel', open: 'showOcrGatePassPanel' },
  archive:  { label: 'Archive Only',    panel: null, open: null },
};

function buildReviewHTML(ocrData, fileName) {
  const rows = [
    ['Title', ocrData.title],
    ['Doc #', ocrData.docNumber],
    ['Date', ocrData.docDate],
    ['Parties', (ocrData.parties || []).join(', ')],
    ['Amounts', (ocrData.amounts || []).join(', ')],
    ['AI Suggested Type', ocrData.suggestedType],
    ['Summary', ocrData.summary],
  ];
  const trs = rows.map(([label, val]) => `
    <tr>
      <td style="padding:6px 8px;font-size:11.5px;font-weight:700;color:#374151;width:32%">${escHtml(label)}</td>
      <td style="padding:6px 8px;font-size:11.5px;color:#111">${escHtml(val ?? '—') || '—'}</td>
    </tr>`).join('');
  return `<div style="font-family:var(--font);font-size:12px">
    <div style="font-size:11px;font-weight:700;color:#374151;margin-bottom:6px">📄 Extracted Document — ${escHtml(fileName || '')}</div>
    <table style="width:100%;border-collapse:collapse;font-size:11.5px">${trs}</table>
  </div>`;
}

export function createOcrDocumentAgentRouter(deps) {
  const { requireAuth, gptChatComplete, azureMessagesCreate, AI_PROVIDER, USE_AI, ocrDocumentsRepo, getActiveCompanyId } = deps;
  const aiDeps = { AI_PROVIDER, gptChatComplete, azureMessagesCreate, USE_AI };
  const router = Router();

  router.post('/upload', requireAuth, _upload.single('file'), async (req, res) => {
    try {
      const file = req.file;
      if (!file) return res.status(400).json({ ok: false, error: 'No file uploaded.' });
      const mimeType = file.mimetype;
      let extractedText = null;
      if (mimeType === 'application/pdf') extractedText = await extractPdfText(file.buffer);

      const ocrData = await runVisionExtraction(file.buffer, mimeType, extractedText, aiDeps, GENERIC_SYSTEM, null);
      if (!ocrData) return res.status(422).json({ ok: false, error: 'Could not extract document data. Please ensure the file is a clear PDF or image.' });

      res.json({ ok: true, ocrData, fileName: file.originalname, fileSize: file.size, mimeType });
    } catch (e) {
      console.error('[OCR-DOCUMENT] upload error:', e);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  router.post('/chat', requireAuth, async (req, res) => {
    try {
      const { message = '', sessionId } = req.body;
      const sid = sessionId || `docmode_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      if (!_sessions.has(sid)) _sessions.set(sid, initSession());
      const session = _sessions.get(sid);
      const msg = message.trim();
      const msgL = msg.toLowerCase();

      let reply = '', quickReplies = [], reviewHTML = null, uploadReady = false, meta = {};

      const LABEL_TO_KEY = {
        'purchase order': 'po_scan', 'expense invoice': 'expense', 'a/p invoice': 'apinv',
        'inward': 'inward', 'gate pass': 'gatepass', 'archive only': 'archive',
      };

      function doClassify(targetKey) {
        const target = TARGET_LABELS[targetKey];
        if (!target) {
          reply = '⚠️ Please choose a valid classification.';
          return;
        }
        const companyId = getActiveCompanyId ? getActiveCompanyId() : '';
        const id = ocrDocumentsRepo.insert({
          company_id: companyId, doc_type: targetKey === 'archive' ? 'document_mode' : targetKey,
          session_id: sid, file_name: session.fileName || '',
          uploaded_by: req.user?.username || req.user?.email || '',
          extracted_json: session.ocrData, status: targetKey === 'archive' ? 'logged' : 'pending',
          notes: `Classified via Document Mode as ${target.label}`,
        });
        session.result = { id, targetKey };
        session.step = 'DONE';
        reply = `### ✅ Classified as ${target.label} (Record #${id})\n\n` +
          (target.open
            ? `Open the **${target.label}** panel to continue matching and posting this document.`
            : `Archived — no further action needed.`) +
          `\n\nScan another document?`;
        quickReplies = ['Yes, Scan Another', 'No, Done'];
        meta = { id, targetKey, openFn: target.open, panelId: target.panel };
      }

      if (msg.startsWith('{')) {
        let action = null;
        try { action = JSON.parse(msg); } catch {}

        if (action?.action === 'ocr_result') {
          session.ocrData = action.ocrData;
          session.fileName = action.fileName;
          reviewHTML = buildReviewHTML(session.ocrData, session.fileName);
          const suggested = TARGET_LABELS[session.ocrData.suggestedType] ? session.ocrData.suggestedType : null;
          reply = `### 📄 Document Scanned\n\nReview the extracted summary below.` +
            (suggested ? `\n\nAI suggests this is a **${TARGET_LABELS[suggested].label}**.` : '') +
            `\n\nWhich workflow should this be routed to?`;
          quickReplies = ['Purchase Order', 'Expense Invoice', 'A/P Invoice', 'Inward', 'Gate Pass', 'Archive Only'];
          session.step = 'CLASSIFY';
        } else if (action?.action === 'classify') {
          doClassify(action.targetType);
        } else {
          reply = 'Unexpected action. Please start over.';
        }
      } else if (session.step === 'CLASSIFY' && LABEL_TO_KEY[msgL]) {
        doClassify(LABEL_TO_KEY[msgL]);
      } else if (session.step === 'INIT' || !msg) {
        reply = `## 📄 Document Mode Agent\n\n*Scan any document — OCR extracts a generic summary, then you choose which workflow it belongs to.*\n\nUpload a file to begin:`;
        uploadReady = true;
        session.step = 'UPLOAD';
      } else if (session.step === 'UPLOAD') {
        reply = 'Please upload the document using the upload button below.';
        uploadReady = true;
      } else if (session.step === 'CLASSIFY') {
        reply = 'Please choose a classification using the buttons above.';
        quickReplies = ['Purchase Order', 'Expense Invoice', 'A/P Invoice', 'Inward', 'Gate Pass', 'Archive Only'];
      } else if (session.step === 'DONE') {
        if (/yes|another|more|scan/i.test(msgL)) {
          Object.assign(session, initSession());
          session.step = 'UPLOAD';
          reply = 'Ready — upload the next document:';
          uploadReady = true;
        } else {
          reply = 'Workflow complete. Click "Scan Another" to classify another document.';
          quickReplies = ['Scan Another'];
        }
      } else {
        session.step = 'UPLOAD';
        reply = 'Session reset. Please upload a document to begin.';
        uploadReady = true;
      }

      session.history.push({ role: 'user', content: msg }, { role: 'assistant', content: reply });
      if (session.history.length > 40) session.history.splice(0, session.history.length - 40);

      res.json({ ok: true, reply, quickReplies, sessionId: sid, step: session.step, reviewHTML, uploadReady, meta });
    } catch (e) {
      console.error('[OCR-DOCUMENT] chat error:', e);
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
