/**
 * SAP matching helpers shared by the OCR register agents (Inward, Gate Pass):
 * business partners, items, warehouses, open purchase orders and duplicate checks.
 * All lookups are read-only against the Service Layer.
 */
import { similarity, nameSimilarity, vendorMatchScore, vendorSearchWords, containsAnyCase, keyWords } from './ocr-extract.mjs';

const q = s => String(s || '').replace(/'/g, "''");

// cardType: 'cSupplier' | 'cCustomer' | null (any partner)
export async function searchPartners(sap, text, cardType = null) {
  const esc = q(text).slice(0, 60);
  const base = [`Frozen eq 'tNO'`, cardType ? `CardType eq '${cardType}'` : null].filter(Boolean).join(' and ');
  const filter = esc ? `(CardCode eq '${esc}' or ${containsAnyCase(['CardName', 'CardCode'], esc)}) and ${base}` : base;
  try {
    const r = await sap.get('/BusinessPartners', { $select: 'CardCode,CardName,CardType,Currency', $filter: filter, $top: 20, $orderby: 'CardName asc' });
    return (Array.isArray(r.value) ? r.value : []).map(p => ({ code: p.CardCode, name: p.CardName, type: p.CardType, currency: p.Currency || null }));
  } catch { return []; }
}

// Best SAP partner for a name/code printed on a document → { partner, score } (partner null if none ≥ 0.5)
export async function matchPartner(sap, { name, code } = {}, cardType = null) {
  let cands = await searchPartners(sap, code || name || '', cardType);
  if (!cands.length && code && name) cands = await searchPartners(sap, name, cardType);
  if (!cands.length && name) {
    const seen = new Map();
    for (const w of vendorSearchWords(name)) (await searchPartners(sap, w, cardType)).forEach(c => seen.set(c.code, c));
    cands = [...seen.values()];
  }
  if (!cands.length) return { partner: null, score: 0 };
  const doc = { vendorName: name, vendorCode: code };
  let best = null, bestScore = -1;
  cands.forEach(c => {
    const s = vendorMatchScore({ CardCode: c.code, CardName: c.name }, doc, cands.length === 1);
    if (s > bestScore) { bestScore = s; best = c; }
  });
  return bestScore >= 0.5 ? { partner: best, score: bestScore } : { partner: null, score: 0 };
}

const ITEM_SEL = 'ItemCode,ItemName,InventoryUOM,PurchaseUnit,SalesUnit';
const itemOut = i => ({ code: i.ItemCode, name: i.ItemName, unit: i.InventoryUOM || i.PurchaseUnit || i.SalesUnit || '' });

export async function searchItems(sap, text) {
  const esc = q(text).slice(0, 40);
  try {
    const r = await sap.get('/Items', { $select: ITEM_SEL, $filter: esc ? containsAnyCase(['ItemCode', 'ItemName'], esc) : `Valid eq 'tYES'`, $top: 25, $orderby: 'ItemCode asc' });
    return (Array.isArray(r.value) ? r.value : []).map(itemOut);
  } catch { return []; }
}

// Best SAP item for a document line → { code, name, unit, score } or null
export async function matchItem(sap, { itemCode, description } = {}) {
  if (itemCode) {
    try {
      const it = await sap.get(`/Items('${q(itemCode)}')`, { $select: ITEM_SEL });
      if (it?.ItemCode) return { ...itemOut(it), score: 1 };
    } catch { /* fall back to description */ }
  }
  if (!description) return null;
  let cands = [];
  try {
    const r = await sap.get('/Items', { $select: ITEM_SEL, $filter: containsAnyCase(['ItemName'], q(description).slice(0, 40)), $top: 5 });
    cands = Array.isArray(r.value) ? r.value : [];
  } catch {}
  const words = keyWords(description, 3).map(q);
  for (let n = words.length; n >= 1 && !cands.length; n--) {
    try {
      const r = await sap.get('/Items', { $select: ITEM_SEL, $filter: words.slice(0, n).map(w => containsAnyCase(['ItemName'], w)).join(' and '), $top: 30 });
      cands = Array.isArray(r.value) ? r.value : [];
    } catch {}
  }
  let best = null, bestScore = 0;
  cands.forEach(c => {
    const s = Math.max(similarity(c.ItemName, description), nameSimilarity(c.ItemName, description));
    if (s > bestScore) { bestScore = s; best = c; }
  });
  return best && bestScore >= 0.3 ? { ...itemOut(best), score: bestScore } : null;
}

export async function getWarehouses(sap, cacheRepo, companyId) {
  let rows = cacheRepo?.getWarehouses ? cacheRepo.getWarehouses(companyId) : [];
  if (!rows.length) {
    try {
      const r = await sap.get('/Warehouses', { $select: 'WarehouseCode,WarehouseName', $filter: `Inactive eq 'tNO'`, $top: 200 });
      rows = Array.isArray(r.value) ? r.value : [];
    } catch { rows = []; }
  }
  return rows.map(w => ({ code: w.WarehouseCode, name: w.WarehouseName || '' }));
}

// Open purchase orders for a vendor, with their still-open lines.
export async function getOpenPOs(sap, cardCode) {
  if (!cardCode) return [];
  try {
    const r = await sap.get('/PurchaseOrders', {
      $select: 'DocEntry,DocNum,DocDate,DocDueDate,NumAtCard,DocumentLines',
      $filter: `CardCode eq '${q(cardCode)}' and DocumentStatus eq 'bost_Open' and Cancelled eq 'tNO'`,
      $orderby: 'DocDate desc', $top: 30,
    });
    return (Array.isArray(r.value) ? r.value : []).map(p => ({
      docEntry: p.DocEntry, docNum: p.DocNum, docDate: String(p.DocDate || '').slice(0, 10), dueDate: String(p.DocDueDate || '').slice(0, 10),
      numAtCard: p.NumAtCard || '',
      lines: (p.DocumentLines || []).filter(l => l.LineStatus !== 'bost_Close').map(l => ({
        lineNum: l.LineNum, itemCode: l.ItemCode, description: l.ItemDescription || '',
        openQty: Number(l.RemainingOpenQuantity ?? l.Quantity ?? 0), uom: l.UoMCode || l.MeasureUnit || '', warehouse: l.WarehouseCode || '',
      })),
    }));
  } catch (e) {
    console.error('[OCR-SAP-MATCH] getOpenPOs error:', e.message);
    return [];
  }
}

// Find a previously logged register entry that looks like the same document.
// keyFn(extractedOrForm) → normalised key string ('' = no key, never a duplicate).
export function findDuplicate(ocrDocumentsRepo, companyId, docType, keyFn, value) {
  const key = keyFn(value);
  if (!key) return null;
  const rows = ocrDocumentsRepo.list(companyId, docType, 500) || [];
  for (const r of rows) {
    const form = r.match_json && typeof r.match_json === 'object' ? r.match_json : null;
    const ext = r.extracted_json && typeof r.extracted_json === 'object' ? r.extracted_json : null;
    if ((form && keyFn(form) === key) || (ext && keyFn(ext) === key)) {
      return { id: r.id, uploadedAt: r.uploaded_at, uploadedBy: r.uploaded_by, fileName: r.file_name };
    }
  }
  return null;
}

export const normKey = (...parts) => parts.map(p => String(p || '').toLowerCase().replace(/[^a-z0-9]/g, '')).join('|');
