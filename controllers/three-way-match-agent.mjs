/**
 * Three-Way Match Agent — Manual AP Invoice Validation
 *  1. Select open GRPO (by number or vendor)
 *  2. Auto-fetch linked Purchase Order for original prices
 *  3. Enter supplier invoice number, date, and line details
 *  4. System compares: Invoice qty vs GRPO qty, Invoice price vs PO price
 *  5. Discrepancies alerted with colour-coded table — user approves or rejects
 *  6. Post AP Invoice to SAP B1 and log to SQLite
 */
import { Router } from 'express';
import db from '../db.mjs';

// ── SQLite log table ─────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS three_way_match_log (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id    TEXT,
    grpo_num      INTEGER,
    po_num        INTEGER,
    invoice_num   TEXT,
    vendor_code   TEXT,
    vendor_name   TEXT,
    invoice_total REAL,
    match_status  TEXT,
    discrepancies TEXT,
    resolution    TEXT,
    sap_doc_entry INTEGER,
    sap_doc_num   INTEGER,
    user_name     TEXT,
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

const _sessions = new Map();

function initSession() {
  return {
    step:          'INIT',
    sessionId:     `twm_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    grpoDetail:    null,
    poDetail:      null,
    lines:         [],
    invoiceNum:    null,
    invoiceDate:   null,
    discrepancies: [],
    resolution:    null,
    auditLog:      [],
    result:        null,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function today()  { return new Date().toISOString().slice(0, 10); }
function sapDate(s) { const d = s || today(); return d.length === 10 ? `${d}T00:00:00` : d; }
function fmtN(n, d = 2) {
  if (n == null || isNaN(Number(n))) return '—';
  return Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}
function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function ts() { return new Date().toISOString().replace('T', ' ').slice(0, 16); }

// ── DB Direct (ODBC/HANA) reads, Service Layer fallback ────────────────────
// Same pattern as purchasing-agent.mjs / the MRP agent: resolve every logical
// field against the LIVE column list before building SQL (never guess a
// column name — a wrong guess here would produce wrong quantities/prices
// instead of a clear error), and fall back to the Service Layer call on any
// connection/mapping failure. HANA folds unquoted identifiers to uppercase,
// so identifiers are quoted on HANA only — MSSQL is case-insensitive.
function qcol(name, isHana) { return isHana ? `"${name}"` : name; }

const OPDN_HEADER_CANDIDATES = {
  docEntry: ['DocEntry'], docNum: ['DocNum'], cardCode: ['CardCode'], cardName: ['CardName'],
  docDate: ['DocDate'], docTotal: ['DocTotal'], docStatus: ['DocStatus'], numAtCard: ['NumAtCard'],
};
const PDN1_LINE_CANDIDATES = {
  docEntry: ['DocEntry'], lineNum: ['LineNum'], itemCode: ['ItemCode'], description: ['Dscription'],
  quantity: ['Quantity'], price: ['Price'], warehouseCode: ['WhsCode'], taxCode: ['VatGroup'],
  baseType: ['BaseType'], baseEntry: ['BaseEntry'], baseLine: ['BaseLine'],
};
const OPOR_HEADER_CANDIDATES = {
  docEntry: ['DocEntry'], docNum: ['DocNum'], cardCode: ['CardCode'], cardName: ['CardName'],
  docDate: ['DocDate'], docTotal: ['DocTotal'],
};
const POR1_LINE_CANDIDATES = {
  docEntry: ['DocEntry'], lineNum: ['LineNum'], itemCode: ['ItemCode'], price: ['Price'],
};

async function fetchOpenGRPOsViaDB(dbDeps, search = '') {
  const { getActiveConfig, getActiveType, getTableColumns, resolveFieldMap, tableRef, executeSQL } = dbDeps;
  const cfg    = getActiveConfig();
  const isHana = getActiveType() === 'hana';
  const q      = n => qcol(n, isHana);
  const cols   = await getTableColumns('OPDN');
  const { resolved, missing } = resolveFieldMap(cols, OPDN_HEADER_CANDIDATES);
  if (missing.length) throw new Error(`OPDN field mapping incomplete: ${missing.join(', ')}`);
  let where = `${q(resolved.docStatus)} = 'O'`;
  if (search) {
    const s = search.replace(/'/g, "''").toUpperCase();
    where += ` AND (UPPER(${q(resolved.cardName)}) LIKE '%${s}%' OR UPPER(${q(resolved.cardCode)}) LIKE '%${s}%')`;
  }
  const sql = `SELECT ${q(resolved.docEntry)} AS ${q('DocEntry')}, ${q(resolved.docNum)} AS ${q('DocNum')}, ` +
    `${q(resolved.cardCode)} AS ${q('CardCode')}, ${q(resolved.cardName)} AS ${q('CardName')}, ` +
    `${q(resolved.docDate)} AS ${q('DocDate')}, ${q(resolved.docTotal)} AS ${q('DocTotal')}, ` +
    `${q(resolved.numAtCard)} AS ${q('NumAtCard')} ` +
    `FROM ${tableRef('OPDN', cfg)} WHERE ${where} ORDER BY ${q(resolved.docDate)} DESC`;
  const rows = await executeSQL(sql);
  return rows.slice(0, 30).map(r => ({
    DocEntry: r.DocEntry, DocNum: r.DocNum, CardCode: r.CardCode, CardName: r.CardName,
    DocDate: r.DocDate, DocTotal: Number(r.DocTotal || 0), NumAtCard: r.NumAtCard,
  }));
}

// Fetch one GRPO (header + lines) by DocEntry or DocNum, shaped exactly like
// the Service Layer's PurchaseDeliveryNotes(entry) response so buildLines()
// and the rest of the flow work unchanged regardless of data source.
async function fetchGRPOFullViaDB(dbDeps, { docEntry, docNum }) {
  const { getActiveConfig, getActiveType, getTableColumns, resolveFieldMap, tableRef, executeSQL } = dbDeps;
  const cfg    = getActiveConfig();
  const isHana = getActiveType() === 'hana';
  const q      = n => qcol(n, isHana);
  const hCols  = await getTableColumns('OPDN');
  const { resolved: rH, missing: mH } = resolveFieldMap(hCols, OPDN_HEADER_CANDIDATES);
  if (mH.length) throw new Error(`OPDN field mapping incomplete: ${mH.join(', ')}`);

  const whereEntry = docEntry != null
    ? `${q(rH.docEntry)} = ${parseInt(docEntry, 10)}`
    : `${q(rH.docNum)} = ${parseInt(docNum, 10)}`;
  const hSql = `SELECT ${q(rH.docEntry)} AS ${q('DocEntry')}, ${q(rH.docNum)} AS ${q('DocNum')}, ` +
    `${q(rH.cardCode)} AS ${q('CardCode')}, ${q(rH.cardName)} AS ${q('CardName')}, ` +
    `${q(rH.docDate)} AS ${q('DocDate')}, ${q(rH.docTotal)} AS ${q('DocTotal')}, ` +
    `${q(rH.docStatus)} AS ${q('DocStatus')}, ${q(rH.numAtCard)} AS ${q('NumAtCard')} ` +
    `FROM ${tableRef('OPDN', cfg)} WHERE ${whereEntry}`;
  const hRows = await executeSQL(hSql);
  const h = hRows[0];
  if (!h) return null;

  const lCols = await getTableColumns('PDN1');
  const { resolved: rL, missing: mL } = resolveFieldMap(lCols, PDN1_LINE_CANDIDATES);
  if (mL.length) throw new Error(`PDN1 field mapping incomplete: ${mL.join(', ')}`);
  const lSql = `SELECT ${q(rL.lineNum)} AS ${q('LineNum')}, ${q(rL.itemCode)} AS ${q('ItemCode')}, ` +
    `${q(rL.description)} AS ${q('ItemDescription')}, ${q(rL.quantity)} AS ${q('Quantity')}, ` +
    `${q(rL.price)} AS ${q('UnitPrice')}, ${q(rL.warehouseCode)} AS ${q('WarehouseCode')}, ` +
    `${q(rL.taxCode)} AS ${q('TaxCode')}, ${q(rL.baseType)} AS ${q('BaseType')}, ` +
    `${q(rL.baseEntry)} AS ${q('BaseEntry')}, ${q(rL.baseLine)} AS ${q('BaseLine')} ` +
    `FROM ${tableRef('PDN1', cfg)} WHERE ${q(rL.docEntry)} = ${h.DocEntry} AND ${q(rL.itemCode)} IS NOT NULL`;
  const lRows = await executeSQL(lSql);

  return {
    DocEntry: h.DocEntry, DocNum: h.DocNum, CardCode: h.CardCode, CardName: h.CardName,
    DocDate: h.DocDate, DocTotal: Number(h.DocTotal || 0),
    DocumentStatus: h.DocStatus === 'O' ? 'bost_Open' : 'bost_Close', NumAtCard: h.NumAtCard,
    DocumentLines: lRows.map(l => ({
      LineNum: l.LineNum, ItemCode: l.ItemCode, ItemDescription: l.ItemDescription,
      Quantity: Number(l.Quantity || 0), UnitPrice: Number(l.UnitPrice || 0),
      WarehouseCode: l.WarehouseCode, TaxCode: l.TaxCode,
      BaseType: Number(l.BaseType), BaseEntry: l.BaseEntry != null ? Number(l.BaseEntry) : null,
      BaseLine: l.BaseLine != null ? Number(l.BaseLine) : null,
    })),
  };
}

async function fetchPOFullViaDB(dbDeps, docEntry) {
  const { getActiveConfig, getActiveType, getTableColumns, resolveFieldMap, tableRef, executeSQL } = dbDeps;
  const cfg    = getActiveConfig();
  const isHana = getActiveType() === 'hana';
  const q      = n => qcol(n, isHana);
  const hCols  = await getTableColumns('OPOR');
  const { resolved: rH, missing: mH } = resolveFieldMap(hCols, OPOR_HEADER_CANDIDATES);
  if (mH.length) throw new Error(`OPOR field mapping incomplete: ${mH.join(', ')}`);
  const hSql = `SELECT ${q(rH.docEntry)} AS ${q('DocEntry')}, ${q(rH.docNum)} AS ${q('DocNum')}, ` +
    `${q(rH.cardCode)} AS ${q('CardCode')}, ${q(rH.cardName)} AS ${q('CardName')}, ` +
    `${q(rH.docDate)} AS ${q('DocDate')}, ${q(rH.docTotal)} AS ${q('DocTotal')} ` +
    `FROM ${tableRef('OPOR', cfg)} WHERE ${q(rH.docEntry)} = ${parseInt(docEntry, 10)}`;
  const hRows = await executeSQL(hSql);
  const h = hRows[0];
  if (!h) return null;

  const lCols = await getTableColumns('POR1');
  const { resolved: rL, missing: mL } = resolveFieldMap(lCols, POR1_LINE_CANDIDATES);
  if (mL.length) throw new Error(`POR1 field mapping incomplete: ${mL.join(', ')}`);
  const lSql = `SELECT ${q(rL.lineNum)} AS ${q('LineNum')}, ${q(rL.itemCode)} AS ${q('ItemCode')}, ` +
    `${q(rL.price)} AS ${q('UnitPrice')} ` +
    `FROM ${tableRef('POR1', cfg)} WHERE ${q(rL.docEntry)} = ${h.DocEntry}`;
  const lRows = await executeSQL(lSql);

  return {
    DocEntry: h.DocEntry, DocNum: h.DocNum, CardCode: h.CardCode, CardName: h.CardName,
    DocDate: h.DocDate, DocTotal: Number(h.DocTotal || 0),
    DocumentLines: lRows.map(l => ({
      LineNum: l.LineNum, ItemCode: l.ItemCode, UnitPrice: Number(l.UnitPrice || 0),
    })),
  };
}

// ── SAP helpers (DB Direct preferred, Service Layer fallback) ──────────────────
async function fetchOpenGRPOs(sap, dbDeps, search = '') {
  if (dbDeps?.isConnected?.()) {
    try { return await fetchOpenGRPOsViaDB(dbDeps, search); }
    catch (e) { console.warn('[ThreeWayMatch] DB Direct open-GRPO scan failed, falling back to Service Layer:', e.message); }
  }
  const filterParts = [`DocumentStatus eq 'bost_Open'`];
  if (search) {
    const s = search.replace(/'/g, "''");
    filterParts.push(`(substringof('${s}',CardName) or substringof('${s}',CardCode))`);
  }
  try {
    const r = await sap.get('/PurchaseDeliveryNotes', {
      $filter:   filterParts.join(' and '),
      $orderby:  'DocDate desc',
      $top:      30,
      $select:   'DocEntry,DocNum,DocDate,CardCode,CardName,DocTotal,NumAtCard',
    });
    return Array.isArray(r.value) ? r.value : [];
  } catch {
    try {
      const r = await sap.get('/PurchaseDeliveryNotes', {
        $filter:  `DocumentStatus eq 'bost_Open'`,
        $orderby: 'DocDate desc',
        $top:     30,
      });
      return Array.isArray(r.value) ? r.value : [];
    } catch { return []; }
  }
}

async function fetchGRPOByNum(sap, dbDeps, docNum) {
  if (dbDeps?.isConnected?.()) {
    try {
      const full = await fetchGRPOFullViaDB(dbDeps, { docNum });
      if (full) return full;
    } catch (e) { console.warn('[ThreeWayMatch] DB Direct GRPO-by-num failed, falling back to Service Layer:', e.message); }
  }
  try {
    const r = await sap.get('/PurchaseDeliveryNotes', {
      $filter: `DocNum eq ${parseInt(docNum, 10)}`,
      $top: 1,
    });
    const e = r.value?.[0];
    if (!e) return null;
    return await sap.get(`/PurchaseDeliveryNotes(${e.DocEntry})`);
  } catch { return null; }
}

async function fetchGRPOByEntry(sap, dbDeps, docEntry) {
  if (dbDeps?.isConnected?.()) {
    try {
      const full = await fetchGRPOFullViaDB(dbDeps, { docEntry });
      if (full) return full;
    } catch (e) { console.warn('[ThreeWayMatch] DB Direct GRPO-by-entry failed, falling back to Service Layer:', e.message); }
  }
  try {
    return await sap.get(`/PurchaseDeliveryNotes(${parseInt(docEntry, 10)})`);
  } catch { return null; }
}

async function fetchPOByEntry(sap, dbDeps, docEntry) {
  if (dbDeps?.isConnected?.()) {
    try {
      const full = await fetchPOFullViaDB(dbDeps, docEntry);
      if (full) return full;
    } catch (e) { console.warn('[ThreeWayMatch] DB Direct PO-by-entry failed, falling back to Service Layer:', e.message); }
  }
  try {
    return await sap.get(`/PurchaseOrders(${parseInt(docEntry, 10)})`);
  } catch { return null; }
}

// Build session lines merging GRPO quantities with PO prices
function buildLines(grpo, po) {
  const grpoLines = (grpo.DocumentLines || []).filter(l => l.ItemCode);
  const poLines   = po ? (po.DocumentLines || []).filter(l => l.ItemCode) : [];

  return grpoLines.map(gl => {
    // BaseType 22 = PO; find matching PO line via BaseLine
    const poLine   = poLines.find(pl => pl.LineNum === gl.BaseLine) ||
                     poLines.find(pl => pl.ItemCode === gl.ItemCode);
    const poPrice  = poLine
      ? Number(poLine.UnitPrice || poLine.Price || 0)
      : Number(gl.UnitPrice || gl.Price || 0);

    return {
      lineNum:    gl.LineNum,
      baseLine:   gl.LineNum,
      baseEntry:  grpo.DocEntry,
      itemCode:   gl.ItemCode,
      itemName:   gl.ItemDescription || gl.ItemCode,
      grpoQty:    Number(gl.Quantity   || 0),
      poPrice:    poPrice,
      invQty:     Number(gl.Quantity   || 0),  // default = GRPO qty
      invPrice:   poPrice,                      // default = PO price
      unit:       gl.UoMCode || gl.MeasureUnit || 'EA',
      warehouse:  gl.WarehouseCode || '',
      taxCode:    gl.TaxCode || null,
    };
  });
}

function detectDiscrepancies(lines) {
  const out = [];
  for (const l of lines) {
    const qtyDiff   = Math.abs(l.invQty - l.grpoQty);
    const pricePct  = l.poPrice > 0
      ? Math.abs(l.invPrice - l.poPrice) / l.poPrice
      : 0;

    if (qtyDiff > 0.001) {
      out.push({
        lineNum:  l.lineNum,
        itemCode: l.itemCode,
        itemName: l.itemName,
        type:     'QTY',
        expected: l.grpoQty,
        actual:   l.invQty,
        diff:     l.invQty - l.grpoQty,
        pct:      l.grpoQty > 0
          ? ((l.invQty - l.grpoQty) / l.grpoQty * 100).toFixed(1)
          : 'N/A',
      });
    }
    if (pricePct > 0.005) {   // 0.5% tolerance
      out.push({
        lineNum:  l.lineNum,
        itemCode: l.itemCode,
        itemName: l.itemName,
        type:     'PRICE',
        expected: l.poPrice,
        actual:   l.invPrice,
        diff:     l.invPrice - l.poPrice,
        pct:      (pricePct * 100).toFixed(1),
      });
    }
  }
  return out;
}

// ── HTML builders ─────────────────────────────────────────────────────────────
function buildGrpoTableHTML(grpos) {
  const rows = grpos.slice(0, 20).map(g =>
    `<tr onclick="twmSelectGRPO('${g.DocEntry}','${g.DocNum}')"
         style="cursor:pointer"
         onmouseover="this.style.background='#eff6ff'"
         onmouseout="this.style.background=''">
      <td style="padding:7px 10px;font-size:12px;font-weight:700;color:#0f766e">${g.DocNum}</td>
      <td style="padding:7px 10px;font-size:12px">${esc(g.CardCode || '')}</td>
      <td style="padding:7px 10px;font-size:12px">${esc(g.CardName || '')}</td>
      <td style="padding:7px 10px;font-size:11.5px;color:#6b7280">${(g.DocDate || '').slice(0, 10)}</td>
      <td style="padding:7px 10px;font-size:12px;text-align:right;font-weight:600">$${fmtN(g.DocTotal)}</td>
      <td style="padding:7px 10px;font-size:11px;color:#9ca3af">${esc(g.NumAtCard || '—')}</td>
    </tr>`
  ).join('');

  return `<div style="border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;margin-top:10px">
    <table style="width:100%;border-collapse:collapse">
      <thead>
        <tr style="background:#f3f4f6">
          <th style="padding:7px 10px;font-size:10.5px;text-align:left;color:#6b7280;border-bottom:1px solid #e5e7eb">GRPO #</th>
          <th style="padding:7px 10px;font-size:10.5px;text-align:left;color:#6b7280;border-bottom:1px solid #e5e7eb">Code</th>
          <th style="padding:7px 10px;font-size:10.5px;text-align:left;color:#6b7280;border-bottom:1px solid #e5e7eb">Vendor</th>
          <th style="padding:7px 10px;font-size:10.5px;text-align:left;color:#6b7280;border-bottom:1px solid #e5e7eb">Date</th>
          <th style="padding:7px 10px;font-size:10.5px;text-align:right;color:#6b7280;border-bottom:1px solid #e5e7eb">Total</th>
          <th style="padding:7px 10px;font-size:10.5px;text-align:left;color:#6b7280;border-bottom:1px solid #e5e7eb">Vendor Ref</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  </div>
  <div style="font-size:11px;color:#9ca3af;margin-top:6px">Click a row or type a GRPO number / vendor name</div>`;
}

function buildInvoiceFormHTML(sess) {
  const grpo  = sess.grpoDetail;
  const lines = sess.lines;

  const lineRows = lines.map((l, i) =>
    `<tr>
      <td style="padding:7px 8px;font-size:11.5px">${esc(l.itemCode)}</td>
      <td style="padding:7px 8px;font-size:11.5px;max-width:180px">${esc(l.itemName)}</td>
      <td style="padding:7px 8px;font-size:11.5px;text-align:center">${fmtN(l.grpoQty, 0)}</td>
      <td style="padding:7px 8px">
        <input type="number" id="twm-qty-${i}" value="${l.invQty}" min="0" step="0.001"
          style="width:65px;border:1px solid #d1d5db;border-radius:4px;padding:3px 6px;font-size:12px;font-family:var(--font)">
      </td>
      <td style="padding:7px 8px;font-size:11.5px;text-align:right;color:#0f766e;font-weight:600">$${fmtN(l.poPrice)}</td>
      <td style="padding:7px 8px">
        <input type="number" id="twm-price-${i}" value="${l.invPrice}" min="0" step="0.01"
          style="width:80px;border:1px solid #d1d5db;border-radius:4px;padding:3px 6px;font-size:12px;font-family:var(--font)">
      </td>
    </tr>`
  ).join('');

  return `<div style="border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;margin-top:4px">
    <div style="background:#0f766e;color:#fff;padding:10px 14px;font-size:12.5px;font-weight:700">
      📋 Enter Supplier Invoice Details — GRPO #${grpo.DocNum} · ${esc(grpo.CardName || grpo.CardCode)}
    </div>
    <div style="background:#fff;padding:14px">
      <div style="display:flex;gap:12px;margin-bottom:14px;flex-wrap:wrap">
        <div style="flex:1;min-width:160px">
          <label style="display:block;font-size:11px;color:#6b7280;margin-bottom:4px;font-weight:600">INVOICE NUMBER *</label>
          <input id="twm-inv-num" type="text" placeholder="e.g. INV-2024-001"
            style="width:100%;border:1px solid #d1d5db;border-radius:4px;padding:6px 10px;font-size:13px;font-family:var(--font);box-sizing:border-box">
        </div>
        <div style="flex:1;min-width:140px">
          <label style="display:block;font-size:11px;color:#6b7280;margin-bottom:4px;font-weight:600">INVOICE DATE *</label>
          <input id="twm-inv-date" type="date" value="${today()}"
            style="width:100%;border:1px solid #d1d5db;border-radius:4px;padding:6px 10px;font-size:13px;font-family:var(--font);box-sizing:border-box">
        </div>
      </div>
      <div style="font-size:11px;color:#6b7280;margin-bottom:8px;font-weight:600">LINE ITEMS — adjust qty/price if they differ from the supplier invoice</div>
      <div style="overflow-x:auto">
        <table style="width:100%;border-collapse:collapse;border:1px solid #e5e7eb;border-radius:6px;overflow:hidden">
          <thead>
            <tr style="background:#f3f4f6">
              <th style="padding:7px 8px;font-size:10.5px;text-align:left;color:#6b7280">Item Code</th>
              <th style="padding:7px 8px;font-size:10.5px;text-align:left;color:#6b7280">Description</th>
              <th style="padding:7px 8px;font-size:10.5px;text-align:center;color:#6b7280">GRPO Qty</th>
              <th style="padding:7px 8px;font-size:10.5px;text-align:left;color:#6b7280">Inv Qty</th>
              <th style="padding:7px 8px;font-size:10.5px;text-align:right;color:#0f766e">PO Price</th>
              <th style="padding:7px 8px;font-size:10.5px;text-align:left;color:#6b7280">Inv Price</th>
            </tr>
          </thead>
          <tbody>${lineRows}</tbody>
        </table>
      </div>
      <div style="margin-top:12px;display:flex;gap:8px;justify-content:flex-end">
        <button onclick="twmResetGRPO()"
          style="padding:7px 16px;background:#f3f4f6;border:1px solid #d1d5db;border-radius:4px;font-size:12px;cursor:pointer;font-family:var(--font)">
          ← Back
        </button>
        <button onclick="twmSubmitInvoice(${lines.length})"
          style="padding:7px 18px;background:#0f766e;color:#fff;border:none;border-radius:4px;font-size:12.5px;font-weight:600;cursor:pointer;font-family:var(--font)">
          Run Three-Way Match →
        </button>
      </div>
    </div>
  </div>`;
}

function buildMatchTableHTML(lines, discrepancies) {
  const discMap = new Set(discrepancies.map(d => `${d.lineNum}:${d.type}`));

  const rows = lines.map(l => {
    const qtyOk   = !discMap.has(`${l.lineNum}:QTY`);
    const priceOk = !discMap.has(`${l.lineNum}:PRICE`);
    const icon    = (qtyOk && priceOk) ? '✅' : '⚠️';
    return `<tr>
      <td style="padding:7px 10px;font-size:12px;font-weight:600">${esc(l.itemCode)}</td>
      <td style="padding:7px 10px;font-size:11.5px;max-width:180px;overflow:hidden;text-overflow:ellipsis">${esc(l.itemName)}</td>
      <td style="padding:7px 10px;font-size:12px;text-align:center">${fmtN(l.grpoQty, 0)}</td>
      <td style="padding:7px 10px;font-size:12px;text-align:center;color:${qtyOk ? 'inherit' : '#b91c1c'};font-weight:${qtyOk ? 400 : 700}">${fmtN(l.invQty, 0)}</td>
      <td style="padding:7px 10px;font-size:12px;text-align:right;color:#0f766e;font-weight:600">$${fmtN(l.poPrice)}</td>
      <td style="padding:7px 10px;font-size:12px;text-align:right;color:${priceOk ? 'inherit' : '#b45309'};font-weight:${priceOk ? 400 : 700}">$${fmtN(l.invPrice)}</td>
      <td style="padding:7px 10px;text-align:center;font-size:15px">${icon}</td>
    </tr>`;
  }).join('');

  return `<div style="border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;margin:8px 0">
    <div style="background:#354A5E;color:#fff;padding:10px 14px;font-size:12.5px;font-weight:700">
      🔍 Three-Way Match Result
    </div>
    <div style="overflow-x:auto">
      <table style="width:100%;border-collapse:collapse">
        <thead>
          <tr style="background:#f3f4f6">
            <th style="padding:7px 10px;font-size:10.5px;text-align:left;color:#6b7280;border-bottom:1px solid #e5e7eb">Item Code</th>
            <th style="padding:7px 10px;font-size:10.5px;text-align:left;color:#6b7280;border-bottom:1px solid #e5e7eb">Description</th>
            <th style="padding:7px 10px;font-size:10.5px;text-align:center;color:#6b7280;border-bottom:1px solid #e5e7eb">GRPO Qty</th>
            <th style="padding:7px 10px;font-size:10.5px;text-align:center;color:#6b7280;border-bottom:1px solid #e5e7eb">Inv Qty</th>
            <th style="padding:7px 10px;font-size:10.5px;text-align:right;color:#0f766e;border-bottom:1px solid #e5e7eb">PO Price</th>
            <th style="padding:7px 10px;font-size:10.5px;text-align:right;color:#6b7280;border-bottom:1px solid #e5e7eb">Inv Price</th>
            <th style="padding:7px 10px;text-align:center;color:#6b7280;border-bottom:1px solid #e5e7eb">Status</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  </div>`;
}

function buildDiscrepancyHTML(discrepancies) {
  const rows = discrepancies.map(d => {
    const sign    = d.diff > 0 ? '+' : '';
    const color   = d.diff > 0 ? '#b45309' : '#b91c1c';
    const typeIcon = d.type === 'QTY' ? '📦' : '💰';
    const label   = d.type === 'QTY' ? 'Quantity mismatch (vs GRPO)' : 'Price mismatch (vs PO)';
    const fmt     = v => d.type === 'PRICE' ? `$${fmtN(v)}` : fmtN(v, 0);
    return `<tr>
      <td style="padding:8px 10px;font-size:12px">${typeIcon} ${esc(d.itemName)}</td>
      <td style="padding:8px 10px;font-size:11.5px;color:#6b7280">${label}</td>
      <td style="padding:8px 10px;font-size:12px;font-weight:600;color:#0f766e">${fmt(d.expected)}</td>
      <td style="padding:8px 10px;font-size:12px;font-weight:700;color:${color}">${fmt(d.actual)}</td>
      <td style="padding:8px 10px;font-size:11.5px;color:${color}">${sign}${fmt(d.diff)} (${sign}${d.pct}%)</td>
    </tr>`;
  }).join('');

  return `<div style="border:2px solid #fcd34d;border-radius:8px;overflow:hidden;margin:8px 0">
    <div style="background:#fef3c7;padding:10px 14px;font-size:12.5px;font-weight:700;color:#92400e;display:flex;align-items:center;gap:8px">
      ⚠️ ${discrepancies.length} Discrepanc${discrepancies.length !== 1 ? 'ies' : 'y'} Detected
      <span style="font-size:11px;font-weight:400;opacity:.75">— human review required before posting</span>
    </div>
    <table style="width:100%;border-collapse:collapse;background:#fff">
      <thead>
        <tr style="background:#fffbeb">
          <th style="padding:7px 10px;font-size:10.5px;text-align:left;color:#92400e;border-bottom:1px solid #fde68a">Item</th>
          <th style="padding:7px 10px;font-size:10.5px;text-align:left;color:#92400e;border-bottom:1px solid #fde68a">Issue</th>
          <th style="padding:7px 10px;font-size:10.5px;text-align:left;color:#0f766e;border-bottom:1px solid #fde68a">Expected</th>
          <th style="padding:7px 10px;font-size:10.5px;text-align:left;color:#92400e;border-bottom:1px solid #fde68a">Invoice</th>
          <th style="padding:7px 10px;font-size:10.5px;text-align:left;color:#92400e;border-bottom:1px solid #fde68a">Variance</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

function buildAuditHTML(auditLog) {
  const rows = auditLog.map(e =>
    `<tr>
      <td style="padding:8px 12px;font-size:11.5px;color:#6b7280;white-space:nowrap">${esc(e.ts)}</td>
      <td style="padding:8px 12px;font-size:11.5px;font-weight:700;color:#374151;white-space:nowrap">${esc(e.step)}</td>
      <td style="padding:8px 12px;font-size:11.5px;color:#374151">${e.action}</td>
    </tr>`
  ).join('');

  return `<div style="border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;margin-top:12px">
    <div style="background:#354A5E;color:#fff;padding:10px 14px;font-size:12.5px;font-weight:700;display:flex;align-items:center;justify-content:space-between">
      <span>📋 LLM Reasoning Summary</span>
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="18 15 12 9 6 15"/></svg>
    </div>
    <table style="width:100%;border-collapse:collapse;background:#fff">
      <thead>
        <tr style="background:#f9fafb">
          <th style="padding:8px 12px;font-size:11px;text-align:left;color:#6b7280;border-bottom:1px solid #e5e7eb">Timestamp</th>
          <th style="padding:8px 12px;font-size:11px;text-align:left;color:#6b7280;border-bottom:1px solid #e5e7eb">Step</th>
          <th style="padding:8px 12px;font-size:11px;text-align:left;color:#6b7280;border-bottom:1px solid #e5e7eb">Action Taken</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

// ── AP Invoice print layout ───────────────────────────────────────────────────
function renderAPInvPrint(doc) {
  const company  = process.env.SAP_B1_COMPANY || process.env.SL_COMPANY || 'Company';
  const lines    = doc.DocumentLines || [];
  const docDate  = doc.DocDate    ? doc.DocDate.slice(0, 10)    : '—';
  const dueDate  = doc.DocDueDate ? doc.DocDueDate.slice(0, 10) : '—';
  const printed  = new Date().toLocaleDateString('en-GB', { day:'2-digit', month:'short', year:'numeric' });
  const grandTotal = lines.reduce((s, l) => s + Number(l.LineTotal || 0), 0);
  const taxTotal   = lines.reduce((s, l) => s + Number(l.VatSum   || 0), 0);

  const linesHtml = lines.map((l, i) => `
    <tr>
      <td>${i + 1}</td>
      <td><strong>${l.ItemCode || ''}</strong></td>
      <td>${l.ItemDescription || ''}</td>
      <td style="text-align:right">${Number(l.Quantity  || 0).toFixed(2)}</td>
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
  <div>
    <div class="co-name">${company}</div>
    <div style="color:#888;font-size:11px;margin-top:2px">SAP Business One — A/P Invoice (Three-Way Match)</div>
  </div>
  <div>
    <div class="doc-title">A/P Invoice</div>
    <div style="font-size:13px;color:#444;text-align:right">AP # ${doc.DocNum}</div>
  </div>
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
  ${taxTotal > 0 ? `<div class="total-row">Subtotal: ${(grandTotal - taxTotal).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}</div>` : ''}
  ${taxTotal > 0 ? `<div class="total-row">Tax: ${taxTotal.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}</div>` : ''}
  <div class="total-grand">Total: ${grandTotal.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}</div>
</div>
<div class="sig-section">
  <div><div class="sig-line">Prepared By</div></div>
  <div><div class="sig-line">Approved By</div></div>
  <div><div class="sig-line">Finance Manager</div></div>
</div>
<div class="footer">Printed on ${printed} &nbsp;|&nbsp; ${company} — SAP B1 A/P Invoice #${doc.DocNum} &nbsp;|&nbsp; Three-Way Match Agent</div>
</body></html>`;
}

// ── Router factory ────────────────────────────────────────────────────────────
export function createThreeWayMatchRouter(deps) {
  const {
    requireAuth, printAuth, getActiveSap,
    isConnected, getActiveType, getActiveConfig, executeSQL, tableRef, getTableColumns, resolveFieldMap,
  } = deps;
  const router  = Router();
  const _dbDeps = isConnected
    ? { isConnected, getActiveType, getActiveConfig, executeSQL, tableRef, getTableColumns, resolveFieldMap }
    : null;

  router.post('/reset', requireAuth, (req, res) => {
    const { sessionId } = req.body || {};
    if (sessionId) _sessions.delete(sessionId);
    res.json({ ok: true });
  });

  router.post('/chat', requireAuth, async (req, res) => {
    try {
      const { message = '', sessionId } = req.body;
      const sid = sessionId || `twm_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      if (!_sessions.has(sid)) _sessions.set(sid, initSession());
      const sess = _sessions.get(sid);
      const sap  = getActiveSap();
      const msg  = message.trim();
      const msgL = msg.toLowerCase();

      if (msg) sess.auditLog; // keep reference

      let reply        = '';
      let quickReplies = [];
      let grpoList     = null;
      let matchData    = null;
      let invoiceForm  = null;

      // ── JSON actions ─────────────────────────────────────────────────────────
      if (msg.startsWith('{')) {
        let action = null;
        try { action = JSON.parse(msg); } catch {}

        // ── GRPO selected from table ──────────────────────────────────────────
        if (action?.action === 'select_grpo') {
          const full = await fetchGRPOByEntry(sap, _dbDeps, action.docEntry);
          if (!full) {
            reply = `<div style="color:#b91c1c">Could not load GRPO #${esc(String(action.docNum || action.docEntry))}. Please try again.</div>`;
          } else {
            // Try to find linked PO from first line's BaseEntry
            let po = null;
            const firstLine = (full.DocumentLines || []).find(l => l.ItemCode && l.BaseType === 22 && l.BaseEntry);
            if (firstLine?.BaseEntry) po = await fetchPOByEntry(sap, _dbDeps, firstLine.BaseEntry);

            sess.grpoDetail = full;
            sess.poDetail   = po;
            sess.lines      = buildLines(full, po);
            sess.step       = 'INVOICE_ENTRY';

            const poInfo = po
              ? `<span style="color:#0f766e;font-weight:600">✓ PO #${po.DocNum} prices loaded</span>`
              : `<span style="color:#9ca3af">No linked PO found — GRPO prices used as reference</span>`;

            sess.auditLog.push({ ts: ts(), step: 'GRPO Selected', action: `GRPO #${full.DocNum} from ${full.CardName || full.CardCode} loaded. ${po ? `PO #${po.DocNum} prices fetched.` : 'No linked PO.'}` });

            reply = `<div style="margin-bottom:10px;font-size:13.5px">
              <strong>GRPO #${full.DocNum}</strong> — ${esc(full.CardName || full.CardCode || '—')}
              &nbsp;|&nbsp; ${full.DocumentLines?.filter(l => l.ItemCode).length || 0} lines
              &nbsp;|&nbsp; Total: <strong>$${fmtN(Number(full.DocTotal || 0))}</strong>
              <br><span style="font-size:11px">${poInfo}</span>
            </div>`;
            invoiceForm = buildInvoiceFormHTML(sess);
          }
        }

        // ── Invoice form submitted ────────────────────────────────────────────
        else if (action?.action === 'submit_invoice') {
          if (!sess.grpoDetail) {
            reply = '<div style="color:#b91c1c">Session expired. Please restart.</div>';
            sess.step = 'INIT';
          } else {
            sess.invoiceNum  = (action.invNum || '').trim();
            sess.invoiceDate = (action.invDate || today()).trim();

            // Merge submitted line prices/qty into session lines
            if (Array.isArray(action.lines)) {
              action.lines.forEach((al, i) => {
                if (sess.lines[i]) {
                  sess.lines[i].invQty   = Number(al.invQty)   || sess.lines[i].grpoQty;
                  sess.lines[i].invPrice = Number(al.invPrice) || sess.lines[i].poPrice;
                }
              });
            }

            sess.discrepancies = detectDiscrepancies(sess.lines);
            const d = sess.discrepancies;

            sess.auditLog.push({
              ts:     ts(),
              step:   'Invoice Received',
              action: `Invoice ${sess.invoiceNum || '—'} for ${esc(sess.grpoDetail.CardName || '')} received. ${sess.lines.length} lines to match.`,
            });
            sess.auditLog.push({
              ts:     ts(),
              step:   'Three-Way Match',
              action: d.length > 0
                ? `${d.length} discrepanc${d.length > 1 ? 'ies' : 'y'} found: ${d.filter(x => x.type === 'QTY').length} qty, ${d.filter(x => x.type === 'PRICE').length} price.`
                : 'All lines match — qty equals GRPO, prices match PO.',
            });

            const matchHtml  = buildMatchTableHTML(sess.lines, d);
            const totalInv   = sess.lines.reduce((s, l) => s + l.invQty * l.invPrice, 0);

            if (d.length === 0) {
              sess.step = 'CONFIRM';
              reply = `${matchHtml}
                <div style="background:#d1fae5;border:1px solid #6ee7b7;border-radius:6px;padding:12px 14px;margin:8px 0;font-size:13px;color:#065f46">
                  ✅ <strong>All checks passed.</strong> Invoice total: <strong>$${fmtN(totalInv)}</strong>
                  <br>Invoice #<strong>${esc(sess.invoiceNum)}</strong> matches GRPO and PO — ready to post.
                </div>
                <div style="font-size:13px">Shall I post the AP Invoice to SAP B1?</div>`;
              quickReplies = ['Yes, Post AP Invoice', 'Cancel'];
            } else {
              sess.step = 'DISCREPANCY_REVIEW';
              reply = `${matchHtml}
                ${buildDiscrepancyHTML(d)}
                <div style="font-size:13px;margin-top:8px">
                  <strong>Invoice #${esc(sess.invoiceNum)}</strong> has discrepancies compared to the Purchase Order / GRPO.
                  <br>Should I accept the invoice as-is and proceed with vendor payment, or should I reject and reach out to the vendor?
                </div>`;
              quickReplies = ['Accept and Post', 'Reject Invoice', 'Reach Out to Vendor'];
            }

            matchData = { lines: sess.lines, discrepancies: d, invoiceTotal: totalInv };
          }
        }

        // ── Confirm post ──────────────────────────────────────────────────────
        else if (action?.action === 'confirm_post' || action?.action === 'post') {
          await doPostAPInvoice(sess, sap, res, sid, quickReplies);
          return;
        }

        else {
          reply = '<div style="color:#b91c1c">Unknown action. Please restart.</div>';
        }
      }

      // ── INIT ─────────────────────────────────────────────────────────────────
      else if (sess.step === 'INIT' || !msg) {
        const grpos = await fetchOpenGRPOs(sap, _dbDeps);
        sess.step = 'SELECT_GRPO';
        sess.auditLog.push({ ts: ts(), step: 'Session Started', action: `Loaded ${grpos.length} open GRPOs for selection.` });

        if (!grpos.length) {
          reply = `<div style="background:#fef3c7;border:1px solid #fcd34d;border-radius:6px;padding:12px 14px;font-size:13px;color:#92400e">
            ⚠️ No open Goods Receipt POs found. Goods must be received before creating an AP invoice.
          </div>`;
        } else {
          reply = `<div style="font-size:13.5px;margin-bottom:8px">
            Welcome to the <strong>Three-Way Match Agent</strong>.<br>
            I'll validate your supplier invoice against the GRPO (quantities) and Purchase Order (prices) before posting.
            <br><br><strong>${grpos.length}</strong> open GRPO${grpos.length !== 1 ? 's' : ''} available — select one to begin:
          </div>
          ${buildGrpoTableHTML(grpos)}`;
          grpoList = grpos.slice(0, 20).map(g => ({
            docEntry: g.DocEntry, docNum: g.DocNum,
            docDate:  (g.DocDate || '').slice(0, 10),
            cardCode: g.CardCode, cardName: g.CardName,
            docTotal: Number(g.DocTotal || 0),
          }));
        }
      }

      // ── SELECT_GRPO — typed search ────────────────────────────────────────────
      else if (sess.step === 'SELECT_GRPO') {
        const numMatch = msg.match(/^GRPO#?(\d+)$/i) || msg.match(/^(\d+)$/);
        let full = null;

        if (numMatch) {
          full = await fetchGRPOByNum(sap, _dbDeps, numMatch[1]);
          if (!full) {
            reply = `<div style="color:#b91c1c">GRPO #${numMatch[1]} not found or not open.</div>`;
          }
        } else {
          const found = await fetchOpenGRPOs(sap, _dbDeps, msg);
          if (found.length === 1) {
            full = await fetchGRPOByEntry(sap, _dbDeps, found[0].DocEntry);
          } else if (found.length > 1) {
            grpoList = found.slice(0, 20).map(g => ({
              docEntry: g.DocEntry, docNum: g.DocNum,
              docDate:  (g.DocDate || '').slice(0, 10),
              cardCode: g.CardCode, cardName: g.CardName,
              docTotal: Number(g.DocTotal || 0),
            }));
            reply = `<div>Found <strong>${found.length}</strong> GRPOs matching "<em>${esc(msg)}</em>". Click one to select:</div>${buildGrpoTableHTML(found)}`;
          } else {
            reply = `<div style="color:#b91c1c">No open GRPOs found for "<em>${esc(msg)}</em>". Try a GRPO number or different vendor name.</div>`;
          }
        }

        if (full) {
          let po = null;
          const firstLine = (full.DocumentLines || []).find(l => l.ItemCode && l.BaseType === 22 && l.BaseEntry);
          if (firstLine?.BaseEntry) po = await fetchPOByEntry(sap, _dbDeps, firstLine.BaseEntry);

          sess.grpoDetail = full;
          sess.poDetail   = po;
          sess.lines      = buildLines(full, po);
          sess.step       = 'INVOICE_ENTRY';

          const poInfo = po
            ? `PO #${po.DocNum} prices loaded`
            : 'No linked PO — GRPO prices used as reference';

          sess.auditLog.push({ ts: ts(), step: 'GRPO Selected', action: `GRPO #${full.DocNum} from ${full.CardName || full.CardCode}. ${poInfo}.` });

          reply = `<div style="margin-bottom:8px;font-size:13.5px">
            <strong>GRPO #${full.DocNum}</strong> — ${esc(full.CardName || full.CardCode || '—')} — $${fmtN(Number(full.DocTotal || 0))}
            <br><span style="font-size:11px;color:#0f766e">${esc(poInfo)}</span>
          </div>`;
          invoiceForm = buildInvoiceFormHTML(sess);
        }
      }

      // ── INVOICE_ENTRY — user typed instead of using form ─────────────────────
      else if (sess.step === 'INVOICE_ENTRY') {
        if (/back|reset|grpo|change/i.test(msgL)) {
          sess.grpoDetail = null;
          sess.poDetail   = null;
          sess.lines      = [];
          sess.step       = 'SELECT_GRPO';
          const grpos = await fetchOpenGRPOs(sap, _dbDeps);
          reply = `<div>Returning to GRPO selection — ${grpos.length} available:</div>${buildGrpoTableHTML(grpos)}`;
          grpoList = grpos.slice(0, 20).map(g => ({
            docEntry: g.DocEntry, docNum: g.DocNum,
            docDate:  (g.DocDate || '').slice(0, 10),
            cardCode: g.CardCode, cardName: g.CardName,
            docTotal: Number(g.DocTotal || 0),
          }));
        } else {
          reply = `<div>Please use the form above to enter the invoice details, or type <em>"back"</em> to choose a different GRPO.</div>`;
          invoiceForm = buildInvoiceFormHTML(sess);
        }
      }

      // ── DISCREPANCY_REVIEW ────────────────────────────────────────────────────
      else if (sess.step === 'DISCREPANCY_REVIEW') {
        if (/accept|post|proceed|approve/i.test(msgL)) {
          sess.resolution = msg;
          sess.step = 'CONFIRM';
          sess.auditLog.push({
            ts: ts(), step: 'Human Decision',
            action: `User accepted discrepancies: "${esc(msg)}"`,
          });
          reply = `<div style="font-size:13px">
            Understood. I'll accept the invoice as-is with your approval.
            <br><br>Ready to post <strong>AP Invoice</strong> to SAP B1 for vendor <strong>${esc(sess.grpoDetail?.CardName || '')}</strong>.
            <br>Invoice #: <strong>${esc(sess.invoiceNum || '—')}</strong>
            &nbsp;|&nbsp; Total: <strong>$${fmtN(sess.lines.reduce((s, l) => s + l.invQty * l.invPrice, 0))}</strong>
          </div>`;
          quickReplies = ['Post AP Invoice', 'Cancel'];
        } else if (/reject|decline|no/i.test(msgL)) {
          sess.resolution = msg;
          sess.auditLog.push({
            ts: ts(), step: 'Invoice Rejected',
            action: `User rejected the invoice: "${esc(msg)}"`,
          });
          sess.step = 'INIT';
          reply = `<div style="background:#fee2e2;border:1px solid #fca5a5;border-radius:6px;padding:12px 14px;font-size:13px;color:#991b1b">
            ❌ Invoice rejected. The vendor will need to resubmit a corrected invoice.
            ${buildAuditHTML(sess.auditLog)}
          </div>`;
          quickReplies = ['Start New Match'];
        } else if (/vendor|reach|contact|negotiate/i.test(msgL)) {
          sess.resolution = msg;
          sess.auditLog.push({
            ts: ts(), step: 'Escalation',
            action: `User requested vendor contact: "${esc(msg)}"`,
          });
          reply = `<div style="background:#fef3c7;border:1px solid #fcd34d;border-radius:6px;padding:12px 14px;font-size:13px;color:#92400e;margin-bottom:8px">
            📧 Noted — you'll need to contact <strong>${esc(sess.grpoDetail?.CardName || 'the vendor')}</strong> to resolve the discrepanc${sess.discrepancies.length !== 1 ? 'ies' : 'y'} before posting.
          </div>
          ${buildDiscrepancyHTML(sess.discrepancies)}
          ${buildAuditHTML(sess.auditLog)}`;
          quickReplies = ['Start New Match'];
        } else {
          const discHtml = sess.discrepancies.length
            ? buildDiscrepancyHTML(sess.discrepancies) : '';
          reply = `${discHtml}
            <div style="font-size:13px;margin-top:8px">
              How would you like to proceed with the discrepan${sess.discrepancies.length !== 1 ? 'cies' : 'cy'}?
            </div>`;
          quickReplies = ['Accept and Post', 'Reject Invoice', 'Reach Out to Vendor'];
        }
      }

      // ── CONFIRM ───────────────────────────────────────────────────────────────
      else if (sess.step === 'CONFIRM') {
        if (/yes|post|confirm|proceed/i.test(msgL)) {
          await doPostAPInvoice(sess, sap, res, sid, quickReplies);
          return;
        } else if (/no|cancel/i.test(msgL)) {
          sess.step = 'INIT';
          reply = '<div>Cancelled. The invoice was not posted. Start a new match whenever you are ready.</div>';
          quickReplies = ['Start New Match'];
        } else {
          const total = sess.lines.reduce((s, l) => s + l.invQty * l.invPrice, 0);
          reply = `<div style="font-size:13px">
            Ready to post <strong>AP Invoice</strong> for <strong>${esc(sess.grpoDetail?.CardName || '')}</strong>.
            Invoice #: <strong>${esc(sess.invoiceNum || '—')}</strong> — Total: <strong>$${fmtN(total)}</strong>
            <br>Confirm post?
          </div>`;
          quickReplies = ['Yes, Post AP Invoice', 'Cancel'];
        }
      }

      // ── DONE ─────────────────────────────────────────────────────────────────
      else if (sess.step === 'DONE') {
        if (/new|another|start|match/i.test(msgL)) {
          _sessions.delete(sid);
          const grpos = await fetchOpenGRPOs(sap, _dbDeps);
          const newSess = initSession();
          newSess.step = 'SELECT_GRPO';
          _sessions.set(sid, newSess);
          reply = `<div style="font-size:13.5px;margin-bottom:8px">Starting a new three-way match. Select a GRPO:</div>${buildGrpoTableHTML(grpos)}`;
          grpoList = grpos.slice(0, 20).map(g => ({ docEntry: g.DocEntry, docNum: g.DocNum, docDate: (g.DocDate || '').slice(0, 10), cardCode: g.CardCode, cardName: g.CardName, docTotal: Number(g.DocTotal || 0) }));
        } else {
          reply = '<div>Workflow complete. Click <em>"Start New Match"</em> to process another invoice.</div>';
          quickReplies = ['Start New Match'];
        }
      }

      else {
        sess.step = 'INIT';
        const grpos = await fetchOpenGRPOs(sap, _dbDeps);
        reply = `<div style="margin-bottom:8px;font-size:13.5px">Let's start. Select a GRPO to begin three-way matching:</div>${buildGrpoTableHTML(grpos)}`;
        grpoList = grpos.slice(0, 20).map(g => ({ docEntry: g.DocEntry, docNum: g.DocNum, docDate: (g.DocDate || '').slice(0, 10), cardCode: g.CardCode, cardName: g.CardName, docTotal: Number(g.DocTotal || 0) }));
        sess.step = 'SELECT_GRPO';
      }

      res.json({
        ok: true, reply, quickReplies, sessionId: sid,
        step: sess.step, grpoList, matchData, invoiceForm,
        grpoDetail: sess.grpoDetail ? {
          docEntry: sess.grpoDetail.DocEntry,
          docNum:   sess.grpoDetail.DocNum,
          cardName: sess.grpoDetail.CardName,
          cardCode: sess.grpoDetail.CardCode,
        } : null,
      });
    } catch (err) {
      console.error('[THREE-WAY-MATCH] chat error:', err);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ── GET /print/:docEntry ─────────────────────────────────────────────────────
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

// ── Post AP Invoice helper ────────────────────────────────────────────────────
async function doPostAPInvoice(sess, sap, res, sid, quickReplies) {
  const { grpoDetail, invoiceNum, invoiceDate, lines } = sess;

  try {
    const payload = {
      CardCode:    grpoDetail.CardCode,
      DocDate:     sapDate(today()),
      DocDueDate:  sapDate(invoiceDate || today()),
      NumAtCard:   invoiceNum || undefined,
      Comments:    `Three-Way Match | GRPO #${grpoDetail.DocNum} | Inv ${invoiceNum || ''}`.trim(),
      DocumentLines: lines.map(l => ({
        ItemCode:      l.itemCode,
        Quantity:      l.invQty,
        UnitPrice:     l.invPrice,
        BaseType:      20,
        BaseLine:      l.baseLine,
        BaseEntry:     Number(l.baseEntry),
        ...(l.warehouse ? { WarehouseCode: l.warehouse } : {}),
        ...(l.taxCode   ? { TaxCode: l.taxCode }         : {}),
      })),
    };

    const result = await sap.post('/PurchaseInvoices', payload);
    sess.result = { docEntry: result.DocEntry, docNum: result.DocNum };
    sess.step   = 'DONE';

    sess.auditLog.push({
      ts:   ts(),
      step: 'Invoice Posted',
      action: `<a href="/api/three-way-match/print/${result.DocEntry}" target="_blank">AP Invoice #${result.DocNum}</a> posted to SAP B1 at ${esc(grpoDetail.CardName || grpoDetail.CardCode)}.`,
    });

    // Log to SQLite
    try {
      db.prepare(`
        INSERT INTO three_way_match_log
          (session_id,grpo_num,invoice_num,vendor_code,vendor_name,invoice_total,
           match_status,discrepancies,resolution,sap_doc_entry,sap_doc_num)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        sid,
        grpoDetail.DocNum,
        invoiceNum || null,
        grpoDetail.CardCode || null,
        grpoDetail.CardName || null,
        lines.reduce((s, l) => s + l.invQty * l.invPrice, 0),
        sess.discrepancies.length > 0 ? 'discrepancy_accepted' : 'clean_match',
        JSON.stringify(sess.discrepancies),
        sess.resolution || null,
        result.DocEntry,
        result.DocNum,
      );
    } catch (dbErr) {
      console.warn('[THREE-WAY-MATCH] SQLite log error:', dbErr.message);
    }

    const replyHtml = `<div style="background:#d1fae5;border:1px solid #6ee7b7;border-radius:8px;padding:14px 16px;margin-bottom:10px">
      <div style="font-size:14px;font-weight:700;color:#065f46;margin-bottom:6px">✅ AP Invoice Posted Successfully!</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px;font-size:12.5px;color:#374151">
        <div><strong>AP Invoice #:</strong> ${result.DocNum}</div>
        <div><strong>Doc Entry:</strong> ${result.DocEntry}</div>
        <div><strong>Vendor:</strong> ${esc(grpoDetail.CardName || grpoDetail.CardCode)}</div>
        <div><strong>Invoice Ref:</strong> ${esc(invoiceNum || '—')}</div>
        <div><strong>GRPO Source:</strong> GRPO #${grpoDetail.DocNum}</div>
        <div><strong>Lines:</strong> ${lines.length}</div>
      </div>
    </div>
    ${buildAuditHTML(sess.auditLog)}`;

    res.json({
      ok: true, reply: replyHtml,
      quickReplies: ['Start New Match'],
      sessionId: sid, step: sess.step,
      meta: { docEntry: result.DocEntry, docNum: result.DocNum, printUrl: `/api/three-way-match/print/${result.DocEntry}` },
    });

  } catch (err) {
    sess.auditLog.push({ ts: ts(), step: 'Post Failed', action: `SAP error: ${esc(err.message)}` });
    res.json({
      ok: true,
      reply: `<div style="background:#fee2e2;border:1px solid #fca5a5;border-radius:6px;padding:12px 14px;color:#991b1b;font-size:13px">
        ❌ <strong>Failed to post AP Invoice</strong><br><em>${esc(err.message)}</em><br>Please check the SAP B1 connection and retry.
      </div>`,
      quickReplies: ['Retry Post', 'Cancel'],
      sessionId: sid, step: sess.step,
    });
  }
}
