/**
 * Putaway Analytics Agent — backend controller
 * Mounted at /api/putaway-analytics by chat-server.mjs (UI: public/putaway-analytics.html)
 *
 * Read-only analytics over the SAP Document UDO STTL_PUTAWAY (header @STTL_OPTW,
 * rows @STTL_PTW1), joined to @SORTING through U_SortCode so each line carries
 * its sorter and sort-out time:
 *  1. KPIs              — documents by status, lines/qty put away, speed, sort → putaway wait
 *  2. User-wise         — workload, speed, working window
 *  3. Flow              — receiving warehouse → storage warehouse, destination bins
 *  4. Time patterns     — daily trend, wait-time distribution
 *  5. Backlog, item / vendor breakdowns, AI insights
 *  6. Forklift vs manual — row U_Forklift, else the item master "Forklift
 *     Required?" (OITM.U_FR, reached through the GRPO line PDN1)
 * No transactions — the putaway documents are maintained in SAP.
 */

import { Router } from 'express';

const MAX_ROWS = 50000;

// ── AI helper ─────────────────────────────────────────────────────────────────
async function callAI(aiDeps, messages, systemPrompt, maxTokens = 1200) {
  if (!aiDeps) return '';
  const { AI_PROVIDER, gptChatComplete, azureMessagesCreate } = aiDeps;
  try {
    if (AI_PROVIDER === 'gpt' && process.env.AZURE_GPT_ENDPOINT) {
      const msgs = systemPrompt ? [{ role: 'system', content: systemPrompt }, ...messages] : messages;
      const r = await gptChatComplete({ messages: msgs, max_tokens: maxTokens });
      return r.choices?.[0]?.message?.content || '';
    }
    if (AI_PROVIDER === 'azure' && process.env.AZURE_OPENAI_API_KEY) {
      const model = process.env.AZURE_CLAUDE_MODEL || 'claude-3-5-sonnet-20241022';
      const msgs  = systemPrompt ? [{ role: 'system', content: systemPrompt }, ...messages] : messages;
      const r = await azureMessagesCreate({ model, messages: msgs, max_tokens: maxTokens });
      return r.content?.[0]?.text || r.choices?.[0]?.message?.content || '';
    }
    if (process.env.ANTHROPIC_API_KEY) {
      const { default: Anthropic } = await import('@anthropic-ai/sdk');
      const ant  = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      const resp = await ant.messages.create({
        model: 'claude-sonnet-4-6', max_tokens: maxTokens,
        system: systemPrompt || undefined, messages,
      });
      return resp.content?.[0]?.text || '';
    }
  } catch (e) { console.warn('[PutawayAnalytics] AI call failed:', e.message); }
  return '';
}

function qcol(name, isHana) { return isHana ? `"${name}"` : name; }
const ymd = d => d.toISOString().slice(0, 10);
const isYmd = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const day = v => v ? String(v instanceof Date ? ymd(v) : v).slice(0, 10) : null;
// SAP time fields: 1310 / "1310" (SQL) or "13:10:00" (Service Layer) → minutes since midnight.
function toMinutes(v) {
  if (v == null || v === '') return null;
  const s = String(v).trim();
  if (s.includes(':')) { const [h, m] = s.split(':').map(Number); return h * 60 + (m || 0); }
  const n = Number(s);
  return Number.isFinite(n) ? Math.floor(n / 100) * 60 + (n % 100) : null;
}
const hhmm = m => m == null ? null : `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(Math.round(m % 60)).padStart(2, '0')}`;
const STATUS = { O: 'Open', P: 'In Process', C: 'Completed' };

