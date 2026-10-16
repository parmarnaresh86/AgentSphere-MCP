/**
 * AP Invoice Processing (APIP) — backend for the "AP Invoice Processing" menu.
 * Contract: docs/apip-spec.md. Mounted at /api/apip.
 *
 *  Intake (folder / mail / upload) → queue → OCR (lib/ocr-extract.mjs) → SAP master mapping
 *  (lib/ocr-sap-match.mjs + cacheRepo + learned mappings) → approval workflow (templates /
 *  stages) → post SAP A/P Invoice (/PurchaseInvoices or /Drafts).
 *
 * Exports:
 *   createApipRouter(deps)  — Express router
 *   startApipIntake(deps)   — call once at startup: starts folder watcher + mail pollers per saved settings
 * deps: { requireAuth, printAuth, getActiveSap, gptChatComplete, azureMessagesCreate, AI_PROVIDER, USE_AI,
 *         cacheRepo, getActiveCompanyId, db }
 */
import express, { Router } from 'express';
import multer from 'multer';
import fs from 'node:fs';
import { extractPdfText, runVisionExtraction, similarity, nameSimilarity, keyWords, containsAnyCase, today, sapDate } from '../lib/ocr-extract.mjs';
import { matchPartner, matchItem, searchPartners, searchItems, getWarehouses } from '../lib/ocr-sap-match.mjs';
import { getTaxCodes as cdfGetTaxCodes, fetchAllPages } from '../lib/copy-doc-flow.mjs';
import {
  settingsRepo, queueRepo, actionRepo, mailRepo, templateRepo, mappingRepo, toQueueRow, normalizeTemplate,
  listPrincipals, roleIdByName, apipLog, getLogs,
} from '../lib/apip-store.mjs';
import {
  configureIntake, applyIntakeSettings, startIntake, stopIntake, scanNow, getIntakeStatus, finalizeFolderOriginal,
  validateFolders, resolveFolders, testMailbox,
} from '../lib/apip-intake.mjs';

const _upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: 50 } });

// ── Shared context (set by createApipRouter / startApipIntake) ────────────────
const _ctx = {
  getActiveSap: () => null, cacheRepo: null, getActiveCompanyId: () => 'default',
  aiDeps: { AI_PROVIDER: undefined, gptChatComplete: null, azureMessagesCreate: null, USE_AI: false },
};
function setCtx(deps = {}) {
  if (deps.getActiveSap) _ctx.getActiveSap = deps.getActiveSap;
  if (deps.cacheRepo) _ctx.cacheRepo = deps.cacheRepo;
  if (deps.getActiveCompanyId) _ctx.getActiveCompanyId = deps.getActiveCompanyId;
  if ('AI_PROVIDER' in deps || 'USE_AI' in deps || deps.gptChatComplete || deps.azureMessagesCreate) {
    _ctx.aiDeps = {
      AI_PROVIDER: deps.AI_PROVIDER ?? _ctx.aiDeps.AI_PROVIDER,
      gptChatComplete: deps.gptChatComplete ?? _ctx.aiDeps.gptChatComplete,
      azureMessagesCreate: deps.azureMessagesCreate ?? _ctx.aiDeps.azureMessagesCreate,
      USE_AI: deps.USE_AI ?? _ctx.aiDeps.USE_AI,
    };
  }
  configureIntake({ onEnqueued, getCompanyId: companyId });
}
const companyId = () => { try { return _ctx.getActiveCompanyId() || 'default'; } catch { return 'default'; } };
const currentSap = () => { try { return _ctx.getActiveSap(); } catch { return null; } };

