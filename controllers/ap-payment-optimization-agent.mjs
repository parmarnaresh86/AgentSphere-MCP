/**
 * AP Payment Optimization Agent — mounted at /api/ap-payment-agent
 *
 * Builds a recommended supplier payment run: which open A/P invoices to pay,
 * on which date and for how much, within the cash available (less a reserve).
 * Each invoice is scored on:
 *   overdue days (35)      clear arrears first — late fees, supply holds
 *   early-pay discount (25) only when its annualised return beats the
 *                          cost-of-capital hurdle
 *   due-date proximity (15)
 *   vendor criticality (25) user-flagged priority vendors, or supply
 *                          dependency (share of our open PO value)
 * then cash is allocated greedily by score. Payments are scheduled on the
 * last day that still captures their value (today if overdue, the discount
 * deadline if taking the discount, otherwise the due date) to preserve cash.
 * Read-only: nothing is posted to SAP.
 */
import { createInsightRouter, ctxTable, daysBetween, addDays, num, round, clamp, fmtAmt } from '../lib/insight-kit.mjs';
import {
  loadPartners, loadOpenInvoices, loadOpenDocs, loadPaymentTerms, loadCashDiscounts, loadCashBalance,
  loadApPaymentHistory, summarisePaymentBehaviour, loadInvoicedByPartner, since,
} from '../lib/insight-data.mjs';

const STRATEGIES = {
  balanced:  { overdue: 35, discount: 25, due: 15, vendor: 25 },
  discounts: { overdue: 25, discount: 45, due: 10, vendor: 20 },
  overdue:   { overdue: 55, discount: 15, due: 10, vendor: 20 },
  preserve:  { overdue: 40, discount: 20, due: 10, vendor: 30 },   // + only must-pay items are funded
};

// KPI drill-through (calc blocks → lib/insight-kit.mjs withKpiDetails).
const SRC = {
  oact: 'OACT — G/L cash & bank accounts (Finanse = Y): current balance',
  opch: 'OPCH — open A/P invoices (not cancelled): balance, due date, payment block',
  octg: 'OCTG — supplier payment terms and their cash-discount code',
  cdc: 'OCDC + CDC1 — cash-discount tiers: % discount within N days of the invoice date',
  opor: 'OPOR + POR1 — open purchase orders: open value per vendor (supply dependency)',
  ocrd: 'OCRD — vendor master (CardType S): frozen flag, payment terms group',
};

// Best discount still available on payDate: the tier with the fewest days
// whose deadline (doc date + days) has not passed yet.
function discountFor(inv, tiers, payDate) {
  if (!tiers?.length) return null;
  for (const t of tiers) {
    const deadline = addDays(inv.docDate, t.days);
    if (deadline >= payDate) return { pct: t.pct, deadline, days: t.days };
  }
  return null;
}

// ── "How is this calculated?" popups — built from the same parts/inputs as the score ──
function explainInvoice({ inv, W, strategyKey, parts, score, disc, discAmt, discApr, discWorth, earlyDays, hurdle, horizon, daysToDue, overdueDays, critical, poShare, maxPoShare, payDate, scheduled }) {
  const pct = v => `${round(v * 100, 1)}%`;
  const ex = {
    score: {
      title: `Priority score ${score}`,
      parts: [
        { label: 'Overdue', max: W.overdue, points: parts.overdue, formula: `${W.overdue} × (0.3 + 0.7 × min(1, days overdue ÷ 60)), only if overdue`,
          detail: overdueDays > 0 ? `${overdueDays} days overdue` : 'Not overdue' },
        { label: 'Early-pay discount', max: W.discount, points: parts.discount,
          formula: `${W.discount} × (0.6 + 0.4 × min(1, annual return ÷ ${hurdle * 3 || 36}%)), only if it beats the ${hurdle}% hurdle`,
          detail: disc ? `${disc.pct}% discount = ${round(discApr, 1)}% a year${discWorth ? '' : ' (below hurdle)'}` : 'No discount available' },
        { label: 'Due soon', max: W.due, points: parts.due, formula: `${W.due} × (1 − days to due ÷ ${horizon + 1}), only if due within ${horizon} days`,
          detail: daysToDue >= 0 ? `Due in ${daysToDue} days` : 'Already overdue' },
        critical
          ? { label: 'Priority vendor', max: W.vendor, points: parts.vendor, formula: `Flagged as priority vendor: full ${W.vendor}`, detail: 'In your priority vendor list' }
          : { label: 'Supply dependency', max: W.vendor, points: parts.vendor, formula: `${W.vendor} × 0.8 × vendor’s open PO share ÷ largest vendor’s share`,
            detail: `${pct(poShare)} of open PO value (largest vendor ${pct(maxPoShare)})` },
      ].map(x => ({ ...x, points: round(x.points, 1) })),
      note: `Weights come from the "${strategyKey}" strategy. Must-pay invoices are funded first, then the highest score.`,
    },
    scheduled: {
      title: `Pay on ${scheduled}`,
      steps: [
        { label: 'Run date', value: payDate }, { label: 'Net due date', value: inv.dueDate },
        ...(disc ? [{ label: 'Discount deadline', value: disc.deadline, detail: discWorth ? 'Discount worth taking' : 'Discount below hurdle — not taken' }] : []),
      ],
      rules: [
        { rule: 'Invoice is overdue', result: 'Pay on the run date', hit: overdueDays > 0 },
        { rule: 'Discount beats the hurdle', result: 'Pay on the discount deadline', hit: overdueDays <= 0 && !!discWorth },
        { rule: 'Otherwise', result: 'Pay on the net due date (keeps cash longer)', hit: overdueDays <= 0 && !discWorth },
      ],
    },
  };
  if (disc) {
    const apr = {
      title: `Discount return ${round(discApr, 1)}% a year`,
      steps: [
        { label: 'Discount', formula: `${disc.pct}% of balance`, value: round(discAmt), detail: `Balance ${fmtAmt(inv.balance)}` },
        { label: 'Days paid early', formula: 'Net due date − discount deadline (min 1)', value: earlyDays, detail: `${disc.deadline} → ${inv.dueDate}` },
        { label: 'Annualised return', formula: `${disc.pct} ÷ (100 − ${disc.pct}) × 365 ÷ ${earlyDays}`, value: `${round(discApr, 1)}%` },
        { label: 'Hurdle (cost of money)', value: `${hurdle}%` },
      ],
      rules: [
        { rule: `Return ≥ ${hurdle}% hurdle`, result: 'Take the discount (YES)', hit: !!discWorth },
        { rule: `Return < ${hurdle}% hurdle`, result: 'Pay on net due date instead (NO)', hit: !discWorth },
      ],
    };
    ex.discountApr = apr;
    ex.beatsHurdle = apr;
  }
  return ex;
}

