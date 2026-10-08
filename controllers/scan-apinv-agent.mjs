/**
 * Scan A/P Invoice Agent — OCR Three-Way Matching (AI → OCR → "Scan A/P Invoice")
 *  1. Select open GRPO (by number or vendor)
 *  2. Upload supplier PDF / image invoice
 *  3. OCR extracts invoice data via AI vision
 *  4. Three-way match: PO→GRPO vs Supplier Invoice
 *  5. Review pre-filled AP Invoice form → post to SAP B1
 * The plain GRPO → A/P Invoice copy flow (no supplier document) is grpo-to-apinv-agent.mjs.
 */
import { Router } from 'express';
import multer from 'multer';
import { createRequire } from 'module';
import { renderAPInvPrint } from './grpo-to-apinv-agent.mjs';

const _require = createRequire(import.meta.url);
let pdfParse;
try { pdfParse = _require('pdf-parse'); } catch(e) {}

const _sessions = new Map();
const _upload   = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

// ── Session ────────────────────────────────────────────────────────────────────
function initSession() {
  return {
    step:        'INIT',
    history:     [],
    grpoDetail:  null,   // fetched GRPO detail
    ocrData:     null,   // AI-extracted invoice data
    matchResult: null,   // three-way match result rows
    result:      null,   // {docEntry,docNum} after post
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────────
function today()    { return new Date().toISOString().slice(0, 10); }
function sapDate(s) { const d = s || today(); return d.length === 10 ? `${d}T00:00:00` : d; }
function fmtN(n, d = 2) {
  if (n == null || isNaN(Number(n))) return '—';
  return Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}
function escHtml(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function datePlusDays(n) { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); }

// Simple description similarity (word overlap)
function similarity(a, b) {
  if (!a || !b) return 0;
  a = String(a).toLowerCase(); b = String(b).toLowerCase();
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.85;
  const wa = a.split(/[\s\-_/,]+/).filter(w => w.length > 2);
  const wb = b.split(/[\s\-_/,]+/).filter(w => w.length > 2);
  if (!wa.length || !wb.length) return 0;
  const common = wa.filter(w => wb.includes(w)).length;
  return common / Math.max(wa.length, wb.length);
}

// ── SAP helpers ────────────────────────────────────────────────────────────────
async function fetchOpenGRPOs(sap) {
  const base = { $filter: `DocumentStatus eq 'bost_Open'`, $orderby: 'DocDate desc', $top: 50 };
  try {
    const r = await sap.get('/PurchaseDeliveryNotes', {
      ...base,
      $select: 'DocEntry,DocNum,DocDate,DocDueDate,CardCode,CardName,DocTotal',
    });
    if (Array.isArray(r.value)) return r.value;
  } catch { /* $select rejected */ }
  try {
    const r = await sap.get('/PurchaseDeliveryNotes', base);
    return Array.isArray(r.value) ? r.value : [];
  } catch (e) {
    console.error('[SCAN-APINV] fetchOpenGRPOs error:', e.message);
    return [];
  }
}

async function fetchGRPOByNum(sap, docNum) {
  try {
    // DocNum is not unique across numbering series — prefer the latest open GRPO
    const r = await sap.get('/PurchaseDeliveryNotes', {
      $filter: `DocNum eq ${parseInt(docNum, 10)} and DocumentStatus eq 'bost_Open'`,
      $orderby: 'DocEntry desc',
      $top: 1,
    });
    const entry = r.value?.[0];
    if (!entry) return null;
    return await sap.get(`/PurchaseDeliveryNotes(${entry.DocEntry})`);
  } catch { return null; }
}

async function fetchGRPOByEntry(sap, docEntry) {
  try {
    return await sap.get(`/PurchaseDeliveryNotes(${parseInt(docEntry, 10)})`);
  } catch { return null; }
}

function buildGRPODetail(doc) {
  return {
    docEntry: doc.DocEntry,
    docNum:   doc.DocNum,
    docDate:  doc.DocDate    ? doc.DocDate.slice(0, 10)    : null,
    dueDate:  doc.DocDueDate ? doc.DocDueDate.slice(0, 10) : null,
    cardCode: doc.CardCode   || null,
    cardName: doc.CardName   || null,
    numAtCard: doc.NumAtCard || null,
    comments: doc.Comments   || null,
    docTotal: Number(doc.DocTotal || 0),
    // Only open lines with quantity still left to invoice
    lines: (doc.DocumentLines || [])
      .filter(l => l.ItemCode && l.LineStatus !== 'bost_Close')
      .map(l => ({
        lineNum:   l.LineNum,
        baseLine:  l.LineNum,
        itemCode:  l.ItemCode,
        itemName:  l.ItemDescription || l.ItemCode,
        qty:       Number(l.RemainingOpenQuantity ?? l.Quantity ?? 0),
        unitPrice: Number(l.UnitPrice   || l.Price || 0),
        lineTotal: Number(l.LineTotal   || 0),
        unit:      l.UoMCode || l.MeasureUnit || 'EA',
        warehouse: l.WarehouseCode || '',
        taxCode:   l.TaxCode || null,
      }))
      .filter(l => l.qty > 0),
  };
}

// ── OCR / AI Invoice Extraction ────────────────────────────────────────────────
const OCR_SYSTEM = `You are an expert invoice OCR system. Extract all data from the invoice document/image.
Return ONLY valid JSON (no markdown, no explanation) with this structure:
{
  "invoiceNumber": "string",
  "invoiceDate": "YYYY-MM-DD or null",
  "dueDate": "YYYY-MM-DD or null",
  "vendorName": "string or null",
  "vendorCode": "string or null",
  "currency": "GBP",
  "subtotal": 0,
  "taxTotal": 0,
  "grandTotal": 0,
  "lines": [
    {
      "lineNum": 1,
      "itemCode": "string or null",
      "description": "string",
      "qty": 0,
      "unit": "EA",
      "unitPrice": 0,
      "lineTotal": 0,
      "taxRate": 0
    }
  ]
}
Use null for strings that cannot be determined. Use 0 for numeric fields that cannot be determined.
"lines" must contain ONLY the item rows actually printed in the invoice's line-item table, once each, in printed order.
Never invent, guess or repeat lines. Do not include subtotal, tax, VAT, freight, discount, total, bank or address rows as lines.
If no invoice content is provided, return "lines": [].`;

async function extractInvoiceOCR(fileBuffer, mimeType, extractedText, aiDeps) {
  const { AI_PROVIDER, gptChatComplete, azureMessagesCreate, USE_AI } = aiDeps || {};

  // Build message content for vision-capable AI
  const buildUserContent = (isOpenAIFormat) => {
    if (isOpenAIFormat) {
      const parts = [];
      if (fileBuffer && (mimeType?.startsWith('image/'))) {
        parts.push({ type: 'image_url', image_url: { url: `data:${mimeType};base64,${fileBuffer.toString('base64')}` } });
      }
      if (extractedText) parts.push({ type: 'text', text: `Invoice text:\n${extractedText}` });
      parts.push({ type: 'text', text: 'Extract invoice data as JSON per instructions.' });
      return parts;
    } else {
      // Anthropic format
      const parts = [];
      if (fileBuffer && mimeType?.startsWith('image/')) {
        parts.push({ type: 'image', source: { type: 'base64', media_type: mimeType, data: fileBuffer.toString('base64') } });
      } else if (fileBuffer && mimeType === 'application/pdf') {
        parts.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: fileBuffer.toString('base64') } });
      }
      if (extractedText) parts.push({ type: 'text', text: `Invoice text:\n${extractedText}` });
      parts.push({ type: 'text', text: 'Extract invoice data as JSON per instructions.' });
      return parts;
    }
  };

  // GPT path can only read images or extracted text. A scanned PDF with no text
  // layer gives it nothing, and the model then invents lines — skip it.
  const gptHasInput = !!extractedText || !!mimeType?.startsWith('image/');

  let rawText = null;

  try {
    if (AI_PROVIDER === 'gpt' && USE_AI && !gptHasInput) {
      console.warn('[SCAN-APINV] GPT OCR skipped: scanned PDF has no text layer');
      if (process.env.ANTHROPIC_API_KEY) {
        const { default: Anthropic } = await import('@anthropic-ai/sdk');
        const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
        const resp = await client.messages.create({
          model: 'claude-sonnet-4-6', max_tokens: 2000,
          system: OCR_SYSTEM,
          messages: [{ role: 'user', content: buildUserContent(false) }],
        });
        rawText = resp.content?.[0]?.text || null;
      }
    } else if (AI_PROVIDER === 'gpt' && USE_AI) {
      const r = await gptChatComplete({
        messages: [
          { role: 'system', content: OCR_SYSTEM },
          { role: 'user', content: buildUserContent(true) },
        ],
        max_tokens: 2000,
      });
      rawText = r?.choices?.[0]?.message?.content || null;
    } else if (AI_PROVIDER === 'azure' && USE_AI) {
      const r = await azureMessagesCreate({
        model: process.env.AZURE_CLAUDE_MODEL || 'claude-sonnet-4-6',
        system: OCR_SYSTEM,
        messages: [{ role: 'user', content: buildUserContent(false) }],
        max_tokens: 2000,
      });
      rawText = r?.content?.[0]?.text || r?.choices?.[0]?.message?.content || null;
    } else if (process.env.ANTHROPIC_API_KEY) {
      const { default: Anthropic } = await import('@anthropic-ai/sdk');
      const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      const resp = await client.messages.create({
        model: 'claude-sonnet-4-6', max_tokens: 2000,
        system: OCR_SYSTEM,
        messages: [{ role: 'user', content: buildUserContent(false) }],
      });
      rawText = resp.content?.[0]?.text || null;
    }
  } catch (e) {
    console.error('[SCAN-APINV] OCR AI error:', e.message);
  }

  if (rawText) {
    try {
      const jsonMatch = rawText.match(/\{[\s\S]*\}/);
      if (jsonMatch) return normalizeOCR(JSON.parse(jsonMatch[0]));
    } catch (e) { console.error('[SCAN-APINV] OCR JSON parse error:', e.message); }
  }

  // Fallback: basic regex extraction from text
  if (extractedText) return normalizeOCR(fallbackExtract(extractedText));
  return null;
}

