/**
 * PUTAWAY demo data — STTL_PUTAWAY documents built from SAP @SORTING (POC).
 *
 *   node scripts/putaway-demo-data.mjs           # (re)build demo putaways
 *   node scripts/putaway-demo-data.mjs --delete  # remove demo putaways
 *
 * One putaway document per GRPO found in @SORTING, one row per GRPO line:
 *  - From = the receiving warehouse/bin recorded on the sorting line.
 *  - To   = a storage warehouse other than the receiving one (rule below) and a
 *           real, active storage bin there; each item always goes to the same bin.
 *  - Putaway starts 15–60 min after the GRPO's last sorted line, 2–15 min per
 *    line, done by whichever of that day's sorters is free first (the GRPO's
 *    main sorter when they are nearly as free). Work that would not finish
 *    by 17:30 is dated the next working day from ~07:00 (U_DocDate = putaway date).
 *  - Lines not sorted yet stay Open; the newest sorted GRPOs are left partly or
 *    fully open so the dashboard shows work in progress.
 *  - U_Forklift = the GRPO line item's "Forklift Required?" (OITM.U_FR); forklift
 *    moves take 3–6 min longer (see scripts/putaway-forklift-setup.mjs).
 * Record only (no Inventory Transfer). Demo documents carry Remark = 'DEMO'.
 */
import axios from 'axios';
import https from 'node:https';
import { connRepo, dbConnRepo } from '../db.mjs';
import { connectDB, executeSQL, getActiveConfig, tableRef } from '../db-connector.mjs';

const DELETE = process.argv.includes('--delete');
const UDO = 'STTL_PUTAWAY', MARK = 'DEMO';
// Receiving warehouse → storage warehouses it is put away to.
const ROUTES = { PORT: ['104WC', 'DR'], '104WC': ['DR', '17SH'], '17SH': ['104WC'], 'OS-PakSf': ['6HD'], 'DS-VN': ['104WC'] };
const DEFAULT_ROUTE = ['104WC', 'DR'];

