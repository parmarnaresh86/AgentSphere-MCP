// ── Finance / CFO knowledge for the AI prompts ────────────────────────────────
// The sales-focused prompts answered "balance sheet", "P&L", "EBITDA" etc. from
// A/R invoices, which is wrong: financial statements come from the General
// Ledger (JDT1 lines rolled up through the chart of accounts, OACT). This file
// holds (1) a regex to spot finance/CFO questions, (2) a live snapshot of the
// company's chart-of-accounts structure — drawer names, groups, key accounts,
// fiscal year — because GroupMask meaning differs per localisation, and
// (3) the playbook text: definitions, sign rules and SQL recipes.
// No dependency on chat-server.mjs — executeSQL is injected.

export const FINANCE_RE = /\b(balance.?sheet|b\/s|p\s?&\s?l|p\s?and\s?l|pnl|profit.?(and|&).?loss|income.?statement|trial.?balance|\btb\b|general.?ledger|\bgl\b|ledger|chart.?of.?accounts?|ebitda|ebit|\bpbt\b|\bpat\b|net.?profit|net.?income|net.?loss|operating.?profit|operating.?income|operating.?(expense|cost)s?|opex|capex|gross.?profit|gross.?margin|net.?margin|cogs|cost.?of.?(goods|sales)|depreciation|amorti[sz]ation|interest.?(expense|cost|income)|finance.?cost|retained.?earnings|reserves?.?(and|&).?surplus|equity|net.?worth|share.?capital|(total|current|fixed|net).?assets?|liabilit|working.?capital|current.?ratio|quick.?ratio|acid.?test|debt.?(to|\/).?equity|gearing|leverage|solvency|liquidity|\broe\b|\broa\b|\broce\b|return.?on|interest.?coverage|\bdso\b|\bdpo\b|\bdio\b|cash.?conversion|debtor.?days|creditor.?days|inventory.?days|turnover.?ratio|cash.?flow|free.?cash|burn.?rate|runway|fund.?flow|budget.?vs|vs.?budget|budget.?variance|financial.?(statement|ratio|health|performance|summary|position|kpi)s?|cfo|board.?pack|mis.?report|fiscal|financial.?year|\bfy\b|ytd.?profit|year.?end.?closing|provision|accrual|expense.?(head|analysis|breakdown)|expenses?)\b/i;

export function isFinanceQuestion(message, history = []) {
  if (FINANCE_RE.test(message || "")) return true;
  // Short follow-ups ("and last year?", "break it down by month") inherit the
  // topic of the previous question.
  const lastUser = [...history].reverse().find(h => h.role === "user");
  const ownTopic = /\b(sales?|customers?|items?|products?|vendors?|suppliers?|purchases?|stock|orders?|invoices?|quotations?|warehouses?)\b/i;
  return !!(lastUser && String(message || "").length < 80 && !ownTopic.test(message || "") && FINANCE_RE.test(lastUser.content || ""));
}

// ── Live chart-of-accounts snapshot ───────────────────────────────────────────
const _ctxCache = new Map(); // database -> { text, at }
const CTX_TTL_MS = 10 * 60 * 1000;

