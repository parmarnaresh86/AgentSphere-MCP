/**
 * Sorting Analytics Agent — backend controller
 * Mounted at /api/sorting-analytics by chat-server.mjs (UI: public/sorting-analytics.html)
 *
 * Read-only analytics over the SAP user-defined table @SORTING (one row per
 * GRPO line: sorter U_USER, Time IN/OUT U_TI/U_TO, U_IS sorted flag). No
 * clock-in data is used — everything comes from what is recorded in SAP:
 *  1. KPIs            — lines, qty, sort hours, completion, throughput
 *  2. Sorter-wise     — workload share, speed, first-in / last-out window
 *  3. Time patterns   — daily trend, hour-of-day × sorter activity
 *  4. Item / vendor / warehouse & bin breakdowns, open (unsorted) backlog
 *  5. AI insights     — narrative summary of the computed figures
 *
 * DB Direct (HANA / MSSQL) first, Service Layer /U_SORTING fallback.
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
  } catch (e) { console.warn('[SortAnalytics] AI call failed:', e.message); }
  return '';
}

function qcol(name, isHana) { return isHana ? `"${name}"` : name; }
const ymd = d => d.toISOString().slice(0, 10);
const isYmd = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const day = v => v ? String(v instanceof Date ? ymd(v) : v).slice(0, 10) : null;

// SAP time fields arrive as 700 / "0700" (SQL) or "07:00:00" (Service Layer) → minutes since midnight.
function toMinutes(v) {
  if (v == null || v === '') return null;
  const s = String(v).trim();
  if (s.includes(':')) { const [h, m] = s.split(':').map(Number); return h * 60 + (m || 0); }
  const n = Number(s);
  return Number.isFinite(n) ? Math.floor(n / 100) * 60 + (n % 100) : null;
}
const hhmm = m => m == null ? null : `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(Math.round(m % 60)).padStart(2, '0')}`;

// ── Read @SORTING ─────────────────────────────────────────────────────────────
const FIELDS = ['Code', 'U_GRPO', 'U_VC', 'U_VN', 'U_IN', 'U_ID', 'U_QTY', 'U_WH', 'U_BIN', 'U_IS', 'U_USER', 'U_TI', 'U_TO', 'U_DD', 'U_DDE'];

async function fetchViaDB(deps, from, to) {
  const { isConnected, ensureConnected, getActiveConfig, getActiveType, tableRef, executeSQL } = deps;
  if (!isConnected?.() && ensureConnected) { try { await ensureConnected(); } catch (e) { console.warn('[SortAnalytics] DB reconnect failed:', e.message); } }
  if (!isConnected?.()) return null;
  const cfg = getActiveConfig(), q = n => qcol(n, getActiveType() === 'hana');
  const rows = await executeSQL(`SELECT ${FIELDS.map(f => `${q(f)} AS ${q(f)}`).join(', ')} FROM ${tableRef('@SORTING', cfg)} ` +
    `WHERE ${q('U_DD')} >= '${from}' AND ${q('U_DD')} <= '${to}'`);
  return rows.slice(0, MAX_ROWS);
}

async function fetchViaSL(sap, from, to) {
  const out = [];
  while (out.length < MAX_ROWS) {
    const r = await sap.get('/U_SORTING', { $filter: `U_DD ge '${from}' and U_DD le '${to}'`, $top: 500, $skip: out.length });
    const page = r.value || [];
    out.push(...page);
    if (!page.length || !(r['odata.nextLink'] || r['@odata.nextLink'])) break;
  }
  return out;
}

function normalise(r) {
  const tin = toMinutes(r.U_TI), tout = toMinutes(r.U_TO);
  const sorted = String(r.U_IS || '').toUpperCase() === 'YES';
  const mins = sorted && tin != null && tout != null ? (tout >= tin ? tout - tin : tout + 1440 - tin) : null;
  return {
    code: r.Code, grpo: r.U_GRPO || '', vendorCode: r.U_VC || '', vendor: r.U_VN || '', itemCode: r.U_IN || '', itemName: r.U_ID || '',
    qty: Number(r.U_QTY || 0), whs: r.U_WH || '', bin: r.U_BIN || '', sorted, user: r.U_USER || '',
    tin, tout, mins, date: day(r.U_DD), due: day(r.U_DDE),
  };
}

// ── Analysis ──────────────────────────────────────────────────────────────────
const round = (n, d = 1) => n == null || !Number.isFinite(n) ? null : +n.toFixed(d);
const perHour = (qty, mins) => mins > 0 ? round(qty / (mins / 60), 1) : null;
const median = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

function analyse(rows, today = ymd(new Date())) {
  const done = rows.filter(r => r.sorted && r.mins != null);
  const open = rows.filter(r => !r.sorted);
  const sum = (a, f) => a.reduce((s, x) => s + (f(x) || 0), 0);
  const totalMins = sum(done, r => r.mins);
  const doneQty = sum(done, r => r.qty);
  const days = new Set(done.map(r => r.date));

  // Sorter-wise, incl. the working window per day (first Time IN → last Time OUT).
  const users = new Map();
  for (const r of done) {
    if (!users.has(r.user)) users.set(r.user, { user: r.user || '(blank)', lines: 0, qty: 0, mins: 0, durations: [], days: new Map(), items: new Set() });
    const u = users.get(r.user);
    u.lines++; u.qty += r.qty; u.mins += r.mins; u.durations.push(r.mins); u.items.add(r.itemCode);
    const d = u.days.get(r.date) || { first: Infinity, last: -Infinity, mins: 0 };
    d.first = Math.min(d.first, r.tin); d.last = Math.max(d.last, r.tin + r.mins); d.mins += r.mins;
    u.days.set(r.date, d);
  }
  const userWise = [...users.values()].map(u => {
    const ds = [...u.days.values()];
    const span = sum(ds, d => d.last - d.first);
    return {
      user: u.user, lines: u.lines, sharePct: done.length ? round(u.lines / done.length * 100) : 0, qty: u.qty,
      sortHours: round(u.mins / 60), avgMinPerLine: round(u.mins / u.lines), medianMinPerLine: round(median(u.durations)),
      qtyPerHour: perHour(u.qty, u.mins), daysWorked: ds.length, linesPerDay: round(u.lines / ds.length),
      avgFirstIn: hhmm(sum(ds, d => d.first) / ds.length), avgLastOut: hhmm(sum(ds, d => d.last) / ds.length),
      avgFirstInMin: round(sum(ds, d => d.first) / ds.length, 0), avgLastOutMin: round(sum(ds, d => d.last) / ds.length, 0),
      busyPct: span ? Math.min(100, Math.round(u.mins / span * 100)) : null, items: u.items.size,
    };
  }).sort((a, b) => b.lines - a.lines);

  // Daily trend.
  const byDay = new Map();
  for (const r of done) {
    const d = byDay.get(r.date) || { date: r.date, lines: 0, qty: 0, mins: 0, users: new Set() };
    d.lines++; d.qty += r.qty; d.mins += r.mins; d.users.add(r.user); byDay.set(r.date, d);
  }
  const daily = [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date))
    .map(d => ({ date: d.date, lines: d.lines, qty: d.qty, sortHours: round(d.mins / 60), sorters: d.users.size, avgMinPerLine: round(d.mins / d.lines) }));

  // Hour of day × sorter (lines started in each hour).
  const hours = []; for (let h = 5; h <= 20; h++) hours.push(h);
  const heat = userWise.map(u => ({ user: u.user, counts: hours.map(h => done.filter(r => r.user === (u.user === '(blank)' ? '' : u.user) && Math.floor(r.tin / 60) === h).length) }));
  const hourTotals = hours.map((h, i) => sum(heat, x => x.counts[i]));
  const firstHour = hourTotals.findIndex(n => n > 0), lastHour = hourTotals.length - 1 - [...hourTotals].reverse().findIndex(n => n > 0);
  const hourly = firstHour < 0 ? { hours: [], rows: [] } : {
    hours: hours.slice(firstHour, lastHour + 1),
    rows: heat.map(x => ({ user: x.user, counts: x.counts.slice(firstHour, lastHour + 1) })),
    totals: hourTotals.slice(firstHour, lastHour + 1),
  };

  const group = (key, label) => {
    const m = new Map();
    for (const r of done) {
      const k = r[key] || '(blank)';
      const g = m.get(k) || { key: k, label: label(r), lines: 0, qty: 0, mins: 0, users: new Set() };
      g.lines++; g.qty += r.qty; g.mins += r.mins; g.users.add(r.user); m.set(k, g);
    }
    return [...m.values()].map(g => ({ key: g.key, label: g.label, lines: g.lines, qty: g.qty, sortHours: round(g.mins / 60),
      avgMinPerLine: round(g.mins / g.lines), secPerUnit: g.qty ? round(g.mins * 60 / g.qty) : null, sorters: [...g.users].sort() }))
      .sort((a, b) => b.sortHours - a.sortHours || b.lines - a.lines);
  };

  const age = d => d ? Math.max(0, Math.round((new Date(today) - new Date(d)) / 86400000)) : null;
  const backlog = open.map(r => ({ ...r, ageDays: age(r.date) })).sort((a, b) => (b.ageDays ?? 0) - (a.ageDays ?? 0));

  return {
    kpis: {
      lines: rows.length, sortedLines: done.length, openLines: open.length,
      completionPct: rows.length ? round(done.length / rows.length * 100) : null,
      qtySorted: doneQty, sortHours: round(totalMins / 60), avgMinPerLine: done.length ? round(totalMins / done.length) : null,
      medianMinPerLine: round(median(done.map(r => r.mins))), qtyPerHour: perHour(doneQty, totalMins),
      sorters: users.size, sortingDays: days.size, linesPerDay: days.size ? round(done.length / days.size) : null,
      grpos: new Set(rows.map(r => r.grpo)).size, items: new Set(rows.map(r => r.itemCode)).size,
      oldestOpenDays: backlog[0]?.ageDays ?? null, openQty: sum(open, r => r.qty),
    },
    userWise, daily, hourly,
    itemWise: group('itemCode', r => r.itemName),
    vendorWise: group('vendor', r => r.vendorCode),
    warehouseWise: group('whs', () => ''),
    binWise: group('bin', r => r.whs),
    backlog,
    lines: rows.map(r => ({ ...r, timeIn: hhmm(r.tin), timeOut: hhmm(r.tout) }))
      .sort((a, b) => String(b.date).localeCompare(String(a.date)) || (b.tin ?? -1) - (a.tin ?? -1)),
  };
}

export function createSortingAnalyticsRouter(deps) {
  const { requireAuth, getActiveSap, AI_PROVIDER, gptChatComplete, azureMessagesCreate } = deps;
  const router = Router();

  async function load(req) {
    const to = isYmd(req.query.to ?? req.body?.to) ? (req.query.to ?? req.body.to) : ymd(new Date());
    let from = req.query.from ?? req.body?.from;
    if (!isYmd(from)) { const d = new Date(to); d.setMonth(d.getMonth() - 3); from = ymd(d); }
    let raw = null, source = 'db';
    try { raw = await fetchViaDB(deps, from, to); }
    catch (e) { console.warn('[SortAnalytics] DB read failed, using Service Layer:', e.message); }
    if (!raw) { source = 'service-layer'; raw = await fetchViaSL(getActiveSap(), from, to); }
    const all = raw.map(normalise);
    const f = { user: req.query.user ?? req.body?.user, vendor: req.query.vendor ?? req.body?.vendor, whs: req.query.whs ?? req.body?.whs };
    const rows = all.filter(r => (!f.user || r.user === f.user) && (!f.vendor || r.vendor === f.vendor) && (!f.whs || r.whs === f.whs));
    const options = {
      users: [...new Set(all.map(r => r.user).filter(Boolean))].sort(),
      vendors: [...new Set(all.map(r => r.vendor).filter(Boolean))].sort(),
      warehouses: [...new Set(all.map(r => r.whs).filter(Boolean))].sort(),
    };
    return { from, to, source, filters: f, options, ...analyse(rows) };
  }

  router.get('/data', requireAuth, async (req, res) => {
    try { res.json({ ok: true, ...(await load(req)) }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Narrative read-out of the same figures the screen shows.
  router.post('/insights', requireAuth, async (req, res) => {
    try {
      const a = await load(req);
      const facts = {
        period: `${a.from} to ${a.to}`, kpis: a.kpis,
        sorters: a.userWise.map(({ avgFirstInMin, avgLastOutMin, ...u }) => u),
        busiestDays: [...a.daily].sort((x, y) => y.lines - x.lines).slice(0, 5),
        slowestItems: a.itemWise.filter(i => i.lines >= 2).sort((x, y) => y.avgMinPerLine - x.avgMinPerLine).slice(0, 5),
        topVendorsByEffort: a.vendorWise.slice(0, 5),
        hourly: a.hourly,
        openBacklog: a.backlog.slice(0, 10).map(b => ({ grpo: b.grpo, item: b.itemCode, qty: b.qty, ageDays: b.ageDays })),
      };
      const text = await callAI({ AI_PROVIDER, gptChatComplete, azureMessagesCreate }, [{ role: 'user', content: JSON.stringify(facts) }],
        'You are a warehouse operations analyst. The JSON is goods-receipt (GRPO) sorting performance from SAP: one line per GRPO line, ' +
        'sorted by a named sorter between Time IN and Time OUT. Write a concise markdown brief for the warehouse supervisor: ' +
        '1) headline (2 sentences), 2) sorter performance — who carries the load, who is fastest/slowest per line and per unit, shift-window pattern, ' +
        '3) bottlenecks — slow items/vendors, busy days, hour-of-day peaks, 4) open backlog risk, 5) 3-5 concrete actions (staffing by hour, assignment balance). ' +
        'Quote numbers from the JSON only; do not invent data. Keep it under 300 words.', 900);
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
        'You are a warehouse operations analyst. The JSON describes one KPI from GRPO sorting analytics (SAP @SORTING: one line per GRPO line, ' +
        'sorted by a named sorter between Time IN and Time OUT): its formula, summary stats and top rows, plus all KPIs for context. ' +
        'Reply in concise markdown: a bold one-line headline on what this KPI says, then "**What drives it**" (2-4 bullets naming specific sorters, items, vendors or GRPOs with numbers), ' +
        'then "**Watch out**" (1-2 bullets on risks or data caveats), then "**Next actions**" (2-3 bullets). Quote numbers from the JSON only; never invent data. Under 200 words.', 700);
      res.json({ ok: true, text: text || '', available: !!text });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  return router;
}