// ── Read STTL_PUTAWAY (+ @SORTING) ────────────────────────────────────────────
async function fetchViaDB(deps, from, to) {
  const { isConnected, ensureConnected, getActiveConfig, getActiveType, tableRef, executeSQL } = deps;
  if (!isConnected?.() && ensureConnected) { try { await ensureConnected(); } catch (e) { console.warn('[PutawayAnalytics] DB reconnect failed:', e.message); } }
  if (!isConnected?.()) return null;
  const cfg = getActiveConfig(), q = n => qcol(n, getActiveType() === 'hana');
  const h = ['DocEntry', 'DocNum', 'U_DocDate', 'U_GRPOEntry', 'U_GRPONum', 'U_GRPODate', 'U_CardCode', 'U_CardName', 'U_FromWhs', 'U_Status', 'U_PutUser', 'U_TrfRef'];
  const l = ['LineId', 'U_SortCode', 'U_GRPOLine', 'U_ItemCode', 'U_ItemName', 'U_Qty', 'U_FromWhs', 'U_FromBin', 'U_ToWhs', 'U_ToBin', 'U_PutUser', 'U_TimeIn', 'U_TimeOut', 'U_Status'];
  // Forklift: row U_Forklift, else the GRPO line item's OITM.U_FR. Either UDF may be
  // missing on other companies — then the query is retried without them.
  const sql = withForklift => `SELECT ${h.map(c => `H.${q(c)} AS ${q('H_' + c)}`).join(', ')}, ${l.map(c => `L.${q(c)} AS ${q('L_' + c)}`).join(', ')}, ` +
    `S.${q('U_USER')} AS ${q('S_User')}, S.${q('U_TO')} AS ${q('S_Out')}, S.${q('U_DD')} AS ${q('S_Date')}, S.${q('U_IS')} AS ${q('S_Is')} ` +
    (withForklift ? `, L.${q('U_Forklift')} AS ${q('L_Forklift')}, I.${q('U_FR')} AS ${q('I_FR')}, I.${q('ItemCode')} AS ${q('I_Code')} ` : '') +
    `FROM ${tableRef('@STTL_OPTW', cfg)} H INNER JOIN ${tableRef('@STTL_PTW1', cfg)} L ON L.${q('DocEntry')} = H.${q('DocEntry')} ` +
    `LEFT JOIN ${tableRef('@SORTING', cfg)} S ON S.${q('Code')} = L.${q('U_SortCode')} ` +
    (withForklift ? `LEFT JOIN ${tableRef('PDN1', cfg)} P ON P.${q('DocEntry')} = H.${q('U_GRPOEntry')} AND P.${q('LineNum')} = L.${q('U_GRPOLine')} ` +
      `LEFT JOIN ${tableRef('OITM', cfg)} I ON I.${q('ItemCode')} = P.${q('ItemCode')} ` : '') +
    `WHERE H.${q('Canceled')} = 'N' AND H.${q('U_GRPODate')} >= '${from}' AND H.${q('U_GRPODate')} <= '${to}'`;
  let rows;
  try { rows = await executeSQL(sql(true)); }
  catch (e) { console.warn('[PutawayAnalytics] forklift fields not readable, continuing without:', e.message); rows = await executeSQL(sql(false)); }
  return rows.slice(0, MAX_ROWS).map(r => {
    const o = { H: {}, L: { U_Forklift: r.L_Forklift }, S: { U_USER: r.S_User, U_TO: r.S_Out, U_DD: r.S_Date, U_IS: r.S_Is }, I: { U_FR: r.I_FR, ItemCode: r.I_Code } };
    for (const c of h) o.H[c] = r['H_' + c];
    for (const c of l) o.L[c] = r['L_' + c];
    return o;
  });
}

async function fetchViaSL(sap, from, to) {
  const page = async (path, params) => {
    const out = [];
    while (out.length < MAX_ROWS) {
      const r = await sap.get(path, { ...params, $top: 200, $skip: out.length });
      const v = r.value || [];
      out.push(...v);
      if (!v.length || !(r['odata.nextLink'] || r['@odata.nextLink'])) break;
    }
    return out;
  };
  const docs = await page('/STTL_PUTAWAY', { $filter: `U_GRPODate ge '${from}' and U_GRPODate le '${to}' and Canceled eq 'N'` });
  const sorting = new Map((await page('/U_SORTING', { $filter: `U_DD ge '${from}'` })).map(s => [s.Code, s]));
  return docs.flatMap(H => (H.STTL_PTW1Collection || []).map(L => ({ H, L, S: sorting.get(L.U_SortCode) || {} })));
}

const yesNo = v => { const s = String(v ?? '').trim().toUpperCase(); return s === 'YES' || s === 'Y' ? true : s === 'NO' || s === 'N' ? false : null; };

