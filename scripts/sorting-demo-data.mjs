/**
 * GRPO Sorting — demo data, written to BOTH the app (hanny.db) and SAP @SORTING.
 *
 *   node scripts/sorting-demo-data.mjs              # (re)build demo: last 3 months
 *   node scripts/sorting-demo-data.mjs --months 2
 *   node scripts/sorting-demo-data.mjs --delete     # remove demo data (app + SAP)
 *
 * Uses real GRPO lines (OPDN/PDN1 + receiving bins) and the 5 sorters SAP allows
 * in @SORTING.U_USER — NIK, JOSH, TOM, KEVIN, PEDRO — created as app users with
 * role "user" (password DEMO_PASSWORD below) so they can log in and sort.
 *
 * Each GRPO date becomes a sorting day with random but realistic behaviour:
 * NIK/JOSH clock in ~07:00, TOM/KEVIN ~09:00, PEDRO ~10:00 (±10 min), as many
 * as the day's workload needs; a sorter is sometimes absent; 30 min lunch
 * around 12:30; clock-out shortly after their last line; sort time grows with quantity;
 * some lines are paused and resumed; a few have a short count. Lines go to the
 * first free sorter, exactly like the agent's auto-assign. The newest GRPO lines
 * are left unsorted (U_IS = NO) for a live clock-in → start → complete demo.
 *
 * Local rows are marked assigned_by / clocked_by = 'demo-seed' and stored as
 * already synced, so the agent's SAP sync does not push them again.
 */
import axios from 'axios';
import https from 'node:https';
import db, { connRepo, dbConnRepo, userRepo, userPermRepo, sortingRepo } from '../db.mjs';
import { connectDB, executeSQL, getActiveConfig, getActiveType, tableRef } from '../db-connector.mjs';

const args = process.argv.slice(2);
const DELETE = args.includes('--delete');
const MONTHS = Number(args[args.indexOf('--months') + 1]) || 3;
const LEAVE_OPEN = 6;                 // newest GRPO lines left unsorted for the live demo
const DEMO = 'demo-seed';
const DEMO_PASSWORD = 'Sort@1234';
const SORTER_PERM = 'purchase.workflow.grpo_sorting';
const CREW = [['nik', 'Nik', 7], ['josh', 'Josh', 7], ['tom', 'Tom', 9], ['kevin', 'Kevin', 9], ['pedro', 'Pedro', 10]];

