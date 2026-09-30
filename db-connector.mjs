/**
 * db-connector.mjs
 * Direct database connection for SAP B1 — supports SQL Server (mssql) and HANA (hdb)
 * Used when DB Direct engine is selected in chat.
 */
import sql  from "mssql";
import hdb  from "hdb";

let _mssqlPool   = null;
let _hanaClient  = null;
let _activeType  = null;  // 'mssql' | 'hana'
let _activeConfig = null;

// ── SAP B1 Schema Context — fed to AI for SQL generation ────────────────────
export const SAP_B1_SCHEMA = `
SAP Business One key tables (same for MSSQL and HANA):

SALES & QUOTATIONS:
  OQUT(DocEntry,DocNum,CardCode,CardName,SlpCode,DocDate,DocDueDate,DocTotal,GrossProfit,DocStatus,Comments)
  QUT1(DocEntry,LineNum,ItemCode,Dscription,Quantity,Price,LineTotal,WhsCode,GrssProfit)
  ORDR(DocEntry,DocNum,CardCode,CardName,SlpCode,DocDate,DocDueDate,DocTotal,GrossProfit,DocStatus,Comments)
  RDR1(DocEntry,LineNum,ItemCode,Dscription,Quantity,Price,LineTotal,WhsCode,GrssProfit)

AR INVOICES & DELIVERY:
  OINV(DocEntry,DocNum,CardCode,CardName,SlpCode,DocDate,DocDueDate,DocTotal,GrossProfit,PaidToDate,DocStatus)
  INV1(DocEntry,LineNum,ItemCode,Dscription,Quantity,Price,LineTotal,WhsCode,GrssProfit)
  ODLN(DocEntry,DocNum,CardCode,CardName,DocDate,DocTotal,DocStatus)
  DLN1(DocEntry,LineNum,ItemCode,Dscription,Quantity,Price,LineTotal,WhsCode)
  ORIN(DocEntry,DocNum,CardCode,CardName,DocDate,DocTotal,DocStatus)
  RIN1(DocEntry,LineNum,ItemCode,Dscription,Quantity,LineTotal,WhsCode)

PURCHASING:
  OPQT(DocEntry,DocNum,CardCode,CardName,DocDate,DocTotal,DocStatus)
  PQT1(DocEntry,LineNum,ItemCode,Dscription,Quantity,Price,LineTotal,WhsCode)
  OPOR(DocEntry,DocNum,CardCode,CardName,DocDate,DocDueDate,DocTotal,DocStatus)
  POR1(DocEntry,LineNum,ItemCode,Dscription,Quantity,Price,LineTotal,WhsCode)
  OPDN(DocEntry,DocNum,CardCode,CardName,DocDate,DocTotal,DocStatus)
  PDN1(DocEntry,LineNum,ItemCode,Dscription,Quantity,Price,LineTotal,WhsCode)
  OPCH(DocEntry,DocNum,CardCode,CardName,DocDate,DocDueDate,DocTotal,DocStatus)
  PCH1(DocEntry,LineNum,ItemCode,Dscription,Quantity,Price,LineTotal,WhsCode)

INVENTORY:
  OITM(ItemCode,ItemName,ItmsGrpCod,InvntItem,SellItem,PrchseItem,OnHand,IsCommited,OnOrder,LastPurPrc,AvgPrice)
  OITW(ItemCode,WhsCode,OnHand,IsCommited,OnOrder)
  OWHS(WhsCode,WhsName,Street,City)
  OITB(ItmsGrpCod,ItmsGrpNam)

BUSINESS PARTNERS:
  OCRD(CardCode,CardName,CardType,GroupCode,Phone1,E_Mail,CntctPrsn,Balance,SlpCode,Territory)
  OSLP(SlpCode,SlpName,Memo,Commission,Phone,Email)
  OCRG(GroupCode,GroupName,GroupType)

FINANCE:
  OJDT(TransId,TransType,RefDate,Memo,Ref1,Ref2,Ref3,CreatedBy)
  JDT1(TransId,Line_ID,Account,Debit,Credit,SYSDebit,SYSCredit,FCDebit,FCCredit,RefDate,LineMemo,ContraAct)
  OACT(AcctCode,AcctName,GroupMask,ActType,Blocked,CurrTotal,LocTotal)

STATUS CODES: DocStatus = 'O' (Open) | 'C' (Closed) | 'W' (Cancelled)
CardType: 'C' (Customer) | 'S' (Supplier) | 'L' (Lead)
`;

