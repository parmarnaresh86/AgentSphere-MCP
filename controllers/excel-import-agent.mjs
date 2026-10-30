/**
 * Excel Import agents — one engine, one router per SAP object.
 * Mounted by chat-server.mjs (UI: public/excel-import.html?type=…):
 *   /api/so-excel-import     Sales Orders          (Orders)
 *   /api/item-excel-import   Item Master           (Items + ItemPrices)
 *   /api/bp-excel-import     Business Partners     (BusinessPartners + BPAddresses)
 *   /api/bom-excel-import    Bills of Materials    (ProductTrees + ProductTreeLines)
 *   /api/apinv-excel-import  A/P expense invoices  (PurchaseInvoices, service type)
 *   /api/salary-jv-import    Salary journal entries (JournalEntries)
 * What differs per object lives in lib/excel-import-types.mjs.
 *
 *  Templates — each company keeps any number of templates per agent. A template is a
 *              list of columns: Excel heading (+ other accepted headings) → SAP target
 *              (a header / line field, a UDF, the record key, information only, a
 *              salary head with its own G/L account and side, or ignored), with type,
 *              required flag, default and example. "Group key" columns decide which rows
 *              form one record. Layout "table" reads a heading row (every sheet that has
 *              it); layout "form" reads "label | value" cells, one record per sheet.
 *  1. Upload   — read an .xlsx / .csv with a chosen template (or the best match).
 *  2. Validate — required values, types, values that disagree between rows of one
 *                record, object rules (JE balance, BOM components …), then SAP master
 *                data. Records with any issue go to "Missing data"; the rest to "Pending".
 *  3. Post     — POST (or PATCH when updating an existing master record) on the
 *                Service Layer, one record at a time.
 *
 *  GET  /meta   GET /sap-fields   GET|POST /templates   GET|PUT|DELETE /templates/:id
 *  POST /templates/:id/default    GET /templates/:id/excel    POST /templates/detect (file)
 *  POST /upload (file, templateId|auto)   GET /orders?tab=&q=&tpl=   GET /orders/:id
 *  POST /post | /recheck | /delete  { ids }   GET /batches   GET /export?tab=
 */

import { Router } from 'express';
import multer from 'multer';
import ExcelJS from 'exceljs';
import { Readable } from 'stream';
import { importRepo, userPermRepo, connRepo } from '../db.mjs';
import { DOC_TYPES } from '../lib/excel-import-types.mjs';

const PERM_TEMPLATES = 'tools.excel_import_templates';
const MAX_ROWS = 20000;
const MAX_POST = 50;          // records per /post call — the UI posts in chunks to show progress
const MAX_COLUMNS = 150;
const FORM_SCAN = { rows: 200, cols: 30 };
const _upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

const esc = s => String(s ?? '').replace(/'/g, "''");
const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const today = () => ymd(new Date());
const normHead = s => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const blank = v => v == null || v === '';
const TYPES = ['text', 'number', 'int', 'date', 'yesno', 'enum'];

// ── Catalog per object ────────────────────────────────────────────────────────
// target = "header.<SL property>" | "line.<SL property>" | "key" | "info.header" |
// "info.line" | "ignore" | "head" (salary head → JE line, journal entries only).
const KEY_ALIASES = ['orderno', 'ordernumber', 'sono', 'salesorderno', 'salesorder', 'orderref', 'orderreference', 'refno', 'orderid', 'docno', 'documentno'];
function buildCatalog(T) {
  const list = [
    { target: 'key', level: 'header', label: `${T.key === 'order' ? 'Order No' : 'Record key'} (groups rows — not posted)`, type: 'text', special: true, aliases: T.key === 'order' ? KEY_ALIASES : [] },
    { target: 'info.header', level: 'header', label: 'Information only — record level (not posted)', type: 'text', special: true },
    { target: 'info.line', level: 'line', label: 'Information only — line level (not posted)', type: 'text', special: true },
    { target: 'ignore', level: null, label: 'Not mapped (ignored)', type: 'text', special: true },
    ...T.fields,
  ];
  const map = new Map(list.map(f => [f.target, f]));
  const suggest = new Map(list.flatMap(f => [normHead(f.label), normHead(f.field || ''), ...(f.aliases || [])].filter(Boolean).map(a => [a, f.target])));
  return { list, map, suggest, core: T.fields.filter(f => f.core) };
}
const CATALOGS = Object.fromEntries(Object.entries(DOC_TYPES).map(([k, T]) => [k, buildCatalog(T)]));

// What a column's target means: level, SL property, type, lookup. Custom / UDF targets
// ("header.U_Region") carry their type on the column.
function targetInfo(col, T) {
  const c = CATALOGS[T.key].map.get(col.target);
  if (c) return c;
  const m = String(col.target || '').match(/^(header|line)\.([A-Za-z_][A-Za-z0-9_]*)$/);
  if (!m) return null;
  return { target: col.target, level: m[1], field: m[2], label: m[2], type: TYPES.includes(col.type) && col.type !== 'enum' ? col.type : 'text', custom: true };
}

// ── Template validation ───────────────────────────────────────────────────────
function cleanTemplate(body, T) {
  const errors = [];
  const name = String(body?.name || '').trim().slice(0, 80);
  if (!name) errors.push('Template name is required');
  const dateFormat = ['DMY', 'MDY', 'YMD'].includes(body?.dateFormat) ? body.dateFormat : 'DMY';
  const layout = body?.layout === 'form' ? 'form' : 'table';
  const options = {};
  for (const [k, def] of Object.entries(T.options || {})) options[k] = String(body?.options?.[k] ?? def.default ?? '').slice(0, 200);
  if (T.updatable) options.onExisting = body?.options?.onExisting === 'update' ? 'update' : 'error';
  const raw = Array.isArray(body?.columns) ? body.columns.slice(0, MAX_COLUMNS) : [];
  const columns = raw.map((c, i) => ({
    id: String(c.id || `c${i + 1}`).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) || `c${i + 1}`,
    heading: String(c.heading || '').trim().slice(0, 80),
    aliases: (Array.isArray(c.aliases) ? c.aliases : String(c.aliases || '').split(',')).map(a => String(a).trim()).filter(Boolean).slice(0, 30),
    target: String(c.target || '').trim(),
    type: TYPES.includes(c.type) ? c.type : 'text',
    required: !!c.required,
    default: blank(c.default) ? '' : String(c.default).slice(0, 254),
    groupKey: !!c.groupKey,
    example: blank(c.example) ? '' : String(c.example).slice(0, 100),
    ...(c.target === 'head' ? { account: String(c.account || '').trim().slice(0, 100), side: c.side === 'C' ? 'C' : c.side === 'D' ? 'D' : '' } : {}),
  }));
  if (!columns.length) errors.push('Add at least one column');
  const ids = new Set(), heads = new Map(), targets = new Map();
  columns.forEach((c, i) => {
    const n = `Column ${i + 1}${c.heading ? ` "${c.heading}"` : ''}`;
    while (ids.has(c.id)) c.id += '_';
    ids.add(c.id);
    const t = targetInfo(c, T);
    if (!t) { errors.push(`${n}: choose the SAP field it fills (other fields look like "U_Region" or "Project")`); return; }
    if (!t.custom) c.type = t.type;
    if (!c.heading && blank(c.default)) errors.push(`${n}: give it an Excel heading, or a default value to send on every record`);
    if (c.target === 'head' && !c.heading) errors.push(`${n}: a salary head needs an Excel heading`);
    if (c.groupKey && t.level !== 'header') errors.push(`${n}: only record-level (header) columns can be a group key`);
    if (c.target === 'key' && !c.groupKey) c.groupKey = true;
    if (c.target === 'ignore') { c.required = false; c.default = ''; }
    for (const h of [c.heading, ...c.aliases].filter(Boolean).map(normHead)) {
      if (heads.has(h) && heads.get(h) !== c.id) errors.push(`${n}: the heading "${h}" is also used by another column`);
      heads.set(h, c.id);
    }
    if (!c.target.startsWith('info.') && !['ignore', 'head'].includes(c.target)) {
      if (targets.has(c.target)) errors.push(`${n}: ${t.label} is already filled by column "${targets.get(c.target)}"`);
      targets.set(c.target, c.heading || c.id);
    }
    if (!blank(c.default) && parseValue(c.default, c.type, dateFormat, t) === undefined) errors.push(`${n}: default "${c.default}" is not a valid ${typeName(c.type)}`);
  });
  if (!columns.some(c => c.groupKey)) errors.push('Mark at least one record-level column as "Group key" — rows with the same key become one record');
  for (const f of CATALOGS[T.key].core) if (!targets.has(f.target)) errors.push(`SAP needs ${f.label} — map a column to it or give one a default`);
  const tpl = { id: Number(body?.id) || undefined, name, description: String(body?.description || '').slice(0, 300), dateFormat, layout, options, columns, isDefault: !!body?.isDefault };
  if (T.templateCheck) errors.push(...T.templateCheck(tpl));
  return { errors, tpl };
}
const typeName = t => ({ int: 'whole number', yesno: 'Yes / No', enum: 'choice' }[t] || t);

