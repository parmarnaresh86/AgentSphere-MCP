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

      // Tab 1 — aging-wise, one row per customer, one column per configured bucket
      const bucketCols = buckets.map((b, i) =>
        `${nf(dbType)}(SUM(CASE WHEN ${bucketCondition(daysExpr, b)} THEN ${balance} ELSE 0 END),0) AS "Bucket_${i}"`
      ).join(',\n  ');
      const summarySql = `SELECT T0."CardCode" AS "CardCode", T0."CardName" AS "CardName",
  ${bucketCols},
  ${nf(dbType)}(SUM(${balance}),0) AS "Total"
FROM ${oinv} T0
WHERE T0."DocStatus"='O' AND ${balance} > 0
GROUP BY T0."CardCode", T0."CardName"
ORDER BY SUM(${balance}) DESC`;

      // Tab 2 — detail-wise, one row per open invoice
      const detailSql = `SELECT T0."CardCode" AS "CardCode", T0."CardName" AS "CardName", T0."DocNum" AS "InvoiceNo",
  T0."DocDate" AS "InvoiceDate", T0."DocDueDate" AS "DueDate", ${balance} AS "Balance",
  ${daysExpr} AS "DaysOverdue", ${bucketCase} AS "Bucket"
FROM ${oinv} T0
WHERE T0."DocStatus"='O' AND ${balance} > 0
ORDER BY T0."${dateCol}" ASC`;

      const [summaryRowsRaw, detailRowsRaw] = await Promise.all([executeSQL(summarySql), executeSQL(detailSql)]);
      const summary = summaryRowsRaw.map(r => ({
        CardCode: r.CardCode, CardName: r.CardName,
        buckets: buckets.map((b, i) => Number(r[`Bucket_${i}`] || 0)),
        total: Number(r.Total || 0),
      }));
      const DETAIL_CAP = 500;
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

  // ── On-demand AI narrative for any of the five agents above — not called
  //    automatically on load, so the base dashboard stays real-time/instant. ──
  const SECTION_ENDPOINT = { pnl: 'pnl', cashflow: 'cashflow', aging: 'aging', customeraging: 'customer-aging', workingcapital: 'working-capital' };
  const NO_PERIOD_SECTIONS = new Set(['aging', 'customeraging']);
  router.get('/finance/insight', requireAuth, async (req, res) => {
    if (!requireDb(res)) return;
    try {
      const section = SECTION_ENDPOINT[req.query.section] ? req.query.section : 'pnl';
      const period   = VALID_PERIODS.includes(req.query.period) ? req.query.period : 'mtd';
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
        workingcapital: () => `You are a financial analyst. Given this working capital snapshot (period=${period}): AR Outstanding=${data.arOutstanding}, AP Outstanding=${data.apOutstanding}, Inventory Value=${data.inventoryValue}, Current Ratio=${data.currentRatio}, Quick Ratio=${data.quickRatio}, DSO=${data.dso}, DPO=${data.dpo}. Write a 2-3 sentence business insight — highlight liquidity/solvency health, and flag anything concerning. Plain text, no markdown headers.`,
      };

      const insight = await callAI([{ role: 'user', content: prompts[section]() }], 300);
      res.json({ section, period, insight: insight.trim(), data });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  return router;
}