const conn = connRepo.getActive();
const base = conn.base_url.replace(/\/+$/, '');
const http = axios.create({ timeout: 60000, httpsAgent: new https.Agent({ rejectUnauthorized: false }), validateStatus: () => true });
const H = { headers: {} };
// With several Service Layer nodes, a node started before the UDO existed answers
// "Service Not Found" until it is restarted — keep logging in until a node knows it.
async function login() {
  for (let i = 0; i < 12; i++) {
    const r = await http.post(`${base}/Login`, { CompanyDB: conn.company, UserName: conn.sl_user, Password: conn.sl_password });
    if (r.status !== 200) throw new Error(`SAP login failed: ${JSON.stringify(r.data)}`);
    H.headers.Cookie = (r.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');
    const probe = { ...H, params: { $select: 'DocEntry,Remark', $top: 1, $skip: 0 } };
    if ((await http.get(`${base}/${UDO}`, probe)).status === 200 && (await http.get(`${base}/${UDO}/$count`, H)).status === 200) return;
    await http.post(`${base}/Logout`, {}, H);
  }
  throw new Error(`No Service Layer node knows ${UDO} yet — restart the Service Layer and run again`);
}
const msg = r => r.data?.error?.message?.value || JSON.stringify(r.data);
await login();
console.log(`SAP: ${conn.company} @ ${base}`);

// ── Remove earlier demo documents ────────────────────────────────────────────
// ($filter on Remark fails on this Service Layer, so filter client-side.)
const demo = [];
for (let skip = 0, tries = 0; ; ) {
  const r = await http.get(`${base}/${UDO}`, { ...H, params: { $select: 'DocEntry,Remark', $top: 100, $skip: skip } });
  if (r.status !== 200) {
    if (++tries > 5) throw new Error(`Listing putaways failed: ${msg(r)}`);
    await login(); continue;
  }
  const page = r.data.value || [];
  demo.push(...page.filter(d => d.Remark === MARK).map(d => d.DocEntry));
  if (!page.length || !(r.data['odata.nextLink'] || r.data['@odata.nextLink'])) break;
  skip += page.length;
}
let removed = 0;
for (const DocEntry of demo) {
  let d = await http.delete(`${base}/${UDO}(${DocEntry})`, H);
  if (d.status !== 204 && d.status !== 404) { await login(); d = await http.delete(`${base}/${UDO}(${DocEntry})`, H); }
  if (d.status === 204 || d.status === 404) removed++; else throw new Error(`Delete putaway ${DocEntry}: ${msg(d)}`);
}
console.log(`Removed ${removed} earlier demo putaway(s)`);
if (DELETE) { await http.post(`${base}/Logout`, {}, H); process.exit(0); }

// ── Source: @SORTING + storage bins ──────────────────────────────────────────
await connectDB(dbConnRepo.getActive());
const T = n => tableRef(n, getActiveConfig());
const sorting = await executeSQL(`SELECT "Code","U_GRPO","U_VC","U_VN","U_IN","U_ID","U_QTY","U_WH","U_BIN","U_IS","U_USER","U_TI","U_TO","U_DD" FROM ${T('@SORTING')}`);
const toWhs = [...new Set(Object.values(ROUTES).flat().concat(DEFAULT_ROUTE))];
const binRows = await executeSQL(`SELECT "WhsCode","BinCode" FROM ${T('OBIN')} WHERE "WhsCode" IN (${toWhs.map(w => `'${w}'`).join(',')}) ` +
  `AND "Disabled"='N' AND "SysBin"='N' AND "BinCode" NOT LIKE '%@%' AND "BinCode" NOT LIKE '%-Z-%'`);
const bins = new Map();
for (const b of binRows) { if (!bins.has(b.WhsCode)) bins.set(b.WhsCode, []); bins.get(b.WhsCode).push(b.BinCode); }
for (const list of bins.values()) list.sort();
// GRPO line → item master "Forklift Required?" (OITM.U_FR; @SORTING item codes are cut to 15 chars, so go via PDN1).
const forklift = new Map();
try {
  const fl = await executeSQL(`SELECT P."DocEntry" AS "E", P."LineNum" AS "L", I."U_FR" AS "FR" FROM ${T('PDN1')} P JOIN ${T('OITM')} I ON I."ItemCode" = P."ItemCode" ` +
    `WHERE P."DocEntry" IN (SELECT DISTINCT CAST(SUBSTR_BEFORE("Code", '-') AS INTEGER) FROM ${T('@SORTING')})`);
  for (const r of fl) forklift.set(`${r.E}-${r.L}`, r.FR === 'YES' ? 'YES' : 'NO');
} catch (e) { console.warn(`Forklift flags not read (${e.message}) — U_Forklift left at its default`); }

const nextWorkday = d => { const x = new Date(d + 'T00:00:00Z'); do x.setUTCDate(x.getUTCDate() + 1); while ([0, 6].includes(x.getUTCDay())); return x.toISOString().slice(0, 10); };
const hash = s => { let h = 2166136261; for (const c of String(s)) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; };
const rand = (seed => () => (seed = (seed * 16807) % 2147483647) / 2147483647)(Date.now() % 2147483647 || 7);
const between = (a, b) => a + rand() * (b - a);
const toMin = v => v == null || v === '' ? null : Math.floor(Number(v) / 100) * 60 + Number(v) % 100;
const hhmm = m => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(Math.floor(m % 60)).padStart(2, '0')}`;
const ymd = v => v ? String(v instanceof Date ? v.toISOString() : v).slice(0, 10) : null;

// Item → destination warehouse + bin, stable across runs.
function destination(item, fromWhs) {
  const route = (ROUTES[fromWhs] || DEFAULT_ROUTE).filter(w => w !== fromWhs);
  const whs = route[hash(item) % route.length];
  const list = bins.get(whs) || [];
  return { whs, bin: list.length ? list[hash(item + whs) % list.length] : '' };
}

// Group sorting lines by GRPO (Code = "<DocEntry>-<LineNum>").
const byGrpo = new Map();
for (const s of sorting) {
  const [entry, line] = String(s.Code).split('-').map(Number);
  if (!Number.isFinite(entry)) continue;
  if (!byGrpo.has(entry)) byGrpo.set(entry, []);
  byGrpo.get(entry).push({ ...s, entry, line, tin: toMin(s.U_TI), tout: toMin(s.U_TO), sorted: s.U_IS === 'YES', date: ymd(s.U_DD) });
}
const grpos = [...byGrpo.values()].map(l => l.sort((a, b) => a.line - b.line)).sort((a, b) => a[0].date.localeCompare(b[0].date) || a[0].entry - b[0].entry);
// The newest sorted GRPOs stay unfinished: last 2 fully open, the 3 newest multi-line ones before that half done.
const sortedGrpos = grpos.filter(l => l.every(x => x.sorted));
const fullyOpen = new Set(sortedGrpos.slice(-2).map(l => l[0].entry));
const halfDone = new Set(sortedGrpos.slice(0, -2).filter(l => l.length > 1).slice(-3).map(l => l[0].entry));

const docs = [];
const userDay = new Map();   // "user|date" → minute the putaway user is free again
// Putaway starts once the GRPO is sorted (+15–60 min); take GRPOs in that order.
for (const l of grpos) {
  const outs = l.filter(x => x.sorted && x.tout != null).map(x => x.tout);
  l.readyAt = outs.length ? Math.max(...outs) + between(15, 60) : Infinity;
}
grpos.sort((a, b) => a[0].date.localeCompare(b[0].date) || a.readyAt - b.readyAt);
for (const lines of grpos) {
  const h = lines[0], date = h.date;
  const sortedLines = lines.filter(l => l.sorted && l.tout != null);
  // Putaway user: one of that day's sorters who can start soonest; the GRPO's
  // main sorter keeps it when they are free within ~20 min of the best option.
  const counts = {}; sortedLines.forEach(l => { counts[l.U_USER] = (counts[l.U_USER] || 0) + 1; });
  const main = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
  const dayUsers = [...new Set(sorting.filter(s => ymd(s.U_DD) === date && s.U_USER).map(s => s.U_USER))];
  const startFor = u => Math.max(sortedLines.length ? lines.readyAt : 0, userDay.get(`${u}|${date}`) || 0);
  const best = dayUsers.sort((a, b) => startFor(a) - startFor(b))[0];
  const user = (main && startFor(main) <= startFor(best) + 20 ? main : best) || main || '';
  // Work that would not finish by 17:30 rolls to the next working morning.
  const doneCount = fullyOpen.has(h.entry) ? 0 : halfDone.has(h.entry) ? Math.ceil(sortedLines.length / 2) : sortedLines.length;
  const lineMins = lines.map(l => Math.min(15, Math.max(2, 2 + Math.sqrt(Number(l.U_QTY || 0)) * 0.08 + between(0, 4)))
    + (forklift.get(`${l.entry}-${l.line}`) === 'YES' ? between(3, 6) : 0));
  const est = lineMins.slice(0, doneCount).reduce((a, m) => a + m + 2.5, 0);
  let putDate = date, t = startFor(user);
  if (t !== Infinity && t + est > 17.5 * 60) {
    putDate = nextWorkday(date);
    t = Math.max(7 * 60 + between(0, 30), userDay.get(`${user}|${putDate}`) || 0);
  }
  const key = `${user}|${putDate}`;
  let done = 0;
  const rows = lines.map((l, i) => {
    const dest = destination(l.U_IN, l.U_WH);
    const row = { U_SortCode: l.Code, U_GRPOLine: l.line, U_ItemCode: l.U_IN, U_ItemName: l.U_ID, U_Qty: Number(l.U_QTY || 0),
      U_FromWhs: l.U_WH, U_FromBin: l.U_BIN || '', U_ToWhs: dest.whs, U_ToBin: dest.bin, U_Status: 'O' };
    if (forklift.has(`${l.entry}-${l.line}`)) row.U_Forklift = forklift.get(`${l.entry}-${l.line}`);
    if (l.sorted && done < doneCount && user) {
      const mins = lineMins[i];
      Object.assign(row, { U_PutUser: user, U_TimeIn: hhmm(t), U_TimeOut: hhmm(t + mins), U_Status: 'C' });
      t += mins + between(1, 4); done++;
    }
    return row;
  });
  if (done) userDay.set(key, t);
  const closed = rows.filter(r => r.U_Status === 'C');
  const status = closed.length === rows.length ? 'C' : closed.length ? 'P' : 'O';
  docs.push({
    Remark: MARK, U_DocDate: closed.length ? putDate : date, U_GRPOEntry: h.entry, U_GRPONum: String(h.U_GRPO), U_GRPODate: date, U_CardCode: h.U_VC, U_CardName: h.U_VN,
    U_FromWhs: h.U_WH, U_ToWhs: rows[0].U_ToWhs, U_PutUser: closed.length ? user : '', U_Status: status,
    U_StartTime: closed[0]?.U_TimeIn ?? null, U_EndTime: status === 'C' ? closed[closed.length - 1].U_TimeOut : null,
    U_TotalQty: rows.reduce((s, r) => s + r.U_Qty, 0),
    STTL_PTW1Collection: rows,
  });
}
console.log(`Building ${docs.length} putaway document(s) from ${sorting.length} sorting line(s)`);

// ── Write ─────────────────────────────────────────────────────────────────────
let ok = 0, failed = 0;
for (const d of docs) {
  let r = await http.post(`${base}/${UDO}`, d, H);
  if (r.status !== 201) { await login(); r = await http.post(`${base}/${UDO}`, d, H); }
  if (r.status === 201) ok++;
  else { failed++; if (failed <= 5) console.warn(`  GRPO ${d.U_GRPONum}: ${msg(r)}`); }
}
const by = s => docs.filter(d => d.U_Status === s).length;
console.log(`STTL_PUTAWAY: ${ok} document(s) written, ${failed} failed — Completed ${by('C')}, In Process ${by('P')}, Open ${by('O')}`);
await http.post(`${base}/Logout`, {}, H);
process.exit(failed ? 1 : 0);
