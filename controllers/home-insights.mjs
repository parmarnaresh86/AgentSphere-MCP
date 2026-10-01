/**
 * Home Insights — live KPIs for the launchpad's "My Home" page
 * (public/launchpad.html). Every figure is a small aggregate run directly
 * against HANA/MSSQL, and each block is gated by the caller's effective
 * permissions so a user only receives the areas they can open anyway.
 *
 *   GET /api/home/insights
 *     sales        — invoiced sales (excl. tax) by month for 12 months, MTD vs
 *                    the same days last month, top 5 customers + items this year
 *     purchases    — AP invoices, same shape as sales, top 5 vendors this year
 *     openQuotes   — open sales quotations: count, value, past valid-until date
 *     cash         — incoming vs outgoing payments by month for 6 months
 *     orders       — open sales orders / purchase orders / quotations: count, value, late
 *     inventory    — stock book value, items below minimum level
 *     finance      — GL-based CFO figures (buildGlOverview, fiscal YTD vs the
 *                    same period last year): P&L, balance sheet, cash, ratios,
 *                    13-month trend, expense groups, credit-limit breaches
 *
 *   GET /api/home/insights/detail?key=<DETAIL key>
 *     — the rows behind one card or alert, shown as a pop-up table on the
 *       home page (for insights that have no transaction screen of their own,
 *       and as a quick look before opening the one that does).
 *
 * Access: every block, finance sub-area and drill-down list is gated by its
 * own 'insights.*' permission key (section "Home Insights" in Roles &
 * Permissions / User Rights — see ALL_PERMISSIONS in db.mjs).
 *
 * Blocks run independently: a query that fails on one schema drops only its
 * block (reported in `errors`) instead of failing the whole page.
 */
import { Router } from 'express';
import { userPermRepo } from '../db.mjs';
import { executeSQL, isConnected, getActiveType, getActiveConfig, tableRef } from '../db-connector.mjs';
import { buildGlOverview } from './financial-agent.mjs';

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const num = v => Number(v || 0);
const DETAIL_LIMIT = 500;

// The GL overview feeds the finance block and several drill-downs; a short memo
// keeps a home-page load plus a few clicks from re-aggregating the ledger.
let glMemo = null;
async function glOverview() {
  if (glMemo && Date.now() - glMemo.at < 60000) return glMemo.value;
  const value = await buildGlOverview('ytd');
  glMemo = { at: Date.now(), value };
  return value;
}
const pctChange = (cur, ly) => (ly ? ((cur - ly) / Math.abs(ly)) * 100 : null);
const AGING_LIMIT = 5000;   // aging lists are reconciled against the card total, so keep them whole

// Month slots oldest → newest, ending with the current month.
function monthSlots(n, now) {
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    out.push({ y: d.getFullYear(), m: d.getMonth() + 1, label: MON[d.getMonth()] });
  }
  return out;
}
const fillSlots = (slots, rows, key = 'Amt') => slots.map(s => {
  const r = rows.find(x => num(x.Y) === s.y && num(x.M) === s.m);
  return { label: s.label, y: s.y, m: s.m, amount: r ? num(r[key]) : 0 };
});

// Dialect helpers + the date anchors every query shares.
function sqlContext() {
  const dbType = getActiveType(), cfg = getActiveConfig();
  const now = new Date();
  const slots12 = monthSlots(12, now), slots6 = monthSlots(6, now);
  const first = s => `${s.y}-${String(s.m).padStart(2, '0')}-01`;
  return {
    now, slots12, slots6,
    T: t => tableRef(t, cfg),
    D: s => (dbType === 'hana' ? `TO_DATE('${s}')` : `CAST('${s}' AS DATE)`),
    NF: dbType === 'hana' ? 'IFNULL' : 'ISNULL',
    top: (n, sql) => (dbType === 'hana' ? `SELECT ${sql} LIMIT ${n}` : `SELECT TOP ${n} ${sql}`),
    days: (from, to) => (dbType === 'hana' ? `DAYS_BETWEEN(${from}, ${to})` : `DATEDIFF(DAY, ${from}, ${to})`),
    today: iso(now),
    monthStart: iso(new Date(now.getFullYear(), now.getMonth(), 1)),
    prevStart: iso(new Date(now.getFullYear(), now.getMonth() - 1, 1)),
    // Same day-of-month last month, clamped (e.g. 31 Mar → 28/29 Feb).
    prevSameDay: iso(new Date(now.getFullYear(), now.getMonth() - 1,
      Math.min(now.getDate(), new Date(now.getFullYear(), now.getMonth(), 0).getDate()))),
    yearStart: `${now.getFullYear()}-01-01`,
    from12: first(slots12[0]), from6: first(slots6[0]),
  };
}

// can('finance.pnl') → the user holds 'insights.finance.pnl'.
function permsOf(user) {
  const perms = new Set(userPermRepo.getEffective(user.user_id, user.role));
  return key => perms.has('insights.' + key);
}

