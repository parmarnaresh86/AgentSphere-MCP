/**
 * Shared OCR / AI-vision extraction helpers used by the OCR Processing
 * workflow controllers (controllers/ocr-*-agent.mjs).
 *
 * Generalizes the OCR pipeline originally built in
 * controllers/grpo-to-apinv-agent.mjs (extractInvoiceOCR) so each workflow
 * can supply its own system prompt / JSON schema instead of duplicating the
 * pdf-parse + AI-vision plumbing.
 */
import { createRequire } from 'module';

const _require = createRequire(import.meta.url);
let pdfParse;
try { pdfParse = _require('pdf-parse'); } catch (e) { pdfParse = null; }

export async function extractPdfText(buffer) {
  if (!pdfParse) return null;
  try {
    const data = await pdfParse(buffer);
    if (data.text && data.text.trim().length > 50) return data.text.slice(0, 8000);
  } catch (e) { console.warn('[ocr-extract] pdf-parse error:', e.message); }
  return null;
}

// Word-overlap similarity, moved verbatim from grpo-to-apinv-agent.mjs
export function similarity(a, b) {
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

// Confidence (0..1) that a SAP BP is the vendor printed on the document.
// Exact code = 1; otherwise name similarity; a lone search hit with no name overlap = 0.5.
export function vendorMatchScore(bp, doc, lone = false) {
  if (!bp) return 0;
  const code = String(doc?.vendorCode || '').trim().toLowerCase();
  if (code && String(bp.CardCode || '').toLowerCase() === code) return 1;
  const s = nameSimilarity(bp.CardName, doc?.vendorName);
  return s > 0 ? s : (lone ? 0.5 : 0);
}

// Company-name similarity (0..1) that ignores punctuation, case and legal-suffix
// spelling ("HTC (ASIA) Limited" vs "HTC Asia Ltd" = 1).
const _SUFFIX = { ltd: 'limited', pvt: 'private', co: 'company', corp: 'corporation', inc: 'incorporated', intl: 'international', mfg: 'manufacturing', '&': 'and' };
export function nameTokens(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9&]+/g, ' ').trim().split(/\s+/)
    .filter(Boolean).map(w => _SUFFIX[w] || w);
}
export function nameSimilarity(a, b) {
  const ta = nameTokens(a), tb = nameTokens(b);
  if (!ta.length || !tb.length) return 0;
  if (ta.join(' ') === tb.join(' ')) return 1;
  const sb = new Set(tb);
  const common = ta.filter(w => sb.has(w)).length;
  return (2 * common) / (ta.length + tb.length);
}

// OData filter matching `text` in any of `fields`, tolerant of case (HANA contains() is
// case-sensitive): tries the text as typed, UPPER, lower and Capitalised. `text` must be escaped.
export function containsAnyCase(fields, text) {
  const t = String(text || '');
  const cap = t.replace(/\b([a-z])/g, c => c.toUpperCase());
  const vars = [...new Set([t, t.toUpperCase(), t.toLowerCase(), cap])];
  return '(' + fields.flatMap(f => vars.map(v => `contains(${f},'${v}')`)).join(' or ') + ')';
}

// Key words to search SAP with when the full name finds nothing. Service Layer
// contains() is case-sensitive on HANA, so each word comes in original/UPPER/Capitalised form.
const _NOISE = new Set(['limited', 'private', 'company', 'corporation', 'incorporated', 'llc', 'llp', 'gmbh', 'the', 'and', 'of', 'international']);
// Most distinctive words of a name/description (longest first, legal suffixes dropped).
export function keyWords(name, max = 3) {
  const seen = new Set();
  return String(name || '').split(/[^A-Za-z0-9&]+/)
    .filter(w => w.length >= 3 && !_NOISE.has(_SUFFIX[w.toLowerCase()] || w.toLowerCase()))
    .filter(w => !seen.has(w.toLowerCase()) && seen.add(w.toLowerCase()))
    .sort((x, y) => y.length - x.length).slice(0, max);
}
export function vendorSearchWords(name) {
  const words = keyWords(name, 3);
  const out = [];
  words.forEach(w => [w, w.toUpperCase(), w[0].toUpperCase() + w.slice(1).toLowerCase()].forEach(v => { if (!out.includes(v)) out.push(v); }));
  return out;
}

