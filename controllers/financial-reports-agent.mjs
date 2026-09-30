/**
 * Financial Reports Agents — Balance Sheet, Profit & Loss and Trial Balance
 * dashboards built on SAP B1's standard HANA calculation views (semantic
 * layer package sap.{company}.fin.*), queried directly over DB Direct.
 * Mounted at /api/fin-reports by chat-server.mjs; UI is the #fin-reports-panel in public/index.html.
 *
 *   GET  /periods                      — posting periods (OFPR) + default period
 *   GET  /balance-sheet?period=CODE    — Balance Sheet Agent
 *   GET  /profit-loss?period=CODE      — Profit & Loss Agent (period, YTD, LY, 12-month trend)
 *   GET  /trial-balance?from=CODE&to=CODE — Trial Balance Agent
 *   POST /insight { report, params }   — AI narrative for a report
 *   POST /chat    { report, params, question, history } — grounded Q&A
 *
 * Calculation views used (all standard, all verified to reconcile to JDT1):
 *   fin.fi/BalanceSheetQuery            (P_FinancialPeriod, P_AddVoucher)
 *   fin.fi/BalanceSheetComparisonQuery  (P_FinancialPeriod) — same period last year
 *   fin.mgmt/GLAccountPeriodAmountQuery — net posting amount per account per period
 *   fin.mgmt/GLAccountPeriodBalanceQuery (P_AddVoucher) — opening/closing per account per period
 *
 * fin.fi/ProfitAndLossQuery is deliberately NOT used: it only returns accounts
 * that have postings in the selected period (so its YTD column omits every
 * account that was idle that month) and it also returns balance-sheet
 * accounts. P&L is built from GLAccountPeriodAmountQuery instead, classified
 * by the chart of accounts drawer (OACT.GroupMask).
 *
 * On MSSQL (no calc views), or if a view is missing/invalidated, the same
 * figures are computed from JDT1 so the dashboards still work; every response
 * says which source was used.
 */
import { Router } from 'express';
import { executeSQL, isConnected, getActiveType, getActiveConfig, tableRef, getCompanyCurrency } from '../db-connector.mjs';
import { callAI } from '../analytics-v2.mjs';

// OACT.GroupMask → drawer. sign converts the debit-positive GL balance into
// the natural display sign (credit-nature drawers shown positive).
const DRAWERS = {
  1:  { key: 'assets',      label: 'Assets',                      stmt: 'BS', sign: 1 },
  2:  { key: 'liabilities', label: 'Liabilities',                 stmt: 'BS', sign: -1 },
  3:  { key: 'equity',      label: 'Equity',                      stmt: 'BS', sign: -1 },
  4:  { key: 'revenue',     label: 'Revenues',                    stmt: 'PL', sign: -1 },
  5:  { key: 'cogs',        label: 'Cost of Sales',               stmt: 'PL', sign: 1 },
  6:  { key: 'expenses',    label: 'Expenses',                    stmt: 'PL', sign: 1 },
  7:  { key: 'financing',   label: 'Financing',                   stmt: 'PL', sign: 1 },
  8:  { key: 'other',       label: 'Other Revenues and Expenses', stmt: 'PL', sign: 1 },
  9:  { key: 'other9',      label: 'Other (Drawer 9)',            stmt: 'PL', sign: 1 },
  10: { key: 'other10',     label: 'Other (Drawer 10)',           stmt: 'PL', sign: 1 },
};
const drawerOf = (g) => DRAWERS[g] || DRAWERS[8];
// Drawer title as named in this company's chart of accounts (level-1 account).
const drawerName = (chart, g) => [...chart.values()].find(a => a.level === 1 && a.group === g)?.name || drawerOf(g).label;

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const r2 = (n) => Math.round(n * 100) / 100;
const isoDate = (v) => {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
};
const shiftYear = (iso, by) => `${Number(iso.slice(0, 4)) + by}${iso.slice(4)}`;

// ── Per-company caches ───────────────────────────────────────────────────────
const _pkgCache = new Map();    // db → 'sap.xxx' | null
const _chartCache = new Map();  // db → { at, chart }
const _periodCache = new Map(); // db → { at, periods }
const _reportCache = new Map(); // db|report|params → { at, data }
const META_TTL = 10 * 60 * 1000;
const REPORT_TTL = 2 * 60 * 1000;
const dbKey = () => { const c = getActiveConfig(); return `${getActiveType()}::${c?.database || c?.schema_name || ''}`; };

// ── Source layer ─────────────────────────────────────────────────────────────
// Semantic-layer package for the active company, e.g. STTL_SD → sap.sttlsd.
// SAP derives it from the schema name (lower-case, non-alphanumerics dropped);
// verified against _SYS_REPO so a mismatch falls back to JDT1 instead of
// querying another company's views. FIN_HANA_PACKAGE overrides detection.
async function hanaPackage() {
  if (getActiveType() !== 'hana') return null;
  const key = dbKey();
  if (_pkgCache.has(key)) return _pkgCache.get(key);
  const cfg = getActiveConfig();
  const candidates = [process.env.FIN_HANA_PACKAGE, cfg?.database, cfg?.schema_name]
    .filter(Boolean)
    .map(s => s.startsWith('sap.') ? s : `sap.${String(s).toLowerCase().replace(/[^a-z0-9]/g, '')}`);
  let pkg = null;
  for (const c of [...new Set(candidates)]) {
    try {
      const rows = await executeSQL(`SELECT COUNT(*) AS "N" FROM "_SYS_REPO"."ACTIVE_OBJECT" WHERE "PACKAGE_ID" = '${c.replace(/'/g, "''")}.fin.fi' AND "OBJECT_NAME" = 'BalanceSheetQuery'`);
      if (num(rows[0]?.N) > 0) { pkg = c; break; }
    } catch { /* no _SYS_REPO access — try next / fall back */ }
  }
  _pkgCache.set(key, pkg);
  if (!pkg) console.warn(`[FinReports] No SAP B1 semantic-layer package found for ${key} — using JDT1 fallback`);
  return pkg;
}