// Payment cancel-flag casing differs between installs (Canceled vs CANCELED):
// try the standard one, fall back to no filter rather than failing.
async function withCancelFallback(build) {
  try { return await executeSQL(build(`T0."Canceled" = 'N'`)); }
  catch { return executeSQL(build('1=1')); }
}

/* ───────────────────────── detail (drill-down) queries ─────────────────────────
   Each entry: area (permission), title, sub, cols [{k, label, type}], sql(ctx).
   type: text | date | money | qty | int — the page formats by type.         */
const NET = `(T0."DocTotal" - T0."VatSum")`;
const OPEN_BAL = `(T0."DocTotal" - T0."PaidToDate")`;
const docCols = (party) => [
  { k: 'DocNum', label: 'Doc no.', type: 'text' }, { k: 'DocDate', label: 'Date', type: 'date' },
  { k: 'CardCode', label: `${party} code`, type: 'text' }, { k: 'CardName', label: party, type: 'text' },
];
const lateCols = (party) => [
  ...docCols(party), { k: 'DocDueDate', label: 'Due date', type: 'date' },
  { k: 'DaysLate', label: 'Days late', type: 'int' }, { k: 'Amount', label: 'Value (excl. tax)', type: 'money' },
];
const openDocsSql = (table, onlyLate) => c => c.top(DETAIL_LIMIT, `T0."DocNum" AS "DocNum", T0."DocDate" AS "DocDate", T0."CardCode" AS "CardCode", T0."CardName" AS "CardName",
  T0."DocDueDate" AS "DocDueDate", ${c.days('T0."DocDueDate"', c.D(c.today))} AS "DaysLate", ${NET} AS "Amount"
FROM ${c.T(table)} T0 WHERE T0."DocStatus" = 'O' AND T0."CANCELED" = 'N'${onlyLate ? ` AND T0."DocDueDate" < ${c.D(c.today)}` : ''}
ORDER BY T0."DocDueDate" ASC`);
const invoicesMtdSql = table => c => c.top(DETAIL_LIMIT, `T0."DocNum" AS "DocNum", T0."DocDate" AS "DocDate", T0."CardCode" AS "CardCode", T0."CardName" AS "CardName",
  ${NET} AS "Amount", ${OPEN_BAL} AS "Open", CASE WHEN T0."DocStatus" = 'O' THEN 'Open' ELSE 'Closed' END AS "Status"
FROM ${c.T(table)} T0 WHERE T0."CANCELED" = 'N' AND T0."DocDate" >= ${c.D(c.monthStart)}
ORDER BY T0."DocDate" DESC, T0."DocNum" DESC`);
// Overdue open items from JDT1 — the same source and bucketing as
// /api/finance/aging (invoices net of credit memos, payments on account and
// manual JEs), so the rows add up to the Receivables/Payables cards.
const AGING_TT = { '13': 'A/R Invoice', '14': 'A/R Credit Memo', '203': 'A/R Down Payment', '24': 'Incoming Payment',
  '18': 'A/P Invoice', '19': 'A/P Credit Memo', '204': 'A/P Down Payment', '46': 'Outgoing Payment',
  '30': 'Journal Entry', '-2': 'Opening Balance', '321': 'Internal Reconciliation' };
const agingCols = party => [
  { k: 'Type', label: 'Type', type: 'text' }, { k: 'DocNum', label: 'Ref.', type: 'text' }, { k: 'DocDate', label: 'Posted', type: 'date' },
  { k: 'CardCode', label: `${party} code`, type: 'text' }, { k: 'CardName', label: party, type: 'text' },
  { k: 'DocDueDate', label: 'Due date', type: 'date' }, { k: 'DaysLate', label: 'Days overdue', type: 'int' },
  { k: 'Amount', label: 'Open balance', type: 'money' },
];
const agingSql = (cardType, minDays) => c => {
  const due = `${c.NF}(J."DueDate", J."RefDate")`, days = c.days(due, c.D(c.today));
  const sign = cardType === 'S' ? '-' : '';
  return c.top(AGING_LIMIT, `J."TransType" AS "TransType", MAX(J."BaseRef") AS "DocNum", MAX(J."RefDate") AS "DocDate", J."ShortName" AS "CardCode",
  MAX(C."CardName") AS "CardName", ${due} AS "DocDueDate", ${days} AS "DaysLate", ${sign}SUM(J."BalDueDeb" - J."BalDueCred") AS "Amount"
FROM ${c.T('JDT1')} J INNER JOIN ${c.T('OCRD')} C ON C."CardCode" = J."ShortName"
WHERE C."CardType" = '${cardType}' AND (J."BalDueDeb" <> 0 OR J."BalDueCred" <> 0) AND ${days} >= ${minDays}
GROUP BY J."TransId", J."TransType", J."ShortName", ${due}
ORDER BY 7 DESC`);
};
const agingRow = r => ({ ...r, Type: AGING_TT[String(r.TransType)] || `TransType ${r.TransType}` });
const paymentsSql = table => c => withCancelFallback(cond => c.top(DETAIL_LIMIT, `T0."DocNum" AS "DocNum", T0."DocDate" AS "DocDate", T0."CardCode" AS "CardCode", T0."CardName" AS "CardName",
  T0."DocTotal" AS "Amount" FROM ${c.T(table)} T0 WHERE ${cond} AND T0."DocDate" >= ${c.D(c.monthStart)}
ORDER BY T0."DocDate" DESC, T0."DocNum" DESC`));
const topPartySql = (table) => c => c.top(50, `T0."CardCode" AS "CardCode", MAX(T0."CardName") AS "CardName", COUNT(*) AS "Docs", ${c.NF}(SUM(${NET}),0) AS "Amount"
FROM ${c.T(table)} T0 WHERE T0."CANCELED" = 'N' AND T0."DocDate" >= ${c.D(c.yearStart)}
GROUP BY T0."CardCode" ORDER BY 4 DESC`);
const itemCols = [
  { k: 'ItemCode', label: 'Item', type: 'text' }, { k: 'ItemName', label: 'Description', type: 'text' },
  { k: 'OnHand', label: 'In stock', type: 'qty' }, { k: 'IsCommited', label: 'Committed', type: 'qty' },
  { k: 'OnOrder', label: 'On order', type: 'qty' }, { k: 'MinLevel', label: 'Min. level', type: 'qty' },
  { k: 'Shortfall', label: 'Shortfall', type: 'qty' },
];
const itemsSql = cond => c => c.top(DETAIL_LIMIT, `T0."ItemCode" AS "ItemCode", T0."ItemName" AS "ItemName", T0."OnHand" AS "OnHand", T0."IsCommited" AS "IsCommited",
  T0."OnOrder" AS "OnOrder", T0."MinLevel" AS "MinLevel", (T0."MinLevel" - T0."OnHand") AS "Shortfall"
FROM ${c.T('OITM')} T0 WHERE T0."InvntItem" = 'Y' AND T0."MinLevel" > 0 AND ${cond}
ORDER BY 7 DESC`);