function normalise({ H, L, S, I = {} }) {
  const tin = toMinutes(L.U_TimeIn), tout = toMinutes(L.U_TimeOut);
  const done = L.U_Status === 'C' && tin != null && tout != null;
  const putDate = day(H.U_DocDate), sortDate = day(S.U_DD), sortOut = toMinutes(S.U_TO);
  // Wait between the line being sorted and its putaway starting (can span days).
  const wait = done && sortDate && sortOut != null
    ? Math.round((new Date(putDate) - new Date(sortDate)) / 60000) + tin - sortOut : null;
  return {
    docEntry: H.DocEntry, docNum: H.DocNum, docStatus: H.U_Status || 'O', putDate, grpoEntry: H.U_GRPOEntry, grpo: String(H.U_GRPONum ?? ''),
    grpoDate: day(H.U_GRPODate), vendorCode: H.U_CardCode || '', vendor: H.U_CardName || '', trfRef: H.U_TrfRef || '',
    line: L.LineId, sortCode: L.U_SortCode || '', itemCode: L.U_ItemCode || '', itemName: L.U_ItemName || '', qty: Number(L.U_Qty || 0),
    fromWhs: L.U_FromWhs || '', fromBin: L.U_FromBin || '', toWhs: L.U_ToWhs || '', toBin: L.U_ToBin || '',
    user: L.U_PutUser || '', tin, tout, mins: done ? (tout >= tin ? tout - tin : tout + 1440 - tin) : null, done,
    sorter: S.U_USER || '', sorted: String(S.U_IS || '').toUpperCase() === 'YES', sortDate, sortOut, wait: wait != null && wait >= 0 ? wait : null,
    // Row value wins; an empty row falls back to the item master. null = not known.
    forklift: yesNo(L.U_Forklift) ?? yesNo(I.U_FR), forkliftFrom: yesNo(L.U_Forklift) != null ? 'putaway row' : yesNo(I.U_FR) != null ? 'item master' : '',
  };
}

// ── Analysis ──────────────────────────────────────────────────────────────────
const round = (n, d = 1) => n == null || !Number.isFinite(n) ? null : +n.toFixed(d);
const perHour = (qty, mins) => mins > 0 ? round(qty / (mins / 60), 1) : null;
const median = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const sum = (a, f) => a.reduce((s, x) => s + (f(x) || 0), 0);
const WAIT_BUCKETS = [['< 30 min', 0, 30], ['30–60 min', 30, 60], ['1–2 h', 60, 120], ['2–4 h', 120, 240], ['4 h – same day', 240, 1440], ['Next day +', 1440, Infinity]];