export async function loadFinanceContext({ executeSQL, dbType, database }) {
  const hit = _ctxCache.get(database);
  if (hit && Date.now() - hit.at < CTX_TTL_MS) return hit.text;

  const hana = dbType === "hana";
  const T = t => (hana ? `"${database}"."${t}"` : t);
  const c = n => (hana ? `"${n}"` : n);
  const today = hana ? "CURRENT_DATE" : "CAST(GETDATE() AS DATE)";
  const top = (n, sql) => (hana ? `${sql} LIMIT ${n}` : sql.replace(/^SELECT /, `SELECT TOP ${n} `));
  const run = async sql => { try { return await executeSQL(sql); } catch { return []; } };

  const [drawers, groups, keyAccts, cashAccts, period] = await Promise.all([
    run(`SELECT ${c("GroupMask")} AS "GroupMask", ${c("AcctCode")} AS "AcctCode", ${c("AcctName")} AS "AcctName" FROM ${T("OACT")} WHERE ${c("Levels")} = 1 ORDER BY ${c("GroupMask")}`),
    run(top(120, `SELECT ${c("GroupMask")} AS "GroupMask", ${c("AcctCode")} AS "AcctCode", ${c("AcctName")} AS "AcctName" FROM ${T("OACT")} WHERE ${c("Levels")} = 2 ORDER BY ${c("GroupMask")}, ${c("AcctCode")}`)),
    run(top(80, `SELECT ${c("GroupMask")} AS "GroupMask", ${c("AcctCode")} AS "AcctCode", ${c("FormatCode")} AS "FormatCode", ${c("AcctName")} AS "AcctName" FROM ${T("OACT")} WHERE ${c("Postable")} = 'Y' AND (` +
      ["%depreci%", "%amorti%", "%interest%", "%finance cost%", "%bank charge%", "%income tax%", "%deferred tax%", "%tax expense%", "%cost of goods%", "%cost of sale%", "%cogs%", "%purchase%", "%stock%", "%inventor%", "%retained%", "%profit%loss%", "%share capital%"]
        .map(p => `LOWER(${c("AcctName")}) LIKE '${p}'`).join(" OR ") + `) ORDER BY ${c("GroupMask")}, ${c("AcctCode")}`)),
    run(top(30, `SELECT ${c("AcctCode")} AS "AcctCode", ${c("AcctName")} AS "AcctName" FROM ${T("OACT")} WHERE ${c("Finanse")} = 'Y' AND ${c("Postable")} = 'Y' ORDER BY ${c("AcctCode")}`)),
    run(`SELECT ${c("Category")} AS "FY", ${c("F_RefDate")} AS "PeriodFrom", ${c("T_RefDate")} AS "PeriodTo" FROM ${T("OFPR")} WHERE ${c("F_RefDate")} <= ${today} AND ${c("T_RefDate")} >= ${today}`),
  ]);

  const views = await loadFinanceViews({ run, hana, database });

  let fy = [];
  if (period[0]?.FY != null) {
    fy = await run(`SELECT MIN(${c("F_RefDate")}) AS "FYStart", MAX(${c("T_RefDate")}) AS "FYEnd" FROM ${T("OFPR")} WHERE ${c("Category")} = '${String(period[0].FY).replace(/'/g, "''")}'`);
  }

  const d = v => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v ?? "").slice(0, 10));
  const parts = [];
  if (drawers.length) {
    parts.push("Drawers (OACT.GroupMask → top-level title) — map statements with THESE, not with assumed numbers:\n" +
      drawers.map(r => `- GroupMask ${r.GroupMask} = ${r.AcctName}`).join("\n"));
  }
  if (groups.length) {
    const byDrawer = {};
    for (const r of groups) (byDrawer[r.GroupMask] ||= []).push(`${r.AcctName} (${r.AcctCode})`);
    parts.push("Level-2 groups per drawer (use to split current/non-current, direct/indirect cost, etc.):\n" +
      Object.entries(byDrawer).map(([g, l]) => `- ${g}: ${l.join("; ")}`).join("\n"));
  }
  if (keyAccts.length) {
    parts.push("Key postable accounts found by name (for COGS, D&A, interest, tax, inventory, retained earnings) — use their AcctCodes, and say which ones you used:\n" +
      keyAccts.map(r => `- ${r.AcctCode}${r.FormatCode && r.FormatCode !== r.AcctCode ? ` (account no. ${r.FormatCode})` : ""} ${r.AcctName} [drawer ${r.GroupMask}]`).join("\n"));
    if (keyAccts.some(r => /^_SYS/.test(r.AcctCode || ""))) {
      parts.push("Account codes: AcctCode here is SAP's INTERNAL key (_SYS…). The account number users see and type (e.g. 45020 or 45020-01-01-01) is OACT.FormatCode" +
        " (digits only, e.g. 45020010101) and its first segment OACT.Segment_0 (45020). Search a user-given account number on FormatCode / Segment_0, join JDT1.Account to OACT.AcctCode, and show FormatCode + AcctName in answers — never the _SYS code.");
    }
  }
  if (cashAccts.length) {
    parts.push("Cash & bank accounts (OACT.Finanse = 'Y'):\n" + cashAccts.map(r => `- ${r.AcctCode} ${r.AcctName}`).join("\n"));
  }
  if (fy[0]?.FYStart) {
    parts.push(`Current fiscal year (OFPR category ${period[0].FY}): ${d(fy[0].FYStart)} to ${d(fy[0].FYEnd)}. Current posting period: ${d(period[0].PeriodFrom)} to ${d(period[0].PeriodTo)}.`);
  }

  if (views) parts.push(views);

  const text = parts.join("\n\n");
  _ctxCache.set(database, { text, at: Date.now() });
  return text;
}

