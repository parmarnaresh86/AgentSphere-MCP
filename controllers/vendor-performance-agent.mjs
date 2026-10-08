/**
 * Vendor Performance Agent — mounted at /api/vendor-performance-agent
 *
 * Scores each vendor 0-100 (higher = better) over a lookback window on:
 *   OTIF delivery (35)   PO lines received on time & in full — needs GRPOs or
 *                        A/P invoices copied from the PO (BaseType 22)
 *   Price (20)           price index vs other vendors for the same items
 *   Quality (20)         goods returns + A/P credit notes as % of purchases
 *   Shortages (10)       share of due PO lines still open past their date
 *   Lead time (10)       consistency of PO → receipt lead time
 *   Payment terms (5)    longer credit terms score higher
 * Dimensions with no data are dropped and the score re-weighted over the rest,
 * so every vendor's score states which dimensions it is based on.
 */
import { createInsightRouter, ctxTable, isoDate, daysBetween, addDays, num, round, clamp, stddev, fmtAmt } from '../lib/insight-kit.mjs';
import { loadPartners, loadPaymentTerms, termDays, loadPurchasePriceHistory, since } from '../lib/insight-data.mjs';

const WEIGHTS = { otif: 35, price: 20, quality: 20, shortage: 10, leadTime: 10, terms: 5 };
const ON_TIME_TOLERANCE = 2;   // days
const IN_FULL_TOLERANCE = 0.98;

async function loadPoLines(k, from) {
  await k.need('OPOR', ['DocEntry', 'DocNum', 'CardCode', 'CardName', 'DocDate', 'CANCELED']);
  await k.need('POR1', ['DocEntry', 'LineNum', 'ItemCode', 'Dscription', 'Quantity', 'OpenQty', 'Price', 'ShipDate', 'LineStatus', 'LineTotal']);
  const rows = await k.run(`SELECT T0.{DocEntry} AS {DocEntry}, T0.{DocNum} AS {DocNum}, T0.{CardCode} AS {CardCode}, T0.{CardName} AS {CardName},
      T0.{DocDate} AS {DocDate}, T1.{LineNum} AS {LineNum}, T1.{ItemCode} AS {ItemCode}, T1.{Dscription} AS {Dscription},
      T1.{Quantity} AS {Quantity}, T1.{OpenQty} AS {OpenQty}, T1.{Price} AS {Price}, T1.{ShipDate} AS {ShipDate},
      T1.{LineStatus} AS {LineStatus}, T1.{LineTotal} AS {LineTotal}
    FROM @OPOR T0 INNER JOIN @POR1 T1 ON T1.{DocEntry} = T0.{DocEntry}
    WHERE T0.{CANCELED} = 'N' AND T0.{DocDate} >= ${k.lit(from)}`);
  return rows.map(r => ({
    docEntry: r.DocEntry, docNum: r.DocNum, cardCode: r.CardCode, cardName: r.CardName || '', docDate: isoDate(r.DocDate),
    lineNum: r.LineNum, itemCode: r.ItemCode, itemName: r.Dscription || '', qty: num(r.Quantity), openQty: num(r.OpenQty),
    price: num(r.Price), dueDate: isoDate(r.ShipDate) || isoDate(r.DocDate), status: r.LineStatus, lineTotal: num(r.LineTotal),
  }));
}

// Receipts copied from PO lines: GRPO (PDN1) and A/P invoice (PCH1) lines with BaseType 22.
async function loadPoReceipts(k, from) {
  const out = [];
  for (const [head, lines] of [['OPDN', 'PDN1'], ['OPCH', 'PCH1']]) {
    if (!(await k.has(lines, 'BaseType'))) continue;
    await k.need(lines, ['DocEntry', 'BaseType', 'BaseEntry', 'BaseLine', 'Quantity']);
    await k.need(head, ['DocEntry', 'DocDate', 'CANCELED']);
    const rows = await k.run(`SELECT T1.{BaseEntry} AS {BaseEntry}, T1.{BaseLine} AS {BaseLine}, T0.{DocDate} AS {DocDate}, SUM(T1.{Quantity}) AS {Qty}
      FROM @${head} T0 INNER JOIN @${lines} T1 ON T1.{DocEntry} = T0.{DocEntry}
      WHERE T0.{CANCELED} = 'N' AND T1.{BaseType} = 22 AND T0.{DocDate} >= ${k.lit(from)}
      GROUP BY T1.{BaseEntry}, T1.{BaseLine}, T0.{DocDate}`);
    for (const r of rows) out.push({ baseEntry: r.BaseEntry, baseLine: r.BaseLine, date: isoDate(r.DocDate), qty: num(r.Qty) });
  }
  return out;
}

async function sumByVendor(k, table, from) {
  if (!(await k.has(table, 'CardCode'))) return new Map();
  await k.need(table, ['CardCode', 'DocTotal', 'DocDate', 'CANCELED']);
  const rows = await k.run(`SELECT {CardCode}, SUM({DocTotal}) AS {Total}, COUNT(*) AS {Cnt} FROM @${table}
    WHERE {CANCELED} = 'N' AND {DocDate} >= ${k.lit(from)} GROUP BY {CardCode}`);
  return new Map(rows.map(r => [r.CardCode, { total: num(r.Total), count: num(r.Cnt) }]));
}

const GRADES = [
  { grade: 'A', min: 80, rec: 'Preferred — consolidate volume here' },
  { grade: 'B', min: 65, rec: 'Approved — maintain' },
  { grade: 'C', min: 50, rec: 'Improvement plan — agree targets with vendor' },
  { grade: 'D', min: -Infinity, rec: 'At risk — dual-source or replace' },
];
// KPI drill-through (calc blocks → lib/insight-kit.mjs withKpiDetails).
const SRC = {
  ocrd: 'OCRD — vendor master (CardType S): name, payment terms group',
  opor: 'OPOR + POR1 — purchase-order lines in the period: qty, open qty, price, delivery date',
  grpo: 'OPDN + PDN1 / OPCH + PCH1 — goods receipts and A/P invoices copied from PO lines (BaseType 22)',
  opch: 'OPCH — A/P invoices in the period (not cancelled): document total per vendor',
  ret: 'ORPD + ORPC — goods returns and A/P credit notes in the period',
  price: 'OPCH + PCH1 — A/P invoice line prices per item and vendor',
  octg: 'OCTG — vendor payment terms (days)',
};
const gradeOf = s => { const g = GRADES.find(x => s >= x.min); return [g.grade, g.rec]; };
const CONFIDENCE = [{ level: 'HIGH', min: 70 }, { level: 'MEDIUM', min: 40 }, { level: 'LOW', min: -Infinity }];
const DIM_LABEL = { otif: 'OTIF delivery', price: 'Price', quality: 'Quality / returns', shortage: 'Shortages', leadTime: 'Lead-time consistency', terms: 'Payment terms' };