function analyse(rows, today = ymd(new Date())) {
  const done = rows.filter(r => r.done);
  const open = rows.filter(r => !r.done);
  const totalMins = sum(done, r => r.mins), doneQty = sum(done, r => r.qty);
  const docs = new Map(); rows.forEach(r => docs.set(r.docEntry, r));
  const docStatus = s => [...docs.values()].filter(d => d.docStatus === s).length;
  const waits = done.map(r => r.wait).filter(w => w != null);

  // User-wise with working window per putaway day.
  const users = new Map();
  for (const r of done) {
    if (!users.has(r.user)) users.set(r.user, { user: r.user || '(blank)', lines: 0, qty: 0, mins: 0, durations: [], waits: [], days: new Map(), docs: new Set(), sameAsSorter: 0 });
    const u = users.get(r.user);
    u.lines++; u.qty += r.qty; u.mins += r.mins; u.durations.push(r.mins); u.docs.add(r.docEntry);
    if (r.wait != null) u.waits.push(r.wait);
    if (r.sorter && r.sorter === r.user) u.sameAsSorter++;
    const d = u.days.get(r.putDate) || { first: Infinity, last: -Infinity };
    d.first = Math.min(d.first, r.tin); d.last = Math.max(d.last, r.tin + r.mins); u.days.set(r.putDate, d);
  }
  const userWise = [...users.values()].map(u => {
    const ds = [...u.days.values()], span = sum(ds, d => d.last - d.first);
    return {
      user: u.user, lines: u.lines, sharePct: done.length ? round(u.lines / done.length * 100) : 0, docs: u.docs.size, qty: u.qty,
      putHours: round(u.mins / 60), avgMinPerLine: round(u.mins / u.lines), medianMinPerLine: round(median(u.durations)),
      qtyPerHour: perHour(u.qty, u.mins), daysWorked: ds.length, linesPerDay: round(u.lines / ds.length),
      avgFirstIn: hhmm(sum(ds, d => d.first) / ds.length), avgLastOut: hhmm(sum(ds, d => d.last) / ds.length),
      avgWaitMin: u.waits.length ? round(sum(u.waits, w => w) / u.waits.length, 0) : null,
      ownSortPct: u.lines ? Math.round(u.sameAsSorter / u.lines * 100) : null, busyPct: span ? Math.min(100, Math.round(u.mins / span * 100)) : null,
    };
  }).sort((a, b) => b.lines - a.lines);

  const byDay = new Map();
  for (const r of done) {
    const d = byDay.get(r.putDate) || { date: r.putDate, lines: 0, qty: 0, mins: 0, users: new Set(), docs: new Set() };
    d.lines++; d.qty += r.qty; d.mins += r.mins; d.users.add(r.user); d.docs.add(r.docEntry); byDay.set(r.putDate, d);
  }
  const daily = [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date))
    .map(d => ({ date: d.date, lines: d.lines, docs: d.docs.size, qty: d.qty, putHours: round(d.mins / 60), users: d.users.size, avgMinPerLine: round(d.mins / d.lines) }));

  const waitDist = WAIT_BUCKETS.map(([label, lo, hi]) => ({ label, lines: waits.filter(w => w >= lo && w < hi).length }));

  // Receiving → storage warehouse matrix.
  const fromList = [...new Set(rows.map(r => r.fromWhs))].sort(), toList = [...new Set(rows.map(r => r.toWhs))].sort();
  const flow = { from: fromList, to: toList,
    lines: fromList.map(f => toList.map(t => rows.filter(r => r.fromWhs === f && r.toWhs === t).length)),
    qty: fromList.map(f => toList.map(t => sum(rows.filter(r => r.fromWhs === f && r.toWhs === t), r => r.qty))) };

  const group = (keyFn, labelFn, src = done) => {
    const m = new Map();
    for (const r of src) {
      const k = keyFn(r) || '(blank)';
      const g = m.get(k) || { key: k, label: labelFn(r), lines: 0, qty: 0, mins: 0, users: new Set(), waits: [] };
      g.lines++; g.qty += r.qty; g.mins += r.mins || 0; if (r.user) g.users.add(r.user); if (r.wait != null) g.waits.push(r.wait);
      m.set(k, g);
    }
    return [...m.values()].map(g => ({ key: g.key, label: g.label, lines: g.lines, qty: g.qty, putHours: round(g.mins / 60),
      avgMinPerLine: g.lines ? round(g.mins / g.lines) : null, avgWaitMin: g.waits.length ? round(sum(g.waits, w => w) / g.waits.length, 0) : null,
      users: [...g.users].sort() })).sort((a, b) => b.lines - a.lines);
  };

  const age = d => d ? Math.max(0, Math.round((new Date(today) - new Date(d)) / 86400000)) : null;
  // Forklift vs manual handling.
  const handling = [['Forklift', r => r.forklift === true], ['Manual', r => r.forklift === false], ['Not set', r => r.forklift == null]].map(([mode, f]) => {
    const all = rows.filter(f), d = all.filter(r => r.done), m = sum(d, r => r.mins), w = d.map(r => r.wait).filter(x => x != null);
    return { mode, lines: all.length, done: d.length, open: all.length - d.length, ready: all.filter(r => !r.done && r.sorted).length,
      sharePct: rows.length ? round(all.length / rows.length * 100) : null, qty: sum(d, r => r.qty), putHours: round(m / 60),
      avgMinPerLine: d.length ? round(m / d.length) : null, medianMinPerLine: round(median(d.map(r => r.mins))), qtyPerHour: perHour(sum(d, r => r.qty), m),
      avgWaitMin: w.length ? round(sum(w, x => x) / w.length, 0) : null, items: new Set(all.map(r => r.itemCode)).size,
      users: [...new Set(d.map(r => r.user).filter(Boolean))].sort() };
  }).filter(h => h.lines);
  const fk = handling.find(h => h.mode === 'Forklift'), mn = handling.find(h => h.mode === 'Manual');
  const forkliftUsers = [...users.keys()].map(u => {
    const d = done.filter(r => r.user === u && r.forklift === true);
    return { user: u || '(blank)', lines: d.length, qty: sum(d, r => r.qty), avgMinPerLine: d.length ? round(sum(d, r => r.mins) / d.length) : null };
  }).filter(x => x.lines).sort((a, b) => b.lines - a.lines);

  const backlog = open.map(r => ({ ...r, ready: r.sorted, ageDays: age(r.sorted ? r.sortDate : r.grpoDate) }))
    .sort((a, b) => (b.ready - a.ready) || (b.ageDays ?? 0) - (a.ageDays ?? 0));

  const documents = [...docs.keys()].map(k => {
    const ls = rows.filter(r => r.docEntry === k), d = ls[0], dl = ls.filter(r => r.done);
    return { docNum: d.docNum, putDate: d.putDate, grpo: d.grpo, grpoDate: d.grpoDate, vendor: d.vendor, status: STATUS[d.docStatus] || d.docStatus,
      lines: ls.length, done: dl.length, qty: sum(ls, r => r.qty), fromWhs: [...new Set(ls.map(r => r.fromWhs))].join(', '),
      toWhs: [...new Set(ls.map(r => r.toWhs))].join(', '), users: [...new Set(dl.map(r => r.user))].join(', '),
      start: hhmm(dl.length ? Math.min(...dl.map(r => r.tin)) : null), end: hhmm(dl.length ? Math.max(...dl.map(r => r.tout)) : null),
      putMinutes: sum(dl, r => r.mins), trfRef: d.trfRef };
  }).sort((a, b) => b.docNum - a.docNum);

  return {
    kpis: {
      documents: docs.size, completedDocs: docStatus('C'), inProcessDocs: docStatus('P'), openDocs: docStatus('O'),
      lines: rows.length, linesDone: done.length, linesOpen: open.length, readyToPutaway: open.filter(r => r.sorted).length,
      completionPct: rows.length ? round(done.length / rows.length * 100) : null, qtyPutAway: doneQty,
      putHours: round(totalMins / 60), avgMinPerLine: done.length ? round(totalMins / done.length) : null, medianMinPerLine: round(median(done.map(r => r.mins))),
      qtyPerHour: perHour(doneQty, totalMins), users: users.size,
      avgWaitMin: waits.length ? round(sum(waits, w => w) / waits.length, 0) : null, medianWaitMin: round(median(waits), 0),
      nextDayPct: done.length ? round(done.filter(r => r.sortDate && r.putDate > r.sortDate).length / done.length * 100) : null,
      ownSortPct: done.length ? Math.round(done.filter(r => r.sorter && r.sorter === r.user).length / done.length * 100) : null,
      storageWhs: toList.length, bins: new Set(done.map(r => r.toBin).filter(Boolean)).size,
      oldestReadyDays: backlog.find(b => b.ready)?.ageDays ?? null,
      forkliftLines: fk?.lines ?? 0, forkliftDone: fk?.done ?? 0, forkliftOpen: fk?.open ?? 0, forkliftReady: fk?.ready ?? 0,
      forkliftPct: fk?.sharePct ?? (rows.length ? 0 : null), forkliftAvgMin: fk?.avgMinPerLine ?? null, manualAvgMin: mn?.avgMinPerLine ?? null,
      forkliftItems: fk?.items ?? 0, forkliftKnown: rows.some(r => r.forklift != null),
    },
    userWise, daily, waitDist, flow, handling, forkliftUsers,
    toWhsWise: group(r => r.toWhs, () => ''),
    binWise: group(r => r.toBin, r => r.toWhs),
    itemWise: group(r => r.itemCode, r => r.itemName),
    vendorWise: group(r => r.vendor, r => r.vendorCode),
    backlog, documents,
    lines: rows.map(r => ({ ...r, timeIn: hhmm(r.tin), timeOut: hhmm(r.tout), sortOutTime: hhmm(r.sortOut) }))
      .sort((a, b) => String(b.putDate).localeCompare(String(a.putDate)) || (b.tin ?? -1) - (a.tin ?? -1)),
  };
}

