/**
 * OCR Inward Register Agent
 *  1. Upload a delivery challan / inward slip (PDF or image)
 *  2. OCR extracts vehicle no., material, qty, from-party, date
 *  3. Review/edit screen → save to local ocr_documents register (no SAP posting)
 */
import { Router } from 'express';
import multer from 'multer';
import { extractPdfText, runVisionExtraction, escHtml, fmtN, today, nameSimilarity } from '../lib/ocr-extract.mjs';
import { searchPartners, matchPartner, searchItems, matchItem, getWarehouses, getOpenPOs, findDuplicate, normKey } from '../lib/ocr-sap-match.mjs';

const _sessions = new Map();
const _upload    = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

function initSession() {
  return { step: 'INIT', history: [], ocrData: null, result: null };
}

const INWARD_SYSTEM = `You are an expert OCR system for inward material / delivery-challan slips.
Return ONLY valid JSON (no markdown) with this structure:
{
  "challanNumber": "string or null",
  "challanDate": "YYYY-MM-DD or null",
  "vehicleNumber": "string or null",
  "fromParty": "string or null",
  "toLocation": "string or null",
  "materialDescription": "string or null",
  "quantity": 0,
  "unit": "string or null",
  "driverName": "string or null",
  "remarks": "string or null",
  "poNumber": "string or null — purchase order number referenced on the challan",
  "lines": [
    { "itemCode": "string or null", "description": "string", "quantity": 0, "unit": "string or null" }
  ]
}
"lines" lists every material row on the challan; the single materialDescription/quantity fields summarise the first row.
Use null for strings that cannot be determined, 0 for numbers that cannot be determined.`;

function buildReviewHTML(ocrData, fileName) {
  const rows = [
    ['Challan #', ocrData.challanNumber],
    ['Challan Date', ocrData.challanDate],
    ['Vehicle No.', ocrData.vehicleNumber],
    ['From Party', ocrData.fromParty],
    ['To Location', ocrData.toLocation],
    ['Material', ocrData.materialDescription],
    ['Quantity', ocrData.quantity != null ? `${fmtN(ocrData.quantity, 2)} ${escHtml(ocrData.unit || '')}` : '—'],
    ['Driver', ocrData.driverName],
    ['Remarks', ocrData.remarks],
  ];
  const trs = rows.map(([label, val]) => `
    <tr>
      <td style="padding:6px 8px;font-size:11.5px;font-weight:700;color:#374151;width:38%">${escHtml(label)}</td>
      <td style="padding:6px 8px;font-size:11.5px;color:#111">${escHtml(val ?? '—') || '—'}</td>
    </tr>`).join('');
  return `<div style="font-family:var(--font);font-size:12px">
    <div style="font-size:11px;font-weight:700;color:#374151;margin-bottom:6px">📥 Extracted Inward Slip — ${escHtml(fileName || '')}</div>
    <table style="width:100%;border-collapse:collapse;font-size:11.5px">${trs}</table>
  </div>`;
}

