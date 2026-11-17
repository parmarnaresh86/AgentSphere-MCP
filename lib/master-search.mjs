/**
 * Item / vendor search — one search for every module.
 *
 *  - Not case-sensitive: "steel pipe", "STEEL PIPE" and "Steel Pipe" find the same rows.
 *  - Matches the code or the name, any keyword in any order: "pipe steel" finds "Steel Pipe 2in".
 *  - Best matches first: exact code, code starts with, name starts with, a word starts with, then contains.
 *
 * Source, fastest first:
 *   1. the local master-data cache (cache_items / cache_business_partners, SQLite LIKE is not case-sensitive)
 *   2. the full master list read once over the direct DB connection, or from the Service Layer,
 *      kept for a few minutes and filtered here.
 * When the cache finds nothing (e.g. a brand-new item not synced yet) the live list is searched too.
 */
import db, { connRepo, dbConnRepo } from '../db.mjs';
import { executeSQL, isConnected, getActiveConfig, tableRef, connectDB } from '../db-connector.mjs';

const LIST_TTL_MS = 10 * 60 * 1000;
const LIST_CAP = 50000;
const _lists = new Map();   // `${company}|items|vendors` → { at, rows }

function companyId() { return connRepo.getActive()?.company || 'default'; }
function rowsOf(r) { return Array.isArray(r) ? r : (r?.rows || r?.recordset || []); }
const keywords = q => String(q || '').toLowerCase().split(/\s+/).filter(Boolean);

export async function dbUp() {
  if (!isConnected()) {
    const saved = dbConnRepo.getActive();
    if (saved) { try { await connectDB(saved); } catch { /* fall back to the Service Layer */ } }
  }
  return isConnected();
}

async function fetchAllPages(sap, endpoint, params, cap) {
  const all = [];
  while (all.length < cap) {
    const r = await sap.get(endpoint, { ...params, $skip: all.length });
    const rows = Array.isArray(r?.value) ? r.value : [];
    if (!rows.length) break;
    all.push(...rows);
  }
  return all;
}

// Rank of a matching row (lower = better); null when a keyword is missing.
function rank(code, name, words, q) {
  const c = String(code || '').toLowerCase(), n = String(name || '').toLowerCase();
  if (!words.every(w => c.includes(w) || n.includes(w))) return null;
  const ql = q.toLowerCase();
  if (c === ql) return 0;
  if (c.startsWith(ql)) return 1;
  if (n.startsWith(ql)) return 2;
  if (n.split(/[^a-z0-9]+/).some(t => t.startsWith(words[0]))) return 3;
  return 4;
}

function pick(rows, q, top, codeOf, nameOf) {
  const words = keywords(q);
  if (!words.length) return rows.slice(0, top);
  return rows
    .map(r => ({ r, k: rank(codeOf(r), nameOf(r), words, q.trim()) }))
    .filter(x => x.k !== null)
    .sort((a, b) => a.k - b.k || String(nameOf(a.r)).localeCompare(String(nameOf(b.r))))
    .slice(0, top)
    .map(x => x.r);
}

// LIKE conditions for the cache: every keyword in the code or the name.
function likeWhere(words, codeCol, nameCol) {
  const esc = w => `%${w.replace(/[\\%_]/g, m => '\\' + m)}%`;
  return {
    sql: words.map(() => `(${codeCol} LIKE ? ESCAPE '\\' OR ${nameCol} LIKE ? ESCAPE '\\')`).join(' AND '),
    args: words.flatMap(w => [esc(w), esc(w)]),
  };
}

async function memoList(key, load) {
  const hit = _lists.get(key);
  if (hit && Date.now() - hit.at < LIST_TTL_MS) return hit.rows;
  const rows = await load();
  _lists.set(key, { at: Date.now(), rows });
  return rows;
}

/** Item's last purchase price (OITM.LastPurPrc) over the direct DB connection; 0 when unknown. */
export async function lastPurchasePrice(itemCode) {
  if (!(await dbUp())) return 0;
  try {
    const rows = rowsOf(await executeSQL(`SELECT "LastPurPrc" FROM ${tableRef('OITM', getActiveConfig())} WHERE "ItemCode" = '${String(itemCode).replace(/'/g, "''")}'`));
    return Number(rows[0]?.LastPurPrc || 0);
  } catch (e) {
    console.error('[master-search] LastPurPrc', e.message);
    return 0;
  }
}

/** Forget the in-memory lists (e.g. after a master-data sync). */
export function clearMasterSearch() { _lists.clear(); }

// ── Items ──────────────────────────────────────────────────────────────────────
// Rows: { ItemCode, ItemName, QuantityOnStock, MinInventory, PurchaseUnit, SalesUnit }

