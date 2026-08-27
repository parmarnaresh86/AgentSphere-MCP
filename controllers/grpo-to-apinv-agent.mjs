/**
 * GRPO → AP Invoice Agent — OCR Three-Way Matching
 *  1. Select open GRPO (by number or vendor)
 *  2. Upload supplier PDF / image invoice
 *  3. OCR extracts invoice data via AI vision
 *  4. Three-way match: PO→GRPO vs Supplier Invoice
 *  5. Review pre-filled AP Invoice form → post to SAP B1
 */
import { Router } from 'express';
import multer from 'multer';
import { createRequire } from 'module';

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
    console.error('[GRPO-APINV] fetchOpenGRPOs error:', e.message);
    return [];
  }
}

async function fetchGRPOByNum(sap, docNum) {
  try {
    const r = await sap.get('/PurchaseDeliveryNotes', {
      $filter: `DocNum eq ${parseInt(docNum, 10)}`,
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
    lines: (doc.DocumentLines || [])
      .filter(l => l.ItemCode)
      .map(l => ({
        lineNum:   l.LineNum,
        baseLine:  l.LineNum,
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
Use null for strings that cannot be determined. Use 0 for numeric fields that cannot be determined.`;

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
      if (extractedText && !fileBuffer) parts.push({ type: 'text', text: `Invoice text:\n${extractedText}` });
      parts.push({ type: 'text', text: 'Extract invoice data as JSON per instructions.' });
      return parts;
    }
  };

  let rawText = null;

  try {
    if (AI_PROVIDER === 'gpt' && USE_AI) {
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
    console.error('[GRPO-APINV] OCR AI error:', e.message);
  }

  if (rawText) {
    try {
      const jsonMatch = rawText.match(/\{[\s\S]*\}/);
      if (jsonMatch) return JSON.parse(jsonMatch[0]);
    } catch (e) { console.error('[GRPO-APINV] OCR JSON parse error:', e.message); }
  }

  // Fallback: basic regex extraction from text
  if (extractedText) return fallbackExtract(extractedText);
  return null;
}

function fallbackExtract(text) {
  const invNum = text.match(/(?:invoice|inv)[\s#:]*([A-Z0-9\-\/]+)/i)?.[1] || null;
  const total  = text.match(/(?:total|amount due|grand total)[\s:]*\$?([\d,]+\.?\d*)/i)?.[1];
  const lines  = [];
  // Attempt to extract tabular lines: number + description + qty + price
  const lineRe = /([A-Z0-9\-]+)\s+(.+?)\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)/g;
  let m;
  while ((m = lineRe.exec(text)) !== null) {
    lines.push({ lineNum: lines.length + 1, itemCode: m[1], description: m[2].trim(), qty: parseFloat(m[3]), unit: 'EA', unitPrice: parseFloat(m[4]), lineTotal: parseFloat(m[5]), taxRate: 0 });
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

  for (const gl of grpoDetail.lines) {
    // Find best matching OCR line
    let bestIdx = -1; let bestScore = 0;
    ocrLines.forEach((ol, idx) => {
      if (usedOCRIdx.has(idx)) return;
      let score = 0;
      if (ol.itemCode && gl.itemCode && ol.itemCode.toUpperCase() === gl.itemCode.toUpperCase()) score = 1;
      else score = similarity(ol.description, gl.itemName);
      if (score > bestScore) { bestScore = score; bestIdx = idx; }
    });

    if (bestIdx === -1 || bestScore < 0.4) {
      results.push({ grpoLine: gl, ocrLine: null, status: 'not_invoiced', priceVariance: 0, qtyVariance: 0 });
    } else {
      const ol = ocrLines[bestIdx];
      usedOCRIdx.add(bestIdx);
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

// ── AP Invoice print layout ────────────────────────────────────────────────────
function renderAPInvPrint(doc) {
  const company   = process.env.SAP_B1_COMPANY || process.env.SL_COMPANY || 'Company';
  const lines     = doc.DocumentLines || [];
  const docDate   = doc.DocDate ? doc.DocDate.slice(0, 10) : '—';
  const dueDate   = doc.DocDueDate ? doc.DocDueDate.slice(0, 10) : '—';
  const printedOn = new Date().toLocaleDateString('en-GB', { day:'2-digit', month:'short', year:'numeric' });
  const grandTotal = lines.reduce((s, l) => s + Number(l.LineTotal || 0), 0);
  const taxTotal   = lines.reduce((s, l) => s + Number(l.VatSum || 0), 0);

  const linesHtml = lines.map((l, i) => `
    <tr>
      <td>${i + 1}</td>
      <td><strong>${l.ItemCode || ''}</strong></td>
      <td>${l.ItemDescription || ''}</td>
      <td style="text-align:right">${Number(l.Quantity || 0).toFixed(2)}</td>
      <td>${l.UoMCode || l.MeasureUnit || ''}</td>
      <td style="text-align:right">${Number(l.UnitPrice || 0).toFixed(2)}</td>
      <td style="text-align:right">${Number(l.LineTotal || 0).toFixed(2)}</td>
      <td>${l.TaxCode || ''}</td>
    </tr>`).join('');

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<title>A/P Invoice #${doc.DocNum}</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:Arial,sans-serif;font-size:11px;color:#222;padding:28px 36px;max-width:980px;margin:auto}
  .print-btn{margin-bottom:16px;display:flex;gap:8px;justify-content:flex-end}
  .print-btn button{padding:8px 18px;border:none;border-radius:6px;cursor:pointer;font-size:13px;font-weight:600}
  .btn-print{background:#0f766e;color:#fff}.btn-close{background:#eee;color:#333}
  .header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:24px;padding-bottom:16px;border-bottom:3px solid #0f766e}
  .co-name{font-size:20px;font-weight:700;color:#1a1d27}
  .doc-title{font-size:18px;font-weight:700;color:#0f766e;text-align:right}
  .info-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-bottom:20px}
  .info-box{border:1px solid #ddd;border-radius:6px;padding:12px}
  .info-label{font-size:9px;font-weight:700;text-transform:uppercase;color:#888;letter-spacing:.06em;margin-bottom:6px}
  .info-val{font-size:12px;color:#222;margin-bottom:2px}
  table{width:100%;border-collapse:collapse;margin-bottom:16px}
  thead tr{background:#0f766e}
  th{padding:8px 10px;text-align:left;font-size:10px;font-weight:700;text-transform:uppercase;color:#fff}
  td{padding:7px 10px;border-bottom:1px solid #eee;font-size:11px}
  tr:nth-child(even) td{background:#f0fdf9}
  .totals{text-align:right;padding:8px 0 20px}
  .total-row{font-size:12px;color:#374151;margin-bottom:4px}
  .total-grand{font-size:15px;font-weight:700;color:#0f766e;margin-top:6px}
  .sig-section{display:grid;grid-template-columns:1fr 1fr 1fr;gap:32px;margin-top:48px}
  .sig-line{border-top:1px solid #333;margin-top:40px;padding-top:6px;font-size:9px;color:#888;text-transform:uppercase;letter-spacing:.04em;text-align:center}
  .footer{text-align:center;margin-top:24px;font-size:9px;color:#aaa;border-top:1px solid #eee;padding-top:12px}
  .watermark{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%) rotate(-30deg);font-size:60px;color:rgba(0,0,0,.04);font-weight:900;pointer-events:none;z-index:0}
  @media print{.print-btn{display:none}}
</style></head>
<body>
<div class="watermark">A/P INVOICE</div>
<div class="print-btn">
  <button class="btn-close" onclick="window.close()">✕ Close</button>
  <button class="btn-print" onclick="window.print()">🖨️ Print</button>
</div>
<div class="header">
  <div><div class="co-name">${company}</div><div style="color:#888;font-size:11px;margin-top:2px">SAP Business One — A/P Invoice</div></div>
  <div><div class="doc-title">A/P Invoice</div><div style="font-size:13px;color:#444;text-align:right">AP # ${doc.DocNum}</div></div>
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
    <div class="info-label">Supplier Invoice Ref</div>
    <div class="info-val"><strong>${doc.NumAtCard || '—'}</strong></div>
    <div class="info-val" style="color:#666">AP # ${doc.DocNum}</div>
  </div>
</div>
${doc.Comments ? `<div style="border:1px solid #ddd;border-radius:6px;padding:12px;margin-bottom:20px;background:#f0fdf9;font-size:11px;line-height:1.6"><strong>📝 Comments:</strong><br><br>${doc.Comments}</div>` : ''}
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
  ${taxTotal > 0 ? `<div class="total-row">Subtotal: ${(grandTotal - taxTotal).toLocaleString('en-US', { minimumFractionDigits:2, maximumFractionDigits:2 })}</div>` : ''}
  ${taxTotal > 0 ? `<div class="total-row">Tax: ${taxTotal.toLocaleString('en-US', { minimumFractionDigits:2, maximumFractionDigits:2 })}</div>` : ''}
  <div class="total-grand">Total: ${grandTotal.toLocaleString('en-US', { minimumFractionDigits:2, maximumFractionDigits:2 })}</div>
</div>
<div class="sig-section">
  <div><div class="sig-line">Prepared By</div></div>
  <div><div class="sig-line">Approved By</div></div>
  <div><div class="sig-line">Finance Manager</div></div>
</div>
<div class="footer">Printed on ${printedOn} &nbsp;|&nbsp; ${company} — SAP B1 A/P Invoice #${doc.DocNum} &nbsp;|&nbsp; Powered by Henny AI Solution</div>
</body></html>`;
}

// ── Router factory ─────────────────────────────────────────────────────────────
export function createGRPOtoAPInvAgentRouter(deps) {
  const { requireAuth, getActiveSap, gptChatComplete, azureMessagesCreate, AI_PROVIDER, USE_AI } = deps;
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
        } catch (e) { console.warn('[GRPO-APINV] pdf-parse error:', e.message); }
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
      console.error('[GRPO-APINV] upload error:', e);
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
            const od = session.ocrData;
            formData = {
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
              lines: session.matchResult
                .filter(r => r.grpoLine)
                .map(r => ({
                  baseLine:    r.grpoLine.baseLine,
                  itemCode:    r.grpoLine.itemCode,
                  itemName:    r.grpoLine.itemName,
                  grpoQty:     r.grpoLine.qty,
                  grpoPrice:   r.grpoLine.unitPrice,
                  recvQty:     r.grpoLine.qty,
                  invQty:      r.ocrLine?.qty  ?? r.grpoLine.qty,
                  invPrice:    r.ocrLine?.unitPrice ?? r.grpoLine.unitPrice,
                  unit:        r.grpoLine.unit,
                  warehouse:   r.grpoLine.warehouse,
                  taxCode:     r.grpoLine.taxCode,
                  status:      r.status,
                  priceVar:    r.priceVariance,
                })),
            };
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
                `[🖨️ Print A/P Invoice](/api/grpo-apinv/print/${result.DocEntry})\n\nWould you like to process another invoice?`;
              quickReplies = ['Yes, Process Another', 'No, Done'];
              meta = {
                docEntry:  result.DocEntry,
                docNum:    result.DocNum,
                printUrl:  `/api/grpo-apinv/print/${result.DocEntry}`,
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
          const od = session.ocrData;
          formData = {
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
            lines: session.matchResult
              .filter(r => r.grpoLine)
              .map(r => ({
                baseLine:  r.grpoLine.baseLine,
                itemCode:  r.grpoLine.itemCode,
                itemName:  r.grpoLine.itemName,
                grpoQty:   r.grpoLine.qty,
                grpoPrice: r.grpoLine.unitPrice,
                recvQty:   r.grpoLine.qty,
                invQty:    r.ocrLine?.qty  ?? r.grpoLine.qty,
                invPrice:  r.ocrLine?.unitPrice ?? r.grpoLine.unitPrice,
                unit:      r.grpoLine.unit,
                warehouse: r.grpoLine.warehouse,
                taxCode:   r.grpoLine.taxCode,
                status:    r.status,
                priceVar:  r.priceVariance,
              })),
          };
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
      console.error('[GRPO-APINV] chat error:', e);
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
      const doc = await sap.get(`/PurchaseInvoices(${parseInt(req.params.docEntry, 10)})`);
      res.setHeader('Content-Type', 'text/html');
      res.send(renderAPInvPrint(doc));
    } catch (e) {
      res.status(500).send(`<pre style="color:red">Error loading AP Invoice #${req.params.docEntry}: ${e.message}</pre>`);
    }
  });

  return router;
}
