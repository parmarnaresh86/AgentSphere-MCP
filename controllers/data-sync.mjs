/**
 * Data Sync Controller — fetches SAP master data via Service Layer and caches it locally.
 * Routes:
 *   POST /api/sync/run              — sync all entities for active company
 *   POST /api/sync/run/:entity      — sync single entity
 *   GET  /api/sync/status           — last sync timestamps + counts
 *   GET  /api/cache/items           — search cached items
 *   GET  /api/cache/customers       — search cached customers
 *   GET  /api/cache/suppliers       — search cached suppliers
 *   GET  /api/cache/tax-codes       — all cached tax codes
 *   GET  /api/cache/warehouses      — all cached warehouses
 *   GET  /api/cache/uom             — all cached UOM
 *   GET  /api/cache/payment-terms   — all cached payment terms
 *   GET  /api/cache/currencies      — all cached currencies
 *   GET  /api/cache/item-groups     — all cached item groups
 *   GET  /api/cache/bp-groups       — all cached BP groups
 */
import { Router } from 'express';
import { cacheRepo, connRepo } from '../db.mjs';
import { isConnected as dbIsConnected, getActiveType as dbGetActiveType, getActiveConfig, executeSQL, tableRef } from '../db-connector.mjs';

// ── Direct-DB availability ──────────────────────────────────────────────────
// Sync prefers a live ODBC/direct DB connection (MSSQL or HANA) for this
// company — one round trip per entity, no Service Layer row-paging — and
// falls back to the SAP Service Layer whenever no DB connection is active
// or the direct query fails for any reason (unknown/renamed column, no
// permission, etc.) so a sync never breaks, it just loses the speed-up.
function dbAvailable() { return dbIsConnected(); }

// Quote an identifier HANA-style when needed; MSSQL/T-SQL columns are fine bare.
function col(name, isHana) { return isHana ? `"${name}"` : name; }
function boolFlag(raw) { return raw === 'Y' ? 'tYES' : 'tNO'; }

// HANA returns unquoted SELECT aliases in UPPERCASE (driver behaviour), while
// MSSQL preserves the case exactly as written — so every row from fetchDB must
// be read case-insensitively or HANA rows come back with all-undefined fields.
function pick(row, key) {
  return row[key] ?? row[key.toUpperCase()] ?? row[key.toLowerCase()];
}