// ── MSSQL ────────────────────────────────────────────────────────────────────
async function connectMSSQL(cfg) {
  if (_mssqlPool) { try { await _mssqlPool.close(); } catch {} _mssqlPool = null; }
  _mssqlPool = await sql.connect({
    server:   cfg.host,
    port:     cfg.port || 1433,
    database: cfg.database,
    user:     cfg.username,
    password: cfg.password,
    options: {
      encrypt:                false,
      trustServerCertificate: true,
      enableArithAbort:       true,
    },
    connectionTimeout: 15000,
    requestTimeout:    60000,
  });
  _activeType   = "mssql";
  _activeConfig = cfg;
  return _mssqlPool;
}

async function executeMSSQL(querySql) {
  if (!_mssqlPool) throw new Error("No MSSQL connection active.");
  const result = await _mssqlPool.request().query(querySql);
  return result.recordset ?? [];
}

// ── HANA ─────────────────────────────────────────────────────────────────────
async function connectHANA(cfg) {
  if (_hanaClient) { try { _hanaClient.disconnect(); } catch {} _hanaClient = null; }
  return new Promise((resolve, reject) => {
    const client = hdb.createClient({
      host:     cfg.host,
      port:     cfg.port || 30015,
      user:     cfg.username,
      password: cfg.password,
    });
    client.connect(err => {
      if (err) return reject(new Error("HANA connect failed: " + err.message));
      _hanaClient  = client;
      _activeType  = "hana";
      _activeConfig = cfg;
      resolve(client);
    });
  });
}

async function executeHANA(querySql) {
  if (!_hanaClient) throw new Error("No HANA connection active.");
  const runQuery = (client) => new Promise((resolve, reject) => {
    client.exec(querySql, (err, rows) => {
      if (err) return reject(err);
      resolve(rows ?? []);
    });
  });
  try {
    return await runQuery(_hanaClient);
  } catch(err) {
    // Connection may have dropped — reconnect once and retry
    console.warn(`[HANA] query failed (${err.message}), reconnecting...`);
    await connectHANA(_activeConfig);
    return runQuery(_hanaClient);
  }
}

// ── Public API ────────────────────────────────────────────────────────────────
export async function connectDB(cfg) {
  if (cfg.db_type === "hana") return connectHANA(cfg);
  return connectMSSQL(cfg);
}

export async function executeSQL(querySql) {
  if (!_activeType) throw new Error("No database connected. Configure DB connection in Settings.");
  // Safety: only allow SELECT queries
  const trimmed = querySql.trim().toUpperCase();
  if (!/^SELECT\b/.test(trimmed)) throw new Error("Only SELECT queries are allowed in DB Direct mode.");
  if (_activeType === "hana")  return executeHANA(querySql);
  return executeMSSQL(querySql);
}

export async function testConnection(cfg) {
  if (cfg.db_type === "hana") {
    return new Promise((resolve, reject) => {
      const client = hdb.createClient({ host: cfg.host, port: cfg.port || 30015, user: cfg.username, password: cfg.password });
      client.connect(err => {
        if (err) return reject(new Error("HANA: " + err.message));
        client.disconnect();
        resolve(true);
      });
    });
  }
  // MSSQL test
  const testPool = await sql.connect({
    server: cfg.host, port: cfg.port || 1433, database: cfg.database,
    user: cfg.username, password: cfg.password,
    options: { encrypt: false, trustServerCertificate: true },
    connectionTimeout: 10000, requestTimeout: 10000,
  });
  await testPool.close();
  return true;
}

export function getActiveType()   { return _activeType; }
export function getActiveConfig() { return _activeConfig; }
export function isConnected()     { return !!_activeType && (_mssqlPool !== null || _hanaClient !== null); }

// ── Company base currency ────────────────────────────────────────────────────
// Each SAP B1 company has its own local currency (OADM.MainCurncy) — a UAE
// company runs in AED, a US one in USD, an Indian one in INR. The AI's number
// formatting (symbol, digit grouping, lakh/crore vs K/M/B) must follow the
// currency of the company actually connected, not a single hardcoded currency.
const CURRENCY_SYMBOLS = {
  INR: "₹", USD: "$", EUR: "€", GBP: "£", AED: "AED ", SAR: "SAR ", JPY: "¥",
  CNY: "¥", AUD: "A$", CAD: "C$", SGD: "S$", CHF: "CHF ", ZAR: "R", NZD: "NZ$",
};
let _currencyCache = null; // { key, code, symbol }

