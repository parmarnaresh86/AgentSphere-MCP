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

const gradeOf = s => (s >= 80 ? ['A', 'Preferred — consolidate volume here'] : s >= 65 ? ['B', 'Approved — maintain'] : s >= 50 ? ['C', 'Improvement plan — agree targets with vendor'] : ['D', 'At risk — dual-source or replace']);

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
          savings: round(Math.max(0, (vAvg - best[1]) * v.qty)), vendors: it.byVendor.size });
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
    if (lts.length >= 3) { const m = lts.reduce((a, b) => a + b, 0) / lts.length; dims.leadTime = clamp(100 - (m ? stddev(lts) / m : 0) * 100, 0, 100); }
    dims.terms = clamp(20 + tDays * (80 / 90), 0, 100);

    const wSum = Object.keys(dims).reduce((s, d) => s + WEIGHTS[d], 0);
    const score = Math.round(Object.entries(dims).reduce((s, [d, v]) => s + v * WEIGHTS[d], 0) / wSum);
    let [grade, recommendation] = gradeOf(score);
    // Share of the full scoring weight actually backed by data.
    const confidence = wSum >= 70 ? 'HIGH' : wSum >= 40 ? 'MEDIUM' : 'LOW';
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

  return {
    kpis: [
      { label: 'Vendors scored', value: rows.length, fmt: 'int' },
      { label: `Spend (${months}m)`, value: spend, fmt: 'amt' },
      { label: 'Avg score', value: rows.length ? rows.reduce((s, r) => s + r.score, 0) / rows.length : null, fmt: 'int' },
      { label: 'OTIF', value: otifAvailable ? (linkedAll.filter(l => l.otif).length / (linkedAll.length || 1)) * 100 : null, fmt: 'pct', hint: otifAvailable ? 'On time & in full across PO-linked receipts' : 'Not measurable — no receipts copied from POs' },
      { label: 'At-risk vendors (D)', value: atRisk.length, fmt: 'int', tone: atRisk.length ? 'bad' : 'good' },
      { label: 'Overdue PO lines', value: backorders.length, fmt: 'int', tone: backorders.length ? 'warn' : 'good' },
      { label: 'Price-switch savings', value: savings, fmt: 'amt', tone: 'good' },
      { label: 'Returns & credit notes', value: rows.reduce((s, r) => s + r.returnValue, 0), fmt: 'amt' },
    ],
    chart: { title: 'Spend by vendor grade', type: 'bar', labels: byGrade.map(g => `Grade ${g.grade} (${g.vendors})`), series: [{ name: 'Spend', values: byGrade.map(g => g.spend) }] },
    tabs: [
      { key: 'scorecard', label: `Scorecard (${rows.length})`, rows,
        columns: [{ key: 'grade', label: 'Grade', fmt: 'badge' }, { key: 'cardName', label: 'Vendor', sub: 'cardCode' },
          { key: 'score', label: 'Score', fmt: 'score' }, { key: 'confidence', label: 'Confidence', fmt: 'badge', badge: { HIGH: 'green', MEDIUM: 'amber', LOW: 'grey' } }, { key: 'purchases', label: 'Spend', fmt: 'amt' },
          { key: 'otifRate', label: 'OTIF', fmt: 'pct' }, { key: 'priceIndex', label: 'Price index', fmt: 'num', hint: '100 = market average; lower is cheaper' },
          { key: 'returnRate', label: 'Returns', fmt: 'pct' }, { key: 'overdueLines', label: 'Overdue lines', fmt: 'int' },
          { key: 'terms', label: 'Terms' }, { key: 'weakest', label: 'Weakest area' }, { key: 'basis', label: 'Scored on', wrap: true },
          { key: 'recommendation', label: 'Recommendation', wrap: true }] },
      { key: 'delivery', label: 'Delivery (OTIF)', rows: rows.filter(r => r.poLinesDue > 0).sort((a, z) => (a.otifRate ?? 999) - (z.otifRate ?? 999)),
        columns: [{ key: 'cardName', label: 'Vendor', sub: 'cardCode' }, { key: 'poLinesDue', label: 'PO lines due', fmt: 'int' },
          { key: 'receiptCoverage', label: 'Linked receipts', fmt: 'pct' }, { key: 'onTimeRate', label: 'On time', fmt: 'pct' },
          { key: 'inFullRate', label: 'In full', fmt: 'pct' }, { key: 'otifRate', label: 'OTIF', fmt: 'pct', strong: true },
          { key: 'avgDelay', label: 'Avg delay (d)', fmt: 'num' }, { key: 'avgLeadTime', label: 'Avg lead (d)', fmt: 'int' },
          { key: 'overdueLines', label: 'Overdue lines', fmt: 'int' }, { key: 'overdueValue', label: 'Overdue value', fmt: 'amt' }] },
      { key: 'price', label: `Price comparison (${priceRows.length})`, rows: priceRows,
        columns: [{ key: 'itemCode', label: 'Item' }, { key: 'cardName', label: 'Vendor', sub: 'cardCode' }, { key: 'qty', label: 'Qty bought', fmt: 'num' },
          { key: 'avgPrice', label: 'Vendor avg', fmt: 'price' }, { key: 'marketAvg', label: 'All-vendor avg', fmt: 'price' },
          { key: 'index', label: 'Index', fmt: 'num' }, { key: 'bestVendor', label: 'Cheapest vendor' }, { key: 'bestPrice', label: 'Best price', fmt: 'price' },
          { key: 'savings', label: 'Savings if switched', fmt: 'amt', strong: true }] },
      { key: 'backorders', label: `Overdue PO lines (${backorders.length})`, rows: backorders,
        columns: [{ key: 'docNum', label: 'PO #' }, { key: 'cardName', label: 'Vendor', sub: 'cardCode' }, { key: 'itemCode', label: 'Item', sub: 'itemName' },
          { key: 'dueDate', label: 'Due', fmt: 'date' }, { key: 'daysLate', label: 'Days late', fmt: 'int' }, { key: 'qty', label: 'Ordered', fmt: 'num' },
          { key: 'openQty', label: 'Open', fmt: 'num' }, { key: 'openValue', label: 'Open value', fmt: 'amt' }] },
      { key: 'quality', label: 'Quality & returns', rows: rows.filter(r => r.purchases > 0).sort((a, z) => (z.returnRate ?? 0) - (a.returnRate ?? 0)),
        columns: [{ key: 'cardName', label: 'Vendor', sub: 'cardCode' }, { key: 'purchases', label: 'Invoiced', fmt: 'amt' },
          { key: 'returnValue', label: 'Returns + credit notes', fmt: 'amt' }, { key: 'returnRate', label: 'Rate', fmt: 'pct', strong: true },
          { key: 'priceStability', label: 'Price stability', fmt: 'pct' }] },
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