function explainDecision(r, { budget, left, strategyKey, allowPartial, horizon }) {
  const fits = left != null && r.payAmount <= left + 0.005;
  return {
    title: `Decision: ${r.decision}`,
    steps: [
      { label: 'Amount to pay', formula: r.takeDiscount ? 'Balance − discount' : 'Open balance', value: r.payAmount },
      { label: 'Must pay', formula: 'Overdue, due within 3 days, discount worth taking, or priority vendor due in window', value: r.mustPay ? 'Yes' : 'No' },
      { label: 'Priority score', value: r.score },
      ...(left != null ? [{ label: 'Budget left at its turn', formula: `Of ${fmtAmt(budget)} budget; must-pay first, then highest score`, value: round(left) }] : []),
    ],
    rules: [
      { rule: 'Payment block on invoice or vendor frozen', result: 'HOLD', hit: r.decision === 'HOLD' },
      { rule: `Not overdue, not due within ${horizon} days, no discount deadline in window`, result: 'LATER', hit: r.decision === 'LATER' },
      { rule: `Preserve-cash strategy and not must-pay${strategyKey === 'preserve' ? '' : ' (not active)'}`, result: 'DEFER', hit: r.decision === 'DEFER' },
      { rule: 'Fits the budget and discount taken', result: 'TAKE DISCOUNT', hit: r.decision === 'TAKE DISCOUNT' },
      { rule: 'Fits the budget, pay date is today', result: 'PAY NOW', hit: r.decision === 'PAY NOW' },
      { rule: 'Fits the budget, pay date is later', result: 'PAY ON DUE DATE', hit: r.decision === 'PAY ON DUE DATE' },
      { rule: `Does not fit, must-pay, no discount, part-payments allowed${allowPartial ? '' : ' (switched off)'}`, result: 'PART PAY', hit: r.decision === 'PART PAY' },
      { rule: 'Does not fit the remaining budget', result: 'NO CASH', hit: r.decision === 'NO CASH' },
    ],
    note: left != null && !fits && r.decision === 'NO CASH' ? `Needed ${fmtAmt(r.payAmount)} but only ${fmtAmt(left)} was left.` : r.reason || '',
  };
}

