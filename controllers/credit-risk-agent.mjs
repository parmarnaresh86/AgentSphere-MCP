/**
 * Credit Risk Agent — mounted at /api/credit-risk-agent
 *
 * Scores every active customer 0-100 (higher = riskier) from overdue share,
 * age of the oldest overdue invoice, historical days-late, credit-limit
 * utilisation (or months of exposure when no limit is set) and new-order
 * exposure while overdue. Grades A-E, recommends terms and a credit limit, and
 * snapshots scores daily (SQLite) so each run shows movement since last time.
 */
import { createInsightRouter, ctxTable, daysBetween, num, round, clamp, fmtAmt } from '../lib/insight-kit.mjs';
import {
  loadPartners, loadOpenInvoices, loadOpenDocs, loadArPaymentHistory, summarisePaymentBehaviour,
  loadInvoicedByPartner, loadPaymentTerms, termDays, since,
} from '../lib/insight-data.mjs';
import { creditSnapRepo } from '../lib/insight-store.mjs';

const GRADES = [
  { grade: 'A', max: 20, label: 'Low risk', rec: 'Normal terms; eligible for a limit increase', factor: 1.5 },
  { grade: 'B', max: 40, label: 'Moderate', rec: 'Normal terms; review quarterly', factor: 1.2 },
  { grade: 'C', max: 60, label: 'Elevated', rec: 'Monitor; require a promise-to-pay before releasing new orders', factor: 1.0 },
  { grade: 'D', max: 80, label: 'High', rec: 'Credit hold on new orders until overdue is cleared', factor: 0.5 },
  { grade: 'E', max: 101, label: 'Severe', rec: 'Stop supply; cash-in-advance only; consider legal recovery', factor: 0 },
];
const gradeOf = score => GRADES.find(g => score < g.max);

