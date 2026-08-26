/**
 * check-sml-views.mjs
 * Logs into SAP B1, then probes every known sml.svc view.
 * Reports: AVAILABLE / NOT AVAILABLE / ERROR
 */
import https from "node:https";
import dotenv from "dotenv";
dotenv.config();

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const BASE   = process.env.SL_BASE_URL;   // e.g. https://host:50000/b1s/v2
const SML    = BASE + "/sml.svc";         // correct: /b1s/v2/sml.svc
const COMPANY  = process.env.SL_COMPANY;
const USER     = process.env.SL_USER;
const PASSWORD = process.env.SL_PASSWORD;

// ── All views referenced in the tool definition ─────────────────────────────
const VIEWS = [
  // Sales / Quotation
  "SalesQuotationHeaderQuery",
  "SalesQuotationDetailQuery",
  "SalesOrderHeaderQuery",
  "SalesOrderDetailQuery",
  "SalesAnalysisQuery",
  "AverageSellingPriceQuery",
  "SalesReturnStatisticsQuery",
  "BackOrderStatusQuery",
  "SalesOrderFulfillmentCycleTimeQuery",
  "SalesOrderDeliveredOnTimeQuery",
  // AR / Receivables
  "ARInvoiceHeaderQuery",
  "ARInvoiceDetailQuery",
  "ARCreditMemoHeaderQuery",
  "ARCreditMemoDetailQuery",
  "ARReserveInvoiceHeaderQuery",
  "CustomerReceivableAgingQuery",
  "AgingQuery",
  // Delivery
  "DeliveryHeaderQuery",
  "DeliveryDetailQuery",
  "OnTimeDeliveryStatisticsQuery",
  // Purchase / AP
  "PurchaseAnalysisQuery",
  "PurchaseAnalysisByDocumentQuery",
  "PurchaseOrderHeaderQuery",
  "PurchaseOrderDetailQuery",
  "AveragePurchasingPriceQuery",
  "PurchaseReturnStatisticsQuery",
  "OnTimeReceiptStatisticsQuery",
  "GoodsReceiptPOHeaderQuery",
  "GoodsReceiptPODetailQuery",
  "APInvoiceHeaderQuery",
  "APInvoiceDetailQuery",
  "APCreditMemoHeaderQuery",
  "VendorBalanceAnalysisQuery",
  "VendorPaymentAgingQuery",
  // Inventory
  "InventoryStatusQuery",
  "InventoryTransactionDocumentsQuery",
  "WMSSTOCK",
  // Returns
  "ReturnHeaderQuery",
  "ReturnDetailQuery",
  "GoodsReturnHeaderQuery",
  "GoodsReturnDetailQuery",
  // Finance / GL
  "FinancialAnalysisQuery",
  "ProfitAndLossQuery",
  "ProfitAndLossComparisonQuery",
  "BalanceSheetQuery",
  "BalanceSheetComparisonQuery",
  "GeneralLedgerBPQuery",
  "GeneralLedgerAccountQuery",
  "GLAccountPeriodAmountQuery",
  "GLAccountPeriodBalanceQuery",
  "TransactionalJournalQuery",
  "SubLedgerQuery",
  "BudgetVSActualQuery",
  "BudgetAnalysisQuery",
  "CostCenterBudgetVSActualQuery",
  "CostAccountingAnalysisQuery",
  "CashFlowStatementQuery",
  "VATReportQuery",
  "TaxReportQuery",
  // KPI
  "KPIProfitAndLossQuery",
  "KPICashFlowStatementQuery",
  "KPIBalanceSheetQuery",
  // CRM
  "OpportunityQuery",
  "OpportunityWinRateQuery",
  "CustomerAttritionRatePredictionQuery",
  "ItemRecommendationQuery",
  "ItemAlsoRecommendedQuery",
];

// ── Simple fetch via Node https ──────────────────────────────────────────────
const agent = new https.Agent({ rejectUnauthorized: false });

async function request(method, url, body, cookies) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const opts = {
      hostname: u.hostname, port: u.port,
      path: u.pathname + u.search,
      method,
      agent,
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        ...(cookies ? { Cookie: cookies } : {}),
      },
    };
    const req = https.request(opts, res => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ── Main ─────────────────────────────────────────────────────────────────────
(async () => {
  // 1. Login
  console.log(`\nLogging in to ${BASE} (company: ${COMPANY})…`);
  const loginRes = await request("POST", `${BASE}/Login`, { CompanyDB: COMPANY, UserName: USER, Password: PASSWORD });
  if (loginRes.status !== 200) {
    console.error("Login failed:", loginRes.status, loginRes.body);
    process.exit(1);
  }
  const cookies = loginRes.headers["set-cookie"]?.map(c => c.split(";")[0]).join("; ");
  console.log("Login OK.\n");

  // 2. Probe each view with $top=1
  const results = { available: [], notAvailable: [], error: [] };

  for (const view of VIEWS) {
    const url = `${SML}/${view}?$top=1`;
    try {
      const res = await request("GET", url, null, cookies);
      if (res.status === 200) {
        results.available.push(view);
        console.log(`  ✅  ${view}`);
      } else if (res.status === 404) {
        results.notAvailable.push(view);
        console.log(`  ❌  ${view}  (404 — not found)`);
      } else {
        results.error.push({ view, status: res.status });
        console.log(`  ⚠️  ${view}  (HTTP ${res.status})`);
      }
    } catch (e) {
      results.error.push({ view, status: e.message });
      console.log(`  ⚠️  ${view}  (error: ${e.message})`);
    }
  }

  // 3. Summary
  console.log("\n" + "═".repeat(60));
  console.log(`SUMMARY — ${BASE}`);
  console.log("═".repeat(60));
  console.log(`\n✅ AVAILABLE (${results.available.length}):`);
  results.available.forEach(v => console.log(`   ${v}`));
  console.log(`\n❌ NOT AVAILABLE (${results.notAvailable.length}):`);
  results.notAvailable.forEach(v => console.log(`   ${v}`));
  if (results.error.length) {
    console.log(`\n⚠️  ERRORS (${results.error.length}):`);
    results.error.forEach(e => console.log(`   ${e.view}  → ${e.status}`));
  }
  console.log("\n" + "═".repeat(60));

  // 4. Logout
  await request("POST", `${BASE}/Logout`, null, cookies).catch(() => {});
  console.log("Logged out.\n");
})();
