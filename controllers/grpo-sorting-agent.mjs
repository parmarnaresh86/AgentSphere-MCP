/**
 * GRPO Sorting Agent — backend controller
 * Mounted at /api/grpo-sorting by chat-server.mjs (UI: public/grpo-sorting.html)
 *
 * Loads Goods Receipt PO lines (OPDN/PDN1, default: last one month) into the
 * local sorting_tasks table, then tracks warehouse sorting per user:
 *  1. Clock in / clock out  — sorting_shifts; only clocked-in users get work
 *  2. Assignment            — manual (supervisor) or auto top-up: each sorter on
 *                             shift holds up to queue_size queued lines, least
 *                             loaded first, same item kept together
 *  3. Start / pause / done  — each run is a sorting_work interval, so time is
 *                             attributed to the user who actually did it
 *  4. Reports               — user-wise, item-wise and user × item time / qty
 *
 * SAP is only read: DB Direct (MSSQL / HANA) first, Service Layer fallback.
 */

import { Router } from 'express';
import { sortingRepo, userRepo, userPermRepo, connRepo } from '../db.mjs';

const SORTER_PERM = 'purchase.workflow.grpo_sorting';
const SUPERVISOR_PERM = 'purchase.workflow.grpo_sorting_supervise';
const MAX_LINES = 20000;

function qcol(name, isHana) { return isHana ? `"${name}"` : name; }
const ymd = d => d.toISOString().slice(0, 10);
const isYmd = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
function lastMonth() {
  const to = new Date(), from = new Date();
  from.setMonth(from.getMonth() - 1);
  return { from: ymd(from), to: ymd(to) };
}

// "SAP 400: {"error":{"message":{"value":"..."}}}" → just the readable message.
function sapErrorText(e) {
  const raw = String(e?.message || e).replace(/^SAP \d+:\s*/, '');
  try {
    const err = JSON.parse(raw).error;
    return err?.message?.value || err?.message || (typeof err === 'string' ? err : raw);
  } catch { return raw; }
}

// ── GRPO lines via DB Direct ──────────────────────────────────────────────────
async function fetchGrpoViaDB(deps, from, to) {
  const { isConnected, ensureConnected, getActiveConfig, getActiveType, getTableColumns, tableRef, executeSQL } = deps;
  if (!isConnected?.() && ensureConnected) { try { await ensureConnected(); } catch (e) { console.warn('[GrpoSort] DB reconnect failed:', e.message); } }
  if (!isConnected?.()) return null;
  const cfg = getActiveConfig(), isHana = getActiveType() === 'hana', q = n => qcol(n, isHana);
  const need = { OPDN: ['DocEntry', 'DocNum', 'DocDate', 'DocDueDate', 'CardCode', 'CardName', 'CANCELED'],
    PDN1: ['DocEntry', 'LineNum', 'ItemCode', 'Dscription', 'Quantity', 'WhsCode'] };
  for (const [t, cols] of Object.entries(need)) {
    const have = await getTableColumns(t);
    const miss = cols.filter(c => !have.has(c.toLowerCase()));
    if (miss.length) { console.warn(`[GrpoSort] ${t} missing ${miss.join(', ')}`); return null; }
  }
  const hasUom = (await getTableColumns('PDN1')).has('unitmsr');
  const sql = `SELECT T0.${q('DocEntry')} AS ${q('DocEntry')}, T0.${q('DocNum')} AS ${q('DocNum')}, T0.${q('DocDate')} AS ${q('DocDate')}, ` +
    `T0.${q('DocDueDate')} AS ${q('DocDueDate')}, T0.${q('CardCode')} AS ${q('CardCode')}, T0.${q('CardName')} AS ${q('CardName')}, T1.${q('LineNum')} AS ${q('LineNum')}, ` +
    `T1.${q('ItemCode')} AS ${q('ItemCode')}, T1.${q('Dscription')} AS ${q('Dscription')}, T1.${q('Quantity')} AS ${q('Quantity')}, ` +
    `T1.${q('WhsCode')} AS ${q('WhsCode')}${hasUom ? `, T1.${q('unitMsr')} AS ${q('UoM')}` : ''} ` +
    `FROM ${tableRef('OPDN', cfg)} T0 INNER JOIN ${tableRef('PDN1', cfg)} T1 ON T1.${q('DocEntry')} = T0.${q('DocEntry')} ` +
    `WHERE T0.${q('CANCELED')} = 'N' AND T0.${q('DocDate')} >= '${from}' AND T0.${q('DocDate')} <= '${to}' ` +
    `ORDER BY T0.${q('DocDate')}, T0.${q('DocNum')}, T1.${q('LineNum')}`;
  const rows = (await executeSQL(sql)).slice(0, MAX_LINES);
  const bins = await fetchGrpoBinsViaDB(deps, [...new Set(rows.map(r => Number(r.DocEntry)))]);
  const day = v => v ? String(v instanceof Date ? ymd(v) : v).slice(0, 10) : null;
  return rows.map(r => ({
    doc_entry: Number(r.DocEntry), doc_num: Number(r.DocNum), line_num: Number(r.LineNum),
    doc_date: day(r.DocDate), doc_due_date: day(r.DocDueDate),
    ...binFields(bins.get(`${Number(r.DocEntry)}-${Number(r.LineNum)}`)),
    card_code: r.CardCode || '', card_name: r.CardName || '', item_code: r.ItemCode || '',
    item_name: r.Dscription || '', quantity: Number(r.Quantity || 0), uom: r.UoM || '', whs_code: r.WhsCode || '',
  }));
}