// ── Cell values ───────────────────────────────────────────────────────────────
function cellValue(v) {
  if (v == null) return null;
  if (v instanceof Date) return v;
  if (typeof v === 'object') {
    if ('result' in v) return cellValue(v.result);
    if (Array.isArray(v.richText)) return v.richText.map(t => t.text).join('');
    if ('text' in v) return cellValue(v.text);
    if ('error' in v) return null;
    return String(v);
  }
  return v;
}
const textOf = v => { v = cellValue(v); return v == null ? '' : v instanceof Date ? ymd(v) : String(v).trim(); };

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
// Excel dates, ISO, numeric text in the template's order (DMY / MDY), 30-Oct-2026, Oct-30-2026; "TODAY".
function parseDate(v, fmt) {
  if (v instanceof Date) return isNaN(v) ? undefined : ymd(new Date(v.getUTCFullYear(), v.getUTCMonth(), v.getUTCDate()));
  if (typeof v === 'number') {
    if (v < 20000 || v > 80000) return undefined;
    const d = new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 864e5);
    return ymd(new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  }
  const s = String(v).trim();
  if (/^today$/i.test(s)) return today();
  let y, m, d, x;
  if ((x = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/))) [y, m, d] = [+x[1], +x[2], +x[3]];
  else if ((x = s.match(/^(\d{1,2})[-/. ](\d{1,2})[-/. ](\d{2,4})$/))) [d, m, y] = fmt === 'MDY' ? [+x[2], +x[1], +x[3]] : [+x[1], +x[2], +x[3]];
  else if ((x = s.match(/^(\d{1,2})[-/. ]([A-Za-z]{3,4})[A-Za-z]*[-/., ]+(\d{2,4})$/))) [d, m, y] = [+x[1], MONTHS[x[2].toLowerCase()], +x[3]];
  else if ((x = s.match(/^([A-Za-z]{3,4})[A-Za-z]*[-/. ]+(\d{1,2})[,]?[-/. ]+(\d{2,4})$/))) [m, d, y] = [MONTHS[x[1].toLowerCase()], +x[2], +x[3]];
  else return undefined;
  if (y < 100) y += 2000;
  const dt = new Date(y, (m || 0) - 1, d);
  return m && dt.getMonth() === m - 1 && dt.getDate() === d ? ymd(dt) : undefined;
}
// Raw cell / default → typed value. '' → null, unreadable → undefined.
function parseValue(raw, type, fmt, field) {
  const v = cellValue(raw);
  if (v == null || (typeof v === 'string' && v.trim() === '')) return null;
  if (type === 'date') return parseDate(v, fmt);
  if (type === 'number' || type === 'int') {
    const s = typeof v === 'number' ? '' : String(v).replace(/[,\s₹$€£%]/g, '').replace(/^\((.*)\)$/, '-$1');
    if (typeof v !== 'number' && s === '') return null;
    const n = typeof v === 'number' ? v : Number(s);
    if (!Number.isFinite(n) || (type === 'int' && !Number.isInteger(n))) return undefined;
    return n;
  }
  if (type === 'yesno') {
    const s = String(v).trim().toLowerCase();
    if (['y', 'yes', 'true', '1', 'tyes'].includes(s) || v === true) return 'tYES';
    if (['n', 'no', 'false', '0', 'tno'].includes(s) || v === false) return 'tNO';
    return undefined;
  }
  if (type === 'enum' && field?.enum) {
    const s = normHead(v);
    for (const [val, names] of Object.entries(field.enum)) if (normHead(val) === s || names.map(normHead).includes(s)) return val;
    return undefined;
  }
  return textOf(v);
}
const enumHint = f => f?.enum ? ` (use ${Object.values(f.enum).map(a => a[0]).join(' / ')})` : '';

// ── Read the sheet ────────────────────────────────────────────────────────────
async function loadWorkbook(file) {
  const wb = new ExcelJS.Workbook();
  const name = String(file.originalname || '').toLowerCase();
  if (name.endsWith('.csv') || file.mimetype === 'text/csv') await wb.csv.read(Readable.from(file.buffer));
  else if (name.endsWith('.xls')) throw httpError(400, 'Old .xls files are not supported — open the file in Excel and save it as .xlsx.');
  else await wb.xlsx.load(file.buffer);
  return wb;
}
const headingsOf = tpl => {
  const byHead = new Map();
  for (const c of tpl.columns) for (const h of [c.heading, ...c.aliases].filter(Boolean)) byHead.set(normHead(h), c.id);
  return byHead;
};

// Table layout: in every sheet, the row (of the first 10) naming the most template
// columns. Every sheet close to the best match is read (e.g. one sheet per department).
function findTables(wb, tpl) {
  const byHead = headingsOf(tpl);
  const minHits = Math.min(2, tpl.columns.filter(c => c.heading).length) || 1;
  const found = [];
  wb.eachSheet(ws => {
    let best = null;
    for (let r = 1; r <= Math.min(10, ws.rowCount); r++) {
      const map = {}, unknown = [], used = new Set();
      ws.getRow(r).eachCell((cell, col) => {
        const head = textOf(cell.value);
        if (!head) return;
        const id = byHead.get(normHead(head));
        if (id && !used.has(id)) { map[col] = { id, head }; used.add(id); } else unknown.push(head);
      });
      if (used.size >= minHits && (!best || used.size > best.hits)) best = { ws, headerRow: r, map, unknown, hits: used.size, used };
    }
    if (best) found.push(best);
  });
  if (!found.length) return null;
  const top = Math.max(...found.map(t => t.hits));
  const tables = found.filter(t => t.hits >= Math.max(minHits, Math.ceil(top * 0.6)));
  const used = new Set(tables.flatMap(t => [...t.used]));
  return { kind: 'table', tables, hits: top, used, sheetNames: tables.map(t => t.ws.name), headerRow: tables[0].headerRow,
    map: tables[0].map, unknown: [...new Set(tables.flatMap(t => t.unknown))] };
}
function readTableRows(found) {
  const rows = [];
  const multi = found.tables.length > 1;
  for (const { ws, headerRow, map } of found.tables) {
    for (let r = headerRow + 1; r <= ws.rowCount && rows.length < MAX_ROWS; r++) {
      const row = ws.getRow(r);
      const rec = { _row: r, ...(multi ? { _sheet: ws.name } : {}) };
      let any = false;
      for (const [col, { id }] of Object.entries(map)) {
        const raw = row.getCell(Number(col)).value;
        rec[id] = raw;
        if (textOf(raw) !== '') any = true;
      }
      if (any) rows.push(rec);
    }
  }
  return rows;
}

// Form layout: each sheet is one record of "label | value" cells (a salary slip).
// The value is the next filled cell to the right (not itself a label), else the cell
// below; "Employee Name: Ramesh" in one cell works too.
function readForms(wb, tpl) {
  const byHead = headingsOf(tpl);
  const records = [], used = new Set(), unknown = [];
  let sheets = 0;
  wb.eachSheet(ws => {
    const rec = { _row: ws.name };
    let hits = 0;
    const maxR = Math.min(ws.rowCount, FORM_SCAN.rows), maxC = Math.min(ws.columnCount || FORM_SCAN.cols, FORM_SCAN.cols);
    const text = (r, c) => textOf(ws.getRow(r).getCell(c).value);
    for (let r = 1; r <= maxR; r++) {
      for (let c = 1; c <= maxC; c++) {
        const t = text(r, c);
        if (!t) continue;
        let id = byHead.get(normHead(t)), inline = null;
        if (!id && t.includes(':')) { const [a, ...b] = t.split(':'); id = byHead.get(normHead(a)); inline = b.join(':').trim(); }
        if (!id || id in rec) continue;
        let raw;
        if (inline) raw = inline;
        else {
          for (let k = c + 1; k <= Math.min(c + 4, maxC); k++) {
            const cell = ws.getRow(r).getCell(k).value, tt = textOf(cell);
            if (!tt) continue;
            if (!byHead.has(normHead(tt))) raw = cell;
            break;
          }
          if (raw === undefined && r < maxR) { const below = ws.getRow(r + 1).getCell(c).value; if (textOf(below) && !byHead.has(normHead(textOf(below)))) raw = below; }
        }
        if (raw === undefined) continue;
        rec[id] = raw; used.add(id); hits++;
      }
    }
    if (hits >= 2) { records.push(rec); sheets++; } else unknown.push(ws.name);
  });
  if (!records.length) return null;
  return { kind: 'form', rows: records, used, hits: used.size, sheetNames: records.map(r => r._row), headerRow: null, map: {}, unknown, sheets };
}
const where = rec => typeof rec._row === 'number' ? `Row ${rec._row}${rec._sheet ? ` (${rec._sheet})` : ''}` : `Sheet "${rec._row}"`;