const calcView = (pkg, sub, name, params = {}) => {
  const ph = Object.entries(params).map(([k, v]) => `'PLACEHOLDER' = ('$$${k}$$', '${String(v).replace(/'/g, "''")}')`);
  return `"_SYS_BIC"."${pkg}.${sub}/${name}"${ph.length ? `(${ph.join(', ')})` : ''}`;
};

async function loadChart() {
  const key = dbKey();
  const hit = _chartCache.get(key);
  if (hit && Date.now() - hit.at < META_TTL) return hit.chart;
  const rows = await executeSQL(`SELECT "AcctCode", "AcctName", "FormatCode", "GroupMask", "Levels", "FatherNum", "Postable" FROM ${tableRef('OACT', getActiveConfig())}`);
  const chart = new Map();
  for (const r of rows) {
    chart.set(r.AcctCode, {
      code: r.AcctCode, name: r.AcctName, fmt: r.FormatCode || r.AcctCode,
      group: num(r.GroupMask), level: num(r.Levels), father: r.FatherNum || null, postable: r.Postable === 'Y',
    });
  }
  _chartCache.set(key, { at: Date.now(), chart });
  return chart;
}

// Name of the account's ancestor at `level` (level-2 = the statement group,
// e.g. "Current Assets"). Falls back to the account itself for shallow trees.
function ancestorAt(chart, code, level) {
  let a = chart.get(code), guard = 0;
  while (a && a.level > level && a.father && guard++ < 12) a = chart.get(a.father) || null;
  return a && a.level === level ? a : null;
}

async function loadPeriods() {
  const key = dbKey();
  const hit = _periodCache.get(key);
  if (hit && Date.now() - hit.at < META_TTL) return hit.periods;
  const rows = await executeSQL(`SELECT "AbsEntry", "Code", "Name", "Category", "F_RefDate", "T_RefDate", "PeriodStat" FROM ${tableRef('OFPR', getActiveConfig())} ORDER BY "F_RefDate"`);
  const periods = rows.map(r => ({
    abs: num(r.AbsEntry), code: r.Code, name: r.Name || r.Code, fy: r.Category || '',
    from: isoDate(r.F_RefDate), to: isoDate(r.T_RefDate), status: r.PeriodStat,
  }));
  _periodCache.set(key, { at: Date.now(), periods });
  return periods;
}

function findPeriod(periods, code) {
  const p = periods.find(x => x.code === code);
  if (!p) { const e = new Error(`Unknown posting period "${code}"`); e.status = 400; throw e; }
  return p;
}
// Period one year earlier (matched on start date), for comparisons.
const lastYearOf = (periods, p) => periods.find(x => x.from === shiftYear(p.from, -1)) || null;
// Fiscal-year-to-date periods ending at p (same OFPR Category).
const fytdOf = (periods, p) => periods.filter(x => x.fy === p.fy && x.from <= p.from);

// JDT1 helpers (fallback path) — debit-positive balances per account.
async function jdtBalances(whereDate) {
  const jdt1 = tableRef('JDT1', getActiveConfig());
  const rows = await executeSQL(`SELECT "Account" AS "A", SUM("Debit" - "Credit") AS "B" FROM ${jdt1} WHERE ${whereDate} GROUP BY "Account"`);
  return new Map(rows.map(r => [r.A, num(r.B)]));
}