// GL-derived drill-downs: computed from the overview, no extra SQL.
const plCols = [
  { k: 'Section', label: 'Section', type: 'text' }, { k: 'Group', label: 'Group', type: 'text' },
  { k: 'Code', label: 'Account', type: 'text' }, { k: 'Name', label: 'Account name', type: 'text' },
  { k: 'Cur', label: 'This year (YTD)', type: 'money' }, { k: 'Ly', label: 'Same period last year', type: 'money' },
  { k: 'Chg', label: 'Change', type: 'pct' },
];
const SECTION_LABEL = { revenue: 'Revenue', cogs: 'Cost of sales', opex: 'Operating expenses', da: 'Depreciation & amortisation', interest: 'Interest', tax: 'Tax', other: 'Other income & expense' };
const plRowsOf = sections => async () => (await glOverview()).plRows
  .filter(r => !sections || sections.includes(r.section))
  .map(r => ({ Section: SECTION_LABEL[r.section] || r.section, Group: r.group, Code: r.code, Name: r.name, Cur: r.cur, Ly: r.ly, Chg: pctChange(r.cur, r.ly) }))
  .sort((a, b) => Math.abs(b.Cur || 0) - Math.abs(a.Cur || 0));
const bsCols = [
  { k: 'Drawer', label: 'Drawer', type: 'text' }, { k: 'Group', label: 'Group', type: 'text' },
  { k: 'Code', label: 'Account', type: 'text' }, { k: 'Name', label: 'Account name', type: 'text' },
  { k: 'End', label: 'Balance now', type: 'money' }, { k: 'Ly', label: 'Balance a year ago', type: 'money' }, { k: 'Chg', label: 'Change', type: 'pct' },
];
const bsRowsOf = keep => async () => (await glOverview()).bsRows.filter(keep)
  .map(r => ({ Drawer: r.drawer, Group: r.group, Code: r.code, Name: r.name, End: r.end, Ly: r.lyEnd, Chg: pctChange(r.end, r.lyEnd) }))
  .sort((a, b) => Math.abs(b.End || 0) - Math.abs(a.End || 0));
const ratioRows = async () => {
  const o = await glOverview(), b = o.balance.end, l = o.balance.ly || {}, r = o.ratios, d = o.definitions || {};
  const ok = v => v != null && isFinite(v);
  const x = v => (ok(v) ? v.toFixed(2) + '×' : '—'), dd = v => (ok(v) ? Math.round(v) + ' days' : '—'), p = v => (ok(v) ? v.toFixed(1) + '%' : '—');
  return [
    ['Current ratio', x(b.currentRatio), x(l.currentRatio), 'Current assets ÷ current liabilities'],
    ['Quick ratio', x(b.quickRatio), x(l.quickRatio), '(Current assets − inventory) ÷ current liabilities'],
    ['Cash ratio', x(b.cashRatio), x(l.cashRatio), 'Cash ÷ current liabilities'],
    ['Liabilities to equity', x(b.liabilitiesToEquity), x(l.liabilitiesToEquity), 'Total liabilities ÷ equity'],
    ['Debt to equity', x(b.debtToEquity), x(l.debtToEquity), 'Loans ÷ equity'],
    ['DSO', dd(r.dso), '—', d.dso || 'AR ÷ revenue (TTM) × days'],
    ['DPO', dd(r.dpo), '—', d.dpo || 'AP ÷ COGS (TTM) × days'],
    ['DIO', dd(r.dio), '—', d.dio || 'Inventory ÷ COGS (TTM) × days'],
    ['Cash conversion cycle', dd(r.ccc), '—', d.ccc || 'DSO + DIO − DPO'],
    ['Return on equity', p(r.roe), '—', 'Net profit (TTM) ÷ equity'],
    ['Return on assets', p(r.roa), '—', 'Net profit (TTM) ÷ total assets'],
    ['Asset turnover', x(r.assetTurnover), '—', 'Revenue (TTM) ÷ total assets'],
    ['Interest coverage', x(r.interestCoverage), '—', 'EBIT ÷ interest expense'],
  ].map(([Metric, Value, Ly, Def]) => ({ Metric, Value, Ly, Def }));
};