// Receiving bins per GRPO line: OILM (TransType 20 = GRPO) → OBTL → OBIN.
// Returns Map "DocEntry-LineNum" → [{ bin, qty }]; empty when bins are not used.
async function fetchGrpoBinsViaDB(deps, docEntries) {
  const { getActiveConfig, getActiveType, tableRef, executeSQL } = deps;
  const cfg = getActiveConfig(), isHana = getActiveType() === 'hana', q = n => qcol(n, isHana);
  const out = new Map();
  try {
    for (let i = 0; i < docEntries.length; i += 500) {
      const chunk = docEntries.slice(i, i + 500);
      const rows = await executeSQL(`SELECT L.${q('DocEntry')} AS ${q('DocEntry')}, L.${q('DocLineNum')} AS ${q('LineNum')}, ` +
        `B.${q('BinCode')} AS ${q('BinCode')}, T1.${q('Quantity')} AS ${q('Qty')} ` +
        `FROM ${tableRef('OILM', cfg)} L INNER JOIN ${tableRef('OBTL', cfg)} T1 ON T1.${q('MessageID')} = L.${q('MessageID')} ` +
        `INNER JOIN ${tableRef('OBIN', cfg)} B ON B.${q('AbsEntry')} = T1.${q('BinAbs')} ` +
        `WHERE L.${q('TransType')} = 20 AND L.${q('DocEntry')} IN (${chunk.join(',')})`);
      for (const r of rows) {
        const k = `${Number(r.DocEntry)}-${Number(r.LineNum)}`;
        if (!out.has(k)) out.set(k, []);
        out.get(k).push({ bin: r.BinCode, qty: Number(r.Qty || 0) });
      }
    }
  } catch (e) { console.warn('[GrpoSort] bin lookup failed:', e.message); }
  return out;
}
// Largest-quantity bin goes to SAP (U_BIN holds one code); all bins kept locally.
function binFields(list) {
  if (!list?.length) return { bin_code: '', bin_all: '' };
  const sorted = [...list].sort((a, b) => b.qty - a.qty);
  return { bin_code: sorted[0].bin, bin_all: [...new Set(sorted.map(x => x.bin))].join(', ') };
}