// ── Date-range mode ──────────────────────────────────────────────────────────
// Reports accept either posting periods or an explicit From/To date. A date
// that sits on a posting-period boundary is served from the calc views; a
// date inside a period is computed from JDT1 so it is exact to the day.
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const isValidDate = (s) => {
  if (!ISO_DATE.test(s || '')) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s; // rejects 2026-02-30, 2026-13-01
};
const badRequest = (msg) => { const e = new Error(msg); e.status = 400; return e; };
function parseRange(fromDate, toDate) {
  if (!isValidDate(fromDate) || !isValidDate(toDate)) throw badRequest('From date and To date must be valid dates (YYYY-MM-DD).');
  if (fromDate > toDate) throw badRequest('From date must be on or before To date.');
  return { from: fromDate, to: toDate };
}
// Same calendar date one year earlier (29 Feb → 28 Feb).
function yearEarlier(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const last = new Date(Date.UTC(y - 1, m, 0)).getUTCDate();
  return `${y - 1}-${String(m).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
}
const rangePeriod = (from, to) => ({ code: `${from}_${to}`, name: from === to ? from : `${from} to ${to}`, fy: '', from, to });
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MAX_RANGE_MONTHS = 60;

// Buckets for a P&L date range: the posting periods themselves when the range
// is exactly whole periods (so the calc view can be used), otherwise calendar
// months clipped to the range (read from JDT1). `tag` keeps current-year and
// last-year pseudo buckets from colliding.
function rangeBuckets(periods, pkg, from, to, tag) {
  const covered = periods.filter(p => p.from >= from && p.to <= to);
  const aligned = covered.length && covered[0].from === from && covered[covered.length - 1].to === to
    && covered.every((p, i) => i === 0 || p.from > covered[i - 1].to);
  if (aligned) {
    if (covered.length > MAX_RANGE_MONTHS) throw badRequest(`Date range can span at most ${MAX_RANGE_MONTHS} months.`);
    return { buckets: covered, pkg };
  }
  const buckets = [];
  let [y, m] = from.split('-').map(Number);
  for (let guard = 0; guard <= MAX_RANGE_MONTHS; guard++) {
    const ms = `${y}-${String(m).padStart(2, '0')}-01`;
    if (ms > to) break;
    const me = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
    const bf = ms < from ? from : ms, bt = me > to ? to : me;
    buckets.push({ code: `${tag}:${bf}`, name: `${MONTHS[m - 1]} ${y}`, fy: '', from: bf, to: bt });
    if (++m > 12) { m = 1; y++; }
  }
  if (buckets.length > MAX_RANGE_MONTHS) throw badRequest(`Date range can span at most ${MAX_RANGE_MONTHS} months.`);
  return { buckets, pkg: null };
}

// Debit-positive balance per account before a date ('open') or at the end of
// a date ('close'). Uses GLAccountPeriodBalanceQuery when a posting period
// starts ('open') / ends ('close') on that date, otherwise JDT1.
async function balanceAt(pkg, periods, date, kind) {
  const p = kind === 'open' ? periods.find(x => x.from === date) : periods.find(x => x.to === date);
  if (pkg && p) {
    try {
      const col = kind === 'open' ? 'OpeningBalanceLC' : 'ClosingBalanceLC';
      const rows = await executeSQL(`SELECT "AccountCode", "SegmentationAccountCode", SUM("${col}") AS "B" FROM ${calcView(pkg, 'fin.mgmt', 'GLAccountPeriodBalanceQuery', { P_AddVoucher: 'N' })} WHERE "FinancialPeriodCode" = '${p.code.replace(/'/g, "''")}' GROUP BY "AccountCode", "SegmentationAccountCode"`);
      const seg = new Map();
      const map = new Map();
      for (const r of rows) { map.set(r.AccountCode, (map.get(r.AccountCode) || 0) + num(r.B)); if (r.SegmentationAccountCode) seg.set(r.AccountCode, r.SegmentationAccountCode); }
      return { map, seg, source: 'hana', view: 'fin.mgmt/GLAccountPeriodBalanceQuery' };
    } catch (e) { console.warn('[FinReports] GLAccountPeriodBalanceQuery failed, using JDT1:', e.message); }
  }
  const map = await jdtBalances(kind === 'open' ? `"RefDate" < '${date}'` : `"RefDate" <= '${date}'`);
  return { map, seg: new Map(), source: 'jdt1', view: 'JDT1' };
}
// 'hana' when every part came from calc views, 'mixed' when some dates fell
// inside a period (JDT1), 'jdt1' when none did.
function mergeSources(parts) {
  const srcs = parts.map(p => p.source);
  return {
    source: srcs.every(s => s === 'hana') ? 'hana' : srcs.some(s => s === 'hana') ? 'mixed' : 'jdt1',
    views: [...new Set(parts.flatMap(p => p.views || [p.view]))],
  };
}

// Net amount per account per period → Map(periodCode → Map(acct → amount)).
// excludeClosing drops SAP period-end closing entries (JDT1.TransType -3, the
// year-end transfer of P&L into retained earnings) — required for a P&L, where
// they would otherwise wipe out December's revenue and costs. The calc view
// has no transaction-type column, so on the HANA path those postings are
// read from JDT1 and netted off the view's amounts.
const CLOSING_TRANS_TYPE = '-3';
async function periodAmounts(pkg, periodList, { excludeClosing = false } = {}) {
  const out = new Map(periodList.map(p => [p.code, new Map()]));
  if (!periodList.length) return { out, source: pkg ? 'hana' : 'jdt1' };
  const jdt1 = tableRef('JDT1', getActiveConfig());
  const cases = periodList.map(p => `WHEN "RefDate" BETWEEN '${p.from}' AND '${p.to}' THEN '${p.code.replace(/'/g, "''")}'`).join(' ');
  const minD = periodList.reduce((m, p) => p.from < m ? p.from : m, periodList[0].from);
  const maxD = periodList.reduce((m, p) => p.to > m ? p.to : m, periodList[0].to);
  const jdtByPeriod = (extraWhere) => executeSQL(`SELECT "Account" AS "A", CASE ${cases} END AS "P", SUM("Debit" - "Credit") AS "B" FROM ${jdt1} WHERE "RefDate" BETWEEN '${minD}' AND '${maxD}'${extraWhere} GROUP BY "Account", CASE ${cases} END`);

  if (pkg) {
    try {
      const inList = periodList.map(p => `'${p.code.replace(/'/g, "''")}'`).join(',');
      const [rows, closing] = await Promise.all([
        executeSQL(`SELECT "AccountCode", "FinancialPeriodCode", SUM("AmountLC") AS "Amt" FROM ${calcView(pkg, 'fin.mgmt', 'GLAccountPeriodAmountQuery')} WHERE "FinancialPeriodCode" IN (${inList}) GROUP BY "AccountCode", "FinancialPeriodCode"`),
        excludeClosing ? jdtByPeriod(` AND "TransType" = '${CLOSING_TRANS_TYPE}'`) : Promise.resolve([]),
      ]);
      for (const r of rows) out.get(r.FinancialPeriodCode)?.set(r.AccountCode, num(r.Amt));
      for (const r of closing) { const m = r.P && out.get(r.P); if (m) m.set(r.A, (m.get(r.A) || 0) - num(r.B)); }
      return { out, source: 'hana', views: ['fin.mgmt/GLAccountPeriodAmountQuery'] };
    } catch (e) {
      console.warn('[FinReports] GLAccountPeriodAmountQuery failed, using JDT1:', e.message);
    }
  }
  const rows = await jdtByPeriod(excludeClosing ? ` AND "TransType" <> '${CLOSING_TRANS_TYPE}'` : '');
  for (const r of rows) if (r.P) out.get(r.P)?.set(r.A, num(r.B));
  return { out, source: 'jdt1', views: ['JDT1'] };
}