function buildUserContent(isOpenAIFormat, fileBuffer, mimeType, extractedText, instructionText) {
  if (isOpenAIFormat) {
    const parts = [];
    if (fileBuffer && mimeType?.startsWith('image/')) {
      parts.push({ type: 'image_url', image_url: { url: `data:${mimeType};base64,${fileBuffer.toString('base64')}` } });
    }
    if (extractedText) parts.push({ type: 'text', text: `Document text:\n${extractedText}` });
    parts.push({ type: 'text', text: instructionText });
    return parts;
  }
  const parts = [];
  if (fileBuffer && mimeType?.startsWith('image/')) {
    parts.push({ type: 'image', source: { type: 'base64', media_type: mimeType, data: fileBuffer.toString('base64') } });
  } else if (fileBuffer && mimeType === 'application/pdf') {
    parts.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: fileBuffer.toString('base64') } });
  }
  if (extractedText && !fileBuffer) parts.push({ type: 'text', text: `Document text:\n${extractedText}` });
  parts.push({ type: 'text', text: instructionText });
  return parts;
}

/**
 * Run AI-vision/text extraction against a document, returning parsed JSON
 * per the caller-supplied systemPrompt's schema (or null on failure).
 *
 * @param {Buffer} fileBuffer
 * @param {string} mimeType
 * @param {string|null} extractedText - pre-extracted PDF text, if any
 * @param {object} aiDeps - { AI_PROVIDER, gptChatComplete, azureMessagesCreate, USE_AI }
 * @param {string} systemPrompt - schema/instructions for this doc type
 * @param {function|null} fallbackExtract - optional regex fallback(text) => object
 */
export async function runVisionExtraction(fileBuffer, mimeType, extractedText, aiDeps, systemPrompt, fallbackExtract) {
  const { AI_PROVIDER, gptChatComplete, azureMessagesCreate, USE_AI } = aiDeps || {};
  const instructionText = 'Extract the document data as JSON per instructions.';
  let rawText = null;

  try {
    if (AI_PROVIDER === 'gpt' && USE_AI) {
      const r = await gptChatComplete({
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: buildUserContent(true, fileBuffer, mimeType, extractedText, instructionText) },
        ],
        max_tokens: 2000,
      });
      rawText = r?.choices?.[0]?.message?.content || null;
    } else if (AI_PROVIDER === 'azure' && USE_AI) {
      const r = await azureMessagesCreate({
        model: process.env.AZURE_CLAUDE_MODEL || 'claude-sonnet-4-6',
        system: systemPrompt,
        messages: [{ role: 'user', content: buildUserContent(false, fileBuffer, mimeType, extractedText, instructionText) }],
        max_tokens: 2000,
      });
      rawText = r?.content?.[0]?.text || r?.choices?.[0]?.message?.content || null;
    } else if (process.env.ANTHROPIC_API_KEY) {
      const { default: Anthropic } = await import('@anthropic-ai/sdk');
      const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      const resp = await client.messages.create({
        model: 'claude-sonnet-4-6', max_tokens: 2000,
        system: systemPrompt,
        messages: [{ role: 'user', content: buildUserContent(false, fileBuffer, mimeType, extractedText, instructionText) }],
      });
      rawText = resp.content?.[0]?.text || null;
    }
  } catch (e) {
    console.error('[ocr-extract] vision AI error:', e.message);
  }

  if (rawText) {
    try {
      const jsonMatch = rawText.match(/\{[\s\S]*\}/);
      if (jsonMatch) return JSON.parse(jsonMatch[0]);
    } catch (e) { console.error('[ocr-extract] JSON parse error:', e.message); }
  }

  if (extractedText && typeof fallbackExtract === 'function') return fallbackExtract(extractedText);
  return null;
}

export function escHtml(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
export function fmtN(n, d = 2) {
  if (n == null || isNaN(Number(n))) return '—';
  return Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}
export function today() { return new Date().toISOString().slice(0, 10); }
export function sapDate(s) { const d = s || today(); return d.length === 10 ? `${d}T00:00:00` : d; }
export function datePlusDays(n) { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); }