// ── Build records ─────────────────────────────────────────────────────────────
const colsAt = (tpl, level, T) => tpl.columns.filter(c => targetInfo(c, T)?.level === level);

// Rows sharing the group-key values form one record. Group keys are parsed per their
// type so 30/10/2026 and an Excel date of the same day group together.
function groupRecords(rows, tpl, T) {
  const keyCols = tpl.columns.filter(c => c.groupKey);
  const out = new Map();
  for (const rec of rows) {
    const parts = keyCols.map(c => {
      const v = parseValue(rec[c.id], c.type, tpl.dateFormat, targetInfo(c, T));
      return v == null ? (c.default || '') : String(v ?? textOf(rec[c.id]));
    });
    let key = parts.filter(Boolean).join(' / ');
    const blankKey = !key;
    if (blankKey) key = typeof rec._row === 'number' ? `ROW-${rec._sheet ? rec._sheet + '-' : ''}${rec._row}` : `SHEET-${rec._row}`;
    if (!out.has(key)) out.set(key, { orderKey: key, rows: [], issues: [] });
    const o = out.get(key);
    if (blankKey) o.issues.push({ message: `${where(rec)}: ${keyCols.map(c => c.heading).join(' / ')} is empty — cannot tell which ${T.noun.toLowerCase()} this belongs to` });
    o.rows.push(rec);
  }
  return [...out.values()];
}

// Typed values per column id → the SAP properties they fill.
function mapToSap(cells, cols, T) {
  const sap = {};
  for (const c of cols) {
    const t = targetInfo(c, T);
    if (!t?.field) continue;
    const v = cells[c.id];
    if (!blank(v)) sap[t.field] = t.max && typeof v === 'string' ? v.slice(0, t.max) : v;
  }
  return sap;
}

// Header + lines of one record, with the problems found in the sheet itself
// (types, required values, header values that disagree). Kept through re-checks.
function buildRecord(o, tpl, T) {
  const fmt = tpl.dateFormat;
  const issues = [...o.issues];
  const cells = {};
  for (const c of colsAt(tpl, 'header', T)) {
    const f = targetInfo(c, T);
    const vals = new Map();
    let bad = false;
    for (const rec of o.rows) {
      const raw = rec[c.id];
      const v = parseValue(raw, c.type, fmt, f);
      if (v === undefined) { bad = true; issues.push({ message: `${where(rec)}: ${c.heading} "${textOf(raw)}" is not a valid ${typeName(c.type)}${enumHint(f)}` }); continue; }
      if (v !== null && !vals.has(v)) vals.set(v, rec);
    }
    if (vals.size > 1) issues.push({ message: `${c.heading} differs between rows of this ${T.noun.toLowerCase()}: ${[...vals.entries()].map(([v, rec]) => `"${v}" (${where(rec).toLowerCase()})`).join(', ')}` });
    cells[c.id] = vals.size ? [...vals.keys()][0] : (blank(c.default) ? null : parseValue(c.default, c.type, fmt, f));
    if (blank(cells[c.id]) && c.required && !bad) issues.push({ message: `${c.heading} is missing` });
  }
  const lineCols = colsAt(tpl, 'line', T);
  const lines = [];
  for (const rec of o.rows) {
    // A row with nothing in the line columns carries only record-level data.
    if (!lineCols.some(c => textOf(rec[c.id]) !== '')) continue;
    const l = { lineNo: lines.length + 1, row: typeof rec._row === 'number' ? rec._row : 0, where: where(rec), cells: {}, issues: [], itemName: '' };
    for (const c of lineCols) {
      const f = targetInfo(c, T);
      const v = parseValue(rec[c.id], c.type, fmt, f);
      if (v === undefined) l.issues.push(`${c.heading} "${textOf(rec[c.id])}" is not a valid ${typeName(c.type)}${enumHint(f)}`);
      l.cells[c.id] = v == null ? (blank(c.default) ? null : parseValue(c.default, c.type, fmt, f)) : v;
      if (v !== undefined && blank(l.cells[c.id]) && c.required) l.issues.push(`${c.heading} is missing`);
    }
    const info = lineCols.find(c => c.target === 'info.line' || c.target === 'line.ItemDescription');
    l.itemName = info ? String(l.cells[info.id] ?? '') : '';
    l.localIssues = [...l.issues];
    lines.push(l);
  }
  const infoName = colsAt(tpl, 'header', T).find(c => c.target === 'info.header');
  const header = { cells, sap: {}, cardName: infoName ? String(cells[infoName.id] ?? '') : '', name: '', mode: 'create' };
  if (T.linesRequired && !lines.length) issues.push({ message: `No lines — fill ${lineCols.filter(c => c.required).map(c => c.heading).join(', ') || 'the line columns'}` });
  return { orderKey: o.orderKey, header, lines, issues: issues.map(i => ({ ...i, local: true })) };
}

// Mapping + object rules; run after every upload and re-check (they only read the cells).
function applyRules(rec, tpl, T) {
  rec.header.sap = mapToSap(rec.header.cells || {}, colsAt(tpl, 'header', T), T);
  T.defaults?.(rec);
  const lineCols = colsAt(tpl, 'line', T);
  for (const l of rec.lines) {
    l.sap = mapToSap(l.cells || {}, lineCols, T);
    l.issues = [...(l.localIssues || []), ...(T.lineRules?.(l.sap) || [])];
  }
  if (T.jeLines) {
    const { lines, issues } = T.buildLines(rec, tpl);
    rec.header.jeLines = lines;
    rec.header.memo = T.memo(rec, tpl);
    for (const m of issues) rec.issues.push({ message: m });
  }
  for (const m of T.rules?.(rec) || []) rec.issues.push({ message: m });
}

// ── SAP master data ───────────────────────────────────────────────────────────
async function fetchAll(sap, path, params, max = 5000) {
  const out = [];
  while (out.length < max) {
    const r = await sap.get(path, { ...params, $skip: out.length });
    const page = Array.isArray(r?.value) ? r.value : [];
    out.push(...page);
    if (!page.length || !(r['odata.nextLink'] || r['@odata.nextLink'])) break;
  }
  return out;
}
// Look codes up 15 at a time ("Code eq 'a' or Code eq 'b' …").
async function fetchByCodes(sap, entity, keyField, codes, select) {
  const found = new Map();
  const list = [...new Set(codes.filter(c => !blank(c)).map(String))];
  for (let i = 0; i < list.length; i += 15) {
    const chunk = list.slice(i, i + 15);
    const rows = await fetchAll(sap, entity, { $filter: chunk.map(c => `${keyField} eq '${esc(c)}'`).join(' or '), $select: select });
    for (const r of rows) found.set(String(r[keyField]).toUpperCase(), r);
  }
  return found;
}
const optional = p => p.catch(() => null);
const byText = (rows, keys) => v => { const s = String(v).toLowerCase(); for (const k of keys) { const hit = rows.find(r => String(r[k] ?? '').toLowerCase() === s); if (hit) return hit; } return null; };

