// ── Verified finance figures ("finance pack") ────────────────────────────────
// Statement-level finance questions (revenue, GP, EBITDA, net profit, cash
// flow, receivables, payables, working capital, balance sheet, ratios) used to
// be answered by the AI writing its own GL SQL — and it got the algebra wrong
// (revenue summed over ALL accounts, GP = 2× revenue, balance-sheet items
// taken as a period movement instead of an as-at balance, null current assets
// from a Levels = 2 filter on title accounts that never carry postings).
//
// Here the server runs a few fixed GL queries (JDT1 + OACT, per account) and
// classifies every account in JavaScript by walking its parent chain in the
// chart of accounts, so the figures are identical on every run. The AI gets
// them as verified facts plus ready-made charts/tables, and only writes the
// analysis. No dependency on chat-server.mjs — executeSQL is injected.

const PACK_RE = /\b(revenue|turnover|gross.?profit|gross.?margin|ebitda|ebit|net.?profit|net.?income|net.?loss|\bpat\b|\bpbt\b|operating.?profit|p\s?&\s?l|p\s?and\s?l|pnl|profit.?(and|&).?loss|income.?statement|balance.?sheet|cash.?flow|working.?capital|receivables?|payables?|current.?(assets?|liabilit\w*|ratio)|quick.?ratio|liquidity|solvency|debt.?(to|\/).?equity|\bdso\b|\bdpo\b|\bdio\b|cash.?conversion|financial.?(health|performance|summary|position|statements?|ratios?|kpis?)|cfo|board.?pack|mis.?report|net.?worth|total.?assets)\b/i;