// ── "How is this calculated?" popups (built from the same dims/weights as the score) ──
function explainVendor({ dims, wSum, score, grade, confidence, recommendation, lines, linked, coverage, vp, purchases, retValue, overdueOpen, lts, ltMean, ltCv, tDays }) {
  const otifCount = linked.filter(l => l.otif).length;
  const idx = vp && vp.marketValue > 0 ? (vp.vendorValue / vp.marketValue) * 100 : null;
  const how = {
    otif: ['Rating = % of received PO lines on time and in full', `${otifCount} of ${linked.length} received lines OTIF`],
    price: ['Rating = 70 − (price index − 100) × 3, kept within 0–100', `Price index ${round(idx, 1)} (100 = all-vendor average)`],
    quality: ['Rating = 100 − return % × 10, kept within 0–100',
      `Returns + credit notes ${fmtAmt(retValue)} of ${fmtAmt(purchases)} invoiced (${purchases > 0 ? round((retValue / purchases) * 100, 2) : 0}%)`],
    shortage: ['Rating = 100 − % of due PO lines still open past their date', `${overdueOpen.length} of ${lines.length} due lines overdue`],
    leadTime: ['Rating = 100 − lead-time variation % (std dev ÷ average)',
      `Average lead time ${round(ltMean, 1)} days, variation ${round(ltCv * 100, 1)}% over ${lts.length} receipts`],
    terms: ['Rating = 20 + terms days × 80 ÷ 90, max 100', `${tDays}-day terms`],
  };
  const why = {
    otif: lines.length ? `only ${linked.length} of ${lines.length} due lines have PO-linked receipts (need 3 and 30%)` : 'no PO lines due',
    price: 'no items bought from 2+ vendors', quality: 'no A/P invoices in the period',
    shortage: 'no PO lines due', leadTime: 'fewer than 3 PO-linked receipts',
  };
  const parts = Object.entries(dims).map(([d, v]) => ({
    label: DIM_LABEL[d], max: round((100 * WEIGHTS[d]) / wSum, 1), points: round((v * WEIGHTS[d]) / wSum, 1),
    formula: `${how[d][0]}; points = rating × ${WEIGHTS[d]} ÷ ${wSum}`,
    detail: `${how[d][1]} → rating ${Math.round(v)}`,
  }));
  const dropped = Object.keys(WEIGHTS).filter(d => dims[d] == null);
  const gradeRules = GRADES.map((g, i) => ({
    rule: i === 0 ? `Score ${g.min} or more` : g.min === -Infinity ? `Score below ${GRADES[i - 1].min}` : `Score ${g.min}–${GRADES[i - 1].min - 1}`,
    result: `Grade ${g.grade}`, hit: g.grade === grade,
  }));
  const confRules = CONFIDENCE.map((c, i) => ({
    rule: i === 0 ? `${c.min}% or more of scoring weight measurable` : c.min === -Infinity ? `Below ${CONFIDENCE[i - 1].min}%` : `${c.min}–${CONFIDENCE[i - 1].min - 1}%`,
    result: c.level, hit: c.level === confidence,
  }));
  const low = confidence === 'LOW';
  return {
    score: {
      title: `Vendor score ${score}`, parts,
      note: (dropped.length
        ? `Not scored (no data): ${dropped.map(d => `${DIM_LABEL[d]} — ${why[d]}`).join('; ')}. The remaining weights (${wSum} of 100) are scaled up to 100. `
        : 'All six dimensions scored. ') + 'Higher score = better vendor.',
    },
    grade: { title: `Grade ${grade}`, result: { label: 'Vendor score', value: score }, rules: gradeRules },
    confidence: {
      title: `Confidence ${confidence}`,
      steps: [{ label: 'Weight backed by data', formula: 'Sum of weights of the dimensions that could be scored', value: `${wSum}%`,
        detail: Object.keys(dims).map(d => `${DIM_LABEL[d]} ${WEIGHTS[d]}`).join(', ') }],
      rules: confRules,
    },
    recommendation: {
      title: 'Recommendation', result: { label: `Grade ${grade}, confidence ${confidence}`, value: recommendation },
      rules: [
        { rule: 'Confidence LOW (under 40% of criteria measurable)', result: 'Collect delivery/price data before ranking', hit: low },
        ...GRADES.map(g => ({ rule: `Grade ${g.grade}`, result: g.rec, hit: !low && g.grade === grade })),
      ],
    },
    ...(idx != null ? { priceIndex: {
      title: `Price index ${round(idx, 1)}`,
      steps: [
        { label: 'Paid to this vendor', formula: 'Σ qty × this vendor’s price (items bought from 2+ vendors)', value: round(vp.vendorValue) },
        { label: 'Same qty at market average', formula: 'Σ qty × all-vendor average price', value: round(vp.marketValue) },
      ],
      result: { label: 'Index = paid ÷ market × 100', value: round(idx, 1) },
      note: '100 = market average; below 100 is cheaper than other vendors.',
    } } : {}),
    ...(dims.otif != null ? { otifRate: {
      title: `OTIF ${round(dims.otif, 1)}%`,
      steps: [
        { label: 'PO lines due', value: lines.length },
        { label: 'With PO-linked receipts', value: linked.length, detail: `${round(coverage * 100)}% coverage` },
        { label: 'On time and in full', formula: `First receipt within ${ON_TIME_TOLERANCE} days of due date, ≥ ${IN_FULL_TOLERANCE * 100}% of qty by then`, value: otifCount },
      ],
      result: { label: 'OTIF % = OTIF lines ÷ received lines', value: `${round(dims.otif, 1)}%` },
    } } : {}),
  };
}

function explainPrice({ item, vAvg, avg, best, bestName, qty, nVendors }) {
  return {
    index: {
      title: `Price index ${round((vAvg / avg) * 100, 1)}`,
      steps: [
        { label: 'This vendor’s average price', formula: 'Qty-weighted A/P invoice price', value: round(vAvg, 2), detail: item },
        { label: 'All-vendor average price', formula: `Qty-weighted across ${nVendors} vendors`, value: round(avg, 2) },
      ],
      result: { label: 'Index = vendor ÷ all-vendor × 100', value: round((vAvg / avg) * 100, 1) },
      note: '100 = market average; below 100 is cheaper.',
    },
    savings: {
      title: 'Savings if switched',
      steps: [
        { label: 'This vendor’s average price', value: round(vAvg, 2) },
        { label: 'Cheapest vendor’s price', value: round(best, 2), detail: bestName },
        { label: 'Quantity bought', value: round(qty, 2) },
      ],
      result: { label: 'Savings = (price − cheapest) × qty, never below 0', value: round(Math.max(0, (vAvg - best) * qty)) },
    },
  };
}