/**
 * Returns { code, symbol } for the currently active company, read live from
 * OADM.MainCurncy and cached until the connection changes. Falls back to
 * USD (this app's default) if the lookup fails for any reason.
 */
export async function getCompanyCurrency() {
  const cfg = _activeConfig;
  const key = `${_activeType}::${cfg?.database || cfg?.schema_name || ""}`;
  if (_currencyCache && _currencyCache.key === key) return _currencyCache;

  // OADM.MainCurncy is OCRN's currency key — usually a 3-letter ISO code
  // (USD, INR…) but SAP B1 lets admins define it as a bare symbol instead
  // (this company's is literally "$"), so it can't always be looked up in
  // CURRENCY_SYMBOLS as if it were an ISO code.
  let raw = "USD";
  if (isConnected()) {
    try {
      // HANA folds unquoted identifiers to uppercase, but SAP B1-on-HANA
      // columns are created quoted (case-preserved) — MainCurncy must be
      // quoted here or HANA looks for MAINCURNCY and throws "invalid column".
      const col = _activeType === "hana" ? `"MainCurncy"` : "MainCurncy";
      const rows = await executeSQL(`SELECT ${col} AS MainCurncy FROM ${tableRef("OADM", cfg)}`);
      const val = rows?.[0]?.MainCurncy ?? rows?.[0]?.MAINCURNCY ?? rows?.[0]?.mainCurncy;
      if (val) raw = String(val).trim();
    } catch { /* keep USD default — e.g. module not licensed, permissions */ }
  }
  const isIsoCode = /^[A-Za-z]{3}$/.test(raw);
  const code = isIsoCode ? raw.toUpperCase() : raw;
  const symbol = isIsoCode ? (CURRENCY_SYMBOLS[code] || `${code} `) : code;
  const result = { key, code, symbol };
  _currencyCache = result;
  return result;
}

// ── Live column discovery + field-mapping validation ────────────────────────
// Used by agents that read live SAP tables directly (ODBC/DB Direct) so they
// never silently query a column name that doesn't exist on this DB — a wrong
// guess here would produce wrong PO quantities/vendors instead of an error.
const _columnCache = new Map(); // "company::TABLE" -> { cols:Set<lowercase>, expiresAt }
const COLUMN_TTL = 10 * 60 * 1000;

/**
 * Returns the set of real column names (lowercased) that exist on `tableName`
 * for the currently active DB Direct connection. Cached for 10 minutes.
 */
export async function getTableColumns(tableName) {
  if (!isConnected()) throw new Error("No database connected.");
  const cfg     = _activeConfig;
  const isHana  = _activeType === "hana";
  const company = cfg?.database || cfg?.schema_name || "default";
  const cacheKey = `${company}::${tableName}`;

  const cached = _columnCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) return cached.cols;

  const sql = isHana
    ? `SELECT COLUMN_NAME FROM SYS.TABLE_COLUMNS WHERE SCHEMA_NAME = '${(cfg.database || cfg.schema_name || '').replace(/'/g, "''")}' AND TABLE_NAME = '${tableName}'`
    : `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = '${tableName}'`;

  const rows = await executeSQL(sql);
  const cols = new Set(rows.map(r => String(r.COLUMN_NAME || r.column_name || Object.values(r)[0] || "").toLowerCase()).filter(Boolean));
  _columnCache.set(cacheKey, { cols, expiresAt: Date.now() + COLUMN_TTL });
  return cols;
}

/**
 * Scans the live DB for real column names (in original case, ordered) of a
 * batch of tables in one round trip — the primitive behind auto-populating
 * the schema registry so the AI stops guessing field names (see
 * schemaRepo type='table' entries and /api/schema-registry/sync-tables).
 *
 * @param {string[]} tableNames  e.g. ["OWOR","WOR1","OITM"]
 * @returns {Promise<Object<string,string[]>>} tableName -> ordered column names.
 *   A table that doesn't exist on this backend (module not licensed/installed,
 *   or a version difference) is simply absent from the result — never thrown.
 */