const DETAIL = {
  'fin-pl':          { perm: 'finance.pnl', title: 'Profit & loss by account', sub: 'General ledger, fiscal year to date vs the same period last year', cols: plCols, build: plRowsOf(null) },
  'fin-revenue':     { perm: 'finance.pnl', title: 'Revenue accounts', sub: 'Revenue and contra-revenue, fiscal YTD vs last year', cols: plCols, build: plRowsOf(['revenue']) },
  'fin-cogs':        { perm: 'finance.pnl', title: 'Cost of sales accounts', sub: 'Fiscal YTD vs last year', cols: plCols, build: plRowsOf(['cogs']) },
  'fin-opex':        { perm: 'finance.pnl', title: 'Operating expense accounts', sub: 'Incl. depreciation, fiscal YTD vs last year', cols: plCols, build: plRowsOf(['opex', 'da']) },
  'fin-tax':         { perm: 'finance.pnl', title: 'Tax and interest accounts', sub: 'Fiscal YTD vs last year', cols: plCols, build: plRowsOf(['tax', 'interest']) },
  'fin-expense-groups': { perm: 'finance.pnl', title: 'Expenses by group', sub: 'Operating expense groups, fiscal YTD vs last year',
    cols: [{ k: 'Group', label: 'Expense group', type: 'text' }, { k: 'Cur', label: 'This year (YTD)', type: 'money' }, { k: 'Ly', label: 'Same period last year', type: 'money' },
      { k: 'Chg', label: 'Change', type: 'pct' }, { k: 'Share', label: 'Share of opex', type: 'pct' }],
    build: async () => {
      const o = await glOverview(), tot = o.expenseGroups.reduce((a, g) => a + g.cur, 0);
      return o.expenseGroups.map(g => ({ Group: g.group, Cur: g.cur, Ly: g.ly, Chg: pctChange(g.cur, g.ly), Share: tot ? g.cur / tot * 100 : null }));
    } },
  'fin-bs':          { perm: 'finance.balance', title: 'Balance sheet by account', sub: 'Balances today vs a year ago', cols: bsCols, build: bsRowsOf(r => r.end || r.lyEnd) },
  'fin-cash-accounts': { perm: 'finance.cash', title: 'Cash & bank accounts', sub: 'GL balance per account, today vs a year ago', cols: bsCols, build: bsRowsOf(r => r.kind === 'cash') },
  'fin-wc':          { perm: 'finance.balance', title: 'Working capital accounts', sub: 'Current assets and current liabilities', cols: bsCols, build: bsRowsOf(r => r.cls === 'current' && (r.end || r.lyEnd)) },
  'fin-trend':       { perm: 'finance.pnl', title: 'Monthly financial trend', sub: 'General ledger, last 13 months, newest first (current month partial)',
    cols: [{ k: 'Month', label: 'Month', type: 'text' }, { k: 'Revenue', label: 'Revenue', type: 'money' }, { k: 'GrossProfit', label: 'Gross profit', type: 'money' },
      { k: 'Opex', label: 'Opex', type: 'money' }, { k: 'Ebitda', label: 'EBITDA', type: 'money' }, { k: 'NetProfit', label: 'Net profit', type: 'money' },
      { k: 'NetMargin', label: 'Net margin', type: 'pct' }, { k: 'Cash', label: 'Cash (month end)', type: 'money', perm: 'finance.cash' },
      { k: 'Ar', label: 'Receivables', type: 'money', perm: 'finance.receivables' }, { k: 'Ap', label: 'Payables', type: 'money', perm: 'finance.payables' },
      { k: 'Inventory', label: 'Inventory', type: 'money', perm: 'finance.balance' }],
    build: async () => (await glOverview()).trend.map(m => ({ Month: m.month + (m.partial ? ' (partial)' : ''), Revenue: m.revenue, GrossProfit: m.grossProfit, Opex: m.opex,
      Ebitda: m.ebitda, NetProfit: m.netProfit, NetMargin: m.partial ? null : m.netMarginPct, Cash: m.cash, Ar: m.ar, Ap: m.ap, Inventory: m.inventory })).reverse() },
  'fin-ratios':      { perm: 'finance.ratios', title: 'Financial ratios', sub: 'Balances today; flow ratios on the trailing 12 months',
    cols: [{ k: 'Metric', label: 'Metric', type: 'text' }, { k: 'Value', label: 'Now', type: 'text' }, { k: 'Ly', label: 'A year ago', type: 'text' }, { k: 'Def', label: 'How it is calculated', type: 'text' }],
    build: ratioRows },
  'fin-credit-limit': { perm: 'finance.receivables', title: 'Customers over credit limit', sub: 'Account balance above the credit limit set on the customer',
    cols: [{ k: 'CardCode', label: 'Code', type: 'text' }, { k: 'CardName', label: 'Customer', type: 'text' }, { k: 'CreditLine', label: 'Credit limit', type: 'money' },
      { k: 'Balance', label: 'Balance', type: 'money' }, { k: 'Over', label: 'Over by', type: 'money' }, { k: 'Usage', label: 'Limit used', type: 'pct' }],
    sql: c => c.top(DETAIL_LIMIT, `T0."CardCode" AS "CardCode", T0."CardName" AS "CardName", T0."CreditLine" AS "CreditLine", T0."Balance" AS "Balance",
  (T0."Balance" - T0."CreditLine") AS "Over"
FROM ${c.T('OCRD')} T0 WHERE T0."CardType" = 'C' AND T0."CreditLine" > 0 AND T0."Balance" > T0."CreditLine"
ORDER BY 5 DESC`),
    // Computed here: on HANA the SQL ratio came back 100x too small (1.75 for 175%).
    map: r => ({ ...r, Usage: num(r.CreditLine) ? num(r.Balance) / num(r.CreditLine) * 100 : null }) },
  'sales-mtd':      { perm: 'sales.trend', title: 'Sales invoices this month', sub: 'AR invoices since the 1st, excl. tax',
    cols: [...docCols('Customer'), { k: 'Amount', label: 'Value (excl. tax)', type: 'money' }, { k: 'Open', label: 'Open balance', type: 'money' }, { k: 'Status', label: 'Status', type: 'text' }],
    sql: invoicesMtdSql('OINV') },
  'purchases-mtd':  { perm: 'purchase.trend', title: 'Purchase invoices this month', sub: 'AP invoices since the 1st, excl. tax',
    cols: [...docCols('Vendor'), { k: 'Amount', label: 'Value (excl. tax)', type: 'money' }, { k: 'Open', label: 'Open balance', type: 'money' }, { k: 'Status', label: 'Status', type: 'text' }],
    sql: invoicesMtdSql('OPCH') },
  'top-customers':  { perm: 'sales.top_customers', title: 'Top customers this year', sub: 'Invoiced sales excl. tax, top 50',
    cols: [{ k: 'CardCode', label: 'Code', type: 'text' }, { k: 'CardName', label: 'Customer', type: 'text' }, { k: 'Docs', label: 'Invoices', type: 'int' }, { k: 'Amount', label: 'Sales', type: 'money' }],
    sql: topPartySql('OINV') },
  'top-vendors':    { perm: 'purchase.top_vendors', title: 'Top vendors this year', sub: 'AP invoices excl. tax, top 50',
    cols: [{ k: 'CardCode', label: 'Code', type: 'text' }, { k: 'CardName', label: 'Vendor', type: 'text' }, { k: 'Docs', label: 'Invoices', type: 'int' }, { k: 'Amount', label: 'Spend', type: 'money' }],
    sql: topPartySql('OPCH') },
  'top-items':      { perm: 'sales.top_items', title: 'Top selling items this year', sub: 'Invoice lines, top 50 by value',
    cols: [{ k: 'ItemCode', label: 'Item', type: 'text' }, { k: 'ItemName', label: 'Description', type: 'text' }, { k: 'Qty', label: 'Qty sold', type: 'qty' }, { k: 'Amount', label: 'Sales', type: 'money' }, { k: 'GP', label: 'Gross profit', type: 'money' }],
    sql: c => c.top(50, `T1."ItemCode" AS "ItemCode", MAX(T1."Dscription") AS "ItemName", ${c.NF}(SUM(T1."Quantity"),0) AS "Qty",
  ${c.NF}(SUM(T1."LineTotal"),0) AS "Amount", ${c.NF}(SUM(T1."GrssProfit"),0) AS "GP"
FROM ${c.T('OINV')} T0 INNER JOIN ${c.T('INV1')} T1 ON T0."DocEntry" = T1."DocEntry"
WHERE T0."CANCELED" = 'N' AND T0."DocDate" >= ${c.D(c.yearStart)} AND T1."ItemCode" IS NOT NULL
GROUP BY T1."ItemCode" ORDER BY 4 DESC`) },
  'open-quotes':    { perm: 'sales.quotations', title: 'Open sales quotations', sub: 'Oldest valid-until date first',
    cols: [...docCols('Customer'), { k: 'DocDueDate', label: 'Valid until', type: 'date' }, { k: 'DaysLate', label: 'Days expired', type: 'int' }, { k: 'Amount', label: 'Value (excl. tax)', type: 'money' }],
    sql: openDocsSql('OQUT', false) },
  'expired-quotes': { perm: 'sales.quotations', title: 'Expired open quotations', sub: 'Still open past their valid-until date',
    cols: [...docCols('Customer'), { k: 'DocDueDate', label: 'Valid until', type: 'date' }, { k: 'DaysLate', label: 'Days expired', type: 'int' }, { k: 'Amount', label: 'Value (excl. tax)', type: 'money' }],
    sql: openDocsSql('OQUT', true) },
  'open-so':        { perm: 'sales.orders', title: 'Open sales orders', sub: 'Earliest due date first', cols: lateCols('Customer'), sql: openDocsSql('ORDR', false) },
  'late-so':        { perm: 'sales.orders', title: 'Sales orders past due', sub: 'Open orders past their delivery date', cols: lateCols('Customer'), sql: openDocsSql('ORDR', true) },
  'open-po':        { perm: 'purchase.orders', title: 'Open purchase orders', sub: 'Earliest due date first', cols: lateCols('Vendor'), sql: openDocsSql('OPOR', false) },
  'late-po':        { perm: 'purchase.orders', title: 'Purchase orders past due', sub: 'Open POs past their delivery date', cols: lateCols('Vendor'), sql: openDocsSql('OPOR', true) },
  'cash-in':        { perm: 'finance.cash', title: 'Incoming payments this month', sub: 'Customer receipts since the 1st',
    cols: [...docCols('Customer'), { k: 'Amount', label: 'Amount', type: 'money' }], sql: paymentsSql('ORCT') },
  'cash-out':       { perm: 'finance.cash', title: 'Outgoing payments this month', sub: 'Vendor payments since the 1st',
    cols: [...docCols('Vendor'), { k: 'Amount', label: 'Amount', type: 'money' }], sql: paymentsSql('OVPM') },
  'ar-overdue':     { perm: 'finance.receivables', title: 'Overdue receivables', sub: 'Open items past due (invoices net of credits and payments on account), most overdue first',
    cols: agingCols('Customer'), sql: agingSql('C', 1), map: agingRow, limit: AGING_LIMIT },
  'ar-90':          { perm: 'finance.receivables', title: 'Receivables 90+ days overdue', sub: 'Open items 91 days or more past due, incl. unapplied credits',
    cols: agingCols('Customer'), sql: agingSql('C', 91), map: agingRow, limit: AGING_LIMIT },
  'ap-overdue':     { perm: 'finance.payables', title: 'Overdue payables', sub: 'Open items past due (invoices net of credits and payments on account), most overdue first',
    cols: agingCols('Vendor'), sql: agingSql('S', 1), map: agingRow, limit: AGING_LIMIT },
  'below-min':      { perm: 'inventory.stock', title: 'Items below minimum stock', sub: 'Largest shortfall first', cols: itemCols, sql: itemsSql(`T0."OnHand" < T0."MinLevel"`) },
  'out-of-stock':   { perm: 'inventory.stock', title: 'Out-of-stock items', sub: 'Items with a minimum level and nothing in stock', cols: itemCols, sql: itemsSql(`T0."OnHand" <= 0`) },
  'stock-value':    { perm: 'inventory.stock', title: 'Stock value by item', sub: 'Book value across warehouses, top 100',
    cols: [{ k: 'ItemCode', label: 'Item', type: 'text' }, { k: 'ItemName', label: 'Description', type: 'text' }, { k: 'OnHand', label: 'In stock', type: 'qty' }, { k: 'Value', label: 'Stock value', type: 'money' }],
    sql: c => c.top(100, `T0."ItemCode" AS "ItemCode", MAX(T1."ItemName") AS "ItemName", SUM(T0."OnHand") AS "OnHand", SUM(T0."StockValue") AS "Value"
FROM ${c.T('OITW')} T0 INNER JOIN ${c.T('OITM')} T1 ON T0."ItemCode" = T1."ItemCode" WHERE T0."OnHand" > 0
GROUP BY T0."ItemCode" ORDER BY 4 DESC`) },
};