export function createPutawayAnalyticsRouter(deps) {
  const { requireAuth, getActiveSap, AI_PROVIDER, gptChatComplete, azureMessagesCreate } = deps;
  const router = Router();

  async function load(req) {
    const src = { ...req.query, ...(req.body || {}) };
    const to = isYmd(src.to) ? src.to : ymd(new Date());
    let from = src.from;
    if (!isYmd(from)) { const d = new Date(to); d.setMonth(d.getMonth() - 3); from = ymd(d); }
    let raw = null, source = 'db';
    try { raw = await fetchViaDB(deps, from, to); }
    catch (e) { console.warn('[PutawayAnalytics] DB read failed, using Service Layer:', e.message); }
    if (!raw) { source = 'service-layer'; raw = await fetchViaSL(getActiveSap(), from, to); }
    const all = raw.map(normalise);
    const fl = String(src.forklift || '').toUpperCase();
    const rows = all.filter(r => (!src.user || r.user === src.user) && (!src.fromWhs || r.fromWhs === src.fromWhs) && (!src.toWhs || r.toWhs === src.toWhs)
      && (fl !== 'YES' || r.forklift === true) && (fl !== 'NO' || r.forklift === false));
    const opts = k => [...new Set(all.map(r => r[k]).filter(Boolean))].sort();
    return { from, to, source, options: { users: opts('user'), fromWhs: opts('fromWhs'), toWhs: opts('toWhs') }, ...analyse(rows) };
  }

  router.get('/data', requireAuth, async (req, res) => {
    try { res.json({ ok: true, ...(await load(req)) }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.post('/insights', requireAuth, async (req, res) => {
    try {
      const a = await load(req);
      const facts = {
        period: `${a.from} to ${a.to}`, kpis: a.kpis, users: a.userWise, waitDistribution: a.waitDist, forkliftVsManual: a.handling,
        flow: a.flow.from.flatMap((f, i) => a.flow.to.map((t, j) => ({ from: f, to: t, lines: a.flow.lines[i][j] }))).filter(x => x.lines),
        busiestDays: [...a.daily].sort((x, y) => y.lines - x.lines).slice(0, 5),
        slowestItems: a.itemWise.filter(i => i.lines >= 2).sort((x, y) => y.avgMinPerLine - x.avgMinPerLine).slice(0, 5),
        backlog: a.backlog.slice(0, 10).map(b => ({ grpo: b.grpo, item: b.itemCode, qty: b.qty, readyToPutaway: b.ready, ageDays: b.ageDays })),
      };
      const text = await callAI({ AI_PROVIDER, gptChatComplete, azureMessagesCreate }, [{ role: 'user', content: JSON.stringify(facts) }],
        'You are a warehouse operations analyst. The JSON is putaway performance from SAP: after goods receipt (GRPO) lines are sorted, ' +
        'a user moves each line from its receiving warehouse/bin to a storage warehouse/bin, recording Time IN/OUT. "wait" = minutes from the line ' +
        'being sorted to its putaway starting; forkliftVsManual compares lines whose item needs a forklift with manual lines. Write a concise markdown brief for the warehouse supervisor: 1) headline (2 sentences), ' +
        '2) user performance and workload balance, 3) flow and wait — which routes dominate, how long sorted stock waits, next-day rollovers, ' +
        '4) forklift vs manual — share, speed, forklift backlog, 5) backlog risk (lines sorted but not put away), 6) 3-5 concrete actions. Quote numbers from the JSON only; do not invent data. Under 300 words.', 900);
      res.json({ ok: true, text: text || '', available: !!text });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // AI insight for one KPI tile (the KPI detail popup). Grounded in the figures
  // the screen sent for that KPI (formula, stats, top rows); the screen falls
  // back to its rule-based insight when AI is off or returns nothing.
  router.post('/kpi-insight', requireAuth, async (req, res) => {
    try {
      const { kpi, kpis, from, to } = req.body || {};
      if (!kpi?.label) return res.status(400).json({ error: 'kpi is required' });
      const facts = JSON.stringify({ period: `${from} to ${to}`, kpi, allKpis: kpis }).slice(0, 15000);
      const text = await callAI({ AI_PROVIDER, gptChatComplete, azureMessagesCreate }, [{ role: 'user', content: facts }],
        'You are a warehouse operations analyst. The JSON describes one KPI from GRPO putaway analytics (SAP UDO STTL_PUTAWAY: after sorting, a user moves ' +
        'each GRPO line from its receiving warehouse/bin to a storage bin, recording Time IN/OUT; forklift = the item needs a forklift): its formula, summary stats ' +
        'and top rows, plus all KPIs for context. Reply in concise markdown: a bold one-line headline on what this KPI says, then "**What drives it**" ' +
        '(2-4 bullets naming specific users, items, warehouses or documents with numbers), then "**Watch out**" (1-2 bullets on risks or data caveats), ' +
        'then "**Next actions**" (2-3 bullets). Quote numbers from the JSON only; never invent data. Under 200 words.', 700);
      res.json({ ok: true, text: text || '', available: !!text });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  return router;
}