// ── Finance reference views ───────────────────────────────────────────────────
// SAP B1 on HANA ships analytical calculation views under _SYS_BIC in a
// per-company package (sap.<company>.fin…). Only the ones below were checked
// against a live company and give correct figures: the standard
// ProfitAndLossQuery / BalanceSheetQuery need a period parameter and net in
// the year-end closing entries (P&L YTD ≈ 0, BS returned no rows), so they are
// deliberately NOT offered. Customer-built views (e.g. a DSO/DPO/DIO view) are
// listed by name with their columns so the AI can reuse the company's own
// definitions.
const SAP_FIN_VIEWS = [
  { path: "fin.mgmt/GLAccountPeriodBalanceQuery",
    use: "Trial balance / balance sheet by account group as at a posting-period end. Columns: FiscalYear, FinancialPeriodCode (e.g. 'FY2025-12' — see OFPR.Code), AccountCode, AccountName, ParentAccountName, AccountNameLevel1..9 (hierarchy: Level1 = drawer), OpeningBalanceLC, ClosingBalanceLC (debit +, credit −; balances INCLUDE closing entries, so the whole ledger nets to 0). Filter WHERE \"FinancialPeriodCode\" = '…'. Cross-check for the JDT1 balance sheet." },
  { path: "fin.bca/BudgetVSActualQuery",
    use: "Budget vs actual per account (and cost centre) per month. Columns: BudgetScenarioName, BudgetFiscalYear, BudgetYear, BudgetQuarter, BudgetMonth, AccountCode, SegmentationAccountCode (account no.), AccountName, ParentAccountName, AccountGroupMask, CostCenterCodeName, ActualAmountLC, BudgetAmountLC, DifferenceAmountLC, DifferencePercentage. Use this for any budget/variance question (pick the scenario for the year; name it)." },
  { path: "fin.mgmt/TransactionalJournalQuery",
    params: "('PLACEHOLDER' = ('$$P_FromDate$$', 'YYYYMMDD'), 'PLACEHOLDER' = ('$$P_ToDate$$', 'YYYYMMDD'), 'PLACEHOLDER' = ('$$P_AddVoucher$$', 'N'))",
    use: "Journal lines with names resolved (BusinessPartnerName, OffsetAccountName, ProjectName, DistributionRuleCode1..5, PostingDate, Year/Quarter/Month, DocumentTypeCode, DebitLC, CreditLC). Good for GL detail / expense drill-down listings." },
  { path: "fin.mgmt/FinancialAnalysisQuery",
    use: "Enriched journal lines (very large — always filter by date and aggregate). Has AccountGroupMask, AccountLevel, ParentAccountName, IsCashAccount and segment codes." },
];