// Each lookup: load(sap, values) → data; check(data, value) → { value?, name?, error?, exists? }.
// "optional" lookups are skipped when SAP does not answer (e.g. branches switched off).
const bpLookup = (cardType, label) => ({
  load: (sap, v) => fetchByCodes(sap, '/BusinessPartners', 'CardCode', v, 'CardCode,CardName,CardType,Frozen,Valid'),
  check: (d, v) => {
    const bp = d.get(String(v).toUpperCase());
    if (!bp) return { error: `${label} ${v} does not exist in SAP` };
    const out = { value: bp.CardCode, name: bp.CardName };
    const kind = { cCustomer: 'customer', cSupplier: 'vendor', cLid: 'lead' }[bp.CardType] || 'other';
    if (cardType && bp.CardType !== cardType) out.error = `${bp.CardCode} is not a ${label.toLowerCase()} in SAP (it is a ${kind} account)`;
    else if (bp.Frozen === 'tYES' || bp.Valid === 'tNO') out.error = `${label} ${bp.CardCode} is inactive in SAP`;
    return out;
  },
});
const itemLookup = flag => ({
  load: (sap, v) => fetchByCodes(sap, '/Items', 'ItemCode', v, 'ItemCode,ItemName,SalesItem,PurchaseItem,InventoryItem,Frozen,Valid'),
  check: (d, v) => {
    const it = d.get(String(v).toUpperCase());
    if (!it) return { error: `Item ${v} does not exist in SAP` };
    const out = { value: it.ItemCode, name: it.ItemName };
    if (flag && it[flag] === 'tNO') out.error = `Item ${it.ItemCode} is not a ${flag === 'SalesItem' ? 'sales' : 'purchase'} item`;
    else if (it.Frozen === 'tYES' || it.Valid === 'tNO') out.error = `Item ${it.ItemCode} is inactive in SAP`;
    return out;
  },
});
const existsLookup = (entity, key, label) => ({
  load: (sap, v) => fetchByCodes(sap, entity, key, v, key),
  check: (d, v) => (d.has(String(v).toUpperCase()) ? { exists: true, label } : {}),
});
const listLookup = (load, find, label, resolve) => ({
  optional: true,
  load,
  check: (d, v) => { const hit = find(d)(v); return hit ? { value: resolve(hit), name: hit.__name } : { error: `${label} "${v}" does not exist in SAP` }; },
});
const LOOKUPS = {
  customer: bpLookup('cCustomer', 'Customer'),
  supplier: bpLookup('cSupplier', 'Vendor'),
  bpAny: bpLookup(null, 'Business partner'),
  item: itemLookup(null),
  salesItem: itemLookup('SalesItem'),
  newItem: existsLookup('/Items', 'ItemCode', 'Item'),
  newBP: existsLookup('/BusinessPartners', 'CardCode', 'Business partner'),
  newBOM: existsLookup('/ProductTrees', 'TreeCode', 'A bill of materials for'),
  warehouse: {
    optional: true,
    load: sap => fetchAll(sap, '/Warehouses', { $select: 'WarehouseCode,WarehouseName,Inactive' }),
    check: (d, v) => {
      const w = d.find(x => String(x.WarehouseCode).toUpperCase() === String(v).toUpperCase());
      if (!w) return { error: `Warehouse ${v} does not exist in SAP` };
      return { value: w.WarehouseCode, ...(w.Inactive === 'tYES' ? { error: `Warehouse ${w.WarehouseCode} is inactive` } : {}) };
    },
  },
  tax: {
    optional: true,
    load: async sap => {
      const [vat, stc] = await Promise.all([optional(fetchAll(sap, '/VatGroups', { $select: 'Code,Inactive' })), optional(fetchAll(sap, '/SalesTaxCodes', { $select: 'Code' }))]);
      if (!vat && !stc) throw new Error('no tax codes');
      return new Set([...(vat || []), ...(stc || [])].filter(t => t.Inactive !== 'tYES').map(t => String(t.Code).toUpperCase()));
    },
    check: (d, v) => (d.has(String(v).toUpperCase()) ? {} : { error: `Tax code ${v} does not exist in SAP` }),
  },
  salesPerson: listLookup(sap => fetchAll(sap, '/SalesPersons', { $select: 'SalesEmployeeCode,SalesEmployeeName' }),
    d => byText(d, ['SalesEmployeeCode', 'SalesEmployeeName']), 'Sales employee', h => h.SalesEmployeeCode),
  branch: listLookup(sap => fetchAll(sap, '/BusinessPlaces', { $select: 'BPLID,BPLName,Disabled' }),
    d => byText(d, ['BPLID', 'BPLName']), 'Branch', h => h.BPLID),
  itemGroup: listLookup(sap => fetchAll(sap, '/ItemGroups', { $select: 'Number,GroupName' }),
    d => byText(d, ['Number', 'GroupName']), 'Item group', h => h.Number),
  bpGroup: listLookup(sap => fetchAll(sap, '/BusinessPartnerGroups', { $select: 'Code,Name,Type' }),
    d => byText(d, ['Code', 'Name']), 'BP group', h => h.Code),
  paymentTerms: listLookup(sap => fetchAll(sap, '/PaymentTermsTypes', { $select: 'GroupNumber,PaymentTermsGroupName' }),
    d => byText(d, ['GroupNumber', 'PaymentTermsGroupName']), 'Payment terms', h => h.GroupNumber),
  // G/L accounts by internal code, account number (FormatCode) or name → internal code.
  account: {
    load: async (sap, values) => {
      const found = [];
      const list = [...new Set(values.filter(v => !blank(v)).map(String))];
      for (let i = 0; i < list.length; i += 5) {
        const f = list.slice(i, i + 5).map(v => `Code eq '${esc(v)}' or FormatCode eq '${esc(v)}' or Name eq '${esc(v)}'`).join(' or ');
        found.push(...await fetchAll(sap, '/ChartOfAccounts', { $filter: f, $select: 'Code,Name,FormatCode,ActiveAccount,FrozenFor' }));
      }
      return found;
    },
    check: (d, v) => {
      const s = String(v).toLowerCase();
      const a = d.find(x => String(x.Code).toLowerCase() === s) || d.find(x => String(x.FormatCode || '').toLowerCase() === s) || d.find(x => String(x.Name || '').toLowerCase() === s);
      if (!a) return { error: `G/L account "${v}" does not exist in SAP` };
      const out = { value: a.Code, name: a.Name, label: `${a.FormatCode || a.Code} — ${a.Name}` };
      if (a.ActiveAccount === 'tNO') out.error = `G/L account ${a.FormatCode || a.Code} (${a.Name}) is a title account — it cannot be posted to`;
      else if (a.FrozenFor === 'tYES') out.error = `G/L account ${a.FormatCode || a.Code} (${a.Name}) is inactive`;
      return out;
    },
  },
};
const lookupsOf = f => (Array.isArray(f.lookup) ? f.lookup : f.lookup ? [f.lookup] : []);

async function loadMasterData(sap, recs, T) {
  const want = {};
  const add = (kind, v) => { if (!blank(v)) (want[kind] ||= []).push(String(v)); };
  for (const f of T.fields) for (const kind of lookupsOf(f)) for (const r of recs) {
    if (f.level === 'header') add(kind, r.header.sap[f.field]);
    else for (const l of r.lines) add(kind, l.sap[f.field]);
  }
  if (T.jeLines) for (const r of recs) for (const l of r.header.jeLines || []) if (!l.ShortName || l.AccountCode) add('account', l.AccountCode);
  const md = {};
  await Promise.all(Object.entries(want).map(async ([kind, values]) => {
    const L = LOOKUPS[kind];
    md[kind] = L.optional ? await optional(L.load(sap, values)) : await L.load(sap, values);
  }));
  if (T.dupCheck) md.dup = await optional(loadDuplicates(sap, recs, T.dupCheck));
  return md;
}
// Existing documents with the same values (e.g. vendor + vendor invoice no).
async function loadDuplicates(sap, recs, dc) {
  const pairs = recs.map(r => dc.fields.map(f => r.header.sap[f])).filter(p => p.every(v => !blank(v)));
  const found = [];
  for (let i = 0; i < pairs.length; i += 8) {
    const f = pairs.slice(i, i + 8).map(p => `(${dc.fields.map((k, j) => `${k} eq '${esc(p[j])}'`).join(' and ')})`).join(' or ');
    found.push(...await fetchAll(sap, dc.entity, { $filter: `(${f}) and Cancelled eq 'tNO'`, $select: ['DocEntry', 'DocNum', ...dc.fields].join(',') }));
  }
  return found;
}

