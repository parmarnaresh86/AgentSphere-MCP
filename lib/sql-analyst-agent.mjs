// ── SQL Analyst Agent ─────────────────────────────────────────────────────────
// Claude-connector-style analysis for DB Direct mode. Instead of generating ONE
// SELECT and dumping the rows (generateAndRunDirectSql), the model gets a
// run_sql tool and loops: look up master data (branches, customers), run as
// many aggregate queries as the question needs (invoices, credit notes,
// cancellations, item mix, collections), then writes the analysis itself —
// KPI tiles, charts, summary, breakdowns, "points to note" and follow-ups.
//
// Provider-agnostic: pass chatComplete (OpenAI/Azure GPT format) or
// messagesCreate (Anthropic/Azure Claude format). Everything DB-related is
// injected so this file has no dependency on chat-server.mjs.

const MAX_STEPS = 14;          // tool-calling rounds before we force an answer
const MAX_ROWS_TO_MODEL = 200; // rows returned to the model per query
const MAX_RESULT_CHARS = 30_000;
const MAX_CHARTS = 3;
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 60;

// Console trace of the whole conversation with the AI. On by default;
// set SQL_ANALYST_LOG=off in .env to silence, =full to also print the
// complete system prompt and full query results (default: summarised).
const logMode = () => (process.env.SQL_ANALYST_LOG || "on").toLowerCase();
const LINE = "─".repeat(70);
function log(...a) { if (logMode() !== "off") console.log(...a); }
function logBlock(title, body) {
  if (logMode() === "off") return;
  console.log(`\n[SQL-ANALYST] ${LINE}\n[SQL-ANALYST] ${title}\n[SQL-ANALYST] ${LINE}\n${body}`);
}

const TOOL_DEFS = [
  {
    name: "run_sql",
    description: "Run ONE read-only SELECT against the live SAP Business One company database and get the rows back as JSON. Aggregate in SQL (SUM/COUNT/GROUP BY) instead of pulling raw lines — at most 200 rows are returned.",
    parameters: {
      type: "object",
      properties: {
        sql: { type: "string", description: "A single SELECT statement (no CTEs/WITH, no semicolons, no writes)." },
        purpose: { type: "string", description: "Short plain-English label shown to the user, e.g. 'Find the Gujarat branch'." },
      },
      required: ["sql", "purpose"],
    },
  },
  {
    name: "show_chart",
    description: `Show a chart to the user. The server runs your SELECT and plots the rows — first column = text label for the X axis (e.g. 'Jan'), remaining 1–4 columns = numeric series. You also get the rows back. Up to ${MAX_CHARTS} charts per answer, each a DIFFERENT view (e.g. a monthly trend + a top-customers pareto).`,
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "Chart title, e.g. 'Monthly sales: 2026 vs 2025 (excl. GST)'" },
        chart_type: { type: "string",
          enum: ["bar", "hbar", "stacked", "hstacked", "stacked100", "variance", "ranking", "line", "area", "stackedarea", "cumulative", "movingavg", "growth", "trendline",
                 "pie", "doughnut", "waterfall", "funnel", "heatmap", "radar", "scatter", "bubble", "histogram", "pareto", "combo", "dualaxis"],
          description: "Initial view (the user can switch among 30+ types). bar: compare periods/series · line/area: trend · variance or growth: this year vs last year · ranking/pareto: top customers/items · pie/doughnut: share of total (1 series) · waterfall: contributions · dualaxis: two measures with different units (e.g. qty and value) · scatter: relation of 2 measures · heatmap: many rows × series." },
        sql: { type: "string", description: "SELECT returning label column first, then numeric series columns with readable aliases, ordered for display." },
      },
      required: ["title", "chart_type", "sql"],
    },
  },
  {
    name: "show_data_table",
    description: "Show a full data table to the user — the server runs your SELECT and displays EVERY row in a paginated, sortable table with Excel/CSV download (up to 5000 rows). Use it whenever the user asks to list/show records or a breakdown has more than 8 rows. You get the first 200 rows back.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "Table title, e.g. 'All invoices — Gujarat branch, Aug 2026'" },
        sql: { type: "string", description: "SELECT returning the rows to show, with readable column aliases, ordered sensibly. No TOP/LIMIT unless the user asked for top-N." },
      },
      required: ["title", "sql"],
    },
  },
  {
    name: "describe_table",
    description: "List the columns of a SAP B1 table (e.g. OINV, INV1, OBPL, OCRD) — use when unsure a column exists.",
    parameters: {
      type: "object",
      properties: { table: { type: "string", description: "Table name, e.g. OINV" } },
      required: ["table"],
    },
  },
];

// Branch master (OBPL) goes into the prompt so "Gujarat branch" resolves
// immediately — OBPL.State holds GST state CODES ("GJ"), so a LIKE '%Gujarat%'
// search finds nothing and the model used to answer "₹0 sales".
const IN_STATES = { AN: "Andaman & Nicobar", AP: "Andhra Pradesh", AR: "Arunachal Pradesh", AS: "Assam", BR: "Bihar", CG: "Chhattisgarh", CH: "Chandigarh", DD: "Daman & Diu", DL: "Delhi", DN: "Dadra & Nagar Haveli", GA: "Goa", GJ: "Gujarat", HP: "Himachal Pradesh", HR: "Haryana", JH: "Jharkhand", JK: "Jammu & Kashmir", KA: "Karnataka", KL: "Kerala", LA: "Ladakh", MH: "Maharashtra", ML: "Meghalaya", MN: "Manipur", MP: "Madhya Pradesh", MZ: "Mizoram", NL: "Nagaland", OD: "Odisha", OR: "Odisha", PB: "Punjab", PY: "Puducherry", RJ: "Rajasthan", SK: "Sikkim", TN: "Tamil Nadu", TR: "Tripura", TS: "Telangana", UK: "Uttarakhand", UP: "Uttar Pradesh", WB: "West Bengal" };
const _branchCache = new Map(); // database -> { text, at }
async function loadBranchContext(executeSQL, database) {
  const hit = _branchCache.get(database);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.text;
  let text = "";
  try {
    const rows = await executeSQL("SELECT BPLId, BPLName, City, State, Disabled FROM OBPL");
    if (rows.length) {
      text = rows.map(r => `- BPLId ${r.BPLId} = ${r.BPLName}${r.City ? ` — ${r.City}` : ""}${r.State ? `, ${IN_STATES[String(r.State).toUpperCase()] || r.State} (State code ${r.State})` : ""}${r.Disabled === "Y" ? " [disabled]" : ""}`).join("\n");
    }
  } catch { /* no branches / no OBPL — fine */ }
  _branchCache.set(database, { text, at: Date.now() });
  return text;
}