const conn = connRepo.getActive();
if (!conn) throw new Error('No active SAP connection in hanny.db');
const company = conn.company;
const base = conn.base_url.replace(/\/+$/, '');
const http = axios.create({ timeout: 30000, httpsAgent: new https.Agent({ rejectUnauthorized: false }), validateStatus: () => true });
const H = { headers: {} };
async function slLogin() {
  const login = await http.post(`${base}/Login`, { CompanyDB: conn.company, UserName: conn.sl_user, Password: conn.sl_password });
  if (login.status !== 200) throw new Error(`SAP login failed: ${JSON.stringify(login.data)}`);
  H.headers.Cookie = (login.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');
}
await slLogin();
const sapMsg = r => r.data?.error?.message?.value || JSON.stringify(r.data);
// A session opened while the UDT was being changed keeps stale field metadata
// ("Property 'U_x' of 'U_SORTING' is invalid") — log in again and retry once.
async function sl(method, path, body) {
  const go = () => body === undefined ? http[method](`${base}${path}`, H) : http[method](`${base}${path}`, body, H);
  let r = await go();
  if (r.status === 401 || (r.status === 400 && /of 'U_SORTING' is invalid/.test(sapMsg(r)))) { await slLogin(); r = await go(); }
  return r;
}
console.log(`SAP: ${company} @ ${base}`);

// ── Cleanup: earlier demo (app + SAP) and the old TEST- rows ─────────────────
async function sapDelete(code) {
  const r = await sl('delete', `/U_SORTING('${encodeURIComponent(code)}')`);
  return r.status === 204 || r.status === 404;
}
async function purge() {
  // Demo lines: still marked, or touched by a demo sorter (e.g. during a live demo).
  const demoUsers = CREW.map(([u]) => userRepo.findByUsername.get(u)?.id).filter(Boolean);
  const byUser = demoUsers.length ? `OR assigned_user_id IN (${demoUsers.join(',')}) OR completed_by IN (${demoUsers.join(',')})` : '';
  const demoTasks = db.prepare(`SELECT id, doc_entry, line_num FROM sorting_tasks WHERE company=? AND (assigned_by=? ${byUser})`).all(company, DEMO);
  let sap = 0;
  for (const t of demoTasks) if (await sapDelete(`${t.doc_entry}-${t.line_num}`)) sap++;
  for (;;) {
    const r = await sl('get', `/U_SORTING?$select=Code&$filter=${encodeURIComponent("startswith(Code,'TEST-')")}&$top=100`);
    if (r.status !== 200) throw new Error(`Listing TEST- rows failed: ${sapMsg(r)}`);
    const page = r.data.value || [];
    if (!page.length) break;
    for (const { Code } of page) if (await sapDelete(Code)) sap++;
  }
  db.transaction(() => {
    const ids = demoTasks.map(t => t.id);
    for (let i = 0; i < ids.length; i += 500) db.prepare(`DELETE FROM sorting_tasks WHERE id IN (${ids.slice(i, i + 500).join(',')})`).run();
    db.prepare(`DELETE FROM sorting_shifts WHERE company=? AND clocked_by=?`).run(company, DEMO);
  })();
  console.log(`Cleanup: ${demoTasks.length} demo line(s) removed from the app, ${sap} row(s) from @SORTING`);
}
await purge();
if (DELETE) {
  for (const [u] of CREW) { const x = userRepo.findByUsername.get(u); if (x) userRepo.delete.run(x.id); }
  console.log(`Demo users removed: ${CREW.map(c => c[0]).join(', ')}`);
  await http.post(`${base}/Logout`, {}, H); process.exit(0);
}

// ── Demo sorters as app users ────────────────────────────────────────────────
const crew = CREW.map(([username, name, startHour]) => {
  if (!userRepo.findByUsername.get(username)) userRepo.create(username, DEMO_PASSWORD, name, 'user');
  const u = userRepo.findByUsername.get(username);
  if (!userPermRepo.getEffective(u.id, u.role).includes(SORTER_PERM)) {
    db.prepare(`INSERT OR REPLACE INTO user_permissions (user_id, perm_key, granted) VALUES (?,?,1)`).run(u.id, SORTER_PERM);
  }
  return { id: u.id, username, name, sapUser: name.toUpperCase(), startHour };
});
console.log(`Sorters: ${crew.map(c => `${c.username} (#${c.id})`).join(', ')} — password ${DEMO_PASSWORD}`);

// ── Real GRPO lines + receiving bins ─────────────────────────────────────────
await connectDB(dbConnRepo.getActive());
const cfg = getActiveConfig(), isHana = getActiveType() === 'hana', q = n => isHana ? `"${n}"` : n, T = n => tableRef(n, cfg);
const fromD = new Date(); fromD.setMonth(fromD.getMonth() - MONTHS);
const fromYmd = fromD.toISOString().slice(0, 10);
const ymd = v => v ? String(v instanceof Date ? v.toISOString() : v).slice(0, 10) : null;
const raw = await executeSQL(`SELECT T0.${q('DocEntry')} AS ${q('DocEntry')}, T0.${q('DocNum')} AS ${q('DocNum')}, T0.${q('DocDate')} AS ${q('DocDate')}, ` +
  `T0.${q('DocDueDate')} AS ${q('DocDueDate')}, T0.${q('CardCode')} AS ${q('CardCode')}, T0.${q('CardName')} AS ${q('CardName')}, ` +
  `T1.${q('LineNum')} AS ${q('LineNum')}, T1.${q('ItemCode')} AS ${q('ItemCode')}, T1.${q('Dscription')} AS ${q('Dscription')}, ` +
  `T1.${q('Quantity')} AS ${q('Quantity')}, T1.${q('WhsCode')} AS ${q('WhsCode')}, T1.${q('unitMsr')} AS ${q('UoM')} ` +
  `FROM ${T('OPDN')} T0 INNER JOIN ${T('PDN1')} T1 ON T1.${q('DocEntry')} = T0.${q('DocEntry')} ` +
  `WHERE T0.${q('CANCELED')} = 'N' AND T0.${q('DocDate')} >= '${fromYmd}' ORDER BY T0.${q('DocDate')}, T0.${q('DocNum')}, T1.${q('LineNum')}`);
const bins = new Map();
const docs = [...new Set(raw.map(l => Number(l.DocEntry)))];
for (let i = 0; i < docs.length; i += 500) {
  const rows = await executeSQL(`SELECT L.${q('DocEntry')} AS ${q('DocEntry')}, L.${q('DocLineNum')} AS ${q('LineNum')}, B.${q('BinCode')} AS ${q('BinCode')}, ` +
    `T1.${q('Quantity')} AS ${q('Qty')} FROM ${T('OILM')} L INNER JOIN ${T('OBTL')} T1 ON T1.${q('MessageID')} = L.${q('MessageID')} ` +
    `INNER JOIN ${T('OBIN')} B ON B.${q('AbsEntry')} = T1.${q('BinAbs')} WHERE L.${q('TransType')} = 20 AND L.${q('DocEntry')} IN (${docs.slice(i, i + 500).join(',')})`);
  for (const r of rows) {
    const k = `${r.DocEntry}-${r.LineNum}`;
    if (!bins.has(k)) bins.set(k, []);
    bins.get(k).push({ bin: r.BinCode, qty: Number(r.Qty) });
  }
}
const lines = raw.map(r => {
  const b = (bins.get(`${r.DocEntry}-${r.LineNum}`) || []).sort((x, y) => y.qty - x.qty);
  return { doc_entry: Number(r.DocEntry), doc_num: Number(r.DocNum), line_num: Number(r.LineNum), doc_date: ymd(r.DocDate),
    doc_due_date: ymd(r.DocDueDate), card_code: r.CardCode || '', card_name: r.CardName || '', item_code: r.ItemCode || '',
    item_name: r.Dscription || '', quantity: Number(r.Quantity || 0), uom: r.UoM || '', whs_code: r.WhsCode || '',
    bin_code: b[0]?.bin || '', bin_all: [...new Set(b.map(x => x.bin))].join(', ') };
});
sortingRepo.upsertLines(company, lines);
db.prepare(`UPDATE sorting_tasks SET assigned_by=? WHERE company=? AND doc_date>=? AND status='pending'`).run(DEMO, company, fromYmd);
const tasks = db.prepare(`SELECT * FROM sorting_tasks WHERE company=? AND assigned_by=? ORDER BY doc_date, doc_num, line_num`).all(company, DEMO);
console.log(`GRPO lines since ${fromYmd}: ${tasks.length} (${docs.length} documents, ${bins.size} with a bin)`);

// ── Simulate sorting days ────────────────────────────────────────────────────
const rand = (seed => () => (seed = (seed * 16807) % 2147483647) / 2147483647)(Date.now() % 2147483647 || 1);
const between = (a, b) => a + rand() * (b - a);
const at = (day, mins) => { const [y, m, d] = day.split('-').map(Number); return new Date(y, m - 1, d, 0, 0, Math.round(mins * 60)).toISOString(); };
const openFrom = tasks.length - LEAVE_OPEN;
const byDay = new Map();
tasks.forEach((t, i) => { if (i < openFrom) { if (!byDay.has(t.doc_date)) byDay.set(t.doc_date, []); byDay.get(t.doc_date).push(t); } });

const insShift = db.prepare(`INSERT INTO sorting_shifts (company, user_id, clock_in, clock_out, clocked_by) VALUES (?,?,?,?,?)`);
const insWork = db.prepare(`INSERT INTO sorting_work (task_id, user_id, start_at, end_at, seconds) VALUES (?,?,?,?,?)`);
const setDone = db.prepare(`UPDATE sorting_tasks SET status='done', assigned_user_id=@user, assigned_by=@by, assigned_at=@assigned, started_at=@started,
    active_since=NULL, work_seconds=@secs, completed_at=@completed, completed_by=@user, sorted_qty=@sorted, notes=@notes, updated_at=@completed
  WHERE id=@id`);
const sapRows = [];
let shifts = 0;
db.transaction(() => {
  for (const [day, dayTasks] of byDay) {
    // Durations first; staff the day to its workload (busy day → all 5 in the
    // 7/9/10 pattern, light day → just the early shift). ~10% absence each.
    const plan = dayTasks.map(t => ({ t, mins: Math.min(60, Math.max(6, 6 + Math.sqrt(Math.max(0, t.quantity)) * 0.8 + between(0, 12))), gap: between(1, 5) }));
    const total = plan.reduce((s, p) => s + p.mins + p.gap, 0);
    const needed = Math.min(crew.length, Math.max(1, Math.ceil(total / 420)));
    const available = crew.filter(() => rand() > 0.1);
    const present = (available.length >= needed ? available : crew).slice(0, needed);
    const people = present.map(c => {
      const inAt = c.startHour * 60 + between(-10, 10);
      const lunch = between(12 * 60, 13 * 60);
      return { ...c, inAt, free: inAt + between(3, 10), lunch, lunchDone: false, lastOut: inAt };
    });
    // Compress very busy days so everyone is out by ~17:30.
    const cap = people.reduce((s, p) => s + (17 * 60 - p.free - 30), 0) * 0.92;
    const scale = Math.min(1, cap / plan.reduce((s, p) => s + p.mins + p.gap, 0));
    for (const { t, mins, gap } of plan) {
      people.sort((a, b) => a.free - b.free);
      const p = people[0];
      if (!p.lunchDone && p.free >= p.lunch) { p.free += 30; p.lunchDone = true; }
      const work = Math.max(1, mins * scale);
      const start = p.free;
      // ~15% of lines are paused once (called away) and resumed a few minutes later.
      const runs = rand() < 0.15 ? [[start, start + work * 0.5], [start + work * 0.5 + between(3, 12), start + work + between(3, 12)]] : [[start, start + work]];
      for (const [a, b] of runs) insWork.run(t.id, p.id, at(day, a), at(day, b), Math.round((b - a) * 60));
      const end = runs[runs.length - 1][1];
      const short = rand() < 0.06 && t.quantity >= 2;
      const sorted = short ? Math.max(1, Math.round(t.quantity * between(0.9, 0.99))) : t.quantity;
      setDone.run({ id: t.id, user: p.id, by: DEMO, assigned: at(day, start - between(1, 20)), started: at(day, start),
        secs: Math.round(runs.reduce((s, [a, b]) => s + (b - a) * 60, 0)), completed: at(day, end), sorted,
        notes: short ? `[demo] short by ${t.quantity - sorted}` : '' });
      p.free = end + gap * scale;
      p.lastOut = end;
      sapRows.push({ t, user: p.sapUser, tin: at(day, start), tout: at(day, end) });
    }
    for (const p of people) {
      insShift.run(company, p.id, at(day, p.inAt), at(day, p.lastOut + between(5, 20)), DEMO);
      shifts++;
    }
  }
})();
for (const t of tasks.slice(Math.max(0, openFrom))) sapRows.push({ t, user: null, tin: null, tout: null });
console.log(`Simulated ${byDay.size} sorting day(s), ${shifts} shift(s); ${tasks.length - Math.max(0, openFrom)} line(s) left open for the live demo`);

// ── Write to SAP @SORTING (same Code / mapping as the agent's sync) ──────────
const clip = (v, n) => String(v ?? '').slice(0, n);
const hhmm = iso => { const d = new Date(iso); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const markSynced = db.prepare(`UPDATE sorting_tasks SET sap_dirty=0, sap_error=NULL, sap_synced_at=? WHERE id=?`);
const markFailed = db.prepare(`UPDATE sorting_tasks SET sap_dirty=1, sap_error=? WHERE id=?`);
let ok = 0, failed = 0;
for (const { t, user, tin, tout } of sapRows) {
  const code = `${t.doc_entry}-${t.line_num}`;
  const body = { Name: code, U_GRPO: clip(t.doc_num, 10), U_VC: clip(t.card_code, 15), U_VN: clip(t.card_name, 30), U_IN: clip(t.item_code, 15),
    U_ID: clip(t.item_name, 50), U_QTY: Math.round(t.quantity), U_WH: clip(t.whs_code, 10), U_BIN: clip(t.bin_code, 20),
    U_IS: user ? 'YES' : 'NO', U_USER: user, U_TI: tin ? hhmm(tin) : null, U_TO: tout ? hhmm(tout) : null, U_DD: t.doc_date, U_DDE: t.doc_due_date };
  let r = await sl('post', '/U_SORTING', { Code: code, ...body });
  if (r.status === 400 && /-2035|already exists/i.test(sapMsg(r))) r = await sl('patch', `/U_SORTING('${code}')`, body);
  if (r.status === 201 || r.status === 204) { ok++; markSynced.run(new Date().toISOString(), t.id); }
  else { failed++; markFailed.run(sapMsg(r).slice(0, 500), t.id); if (failed <= 10) console.warn(`  ${code}: ${sapMsg(r)}`); }
  if ((ok + failed) % 100 === 0) console.log(`  … ${ok + failed}/${sapRows.length}`);
}
const per = crew.map(c => `${c.sapUser} ${sapRows.filter(r => r.user === c.sapUser).length}`).join(', ');
console.log(`@SORTING: ${ok} row(s) written, ${failed} failed. Sorted per user: ${per}`);
await http.post(`${base}/Logout`, {}, H);
process.exit(failed ? 1 : 0);