async function withCurrency(obj) {
  try { const c = await getCompanyCurrency(); obj.currency = { code: c.code, symbol: c.symbol }; } catch { obj.currency = { code: '', symbol: '' }; }
  return obj;
}

// ── Balance Sheet Agent ──────────────────────────────────────────────────────
// Period mode: as at period end, change vs FY opening, comparison = same
// period last year. Range mode: as at To date, change vs the balance at the
// start of From date, comparison = To date one year earlier.
async function buildBalanceSheet(periodCode, range = null) {
  const [periods, chart, pkg] = await Promise.all([loadPeriods(), loadChart(), hanaPackage()]);
  let p, ly, fyFirst;
  if (range) {
    p = rangePeriod(range.from, range.to);
    const lyTo = yearEarlier(range.to);
    ly = { code: `ly_${lyTo}`, name: lyTo, fy: '', from: lyTo, to: lyTo };
    fyFirst = { code: range.from, name: range.from, fy: '', from: range.from, to: range.from };
  } else {
    p = findPeriod(periods, periodCode);
    ly = lastYearOf(periods, p);
    fyFirst = periods.find(x => x.fy === p.fy) || p;
  }

  // acct → { open (FY opening / From-date opening), close, ly }
  const bal = new Map();
  const get = (a) => { if (!bal.has(a)) bal.set(a, { open: 0, close: 0, ly: null }); return bal.get(a); };
  const segCode = new Map();
  let source = 'jdt1', views = ['JDT1'];

  let hanaOk = false;
  if (range) {
    const [o, c, l] = await Promise.all([
      balanceAt(pkg, periods, range.from, 'open'), balanceAt(pkg, periods, range.to, 'close'), balanceAt(pkg, periods, ly.to, 'close'),
    ]);
    for (const [a, v] of o.map) { const d = drawerOf(chart.get(a)?.group); if (d.stmt === 'BS') get(a).open = v; }
    for (const [a, v] of c.map) get(a).close = v;
    for (const [a, v] of l.map) get(a).ly = v;
    for (const part of [c, o]) part.seg.forEach((v, k) => segCode.set(k, v));
    ({ source, views } = mergeSources([o, c, l]));
    hanaOk = true;
  } else if (pkg) {
    try {
      const rows = await executeSQL(`SELECT "AccountCode", "SegmentationAccountCode", "FiscalYearOpeningBalanceLC", "FinancialPeriodClosingBalanceLC" FROM ${calcView(pkg, 'fin.fi', 'BalanceSheetQuery', { P_FinancialPeriod: p.code, P_AddVoucher: 'N' })}`);
      for (const r of rows) {
        const b = get(r.AccountCode);
        b.open += num(r.FiscalYearOpeningBalanceLC); b.close += num(r.FinancialPeriodClosingBalanceLC);
        if (r.SegmentationAccountCode) segCode.set(r.AccountCode, r.SegmentationAccountCode);
      }
      hanaOk = true; source = 'hana'; views = ['fin.fi/BalanceSheetQuery'];
      if (ly) {
        try {
          const lyRows = await executeSQL(`SELECT "AccountCode", SUM("SamePeriodLastYearClosingBalanceLC") AS "LY" FROM ${calcView(pkg, 'fin.fi', 'BalanceSheetComparisonQuery', { P_FinancialPeriod: p.code })} GROUP BY "AccountCode"`);
          for (const r of lyRows) get(r.AccountCode).ly = num(r.LY);
          views.push('fin.fi/BalanceSheetComparisonQuery');
        } catch (e) { console.warn('[FinReports] BalanceSheetComparisonQuery failed:', e.message); }
      }
    } catch (e) {
      console.warn('[FinReports] BalanceSheetQuery failed, using JDT1:', e.message);
    }
  }
  if (!hanaOk) {
    const [close, open, lyB] = await Promise.all([
      jdtBalances(`"RefDate" <= '${p.to}'`),
      jdtBalances(`"RefDate" < '${fyFirst.from}'`),
      ly ? jdtBalances(`"RefDate" <= '${ly.to}'`) : Promise.resolve(null),
    ]);
    for (const [a, v] of close) get(a).close = v;
    for (const [a, v] of open) { const d = drawerOf(chart.get(a)?.group); if (d.stmt === 'BS') get(a).open = v; }
    if (lyB) for (const [a, v] of lyB) get(a).ly = v;
  }

  // Assemble: BS drawers grouped by level-2 title; P&L drawers collapse into
  // a single "current earnings" line so the statement balances.
  const sections = { assets: null, liabilities: null, equity: null };
  const mk = (g) => ({ key: DRAWERS[g].key, label: drawerName(chart, g), groups: new Map(), open: 0, close: 0, ly: 0 });
  sections.assets = mk(1); sections.liabilities = mk(2); sections.equity = mk(3);
  const earnings = { open: 0, close: 0, ly: 0 };
  let hasLy = false;
  for (const [code, b] of bal) {
    const a = chart.get(code);
    const d = drawerOf(a?.group);
    const lyRaw = b.ly;
    if (lyRaw !== null) hasLy = true;
    if (d.stmt === 'PL') {
      earnings.close += -b.close; earnings.ly += -(lyRaw || 0);
      continue;
    }
    const sec = sections[d.key];
    const g2 = ancestorAt(chart, code, 2);
    const gk = g2?.code || '_';
    if (!sec.groups.has(gk)) sec.groups.set(gk, { code: gk, label: g2?.name || sec.label, open: 0, close: 0, ly: 0, accounts: [] });
    const grp = sec.groups.get(gk);
    const v = { open: d.sign * b.open, close: d.sign * b.close, ly: lyRaw === null ? null : d.sign * lyRaw };
    if (Math.abs(v.open) < 0.005 && Math.abs(v.close) < 0.005 && !v.ly) continue;
    grp.accounts.push({ code, disp: segCode.get(code) || a?.fmt || code, name: a?.name || code, ...v, change: v.close - v.open });
    grp.open += v.open; grp.close += v.close; grp.ly += v.ly || 0;
    sec.open += v.open; sec.close += v.close; sec.ly += v.ly || 0;
  }
  // FY opening of the earnings line = retained P&L not yet closed at FY start.
  earnings.open = sections.assets.open - sections.liabilities.open - sections.equity.open;

  const out = Object.values(sections).map(s => ({
    ...s, groups: [...s.groups.values()].map(g => ({ ...g, change: g.close - g.open, accounts: g.accounts.sort((x, y) => Math.abs(y.close) - Math.abs(x.close)) }))
      .filter(g => g.accounts.length).sort((x, y) => Math.abs(y.close) - Math.abs(x.close)),
    change: s.close - s.open,
  }));
  const [assets, liabilities, equity] = out;
  const totalLE = liabilities.close + equity.close + earnings.close;
  const lyLE = liabilities.ly + equity.ly + earnings.ly;

  return withCurrency({
    agent: 'Balance Sheet Agent', report: 'bs', mode: range ? 'range' : 'period', source, views, generatedAt: new Date().toISOString(),
    period: p, lastYearPeriod: hasLy ? ly : null, fyStart: fyFirst,
    openLabel: range ? `Opening ${range.from}` : 'FY opening',
    sections: out,
    earnings: { label: 'Current earnings (P&L not yet closed to equity)', ...earnings, change: earnings.close - earnings.open },
    totals: {
      assets: assets.close, liabilities: liabilities.close, equity: equity.close + earnings.close,
      liabilitiesAndEquity: totalLE, difference: r2(assets.close - totalLE),
      assetsOpen: assets.open, assetsLy: hasLy ? assets.ly : null, liabilitiesAndEquityLy: hasLy ? lyLE : null,
      debtToEquity: (equity.close + earnings.close) ? liabilities.close / (equity.close + earnings.close) : null,
      equityRatio: assets.close ? (equity.close + earnings.close) / assets.close : null,
    },
  });
}