// ── GRPO lines via Service Layer (no DB Direct connection) ────────────────────
async function fetchGrpoViaSL(sap, from, to) {
  const out = [];
  let skip = 0;
  while (out.length < MAX_LINES) {
    const r = await sap.get('/PurchaseDeliveryNotes', {
      $select: 'DocEntry,DocNum,DocDate,DocDueDate,CardCode,CardName,DocumentLines',
      $filter: `DocDate ge '${from}' and DocDate le '${to}' and Cancelled eq 'tNO'`,
      $orderby: 'DocDate,DocNum', $top: 50, $skip: skip,
    });
    const page = r.value || [];
    for (const d of page) {
      for (const l of d.DocumentLines || []) {
        out.push({
          doc_entry: d.DocEntry, doc_num: d.DocNum, line_num: l.LineNum, doc_date: String(d.DocDate).slice(0, 10),
          doc_due_date: d.DocDueDate ? String(d.DocDueDate).slice(0, 10) : null,
          _bins: (l.DocumentLinesBinAllocations || []).map(b => ({ abs: b.BinAbsEntry, qty: Number(b.Quantity || 0) })),
          card_code: d.CardCode || '', card_name: d.CardName || '', item_code: l.ItemCode || '',
          item_name: l.ItemDescription || '', quantity: Number(l.Quantity || 0),
          uom: l.MeasureUnit || l.UoMCode || '', whs_code: l.WarehouseCode || '',
        });
      }
    }
    if (!page.length || !(r['odata.nextLink'] || r['@odata.nextLink'])) break;
    skip += page.length;
  }
  const codes = new Map();
  for (const abs of new Set(out.flatMap(l => l._bins.map(b => b.abs)))) {
    try { codes.set(abs, (await sap.get(`/BinLocations(${abs})`, { $select: 'BinCode' })).BinCode); } catch {}
  }
  return out.map(({ _bins, ...l }) => ({ ...l, ...binFields(_bins.filter(b => codes.has(b.abs)).map(b => ({ bin: codes.get(b.abs), qty: b.qty }))) }));
}