export async function scanTablesSchema(tableNames) {
  if (!isConnected()) throw new Error("No database connected.");
  if (!tableNames?.length) return {};
  const cfg    = _activeConfig;
  const isHana = _activeType === "hana";
  const list   = tableNames.map(t => `'${t.replace(/'/g, "''")}'`).join(",");

  const sql = isHana
    ? `SELECT TABLE_NAME, COLUMN_NAME, POSITION FROM SYS.TABLE_COLUMNS
       WHERE SCHEMA_NAME = '${(cfg.database || cfg.schema_name || '').replace(/'/g, "''")}'
       AND TABLE_NAME IN (${list}) ORDER BY TABLE_NAME, POSITION`
    : `SELECT TABLE_NAME, COLUMN_NAME, ORDINAL_POSITION FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_NAME IN (${list}) ORDER BY TABLE_NAME, ORDINAL_POSITION`;

  const rows = await executeSQL(sql);
  const byTable = {};
  for (const r of rows) {
    const t = r.TABLE_NAME || r.table_name;
    const c = r.COLUMN_NAME || r.column_name;
    if (!t || !c) continue;
    (byTable[t] ??= []).push(c);
  }
  return byTable;
}

/**
 * Resolves a logical field -> real SQL column name using an ordered list of
 * candidate names per field, validated against the live column set.
 *
 * @param {Set<string>} availableCols  lowercased column names from getTableColumns()
 * @param {Object<string,string[]>} candidatesMap  { logicalField: [candidate1, candidate2, ...] }
 * @returns {{ resolved: Object<string,string>, missing: string[] }}
 *   resolved[logicalField] = actual column name to use in SQL (first matching candidate)
 *   missing = logical fields with no matching candidate on this DB
 */
export function resolveFieldMap(availableCols, candidatesMap) {
  const resolved = {};
  const missing = [];
  for (const [field, candidates] of Object.entries(candidatesMap)) {
    const hit = candidates.find(c => availableCols.has(c.toLowerCase()));
    if (hit) resolved[field] = hit;
    else missing.push(field);
  }
  return { resolved, missing };
}

export function invalidateColumnCache() {
  _columnCache.clear();
}

// Drop the active DB Direct connection without connecting to a new one.
// Used when switching to a company that has no direct-DB credentials configured,
// so DB Direct/Analytics V2 doesn't keep silently querying the PREVIOUS company's database.
export async function disconnectDB() {
  if (_mssqlPool)  { try { await _mssqlPool.close(); } catch {} _mssqlPool = null; }
  if (_hanaClient) { try { _hanaClient.disconnect(); } catch {} _hanaClient = null; }
  _activeType   = null;
  _activeConfig = null;
}

// Build a schema-qualified table reference
export function tableRef(tableName, cfg) {
  if (!cfg) return tableName;
  if (cfg.db_type === "hana") {
    const schema = cfg.database || cfg.schema_name;
    return schema ? `"${schema}"."${tableName}"` : `"${tableName}"`;
  }
  // MSSQL
  const db = cfg.database;
  return db ? `[${db}].[dbo].[${tableName}]` : `[${tableName}]`;
}

// ── Live UDF Discovery ────────────────────────────────────────────────────────
// Cache: company → { text, expiresAt }
const _udfCache = new Map();
const UDF_TTL   = 10 * 60 * 1000; // 10 minutes

/**
 * Fetch all User Defined Fields (UDFs) from the live database CUFD table.
 * Returns a formatted string ready to include in the AI SQL prompt.
 * Results are cached for 10 minutes per company.
 *
 * @returns {Promise<string>} formatted UDF context block, or '' on failure
 */