// ── Profit & Loss Agent ──────────────────────────────────────────────────────
// Each column is a list of buckets summed per account. Period mode: period =
// [p], ytd = fiscal YTD, trend = last 12 periods. Range mode: period and ytd
// are both the selected range, ly = the same range a year earlier, trend =
// the range's buckets.
async function buildProfitLoss(periodCode, range = null) {
  const [periods, chart, pkg] = await Promise.all([loadPeriods(), loadChart(), hanaPackage()]);
  let p, ly, fytdFrom, cols, trendPeriods, amounts, source, views;
  if (range) {
    const lyR = { from: yearEarlier(range.from), to: yearEarlier(range.to) };
    const cur = rangeBuckets(periods, pkg, range.from, range.to, 'C');
    const prev = rangeBuckets(periods, pkg, lyR.from, lyR.to, 'L');
    const [a1, a2] = await Promise.all([
      periodAmounts(cur.pkg, cur.buckets, { excludeClosing: true }),
      periodAmounts(prev.pkg, prev.buckets, { excludeClosing: true }),
    ]);
    amounts = new Map([...a1.out, ...a2.out]);
    ({ source, views } = mergeSources([a1, a2]));
    p = rangePeriod(range.from, range.to); ly = rangePeriod(lyR.from, lyR.to); fytdFrom = p;
    cols = { period: cur.buckets, ytd: cur.buckets, lyPeriod: prev.buckets, lyYtd: prev.buckets };
    trendPeriods = cur.buckets;
  } else {
    p = findPeriod(periods, periodCode);
    const idx = periods.indexOf(p);
    trendPeriods = periods.slice(Math.max(0, idx - 11), idx + 1);
    const fytd = fytdOf(periods, p);
    ly = lastYearOf(periods, p);
    const lyFytd = ly ? fytdOf(periods, ly) : [];
    const need = new Map([...trendPeriods, ...fytd, ...(ly ? [ly] : []), ...lyFytd].map(x => [x.code, x]));
    ({ out: amounts, source, views } = await periodAmounts(pkg, [...need.values()], { excludeClosing: true }));
    fytdFrom = fytd[0] || p;
    cols = { period: [p], ytd: fytd, lyPeriod: ly ? [ly] : null, lyYtd: ly ? lyFytd : null };
  }

  const sumOver = (list, acct) => list.reduce((s, x) => s + (amounts.get(x.code)?.get(acct) || 0), 0);
  const accts = new Set();
  for (const m of amounts.values()) for (const a of m.keys()) if (drawerOf(chart.get(a)?.group).stmt === 'PL') accts.add(a);

  const secMap = new Map();
  for (const code of accts) {
    const a = chart.get(code); const g = a?.group || 8; const d = drawerOf(g);
    const v = {
      period: d.sign * sumOver(cols.period, code),
      ytd: d.sign * sumOver(cols.ytd, code),
      lyPeriod: cols.lyPeriod ? d.sign * sumOver(cols.lyPeriod, code) : null,
      lyYtd: cols.lyYtd ? d.sign * sumOver(cols.lyYtd, code) : null,
    };
    if (![v.period, v.ytd, v.lyPeriod || 0, v.lyYtd || 0].some(x => Math.abs(x) >= 0.005)) continue;
    if (!secMap.has(d.key)) secMap.set(d.key, { key: d.key, group: g, label: drawerName(chart, g), sign: d.sign, groups: new Map(), period: 0, ytd: 0, lyPeriod: 0, lyYtd: 0 });
    const sec = secMap.get(d.key);
    const g2 = ancestorAt(chart, code, 2); const gk = g2?.code || '_';
    if (!sec.groups.has(gk)) sec.groups.set(gk, { code: gk, label: g2?.name || sec.label, period: 0, ytd: 0, lyPeriod: 0, lyYtd: 0, accounts: [] });
    const grp = sec.groups.get(gk);
    grp.accounts.push({ code, disp: a?.fmt || code, name: a?.name || code, ...v });
    for (const k of ['period', 'ytd', 'lyPeriod', 'lyYtd']) { grp[k] += v[k] || 0; sec[k] += v[k] || 0; }
  }
  const sections = [...secMap.values()].sort((x, y) => x.group - y.group).map(s => ({
    ...s, groups: [...s.groups.values()].map(g => ({ ...g, accounts: g.accounts.sort((x, y) => Math.abs(y.ytd) - Math.abs(x.ytd)) }))
      .sort((x, y) => Math.abs(y.ytd) - Math.abs(x.ytd)),
  }));

  // Headline lines. Display signs: revenue positive, costs positive; other
  // drawers are net debits (positive = net expense).
  const line = (col) => {
    const by = (k) => sections.find(s => s.key === k)?.[col] || 0;
    const revenue = by('revenue'), cogs = by('cogs'), opex = by('expenses');
    const other = sections.filter(s => !['revenue', 'cogs', 'expenses'].includes(s.key)).reduce((t, s) => t + (s[col] || 0), 0);
    const gross = revenue - cogs, operating = gross - opex, net = operating - other;
    return { revenue, cogs, grossProfit: gross, opex, operatingProfit: operating, otherNet: other, netProfit: net,
      grossMargin: revenue ? gross / revenue * 100 : null, netMargin: revenue ? net / revenue * 100 : null };
  };

  const trend = trendPeriods.map(tp => {
    let revenue = 0, cogs = 0, opex = 0, other = 0;
    for (const [acct, amt] of amounts.get(tp.code) || []) {
      const d = drawerOf(chart.get(acct)?.group);
      if (d.stmt !== 'PL') continue;
      const v = d.sign * amt;
      if (d.key === 'revenue') revenue += v; else if (d.key === 'cogs') cogs += v; else if (d.key === 'expenses') opex += v; else other += v;
    }
    return { code: tp.code, name: tp.name, from: tp.from, revenue, cogs, opex, other, grossProfit: revenue - cogs, netProfit: revenue - cogs - opex - other };
  });

  return withCurrency({
    agent: 'Profit & Loss Agent', report: 'pl', mode: range ? 'range' : 'period', source, views, generatedAt: new Date().toISOString(),
    period: p, lastYearPeriod: ly, fytdFrom,
    sections, trend,
    summary: { period: line('period'), ytd: line('ytd'), lyPeriod: ly ? line('lyPeriod') : null, lyYtd: ly ? line('lyYtd') : null },
  });
}

