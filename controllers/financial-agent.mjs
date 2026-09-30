/**
 * Financial Agent Controller — real-time financial dashboards, all queried
 * directly against HANA/MSSQL (no caching) so numbers are always current.
 * Requires a direct DB connection (Settings → DB Connection) — falls back with
 * a clear error otherwise, since Service Layer alone can't aggregate this
 * efficiently.
 *
 * Five agents, each its own named dashboard card:
 *   GET /api/finance/pnl            — Trading P&L Agent
 *   GET /api/finance/cashflow       — Cash Flow & Liquidity Agent
 *   GET /api/finance/aging          — Receivables & Payables Aging Agent
 *   GET /api/finance/customer-aging — Customer Aging Detail Agent (bucket-wise + invoice-wise tabs)
 *   GET /api/finance/working-capital— Working Capital & Ratios Agent
 *   GET /api/finance/insight?section=pnl|cashflow|aging|customeraging|workingcapital&period=...
 *       — on-demand AI narrative for any of the above
 */
import { Router } from 'express';
import { executeSQL, isConnected, getActiveType, getActiveConfig, tableRef } from '../db-connector.mjs';
import { callAI } from '../analytics-v2.mjs';

const nf = (dbType) => (dbType === 'hana' ? 'IFNULL' : 'ISNULL');
const today = (dbType) => (dbType === 'hana' ? 'CURRENT_DATE' : 'GETDATE()');
const monthStart = (dbType) => dbType === 'hana'
  ? `TO_DATE(SUBSTRING(TO_VARCHAR(CURRENT_DATE),1,7)||'-01')`
  : `DATEFROMPARTS(YEAR(GETDATE()),MONTH(GETDATE()),1)`;
const yearStart = (dbType) => dbType === 'hana'
  ? `TO_DATE(SUBSTRING(TO_VARCHAR(CURRENT_DATE),1,4)||'-01-01')`
  : `DATEFROMPARTS(YEAR(GETDATE()),1,1)`;
const daysAgo = (dbType, n) => dbType === 'hana'
  ? `ADD_DAYS(CURRENT_DATE, -${n})`
  : `DATEADD(DAY, -${n}, GETDATE())`;
const daysBetween = (dbType, fromExpr, toExpr) => dbType === 'hana'
  ? `DAYS_BETWEEN(${fromExpr}, ${toExpr})`
  : `DATEDIFF(DAY, ${fromExpr}, ${toExpr})`;

function periodFrom(dbType, period) {
  if (period === 'ytd') return yearStart(dbType);
  if (period === 'last30') return daysAgo(dbType, 30);
  return monthStart(dbType); // default: mtd
}
function periodDaysCount(period) {
  const now = new Date();
  if (period === 'ytd')   return Math.max(1, Math.ceil((now - new Date(now.getFullYear(), 0, 1)) / 86400000));
  if (period === 'last30') return 30;
  return Math.max(1, Math.ceil((now - new Date(now.getFullYear(), now.getMonth(), 1)) / 86400000)); // mtd
}
const VALID_PERIODS = ['mtd', 'ytd', 'last30'];