function buildSystemPrompt({ dbType, database, today, companyContext, compact, branches, currency = { code: "INR", symbol: "₹" } }) {
  const dialect = dbType === "hana"
    ? `SAP HANA. Qualify tables as "${database}"."OINV". Use double quotes for identifiers, LIMIT n for top-N, ADD_MONTHS/ADD_DAYS, TO_DATE('YYYY-MM-DD').`
    : `Microsoft SQL Server (T-SQL). Tables can be used unqualified (OINV) or as [${database}].[dbo].[OINV]. Use TOP n, DATEADD/EOMONTH, 'YYYYMMDD' date literals.`;
  const isINR = currency.code === "INR";
  const currencyRule = isINR
    ? `Currency: ${currency.symbol} with Indian digit grouping (${currency.symbol}69,62,351) in tables. In prose you may use lakh/crore (${currency.symbol}6.63 L, ${currency.symbol}1.46 Cr) — only for figures taken from query results.`
    : `Currency: ${currency.symbol} with international digit grouping (${currency.symbol}6,962,351) in tables. In prose you may use K/M/B (${currency.symbol}696.2K, ${currency.symbol}6.96M, ${currency.symbol}1.2B) — only for figures taken from query results.`;

  return `You are a senior SAP Business One financial analyst with read-only SQL access to the company database "${database}".
Today is ${today}. Database dialect: ${dialect}
The company's base currency is ${currency.code} (${currency.symbol}) — every money figure you write must use this symbol.

## How to work
- Investigate like an analyst, not a query generator. Before answering, run every query you need:
  resolve names first (a customer name → OCRD with LIKE on CardCode and CardName), then pull headline totals, then breakdowns (top customers, items), then exceptions (cancellations, credit notes, losses, unpaid).
- Resolve relative dates yourself and state them ("last month" = the full previous calendar month relative to today).
- Do not stop after the first totals query. For any sales / purchase PERIOD question you MUST run at least:
  1. headline totals with CANCELED = 'N', in ONE query with exactly these measures:
     COUNT(*) AS Invoices, COUNT(DISTINCT CardCode) AS Customers, SUM(DocTotal - VatSum) AS NetSales, SUM(VatSum) AS Tax, SUM(DocTotal) AS InvoiceTotal, SUM(GrosProfit) AS GrossProfit,
     SUM(PaidToDate) AS Collected, SUM(CASE WHEN DocStatus = 'O' THEN DocTotal - PaidToDate ELSE 0 END) AS Outstanding,
     SUM(CASE WHEN DocStatus = 'C' THEN DocTotal - PaidToDate ELSE 0 END) AS ClosedWithoutPayment
  2. credit notes for the same filter
  3. cancelled documents (CANCELED = 'Y' only — 'C' rows are the reversal docs, counting both doubles it) — count and value, to report as excluded
  4. top customers with net sales, GP AND outstanding (open invoices) per customer
  5. sales by item from the lines table: quantity (with UnitMsr), net sales, GP, GP %
  6. exceptions: lines with negative GP, and the largest unpaid open invoices
  7. header net vs SUM(line totals) — to explain any gap
  8. comparison: the same headline measures (net sales, GP, invoices) for the PREVIOUS period of equal length and for the SAME period LAST YEAR, with growth % computed in SQL
     (one query with SUM(CASE WHEN DocDate BETWEEN … THEN … END) per period), plus net sales for each of the last 6 months (for the trend sparkline).
- Prefer several small aggregate queries over one huge query. Only SELECT is allowed — no WITH/CTE, no temp tables, no semicolons.
- If a query errors, read the error, fix the SQL and retry. Use describe_table if unsure of a column.
- If a filter on something the user NAMED (branch, customer, item, vendor) returns 0 rows, do not report zero — your filter is probably wrong. Check the master data (list the names, try LIKE on code and name, check state codes) and re-run. Only report "none found" after that check, and say what you checked.${branches ? `

## Branches in this company (OBPL) — use these BPLIds directly, no need to look them up
${branches}
A branch the user names by state or city (e.g. "Gujarat branch", "Mathura") maps to the matching row above. State is stored as a code.` : ""}
- Never invent numbers. Every ${currency.symbol} figure in the answer must be copied from a query result — the server checks every figure against your query results and sends back any that don't match.
- NEVER do arithmetic yourself for totals, "Others" rows, differences or percentages — you make mistakes. Compute them in SQL:
  totals from the headline query; "Others" = headline total − top-N (e.g. SUM(x) OVER () in the breakdown query, or a separate query);
  shares/growth % with an expression in the SELECT. The Total row of a table must equal the headline figure exactly.

## SAP B1 rules (SQL column values)
- Sales: OINV (A/R invoice header) + INV1 (lines). Credit notes: ORIN + RIN1 — subtract them for net sales.
- Exclude cancelled documents: CANCELED = 'N' (cancellation docs have CANCELED = 'C', originals 'Y'). Report the cancelled ones separately as a note, counting only CANCELED = 'Y'.
- Line tables (INV1, RIN1, PCH1, RDR1…) have NO BPLId / DocDate / CANCELED / CardCode filters you can trust — always JOIN the header (INV1 L JOIN OINV H ON L.DocEntry = H.DocEntry) and filter on H.
- Only state a cause (e.g. freight) if a query showed it; otherwise say "likely" and name what to check.
- Net sales excl. tax = DocTotal - VatSum (header) or SUM(LineTotal) (lines). Header vs line totals can differ by freight/document charges (TotalExpns) — mention the gap if you see it.
- Gross profit: OINV.GrosProfit (header) or INV1.GrssProfit (line). Margin % = GP / net sales.
- Receivables (fixed definitions — always use these, never another formula):
  Collected = SUM(PaidToDate); Collection % = Collected / InvoiceTotal (incl. GST) — never divide by net sales.
  Outstanding = unpaid amount on OPEN invoices only: SUM(CASE WHEN DocStatus = 'O' THEN DocTotal - PaidToDate ELSE 0 END).
  Closed without payment = SUM(CASE WHEN DocStatus = 'C' THEN DocTotal - PaidToDate ELSE 0 END) — invoices closed by credit note / journal without full payment. Show it as its own Summary line whenever it is not 0.
- Branch: BPLId / BPLName on the document header; branch master is OBPL. Customer: CardCode/CardName (OCRD). Item: ItemCode/Dscription (INV1), OITM. Quantity unit on the line: UnitMsr.
- Purchases: OPCH/PCH1 (AP invoice), OPOR (PO), OPDN (GRPO). Orders: ORDR/RDR1. Deliveries: ODLN.
- Use DocDate for period filters.
- "Last quarter" = the previous COMPLETE calendar quarter (Q1 Jan–Mar, Q2 Apr–Jun, Q3 Jul–Sep, Q4 Oct–Dec); "this quarter" = the current one to date. Use FY quarters (Q1 = Apr–Jun) only if the user says FY. State the dates.
- Purchase side (OPCH/ORPC): PaidToDate means "Paid" to the vendor and open DocTotal - PaidToDate is "Payable" — never call it collected/outstanding from customers.
- "This year" = calendar year to date unless the user says FY / financial year (India: 1 Apr – 31 Mar). Say which you used.
  Year-on-year comparisons must be like-for-like: compare the same months (and the same days of the current, partial month) — say so.

## Charts
- Call show_chart in MOST answers: always when the user asks for a chart / graph / trend / month-wise / comparison, and also whenever the answer has a time dimension or 3+ comparable categories (top customers, items, branches, vendors, ageing buckets). Skip it only for single-number answers or pure lists of documents.
- Up to ${MAX_CHARTS} charts, each a different view that adds something (e.g. monthly trend line + top-customers pareto + item mix doughnut). Put one [[CHART]] marker per chart, in the order you created them.
- The first column must be a TEXT label so it plots on the X axis — never a bare month number. Numeric series get readable aliases.
  Month-wise T-SQL pattern: SELECT LEFT(DATENAME(month, DocDate), 3) AS [Month], SUM(CASE WHEN YEAR(DocDate) = 2026 THEN DocTotal - VatSum ELSE 0 END) AS [2026 Sales], SUM(CASE WHEN YEAR(DocDate) = 2025 THEN DocTotal - VatSum ELSE 0 END) AS [2025 Sales] FROM OINV WHERE CANCELED = 'N' AND ... GROUP BY MONTH(DocDate), DATENAME(month, DocDate) ORDER BY MONTH(DocDate)
  (HANA: TO_VARCHAR(DocDate, 'Mon') and MONTH(DocDate).)
- For a period-vs-period comparison you MUST also run a separate query for the like-for-like YTD totals of both years (same start date, same day-of-year end date, e.g. 2026-01-01..2026-09-25 vs 2025-01-01..2025-09-25) and report growth %.
  In the month table add a Growth % column, mark the current month as partial (e.g. "Sep*" with a footnote), and leave future months out of the table.
- Before writing a claim like "every month", "consistently", "all", check it against every row. Name the exceptions.
${companyContext ? `\n## Company-specific context\n${companyContext}\n` : ""}
## Simple questions get a simple answer
If the user asks for ONE figure or fact ("total sales this month", "how many open orders", "stock of item X", "who is the top customer") or the result is only 1–2 rows,
answer directly: one or two sentences with the figure(s) in **bold** (a tiny table only if it genuinely helps), then the followups block. No kpis block, no chart, no Summary, no Points to note.

## Analysis answers — ALWAYS this exact layout, in this order (every other question, including lists of records)
1. Lead line: one sentence stating exactly what was analysed (entity, period resolved to real dates, database).
2. KPI block (rendered as colourful tiles — 3 to 6 tiles, most important first). Every value must come from a query result:
\`\`\`kpis
[{"label": "Net sales", "value": 6962351.23, "unit": "inr", "change_pct": -8.2, "vs": "vs Jul 2026", "yoy_pct": -17.1, "vs_yoy": "vs Aug 2025", "spark": [8345738, 7932685, 6629591, 5305638, 5296125, 6962351], "def": "Invoice total − GST, cancelled invoices excluded"},
 {"label": "Gross margin", "value": 13.3, "unit": "pct", "note": "GP 927737.5", "def": "Gross profit ÷ net sales"},
 {"label": "Outstanding", "value": 1215376, "unit": "inr", "note": "open invoices", "def": "Unpaid amount on open invoices (DocTotal − PaidToDate, DocStatus = O)"}]
\`\`\`
   "value" is the RAW number copied exactly from a query result — never pre-format it (no currency symbol, no K/M/B or L/Cr, no commas); the screen formats it. unit: inr | pct | count | qty.
   "def" (REQUIRED): one short line saying how the figure is calculated — shown when the user hovers the tile.
   For sales/purchase period questions, the main value tiles MUST carry "change_pct"+"vs" (vs previous period) and "yoy_pct"+"vs_yoy" (vs same period last year) from query 8, and the first tile a 6-month "spark".
   Otherwise include change fields only when you actually queried a comparison. "note" is a short sub-line (raw numbers in it are fine).
3. [[CHART]] marker(s) on their own lines (one per show_chart call).
4. ### Summary — a Measure | Amount table of the headline figures (for sales: Invoices, Customers, Net sales, Tax, Invoice total, Gross profit + margin %, Collected + %, Outstanding (open invoices), Closed without payment when not 0), then one sentence on exclusions (credit notes, cancelled docs).
5. Detail:
   - A list of records (invoices, orders, customers, items…) or any breakdown with MORE than 8 rows → call show_data_table with the full query and put [[TABLE]] on its own line here. The screen shows EVERY row with pagination and Excel download — never cut rows, never roll them into "Others", never repeat those rows as a markdown table.
   - Breakdowns of 8 rows or fewer → a markdown table with a heading (### Top customers, ### Sales by item…), ending with a **Total** row when totals make sense.
6. ### Points to note — see the rules below.
7. The followups block (last).

## Rules for the parts above
- **Points to note**: 3–6 bullets with the genuinely interesting findings — concentration (e.g. "item X brought 40% of sales and 58% of profit"), low/negative margins naming the item and customer, the biggest unpaid invoices by name and amount, the change vs last period / last year, data gaps. Never restate the summary numbers as a "point" — only add insight the tables don't already show.
- Start every "Points to note" bullet with ONE tag emoji so it can be colour-coded: 📈 growth/good news · 🏆 top performer · ⚠️ risk/concern · 🔻 decline · 💰 cash/collections · 📦 stock/operations · 💡 idea/recommendation.
- In tables, show changes as "▲ 12.4%" / "▼ 8.1%", and end breakdown tables with a **Total** row when totals make sense.
- ${currencyRule}
- Do NOT show SQL in the answer. No preamble like "Sure!". Be concise and factual.
- END the answer with a plain list of the follow-up questions the user would most likely ask next about THIS question — drill-downs, comparisons and related checks that build directly on what the user asked and what your results showed (name the actual customers, items, branches, months from your results — no generic questions). Each must be self-contained and answerable from SAP B1 data:
\`\`\`followups
["<follow-up 1>", "<follow-up 2>", "<follow-up 3>"]
\`\`\`
  Shapes that work (fill in real names/periods from YOUR results — never copy these literally): "Show <item> margin by month for the last 12 months" · "List <customer>'s unpaid invoices with days overdue" · "Compare <branch> sales for <month> vs the same month last year" · "Top 10 <items/customers> by <measure> for <period>".
  Every follow-up must be a DATA request this system can answer with a query, starting with Show / List / Compare / Which / Top / Trend of. Never "why…", "how can we…", "what strategies…" questions. No role labels or grouping.
  ${compact ? "Give 3 follow-ups." : "Give 5 follow-ups, most relevant first."}${compact ? `

## This is one of several questions the user asked at once
Answer ONLY this question, compactly, in the same layout: lead line, KPI block (3–4 tiles), one chart if useful, at most two small tables (use show_data_table for anything longer), 2–3 points to note, followups. You may skip query 8 (comparisons) unless the question asks for a comparison. Do not add a top-level heading (the question is already shown as the heading).` : ""}`;
}