// ── Trial Balance Agent ──────────────────────────────────────────────────────
// Opening = balance before the first day, closing = balance at the end of the
// last day. Period mode is just a range on period boundaries, so it is always
// served by GLAccountPeriodBalanceQuery; mid-period dates fall back to JDT1.
async function buildTrialBalance(fromCode, toCode, range = null) {
  const [periods, chart, pkg] = await Promise.all([loadPeriods(), loadChart(), hanaPackage()]);
  let pf, pt;
  if (range) {
    pf = { code: range.from, name: range.from, fy: '', from: range.from, to: range.from };
    pt = { code: range.to, name: range.to, fy: '', from: range.to, to: range.to };
  } else {
    pf = findPeriod(periods, fromCode); pt = findPeriod(periods, toCode);
    if (pf.from > pt.from) [pf, pt] = [pt, pf];
  }

  const [o, c] = await Promise.all([balanceAt(pkg, periods, pf.from, 'open'), balanceAt(pkg, periods, pt.to, 'close')]);
  const open = o.map, close = c.map, segCode = new Map([...o.seg, ...c.seg]);
  const { source, views } = mergeSources([o, c]);

  const rows = [];
  const drawerTotals = new Map();
  const tot = { openDr: 0, openCr: 0, moveDr: 0, moveCr: 0, closeDr: 0, closeCr: 0 };
  for (const code of new Set([...open.keys(), ...close.keys()])) {
    const a = chart.get(code);
    const o = open.get(code) || 0, c = close.get(code) || 0, m = c - o;
    if (Math.abs(o) < 0.005 && Math.abs(c) < 0.005 && Math.abs(m) < 0.005) continue;
    const g = a?.group || 8, d = drawerOf(g);
    const row = {
      code, disp: segCode.get(code) || a?.fmt || code, name: a?.name || code, group: g, drawer: d.key,
      drawerLabel: drawerName(chart, g),
      section: ancestorAt(chart, code, 2)?.name || '',
      opening: o, movement: m, closing: c,
      openDr: o > 0 ? o : 0, openCr: o < 0 ? -o : 0, moveDr: m > 0 ? m : 0, moveCr: m < 0 ? -m : 0, closeDr: c > 0 ? c : 0, closeCr: c < 0 ? -c : 0,
    };
    rows.push(row);
    for (const k of Object.keys(tot)) tot[k] += row[k];
    if (!drawerTotals.has(g)) drawerTotals.set(g, { group: g, key: d.key, label: row.drawerLabel, closeDr: 0, closeCr: 0, movement: 0, count: 0 });
    const dt = drawerTotals.get(g); dt.closeDr += row.closeDr; dt.closeCr += row.closeCr; dt.movement += m; dt.count++;
  }
  rows.sort((x, y) => x.group - y.group || String(x.disp).localeCompare(String(y.disp)));
  const difference = r2(tot.closeDr - tot.closeCr);

  return withCurrency({
    agent: 'Trial Balance Agent', report: 'tb', mode: range ? 'range' : 'period', source, views, generatedAt: new Date().toISOString(),
    fromPeriod: pf, toPeriod: pt, rows,
    drawers: [...drawerTotals.values()].sort((x, y) => x.group - y.group),
    totals: { ...tot, difference, balanced: Math.abs(difference) < 0.01, accountCount: rows.length,
      movementAccounts: rows.filter(r => Math.abs(r.movement) >= 0.005).length },
  });
}