// ── SAP @SORTING mirror (no-object UDT → Service Layer /U_SORTING) ─────────────
// Code = "<GRPO DocEntry>-<LineNum>". Field sizes / types come from the UDT:
// U_QTY is a whole number, U_TI/U_TO are SAP time fields (HH:MM), U_IS is YES/NO,
// U_USER has its own valid-value list in SAP.
const SAP_UDT = '/U_SORTING';
const sapCode = t => `${t.doc_entry}-${t.line_num}`;
const clip = (v, n) => String(v ?? '').slice(0, n);
const hhmm = iso => { if (!iso) return null; const d = new Date(iso); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
// The employee is whoever is sorting the line: the finisher once done, else the current holder.
function sortingRow(t, empValue) {
  const who = t.status === 'done' ? t.completed_by : t.started_at ? t.assigned_user_id : null;
  return {
    Name: sapCode(t), U_GRPO: clip(t.doc_num, 10), U_VC: clip(t.card_code, 15), U_VN: clip(t.card_name, 30),
    U_IN: clip(t.item_code, 15), U_ID: clip(t.item_name, 50), U_QTY: Math.round(Number(t.quantity || 0)),
    U_WH: clip(t.whs_code, 10), U_BIN: clip(t.bin_code, 20), U_IS: t.status === 'done' ? 'YES' : 'NO',
    U_USER: who ? (empValue(who) || null) : null, U_TI: hhmm(t.started_at), U_TO: t.status === 'done' ? hhmm(t.completed_at) : null,
    U_DD: t.doc_date || null, U_DDE: t.doc_due_date || null,
  };
}
// PATCH first (row usually exists after the first push); create it on 404.
async function pushSortingRow(sap, t, body) {
  const code = sapCode(t);
  if (t.sap_synced_at) {
    try { await sap.patch(`${SAP_UDT}('${code}')`, body); return; }
    catch (e) { if (!/^SAP 404/.test(e.message)) throw e; }
  }
  try { await sap.post(SAP_UDT, { Code: code, ...body }); }
  catch (e) {
    if (!/already exists|-2035/i.test(e.message)) throw e;
    await sap.patch(`${SAP_UDT}('${code}')`, body);
  }
}
// U_USER value for an employee: upper-case first name, as the existing valid values (NIK, JOSH…) are.
const empUserValue = name => clip(String(name || '').trim().split(/\s+/)[0].toUpperCase(), 10);

// ── SAP employees (OHEM) and the U_USER valid-value list ──────────────────────
async function fetchEmployees(deps, sap) {
  const { isConnected, getActiveConfig, getActiveType, tableRef, executeSQL } = deps;
  if (isConnected?.()) {
    try {
      const cfg = getActiveConfig(), q = n => qcol(n, getActiveType() === 'hana');
      const rows = await executeSQL(`SELECT ${q('empID')} AS ${q('empID')}, ${q('firstName')} AS ${q('firstName')}, ${q('lastName')} AS ${q('lastName')} ` +
        `FROM ${tableRef('OHEM', cfg)} WHERE ${q('Active')} = 'Y' ORDER BY ${q('firstName')}`);
      return rows.map(r => ({ empId: Number(r.empID), name: [r.firstName, r.lastName].filter(Boolean).join(' ') }));
    } catch (e) { console.warn('[GrpoSort] OHEM read failed, using Service Layer:', e.message); }
  }
  const r = await sap.get('/EmployeesInfo', { $select: 'EmployeeID,FirstName,LastName', $filter: "Active eq 'tYES'", $top: 500 });
  return (r.value || []).map(e => ({ empId: e.EmployeeID, name: [e.FirstName, e.LastName].filter(Boolean).join(' ') }));
}
async function fetchUserValidValues(sap) {
  try {
    const r = await sap.get('/UserFieldsMD', { $filter: "TableName eq '@SORTING' and Name eq 'USER'", $select: 'ValidValuesMD' });
    const vv = r.value?.[0]?.ValidValuesMD || [];
    return vv.length ? vv.map(v => v.Value) : null;
  } catch { return null; }
}

// ── Report aggregation ────────────────────────────────────────────────────────
// Clip [a, b) to [from, to); an open interval runs until now.
function overlapSecs(a, b, from, to) {
  const s = Math.max(new Date(a).getTime(), new Date(from).getTime());
  const e = Math.min(b ? new Date(b).getTime() : Date.now(), new Date(to).getTime());
  return Math.max(0, Math.round((e - s) / 1000));
}

function buildReport(company, from, to) {
  const shifts = sortingRepo.shifts(company, { from, to });
  const work = sortingRepo.workIntervals(company, from, to);
  const done = sortingRepo.completedBetween(company, from, to);
  const nameOf = r => r.full_name || r.username || `User ${r.user_id ?? r.completed_by}`;

  const users = new Map();
  const u = (id, name) => {
    if (!users.has(id)) users.set(id, { userId: id, name, shifts: 0, firstIn: null, lastOut: null, open: false,
      shiftSecs: 0, workSecs: 0, linesDone: 0, qtySorted: 0, items: new Set() });
    return users.get(id);
  };
  for (const s of shifts) {
    const x = u(s.user_id, nameOf(s));
    x.shifts++;
    x.shiftSecs += overlapSecs(s.clock_in, s.clock_out, from, to);
    if (!x.firstIn || s.clock_in < x.firstIn) x.firstIn = s.clock_in;
    if (!s.clock_out) x.open = true;
    else if (!x.lastOut || s.clock_out > x.lastOut) x.lastOut = s.clock_out;
  }

  const items = new Map();
  const it = (code, name) => {
    if (!items.has(code)) items.set(code, { itemCode: code, itemName: name, linesDone: 0, qtyReceived: 0, qtySorted: 0, workSecs: 0, users: new Set() });
    return items.get(code);
  };
  const cross = new Map();
  const cx = (userId, name, code, itemName) => {
    const k = `${userId}|${code}`;
    if (!cross.has(k)) cross.set(k, { userId, name, itemCode: code, itemName, lines: new Set(), linesDone: 0, qtySorted: 0, workSecs: 0 });
    return cross.get(k);
  };

  for (const w of work) {
    const secs = overlapSecs(w.start_at, w.end_at, from, to);
    const name = nameOf(w);
    u(w.user_id, name).workSecs += secs;
    const i = it(w.item_code, w.item_name);
    i.workSecs += secs; i.users.add(name);
    const c = cx(w.user_id, name, w.item_code, w.item_name);
    c.workSecs += secs; c.lines.add(w.task_id);
  }
  for (const t of done) {
    const name = nameOf(t);
    const qty = Number(t.sorted_qty ?? t.quantity ?? 0);
    const x = u(t.completed_by, name);
    x.linesDone++; x.qtySorted += qty; x.items.add(t.item_code);
    const i = it(t.item_code, t.item_name);
    i.linesDone++; i.qtyReceived += Number(t.quantity || 0); i.qtySorted += qty; i.users.add(name);
    const c = cx(t.completed_by, name, t.item_code, t.item_name);
    c.linesDone++; c.qtySorted += qty; c.lines.add(t.id);
  }

  const perHour = (qty, secs) => secs > 0 ? +(qty / (secs / 3600)).toFixed(2) : null;
  return {
    from, to,
    userWise: [...users.values()].map(x => ({
      userId: x.userId, name: x.name, shifts: x.shifts, firstIn: x.firstIn, lastOut: x.open ? null : x.lastOut, onShift: x.open,
      shiftMinutes: Math.round(x.shiftSecs / 60), workMinutes: Math.round(x.workSecs / 60),
      idleMinutes: Math.max(0, Math.round((x.shiftSecs - x.workSecs) / 60)),
      utilisationPct: x.shiftSecs ? Math.round((x.workSecs / x.shiftSecs) * 100) : null,
      linesDone: x.linesDone, qtySorted: +x.qtySorted.toFixed(3), distinctItems: x.items.size,
      qtyPerHour: perHour(x.qtySorted, x.workSecs),
      avgMinPerLine: x.linesDone ? +((x.workSecs / 60) / x.linesDone).toFixed(1) : null,
    })).sort((a, b) => b.qtySorted - a.qtySorted || a.name.localeCompare(b.name)),
    itemWise: [...items.values()].map(i => ({
      itemCode: i.itemCode, itemName: i.itemName, linesDone: i.linesDone, qtyReceived: +i.qtyReceived.toFixed(3),
      qtySorted: +i.qtySorted.toFixed(3), workMinutes: +(i.workSecs / 60).toFixed(1),
      avgMinPerLine: i.linesDone ? +((i.workSecs / 60) / i.linesDone).toFixed(1) : null,
      secPerUnit: i.qtySorted ? +(i.workSecs / i.qtySorted).toFixed(1) : null,
      users: [...i.users].sort(),
    })).sort((a, b) => b.workMinutes - a.workMinutes),
    userItem: [...cross.values()].map(c => ({
      userId: c.userId, name: c.name, itemCode: c.itemCode, itemName: c.itemName, linesWorked: c.lines.size,
      linesDone: c.linesDone, qtySorted: +c.qtySorted.toFixed(3), workMinutes: +(c.workSecs / 60).toFixed(1),
      qtyPerHour: perHour(c.qtySorted, c.workSecs),
    })).sort((a, b) => a.name.localeCompare(b.name) || b.workMinutes - a.workMinutes),
    lineWise: done.map(t => ({
      grpo: t.doc_num, line: t.line_num + 1, docDate: t.doc_date, vendor: t.card_name, itemCode: t.item_code, itemName: t.item_name,
      whs: t.whs_code, bin: t.bin_code, qty: Number(t.quantity || 0), sortedQty: Number(t.sorted_qty ?? t.quantity ?? 0),
      name: nameOf(t), timeIn: t.started_at, timeOut: t.completed_at, workMinutes: +((t.work_seconds || 0) / 60).toFixed(1),
      notes: t.notes || '', sap: t.sap_error ? 'Error' : t.sap_dirty ? 'Waiting' : t.sap_synced_at ? 'Synced' : '—',
    })).sort((a, b) => String(b.timeOut).localeCompare(String(a.timeOut))),
    shifts: shifts.map(s => ({ id: s.id, userId: s.user_id, name: nameOf(s), clockIn: s.clock_in, clockOut: s.clock_out,
      minutes: Math.round(overlapSecs(s.clock_in, s.clock_out, s.clock_in, '9999-12-31') / 60), clockedBy: s.clocked_by })),
  };
}

export function createGrpoSortingRouter(deps) {
  const { requireAuth, getActiveSap, getActiveConfig } = deps;
  const router = Router();

  // Sorting data follows the SAP company of the caller's session.
  const companyOf = () => {
    const cfg = getActiveConfig?.();
    return getActiveSap?.()?._connCredentials?.company || connRepo.getActive()?.company || cfg?.database || cfg?.schema_name || 'default';
  };
  const permsOf = user => new Set(userPermRepo.getEffective(user.user_id, user.role));
  const isSupervisor = user => ['admin', 'superadmin'].includes(user.role) || permsOf(user).has(SUPERVISOR_PERM);
  const who = req => req.user?.full_name || req.user?.username || '';
  const me = req => Number(req.user.user_id);

  const supervisorOnly = (req, res, next) =>
    isSupervisor(req.user) ? next() : res.status(403).json({ error: 'Supervisor access required' });
  // Clocking another user in/out is a supervisor action; everyone may clock themselves.
  const targetUser = req => {
    const id = req.body?.userId ? Number(req.body.userId) : me(req);
    if (id !== me(req) && !isSupervisor(req.user)) { const e = new Error('Supervisor access required'); e.status = 403; throw e; }
    if (!userRepo.findById.get(id)) { const e = new Error('User not found'); e.status = 404; throw e; }
    return id;
  };
  const wrap = fn => async (req, res) => {
    try { await fn(req, res); }
    catch (e) { res.status(e.status || 400).json({ error: sapErrorText(e) }); }
  };
  const autoTopUp = company => sortingRepo.getSettings(company).auto_assign ? sortingRepo.topUp(company) : 0;

  // Background push of changed lines to SAP @SORTING, one worker per company.
  // The Service Layer client is taken from the request that caused the change.
  const sync = new Map();   // company → { running, again, sap }
  function kickSync(company, sap) {
    const st = sync.get(company) || { running: false, again: false };
    st.sap = sap || st.sap || getActiveSap();
    sync.set(company, st);
    if (st.running) { st.again = true; return; }
    st.running = true;
    (async () => {
      const empValue = uid => empUserValue(sortingRepo.empOf(company, uid)?.emp_name);
      do {
        st.again = false;
        let batch;
        while ((batch = sortingRepo.sapDirty(company)).length) {
          for (const t of batch) {
            const pushedAt = new Date().toISOString();
            try { await pushSortingRow(st.sap, t, sortingRow(t, empValue)); sortingRepo.sapSynced(t.id, pushedAt); }
            catch (e) { sortingRepo.sapFailed(t.id, sapErrorText(e)); }
          }
        }
      } while (st.again);
    })().catch(e => console.warn('[GrpoSort] SAP sync stopped:', e.message)).finally(() => { st.running = false; });
  }
  // Kick after every change that can mark lines dirty.
  router.use((req, res, next) => {
    if (req.method !== 'GET') { const company = companyOf(), sap = getActiveSap(); res.on('finish', () => kickSync(company, sap)); }
    next();
  });

  router.get('/me', requireAuth, wrap((req, res) => {
    const company = companyOf();
    res.json({ ok: true, company, user: req.user, isSupervisor: isSupervisor(req.user),
      shift: sortingRepo.openShift(company, me(req)) || null, settings: sortingRepo.getSettings(company), defaultRange: lastMonth() });
  }));

  // Everyone who can sort (holds the sorter key), with their shift state.
  router.get('/users', requireAuth, supervisorOnly, wrap((req, res) => {
    const company = companyOf();
    const on = new Map(sortingRepo.onShift(company).map(s => [s.user_id, s]));
    const users = userRepo.list.all()
      .filter(u => u.role === 'superadmin' || userPermRepo.getEffective(u.id, u.role).includes(SORTER_PERM))
      .map(u => ({ id: u.id, username: u.username, name: u.full_name || u.username, onShift: on.has(u.id), clockIn: on.get(u.id)?.clock_in || null }));
    res.json({ ok: true, users });
  }));

  router.get('/board', requireAuth, supervisorOnly, wrap((req, res) => {
    const company = companyOf();
    res.json({ ok: true, company, onShift: sortingRepo.onShift(company), counts: sortingRepo.counts(company),
      settings: sortingRepo.getSettings(company), sap: { ...sortingRepo.sapStatus(company), running: !!sync.get(company)?.running } });
  }));

  // Clear SAP errors (e.g. after fixing U_USER valid values) and push again.
  router.post('/sap-sync', requireAuth, supervisorOnly, wrap((req, res) => {
    res.json({ ok: true, retried: sortingRepo.sapRetry(companyOf()) });
  }));

  // Sorters ↔ SAP employees, plus the U_USER values SAP will accept.
  router.get('/employees', requireAuth, supervisorOnly, wrap(async (req, res) => {
    const company = companyOf(), sap = getActiveSap();
    const [employees, validValues] = await Promise.all([fetchEmployees(deps, sap), fetchUserValidValues(sap)]);
    res.json({ ok: true, employees: employees.map(e => ({ ...e, userValue: empUserValue(e.name) })), validValues, map: sortingRepo.empMap(company) });
  }));
  router.put('/employee-map', requireAuth, supervisorOnly, wrap((req, res) => {
    const userId = Number(req.body?.userId);
    if (!userRepo.findById.get(userId)) throw new Error('User not found');
    const empId = req.body?.empId == null || req.body.empId === '' ? null : Number(req.body.empId);
    sortingRepo.setEmp(companyOf(), userId, empId, req.body?.empName);
    res.json({ ok: true });
  }));

  router.put('/settings', requireAuth, supervisorOnly, wrap((req, res) => {
    const company = companyOf();
    const settings = sortingRepo.saveSettings(company, req.body || {});
    res.json({ ok: true, settings, assigned: autoTopUp(company) });
  }));

  // Pull GRPO lines from SAP into the sorting table.
  router.post('/load', requireAuth, supervisorOnly, wrap(async (req, res) => {
    const company = companyOf();
    const def = lastMonth();
    const from = isYmd(req.body?.from) ? req.body.from : def.from;
    const to = isYmd(req.body?.to) ? req.body.to : def.to;
    if (from > to) throw new Error('From date is after To date');
    let lines = null, source = 'db';
    try { lines = await fetchGrpoViaDB(deps, from, to); }
    catch (e) { console.warn('[GrpoSort] DB read failed, using Service Layer:', e.message); }
    if (!lines) { source = 'service-layer'; lines = await fetchGrpoViaSL(getActiveSap(), from, to); }
    const result = sortingRepo.upsertLines(company, lines);
    res.json({ ok: true, company, from, to, source, fetched: lines.length, ...result, assigned: autoTopUp(company) });
  }));

  router.get('/tasks', requireAuth, wrap((req, res) => {
    const company = companyOf();
    const { status, item, q, from, to } = req.query;
    const userId = isSupervisor(req.user) ? (req.query.userId ? Number(req.query.userId) : undefined) : me(req);
    res.json({ ok: true, tasks: sortingRepo.list(company, { status, userId, item, q, from: isYmd(from) ? from : undefined, to: isYmd(to) ? to : undefined }) });
  }));

  // The sorter's own screen: shift, queue and what they finished this shift.
  router.get('/my', requireAuth, wrap((req, res) => {
    const company = companyOf();
    const shift = sortingRepo.openShift(company, me(req)) || null;
    const mine = sortingRepo.list(company, { userId: me(req) });
    res.json({ ok: true, shift,
      active: mine.filter(t => t.status === 'in_progress' || t.status === 'assigned'),
      done: shift ? mine.filter(t => t.status === 'done' && t.completed_at >= shift.clock_in) : [] });
  }));

  router.post('/clock-in', requireAuth, wrap((req, res) => {
    const company = companyOf();
    const shift = sortingRepo.clockIn(company, targetUser(req), who(req));
    res.json({ ok: true, shift, assigned: autoTopUp(company) });
  }));

  router.post('/clock-out', requireAuth, wrap((req, res) => {
    const company = companyOf();
    const shift = sortingRepo.clockOut(company, targetUser(req), who(req));
    res.json({ ok: true, shift, assigned: autoTopUp(company) });
  }));

  // userId null → unassign (back to the pool).
  router.post('/assign', requireAuth, supervisorOnly, wrap((req, res) => {
    const company = companyOf();
    const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).map(Number).filter(Boolean);
    if (!ids.length) throw new Error('Select at least one line');
    const userId = req.body?.userId ? Number(req.body.userId) : null;
    if (userId && !userRepo.findById.get(userId)) throw new Error('User not found');
    res.json({ ok: true, changed: sortingRepo.assign(company, ids, userId, who(req)) });
  }));

  router.post('/auto-assign', requireAuth, supervisorOnly, wrap((req, res) => {
    res.json({ ok: true, assigned: sortingRepo.topUp(companyOf(), who(req)) });
  }));

  router.post('/rebalance', requireAuth, supervisorOnly, wrap((req, res) => {
    res.json({ ok: true, assigned: sortingRepo.rebalance(companyOf(), who(req)) });
  }));

  router.post('/tasks/:id/start', requireAuth, wrap((req, res) => {
    res.json({ ok: true, task: sortingRepo.start(Number(req.params.id), me(req)) });
  }));
  router.post('/tasks/:id/pause', requireAuth, wrap((req, res) => {
    res.json({ ok: true, task: sortingRepo.pause(Number(req.params.id), me(req)) });
  }));
  router.post('/tasks/:id/complete', requireAuth, wrap((req, res) => {
    const task = sortingRepo.complete(Number(req.params.id), me(req), { sortedQty: req.body?.sortedQty, notes: req.body?.notes });
    res.json({ ok: true, task, assigned: autoTopUp(task.company) });
  }));
  router.post('/tasks/:id/reopen', requireAuth, supervisorOnly, wrap((req, res) => {
    res.json({ ok: true, changed: sortingRepo.reopen(companyOf(), Number(req.params.id)) });
  }));

  // from/to are ISO instants (the browser sends its local-day bounds).
  router.get('/report', requireAuth, supervisorOnly, wrap((req, res) => {
    const to = req.query.to && !isNaN(new Date(req.query.to)) ? new Date(req.query.to).toISOString() : new Date().toISOString();
    const from = req.query.from && !isNaN(new Date(req.query.from)) ? new Date(req.query.from).toISOString()
      : new Date(new Date(to).getTime() - 86400000).toISOString();
    res.json({ ok: true, ...buildReport(companyOf(), from, to) });
  }));

  return router;
}