export function createHomeInsightsRouter({ requireAuth }) {
  const router = Router();

  router.get('/home/insights', requireAuth, async (req, res) => {
    if (!isConnected()) return res.json({ connected: false });
    const can = permsOf(req.user);
    const c = sqlContext();
    const { T, D, NF, top } = c;

    // Monthly net (excl. tax) totals + MTD vs same days last month for one doc table.
    async function docTrend(table) {
      const [months, cmp] = await Promise.all([
        executeSQL(`SELECT YEAR(T0."DocDate") AS "Y", MONTH(T0."DocDate") AS "M", ${NF}(SUM(${NET}),0) AS "Amt", COUNT(*) AS "Cnt"
FROM ${T(table)} T0 WHERE T0."CANCELED" = 'N' AND T0."DocDate" >= ${D(c.from12)}
GROUP BY YEAR(T0."DocDate"), MONTH(T0."DocDate")`),
        executeSQL(`SELECT
  ${NF}(SUM(CASE WHEN T0."DocDate" >= ${D(c.monthStart)} THEN ${NET} ELSE 0 END),0) AS "Mtd",
  ${NF}(SUM(CASE WHEN T0."DocDate" < ${D(c.monthStart)} AND T0."DocDate" <= ${D(c.prevSameDay)} THEN ${NET} ELSE 0 END),0) AS "PrevMtd",
  SUM(CASE WHEN T0."DocDate" >= ${D(c.monthStart)} THEN 1 ELSE 0 END) AS "MtdCnt"
FROM ${T(table)} T0 WHERE T0."CANCELED" = 'N' AND T0."DocDate" >= ${D(c.prevStart)}`),
      ]);
      const mtd = num(cmp[0]?.Mtd), prevMtd = num(cmp[0]?.PrevMtd);
      return {
        months: fillSlots(c.slots12, months),
        mtd, prevMtd, mtdCount: num(cmp[0]?.MtdCnt),
        changePct: prevMtd ? ((mtd - prevMtd) / Math.abs(prevMtd)) * 100 : null,
      };
    }

    async function openDocs(table) {
      const r = await executeSQL(`SELECT COUNT(*) AS "Cnt", ${NF}(SUM(${NET}),0) AS "Amt",
  SUM(CASE WHEN T0."DocDueDate" < ${D(c.today)} THEN 1 ELSE 0 END) AS "Late",
  ${NF}(SUM(CASE WHEN T0."DocDueDate" < ${D(c.today)} THEN ${NET} ELSE 0 END),0) AS "LateAmt"
FROM ${T(table)} T0 WHERE T0."DocStatus" = 'O' AND T0."CANCELED" = 'N'`);
      return { count: num(r[0]?.Cnt), amount: num(r[0]?.Amt), late: num(r[0]?.Late), lateAmount: num(r[0]?.LateAmt) };
    }

    const topParties = async table => (await executeSQL(top(5, `T0."CardCode" AS "Code", MAX(T0."CardName") AS "Name", ${NF}(SUM(${NET}),0) AS "Amt"
FROM ${T(table)} T0 WHERE T0."CANCELED" = 'N' AND T0."DocDate" >= ${D(c.yearStart)}
GROUP BY T0."CardCode" ORDER BY 3 DESC`))).map(r => ({ code: r.Code, name: r.Name || r.Code, amount: num(r.Amt) }));

    const payMonths = async table => fillSlots(c.slots6, await withCancelFallback(cond =>
      `SELECT YEAR(T0."DocDate") AS "Y", MONTH(T0."DocDate") AS "M", ${NF}(SUM(T0."DocTotal"),0) AS "Amt"
FROM ${T(table)} T0 WHERE ${cond} AND T0."DocDate" >= ${D(c.from6)} GROUP BY YEAR(T0."DocDate"), MONTH(T0."DocDate")`));

    const jobs = {};
    if (can('sales.trend')) jobs.sales = () => docTrend('OINV');
    if (can('sales.top_customers')) jobs.topCustomers = () => topParties('OINV');
    if (can('sales.top_items')) jobs.topItems = async () => (await executeSQL(top(5, `T1."ItemCode" AS "Code", MAX(T1."Dscription") AS "Name", ${NF}(SUM(T1."LineTotal"),0) AS "Amt"
FROM ${T('OINV')} T0 INNER JOIN ${T('INV1')} T1 ON T0."DocEntry" = T1."DocEntry"
WHERE T0."CANCELED" = 'N' AND T0."DocDate" >= ${D(c.yearStart)} AND T1."ItemCode" IS NOT NULL
GROUP BY T1."ItemCode" ORDER BY 3 DESC`))).map(r => ({ code: r.Code, name: r.Name || r.Code, amount: num(r.Amt) }));
    if (can('sales.orders')) jobs.openSalesOrders = () => openDocs('ORDR');
    if (can('sales.quotations')) jobs.openQuotes = () => openDocs('OQUT');
    if (can('purchase.trend')) jobs.purchases = () => docTrend('OPCH');
    if (can('purchase.top_vendors')) jobs.topVendors = () => topParties('OPCH');
    if (can('purchase.orders')) jobs.openPurchaseOrders = () => openDocs('OPOR');
    if (can('finance.cash')) {
      jobs.cash = async () => {
        const [cashIn, cashOut] = await Promise.all([payMonths('ORCT'), payMonths('OVPM')]);
        return {
          months: c.slots6.map((s, i) => ({ label: s.label, in: cashIn[i].amount, out: cashOut[i].amount })),
          mtdIn: cashIn.at(-1).amount, mtdOut: cashOut.at(-1).amount,
        };
      };
    }
    // Finance: one GL overview, but each sub-area's figures are only sent to
    // holders of its key, so a P&L-only user never receives balance sheet data.
    const FIN = ['pnl', 'cash', 'balance', 'ratios', 'receivables', 'payables'].filter(k => can('finance.' + k));
    if (FIN.length) {
      jobs.finance = async () => {
        const has = k => FIN.includes(k);
        const [o, cl] = await Promise.all([
          glOverview(),
          has('receivables') ? executeSQL(`SELECT COUNT(*) AS "N", ${NF}(SUM(T0."Balance" - T0."CreditLine"),0) AS "Over"
FROM ${T('OCRD')} T0 WHERE T0."CardType" = 'C' AND T0."CreditLine" > 0 AND T0."Balance" > T0."CreditLine"`) : null,
        ]);
        const pick = (src, keys) => Object.fromEntries(keys.map(k => [k, src?.[k] ?? null]));
        const BS = [...(has('cash') ? ['cash'] : []), ...(has('receivables') ? ['ar'] : []), ...(has('payables') ? ['ap'] : []),
          ...(has('balance') ? ['inventory', 'totalAssets', 'totalLiabilities', 'equity', 'workingCapital'] : []),
          ...(has('ratios') ? ['currentRatio', 'quickRatio', 'cashRatio', 'liabilitiesToEquity'] : [])];
        const out = {
          allow: Object.fromEntries(FIN.map(k => [k, true])),
          period: o.periods?.label, curLabel: o.periods?.cur?.label, lyLabel: o.periods?.ly?.label,
          balance: pick(o.balance.end, BS), balanceLy: pick(o.balance.ly, BS),
        };
        if (has('pnl')) {
          const PL = ['revenue', 'cogs', 'grossProfit', 'grossMarginPct', 'opex', 'opexPct', 'ebitda', 'ebitdaMarginPct', 'netProfit', 'netMarginPct', 'tax'];
          Object.assign(out, {
            pnl: pick(o.pnl.cur, PL), pnlLy: pick(o.pnl.ly, PL),
            trend: o.trend.map(m => ({ month: m.month, partial: !!m.partial, revenue: m.revenue, netProfit: m.netProfit })),
            expenseGroups: o.expenseGroups.slice(0, 6).map(g => ({ group: g.group, cur: g.cur, ly: g.ly })),
          });
        }
        if (has('cash')) Object.assign(out, {
          cashFlow: pick(o.cashFlow.cur, ['inflow', 'outflow', 'net', 'opening', 'closing']), cashFlowLy: pick(o.cashFlow.ly, ['inflow', 'outflow', 'net']),
          cashTrend: o.trend.map(m => ({ month: m.month, cash: m.cash })),
        });
        if (has('ratios')) out.ratios = pick(o.ratios, ['dso', 'dpo', 'dio', 'ccc', 'roe', 'roa', 'assetTurnover', 'interestCoverage']);
        if (cl) out.creditLimit = { count: num(cl[0]?.N), over: num(cl[0]?.Over) };
        return out;
      };
    }
    if (can('inventory.stock')) {
      jobs.inventory = async () => {
        const [val, low] = await Promise.all([
          // Warehouse StockValue is the book value; OITM.AvgPrice is 0 when costing is per warehouse.
          executeSQL(`SELECT ${NF}(SUM(T0."StockValue"),0) AS "Val", COUNT(DISTINCT T0."ItemCode") AS "Items"
FROM ${T('OITW')} T0 WHERE T0."OnHand" > 0`),
          executeSQL(`SELECT SUM(CASE WHEN T0."OnHand" < T0."MinLevel" THEN 1 ELSE 0 END) AS "Low",
  SUM(CASE WHEN T0."OnHand" <= 0 THEN 1 ELSE 0 END) AS "Out"
FROM ${T('OITM')} T0 WHERE T0."InvntItem" = 'Y' AND T0."MinLevel" > 0`),
        ]);
        return {
          value: num(val[0]?.Val), itemsInStock: num(val[0]?.Items),
          belowMin: num(low[0]?.Low), outOfStock: num(low[0]?.Out),
        };
      };
    }

    const keys = Object.keys(jobs);
    const results = await Promise.allSettled(keys.map(k => jobs[k]()));
    const out = { connected: true, generatedAt: c.now.toISOString(), errors: {} };
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') out[keys[i]] = r.value;
      else out.errors[keys[i]] = r.reason?.message || String(r.reason);
    });
    res.json(out);
  });

  router.get('/home/insights/detail', requireAuth, async (req, res) => {
    const def = DETAIL[String(req.query.key || '')];
    if (!def) return res.status(404).json({ error: 'Unknown insight' });
    const can = permsOf(req.user);
    if (!can(def.perm)) return res.status(403).json({ error: 'You do not have access to this insight' });
    if (!isConnected()) return res.status(503).json({ error: 'No direct database connection is active.' });
    try {
      let raw;
      if (def.build) raw = await def.build();
      else { const sql = def.sql(sqlContext()); raw = typeof sql === 'string' ? await executeSQL(sql) : await sql; }
      const rows = def.map ? raw.map(def.map) : raw;
      const cols = def.cols.filter(col => !col.perm || can(col.perm));
      res.json({
        title: def.title, sub: def.sub, cols, generatedAt: new Date().toISOString(),
        rows: rows.map(r => Object.fromEntries(cols.map(col => [col.k, r[col.k] ?? null]))),
        limit: rows.length >= (def.limit || DETAIL_LIMIT) ? (def.limit || DETAIL_LIMIT) : null,
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  return router;
}