/** Should this question get the verified finance figures? */
export function wantsFinancePack(message) {
  return PACK_RE.test(String(message || ""));
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const TRANS_TYPES = { "-2": "Opening balance", "-4": "Bank statement / reconciliation postings", "13": "A/R invoices", "14": "A/R credit memos", "18": "A/P invoices", "19": "A/P credit memos",
  "24": "Incoming payments (customers)", "25": "Deposits", "30": "Journal entries", "46": "Outgoing payments (vendors)", "57": "Checks for payment",
  "59": "Goods receipts", "60": "Goods issues", "321": "Internal reconciliation", "1470000071": "Depreciation run" };

// ── dates ────────────────────────────────────────────────────────────────────
const ymd = d => d.toISOString().slice(0, 10);
const utc = (y, m, d) => new Date(Date.UTC(y, m, d));
const addMonths = (d, n) => utc(d.getUTCFullYear(), d.getUTCMonth() + n, 1);
const addYears = (d, n) => {
  const t = utc(d.getUTCFullYear() + n, d.getUTCMonth(), d.getUTCDate());
  return t.getUTCMonth() !== d.getUTCMonth() ? utc(d.getUTCFullYear() + n, d.getUTCMonth() + 1, 0) : t; // 29 Feb → 28 Feb
};
const endOfMonth = d => utc(d.getUTCFullYear(), d.getUTCMonth() + 1, 0);
const toDate = v => { const d = v instanceof Date ? v : new Date(String(v).slice(0, 10) + "T00:00:00Z"); return isNaN(d) ? null : utc(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()); };
const fmtD = d => `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
const days = (a, b) => Math.round((b - a) / 86400000) + 1;
const monthKey = d => d.getUTCFullYear() * 100 + d.getUTCMonth() + 1;

/**
 * Picks the period the question is about. Supported: this/current month (MTD),
 * last month, this quarter (QTD), last quarter, last/previous FY, an explicit
 * "Month YYYY", "Qn YYYY", "FY YYYY"/"YYYY" — default: current FY to date.
 * Quarters follow the fiscal year. Returns null for anything it can't map
 * (the AI then runs its own queries for that period).
 */
export function resolveFinancePeriod(message, fy, today) {
  const m = String(message || "").toLowerCase();
  const fyStartMonth = fy.start.getUTCMonth();
  const qStartOf = d => { const off = ((d.getUTCMonth() - fyStartMonth) % 12 + 12) % 12; return addMonths(utc(d.getUTCFullYear(), d.getUTCMonth(), 1), -(off % 3)); };
  const fyStartOf = d => { const y = d.getUTCMonth() >= fyStartMonth ? d.getUTCFullYear() : d.getUTCFullYear() - 1; return utc(y, fyStartMonth, 1); };
  const fyLabel = start => fyStartMonth === 0 ? `FY${start.getUTCFullYear()}` : `FY${start.getUTCFullYear()}-${String((start.getUTCFullYear() + 1) % 100).padStart(2, "0")}`;
  const mk = (kind, start, end, label) => {
    const toDateEnd = end > today ? today : end;
    return { kind, start, end: toDateEnd, fullEnd: end, partial: end > today, label: end > today ? `${label} to date (${fmtD(start)} – ${fmtD(today)})` : `${label} (${fmtD(start)} – ${fmtD(end)})` };
  };

  const monthIdx = MONTHS.findIndex(x => new RegExp(`\\b${x.toLowerCase()}[a-z]*\\.?\\s*[-']?\\s*(20\\d\\d)\\b`).test(m));
  if (monthIdx >= 0) {
    const y = Number(m.match(new RegExp(`\\b${MONTHS[monthIdx].toLowerCase()}[a-z]*\\.?\\s*[-']?\\s*(20\\d\\d)\\b`))[1]);
    const s = utc(y, monthIdx, 1);
    if (s <= today) return mk("month", s, endOfMonth(s), `${MONTHS[monthIdx]} ${y}`);
  }
  const q = m.match(/\bq([1-4])\s*(?:fy\s*)?[-']?\s*(20\d\d)\b/);
  if (q) {
    const s = addMonths(utc(Number(q[2]), fyStartMonth, 1), (Number(q[1]) - 1) * 3);
    if (s <= today) return mk("quarter", s, endOfMonth(addMonths(s, 2)), `Q${q[1]} ${fyLabel(utc(Number(q[2]), fyStartMonth, 1))}`);
  }
  if (/\b(this|current)\s+month\b|\bmtd\b|month.?to.?date/.test(m)) { const s = utc(today.getUTCFullYear(), today.getUTCMonth(), 1); return mk("month", s, endOfMonth(s), `${MONTHS[s.getUTCMonth()]} ${s.getUTCFullYear()}`); }
  if (/\b(last|previous|prior)\s+month\b/.test(m)) { const s = addMonths(utc(today.getUTCFullYear(), today.getUTCMonth(), 1), -1); return mk("month", s, endOfMonth(s), `${MONTHS[s.getUTCMonth()]} ${s.getUTCFullYear()}`); }
  if (/\b(this|current)\s+quarter\b|\bqtd\b|quarter.?to.?date/.test(m)) { const s = qStartOf(today); return mk("quarter", s, endOfMonth(addMonths(s, 2)), "Current quarter"); }
  if (/\b(last|previous|prior)\s+quarter\b/.test(m)) { const s = addMonths(qStartOf(today), -3); return mk("quarter", s, endOfMonth(addMonths(s, 2)), "Last quarter"); }
  if (/\b(last|previous|prior)\s+(fy|financial\s+year|fiscal\s+year|year)\b/.test(m)) { const s = addYears(fy.start, -1); return mk("fy", s, utc(fy.start.getUTCFullYear(), fy.start.getUTCMonth(), 0), fyLabel(s)); }
  const fyY = m.match(/\b(?:fy|financial\s+year|fiscal\s+year|year)\s*[-']?\s*(20\d\d)\b/) || (!/\b(month|quarter|q[1-4])\b/.test(m) && m.match(/\b(20\d\d)\b/));
  if (fyY) {
    const s = utc(Number(fyY[1]), fyStartMonth, 1);
    if (s <= today) return mk("fy", s, endOfMonth(addMonths(s, 11)), fyLabel(s));
  }
  // An unsupported explicit range ("between 1 Mar and 15 Apr", "last 90 days") → let the AI handle it.
  if (/\bbetween\b.*\band\b|\blast\s+\d+\s+(days|weeks|months)\b|\bweek\b|\btoday\b|\byesterday\b/.test(m)) return null;
  return mk("ytd", fyStartOf(today) < fy.start ? fyStartOf(today) : fy.start, fy.end, fyLabel(fy.start));
}

// ── chart-of-accounts classification ────────────────────────────────────────
const RX = {
  da: /depreciat|amorti[sz]/i,
  interest: /interest|finance\s*(cost|charge|expense)s?|borrowing\s*cost/i,
  tax: /\b(income\s*tax|corporate\s*tax|tax\s*expense|current\s*tax|deferred\s*tax|provision\s*for\s*(income\s*)?tax|taxation)\b/i,
  otherIncome: /other\s*(operating\s*)?income|misc\w*\s*income|gain|loss\s*on\s*(sale|disposal)|dividend|interest\s*income|non.?operating/i,
  nonCurrent: /non.?current|\bnca\b|\bncl\b|fixed|intangible|long.?term|\blt\b|property|plant|equipment|capital\s*work|goodwill|deferred\s*tax\s*asset/i,
  currentA: /current|\bca\b|cash|bank|receiv|\bar\b|debtor|inventor|stock|prepaid|advance|deposit|short.?term|loans?\s*and\s*advances/i,
  currentL: /current|\bcl\b|payable|\bap\b|creditor|accru|short.?term|\bst\b|provision|dut(y|ies)|statutory|tax\s*payable|customer\s*advance/i,
  receivable: /receiv|\bar\b|debtor/i,
  payable: /payable|\bap\b|creditor/i,
  inventory: /inventor|stock\b|stock[-\s]?in[-\s]?trade|raw\s*material|finished\s*goods|wip\b/i,
  cash: /cash|bank/i,
  loan: /loan|borrow|debt|overdraft|credit\s*line|line\s*of\s*credit/i,
};

function buildTree(accounts) {
  const byCode = new Map(accounts.map(a => [a.AcctCode, a]));
  const chain = code => { // [self, parent, … drawer]
    const out = []; let cur = byCode.get(code); let guard = 0;
    while (cur && guard++ < 12) { out.push(cur); cur = cur.FatherNum ? byCode.get(cur.FatherNum) : null; }
    return out;
  };
  return { byCode, chain };
}

/** Level-2 group (first title under the drawer) of an account. */
function groupOf(ch) {
  const l2 = ch.find(a => Number(a.Levels) === 2);
  return l2 || ch[ch.length - 2] || ch[0];
}

function classifyPL(acct, ch, drawerName) {
  const names = ch.map(a => a.AcctName || "").join(" | ");
  const g = Number(acct.GroupMask);
  if (RX.tax.test(names) || /taxation/i.test(drawerName)) return "tax";
  if (RX.da.test(names)) return "da";
  if (g === 4) return RX.otherIncome.test(names.split(" | ").slice(0, -1).join(" | ")) ? "other" : "revenue";
  if (g === 5) return "cogs";
  if (RX.interest.test(names) && !/interest\s*income/i.test(acct.AcctName || "")) return "interest";
  if (g === 6) return "opex";
  return "other"; // drawers 7+ (financing / non-operating / other revenues & expenses)
}

function classifyBS(acct, ch) {
  const g = Number(acct.GroupMask);
  const names = ch.slice(0, -1).map(a => a.AcctName || "").join(" | "); // without the drawer title
  if (g === 3) return { side: "equity" };
  if (g === 1) {
    const cash = acct.Finanse === "Y" || RX.cash.test(names) && !RX.nonCurrent.test(names);
    const recv = (acct.LocManTran === "Y") || RX.receivable.test(names);
    const inv = RX.inventory.test(names);
    const current = !RX.nonCurrent.test(names) && (cash || recv || inv || RX.currentA.test(names));
    return { side: "asset", current, cash: cash && current, receivable: recv && current && !cash, inventory: inv && current && !cash && !recv, unclassified: !current && !RX.nonCurrent.test(names) };
  }
  const pay = (acct.LocManTran === "Y") || RX.payable.test(names);
  const current = !RX.nonCurrent.test(names) && (pay || RX.currentL.test(names));
  return { side: "liability", current, payable: pay && current, loan: RX.loan.test(names), unclassified: !current && !RX.nonCurrent.test(names) };
}

// ── formatting ──────────────────────────────────────────────────────────────
export function makeMoneyFormatter(currency = { code: "USD", symbol: "$" }) {
  const locale = currency.code === "INR" ? "en-IN" : "en-US";
  const nf = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
  return v => {
    if (v == null || !isFinite(v)) return "—";
    const s = `${currency.symbol}${nf.format(Math.abs(Math.round(v)))}`;
    return v < 0 ? `(${s})` : s;
  };
}
const pct = v => (v == null || !isFinite(v) ? "—" : `${v.toFixed(1)}%`);
const chg = (cur, prev) => (prev ? (cur - prev) / Math.abs(prev) * 100 : null);
const chgTxt = v => (v == null || !isFinite(v) ? "—" : v >= 0 ? `▲ ${v.toFixed(1)}%` : `▼ ${Math.abs(v).toFixed(1)}%`);
const r2 = v => (v == null || !isFinite(v) ? null : Math.round(v * 100) / 100);

// ── P&L roll-up ─────────────────────────────────────────────────────────────
function emptyPL() { return { revenue: 0, cogs: 0, opex: 0, da: 0, interest: 0, other: 0, tax: 0 }; }
function addPL(pl, cat, netCredit) {
  // natural sign: revenue/other = credit − debit; costs = debit − credit
  if (cat === "revenue" || cat === "other") pl[cat] += netCredit; else pl[cat] -= netCredit;
}
function finishPL(pl) {
  const gp = pl.revenue - pl.cogs;
  const ebitda = gp - pl.opex;
  const ebit = ebitda - pl.da;
  const pbt = ebit - pl.interest + pl.other;
  const pat = pbt - pl.tax;
  const div = x => (pl.revenue ? x / pl.revenue * 100 : null);
  return { ...pl, gp, ebitda, ebit, pbt, pat, gpPct: div(gp), ebitdaPct: div(ebitda), netPct: div(pat) };
}

/**
 * Runs the fixed GL queries and returns verified figures, prepared charts and
 * markdown tables for one period. Never throws — returns { error } instead so
 * the caller can fall back to the AI's own queries.
 */
export async function buildFinancePack({ executeSQL, dbType, database, message, currency = { code: "USD", symbol: "$" }, today: todayIn }) {
  const hana = dbType === "hana";
  const T = t => (hana ? `"${database}"."${t}"` : t);
  const c = n => (hana ? `"${n}"` : n);
  const lit = d => (hana ? `TO_DATE('${ymd(d)}')` : `'${ymd(d).replace(/-/g, "")}'`);
  const money = makeMoneyFormatter(currency);
  const now = todayIn ? toDate(todayIn) : toDate(new Date().toISOString());
  const t0 = Date.now();
  // Every query is recorded so the chat's "Show Query" panel lists them.
  const ran = [], rawExec = executeSQL;
  executeSQL = async sql => { const r = await rawExec(sql); ran.push({ purpose: "Finance figures (GL)", sql: sql.replace(/\s+/g, " ").trim(), rows: r.length, error: null }); return r; };
  try {
    // 1. chart of accounts + fiscal year
    const [accounts, periods] = await Promise.all([
      executeSQL(`SELECT ${c("AcctCode")} AS "AcctCode", ${c("AcctName")} AS "AcctName", ${c("FormatCode")} AS "FormatCode", ${c("GroupMask")} AS "GroupMask", ${c("Levels")} AS "Levels", ${c("FatherNum")} AS "FatherNum", ${c("Postable")} AS "Postable", ${c("Finanse")} AS "Finanse", ${c("LocManTran")} AS "LocManTran" FROM ${T("OACT")}`),
      executeSQL(`SELECT ${c("Category")} AS "FY", MIN(${c("F_RefDate")}) AS "S", MAX(${c("T_RefDate")}) AS "E" FROM ${T("OFPR")} GROUP BY ${c("Category")}`).catch(() => []),
    ]);
    if (!accounts.length) return { error: "Chart of accounts (OACT) is empty or not readable." };
    const { byCode, chain } = buildTree(accounts);
    const drawerName = new Map(accounts.filter(a => Number(a.Levels) === 1).map(a => [Number(a.GroupMask), a.AcctName]));

    let fyRow = periods.map(p => ({ fy: p.FY, start: toDate(p.S), end: toDate(p.E) })).find(p => p.start && p.end && p.start <= now && p.end >= now);
    const fySource = fyRow ? `SAP posting periods (OFPR category ${fyRow.fy})` : "calendar year (no posting period covers today)";
    if (!fyRow) fyRow = { fy: String(now.getUTCFullYear()), start: utc(now.getUTCFullYear(), 0, 1), end: utc(now.getUTCFullYear(), 11, 31) };
    const period = resolveFinancePeriod(message, fyRow, now);
    if (!period) return { error: "Period in the question is not one of the standard ones (month / quarter / FY) — use your own queries." };
    const pStart = period.start, pEnd = period.end;
    const pyStart = addYears(pStart, -1), pyEnd = addYears(pEnd, -1);
    // Monthly trend window: the fiscal year containing the period (to its end, capped at today).
    const fyStartForTrend = (() => { const fsm = fyRow.start.getUTCMonth(); const y = pStart.getUTCMonth() >= fsm ? pStart.getUTCFullYear() : pStart.getUTCFullYear() - 1; return utc(y, fsm, 1); })();
    const trendEnd = pEnd;
    const trendStart = fyStartForTrend < pStart ? fyStartForTrend : pStart;

    // 2. P&L per account: current period, same period last year (like-for-like), monthly trend
    const plWhere = `A.${c("GroupMask")} >= 4 AND J.${c("TransType")} <> -3`;
    const [plRows, monthRows, bsRows, cashRows, futureRows] = await Promise.all([
      executeSQL(`SELECT J.${c("Account")} AS "Acct",
          SUM(CASE WHEN J.${c("RefDate")} BETWEEN ${lit(pStart)} AND ${lit(pEnd)} THEN J.${c("Credit")} - J.${c("Debit")} ELSE 0 END) AS "Cur",
          SUM(CASE WHEN J.${c("RefDate")} BETWEEN ${lit(pyStart)} AND ${lit(pyEnd)} THEN J.${c("Credit")} - J.${c("Debit")} ELSE 0 END) AS "Prev"
        FROM ${T("JDT1")} J JOIN ${T("OACT")} A ON A.${c("AcctCode")} = J.${c("Account")}
        WHERE ${plWhere} AND J.${c("RefDate")} BETWEEN ${lit(pyStart)} AND ${lit(pEnd)} GROUP BY J.${c("Account")}`),
      executeSQL(`SELECT J.${c("Account")} AS "Acct", YEAR(J.${c("RefDate")}) AS "Y", MONTH(J.${c("RefDate")}) AS "M", SUM(J.${c("Credit")} - J.${c("Debit")}) AS "NC"
        FROM ${T("JDT1")} J JOIN ${T("OACT")} A ON A.${c("AcctCode")} = J.${c("Account")}
        WHERE ${plWhere} AND J.${c("RefDate")} BETWEEN ${lit(trendStart)} AND ${lit(trendEnd)} GROUP BY J.${c("Account")}, YEAR(J.${c("RefDate")}), MONTH(J.${c("RefDate")})`),
      // 3. balance sheet per account as at period end, a year earlier, and at period start (opening)
      executeSQL(`SELECT J.${c("Account")} AS "Acct",
          SUM(CASE WHEN J.${c("RefDate")} <= ${lit(pEnd)} THEN J.${c("Debit")} - J.${c("Credit")} ELSE 0 END) AS "Close",
          SUM(CASE WHEN J.${c("RefDate")} <= ${lit(pyEnd)} THEN J.${c("Debit")} - J.${c("Credit")} ELSE 0 END) AS "PrevClose",
          SUM(CASE WHEN J.${c("RefDate")} < ${lit(pStart)} THEN J.${c("Debit")} - J.${c("Credit")} ELSE 0 END) AS "Open"
        FROM ${T("JDT1")} J WHERE J.${c("RefDate")} <= ${lit(pEnd)} GROUP BY J.${c("Account")}`),
      // 4. cash & bank movements in the period by document type
      executeSQL(`SELECT J.${c("TransType")} AS "TT", SUM(J.${c("Debit")}) AS "Inflow", SUM(J.${c("Credit")}) AS "Outflow"
        FROM ${T("JDT1")} J JOIN ${T("OACT")} A ON A.${c("AcctCode")} = J.${c("Account")}
        WHERE A.${c("Finanse")} = 'Y' AND J.${c("RefDate")} BETWEEN ${lit(pStart)} AND ${lit(pEnd)} GROUP BY J.${c("TransType")}`),
      executeSQL(`SELECT COUNT(*) AS "N", MAX(J.${c("RefDate")}) AS "MaxDate" FROM ${T("JDT1")} J WHERE J.${c("RefDate")} > ${lit(now)}`).catch(() => []),
    ]);

    // ── P&L
    const curPL = emptyPL(), prevPL = emptyPL();
    const lineAmt = new Map(); // "cat|group" -> { cat, group, cur, prev }
    const catOf = new Map();
    const cat = code => {
      if (!catOf.has(code)) {
        const a = byCode.get(code); const ch = chain(code);
        catOf.set(code, a ? { cat: classifyPL(a, ch, drawerName.get(Number(a.GroupMask)) || ""), group: groupOf(ch)?.AcctName || a.AcctName } : { cat: "other", group: "Unmapped" });
      }
      return catOf.get(code);
    };
    for (const r of plRows) {
      const { cat: k, group } = cat(r.Acct);
      const cur = Number(r.Cur) || 0, prev = Number(r.Prev) || 0;
      addPL(curPL, k, cur); addPL(prevPL, k, prev);
      const key = `${k}|${group}`;
      const e = lineAmt.get(key) || { cat: k, group, cur: 0, prev: 0 };
      const sign = k === "revenue" || k === "other" ? 1 : -1;
      e.cur += sign * cur; e.prev += sign * prev; lineAmt.set(key, e);
    }
    const P = finishPL(curPL), PY = finishPL(prevPL);

    // monthly trend
    const months = [];
    for (let d = utc(trendStart.getUTCFullYear(), trendStart.getUTCMonth(), 1); d <= trendEnd; d = addMonths(d, 1)) months.push({ key: monthKey(d), d, pl: emptyPL() });
    const mIdx = new Map(months.map(m => [m.key, m]));
    for (const r of monthRows) { const m = mIdx.get(Number(r.Y) * 100 + Number(r.M)); if (m) addPL(m.pl, cat(r.Acct).cat, Number(r.NC) || 0); }
    const monthly = months.map(m => ({ label: `${MONTHS[m.d.getUTCMonth()]} ${String(m.d.getUTCFullYear()).slice(2)}${monthKey(now) === m.key && trendEnd >= now ? "*" : ""}`, ...finishPL(m.pl) }));

    // ── Balance sheet
    const bs = { cur: { ca: 0, nca: 0, cl: 0, ncl: 0, equity: 0, cash: 0, ar: 0, inv: 0, ap: 0, loans: 0 }, prev: null, open: null };
    const blank = () => ({ ca: 0, nca: 0, cl: 0, ncl: 0, equity: 0, cash: 0, ar: 0, inv: 0, ap: 0, loans: 0 });
    bs.prev = blank(); bs.open = blank();
    let unclosedPL = { cur: 0, prev: 0, open: 0 };
    const unclassified = new Set();
    const bsGroups = new Map(); // "side|current|group" -> { label, cur, prev }
    for (const r of bsRows) {
      const a = byCode.get(r.Acct); if (!a) continue;
      const g = Number(a.GroupMask);
      const vals = { cur: Number(r.Close) || 0, prev: Number(r.PrevClose) || 0, open: Number(r.Open) || 0 };
      if (g >= 4) { for (const k of Object.keys(vals)) unclosedPL[k] += -vals[k]; continue; } // credit − debit
      const ch = chain(r.Acct); const k = classifyBS(a, ch);
      const grp = groupOf(ch)?.AcctName || a.AcctName;
      if (k.unclassified) unclassified.add(`${grp} (${drawerName.get(g) || `drawer ${g}`})`);
      for (const [p, v] of Object.entries(vals)) {
        const t = p === "cur" ? bs.cur : p === "prev" ? bs.prev : bs.open;
        if (k.side === "asset") { t[k.current ? "ca" : "nca"] += v; if (k.cash) t.cash += v; if (k.receivable) t.ar += v; if (k.inventory) t.inv += v; }
        else if (k.side === "liability") { t[k.current ? "cl" : "ncl"] += -v; if (k.payable) t.ap += -v; if (k.loan) t.loans += -v; }
        else t.equity += -v;
      }
      const gk = `${k.side}|${k.current ? 1 : 0}|${grp}`;
      const e = bsGroups.get(gk) || { side: k.side, current: !!k.current, label: grp, cur: 0, prev: 0 };
      const sgn = k.side === "asset" ? 1 : -1;
      e.cur += sgn * vals.cur; e.prev += sgn * vals.prev; bsGroups.set(gk, e);
    }
    const bsTotals = t => {
      const ta = t.ca + t.nca, tl = t.cl + t.ncl;
      return { ...t, totalAssets: ta, totalLiab: tl, wc: t.ca - t.cl, currentRatio: t.cl ? t.ca / t.cl : null, quickRatio: t.cl ? (t.ca - t.inv) / t.cl : null, cashRatio: t.cl ? t.cash / t.cl : null };
    };
    const B = bsTotals(bs.cur), BPY = bsTotals(bs.prev), BO = bsTotals(bs.open);
    B.currentProfit = unclosedPL.cur; BPY.currentProfit = unclosedPL.prev;
    B.totalEquity = B.equity + B.currentProfit; BPY.totalEquity = BPY.equity + BPY.currentProfit;
    B.diff = B.totalAssets - (B.totalLiab + B.totalEquity); BPY.diff = BPY.totalAssets - (BPY.totalLiab + BPY.totalEquity);
    B.debtToEquity = B.totalEquity ? B.loans / B.totalEquity : null;

    const nDays = days(pStart, pEnd);
    const dso = P.revenue > 0 ? B.ar / P.revenue * nDays : null;
    const dpo = P.cogs > 0 ? B.ap / P.cogs * nDays : null;
    const dio = P.cogs > 0 ? B.inv / P.cogs * nDays : null;
    const ccc = dso != null && dpo != null && dio != null ? dso + dio - dpo : null;

    // ── Cash
    const cashFlows = cashRows.map(r => ({ type: TRANS_TYPES[String(r.TT)] || `Doc type ${r.TT}`, inflow: Number(r.Inflow) || 0, outflow: Number(r.Outflow) || 0 }))
      .map(r => ({ ...r, net: r.inflow - r.outflow })).sort((a, b) => Math.abs(b.net) - Math.abs(a.net));
    const cashOpen = BO.cash, cashClose = B.cash, cashNet = cashClose - cashOpen;

    // ── sanity notes (data quality, shown to the AI and in the answer)
    const notes = [];
    notes.push(`Fiscal year from ${fySource}: ${fmtD(fyRow.start)} – ${fmtD(fyRow.end)}.`);
    if (period.partial) notes.push(`${period.label}: figures run to today (${fmtD(now)}); the comparison is the same dates last year (like-for-like).`);
    const fut = futureRows?.[0];
    if (Number(fut?.N) > 0) notes.push(`${Number(fut.N).toLocaleString("en-US")} journal lines are dated after today (latest ${String(fut.MaxDate).slice(0, 10)}) — excluded from to-date figures.`);
    if (P.revenue <= 0 && (P.cogs > 0 || P.opex > 0)) notes.push(`⚠️ Revenue is ${money(P.revenue)} while costs were posted — check the revenue accounts in drawer 4 (${drawerName.get(4) || "Revenues"}).`);
    if (Math.abs(B.diff) > 1) notes.push(`⚠️ Balance sheet does not balance by ${money(B.diff)} (assets − liabilities − equity − current profit).`);
    if (unclassified.size) notes.push(`Groups not clearly current / non-current (treated as non-current): ${[...unclassified].slice(0, 8).join("; ")}.`);
    const daAccts = new Set([...catOf].filter(([, v]) => v.cat === "da").map(([, v]) => v.group));
    const intAccts = new Set([...catOf].filter(([, v]) => v.cat === "interest").map(([, v]) => v.group));
    const taxAccts = new Set([...catOf].filter(([, v]) => v.cat === "tax").map(([, v]) => v.group));
    notes.push(daAccts.size ? `D&A from: ${[...daAccts].join(", ")}.` : "No depreciation/amortisation accounts with postings — EBITDA = EBIT.");
    notes.push(intAccts.size ? `Interest / finance cost from: ${[...intAccts].join(", ")}.` : "No interest/finance-cost accounts with postings.");
    if (!taxAccts.size) notes.push("No income-tax postings in the period — net profit is before tax (PBT = PAT).");

    // ── facts for the AI (raw numbers — the KPI "value" must be copied from here)
    const F = (label, v, def) => `- ${label}: ${r2(v)}${def ? `  — ${def}` : ""}`;
    const facts = [
      `Period: ${period.label}. Comparison: same period last year (${fmtD(pyStart)} – ${fmtD(pyEnd)}). Balance sheet as at ${fmtD(pEnd)} (comparison as at ${fmtD(pyEnd)}).`,
      `### Profit & loss (General Ledger, closing entries excluded) — current | last year`,
      F("Revenue", P.revenue, `prev ${r2(PY.revenue)}, change ${r2(chg(P.revenue, PY.revenue))}% · ${drawerName.get(4) || "drawer 4"} (net of contra-revenue), excl. other income`),
      F("Cost of sales", P.cogs, `prev ${r2(PY.cogs)} · ${drawerName.get(5) || "drawer 5"}`),
      F("Gross profit", P.gp, `prev ${r2(PY.gp)}, change ${r2(chg(P.gp, PY.gp))}% · Revenue − Cost of sales`),
      F("Gross margin %", P.gpPct, `prev ${r2(PY.gpPct)}, change ${r2(P.gpPct - PY.gpPct)} pts`),
      F("Operating expenses (excl. D&A, interest, tax)", P.opex, `prev ${r2(PY.opex)}`),
      F("EBITDA", P.ebitda, `prev ${r2(PY.ebitda)}, change ${r2(chg(P.ebitda, PY.ebitda))}% · Gross profit − operating expenses`),
      F("EBITDA margin %", P.ebitdaPct, `prev ${r2(PY.ebitdaPct)}, change ${r2(P.ebitdaPct - PY.ebitdaPct)} pts`),
      F("Depreciation & amortisation", P.da, `prev ${r2(PY.da)}`),
      F("EBIT", P.ebit, `prev ${r2(PY.ebit)}`),
      F("Interest / finance cost, net", P.interest, `prev ${r2(PY.interest)} · positive = net cost, NEGATIVE = net interest INCOME`),
      F("Other income / (expense), net", P.other, `prev ${r2(PY.other)} · other income, gains, non-operating items`),
      F("Profit before tax", P.pbt, `prev ${r2(PY.pbt)}`),
      F("Income tax", P.tax, `prev ${r2(PY.tax)}`),
      F("Net profit", P.pat, `prev ${r2(PY.pat)}, change ${r2(chg(P.pat, PY.pat))}% · = total of all P&L accounts`),
      F("Net margin %", P.netPct, `prev ${r2(PY.netPct)}, change ${r2(P.netPct - PY.netPct)} pts`),
      `### Balance sheet & working capital (as-at balances, all postings up to the date) — current | a year earlier`,
      F("Cash & bank", B.cash, `prev ${r2(BPY.cash)} · accounts flagged cash (Finanse = Y); opening at period start ${r2(cashOpen)}, net change ${r2(cashNet)}`),
      F("Trade receivables", B.ar, `prev ${r2(BPY.ar)} · customer control account(s)`),
      F("Inventory", B.inv, `prev ${r2(BPY.inv)}`),
      F("Current assets", B.ca, `prev ${r2(BPY.ca)}`),
      F("Non-current assets", B.nca, `prev ${r2(BPY.nca)}`),
      F("Total assets", B.totalAssets, `prev ${r2(BPY.totalAssets)}`),
      F("Trade payables", B.ap, `prev ${r2(BPY.ap)} · vendor control account(s)`),
      F("Current liabilities", B.cl, `prev ${r2(BPY.cl)}`),
      F("Non-current liabilities", B.ncl, `prev ${r2(BPY.ncl)}`),
      F("Borrowings (loans)", B.loans, `prev ${r2(BPY.loans)}`),
      F("Equity incl. current-year profit", B.totalEquity, `prev ${r2(BPY.totalEquity)} · equity ${r2(B.equity)} + unclosed profit ${r2(B.currentProfit)}`),
      F("Working capital", B.wc, `prev ${r2(BPY.wc)} · Current assets − Current liabilities`),
      F("Current ratio", B.currentRatio, `prev ${r2(BPY.currentRatio)}`),
      F("Quick ratio", B.quickRatio, `prev ${r2(BPY.quickRatio)} · (CA − inventory) ÷ CL`),
      F("Cash ratio", B.cashRatio),
      F("Debt-to-equity", B.debtToEquity),
      F("DSO (days)", dso, `receivables ÷ revenue × ${nDays} days`),
      F("DPO (days)", dpo, `payables ÷ cost of sales × ${nDays} days`),
      F("DIO (days)", dio, `inventory ÷ cost of sales × ${nDays} days`),
      F("Cash conversion cycle (days)", ccc, "DSO + DIO − DPO"),
      F("Balance check difference", B.diff, "should be 0"),
      `### Cash & bank movements in the period (by document type: inflow | outflow | net)`,
      ...cashFlows.slice(0, 10).map(r => `- ${r.type}: in ${r2(r.inflow)} | out ${r2(r.outflow)} | net ${r2(r.net)}`),
      `### Monthly (Revenue | Gross profit | EBITDA | Net profit)`,
      ...monthly.map(m => `- ${m.label}: ${r2(m.revenue)} | ${r2(m.gp)} | ${r2(m.ebitda)} | ${r2(m.pat)}`),
      `### Data notes`,
      ...notes.map(n => `- ${n}`),
    ].join("\n");

    // every number above, for the server's figure check
    const numberRows = [{ ...P }, { ...PY }, { ...B }, { ...BPY }, { cashOpen, cashClose, cashNet, dso, dpo, dio, ccc }, ...monthly.map(m => ({ ...m })),
      ...cashFlows.map(r => ({ i: r.inflow, o: r.outflow, n: r.net })), ...[...lineAmt.values()].map(e => ({ c: e.cur, p: e.prev })), ...[...bsGroups.values()].map(e => ({ c: e.cur, p: e.prev }))];

    // ── markdown tables (inserted verbatim where the AI puts [[FIN:…]])
    const row = (label, cur, prev, { bold = false, isPct = false } = {}) => {
      const b = s => (bold ? `**${s}**` : s);
      return `| ${b(label)} | ${b(isPct ? pct(cur) : money(cur))} | ${isPct ? pct(prev) : money(prev)} | ${isPct ? (cur != null && prev != null ? `${(cur - prev) >= 0 ? "▲" : "▼"} ${Math.abs(cur - prev).toFixed(1)} pts` : "—") : chgTxt(chg(cur, prev))} |`;
    };
    const head = (a, b) => `| | ${a} | ${b} | Change |\n|---|---:|---:|---:|`;
    const curLbl = period.kind === "ytd" ? "This year to date" : "This period", prevLbl = "Same period last year";
    const tables = {
      pnl: [`### Profit & Loss — ${period.label}`, head(curLbl, prevLbl),
        row("Revenue", P.revenue, PY.revenue), row("Cost of sales", P.cogs, PY.cogs), row("Gross profit", P.gp, PY.gp, { bold: true }), row("Gross margin %", P.gpPct, PY.gpPct, { isPct: true }),
        row("Operating expenses", P.opex, PY.opex), row("EBITDA", P.ebitda, PY.ebitda, { bold: true }), row("EBITDA margin %", P.ebitdaPct, PY.ebitdaPct, { isPct: true }),
        row("Depreciation & amortisation", P.da, PY.da), row("EBIT", P.ebit, PY.ebit, { bold: true }), (P.interest < 0 ? row("Net interest & finance income", -P.interest, -PY.interest) : row("Interest / finance cost, net", P.interest, PY.interest)),
        row("Other income / (expense), net", P.other, PY.other), row("Profit before tax", P.pbt, PY.pbt, { bold: true }), row("Income tax", P.tax, PY.tax),
        row("Net profit", P.pat, PY.pat, { bold: true }), row("Net margin %", P.netPct, PY.netPct, { isPct: true })].join("\n"),
      bs: [`### Balance Sheet — as at ${fmtD(pEnd)}`, head(`As at ${fmtD(pEnd)}`, `As at ${fmtD(pyEnd)}`),
        row("Cash & bank", B.cash, BPY.cash), row("Trade receivables", B.ar, BPY.ar), row("Inventory", B.inv, BPY.inv), row("Other current assets", B.ca - B.cash - B.ar - B.inv, BPY.ca - BPY.cash - BPY.ar - BPY.inv),
        row("Current assets", B.ca, BPY.ca, { bold: true }), row("Non-current assets", B.nca, BPY.nca), row("Total assets", B.totalAssets, BPY.totalAssets, { bold: true }),
        row("Trade payables", B.ap, BPY.ap), row("Other current liabilities", B.cl - B.ap, BPY.cl - BPY.ap), row("Current liabilities", B.cl, BPY.cl, { bold: true }),
        row("Non-current liabilities", B.ncl, BPY.ncl), row("Total liabilities", B.totalLiab, BPY.totalLiab, { bold: true }),
        row("Equity", B.equity, BPY.equity), row("Current-year profit (not yet closed)", B.currentProfit, BPY.currentProfit), row("Total equity", B.totalEquity, BPY.totalEquity, { bold: true }),
        `| Check: assets − liabilities − equity | ${money(B.diff)} | ${money(BPY.diff)} | ${Math.abs(B.diff) <= 1 ? "✅ balances" : "⚠️ difference"} |`].join("\n"),
      wc: [`### Working capital & liquidity — as at ${fmtD(pEnd)}`, `| Measure | Value | A year earlier |\n|---|---:|---:|`,
        `| Working capital (CA − CL) | **${money(B.wc)}** | ${money(BPY.wc)} |`,
        `| Current ratio | ${B.currentRatio?.toFixed(2) ?? "—"} | ${BPY.currentRatio?.toFixed(2) ?? "—"} |`,
        `| Quick ratio | ${B.quickRatio?.toFixed(2) ?? "—"} | ${BPY.quickRatio?.toFixed(2) ?? "—"} |`,
        `| Cash ratio | ${B.cashRatio?.toFixed(2) ?? "—"} | ${BPY.cashRatio?.toFixed(2) ?? "—"} |`,
        `| DSO — days to collect | ${dso?.toFixed(0) ?? "—"} | |`, `| DPO — days to pay | ${dpo?.toFixed(0) ?? "—"} | |`, `| DIO — days of inventory | ${dio?.toFixed(0) ?? "—"} | |`,
        `| Cash conversion cycle (days) | ${ccc?.toFixed(0) ?? "—"} | |`, `| Debt-to-equity | ${B.debtToEquity?.toFixed(2) ?? "—"} | ${BPY.totalEquity ? (BPY.loans / BPY.totalEquity).toFixed(2) : "—"} |`].join("\n"),
      cash: [`### Cash & bank — ${period.label}`, `| | Amount |\n|---|---:|`, `| Opening balance (${fmtD(pStart)}) | ${money(cashOpen)} |`,
        ...cashFlows.filter(r => Math.abs(r.net) >= 0.5).slice(0, 8).map(r => `| ${r.type} (net) | ${money(r.net)} |`),
        ...(cashFlows.length > 8 ? [`| Other movements (net) | ${money(cashFlows.slice(8).reduce((s, r) => s + r.net, 0))} |`] : []),
        `| **Closing balance (${fmtD(pEnd)})** | **${money(cashClose)}** |`, `| Net change | ${money(cashNet)} |`].join("\n"),
      monthly: [`### Month by month`, `| Month | Revenue | Gross profit | GP % | EBITDA | Net profit |\n|---|---:|---:|---:|---:|---:|`,
        ...monthly.map(m => `| ${m.label} | ${money(m.revenue)} | ${money(m.gp)} | ${pct(m.gpPct)} | ${money(m.ebitda)} | ${money(m.pat)} |`),
        ...(monthly.some(m => m.label.endsWith("*")) ? ["\n\\* current month, to date"] : [])].join("\n"),
      notes: [`### Data notes`, ...notes.map(n => `- ${n}`)].join("\n"),
    };

    // ── prepared charts (rows already computed — shown via show_prepared_chart)
    const opexGroups = [...lineAmt.values()].filter(e => e.cat === "opex" && Math.abs(e.cur) >= 0.5).sort((a, b) => b.cur - a.cur);
    const topOpex = opexGroups.slice(0, 8).map(e => ({ "Expense group": e.group, [`${curLbl}`]: r2(e.cur), "Last year": r2(e.prev) }));
    if (opexGroups.length > 8) topOpex.push({ "Expense group": "Others", [`${curLbl}`]: r2(opexGroups.slice(8).reduce((s, e) => s + e.cur, 0)), "Last year": r2(opexGroups.slice(8).reduce((s, e) => s + e.prev, 0)) });
    const charts = {
      monthly_trend: { title: `Monthly revenue, gross profit & EBITDA — ${period.label.split(" (")[0]}`, chartType: "combo",
        rows: monthly.map(m => ({ Month: m.label, Revenue: r2(m.revenue), "Gross profit": r2(m.gp), EBITDA: r2(m.ebitda), "Net profit": r2(m.pat) })) },
      profit_bridge: { title: `Revenue to net profit — ${period.label.split(" (")[0]}`, chartType: "waterfall",
        rows: [["Revenue", P.revenue], ["Cost of sales", -P.cogs], ["Operating expenses", -P.opex], ["D&A", -P.da], ["Interest", -P.interest], ["Other income/expense", P.other], ["Tax", -P.tax], ["Net profit", P.pat]]
          .filter(([l, v]) => l === "Revenue" || l === "Net profit" || Math.abs(v) >= 0.5).map(([l, v]) => ({ Step: l, Amount: r2(v) })) },
      this_vs_last_year: { title: `This year vs last year — key P&L lines`, chartType: "bar",
        rows: [["Revenue", P.revenue, PY.revenue], ["Gross profit", P.gp, PY.gp], ["EBITDA", P.ebitda, PY.ebitda], ["Net profit", P.pat, PY.pat]].map(([l, a, b]) => ({ Measure: l, [curLbl]: r2(a), [prevLbl]: r2(b) })) },
      expense_mix: { title: `Operating expenses by group — ${period.label.split(" (")[0]}`, chartType: "hbar", rows: topOpex },
      working_capital: { title: `Working capital components — as at ${fmtD(pEnd)}`, chartType: "bar",
        rows: [["Cash & bank", B.cash, BPY.cash], ["Receivables", B.ar, BPY.ar], ["Inventory", B.inv, BPY.inv], ["Other current assets", B.ca - B.cash - B.ar - B.inv, BPY.ca - BPY.cash - BPY.ar - BPY.inv],
          ["Payables", -B.ap, -BPY.ap], ["Other current liabilities", -(B.cl - B.ap), -(BPY.cl - BPY.ap)], ["Working capital", B.wc, BPY.wc]]
          .map(([l, a, b]) => ({ Component: l, [`As at ${fmtD(pEnd)}`]: r2(a), [`A year earlier`]: r2(b) })) },
    };
    for (const k of Object.keys(charts)) if (!charts[k].rows.length) delete charts[k];

    return {
      period, fy: fyRow, facts, tables, charts, numberRows, notes,
      metrics: { P, PY, B, BPY, dso, dpo, dio, ccc, cashOpen, cashClose, cashNet },
      queries: ran, ms: Date.now() - t0,
    };
  } catch (e) {
    return { error: e.message };
  }
}

/** Prompt section that hands the verified figures to the AI. */
export function financePackPrompt(pack, { insight = false } = {}) {
  const ids = Object.keys(pack.charts);
  return `## VERIFIED FINANCE FIGURES (computed by the server from the General Ledger — use THESE)
The server already ran the general-ledger queries for this question and classified every account through the chart-of-accounts tree.
These figures are correct and final. Rules:
- Use these exact numbers for every statement figure (revenue, cost of sales, gross profit, EBITDA, net profit, cash, receivables, payables, current assets/liabilities, working capital, ratios). Do NOT recompute them with your own SQL and do not "correct" them.
- Run your own run_sql queries ONLY for drill-downs these figures don't cover (e.g. top customers, top expense accounts, ageing, a specific account), following the FINANCE rules.
- KPI "value" = the raw number exactly as written here (no symbols, no rounding to K/M/L/Cr).
- Ready-made tables — put the marker on its own line where the table belongs; the server replaces it with the full table (do not retype these tables):
  [[FIN:pnl]] Profit & Loss with last-year comparison · [[FIN:bs]] Balance Sheet · [[FIN:wc]] Working capital & liquidity ratios · [[FIN:cash]] Cash & bank movement · [[FIN:monthly]] Month-by-month P&L · [[FIN:notes]] Data notes
  Use the ones that answer the question (for a full CFO/financial-health question use all of them; always include [[FIN:notes]] at the end of the analysis, before the follow-ups).
- Ready-made charts — call show_prepared_chart with one of: ${ids.join(", ")}. ${insight ? "Use 3–5 of them that fit the question (each a different view) and add your own show_chart only for drill-downs." : "Use the 1–3 that fit the question best (counts toward the chart limit)."}
  Place each prepared chart with its id marker exactly where it belongs, e.g. [[CHART:monthly_trend]] right after the paragraph it illustrates; use plain [[CHART]] only for your own show_chart charts.
- KPI tiles for margins (%): change_pct = the "pts" change given above (e.g. 6.27), with "vs": "pts vs last year".
- Follow-ups must go BEYOND what this answer already shows — drill into the largest expense accounts, customer-level receivables ageing, vendor payables due, a month that dropped, cost-centre / branch P&L. Never suggest a table or chart that is already in the answer.
- If a figure is 0 or missing here, say so plainly and explain it from the data notes — never invent one.
${insight ? `
### Layout for this financial answer (AI Insight)
1. Direct answer: 2–3 sentences with the headline figures in **bold** and the biggest change vs last year.
2. kpis block: Revenue, Gross margin %, EBITDA, Net profit, Cash & bank, Working capital — each with change_pct + vs ("vs same period last year") from the "prev"/"change" values above and a "def". Add a 6-month "spark" from the monthly figures on the Revenue tile.
3. ## 📊 Profitability — what drove revenue, margin and EBITDA (name months that stand out), then [[FIN:pnl]], [[CHART:monthly_trend]] and [[CHART:profit_bridge]].
4. ## 💸 Cost structure — the biggest expense groups and how they moved, then [[CHART:expense_mix]].
5. ## 💧 Liquidity & working capital — cash, receivables, payables, inventory, ratios and days (DSO / DPO / DIO) in plain words, then [[FIN:bs]], [[FIN:wc]] and [[CHART:working_capital]].
6. ## 🏦 Cash flow — where cash came from and went (the movement table), then [[FIN:cash]].
7. ## ⚠️ Risks & watch-points — 3–5 bullets from the data (falling months, margin pressure, slow collections, concentration, data gaps).
8. ## 💡 Recommendations — 4–6 concrete actions tied to the figures (e.g. "collect … to bring DSO from 74 to 60 days").
9. [[FIN:notes]]
Skip a section only if the question clearly doesn't ask about it.` : ""}

${pack.facts}`;
}

/** Replaces [[FIN:…]] markers with the prepared markdown tables. */
export function expandFinanceTables(text, pack) {
  if (!pack?.tables) return text;
  return String(text || "").replace(/\[\[FIN:(\w+)\]\]/g, (m, k) => (pack.tables[k] ? `\n\n${pack.tables[k]}\n\n` : ""));
}