// Pulls the ```kpis and ```followups JSON blocks out of the final answer.
// The KPI block's position is kept as a [[KPIS]] marker so the tiles render
// where the AI put them; follow-ups are returned separately (the caller puts
// them at the very end, merged across questions for multi-question replies).
// A malformed block is dropped rather than shown as raw JSON.
export function extractRichBlocks(text) {
  let kpis = null, followups = null;
  const parse = s => { try { return JSON.parse(s.trim()); } catch { return null; } };
  let out = String(text || "").replace(/```kpis\s*([\s\S]*?)```/i, (_, body) => {
    const v = parse(body);
    kpis = Array.isArray(v) ? v.filter(k => k && k.label && k.value != null && k.value !== "").slice(0, 8) : null;
    return kpis?.length ? "[[KPIS]]" : "";
  });
  out = out.replace(/```followups\s*([\s\S]*?)```/i, (_, body) => {
    const v = parse(body);
    // A flat list; an object of groups (older prompt) is flattened.
    const list = Array.isArray(v) ? v : v && typeof v === "object" ? Object.values(v).flat() : [];
    followups = list.map(q => String(q).trim()).filter(Boolean).slice(0, 8);
    return "";
  });
  // The model sometimes skips the ```followups fence and writes a "Follow-ups"
  // heading followed by a raw JSON array or a bullet/numbered list instead —
  // take those questions and strip the whole tail so it isn't shown twice.
  const tail = out.match(/\n+[ \t]*(?:#{1,4}[ \t]*)?\**[ \t]*(?:💡[ \t]*)?(?:follow[- ]?ups?(?:[ \t]+questions?)?|you (?:would|might) also like to check|suggested questions?)\**[ \t]*:?\**[ \t]*(?:\n[\s\S]*)?$/i);
  if (tail) {
    const body = tail[0].replace(/^[^\n]*\n?/, "").replace(/^\s*\n/, "");
    if (!followups?.length) {
      const arr = parse(((body.match(/\[[\s\S]*\]/) || [""])[0]));
      followups = Array.isArray(arr)
        ? arr.map(q => String(q).trim()).filter(Boolean)
        : body.split("\n").map(l => (l.match(/^\s*(?:[-*•]|\d{1,2}[.)])\s+(.+)$/) || [])[1]).filter(Boolean).map(q => q.replace(/^["']|["'],?$/g, "").trim());
      followups = followups.slice(0, 8);
    }
    out = out.slice(0, tail.index);
  }
  return { text: out.trim(), kpis: kpis?.length ? kpis : null, followups: followups?.length ? followups : null };
}

function formatRowsForModel(rows) {
  const sample = rows.slice(0, MAX_ROWS_TO_MODEL);
  let text = JSON.stringify({ rowCount: rows.length, truncated: rows.length > MAX_ROWS_TO_MODEL, rows: sample });
  if (text.length > MAX_RESULT_CHARS) text = text.slice(0, MAX_RESULT_CHARS) + ' …[truncated — aggregate further]"';
  return text;
}

// ── Figure check ──────────────────────────────────────────────────────────────
// Every currency figure the AI writes (and every inr/count/qty KPI value) must
// match a number that actually came back from one of its queries. Catches the
// lakh/crore/K/M/B slips (₹15.23 L written for 1,52,250) and hand arithmetic.
// Both scale vocabularies are accepted regardless of company currency — it
// only affects which one the prompt tells the AI to prefer.
const MULT = {
  cr: 1e7, crore: 1e7, crores: 1e7, l: 1e5, lakh: 1e5, lakhs: 1e5, lac: 1e5, lacs: 1e5,
  b: 1e9, bn: 1e9, billion: 1e9, billions: 1e9, m: 1e6, mn: 1e6, million: 1e6, millions: 1e6,
  k: 1e3, thousand: 1e3, thousands: 1e3,
};

function collectNumbers(rows, into) {
  for (const r of rows) {
    for (const v of Object.values(r)) {
      const n = typeof v === "number" ? v : (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : NaN);
      if (isFinite(n)) { into.push(n); if (n < 0) into.push(-n); }
    }
  }
}

function hasMatch(sorted, value, tol) {
  // binary search for the first element >= value - tol
  let lo = 0, hi = sorted.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] < value - tol) lo = mid + 1; else hi = mid; }
  return lo < sorted.length && sorted[lo] <= value + tol;
}

/** Returns the figures in `answer` that match no query result (as written). */
export function findUnverifiedFigures(answer, numbers, currency = { symbol: "₹" }) {
  if (!numbers.length) return [];
  const sorted = [...numbers].sort((a, b) => a - b);
  const bad = [];
  const body = String(answer || "").replace(/```(?:kpis|followups)[\s\S]*?```/gi, "");
  const sym = String(currency.symbol || "₹").trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`${sym}\\s?(-?[\\d,]+(?:\\.\\d+)?)\\s*(crores?|cr|lakhs?|lacs?|lac|l|billions?|bn|b|millions?|mn|m|thousands?|k)?\\b`, "gi");
  let m;
  while ((m = re.exec(body))) {
    const digits = m[1].replace(/,/g, "");
    const n = Number(digits);
    if (!isFinite(n)) continue;
    const unit = (m[2] || "").toLowerCase();
    const mult = MULT[unit] || 1;
    const decimals = (digits.split(".")[1] || "").length;
    const value = Math.abs(n * mult);
    if (value < 1) continue;
    const tol = 0.51 * Math.pow(10, -decimals) * mult + value * 0.0005;
    if (!hasMatch(sorted, value, tol)) bad.push(m[0].trim());
  }
  const kb = String(answer || "").match(/```kpis\s*([\s\S]*?)```/i);
  if (kb) {
    try {
      for (const k of JSON.parse(kb[1].trim())) {
        if (!["inr", "count", "qty"].includes(k?.unit) || typeof k.value !== "number") continue;
        const v = Math.abs(k.value);
        if (v >= 1 && !hasMatch(sorted, v, 1 + v * 0.0005)) bad.push(`KPI "${k.label}" = ${k.value}`);
      }
    } catch { /* malformed block is dropped later anyway */ }
  }
  return [...new Set(bad)];
}