async function run(k, p) {
  const payDate = p.asOf;
  const horizon = clamp(Math.round(num(p.horizonDays) || 14), 1, 120);
  const horizonEnd = addDays(payDate, horizon);
  const hurdle = clamp(num(p.hurdleRatePct ?? 12), 0, 200);
  const strategyKey = STRATEGIES[p.strategy] ? p.strategy : 'balanced';
  const W = STRATEGIES[strategyKey];
  const allowPartial = p.allowPartial === true || p.allowPartial === 'yes';
  const priorityVendors = new Set(String(p.priorityVendors || '').split(/[,;\s]+/).map(s => s.trim().toUpperCase()).filter(Boolean));

  const vendors = await loadPartners(k, 'S');
  const terms = await loadPaymentTerms(k);
  const discounts = await loadCashDiscounts(k);
  const invoices = await loadOpenInvoices(k, 'OPCH');
  const openPos = await loadOpenDocs(k, 'OPOR', 'POR1');
  const spend12 = await loadInvoicedByPartner(k, since(payDate, 365), 'OPCH', 'ORPC');
  const history = summarisePaymentBehaviour(await loadApPaymentHistory(k, since(payDate, 365)));

  let cash = p.cashAvailable;
  let cashSource = 'entered';
  if (cash === undefined || cash === null || cash === '') {
    const c = await loadCashBalance(k);
    cash = c.balance;
    cashSource = c.accounts ? `G/L cash & bank accounts (${c.accounts})` : 'none found — enter cash available';
  }
  cash = num(cash);
  const reserve = Math.max(0, num(p.reserve));
  const budget = Math.max(0, cash - reserve);

  // Supply dependency = vendor's share of all open PO value.
  const poByVendor = new Map();
  for (const d of openPos) poByVendor.set(d.cardCode, (poByVendor.get(d.cardCode) || 0) + d.openValue);
  const totalPo = [...poByVendor.values()].reduce((s, x) => s + x, 0) || 1;
  const maxPoShare = Math.max(0.0001, ...[...poByVendor.values()].map(v => v / totalPo));

  const rows = invoices.map(inv => {
    const bp = vendors.get(inv.cardCode) || {};
    const term = terms.get(String(inv.groupNum ?? bp.groupNum));
    const disc = term?.discCode ? discountFor(inv, discounts.get(term.discCode), payDate) : null;
    const daysToDue = daysBetween(payDate, inv.dueDate);
    const overdueDays = Math.max(0, -daysToDue);
    const discAmt = disc ? inv.balance * (disc.pct / 100) : 0;
    // Annualised return of paying early: pct/(1-pct) × 365 / days paid early.
    const earlyDays = disc ? Math.max(1, daysBetween(disc.deadline, inv.dueDate)) : 0;
    const discApr = disc ? (disc.pct / (100 - disc.pct)) * (365 / earlyDays) * 100 : 0;
    const discWorth = disc && discApr >= hurdle;
    const critical = priorityVendors.has(String(inv.cardCode).toUpperCase());
    const poShare = (poByVendor.get(inv.cardCode) || 0) / totalPo;

    const parts = {
      overdue: overdueDays > 0 ? W.overdue * (0.3 + 0.7 * Math.min(1, overdueDays / 60)) : 0,
      discount: discWorth ? W.discount * (0.6 + 0.4 * Math.min(1, discApr / (hurdle * 3 || 36))) : 0,
      due: daysToDue >= 0 && daysToDue <= horizon ? W.due * (1 - daysToDue / (horizon + 1)) : 0,
      vendor: critical ? W.vendor : W.vendor * 0.8 * (poShare / maxPoShare),
    };
    const score = Math.round(Object.values(parts).reduce((s, x) => s + x, 0));
    const inScope = overdueDays > 0 || daysToDue <= horizon || (discWorth && disc.deadline <= horizonEnd);
    const mustPay = overdueDays > 0 || daysToDue <= 3 || (discWorth && disc.deadline <= horizonEnd) || critical && daysToDue <= horizon;
    const scheduled = overdueDays > 0 ? payDate : discWorth ? disc.deadline : inv.dueDate < payDate ? payDate : inv.dueDate;
    const payAmount = discWorth ? inv.balance - discAmt : inv.balance;
    const h = history.get(inv.cardCode);
    const driver = Object.entries(parts).sort((a, z) => z[1] - a[1])[0];

    return {
      docEntry: inv.docEntry, docNum: inv.docNum, cardCode: inv.cardCode, cardName: inv.cardName,
      docDate: inv.docDate, dueDate: inv.dueDate, daysToDue, overdueDays,
      balance: round(inv.balance), payAmount: round(payAmount),
      discountPct: disc?.pct ?? null, discountDeadline: disc?.deadline ?? null, discountAmt: round(discAmt),
      discountApr: disc ? round(discApr, 1) : null, takeDiscount: !!discWorth, beatsHurdle: disc ? (discWorth ? 'YES' : 'NO') : '',
      terms: term?.name || '', critical: critical ? 'YES' : '', poShare: round(poShare * 100, 1),
      openPoValue: round(poByVendor.get(inv.cardCode) || 0), spend12m: round(Math.max(0, spend12.get(inv.cardCode)?.total || 0)),
      ourAvgDaysLate: h?.avgDaysLate ?? null, blocked: inv.payBlocked || bp.frozen,
      blockReason: inv.payBlocked ? 'Payment block on invoice' : bp.frozen ? 'Vendor is frozen/inactive' : '',
      score, inScope, mustPay, scheduled,
      mainReason: overdueDays > 0 ? `${overdueDays}d overdue`
        : discWorth ? `${disc.pct}% discount (${round(discApr, 0)}% p.a.) until ${disc.deadline}`
        : critical ? 'Priority vendor'
        : daysToDue <= horizon ? `Due in ${daysToDue}d`
        : `Due ${inv.dueDate}`,
      driver: { overdue: 'Overdue', discount: 'Discount', due: 'Due soon', vendor: critical ? 'Priority vendor' : 'Supply dependency' }[driver[0]],
      explain: explainInvoice({ inv, W, strategyKey, parts, score, disc, discAmt, discApr, discWorth, earlyDays, hurdle, horizon, daysToDue, overdueDays, critical, poShare, maxPoShare, payDate, scheduled }),
    };
  });

  // ── Allocate cash ─────────────────────────────────────────────────────────
  let remaining = budget;
  const budgetLeft = new Map();   // row → budget still unallocated when its turn came (for the Decision popup)
  const order = rows.filter(r => !r.blocked && r.inScope)
    .sort((a, z) => (z.mustPay - a.mustPay) || z.score - a.score || a.scheduled.localeCompare(z.scheduled));
  for (const r of order) {
    budgetLeft.set(r, remaining);
    if (strategyKey === 'preserve' && !r.mustPay) {
      r.decision = 'DEFER'; r.reason = 'Preserve-cash strategy: not urgent, pay on a later run'; continue;
    }
    if (r.payAmount <= remaining + 0.005) {
      remaining -= r.payAmount;
      r.paid = r.payAmount;
      r.decision = r.takeDiscount ? 'TAKE DISCOUNT' : r.scheduled <= payDate ? 'PAY NOW' : 'PAY ON DUE DATE';
      r.reason = r.mainReason;
    } else if (allowPartial && remaining > 0 && r.mustPay && !r.takeDiscount) {
      r.paid = round(remaining);
      remaining = 0;
      r.decision = 'PART PAY';
      r.reason = `Only ${fmtAmt(r.paid)} of ${fmtAmt(r.payAmount)} fits the budget — pay part and agree a date for the rest`;
    } else {
      r.decision = 'NO CASH';
      r.reason = r.takeDiscount ? `Discount of ${fmtAmt(r.discountAmt)} will be lost — insufficient cash` : 'Insufficient cash — agree a payment date with the vendor';
    }
  }
  for (const r of rows) {
    if (r.decision) continue;
    if (r.blocked) { r.decision = 'HOLD'; r.reason = r.blockReason; }
    else { r.decision = 'LATER'; r.reason = `Due ${r.dueDate} — outside the ${horizon}-day window`; }
  }
  for (const r of rows) r.paid = round(r.paid || 0);
  for (const r of rows) r.explain.decision = explainDecision(r, { budget, left: budgetLeft.get(r), strategyKey, allowPartial, horizon });

  const selected = rows.filter(r => r.paid > 0).sort((a, z) => a.scheduled.localeCompare(z.scheduled) || z.score - a.score);
  const unpaidInScope = rows.filter(r => ['NO CASH', 'DEFER', 'PART PAY'].includes(r.decision) || (r.decision === 'HOLD' && r.inScope));
  const discountRows = rows.filter(r => r.discountPct != null).sort((a, z) => (z.discountApr || 0) - (a.discountApr || 0));
  const overdueRows = rows.filter(r => r.overdueDays > 0).sort((a, z) => z.overdueDays - a.overdueDays);

  const sum = (list, f) => list.reduce((s, r) => s + num(r[f]), 0);
  const runTotal = sum(selected, 'paid');
  const captured = sum(selected.filter(r => r.decision === 'TAKE DISCOUNT'), 'discountAmt');
  const lost = sum(rows.filter(r => r.takeDiscount && r.decision !== 'TAKE DISCOUNT'), 'discountAmt');
  const overdueTotal = sum(overdueRows, 'balance');
  const overduePaid = sum(overdueRows, 'paid');
  const totalOpen = sum(rows, 'balance');
  const noCash = rows.filter(r => r.decision === 'NO CASH');
  // Unfunded = invoices that got nothing plus the unpaid remainder of part-payments.
  const shortfall = sum(noCash, 'payAmount') + rows.filter(r => r.decision === 'PART PAY').reduce((s, r) => s + r.payAmount - r.paid, 0);
  const n = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

  // Weekly schedule of the recommended run + remaining cash.
  const weeks = Math.max(1, Math.ceil((horizon + 1) / 7));
  const wk = Array.from({ length: weeks }, (_, i) => ({ week: i + 1, from: addDays(payDate, i * 7), to: addDays(payDate, i * 7 + 6), overdue: 0, discount: 0, due: 0, count: 0 }));
  for (const r of selected) {
    const w = wk[Math.min(weeks - 1, Math.floor(daysBetween(payDate, r.scheduled) / 7))];
    w.count++;
    if (r.overdueDays > 0) w.overdue += r.paid; else if (r.decision === 'TAKE DISCOUNT') w.discount += r.paid; else w.due += r.paid;
  }
  let bal = cash;
  for (const w of wk) { w.total = round(w.overdue + w.discount + w.due); bal -= w.total; w.cashAfter = round(bal); for (const f of ['overdue', 'discount', 'due']) w[f] = round(w[f]); }

  // Vendor summary
  const byVendor = new Map();
  for (const r of rows) {
    const v = byVendor.get(r.cardCode) || { cardCode: r.cardCode, cardName: r.cardName, invoices: 0, open: 0, overdue: 0, pay: 0, discount: 0, deferred: 0, critical: r.critical, poShare: r.poShare, ourAvgDaysLate: r.ourAvgDaysLate };
    v.invoices++; v.open += r.balance; if (r.overdueDays > 0) v.overdue += r.balance;
    v.pay += r.paid; if (r.decision === 'TAKE DISCOUNT') v.discount += r.discountAmt;
    if (['NO CASH', 'DEFER', 'PART PAY'].includes(r.decision)) v.deferred += r.payAmount - r.paid;
    byVendor.set(r.cardCode, v);
  }
  const vendorRows = [...byVendor.values()].map(v => ({ ...v, open: round(v.open), overdue: round(v.overdue), pay: round(v.pay), discount: round(v.discount), deferred: round(v.deferred) }))
    .sort((a, z) => z.pay - a.pay || z.overdue - a.overdue);

  const discountsConfigured = discounts.size > 0;
  const insight = `**Recommended payment run: ${fmtAmt(runTotal)} across ${n(selected.length, 'invoice')}${budget > 0 ? ` (${Math.round((runTotal / budget) * 100)}% of the ${fmtAmt(budget)} budget)` : ''}.**\n\n` +
    (budget <= 0 ? `- **No cash is available** after the reserve (cash ${fmtAmt(cash)}, reserve ${fmtAmt(reserve)}). Enter the actual cash available to get a payment run.\n` : '') +
    `- Overdue: ${fmtAmt(overduePaid)} of ${fmtAmt(overdueTotal)} cleared by this run${overdueTotal - overduePaid > 0 ? `; **${fmtAmt(overdueTotal - overduePaid)} stays overdue**` : ''}.\n` +
    (discountsConfigured
      ? `- Early-payment discounts captured: ${fmtAmt(captured)}${lost > 0 ? `; ${fmtAmt(lost)} worth taking is lost for lack of cash` : ''}.\n`
      : '- No cash-discount terms are set up on supplier payment terms, so no early-payment discounts apply.\n') +
    (shortfall > 0 ? `- ${n(noCash.length + rows.filter(r => r.decision === 'PART PAY').length, 'due or overdue invoice')} (${fmtAmt(shortfall)} unfunded) do not fully fit the budget — agree dates with those vendors.\n` : '') +
    (selected[0] ? `- Top priority: **${selected.slice().sort((a, z) => z.score - a.score)[0].cardName}** — ${selected.slice().sort((a, z) => z.score - a.score)[0].mainReason}.\n` : '') +
    (rows.some(r => r.blocked) ? `- ${n(rows.filter(r => r.blocked).length, 'invoice')} on hold (payment block or frozen vendor).\n` : '');

  const aiContext = `A/P PAYMENT RUN for ${payDate}, ${horizon}-day window, strategy ${strategyKey}, hurdle ${hurdle}% p.a., partial payments ${allowPartial ? 'allowed' : 'not allowed'}.
Cash ${fmtAmt(cash)} (${cashSource}), reserve ${fmtAmt(reserve)}, budget ${fmtAmt(budget)}. Open A/P ${fmtAmt(totalOpen)}; overdue ${fmtAmt(overdueTotal)}.
Run ${fmtAmt(runTotal)} (${selected.length} invoices), discounts captured ${fmtAmt(captured)}, lost ${fmtAmt(lost)}, unfunded due/overdue ${fmtAmt(shortfall)}. Priority vendors: ${[...priorityVendors].join(', ') || 'none'}.
PAYMENT RUN:
${ctxTable(selected, [['scheduled', 'PayOn'], ['cardName', 'Vendor'], ['docNum', 'Inv'], ['dueDate', 'Due'], ['paid', 'Pay'], ['discountAmt', 'Disc'], ['score', 'Score'], ['decision', 'Decision'], ['reason', 'Why']], 30)}
NOT FUNDED:
${ctxTable(unpaidInScope, [['cardName', 'Vendor'], ['docNum', 'Inv'], ['dueDate', 'Due'], ['overdueDays', 'Overdue'], ['payAmount', 'Amount'], ['decision', 'Decision']], 20)}
BY VENDOR:
${ctxTable(vendorRows, [['cardName', 'Vendor'], ['open', 'Open'], ['overdue', 'Overdue'], ['pay', 'PayNow'], ['poShare', 'OpenPO%'], ['ourAvgDaysLate', 'WePayLateBy']], 15)}`;

  const invCols = [
    { key: 'decision', label: 'Decision', fmt: 'badge', badge: { 'PAY NOW': 'green', 'TAKE DISCOUNT': 'purple', 'PAY ON DUE DATE': 'blue', 'PART PAY': 'amber', 'NO CASH': 'red', DEFER: 'amber', HOLD: 'grey', LATER: 'grey' },
      hint: 'Recommended action: pay now, take the discount, pay on due date, part-pay, no cash left, defer, on hold (blocked) or later (outside the window)' },
    { key: 'scheduled', label: 'Pay on', fmt: 'date', hint: 'Recommended payment date: today if overdue, the discount deadline if taking the discount, else the net due date' },
    { key: 'cardName', label: 'Vendor', sub: 'cardCode', hint: 'Supplier name and SAP business partner code' },
    { key: 'docNum', label: 'Invoice #', hint: 'SAP document number of the A/P invoice' },
    { key: 'dueDate', label: 'Due', fmt: 'date', hint: 'Net due date of the A/P invoice' },
    { key: 'overdueDays', label: 'Overdue (d)', fmt: 'int', hint: 'Days past the due date as of the run date (0 = not overdue)' },
    { key: 'balance', label: 'Balance', fmt: 'amt', hint: 'Unpaid amount of the invoice (document total − paid to date)' },
    { key: 'discountAmt', label: 'Discount', fmt: 'amt', hint: 'Early-payment discount available: balance × discount % of the payment terms' },
    { key: 'paid', label: 'Pay', fmt: 'amt', strong: true, hint: 'Amount funded in this run: balance (less discount if taken), or the part that fits the budget' },
    { key: 'score', label: 'Priority', fmt: 'score', invert: true, hint: `Priority score 0-100: overdue ${W.overdue} + discount ${W.discount} + due soon ${W.due} + vendor importance ${W.vendor} points ("${strategyKey}" strategy)` },
    { key: 'critical', label: 'Priority vendor', fmt: 'badge', hint: 'YES when the vendor is in your priority vendor list' },
    { key: 'reason', label: 'Why', wrap: true, hint: 'Main reason for the decision' },
  ];

  return {
    kpis: [
      { label: 'Cash available', value: cash, fmt: 'amt', hint: cashSource,
        calc: { formula: cashSource === 'entered' ? 'Cash available as entered in the options above (overrides the G/L balance).' : 'Σ current balance of the G/L cash & bank accounts (OACT.Finanse = Y).',
          steps: ['Leave "Cash available" blank to read the G/L cash & bank balance automatically.', 'Enter a figure to plan with expected cash instead (e.g. after known receipts).', `Payment budget = this cash − reserve of ${fmtAmt(reserve)}.`],
          sources: [SRC.oact], tab: 'schedule', chart: null,
          stats: [{ label: 'Reserve kept back', value: reserve, fmt: 'amt' }, { label: 'Payment budget', value: budget, fmt: 'amt' },
            { label: 'Total open A/P', value: round(totalOpen), fmt: 'amt' }, { label: 'Of which overdue', value: round(overdueTotal), fmt: 'amt' }] } },
      { label: 'Payment budget', value: budget, fmt: 'amt', hint: `Cash less reserve of ${fmtAmt(reserve)}`,
        calc: { formula: `Payment budget = cash available ${fmtAmt(cash)} − reserve ${fmtAmt(reserve)} (never below zero).`,
          steps: ['Must-pay invoices (overdue, due within 3 days, discounts worth taking, priority vendors due in the window) are funded first.', 'Then the remaining budget goes to the highest priority scores until it runs out.'],
          sources: [SRC.oact, SRC.opch], tab: 'run', sortBy: 'paid',
          stats: [{ label: 'Allocated to the run', value: round(runTotal), fmt: 'amt' }, { label: 'Budget used', value: budget ? round((runTotal / budget) * 100, 1) : 0, fmt: 'pct' },
            { label: 'Budget left', value: round(budget - runTotal), fmt: 'amt' }, { label: 'Unfunded due / overdue', value: round(shortfall), fmt: 'amt' }] } },
      { label: 'Recommended run', value: runTotal, fmt: 'amt', tone: 'good', hint: 'Total to pay in this payment run',
        calc: { formula: `Σ amount funded per invoice (balance, less discount where taken) for invoices due, overdue or with a discount deadline within ${horizon} days.`,
          steps: ['Blocked invoices and frozen vendors are excluded (HOLD).', 'Invoices are funded in order: must-pay first, then by priority score, then by pay date.', allowPartial ? 'Part-payments are allowed for must-pay invoices that do not fully fit.' : 'Part-payments are switched off: an invoice is paid in full or not at all.'],
          sources: [SRC.opch, SRC.octg, SRC.cdc, SRC.opor, SRC.ocrd, SRC.oact], tab: 'run', sortBy: 'paid',
          stats: [{ label: 'Pay now', value: round(sum(selected.filter(r => r.decision === 'PAY NOW'), 'paid')), fmt: 'amt' },
            { label: 'Take discount', value: round(sum(selected.filter(r => r.decision === 'TAKE DISCOUNT'), 'paid')), fmt: 'amt' },
            { label: 'Pay on due date', value: round(sum(selected.filter(r => r.decision === 'PAY ON DUE DATE'), 'paid')), fmt: 'amt' },
            { label: 'Part payments', value: round(sum(selected.filter(r => r.decision === 'PART PAY'), 'paid')), fmt: 'amt' },
            { label: '% of budget', value: budget ? round((runTotal / budget) * 100, 1) : 0, fmt: 'pct' }] } },
      { label: 'Invoices to pay', value: selected.length, fmt: 'int', hint: 'A/P invoices funded (fully or partly) in this run',
        calc: { formula: 'Count of open A/P invoices that receive any amount in the recommended run.',
          steps: [`In scope: overdue, due within ${horizon} days, or a worthwhile discount deadline within the window.`, 'Each in-scope invoice is funded only while budget remains.'],
          sources: [SRC.opch], tab: 'run', sortBy: 'paid',
          stats: [{ label: 'Vendors paid', value: new Set(selected.map(r => r.cardCode)).size, fmt: 'int' },
            { label: 'Overdue invoices paid', value: selected.filter(r => r.overdueDays > 0).length, fmt: 'int' },
            { label: 'With discount taken', value: selected.filter(r => r.decision === 'TAKE DISCOUNT').length, fmt: 'int' },
            { label: 'Not funded (in scope)', value: unpaidInScope.length, fmt: 'int' }, { label: 'Open A/P invoices', value: rows.length, fmt: 'int' }] } },
      { label: 'Discounts captured', value: captured, fmt: 'amt', tone: captured ? 'good' : undefined, hint: `Early-payment discounts taken (return ≥ ${hurdle}% a year)`,
        calc: { formula: `Σ discount amount (balance × discount %) on invoices paid by their discount deadline, where the annualised return ≥ the ${hurdle}% hurdle.`,
          steps: ['Annualised return = discount % ÷ (100 − discount %) × 365 ÷ days paid early.', 'Discounts below the hurdle are ignored: paying on the net due date keeps cash longer.', discountsConfigured ? 'Discount tiers come from the cash-discount codes on supplier payment terms.' : 'No cash-discount tiers are set up on supplier payment terms, so this is zero.'],
          sources: [SRC.opch, SRC.octg, SRC.cdc], tab: 'discounts', filter: r => r.decision === 'TAKE DISCOUNT', sortBy: 'discountAmt',
          stats: [{ label: 'Invoices with discount terms', value: discountRows.length, fmt: 'int' }, { label: 'Worth taking (beat hurdle)', value: rows.filter(r => r.takeDiscount).length, fmt: 'int' },
            { label: 'Lost for lack of cash', value: round(lost), fmt: 'amt' }, { label: 'Hurdle rate', value: hurdle, fmt: 'pct' }] } },
      { label: 'Overdue left unpaid', value: overdueTotal - overduePaid, fmt: 'amt', tone: overdueTotal - overduePaid > 0 ? 'bad' : 'good', hint: 'Overdue A/P balance this run does not clear',
        calc: { formula: 'Σ balance of overdue A/P invoices − Σ amount paid on them in this run.',
          steps: ['Overdue = net due date before the run date.', 'Overdue invoices are must-pay and funded first; what remains is due to blocks, frozen vendors or lack of cash.'],
          sources: [SRC.opch], tab: 'overdue', filter: r => r.paid < r.balance, sortBy: 'balance',
          stats: [{ label: 'Total overdue', value: round(overdueTotal), fmt: 'amt' }, { label: 'Paid in this run', value: round(overduePaid), fmt: 'amt' },
            { label: 'Overdue invoices', value: overdueRows.length, fmt: 'int' }, { label: 'Oldest (days)', value: overdueRows[0]?.overdueDays || 0, fmt: 'int' },
            { label: 'On hold (blocked)', value: overdueRows.filter(r => r.decision === 'HOLD').length, fmt: 'int' }] } },
      { label: 'Unfunded due / overdue', value: shortfall, fmt: 'amt', tone: shortfall ? 'bad' : 'good', hint: 'Due or overdue amounts the budget cannot cover',
        calc: { formula: 'Σ amount of invoices marked NO CASH + unpaid remainder of PART PAY invoices.',
          steps: ['These invoices were in scope but the budget ran out before their turn.', 'Agree a payment date with these vendors or increase the cash available.'],
          sources: [SRC.opch, SRC.oact], tab: 'unfunded', filter: r => r.decision === 'NO CASH' || r.decision === 'PART PAY', sortBy: 'payAmount',
          stats: [{ label: 'NO CASH invoices', value: noCash.length, fmt: 'int' }, { label: 'PART PAY invoices', value: rows.filter(r => r.decision === 'PART PAY').length, fmt: 'int' },
            { label: 'Deferred (preserve cash)', value: rows.filter(r => r.decision === 'DEFER').length, fmt: 'int' }, { label: 'Discounts lost', value: round(lost), fmt: 'amt' }] } },
      { label: 'Cash after run', value: cash - runTotal, fmt: 'amt', tone: cash - runTotal >= reserve ? 'good' : 'bad', hint: 'Cash available − recommended run',
        calc: { formula: `Cash after run = cash available ${fmtAmt(cash)} − recommended run ${fmtAmt(runTotal)}.`,
          steps: [`Shown green when it stays at or above the reserve of ${fmtAmt(reserve)}.`, 'The weekly schedule shows how cash falls as each week’s payments go out.', 'Expected customer receipts are not included.'],
          sources: [SRC.oact, SRC.opch], tab: 'schedule', sortBy: 'total',
          stats: [{ label: 'Cash available', value: round(cash), fmt: 'amt' }, { label: 'Recommended run', value: round(runTotal), fmt: 'amt' },
            { label: 'Reserve', value: reserve, fmt: 'amt' }, { label: 'Headroom over reserve', value: round(cash - runTotal - reserve), fmt: 'amt' }] } },
    ],
    chart: {
      title: 'Payment schedule by week', type: 'bar', labels: wk.map(w => `W${w.week} ${w.from.slice(5)}`),
      desc: 'Bars show how much is paid each week, split into overdue, discount and on-due-date payments; the green line is cash left after each week.',
      series: [
        { name: 'Overdue', values: wk.map(w => w.overdue), color: '#DC2626' },
        { name: 'Discount', values: wk.map(w => w.discount), color: '#7C3AED' },
        { name: 'Due', values: wk.map(w => w.due), color: '#2563EB' },
        { name: 'Cash after', values: wk.map(w => w.cashAfter), type: 'line', color: '#059669' },
      ],
    },
    tabs: [
      { key: 'run', label: `Payment run (${selected.length})`, rows: selected, columns: invCols,
        desc: 'Invoices to pay in this run, in pay-date order; use it (or the CSV export) to prepare the outgoing payments in SAP.' },
      { key: 'unfunded', label: `Not funded (${unpaidInScope.length})`, rows: unpaidInScope.sort((a, z) => z.score - a.score), columns: invCols,
        desc: 'Due or overdue invoices that did not get (full) cash, highest priority first; agree payment dates with these vendors.' },
      { key: 'overdue', label: `Overdue (${overdueRows.length})`, rows: overdueRows, columns: invCols,
        desc: 'All overdue A/P invoices, oldest first, with what this run pays on each.' },
      { key: 'discounts', label: `Discounts (${discountRows.length})`, rows: discountRows,
        desc: `Invoices with an early-payment discount, best annual return first; YES means the return beats the ${hurdle}% hurdle and is worth paying early for.`,
        columns: [invCols[0], { key: 'cardName', label: 'Vendor', sub: 'cardCode', hint: 'Supplier name and SAP business partner code' },
          { key: 'docNum', label: 'Invoice #', hint: 'SAP document number of the A/P invoice' },
          { key: 'balance', label: 'Balance', fmt: 'amt', hint: 'Unpaid amount of the invoice' },
          { key: 'discountPct', label: 'Discount %', fmt: 'num', hint: 'Discount % still available on the run date from the payment terms' },
          { key: 'discountDeadline', label: 'Pay by', fmt: 'date', hint: 'Last date to pay and still get the discount (invoice date + discount days)' },
          { key: 'dueDate', label: 'Net due', fmt: 'date', hint: 'Net due date if the discount is not taken' },
          { key: 'discountAmt', label: 'Saving', fmt: 'amt', strong: true, hint: 'Balance × discount %' },
          { key: 'discountApr', label: 'Annualised', fmt: 'pct', hint: 'Discount % ÷ (100 − discount %) × 365 ÷ days paid early' },
          { key: 'beatsHurdle', label: 'Beats hurdle', fmt: 'badge', badge: { YES: 'green', NO: 'grey' }, hint: `YES when the annualised return is at least the ${hurdle}% cost-of-money hurdle` }] },
      { key: 'schedule', label: 'Weekly schedule', rows: wk,
        desc: 'Payments of the recommended run grouped by week, with the cash balance left after each week.',
        columns: [{ key: 'week', label: 'Wk', fmt: 'int', hint: 'Week number from the run date' },
          { key: 'from', label: 'From', fmt: 'date', hint: 'First day of the week' }, { key: 'to', label: 'To', fmt: 'date', hint: 'Last day of the week' },
          { key: 'count', label: 'Invoices', fmt: 'int', hint: 'Invoices scheduled for payment this week' },
          { key: 'overdue', label: 'Overdue', fmt: 'amt', hint: 'Payments clearing overdue invoices' },
          { key: 'discount', label: 'Discount', fmt: 'amt', hint: 'Payments made early to capture a discount' },
          { key: 'due', label: 'Due', fmt: 'amt', hint: 'Payments made on their net due date' },
          { key: 'total', label: 'Total', fmt: 'amt', strong: true, hint: 'Overdue + discount + due payments this week' },
          { key: 'cashAfter', label: 'Cash after', fmt: 'amt', hint: 'Cash available − all run payments up to the end of this week' }] },
      { key: 'vendors', label: `By vendor (${vendorRows.length})`, rows: vendorRows,
        desc: 'Open A/P and this run’s payments per vendor; check vendors with large "Not funded" amounts or a high open PO share.',
        columns: [{ key: 'cardName', label: 'Vendor', sub: 'cardCode', hint: 'Supplier name and SAP business partner code' },
          { key: 'invoices', label: 'Invoices', fmt: 'int', hint: 'Open A/P invoices for this vendor' },
          { key: 'open', label: 'Open', fmt: 'amt', hint: 'Total unpaid A/P balance with this vendor' },
          { key: 'overdue', label: 'Overdue', fmt: 'amt', hint: 'Part of the open balance past its due date' },
          { key: 'pay', label: 'Pay in run', fmt: 'amt', strong: true, hint: 'Amount paid to this vendor in the recommended run' },
          { key: 'discount', label: 'Discount', fmt: 'amt', hint: 'Early-payment discounts captured from this vendor' },
          { key: 'deferred', label: 'Not funded', fmt: 'amt', hint: 'Due/overdue amounts left unpaid for lack of cash or deferred' },
          { key: 'poShare', label: 'Open PO share', fmt: 'pct', hint: 'Vendor’s share of all open purchase-order value — a measure of supply dependency' },
          { key: 'ourAvgDaysLate', label: 'We pay late by (d)', fmt: 'int', hint: 'How many days after due date we paid this vendor on average over 12 months' },
          { key: 'critical', label: 'Priority', fmt: 'badge', hint: 'YES when the vendor is in your priority vendor list' }] },
    ],
    notes: [
      `Strategy "${strategyKey}" weights: overdue ${W.overdue}, discount ${W.discount}, due-date ${W.due}, vendor ${W.vendor}. Must-pay items (overdue, due within 3 days, discounts worth taking, priority vendors due in the window) are funded first, then by score.`,
      `A discount is taken only if its annualised return (pct ÷ (100 − pct) × 365 ÷ days paid early) is at least the ${hurdle}% hurdle. Payments are scheduled on the latest date that still captures their value.`,
      `Cash: ${cashSource}. Supply dependency = the vendor's share of all open purchase-order value. Nothing is posted to SAP — use the CSV export to prepare the payment run.`,
      discountsConfigured ? '' : 'No cash-discount tiers (OCDC/CDC1) are linked to supplier payment terms on this company.',
    ].filter(Boolean),
    insight, aiContext,
  };
}

export function createApPaymentOptimizationRouter(deps) {
  return createInsightRouter(deps, {
    slug: 'appayment', title: 'AP Payment Optimization Agent',
    defaults: { horizonDays: 14, hurdleRatePct: 12, strategy: 'balanced', reserve: 0 },
    persona: 'You are a treasury and accounts-payable manager planning supplier payment runs in SAP Business One.',
    aiTask: 'Review this recommended supplier payment run. Explain what is being paid and why, which vendors are left unpaid and the risk of that, discounts worth taking, and how to sequence payments if cash is tight.',
    run,
  });
}