// ── Small helpers ─────────────────────────────────────────────────────────────
const q = s => String(s ?? '').replace(/'/g, "''");
const num = v => { if (v == null || v === '') return 0; const n = Number(String(v).replace(/[^0-9.\-]/g, '')); return Number.isFinite(n) ? n : 0; };
const round2 = n => Math.round((Number(n) || 0) * 100) / 100;
const nowIso = () => new Date().toISOString();
const userIdOf = u => String(u?.user_id ?? u?.id ?? '');
const userNameOf = u => u?.full_name || u?.username || u?.name || '';
function withTimeout(p, ms, label = 'operation') {
  let t;
  return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${label} timed out`)), ms); })]).finally(() => clearTimeout(t));
}
function fail(res, status, error) { return res.status(status).json({ ok: false, error: String(error?.message || error || 'Error') }); }
const wrap = fn => async (req, res) => {
  try { await fn(req, res); }
  catch (e) {
    apipLog('ERROR', `${req.method} ${req.originalUrl}: ${e.message}`);
    if (!res.headersSent) fail(res, e.status || 500, e);
  }
};
const httpErr = (status, msg) => Object.assign(new Error(msg), { status });

// A stand-in client used when SAP is unreachable — every call fails fast.
const OFFLINE_SAP = { get: async () => { throw new Error('SAP offline'); }, post: async () => { throw new Error('SAP offline'); } };

// Is the SAP Service Layer reachable right now? (single cheap call, 8 s cap)
async function probeSap(sap) {
  if (!sap || typeof sap.get !== 'function') return false;
  try { if ('baseUrl' in sap && !sap.baseUrl) return false; } catch { /* getter error */ }
  try { await withTimeout(sap.get('/BusinessPartners', { $top: 1, $select: 'CardCode' }), 8000, 'SAP probe'); return true; }
  catch { return false; }
}

function normDate(s) {
  if (!s) return '';
  const v = String(s).trim();
  let m = v.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = v.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})$/);                    // dd/mm/yyyy (day first)
  if (m) { const y = m[3].length === 2 ? `20${m[3]}` : m[3]; return `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`; }
  const d = new Date(v);
  return isNaN(d) ? '' : d.toISOString().slice(0, 10);
}

// ── OCR ───────────────────────────────────────────────────────────────────────
const APIP_OCR_SYSTEM = `You are an expert OCR system for supplier (accounts payable) invoices.
Return ONLY valid JSON (no markdown, no explanation) with exactly this structure:
{
  "vendorName": "string or null — the SUPPLIER issuing the invoice (not the buyer / bill-to)",
  "vendorGstin": "string or null — supplier GSTIN / VAT / tax registration number",
  "vendorCode": "string or null — supplier code if printed",
  "invoiceNo": "string or null",
  "invoiceDate": "YYYY-MM-DD or null",
  "dueDate": "YYYY-MM-DD or null",
  "poNumber": "string or null — buyer's purchase order number referenced on the invoice",
  "currency": "ISO code e.g. INR, USD, GBP, or null",
  "subtotal": 0,
  "taxTotal": 0,
  "total": 0,
  "lines": [
    { "description": "string", "itemCode": "string or null", "hsn": "string or null", "qty": 0, "uom": "string or null",
      "unitPrice": 0, "discountPct": 0, "taxPct": 0, "taxAmount": 0, "lineTotal": 0 }
  ]
}
"lines" must contain ONLY the item/service rows printed in the invoice's line table, once each, in printed order.
lineTotal is the line amount BEFORE tax. taxPct is the combined tax rate of the line (e.g. CGST 9 + SGST 9 = 18).
Never invent lines. Do not include subtotal, tax, freight, discount, rounding, total, bank or address rows as lines.
Use null for strings that cannot be determined and 0 for numbers that cannot be determined.`;

// Regex fallback when no AI is configured — header fields only.
function fallbackExtract(text) {
  const t = String(text || '');
  const pick = re => { const m = t.match(re); return m ? m[1].trim() : null; };
  const amount = re => { const m = t.match(re); return m ? num(m[1]) : 0; };
  const firstLine = t.split(/\r?\n/).map(s => s.trim()).find(s => s.length > 3) || null;
  return {
    vendorName: firstLine,
    vendorGstin: pick(/\b(\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z])\b/),
    vendorCode: null,
    invoiceNo: pick(/invoice\s*(?:no\.?|number|#)\s*[:\-]?\s*([A-Za-z0-9\/\-]+)/i),
    invoiceDate: normDate(pick(/(?:invoice\s*)?date\s*[:\-]?\s*([0-9]{1,4}[./-][0-9]{1,2}[./-][0-9]{1,4})/i)) || null,
    dueDate: normDate(pick(/due\s*date\s*[:\-]?\s*([0-9]{1,4}[./-][0-9]{1,2}[./-][0-9]{1,4})/i)) || null,
    poNumber: pick(/(?:p\.?o\.?|purchase\s*order)\s*(?:no\.?|number|#)?\s*[:\-]?\s*([A-Za-z0-9\/\-]{3,})/i),
    currency: pick(/\b(INR|USD|EUR|GBP|AED|SGD|AUD|CAD)\b/),
    subtotal: amount(/sub\s*-?\s*total\s*[:\-]?\s*[^\d]{0,5}([\d,]+\.?\d*)/i),
    taxTotal: amount(/(?:total\s*tax|tax\s*total|gst\s*total|vat)\s*[:\-]?\s*[^\d]{0,5}([\d,]+\.?\d*)/i),
    total: amount(/(?:grand\s*total|total\s*amount|amount\s*due|invoice\s*total)\s*[:\-]?\s*[^\d]{0,5}([\d,]+\.?\d*)/i),
    lines: [],
    _fallback: true,
  };
}

function normalizeExtracted(raw = {}) {
  const r = raw || {};
  const lines = (Array.isArray(r.lines) ? r.lines : []).map(l => {
    const qty = num(l.qty ?? l.quantity) || 0;
    const unitPrice = num(l.unitPrice ?? l.price ?? l.rate);
    const lineTotal = num(l.lineTotal ?? l.amount);
    const discountPct = num(l.discountPct ?? l.discount);
    let taxPct = num(l.taxPct ?? l.taxRate);
    const taxAmount = num(l.taxAmount);
    if (!taxPct && taxAmount && lineTotal) taxPct = round2(taxAmount / lineTotal * 100);
    return {
      description: String(l.description || l.itemName || '').trim(),
      itemCode: l.itemCode ? String(l.itemCode).trim() : null,
      hsn: l.hsn ? String(l.hsn).trim() : null,
      qty: qty || (lineTotal && unitPrice ? round2(lineTotal / unitPrice) : (lineTotal ? 1 : 0)),
      uom: l.uom || l.unit || null,
      unitPrice: unitPrice || (qty && lineTotal ? round2(lineTotal / qty) : lineTotal),
      discountPct, taxPct, taxAmount, lineTotal,
    };
  }).filter(l => l.description || l.itemCode || l.lineTotal);
  return {
    vendorName: r.vendorName || null,
    vendorGstin: r.vendorGstin || r.gstin || null,
    vendorCode: r.vendorCode || null,
    invoiceNo: (r.invoiceNo ?? r.invoiceNumber) ? String(r.invoiceNo ?? r.invoiceNumber).trim() : null,
    invoiceDate: normDate(r.invoiceDate) || null,
    dueDate: normDate(r.dueDate) || null,
    poNumber: r.poNumber ? String(r.poNumber).trim() : null,
    currency: r.currency ? String(r.currency).trim().toUpperCase().slice(0, 3) : null,
    subtotal: num(r.subtotal),
    taxTotal: num(r.taxTotal),
    total: num(r.total ?? r.grandTotal),
    lines,
    ...(r._fallback ? { _fallback: true } : {}),
  };
}

async function runOcr(buffer, settings) {
  const ai = _ctx.aiDeps;
  const text = await extractPdfText(buffer);
  const hasAnthropic = !!process.env.ANTHROPIC_API_KEY;
  const aiAvailable = !!ai.USE_AI || hasAnthropic;
  if (settings.ocrEngine === 'text') {
    if (!text) throw new Error('PDF has no text layer — switch the OCR engine to "ai" for scanned invoices.');
    const raw = aiAvailable ? await runVisionExtraction(null, 'application/pdf', text, ai, APIP_OCR_SYSTEM, fallbackExtract) : fallbackExtract(text);
    return { raw, text };
  }
  if (ai.AI_PROVIDER === 'gpt' && ai.USE_AI && !text && !hasAnthropic) {
    throw new Error('Scanned PDF has no text layer and the GPT engine cannot read PDF images.');
  }
  if (!aiAvailable) {
    if (!text) throw new Error('No AI engine configured and the PDF has no text layer.');
    return { raw: fallbackExtract(text), text };
  }
  // GPT path can't read the PDF itself; fall back to the Anthropic SDK path when only that can.
  const deps = (ai.AI_PROVIDER === 'gpt' && !text && hasAnthropic) ? { ...ai, USE_AI: false } : ai;
  let raw = await runVisionExtraction(buffer, 'application/pdf', text, deps, APIP_OCR_SYSTEM, fallbackExtract);
  // Azure Anthropic failed (e.g. wrong AZURE_CLAUDE_MODEL deployment) → retry once on GPT from the text layer.
  if (deps.AI_PROVIDER === 'azure' && (!raw || raw._fallback) && text && ai.gptChatComplete && process.env.AZURE_GPT_ENDPOINT) {
    apipLog('WARN', 'Azure Anthropic extraction failed — retrying with GPT on the PDF text layer.');
    const viaGpt = await runVisionExtraction(null, 'application/pdf', text, { ...ai, AI_PROVIDER: 'gpt', USE_AI: true }, APIP_OCR_SYSTEM, fallbackExtract);
    if (viaGpt) raw = viaGpt;
  }
  return { raw, text };
}

// ── Master data helpers (cache first, SAP when online) ────────────────────────
async function loadTaxCodes(sap, online) {
  const cid = companyId();
  let rows = _ctx.cacheRepo?.getTaxCodes ? _ctx.cacheRepo.getTaxCodes(cid) : [];
  if (!rows.length && online) { try { rows = await withTimeout(cdfGetTaxCodes(sap), 20000, 'tax codes'); } catch { rows = []; } }
  return (rows || []).map(t => ({ code: t.Code, name: t.Name || '', rate: Number(t.Rate) || 0 }));
}

function cacheVendorCandidates(name) {
  const repo = _ctx.cacheRepo;
  if (!repo?.searchBPs || !name) return [];
  const seen = new Map();
  const tryQ = s => { try { (repo.searchBPs(companyId(), s, 'cSupplier', 30) || []).forEach(b => seen.set(b.CardCode, b)); } catch { /* ignore */ } };
  tryQ(name);
  if (!seen.size) keyWords(name, 3).forEach(tryQ);
  return [...seen.values()].map(b => ({ code: b.CardCode, name: b.CardName, currency: b.Currency || null }));
}

function cacheItemCandidates(text) {
  const repo = _ctx.cacheRepo;
  if (!repo?.searchItems || !text) return [];
  const seen = new Map();
  const tryQ = s => { try { (repo.searchItems(companyId(), s, 30) || []).forEach(i => seen.set(i.ItemCode, i)); } catch { /* ignore */ } };
  tryQ(text);
  if (!seen.size) keyWords(text, 3).forEach(tryQ);
  return [...seen.values()].map(i => ({ code: i.ItemCode, name: i.ItemName, unit: i.InventoryUoM || i.PurchaseUnit || '' }));
}

function bestByName(cands, text, min = 0.5) {
  let best = null, bestScore = 0;
  for (const c of cands) {
    const s = Math.max(nameSimilarity(c.name, text), similarity(c.name, text));
    if (s > bestScore) { bestScore = s; best = c; }
  }
  return best && bestScore >= min ? { ...best, score: round2(bestScore) } : null;
}

async function lookupVendorName(sap, online, cardCode) {
  try {
    const hit = (_ctx.cacheRepo?.searchBPs?.(companyId(), cardCode, 'cSupplier', 5) || []).find(b => b.CardCode === cardCode);
    if (hit) return { name: hit.CardName, currency: hit.Currency || null };
  } catch { /* ignore */ }
  if (online) {
    try { const bp = await sap.get(`/BusinessPartners('${q(cardCode)}')`, { $select: 'CardCode,CardName,Currency' }); return { name: bp.CardName, currency: bp.Currency || null }; } catch { /* ignore */ }
  }
  return null;
}

// Open POs / GRPOs for a vendor, with open lines (incl. price) for base-document linking.
async function fetchOpenDocs(sap, cardCode) {
  if (!cardCode) return { pos: [], grpos: [] };
  const shape = d => ({
    docEntry: d.DocEntry, docNum: d.DocNum, docDate: String(d.DocDate || '').slice(0, 10), dueDate: String(d.DocDueDate || '').slice(0, 10),
    numAtCard: d.NumAtCard || '', docTotal: Number(d.DocTotal || 0), currency: d.DocCurrency || '', docType: d.DocType || 'dDocument_Items',
    lines: (d.DocumentLines || []).filter(l => l.LineStatus !== 'bost_Close').map(l => ({
      lineNum: l.LineNum, itemCode: l.ItemCode || '', description: l.ItemDescription || '',
      openQty: Number(l.RemainingOpenQuantity ?? l.Quantity ?? 0), quantity: Number(l.Quantity || 0),
      price: Number(l.UnitPrice ?? l.Price ?? 0), discountPct: Number(l.DiscountPercent || 0),
      uom: l.UoMCode || l.MeasureUnit || '', warehouse: l.WarehouseCode || '', taxCode: l.TaxCode || l.VatGroup || '',
      accountCode: l.AccountCode || '', lineTotal: Number(l.LineTotal || 0),
      baseType: l.BaseType != null ? Number(l.BaseType) : null, baseEntry: l.BaseEntry ?? null, baseLine: l.BaseLine ?? null,
    })),
  });
  const params = {
    $select: 'DocEntry,DocNum,DocDate,DocDueDate,NumAtCard,DocTotal,DocCurrency,DocType,DocumentLines',
    $filter: `CardCode eq '${q(cardCode)}' and DocumentStatus eq 'bost_Open' and Cancelled eq 'tNO'`,
    $orderby: 'DocDate desc', $top: 30,
  };
  const get = async ep => { try { const r = await withTimeout(sap.get(ep, params), 25000, ep); return (Array.isArray(r.value) ? r.value : []).map(shape); } catch (e) { apipLog('WARN', `open docs ${ep}: ${e.message}`); return []; } };
  const [pos, grpos] = await Promise.all([get('/PurchaseOrders'), get('/PurchaseDeliveryNotes')]);
  return { pos, grpos };
}

// ── Totals ────────────────────────────────────────────────────────────────────
function computeTotals(mapped, taxCodes = []) {
  const rate = new Map(taxCodes.map(t => [String(t.code), Number(t.rate) || 0]));
  const hd = Math.min(100, Math.max(0, num(mapped.DiscountPercent))) / 100;
  let before = 0, tax = 0;
  for (const l of mapped.lines || []) {
    const net = num(l.Quantity) * num(l.UnitPrice) * (1 - Math.min(100, Math.max(0, num(l.DiscountPercent))) / 100);
    l.LineTotal = round2(net);
    before += net;
    const r = l.TaxCode && rate.has(String(l.TaxCode)) ? rate.get(String(l.TaxCode)) : num(l.taxPct);
    tax += net * (1 - hd) * r / 100;
  }
  const discount = before * hd;
  mapped.totals = { beforeDiscount: round2(before), discount: round2(discount), tax: round2(tax), total: round2(before - discount + tax) };
  return mapped.totals;
}

function pickTaxCode(taxCodes, pct, settings) {
  const def = settings.defaultTaxCode ? taxCodes.find(t => t.code === settings.defaultTaxCode) : null;
  if (!pct) return settings.defaultTaxCode || '';
  if (def && Math.abs(def.rate - pct) < 0.01) return def.code;
  const hit = taxCodes.find(t => Math.abs(t.rate - pct) < 0.01);
  return hit ? hit.code : (settings.defaultTaxCode || '');
}

// ── Mapping: OCR → SAP-shaped A/P invoice draft ───────────────────────────────
async function buildMapped(ext, settings, row, sapIn) {
  const cid = companyId();
  const online = await probeSap(sapIn);
  const sap = online ? sapIn : OFFLINE_SAP;
  const warnings = [];
  if (!online) warnings.push('SAP is not reachable — vendor/item matching used cached master data only. Re-run mapping or review before posting.');

  // Vendor
  let CardCode = '', CardName = '', bpCurrency = null, vendorScore = 0;
  const memV = mappingRepo.find(cid, 'vendor', ext.vendorName) || (ext.vendorGstin ? mappingRepo.find(cid, 'vendor', `gstin ${ext.vendorGstin}`) : null);
  if (memV) {
    CardCode = memV.target; CardName = memV.target_name || ''; vendorScore = 1;
    const info = await lookupVendorName(sap, online, CardCode);
    if (info) { CardName = info.name || CardName; bpCurrency = info.currency; }
  } else if (ext.vendorName || ext.vendorCode) {
    let hit = null;
    if (online) {
      try {
        const m = await withTimeout(matchPartner(sap, { name: ext.vendorName, code: ext.vendorCode }, 'cSupplier'), 45000, 'vendor match');
        if (m.partner) hit = { ...m.partner, score: m.score };
      } catch (e) { warnings.push(`Vendor lookup failed: ${e.message}`); }
    }
    if (!hit) hit = bestByName(cacheVendorCandidates(ext.vendorName || ext.vendorCode), ext.vendorName || ext.vendorCode);
    if (hit) { CardCode = hit.code; CardName = hit.name; bpCurrency = hit.currency || null; vendorScore = round2(hit.score ?? 0.5); }
  }
  if (!CardCode) warnings.push(`Vendor "${ext.vendorName || ext.vendorCode || '?'}" was not matched to an SAP supplier — select it manually.`);
  else if (vendorScore < 0.8) warnings.push(`Vendor matched with low confidence (${Math.round(vendorScore * 100)}%) — please verify ${CardCode}.`);

  const taxCodes = await loadTaxCodes(sap, online);
  let warehouses = [];
  try { warehouses = await withTimeout(getWarehouses(sap, _ctx.cacheRepo, cid), 20000, 'warehouses'); } catch { warehouses = []; }
  const defaultWhs = settings.defaultWarehouse || warehouses[0]?.code || '';

  // Lines
  const lines = [];
  for (const l of ext.lines) {
    const desc = l.description || l.itemCode || '';
    let ItemCode = '', ItemDescription = desc, UoMCode = '', matchScore = 0, AccountCode = '';
    const memI = mappingRepo.find(cid, 'item', desc);
    const memG = mappingRepo.find(cid, 'gl', desc);
    if (memI) { ItemCode = memI.target; ItemDescription = memI.target_name || desc; matchScore = 1; }
    else if (online) {
      try {
        const m = await withTimeout(matchItem(sap, { itemCode: l.itemCode, description: desc }), 30000, 'item match');
        if (m) { ItemCode = m.code; ItemDescription = m.name || desc; UoMCode = m.unit || ''; matchScore = round2(m.score); }
      } catch { /* leave unmatched */ }
    }
    if (!ItemCode && !online) {
      const c = bestByName(cacheItemCandidates(desc), desc, 0.4);
      if (c) { ItemCode = c.code; ItemDescription = c.name || desc; UoMCode = c.unit || ''; matchScore = c.score; }
    }
    if (memG) AccountCode = memG.target;
    else if (settings.defaultGlAccount) AccountCode = settings.defaultGlAccount;
    lines.push({
      ItemCode, ItemDescription: String(ItemDescription).slice(0, 100), AccountCode,
      Quantity: num(l.qty) || 1, UnitPrice: num(l.unitPrice), DiscountPercent: num(l.discountPct),
      TaxCode: pickTaxCode(taxCodes, num(l.taxPct), settings), WarehouseCode: defaultWhs, UoMCode,
      BaseType: null, BaseEntry: null, BaseLine: null,
      ocrDescription: desc, matchScore,
      // additions
      taxPct: num(l.taxPct), hsn: l.hsn || '', ocrLineTotal: num(l.lineTotal),
    });
  }
  // Header-only invoice (no line table read) → one service line for the net amount
  if (!lines.length && (ext.subtotal || ext.total)) {
    const net = ext.subtotal || Math.max(0, ext.total - ext.taxTotal);
    const pct = net && ext.taxTotal ? round2(ext.taxTotal / net * 100) : 0;
    lines.push({
      ItemCode: '', ItemDescription: 'Invoice amount', AccountCode: settings.defaultGlAccount || '', Quantity: 1, UnitPrice: round2(net),
      DiscountPercent: 0, TaxCode: pickTaxCode(taxCodes, pct, settings), WarehouseCode: defaultWhs, UoMCode: '',
      BaseType: null, BaseEntry: null, BaseLine: null, ocrDescription: 'Invoice amount', matchScore: 0, taxPct: pct, hsn: '', ocrLineTotal: round2(net),
    });
    warnings.push('No line table was extracted — a single line for the invoice net amount was created.');
  }

  // Doc type
  let DocType = settings.defaultDocType === 'dDocument_Service' ? 'dDocument_Service' : 'dDocument_Items';
  if (DocType === 'dDocument_Items' && lines.length && !lines.some(l => l.ItemCode) && lines.every(l => l.AccountCode)) {
    DocType = 'dDocument_Service';
    warnings.push('No line matched an SAP item — switched to a service invoice using the G/L account(s).');
  }

  // Base-document linking (PO / GRPO)
  let BaseType = null, BaseEntry = null;
  if (online && CardCode) {
    const docs = await fetchOpenDocs(sap, CardCode);
    const poNo = String(ext.poNumber || '').replace(/\D/g, '');
    const po = poNo ? docs.pos.find(p => String(p.docNum) === poNo) : null;
    let grpos = po ? docs.grpos.filter(g => g.lines.some(l => l.baseType === 22 && Number(l.baseEntry) === Number(po.docEntry))) : [];
    if (!po && ext.invoiceNo) grpos = docs.grpos.filter(g => g.numAtCard && g.numAtCard.trim().toLowerCase() === String(ext.invoiceNo).trim().toLowerCase());
    const baseDocs = grpos.length ? grpos.map(d => ({ ...d, type: 20 })) : (po ? [{ ...po, type: 22 }] : []);
    if (baseDocs.length) {
      const pool = baseDocs.flatMap(d => d.lines.map(l => ({ ...l, docType: d.docType, type: d.type, docEntry: d.docEntry, docNum: d.docNum, left: l.openQty })));
      let linked = 0;
      for (const l of lines) {
        let cand = l.ItemCode ? pool.find(p => p.left > 0 && p.itemCode === l.ItemCode) : null;
        if (!cand) {
          let best = null, bs = 0;
          for (const p of pool) {
            if (p.left <= 0) continue;
            const s = Math.max(similarity(p.description, l.ocrDescription), nameSimilarity(p.description, l.ocrDescription));
            if (s > bs) { bs = s; best = p; }
          }
          if (best && bs >= 0.5) cand = best;
        }
        if (!cand) continue;
        linked++;
        cand.left -= l.Quantity;
        l.BaseType = cand.type; l.BaseEntry = cand.docEntry; l.BaseLine = cand.lineNum;
        if (!l.ItemCode && cand.itemCode) { l.ItemCode = cand.itemCode; l.ItemDescription = cand.description || l.ItemDescription; }
        if (cand.accountCode && !l.AccountCode) l.AccountCode = cand.accountCode;
        if (cand.warehouse) l.WarehouseCode = cand.warehouse;
        if (!l.TaxCode && cand.taxCode) l.TaxCode = cand.taxCode;
        if (cand.uom && !l.UoMCode) l.UoMCode = cand.uom;
        if (l.Quantity > cand.openQty + 1e-6) warnings.push(`Line "${l.ocrDescription}": invoiced qty ${l.Quantity} exceeds open qty ${cand.openQty} on ${cand.type === 20 ? 'GRPO' : 'PO'} ${cand.docNum}.`);
        if (cand.price > 0 && settings.priceTolerancePct >= 0) {
          const dev = Math.abs(l.UnitPrice - cand.price) / cand.price * 100;
          if (dev > settings.priceTolerancePct) warnings.push(`Line "${l.ocrDescription}": price ${l.UnitPrice} deviates ${round2(dev)}% from ${cand.type === 20 ? 'GRPO' : 'PO'} price ${cand.price} (tolerance ${settings.priceTolerancePct}%).`);
        }
      }
      if (linked) {
        BaseType = baseDocs[0].type; BaseEntry = baseDocs[0].docEntry;
        if (baseDocs[0].docType === 'dDocument_Service') DocType = 'dDocument_Service';
      } else warnings.push(`${baseDocs[0].type === 20 ? 'GRPO' : 'PO'} ${baseDocs[0].docNum} found but no invoice line could be linked to it.`);
    } else if (ext.poNumber) warnings.push(`PO "${ext.poNumber}" printed on the invoice is not an open purchase order for ${CardCode}.`);
  }

  // Line-level warnings
  lines.forEach((l, i) => {
    if (DocType === 'dDocument_Items' && !l.ItemCode && l.BaseEntry == null) warnings.push(`Line ${i + 1} "${l.ocrDescription}": no SAP item matched.`);
    if (DocType === 'dDocument_Service' && !l.AccountCode && l.BaseEntry == null) warnings.push(`Line ${i + 1} "${l.ocrDescription}": no G/L account.`);
    if (!l.TaxCode && l.taxPct) warnings.push(`Line ${i + 1}: no SAP tax code with rate ${l.taxPct}%.`);
  });

  let DocCurrency = ext.currency || (bpCurrency && bpCurrency !== '##' ? bpCurrency : '');
  if (ext.currency && bpCurrency && bpCurrency !== '##' && bpCurrency !== ext.currency) warnings.push(`Invoice currency ${ext.currency} differs from the vendor's SAP currency ${bpCurrency}.`);

  const mapped = {
    CardCode, CardName, NumAtCard: ext.invoiceNo || '',
    DocDate: ext.invoiceDate || today(), DocDueDate: ext.dueDate || '', TaxDate: ext.invoiceDate || today(),
    DocCurrency, Series: settings.defaultSeries ? (Number(settings.defaultSeries) || settings.defaultSeries) : null,
    Comments: `APIP #${row.id} — ${row.file_name}`.slice(0, 254),
    DocType, BaseType, BaseEntry, DiscountPercent: 0,
    lines,
    totals: { beforeDiscount: 0, discount: 0, tax: 0, total: 0 },
    warnings: [],
    // additions
    extraFields: {},
    vendorScore, sapOnline: online,
  };
  computeTotals(mapped, taxCodes);
  if (ext.total && Math.abs(mapped.totals.total - ext.total) > (Number(settings.totalTolerance) || 0)) {
    warnings.push(`Mapped total ${mapped.totals.total} differs from the invoice total ${ext.total} (tolerance ${settings.totalTolerance}).`);
  }
  mapped.warnings = [...new Set(warnings)];
  return mapped;
}

// ── Duplicate check ───────────────────────────────────────────────────────────
async function findDuplicateInvoice(sap, online, cardCode, invoiceNo, exceptId) {
  if (!cardCode || !invoiceNo) return null;
  const local = queueRepo.findPostedDuplicate(cardCode, invoiceNo, exceptId);
  if (local) return { where: 'queue', id: local.id, docNum: local.sap_doc_num };
  if (online) {
    try {
      const r = await withTimeout(sap.get('/PurchaseInvoices', {
        $select: 'DocEntry,DocNum', $filter: `CardCode eq '${q(cardCode)}' and NumAtCard eq '${q(invoiceNo)}' and Cancelled eq 'tNO'`, $top: 1,
      }), 15000, 'duplicate check');
      const d = r?.value?.[0];
      if (d) return { where: 'sap', docEntry: d.DocEntry, docNum: d.DocNum };
    } catch { /* treat as no duplicate */ }
  }
  return null;
}

// ── Sequential processing worker ──────────────────────────────────────────────
const _jobs = [];
const _pending = new Map();   // id → promise
let _workerRunning = false;

function enqueueProcess(id, sap = null) {
  id = Number(id);
  if (_pending.has(id)) return _pending.get(id);
  let resolve, reject;
  const p = new Promise((res, rej) => { resolve = res; reject = rej; });
  _pending.set(id, p);
  _jobs.push({ id, sap, resolve, reject });
  runWorker();
  return p;
}

async function runWorker() {
  if (_workerRunning) return;
  _workerRunning = true;
  try {
    while (_jobs.length) {
      const job = _jobs.shift();
      try { job.resolve(await processItem(job.id, job.sap)); }
      catch (e) { job.reject(e); }
      finally { _pending.delete(job.id); }
    }
  } finally { _workerRunning = false; }
}

function onEnqueued(id) {
  if (settingsRepo.get().autoProcess) enqueueProcess(id).catch(e => apipLog('ERROR', `Auto-process #${id}: ${e.message}`));
}

async function processItem(id, sapArg) {
  const row = queueRepo.get(id);
  if (!row) throw httpErr(404, 'Queue item not found');
  if (row.processing_status === 'posted') return row;
  const settings = settingsRepo.get();
  const sap = sapArg || currentSap();
  queueRepo.update(id, { processing_status: 'processing', error: '' });
  apipLog('INFO', `Processing #${id} ${row.file_name}`);
  try {
    const buffer = queueRepo.readFile(id);
    if (!buffer) throw new Error('Stored PDF file is missing');
    const { raw } = await runOcr(buffer, settings);
    if (!raw) throw new Error('Could not extract invoice data from the PDF (OCR returned nothing).');
    const ext = normalizeExtracted(raw);
    if (!ext.invoiceNo && !ext.total && !ext.lines.length && !ext.vendorName) throw new Error('OCR did not find any invoice data in the document.');
    const mapped = await buildMapped(ext, settings, row, sap);

    let status = 'processed';
    let dupMsg = '';
    if (settings.duplicateCheck) {
      const dup = await findDuplicateInvoice(sap, mapped.sapOnline, mapped.CardCode, mapped.NumAtCard, id);
      if (dup) {
        status = 'duplicate';
        dupMsg = dup.where === 'sap' ? `Invoice ${mapped.NumAtCard} for ${mapped.CardCode} already posted in SAP (A/P Invoice ${dup.docNum}).`
          : `Invoice ${mapped.NumAtCard} for ${mapped.CardCode} already posted from queue item #${dup.id}.`;
        mapped.warnings.unshift(dupMsg);
      }
    }
    const cur = queueRepo.get(id);
    const keepApproval = cur.sent_at && ['PENDING', 'PARTIAL', 'APPROVED', 'REJECTED'].includes(cur.approval_status);
    const updated = queueRepo.update(id, {
      processing_status: status, error: dupMsg, extracted_json: ext, mapped_json: mapped,
      vendor_name: mapped.CardName || ext.vendorName || '', card_code: mapped.CardCode || '', invoice_no: mapped.NumAtCard || '',
      total: ext.total || mapped.totals.total, currency: mapped.DocCurrency || '', processed_at: nowIso(),
      ...(keepApproval ? {} : { approval_status: settings.approvalRequired ? 'DRAFT' : 'NOT_REQUIRED' }),
    });
    finalizeFolderOriginal(updated, true);
    apipLog(status === 'duplicate' ? 'WARN' : 'INFO', `#${id} ${status}: vendor=${mapped.CardCode || '?'} inv=${mapped.NumAtCard || '?'} total=${mapped.totals.total}`);

    if (status === 'processed' && settings.approvalRequired && settings.autoSendApproval && !keepApproval) {
      try {
        const requestor = updated.uploaded_by ? principalForUsername(updated.uploaded_by) : null;
        sendForApproval(updated, { requestor, sentBy: updated.uploaded_by || 'system' });
      } catch (e) { apipLog('WARN', `#${id} auto-send for approval skipped: ${e.message}`); }
    }
    return queueRepo.get(id);
  } catch (e) {
    const failed = queueRepo.update(id, { processing_status: 'failed', error: String(e.message || e).slice(0, 1000), processed_at: nowIso() });
    finalizeFolderOriginal(failed, false);
    apipLog('ERROR', `#${id} failed: ${e.message}`);
    return failed;
  }
}

// ── Approval engine ───────────────────────────────────────────────────────────
function principalForUsername(username) {
  const u = listPrincipals().users.find(x => x.username === username);
  return u ? { user_id: u.id, username: u.username, full_name: u.name, role: u.role } : null;
}

function principalMatches(p, user) {
  if (!p || !user) return false;
  if (p.type === 'role') {
    const rid = roleIdByName(user.role);
    return (rid != null && String(p.id) === String(rid)) || (p.name && p.name === user.role) || String(p.id) === String(user.role);
  }
  return String(p.id) === userIdOf(user) || (p.name && (p.name === user.username)) || String(p.id) === String(user.username);
}

function stagesForTotal(template, total) {
  const out = [];
  for (const s of template.stages || []) {
    out.push(s);
    if (s.maxInvoiceTotal != null && Number(s.maxInvoiceTotal) > 0 && Number(total) <= Number(s.maxInvoiceTotal)) break;
  }
  return out;
}

function templateApplies(t, row, mapped, extracted, requestor) {
  if (!t?.stages?.length) return false;
  if (requestor && t.requestors?.length && !t.requestors.some(p => principalMatches(p, requestor))) return false;
  const add = t.additionalSettings || {};
  if (add.enabled) {
    if (add.vendorCodes?.length && !add.vendorCodes.includes(mapped?.CardCode || row.card_code)) return false;
    if (Number(add.deviationPct) > 0) {
      const ocr = Number(extracted?.total) || 0, sapT = Number(mapped?.totals?.total) || 0;
      const dev = ocr ? Math.abs(sapT - ocr) / ocr * 100 : 0;
      if (dev < Number(add.deviationPct)) return false;
    }
  }
  return true;
}

function sendForApproval(row, { templateId = null, requestor = null, sentBy = '' } = {}) {
  const full = queueRepo.getFull(row.id);
  if (!full) throw httpErr(404, 'Queue item not found');
  if (!['processed', 'duplicate'].includes(full.processing_status)) throw httpErr(400, `Only processed invoices can be sent for approval (status: ${full.processing_status}).`);
  if (['PENDING', 'PARTIAL'].includes(full.approval_status)) throw httpErr(400, 'Invoice is already awaiting approval.');
  if (full.approval_status === 'APPROVED') throw httpErr(400, 'Invoice is already approved.');
  const total = Number(full.mapped?.totals?.total ?? full.total ?? 0);
  let template = null;
  if (templateId) {
    template = templateRepo.get(templateId);
    if (!template) throw httpErr(404, 'Approval template not found');
  } else {
    template = templateRepo.list().find(t => templateApplies(t, full, full.mapped, full.extracted, requestor));
    if (!template) throw httpErr(400, 'No approval template matches this invoice (requestor / vendor / amount rules).');
  }
  const stages = stagesForTotal(template, total);
  if (!stages.length) throw httpErr(400, `Template "${template.name}" has no stages.`);
  const approval = {
    templateId: template.id, templateName: template.name, currentStage: 1,
    stages: stages.map((s, i) => ({
      no: i + 1, name: s.name, description: s.description || '', approvalsRequired: s.approvalsRequired || 1,
      rejectorsRequired: s.rejectorsRequired || 1, maxInvoiceTotal: s.maxInvoiceTotal ?? null,
      approvers: s.approvers || [], status: i === 0 ? 'PENDING' : 'WAITING',
    })),
  };
  actionRepo.clear(row.id);
  const updated = queueRepo.update(row.id, {
    approval_json: approval, approval_status: 'PENDING', template_id: template.id, sent_at: nowIso(), sent_by: String(sentBy || ''),
  });
  apipLog('INFO', `#${row.id} sent for approval using "${template.name}" (${stages.length} stage(s))`);
  return updated;
}

function stageCounts(actions, stageNo) {
  const acts = actions.filter(a => a.stage_no === stageNo);
  return { approvals: acts.filter(a => a.action === 'approve').length, rejections: acts.filter(a => a.action === 'reject').length, acts };
}

async function actOnApproval(queueId, user, action, comment, sap) {
  const full = queueRepo.getFull(queueId);
  if (!full) throw httpErr(404, 'Queue item not found');
  const ap = full.approval;
  if (!ap || !['PENDING', 'PARTIAL'].includes(full.approval_status)) throw httpErr(400, `Invoice is not awaiting approval (status: ${full.approval_status}).`);
  const stage = ap.stages[ap.currentStage - 1];
  if (!stage) throw httpErr(400, 'Approval stage not found');
  if (!stage.approvers.some(p => principalMatches(p, user))) throw httpErr(403, `You are not an approver for stage "${stage.name}".`);
  const actions = actionRepo.list(queueId);
  if (actions.some(a => a.stage_no === stage.no && a.user_id === userIdOf(user))) throw httpErr(400, 'You have already acted on this stage.');
  if (action === 'reject' && !String(comment || '').trim()) { /* comment optional; kept permissive */ }

  actionRepo.add({ queueId, stageNo: stage.no, userId: userIdOf(user), userName: userNameOf(user), action, comment });
  const { approvals, rejections } = stageCounts(actionRepo.list(queueId), stage.no);
  let status = 'PARTIAL';
  if (rejections >= stage.rejectorsRequired) {
    stage.status = 'REJECTED'; status = 'REJECTED';
  } else if (approvals >= stage.approvalsRequired) {
    stage.status = 'APPROVED';
    if (ap.currentStage >= ap.stages.length) status = 'APPROVED';
    else { ap.currentStage += 1; ap.stages[ap.currentStage - 1].status = 'PENDING'; }
  }
  let updated = queueRepo.update(queueId, { approval_json: ap, approval_status: status });
  apipLog('INFO', `#${queueId} ${action} by ${userNameOf(user)} at stage ${stage.no} → ${status}`);
  if (status === 'APPROVED' && settingsRepo.get().autoPostOnApproval && updated.processing_status !== 'posted') {
    try { await postInvoice(queueId, sap); updated = queueRepo.get(queueId); }
    catch (e) { apipLog('ERROR', `#${queueId} auto-post after approval failed: ${e.message}`); updated = queueRepo.update(queueId, { error: `Auto-post failed: ${e.message}`.slice(0, 1000) }); }
  }
  return updated;
}

function approvalView(full) {
  const ap = full?.approval;
  if (!ap) return { templateName: null, stages: [], currentStage: null };
  const actions = actionRepo.list(full.id);
  return {
    templateId: ap.templateId, templateName: ap.templateName, currentStage: ap.currentStage,
    stages: ap.stages.map(s => ({
      no: s.no, name: s.name, status: s.status, approvalsRequired: s.approvalsRequired, rejectorsRequired: s.rejectorsRequired,
      approvers: s.approvers,
      approvals: actions.filter(a => a.stage_no === s.no).map(a => ({ user: a.user_name, userId: a.user_id, action: a.action, comment: a.comment, at: a.at })),
    })),
  };
}

function approvalRow(r, user) {
  const ap = r.approval || { stages: [], currentStage: 0 };
  const actions = actionRepo.list(r.id);
  const stage = ap.stages[(ap.currentStage || 1) - 1] || null;
  const cur = stage ? stageCounts(actions, stage.no) : { approvals: 0 };
  const required = ap.stages.reduce((s, x) => s + (x.approvalsRequired || 1), 0);
  const done = ap.stages.reduce((s, x) => s + Math.min(x.approvalsRequired || 1, stageCounts(actions, x.no).approvals), 0);
  return {
    id: r.id, fileName: r.file_name, vendorName: r.vendor_name || '', templateName: ap.templateName || '',
    stageNo: stage?.no ?? null, stageCount: ap.stages.length, stageName: stage?.name || '',
    status: r.approval_status, approvedCount: cur.approvals, requiredCount: stage?.approvalsRequired ?? 0,
    progressPct: r.approval_status === 'APPROVED' ? 100 : (required ? Math.round(done / required * 100) : 0),
    sapDocNum: r.sap_doc_num ?? null, date: r.sent_at,
    // additions
    invoiceNo: r.invoice_no || '', total: r.total, currency: r.currency || '', cardCode: r.card_code || '',
    processingStatus: r.processing_status,
    canAct: !!(user && stage && ['PENDING', 'PARTIAL'].includes(r.approval_status) && stage.approvers.some(p => principalMatches(p, user))
      && !actions.some(a => a.stage_no === stage.no && a.user_id === userIdOf(user))),
  };
}

// ── Validation & posting ──────────────────────────────────────────────────────
async function validateInvoice(full, sapIn) {
  const issues = [];
  const m = full.mapped;
  const settings = settingsRepo.get();
  if (!m) return [{ field: 'invoice', message: 'Invoice has not been processed yet.', severity: 'error' }];
  const online = await probeSap(sapIn);
  const sap = online ? sapIn : OFFLINE_SAP;
  if (!online) issues.push({ field: 'sap', message: 'SAP is not reachable — master data could not be verified.', severity: 'warning' });

  if (!m.CardCode) issues.push({ field: 'CardCode', message: 'Vendor is required.', severity: 'error' });
  else if (online) {
    try {
      const bp = await sap.get(`/BusinessPartners('${q(m.CardCode)}')`, { $select: 'CardCode,CardType,Frozen' });
      if (bp.CardType && bp.CardType !== 'cSupplier') issues.push({ field: 'CardCode', message: `${m.CardCode} is not a supplier.`, severity: 'error' });
      if (bp.Frozen === 'tYES') issues.push({ field: 'CardCode', message: `Vendor ${m.CardCode} is inactive/frozen.`, severity: 'error' });
    } catch { issues.push({ field: 'CardCode', message: `Vendor ${m.CardCode} does not exist in SAP.`, severity: 'error' }); }
  }
  if (!m.NumAtCard) issues.push({ field: 'NumAtCard', message: 'Vendor invoice number (NumAtCard) is empty.', severity: 'warning' });
  if (!m.DocDate) issues.push({ field: 'DocDate', message: 'Posting date is required.', severity: 'error' });
  if (!m.lines?.length) issues.push({ field: 'lines', message: 'Invoice has no lines.', severity: 'error' });

  const isService = m.DocType === 'dDocument_Service';
  const itemCodes = new Set(), accounts = new Set();
  (m.lines || []).forEach((l, i) => {
    const line = i + 1, base = l.BaseEntry != null && l.BaseEntry !== '';
    if (!isService && !l.ItemCode && !base) issues.push({ field: 'ItemCode', line, message: 'Item is required.', severity: 'error' });
    if (isService && !l.AccountCode && !base) issues.push({ field: 'AccountCode', line, message: 'G/L account is required.', severity: 'error' });
    if (!isService && l.ItemCode) itemCodes.add(l.ItemCode);
    if (isService && l.AccountCode) accounts.add(l.AccountCode);
    if (!(num(l.Quantity) > 0)) issues.push({ field: 'Quantity', line, message: 'Quantity must be greater than 0.', severity: 'error' });
    if (num(l.UnitPrice) < 0) issues.push({ field: 'UnitPrice', line, message: 'Unit price cannot be negative.', severity: 'error' });
    if (!l.TaxCode) issues.push({ field: 'TaxCode', line, message: 'Tax code is empty.', severity: 'warning' });
    if (!isService && !l.WarehouseCode && !base) issues.push({ field: 'WarehouseCode', line, message: 'Warehouse is empty.', severity: 'warning' });
  });
  if (online) {
    for (const code of itemCodes) {
      try { await sap.get(`/Items('${q(code)}')`, { $select: 'ItemCode' }); }
      catch { (m.lines || []).forEach((l, i) => { if (l.ItemCode === code) issues.push({ field: 'ItemCode', line: i + 1, message: `Item ${code} does not exist in SAP.`, severity: 'error' }); }); }
    }
    for (const acct of accounts) {
      try { await sap.get(`/ChartOfAccounts('${q(acct)}')`, { $select: 'Code' }); }
      catch { (m.lines || []).forEach((l, i) => { if (l.AccountCode === acct) issues.push({ field: 'AccountCode', line: i + 1, message: `G/L account ${acct} does not exist in SAP.`, severity: 'error' }); }); }
    }
  }
  const ocrTotal = Number(full.extracted?.total) || 0;
  const mt = Number(m.totals?.total) || 0;
  if (ocrTotal && Math.abs(mt - ocrTotal) > (Number(settings.totalTolerance) || 0)) {
    issues.push({ field: 'totals', message: `Document total ${mt} differs from the invoice (OCR) total ${ocrTotal} by ${round2(mt - ocrTotal)}.`, severity: 'warning' });
  }
  const dup = await findDuplicateInvoice(sap, online, m.CardCode, m.NumAtCard, full.id);
  if (dup) issues.push({ field: 'NumAtCard', message: dup.where === 'sap' ? `Vendor invoice ${m.NumAtCard} already exists in SAP (A/P Invoice ${dup.docNum}).` : `Vendor invoice ${m.NumAtCard} was already posted from queue item #${dup.id}.`, severity: 'error' });
  for (const f of settings.extraFields || []) {
    const v = m.extraFields?.[f.key] ?? (f.sapField ? m[f.sapField] : undefined);
    if (f.required && (v == null || String(v).trim() === '')) issues.push({ field: f.key, message: `${f.label || f.key} is required.`, severity: 'error' });
  }
  return issues;
}

function buildPayload(m, settings) {
  const isService = m.DocType === 'dDocument_Service';
  const payload = {
    DocType: isService ? 'dDocument_Service' : 'dDocument_Items',
    CardCode: m.CardCode,
    DocDate: sapDate(normDate(m.DocDate) || today()),
    TaxDate: sapDate(normDate(m.TaxDate || m.DocDate) || today()),
    ...(m.DocDueDate ? { DocDueDate: sapDate(normDate(m.DocDueDate)) } : {}),
    ...(m.NumAtCard ? { NumAtCard: String(m.NumAtCard).slice(0, 100) } : {}),
    ...(m.Comments ? { Comments: String(m.Comments).slice(0, 254) } : {}),
    ...(m.Series != null && m.Series !== '' && Number.isFinite(Number(m.Series)) ? { Series: Number(m.Series) } : {}),
    ...(m.DocCurrency && m.DocCurrency !== '##' ? { DocCurrency: m.DocCurrency } : {}),
    ...(num(m.DiscountPercent) ? { DiscountPercent: num(m.DiscountPercent) } : {}),
  };
  for (const f of settings.extraFields || []) {
    if (!f.sapField) continue;
    let v = m.extraFields?.[f.key] ?? m[f.sapField];
    if (v == null || v === '') continue;
    if (f.type === 'number') v = num(v);
    if (f.type === 'date') v = sapDate(normDate(v));
    payload[f.sapField] = v;
  }
  for (const [k, v] of Object.entries(m)) if (/^U_/.test(k) && !(k in payload) && v !== '' && v != null) payload[k] = v;

  payload.DocumentLines = (m.lines || []).filter(l => num(l.Quantity) > 0).map(l => {
    const base = l.BaseEntry != null && l.BaseEntry !== '' && l.BaseLine != null && l.BaseLine !== ''
      ? { BaseType: Number(l.BaseType) || 22, BaseEntry: Number(l.BaseEntry), BaseLine: Number(l.BaseLine) } : null;
    const common = {
      ...(l.TaxCode ? { TaxCode: l.TaxCode } : {}),
      ...(num(l.DiscountPercent) ? { DiscountPercent: num(l.DiscountPercent) } : {}),
    };
    if (isService) {
      const net = round2(num(l.Quantity) * num(l.UnitPrice) * (1 - num(l.DiscountPercent) / 100));
      return {
        ...(base || {}), ...(base ? {} : { AccountCode: l.AccountCode }),
        ItemDescription: String(l.ItemDescription || l.ocrDescription || 'Service').slice(0, 100),
        LineTotal: net, ...(l.TaxCode ? { TaxCode: l.TaxCode } : {}),
      };
    }
    return {
      ...(base || { ItemCode: l.ItemCode }),
      Quantity: num(l.Quantity), UnitPrice: num(l.UnitPrice), ...common,
      ...(l.WarehouseCode ? { WarehouseCode: l.WarehouseCode } : {}),
      ...(!base && l.AccountCode && l.AccountCode !== settings.defaultGlAccount ? { AccountCode: l.AccountCode } : {}),
    };
  });
  return payload;
}

async function postInvoice(id, sapIn) {
  const full = queueRepo.getFull(id);
  if (!full) throw httpErr(404, 'Queue item not found');
  if (full.processing_status === 'posted') throw httpErr(400, `Already posted (Doc ${full.sap_doc_num}).`);
  if (!full.mapped) throw httpErr(400, 'Invoice has not been processed yet.');
  const settings = settingsRepo.get();
  if (!settings.postWithoutApproval && !['APPROVED', 'NOT_REQUIRED'].includes(full.approval_status)) {
    throw httpErr(400, `Invoice must be approved before posting (approval status: ${full.approval_status}).`);
  }
  const m = full.mapped;
  if (!m.CardCode) throw httpErr(400, 'Vendor (CardCode) is required.');
  if (settings.duplicateCheck) {
    const local = queueRepo.findPostedDuplicate(m.CardCode, m.NumAtCard, id);
    if (local) throw httpErr(400, `Vendor invoice ${m.NumAtCard} was already posted from queue item #${local.id}.`);
  }
  const payload = buildPayload(m, settings);
  if (!payload.DocumentLines.length) throw httpErr(400, 'No lines with a quantity to post.');
  const sap = sapIn || currentSap();
  if (!sap) throw httpErr(503, 'No SAP connection.');
  let result;
  try {
    result = settings.postAsDraft
      ? await sap.post('/Drafts', { ...payload, DocObjectCode: 'oPurchaseInvoices' })
      : await sap.post('/PurchaseInvoices', payload);
  } catch (e) {
    queueRepo.update(id, { error: `Post failed: ${e.message}`.slice(0, 1000) });
    apipLog('ERROR', `#${id} post failed: ${e.message}`);
    throw httpErr(502, e.message);
  }
  queueRepo.update(id, {
    processing_status: 'posted', sap_doc_entry: result?.DocEntry ?? null, sap_doc_num: result?.DocNum ?? null,
    sap_is_draft: settings.postAsDraft ? 1 : 0, posted_at: nowIso(), error: '',
  });
  apipLog('INFO', `#${id} posted as ${settings.postAsDraft ? 'draft' : 'A/P Invoice'} DocNum=${result?.DocNum} DocEntry=${result?.DocEntry}`);
  return { docEntry: result?.DocEntry ?? null, docNum: result?.DocNum ?? null, isDraft: !!settings.postAsDraft };
}

// ── Lookups ───────────────────────────────────────────────────────────────────
async function loadSeries(sap) {
  try {
    const r = await withTimeout(sap.post('/SeriesService_GetDocumentSeries', { DocumentTypeParams: { Document: '18' } }), 15000, 'series');
    const list = Array.isArray(r?.value) ? r.value : (Array.isArray(r) ? r : []);
    return list.filter(s => s.Locked !== 'tYES').map(s => ({ code: s.Series, name: s.Name || String(s.Series), series: s.Series, isDefault: s.IsDefault === 'tYES' || undefined }));
  } catch { return []; }
}

async function searchGlAccounts(sap, text, top = 50) {
  const esc = q(text).slice(0, 40);
  const filter = `ActiveAccount eq 'tYES'` + (esc ? ` and (Code eq '${esc}' or ${containsAnyCase(['FormatCode', 'Name'], esc)})` : '');
  const r = await withTimeout(sap.get('/ChartOfAccounts', { $select: 'Code,Name,FormatCode', $filter: filter, $orderby: 'Code', $top: top }), 20000, 'G/L accounts');
  return (Array.isArray(r.value) ? r.value : []).map(a => ({ code: a.Code, name: a.Name || '', format: a.FormatCode || '' }));
}

async function masterSync(sap) {
  const cid = companyId();
  const repo = _ctx.cacheRepo;
  if (!repo) throw new Error('cacheRepo dependency missing');
  if (!(await probeSap(sap))) throw httpErr(503, 'SAP is not reachable — cannot refresh master data.');
  const synced = {}, errors = {};
  const run = async (entity, fn) => {
    try { synced[entity] = await fn(); repo.logSync?.(cid, entity, 'ok', synced[entity]); }
    catch (e) { errors[entity] = e.message; synced[entity] = 0; try { repo.logSync?.(cid, entity, 'error', 0, e.message); } catch { /* ignore */ } }
  };
  await run('suppliers', async () => {
    const rows = await fetchAllPages(sap, '/BusinessPartners', { $select: 'CardCode,CardName,CardType,Currency,Frozen,GroupCode,PayTermsGrpCode', $filter: `CardType eq 'cSupplier'` }, 50000);
    if (rows.length) repo.replaceEntity(cid, 'suppliers', () => repo.upsertBPs(cid, rows));
    return rows.length;
  });
  await run('items', async () => {
    const rows = await fetchAllPages(sap, '/Items', { $select: 'ItemCode,ItemName,ItemsGroupCode,PurchaseUnit,SalesUnit,InventoryUOM,Frozen,ManageBatchNumbers,ManageSerialNumbers' }, 100000);
    const mappedRows = rows.map(i => ({ ...i, InventoryUoM: i.InventoryUOM }));
    if (rows.length) repo.replaceEntity(cid, 'items', () => repo.upsertItems(cid, mappedRows));
    return rows.length;
  });
  await run('tax_codes', async () => {
    let list = [];
    try {
      const vat = await fetchAllPages(sap, '/VatGroups', { $select: 'Code,Name,Category,VatGroups_Lines' }, 2000).catch(async () => fetchAllPages(sap, '/VatGroups', {}, 2000));
      list = vat.map(v => { const sl = v.VatGroups_Lines || v.VatGroups || []; return { Code: v.Code, Name: v.Name, Category: v.Category || '', Rate: sl.length ? Number(sl[sl.length - 1].Rate || 0) : Number(v.Rate || 0) }; });
    } catch { /* not this localization */ }
    if (!list.length) {
      try { list = (await fetchAllPages(sap, '/SalesTaxCodes', {}, 2000)).map(v => ({ Code: v.Code, Name: v.Name, Category: 'Sales Tax', Rate: Number(v.Rate || 0) })); } catch { /* ignore */ }
    }
    if (list.length) repo.replaceEntity(cid, 'tax_codes', () => repo.upsertTaxCodes(cid, list));
    return list.length;
  });
  await run('warehouses', async () => {
    const rows = await fetchAllPages(sap, '/Warehouses', { $select: 'WarehouseCode,WarehouseName,Inactive' }, 5000);
    if (rows.length) repo.replaceEntity(cid, 'warehouses', () => repo.upsertWarehouses(cid, rows));
    return rows.length;
  });
  apipLog('INFO', `Master sync: ${JSON.stringify(synced)}${Object.keys(errors).length ? ' errors=' + JSON.stringify(errors) : ''}`);
  return { synced, errors };
}

// ── Mapping memory: learn from user corrections ───────────────────────────────
function learnMappings(prev, next, extracted) {
  const cid = companyId();
  let learned = 0;
  if (next.CardCode && next.CardCode !== prev?.CardCode) {
    if (extracted?.vendorName) { mappingRepo.learn(cid, 'vendor', extracted.vendorName, next.CardCode, next.CardName || ''); learned++; }
    if (extracted?.vendorGstin) mappingRepo.learn(cid, 'vendor', `gstin ${extracted.vendorGstin}`, next.CardCode, next.CardName || '');
  }
  (next.lines || []).forEach((l, i) => {
    const p = prev?.lines?.[i];
    const src = l.ocrDescription || p?.ocrDescription;
    if (!src) return;
    if (l.ItemCode && l.ItemCode !== p?.ItemCode) { mappingRepo.learn(cid, 'item', src, l.ItemCode, l.ItemDescription || ''); learned++; }
    if (l.AccountCode && l.AccountCode !== p?.AccountCode) { mappingRepo.learn(cid, 'gl', src, l.AccountCode, ''); learned++; }
  });
  return learned;
}

function sanitizeMapped(input, prev) {
  const m = { ...(prev || {}), ...(input || {}) };
  m.DocType = m.DocType === 'dDocument_Service' ? 'dDocument_Service' : 'dDocument_Items';
  m.BaseType = m.BaseType === '' || m.BaseType == null ? null : Number(m.BaseType);
  m.BaseEntry = m.BaseEntry === '' || m.BaseEntry == null ? null : Number(m.BaseEntry);
  m.DiscountPercent = num(m.DiscountPercent);
  m.lines = (Array.isArray(m.lines) ? m.lines : []).map(l => ({
    ItemCode: String(l.ItemCode || ''), ItemDescription: String(l.ItemDescription || '').slice(0, 100), AccountCode: String(l.AccountCode || ''),
    Quantity: num(l.Quantity), UnitPrice: num(l.UnitPrice), DiscountPercent: num(l.DiscountPercent),
    TaxCode: String(l.TaxCode || ''), WarehouseCode: String(l.WarehouseCode || ''), UoMCode: String(l.UoMCode || ''),
    BaseType: l.BaseType === '' || l.BaseType == null ? null : Number(l.BaseType),
    BaseEntry: l.BaseEntry === '' || l.BaseEntry == null ? null : Number(l.BaseEntry),
    BaseLine: l.BaseLine === '' || l.BaseLine == null ? null : Number(l.BaseLine),
    ocrDescription: l.ocrDescription || '', matchScore: l.matchScore ?? 0,
    taxPct: num(l.taxPct), hsn: l.hsn || '', ocrLineTotal: num(l.ocrLineTotal),
  }));
  if (!m.extraFields || typeof m.extraFields !== 'object') m.extraFields = {};
  if (!Array.isArray(m.warnings)) m.warnings = [];
  return m;
}

// ── Public: startup ───────────────────────────────────────────────────────────
export function startApipIntake(deps = {}) {
  setCtx(deps);
  try {
    // Items left in 'processing' by a restart go back to pending.
    for (const id of queueRepo.idsByStatus(['processing'])) queueRepo.update(id, { processing_status: 'pending' });
    const status = applyIntakeSettings();
    if (settingsRepo.get().autoProcess) for (const id of queueRepo.idsByStatus(['pending'])) enqueueProcess(id).catch(() => {});
    apipLog('INFO', `APIP intake initialised (folder=${status.folderRunning}, mail=${status.mailRunning})`);
    return status;
  } catch (e) {
    apipLog('ERROR', `APIP intake start failed: ${e.message}`);
    return getIntakeStatus();
  }
}

// ── Router ────────────────────────────────────────────────────────────────────
export function createApipRouter(deps = {}) {
  setCtx(deps);
  const { requireAuth } = deps;
  const printAuth = deps.printAuth || requireAuth;
  const router = Router();
  router.use(express.json({ limit: '8mb' }));
  const sapOf = () => currentSap();
  const getRow = id => { const r = queueRepo.getFull(id); if (!r) throw httpErr(404, 'Queue item not found'); return r; };

  // Dashboard
  router.get('/dashboard', requireAuth, wrap(async (req, res) => {
    res.json({
      ok: true, counts: queueRepo.counts(), approval: queueRepo.approvalCounts(), bySource: queueRepo.bySource(),
      recent: queueRepo.list({ limit: 10 }).map(toQueueRow), intake: getIntakeStatus(), daily: queueRepo.daily(14),
    });
  }));

  // Queue
  router.get('/queue', requireAuth, wrap(async (req, res) => {
    const { status = '', search = '', tab = '' } = req.query;
    res.json({ ok: true, rows: queueRepo.list({ status: String(status), search: String(search).trim(), tab: String(tab) }).map(toQueueRow) });
  }));

  router.post('/queue/upload', requireAuth, _upload.any(), wrap(async (req, res) => {
    const files = (req.files || []).filter(f => ['files', 'file', 'files[]'].includes(f.fieldname));
    if (!files.length) throw httpErr(400, 'No files uploaded (multipart field "files").');
    const settings = settingsRepo.get();
    const sap = sapOf();
    const rows = [], rejected = [];
    for (const f of files) {
      const isPdf = f.mimetype === 'application/pdf' || /\.pdf$/i.test(f.originalname || '') || f.buffer?.slice(0, 4).toString() === '%PDF';
      if (!isPdf) { rejected.push(f.originalname); continue; }
      const row = queueRepo.create({
        buffer: f.buffer, fileName: f.originalname || 'invoice.pdf', source: 'upload', sourceRef: 'Uploaded Invoice',
        uploadedBy: req.user?.username || '', companyId: companyId(), approvalStatus: settings.approvalRequired ? 'DRAFT' : 'NOT_REQUIRED',
      });
      rows.push(row);
      apipLog('INFO', `Upload: queued ${row.file_name} as #${row.id} by ${req.user?.username || '?'}`);
      if (settings.autoProcess) enqueueProcess(row.id, sap).catch(e => apipLog('ERROR', `#${row.id}: ${e.message}`));
    }
    if (!rows.length) throw httpErr(400, `Only PDF files are accepted${rejected.length ? ` (rejected: ${rejected.join(', ')})` : ''}.`);
    res.json({ ok: true, rows: rows.map(r => toQueueRow(queueRepo.get(r.id))), rejected });
  }));

  router.post('/queue/process-all', requireAuth, wrap(async (req, res) => {
    const ids = queueRepo.idsByStatus(['pending', 'failed']);
    const sap = sapOf();
    ids.forEach(id => enqueueProcess(id, sap).catch(() => {}));
    res.json({ ok: true, started: true, count: ids.length });
  }));

  router.post('/queue/:id/process', requireAuth, wrap(async (req, res) => {
    const row = getRow(req.params.id);
    if (row.processing_status === 'posted') throw httpErr(400, 'Invoice is already posted.');
    const out = await enqueueProcess(row.id, sapOf());
    res.json({ ok: true, row: toQueueRow(out) });
  }));

  router.delete('/queue/:id', requireAuth, wrap(async (req, res) => {
    const row = getRow(req.params.id);
    if (_pending.has(row.id)) throw httpErr(409, 'Item is being processed — try again shortly.');
    // a folder original still sitting in the input folder would be re-queued on the next scan
    if (row.source === 'folder' && !row.original_moved) finalizeFolderOriginal(row, false);
    queueRepo.delete(row.id);
    apipLog('INFO', `#${row.id} deleted by ${req.user?.username || '?'}`);
    res.json({ ok: true, id: row.id });
  }));

  router.get('/queue/:id/pdf', printAuth, wrap(async (req, res) => {
    const row = getRow(req.params.id);
    const fp = row.file_path;
    if (!fp || !fs.existsSync(fp)) throw httpErr(404, 'PDF file not found');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${String(row.file_name).replace(/["\r\n]/g, '')}"`);
    fs.createReadStream(fp).on('error', e => { if (!res.headersSent) fail(res, 500, e); else res.end(); }).pipe(res);
  }));

  router.get('/queue/:id/json', requireAuth, wrap(async (req, res) => {
    const row = getRow(req.params.id);
    res.json({ ok: true, extracted: row.extracted, mapped: row.mapped });
  }));

  router.post('/queue/:id/send-approval', requireAuth, wrap(async (req, res) => {
    const row = getRow(req.params.id);
    const updated = sendForApproval(row, { templateId: req.body?.templateId || null, requestor: req.user, sentBy: req.user?.username || '' });
    res.json({ ok: true, row: toQueueRow(updated) });
  }));

  // Invoice form
  router.get('/invoice/:id', requireAuth, wrap(async (req, res) => {
    const row = getRow(req.params.id);
    res.json({ ok: true, row: toQueueRow(row), extracted: row.extracted, mapped: row.mapped, approval: approvalView(row) });
  }));

  router.put('/invoice/:id', requireAuth, wrap(async (req, res) => {
    const row = getRow(req.params.id);
    if (row.processing_status === 'posted') throw httpErr(400, 'Invoice is already posted — it can no longer be edited.');
    if (!req.body?.mapped || typeof req.body.mapped !== 'object') throw httpErr(400, 'Body must contain { mapped }.');
    const mapped = sanitizeMapped(req.body.mapped, row.mapped);
    const sap = sapOf();
    const taxCodes = await loadTaxCodes(sap, false).catch(() => []);
    computeTotals(mapped, taxCodes);
    const learned = learnMappings(row.mapped, mapped, row.extracted);
    const fields = {
      mapped_json: mapped, card_code: mapped.CardCode || '', vendor_name: mapped.CardName || row.vendor_name || '',
      invoice_no: mapped.NumAtCard || '', currency: mapped.DocCurrency || '', total: mapped.totals.total,
    };
    // A manually prepared (pending/failed) invoice becomes processed once it has a vendor and lines.
    if (['pending', 'failed'].includes(row.processing_status) && mapped.CardCode && mapped.lines.length) { fields.processing_status = 'processed'; fields.error = ''; }
    if (row.processing_status === 'duplicate' && !queueRepo.findPostedDuplicate(mapped.CardCode, mapped.NumAtCard, row.id)
      && (mapped.NumAtCard !== row.mapped?.NumAtCard || mapped.CardCode !== row.mapped?.CardCode)) { fields.processing_status = 'processed'; fields.error = ''; }
    queueRepo.update(row.id, fields);
    if (learned) apipLog('INFO', `#${row.id}: learned ${learned} mapping correction(s)`);
    res.json({ ok: true, mapped, learned });
  }));

  router.post('/invoice/:id/validate', requireAuth, wrap(async (req, res) => {
    const row = getRow(req.params.id);
    res.json({ ok: true, issues: await validateInvoice(row, sapOf()) });
  }));

  router.post('/invoice/:id/post', requireAuth, wrap(async (req, res) => {
    const out = await postInvoice(Number(req.params.id), sapOf());
    res.json({ ok: true, ...out, row: toQueueRow(queueRepo.get(req.params.id)) });
  }));

  // Lookups
  router.get('/lookups', requireAuth, wrap(async (req, res) => {
    const sap = sapOf();
    const online = await probeSap(sap);
    const cid = companyId();
    const repo = _ctx.cacheRepo;
    const s = online ? sap : OFFLINE_SAP;
    const [taxCodes, warehouses, series] = await Promise.all([
      loadTaxCodes(s, online),
      getWarehouses(s, repo, cid).catch(() => []),
      online ? loadSeries(sap) : Promise.resolve([]),
    ]);
    let currencies = (repo?.getCurrencies?.(cid) || []).map(c => ({ code: c.Code, name: c.Name || c.Code }));
    if (!currencies.length && online) {
      try { const r = await withTimeout(sap.get('/Currencies', { $select: 'Code,Name', $top: 300 }), 15000, 'currencies'); currencies = (r.value || []).map(c => ({ code: c.Code, name: c.Name || c.Code })); } catch { /* ignore */ }
    }
    let paymentTerms = (repo?.getPaymentTerms?.(cid) || []).map(p => ({ code: p.GroupNumber, name: p.PaymentTermsGroupName || String(p.GroupNumber) }));
    if (!paymentTerms.length && online) {
      try { const r = await withTimeout(sap.get('/PaymentTermsTypes', { $select: 'GroupNumber,PaymentTermsGroupName', $top: 300 }), 15000, 'payment terms'); paymentTerms = (r.value || []).map(p => ({ code: p.GroupNumber, name: p.PaymentTermsGroupName })); } catch { /* ignore */ }
    }
    res.json({ ok: true, taxCodes, warehouses, currencies, paymentTerms, series, sapOnline: online });
  }));

  router.get('/vendors', requireAuth, wrap(async (req, res) => {
    const text = String(req.query.q || '').trim();
    let rows = [];
    try { rows = (_ctx.cacheRepo?.searchBPs?.(companyId(), text, 'cSupplier', 30) || []).map(b => ({ code: b.CardCode, name: b.CardName, currency: b.Currency || null })); } catch { rows = []; }
    if (!rows.length) {
      const sap = sapOf();
      if (await probeSap(sap)) rows = (await searchPartners(sap, text, 'cSupplier')).map(p => ({ code: p.code, name: p.name, currency: p.currency }));
    }
    res.json({ ok: true, rows, vendors: rows });
  }));

  router.get('/items', requireAuth, wrap(async (req, res) => {
    const text = String(req.query.q || '').trim();
    let rows = [];
    try { rows = (_ctx.cacheRepo?.searchItems?.(companyId(), text, 30) || []).map(i => ({ code: i.ItemCode, name: i.ItemName, unit: i.InventoryUoM || i.PurchaseUnit || '' })); } catch { rows = []; }
    if (!rows.length) {
      const sap = sapOf();
      if (await probeSap(sap)) rows = await searchItems(sap, text);
    }
    res.json({ ok: true, rows, items: rows });
  }));

  router.get('/gl-accounts', requireAuth, wrap(async (req, res) => {
    const sap = sapOf();
    if (!(await probeSap(sap))) return res.json({ ok: true, rows: [], accounts: [], warning: 'SAP is not reachable.' });
    const rows = await searchGlAccounts(sap, String(req.query.q || '').trim());
    res.json({ ok: true, rows, accounts: rows });
  }));

  router.get('/open-docs', requireAuth, wrap(async (req, res) => {
    const cardCode = String(req.query.cardCode || '').trim();
    if (!cardCode) throw httpErr(400, 'cardCode is required');
    const sap = sapOf();
    if (!(await probeSap(sap))) return res.json({ ok: true, pos: [], grpos: [], warning: 'SAP is not reachable.' });
    res.json({ ok: true, ...(await fetchOpenDocs(sap, cardCode)) });
  }));

  router.post('/master-sync', requireAuth, wrap(async (req, res) => {
    res.json({ ok: true, ...(await masterSync(sapOf())) });
  }));

  router.get('/mappings', requireAuth, wrap(async (req, res) => {
    res.json({ ok: true, rows: mappingRepo.list(companyId()) });
  }));

  // Approvals
  router.get('/approvals', requireAuth, wrap(async (req, res) => {
    const tab = String(req.query.tab || 'mine');
    const search = String(req.query.search || '').trim().toLowerCase();
    let rows = queueRepo.sentRows().map(r => approvalRow(r, req.user));
    if (tab === 'mine') rows = rows.filter(r => r.canAct);
    else if (tab === 'partial') rows = rows.filter(r => r.status === 'PARTIAL');
    else if (tab === 'approved') rows = rows.filter(r => r.status === 'APPROVED');
    else if (tab === 'rejected') rows = rows.filter(r => r.status === 'REJECTED');
    else if (tab === 'pending') rows = rows.filter(r => ['PENDING', 'PARTIAL'].includes(r.status));
    if (search) rows = rows.filter(r => [r.fileName, r.vendorName, r.templateName, r.stageName, r.invoiceNo, r.cardCode, String(r.sapDocNum ?? '')]
      .some(v => String(v || '').toLowerCase().includes(search)));
    res.json({ ok: true, rows });
  }));

  for (const action of ['approve', 'reject']) {
    router.post(`/approvals/:queueId/${action}`, requireAuth, wrap(async (req, res) => {
      const updated = await actOnApproval(Number(req.params.queueId), req.user, action, req.body?.comment || '', sapOf());
      res.json({ ok: true, row: toQueueRow(updated), approval: approvalView(queueRepo.getFull(updated.id)) });
    }));
  }

  router.get('/approval-stages', requireAuth, wrap(async (req, res) => {
    const pending = queueRepo.sentRows().filter(r => ['PENDING', 'PARTIAL'].includes(r.approval_status) && r.approval);
    const rows = [];
    for (const t of templateRepo.list()) {
      (t.stages || []).forEach((s, i) => {
        rows.push({
          templateId: t.id, templateName: t.name, stageNo: i + 1, name: s.name, description: s.description || '',
          approvalsRequired: s.approvalsRequired, rejectorsRequired: s.rejectorsRequired, maxInvoiceTotal: s.maxInvoiceTotal ?? null,
          approvers: s.approvers || [],
          pendingCount: pending.filter(r => Number(r.approval.templateId) === Number(t.id) && Number(r.approval.currentStage) === i + 1).length,
        });
      });
    }
    res.json({ ok: true, rows, stages: rows });
  }));

  // Approval Master (templates)
  const validateTemplateBody = b => {
    const t = normalizeTemplate(b);
    if (!t.name) throw httpErr(400, 'Template name is required.');
    if (!t.stages.length) throw httpErr(400, 'At least one approval stage is required.');
    t.stages.forEach((s, i) => { if (!s.approvers.length) throw httpErr(400, `Stage ${i + 1} ("${s.name}") needs at least one approver.`); });
    return t;
  };

  router.get('/templates', requireAuth, wrap(async (req, res) => {
    const rows = templateRepo.list(String(req.query.search || '').trim()).map(t => ({
      id: t.id, name: t.name, description: t.description, stageCount: t.stages.length,
      settingsEnabled: !!t.additionalSettings?.enabled, requestorCount: t.requestors.length, createdAt: t.createdAt,
    }));
    res.json({ ok: true, rows });
  }));

  router.get('/templates/:id', requireAuth, wrap(async (req, res) => {
    const t = templateRepo.get(req.params.id);
    if (!t) throw httpErr(404, 'Template not found');
    res.json({ ok: true, template: t });
  }));

  router.post('/templates', requireAuth, wrap(async (req, res) => {
    validateTemplateBody(req.body || {});
    const t = templateRepo.create(req.body || {});
    apipLog('INFO', `Template "${t.name}" created by ${req.user?.username || '?'}`);
    res.json({ ok: true, template: t });
  }));

  router.put('/templates/:id', requireAuth, wrap(async (req, res) => {
    validateTemplateBody(req.body || {});
    const t = templateRepo.update(req.params.id, req.body || {});
    if (!t) throw httpErr(404, 'Template not found');
    res.json({ ok: true, template: t });
  }));

  router.delete('/templates/:id', requireAuth, wrap(async (req, res) => {
    if (!templateRepo.delete(req.params.id)) throw httpErr(404, 'Template not found');
    res.json({ ok: true });
  }));

  router.get('/principals', requireAuth, wrap(async (req, res) => {
    const { users, roles } = listPrincipals();
    res.json({ ok: true, users: users.map(u => ({ id: u.id, name: u.name, username: u.username })), roles });
  }));

  // Mail configuration
  router.get('/mail-configs', requireAuth, wrap(async (req, res) => {
    res.json({ ok: true, rows: mailRepo.list() });
  }));

  const checkMailBody = (b, creating) => {
    if (creating && (!b.imapHost || !b.user)) throw httpErr(400, 'IMAP host and user are required.');
    if (creating && !b.password) throw httpErr(400, 'Password is required.');
    if (b.subjectFilter) { try { new RegExp(b.subjectFilter, 'i'); } catch { throw httpErr(400, 'Subject filter is not a valid regular expression.'); } }
  };
  const reloadMail = () => { if (settingsRepo.get().mailEnabled) applyIntakeSettings(); };

  router.post('/mail-configs', requireAuth, wrap(async (req, res) => {
    const b = req.body || {};
    checkMailBody(b, true);
    const row = mailRepo.create(b);
    reloadMail();
    res.json({ ok: true, row });
  }));

  router.put('/mail-configs/:id', requireAuth, wrap(async (req, res) => {
    const b = req.body || {};
    checkMailBody(b, false);
    const row = mailRepo.update(req.params.id, b);
    if (!row) throw httpErr(404, 'Mail configuration not found');
    reloadMail();
    res.json({ ok: true, row });
  }));

  router.delete('/mail-configs/:id', requireAuth, wrap(async (req, res) => {
    if (!mailRepo.delete(req.params.id)) throw httpErr(404, 'Mail configuration not found');
    reloadMail();
    res.json({ ok: true });
  }));

  router.post('/mail-configs/:id/test', requireAuth, wrap(async (req, res) => {
    const b = req.body || {};
    const saved = /^\d+$/.test(String(req.params.id)) ? mailRepo.getWithSecret(req.params.id) : null;
    if (!saved && !b.imapHost) throw httpErr(404, 'Mail configuration not found');
    const cfg = { ...(saved || {}) };
    for (const k of ['imapHost', 'imapPort', 'imapTls', 'user', 'folder']) if (b[k] !== undefined && b[k] !== '') cfg[k] = b[k];
    if (b.password) cfg.password = b.password;
    if (typeof cfg.imapTls === 'string') cfg.imapTls = cfg.imapTls !== 'false';
    const r = await testMailbox(cfg);
    if (saved) mailRepo.setStatus(saved.id, { lastCheck: nowIso(), lastError: r.ok ? '' : r.message });
    res.json({ ok: r.ok, message: r.message, ...(r.ok ? {} : { error: r.message }) });
  }));

  // Settings
  router.get('/settings', requireAuth, wrap(async (req, res) => {
    res.json({ ok: true, settings: settingsRepo.get() });
  }));

  router.put('/settings', requireAuth, wrap(async (req, res) => {
    const merged = { ...settingsRepo.get(), ...(req.body?.settings || req.body || {}) };
    const err = validateFolders(merged);
    if (err) throw httpErr(400, err);
    if (merged.inputFolder) {
      const f = resolveFolders(merged);
      merged.processedFolder = merged.processedFolder || f.processed;
      merged.failedFolder = merged.failedFolder || f.failed;
    }
    const settings = settingsRepo.save(merged);
    applyIntakeSettings();
    apipLog('INFO', `Settings updated by ${req.user?.username || '?'}`);
    res.json({ ok: true, settings });
  }));

  // Intake control + logs
  router.get('/intake/status', requireAuth, wrap(async (req, res) => { res.json({ ok: true, ...getIntakeStatus(), status: getIntakeStatus() }); }));
  router.post('/intake/start', requireAuth, wrap(async (req, res) => { const s = startIntake(); res.json({ ok: true, ...s, status: s }); }));
  router.post('/intake/stop', requireAuth, wrap(async (req, res) => { const s = stopIntake(); res.json({ ok: true, ...s, status: s }); }));
  router.post('/intake/scan-now', requireAuth, wrap(async (req, res) => {
    const found = await scanNow();
    const s = getIntakeStatus();
    res.json({ ok: true, found, ...s, status: s });
  }));
  router.get('/logs', requireAuth, wrap(async (req, res) => { res.json({ ok: true, logs: getLogs() }); }));

  return router;
}