// ── Answer cache ──────────────────────────────────────────────────────────────
// Same question on the same database within 10 minutes → instant answer.
// Only for fresh questions (no conversation history to resolve against).
const _answerCache = new Map(); // key -> { at, result }
const cacheKey = (database, message, compact) =>
  `${database}::${compact ? "c" : "f"}::${String(message).toLowerCase().replace(/[^\p{L}\p{N}%₹$]+/gu, " ").trim()}`;

/**
 * @param {object} opts
 * @param {string} opts.message            user question
 * @param {Array}  [opts.history]          prior turns [{role:"user"|"assistant", content:string}]
 * @param {Function} opts.executeSQL       (sql) => rows
 * @param {Function} [opts.getTableColumns] (table) => columns
 * @param {string} opts.dbType             "mssql" | "hana"
 * @param {string} opts.database           company DB / schema name
 * @param {string} [opts.companyContext]   extra schema hints (UDFs, dimensions)
 * @param {Function} [opts.chatComplete]   OpenAI-format client (Azure GPT)
 * @param {Function} [opts.chatCompleteStream] (body, onDelta) => same shape as chatComplete, streaming the text
 * @param {Function} [opts.messagesCreate] Anthropic-format client (Azure Claude / Anthropic)
 * @param {string} [opts.model]            model id for messagesCreate
 * @param {Function} [opts.onStep]         progress callback (text)
 * @param {Function} [opts.onDelta]        live answer text: (chunk) appends, (null) = discard what was streamed so far
 * @returns {Promise<{text, kpis, followups, charts, tables, queries, unverified, cachedAt?}>}
 */