// SAP checks; resolves names to the codes the payload needs and fills display names.
function checkAgainstSap(rec, md, T, tpl) {
  const h = rec.header.sap;
  const push = message => rec.issues.push({ message });
  rec.header.mode = 'create';
  for (const f of T.fields.filter(f => f.level === 'header')) {
    if (blank(h[f.field])) continue;
    for (const kind of lookupsOf(f)) {
      if (!md[kind]) continue;
      const r = LOOKUPS[kind].check(md[kind], h[f.field]);
      if (r.exists) {
        if (T.updatable && tpl.options?.onExisting === 'update') rec.header.mode = 'update';
        else push(`${r.label} ${h[f.field]} already exists in SAP${T.updatable ? ' — switch on "Update existing records" in the template to change it' : ''}`);
        continue;
      }
      if (r.error) push(r.error);
      if (r.value !== undefined) h[f.field] = r.value;
      if (r.name) { if (['customer', 'supplier', 'bpAny'].includes(kind) && f.field === 'CardCode') rec.header.cardName = r.name; else rec.header.name = rec.header.name || r.name; }
    }
  }
  if (rec.header.mode === 'update') rec.header.updateNote = `${T.noun} exists in SAP — it will be updated`;
  else delete rec.header.updateNote;
  for (const l of rec.lines) {
    for (const f of T.fields.filter(f => f.level === 'line')) {
      if (blank(l.sap[f.field])) continue;
      for (const kind of lookupsOf(f)) {
        if (!md[kind]) continue;
        const r = LOOKUPS[kind].check(md[kind], l.sap[f.field]);
        if (r.error) l.issues.push(r.error);
        if (r.value !== undefined) l.sap[f.field] = r.value;
        if (r.name && /item$/i.test(kind)) l.itemName = l.itemName || r.name;
        if (r.name && kind === 'account') { l.accountName = r.name; l.accountLabel = r.label; }
      }
    }
  }
  if (T.jeLines && md.account) {
    for (const l of rec.header.jeLines || []) {
      if (blank(l.AccountCode)) continue;
      const r = LOOKUPS.account.check(md.account, l.AccountCode);
      if (r.error) push(`${l.head ? `Salary head "${l.head}"` : 'Journal line'}: ${r.error}`);
      if (r.value !== undefined) { l.accountLabel = r.label; l.AccountCode = r.value; }
    }
  }
  if (T.dupCheck && md.dup) {
    const hit = md.dup.find(d => T.dupCheck.fields.every(k => String(d[k] ?? '').toLowerCase() === String(h[k] ?? '').toLowerCase()));
    if (hit) push(T.dupCheck.label(h, hit));
  }
}

// Line issues are listed with the record too, so the Missing tab shows one list.
function finalise(rec, T) {
  const issues = rec.issues.filter(i => !i.line);
  for (const l of rec.lines) for (const m of l.issues) issues.push({ line: l.lineNo, row: l.row, message: `Line ${l.lineNo} (${(l.where || `row ${l.row}`).toLowerCase()}): ${m}` });
  rec.issues = issues;
  rec.total = T.value(rec);
  rec.lineCount = T.jeLines ? (rec.header.jeLines || []).length : rec.lines.length;
  rec.summary = T.summary(rec, { cardName: rec.header.cardName, name: rec.header.name });
  return rec;
}

// "SAP 400: {"error":{"message":{"value":"..."}}}" → just the readable message.
function sapErrorText(e) {
  const raw = String(e?.message || e).replace(/^SAP \d+:\s*/, '');
  try {
    const err = JSON.parse(raw).error;
    return err?.message?.value || err?.message || (typeof err === 'string' ? err : raw);
  } catch { return raw; }
}
function httpError(status, message) { const e = new Error(message); e.status = status; return e; }

// ── Sales orders stored before templates existed ──────────────────────────────
// Flat keys (cardCode, itemCode, …) are the Standard template's column ids.
function migrateLegacy(standard, T) {
  const rows = importRepo.legacy();
  if (!rows.length) return;
  const hCols = colsAt(standard, 'header', T), lCols = colsAt(standard, 'line', T);
  const batches = new Set();
  for (const r of rows) {
    const old = JSON.parse(r.header_json || '{}');
    const cells = { orderKey: r.order_key };
    for (const c of hCols) if (c.id in old) cells[c.id] = old[c.id];
    const sap = mapToSap(cells, hCols, T);
    if (old.salesPersonCode != null) sap.SalesPersonCode = old.salesPersonCode;
    if (old.branchId != null) sap.BPL_IDAssignedToInvoice = old.branchId;
    const lines = JSON.parse(r.lines_json || '[]').map(l => {
      const lc = {};
      for (const c of lCols) if (c.id in l) lc[c.id] = l[c.id];
      return { lineNo: l.lineNo, row: l.row, cells: lc, sap: mapToSap(lc, lCols, T), issues: l.issues || [], localIssues: l.localIssues || [], itemName: l.itemName || '' };
    });
    importRepo.rewriteJson(r.id, { cells, sap, cardName: old.cardName || '' }, lines);
    batches.add(r.batch_id);
  }
  for (const b of batches) importRepo.setBatchTemplate(b, standard);
  console.log(`[Excel-Import] Converted ${rows.length} sales order(s) to the template format`);
}