export async function fetchLiveUDFs() {
  if (!isConnected()) return '';
  const cfg     = _activeConfig;
  const isHana  = _activeType === 'hana';
  const company = cfg?.database || cfg?.schema_name || 'default';

  // Cache hit
  const cached = _udfCache.get(company);
  if (cached && Date.now() < cached.expiresAt) return cached.text;

  try {
    const cufd  = tableRef('CUFD', cfg);
    const typeLabel = isHana
      ? `CASE "Type" WHEN 'C' THEN 'varchar' WHEN 'N' THEN 'numeric' WHEN 'D' THEN 'date' WHEN 'L' THEN 'link' ELSE "Type" END`
      : `CASE Type WHEN 'C' THEN 'varchar' WHEN 'N' THEN 'numeric' WHEN 'D' THEN 'date' WHEN 'L' THEN 'link' ELSE Type END`;
    const sizeExpr = isHana ? `"Size"` : `Size`;
    const nameCol  = isHana ? `"Name"` : `Name`;
    const descrCol = isHana ? `"Descr"` : `Descr`;
    const tableCol = isHana ? `"TableID"` : `TableID`;
    const validCol = isHana ? `"ValidValues"` : `ValidValues`;

    const sql = isHana
      ? `SELECT ${tableCol} AS TBL, ${nameCol} AS FLD, ${descrCol} AS DSC, ${typeLabel} AS TYP, ${sizeExpr} AS SZ, ${validCol} AS VV FROM ${cufd} WHERE ${nameCol} LIKE 'U_%' ORDER BY ${tableCol}, ${nameCol} LIMIT 500`
      : `SELECT TOP 500 ${tableCol} AS TBL, ${nameCol} AS FLD, ${descrCol} AS DSC, ${typeLabel} AS TYP, ${sizeExpr} AS SZ, ${validCol} AS VV FROM ${cufd} WHERE ${nameCol} LIKE 'U_%' ORDER BY ${tableCol}, ${nameCol}`;

    const rows = await executeSQL(sql);
    if (!rows.length) {
      _udfCache.set(company, { text: '', expiresAt: Date.now() + UDF_TTL });
      return '';
    }

    // Group by table
    const byTable = {};
    for (const r of rows) {
      const tbl = r.TBL || r.tbl || '';
      const fld = r.FLD || r.fld || '';
      const dsc = r.DSC || r.dsc || '';
      const typ = r.TYP || r.typ || 'varchar';
      const sz  = r.SZ  || r.sz  || '';
      const vv  = r.VV  || r.vv  || '';
      if (!tbl || !fld) continue;
      if (!byTable[tbl]) byTable[tbl] = [];
      let desc = `${fld}(${typ}${sz ? '('+sz+')' : ''})`;
      if (dsc) desc += ` "${dsc}"`;
      if (vv)  desc += ` [${vv}]`;
      byTable[tbl].push(desc);
    }

    const lines = Object.entries(byTable)
      .map(([tbl, fields]) => `  ${tbl}: ${fields.join(', ')}`)
      .join('\n');
    const text = `Company UDF Fields (User Defined Fields) — use these U_ column names in SQL:\n${lines}`;

    _udfCache.set(company, { text, expiresAt: Date.now() + UDF_TTL });
    return text;
  } catch(e) {
    console.warn(`[UDF] fetchLiveUDFs failed: ${e.message}`);
    return '';
  }
}

/**
 * Invalidate the UDF cache (call after syncing UDFs to force refresh).
 */
export function invalidateUDFCache() {
  _udfCache.clear();
}

/**
 * Fetch raw UDF rows from CUFD for storing in SQLite schemaRepo.
 * Returns array of { tableId, name, descr, type, size, validValues }
 */
export async function fetchRawUDFs() {
  if (!isConnected()) throw new Error("No database connected");
  const cfg    = _activeConfig;
  const isHana = _activeType === 'hana';
  const cufd   = tableRef('CUFD', cfg);

  const nameCol  = isHana ? `"Name"`       : `Name`;
  const descrCol = isHana ? `"Descr"`      : `Descr`;
  const tableCol = isHana ? `"TableID"`    : `TableID`;
  const validCol = isHana ? `"ValidValues"`: `ValidValues`;
  const typeCol  = isHana ? `"Type"`       : `Type`;
  const sizeCol  = isHana ? `"Size"`       : `Size`;

  const sql = isHana
    ? `SELECT ${tableCol} AS TBL, ${nameCol} AS FLD, ${descrCol} AS DSC, ${typeCol} AS TYP, ${sizeCol} AS SZ, ${validCol} AS VV FROM ${cufd} WHERE ${nameCol} LIKE 'U_%' ORDER BY ${tableCol}, ${nameCol} LIMIT 2000`
    : `SELECT TOP 2000 ${tableCol} AS TBL, ${nameCol} AS FLD, ${descrCol} AS DSC, ${typeCol} AS TYP, ${sizeCol} AS SZ, ${validCol} AS VV FROM ${cufd} WHERE ${nameCol} LIKE 'U_%' ORDER BY ${tableCol}, ${nameCol}`;

  const rows = await executeSQL(sql);
  return rows.map(r => ({
    tableId:     r.TBL || r.tbl || '',
    name:        r.FLD || r.fld || '',
    descr:       r.DSC || r.dsc || '',
    type:        r.TYP || r.typ || 'C',
    size:        r.SZ  || r.sz  || 0,
    validValues: r.VV  || r.vv  || '',
  })).filter(r => r.tableId && r.name);
}