// ════════════════════════════════════════════════════════════════════════════
// GL-based CFO overview
// Everything is derived from JDT1 (journal lines) + OACT (chart of accounts):
//   P&L for a period  = Σ(Credit − Debit) of P&L accounts, closing entries
//                       (TransType -3) excluded — they zero the P&L at year end.
//   Balance at a date = Σ(Debit − Credit) of every line up to that date (all
//                       TransTypes); unclosed P&L is shown as "current
//                       earnings" inside equity so the sheet balances.
// Two aggregate queries (opening balances + account × month movements) feed
// every KPI, chart and table, so all figures on the page agree with each other.
// Validated on a live company: FY2025 net profit = −(closing entries), and
// assets at FY2025-12 = SAP's GLAccountPeriodBalanceQuery to the cent.
// ════════════════════════════════════════════════════════════════════════════
const GL_PERIODS = ['mtd', 'lastmonth', 'qtd', 'ytd', 'last12', 'lastfy'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const miOf    = d => d.getFullYear() * 12 + d.getMonth();
const miY     = mi => Math.floor(mi / 12);
const miStart = mi => `${miY(mi)}-${String((mi % 12) + 1).padStart(2, '0')}-01`;
const miEnd   = mi => new Date(Date.UTC(miY(mi), (mi % 12) + 1, 0)).toISOString().slice(0, 10);
const miLabel = mi => `${MON[mi % 12]} ${miY(mi)}`;
const rangeLabel = ([a, b]) => (a === b ? miLabel(a) : `${miLabel(a)} – ${miLabel(b)}`);
const sqlDate = (dbType, iso) => (dbType === 'hana' ? `TO_DATE('${iso}')` : `CAST('${iso}' AS DATE)`);

// Period → month ranges [fromMi, toMi] for current / previous / same-period-last-year.
function glPeriods(key, c, fyStartMonth) {
  const fyFrom = c - (((c % 12) - fyStartMonth + 12) % 12);
  const qFrom = fyFrom + 3 * Math.floor((c - fyFrom) / 3);
  switch (key) {
    case 'mtd':       return { cur: [c, c], prev: [c - 1, c - 1], ly: [c - 12, c - 12], label: 'Month to date' };
    case 'lastmonth': return { cur: [c - 1, c - 1], prev: [c - 2, c - 2], ly: [c - 13, c - 13], label: 'Last month' };
    case 'qtd':       return { cur: [qFrom, c], prev: [qFrom - 3, qFrom - 3 + (c - qFrom)], ly: [qFrom - 12, c - 12], label: 'Quarter to date' };
    case 'last12':    return { cur: [c - 11, c], prev: null, ly: [c - 23, c - 12], label: 'Last 12 months' };
    case 'lastfy':    return { cur: [fyFrom - 12, fyFrom - 1], prev: null, ly: [fyFrom - 24, fyFrom - 13], label: 'Last fiscal year' };
    default:          return { cur: [fyFrom, c], prev: null, ly: [fyFrom - 12, c - 12], label: 'Fiscal year to date' };
  }
}

// P&L drawer → role, from the drawer's own title (GroupMask meaning differs per localisation).
function drawerRole(name, groupMask) {
  const n = String(name || '').toLowerCase();
  if (groupMask === 1) return 'asset';
  if (groupMask === 2) return 'liability';
  if (groupMask === 3) return 'equity';
  if (/cost of (sales|goods)|cogs|direct cost/.test(n)) return 'cogs';
  if (/other|non.?operating|financ|extraordinary|taxation/.test(n)) return 'other';
  if (/revenue|turnover|sales|income/.test(n)) return 'revenue';
  if (/expense|operating|overhead|expenditure/.test(n)) return 'opex';
  return 'other';
}
const RE_DA = /depreciat|amorti[sz]/i;
const RE_INTEREST = /interest|finance (cost|charge|expense)/i;
const RE_TAX = /income tax|corporate tax|corporation tax|deferred tax|tax on (profit|income)|provision for tax/i;
const RE_NONCUR = /non.?current|\bnca\b|\bncl\b|fixed|intangible|long|\blt\b|property|plant|equipment|investment|goodwill|right.?of.?use/i;
const RE_CA = /cash|bank|receiv|\bar\b|debtor|inventor|stock|prepa|advance|deposit|current|\bca\b|short/i;
const RE_CL = /payable|\bap\b|creditor|accru|current|\bcl\b|short|\bst\b|tax|provision|deferred revenue|customer deposit|advance/i;

export async function buildGlOverview(periodKey) {
  const dbType = getActiveType(), cfg = getActiveConfig();
  const T = t => tableRef(t, cfg);
  const today = new Date();
  const c = miOf(today);

  // Fiscal year start month from the posting period that contains today.
  let fyStartMonth = 0;
  try {
    const p = await executeSQL(`SELECT MIN(F."F_RefDate") AS "S" FROM ${T('OFPR')} F WHERE F."Category" = (SELECT MAX(P."Category") FROM ${T('OFPR')} P WHERE P."F_RefDate" <= ${sqlDate(dbType, today.toISOString().slice(0, 10))} AND P."T_RefDate" >= ${sqlDate(dbType, today.toISOString().slice(0, 10))})`);
    if (p[0]?.S) fyStartMonth = new Date(p[0].S).getMonth();
  } catch { /* calendar year */ }

  const P = glPeriods(periodKey, c, fyStartMonth);
  const endMi = P.cur[1];
  const ttm = [endMi - 11, endMi];
  const trendMis = Array.from({ length: 13 }, (_, i) => endMi - 12 + i);
  const winStart = Math.min(P.cur[0], P.ly[0], P.prev ? P.prev[0] : Infinity, ttm[0], trendMis[0]);
  const winEnd = Math.max(P.cur[1], c);

  const [acctRows, openRows, movRows] = await Promise.all([
    executeSQL(`SELECT A."AcctCode" AS "AcctCode", A."AcctName" AS "AcctName", A."FormatCode" AS "FormatCode", A."GroupMask" AS "GroupMask", A."Levels" AS "Levels", A."FatherNum" AS "FatherNum", A."Finanse" AS "Finanse" FROM ${T('OACT')} A`),
    executeSQL(`SELECT J."Account" AS "A", SUM(J."Debit" - J."Credit") AS "B" FROM ${T('JDT1')} J WHERE J."RefDate" < ${sqlDate(dbType, miStart(winStart))} GROUP BY J."Account"`),
    executeSQL(`SELECT J."Account" AS "A", YEAR(J."RefDate") AS "Y", MONTH(J."RefDate") AS "M", SUM(J."Debit") AS "DR", SUM(J."Credit") AS "CR",
  SUM(CASE WHEN J."TransType" <> '-3' THEN J."Debit" ELSE 0 END) AS "DRX", SUM(CASE WHEN J."TransType" <> '-3' THEN J."Credit" ELSE 0 END) AS "CRX"
FROM ${T('JDT1')} J WHERE J."RefDate" >= ${sqlDate(dbType, miStart(winStart))} AND J."RefDate" <= ${sqlDate(dbType, miEnd(winEnd))}
GROUP BY J."Account", YEAR(J."RefDate"), MONTH(J."RefDate")`),
  ]);

  // ── Chart of accounts tree: drawer + level-2 group for every account ──────
  const acct = new Map(acctRows.map(r => [r.AcctCode, { ...r, GroupMask: Number(r.GroupMask), Levels: Number(r.Levels) }]));
  const drawerName = {};
  for (const a of acct.values()) if (a.Levels === 1) drawerName[a.GroupMask] = a.AcctName;
  for (const a of acct.values()) {
    let node = a, group = a.Levels <= 2 ? a : null, guard = 0;
    while (node && node.Levels > 2 && guard++ < 12) { node = acct.get(node.FatherNum); if (node?.Levels === 2) group = node; }
    a.group = group ? group.AcctName : (drawerName[a.GroupMask] || 'Other');
    a.role = drawerRole(drawerName[a.GroupMask], a.GroupMask);
    a.isPL = a.GroupMask >= 4;
    if (a.isPL) {
      a.section = a.role;
      if (a.role !== 'revenue' && a.role !== 'cogs') {
        if (RE_DA.test(a.AcctName)) a.section = 'da';
        else if (RE_TAX.test(a.AcctName)) a.section = 'tax';
        else if (RE_INTEREST.test(a.AcctName)) a.section = 'interest';
      }
    } else if (a.GroupMask === 1) {
      a.cls = RE_NONCUR.test(a.group) || !RE_CA.test(a.group) ? 'noncurrent' : 'current';
      a.kind = a.Finanse === 'Y' || /cash|bank/i.test(a.group) ? 'cash' : /inventor|stock/i.test(a.group) ? 'inventory' : /receiv|\bar\b|debtor/i.test(a.group) ? 'ar' : 'other';
      if (a.kind === 'cash' || a.kind === 'inventory' || a.kind === 'ar') a.cls = 'current';
    } else if (a.GroupMask === 2) {
      a.cls = RE_NONCUR.test(a.group) || !RE_CL.test(a.group) ? 'noncurrent' : 'current';
      a.kind = /payable|\bap\b|creditor/i.test(a.group) ? 'ap' : /loan|borrow|debt|note|overdraft|credit line/i.test(a.group) ? 'debt' : 'other';
      if (a.kind === 'ap') a.cls = 'current';
    }
  }

  // ── Movements ────────────────────────────────────────────────────────────
  const open = new Map(openRows.map(r => [r.A, Number(r.B || 0)]));
  const mov = new Map(); // acct -> Map(mi -> {dr,cr,drx,crx})
  for (const r of movRows) {
    if (!mov.has(r.A)) mov.set(r.A, new Map());
    mov.get(r.A).set(Number(r.Y) * 12 + Number(r.M) - 1, { dr: Number(r.DR || 0), cr: Number(r.CR || 0), drx: Number(r.DRX || 0), crx: Number(r.CRX || 0) });
  }
  const used = new Set([...open.keys(), ...mov.keys()]);
  const plNet = (code, [a, b]) => { let s = 0; const m = mov.get(code); if (m) for (const [mi, v] of m) if (mi >= a && mi <= b) s += v.crx - v.drx; return s; };
  const balAt = (code, mi) => { let s = open.get(code) || 0; const m = mov.get(code); if (m) for (const [k, v] of m) if (k <= mi) s += v.dr - v.cr; return s; };
  const flow = (code, [a, b]) => { let dr = 0, cr = 0; const m = mov.get(code); if (m) for (const [mi, v] of m) if (mi >= a && mi <= b) { dr += v.dr; cr += v.cr; } return { dr, cr }; };
  const accts = [...used].map(code => acct.get(code)).filter(Boolean);
  const plAccts = accts.filter(a => a.isPL);
  const bsAccts = accts.filter(a => !a.isPL);

  const pl = range => {
    if (!range) return null;
    const s = { revenue: 0, cogs: 0, opex: 0, other: 0, da: 0, interest: 0, tax: 0 };
    for (const a of plAccts) s[a.section] += plNet(a.AcctCode, range);
    const netProfit = s.revenue + s.cogs + s.opex + s.other + s.da + s.interest + s.tax;
    const revenue = s.revenue, cogs = -s.cogs, opex = -s.opex, da = -s.da, interest = -s.interest, tax = -s.tax, otherNet = s.other;
    const grossProfit = revenue - cogs, ebitda = netProfit + da + interest + tax, ebit = ebitda - da;
    const pct = v => (revenue ? (v / revenue) * 100 : null);
    return { revenue, cogs, grossProfit, grossMarginPct: pct(grossProfit), opex, otherNet, ebitda, ebitdaMarginPct: pct(ebitda), da, ebit, interest, pbt: netProfit + tax, tax, netProfit, netMarginPct: pct(netProfit), opexPct: pct(opex) };
  };

  const bs = mi => {
    const t = { cash: 0, ar: 0, inventory: 0, otherCurrentAssets: 0, currentAssets: 0, nonCurrentAssets: 0, totalAssets: 0,
                ap: 0, debt: 0, currentLiabilities: 0, nonCurrentLiabilities: 0, totalLiabilities: 0, equityBooked: 0, currentEarnings: 0 };
    for (const a of bsAccts) {
      const b = balAt(a.AcctCode, mi);
      if (a.GroupMask === 1) {
        t.totalAssets += b;
        if (a.cls === 'current') { t.currentAssets += b; if (a.kind === 'cash') t.cash += b; else if (a.kind === 'ar') t.ar += b; else if (a.kind === 'inventory') t.inventory += b; else t.otherCurrentAssets += b; }
        else t.nonCurrentAssets += b;
      } else if (a.GroupMask === 2) {
        t.totalLiabilities -= b;
        if (a.cls === 'current') t.currentLiabilities -= b; else t.nonCurrentLiabilities -= b;
        if (a.kind === 'ap') t.ap -= b;
        if (a.kind === 'debt') t.debt -= b;
      } else t.equityBooked -= b;
    }
    for (const a of plAccts) t.currentEarnings -= balAt(a.AcctCode, mi);
    t.equity = t.equityBooked + t.currentEarnings;
    t.workingCapital = t.currentAssets - t.currentLiabilities;
    t.difference = t.totalAssets - t.totalLiabilities - t.equity;
    const div = (x, y) => (y ? x / y : null);
    t.currentRatio = div(t.currentAssets, t.currentLiabilities);
    t.quickRatio = div(t.currentAssets - t.inventory, t.currentLiabilities);
    t.cashRatio = div(t.cash, t.currentLiabilities);
    t.debtToEquity = div(t.debt, t.equity);
    t.liabilitiesToEquity = div(t.totalLiabilities, t.equity);
    return t;
  };

  const cashAccts = bsAccts.filter(a => a.kind === 'cash');
  const cashFlow = range => {
    if (!range) return null;
    let inflow = 0, outflow = 0;
    for (const a of cashAccts) { const f = flow(a.AcctCode, range); inflow += f.dr; outflow += f.cr; }
    return { inflow, outflow, net: inflow - outflow, opening: cashAccts.reduce((s, a) => s + balAt(a.AcctCode, range[0] - 1), 0), closing: cashAccts.reduce((s, a) => s + balAt(a.AcctCode, range[1]), 0) };
  };

  const cur = pl(P.cur), prev = pl(P.prev), ly = pl(P.ly), ttmPl = pl(ttm);
  const bsEnd = bs(endMi), bsPrev = bs(P.prev ? P.prev[1] : P.cur[0] - 1), bsLy = bs(endMi - 12);
  const daysTtm = Math.round((new Date(miEnd(ttm[1])) - new Date(miStart(ttm[0]))) / 86400000) + 1;
  const div = (x, y) => (y ? x / y : null);
  const dso = div(bsEnd.ar * daysTtm, ttmPl.revenue), dpo = div(bsEnd.ap * daysTtm, ttmPl.cogs), dio = div(bsEnd.inventory * daysTtm, ttmPl.cogs);
  const ratios = {
    basis: `Balances at ${miEnd(endMi)}; flows = trailing 12 months ${rangeLabel(ttm)}`,
    dso, dpo, dio, ccc: dso != null && dio != null && dpo != null ? dso + dio - dpo : null,
    roe: div(ttmPl.netProfit * 100, bsEnd.equity), roa: div(ttmPl.netProfit * 100, bsEnd.totalAssets),
    interestCoverage: ttmPl.interest > 0 ? ttmPl.ebit / ttmPl.interest : null,
    assetTurnover: div(ttmPl.revenue, bsEnd.totalAssets),
    ttm: ttmPl,
  };

  // ── Monthly trend ────────────────────────────────────────────────────────
  const trend = trendMis.map(mi => {
    const p = pl([mi, mi]), b = bs(mi);
    return { month: miLabel(mi), from: miStart(mi), to: miEnd(mi), partial: mi === c,
      revenue: p.revenue, grossProfit: p.grossProfit, opex: p.opex, ebitda: p.ebitda, netProfit: p.netProfit,
      grossMarginPct: p.grossMarginPct, ebitdaMarginPct: p.ebitdaMarginPct, netMarginPct: p.netMarginPct,
      cash: b.cash, ar: b.ar, ap: b.ap, inventory: b.inventory };
  });

  // ── Detail rows ──────────────────────────────────────────────────────────
  const COST = new Set(['cogs', 'opex', 'da', 'interest', 'tax']);
  const plRows = plAccts.map(a => {
    const sgn = COST.has(a.section) ? -1 : 1;
    return { acct: a.AcctCode, code: a.FormatCode || a.AcctCode, name: a.AcctName, section: a.section, group: a.group,
      cur: sgn * plNet(a.AcctCode, P.cur), prev: P.prev ? sgn * plNet(a.AcctCode, P.prev) : null, ly: sgn * plNet(a.AcctCode, P.ly) };
  }).filter(r => Math.abs(r.cur) > 0.005 || Math.abs(r.ly) > 0.005 || Math.abs(r.prev || 0) > 0.005)
    .sort((x, y) => Math.abs(y.cur) - Math.abs(x.cur));
  const bsRows = bsAccts.map(a => {
    const sgn = a.GroupMask === 1 ? 1 : -1;
    return { acct: a.AcctCode, code: a.FormatCode || a.AcctCode, name: a.AcctName, drawer: drawerName[a.GroupMask] || (a.GroupMask === 1 ? 'Assets' : a.GroupMask === 2 ? 'Liabilities' : 'Equity'),
      groupMask: a.GroupMask, group: a.group, cls: a.cls || null, kind: a.kind || null, end: sgn * balAt(a.AcctCode, endMi), lyEnd: sgn * balAt(a.AcctCode, endMi - 12) };
  }).filter(r => Math.abs(r.end) > 0.005 || Math.abs(r.lyEnd) > 0.005);

  // Expense mix by group (opex + D&A), current vs last year.
  const expMap = new Map();
  for (const r of plRows) if (r.section === 'opex' || r.section === 'da') {
    const e = expMap.get(r.group) || { group: r.group, cur: 0, ly: 0, prev: 0 };
    e.cur += r.cur; e.ly += r.ly; e.prev += r.prev || 0; expMap.set(r.group, e);
  }
  const expenseGroups = [...expMap.values()].sort((a, b) => b.cur - a.cur);

  const groupsOf = (pred) => [...new Set(bsAccts.filter(pred).map(a => a.group))];
  return {
    agent: 'CFO Overview (General Ledger)', dbType, generatedAt: new Date().toISOString(), period: periodKey,
    periods: {
      label: P.label, fyStartMonth: MON[fyStartMonth],
      cur: { from: miStart(P.cur[0]), to: miEnd(P.cur[1]), label: rangeLabel(P.cur), partial: P.cur[1] === c },
      prev: P.prev ? { from: miStart(P.prev[0]), to: miEnd(P.prev[1]), label: rangeLabel(P.prev) } : null,
      ly: { from: miStart(P.ly[0]), to: miEnd(P.ly[1]), label: rangeLabel(P.ly) },
      balanceDate: miEnd(endMi), balanceDateLy: miEnd(endMi - 12),
    },
    pnl: { cur, prev, ly }, balance: { end: bsEnd, prev: bsPrev, ly: bsLy },
    cashFlow: { cur: cashFlow(P.cur), prev: cashFlow(P.prev), ly: cashFlow(P.ly) },
    ratios, trend, expenseGroups, plRows, bsRows,
    classification: {
      drawers: drawerName,
      currentAssets: groupsOf(a => a.GroupMask === 1 && a.cls === 'current'), nonCurrentAssets: groupsOf(a => a.GroupMask === 1 && a.cls === 'noncurrent'),
      currentLiabilities: groupsOf(a => a.GroupMask === 2 && a.cls === 'current'), nonCurrentLiabilities: groupsOf(a => a.GroupMask === 2 && a.cls === 'noncurrent'),
      debt: groupsOf(a => a.kind === 'debt'),
      daAccounts: plAccts.filter(a => a.section === 'da').map(a => a.AcctName), interestAccounts: plAccts.filter(a => a.section === 'interest').map(a => a.AcctName),
      taxAccounts: plAccts.filter(a => a.section === 'tax').map(a => a.AcctName),
    },
    definitions: {
      revenue: 'Revenue drawer, Σ(Credit − Debit), closing entries excluded',
      grossProfit: 'Revenue − Cost of sales', ebitda: 'Net profit + depreciation & amortisation + interest + income tax',
      netProfit: 'Σ(Credit − Debit) of all P&L accounts', workingCapital: 'Current assets − current liabilities (by level-2 account group)',
      dso: 'AR ÷ revenue (TTM) × days', dpo: 'AP ÷ COGS (TTM) × days', dio: 'Inventory ÷ COGS (TTM) × days', ccc: 'DSO + DIO − DPO',
    },
  };
}

export function createFinancialAgentRouter({ requireAuth }) {
  const router = Router();

  function requireDb(res) {
    if (!isConnected()) {
      res.status(503).json({ error: 'No direct HANA/MSSQL connection active. Connect one in Settings → DB Connection to use the Financial Dashboard.' });
      return false;
    }
    return true;
  }

  // ── Trading P&L Agent — derived from AR Invoice revenue/gross profit and AP
  //    Invoice purchases; NOT a full GL-based P&L (that needs each company's
  //    chart of accounts mapped to income/expense account types). ────────────
  router.get('/finance/pnl', requireAuth, async (req, res) => {
    if (!requireDb(res)) return;
    try {
      const dbType = getActiveType(), cfg = getActiveConfig();
      const period = VALID_PERIODS.includes(req.query.period) ? req.query.period : 'mtd';
      const fromExpr = periodFrom(dbType, period);
      const oinv = tableRef('OINV', cfg), inv1 = tableRef('INV1', cfg);
      const opch = tableRef('OPCH', cfg), pch1 = tableRef('PCH1', cfg);

      const salesSql = `SELECT ${nf(dbType)}(SUM(T1."LineTotal"),0) AS "Revenue", ${nf(dbType)}(SUM(T1."GrssProfit"),0) AS "GrossProfit"
FROM ${oinv} T0 INNER JOIN ${inv1} T1 ON T0."DocEntry" = T1."DocEntry"
WHERE T0."DocDate" >= ${fromExpr} AND T0."DocStatus" <> 'W'`;

      const purchSql = `SELECT ${nf(dbType)}(SUM(T1."LineTotal"),0) AS "Expenses"
FROM ${opch} T0 INNER JOIN ${pch1} T1 ON T0."DocEntry" = T1."DocEntry"
WHERE T0."DocDate" >= ${fromExpr} AND T0."DocStatus" <> 'W'`;

      const [salesRows, purchRows] = await Promise.all([executeSQL(salesSql), executeSQL(purchSql)]);
      const revenue      = Number(salesRows[0]?.Revenue || 0);
      const grossProfit  = Number(salesRows[0]?.GrossProfit || 0);
      const expenses     = Number(purchRows[0]?.Expenses || 0);
      const cogs         = revenue - grossProfit;
      const gpPercent    = revenue ? (grossProfit / revenue * 100) : 0;
      const netProxy     = grossProfit - expenses;

      res.json({
        agent: 'Trading P&L Agent', period, dbType, generatedAt: new Date().toISOString(),
        revenue, cogs, grossProfit, gpPercent, expenses, netProxy,
        note: 'Trading P&L: revenue/gross profit from AR Invoices, expenses from AP Invoices. Not a full GL-based P&L.',
        sql: { sales: salesSql, purchases: purchSql },
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Cash Flow & Liquidity Agent ──────────────────────────────────────────────
  router.get('/finance/cashflow', requireAuth, async (req, res) => {
    if (!requireDb(res)) return;
    try {
      const dbType = getActiveType(), cfg = getActiveConfig();
      const period = VALID_PERIODS.includes(req.query.period) ? req.query.period : 'mtd';
      const fromExpr = periodFrom(dbType, period);
      const orct = tableRef('ORCT', cfg), ovpm = tableRef('OVPM', cfg);
      const oinv = tableRef('OINV', cfg), opch = tableRef('OPCH', cfg);

      const cashInSql  = `SELECT ${nf(dbType)}(SUM(T0."DocTotal"),0) AS "CashIn" FROM ${orct} T0 WHERE T0."DocDate" >= ${fromExpr}`;
      const cashOutSql = `SELECT ${nf(dbType)}(SUM(T0."DocTotal"),0) AS "CashOut" FROM ${ovpm} T0 WHERE T0."DocDate" >= ${fromExpr}`;
      const arSql       = `SELECT ${nf(dbType)}(SUM(T0."DocTotal" - T0."PaidToDate"),0) AS "AR" FROM ${oinv} T0 WHERE T0."DocStatus" = 'O'`;
      const apSql        = `SELECT ${nf(dbType)}(SUM(T0."DocTotal" - T0."PaidToDate"),0) AS "AP" FROM ${opch} T0 WHERE T0."DocStatus" = 'O'`;

      const [inRows, outRows, arRows, apRows] = await Promise.all([
        executeSQL(cashInSql), executeSQL(cashOutSql), executeSQL(arSql), executeSQL(apSql),
      ]);
      const cashIn        = Number(inRows[0]?.CashIn || 0);
      const cashOut        = Number(outRows[0]?.CashOut || 0);
      const arOutstanding  = Number(arRows[0]?.AR || 0);
      const apOutstanding  = Number(apRows[0]?.AP || 0);
      const netCashFlow    = cashIn - cashOut;
      const netPosition    = arOutstanding - apOutstanding;
      const receivablesToPayablesRatio = apOutstanding ? (arOutstanding / apOutstanding) : null;

      res.json({
        agent: 'Cash Flow & Liquidity Agent', period, dbType, generatedAt: new Date().toISOString(),
        cashIn, cashOut, netCashFlow, arOutstanding, apOutstanding, netPosition, receivablesToPayablesRatio,
        note: 'Cash In/Out are Incoming/Outgoing Payments for the period. AR/AP Outstanding are current open-balance snapshots (not period-limited). Ratio = AR Outstanding / AP Outstanding — a receivables-to-payables liquidity proxy, not a full current ratio.',
        sql: { cashIn: cashInSql, cashOut: cashOutSql, ar: arSql, ap: apSql },
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Receivables & Payables Aging Agent — bucketed open-balance snapshot ──────
  router.get('/finance/aging', requireAuth, async (req, res) => {
    if (!requireDb(res)) return;
    try {
      const dbType = getActiveType(), cfg = getActiveConfig();
      const oinv = tableRef('OINV', cfg), opch = tableRef('OPCH', cfg);
      const todayExpr = today(dbType);
      const bucketCase = (alias) => `CASE WHEN ${alias}."DocDueDate" >= ${todayExpr} THEN 'Current'
        WHEN ${daysBetween(dbType, `${alias}."DocDueDate"`, todayExpr)} <= 30 THEN '1-30'
        WHEN ${daysBetween(dbType, `${alias}."DocDueDate"`, todayExpr)} <= 60 THEN '31-60'
        WHEN ${daysBetween(dbType, `${alias}."DocDueDate"`, todayExpr)} <= 90 THEN '61-90'
        ELSE '90+' END`;

      const arSql = `SELECT ${bucketCase('T0')} AS "Bucket", ${nf(dbType)}(SUM(T0."DocTotal"-T0."PaidToDate"),0) AS "Amount", COUNT(*) AS "Cnt"
FROM ${oinv} T0 WHERE T0."DocStatus"='O' AND (T0."DocTotal"-T0."PaidToDate")>0
GROUP BY ${bucketCase('T0')}`;

      const apSql = `SELECT ${bucketCase('T0')} AS "Bucket", ${nf(dbType)}(SUM(T0."DocTotal"-T0."PaidToDate"),0) AS "Amount", COUNT(*) AS "Cnt"
FROM ${opch} T0 WHERE T0."DocStatus"='O' AND (T0."DocTotal"-T0."PaidToDate")>0
GROUP BY ${bucketCase('T0')}`;

      const [arRows, apRows] = await Promise.all([executeSQL(arSql), executeSQL(apSql)]);
      const BUCKETS = ['Current', '1-30', '31-60', '61-90', '90+'];
      const toMap = (rows) => {
        const m = {}; BUCKETS.forEach(b => m[b] = { amount: 0, count: 0 });
        rows.forEach(r => { if (m[r.Bucket]) m[r.Bucket] = { amount: Number(r.Amount || 0), count: Number(r.Cnt || 0) }; });
        return m;
      };
      const ar = toMap(arRows), ap = toMap(apRows);
      const arTotal = Object.values(ar).reduce((s, b) => s + b.amount, 0);
      const apTotal = Object.values(ap).reduce((s, b) => s + b.amount, 0);
      const arOverdue = arTotal - ar.Current.amount;
      const apOverdue = apTotal - ap.Current.amount;

      res.json({
        agent: 'Receivables & Payables Aging Agent', dbType, generatedAt: new Date().toISOString(),
        buckets: BUCKETS, ar, ap, arTotal, apTotal, arOverdue, apOverdue,
        note: 'Buckets computed from open AR/AP invoice balances vs today\'s date. "Current" = not yet due.',
        sql: { ar: arSql, ap: apSql },
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Customer Aging Detail Agent — per-customer bucket matrix + invoice-level
  //    drill-down. Buckets and date basis (due date vs document date) are both
  //    user-configurable via query params. ──────────────────────────────────
  // daysOverdue = today - dateCol. Positive = overdue, negative = not yet due
  // (in the future) — that's what lets a "Future" bucket exist (maxDays < 0).
  const DEFAULT_BUCKETS = [
    { label: 'Future',  minDays: null, maxDays: -1 },
    { label: 'Current', minDays: 0,    maxDays: 0 },
    { label: '1-30',    minDays: 1,    maxDays: 30 },
    { label: '31-60',   minDays: 31,   maxDays: 60 },
    { label: '61-90',   minDays: 61,   maxDays: 90 },
    { label: '90+',     minDays: 91,   maxDays: null },
  ];
  function sanitizeBuckets(raw) {
    if (!raw) return DEFAULT_BUCKETS;
    let arr;
    try { arr = JSON.parse(raw); } catch { return DEFAULT_BUCKETS; }
    if (!Array.isArray(arr) || !arr.length || arr.length > 12) return DEFAULT_BUCKETS;
    const out = [];
    for (const b of arr) {
      if (!b || typeof b.label !== 'string') return DEFAULT_BUCKETS;
      const label = b.label.trim().replace(/'/g, '').slice(0, 24);
      if (!label) return DEFAULT_BUCKETS;
      const minDays = (b.minDays === null || b.minDays === undefined || b.minDays === '') ? null : parseInt(b.minDays, 10);
      const maxDays = (b.maxDays === null || b.maxDays === undefined || b.maxDays === '') ? null : parseInt(b.maxDays, 10);
      if ((minDays !== null && !Number.isFinite(minDays)) || (maxDays !== null && !Number.isFinite(maxDays))) return DEFAULT_BUCKETS;
      out.push({ label, minDays, maxDays });
    }
    return out;
  }
  function bucketCondition(daysExpr, b) {
    if (b.minDays === null && b.maxDays !== null) return `${daysExpr} <= ${b.maxDays}`;
    if (b.minDays !== null && b.maxDays === null) return `${daysExpr} >= ${b.minDays}`;
    if (b.minDays !== null && b.maxDays !== null) return `${daysExpr} BETWEEN ${b.minDays} AND ${b.maxDays}`;
    return '1=1';
  }
  // Standard SQL single-quote escaping — values are always wrapped in '...' below.
  const sqlEscape = (s) => String(s).replace(/'/g, "''");

  router.get('/finance/customer-aging', requireAuth, async (req, res) => {
    if (!requireDb(res)) return;
    try {
      const dbType = getActiveType(), cfg = getActiveConfig();
      const oinv = tableRef('OINV', cfg);
      const dateBasis = req.query.dateBasis === 'doc' ? 'doc' : 'due';
      const dateCol = dateBasis === 'doc' ? 'DocDate' : 'DocDueDate';
      const buckets = sanitizeBuckets(req.query.buckets);
      const todayExpr = today(dbType);
      const daysExpr = daysBetween(dbType, `T0."${dateCol}"`, todayExpr);
      const balance = `(T0."DocTotal" - T0."PaidToDate")`;
      const bucketCase = `CASE ${buckets.map(b => `WHEN ${bucketCondition(daysExpr, b)} THEN '${b.label}'`).join(' ')} ELSE 'Other' END`;

      // Optional customer filter — exact CardCode match, or partial CardName match.
      const cardCode = (req.query.cardCode || '').toString().trim().slice(0, 60);
      const cardName = (req.query.cardName || '').toString().trim().slice(0, 100);
      let custFilter = '';
      if (cardCode) custFilter = ` AND T0."CardCode"='${sqlEscape(cardCode)}'`;
      else if (cardName) custFilter = ` AND UPPER(T0."CardName") LIKE UPPER('%${sqlEscape(cardName)}%')`;

      // Detail-wise-only filters — customer (name/code contains), document number, doc-date range.
      // Validated to strict shapes so nothing free-form reaches the SQL except the escaped customer text.
      const detailCustomer = (req.query.detailCustomer || '').toString().trim().slice(0, 100);
      const docNum = (req.query.docNum || '').toString().trim();
      const isoDate = v => { const s = (v || '').toString().trim(); return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : ''; };
      const fromDate = isoDate(req.query.fromDate), toDate = isoDate(req.query.toDate);
      let detailFilter = '';
      if (detailCustomer) {
        const like = `UPPER('%${sqlEscape(detailCustomer)}%')`;
        detailFilter += ` AND (UPPER(T0."CardName") LIKE ${like} OR UPPER(T0."CardCode") LIKE ${like})`;
      }
      if (/^\d{1,10}$/.test(docNum)) detailFilter += ` AND T0."DocNum"=${parseInt(docNum, 10)}`;
      if (fromDate) detailFilter += ` AND T0."DocDate" >= '${fromDate}'`;
      if (toDate)   detailFilter += ` AND T0."DocDate" <= '${toDate}'`;

      // Tab 1 — aging-wise, one row per customer, one column per configured bucket
      const bucketCols = buckets.map((b, i) =>
        `${nf(dbType)}(SUM(CASE WHEN ${bucketCondition(daysExpr, b)} THEN ${balance} ELSE 0 END),0) AS "Bucket_${i}"`
      ).join(',\n  ');
      const summarySql = `SELECT T0."CardCode" AS "CardCode", T0."CardName" AS "CardName",
  ${bucketCols},
  ${nf(dbType)}(SUM(${balance}),0) AS "Total"
FROM ${oinv} T0
WHERE T0."DocStatus"='O' AND ${balance} > 0${custFilter}
GROUP BY T0."CardCode", T0."CardName"
ORDER BY SUM(${balance}) DESC`;

      // Tab 2 — detail-wise, one row per open invoice
      const detailSql = `SELECT T0."CardCode" AS "CardCode", T0."CardName" AS "CardName", T0."DocNum" AS "InvoiceNo",
  T0."DocDate" AS "InvoiceDate", T0."DocDueDate" AS "DueDate", ${balance} AS "Balance",
  ${daysExpr} AS "DaysOverdue", ${bucketCase} AS "Bucket"
FROM ${oinv} T0
WHERE T0."DocStatus"='O' AND ${balance} > 0${custFilter}${detailFilter}
ORDER BY T0."${dateCol}" ASC`;

      const [summaryRowsRaw, detailRowsRaw] = await Promise.all([executeSQL(summarySql), executeSQL(detailSql)]);
      const summary = summaryRowsRaw.map(r => ({
        CardCode: r.CardCode, CardName: r.CardName,
        buckets: buckets.map((b, i) => Number(r[`Bucket_${i}`] || 0)),
        total: Number(r.Total || 0),
      }));
      const DETAIL_CAP = 5000; // UI paginates (30 customers/page), so the cap only bounds payload size
      const detailRows = detailRowsRaw.slice(0, DETAIL_CAP);

      // Grand totals — the overall AR balance across all customers/buckets, so
      // it's visible at a glance instead of only per-row (fixes it not showing).
      const grandTotal = summary.reduce((s, r) => s + r.total, 0);
      const overdueTotal = buckets.reduce((s, b, i) =>
        s + (b.minDays !== null && b.minDays > 0 ? summary.reduce((s2, r) => s2 + r.buckets[i], 0) : 0), 0);

      res.json({
        agent: 'Customer Aging Detail Agent', dbType, dateBasis, generatedAt: new Date().toISOString(),
        bucketLabels: buckets.map(b => b.label),
        buckets, // echoed back so the UI can reload the same config after a refresh
        customerFilter: { cardCode: cardCode || null, cardName: cardName || null },
        detailFilters: { customer: detailCustomer || null, docNum: docNum || null, fromDate: fromDate || null, toDate: toDate || null },
        summary, totals: { grandTotal, overdueTotal, customerCount: summary.length },
        detail: detailRows,
        detailTotalCount: detailRowsRaw.length,
        detailTruncated: detailRowsRaw.length > DETAIL_CAP,
        note: `Aging-wise: one row per customer with open AR balance split by bucket (based on ${dateBasis === 'doc' ? 'document date' : 'due date'}). Detail-wise: every open AR invoice, oldest first` + (detailRowsRaw.length > DETAIL_CAP ? ` (showing first ${DETAIL_CAP} of ${detailRowsRaw.length}).` : '.'),
        sql: { summary: summarySql, detail: detailSql },
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Working Capital & Ratios Agent — proxy ratios from transactional data ────
  router.get('/finance/working-capital', requireAuth, async (req, res) => {
    if (!requireDb(res)) return;
    try {
      const dbType = getActiveType(), cfg = getActiveConfig();
      const period = VALID_PERIODS.includes(req.query.period) ? req.query.period : 'mtd';
      const fromExpr = periodFrom(dbType, period);
      const oinv = tableRef('OINV', cfg), inv1 = tableRef('INV1', cfg);
      const opch = tableRef('OPCH', cfg), pch1 = tableRef('PCH1', cfg);
      const oitw = tableRef('OITW', cfg), oitm = tableRef('OITM', cfg);

      const arSql  = `SELECT ${nf(dbType)}(SUM(T0."DocTotal"-T0."PaidToDate"),0) AS "AR" FROM ${oinv} T0 WHERE T0."DocStatus"='O'`;
      const apSql  = `SELECT ${nf(dbType)}(SUM(T0."DocTotal"-T0."PaidToDate"),0) AS "AP" FROM ${opch} T0 WHERE T0."DocStatus"='O'`;
      const invSql = `SELECT ${nf(dbType)}(SUM(T0."OnHand" * T1."AvgPrice"),0) AS "InvValue" FROM ${oitw} T0 INNER JOIN ${oitm} T1 ON T0."ItemCode"=T1."ItemCode" WHERE T0."OnHand">0`;
      const revSql = `SELECT ${nf(dbType)}(SUM(T1."LineTotal"),0) AS "Revenue" FROM ${oinv} T0 INNER JOIN ${inv1} T1 ON T0."DocEntry"=T1."DocEntry" WHERE T0."DocDate">=${fromExpr} AND T0."DocStatus"<>'W'`;
      const purSql = `SELECT ${nf(dbType)}(SUM(T1."LineTotal"),0) AS "Purchases" FROM ${opch} T0 INNER JOIN ${pch1} T1 ON T0."DocEntry"=T1."DocEntry" WHERE T0."DocDate">=${fromExpr} AND T0."DocStatus"<>'W'`;

      const [arRows, apRows, invRows, revRows, purRows] = await Promise.all([
        executeSQL(arSql), executeSQL(apSql), executeSQL(invSql), executeSQL(revSql), executeSQL(purSql),
      ]);
      const arOutstanding  = Number(arRows[0]?.AR || 0);
      const apOutstanding  = Number(apRows[0]?.AP || 0);
      const inventoryValue = Number(invRows[0]?.InvValue || 0);
      const revenue         = Number(revRows[0]?.Revenue || 0);
      const purchases       = Number(purRows[0]?.Purchases || 0);
      const days             = periodDaysCount(period);

      const currentRatio = apOutstanding ? (arOutstanding + inventoryValue) / apOutstanding : null;
      const quickRatio    = apOutstanding ? arOutstanding / apOutstanding : null;
      const dso            = revenue ? (arOutstanding / revenue) * days : null;
      const dpo            = purchases ? (apOutstanding / purchases) * days : null;

      res.json({
        agent: 'Working Capital & Ratios Agent', period, dbType, generatedAt: new Date().toISOString(),
        arOutstanding, apOutstanding, inventoryValue, revenue, purchases,
        currentRatio, quickRatio, dso, dpo,
        note: 'Proxy ratios from transactional data — AR/AP open balances and inventory at average cost, not a full GL-based balance sheet. Current Ratio ≈ (AR + Inventory) / AP. Quick Ratio ≈ AR / AP. DSO/DPO computed over the selected period.',
        sql: { ar: arSql, ap: apSql, inventory: invSql, revenue: revSql, purchases: purSql },
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── CFO Overview — General-Ledger based P&L, balance sheet, ratios, trend ──
  //    Replaces the document-based proxies above on the dashboard: those
  //    divided all open AR by one month of invoice revenue (DSO 182,382 days)
  //    and missed every non-invoice posting. See buildGlOverview below.
  router.get('/finance/overview', requireAuth, async (req, res) => {
    if (!requireDb(res)) return;
    try {
      const period = GL_PERIODS.includes(req.query.period) ? req.query.period : 'ytd';
      res.json(await buildGlOverview(period));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Drill-down: journal lines behind one account for a date range.
  router.get('/finance/account-lines', requireAuth, async (req, res) => {
    if (!requireDb(res)) return;
    try {
      const dbType = getActiveType(), cfg = getActiveConfig();
      const acct = String(req.query.acct || '');
      const iso = /^\d{4}-\d{2}-\d{2}$/;
      if (!acct || !iso.test(req.query.from || '') || !iso.test(req.query.to || '')) return res.status(400).json({ error: 'acct, from and to (YYYY-MM-DD) are required' });
      const jdt1 = tableRef('JDT1', cfg), ojdt = tableRef('OJDT', cfg), ocrd = tableRef('OCRD', cfg);
      const lim = dbType === 'hana' ? ['', 'LIMIT 1000'] : ['TOP 1000', ''];
      const sql = `SELECT ${lim[0]} J."TransId" AS "TransId", J."RefDate" AS "Date", J."TransType" AS "TransType", J."BaseRef" AS "DocNo",
  H."Memo" AS "Memo", J."LineMemo" AS "LineMemo", J."ShortName" AS "ShortName", C."CardName" AS "Partner",
  J."Debit" AS "Debit", J."Credit" AS "Credit", J."ProfitCode" AS "CostCentre"
FROM ${jdt1} J INNER JOIN ${ojdt} H ON H."TransId" = J."TransId" LEFT JOIN ${ocrd} C ON C."CardCode" = J."ShortName"
WHERE J."Account" = '${acct.replace(/'/g, "''")}' AND J."RefDate" >= ${sqlDate(dbType, req.query.from)} AND J."RefDate" <= ${sqlDate(dbType, req.query.to)} AND J."TransType" <> '-3'
ORDER BY J."RefDate" DESC, J."TransId" DESC ${lim[1]}`;
      const rows = await executeSQL(sql);
      res.json({ acct, from: req.query.from, to: req.query.to, rows, truncated: rows.length >= 1000 });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── On-demand AI narrative for any of the five agents above — not called
  //    automatically on load, so the base dashboard stays real-time/instant. ──
  const SECTION_ENDPOINT = { pnl: 'pnl', cashflow: 'cashflow', aging: 'aging', customeraging: 'customer-aging', workingcapital: 'working-capital', overview: 'overview' };
  const NO_PERIOD_SECTIONS = new Set(['aging', 'customeraging']);
  router.get('/finance/insight', requireAuth, async (req, res) => {
    if (!requireDb(res)) return;
    try {
      const section = SECTION_ENDPOINT[req.query.section] ? req.query.section : 'pnl';
      const period   = section === 'overview'
        ? (GL_PERIODS.includes(req.query.period) ? req.query.period : 'ytd')
        : (VALID_PERIODS.includes(req.query.period) ? req.query.period : 'mtd');
      const base     = `http://127.0.0.1:${process.env.PORT || 3000}`;
      const endpoint = SECTION_ENDPOINT[section];
      let url;
      if (section === 'customeraging') {
        const qs = new URLSearchParams();
        if (req.query.dateBasis) qs.set('dateBasis', req.query.dateBasis);
        if (req.query.buckets)   qs.set('buckets', req.query.buckets);
        url = `${base}/api/finance/${endpoint}${qs.toString() ? '?' + qs.toString() : ''}`;
      } else {
        url = NO_PERIOD_SECTIONS.has(section) ? `${base}/api/finance/${endpoint}` : `${base}/api/finance/${endpoint}?period=${period}`;
      }
      const dataRes  = await fetch(url, { headers: { 'x-auth-token': req.headers['x-auth-token'] || '' } });
      const data = await dataRes.json();
      if (data.error) return res.status(503).json({ error: data.error });

      const prompts = {
        pnl: () => `You are a financial analyst. Given this trading P&L snapshot (period=${period}): Revenue=${data.revenue}, COGS=${data.cogs}, Gross Profit=${data.grossProfit} (${data.gpPercent.toFixed(2)}%), Expenses (AP)=${data.expenses}, Net Proxy=${data.netProxy}. Write a 2-3 sentence business insight — highlight the margin, and flag anything concerning. Plain text, no markdown headers.`,
        cashflow: () => `You are a financial analyst. Given this cash flow/liquidity snapshot (period=${period}): Cash In=${data.cashIn}, Cash Out=${data.cashOut}, Net Cash Flow=${data.netCashFlow}, AR Outstanding=${data.arOutstanding}, AP Outstanding=${data.apOutstanding}, Net Position=${data.netPosition}, Receivables/Payables Ratio=${data.receivablesToPayablesRatio}. Write a 2-3 sentence business insight — highlight liquidity health, and flag anything concerning. Plain text, no markdown headers.`,
        aging: () => `You are a financial analyst. Given this AR/AP aging snapshot: AR total=${data.arTotal} (overdue=${data.arOverdue}), AP total=${data.apTotal} (overdue=${data.apOverdue}), AR buckets=${JSON.stringify(data.ar)}, AP buckets=${JSON.stringify(data.ap)}. Write a 2-3 sentence business insight — highlight collections risk and payables pressure, and flag anything concerning. Plain text, no markdown headers.`,
        customeraging: () => `You are a financial analyst. Given this per-customer AR aging breakdown (date basis: ${data.dateBasis === 'doc' ? 'document date' : 'due date'}; buckets: ${JSON.stringify(data.bucketLabels)}; total AR balance=${data.totals?.grandTotal}, overdue=${data.totals?.overdueTotal}; top rows by outstanding balance, each as [CardCode, CardName, amounts per bucket in order, total]): ${JSON.stringify((data.summary || []).slice(0, 15).map(r => [r.CardCode, r.CardName, r.buckets, r.total]))}. Write a 2-3 sentence business insight — call out the customers with the largest overdue exposure by name, and flag anything concerning. Plain text, no markdown headers.`,
        overview: () => {
          const r = v => (typeof v === 'number' ? Math.round(v) : v);
          const pick = o => o && Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'number' ? Math.round(v * 100) / 100 : v]));
          return `You are the CFO's analyst. General-ledger figures for ${data.periods.cur.label} (${data.periods.label}), compared with ${data.periods.prev ? data.periods.prev.label + ' and ' : ''}${data.periods.ly.label}.
P&L current: ${JSON.stringify(pick(data.pnl.cur))}
P&L last year: ${JSON.stringify(pick(data.pnl.ly))}${data.pnl.prev ? `
P&L previous period: ${JSON.stringify(pick(data.pnl.prev))}` : ''}
Balance sheet at ${data.periods.balanceDate}: ${JSON.stringify(pick(data.balance.end))}
Ratios (TTM): DSO=${r(data.ratios.dso)}, DPO=${r(data.ratios.dpo)}, DIO=${r(data.ratios.dio)}, CCC=${r(data.ratios.ccc)}, ROE%=${r(data.ratios.roe)}, ROA%=${r(data.ratios.roa)}
Cash flow: ${JSON.stringify(pick(data.cashFlow.cur))}
Top expense groups (current vs last year): ${JSON.stringify(data.expenseGroups.slice(0, 6).map(e => [e.group, r(e.cur), r(e.ly)]))}
Last 4 months revenue: ${JSON.stringify(data.trend.slice(-4).map(t => [t.month, r(t.revenue)]))}
Write 4-5 short bullet points (plain text, each starting with "• ") for a CFO: profitability and margin movement vs last year with the main driver, the biggest cost change, liquidity/working capital, and one risk. If the latest month's revenue is far below the months before it, say it is probably not fully posted yet rather than calling it a collapse. Only use the numbers given; round to K/M.`;
        },
        workingcapital: () => `You are a financial analyst. Given this working capital snapshot (period=${period}): AR Outstanding=${data.arOutstanding}, AP Outstanding=${data.apOutstanding}, Inventory Value=${data.inventoryValue}, Current Ratio=${data.currentRatio}, Quick Ratio=${data.quickRatio}, DSO=${data.dso}, DPO=${data.dpo}. Write a 2-3 sentence business insight — highlight liquidity/solvency health, and flag anything concerning. Plain text, no markdown headers.`,
      };

      const insight = await callAI([{ role: 'user', content: prompts[section]() }], section === 'overview' ? 600 : 300);
      res.json({ section, period, insight: insight.trim(), data });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  return router;
}