async function run(k, p) {
  const asOf = p.asOf;
  const customers = await loadPartners(k, 'C');
  const terms = await loadPaymentTerms(k);
  const invoices = await loadOpenInvoices(k, 'OINV');
  const orders = await loadOpenDocs(k, 'ORDR', 'RDR1');
  const behaviour = summarisePaymentBehaviour(await loadArPaymentHistory(k, since(asOf, 365)));
  const sales12 = await loadInvoicedByPartner(k, since(asOf, 365));
  const prev = creditSnapRepo.previous(k.company, asOf);

  const agg = new Map();
  const get = card => {
    if (!agg.has(card)) agg.set(card, { outstanding: 0, overdue: 0, maxDaysOverdue: 0, openOrders: 0, orderCount: 0 });
    return agg.get(card);
  };
  for (const inv of invoices) {
    const a = get(inv.cardCode);
    const d = daysBetween(inv.dueDate, asOf);
    a.outstanding += inv.balance;
    if (d > 0) { a.overdue += inv.balance; a.maxDaysOverdue = Math.max(a.maxDaysOverdue, d); }
  }
  for (const o of orders) { const a = get(o.cardCode); a.openOrders += o.openValue; a.orderCount++; }
  for (const [card, s] of sales12) if (s.total > 0) get(card);

  const rows = [];
  for (const [card, a] of agg) {
    const bp = customers.get(card);
    if (!bp) continue;
    const b = behaviour.get(card);
    const sales = Math.max(0, sales12.get(card)?.total || 0);
    const avgMonthly = sales / 12;
    const exposure = a.outstanding + a.openOrders + bp.dnotesBal;
    if (exposure <= 0 && sales <= 0) continue;
    const overdueRatio = a.outstanding > 0 ? a.overdue / a.outstanding : 0;
    const util = bp.creditLimit > 0 ? exposure / bp.creditLimit : null;
    const expMonths = avgMonthly > 0 ? exposure / avgMonthly : (exposure > 0 ? 99 : 0);

    const parts = {
      overdue: 25 * overdueRatio,
      age: 20 * Math.min(1, a.maxDaysOverdue / 120),
      history: b ? 20 * clamp(b.avgDaysLate / 60, 0, 1) : (exposure > 0 ? 10 : 0),
      utilisation: util != null ? 20 * clamp((util - 0.5) / 0.5, 0, 1) : 20 * clamp((expMonths - 1) / 2, 0, 1),
      orders: a.openOrders > 0 ? 15 * clamp(overdueRatio * 2, 0, 1) : 0,
    };
    const score = Math.round(Object.values(parts).reduce((s, x) => s + x, 0));
    const g = gradeOf(score);
    const tDays = termDays(terms, bp.groupNum);
    const suggestedLimit = Math.round((avgMonthly * (tDays / 30 + 1) * g.factor) / 1000) * 1000;
    const p0 = prev.get(card);
    const delta = p0 ? score - p0.score : null;

    const flags = [];
    if (!bp.creditLimit) flags.push('No limit set');
    if (util != null && util > 1) flags.push(`Over limit ${Math.round(util * 100)}%`);
    if (a.openOrders > 0 && a.maxDaysOverdue > 60) flags.push('Orders open while >60d overdue');
    if (!b && exposure > 0) flags.push('No payment history');
    if (bp.frozen) flags.push('BP frozen');
    if (delta != null && delta >= 10) flags.push(`Worsened +${delta}`);

    const driver = Object.entries(parts).sort((x, y) => y[1] - x[1])[0];
    rows.push({
      cardCode: card, cardName: bp.cardName, grade: g.grade, band: g.label, score, delta,
      prevGrade: p0?.grade || '', trend: delta == null ? 'NEW' : delta >= 5 ? 'WORSE' : delta <= -5 ? 'BETTER' : 'STABLE',
      outstanding: round(a.outstanding), overdue: round(a.overdue), overduePct: round(overdueRatio * 100, 1),
      maxDaysOverdue: a.maxDaysOverdue, avgDaysLate: b?.avgDaysLate ?? null, onTimeRate: b?.onTimeRate ?? null,
      openOrders: round(a.openOrders), exposure: round(exposure), atRisk: round(exposure * score / 100), creditLimit: bp.creditLimit,
      utilisation: util != null ? round(util * 100, 1) : null, sales12m: round(sales),
      exposureMonths: expMonths >= 99 ? null : round(expMonths, 1), terms: terms.get(String(bp.groupNum))?.name || `${tDays}d`,
      suggestedLimit, limitChange: suggestedLimit - bp.creditLimit,
      mainDriver: { overdue: 'Overdue share', age: 'Age of overdue', history: 'Pays late', utilisation: util != null ? 'Limit utilisation' : 'Exposure vs sales', orders: 'New orders while overdue' }[driver[0]],
      flags: flags.join(', '), recommendation: g.rec,
    });
  }
  rows.sort((a, z) => z.score - a.score || z.exposure - a.exposure);
  creditSnapRepo.save(k.company, asOf, rows);

  const byGrade = GRADES.map(g => {
    const r = rows.filter(x => x.grade === g.grade);
    return { grade: g.grade, band: g.label, customers: r.length, exposure: round(r.reduce((s, x) => s + x.exposure, 0)), overdue: round(r.reduce((s, x) => s + x.overdue, 0)), recommendation: g.rec };
  });
  const totalExp = rows.reduce((s, r) => s + r.exposure, 0);
  const highRisk = rows.filter(r => r.grade === 'D' || r.grade === 'E');
  const highExp = highRisk.reduce((s, r) => s + r.exposure, 0);
  const worse = rows.filter(r => r.trend === 'WORSE');
  const noLimit = rows.filter(r => !r.creditLimit);
  const ordersAtRisk = rows.filter(r => r.openOrders > 0 && (r.grade === 'D' || r.grade === 'E'));
  // Watchlist ranks by risk-weighted exposure so a tiny account with a high
  // score doesn't outrank a large one that is nearly as risky.
  const watch = rows.filter(r => r.grade === 'D' || r.grade === 'E' || r.trend === 'WORSE').sort((a, z) => z.atRisk - a.atRisk);

  const topRisk = watch[0] || rows[0];
  const insight = `**${highRisk.length} of ${rows.length} active customers are high/severe risk (D/E), holding ${fmtAmt(highExp)} (${totalExp ? Math.round((highExp / totalExp) * 100) : 0}%) of total exposure.**\n\n` +
    (topRisk ? `- Largest risk-weighted exposure: **${topRisk.cardName}** — score ${topRisk.score} (${topRisk.grade}), ${fmtAmt(topRisk.overdue)} overdue, oldest ${topRisk.maxDaysOverdue}d. Driver: ${topRisk.mainDriver}.\n` : '') +
    (ordersAtRisk.length ? `- ${ordersAtRisk.length} D/E customers still have open sales orders worth ${fmtAmt(ordersAtRisk.reduce((s, r) => s + r.openOrders, 0))} — review before delivery.\n` : '') +
    (worse.length ? `- ${worse.length} customers worsened by 5+ points since the last run.\n` : '') +
    (noLimit.length ? `- ${noLimit.length} customers have **no credit limit** set in SAP; the Limit review tab suggests one from 12-month sales and terms.\n` : '');

  const aiContext = `CREDIT RISK REGISTER as of ${asOf}. Score 0-100 (higher = riskier). Grades: ${GRADES.map(g => `${g.grade}<${g.max}`).join(', ')}.
Active customers ${rows.length}, total exposure ${fmtAmt(totalExp)}, D/E exposure ${fmtAmt(highExp)}, worsened ${worse.length}, without limit ${noLimit.length}.
GRADES: ${byGrade.map(g => `${g.grade}: ${g.customers} cust, exp ${fmtAmt(g.exposure)}`).join('; ')}
TOP RISK (by risk-weighted exposure):
${ctxTable(watch.length ? watch : rows, [['cardName', 'Customer'], ['cardCode', 'Code'], ['score', 'Score'], ['grade', 'Gr'], ['delta', 'Δ'], ['atRisk', 'RiskWeighted'], ['overdue', 'Overdue'], ['maxDaysOverdue', 'MaxDays'], ['avgDaysLate', 'AvgLate'], ['exposure', 'Exposure'], ['creditLimit', 'Limit'], ['openOrders', 'OpenSO'], ['mainDriver', 'Driver'], ['flags', 'Flags']], 25)}`;

  const cols = [
    { key: 'grade', label: 'Grade', fmt: 'badge' }, { key: 'cardName', label: 'Customer', sub: 'cardCode' },
    { key: 'score', label: 'Risk score', fmt: 'score', invert: true }, { key: 'trend', label: 'Trend', fmt: 'badge', sub: 'delta', badge: { WORSE: 'red', BETTER: 'green', STABLE: 'grey', NEW: 'blue' } },
    { key: 'exposure', label: 'Exposure', fmt: 'amt' }, { key: 'atRisk', label: 'Risk-weighted', fmt: 'amt' },
    { key: 'overdue', label: 'Overdue', fmt: 'amt' }, { key: 'maxDaysOverdue', label: 'Oldest (d)', fmt: 'int' }, { key: 'avgDaysLate', label: 'Avg late (d)', fmt: 'int' },
    { key: 'creditLimit', label: 'Limit', fmt: 'amt' }, { key: 'utilisation', label: 'Utilised', fmt: 'pct' },
    { key: 'openOrders', label: 'Open SO', fmt: 'amt' }, { key: 'mainDriver', label: 'Main driver' },
    { key: 'flags', label: 'Flags', wrap: true }, { key: 'recommendation', label: 'Recommendation', wrap: true },
  ];

  return {
    kpis: [
      { label: 'Active customers', value: rows.length, fmt: 'int' },
      { label: 'Total exposure', value: totalExp, fmt: 'amt' },
      { label: 'High/severe (D/E)', value: highRisk.length, fmt: 'int', tone: highRisk.length ? 'bad' : 'good' },
      { label: 'D/E exposure', value: highExp, fmt: 'amt', tone: highExp ? 'bad' : 'good' },
      { label: 'Worsened', value: worse.length, fmt: 'int', tone: worse.length ? 'warn' : 'good', hint: 'Score up 5+ points since the previous run' },
      { label: 'Open SO at D/E', value: ordersAtRisk.reduce((s, r) => s + r.openOrders, 0), fmt: 'amt', tone: ordersAtRisk.length ? 'bad' : 'good' },
      { label: 'No credit limit', value: noLimit.length, fmt: 'int', tone: noLimit.length ? 'warn' : 'good' },
      { label: 'Avg risk score', value: rows.length ? rows.reduce((s, r) => s + r.score, 0) / rows.length : 0, fmt: 'int' },
    ],
    chart: { title: 'Exposure by risk grade', type: 'bar', labels: byGrade.map(g => `${g.grade} · ${g.band}`),
      series: [{ name: 'Exposure', values: byGrade.map(g => g.exposure) }, { name: 'Overdue', values: byGrade.map(g => g.overdue), color: '#BB0000' }] },
    tabs: [
      { key: 'register', label: `Risk register (${rows.length})`, rows, columns: cols },
      { key: 'watch', label: `Watchlist (${watch.length})`, rows: watch, columns: cols },
      { key: 'limits', label: 'Limit review', rows: rows.filter(r => r.suggestedLimit !== r.creditLimit),
        columns: [
          { key: 'grade', label: 'Grade', fmt: 'badge' }, { key: 'cardName', label: 'Customer', sub: 'cardCode' },
          { key: 'sales12m', label: 'Sales 12m', fmt: 'amt' }, { key: 'terms', label: 'Terms' },
          { key: 'exposure', label: 'Exposure', fmt: 'amt' }, { key: 'creditLimit', label: 'Current limit', fmt: 'amt' },
          { key: 'suggestedLimit', label: 'Suggested limit', fmt: 'amt' }, { key: 'limitChange', label: 'Change', fmt: 'amt' },
          { key: 'recommendation', label: 'Recommendation', wrap: true },
        ] },
      { key: 'grades', label: 'Grade summary', rows: byGrade,
        columns: [
          { key: 'grade', label: 'Grade', fmt: 'badge' }, { key: 'band', label: 'Band' }, { key: 'customers', label: 'Customers', fmt: 'int' },
          { key: 'exposure', label: 'Exposure', fmt: 'amt' }, { key: 'overdue', label: 'Overdue', fmt: 'amt' }, { key: 'recommendation', label: 'Policy', wrap: true },
        ] },
    ],
    notes: [
      'Score weights: overdue share 25, age of oldest overdue 20, historical days-late 20, limit utilisation (or exposure ÷ average monthly sales when no limit) 20, open orders while overdue 15.',
      'Exposure = open A/R invoices + open sales-order value + open deliveries. Suggested limit = average monthly sales × (terms months + 1) × grade factor (A 1.5 … E 0), rounded to 1,000.',
      prev.size ? 'Trend compares with the most recent earlier snapshot.' : 'First run for this company — trends will appear from the next run on a later date.',
    ],
    insight, aiContext,
  };
}

export function createCreditRiskAgentRouter(deps) {
  return createInsightRouter(deps, {
    slug: 'creditrisk', title: 'Credit Risk Agent',
    persona: 'You are a credit risk analyst for a B2B company using SAP Business One.',
    aiTask: 'Review this customer credit risk register. Explain the biggest risks and why, which customers need credit holds or limit changes, and where open orders are exposed.',
    run,
  });
}
