/**
 * reports-engine.mjs
 * Pre-defined analytical report templates for SAP B1.
 * SQL uses {SCHEMA} as a placeholder — replaced at runtime with the active DB schema name.
 * type:'sql'  → executed via executeSQL() against HANA/MSSQL
 * type:'ai'   → prompt field sent to the chat AI
 */

export const REPORT_CATEGORIES = [
  { id: 'financial',   label: 'Financial KPIs',           icon: '📊' },
  { id: 'sales',       label: 'Sales Analytics',           icon: '📈' },
  { id: 'inventory',   label: 'Inventory Analytics',       icon: '📦' },
  { id: 'finance_pl',  label: 'Finance & P&L',             icon: '💰' },
  { id: 'procurement', label: 'Procurement & Operations',  icon: '🛒' },
  { id: 'forecasting', label: 'Forecasting & Scenario',    icon: '🔮' },
  { id: 'intelligence','label': 'Sales Intelligence',      icon: '🤖' },
  { id: 'inv_intel',   label: 'Inventory Intelligence',    icon: '🏭' },
  { id: 'email',       label: 'Daily / Weekly Reports',    icon: '📧' },
];

export const REPORTS = [

  // ─── 3. Financial KPIs ───────────────────────────────────────────────────────

  {
    id: 'dpo',
    categoryId: 'financial',
    title: 'DPO – Days Payable Outstanding',
    description: 'Average days to pay suppliers vs last 12-month purchases',
    type: 'sql',
    sql: `WITH AP_OPEN AS (
  SELECT SUM("DocTotal" - "PaidToDate") AS "AP_Balance"
  FROM "{SCHEMA}"."OPCH"
  WHERE "DocStatus" = 'O' AND "Cancelled" = 'tNO'
),
PURCHASES_12M AS (
  SELECT SUM("DocTotal") AS "Total_Purchases"
  FROM "{SCHEMA}"."OPCH"
  WHERE "DocDate" >= ADD_MONTHS(CURRENT_DATE, -12) AND "Cancelled" = 'tNO'
)
SELECT
  ROUND("AP_Balance", 2)                                                    AS "AP_Outstanding",
  ROUND("Total_Purchases", 2)                                               AS "Purchases_Last_12M",
  ROUND("AP_Balance" / NULLIF("Total_Purchases" / 365, 0), 1)               AS "DPO_Days"
FROM AP_OPEN, PURCHASES_12M`
  },

  {
    id: 'ap_aging',
    categoryId: 'financial',
    title: 'AP Aging – Supplier Buckets',
    description: 'Outstanding supplier invoices bucketed by overdue days (Current / 1-30 / 31-60 / 61-90 / 90+)',
    type: 'sql',
    sql: `SELECT
  "T0"."CardCode",
  "T0"."CardName",
  COUNT("T0"."DocNum")                                                                                                                                        AS "Invoices",
  ROUND(SUM(CASE WHEN DAYS_BETWEEN("T0"."DocDueDate", CURRENT_DATE) <= 0      THEN "T0"."DocTotal" - "T0"."PaidToDate" ELSE 0 END), 2)                      AS "Not_Due",
  ROUND(SUM(CASE WHEN DAYS_BETWEEN("T0"."DocDueDate", CURRENT_DATE) BETWEEN 1  AND 30  THEN "T0"."DocTotal" - "T0"."PaidToDate" ELSE 0 END), 2)             AS "1_30_Days",
  ROUND(SUM(CASE WHEN DAYS_BETWEEN("T0"."DocDueDate", CURRENT_DATE) BETWEEN 31 AND 60  THEN "T0"."DocTotal" - "T0"."PaidToDate" ELSE 0 END), 2)             AS "31_60_Days",
  ROUND(SUM(CASE WHEN DAYS_BETWEEN("T0"."DocDueDate", CURRENT_DATE) BETWEEN 61 AND 90  THEN "T0"."DocTotal" - "T0"."PaidToDate" ELSE 0 END), 2)             AS "61_90_Days",
  ROUND(SUM(CASE WHEN DAYS_BETWEEN("T0"."DocDueDate", CURRENT_DATE) > 90               THEN "T0"."DocTotal" - "T0"."PaidToDate" ELSE 0 END), 2)             AS "Over_90_Days",
  ROUND(SUM("T0"."DocTotal" - "T0"."PaidToDate"), 2)                                                                                                        AS "Total_Outstanding"
FROM "{SCHEMA}"."OPCH" "T0"
WHERE "T0"."DocStatus" = 'O' AND "T0"."Cancelled" = 'tNO'
  AND ("T0"."DocTotal" - "T0"."PaidToDate") > 0
GROUP BY "T0"."CardCode", "T0"."CardName"
ORDER BY "Total_Outstanding" DESC
LIMIT 50`
  },

  {
    id: 'ar_aging',
    categoryId: 'financial',
    title: 'AR Aging – Customer Buckets',
    description: 'Outstanding customer invoices bucketed by overdue days',
    type: 'sql',
    sql: `SELECT
  "T0"."CardCode",
  "T0"."CardName",
  COUNT("T0"."DocNum")                                                                                                                                        AS "Invoices",
  ROUND(SUM(CASE WHEN DAYS_BETWEEN("T0"."DocDueDate", CURRENT_DATE) <= 0      THEN "T0"."DocTotal" - "T0"."PaidToDate" ELSE 0 END), 2)                      AS "Not_Due",
  ROUND(SUM(CASE WHEN DAYS_BETWEEN("T0"."DocDueDate", CURRENT_DATE) BETWEEN 1  AND 30  THEN "T0"."DocTotal" - "T0"."PaidToDate" ELSE 0 END), 2)             AS "1_30_Days",
  ROUND(SUM(CASE WHEN DAYS_BETWEEN("T0"."DocDueDate", CURRENT_DATE) BETWEEN 31 AND 60  THEN "T0"."DocTotal" - "T0"."PaidToDate" ELSE 0 END), 2)             AS "31_60_Days",
  ROUND(SUM(CASE WHEN DAYS_BETWEEN("T0"."DocDueDate", CURRENT_DATE) BETWEEN 61 AND 90  THEN "T0"."DocTotal" - "T0"."PaidToDate" ELSE 0 END), 2)             AS "61_90_Days",
  ROUND(SUM(CASE WHEN DAYS_BETWEEN("T0"."DocDueDate", CURRENT_DATE) > 90               THEN "T0"."DocTotal" - "T0"."PaidToDate" ELSE 0 END), 2)             AS "Over_90_Days",
  ROUND(SUM("T0"."DocTotal" - "T0"."PaidToDate"), 2)                                                                                                        AS "Total_Outstanding"
FROM "{SCHEMA}"."OINV" "T0"
WHERE "T0"."DocStatus" = 'O' AND "T0"."Cancelled" = 'tNO'
  AND ("T0"."DocTotal" - "T0"."PaidToDate") > 0
GROUP BY "T0"."CardCode", "T0"."CardName"
ORDER BY "Total_Outstanding" DESC
LIMIT 50`
  },

  {
    id: 'vendor_outstanding',
    categoryId: 'financial',
    title: 'Vendor Outstanding Analysis',
    description: 'All open AP invoices grouped by vendor with oldest date and max overdue days',
    type: 'sql',
    sql: `SELECT
  "T0"."CardCode",
  "T0"."CardName",
  MIN("T0"."DocDate")                                          AS "Oldest_Invoice",
  MAX("T0"."DocDate")                                          AS "Latest_Invoice",
  COUNT("T0"."DocNum")                                         AS "Open_Invoices",
  ROUND(SUM("T0"."DocTotal"), 2)                               AS "Total_Invoiced",
  ROUND(SUM("T0"."PaidToDate"), 2)                             AS "Total_Paid",
  ROUND(SUM("T0"."DocTotal" - "T0"."PaidToDate"), 2)           AS "Outstanding",
  MAX(DAYS_BETWEEN("T0"."DocDueDate", CURRENT_DATE))           AS "Max_Overdue_Days"
FROM "{SCHEMA}"."OPCH" "T0"
WHERE "T0"."DocStatus" = 'O' AND "T0"."Cancelled" = 'tNO'
  AND ("T0"."DocTotal" - "T0"."PaidToDate") > 0
GROUP BY "T0"."CardCode", "T0"."CardName"
ORDER BY "Outstanding" DESC
LIMIT 50`
  },

  {
    id: 'customer_outstanding',
    categoryId: 'financial',
    title: 'Customer Outstanding Analysis',
    description: 'All open AR invoices grouped by customer with balance and overdue detail',
    type: 'sql',
    sql: `SELECT
  "T0"."CardCode",
  "T0"."CardName",
  MIN("T0"."DocDate")                                          AS "Oldest_Invoice",
  MAX("T0"."DocDate")                                          AS "Latest_Invoice",
  COUNT("T0"."DocNum")                                         AS "Open_Invoices",
  ROUND(SUM("T0"."DocTotal"), 2)                               AS "Total_Invoiced",
  ROUND(SUM("T0"."PaidToDate"), 2)                             AS "Total_Paid",
  ROUND(SUM("T0"."DocTotal" - "T0"."PaidToDate"), 2)           AS "Outstanding",
  MAX(DAYS_BETWEEN("T0"."DocDueDate", CURRENT_DATE))           AS "Max_Overdue_Days"
FROM "{SCHEMA}"."OINV" "T0"
WHERE "T0"."DocStatus" = 'O' AND "T0"."Cancelled" = 'tNO'
  AND ("T0"."DocTotal" - "T0"."PaidToDate") > 0
GROUP BY "T0"."CardCode", "T0"."CardName"
ORDER BY "Outstanding" DESC
LIMIT 50`
  },

  // ─── 4. Sales Analytics ──────────────────────────────────────────────────────

  {
    id: 'monthly_sales',
    categoryId: 'sales',
    title: 'Monthly Sales Trend',
    description: 'Invoice count, revenue, gross profit and GP% month-by-month for last 13 months',
    type: 'sql',
    sql: `SELECT
  TO_NVARCHAR("DocDate", 'YYYY-MM')                                          AS "Period",
  COUNT("DocNum")                                                            AS "Invoice_Count",
  COUNT(DISTINCT "CardCode")                                                 AS "Customers",
  ROUND(SUM("DocTotal"), 2)                                                  AS "Gross_Sales",
  ROUND(SUM("GrossProfit"), 2)                                               AS "Gross_Profit",
  ROUND(SUM("GrossProfit") / NULLIF(SUM("DocTotal"), 0) * 100, 1)            AS "GP_Pct"
FROM "{SCHEMA}"."OINV"
WHERE "DocStatus" IN ('O', 'C') AND "Cancelled" = 'tNO'
  AND "DocDate" >= ADD_MONTHS(CURRENT_DATE, -13)
GROUP BY TO_NVARCHAR("DocDate", 'YYYY-MM')
ORDER BY "Period"`
  },

  {
    id: 'sales_by_employee',
    categoryId: 'sales',
    title: 'Sales by Sales Employee',
    description: 'Revenue and GP per sales rep for the last 12 months',
    type: 'sql',
    sql: `SELECT
  COALESCE("S"."SlpName", 'Unassigned')                                      AS "Sales_Employee",
  COUNT("T0"."DocNum")                                                       AS "Invoice_Count",
  COUNT(DISTINCT "T0"."CardCode")                                            AS "Customer_Count",
  ROUND(SUM("T0"."DocTotal"), 2)                                             AS "Total_Sales",
  ROUND(SUM("T0"."GrossProfit"), 2)                                          AS "Gross_Profit",
  ROUND(SUM("T0"."GrossProfit") / NULLIF(SUM("T0"."DocTotal"), 0) * 100, 1) AS "GP_Pct"
FROM "{SCHEMA}"."OINV" "T0"
LEFT JOIN "{SCHEMA}"."OSLP" "S" ON "T0"."SlpCode" = "S"."SlpCode"
WHERE "T0"."DocStatus" IN ('O', 'C') AND "T0"."Cancelled" = 'tNO'
  AND "T0"."DocDate" >= ADD_MONTHS(CURRENT_DATE, -12)
GROUP BY "S"."SlpName"
ORDER BY "Total_Sales" DESC`
  },

  {
    id: 'top10_customers',
    categoryId: 'sales',
    title: 'Top 10 Customers by Sales',
    description: 'Top 10 customers ranked by total AR invoice value over last 12 months',
    type: 'sql',
    sql: `SELECT
  "T0"."CardCode",
  "T0"."CardName",
  COUNT("T0"."DocNum")                                                       AS "Invoice_Count",
  ROUND(SUM("T0"."DocTotal"), 2)                                             AS "Total_Sales",
  ROUND(SUM("T0"."GrossProfit"), 2)                                          AS "Gross_Profit",
  ROUND(SUM("T0"."GrossProfit") / NULLIF(SUM("T0"."DocTotal"), 0) * 100, 1) AS "GP_Pct",
  MAX("T0"."DocDate")                                                        AS "Last_Invoice"
FROM "{SCHEMA}"."OINV" "T0"
WHERE "T0"."DocStatus" IN ('O', 'C') AND "T0"."Cancelled" = 'tNO'
  AND "T0"."DocDate" >= ADD_MONTHS(CURRENT_DATE, -12)
GROUP BY "T0"."CardCode", "T0"."CardName"
ORDER BY "Total_Sales" DESC
LIMIT 10`
  },

  {
    id: 'sales_growth',
    categoryId: 'sales',
    title: 'Sales Growth Analysis (YoY)',
    description: 'Current-year vs prior-year sales per month with growth %',
    type: 'sql',
    sql: `WITH CY AS (
  SELECT MONTH("DocDate") AS "Mo", SUM("DocTotal") AS "Sales"
  FROM "{SCHEMA}"."OINV"
  WHERE "DocStatus" IN ('O','C') AND "Cancelled" = 'tNO'
    AND YEAR("DocDate") = YEAR(CURRENT_DATE)
  GROUP BY MONTH("DocDate")
),
PY AS (
  SELECT MONTH("DocDate") AS "Mo", SUM("DocTotal") AS "Sales"
  FROM "{SCHEMA}"."OINV"
  WHERE "DocStatus" IN ('O','C') AND "Cancelled" = 'tNO'
    AND YEAR("DocDate") = YEAR(CURRENT_DATE) - 1
  GROUP BY MONTH("DocDate")
)
SELECT
  CY."Mo"                                                                     AS "Month",
  ROUND(CY."Sales", 2)                                                        AS "Current_Year",
  ROUND(COALESCE(PY."Sales", 0), 2)                                           AS "Prior_Year",
  ROUND((CY."Sales" - COALESCE(PY."Sales", 0)) / NULLIF(PY."Sales", 0) * 100, 1) AS "Growth_Pct"
FROM CY
LEFT JOIN PY ON CY."Mo" = PY."Mo"
ORDER BY CY."Mo"`
  },

  // ─── 5. Inventory Analytics ──────────────────────────────────────────────────

  {
    id: 'slow_moving',
    categoryId: 'inventory',
    title: 'Slow Moving Items (90+ days)',
    description: 'Items in stock with no sale in last 90 days, ranked by tied-up value',
    type: 'sql',
    sql: `SELECT
  "T0"."ItemCode",
  "T0"."ItemName",
  "G"."ItmsGrpNam"                                             AS "Item_Group",
  ROUND("T0"."OnHand", 2)                                      AS "Stock_Qty",
  ROUND("T0"."OnHand" * "T0"."AvgPrice", 2)                   AS "Stock_Value",
  "LS"."Last_Sale",
  COALESCE("LS"."Days_Since_Sale", 9999)                       AS "Days_Since_Sale"
FROM "{SCHEMA}"."OITM" "T0"
LEFT JOIN "{SCHEMA}"."OITB" "G" ON "T0"."ItmsGrpCod" = "G"."ItmsGrpCod"
LEFT JOIN (
  SELECT "I"."ItemCode",
    TO_NVARCHAR(MAX("O"."DocDate"), 'YYYY-MM-DD')              AS "Last_Sale",
    DAYS_BETWEEN(MAX("O"."DocDate"), CURRENT_DATE)             AS "Days_Since_Sale"
  FROM "{SCHEMA}"."INV1" "I"
  INNER JOIN "{SCHEMA}"."OINV" "O" ON "I"."DocEntry" = "O"."DocEntry"
  WHERE "O"."Cancelled" = 'tNO'
  GROUP BY "I"."ItemCode"
) "LS" ON "T0"."ItemCode" = "LS"."ItemCode"
WHERE "T0"."InvntItem" = 'tYES' AND "T0"."OnHand" > 0
  AND COALESCE("LS"."Days_Since_Sale", 9999) > 90
ORDER BY "Stock_Value" DESC
LIMIT 50`
  },

  {
    id: 'stock_valuation',
    categoryId: 'inventory',
    title: 'Stock Valuation by Group',
    description: 'Total stock qty, value, committed and on-order broken down by item group',
    type: 'sql',
    sql: `SELECT
  "G"."ItmsGrpNam"                                             AS "Item_Group",
  COUNT("T0"."ItemCode")                                       AS "Item_Count",
  ROUND(SUM("T0"."OnHand"), 2)                                 AS "Total_Qty",
  ROUND(SUM("T0"."OnHand" * "T0"."AvgPrice"), 2)              AS "Stock_Value",
  ROUND(SUM("T0"."IsCommited"), 2)                             AS "Committed_Qty",
  ROUND(SUM("T0"."OnOrder"), 2)                                AS "On_Order_Qty"
FROM "{SCHEMA}"."OITM" "T0"
INNER JOIN "{SCHEMA}"."OITB" "G" ON "T0"."ItmsGrpCod" = "G"."ItmsGrpCod"
WHERE "T0"."InvntItem" = 'tYES'
GROUP BY "G"."ItmsGrpNam"
ORDER BY "Stock_Value" DESC`
  },

  {
    id: 'inventory_turnover',
    categoryId: 'inventory',
    title: 'Inventory Turnover Proxy',
    description: 'Days of stock remaining per item based on last-12-month sales velocity',
    type: 'sql',
    sql: `WITH SOLD_12M AS (
  SELECT "I"."ItemCode",
    SUM("I"."Quantity") AS "Qty_Sold"
  FROM "{SCHEMA}"."INV1" "I"
  INNER JOIN "{SCHEMA}"."OINV" "O" ON "I"."DocEntry" = "O"."DocEntry"
  WHERE "O"."Cancelled" = 'tNO'
    AND "O"."DocDate" >= ADD_MONTHS(CURRENT_DATE, -12)
  GROUP BY "I"."ItemCode"
)
SELECT
  "T0"."ItemCode",
  "T0"."ItemName",
  "G"."ItmsGrpNam"                                                      AS "Group",
  ROUND("T0"."OnHand", 2)                                               AS "Stock",
  ROUND(COALESCE("S"."Qty_Sold", 0), 2)                                 AS "Sold_12M",
  CASE
    WHEN "T0"."OnHand" > 0 AND COALESCE("S"."Qty_Sold", 0) > 0
    THEN ROUND("T0"."OnHand" / ("S"."Qty_Sold" / 365), 0)
    ELSE NULL
  END                                                                   AS "Days_of_Stock",
  ROUND("T0"."OnHand" * "T0"."AvgPrice", 2)                            AS "Stock_Value"
FROM "{SCHEMA}"."OITM" "T0"
LEFT JOIN "{SCHEMA}"."OITB" "G" ON "T0"."ItmsGrpCod" = "G"."ItmsGrpCod"
LEFT JOIN SOLD_12M "S" ON "T0"."ItemCode" = "S"."ItemCode"
WHERE "T0"."InvntItem" = 'tYES' AND "T0"."OnHand" > 0
ORDER BY "Days_of_Stock" DESC NULLS LAST
LIMIT 50`
  },

  // ─── 6. Finance & P&L ────────────────────────────────────────────────────────

  {
    id: 'pl_summary',
    categoryId: 'finance_pl',
    title: 'P&L Summary (Last 12 Months)',
    description: 'Revenue, gross profit from AR, and total purchases from AP — simplified P&L view',
    type: 'sql',
    sql: `SELECT 'Revenue (AR Invoices)'       AS "Category", ROUND(SUM("DocTotal"), 2)     AS "Amount", COUNT(*) AS "Count"
FROM "{SCHEMA}"."OINV"
WHERE "DocStatus" IN ('O','C') AND "Cancelled" = 'tNO' AND "DocDate" >= ADD_MONTHS(CURRENT_DATE, -12)
UNION ALL
SELECT 'Gross Profit (AR Invoices)',  ROUND(SUM("GrossProfit"), 2),  COUNT(*)
FROM "{SCHEMA}"."OINV"
WHERE "DocStatus" IN ('O','C') AND "Cancelled" = 'tNO' AND "DocDate" >= ADD_MONTHS(CURRENT_DATE, -12)
UNION ALL
SELECT 'Cost of Purchases (AP Invoices)', ROUND(SUM("DocTotal"), 2), COUNT(*)
FROM "{SCHEMA}"."OPCH"
WHERE "DocStatus" IN ('O','C') AND "Cancelled" = 'tNO' AND "DocDate" >= ADD_MONTHS(CURRENT_DATE, -12)
UNION ALL
SELECT 'AR Credits / Returns', ROUND(SUM("DocTotal"), 2), COUNT(*)
FROM "{SCHEMA}"."ORIN"
WHERE "DocStatus" IN ('O','C') AND "Cancelled" = 'tNO' AND "DocDate" >= ADD_MONTHS(CURRENT_DATE, -12)`
  },

  {
    id: 'expense_analysis',
    categoryId: 'finance_pl',
    title: 'Expense (AP) Analysis',
    description: 'Monthly AP invoice spend with count and outstanding balance',
    type: 'sql',
    sql: `SELECT
  TO_NVARCHAR("DocDate", 'YYYY-MM')                             AS "Period",
  COUNT("DocNum")                                               AS "Invoice_Count",
  COUNT(DISTINCT "CardCode")                                    AS "Vendor_Count",
  ROUND(SUM("DocTotal"), 2)                                     AS "Total_Purchases",
  ROUND(SUM("PaidToDate"), 2)                                   AS "Total_Paid",
  ROUND(SUM("DocTotal" - "PaidToDate"), 2)                      AS "Outstanding"
FROM "{SCHEMA}"."OPCH"
WHERE "DocStatus" IN ('O','C') AND "Cancelled" = 'tNO'
  AND "DocDate" >= ADD_MONTHS(CURRENT_DATE, -12)
GROUP BY TO_NVARCHAR("DocDate", 'YYYY-MM')
ORDER BY "Period"`
  },

  {
    id: 'revenue_analysis',
    categoryId: 'finance_pl',
    title: 'Revenue Analysis',
    description: 'Monthly AR revenue, GP, and average invoice value for last 12 months',
    type: 'sql',
    sql: `SELECT
  TO_NVARCHAR("DocDate", 'YYYY-MM')                                          AS "Period",
  COUNT(DISTINCT "CardCode")                                                 AS "Customers",
  COUNT("DocNum")                                                            AS "Invoice_Count",
  ROUND(SUM("DocTotal"), 2)                                                  AS "Revenue",
  ROUND(SUM("GrossProfit"), 2)                                               AS "Gross_Profit",
  ROUND(SUM("GrossProfit") / NULLIF(SUM("DocTotal"), 0) * 100, 1)            AS "GP_Pct",
  ROUND(AVG("DocTotal"), 2)                                                  AS "Avg_Invoice_Value"
FROM "{SCHEMA}"."OINV"
WHERE "DocStatus" IN ('O','C') AND "Cancelled" = 'tNO'
  AND "DocDate" >= ADD_MONTHS(CURRENT_DATE, -12)
GROUP BY TO_NVARCHAR("DocDate", 'YYYY-MM')
ORDER BY "Period"`
  },

  // ─── 7. Procurement & Operations ─────────────────────────────────────────────

  {
    id: 'open_po',
    categoryId: 'procurement',
    title: 'Open Purchase Orders',
    description: 'All open POs ordered by due date — includes vendor, amount, and age',
    type: 'sql',
    sql: `SELECT
  "T0"."DocNum",
  "T0"."CardCode",
  "T0"."CardName",
  "T0"."DocDate",
  "T0"."DocDueDate",
  DAYS_BETWEEN("T0"."DocDate", CURRENT_DATE)                   AS "Age_Days",
  DAYS_BETWEEN("T0"."DocDueDate", CURRENT_DATE)                AS "Overdue_Days",
  ROUND("T0"."DocTotal", 2)                                    AS "PO_Total",
  ROUND("T0"."DocTotal" - "T0"."PaidToDate", 2)               AS "Open_Amount",
  "T0"."Comments"
FROM "{SCHEMA}"."OPOR" "T0"
WHERE "T0"."DocStatus" = 'O' AND "T0"."Cancelled" = 'tNO'
ORDER BY "T0"."DocDueDate" ASC
LIMIT 100`
  },

  // ─── 8. Forecasting & Scenario Analysis ──────────────────────────────────────

  {
    id: 'sales_projection',
    categoryId: 'forecasting',
    title: 'Sales Projection – 20% / 30% / 50% Drop',
    description: 'Last 6 months of revenue with downside scenarios modelled',
    type: 'sql',
    sql: `WITH MONTHLY AS (
  SELECT
    TO_NVARCHAR("DocDate", 'YYYY-MM')                                        AS "Period",
    ROUND(SUM("DocTotal"), 2)                                                AS "Actual_Sales"
  FROM "{SCHEMA}"."OINV"
  WHERE "DocStatus" IN ('O','C') AND "Cancelled" = 'tNO'
    AND "DocDate" >= ADD_MONTHS(CURRENT_DATE, -6)
  GROUP BY TO_NVARCHAR("DocDate", 'YYYY-MM')
)
SELECT
  "Period",
  "Actual_Sales",
  ROUND("Actual_Sales" * 0.80, 2)                                           AS "If_20pct_Drop",
  ROUND("Actual_Sales" * 0.70, 2)                                           AS "If_30pct_Drop",
  ROUND("Actual_Sales" * 0.50, 2)                                           AS "If_50pct_Drop",
  ROUND("Actual_Sales" * 0.20, 2)                                           AS "Revenue_At_Risk_20pct"
FROM MONTHLY
ORDER BY "Period"`
  },

  {
    id: 'purchase_vs_sales',
    categoryId: 'forecasting',
    title: 'Purchase vs Sales Comparison',
    description: 'Monthly sales vs purchases side-by-side with net margin and GP%',
    type: 'sql',
    sql: `WITH SALES AS (
  SELECT TO_NVARCHAR("DocDate", 'YYYY-MM') AS "P", SUM("DocTotal") AS "S", SUM("GrossProfit") AS "GP"
  FROM "{SCHEMA}"."OINV"
  WHERE "DocStatus" IN ('O','C') AND "Cancelled" = 'tNO'
    AND "DocDate" >= ADD_MONTHS(CURRENT_DATE, -12)
  GROUP BY TO_NVARCHAR("DocDate", 'YYYY-MM')
),
PURCH AS (
  SELECT TO_NVARCHAR("DocDate", 'YYYY-MM') AS "P", SUM("DocTotal") AS "Pur"
  FROM "{SCHEMA}"."OPCH"
  WHERE "DocStatus" IN ('O','C') AND "Cancelled" = 'tNO'
    AND "DocDate" >= ADD_MONTHS(CURRENT_DATE, -12)
  GROUP BY TO_NVARCHAR("DocDate", 'YYYY-MM')
)
SELECT
  COALESCE("S"."P", "PR"."P")                                               AS "Period",
  ROUND(COALESCE("S"."S", 0), 2)                                            AS "Sales",
  ROUND(COALESCE("S"."GP", 0), 2)                                           AS "Gross_Profit",
  ROUND(COALESCE("PR"."Pur", 0), 2)                                         AS "Purchases",
  ROUND(COALESCE("S"."S", 0) - COALESCE("PR"."Pur", 0), 2)                 AS "Net_Margin",
  ROUND(COALESCE("S"."GP", 0) / NULLIF(COALESCE("S"."S", 0), 0) * 100, 1) AS "GP_Pct"
FROM SALES "S"
FULL OUTER JOIN PURCH "PR" ON "S"."P" = "PR"."P"
ORDER BY "Period"`
  },

  // ─── Sales Intelligence (AI-driven) ──────────────────────────────────────────

  {
    id: 'sales_forecast_ai',
    categoryId: 'intelligence',
    title: 'Auto Sales Forecasting',
    description: 'AI analyses the last 12 months of monthly sales and projects the next 3 months',
    type: 'ai',
    prompt: 'Show me the last 12 months of monthly sales data and then forecast the next 3 months based on the trend. Include total revenue, growth rate, and confidence notes.'
  },

  {
    id: 'cross_selling_ai',
    categoryId: 'intelligence',
    title: 'AI Cross-Selling Engine',
    description: 'AI identifies product pairs frequently bought together for cross-sell recommendations',
    type: 'ai',
    prompt: 'Analyse our sales orders from the last 6 months and identify the top 10 item combinations that are frequently bought together. Show the item codes, names, and co-occurrence frequency so we can build cross-selling campaigns.'
  },

  // ─── Inventory Intelligence ───────────────────────────────────────────────────

  {
    id: 'dead_stock',
    categoryId: 'inv_intel',
    title: 'Dead Stock Detection (180+ days)',
    description: 'Items with stock that have not been sold in 6+ months — financial exposure view',
    type: 'sql',
    sql: `SELECT
  "T0"."ItemCode",
  "T0"."ItemName",
  "G"."ItmsGrpNam"                                             AS "Item_Group",
  ROUND("T0"."OnHand", 2)                                      AS "Stock_Qty",
  ROUND("T0"."OnHand" * "T0"."AvgPrice", 2)                   AS "Dead_Stock_Value",
  COALESCE("LS"."Last_Sale", 'Never sold')                     AS "Last_Sale_Date",
  COALESCE("LS"."Days_Since_Sale", 9999)                       AS "Days_Since_Sale"
FROM "{SCHEMA}"."OITM" "T0"
LEFT JOIN "{SCHEMA}"."OITB" "G" ON "T0"."ItmsGrpCod" = "G"."ItmsGrpCod"
LEFT JOIN (
  SELECT "I"."ItemCode",
    TO_NVARCHAR(MAX("O"."DocDate"), 'YYYY-MM-DD')              AS "Last_Sale",
    DAYS_BETWEEN(MAX("O"."DocDate"), CURRENT_DATE)             AS "Days_Since_Sale"
  FROM "{SCHEMA}"."INV1" "I"
  INNER JOIN "{SCHEMA}"."OINV" "O" ON "I"."DocEntry" = "O"."DocEntry"
  WHERE "O"."Cancelled" = 'tNO'
  GROUP BY "I"."ItemCode"
) "LS" ON "T0"."ItemCode" = "LS"."ItemCode"
WHERE "T0"."InvntItem" = 'tYES' AND "T0"."OnHand" > 0
  AND COALESCE("LS"."Days_Since_Sale", 9999) >= 180
ORDER BY "Dead_Stock_Value" DESC
LIMIT 50`
  },

  {
    id: 'slow_stock_intel',
    categoryId: 'inv_intel',
    title: 'Slow Moving Stock (90-179 days)',
    description: 'Items sold 90–179 days ago — candidates for promotions before becoming dead stock',
    type: 'sql',
    sql: `SELECT
  "T0"."ItemCode",
  "T0"."ItemName",
  "G"."ItmsGrpNam"                                             AS "Item_Group",
  ROUND("T0"."OnHand", 2)                                      AS "Stock_Qty",
  ROUND("T0"."OnHand" * "T0"."AvgPrice", 2)                   AS "Stock_Value",
  "LS"."Last_Sale",
  "LS"."Days_Since_Sale"
FROM "{SCHEMA}"."OITM" "T0"
LEFT JOIN "{SCHEMA}"."OITB" "G" ON "T0"."ItmsGrpCod" = "G"."ItmsGrpCod"
LEFT JOIN (
  SELECT "I"."ItemCode",
    TO_NVARCHAR(MAX("O"."DocDate"), 'YYYY-MM-DD')              AS "Last_Sale",
    DAYS_BETWEEN(MAX("O"."DocDate"), CURRENT_DATE)             AS "Days_Since_Sale"
  FROM "{SCHEMA}"."INV1" "I"
  INNER JOIN "{SCHEMA}"."OINV" "O" ON "I"."DocEntry" = "O"."DocEntry"
  WHERE "O"."Cancelled" = 'tNO'
  GROUP BY "I"."ItemCode"
) "LS" ON "T0"."ItemCode" = "LS"."ItemCode"
WHERE "T0"."InvntItem" = 'tYES' AND "T0"."OnHand" > 0
  AND "LS"."Days_Since_Sale" BETWEEN 90 AND 179
ORDER BY "Stock_Value" DESC
LIMIT 50`
  },

  {
    id: 'stock_prediction_ai',
    categoryId: 'inv_intel',
    title: 'Stock Prediction (Consumption-Based)',
    description: 'AI predicts which items will hit zero stock in the next 30 days based on usage rate',
    type: 'ai',
    prompt: 'Based on our current stock levels and sales velocity over the last 3 months, predict which items are likely to run out of stock within the next 30 days. Show item code, name, current stock, average monthly usage, and estimated stock-out date.'
  },

  // ─── Email / Daily-Weekly Reports (AI) ───────────────────────────────────────

  {
    id: 'today_sales',
    categoryId: 'email',
    title: "Today's Sales Summary",
    description: 'Revenue, invoice count, top items and customers for today',
    type: 'ai',
    prompt: "Show me today's sales summary. Include: total revenue, number of invoices raised, number of unique customers, top 5 items sold by revenue, and top 3 customers by invoice value. Format it as a clean daily report."
  },

  {
    id: 'brand_sales',
    categoryId: 'email',
    title: 'Brand / Sub-Brand Sales',
    description: 'This-month sales broken down by Brand (CogsOcrCod) and Sub-Brand (CogsOcrCo2)',
    type: 'ai',
    prompt: 'Show me this month\'s sales breakdown by Brand and Sub-Brand (cost-centre dimensions). For each Brand and Sub-Brand combination show invoice count, total sales value, and gross profit. Use the dimension columns CogsOcrCod (Brand) and CogsOcrCo2 (Sub-Brand).'
  },

  {
    id: 'overdue_payments',
    categoryId: 'email',
    title: 'Overdue Customer Payments',
    description: 'All AR invoices past due date — customer name, days overdue, outstanding amount',
    type: 'ai',
    prompt: 'Show me all overdue customer AR invoices — those past their due date and still unpaid. For each invoice include: customer code, customer name, invoice number, invoice date, due date, days overdue, and outstanding amount. Sort by days overdue descending. Flag anything over 60 days as critical.'
  },

  {
    id: 'delivery_this_week',
    categoryId: 'email',
    title: 'Delivery Schedule (This Week)',
    description: 'Open sales orders with delivery due this week',
    type: 'ai',
    prompt: 'Show me all open sales orders that have a delivery due date falling this week (Monday to Sunday). Include: order number, customer name, due date, total amount, and line items (item code, description, quantity). This is the weekly delivery schedule report.'
  },

  {
    id: 'cash_receivables_week',
    categoryId: 'email',
    title: 'Cash Receivables (This Week)',
    description: 'AR invoices due this week — collections focus list',
    type: 'ai',
    prompt: 'Show me all open AR invoices with payment due this week (due date between Monday and Sunday of the current week). Include: customer code, customer name, invoice number, invoice date, due date, days remaining, and outstanding amount. Total the expected collections for the week.'
  },

  {
    id: 'cash_payables_week',
    categoryId: 'email',
    title: 'Cash Payables (This Week)',
    description: 'AP invoices due this week — payment obligations for cash planning',
    type: 'ai',
    prompt: 'Show me all open AP invoices with payment due this week (due date between Monday and Sunday of the current week). Include: vendor code, vendor name, invoice number, invoice date, due date, days remaining, and outstanding amount. Total the payments due this week for cash planning.'
  },

];

// ── Helpers ───────────────────────────────────────────────────────────────────

export function getReport(id) {
  return REPORTS.find(r => r.id === id) || null;
}

export function listReports() {
  return REPORTS.map(({ sql: _sql, prompt: _prompt, ...meta }) => meta);
}

export async function runReport(id, schema, executeSQLFn) {
  const report = getReport(id);
  if (!report)               throw new Error(`Unknown report: ${id}`);
  if (report.type !== 'sql') throw new Error(`Report "${id}" is type "${report.type}" — not SQL-executable`);
  if (!schema)               throw new Error('No schema name provided for SQL report');

  const sql = report.sql.replace(/\{SCHEMA\}/g, schema.replace(/'/g, "''"));
  return executeSQLFn(sql);
}