// ── Cached dispatch (insight/chat reuse the data the dashboard just loaded) ──
async function getReport(report, params = {}, fresh = false) {
  // fromDate/toDate (date-range mode) take precedence over posting periods.
  const range = (params.fromDate || params.toDate) ? parseRange(String(params.fromDate || ''), String(params.toDate || '')) : null;
  const key = `${dbKey()}|${report}|${range ? `${range.from}~${range.to}` : `${params.period || ''}|${params.from || ''}|${params.to || ''}`}`;
  const hit = _reportCache.get(key);
  if (!fresh && hit && Date.now() - hit.at < REPORT_TTL) return hit.data;
  let data;
  if (report === 'bs') data = await buildBalanceSheet(params.period, range);
  else if (report === 'pl') data = await buildProfitLoss(params.period, range);
  else if (report === 'tb') data = await buildTrialBalance(params.from, params.to, range);
  else { const e = new Error('Unknown report'); e.status = 400; throw e; }
  _reportCache.set(key, { at: Date.now(), data });
  if (_reportCache.size > 60) _reportCache.delete(_reportCache.keys().next().value);
  return data;
}

// Compact, number-dense text summary the AI is grounded on.
function reportContext(d) {
  const f = (n) => (n === null || n === undefined || !Number.isFinite(n)) ? 'n/a' : Math.round(n).toLocaleString('en-US');
  const cur = d.currency?.code || '';
  if (d.report === 'bs') {
    const t = d.totals;
    const lines = [`BALANCE SHEET as at end of ${d.period.name} (${d.period.to}), currency ${cur}, source ${d.source}.`,
      `Total assets ${f(t.assets)} (${d.openLabel} ${f(t.assetsOpen)}${t.assetsLy !== null ? `, same period last year ${f(t.assetsLy)}` : ''}).`,
      `Liabilities ${f(t.liabilities)}; equity incl. current earnings ${f(t.equity)}; difference ${f(t.difference)}.`,
      `Debt-to-equity ${t.debtToEquity?.toFixed(2) ?? 'n/a'}; equity ratio ${t.equityRatio !== null ? (t.equityRatio * 100).toFixed(1) + '%' : 'n/a'}.`,
      `Current earnings (unclosed P&L) ${f(d.earnings.close)}.`];
    for (const s of d.sections) {
      lines.push(`\n${s.label}: ${f(s.close)} (${d.openLabel} ${f(s.open)}, change ${f(s.change)})`);
      for (const g of s.groups.slice(0, 8)) lines.push(`  - ${g.label}: ${f(g.close)} (change ${f(g.change)}); top: ${g.accounts.slice(0, 3).map(a => `${a.name} ${f(a.close)}`).join('; ')}`);
    }
    return lines.join('\n');
  }
  if (d.report === 'pl') {
    const s = d.summary, row = (k, lbl) => `${lbl}: period ${f(s.period[k])}, YTD ${f(s.ytd[k])}${s.lyPeriod ? `, LY period ${f(s.lyPeriod[k])}, LY YTD ${f(s.lyYtd[k])}` : ''}`;
    const lines = [`PROFIT & LOSS for ${d.period.name} (YTD from ${d.fytdFrom.name}), currency ${cur}, source ${d.source}.`,
      row('revenue', 'Revenue'), row('cogs', 'Cost of sales'), row('grossProfit', 'Gross profit'), row('opex', 'Operating expenses'),
      row('otherNet', 'Other/financing (net expense)'), row('netProfit', 'Net profit'),
      `Gross margin period ${s.period.grossMargin?.toFixed(1) ?? 'n/a'}% / YTD ${s.ytd.grossMargin?.toFixed(1) ?? 'n/a'}%; net margin period ${s.period.netMargin?.toFixed(1) ?? 'n/a'}% / YTD ${s.ytd.netMargin?.toFixed(1) ?? 'n/a'}%.`,
      `\nMonthly trend (revenue / gross profit / net profit): ${d.trend.map(t => `${t.name}: ${f(t.revenue)} / ${f(t.grossProfit)} / ${f(t.netProfit)}`).join('; ')}`];
    for (const sec of d.sections) {
      lines.push(`\n${sec.label}: period ${f(sec.period)}, YTD ${f(sec.ytd)}`);
      for (const g of sec.groups.slice(0, 6)) lines.push(`  - ${g.label}: period ${f(g.period)}, YTD ${f(g.ytd)}; top: ${g.accounts.slice(0, 3).map(a => `${a.name} YTD ${f(a.ytd)}`).join('; ')}`);
    }
    return lines.join('\n');
  }
  const t = d.totals;
  const lines = [`TRIAL BALANCE ${d.fromPeriod.name} to ${d.toPeriod.name}, currency ${cur}, source ${d.source}.`,
    `Closing debit ${f(t.closeDr)}, closing credit ${f(t.closeCr)}, difference ${f(t.difference)} (${t.balanced ? 'balanced' : 'NOT balanced'}). ${t.accountCount} accounts with balances, ${t.movementAccounts} with movement in range.`,
    `By drawer: ${d.drawers.map(x => `${x.label} Dr ${f(x.closeDr)} / Cr ${f(x.closeCr)}, movement ${f(x.movement)}`).join('; ')}`,
    `\nLargest movements: ${[...d.rows].sort((a, b) => Math.abs(b.movement) - Math.abs(a.movement)).slice(0, 15).map(r => `${r.disp} ${r.name} ${f(r.movement)} (closing ${f(r.closing)})`).join('; ')}`,
    `\nLargest closing balances: ${[...d.rows].sort((a, b) => Math.abs(b.closing) - Math.abs(a.closing)).slice(0, 15).map(r => `${r.disp} ${r.name} ${f(r.closing)}`).join('; ')}`,
    `Balances are debit-positive (negative = credit).`];
  return lines.join('\n');
}