async function run(k, p) {
  const asOf = p.asOf;
  const months = clamp(Math.round(num(p.lookbackMonths) || 12), 1, 36);
  const from = since(asOf, months * 30);
  const vendors = await loadPartners(k, 'S');
  const terms = await loadPaymentTerms(k);
  const poLines = await loadPoLines(k, from);
  const receipts = await loadPoReceipts(k, from);
  const invoiced = await sumByVendor(k, 'OPCH', from);
  const returns = await sumByVendor(k, 'ORPD', from);
  const credits = await sumByVendor(k, 'ORPC', from);
  const prices = await loadPurchasePriceHistory(k, from);

  // ── Delivery: match receipts to PO lines ────────────────────────────────
  const recByLine = new Map();
  for (const r of receipts) {
    const key = `${r.baseEntry}:${r.baseLine}`;
    if (!recByLine.has(key)) recByLine.set(key, []);
    recByLine.get(key).push(r);
  }
  const lineResults = [];
  for (const l of poLines) {
    if (l.dueDate > asOf) continue;   // not yet due
    const recs = (recByLine.get(`${l.docEntry}:${l.lineNum}`) || []).sort((a, z) => a.date.localeCompare(z.date));
    const byDue = recs.filter(r => r.date <= addDays(l.dueDate, ON_TIME_TOLERANCE)).reduce((s, r) => s + r.qty, 0);
    const total = recs.reduce((s, r) => s + r.qty, 0);
    // First date the cumulative received qty reached "in full".
    let cum = 0, fullDate = null;
    for (const r of recs) { cum += r.qty; if (!fullDate && cum >= l.qty * IN_FULL_TOLERANCE) fullDate = r.date; }
    lineResults.push({
      ...l, linked: recs.length > 0, received: total,
      onTime: recs.length ? recs[0].date <= addDays(l.dueDate, ON_TIME_TOLERANCE) : null,
      inFull: recs.length ? total >= l.qty * IN_FULL_TOLERANCE : null,
      otif: recs.length ? byDue >= l.qty * IN_FULL_TOLERANCE : null,
      delay: recs.length ? daysBetween(l.dueDate, fullDate || recs[recs.length - 1].date) : null,
      leadTime: recs.length ? daysBetween(l.docDate, recs[0].date) : null,
      overdueOpen: l.status === 'O' && l.openQty > 0,
      daysLate: l.status === 'O' && l.openQty > 0 ? daysBetween(l.dueDate, asOf) : 0,
    });
  }

  // ── Price index: items bought from ≥ 2 vendors ──────────────────────────
  const itemAgg = new Map();
  for (const x of prices) {
    if (!x.itemCode || x.qty <= 0 || x.price <= 0) continue;
    const it = itemAgg.get(x.itemCode) || { qty: 0, value: 0, byVendor: new Map() };
    it.qty += x.qty; it.value += x.price * x.qty;
    const v = it.byVendor.get(x.cardCode) || { qty: 0, value: 0, prices: [] };
    v.qty += x.qty; v.value += x.price * x.qty; v.prices.push(x.price);
    it.byVendor.set(x.cardCode, v);
    itemAgg.set(x.itemCode, it);
  }
  const priceRows = [];
  const vendorPrice = new Map();   // card → { vendorValue, marketValue, cvs[] }
  for (const [item, it] of itemAgg) {
    const avg = it.value / it.qty;
    const vendorAvgs = [...it.byVendor.entries()].map(([c, v]) => [c, v.value / v.qty]);
    const best = vendorAvgs.reduce((m, x) => (x[1] < m[1] ? x : m), vendorAvgs[0]);
    for (const [card, v] of it.byVendor) {
      const vp = vendorPrice.get(card) || { vendorValue: 0, marketValue: 0, cvs: [] };
      const vAvg = v.value / v.qty;
      if (v.prices.length >= 2) { const m = v.prices.reduce((a, b) => a + b, 0) / v.prices.length; vp.cvs.push(m ? stddev(v.prices) / m : 0); }
      if (it.byVendor.size >= 2) {
        vp.vendorValue += v.value; vp.marketValue += avg * v.qty;
        priceRows.push({ itemCode: item, cardCode: card, cardName: vendors.get(card)?.cardName || card, qty: round(v.qty, 2),
          avgPrice: round(vAvg, 2), marketAvg: round(avg, 2), index: round((vAvg / avg) * 100, 1),
          bestVendor: vendors.get(best[0])?.cardName || best[0], bestPrice: round(best[1], 2),
          savings: round(Math.max(0, (vAvg - best[1]) * v.qty)), vendors: it.byVendor.size,
          explain: explainPrice({ item, vAvg, avg, best: best[1], bestName: vendors.get(best[0])?.cardName || best[0], qty: v.qty, nVendors: it.byVendor.size }) });
      }
      vendorPrice.set(card, vp);
    }
  }
  priceRows.sort((a, z) => z.savings - a.savings);

  // ── Vendor scorecard ────────────────────────────────────────────────────
  const cards = new Set([...poLines.map(l => l.cardCode), ...invoiced.keys()]);
  const rows = [];
  for (const card of cards) {
    const bp = vendors.get(card);
    if (!bp) continue;
    const lines = lineResults.filter(l => l.cardCode === card);
    const linked = lines.filter(l => l.linked);
    const purchases = invoiced.get(card)?.total || 0;
    const poValue = poLines.filter(l => l.cardCode === card).reduce((s, l) => s + l.lineTotal, 0);
    const retValue = (returns.get(card)?.total || 0) + (credits.get(card)?.total || 0);
    const vp = vendorPrice.get(card);
    const tDays = termDays(terms, bp.groupNum);
    const overdueOpen = lines.filter(l => l.overdueOpen);
    const lts = linked.map(l => l.leadTime).filter(x => x != null);

    const dims = {};
    const coverage = lines.length ? linked.length / lines.length : 0;
    if (linked.length >= 3 && coverage >= 0.3) dims.otif = (linked.filter(l => l.otif).length / linked.length) * 100;
    if (vp && vp.marketValue > 0) dims.price = clamp(70 - ((vp.vendorValue / vp.marketValue) * 100 - 100) * 3, 0, 100);
    if (purchases > 0) dims.quality = clamp(100 - (retValue / purchases) * 100 * 10, 0, 100);
    if (lines.length) dims.shortage = 100 - (overdueOpen.length / lines.length) * 100;
    const ltMean = lts.length ? lts.reduce((a, b) => a + b, 0) / lts.length : 0;
    const ltCv = ltMean ? stddev(lts) / ltMean : 0;
    if (lts.length >= 3) dims.leadTime = clamp(100 - ltCv * 100, 0, 100);
    dims.terms = clamp(20 + tDays * (80 / 90), 0, 100);

    const wSum = Object.keys(dims).reduce((s, d) => s + WEIGHTS[d], 0);
    const score = Math.round(Object.entries(dims).reduce((s, [d, v]) => s + v * WEIGHTS[d], 0) / wSum);
    let [grade, recommendation] = gradeOf(score);
    // Share of the full scoring weight actually backed by data.
    const confidence = CONFIDENCE.find(c => wSum >= c.min).level;
    if (confidence === 'LOW') recommendation = `Low confidence (${wSum}% of criteria measurable) — collect delivery/price data before ranking`;
    const weakest = Object.entries(dims).filter(([d]) => d !== 'terms').sort((a, z) => a[1] - z[1])[0];
    rows.push({
      cardCode: card, cardName: bp.cardName, grade, score, confidence, recommendation,
      basis: Object.keys(dims).map(d => ({ otif: 'OTIF', price: 'Price', quality: 'Quality', shortage: 'Shortage', leadTime: 'Lead time', terms: 'Terms' }[d])).join(', '),
      weakest: weakest ? { otif: 'OTIF delivery', price: 'Price', quality: 'Quality / returns', shortage: 'Overdue PO lines', leadTime: 'Lead-time consistency' }[weakest[0]] : '',
      purchases: round(purchases), poValue: round(poValue), poLinesDue: lines.length,
      otifRate: dims.otif != null ? round(dims.otif, 1) : null,
      onTimeRate: linked.length ? round((linked.filter(l => l.onTime).length / linked.length) * 100, 1) : null,
      inFullRate: linked.length ? round((linked.filter(l => l.inFull).length / linked.length) * 100, 1) : null,
      avgDelay: linked.length ? round(linked.reduce((s, l) => s + Math.max(0, l.delay || 0), 0) / linked.length, 1) : null,
      avgLeadTime: lts.length ? Math.round(lts.reduce((a, b) => a + b, 0) / lts.length) : null,
      overdueLines: overdueOpen.length, overdueValue: round(overdueOpen.reduce((s, l) => s + l.openQty * l.price, 0)),
      priceIndex: vp && vp.marketValue > 0 ? round((vp.vendorValue / vp.marketValue) * 100, 1) : null,
      priceStability: vp?.cvs.length ? round(100 - (vp.cvs.reduce((a, b) => a + b, 0) / vp.cvs.length) * 100, 1) : null,
      returnRate: purchases > 0 ? round((retValue / purchases) * 100, 2) : null, returnValue: round(retValue),
      termsDays: tDays, terms: terms.get(String(bp.groupNum))?.name || `${tDays}d`,
      receiptCoverage: lines.length ? round(coverage * 100) : null,
      explain: explainVendor({ dims, wSum, score, grade, confidence, recommendation, lines, linked, coverage, vp, purchases, retValue, overdueOpen, lts, ltMean, ltCv, tDays }),
    });
  }
  rows.sort((a, z) => z.purchases + z.poValue - (a.purchases + a.poValue));

  const backorders = lineResults.filter(l => l.overdueOpen).sort((a, z) => z.daysLate - a.daysLate)
    .map(l => ({ docNum: l.docNum, cardCode: l.cardCode, cardName: l.cardName, itemCode: l.itemCode, itemName: l.itemName,
      dueDate: l.dueDate, daysLate: l.daysLate, qty: round(l.qty, 2), openQty: round(l.openQty, 2), openValue: round(l.openQty * l.price) }));
  const linkedAll = lineResults.filter(l => l.linked);
  const otifAvailable = rows.some(r => r.otifRate != null);
  const spend = rows.reduce((s, r) => s + r.purchases, 0);
  const atRisk = rows.filter(r => r.grade === 'D' && r.confidence !== 'LOW');
  const savings = priceRows.reduce((s, r) => s + r.savings, 0);
  const byGrade = ['A', 'B', 'C', 'D'].map(g => ({ grade: g, vendors: rows.filter(r => r.grade === g).length, spend: round(rows.filter(r => r.grade === g).reduce((s, r) => s + r.purchases, 0)) }));

  const insight = `**${rows.length} vendors scored over ${months} months (${fmtAmt(spend)} invoiced); ${atRisk.length} graded D (at risk) with enough data to rely on.**\n\n` +
    (otifAvailable
      ? `- OTIF across ${linkedAll.length} received PO lines: ${round((linkedAll.filter(l => l.otif).length / (linkedAll.length || 1)) * 100, 1)}%.\n`
      : `- **OTIF cannot be measured:** no GRPOs or A/P invoices were copied from purchase orders in this period, so receipts can't be matched to PO due dates. Scores use price, quality, shortages and terms. Receiving against the PO (Copy From) enables delivery scoring.\n`) +
    (rows.some(r => r.confidence === 'LOW') ? `- ${rows.filter(r => r.confidence === 'LOW').length} vendors have low-confidence scores (under 40% of criteria measurable) and are excluded from the at-risk count.
` : '') +
    `- ${backorders.length} PO lines (${fmtAmt(backorders.reduce((s, b) => s + b.openValue, 0))}) are open past their delivery date.\n` +
    (priceRows.length ? `- Buying each multi-sourced item from its cheapest vendor would have saved about **${fmtAmt(savings)}**; biggest gap: ${priceRows[0].itemCode} from ${priceRows[0].cardName} (index ${priceRows[0].index}).\n` : '- No items were bought from more than one vendor, so price comparison is not available.\n') +
    (atRisk[0] ? `- Lowest-scoring significant vendor: **${atRisk[0].cardName}** (${atRisk[0].score}), weakest on ${atRisk[0].weakest}.\n` : '');

  const aiContext = `VENDOR PERFORMANCE over ${months} months to ${asOf}. Score 0-100 (higher = better); weights ${Object.entries(WEIGHTS).map(([d, w]) => `${d} ${w}`).join(', ')}, re-weighted when a dimension has no data.
OTIF measurable: ${otifAvailable ? 'yes' : 'NO (no PO-linked receipts)'}. Vendors ${rows.length}, spend ${fmtAmt(spend)}, overdue PO lines ${backorders.length}, price-switch savings ${fmtAmt(savings)}.
SCORECARD (by spend):
${ctxTable(rows, [['cardName', 'Vendor'], ['grade', 'Gr'], ['score', 'Score'], ['confidence', 'Conf'], ['purchases', 'Spend'], ['otifRate', 'OTIF%'], ['priceIndex', 'PriceIdx'], ['returnRate', 'Return%'], ['overdueLines', 'OverdueLines'], ['termsDays', 'Terms'], ['weakest', 'Weakest'], ['basis', 'ScoredOn']], 25)}
PRICE GAPS:
${ctxTable(priceRows, [['itemCode', 'Item'], ['cardName', 'Vendor'], ['avgPrice', 'Price'], ['bestPrice', 'Best'], ['bestVendor', 'BestVendor'], ['savings', 'Savings']], 12)}
OVERDUE PO LINES:
${ctxTable(backorders, [['docNum', 'PO'], ['cardName', 'Vendor'], ['itemCode', 'Item'], ['daysLate', 'DaysLate'], ['openValue', 'OpenValue']], 12)}`;

  // KPI drill-through figures (derived from the rows above; no extra queries).
  const confCount = lvl => rows.filter(r => r.confidence === lvl).length;
  const scoresSorted = rows.map(r => r.score).sort((a, z) => a - z);
  const spendWAvg = spend ? rows.reduce((s, r) => s + r.score * r.purchases, 0) / spend : 0;
  const otifLines = linkedAll.filter(l => l.otif).length;
  const backorderValue = backorders.reduce((s, b) => s + b.openValue, 0);
  const retTotal = rows.reduce((s, r) => s + r.returnValue, 0);
  const pctOf = (a, b) => (b ? round((a / b) * 100, 1) : 0);
  const sumOf = (list, f) => list.reduce((s, r) => s + (typeof f === 'function' ? f(r) : num(r[f])), 0);
  const topBy = (list, by, n = 10) => [...list].sort((a, z) => num(z[by]) - num(a[by])).slice(0, n);
  const GL = ['A', 'B', 'C', 'D'];
  const COL = {
    vendor: { key: 'cardName', label: 'Vendor', sub: 'cardCode' },
    grade: { key: 'grade', label: 'Grade', fmt: 'badge' },
    score: { key: 'score', label: 'Score', fmt: 'score' },
    conf: { key: 'confidence', label: 'Confidence', fmt: 'badge', badge: { HIGH: 'green', MEDIUM: 'amber', LOW: 'grey' } },
    spend: { key: 'purchases', label: 'Spend', fmt: 'amt' },
    share: { key: 'share', label: '% of spend', fmt: 'pct' },
    weakest: { key: 'weakest', label: 'Weakest area' },
    otif: { key: 'otifRate', label: 'OTIF', fmt: 'pct' },
    overdueLines: { key: 'overdueLines', label: 'Overdue lines', fmt: 'int' },
  };

  // Vendors scored — grade × confidence and dimension coverage.
  const CONF_COLOR = { HIGH: '#16A34A', MEDIUM: '#D97706', LOW: '#9CA3AF' };
  const partOf = (r, d) => r.explain.score.parts.find(p => p.label === DIM_LABEL[d]);
  const dimCover = Object.keys(WEIGHTS).map(d => ({ d, label: DIM_LABEL[d], n: rows.filter(r => partOf(r, d)).length }));
  const leastCovered = dimCover.filter(c => c.d !== 'terms').sort((a, z) => a.n - z.n)[0];
  const lowTop = topBy(rows.filter(r => r.confidence === 'LOW'), 'purchases', 1)[0];
  const rowsWithShare = rows.map(r => ({ ...r, share: pctOf(r.purchases, spend) }));

  // Spend — concentration.
  const spendTop10 = topBy(rows, 'purchases', 10).filter(r => r.purchases > 0);
  const top5Share = pctOf(sumOf(topBy(rows, 'purchases', 5), 'purchases'), spend);
  const abSpend = byGrade[0].spend + byGrade[1].spend, cdSpend = byGrade[2].spend + byGrade[3].spend;
  const cdTop = topBy(rows.filter(r => r.grade === 'C' || r.grade === 'D'), 'purchases', 1)[0];
  const poValueTotal = sumOf(rows, 'poValue');

  // Avg score — average points per component vs its (re-weighted) maximum.
  const compAvg = Object.keys(WEIGHTS).map(d => {
    const ps = rows.map(r => partOf(r, d)).filter(Boolean);
    return { d, label: DIM_LABEL[d], n: ps.length, pts: ps.length ? round(sumOf(ps, 'points') / ps.length, 1) : 0, max: ps.length ? round(sumOf(ps, 'max') / ps.length, 1) : 0 };
  }).filter(c => c.n);
  const weakComp = [...compAvg].filter(c => c.max > 0).sort((a, z) => a.pts / a.max - z.pts / z.max)[0];
  const scoreMedian = scoresSorted.length ? (scoresSorted.length % 2 ? scoresSorted[(scoresSorted.length - 1) / 2]
    : (scoresSorted[scoresSorted.length / 2 - 1] + scoresSorted[scoresSorted.length / 2]) / 2) : 0;
  const lowScoreRows = rows.map(r => ({ ...r, shortfall: 100 - r.score }));
  const lowestVendor = topBy(lowScoreRows, 'shortfall', 1)[0];
  const weakCounts = Object.entries(rows.reduce((m, r) => (r.weakest && (m[r.weakest] = (m[r.weakest] || 0) + 1), m), {})).sort((a, z) => z[1] - a[1]);

  // OTIF — outcome of every due PO line.
  const otifPct = linkedAll.length ? (otifLines / linkedAll.length) * 100 : 0;
  const onTimePct = pctOf(linkedAll.filter(l => l.onTime).length, linkedAll.length);
  const inFullPct = pctOf(linkedAll.filter(l => l.inFull).length, linkedAll.length);
  const otifOutcome = [
    ['OTIF', otifLines, '#16A34A'],
    [`Late (first receipt > due + ${ON_TIME_TOLERANCE}d)`, linkedAll.filter(l => !l.otif && !l.onTime).length, '#DC2626'],
    ['On time but short by due date', linkedAll.filter(l => !l.otif && l.onTime).length, '#D97706'],
    ['No PO-linked receipt', lineResults.length - linkedAll.length, '#9CA3AF'],
  ];
  const otifRows = rows.filter(r => r.otifRate != null).map(r => ({ ...r, otifGap: round(100 - r.otifRate, 1) }));
  const worstOtif = topBy(otifRows, 'otifGap', 1)[0];
  const bestOtif = topBy(otifRows, 'otifRate', 1)[0];
  const avgDelayAll = linkedAll.length ? round(sumOf(linkedAll, l => Math.max(0, l.delay || 0)) / linkedAll.length, 1) : 0;

  // At-risk vendors.
  const atRiskSpend = sumOf(atRisk, 'purchases');
  const atRiskTop = topBy(atRisk, 'purchases', 10);
  const atRiskWeak = Object.entries(atRisk.reduce((m, r) => (r.weakest && (m[r.weakest] = (m[r.weakest] || 0) + 1), m), {})).sort((a, z) => z[1] - a[1]);

  // Overdue PO lines — days-late bands and per-vendor totals.
  const BANDS = [[-Infinity, 7, '0–7 d'], [7, 30, '8–30 d'], [30, 60, '31–60 d'], [60, 90, '61–90 d'], [90, Infinity, '90+ d']];
  const boBands = BANDS.map(([lo, hi, label]) => {
    const l = backorders.filter(b => b.daysLate > lo && b.daysLate <= hi);
    return { label: `${label} (${l.length})`, n: l.length, value: round(sumOf(l, 'openValue')) };
  });
  const boVendor = [...backorders.reduce((m, b) => {
    const v = m.get(b.cardCode) || { cardCode: b.cardCode, cardName: b.cardName, lines: 0, value: 0, oldest: 0 };
    v.lines += 1; v.value += b.openValue; v.oldest = Math.max(v.oldest, b.daysLate);
    return m.set(b.cardCode, v);
  }, new Map()).values()].sort((a, z) => z.value - a.value);
  const bo30Value = round(sumOf(backorders.filter(b => b.daysLate > 30), 'openValue'));

  // Price-switch savings — per vendor.
  const savPairs = priceRows.filter(r => r.savings > 0);
  const savVendor = [...savPairs.reduce((m, r) => {
    const v = m.get(r.cardCode) || { cardCode: r.cardCode, cardName: r.cardName, savings: 0, items: 0 };
    v.savings += r.savings; v.items += 1;
    return m.set(r.cardCode, v);
  }, new Map()).values()].sort((a, z) => z.savings - a.savings);
  const multiSpend = round(sumOf(priceRows, r => r.avgPrice * r.qty));

  // Returns — rate bands and quality rating.
  const RBANDS = [[-Infinity, 1, 'Under 1%'], [1, 2, '1–2%'], [2, 5, '2–5%'], [5, 10, '5–10%'], [10, Infinity, '10%+ (rating 0)']];
  const rateRows = rows.filter(r => r.returnRate != null);
  const retBands = RBANDS.map(([lo, hi, label]) => ({ label, n: rateRows.filter(r => r.returnRate >= (lo === -Infinity ? 0 : lo) && r.returnRate < hi).length }));
  const retRows = rows.filter(r => r.returnValue > 0).map(r => ({ ...r, qualityRating: r.returnRate != null ? Math.round(clamp(100 - r.returnRate * 10, 0, 100)) : null }));
  const retTop = topBy(retRows, 'returnValue', 1)[0];
  const retWorstRate = topBy(retRows.filter(r => r.purchases >= spend * 0.01), 'returnRate', 1)[0];

  return {
    kpis: [
      { label: 'Vendors scored', value: rows.length, fmt: 'int', hint: `Vendors with POs or A/P invoices in the last ${months} months`,
        calc: { formula: `Count of vendors in the vendor master (OCRD CardType = S) with a non-cancelled purchase order or A/P invoice dated on or after ${from} (${months} × 30 days before ${asOf}).`,
          steps: ['Vendor codes are collected from PO lines and A/P invoices in the window; codes not found as vendors in OCRD are dropped.', 'Each vendor is scored on the dimensions that have data; missing ones are dropped and the rest re-weighted to 100.', 'Confidence = share of the 100 scoring weight that could be measured (HIGH ≥ 70%, MEDIUM ≥ 40%, LOW below).'],
          sources: [SRC.ocrd, SRC.opor, SRC.opch], tab: 'scorecard', rows: rowsWithShare, sortBy: 'purchases',
          title: 'Scored vendors by spend — grade, confidence and data basis',
          columns: [COL.vendor, COL.grade, COL.score, COL.conf, COL.spend, { key: 'basis', label: 'Scored on' }],
          stats: [{ label: 'HIGH confidence', value: confCount('HIGH'), fmt: 'int' }, { label: 'MEDIUM confidence', value: confCount('MEDIUM'), fmt: 'int' },
            { label: 'LOW confidence', value: confCount('LOW'), fmt: 'int' }, { label: 'With PO lines due', value: rows.filter(r => r.poLinesDue > 0).length, fmt: 'int' },
            { label: 'Invoice-only (no PO lines due)', value: rows.filter(r => !r.poLinesDue).length, fmt: 'int' },
            { label: 'Scored on OTIF', value: rows.filter(r => r.otifRate != null).length, fmt: 'int' }],
          chart: { title: 'Vendors by grade and confidence', type: 'bar', stacked: true, fmt: 'int', labels: GL.map(g => `Grade ${g}`),
            series: ['HIGH', 'MEDIUM', 'LOW'].map(lvl => ({ name: lvl, color: CONF_COLOR[lvl], values: GL.map(g => rows.filter(r => r.grade === g && r.confidence === lvl).length) })) },
          insight: rows.length
            ? `**${rows.length} vendors scored; ${confCount('HIGH') + confCount('MEDIUM')} (${pctOf(confCount('HIGH') + confCount('MEDIUM'), rows.length)}%) have enough data (MEDIUM/HIGH confidence) to act on.**\n\n` +
              `- Grade mix: ${byGrade.map(g => `${g.grade} ${g.vendors}`).join(', ')}.\n` +
              `- Data coverage: ${dimCover.filter(c => c.d !== 'terms').map(c => `${c.label} ${c.n}`).join(', ')} of ${rows.length} vendors${leastCovered ? `; thinnest is **${leastCovered.label}**` : ''}.\n` +
              (lowTop ? `- Largest LOW-confidence vendor: **${lowTop.cardName}** (${fmtAmt(lowTop.purchases)} spend, scored on ${lowTop.basis}).\n` : '') +
              `- Action: ${confCount('LOW') ? `receive against POs (Copy From) for the ${confCount('LOW')} LOW-confidence vendors so OTIF and lead time can be measured` : 'all vendors have usable data — review grade C/D vendors first'}.`
            : `**No vendors had purchase orders or A/P invoices since ${from}.**`,
        } },
      { label: `Spend (${months}m)`, value: spend, fmt: 'amt', hint: `A/P invoiced value in the last ${months} months`,
        calc: { formula: `Σ A/P invoice document totals (OPCH.DocTotal, not cancelled, dated on or after ${from}) of the scored vendors.`,
          steps: [`Window = ${months} × 30 days before ${asOf}.`, 'DocTotal is the gross invoice total (incl. tax/freight); credit notes and returns are not deducted here — they feed the quality score instead.', 'Invoices of codes not found as vendors in OCRD are excluded.', 'Spend by grade shows how much volume sits with good vs weak vendors.'],
          sources: [SRC.opch], tab: 'scorecard', rows: rowsWithShare, sortBy: 'purchases',
          title: 'Largest vendors by spend',
          columns: [COL.vendor, COL.grade, COL.spend, COL.share, { key: 'poValue', label: 'PO value placed', fmt: 'amt' }, COL.score],
          stats: [{ label: 'Grade A+B spend', value: round(abSpend), fmt: 'amt' }, { label: 'Grade C+D spend', value: round(cdSpend), fmt: 'amt' },
            { label: 'A+B share', value: pctOf(abSpend, spend), fmt: 'pct' }, { label: 'Top-5 vendor share', value: top5Share, fmt: 'pct' },
            { label: 'Vendors with spend', value: rows.filter(r => r.purchases > 0).length, fmt: 'int' }, { label: 'PO value placed', value: round(poValueTotal), fmt: 'amt' }],
          chart: spendTop10.length ? { title: `Top ${spendTop10.length} vendors by spend`, type: 'bar', horizontal: true, fmt: 'amt',
            labels: spendTop10.map(r => `${r.cardName} (${r.grade})`), series: [{ name: 'Spend', values: spendTop10.map(r => r.purchases) }] } : null,
          insight: spend > 0 && spendTop10[0]
            ? `**${fmtAmt(spend)} invoiced in ${months} months; ${pctOf(abSpend, spend)}% sits with grade A/B vendors.**\n\n` +
              `- Largest vendor: **${spendTop10[0].cardName}** (grade ${spendTop10[0].grade}, score ${spendTop10[0].score}) — ${fmtAmt(spendTop10[0].purchases)}, ${pctOf(spendTop10[0].purchases, spend)}% of spend; top 5 hold ${top5Share}%.\n` +
              `- Grade C/D vendors take ${fmtAmt(cdSpend)} (${pctOf(cdSpend, spend)}%)${cdTop && cdTop.purchases > 0 ? `, led by **${cdTop.cardName}** (${cdTop.grade}, ${fmtAmt(cdTop.purchases)})` : ''}.\n` +
              `- Action: ${cdSpend > 0 ? 'shift volume from C/D vendors to A/B alternatives or agree improvement targets' : 'spend is already with A/B vendors — consolidate further for volume discounts'}${top5Share > 70 ? '; high concentration — check single-source dependency' : ''}.`
            : `**No A/P invoices since ${from}, so spend is zero.**`,
        } },
      { label: 'Avg score', value: rows.length ? rows.reduce((s, r) => s + r.score, 0) / rows.length : null, fmt: 'int', hint: '0-100, higher = better vendor',
        calc: { formula: `Σ vendor score ÷ number of vendors (simple average). Vendor score = Σ rating × weight ÷ Σ weights of the dimensions with data, rounded; weights OTIF ${WEIGHTS.otif}, price ${WEIGHTS.price}, quality ${WEIGHTS.quality}, shortages ${WEIGHTS.shortage}, lead time ${WEIGHTS.leadTime}, terms ${WEIGHTS.terms}.`,
          steps: [`OTIF = % of received PO lines with ≥ ${IN_FULL_TOLERANCE * 100}% of qty received within ${ON_TIME_TOLERANCE} days of the due date (only when ≥ 3 due lines and ≥ 30% have PO-linked receipts).`, 'Price = 70 − (price index − 100) × 3, kept within 0–100 (items bought from 2+ vendors only).', 'Quality = 100 − return % × 10 (0–100); shortages = 100 − % of due PO lines still open; lead time = 100 − lead-time variation % (≥ 3 receipts); terms = 20 + days × 80 ÷ 90 (max 100).', 'Grades: A ≥ 80, B ≥ 65, C ≥ 50, D below 50.'],
          sources: [SRC.opor, SRC.grpo, SRC.opch, SRC.ret, SRC.price, SRC.octg], tab: 'scorecard', rows: lowScoreRows, sortBy: 'shortfall',
          title: 'Lowest-scoring vendors and their weakest area',
          columns: [COL.vendor, COL.grade, COL.score, COL.conf, COL.weakest, COL.spend],
          stats: [{ label: 'Spend-weighted avg', value: round(spendWAvg), fmt: 'int' }, { label: 'Median', value: round(scoreMedian), fmt: 'int' },
            { label: 'Lowest', value: scoresSorted[0] ?? 0, fmt: 'int' }, { label: 'Highest', value: scoresSorted[scoresSorted.length - 1] ?? 0, fmt: 'int' },
            { label: 'Grade A vendors', value: byGrade[0].vendors, fmt: 'int' }, { label: 'Grade D vendors', value: byGrade[3].vendors, fmt: 'int' }],
          chart: compAvg.length ? { title: 'Average points per score component vs maximum (vendors scored on it)', type: 'bar', fmt: 'num',
            labels: compAvg.map(c => `${c.label} (${c.n})`),
            series: [{ name: 'Avg points earned', values: compAvg.map(c => c.pts) }, { name: 'Avg max points', values: compAvg.map(c => c.max), color: '#CBD5E1' }] } : null,
          insight: rows.length
            ? `**Average vendor score ${Math.round(sumOf(rows, 'score') / rows.length)} (spend-weighted ${round(spendWAvg)}) — ${spendWAvg >= 65 ? 'most spend is with approved or better vendors' : 'a large share of spend is with vendors below grade B'}.**\n\n` +
              (weakComp ? `- Weakest component: **${weakComp.label}** — vendors earn ${weakComp.pts} of ${weakComp.max} possible points on average (${pctOf(weakComp.pts, weakComp.max)}%).\n` : '') +
              (weakCounts.length ? `- Most common weakest area: ${weakCounts.slice(0, 3).map(([k, v]) => `${k} (${v})`).join(', ')}.\n` : '') +
              (lowestVendor ? `- Lowest: **${lowestVendor.cardName}** scores ${lowestVendor.score} (grade ${lowestVendor.grade}, ${lowestVendor.confidence} confidence), weakest on ${lowestVendor.weakest || 'n/a'}, spend ${fmtAmt(lowestVendor.purchases)}.\n` : '') +
              `- Action: ${weakComp ? `make ${weakComp.label} the focus of vendor reviews — it costs the most points across the base` : 'review grade C/D vendors'}.`
            : '**No vendors to score in this period.**',
        } },
      { label: 'OTIF', value: otifAvailable ? (linkedAll.filter(l => l.otif).length / (linkedAll.length || 1)) * 100 : null, fmt: 'pct', hint: otifAvailable ? 'On time & in full across PO-linked receipts' : 'Not measurable — no receipts copied from POs',
        calc: { formula: `OTIF % = due PO lines with ≥ ${IN_FULL_TOLERANCE * 100}% of ordered qty received within ${ON_TIME_TOLERANCE} days of the line due date ÷ due PO lines with at least one receipt copied from the PO, pooled across all vendors.`,
          steps: [`Due PO lines = lines on non-cancelled POs dated on or after ${from} whose delivery date (ShipDate, else PO date) is on or before ${asOf}.`, `Receipts = goods receipts or A/P invoices dated on or after ${from} created with Copy From the PO (BaseType 22); others cannot be matched.`, `On time (shown separately) = first receipt within ${ON_TIME_TOLERANCE} days of the due date; in full = total received ≥ ${IN_FULL_TOLERANCE * 100}% of ordered qty at any date.`, otifAvailable ? 'The tile pools every received line; a vendor’s own OTIF is scored only when ≥ 3 due lines (and ≥ 30%) have linked receipts.' : 'No vendor reached 3 due lines with ≥ 30% PO-linked receipts, so OTIF is not shown.'],
          sources: [SRC.opor, SRC.grpo], tab: 'delivery', rows: otifRows, sortBy: 'otifGap',
          title: 'Vendors by OTIF — worst first',
          columns: [COL.vendor, { key: 'poLinesDue', label: 'PO lines due', fmt: 'int' }, { key: 'onTimeRate', label: 'On time', fmt: 'pct' },
            { key: 'inFullRate', label: 'In full', fmt: 'pct' }, COL.otif, { key: 'avgDelay', label: 'Avg delay (d)', fmt: 'num' }],
          stats: [{ label: 'Received PO lines', value: linkedAll.length, fmt: 'int' }, { label: 'OTIF lines', value: otifLines, fmt: 'int' },
            { label: 'On time', value: onTimePct, fmt: 'pct' }, { label: 'In full', value: inFullPct, fmt: 'pct' },
            { label: 'Avg delay to full receipt (d)', value: avgDelayAll, fmt: 'num' },
            { label: 'Due lines without linked receipt', value: lineResults.length - linkedAll.length, fmt: 'int' }],
          chart: lineResults.length ? { title: 'Due PO lines by delivery outcome', type: 'bar', fmt: 'int', labels: otifOutcome.map(o => o[0]),
            series: [{ name: 'PO lines', values: otifOutcome.map(o => o[1]) }] } : null,
          insight: otifAvailable
            ? `**OTIF ${round(otifPct, 1)}% across ${linkedAll.length} received PO lines — ${otifPct >= 90 ? 'reliable delivery' : otifPct >= 75 ? 'acceptable but with regular slips' : 'delivery reliability is a real problem'}.**\n\n` +
              `- On time ${onTimePct}% vs in full ${inFullPct}%: the main loss is ${onTimePct <= inFullPct ? '**lateness**' : '**short deliveries**'}; average delay to full receipt ${avgDelayAll} days.\n` +
              (worstOtif ? `- Worst: **${worstOtif.cardName}** — OTIF ${worstOtif.otifRate}% on ${worstOtif.poLinesDue} due lines (avg delay ${worstOtif.avgDelay ?? 0} d, ${worstOtif.overdueLines} still overdue).\n` : '') +
              (bestOtif && bestOtif !== worstOtif ? `- Best: **${bestOtif.cardName}** at ${bestOtif.otifRate}%.\n` : '') +
              `- Action: escalate vendors below 75% OTIF with a delivery-performance review${lineResults.length - linkedAll.length ? `; ${lineResults.length - linkedAll.length} due lines have no PO-linked receipt — receive with Copy From to measure them` : ''}.`
            : `**OTIF cannot be measured: only ${linkedAll.length} of ${lineResults.length} due PO lines have receipts copied from the PO.**\n\n- Goods receipts / A/P invoices entered without Copy From cannot be matched to PO due dates.\n- Action: receive against the purchase order (Copy From) so delivery reliability and lead time can be scored.`,
        } },
      { label: 'At-risk vendors (D)', value: atRisk.length, fmt: 'int', tone: atRisk.length ? 'bad' : 'good', hint: 'Score below 50 with enough data to rely on',
        calc: { formula: 'Count of vendors with grade D (score below 50) and confidence MEDIUM or HIGH.',
          steps: ['LOW-confidence vendors (under 40% of the scoring weight measurable) are excluded to avoid acting on thin data.', 'Recommendation for D: dual-source or replace.'],
          sources: [SRC.opor, SRC.grpo, SRC.opch, SRC.ret], tab: 'scorecard', filter: r => r.grade === 'D' && r.confidence !== 'LOW', sortBy: 'purchases',
          title: 'At-risk (grade D) vendors by spend',
          columns: [COL.vendor, COL.score, COL.weakest, COL.spend, COL.otif, COL.overdueLines],
          stats: [{ label: 'Their spend', value: round(atRiskSpend), fmt: 'amt' }, { label: '% of spend', value: pctOf(atRiskSpend, spend), fmt: 'pct' },
            { label: 'All grade D (incl. LOW)', value: rows.filter(r => r.grade === 'D').length, fmt: 'int' }, { label: 'Their overdue PO lines', value: sumOf(atRisk, 'overdueLines'), fmt: 'int' },
            { label: 'Their overdue value', value: round(sumOf(atRisk, 'overdueValue')), fmt: 'amt' },
            { label: 'Avg score (at-risk)', value: atRisk.length ? round(sumOf(atRisk, 'score') / atRisk.length) : 0, fmt: 'int' }],
          chart: atRiskTop.length
            ? { title: `Top ${atRiskTop.length} at-risk vendors — spend vs overdue PO value`, type: 'bar', horizontal: true, fmt: 'amt', labels: atRiskTop.map(r => `${r.cardName} (${r.score})`),
                series: [{ name: 'Spend', values: atRiskTop.map(r => r.purchases) }, { name: 'Overdue PO value', values: atRiskTop.map(r => r.overdueValue), color: '#DC2626' }] }
            : { title: 'Vendors by grade', type: 'bar', fmt: 'int', labels: GL.map(g => `Grade ${g}`), series: [{ name: 'Vendors', values: byGrade.map(g => g.vendors) }] },
          insight: atRisk.length
            ? `**${atRisk.length} vendor${atRisk.length === 1 ? ' is' : 's are'} at risk (grade D, MEDIUM/HIGH confidence), holding ${fmtAmt(atRiskSpend)} (${pctOf(atRiskSpend, spend)}%) of spend.**\n\n` +
              `- Largest: **${atRiskTop[0].cardName}** — score ${atRiskTop[0].score}, ${fmtAmt(atRiskTop[0].purchases)} spend, weakest on ${atRiskTop[0].weakest || 'n/a'}${atRiskTop[0].overdueLines ? `, ${atRiskTop[0].overdueLines} overdue PO lines (${fmtAmt(atRiskTop[0].overdueValue)})` : ''}.\n` +
              (atRiskWeak.length ? `- Weakest areas: ${atRiskWeak.map(([k, v]) => `${k} (${v})`).join(', ')}.\n` : '') +
              `- Action: qualify a second source for each and move new POs away${atRiskSpend > spend * 0.1 ? ' — more than 10% of spend is exposed, so prioritise by spend' : ''}.`
            : `**No vendor is at risk with reliable data.**\n\n- ${rows.filter(r => r.grade === 'D').length} grade-D vendors have LOW confidence and are excluded until more delivery/price data exists.\n- Grade C vendors to watch: ${byGrade[2].vendors}.`,
        } },
      { label: 'Overdue PO lines', value: backorders.length, fmt: 'int', tone: backorders.length ? 'warn' : 'good', hint: 'Open PO lines past their delivery date',
        calc: { formula: `Count of open PO lines (LineStatus O, open qty > 0) on non-cancelled purchase orders dated on or after ${from} whose delivery date (ShipDate, else PO date) is on or before the analysis date ${asOf}.`,
          steps: [`Only POs inside the ${months}-month look-back window are checked; older open POs are not counted.`, `Days late = ${asOf} − delivery date (0 = due on the analysis date).`, 'Open value = open qty × PO line price (before tax).', 'Feeds the shortages score: 100 − % of a vendor’s due lines still open.'],
          sources: [SRC.opor], tab: 'backorders', sortBy: 'openValue',
          title: 'Overdue PO lines by open value',
          columns: [COL.vendor, { key: 'docNum', label: 'PO #' }, { key: 'itemCode', label: 'Item', sub: 'itemName' },
            { key: 'dueDate', label: 'Due', fmt: 'date' }, { key: 'daysLate', label: 'Days late', fmt: 'int' }, { key: 'openValue', label: 'Open value', fmt: 'amt' }],
          stats: [{ label: 'Open value', value: round(backorderValue), fmt: 'amt' }, { label: 'Vendors affected', value: boVendor.length, fmt: 'int' },
            { label: 'Oldest (days late)', value: backorders[0]?.daysLate || 0, fmt: 'int' }, { label: 'Over 30 days late', value: backorders.filter(b => b.daysLate > 30).length, fmt: 'int' },
            { label: 'Value over 30 days late', value: bo30Value, fmt: 'amt' },
            { label: 'Top vendor share of value', value: pctOf(boVendor[0]?.value || 0, backorderValue), fmt: 'pct' }],
          chart: backorders.length ? { title: 'Overdue open value by days late (line count)', type: 'bar', fmt: 'amt', labels: boBands.map(b => b.label),
            series: [{ name: 'Open value', values: boBands.map(b => b.value), color: '#D97706' }] } : null,
          insight: backorders.length
            ? `**${backorders.length} PO lines worth ${fmtAmt(backorderValue)} are open past their delivery date at ${boVendor.length} vendor${boVendor.length === 1 ? '' : 's'}.**\n\n` +
              `- Largest: **${boVendor[0].cardName}** — ${boVendor[0].lines} lines, ${fmtAmt(boVendor[0].value)} (${pctOf(boVendor[0].value, backorderValue)}%), oldest ${boVendor[0].oldest} days late.\n` +
              `- Oldest line: PO ${backorders[0].docNum} / ${backorders[0].itemCode} from ${backorders[0].cardName}, ${backorders[0].daysLate} days late (${fmtAmt(backorders[0].openValue)} open).\n` +
              `- ${backorders.filter(b => b.daysLate > 30).length} lines (${fmtAmt(bo30Value)}) are over 30 days late.\n` +
              '- Action: expedite the largest vendors; close or re-date lines no longer needed — stale open lines also depress the vendor’s shortages score.'
            : `**No PO lines from the look-back window are open past their delivery date (as of ${asOf}).**`,
        } },
      { label: 'Price-switch savings', value: savings, fmt: 'amt', tone: 'good', hint: 'Saving if each multi-sourced item had been bought at the cheapest vendor’s price',
        calc: { formula: 'Σ over items bought from 2+ vendors of (vendor’s average price − cheapest vendor’s average price) × qty bought, never below 0.',
          steps: [`Prices are quantity-weighted A/P invoice line prices (non-cancelled invoices dated on or after ${from}; lines with qty or price ≤ 0 ignored).`, 'Cheapest vendor = vendor with the lowest quantity-weighted average price for the item.', 'Indicative only: quality, lead time and minimum order quantities may justify a higher price.'],
          sources: [SRC.price], tab: 'price', filter: r => r.savings > 0, sortBy: 'savings',
          title: 'Item-vendor pairs with the biggest saving',
          columns: [COL.vendor, { key: 'itemCode', label: 'Item' }, { key: 'avgPrice', label: 'Vendor avg', fmt: 'price' },
            { key: 'bestPrice', label: 'Best price', fmt: 'price' }, { key: 'bestVendor', label: 'Cheapest vendor' }, { key: 'savings', label: 'Savings if switched', fmt: 'amt' }],
          stats: [{ label: 'Multi-sourced items', value: new Set(priceRows.map(r => r.itemCode)).size, fmt: 'int' }, { label: 'Item-vendor pairs with savings', value: savPairs.length, fmt: 'int' },
            { label: 'Vendors priced above average', value: rows.filter(r => r.priceIndex != null && r.priceIndex > 100).length, fmt: 'int' },
            { label: 'Spend on multi-sourced items', value: multiSpend, fmt: 'amt' }, { label: 'Savings % of that spend', value: pctOf(savings, multiSpend), fmt: 'pct' },
            { label: 'Vendors with savings', value: savVendor.length, fmt: 'int' }],
          chart: savVendor.length ? { title: `Savings if switched — top ${Math.min(10, savVendor.length)} vendors`, type: 'bar', horizontal: true, fmt: 'amt',
            labels: savVendor.slice(0, 10).map(v => `${v.cardName} (${v.items} item${v.items === 1 ? '' : 's'})`), series: [{ name: 'Savings', values: savVendor.slice(0, 10).map(v => round(v.savings)) }] } : null,
          insight: savPairs.length
            ? `**About ${fmtAmt(savings)} (${pctOf(savings, multiSpend)}% of multi-sourced spend) could have been saved by buying each item at the cheapest vendor’s price.**\n\n` +
              `- Biggest gap: **${savPairs[0].itemCode}** from **${savPairs[0].cardName}** at ${savPairs[0].avgPrice} vs ${savPairs[0].bestPrice} from ${savPairs[0].bestVendor} (index ${savPairs[0].index}) — ${fmtAmt(savPairs[0].savings)}.\n` +
              `- Vendor with most to recover: **${savVendor[0].cardName}** — ${fmtAmt(savVendor[0].savings)} over ${savVendor[0].items} item${savVendor[0].items === 1 ? '' : 's'}.\n` +
              '- Action: renegotiate with these vendors using the cheapest price as the benchmark, or shift volume after checking quality and lead time.'
            : `**No savings found: ${priceRows.length ? 'every multi-sourced item is already bought at the cheapest vendor’s price' : 'no item was bought from more than one vendor in the period'}.**`,
        } },
      { label: 'Returns & credit notes', value: rows.reduce((s, r) => s + r.returnValue, 0), fmt: 'amt', hint: 'Goods returns + A/P credit notes in the period',
        calc: { formula: `Σ goods-return (ORPD) and A/P credit-note (ORPC) document totals, not cancelled, dated on or after ${from}, for the scored vendors.`,
          steps: [`Window = ${months} × 30 days before ${asOf}; returns of vendors with no PO or A/P invoice in the window are not included.`, 'Return rate per vendor = returns + credit notes ÷ A/P invoiced; quality rating = 100 − rate × 10, kept within 0–100 (10%+ → 0).', 'Credit notes can include price corrections, so treat this as an upper bound for quality issues.'],
          sources: [SRC.ret, SRC.opch], tab: 'quality', rows: retRows, sortBy: 'returnValue',
          title: 'Vendors by returns + credit notes',
          columns: [COL.vendor, { key: 'purchases', label: 'Invoiced', fmt: 'amt' }, { key: 'returnValue', label: 'Returns + credit notes', fmt: 'amt' },
            { key: 'returnRate', label: 'Rate', fmt: 'pct' }, { key: 'qualityRating', label: 'Quality rating', fmt: 'int' }, COL.grade],
          stats: [{ label: '% of spend', value: pctOf(retTotal, spend), fmt: 'pct' }, { label: 'Vendors with returns', value: retRows.length, fmt: 'int' },
            { label: 'Return rate above 5%', value: rows.filter(r => (r.returnRate ?? 0) > 5).length, fmt: 'int' },
            { label: 'Rate 10%+ (quality rating 0)', value: rows.filter(r => (r.returnRate ?? 0) >= 10).length, fmt: 'int' },
            { label: 'Largest vendor total', value: retTop?.returnValue || 0, fmt: 'amt' }],
          chart: rateRows.length ? { title: 'Vendors by return rate band', type: 'bar', fmt: 'int', labels: retBands.map(b => b.label),
            series: [{ name: 'Vendors', values: retBands.map(b => b.n), color: '#DC2626' }] } : null,
          insight: retRows.length
            ? `**${fmtAmt(retTotal)} returned or credited — ${pctOf(retTotal, spend)}% of spend across ${retRows.length} vendor${retRows.length === 1 ? '' : 's'}.**\n\n` +
              `- Largest: **${retTop.cardName}** — ${fmtAmt(retTop.returnValue)}${retTop.returnRate != null ? ` (${retTop.returnRate}% of ${fmtAmt(retTop.purchases)} invoiced, quality rating ${retTop.qualityRating})` : ' (no A/P invoices in the period)'}.\n` +
              (retWorstRate && retWorstRate !== retTop ? `- Highest rate among vendors with ≥ 1% of spend: **${retWorstRate.cardName}** at ${retWorstRate.returnRate}% (${fmtAmt(retWorstRate.returnValue)}).\n` : '') +
              `- ${rows.filter(r => (r.returnRate ?? 0) > 5).length} vendors return more than 5% of what they invoice.\n` +
              '- Action: check whether credit notes are quality returns or price corrections, then raise corrective actions with the high-rate vendors.'
            : `**No goods returns or A/P credit notes since ${from}.**`,
        } },
    ],
    chart: { title: 'Spend by vendor grade', type: 'bar', labels: byGrade.map(g => `Grade ${g.grade} (${g.vendors})`), series: [{ name: 'Spend', values: byGrade.map(g => g.spend) }],
      desc: 'Invoiced spend per vendor grade (vendor count in brackets); ideally most spend sits with A and B vendors.' },
    tabs: [
      { key: 'scorecard', label: `Scorecard (${rows.length})`, rows,
        desc: 'All vendors by spend with their score, grade and weakest area; use it to pick preferred vendors and those needing an improvement plan.',
        columns: [{ key: 'grade', label: 'Grade', fmt: 'badge', hint: 'A ≥ 80 preferred, B ≥ 65 approved, C ≥ 50 improvement plan, D below 50 at risk' },
          { key: 'cardName', label: 'Vendor', sub: 'cardCode', hint: 'Supplier name and SAP business partner code' },
          { key: 'score', label: 'Score', fmt: 'score', hint: `0-100, higher = better: weighted ratings for OTIF ${WEIGHTS.otif}, price ${WEIGHTS.price}, quality ${WEIGHTS.quality}, shortages ${WEIGHTS.shortage}, lead time ${WEIGHTS.leadTime}, terms ${WEIGHTS.terms}` },
          { key: 'confidence', label: 'Confidence', fmt: 'badge', badge: { HIGH: 'green', MEDIUM: 'amber', LOW: 'grey' }, hint: 'Share of the scoring weight backed by data: HIGH ≥ 70%, MEDIUM ≥ 40%, LOW below' },
          { key: 'purchases', label: 'Spend', fmt: 'amt', hint: `A/P invoiced value in the last ${months} months` },
          { key: 'otifRate', label: 'OTIF', fmt: 'pct', hint: 'PO lines received on time and in full ÷ PO lines with a linked receipt' },
          { key: 'priceIndex', label: 'Price index', fmt: 'num', hint: '100 = market average; lower is cheaper' },
          { key: 'returnRate', label: 'Returns', fmt: 'pct', hint: 'Goods returns + A/P credit notes ÷ A/P invoiced' },
          { key: 'overdueLines', label: 'Overdue lines', fmt: 'int', hint: 'Open PO lines past their delivery date' },
          { key: 'terms', label: 'Terms', hint: 'Payment terms of the vendor in SAP' },
          { key: 'weakest', label: 'Weakest area', hint: 'Lowest-rated scoring dimension (excluding terms)' },
          { key: 'basis', label: 'Scored on', wrap: true, hint: 'Dimensions that had data and were used for the score' },
          { key: 'recommendation', label: 'Recommendation', wrap: true, hint: 'Sourcing action for this grade (or collect data first when confidence is LOW)' }] },
      { key: 'delivery', label: 'Delivery (OTIF)', rows: rows.filter(r => r.poLinesDue > 0).sort((a, z) => (a.otifRate ?? 999) - (z.otifRate ?? 999)),
        desc: 'Delivery reliability per vendor, worst OTIF first; escalate vendors with low OTIF or many overdue lines.',
        columns: [{ key: 'cardName', label: 'Vendor', sub: 'cardCode', hint: 'Supplier name and SAP business partner code' },
          { key: 'poLinesDue', label: 'PO lines due', fmt: 'int', hint: 'PO lines in the period whose delivery date has passed' },
          { key: 'receiptCoverage', label: 'Linked receipts', fmt: 'pct', hint: 'Due PO lines with a receipt copied from the PO ÷ due PO lines' },
          { key: 'onTimeRate', label: 'On time', fmt: 'pct', hint: `Received lines whose first receipt came within ${ON_TIME_TOLERANCE} days of the due date` },
          { key: 'inFullRate', label: 'In full', fmt: 'pct', hint: `Received lines with ≥ ${IN_FULL_TOLERANCE * 100}% of ordered qty received` },
          { key: 'otifRate', label: 'OTIF', fmt: 'pct', strong: true, hint: 'Lines both on time and in full ÷ received lines' },
          { key: 'avgDelay', label: 'Avg delay (d)', fmt: 'num', hint: 'Average days between due date and full receipt (early = 0)' },
          { key: 'avgLeadTime', label: 'Avg lead (d)', fmt: 'int', hint: 'Average days from PO date to first receipt' },
          { key: 'overdueLines', label: 'Overdue lines', fmt: 'int', hint: 'Open PO lines past their delivery date' },
          { key: 'overdueValue', label: 'Overdue value', fmt: 'amt', hint: 'Open qty × PO price of the overdue lines' }] },
      { key: 'price', label: `Price comparison (${priceRows.length})`, rows: priceRows,
        desc: 'Items bought from 2+ vendors, biggest saving first; use it to renegotiate or shift volume to the cheaper vendor.',
        columns: [{ key: 'itemCode', label: 'Item', hint: 'SAP item code' },
          { key: 'cardName', label: 'Vendor', sub: 'cardCode', hint: 'Supplier name and SAP business partner code' },
          { key: 'qty', label: 'Qty bought', fmt: 'num', hint: 'Quantity invoiced by this vendor in the period' },
          { key: 'avgPrice', label: 'Vendor avg', fmt: 'price', hint: 'This vendor’s quantity-weighted average invoice price' },
          { key: 'marketAvg', label: 'All-vendor avg', fmt: 'price', hint: 'Quantity-weighted average price across all vendors of this item' },
          { key: 'index', label: 'Index', fmt: 'num', hint: 'Vendor avg ÷ all-vendor avg × 100; below 100 = cheaper' },
          { key: 'bestVendor', label: 'Cheapest vendor', hint: 'Vendor with the lowest average price for this item' },
          { key: 'bestPrice', label: 'Best price', fmt: 'price', hint: 'Cheapest vendor’s average price' },
          { key: 'savings', label: 'Savings if switched', fmt: 'amt', strong: true, hint: '(Vendor avg − best price) × qty bought, never below 0' }] },
      { key: 'backorders', label: `Overdue PO lines (${backorders.length})`, rows: backorders,
        desc: 'Purchase-order lines still open after their delivery date, most late first; chase these vendors.',
        columns: [{ key: 'docNum', label: 'PO #', hint: 'SAP document number of the purchase order' },
          { key: 'cardName', label: 'Vendor', sub: 'cardCode', hint: 'Supplier name and SAP business partner code' },
          { key: 'itemCode', label: 'Item', sub: 'itemName', hint: 'SAP item code and description' },
          { key: 'dueDate', label: 'Due', fmt: 'date', hint: 'Delivery date on the PO line' },
          { key: 'daysLate', label: 'Days late', fmt: 'int', hint: 'Days since the delivery date' },
          { key: 'qty', label: 'Ordered', fmt: 'num', hint: 'Quantity ordered on the PO line' },
          { key: 'openQty', label: 'Open', fmt: 'num', hint: 'Quantity not yet received' },
          { key: 'openValue', label: 'Open value', fmt: 'amt', hint: 'Open qty × PO price' }] },
      { key: 'quality', label: 'Quality & returns', rows: rows.filter(r => r.purchases > 0).sort((a, z) => (z.returnRate ?? 0) - (a.returnRate ?? 0)),
        desc: 'Vendors by return rate, highest first; investigate vendors with high returns or unstable prices.',
        columns: [{ key: 'cardName', label: 'Vendor', sub: 'cardCode', hint: 'Supplier name and SAP business partner code' },
          { key: 'purchases', label: 'Invoiced', fmt: 'amt', hint: `A/P invoiced value in the last ${months} months` },
          { key: 'returnValue', label: 'Returns + credit notes', fmt: 'amt', hint: 'Goods returns + A/P credit notes in the period' },
          { key: 'returnRate', label: 'Rate', fmt: 'pct', strong: true, hint: 'Returns + credit notes ÷ invoiced' },
          { key: 'priceStability', label: 'Price stability', fmt: 'pct', hint: '100 − average price variation % per item; higher = steadier prices' }] },
    ],
    notes: [
      `On time = first receipt within ${ON_TIME_TOLERANCE} days of the PO line date; in full = ≥ ${IN_FULL_TOLERANCE * 100}% of ordered qty. OTIF is scored only when at least 3 due lines (30%) have PO-linked receipts.`,
      'Quality uses goods returns (ORPD) plus A/P credit notes (ORPC) as a share of A/P invoiced value — credit notes can include price corrections, so treat it as an upper bound.',
      'Price index compares a vendor\'s quantity-weighted A/P invoice prices with the all-vendor average for the same items (only items bought from 2+ vendors).',
      otifAvailable ? '' : '⚠ No receipts on this company were copied from purchase orders, so OTIF and lead time are not scored.',
    ].filter(Boolean),
    insight, aiContext,
  };
}

export function createVendorPerformanceAgentRouter(deps) {
  return createInsightRouter(deps, {
    slug: 'vendorperf', title: 'Vendor Performance Agent',
    defaults: { lookbackMonths: 12 },
    persona: 'You are a strategic sourcing manager evaluating suppliers from SAP Business One purchasing data.',
    aiTask: 'Review this vendor scorecard. Identify the best and worst suppliers and why, where to consolidate or dual-source, price savings to pursue, and delivery issues to escalate.',
    run,
  });
}