// ── Router ────────────────────────────────────────────────────────────────────
export function createExcelImportRouter(deps, typeKey) {
  const T = DOC_TYPES[typeKey];
  if (!T) throw new Error(`Unknown Excel import type "${typeKey}"`);
  const CAT = CATALOGS[typeKey];
  const { requireAuth, getActiveSap, getActiveConfig } = deps;
  const router = Router();

  // The built-in templates after validation (column types filled in from the catalog).
  const STANDARD = T.standard.map(s => {
    const { errors, tpl } = cleanTemplate(s, T);
    if (errors.length) throw new Error(`${T.title} — built-in template "${s.name}": ${errors.join('; ')}`);
    return tpl;
  });

  const companyOf = () => {
    const cfg = getActiveConfig?.();
    return getActiveSap?.()?._connCredentials?.company || connRepo.getActive()?.company || cfg?.database || cfg?.schema_name || 'default';
  };
  const scope = () => ({ company: companyOf(), type: typeKey });
  const who = req => req.user?.full_name || req.user?.username || '';
  const isAdmin = u => ['admin', 'superadmin'].includes(u?.role);
  const has = (u, keys) => isAdmin(u) || userPermRepo.getEffective(u.user_id, u.role).some(k => keys.includes(k));
  const tplPerms = [PERM_TEMPLATES, ...(T.templatesPerm || [])];
  // These agents write to SAP, so the permission is enforced here as well as in the menu.
  const allowed = (req, res, next) => has(req.user || {}, [T.perm]) ? next() : res.status(403).json({ error: `You do not have access to ${T.title}` });
  const canEdit = (req, res, next) => has(req.user || {}, tplPerms) ? next() : res.status(403).json({ error: 'You do not have permission to change import templates' });
  const wrap = fn => async (req, res) => {
    try { await fn(req, res); }
    catch (e) { res.status(e.status || 500).json({ error: sapErrorText(e), ...(e.errors ? { errors: e.errors } : {}) }); }
  };
  const idsOf = req => [...new Set((Array.isArray(req.body?.ids) ? req.body.ids : []).map(Number).filter(n => n > 0))];

  // Every company starts with the built-in templates of each agent.
  const templatesOf = sc => {
    let list = importRepo.templates(sc);
    if (!list.length) { STANDARD.forEach((t, i) => importRepo.saveTemplate(sc, { ...t, isDefault: i === 0 }, 'system')); list = importRepo.templates(sc); }
    importRepo.linkBatches(sc, list);
    return list;
  };
  if (typeKey === 'order') try { migrateLegacy({ id: null, ...STANDARD[0] }, T); } catch (e) { console.warn('[Excel-Import] legacy conversion failed:', e.message); }

  router.use(requireAuth, allowed);

  const typeInfo = () => ({
    key: T.key, title: T.title, short: T.short, uploadTitle: T.uploadTitle, subtitle: T.subtitle, icon: T.icon, color: T.color, noun: T.noun, nouns: T.nouns,
    docLabel: T.docLabel, headerLabel: T.headerLabel, lineLabel: T.lineLabel, tables: T.tables, listLabels: T.listLabels,
    valueLabel: T.valueLabel, updatable: !!T.updatable, hasHeads: !!T.hasHeads, jeLines: !!T.jeLines,
    options: Object.fromEntries(Object.entries(T.options || {}).map(([k, o]) => [k, { label: o.label, hint: o.hint, default: o.default }])),
    method: `POST ${T.entity}`,
  });

  router.get('/meta', wrap((req, res) => {
    const sc = scope();
    res.json({ ok: true, company: sc.company, user: who(req), type: typeInfo(), counts: importRepo.counts(sc), canEditTemplates: has(req.user, tplPerms),
      templates: templatesOf(sc).map(t => ({ id: t.id, name: t.name, description: t.description, isDefault: t.isDefault, layout: t.layout || 'table', columns: t.columns.length, updatedAt: t.updatedAt, updatedBy: t.updatedBy })) });
  }));

  // ── Templates ───────────────────────────────────────────────────────────
  router.get('/sap-fields', wrap(async (req, res) => {
    let udfs = [], udfError = '';
    try {
      const { header, line } = T.tables;
      const rows = await fetchAll(getActiveSap(), '/UserFieldsMD', { $filter: [header, line].filter(Boolean).map(t => `TableName eq '${t}'`).join(' or '), $select: 'TableName,Name,Description,Type,SubType,Size' });
      const typeOf = u => u.Type === 'db_Date' ? 'date' : u.Type === 'db_Numeric' ? 'int' : u.Type === 'db_Float' ? 'number' : 'text';
      udfs = rows.map(u => ({ target: `${u.TableName === header ? 'header' : 'line'}.U_${u.Name}`, level: u.TableName === header ? 'header' : 'line',
        field: `U_${u.Name}`, label: `${u.Description || u.Name} (U_${u.Name})`, type: typeOf(u), udf: true }));
    } catch (e) { udfError = sapErrorText(e); }
    res.json({ ok: true, fields: CAT.list.map(({ target, level, label, type, lookup, core, special, field, aliases, enum: en, multi }) =>
      ({ target, level, label, type, lookup: lookupsOf({ lookup }), core: !!core, special: !!special, field, aliases: aliases || [], multi: !!multi,
        ...(en ? { choices: Object.values(en).map(a => a[0]) } : {}) })),
      udfs, udfError, types: TYPES.filter(t => t !== 'enum') });
  }));

  router.get('/templates', wrap((req, res) => res.json({ ok: true, templates: templatesOf(scope()) })));
  router.get('/templates/:id', wrap((req, res) => {
    const t = importRepo.template(scope(), Number(req.params.id));
    if (!t) throw httpError(404, 'Template not found');
    res.json({ ok: true, template: t });
  }));
  const saveTpl = (req, res, id) => {
    const sc = scope();
    const { errors, tpl } = cleanTemplate({ ...req.body, id }, T);
    if (templatesOf(sc).some(t => t.name.toLowerCase() === tpl.name.toLowerCase() && t.id !== id)) errors.push(`A template called "${tpl.name}" already exists`);
    if (errors.length) { const e = httpError(400, errors[0]); e.errors = errors; throw e; }
    const saved = importRepo.saveTemplate(sc, tpl, who(req));
    if (!saved) throw httpError(404, 'Template not found');
    res.json({ ok: true, template: saved });
  };
  router.post('/templates', canEdit, wrap((req, res) => saveTpl(req, res, undefined)));
  router.put('/templates/:id', canEdit, wrap((req, res) => saveTpl(req, res, Number(req.params.id))));
  router.delete('/templates/:id', canEdit, wrap((req, res) => {
    const sc = scope();
    if (templatesOf(sc).length <= 1) throw httpError(400, 'Keep at least one template');
    if (!importRepo.deleteTemplate(sc, Number(req.params.id))) throw httpError(404, 'Template not found');
    res.json({ ok: true, templates: templatesOf(sc) });
  }));
  router.post('/templates/:id/default', canEdit, wrap((req, res) => {
    const sc = scope();
    if (!importRepo.template(sc, Number(req.params.id))) throw httpError(404, 'Template not found');
    importRepo.setDefaultTemplate(sc, Number(req.params.id));
    res.json({ ok: true, templates: templatesOf(sc) });
  }));

  // Blank Excel in a template's layout, with an example and the column → SAP field list.
  router.get('/templates/:id/excel', wrap(async (req, res) => {
    const tpl = importRepo.template(scope(), Number(req.params.id));
    if (!tpl) throw httpError(404, 'Template not found');
    const cols = tpl.columns.filter(c => c.heading);
    const wb = new ExcelJS.Workbook();
    const colour = c => c.required ? 'FF0070F2' : c.target.startsWith('info.') ? 'FF8396A8' : c.target === 'head' ? (c.side === 'C' ? 'FFBB0000' : 'FF107E3E') : 'FF354A5E';
    const note = c => {
      const t = targetInfo(c, T);
      return `${c.required ? 'Required. ' : ''}SAP: ${c.target === 'head' ? `${c.side === 'C' ? 'Credit' : 'Debit'} ${c.account || '(account not set)'}` : t?.label || c.target}${t?.level === 'header' && tpl.layout !== 'form' ? ' — repeat on every row of the record' : ''}${c.default ? `. Default: ${c.default}` : ''}`;
    };
    if (tpl.layout === 'form') {
      const ws = wb.addWorksheet('Employee 1');
      ws.columns = [{ width: 30 }, { width: 24 }];
      ws.addRow([tpl.name]).font = { bold: true, size: 13 };
      ws.addRow([]);
      cols.forEach(c => {
        const row = ws.addRow([c.heading, c.example || '']);
        row.getCell(1).font = { bold: true, color: { argb: colour(c) } };
        row.getCell(1).note = note(c);
      });
    } else {
      const ws = wb.addWorksheet(T.short, { views: [{ state: 'frozen', ySplit: 1 }] });
      ws.columns = cols.map(c => ({ header: c.heading, width: Math.max(10, Math.min(40, c.heading.length + 4, (c.example || '').length + 4)) }));
      if (cols.some(c => c.example)) ws.addRow(cols.map(c => {
        const t = targetInfo(c, T);
        const v = parseValue(c.example, c.type, tpl.dateFormat, t);
        return (c.type === 'number' || c.type === 'int' || c.target === 'head') && typeof v === 'number' ? v : (c.example || '');
      }));
      const hdr = ws.getRow(1);
      hdr.height = 20;
      cols.forEach((c, i) => {
        const cell = hdr.getCell(i + 1);
        cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: colour(c) } };
        cell.note = note(c);
      });
      if (cols.length) ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: cols.length } };
    }
    const help = wb.addWorksheet('Mapping');
    help.columns = [{ width: 26 }, { width: 44 }, { width: 10 }, { width: 10 }, { width: 10 }, { width: 16 }, { width: 50 }];
    help.addRow([`${tpl.name} — column mapping`]).font = { bold: true, size: 14 };
    help.addRow([tpl.description || '', `Dates: ${{ DMY: 'day/month/year', MDY: 'month/day/year', YMD: 'year-month-day' }[tpl.dateFormat]} · ${tpl.layout === 'form' ? 'one sheet per record (label | value)' : 'one row per line'}`]);
    help.addRow([]);
    help.addRow(['Excel heading', 'SAP field', 'Level', 'Required', 'Group key', 'Default', 'Also accepted as heading']).font = { bold: true };
    tpl.columns.forEach(c => {
      const t = targetInfo(c, T);
      help.addRow([c.heading || '(no column — default only)', c.target === 'head' ? `JE line: ${c.side === 'C' ? 'Credit' : 'Debit'} ${c.account || '(account not set)'}` : t?.label || c.target,
        t?.level, c.required ? 'Yes' : '', c.groupKey ? 'Yes' : '', c.default, c.aliases.join(', ')]);
    });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${tpl.name.replace(/[^A-Za-z0-9 _-]/g, '').replace(/\s+/g, '_') || 'Template'}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  }));

  // Draft a template from a sample sheet: headings of the row with the most text cells
  // (layout=form: the label cells of the first sheet).
  router.post('/templates/detect', canEdit, _upload.single('file'), wrap(async (req, res) => {
    if (!req.file) throw httpError(400, 'No file received');
    const wb = await loadWorkbook(req.file).catch(e => { throw e.status ? e : httpError(400, `Could not read the file: ${e.message}`); });
    const form = req.body?.layout === 'form';
    let cells = [], sheet = '', headerRow = null;
    if (form) {
      const ws = wb.worksheets[0];
      sheet = ws.name;
      for (let r = 1; r <= Math.min(ws.rowCount, FORM_SCAN.rows); r++) {
        const row = ws.getRow(r);
        for (let c = 1; c <= Math.min(ws.columnCount || FORM_SCAN.cols, FORM_SCAN.cols); c++) {
          const t = cellValue(row.getCell(c).value);
          if (typeof t !== 'string' || !t.trim() || /^\d/.test(t.trim())) continue;
          const label = t.includes(':') ? t.split(':')[0].trim() : t.trim();
          const inline = t.includes(':') ? t.split(':').slice(1).join(':').trim() : '';
          let ex = inline;
          if (!ex) for (let k = c + 1; k <= c + 4; k++) { const v = textOf(row.getCell(k).value); if (v) { ex = v; break; } }
          if (label && ex && label.length <= 60 && !cells.some(x => normHead(x.heading) === normHead(label))) cells.push({ heading: label, example: ex });
          if (ex) break;
        }
      }
    } else {
      let best = null;
      wb.eachSheet(ws => {
        for (let r = 1; r <= Math.min(10, ws.rowCount); r++) {
          const list = [];
          ws.getRow(r).eachCell((cell, col) => { const t = cellValue(cell.value); if (typeof t === 'string' && t.trim()) list.push({ col, heading: t.trim() }); });
          const hits = list.filter(c => CAT.suggest.has(normHead(c.heading))).length;
          const score = hits * 10 + list.length;
          if (list.length >= 2 && (!best || score > best.score)) best = { ws, r, list, score };
        }
      });
      if (!best) throw httpError(400, 'No heading row found in the first 10 rows');
      sheet = best.ws.name; headerRow = best.r;
      const sample = best.ws.getRow(best.r + 1);
      cells = best.list.map(c => ({ heading: c.heading, example: textOf(sample.getCell(c.col).value).slice(0, 100) }));
    }
    if (!cells.length) throw httpError(400, 'No "label | value" pairs found on the first sheet');
    const taken = new Set();
    const columns = cells.map((c, i) => {
      let target = CAT.suggest.get(normHead(c.heading)) || '';
      if (target && !target.startsWith('info.') && taken.has(target)) target = '';
      if (target) taken.add(target);
      // Journal entries: any other numeric column is probably a salary head.
      if (!target && T.hasHeads && /^-?[\d,.]+$/.test(String(c.example).trim())) target = 'head';
      if (!target) target = 'ignore';
      const t = CAT.map.get(target);
      return { id: `c${i + 1}`, heading: c.heading, aliases: [], target, type: t?.type || 'text', required: !!t?.core || target === 'key',
        default: '', groupKey: target === 'key', example: String(c.example ?? '').slice(0, 100), ...(target === 'head' ? { side: '', account: '' } : {}) };
    });
    res.json({ ok: true, sheet, headerRow, layout: form ? 'form' : 'table', columns, matched: columns.filter(c => c.target !== 'ignore').length });
  }));

  // ── Upload ──────────────────────────────────────────────────────────────
  const readWith = (wb, tpl) => (tpl.layout === 'form' ? readForms(wb, tpl) : findTables(wb, tpl));
  router.post('/upload', _upload.single('file'), wrap(async (req, res) => {
    if (!req.file) throw httpError(400, 'No file received');
    const sc = scope();
    const wb = await loadWorkbook(req.file).catch(e => { throw e.status ? e : httpError(400, `Could not read the file: ${e.message}`); });
    const list = templatesOf(sc);
    const wanted = Number(req.body?.templateId);
    let tpl, found;
    if (wanted) {
      tpl = list.find(t => t.id === wanted);
      if (!tpl) throw httpError(400, 'The chosen template no longer exists — pick another one');
      found = readWith(wb, tpl);
      if (!found) throw httpError(400, tpl.layout === 'form'
        ? `No sheet has the labels of template "${tpl.name}" (${tpl.columns.filter(c => c.heading).slice(0, 8).map(c => c.heading).join(', ')} …)`
        : `No header row matching template "${tpl.name}" in the first 10 rows. Its headings are: ${tpl.columns.filter(c => c.heading).map(c => c.heading).join(', ')}`);
    } else {
      // Auto: the template whose headings cover most of the sheet; the default wins a tie.
      for (const t of list) {
        const f = readWith(wb, t);
        if (f && (!found || f.hits > found.hits)) { tpl = t; found = f; }
      }
      if (!found) throw httpError(400, `The headings do not match any template (${list.map(t => t.name).join(', ')}). Pick a template, or ask an administrator to create one for this layout.`);
    }
    const missingCols = tpl.columns.filter(c => c.required && c.heading && blank(c.default) && !found.used.has(c.id)).map(c => c.heading);
    if (missingCols.length) throw httpError(400, `Template "${tpl.name}": required ${tpl.layout === 'form' ? 'label' : 'column'}${missingCols.length > 1 ? 's' : ''} not found — ${missingCols.join(', ')}`);

    const rows = found.kind === 'form' ? found.rows : readTableRows(found);
    if (!rows.length) throw httpError(400, `Sheet "${found.sheetNames[0]}" has a header row but no data rows`);
    const recs = groupRecords(rows, tpl, T).map(o => buildRecord(o, tpl, T));
    recs.forEach(r => applyRules(r, tpl, T));

    let md;
    try { md = await loadMasterData(getActiveSap(), recs, T); }
    catch (e) { throw httpError(502, `Could not reach SAP to validate the ${T.nouns}: ${sapErrorText(e)}`); }
    recs.forEach(r => { checkAgainstSap(r, md, T, tpl); finalise(r, T); });

    const snapshot = { id: tpl.id, name: tpl.name, dateFormat: tpl.dateFormat, layout: tpl.layout, options: tpl.options, columns: tpl.columns };
    const lineCount = recs.reduce((s, o) => s + (T.jeLines ? (o.header.jeLines || []).length : o.lines.length), 0);
    const sheetName = found.sheetNames.length > 1 ? `${found.sheetNames.length} sheets` : found.sheetNames[0];
    const saved = importRepo.saveBatch(sc, {
      fileName: req.file.originalname || '', sheetName, uploadedBy: who(req), rowCount: rows.length, lineCount, template: snapshot,
      noun: T.noun, docLabel: T.docLabel,
    }, recs);

    const used = found.kind === 'form' ? [...found.used] : Object.values(found.map).map(m => m.id);
    const headOf = id => (found.kind === 'form' ? tpl.columns.find(c => c.id === id)?.heading : Object.values(found.map).find(m => m.id === id)?.head);
    const values = recs.map(o => o.total).filter(v => v != null);
    res.json({
      ok: true,
      ack: {
        ...saved, fileName: req.file.originalname || '', sheetName, sheets: found.sheetNames, headerRow: found.headerRow, layout: tpl.layout,
        uploadedBy: who(req), company: sc.company, template: tpl.name, templateAuto: !wanted,
        rows: rows.length, orders: recs.length, lines: lineCount,
        value: values.length ? r2(values.reduce((s, v) => s + v, 0)) : null,
        updates: recs.filter(o => o.header.mode === 'update').length,
        groupedBy: tpl.columns.filter(c => c.groupKey).map(c => c.heading || c.id).join(' + '),
        truncated: rows.length >= MAX_ROWS,
        columns: used.map(id => tpl.columns.find(c => c.id === id)).filter(c => c && c.target !== 'ignore')
          .map(c => ({ heading: headOf(c.id), field: c.target === 'head' ? `${c.side === 'C' ? 'Cr' : 'Dr'} ${c.account || '?'}` : targetInfo(c, T)?.label || c.target })),
        ignored: [...used.map(id => tpl.columns.find(c => c.id === id)).filter(c => c?.target === 'ignore').map(c => headOf(c.id)), ...(found.kind === 'form' ? [] : found.unknown)],
        skippedSheets: found.kind === 'form' ? found.unknown : [],
        missingOrders: recs.filter(o => o.issues.length).slice(0, 8).map(o => ({ orderKey: o.orderKey, issue: o.issues[0]?.message, more: o.issues.length - 1 })),
      },
      counts: importRepo.counts(sc),
    });
  }));

  // ── Records ─────────────────────────────────────────────────────────────
  // Record-level columns of each template in the result, from the latest import snapshot
  // (columns of older snapshots that were since removed are kept at the end).
  function templateViews(sc, ids) {
    const views = {};
    for (const snap of importRepo.templateSnapshots(sc, ids)) {
      const v = views[snap.id] ||= { id: snap.id, name: snap.name, columns: [] };
      for (const c of snap.columns || []) {
        const t = targetInfo(c, T);
        if (t?.level !== 'header' || !c.heading || c.target === 'ignore' || v.columns.some(x => x.id === c.id)) continue;
        v.columns.push({ id: c.id, heading: c.heading, field: c.target === 'head' ? `${c.side === 'C' ? 'Credit' : 'Debit'} ${c.account}` : t.label,
          target: c.target, type: c.type, groupKey: !!c.groupKey });
      }
    }
    return views;
  }

  router.get('/orders', wrap((req, res) => {
    const sc = scope();
    templatesOf(sc);
    const tab = ['pending', 'posted', 'missing'].includes(req.query.tab) ? req.query.tab : 'pending';
    const templateId = Number(req.query.tpl) || null;
    const orders = importRepo.list(sc, tab, { q: String(req.query.q || '').slice(0, 60), templateId });
    const ids = [...new Set([templateId, ...orders.map(o => o.templateId)].filter(Boolean))];
    res.json({ ok: true, tab, orders, templates: templateViews(sc, ids), counts: importRepo.counts(sc) });
  }));

  const payloadOf = o => T.payload(o, { fileName: o.fileName, template: o.template || STANDARD[0] });
  router.get('/orders/:id', wrap((req, res) => {
    const o = importRepo.get(scope(), Number(req.params.id));
    if (!o) throw httpError(404, 'Record not found');
    const t = o.template;
    const view = t && { name: t.name, layout: t.layout, columns: t.columns.map(c => ({ id: c.id, heading: c.heading || targetInfo(c, T)?.label || c.id,
      level: targetInfo(c, T)?.level, field: c.target === 'head' ? `${c.side === 'C' ? 'Credit' : 'Debit'} ${c.account}` : targetInfo(c, T)?.label || c.target,
      target: c.target, type: c.type })) };
    const update = o.header.mode === 'update';
    res.json({ ok: true, order: { ...o, template: view, payload: payloadOf(o),
      method: update ? `PATCH ${T.keyEntity(o.header.sap[T.masterKey], s => s)}` : `POST ${T.entity}` } });
  }));

  router.post('/post', wrap(async (req, res) => {
    const sc = scope();
    const ids = idsOf(req).slice(0, MAX_POST);
    if (!ids.length) throw httpError(400, `Select at least one ${T.noun.toLowerCase()} to post`);
    const claimed = importRepo.claim(sc, ids);
    const sap = getActiveSap();
    const results = [];
    for (const id of claimed) {
      const o = importRepo.get(sc, id);
      try {
        const body = payloadOf(o);
        let r;
        if (o.header.mode === 'update') { await sap.patch(T.keyEntity(o.header.sap[T.masterKey], esc), body); r = {}; }
        else r = await sap.post(T.entity, body);
        const { docEntry, docNum } = T.result(r, o);
        importRepo.markPosted(id, docEntry, docNum, who(req));
        results.push({ id, orderKey: o.orderKey, ok: true, docEntry, docNum, updated: o.header.mode === 'update' });
      } catch (e) {
        const msg = sapErrorText(e);
        importRepo.markFailed(id, msg);
        results.push({ id, orderKey: o.orderKey, ok: false, error: msg });
      }
    }
    const skipped = ids.filter(id => !claimed.includes(id));
    res.json({ ok: true, results, skipped, counts: importRepo.counts(sc) });
  }));

  router.post('/recheck', wrap(async (req, res) => {
    const sc = scope();
    const rows = importRepo.getMany(sc, idsOf(req), ['missing', 'failed']);
    if (!rows.length) throw httpError(400, `Select ${T.nouns} from Missing data (or rejected ones) to re-check`);
    const current = new Map(templatesOf(sc).map(t => [t.id, t]));
    // Keep the issues found in the sheet itself; redo mapping, rules and SAP checks.
    // Salary heads take their G/L account and side from the template as it is now.
    const recs = rows.map(r => {
      const snap = r.template || STANDARD[0];
      const now = current.get(snap.id);
      const tpl = { ...snap, options: now?.options || snap.options,
        columns: snap.columns.map(c => (c.target === 'head' && now ? { ...c, ...(now.columns.find(x => x.id === c.id && x.target === 'head') || {}) } : c)) };
      const rec = { id: r.id, orderKey: r.orderKey, fileName: r.fileName,
        header: { cells: r.header.cells || {}, sap: {}, cardName: r.header.cardName || '', name: r.header.name || '', mode: 'create' },
        lines: r.lines.map(l => ({ ...l, issues: [] })), issues: r.issues.filter(i => i.local && !i.line), tpl };
      applyRules(rec, tpl, T);
      return rec;
    });
    let md;
    try { md = await loadMasterData(getActiveSap(), recs, T); }
    catch (e) { throw httpError(502, `Could not reach SAP: ${sapErrorText(e)}`); }
    let nowReady = 0;
    for (const o of recs) {
      checkAgainstSap(o, md, T, o.tpl); finalise(o, T);
      delete o.tpl;
      importRepo.revalidated(o.id, o);
      if (!o.issues.length) nowReady++;
    }
    res.json({ ok: true, checked: recs.length, nowReady, stillMissing: recs.length - nowReady, counts: importRepo.counts(sc) });
  }));

  router.post('/delete', wrap((req, res) => {
    const sc = scope();
    const removed = importRepo.remove(sc, idsOf(req));
    res.json({ ok: true, removed, counts: importRepo.counts(sc) });
  }));

  router.get('/batches', wrap((req, res) => {
    res.json({ ok: true, batches: importRepo.batches(scope()).map(({ template_json, ...b }) => b) });
  }));

  // One row per line (per JE line for journal entries); the template columns become columns.
  router.get('/export', wrap(async (req, res) => {
    const sc = scope();
    const tab = ['pending', 'posted', 'missing'].includes(req.query.tab) ? req.query.tab : 'pending';
    const recs = importRepo.listFull(sc, tab);
    const heads = [];
    for (const o of recs) for (const c of o.template?.columns || []) if (c.heading && !heads.includes(c.heading) && !['key', 'ignore', 'head'].includes(c.target)) heads.push(c.heading);
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet({ pending: 'Pending', posted: 'Posted', missing: 'Missing data' }[tab]);
    const L = T.listLabels;
    const fixed = ['Record', 'Status', `SAP ${T.docLabel}`, L.code || 'Code', 'Name', 'Template', 'Line'];
    const lineHead = T.jeLines ? ['Head / line', 'G/L account', 'Debit', 'Credit', 'Line remarks'] : [];
    const tail = [...(T.valueLabel && !T.jeLines ? ['Line total'] : []), 'Issues / SAP message', 'Source file', 'Posted at', 'Posted by'];
    ws.columns = [...fixed, ...heads, ...lineHead, ...tail].map(h => ({ header: h, width: Math.max(10, Math.min(40, h.length + 6)) }));
    for (const o of recs) {
      const cols = o.template?.columns || [];
      const msg = o.status === 'failed' ? o.error : o.issues.filter(i => !i.line).map(i => i.message).join('; ');
      const lines = T.jeLines ? (o.header.jeLines || []) : o.lines.length ? o.lines : [{ lineNo: '', cells: {}, sap: {}, issues: [] }];
      lines.forEach((l, i) => {
        const val = h => { const c = cols.find(x => x.heading === h); if (!c) return ''; const v = targetInfo(c, T)?.level === 'header' ? o.header.cells?.[c.id] : l.cells?.[c.id]; return v ?? ''; };
        ws.addRow([o.orderKey, o.status, o.docNum ?? '', o.cardCode, o.cardName, o.template?.name || '', T.jeLines ? i + 1 : l.lineNo, ...heads.map(val),
          ...(T.jeLines ? [l.head || 'Journal line', l.accountLabel || l.AccountCode || l.ShortName || '', l.Debit ?? '', l.Credit ?? '', l.LineMemo || ''] : []),
          ...(T.valueLabel && !T.jeLines ? [r2(T.lineTotal?.(l.sap || {}) ?? 0)] : []),
          [i === 0 ? msg : '', ...(l.issues || [])].filter(Boolean).join('; '),
          o.fileName, o.postedAt ? o.postedAt.replace('T', ' ').slice(0, 16) : '', o.postedBy]);
      });
    }
    ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF354A5E' } };
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${T.short.replace(/[^A-Za-z]+/g, '_')}_Import_${tab}_${today()}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  }));

  return router;
}
