/**
 * query-templates.mjs
 * Query Template Library — hand-written, dialect-correct SQL for the highest-
 * frequency SAP B1 questions (top sellers, low stock, AR/AP aging, open
 * orders, top customers, stock on hand, overdue invoices).
 *
 * Matched questions skip AI SQL generation entirely: no LLM round-trip, no
 * hallucination risk, instant response. Anything that doesn't match falls
 * through to generateSQL() as before.
 */

import { tableRef } from './db-connector.mjs';

const nullFn = (dbType) => (dbType === 'hana' ? 'IFNULL' : 'ISNULL');
const today  = (dbType) => (dbType === 'hana' ? 'CURRENT_DATE' : 'GETDATE()');
const daysAgo = (dbType, n) =>
  dbType === 'hana' ? `ADD_DAYS(CURRENT_DATE, -${n})` : `DATEADD(DAY, -${n}, GETDATE())`;
const daysBetween = (dbType, fromExpr, toExpr) =>
  dbType === 'hana' ? `DAYS_BETWEEN(${fromExpr}, ${toExpr})` : `DATEDIFF(DAY, ${fromExpr}, ${toExpr})`;

function applyLimit(dbType, sql, n) {
  return dbType === 'hana' ? `${sql}\nLIMIT ${n}` : sql.replace(/^SELECT\b/i, `SELECT TOP ${n}`);
}

function extractTopN(question, def) {
  const m = question.match(/\btop\s+(\d{1,3})\b/i);
  return m ? Math.min(parseInt(m[1], 10), 500) : def;
}

function extractDays(question, def) {
  const m = question.match(/\blast\s+(\d{1,4})\s*days?\b/i);
  if (m) return parseInt(m[1], 10);
  if (/\blast\s+year\b/i.test(question)) return 365;
  if (/\bthis\s+year\b|\bytd\b/i.test(question)) return 365;
  if (/\blast\s+(quarter|3\s*months?)\b/i.test(question)) return 90;
  if (/\blast\s+month\b/i.test(question)) return 30;
  if (/\bthis\s+month\b|\bmtd\b/i.test(question)) return 30;
  return def;
}