// "Sync All" runs entities one at a time so a stuck/slow query (huge table,
// dropped connection, HANA driver hang) doesn't hold up the whole chain
// forever — every entity behind it would otherwise sit at "running" (looks
// like "pending" in the UI) with no way to know why. Cap each fetch so one
// bad entity times out and lets the rest of the queue proceed.
const FETCH_TIMEOUT_MS = 45_000;
function withTimeout(promise, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${FETCH_TIMEOUT_MS / 1000}s`)), FETCH_TIMEOUT_MS)),
  ]);
}

// ── SAP pagination helper ─────────────────────────────────────────────────────
// Discovers the effective page size SAP actually returns (may be less than $top
// due to server-side caps), then keeps paginating with $skip until 0 rows returned.
async function fetchAll(sap, endpoint, params = {}) {
  const all = [];
  let   skip = 0;
  let   pageSize = null; // actual rows-per-page as returned by SAP

  // First call — discover how many rows SAP will give per page
  for (const trySize of [200, 100, 50, 20]) {
    try {
      const res  = await sap.get(endpoint, { ...params, $top: trySize });
      const rows = Array.isArray(res) ? res : (res?.value ?? []);
      if (rows.length === 0) return all; // nothing in this endpoint
      all.push(...rows);
      // Use the ACTUAL count returned — SAP may cap lower than requested
      pageSize = rows.length;
      skip     = rows.length;
      break;
    } catch (e) {
      if (trySize === 20) throw e; // all page sizes failed
    }
  }

  if (!pageSize) return all;

  // Keep paginating until SAP returns 0 rows
  while (true) {
    const res  = await sap.get(endpoint, { ...params, $top: pageSize, $skip: skip });
    const rows = Array.isArray(res) ? res : (res?.value ?? []);
    if (!rows.length) break;
    all.push(...rows);
    skip += rows.length;
    if (all.length >= 100000) {
      console.warn(`[fetchAll] ${endpoint}: safety cap 100k reached, stopping`);
      break;
    }
  }

  return all;
}

// ── Sync definitions ─────────────────────────────────────────────────────────
// Each entity has fetchDB (direct MSSQL/HANA — tried first when a DB
// connection is active) and fetchSL (SAP Service Layer — always available,
// used whenever there's no DB connection or fetchDB throws).
const ENTITIES = {
  items: {
    label: 'Item Master',
    icon:  '📦',
    fetchSL: async (sap) => fetchAll(sap, '/Items', {
      $filter: "ItemType eq 'itItems'",
      $select: 'ItemCode,ItemName,ItemsGroupCode,SalesUnit,PurchaseUnit,SalesVATGroup,ManageBatchNumbers,ManageSerialNumbers,QuantityOnStock,Frozen',
    }),
    fetchDB: async () => {
      const cfg = getActiveConfig(), isHana = dbGetActiveType() === 'hana';
      const oitm = tableRef('OITM', cfg), oitb = tableRef('OITB', cfg);
      const c = n => col(n, isHana);
      const rows = await executeSQL(
        `SELECT i.${c('ItemCode')} AS ItemCode, i.${c('ItemName')} AS ItemName, i.${c('ItmsGrpCod')} AS ItemsGroupCode,
                g.${c('ItmsGrpNam')} AS ItemGroupName, i.${c('SalUnitMsr')} AS SalesUnit, i.${c('BuyUnitMsr')} AS PurchaseUnit,
                i.${c('InvntryUom')} AS InventoryUoM, i.${c('ManBtchNum')} AS ManBtchNumRaw, i.${c('ManSerNum')} AS ManSerNumRaw,
                i.${c('OnHand')} AS QuantityOnStock, i.${c('validFor')} AS ValidForRaw
         FROM ${oitm} i LEFT JOIN ${oitb} g ON i.${c('ItmsGrpCod')} = g.${c('ItmsGrpCod')}`
      );
      return rows.map(r => ({
        ItemCode: pick(r,'ItemCode'), ItemName: pick(r,'ItemName') || '', ItemsGroupCode: pick(r,'ItemsGroupCode'),
        ItemGroupName: pick(r,'ItemGroupName') || '', SalesUnit: pick(r,'SalesUnit') || '', PurchaseUnit: pick(r,'PurchaseUnit') || '',
        InventoryUoM: pick(r,'InventoryUoM') || '', ManageBatchNumbers: boolFlag(pick(r,'ManBtchNumRaw')), ManageSerialNumbers: boolFlag(pick(r,'ManSerNumRaw')),
        QuantityOnStock: pick(r,'QuantityOnStock') || 0, Frozen: pick(r,'ValidForRaw') === 'N' ? 'tYES' : 'tNO',
      })).filter(r => r.ItemCode);
    },
    save: (companyId, rows) => cacheRepo.upsertItems(companyId, rows),
  },
  customers: {
    label: 'Customer Master',
    icon:  '👤',
    fetchSL: async (sap) => fetchAll(sap, '/BusinessPartners', {
      $filter: "CardType eq 'cCustomer'",
      $select: 'CardCode,CardName,CardType,GroupCode,Currency,PayTermsGrpCode,Phone1,EmailAddress,City,Country,Frozen',
    }),
    fetchDB: async () => fetchBPsFromDB('C'),
    save: (companyId, rows) => cacheRepo.upsertBPs(companyId, rows),
  },
  suppliers: {
    label: 'Supplier Master',
    icon:  '🏭',
    fetchSL: async (sap) => fetchAll(sap, '/BusinessPartners', {
      $filter: "CardType eq 'cSupplier'",
      $select: 'CardCode,CardName,CardType,GroupCode,Currency,PayTermsGrpCode,Phone1,EmailAddress,City,Country,Frozen',
    }),
    fetchDB: async () => fetchBPsFromDB('S'),
    save: (companyId, rows) => cacheRepo.upsertBPs(companyId, rows),
  },
  tax_codes: {
    label: 'Tax Codes (VAT)',
    icon:  '🧾',
    fetchSL: async (sap) => {
      // Fetch without $select so we get the VatGroups sub-array with Rate
      const rows = await fetchAll(sap, '/VatGroups', {});
      return rows.map(v => {
        // Rate is in the VatGroups collection — take the latest active entry
        const slabs = v.VatGroups || [];
        const rate  = slabs.length ? Number(slabs[slabs.length - 1].Rate || slabs[0].Rate || 0) : 0;
        return { Code: v.Code, Name: v.Name, Category: v.Category, Rate: rate };
      });
    },
    fetchDB: async () => {
      const cfg = getActiveConfig(), isHana = dbGetActiveType() === 'hana';
      const ovtg = tableRef('OVTG', cfg);
      const c = n => col(n, isHana);
      const rows = await executeSQL(`SELECT ${c('Code')} AS Code, ${c('Name')} AS Name, ${c('Type')} AS Category, ${c('Rate')} AS Rate FROM ${ovtg}`);
      return rows.map(r => ({ Code: pick(r,'Code'), Name: pick(r,'Name') || '', Category: pick(r,'Category') || '', Rate: Number(pick(r,'Rate') || 0) })).filter(r => r.Code);
    },
    save: (companyId, rows) => cacheRepo.upsertTaxCodes(companyId, rows),
  },
  warehouses: {
    label: 'Warehouses',
    icon:  '🏪',
    fetchSL: async (sap) => fetchAll(sap, '/Warehouses', { $select: 'WarehouseCode,WarehouseName,Inactive' }),
    fetchDB: async () => {
      const cfg = getActiveConfig(), isHana = dbGetActiveType() === 'hana';
      const owhs = tableRef('OWHS', cfg);
      const c = n => col(n, isHana);
      const rows = await executeSQL(`SELECT ${c('WhsCode')} AS WarehouseCode, ${c('WhsName')} AS WarehouseName, ${c('Inactive')} AS InactiveRaw FROM ${owhs}`);
      return rows.map(r => ({ WarehouseCode: pick(r,'WarehouseCode'), WarehouseName: pick(r,'WarehouseName') || '', Inactive: pick(r,'InactiveRaw') === 'Y' ? 'tYES' : 'tNO' })).filter(r => r.WarehouseCode);
    },
    save: (companyId, rows) => cacheRepo.upsertWarehouses(companyId, rows),
  },
  uom: {
    label: 'Units of Measure',
    icon:  '📐',
    fetchSL: async (sap) => fetchAll(sap, '/UnitOfMeasurements', { $select: 'AbsEntry,Code,Name' }),
    fetchDB: async () => {
      const cfg = getActiveConfig(), isHana = dbGetActiveType() === 'hana';
      const ouvt = tableRef('OUVT', cfg);
      const c = n => col(n, isHana);
      const rows = await executeSQL(`SELECT ${c('UomEntry')} AS AbsEntry, ${c('UomCode')} AS Code, ${c('UomName')} AS Name FROM ${ouvt}`);
      return rows.map(r => ({ AbsEntry: pick(r,'AbsEntry'), Code: pick(r,'Code') || '', Name: pick(r,'Name') || '' })).filter(r => r.AbsEntry !== undefined && r.AbsEntry !== null);
    },
    save: (companyId, rows) => cacheRepo.upsertUOM(companyId, rows),
  },
  payment_terms: {
    label: 'Payment Terms',
    icon:  '💳',
    fetchSL: async (sap) => fetchAll(sap, '/PaymentTermsTypes', { $select: 'GroupNumber,PaymentTermsGroupName' }),
    fetchDB: async () => {
      const cfg = getActiveConfig(), isHana = dbGetActiveType() === 'hana';
      const octg = tableRef('OCTG', cfg);
      const c = n => col(n, isHana);
      const rows = await executeSQL(`SELECT ${c('GroupNum')} AS GroupNumber, ${c('PymntGroup')} AS PaymentTermsGroupName FROM ${octg}`);
      return rows.map(r => ({ GroupNumber: pick(r,'GroupNumber'), PaymentTermsGroupName: pick(r,'PaymentTermsGroupName') || '' })).filter(r => r.GroupNumber !== undefined && r.GroupNumber !== null);
    },
    save: (companyId, rows) => cacheRepo.upsertPaymentTerms(companyId, rows),
  },
  currencies: {
    label: 'Currencies',
    icon:  '💱',
    fetchSL: async (sap) => fetchAll(sap, '/Currencies', { $select: 'Code,Name' }),
    fetchDB: async () => {
      const cfg = getActiveConfig(), isHana = dbGetActiveType() === 'hana';
      const ocur = tableRef('OCUR', cfg);
      const c = n => col(n, isHana);
      const rows = await executeSQL(`SELECT ${c('CurrCode')} AS Code, ${c('CurrName')} AS Name FROM ${ocur}`);
      return rows.map(r => ({ Code: pick(r,'Code'), Name: pick(r,'Name') || '' })).filter(r => r.Code);
    },
    save: (companyId, rows) => cacheRepo.upsertCurrencies(companyId, rows),
  },
  item_groups: {
    label: 'Item Groups',
    icon:  '🗂️',
    fetchSL: async (sap) => fetchAll(sap, '/ItemGroups', { $select: 'Number,GroupName' }),
    fetchDB: async () => {
      const cfg = getActiveConfig(), isHana = dbGetActiveType() === 'hana';
      const oitb = tableRef('OITB', cfg);
      const c = n => col(n, isHana);
      const rows = await executeSQL(`SELECT ${c('ItmsGrpCod')} AS Number, ${c('ItmsGrpNam')} AS GroupName FROM ${oitb}`);
      return rows.map(r => ({ Number: pick(r,'Number'), GroupName: pick(r,'GroupName') || '' })).filter(r => r.Number !== undefined && r.Number !== null);
    },
    save: (companyId, rows) => cacheRepo.upsertItemGroups(companyId, rows),
  },
  bp_groups: {
    label: 'BP Groups',
    icon:  '👥',
    fetchSL: async (sap) => fetchAll(sap, '/BusinessPartnerGroups', { $select: 'Code,Name' }),
    fetchDB: async () => {
      const cfg = getActiveConfig(), isHana = dbGetActiveType() === 'hana';
      const ocrg = tableRef('OCRG', cfg);
      const c = n => col(n, isHana);
      const rows = await executeSQL(`SELECT ${c('GroupCode')} AS Code, ${c('GroupName')} AS Name FROM ${ocrg}`);
      return rows.map(r => ({ Code: pick(r,'Code'), Name: pick(r,'Name') || '' })).filter(r => r.Code !== undefined && r.Code !== null);
    },
    save: (companyId, rows) => cacheRepo.upsertBPGroups(companyId, rows),
  },
};

// ── OCRD direct fetch — shared by customers/suppliers ────────────────────────
async function fetchBPsFromDB(cardType) {
  const cfg = getActiveConfig(), isHana = dbGetActiveType() === 'hana';
  const ocrd = tableRef('OCRD', cfg);
  const c = n => col(n, isHana);
  const rows = await executeSQL(
    `SELECT ${c('CardCode')} AS CardCode, ${c('CardName')} AS CardName, ${c('CardType')} AS CardType,
            ${c('GroupCode')} AS GroupCode, ${c('Currency')} AS Currency, ${c('PayTermsGrpCode')} AS PayTermsGrpCode,
            ${c('Phone1')} AS Phone1, ${c('E_Mail')} AS EmailAddress, ${c('City')} AS City, ${c('Country')} AS Country,
            ${c('Frozen')} AS FrozenRaw
     FROM ${ocrd} WHERE ${c('CardType')} = '${cardType}'`
  );
  return rows.map(r => ({
    CardCode: pick(r,'CardCode'), CardName: pick(r,'CardName') || '', CardType: cardType === 'C' ? 'cCustomer' : 'cSupplier',
    GroupCode: pick(r,'GroupCode'), Currency: pick(r,'Currency') || '', PayTermsGrpCode: pick(r,'PayTermsGrpCode'),
    Phone1: pick(r,'Phone1') || '', EmailAddress: pick(r,'EmailAddress') || '', City: pick(r,'City') || '', Country: pick(r,'Country') || '',
    Frozen: pick(r,'FrozenRaw') === 'Y' ? 'tYES' : 'tNO',
  })).filter(r => r.CardCode);
}

// Track in-progress syncs to avoid duplicates
const _running = new Set();

// ── Router factory ─────────────────────────────────────────────────────────────
export function createDataSyncRouter({ requireAuth, getActiveSap }) {

  function getCompanyId() {
    const conn = connRepo.getActive();
    return conn ? conn.company : 'default';
  }

  async function runSync(sap, companyId, entityKey, res, streaming = false) {
    const def = ENTITIES[entityKey];
    if (!def) return { error: `Unknown entity: ${entityKey}` };
    const lockKey = `${companyId}:${entityKey}`;
    if (_running.has(lockKey)) return { error: 'Sync already running for this entity' };
    _running.add(lockKey);
    try {
      let rows = null, source = 'sl';
      if (dbAvailable()) {
        try {
          rows = await withTimeout(def.fetchDB(), `${entityKey} direct DB fetch`);
          source = dbGetActiveType();
        } catch (dbErr) {
          console.warn(`[data-sync] ${entityKey}: direct DB fetch failed (${dbErr.message}), falling back to Service Layer`);
          rows = null;
        }
      }
      if (rows === null) rows = await withTimeout(def.fetchSL(sap), `${entityKey} Service Layer fetch`);
      def.save(companyId, rows);
      console.log(`[data-sync] ${entityKey}: synced ${rows.length} rows via ${source === 'sl' ? 'Service Layer' : 'direct DB (' + source + ')'}`);
      cacheRepo.logSync(companyId, entityKey, 'ok', rows.length);
      return { entity: entityKey, label: def.label, count: rows.length, status: 'ok', source };
    } catch(e) {
      cacheRepo.logSync(companyId, entityKey, 'error', 0, e.message);
      return { entity: entityKey, label: def.label, count: 0, status: 'error', error: e.message };
    } finally {
      _running.delete(lockKey);
    }
  }

  const router = Router();

  // Any route below that reads/writes SQLite directly without its own
  // try/catch would otherwise crash to Express's default HTML error page on
  // a DB fault (e.g. "database disk image is malformed") — the frontend's
  // res.json() call then chokes on the leading "<" of that HTML with
  // "Unexpected token '<'", masking the real error. Wrap every such handler
  // so a DB fault always comes back as a proper JSON error instead.
  const safe = (fn) => (req, res) => {
    try { fn(req, res); }
    catch (e) { res.status(500).json({ error: e.message }); }
  };

  // ── Sync status ──────────────────────────────────────────────────────────────
  router.get('/sync/status', requireAuth, safe((req, res) => {
    const companyId = getCompanyId();
    const lastSync  = cacheRepo.getLastSync(companyId);
    const syncMap   = {};
    lastSync.forEach(r => { syncMap[r.entity] = r; });
    const result = Object.entries(ENTITIES).map(([key, def]) => ({
      key,
      label:       def.label,
      icon:        def.icon,
      status:      syncMap[key]?.status || 'never',
      count:       syncMap[key]?.record_count || 0,
      synced_at:   syncMap[key]?.synced_at || null,
      error:       syncMap[key]?.error_msg || '',
      running:     _running.has(`${companyId}:${key}`),
    }));
    res.json({ companyId, entities: result });
  }));

  // ── Sync single entity (async background job) ────────────────────────────────
  router.post('/sync/run/:entity', requireAuth, (req, res) => {
    try {
      const sap       = getActiveSap();
      const companyId = getCompanyId();
      const entity    = req.params.entity;
      if (!ENTITIES[entity]) return res.json({ ok:false, error:`Unknown entity: ${entity}` });
      const lockKey   = `${companyId}:${entity}`;
      if (_running.has(lockKey)) return res.json({ ok:true, running:true, message:'Already syncing' });
      // Mark as running in DB immediately
      cacheRepo.logSync(companyId, entity, 'running', 0);
      // Run in background — do NOT await
      runSync(sap, companyId, entity).catch(()=>{});
      res.json({ ok:true, started:true, entity, message:`Syncing ${ENTITIES[entity].label}…` });
    } catch(e) { res.json({ ok:false, error: e.message }); }
  });

  // ── Sync all entities (async background) ─────────────────────────────────────
  // Entities are marked 'running' one at a time, right as the sequential loop
  // actually reaches each of them — NOT all upfront. Marking everything
  // 'running' immediately (the old behaviour) made every entity's Sync button
  // look busy and disabled for the whole batch, even entities still waiting in
  // the queue that hadn't started yet — the user couldn't manually trigger any
  // individual entity (Business Partner, Item Master, etc.) until the entire
  // batch finished. Now only the entity actually in flight is locked.
  router.post('/sync/run', requireAuth, (req, res) => {
    try {
      const sap       = getActiveSap();
      const companyId = getCompanyId();
      const keys      = Object.keys(ENTITIES).filter(k => !_running.has(`${companyId}:${k}`));
      // Chain entities sequentially in background
      (async () => {
        for (const k of keys) {
          if (_running.has(`${companyId}:${k}`)) continue; // picked up individually in the meantime
          cacheRepo.logSync(companyId, k, 'running', 0);
          await runSync(sap, companyId, k).catch(()=>{});
        }
      })();
      res.json({ ok:true, started:true, count: keys.length, message:`Starting sync for ${keys.length} entities…` });
    } catch(e) { res.json({ ok:false, error: e.message }); }
  });

  // ── Cache read APIs ───────────────────────────────────────────────────────────
  // top=0 or top=all → return every stored row (no limit). Default 20 for autocomplete.
  function resolveTop(query, defaultTop = 20) {
    const raw = query.top;
    if (raw === '0' || raw === 'all') return 0; // 0 = no LIMIT in SQLite
    const n = parseInt(raw);
    return isNaN(n) ? defaultTop : Math.max(1, n);
  }

  router.get('/cache/items', requireAuth, safe((req, res) => {
    const companyId = getCompanyId();
    const q   = (req.query.q || '').trim();
    const top = resolveTop(req.query);
    res.json(cacheRepo.searchItems(companyId, q, top));
  }));

  router.get('/cache/customers', requireAuth, safe((req, res) => {
    const companyId = getCompanyId();
    const q   = (req.query.q || '').trim();
    res.json(_searchBPs(companyId, q, 'cCustomer', resolveTop(req.query)));
  }));

  router.get('/cache/suppliers', requireAuth, safe((req, res) => {
    const companyId = getCompanyId();
    const q   = (req.query.q || '').trim();
    res.json(_searchBPs(companyId, q, 'cSupplier', resolveTop(req.query)));
  }));

  router.get('/cache/business-partners', requireAuth, safe((req, res) => {
    const companyId = getCompanyId();
    const q    = (req.query.q || '').trim();
    const type = req.query.type || '';
    res.json(_searchBPs(companyId, q, type, resolveTop(req.query)));
  }));

  router.get('/cache/tax-codes',       requireAuth, safe((req, res) => res.json(cacheRepo.getTaxCodes(getCompanyId()))));
  router.get('/cache/warehouses',      requireAuth, safe((req, res) => res.json(cacheRepo.getWarehouses(getCompanyId()))));
  router.get('/cache/uom',             requireAuth, safe((req, res) => res.json(cacheRepo.getUOM(getCompanyId()))));
  router.get('/cache/payment-terms',   requireAuth, safe((req, res) => res.json(cacheRepo.getPaymentTerms(getCompanyId()))));
  router.get('/cache/currencies',      requireAuth, safe((req, res) => res.json(cacheRepo.getCurrencies(getCompanyId()))));
  router.get('/cache/item-groups',     requireAuth, safe((req, res) => res.json(cacheRepo.getItemGroups(getCompanyId()))));
  router.get('/cache/bp-groups',       requireAuth, safe((req, res) => res.json(cacheRepo.getBPGroups(getCompanyId()))));

  // ── Cache stats — exact row counts per entity stored in hanny.db ─────────────
  router.get('/cache/stats', requireAuth, safe((req, res) => {
    const companyId = getCompanyId();
    res.json(cacheRepo.getStats(companyId));
  }));

  // ── Full export of any cached entity (for future use / reporting) ─────────────
  // GET /api/cache/export/:entity  — returns ALL rows for entity in JSON
  // Supported: items, customers, suppliers, tax-codes, warehouses, uom,
  //            payment-terms, currencies, item-groups, bp-groups
  router.get('/cache/export/:entity', requireAuth, safe((req, res) => {
    const companyId = getCompanyId();
    const entity    = req.params.entity;
    const format    = req.query.format || 'json'; // json | csv
    let rows;
    switch (entity) {
      case 'items':         rows = cacheRepo.searchItems(companyId, '', 0); break;
      case 'customers':     rows = _searchBPs(companyId, '', 'cCustomer', 0); break;
      case 'suppliers':     rows = _searchBPs(companyId, '', 'cSupplier', 0); break;
      case 'tax-codes':     rows = cacheRepo.getTaxCodes(companyId); break;
      case 'warehouses':    rows = cacheRepo.getWarehouses(companyId); break;
      case 'uom':           rows = cacheRepo.getUOM(companyId); break;
      case 'payment-terms': rows = cacheRepo.getPaymentTerms(companyId); break;
      case 'currencies':    rows = cacheRepo.getCurrencies(companyId); break;
      case 'item-groups':   rows = cacheRepo.getItemGroups(companyId); break;
      case 'bp-groups':     rows = cacheRepo.getBPGroups(companyId); break;
      default: return res.status(400).json({ error: `Unknown entity: ${entity}` });
    }
    if (format === 'csv' && rows.length > 0) {
      const keys = Object.keys(rows[0]);
      const csv  = [keys.join(','), ...rows.map(r => keys.map(k => `"${String(r[k]||'').replace(/"/g,'""')}"`).join(','))].join('\n');
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="${companyId}_${entity}.csv"`);
      return res.send(csv);
    }
    res.json({ company_id: companyId, entity, count: rows.length, rows });
  }));

  // Entity list (for UI)
  router.get('/sync/entities', requireAuth, safe((req, res) => {
    res.json(Object.entries(ENTITIES).map(([key, d]) => ({ key, label: d.label, icon: d.icon })));
  }));

  // ── Wipe cached data ──────────────────────────────────────────────────────────
  // Deletes cached rows + sync history for one entity — status returns to "Never
  // synced" so the next Sync pulls a completely fresh copy from SAP.
  router.post('/sync/wipe/:entity', requireAuth, (req, res) => {
    try {
      const companyId = getCompanyId();
      const entity     = req.params.entity;
      if (!ENTITIES[entity]) return res.json({ ok:false, error:`Unknown entity: ${entity}` });
      if (_running.has(`${companyId}:${entity}`)) return res.json({ ok:false, error:'Cannot wipe while this entity is syncing' });
      cacheRepo.clearEntity(companyId, entity);
      res.json({ ok:true, entity });
    } catch(e) { res.json({ ok:false, error: e.message }); }
  });

  // Wipe ALL cached master data for the active company
  router.post('/sync/wipe', requireAuth, (req, res) => {
    try {
      const companyId = getCompanyId();
      if (Object.keys(ENTITIES).some(k => _running.has(`${companyId}:${k}`)))
        return res.json({ ok:false, error:'Cannot wipe while a sync is running' });
      cacheRepo.clearCompany(companyId);
      res.json({ ok:true });
    } catch(e) { res.json({ ok:false, error: e.message }); }
  });

  // ── Startup safety: an entity whose last sync attempt never finished (e.g.
  //    the server process was restarted mid-sync) would otherwise show
  //    status='running' forever — nothing left in memory to ever update it —
  //    which permanently disables that entity's Sync button in the UI even
  //    though nothing is actually running. Correct any such rows on boot.
  try {
    const stale = db.prepare(`
      SELECT c.company_id, c.entity FROM cache_sync_log c
      WHERE c.status = 'running'
        AND c.id = (SELECT MAX(id) FROM cache_sync_log WHERE company_id = c.company_id AND entity = c.entity)
    `).all();
    stale.forEach(({ company_id, entity }) => {
      cacheRepo.logSync(company_id, entity, 'error', 0, 'Interrupted by server restart — click Sync to retry');
    });
    if (stale.length) console.log(`[data-sync] cleared ${stale.length} stale "running" sync status row(s) left over from a previous server session`);
  } catch (e) { console.warn('[data-sync] stale sync cleanup failed:', e.message); }

  return router;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
import db from '../db.mjs';

// top=0 → no LIMIT (return all stored rows)
function _searchBPs(companyId, q, type, top = 20) {
  const like    = `%${q}%`;
  const noLimit = !top;
  if (type) {
    const sql = `SELECT * FROM cache_business_partners
      WHERE company_id=? AND CardType=? AND Frozen='tNO'
      AND (CardCode LIKE ? OR CardName LIKE ?) ORDER BY CardName${noLimit ? '' : ' LIMIT ?'}`;
    return noLimit
      ? db.prepare(sql).all(companyId, type, like, like)
      : db.prepare(sql).all(companyId, type, like, like, top);
  }
  const sql = `SELECT * FROM cache_business_partners
    WHERE company_id=? AND Frozen='tNO'
    AND (CardCode LIKE ? OR CardName LIKE ?) ORDER BY CardName${noLimit ? '' : ' LIMIT ?'}`;
  return noLimit
    ? db.prepare(sql).all(companyId, like, like)
    : db.prepare(sql).all(companyId, like, like, top);
}