async function loadFinanceViews({ run, hana, database }) {
  const lines = [];
  if (hana) {
    const found = await run(`SELECT "VIEW_NAME" FROM SYS.VIEWS WHERE "SCHEMA_NAME" = '_SYS_BIC' AND "VIEW_NAME" LIKE 'sap.%.fin.mgmt/GLAccountPeriodBalanceQuery'`);
    const want = String(database || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    const pkg = (found.find(r => r.VIEW_NAME.split("/")[0].split(".")[1] === want) || (found.length === 1 ? found[0] : null))?.VIEW_NAME.split(".fin.")[0];
    if (pkg) {
      const names = SAP_FIN_VIEWS.map(v => `'${pkg}.${v.path}'`).join(",");
      const exist = new Set((await run(`SELECT "VIEW_NAME" FROM SYS.VIEWS WHERE "SCHEMA_NAME" = '_SYS_BIC' AND "VIEW_NAME" IN (${names})`)).map(r => r.VIEW_NAME));
      for (const v of SAP_FIN_VIEWS) {
        const full = `${pkg}.${v.path}`;
        if (exist.has(full)) lines.push(`- "_SYS_BIC"."${full}"${v.params ? ` ${v.params}` : ""} — ${v.use}`);
      }
      if (lines.length) {
        lines.unshift(`SAP B1 analytical views (HANA) — query them like tables, schema "_SYS_BIC", names exactly as shown (quoted, with the slash):`);
        lines.push(`- Do NOT use "${pkg}.fin.fi/ProfitAndLossQuery" / "BalanceSheetQuery" / "CashFlowStatementQuery" or the KPI*Query views for statements — they need template/period parameters and net in year-end closing entries. Build P&L / balance sheet from JDT1 + OACT as described below, and use the views above as a cross-check.`);
      }
    }
  }

  // Company-built finance views — names hint at their purpose; the AI can
  // SELECT from them directly (e.g. a DSO/DPO/DIO view encodes the company's
  // own AR/AP/inventory account groups).
  const pat = ["DSO", "DPO", "DIO", "EBITDA", "PNL", "PROFIT", "BALANCE", "CASHFLOW", "CASH_FLOW", "BUDGET", "FINANC", "LEDGER", "TRIAL", "FI_GL", "FI_PC", "PAIDAMOUNT", "MARGIN"];
  const custom = hana
    ? await run(`SELECT V."VIEW_NAME" AS "V", STRING_AGG(C."COLUMN_NAME", ', ' ORDER BY C."POSITION") AS "C" FROM SYS.VIEWS V JOIN SYS.VIEW_COLUMNS C ON C."SCHEMA_NAME" = V."SCHEMA_NAME" AND C."VIEW_NAME" = V."VIEW_NAME"
        WHERE V."SCHEMA_NAME" = '${database}' AND V."VIEW_NAME" NOT LIKE 'DV20%' AND V."VIEW_NAME" NOT LIKE 'B1\\_%' ESCAPE '\\' AND (${pat.map(p => `UPPER(V."VIEW_NAME") LIKE '%${p}%'`).join(" OR ")})
        GROUP BY V."VIEW_NAME" ORDER BY V."VIEW_NAME" LIMIT 15`)
    : await run(`SELECT TOP 15 V.TABLE_NAME AS V, STUFF((SELECT ', ' + C.COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS C WHERE C.TABLE_NAME = V.TABLE_NAME AND C.TABLE_SCHEMA = V.TABLE_SCHEMA ORDER BY C.ORDINAL_POSITION FOR XML PATH('')), 1, 2, '') AS C
        FROM INFORMATION_SCHEMA.VIEWS V WHERE ${pat.map(p => `UPPER(V.TABLE_NAME) LIKE '%${p}%'`).join(" OR ")} ORDER BY V.TABLE_NAME`);
  if (custom.length && hana) {
    // A view that divides by 1000 reports in thousands — say so, or the AI
    // quotes $43,177 of receivables when it is $43.2M.
    const thousands = new Set((await run(`SELECT "VIEW_NAME" FROM SYS.VIEWS WHERE "SCHEMA_NAME" = '${database}' AND "VIEW_NAME" IN (${custom.map(r => `'${String(r.V).replace(/'/g, "''")}'`).join(",")}) AND "DEFINITION" LIKE '%/1000%'`)).map(r => r.VIEW_NAME));
    for (const r of custom) if (thousands.has(r.V)) r.C = `[AMOUNTS IN THOUSANDS — the SQL divides by 1000; select e.g. "AR" * 1000 AS "AR" in the SQL before quoting money figures] ${r.C}`;
  }
  if (custom.length) {
    lines.push(`Company-built finance views in "${database}" (custom — check the numbers make sense before relying on one; the name may not say the unit, e.g. amounts in thousands):\n` +
      custom.map(r => `- ${r.V}: ${String(r.C || "").slice(0, 300)}`).join("\n"));
  }
  return lines.join("\n");
}

// ── Playbook ──────────────────────────────────────────────────────────────────
export function buildFinancePlaybook({ dbType, currencySymbol = "$", liveContext = "" }) {
  const hana = dbType === "hana";
  return `## FINANCE & CFO QUESTIONS — General Ledger rules (this question is financial)
Financial statements, profit lines and ratios come from the GENERAL LEDGER, not from sales/purchase documents.
Use JDT1 (journal lines) joined to OACT (chart of accounts). Every document (invoice, payment, GRPO, goods issue, JE, depreciation run)
already posts to JDT1, so the GL is complete; OINV/OPCH totals miss expenses, COGS postings, payroll JEs, depreciation, provisions and year-end entries.
Use documents (OINV/ORIN GrosProfit) only when the user asks for sales/invoice margin, or as a cross-check — and label it "document-based".
${liveContext ? `\n### This company's chart of accounts (live)\n${liveContext}\n` : ""}
### Tables and columns (SQL names — exact)
- OACT: AcctCode, AcctName, FormatCode (display code), GroupMask (drawer), Levels (1 = drawer title … 10), FatherNum (parent AcctCode),
  Postable ('Y' = postable account, 'N' = title/group), ActType ('I' income, 'E' expenditure, 'N' other), Finanse ('Y' = cash/bank account),
  LocManTran ('Y' = control account e.g. debtors/creditors), CurrTotal (all-time balance in local currency — do NOT use for a period or an as-of date).
- JDT1: TransId, Line_ID, Account (→ OACT.AcctCode), ShortName (BP CardCode on BP lines, else = Account), Debit, Credit (local currency),
  SYSDeb, SYSCred (system currency), FCDebit, FCCredit, FCCurrency, RefDate (POSTING DATE — use for all period filters), DueDate, TaxDate,
  TransType, BaseRef (source doc no.), LineMemo, ContraAct, ProfitCode (dimension 1 cost centre), OcrCode2..OcrCode5 (dimensions 2–5),
  Project, BPLId (branch), BalDueDeb, BalDueCred (open amounts).
- OJDT: TransId, TransType, RefDate, Memo, Ref1, Ref2, BaseRef, StornoToTr (reversed-by), AutoStorno. Header only — JDT1 already has RefDate/TransType.
- TransType: -2 opening balance · -3 period-end closing · 13 A/R invoice · 14 A/R credit memo · 15 delivery · 16 sales return · 18 A/P invoice ·
  19 A/P credit memo · 20 GRPO · 21 goods return · 24 incoming payment · 25 deposit · 30 manual journal entry · 46 outgoing payment ·
  59 goods receipt · 60 goods issue · 67 inventory transfer · 69 landed costs · 162 inventory revaluation · 202 production order · 1470000071 depreciation run (fixed assets).
- Budget: OBGS (AbsId, Name, FinancYear = scenario), OBGT (AcctCode, Instance → OBGS.AbsId, FinancYear, DebLTotal, CredLTotal = annual),
  BGT1 (AcctCode, Instance, Line_ID = month 0–11 of the FY, DebLTotal, CredLTotal).
- Posting periods / fiscal year: OFPR (Code, Name, F_RefDate, T_RefDate, Category = fiscal year). Cost centres: OPRC (PrcCode, PrcName, DimCode). Dimensions: ODIM.
- Branches: OBPL (BPLId, BPLName). Fixed assets (if module used): OITM with ItemType = 'F', ITM7/ITM8 hold asset values.

### Drawers and signs
- Drawer meaning comes from the live list above. Typical SAP B1 layouts:
  India/UK: 1 Assets · 2 Liabilities · 3 Capital & Reserves · 4 Turnover/Revenue · 5 Cost of Sales · 6 Operating Costs · 7 Non-operating Income & Expenditure · 8 Taxation & Extraordinary.
  US/others: 1 Assets · 2 Liabilities · 3 Equity · 4 Revenues · 5 Cost of Sales · 6 Expenses · 7 Financing · 8 Other Revenues & Expenses.
- Balance Sheet = drawers 1–3. Profit & Loss = every drawer after 3. Confirm with the drawer names before you query.
- Natural sign: Assets & expenses = SUM(Debit − Credit). Liabilities, equity & income = SUM(Credit − Debit). Show every line positive in its natural sign, then subtract in SQL.
- Group postable accounts to their parent title with a self-join: JOIN OACT P ON P.AcctCode = A.FatherNum (join once more for the grand-parent if the tree is deeper). No CTEs/recursion.

### Period rules
- P&L / expenses / EBITDA for a period: JDT1.RefDate BETWEEN start AND end, and EXCLUDE TransType = -3 (closing entries zero out the P&L).
- Balance Sheet as at a date: ALL JDT1 lines with RefDate <= date (every TransType, from the beginning). Add a line
  "Current period profit / (loss)" = SUM(Credit − Debit) over the P&L drawers with RefDate <= date (all TransTypes) — without it the sheet does not balance.
  Check in SQL: Total assets − (liabilities + equity + current profit) and show the difference (should be 0; if not, say so).
- Trial Balance: per postable account — Opening (RefDate < start), Period Debit, Period Credit, Closing = Opening + Dr − Cr; totals Dr = Cr.
- "This year" / "YTD" / "FY" for finance = the company FISCAL year above (from SAP posting periods OFPR/OACP — usually Jan – Dec for a US company) unless the user says calendar year. State the dates.
- Comparisons: the same measures for the previous period and the same period last year, growth % in SQL (SUM(CASE WHEN RefDate BETWEEN … THEN … END)).
  !! The WHERE date range must cover EVERY compared period — WHERE RefDate BETWEEN <last-year start> AND <this-year end> — and the CASE picks each period.
  A WHERE on this year only makes every last-year CASE column 0 (a wrong "no data for 2025").
- Monthly trends / month-wise comparisons: group by MONTH(RefDate) with a text month label first, one CASE column per year, and the WHERE spanning both years.
  Month-wise EBITDA / GP / margin: compute each year's Revenue, COGS, Opex and EBITDA columns in the SAME query, and the margin % in SQL
  (NULLIF the revenue denominator) — never take revenue from an invoice query and EBITDA from a GL query.
- A comparison period showing 0 while the current period has values is a query error until proven otherwise: run a separate total for that period
  before you ever write "no data for <period>".

### Definitions (CFO terms) — compute every one of these in SQL, never by hand
- Revenue / Turnover / Net sales = income drawer(s) for sales (Credit − Debit), after returns/discount accounts in that drawer.
- COGS / Cost of sales = Cost of Sales drawer (or COGS/purchase/stock-change accounts listed above if the company books them under expenses).
- Gross profit = Revenue − COGS · Gross margin % = GP ÷ Revenue × 100.
- Operating expenses (OPEX) = operating cost drawer(s), excluding depreciation/amortisation, interest/finance cost and income tax accounts.
- EBITDA = Revenue − COGS − OPEX (excl. D&A, interest, tax) + other operating income. EBITDA margin % = EBITDA ÷ Revenue.
  Equivalent check: PBT + Interest/finance cost + Depreciation + Amortisation. Name the D&A and interest accounts you used; if none exist, say "no D&A accounts found — EBITDA = EBIT".
- EBIT (operating profit) = EBITDA − D&A · PBT = EBIT − interest/finance cost + non-operating income − non-operating expense · Tax = income-tax accounts · PAT / Net profit = PBT − Tax. Net margin % = PAT ÷ Revenue.
- Working capital = Current assets − Current liabilities (use the level-2 groups named current/non-current).
- Current ratio = CA ÷ CL · Quick ratio = (CA − Inventory) ÷ CL · Cash ratio = Cash & bank ÷ CL.
- Debt-to-equity = (borrowings/loans) ÷ Equity · Interest coverage = EBIT ÷ interest · Equity / net worth = drawer 3 + current period profit.
- ROE = PAT ÷ average equity · ROA = PAT ÷ total assets · ROCE = EBIT ÷ (total assets − current liabilities) — annualise part-year figures and say so.
- DSO = Trade receivables ÷ Revenue × days · DPO = Trade payables ÷ COGS × days · DIO = Inventory ÷ COGS × days · Cash conversion cycle = DSO + DIO − DPO.
  Receivables/payables: control-account balances (LocManTran = 'Y') from JDT1, or open OINV/OPCH (DocTotal − PaidToDate) — say which.
  Inventory: GL inventory accounts; cross-check with OITW OnHand × OITM AvgPrice.
- Cash flow (direct): opening and closing balance of the cash & bank accounts (Finanse = 'Y') and period movements split by TransType
  (24 receipts from customers, 46 payments to vendors, 30 journal entries, 25 deposits …) and by ContraAct drawer (operating / investing = fixed-asset accounts / financing = loans & capital).
  Net cash flow = closing − opening; the split must add up to it. Free cash flow = operating cash flow − capex (fixed-asset additions).
- Burn rate = average monthly net cash outflow · Runway = cash ÷ burn rate.
- Budget vs actual: OBGT/BGT1 (Debit − Credit for expenses) vs JDT1 actuals for the same accounts and months; Variance = Actual − Budget, Variance % in SQL.
- Cost-centre / branch / project P&L: same P&L query grouped by JDT1.ProfitCode (OPRC.PrcName), OcrCode2–5, BPLId (OBPL.BPLName) or Project.
- Expense analysis: expense drawer accounts grouped by parent group and account, top N by amount, with % of total and change vs last period.

### How to present financial answers
- Run ONE summary query that returns the statement lines as columns (e.g. Revenue, COGS, GrossProfit, GPPct, Opex, EBITDA, EBITDAPct, DA, EBIT, Interest, PBT, Tax, PAT) computed with SUM(CASE WHEN GroupMask … / Account IN (…) …) — KPI tiles and the statement table must use these exact figures.
- P&L layout (### Profit & Loss): Revenue → Cost of sales → **Gross profit** (GP %) → Operating expenses → **EBITDA** (EBITDA %) → Depreciation & amortisation → **EBIT** → Finance cost / other income → **PBT** → Tax → **Net profit (PAT)** (net %), with columns for current period, comparison period and change %.
- Balance Sheet layout (### Balance Sheet as at <date>): Assets (by group: non-current, current — with inventory, receivables, cash & bank), **Total assets**; Liabilities (non-current, current), Equity (capital, reserves, current period profit), **Total liabilities & equity**, then the difference check.
- Trial Balance / account-level detail → show_data_table (every account, Excel download). Statement-level summary → markdown table.
- KPI tiles for finance: pick the headline measures asked for (e.g. Revenue, Gross margin, EBITDA, Net profit, Cash & bank, Working capital) with "def" stating the GL formula and accounts.
- Charts that fit: monthly Revenue/GP/EBITDA trend (combo or line), expense mix (doughnut or pareto), EBITDA bridge (waterfall), budget vs actual (variance).
- Points to note for a CFO: margin movement and its driver accounts, biggest cost increases, unusual/negative balances (e.g. negative cash, credit-balance assets), unposted period-end items (no depreciation this period, no closing), liquidity risk (current ratio < 1), concentration.
- If a figure can't be derived reliably (e.g. no fiscal-year setup, accounts not classified current/non-current), say exactly what is missing and what assumption you used — never silently fall back to invoice totals.
- Amounts in ${currencySymbol}; negative values in brackets, e.g. (${currencySymbol}125,000) or with a leading minus.
${hana ? `- HANA: quote every identifier ("JDT1"."RefDate"), qualify tables with the schema, dates as TO_DATE('YYYY-MM-DD'), IFNULL, LIMIT n.` : `- SQL Server: dates as 'YYYYMMDD', ISNULL, TOP n.`}
- Example (T-SQL shape; convert for HANA) — P&L summary by drawer for a period:
  SELECT A.GroupMask, SUM(J.Credit - J.Debit) AS NetCredit FROM JDT1 J JOIN OACT A ON A.AcctCode = J.Account
  WHERE J.RefDate BETWEEN '20260401' AND '20260930' AND J.TransType <> -3 AND A.GroupMask >= 4 GROUP BY A.GroupMask ORDER BY A.GroupMask
- Example — Balance Sheet by group as at a date:
  SELECT A.GroupMask, P.AcctName AS GroupName, SUM(J.Debit - J.Credit) AS DebitBalance FROM JDT1 J JOIN OACT A ON A.AcctCode = J.Account
  LEFT JOIN OACT P ON P.AcctCode = A.FatherNum WHERE J.RefDate <= '20260930' AND A.GroupMask <= 3 GROUP BY A.GroupMask, P.AcctName ORDER BY A.GroupMask, P.AcctName`;
}
