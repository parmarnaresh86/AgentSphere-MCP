/**
 * OCR Gate Pass Register Agent
 *  1. Upload a gate pass slip (visitor / vehicle / material in-out)
 *  2. OCR extracts pass details
 *  3. Review/edit screen → save to local ocr_documents register (no SAP posting)
 */
import { Router } from 'express';
import multer from 'multer';
import { extractPdfText, runVisionExtraction, escHtml, today } from '../lib/ocr-extract.mjs';

const _sessions = new Map();
const _upload    = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

function initSession() {
  return { step: 'INIT', history: [], ocrData: null, result: null };
}

const GATEPASS_SYSTEM = `You are an expert OCR system for security gate-pass slips (visitor / vehicle / material in-out).
Return ONLY valid JSON (no markdown) with this structure:
{
  "passNumber": "string or null",
  "passDate": "YYYY-MM-DD or null",
  "passType": "visitor | vehicle | material | other",
  "direction": "in | out",
  "personOrVehicle": "string or null — visitor name, or vehicle number",
  "company": "string or null",
  "purpose": "string or null",
  "materialDescription": "string or null",
  "timeIn": "HH:MM or null",
  "timeOut": "HH:MM or null",
  "authorizedBy": "string or null"
}
Use null for strings that cannot be determined.`;

function buildReviewHTML(ocrData, fileName) {
  const rows = [
    ['Pass #', ocrData.passNumber],
    ['Date', ocrData.passDate],
    ['Type', ocrData.passType],
    ['Direction', ocrData.direction],
    ['Person / Vehicle', ocrData.personOrVehicle],
    ['Company', ocrData.company],
    ['Purpose', ocrData.purpose],
    ['Material', ocrData.materialDescription],
    ['Time In', ocrData.timeIn],
    ['Time Out', ocrData.timeOut],
    ['Authorized By', ocrData.authorizedBy],
  ];
  const trs = rows.map(([label, val]) => `
    <tr>
      <td style="padding:6px 8px;font-size:11.5px;font-weight:700;color:#374151;width:38%">${escHtml(label)}</td>
      <td style="padding:6px 8px;font-size:11.5px;color:#111">${escHtml(val ?? '—') || '—'}</td>
    </tr>`).join('');
  return `<div style="font-family:var(--font);font-size:12px">
    <div style="font-size:11px;font-weight:700;color:#374151;margin-bottom:6px">🪪 Extracted Gate Pass — ${escHtml(fileName || '')}</div>
    <table style="width:100%;border-collapse:collapse;font-size:11.5px">${trs}</table>
  </div>`;
}

export function createOcrGatePassAgentRouter(deps) {
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

      const ocrData = await runVisionExtraction(file.buffer, mimeType, extractedText, aiDeps, GATEPASS_SYSTEM, null);
      if (!ocrData) return res.status(422).json({ ok: false, error: 'Could not extract gate pass data. Please ensure the file is a clear PDF or image.' });

      res.json({ ok: true, ocrData, fileName: file.originalname, fileSize: file.size, mimeType });
    } catch (e) {
      console.error('[OCR-GATEPASS] upload error:', e);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  router.post('/chat', requireAuth, async (req, res) => {
    try {
      const { message = '', sessionId } = req.body;
      const sid = sessionId || `gatepass_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      if (!_sessions.has(sid)) _sessions.set(sid, initSession());
      const session = _sessions.get(sid);
      const msg = message.trim();
      const msgL = msg.toLowerCase();

      let reply = '', quickReplies = [], reviewHTML = null, uploadReady = false, meta = {};

      function doSave(edits) {
        try {
          const od = { ...session.ocrData, ...(edits || {}) };
          const id = ocrDocumentsRepo.insert({
            company_id:     getActiveCompanyId ? getActiveCompanyId() : '',
            doc_type:       'gatepass',
            session_id:     sid,
            file_name:      session.fileName || '',
            uploaded_by:    req.user?.username || req.user?.email || '',
            extracted_json: od,
            status:         'logged',
            notes:          od.purpose || '',
          });
          session.result = { id };
          session.step = 'DONE';
          reply = `### ✅ Logged to Gate Pass Register (#${id})\n\n` +
            `| Field | Value |\n|---|---|\n` +
            `| **Pass #** | ${od.passNumber || '—'} |\n` +
            `| **Type / Direction** | ${od.passType || '—'} / ${od.direction || '—'} |\n` +
            `| **Person / Vehicle** | ${od.personOrVehicle || '—'} |\n` +
            `| **Purpose** | ${od.purpose || '—'} |\n\n` +
            `Scan another gate pass?`;
          quickReplies = ['Yes, Scan Another', 'No, Done'];
          meta = { id };
        } catch (e) {
          reply = `❌ Failed to save entry: ${e.message}`;
          quickReplies = ['Retry', 'Cancel'];
        }
      }

      if (msg.startsWith('{')) {
        let action = null;
        try { action = JSON.parse(msg); } catch {}

        if (action?.action === 'ocr_result') {
          session.ocrData = action.ocrData;
          session.fileName = action.fileName;
          reviewHTML = buildReviewHTML(session.ocrData, session.fileName);
          reply = `### 🪪 Gate Pass Scanned\n\nReview the extracted details below, then confirm to log it in the security register.`;
          quickReplies = ['Save to Register', 'Re-upload'];
          session.step = 'REVIEW';
        } else if (action?.action === 'save_gatepass') {
          doSave(action.edits);
        } else {
          reply = 'Unexpected action. Please start over.';
        }
      } else if (session.step === 'INIT' || !msg) {
        reply = `## 🪪 Gate Pass Register Agent\n\n*Scan a visitor / vehicle / material gate-pass slip — logged locally for security audit, no SAP posting.*\n\nUpload a file to begin:`;
        uploadReady = true;
        session.step = 'UPLOAD';
      } else if (session.step === 'UPLOAD') {
        reply = 'Please upload the gate pass slip using the upload button below.';
        uploadReady = true;
      } else if (session.step === 'REVIEW') {
        if (/^save/i.test(msgL)) {
          doSave();
        } else if (/re-?upload|change|new/i.test(msgL)) {
          session.ocrData = null;
          session.step = 'UPLOAD';
          reply = 'Ready for a new upload. Please upload the corrected slip:';
          uploadReady = true;
        } else {
          reply = 'What would you like to do?';
          quickReplies = ['Save to Register', 'Re-upload'];
        }
      } else if (session.step === 'DONE') {
        if (/yes|another|more|scan/i.test(msgL)) {
          Object.assign(session, initSession());
          reply = 'Ready — upload the next gate pass:';
          uploadReady = true;
          session.step = 'UPLOAD';
        } else {
          reply = 'Workflow complete. Click "Scan Another" to log another gate pass.';
          quickReplies = ['Scan Another'];
        }
      } else {
        session.step = 'UPLOAD';
        reply = 'Session reset. Please upload a gate pass slip to begin.';
        uploadReady = true;
      }

      session.history.push({ role: 'user', content: msg }, { role: 'assistant', content: reply });
      if (session.history.length > 40) session.history.splice(0, session.history.length - 40);

      res.json({ ok: true, reply, quickReplies, sessionId: sid, step: session.step, reviewHTML, uploadReady, meta });
    } catch (e) {
      console.error('[OCR-GATEPASS] chat error:', e);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  router.get('/register', requireAuth, (req, res) => {
    try {
      const companyId = getActiveCompanyId ? getActiveCompanyId() : '';
      const rows = ocrDocumentsRepo.list(companyId, 'gatepass', 100);
      res.json({ ok: true, rows });
    } catch (e) {
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