function cacheItems(q, top) {
  const cid = companyId();
  const words = keywords(q);
  const w = likeWhere(words, 'ItemCode', 'ItemName');
  const rows = db.prepare(`SELECT ItemCode, ItemName, QuantityOnStock, PurchaseUnit, SalesUnit FROM cache_items
    WHERE company_id=? AND Frozen='tNO'${words.length ? ` AND ${w.sql}` : ''} ORDER BY ItemName LIMIT ?`)
    .all(cid, ...w.args, words.length ? 2000 : top);
  return rows.map(r => ({ ...r, MinInventory: 0 }));
}

async function liveItems(sap) {
  return memoList(`${companyId()}|items`, async () => {
    if (await dbUp()) {
      try {
        const rows = rowsOf(await executeSQL(`SELECT "ItemCode", "ItemName", "OnHand", "MinLevel", "BuyUnitMsr", "SalUnitMsr"
          FROM ${tableRef('OITM', getActiveConfig())} WHERE "frozenFor" = 'N' AND "ItemType" = 'I'`));
        return rows.map(r => ({ ItemCode: String(r.ItemCode), ItemName: String(r.ItemName || ''), QuantityOnStock: Number(r.OnHand || 0),
          MinInventory: Number(r.MinLevel || 0), PurchaseUnit: r.BuyUnitMsr || '', SalesUnit: r.SalUnitMsr || '' }));
      } catch (e) { console.error('[master-search] OITM', e.message); }
    }
    return fetchAllPages(sap, '/Items', {
      $select: 'ItemCode,ItemName,QuantityOnStock,MinInventory,PurchaseUnit,SalesUnit',
      $filter: "ItemType eq 'itItems' and Frozen eq 'tNO'", $orderby: 'ItemName asc',
    }, LIST_CAP);
  });
}

/** Items matching q (code or name, not case-sensitive, any keyword order). */
export async function searchItems(sap, q, { top = 20 } = {}) {
  q = String(q || '').trim();
  try {
    const cached = pick(cacheItems(q, top), q, top, r => r.ItemCode, r => r.ItemName);
    if (cached.length) return cached;
  } catch (e) { console.error('[master-search] item cache', e.message); }
  try {
    return pick(await liveItems(sap), q, top, r => r.ItemCode, r => r.ItemName);
  } catch (e) {
    console.error('[master-search] item search', e.message);
    return [];
  }
}

// ── Business partners (vendors / customers) ───────────────────────────────────
// Rows: { CardCode, CardName }

const BP_TYPES = { cSupplier: 'S', cCustomer: 'C' };

function cachePartners(cardType, q, top) {
  const words = keywords(q);
  const w = likeWhere(words, 'CardCode', 'CardName');
  return db.prepare(`SELECT CardCode, CardName FROM cache_business_partners
    WHERE company_id=? AND CardType=? AND Frozen='tNO'${words.length ? ` AND ${w.sql}` : ''} ORDER BY CardName LIMIT ?`)
    .all(companyId(), cardType, ...w.args, words.length ? 2000 : top);
}

async function livePartners(sap, cardType) {
  return memoList(`${companyId()}|bp|${cardType}`, async () => {
    if (await dbUp()) {
      try {
        const rows = rowsOf(await executeSQL(`SELECT "CardCode", "CardName" FROM ${tableRef('OCRD', getActiveConfig())} WHERE "CardType" = '${BP_TYPES[cardType]}' AND "frozenFor" = 'N'`));
        return rows.map(r => ({ CardCode: String(r.CardCode), CardName: String(r.CardName || '') }));
      } catch (e) { console.error('[master-search] OCRD', e.message); }
    }
    return fetchAllPages(sap, '/BusinessPartners', {
      $select: 'CardCode,CardName', $filter: `CardType eq '${cardType}' and Frozen eq 'tNO'`, $orderby: 'CardName asc',
    }, LIST_CAP);
  });
}

/** Business partners of cardType ('cSupplier' | 'cCustomer') matching q — code or name, not case-sensitive, any keyword order. */
export async function searchPartners(sap, q, { cardType = 'cSupplier', top = 20 } = {}) {
  if (!BP_TYPES[cardType]) throw new Error('unknown card type ' + cardType);
  q = String(q || '').trim();
  try {
    const cached = pick(cachePartners(cardType, q, top), q, top, r => r.CardCode, r => r.CardName);
    if (cached.length) return cached;
  } catch (e) { console.error('[master-search] partner cache', e.message); }
  try {
    return pick(await livePartners(sap, cardType), q, top, r => r.CardCode, r => r.CardName);
  } catch (e) {
    console.error('[master-search] partner search', e.message);
    return [];
  }
}

/** Vendors matching q (code or name, not case-sensitive, any keyword order). */
export function searchVendors(sap, q, { top = 20 } = {}) {
  return searchPartners(sap, q, { cardType: 'cSupplier', top });
}