// Drop non-item rows, zero-qty rows and exact duplicates the OCR may return
const NON_ITEM_RE = /\b(sub\s*-?total|total|vat|gst|tax|freight|shipping|carriage|discount|rounding|balance|amount due)\b/i;
function normalizeOCR(ocr) {
  if (!ocr || typeof ocr !== 'object') return ocr;
  const seen = new Set();
  const lines = (Array.isArray(ocr.lines) ? ocr.lines : [])
    .map(l => ({
      ...l,
      itemCode:    l.itemCode ? String(l.itemCode).trim() : null,
      description: String(l.description || '').trim(),
      qty:         Number(l.qty) || 0,
      unitPrice:   Number(l.unitPrice) || 0,
      lineTotal:   Number(l.lineTotal) || 0,
    }))
    .filter(l => l.qty > 0 && (l.itemCode || l.description))
    .filter(l => l.itemCode || !NON_ITEM_RE.test(l.description))
    .filter(l => {
      const key = [l.itemCode, l.description.toLowerCase(), l.qty, l.unitPrice, l.lineNum].join('|');
      if (seen.has(key)) return false;
      seen.add(key); return true;
    })
    .map((l, i) => ({ ...l, lineNum: i + 1 }));
  return { ...ocr, lines };
}

function fallbackExtract(text) {
  const invNum = text.match(/(?:invoice|inv)[\s#:]*([A-Z0-9\-\/]+)/i)?.[1] || null;
  const total  = text.match(/(?:total|amount due|grand total)[\s:]*\$?([\d,]+\.?\d*)/i)?.[1];
  const lines  = [];
  // One table row per text line: code + description + qty + price + total.
  // [ \t] (not \s) so a match can't span lines and glue addresses/dates together.
  const lineRe = /^[ \t]*([A-Z0-9][A-Z0-9\-]*)[ \t]+(.+?)[ \t]+(\d+(?:\.\d+)?)[ \t]+(\d+(?:[.,]\d+)*)[ \t]+(\d+(?:[.,]\d+)*)[ \t]*$/gm;
  const num = s => parseFloat(String(s).replace(/,/g, ''));
  let m;
  while ((m = lineRe.exec(text)) !== null) {
    const qty = num(m[3]), unitPrice = num(m[4]), lineTotal = num(m[5]);
    // Keep only rows whose numbers are consistent (qty × price ≈ total)
    if (!(qty > 0) || Math.abs(qty * unitPrice - lineTotal) > Math.max(0.05, lineTotal * 0.02)) continue;
    lines.push({ lineNum: lines.length + 1, itemCode: m[1], description: m[2].trim(), qty, unit: 'EA', unitPrice, lineTotal, taxRate: 0 });
  }
  return {
    invoiceNumber: invNum,
    invoiceDate: null,
    dueDate: null,
    vendorName: null,
    vendorCode: null,
    currency: 'GBP',
    subtotal: 0,
    taxTotal: 0,
    grandTotal: total ? parseFloat(total.replace(/,/g,'')) : 0,
    lines,
  };
}

// ── Three-Way Matching ─────────────────────────────────────────────────────────
const PRICE_TOLERANCE_PCT = 2; // 2% price variance allowed

function threeWayMatch(grpoDetail, ocrData) {
  const results = [];
  const ocrLines   = ocrData?.lines || [];
  const usedOCRIdx = new Set();
  const grpoLines  = grpoDetail.lines || [];

  // Score every GRPO×OCR pair, then assign best pairs first (global, not
  // first-come), so an early GRPO line can't steal another line's OCR row.
  const MIN_SCORE = 0.5;
  const pairs = [];
  grpoLines.forEach((gl, gi) => {
    ocrLines.forEach((ol, oi) => {
      const codeHit = ol.itemCode && gl.itemCode &&
        String(ol.itemCode).trim().toUpperCase() === String(gl.itemCode).trim().toUpperCase();
      let score = codeHit ? 2 : similarity(ol.description, gl.itemName);
      if (score < MIN_SCORE) return;
      if (Math.abs((Number(ol.qty) || 0) - gl.qty) < 0.001) score += 0.05; // tie-break on qty
      pairs.push({ gi, oi, score });
    });
  });
  pairs.sort((a, b) => b.score - a.score || a.gi - b.gi || a.oi - b.oi);
  const grpoToOcr = new Map();
  for (const p of pairs) {
    if (grpoToOcr.has(p.gi) || usedOCRIdx.has(p.oi)) continue;
    grpoToOcr.set(p.gi, p.oi);
    usedOCRIdx.add(p.oi);
  }

  for (const [gi, gl] of grpoLines.entries()) {
    if (!grpoToOcr.has(gi)) {
      results.push({ grpoLine: gl, ocrLine: null, status: 'not_invoiced', priceVariance: 0, qtyVariance: 0 });
    } else {
      const ol = ocrLines[grpoToOcr.get(gi)];
      const qtyVar      = Math.abs(ol.qty - gl.qty);
      const priceVar    = gl.unitPrice > 0 ? Math.abs((ol.unitPrice - gl.unitPrice) / gl.unitPrice) * 100 : 0;
      const qtyMatch    = qtyVar < 0.001;
      const priceMatch  = priceVar <= PRICE_TOLERANCE_PCT;
      let status = 'matched';
      if (!qtyMatch && !priceMatch) status = 'qty_price_mismatch';
      else if (!qtyMatch)  status = 'qty_mismatch';
      else if (!priceMatch) status = 'price_variance';
      results.push({ grpoLine: gl, ocrLine: ol, status, priceVariance: priceVar, qtyVariance: qtyVar });
    }
  }

  // Extra lines on invoice not found in GRPO
  ocrLines.forEach((ol, idx) => {
    if (!usedOCRIdx.has(idx)) {
      results.push({ grpoLine: null, ocrLine: ol, status: 'invoice_only', priceVariance: 0, qtyVariance: 0 });
    }
  });

  return results;
}

// AP Invoice form: only GRPO lines that were matched to a line on the scanned
// invoice. GRPO lines not on the invoice stay visible in the match table only.
function buildFormData(session) {
  const od = session.ocrData;
  return {
    grpoDocEntry:  session.grpoDetail.docEntry,
    grpoDocNum:    session.grpoDetail.docNum,
    cardCode:      session.grpoDetail.cardCode,
    cardName:      session.grpoDetail.cardName,
    invoiceNumber: od?.invoiceNumber || '',
    invoiceDate:   od?.invoiceDate   || today(),
    dueDate:       od?.dueDate       || datePlusDays(30),
    currency:      od?.currency      || 'GBP',
    grandTotal:    od?.grandTotal    || 0,
    matchResult:   session.matchResult,
    lines: (session.matchResult || [])
      .filter(r => r.grpoLine && r.ocrLine)
      .map(r => ({
        baseLine:  r.grpoLine.baseLine,
        itemCode:  r.grpoLine.itemCode,
        itemName:  r.grpoLine.itemName,
        grpoQty:   r.grpoLine.qty,
        grpoPrice: r.grpoLine.unitPrice,
        recvQty:   r.grpoLine.qty,
        invQty:    r.ocrLine.qty,
        invPrice:  r.ocrLine.unitPrice,
        unit:      r.grpoLine.unit,
        warehouse: r.grpoLine.warehouse,
        taxCode:   r.grpoLine.taxCode,
        status:    r.status,
        priceVar:  r.priceVariance,
      })),
  };
}

// Build HTML reconciliation table (rendered in chat bubble)
function buildMatchHTML(matchResult, grpoDetail, ocrData) {
  const statusIcon = { matched:'✅', price_variance:'⚠️', qty_mismatch:'❌', qty_price_mismatch:'❌', not_invoiced:'ℹ️', invoice_only:'⚠️' };
  const statusLabel = { matched:'Match', price_variance:'Price Δ', qty_mismatch:'Qty Mismatch', qty_price_mismatch:'Qty+Price ❌', not_invoiced:'Not Invoiced', invoice_only:'Extra Line' };

  const allMatch    = matchResult.every(r => r.status === 'matched');
  const hasErrors   = matchResult.some(r => ['qty_mismatch','qty_price_mismatch'].includes(r.status));
  const hasWarnings = matchResult.some(r => ['price_variance','invoice_only'].includes(r.status));

  const summary = allMatch
    ? `<div style="background:#dcfce7;border:1px solid #86efac;border-radius:6px;padding:8px 12px;margin-bottom:12px;font-size:12px;color:#166534;font-weight:600">✅ All ${matchResult.length} lines matched perfectly — ready to post</div>`
    : hasErrors
    ? `<div style="background:#fee2e2;border:1px solid #fca5a5;border-radius:6px;padding:8px 12px;margin-bottom:12px;font-size:12px;color:#991b1b;font-weight:600">❌ Mismatches found — review before posting</div>`
    : `<div style="background:#fef9c3;border:1px solid #fde047;border-radius:6px;padding:8px 12px;margin-bottom:12px;font-size:12px;color:#854d0e;font-weight:600">⚠️ Minor variances found — verify before posting</div>`;

  const rows = matchResult.map(r => {
    const gl = r.grpoLine; const ol = r.ocrLine;
    const itemCode  = escHtml(gl?.itemCode  || ol?.itemCode  || '—');
    const itemName  = escHtml((gl?.itemName || ol?.description || '').substring(0, 40));
    const grpoQty   = gl ? fmtN(gl.qty, 3)  : '—';
    const invQty    = ol ? fmtN(ol.qty, 3)  : '—';
    const grpoPrice = gl ? fmtN(gl.unitPrice) : '—';
    const invPrice  = ol ? fmtN(ol.unitPrice) : '—';
    const icon = statusIcon[r.status] || '?';
    const label = statusLabel[r.status] || r.status;
    const rowBg = r.status === 'matched' ? '' : r.status === 'price_variance' || r.status === 'invoice_only' ? 'background:#fffbeb;' : 'background:#fff1f1;';
    const priceCellStyle = r.status === 'price_variance' || r.status === 'qty_price_mismatch'
      ? 'color:#dc2626;font-weight:700' : '';
    const qtyCellStyle = r.status === 'qty_mismatch' || r.status === 'qty_price_mismatch'
      ? 'color:#dc2626;font-weight:700' : '';

    return `<tr style="${rowBg}">
      <td style="padding:6px 8px;font-size:11.5px;font-weight:700;color:#0f766e">${itemCode}</td>
      <td style="padding:6px 8px;font-size:11px;max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${itemName}">${itemName}</td>
      <td style="padding:6px 8px;text-align:right;font-size:11px">${grpoQty}</td>
      <td style="padding:6px 8px;text-align:right;font-size:11px;${qtyCellStyle}">${invQty}</td>
      <td style="padding:6px 8px;text-align:right;font-size:11px">${grpoPrice}</td>
      <td style="padding:6px 8px;text-align:right;font-size:11px;${priceCellStyle}">${invPrice}</td>
      <td style="padding:6px 8px;text-align:center;font-size:11px;white-space:nowrap">${icon} ${label}</td>
    </tr>`;
  }).join('');

  const invSummary = ocrData ? `
    <div style="margin-bottom:10px;font-size:12px;display:flex;gap:20px;flex-wrap:wrap">
      <span><strong>Invoice #:</strong> ${escHtml(ocrData.invoiceNumber || '—')}</span>
      <span><strong>Date:</strong> ${escHtml(ocrData.invoiceDate || '—')}</span>
      <span><strong>Vendor:</strong> ${escHtml(ocrData.vendorName || grpoDetail.cardName || '—')}</span>
      <span><strong>Invoice Total:</strong> ${fmtN(ocrData.grandTotal)}</span>
      <span><strong>GRPO Total:</strong> ${fmtN(grpoDetail.docTotal)}</span>
    </div>` : '';

  return `<div style="font-family:var(--font);font-size:12px">
    ${invSummary}
    ${summary}
    <div style="font-size:11px;font-weight:700;color:#374151;margin-bottom:6px">Three-Way Match — GRPO #${grpoDetail.docNum} vs Supplier Invoice</div>
    <div style="overflow-x:auto">
    <table style="width:100%;border-collapse:collapse;font-size:11.5px">
      <thead>
        <tr style="background:#0f766e;color:#fff">
          <th style="padding:7px 8px;text-align:left">Item Code</th>
          <th style="padding:7px 8px;text-align:left">Description</th>
          <th style="padding:7px 8px;text-align:right">GRPO Qty</th>
          <th style="padding:7px 8px;text-align:right">Inv Qty</th>
          <th style="padding:7px 8px;text-align:right">GRPO Price</th>
          <th style="padding:7px 8px;text-align:right">Inv Price</th>
          <th style="padding:7px 8px;text-align:center">Status</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    </div>
  </div>`;
}

// ── Router factory ─────────────────────────────────────────────────────────────
export function createScanAPInvAgentRouter(deps) {
  const { requireAuth, printAuth, getActiveSap, gptChatComplete, azureMessagesCreate, AI_PROVIDER, USE_AI } = deps;
  const aiDeps = { AI_PROVIDER, gptChatComplete, azureMessagesCreate, USE_AI };
  const router = Router();

  // ── POST /upload — OCR file processing ─────────────────────────────────────
  router.post('/upload', requireAuth, _upload.single('invoice'), async (req, res) => {
    try {
      const file = req.file;
      if (!file) return res.status(400).json({ ok: false, error: 'No file uploaded.' });

      const mimeType = file.mimetype;
      let extractedText = null;

      // Extract text from PDF if possible
      if (mimeType === 'application/pdf' && pdfParse) {
        try {
          const data = await pdfParse(file.buffer);
          if (data.text && data.text.trim().length > 100) extractedText = data.text.slice(0, 8000);
        } catch (e) { console.warn('[SCAN-APINV] pdf-parse error:', e.message); }
      }

      // Run OCR via AI
      const ocrData = await extractInvoiceOCR(file.buffer, mimeType, extractedText, aiDeps);

      if (!ocrData) {
        return res.status(422).json({ ok: false, error: 'Could not extract invoice data. Please ensure the file is a clear PDF or image.' });
      }

      res.json({
        ok: true,
        ocrData,
        fileName: file.originalname,
        fileSize: file.size,
        mimeType,
      });
    } catch (e) {
      console.error('[SCAN-APINV] upload error:', e);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ── POST /chat — main conversation ────────────────────────────────────────
  router.post('/chat', requireAuth, async (req, res) => {
    try {
      const { message = '', sessionId } = req.body;
      const sid = sessionId || `apinv_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      if (!_sessions.has(sid)) _sessions.set(sid, initSession());
      const session = _sessions.get(sid);
      const sap     = getActiveSap();
      const msg     = message.trim();
      const msgL    = msg.toLowerCase();

      if (msg) session.history.push({ role: 'user', content: msg });

      let reply        = '';
      let quickReplies = [];
      let meta         = {};
      let matchHTML    = null;
      let uploadReady  = false;
      let formData     = null;
      let grpoList     = null;

      // ── JSON action (ocr_result / post_apinv) ────────────────────────────
      if (msg.startsWith('{')) {
        let action = null;
        try { action = JSON.parse(msg); } catch {}

        // OCR result received from frontend after upload
        if (action?.action === 'ocr_result') {
          session.ocrData = action.ocrData;
          if (!session.grpoDetail) {
            reply = '⚠️ No GRPO selected. Please select a GRPO first.';
            uploadReady = false;
          } else {
            session.matchResult = threeWayMatch(session.grpoDetail, session.ocrData);
            const matched = session.matchResult.filter(r => r.status === 'matched').length;
            const total   = session.matchResult.length;
            const hasErr  = session.matchResult.some(r => ['qty_mismatch','qty_price_mismatch'].includes(r.status));

            matchHTML = buildMatchHTML(session.matchResult, session.grpoDetail, session.ocrData);
            reply = hasErr
              ? `### ⚠️ Three-Way Match Complete (${matched}/${total} matched)\n\nSome lines have mismatches. Review carefully before posting.`
              : `### ✅ Three-Way Match Complete (${matched}/${total} matched)\n\nAll checks passed. Open the AP Invoice form to review and post.`;

            // Build form data for the modal
            formData = buildFormData(session);
            if (!formData.lines.length) {
              reply += `\n\n> ⚠️ No invoice line could be matched to GRPO #${session.grpoDetail.docNum}. Check that you selected the right GRPO, or re-upload a clearer invoice.`;
            }
            quickReplies = ['Open AP Invoice Form', 'Re-upload Invoice'];
            session.step = 'REVIEW_FORM';
          }
        }

        // Post AP Invoice
        else if (action?.action === 'post_apinv') {
          const lines = action.lines || [];
          if (!lines.length) {
            reply = '❌ No lines to invoice. Select at least one line.';
          } else {
            try {
              const grpo = session.grpoDetail;
              const payload = {
                DocDate:    sapDate(action.invoiceDate || today()),
                DocDueDate: sapDate(action.dueDate     || datePlusDays(30)),
                CardCode:   grpo.cardCode || undefined,
                NumAtCard:  action.invoiceNumber || undefined,
                ...(action.comments ? { Comments: action.comments } : {}),
                DocumentLines: lines.map(l => ({
                  BaseType:  20,   // oPurchaseDeliveryNotes (GRPO)
                  BaseEntry: Number(grpo.docEntry),
                  BaseLine:  Number(l.baseLine),
                  Quantity:  Number(l.qty),
                  UnitPrice: Number(l.unitPrice),
                  ...(l.taxCode    ? { TaxCode: l.taxCode } : {}),
                  ...(l.warehouse  ? { WarehouseCode: l.warehouse } : {}),
                })),
              };

              const result = await sap.post('/PurchaseInvoices', payload);
              session.result = { docEntry: result.DocEntry, docNum: result.DocNum };
              session.step   = 'DONE';

              reply = `### ✅ A/P Invoice Posted!\n\n` +
                `| Field | Value |\n|---|---|\n` +
                `| **AP Invoice #** | ${result.DocNum} |\n` +
                `| **Doc Entry** | ${result.DocEntry} |\n` +
                `| **Vendor** | ${grpo.cardName || grpo.cardCode || '—'} |\n` +
                `| **Supplier Ref** | ${action.invoiceNumber || '—'} |\n` +
                `| **Lines** | ${lines.length} |\n` +
                `| **Source GRPO** | GRPO #${grpo.docNum} |\n\n` +
                `[🖨️ Print A/P Invoice](/api/scan-apinv/print/${result.DocEntry})\n\nWould you like to process another invoice?`;
              quickReplies = ['Yes, Process Another', 'No, Done'];
              meta = {
                docEntry:  result.DocEntry,
                docNum:    result.DocNum,
                printUrl:  `/api/scan-apinv/print/${result.DocEntry}`,
                vendor:    { cardCode: grpo.cardCode, cardName: grpo.cardName },
              };
            } catch (e) {
              reply = `❌ **Failed to post A/P Invoice**\n\nSAP Error: _${e.message}_\n\nWould you like to **retry** or **cancel**?`;
              quickReplies = ['Retry', 'Cancel'];
            }
          }
        } else {
          reply = 'Unexpected action. Please start over.';
        }
      }

      // ── INIT ──────────────────────────────────────────────────────────────
      else if (session.step === 'INIT' || (!msg && session.step === 'INIT')) {
        const grpos = await fetchOpenGRPOs(sap);
        const tod = today();
        reply = `## 🧾 GRPO → A/P Invoice Agent\n\n*OCR three-way matching — PO → GRPO → Supplier Invoice*\n\n`;

        if (!grpos.length) {
          reply += `> ✅ No open Goods Receipt POs pending invoicing.`;
          quickReplies = ['Refresh'];
        } else {
          const grouped = {};
          grpos.forEach(g => {
            const k = g.CardCode || '—';
            if (!grouped[k]) grouped[k] = { name: g.CardName || k, count: 0, total: 0 };
            grouped[k].count++;
            grouped[k].total += Number(g.DocTotal || 0);
          });
          reply += `**${grpos.length} open GRPO${grpos.length !== 1 ? 's' : ''}** pending AP invoicing across **${Object.keys(grouped).length} vendor${Object.keys(grouped).length !== 1 ? 's' : ''}**\n\n`;
          reply += `Enter a **GRPO number** or **vendor name/code** to begin:\n\n`;
          grpoList = grpos.slice(0, 20).map(g => ({
            docEntry: g.DocEntry, docNum: g.DocNum,
            docDate:  g.DocDate  ? g.DocDate.slice(0, 10)    : null,
            dueDate:  g.DocDueDate ? g.DocDueDate.slice(0, 10) : null,
            cardCode: g.CardCode, cardName: g.CardName,
            docTotal: Number(g.DocTotal || 0),
            overdue:  (g.DocDueDate?.slice(0, 10) || '') < tod,
          }));
          session.step = 'SELECT_GRPO';
        }
      }

      // ── SELECT_GRPO ────────────────────────────────────────────────────────
      else if (session.step === 'SELECT_GRPO') {
        if (/refresh|reload/i.test(msgL)) {
          session.step = 'INIT';
          // recurse — fall through to INIT
          const grpos = await fetchOpenGRPOs(sap);
          const tod = today();
          grpoList = grpos.slice(0, 20).map(g => ({
            docEntry: g.DocEntry, docNum: g.DocNum,
            docDate:  g.DocDate ? g.DocDate.slice(0, 10) : null,
            dueDate:  g.DocDueDate ? g.DocDueDate.slice(0, 10) : null,
            cardCode: g.CardCode, cardName: g.CardName,
            docTotal: Number(g.DocTotal || 0),
            overdue:  (g.DocDueDate?.slice(0, 10) || '') < tod,
          }));
          reply = `Refreshed — ${grpos.length} open GRPO${grpos.length !== 1 ? 's' : ''} found. Select one:`;
          session.step = 'SELECT_GRPO';
        } else {
          // Try to parse as GRPO# or vendor search
          const numMatch = msg.match(/^GRPO#?(\d+)$/i) || msg.match(/^(\d+)$/);
          let full = null;
          if (numMatch) {
            full = await fetchGRPOByNum(sap, numMatch[1]);
          } else {
            // Search by vendor
            try {
              const r = await sap.get('/PurchaseDeliveryNotes', {
                $filter: `DocumentStatus eq 'bost_Open' and (substringof('${msg.replace(/'/g,"''")}',CardName) or substringof('${msg.replace(/'/g,"''")}',CardCode))`,
                $orderby: 'DocDate desc',
                $top: 10,
              });
              const candidates = r.value || [];
              if (candidates.length === 1) {
                full = await fetchGRPOByEntry(sap, candidates[0].DocEntry);
              } else if (candidates.length > 1) {
                const tod = today();
                grpoList = candidates.map(g => ({
                  docEntry: g.DocEntry, docNum: g.DocNum,
                  docDate:  g.DocDate ? g.DocDate.slice(0, 10) : null,
                  dueDate:  g.DocDueDate ? g.DocDueDate.slice(0, 10) : null,
                  cardCode: g.CardCode, cardName: g.CardName,
                  docTotal: Number(g.DocTotal || 0),
                  overdue:  (g.DocDueDate?.slice(0, 10) || '') < tod,
                }));
                reply = `Found ${candidates.length} GRPOs for "${msg}". Select one:`;
              } else {
                reply = `No open GRPOs found for "${msg}". Try a GRPO number or different vendor name.`;
              }
            } catch (e) {
              reply = `Search error: ${e.message}. Try entering a GRPO number directly.`;
            }
          }

          if (full) {
            session.grpoDetail = buildGRPODetail(full);
            session.step = 'UPLOAD_INVOICE';
            const lc = session.grpoDetail.lines.length;
            reply = `### GRPO #${full.DocNum} — ${full.CardName || full.CardCode || '—'}\n\n` +
              `| Field | Value |\n|---|---|\n` +
              `| **Date** | ${session.grpoDetail.docDate || '—'} |\n` +
              `| **Vendor** | ${full.CardName || '—'} (${full.CardCode || '—'}) |\n` +
              `| **Lines** | ${lc} line${lc !== 1 ? 's' : ''} |\n` +
              `| **Total** | ${fmtN(Number(full.DocTotal || 0))} |\n\n` +
              `Now **upload the supplier invoice** (PDF or image) for three-way matching:`;
            uploadReady = true;
          }
        }
      }

      // ── UPLOAD_INVOICE ─────────────────────────────────────────────────────
      else if (session.step === 'UPLOAD_INVOICE') {
        if (/back|change|grpo/i.test(msgL)) {
          session.step = 'SELECT_GRPO';
          session.grpoDetail = null;
          reply = 'Returning to GRPO selection. Enter a GRPO number or vendor:';
        } else {
          reply = 'Please upload the supplier invoice using the upload button below.';
          uploadReady = true;
        }
      }

      // ── REVIEW_FORM ────────────────────────────────────────────────────────
      else if (session.step === 'REVIEW_FORM') {
        if (/re-?upload|new invoice|change invoice/i.test(msgL)) {
          session.ocrData = null;
          session.matchResult = null;
          session.step = 'UPLOAD_INVOICE';
          reply = 'Ready for a new upload. Please upload the corrected supplier invoice:';
          uploadReady = true;
        } else if (/open|form|review|post|invoice/i.test(msgL)) {
          formData = buildFormData(session);
          reply = 'Opening AP Invoice form…';
        } else if (/cancel|start over/i.test(msgL)) {
          Object.assign(session, initSession());
          reply = 'Cancelled. Starting over…';
          const grpos = await fetchOpenGRPOs(sap);
          const tod = today();
          grpoList = grpos.slice(0, 20).map(g => ({
            docEntry: g.DocEntry, docNum: g.DocNum,
            docDate:  g.DocDate ? g.DocDate.slice(0, 10) : null,
            dueDate:  g.DocDueDate ? g.DocDueDate.slice(0, 10) : null,
            cardCode: g.CardCode, cardName: g.CardName,
            docTotal: Number(g.DocTotal || 0),
            overdue:  (g.DocDueDate?.slice(0, 10) || '') < tod,
          }));
          session.step = 'SELECT_GRPO';
        } else {
          reply = 'What would you like to do?';
          quickReplies = ['Open AP Invoice Form', 'Re-upload Invoice', 'Cancel'];
        }
      }

      // ── DONE ──────────────────────────────────────────────────────────────
      else if (session.step === 'DONE') {
        if (/yes|another|more|process/i.test(msgL)) {
          Object.assign(session, initSession());
          const grpos = await fetchOpenGRPOs(sap);
          const tod = today();
          grpoList = grpos.slice(0, 20).map(g => ({
            docEntry: g.DocEntry, docNum: g.DocNum,
            docDate:  g.DocDate ? g.DocDate.slice(0, 10) : null,
            dueDate:  g.DocDueDate ? g.DocDueDate.slice(0, 10) : null,
            cardCode: g.CardCode, cardName: g.CardName,
            docTotal: Number(g.DocTotal || 0),
            overdue:  (g.DocDueDate?.slice(0, 10) || '') < tod,
          }));
          reply = `Ready. ${grpos.length} open GRPO${grpos.length !== 1 ? 's' : ''} pending invoicing. Select one:`;
          session.step = 'SELECT_GRPO';
        } else {
          reply = 'Workflow complete. Click "Process Another" to start again.';
          quickReplies = ['Process Another'];
        }
      }

      // ── Fallback ──────────────────────────────────────────────────────────
      else {
        session.step = 'INIT';
        reply = 'Session reset. Please select a GRPO to begin.';
        const grpos = await fetchOpenGRPOs(sap);
        const tod = today();
        grpoList = grpos.slice(0, 20).map(g => ({
          docEntry: g.DocEntry, docNum: g.DocNum,
          docDate:  g.DocDate ? g.DocDate.slice(0, 10) : null,
          dueDate:  g.DocDueDate ? g.DocDueDate.slice(0, 10) : null,
          cardCode: g.CardCode, cardName: g.CardName,
          docTotal: Number(g.DocTotal || 0),
          overdue:  (g.DocDueDate?.slice(0, 10) || '') < tod,
        }));
        session.step = 'SELECT_GRPO';
      }

      session.history.push({ role: 'assistant', content: reply });
      if (session.history.length > 40) session.history.splice(0, session.history.length - 40);

      res.json({
        ok: true, reply, quickReplies, sessionId: sid,
        step: session.step,
        grpoDetail: session.grpoDetail,
        meta, matchHTML, uploadReady, formData, grpoList,
      });

    } catch (e) {
      console.error('[SCAN-APINV] chat error:', e);
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
      const doc = await sap.get(`/PurchaseInvoices(${parseInt(req.params.docEntry, 10)})`);
      res.setHeader('Content-Type', 'text/html');
      res.send(renderAPInvPrint(doc));
    } catch (e) {
      res.status(500).send(`<pre style="color:red">Error loading AP Invoice #${req.params.docEntry}: ${e.message}</pre>`);
    }
  });

  return router;
}