export function createOcrInwardAgentRouter(deps) {
  const { requireAuth, getActiveSap, gptChatComplete, azureMessagesCreate, AI_PROVIDER, USE_AI, ocrDocumentsRepo, cacheRepo, getActiveCompanyId } = deps;
  const aiDeps = { AI_PROVIDER, gptChatComplete, azureMessagesCreate, USE_AI };
  const router = Router();

  router.post('/upload', requireAuth, _upload.single('file'), async (req, res) => {
    try {
      const file = req.file;
      if (!file) return res.status(400).json({ ok: false, error: 'No file uploaded.' });
      const mimeType = file.mimetype;
      let extractedText = null;
      if (mimeType === 'application/pdf') extractedText = await extractPdfText(file.buffer);

      const ocrData = await runVisionExtraction(file.buffer, mimeType, extractedText, aiDeps, INWARD_SYSTEM, null);
      if (!ocrData) return res.status(422).json({ ok: false, error: 'Could not extract inward slip data. Please ensure the file is a clear PDF or image.' });

      res.json({ ok: true, ocrData, fileName: file.originalname, fileSize: file.size, mimeType });
    } catch (e) {
      console.error('[OCR-INWARD] upload error:', e);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ── Form-mode endpoints (split view: document preview + editable inward entry) ──
  const cid = () => (getActiveCompanyId ? getActiveCompanyId() : '');
  // Same challan no. + date = same delivery (works for both raw OCR and saved form shapes)
  const dupKey = v => {
    const h = v?.header || v || {};
    return h.challanNumber ? normKey(h.challanNumber, h.challanDate) : '';
  };

  router.get('/vendors', requireAuth, async (req, res) => {
    res.json({ ok: true, vendors: await searchPartners(getActiveSap(), String(req.query.q || '').trim(), 'cSupplier') });
  });

  router.get('/items', requireAuth, async (req, res) => {
    res.json({ ok: true, items: await searchItems(getActiveSap(), String(req.query.q || '').trim()) });
  });

  router.get('/open-pos', requireAuth, async (req, res) => {
    res.json({ ok: true, pos: await getOpenPOs(getActiveSap(), String(req.query.cardCode || '')) });
  });

  router.post('/prepare', requireAuth, async (req, res) => {
    try {
      const sap = getActiveSap();
      const od = req.body?.ocrData || {};
      const { partner, score } = await matchPartner(sap, { name: od.fromParty }, 'cSupplier');

      let lines = Array.isArray(od.lines) ? od.lines.filter(l => l && (l.description || l.itemCode)) : [];
      if (!lines.length && (od.materialDescription || od.quantity)) {
        lines = [{ description: od.materialDescription || '', quantity: od.quantity || 0, unit: od.unit || '' }];
      }
      const matched = await Promise.all(lines.map(async l => ({ ocrLine: l, match: await matchItem(sap, l) })));

      const warehouses = await getWarehouses(sap, cacheRepo, cid());
      let warehouse = null;
      if (od.toLocation) {
        let best = null, bs = 0;
        warehouses.forEach(w => { const s = Math.max(nameSimilarity(w.name, od.toLocation), nameSimilarity(w.code, od.toLocation)); if (s > bs) { bs = s; best = w; } });
        if (best && bs >= 0.5) warehouse = { ...best, score: bs };
      }

      const pos = partner ? await getOpenPOs(sap, partner.code) : [];
      let po = null;
      if (od.poNumber) {
        const ref = String(od.poNumber).replace(/\D/g, '');
        po = pos.find(p => String(p.docNum) === ref || (p.numAtCard && normKey(p.numAtCard) === normKey(od.poNumber))) || null;
      }

      res.json({
        ok: true,
        vendor: partner ? { ...partner, score } : null,
        lines: matched, warehouses, warehouse, pos, po: po ? po.docEntry : null,
        duplicate: findDuplicate(ocrDocumentsRepo, cid(), 'inward', dupKey, od),
      });
    } catch (e) {
      console.error('[OCR-INWARD] prepare error:', e);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  router.post('/save', requireAuth, (req, res) => {
    try {
      const { form, ocrData = null, fileName = '', allowDuplicate = false } = req.body || {};
      const h = form?.header || {};
      const lines = (form?.lines || []).filter(l => l.description || l.itemCode);
      if (!h.challanNumber && !h.vehicleNumber) return res.status(400).json({ ok: false, error: 'Enter at least the challan no. or the vehicle no.' });
      if (!lines.length) return res.status(400).json({ ok: false, error: 'Add at least one material line.' });
      const dup = findDuplicate(ocrDocumentsRepo, cid(), 'inward', dupKey, form);
      if (dup && !allowDuplicate) return res.status(409).json({ ok: false, duplicate: dup, error: `Challan ${h.challanNumber} dated ${h.challanDate || '—'} is already in the register (entry #${dup.id}).` });

      const id = ocrDocumentsRepo.insert({
        company_id: cid(), doc_type: 'inward', session_id: `inwform_${Date.now()}`,
        file_name: fileName, uploaded_by: req.user?.username || req.user?.email || '',
        extracted_json: ocrData, match_json: { header: h, lines }, status: 'logged',
        sap_doc_type: h.poDocEntry ? 'PurchaseOrders' : '', sap_doc_entry: h.poDocEntry || null, sap_doc_num: h.poDocNum || null,
        notes: [h.vendor?.code, h.remarks].filter(Boolean).join(' · '),
      });
      res.json({ ok: true, id });
    } catch (e) {
      console.error('[OCR-INWARD] save error:', e);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  router.post('/chat', requireAuth, async (req, res) => {
    try {
      const { message = '', sessionId } = req.body;
      const sid = sessionId || `inward_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
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
            doc_type:       'inward',
            session_id:     sid,
            file_name:      session.fileName || '',
            uploaded_by:    req.user?.username || req.user?.email || '',
            extracted_json: od,
            status:         'logged',
            notes:          od.remarks || '',
          });
          session.result = { id };
          session.step = 'DONE';
          reply = `### ✅ Logged to Inward Register (#${id})\n\n` +
            `| Field | Value |\n|---|---|\n` +
            `| **Vehicle No.** | ${od.vehicleNumber || '—'} |\n` +
            `| **From** | ${od.fromParty || '—'} |\n` +
            `| **Material** | ${od.materialDescription || '—'} |\n` +
            `| **Qty** | ${od.quantity ?? '—'} ${od.unit || ''} |\n\n` +
            `Scan another inward slip?`;
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
          reply = `### 📥 Inward Slip Scanned\n\nReview the extracted details below, then confirm to log it in the inward register.`;
          quickReplies = ['Save to Register', 'Re-upload'];
          session.step = 'REVIEW';
        } else if (action?.action === 'save_inward') {
          doSave(action.edits);
        } else {
          reply = 'Unexpected action. Please start over.';
        }
      } else if (session.step === 'INIT' || !msg) {
        reply = `## 📥 Inward Register Agent\n\n*Scan a delivery challan / inward slip — extracted details are logged locally for audit, no SAP posting.*\n\nUpload a file to begin:`;
        uploadReady = true;
        session.step = 'UPLOAD';
      } else if (session.step === 'UPLOAD') {
        reply = 'Please upload the inward slip / delivery challan using the upload button below.';
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
          reply = 'Ready — upload the next inward slip:';
          uploadReady = true;
          session.step = 'UPLOAD';
        } else {
          reply = 'Workflow complete. Click "Scan Another" to log another inward entry.';
          quickReplies = ['Scan Another'];
        }
      } else {
        session.step = 'UPLOAD';
        reply = 'Session reset. Please upload an inward slip to begin.';
        uploadReady = true;
      }

      session.history.push({ role: 'user', content: msg }, { role: 'assistant', content: reply });
      if (session.history.length > 40) session.history.splice(0, session.history.length - 40);

      res.json({ ok: true, reply, quickReplies, sessionId: sid, step: session.step, reviewHTML, uploadReady, meta });
    } catch (e) {
      console.error('[OCR-INWARD] chat error:', e);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  router.get('/register', requireAuth, (req, res) => {
    try {
      const companyId = getActiveCompanyId ? getActiveCompanyId() : '';
      const rows = ocrDocumentsRepo.list(companyId, 'inward', 100);
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