export async function runSqlAnalystAgent(opts) {
  const { message, history = [], database, compact = false } = opts;
  const useCache = !history.length;
  const key = cacheKey(database, message, compact);
  if (useCache) {
    const hit = _answerCache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
      log(`\n[SQL-ANALYST] Cache hit (${Math.round((Date.now() - hit.at) / 1000)}s old): ${message}`);
      return { ...hit.result, cachedAt: hit.at };
    }
  }
  const result = await runAnalysis(opts);
  if (useCache) {
    _answerCache.set(key, { at: Date.now(), result });
    while (_answerCache.size > CACHE_MAX) _answerCache.delete(_answerCache.keys().next().value);
  }
  return result;
}

async function runAnalysis(opts) {
  const { message, history = [], executeSQL, getTableColumns, dbType, database, companyContext,
          chatComplete, chatCompleteStream, messagesCreate, model, onStep = () => {}, onDelta = null, compact = false,
          currency = { code: "INR", symbol: "₹" } } = opts;
  if (!chatComplete && !messagesCreate) throw new Error("No AI client configured for the SQL analyst agent.");

  const branches = await loadBranchContext(executeSQL, database);
  const system = buildSystemPrompt({ dbType, database, today: new Date().toISOString().slice(0, 10), companyContext, compact, branches, currency });
  const queries = [];
  const numbers = [];  // every number any query returned — for the figure check
  const charts = [];   // set by show_chart: [{ title, chartType, sql, rows }]
  const tables = [];   // set by show_data_table: [{ title, sql, rows, total }] — every row, shown paginated
  const norm = x => String(x || "").replace(/\s+/g, " ").trim().toLowerCase();

  const runTool = async (name, args) => {
    if (name === "run_sql") {
      const sql = String(args.sql || "").trim().replace(/;+\s*$/, "");
      onStep(`${args.purpose || "Querying"} — ${sql.replace(/\s+/g, " ").slice(0, 140)}`);
      try {
        const t0 = Date.now();
        const rows = await executeSQL(sql);
        queries.push({ purpose: args.purpose, sql, rows: rows.length, error: null });
        collectNumbers(rows, numbers);
        const preview = logMode() === "full" ? rows : rows.slice(0, 5);
        logBlock(`DB RESULT — ${rows.length} row(s) in ${Date.now() - t0} ms${logMode() === "full" || rows.length <= 5 ? "" : " (first 5 shown)"}`,
                 preview.length ? JSON.stringify(preview, null, 2) : "(no rows)");
        return formatRowsForModel(rows);
      } catch (e) {
        queries.push({ purpose: args.purpose, sql, rows: 0, error: e.message });
        logBlock("DB ERROR (sent back to AI so it can fix the SQL)", e.message);
        return `SQL error: ${e.message}`;
      }
    }
    if (name === "show_chart") {
      const sql = String(args.sql || "").trim().replace(/;+\s*$/, "");
      onStep(`Building chart — ${args.title || ""}`);
      try {
        const rows = await executeSQL(sql);
        queries.push({ purpose: `Chart: ${args.title || ""}`, sql, rows: rows.length, error: null });
        collectNumbers(rows, numbers);
        if (!rows.length) return "Chart query returned no rows — no chart shown. Fix the query or explain in the answer.";
        const entry = { title: args.title || "", chartType: args.chart_type || "bar", sql, rows: rows.slice(0, 500) };
        // Re-issued after a push-back → replace, don't show it twice.
        const dup = charts.findIndex(c => norm(c.sql) === norm(sql) || norm(c.title) === norm(entry.title));
        if (dup >= 0) charts[dup] = entry;
        else if (charts.length >= MAX_CHARTS) return `Only ${MAX_CHARTS} charts can be shown — this one was not added. Use the ones you already have.`;
        else charts.push(entry);
        logBlock(`CHART ${charts.length} DATA — ${args.chart_type} · ${rows.length} row(s)`, JSON.stringify(rows.slice(0, 13), null, 2));
        return `Chart ${dup >= 0 ? dup + 1 : charts.length} will be shown to the user (put a [[CHART]] marker for it). Data: ${formatRowsForModel(rows)}`;
      } catch (e) {
        queries.push({ purpose: `Chart: ${args.title || ""}`, sql, rows: 0, error: e.message });
        logBlock("CHART SQL ERROR (sent back to AI)", e.message);
        return `SQL error: ${e.message}`;
      }
    }
    if (name === "show_data_table") {
      const sql = String(args.sql || "").trim().replace(/;+\s*$/, "");
      onStep(`Preparing table — ${args.title || ""}`);
      try {
        const rows = await executeSQL(sql);
        queries.push({ purpose: `Table: ${args.title || ""}`, sql, rows: rows.length, error: null });
        collectNumbers(rows, numbers);
        if (!rows.length) return "Table query returned no rows — nothing shown. Say so in the answer.";
        const entry = { title: args.title || "", sql, rows: rows.slice(0, 5000), total: rows.length };
        const dup = tables.findIndex(t => norm(t.sql) === norm(sql) || norm(t.title) === norm(entry.title));
        if (dup >= 0) tables[dup] = entry; else tables.push(entry);
        logBlock(`DATA TABLE — ${rows.length} row(s)`, args.title || "");
        return `Table with all ${rows.length} rows${rows.length > 5000 ? " (first 5000 shown)" : ""} will be shown to the user (paginated). Put [[TABLE]] where it belongs; do not repeat these rows as a markdown table. Data: ${formatRowsForModel(rows)}`;
      } catch (e) {
        queries.push({ purpose: `Table: ${args.title || ""}`, sql, rows: 0, error: e.message });
        return `SQL error: ${e.message}`;
      }
    }
    if (name === "describe_table") {
      onStep(`Checking columns of ${args.table}`);
      if (!getTableColumns) return "describe_table is not available.";
      try { return JSON.stringify([...await getTableColumns(args.table)]).slice(0, MAX_RESULT_CHARS); }
      catch (e) { return `Error: ${e.message}`; }
    }
    return `Unknown tool ${name}`;
  };

  const priorTurns = history.filter(h => typeof h.content === "string" && h.content)
                            .map(h => ({ role: h.role === "assistant" ? "assistant" : "user", content: h.content }));

  logBlock(`NEW QUESTION  (db=${database}, dialect=${dbType}, provider=${chatComplete ? "GPT (OpenAI format)" : `Claude (${model})`})`, message);
  logBlock(`SYSTEM PROMPT (${system.length} chars)${logMode() === "full" ? "" : " — set SQL_ANALYST_LOG=full to print it all"}`,
           logMode() === "full" ? system : system.slice(0, 1500) + "\n…");
  if (priorTurns.length) logBlock(`CONVERSATION HISTORY (${priorTurns.length} messages)`,
           priorTurns.map(t => `${t.role.toUpperCase()}: ${t.content.slice(0, 300)}`).join("\n\n"));

  // Reviews each would-be final answer. Returns a push-back message, or null
  // to accept it. Each check fires at most once so an answer always lands:
  //  1. layout — no chart after a real analysis, no KPI block, no Points to note
  //  2. figures — ₹ amounts / KPI values that match no query result
  // Sales / purchase question about a period → the comparison (query 8) is required.
  const periodQuestion = /\b(sales|sale|revenue|turnover|purchase|purchases|buying)\b/i.test(message)
    && /\b(month|year|quarter|week|today|yesterday|ytd|mtd|fy|20\d\d|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*/i.test(message);
  let structureChecked = false, figuresChecked = false;
  const review = (answer) => {
    if (!queries.some(q => !q.error)) return null;
    if (!structureChecked) {
      structureChecked = true;
      const missing = [];
      const okSql = queries.filter(q => !q.error).map(q => q.sql).join("\n");
      // Layout — only for real analyses; 1–2 row answers stay short.
      if (queries.some(q => !q.error && q.rows > 2)) {
        if (!charts.length && queries.filter(q => !q.error).length >= 2) missing.push("a chart: call show_chart for the most useful visual (a time trend, or the top customers/items/categories you found) and put [[CHART]] on its own line");
        if (!/```kpis/i.test(answer)) missing.push("the kpis block with 3-6 tiles, each with a \"def\" (for a list: e.g. number of records, total value, largest one); query any totals you still need");
        if (!/points to note/i.test(answer)) missing.push("### Points to note with 2-5 tagged bullets");
      }
      // Fixed definitions — the AI tends to fall back to DocTotal − PaidToDate over ALL invoices.
      if (/\b(outstanding|payable|receivable)/i.test(answer) && /\b(OINV|OPCH|ORDR|OPOR)\b/i.test(okSql) && !/DocStatus\s*=\s*'O'/i.test(okSql)) {
        missing.push("the correct Outstanding: it is the unpaid amount on OPEN documents only — recompute with SUM(CASE WHEN DocStatus = 'O' THEN DocTotal - PaidToDate ELSE 0 END), and ClosedWithoutPayment = SUM(CASE WHEN DocStatus = 'C' THEN DocTotal - PaidToDate ELSE 0 END) (show it as its own Summary line when not 0). Replace every Outstanding figure in the answer (tiles, Summary, customer table)");
      }
      if (periodQuestion && !compact && /```kpis/i.test(answer) && !/"(change_pct|yoy_pct)"\s*:\s*-?\d/.test(answer)) {
        missing.push("the comparison: run query 8 (same measures for the previous period and the same period last year, growth % computed in SQL, plus net sales for the last 6 months) and add change_pct/vs, yoy_pct/vs_yoy and spark to the main KPI tiles");
      }
      if (missing.length) {
        log(`\n[SQL-ANALYST] Answer needs: ${missing.map(m => m.split(":")[0].split(" with")[0]).join(", ")} — sending it back`);
        return `Your answer is not complete yet. Fix the following:\n- ${missing.join("\n- ")}\nDo that now (run any queries you need), then write the COMPLETE final answer again in the required layout (lead line, kpis block, [[CHART]], ### Summary, detail tables / [[TABLE]], ### Points to note, followups block).`;
      }
    }
    if (!figuresChecked) {
      figuresChecked = true;
      const bad = findUnverifiedFigures(answer, numbers, currency);
      if (bad.length) {
        log(`\n[SQL-ANALYST] Figures not found in any query result: ${bad.join(", ")} — asking the AI to correct them`);
        const scaleHint = currency.code === "INR"
          ? "convert to lakh/crore carefully: 1 L = 1,00,000; 1 Cr = 1,00,00,000"
          : "convert to K/M/B carefully: 1K = 1,000; 1M = 1,000,000; 1B = 1,000,000,000";
        return `These figures in your answer do not match any number returned by your queries:\n- ${bad.join("\n- ")}\nCopy the exact numbers from your query results (${scaleHint}), or run a query that computes the figure. Then write the COMPLETE final answer again.`;
      }
    }
    return null;
  };

  onStep("Planning the analysis…");
  const result = chatComplete
    ? await loopOpenAI({ chatComplete, chatCompleteStream, onDelta, system, priorTurns, message, runTool, onStep, queries, review })
    : await loopAnthropic({ messagesCreate, model, system, priorTurns, message, runTool, onStep, queries, review });
  const unverified = findUnverifiedFigures(result.text, numbers, currency);
  if (unverified.length) log(`[SQL-ANALYST] Still unverified after correction: ${unverified.join(", ")}`);
  const rich = extractRichBlocks(result.text);
  // The model sometimes skips the followups block — ask for it separately
  // (one small call) so every answer ends with suggestions.
  if (!rich.followups) rich.followups = await generateFollowups(message, rich.text, { chatComplete, messagesCreate, model }, compact ? 3 : 5);
  return { ...result, ...rich, charts, tables, unverified };
}


function logAiToolCall(name, args) {
  if (name === "run_sql") logBlock(`AI WROTE SQL — ${args.purpose || ""}`, String(args.sql || "").trim());
  else logBlock(`AI CALLED ${name}`, JSON.stringify(args));
}

async function loopOpenAI({ chatComplete, chatCompleteStream, onDelta, system, priorTurns, message, runTool, onStep, queries, review }) {
  const tools = TOOL_DEFS.map(t => ({ type: "function", function: t }));
  const messages = [{ role: "system", content: system }, ...priorTurns, { role: "user", content: message }];
  const streaming = !!(chatCompleteStream && onDelta);

  for (let step = 0; step < MAX_STEPS; step++) {
    const lastRound = step === MAX_STEPS - 1;
    const t0 = Date.now();
    const body = { messages, tools, tool_choice: lastRound ? "none" : "auto", max_tokens: 4096, temperature: 0 };
    let streamed = false;
    const res = streaming
      ? await chatCompleteStream(body, chunk => { streamed = true; onDelta(chunk); })
      : await chatComplete(body);
    const msg = res.choices[0].message;
    const calls = msg.tool_calls || [];
    const usage = res.usage ? ` · tokens in=${res.usage.prompt_tokens} out=${res.usage.completion_tokens}` : "";
    log(`\n[SQL-ANALYST] AI round ${step + 1} — ${Date.now() - t0} ms${usage} — ${calls.length ? `${calls.length} tool call(s)` : "final answer"}`);
    const pushBack = !calls.length && !lastRound ? review(msg.content || "") : null;
    // Streamed text that turned out not to be the final answer (tool-call
    // round with some "thinking" text, or an answer sent back) is discarded.
    if (streamed && (calls.length || pushBack)) onDelta(null);
    if (pushBack) {
      messages.push({ role: "assistant", content: msg.content || "" }, { role: "user", content: pushBack });
      continue;
    }
    if (!calls.length) {
      logBlock("AI FINAL ANSWER", msg.content || "(empty)");
      onStep("Writing up the analysis…");
      return { text: msg.content || "", queries };
    }
    if (msg.content) logBlock("AI THINKING", msg.content);
    messages.push(msg);
    for (const tc of calls) {
      let args = {};
      try { args = JSON.parse(tc.function.arguments || "{}"); } catch {}
      logAiToolCall(tc.function.name, args);
      messages.push({ role: "tool", tool_call_id: tc.id, content: await runTool(tc.function.name, args) });
    }
  }
  throw new Error("Analysis did not finish within the step limit.");
}

async function loopAnthropic({ messagesCreate, model, system, priorTurns, message, runTool, onStep, queries, review }) {
  const tools = TOOL_DEFS.map(t => ({ name: t.name, description: t.description, input_schema: t.parameters }));
  const messages = [...priorTurns, { role: "user", content: message }];

  for (let step = 0; step < MAX_STEPS; step++) {
    const t0 = Date.now();
    const res = await messagesCreate({ model, system, messages, tools, max_tokens: 4096, temperature: 0 });
    const toolUses = (res.content || []).filter(b => b.type === "tool_use");
    const text = (res.content || []).filter(b => b.type === "text").map(b => b.text).join("\n");
    const usage = res.usage ? ` · tokens in=${res.usage.input_tokens} out=${res.usage.output_tokens}` : "";
    log(`\n[SQL-ANALYST] AI round ${step + 1} — ${Date.now() - t0} ms${usage} — ${toolUses.length ? `${toolUses.length} tool call(s)` : "final answer"}`);
    const pushBack = !toolUses.length && step < MAX_STEPS - 1 ? review(text) : null;
    if (pushBack) {
      messages.push({ role: "assistant", content: res.content }, { role: "user", content: pushBack });
      continue;
    }
    if (!toolUses.length) {
      logBlock("AI FINAL ANSWER", text || "(empty)");
      onStep("Writing up the analysis…");
      return { text, queries };
    }
    if (text) logBlock("AI THINKING", text);
    messages.push({ role: "assistant", content: res.content });
    const results = [];
    for (const b of toolUses) {
      logAiToolCall(b.name, b.input || {});
      results.push({ type: "tool_result", tool_use_id: b.id, content: await runTool(b.name, b.input || {}) });
    }
    messages.push({ role: "user", content: results });
  }
  throw new Error("Analysis did not finish within the step limit.");
}

// ── Multiple questions in one message ────────────────────────────────────────
// "1. sales last month  2. top 10 customers  3. overdue invoices …" — split
// into self-contained questions, answer each with its own full analyst loop
// (multi-query, own charts), a few at a time, and hand back every answer.

// Cheap pre-check so a normal single question never pays for a split call.
export function mightBeMultiQuestion(msg) {
  const m = String(msg || "");
  const listItems = (m.match(/^\s*(\d{1,2}[.):]|[-*•])\s+\S/gm) || []).length;
  const lines = m.split(/\n+/).filter(l => l.trim().length > 8).length;
  const qMarks = (m.match(/\?/g) || []).length;
  return listItems >= 2 || lines >= 2 || qMarks >= 2 || /;\s*\S/.test(m)
      || /\b(and also|also give|also show|as well as|along with|another question|next question)\b/i.test(m);
}

async function askText({ chatComplete, messagesCreate, model }, prompt, maxTokens = 2000) {
  if (chatComplete) {
    const r = await chatComplete({ messages: [{ role: "user", content: prompt }], max_tokens: maxTokens, temperature: 0 });
    return r.choices[0].message.content || "";
  }
  const r = await messagesCreate({ model, messages: [{ role: "user", content: prompt }], max_tokens: maxTokens, temperature: 0 });
  return (r.content || []).filter(b => b.type === "text").map(b => b.text).join("");
}

async function generateFollowups(question, answer, ai, n) {
  const prompt = `A user asked a SAP Business One data analyst: "${question}"
The answer was:
"""
${String(answer || "").slice(0, 5000)}
"""
Write the ${n} follow-up questions this user would most likely ask next — drill-downs, comparisons and related checks that build directly on this question and name the actual customers, items, branches or months in the answer. Each must be a self-contained data request answerable from SAP B1 data, starting with Show / List / Compare / Which / Top / Trend of. No "why"/"how can we" questions.
Respond with ONLY a JSON array of strings.`;
  try {
    const raw = await askText(ai, prompt, 600);
    const arr = JSON.parse((raw.match(/\[[\s\S]*\]/) || ["[]"])[0]);
    const list = (Array.isArray(arr) ? arr : []).map(q => String(q).trim()).filter(Boolean).slice(0, n);
    if (list.length) log(`[SQL-ANALYST] Follow-ups generated separately (${list.length})`);
    return list.length ? list : null;
  } catch { return null; }
}

/** Returns an array of self-contained questions (length 1 = not a multi-question message). */
export async function splitQuestions(message, ai) {
  const prompt = `The user sent this message to a SAP Business One data analyst:
"""
${message}
"""
Split it into the separate, independent questions it contains.
Rules:
- ONE question that has several facets stays ONE item. "sales this year month-wise with chart and last year comparison" is ONE question. "sales by branch and by item" is ONE question.
- Separate items only when they ask about genuinely different things (e.g. "last month sales" and "top overdue customers" and "stock of item X").
- Each item must stand alone: repeat any shared context (branch, customer, item, period, company) that applies to it.
- A fragment that only adds to another question ("also include growth %", "with chart", "and export it", "same for last year") is merged INTO that question, never its own item.
- Keep the user's wording and language; fix only obvious typos. Keep the original order. Include EVERY question — never drop or summarise any, however many there are.
Respond with ONLY a JSON array of strings, no markdown fences.`;
  try {
    const raw = await askText(ai, prompt, 8000);
    const arr = JSON.parse((raw.match(/\[[\s\S]*\]/) || ["[]"])[0]);
    const qs = Array.isArray(arr) ? arr.map(q => String(q).trim()).filter(Boolean) : [];
    if (qs.length) log(`\n[SQL-ANALYST] Split into ${qs.length} question(s):\n${qs.map((q, i) => `  ${i + 1}. ${q}`).join("\n")}`);
    return qs.length ? qs : [message];
  } catch (e) {
    log(`[SQL-ANALYST] Question split failed (${e.message}) — answering as one question`);
    return [message];
  }
}

/**
 * Answers each question with its own runSqlAnalystAgent loop, `concurrency`
 * at a time. Never throws for a single question — a failure becomes that
 * question's `error` so the other answers still come back.
 * Every question is answered — there is no cap on how many.
 * onAnswer(index, result) fires as soon as each answer is ready, so the
 * caller can show it straight away instead of waiting for the slowest one.
 * @returns {Promise<{results: Array<{question,text,queries,charts,tables,kpis,followups,unverified,error,ms}>, skipped: string[]}>}
 */
export async function runMultiQuestionAnalysis(questions, baseOpts, { concurrency = 3, onAnswer = null } = {}) {
  const onStep = baseOpts.onStep || (() => {});
  const list = questions, skipped = [];
  const results = new Array(list.length);
  let next = 0, done = 0;
  onStep(`Answering ${list.length} questions (${Math.min(concurrency, list.length)} at a time)…`);
  const worker = async () => {
    while (next < list.length) {
      const i = next++;
      const q = list[i], t0 = Date.now();
      const tag = `[${i + 1}/${list.length}]`;
      try {
        // No token streaming here — parallel answers would interleave.
        const r = await runSqlAnalystAgent({ ...baseOpts, onDelta: null, message: q, compact: list.length > 1, onStep: s => onStep(`${tag} ${s}`) });
        results[i] = { question: q, text: r.text, queries: r.queries, charts: r.charts, tables: r.tables, kpis: r.kpis, followups: r.followups, unverified: r.unverified || [], cachedAt: r.cachedAt, error: null, ms: Date.now() - t0 };
      } catch (e) {
        results[i] = { question: q, text: "", queries: [], charts: [], tables: [], kpis: null, followups: null, unverified: [], error: e.message, ms: Date.now() - t0 };
      }
      onStep(`✓ ${++done} of ${list.length} answered — "${q.slice(0, 60)}${q.length > 60 ? "…" : ""}"`);
      try { onAnswer?.(i, results[i]); } catch { /* a display hiccup must not lose the answer */ }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, list.length) }, worker));
  return { results, skipped };
}