const REPORT_NAMES = { bs: 'Balance Sheet', pl: 'Profit & Loss', tb: 'Trial Balance' };

export function createFinancialReportsRouter({ requireAuth, USE_AI }) {
  const router = Router();

  const guard = (res) => {
    if (!isConnected()) {
      res.status(503).json({ error: 'No direct HANA/MSSQL connection active. Connect one in Settings → DB Connection to use Financial Reports.' });
      return false;
    }
    return true;
  };
  const fail = (res, e) => { console.error('[FinReports]', e.message); res.status(e.status || 500).json({ error: e.message }); };

  router.get('/periods', requireAuth, async (req, res) => {
    if (!guard(res)) return;
    try {
      const [periods, pkg] = await Promise.all([loadPeriods(), hanaPackage()]);
      const today = new Date().toISOString().slice(0, 10);
      const current = periods.find(p => p.from <= today && p.to >= today) || [...periods].reverse().find(p => p.from <= today) || periods[periods.length - 1];
      res.json(await withCurrency({
        periods, defaultPeriod: current?.code || null,
        defaultFromPeriod: (periods.find(p => p.fy === current?.fy) || current)?.code || null,
        source: pkg ? 'hana' : 'jdt1', package: pkg, dbType: getActiveType(), aiEnabled: !!USE_AI,
      }));
    } catch (e) { fail(res, e); }
  });

  // Optional date-range mode: ?fromDate=YYYY-MM-DD&toDate=YYYY-MM-DD
  const dateParams = (req) => (req.query.fromDate || req.query.toDate) ? { fromDate: String(req.query.fromDate || ''), toDate: String(req.query.toDate || '') } : {};

  router.get('/balance-sheet', requireAuth, async (req, res) => {
    if (!guard(res)) return;
    try { res.json(await getReport('bs', { period: String(req.query.period || ''), ...dateParams(req) }, req.query.fresh === '1')); } catch (e) { fail(res, e); }
  });
  router.get('/profit-loss', requireAuth, async (req, res) => {
    if (!guard(res)) return;
    try { res.json(await getReport('pl', { period: String(req.query.period || ''), ...dateParams(req) }, req.query.fresh === '1')); } catch (e) { fail(res, e); }
  });
  router.get('/trial-balance', requireAuth, async (req, res) => {
    if (!guard(res)) return;
    try { res.json(await getReport('tb', { from: String(req.query.from || ''), to: String(req.query.to || ''), ...dateParams(req) }, req.query.fresh === '1')); } catch (e) { fail(res, e); }
  });

  const SYSTEM = (report) => `You are a chartered accountant and financial analyst reviewing an SAP Business One ${REPORT_NAMES[report]}. Use ONLY the figures provided; never invent numbers. Be specific, cite amounts, and keep it concise. Use markdown bullets; no headings larger than ###.`;

  router.post('/insight', requireAuth, async (req, res) => {
    if (!guard(res)) return;
    if (!USE_AI) return res.status(503).json({ error: 'AI is not configured on this server (no AI provider API key set).' });
    try {
      const { report, params } = req.body || {};
      const data = await getReport(report, params || {});
      const ask = {
        bs: 'Give 4-5 bullet insights on financial position: liquidity and solvency, the biggest movements since the opening balance, concentration in the largest balances, and any red flags (e.g. negative asset balances, debit balances in liabilities, the statement not balancing).',
        pl: 'Give 4-5 bullet insights on performance: revenue and margin trend, period vs last year, cost drivers, the months that stand out, and one or two concrete actions.',
        tb: 'Give 4-5 bullet insights for a reviewer: whether the TB balances, accounts with unusual sign (e.g. credit balance in an asset or cash account), the largest movements to investigate, and accounts to reconcile before closing.',
      }[report];
      const text = await callAI([{ role: 'user', content: `${SYSTEM(report)}\n\n${reportContext(data)}\n\n${ask}` }], 900);
      res.json({ insight: (text || '').trim() });
    } catch (e) { fail(res, e); }
  });

  router.post('/chat', requireAuth, async (req, res) => {
    if (!guard(res)) return;
    if (!USE_AI) return res.status(503).json({ error: 'AI is not configured on this server (no AI provider API key set).' });
    try {
      const { report, params, question, history } = req.body || {};
      const q = String(question || '').trim().slice(0, 1000);
      if (!q) return res.status(400).json({ error: 'Question is required' });
      const data = await getReport(report, params || {});
      const prior = (Array.isArray(history) ? history : []).slice(-8)
        .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
        .map(m => ({ role: m.role, content: m.content.slice(0, 2000) }));
      const messages = [
        { role: 'user', content: `${SYSTEM(report)}\n\nREPORT DATA:\n${reportContext(data)}` },
        { role: 'assistant', content: `Understood — I will answer questions about this ${REPORT_NAMES[report]} using only these figures.` },
        ...prior, { role: 'user', content: q },
      ];
      const text = await callAI(messages, 900);
      res.json({ reply: (text || '').trim() });
    } catch (e) { fail(res, e); }
  });

  return router;
}