// ── TEMPLATES ─────────────────────────────────────────────────────────────
// Ordered by specificity — more specific patterns first.
const TEMPLATES = [

  {
    name: 'top_selling_items',
    match: /\btop\s*\d*\s*(selling|best.?sell(ing)?)\s*(items?|products?)\b|\bbest\s*sell(er|ing)s?\b|\bmost\s+sold\s+items?\b/i,
    build: (question, dbType, cfg) => {
      const n = extractTopN(question, 10);
      const days = extractDays(question, 90);
      const oinv = tableRef('OINV', cfg), inv1 = tableRef('INV1', cfg), oitm = tableRef('OITM', cfg);
      const sql = `SELECT T1."ItemCode" AS "Item Code", T2."ItemName" AS "Item Name", SUM(T1."Quantity") AS "Total Qty Sold", SUM(T1."LineTotal") AS "Total Revenue"
FROM ${oinv} T0
INNER JOIN ${inv1} T1 ON T0."DocEntry" = T1."DocEntry"
INNER JOIN ${oitm} T2 ON T1."ItemCode" = T2."ItemCode"
WHERE T0."DocDate" >= ${daysAgo(dbType, days)} AND T0."DocStatus" <> 'W'
GROUP BY T1."ItemCode", T2."ItemName"
ORDER BY SUM(T1."LineTotal") DESC`;
      return applyLimit(dbType, sql, n);
    },
  },

  {
    name: 'top_customers',
    match: /\btop\s*\d*\s*customers?\b(?!.*price)/i,
    build: (question, dbType, cfg) => {
      const n = extractTopN(question, 10);
      const days = extractDays(question, 365);
      const oinv = tableRef('OINV', cfg);
      const sql = `SELECT T0."CardCode" AS "Customer Code", T0."CardName" AS "Customer Name", SUM(T0."DocTotal") AS "Total Sales", COUNT(DISTINCT T0."DocEntry") AS "Invoice Count"
FROM ${oinv} T0
WHERE T0."DocDate" >= ${daysAgo(dbType, days)} AND T0."DocStatus" <> 'W'
GROUP BY T0."CardCode", T0."CardName"
ORDER BY SUM(T0."DocTotal") DESC`;
      return applyLimit(dbType, sql, n);
    },
  },

  {
    name: 'low_stock',
    match: /\blow\s*stock\b|\bbelow\s*(re.?order|min(imum)?)\b|\bneed(s)?\s+(to\s+)?re.?order\b|\breorder\s*(point|level|list)\b|\bstock\s*shortage\b/i,
    build: (question, dbType, cfg) => {
      const oitw = tableRef('OITW', cfg), oitm = tableRef('OITM', cfg), owhs = tableRef('OWHS', cfg);
      return `SELECT T1."ItemCode" AS "Item Code", T2."ItemName" AS "Item Name", T0."WhsCode" AS "Warehouse", T0."OnHand" AS "On Hand", T0."MinStock" AS "Min Stock"
FROM ${oitw} T0
INNER JOIN ${oitm} T2 ON T0."ItemCode" = T2."ItemCode"
LEFT JOIN ${owhs} T1 ON T0."WhsCode" = T1."WhsCode"
WHERE T0."MinStock" > 0 AND T0."OnHand" < T0."MinStock"
ORDER BY (T0."MinStock" - T0."OnHand") DESC`;
    },
  },

  {
    name: 'out_of_stock',
    match: /\bout\s*of\s*stock\b|\bzero\s*stock\b|\bnegative\s*stock\b/i,
    build: (question, dbType, cfg) => {
      const oitw = tableRef('OITW', cfg), oitm = tableRef('OITM', cfg);
      const isNegative = /\bnegative\b/i.test(question);
      return `SELECT T0."ItemCode" AS "Item Code", T1."ItemName" AS "Item Name", T0."WhsCode" AS "Warehouse", T0."OnHand" AS "On Hand"
FROM ${oitw} T0
INNER JOIN ${oitm} T1 ON T0."ItemCode" = T1."ItemCode"
WHERE T0."OnHand" ${isNegative ? '< 0' : '<= 0'}
ORDER BY T0."OnHand" ASC`;
    },
  },

  {
    name: 'ar_aging',
    match: /\bar\s*aging\b|\breceivable\s*aging\b|\bcustomer\s*aging\b|\baging\s*(report|summary)?\s*(of\s*)?(customers?|receivables?|ar)\b/i,
    build: (question, dbType, cfg) => {
      const oinv = tableRef('OINV', cfg);
      const dOverdue = daysBetween(dbType, 'T0."DocDueDate"', today(dbType));
      return `SELECT T0."CardCode" AS "Customer Code", T0."CardName" AS "Customer Name", T0."DocNum" AS "Invoice No", T0."DocDate" AS "Invoice Date", T0."DocDueDate" AS "Due Date",
  T0."DocTotal" AS "Invoice Total", T0."PaidToDate" AS "Paid", (T0."DocTotal" - T0."PaidToDate") AS "Balance Due",
  CASE WHEN T0."DocDueDate" >= ${today(dbType)} THEN 'Current'
       WHEN ${dOverdue} <= 30 THEN '1-30 Days'
       WHEN ${dOverdue} <= 60 THEN '31-60 Days'
       WHEN ${dOverdue} <= 90 THEN '61-90 Days'
       ELSE '90+ Days' END AS "Aging Bucket"
FROM ${oinv} T0
WHERE T0."DocStatus" = 'O' AND (T0."DocTotal" - T0."PaidToDate") > 0
ORDER BY T0."DocDueDate" ASC`;
    },
  },

  {
    name: 'ap_aging',
    match: /\bap\s*aging\b|\bpayable\s*aging\b|\bvendor\s*aging\b|\bsupplier\s*aging\b|\baging\s*(report|summary)?\s*(of\s*)?(vendors?|suppliers?|payables?|ap)\b/i,
    build: (question, dbType, cfg) => {
      const opch = tableRef('OPCH', cfg);
      const dOverdue = daysBetween(dbType, 'T0."DocDueDate"', today(dbType));
      return `SELECT T0."CardCode" AS "Vendor Code", T0."CardName" AS "Vendor Name", T0."DocNum" AS "Invoice No", T0."DocDate" AS "Invoice Date", T0."DocDueDate" AS "Due Date",
  T0."DocTotal" AS "Invoice Total", T0."PaidToDate" AS "Paid", (T0."DocTotal" - T0."PaidToDate") AS "Balance Due",
  CASE WHEN T0."DocDueDate" >= ${today(dbType)} THEN 'Current'
       WHEN ${dOverdue} <= 30 THEN '1-30 Days'
       WHEN ${dOverdue} <= 60 THEN '31-60 Days'
       WHEN ${dOverdue} <= 90 THEN '61-90 Days'
       ELSE '90+ Days' END AS "Aging Bucket"
FROM ${opch} T0
WHERE T0."DocStatus" = 'O' AND (T0."DocTotal" - T0."PaidToDate") > 0
ORDER BY T0."DocDueDate" ASC`;
    },
  },

  {
    name: 'overdue_invoices',
    match: /\boverdue\s*(invoice|customer|payment)s?\b|\bpast\s*due\s*invoices?\b/i,
    build: (question, dbType, cfg) => {
      const oinv = tableRef('OINV', cfg);
      return `SELECT T0."CardCode" AS "Customer Code", T0."CardName" AS "Customer Name", T0."DocNum" AS "Invoice No", T0."DocDueDate" AS "Due Date",
  (T0."DocTotal" - T0."PaidToDate") AS "Balance Due", ${daysBetween(dbType, 'T0."DocDueDate"', today(dbType))} AS "Days Overdue"
FROM ${oinv} T0
WHERE T0."DocStatus" = 'O' AND (T0."DocTotal" - T0."PaidToDate") > 0 AND T0."DocDueDate" < ${today(dbType)}
ORDER BY T0."DocDueDate" ASC`;
    },
  },

  {
    name: 'open_sales_orders',
    match: /\bopen\s*sales?\s*orders?\b/i,
    build: (question, dbType, cfg) => {
      const ordr = tableRef('ORDR', cfg);
      return `SELECT T0."DocNum" AS "Order No", T0."CardCode" AS "Customer Code", T0."CardName" AS "Customer Name", T0."DocDate" AS "Order Date", T0."DocDueDate" AS "Delivery Date", T0."DocTotal" AS "Order Value"
FROM ${ordr} T0
WHERE T0."DocStatus" = 'O'
ORDER BY T0."DocDate" DESC`;
    },
  },

  {
    name: 'open_purchase_orders',
    match: /\bopen\s*purchase\s*orders?\b/i,
    build: (question, dbType, cfg) => {
      const opor = tableRef('OPOR', cfg);
      return `SELECT T0."DocNum" AS "PO No", T0."CardCode" AS "Vendor Code", T0."CardName" AS "Vendor Name", T0."DocDate" AS "Order Date", T0."DocDueDate" AS "Expected Date", T0."DocTotal" AS "Order Value"
FROM ${opor} T0
WHERE T0."DocStatus" = 'O'
ORDER BY T0."DocDate" DESC`;
    },
  },

  {
    name: 'stock_on_hand',
    match: /\b(current\s+)?stock\s*(on\s*hand|level|balance)s?\b|\bhow\s+much\s+stock\b|\binventory\s*(on\s*hand|level|balance)s?\b/i,
    build: (question, dbType, cfg) => {
      const n = extractTopN(question, 200);
      const oitm = tableRef('OITM', cfg);
      const sql = `SELECT T0."ItemCode" AS "Item Code", T0."ItemName" AS "Item Name", ${nullFn(dbType)}(T0."OnHand", 0) AS "On Hand", ${nullFn(dbType)}(T0."IsCommited", 0) AS "Committed", ${nullFn(dbType)}(T0."OnOrder", 0) AS "On Order"
FROM ${oitm} T0
WHERE T0."InvntItem" = 'Y'
ORDER BY T0."OnHand" DESC`;
      return applyLimit(dbType, sql, n);
    },
  },
];

/**
 * Returns { sql, name } for the first matching template, or null if none match.
 * Callers should still be free to fall back to AI-generated SQL on null.
 */
export function matchTemplate(question, dbType, cfg) {
  if (!dbType || !cfg) return null;
  for (const t of TEMPLATES) {
    if (t.match.test(question)) {
      try {
        const sql = t.build(question, dbType, cfg);
        return { sql, name: t.name };
      } catch {
        return null; // fall through to AI generation on any template build error
      }
    }
  }
  return null;
}
