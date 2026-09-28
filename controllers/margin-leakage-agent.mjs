/**
 * Margin Leakage Agent — mounted at /api/margin-leakage-agent
 *
 * Finds where margin is being given away on A/R invoices in a date range, and
 * quantifies each leak in local currency:
 *   BELOW TARGET / BELOW COST  revenue short of cost ÷ (1 − target margin)
 *   EXCESSIVE DISCOUNT         line + header discount above the allowed %
 *   PRICE ANOMALY / ZERO PRICE unit price far below the item's median price
 *   FREIGHT NOT CHARGED        invoice without freight for a customer who is
 *                              normally charged freight (+ freight recovered
 *                              on sales vs paid on purchases)
 *   INCONSISTENT PRICE         same customer + item sold at widely different
 *                              prices in the period (informational)
 * A line's total leak is the largest of its categories, so nothing is counted
 * twice.
 */
import { createInsightRouter, ctxTable, addDays, num, round, clamp, median, fmtAmt } from '../lib/insight-kit.mjs';
import { loadSalesLines, loadFreight } from '../lib/insight-data.mjs';

async function run(k, p) {
  const to = p.asOf;
  const from = /^\d{4}-\d{2}-\d{2}$/.test(p.fromDate || '') ? p.fromDate : addDays(to, -(clamp(num(p.days) || 90, 1, 1095) - 1));
  const target = clamp(num(p.targetMarginPct ?? 15), 0, 90) / 100;
  const maxDisc = clamp(num(p.maxDiscountPct ?? 10), 0, 100);
  const anomaly = clamp(num(p.anomalyPct ?? 25), 5, 90) / 100;

  const all = await loadSalesLines(k, from, to);
  const lines = all.filter(l => l.sign > 0 && l.qty > 0);
  const creditMemos = all.filter(l => l.sign < 0);
  const freightIn = await loadFreight(k, 'OINV', 'INV3', from, to);
  const freightOut = await loadFreight(k, 'OPCH', 'PCH3', from, to);

  // Item price reference: median LC unit price across the period.
  const priceByItem = new Map();
  for (const l of lines) if (l.unitPriceLc > 0) { if (!priceByItem.has(l.itemCode)) priceByItem.set(l.itemCode, []); priceByItem.get(l.itemCode).push(l.unitPriceLc); }
  const medianByItem = new Map([...priceByItem].map(([i, ps]) => [i, { median: median(ps), n: ps.length }]));

  const flagged = [];
  for (const l of lines) {
    const flags = [];
    const margin = l.revenue ? l.gp / l.revenue : null;
    if (l.cost > 0 && margin != null && margin < target) {
      const leak = l.cost / (1 - target) - l.revenue;
      flags.push({ type: margin < 0 ? 'BELOW COST' : 'BELOW TARGET', leak, detail: `${round(margin * 100, 1)}% margin vs ${round(target * 100)}% target` });
    }
    const eff = (1 - (1 - l.lineDiscPct / 100) * (1 - l.hdrDiscPct / 100)) * 100;
    if (eff > maxDisc) {
      const gross = l.revenue / (1 - eff / 100);
      flags.push({ type: 'EXCESSIVE DISCOUNT', leak: gross * (eff - maxDisc) / 100, detail: `${round(eff, 1)}% discount (line ${round(l.lineDiscPct, 1)}%, header ${round(l.hdrDiscPct, 1)}%) vs ${maxDisc}% allowed` });
    }
    const ref = medianByItem.get(l.itemCode);
    if (l.unitPriceLc <= 0) {
      const basis = ref?.median || l.unitCost;
      if (basis > 0) flags.push({ type: 'ZERO PRICE', leak: basis * l.qty, detail: `Invoiced at zero; ${ref?.median ? `typical price ${round(basis, 2)}` : `cost ${round(basis, 2)} (no priced sales to compare)`}` });
    } else if (ref && ref.n >= 4 && l.unitPriceLc < ref.median * (1 - anomaly)) {
      flags.push({ type: 'PRICE ANOMALY', leak: (ref.median - l.unitPriceLc) * l.qty, detail: `${round(l.unitPriceLc, 2)} vs item median ${round(ref.median, 2)} (${Math.round((1 - l.unitPriceLc / ref.median) * 100)}% below)` });
    }
    if (!flags.length) continue;
    const main = flags.reduce((m, f) => (f.leak > m.leak ? f : m));
    flagged.push({
      docNum: l.docNum, date: l.date, cardCode: l.cardCode, cardName: l.cardName, salesperson: l.salesperson,
      itemCode: l.itemCode, itemName: l.itemName, whsCode: l.whsCode, qty: round(l.qty, 2),
      unitPrice: round(l.unitPriceLc, 2), unitCost: round(l.unitCost, 2), revenue: round(l.revenue), gp: round(l.gp),
      marginPct: margin != null ? round(margin * 100, 1) : null, discountPct: round(eff, 1),
      type: main.type, leak: round(Math.max(0, main.leak)), detail: flags.map(f => f.detail).join('; '), types: flags.map(f => f.type).join(', '),
    });
  }
  flagged.sort((a, z) => z.leak - a.leak);

  // Freight not charged: customers usually charged freight (≥ 50% of ≥ 3 invoices).
  const invByCard = new Map();
  for (const l of lines) { if (!invByCard.has(l.cardCode)) invByCard.set(l.cardCode, new Map()); invByCard.get(l.cardCode).set(l.docNum, l); }
  const freightByDoc = new Map(freightIn.map(f => [f.docNum, f.freight]));
  const freightRows = [];
  for (const [card, docs] of invByCard) {
    if (docs.size < 3) continue;
    const charged = [...docs.keys()].map(d => freightByDoc.get(d) || 0).filter(x => x > 0);
    if (charged.length / docs.size < 0.5) continue;
    const typical = median(charged);
    for (const [docNum, l] of docs) {
      if ((freightByDoc.get(docNum) || 0) > 0) continue;
      freightRows.push({ docNum, date: l.date, cardCode: card, cardName: l.cardName, salesperson: l.salesperson, type: 'FREIGHT NOT CHARGED',
        leak: round(typical), detail: `Customer is charged freight on ${Math.round((charged.length / docs.size) * 100)}% of invoices (typical ${fmtAmt(typical)})` });
    }
  }
  freightRows.sort((a, z) => z.leak - a.leak);
  const freightCharged = freightIn.reduce((s, f) => s + f.freight, 0);
  const freightPaid = freightOut.reduce((s, f) => s + f.freight, 0);

  // Inconsistent pricing (informational).
  const pair = new Map();
  for (const l of lines) if (l.unitPriceLc > 0) {
    const key = `${l.cardCode}\u0001${l.itemCode}`;
    const e = pair.get(key) || { cardCode: l.cardCode, cardName: l.cardName, itemCode: l.itemCode, itemName: l.itemName, prices: [], qty: 0 };
    e.prices.push(l.unitPriceLc); e.qty += l.qty; pair.set(key, e);
  }
  const inconsistent = [...pair.values()].filter(e => e.prices.length >= 2).map(e => {
    const lo = Math.min(...e.prices), hi = Math.max(...e.prices);
    return { ...e, sales: e.prices.length, minPrice: round(lo, 2), maxPrice: round(hi, 2), spreadPct: round(((hi - lo) / hi) * 100, 1), qty: round(e.qty, 2), prices: undefined };
  }).filter(e => e.spreadPct >= anomaly * 100).sort((a, z) => z.spreadPct - a.spreadPct);

  const cmValue = -creditMemos.reduce((s, l) => s + l.revenue, 0);
  const all2 = [...flagged, ...freightRows];
  const TYPES = ['BELOW COST', 'BELOW TARGET', 'EXCESSIVE DISCOUNT', 'PRICE ANOMALY', 'ZERO PRICE', 'FREIGHT NOT CHARGED'];
  const summary = TYPES.map(t => {
    const r = all2.filter(x => x.type === t);
    return { type: t, lines: r.length, leak: round(r.reduce((s, x) => s + x.leak, 0)), customers: new Set(r.map(x => x.cardCode)).size };
  });
  const totalLeak = summary.reduce((s, x) => s + x.leak, 0);
  const revenue = lines.reduce((s, l) => s + l.revenue, 0);
  const gp = lines.reduce((s, l) => s + l.gp, 0);

  const groupLeak = (keyFn, labelFn) => {
    const m = new Map();
    for (const r of all2) {
      const key = keyFn(r);
      const e = m.get(key) || { ...labelFn(r), leak: 0, lines: 0, byType: {} };
      e.leak += r.leak; e.lines++; e.byType[r.type] = (e.byType[r.type] || 0) + r.leak;
      m.set(key, e);
    }
    return [...m.values()].map(e => ({ ...e, leak: round(e.leak), mainType: Object.entries(e.byType).sort((a, z) => z[1] - a[1])[0]?.[0] || '', byType: undefined })).sort((a, z) => z.leak - a.leak);
  };
  const bySlp = groupLeak(r => r.salesperson, r => ({ salesperson: r.salesperson }));
  const byCust = groupLeak(r => r.cardCode, r => ({ cardCode: r.cardCode, cardName: r.cardName }));

  const insight = `**Estimated margin leakage ${fmtAmt(totalLeak)} (${revenue ? round((totalLeak / revenue) * 100, 1) : 0}% of revenue) across ${all2.length} lines, ${from} → ${to}.**\n\n` +
    summary.filter(s => s.lines).map(s => `- ${s.type}: ${fmtAmt(s.leak)} on ${s.lines} line${s.lines === 1 ? '' : 's'}.`).join('\n') + '\n' +
    (flagged[0] ? `- Largest single leak: invoice #${flagged[0].docNum} ${flagged[0].itemCode} for ${flagged[0].cardName} — ${fmtAmt(flagged[0].leak)} (${flagged[0].detail}).\n` : '') +
    (bySlp[0] ? `- Sales employee with most leakage: **${bySlp[0].salesperson}** (${fmtAmt(bySlp[0].leak)}, mostly ${bySlp[0].mainType}).\n` : '') +
    (freightIn.length || freightOut.length ? `- Freight: ${fmtAmt(freightCharged)} charged to customers vs ${fmtAmt(freightPaid)} paid to suppliers${freightPaid > freightCharged ? ` — **${fmtAmt(freightPaid - freightCharged)} unrecovered**` : ''}.\n` : '- No freight/additional expenses are recorded on invoices, so freight leakage cannot be measured.\n') +
    (cmValue ? `- Credit memos issued: ${fmtAmt(cmValue)} (post-sale concessions reduce margin further).\n` : '') +
    (inconsistent.length ? `- ${inconsistent.length} customer/item pairs were sold at prices ${Math.round(anomaly * 100)}%+ apart in the period.\n` : '');

  const aiContext = `MARGIN LEAKAGE ${from} to ${to}. Target margin ${round(target * 100)}%, max discount ${maxDisc}%, anomaly threshold ${Math.round(anomaly * 100)}% below item median.
Revenue ${fmtAmt(revenue)}, GP ${fmtAmt(gp)}, leakage ${fmtAmt(totalLeak)}. Freight charged ${fmtAmt(freightCharged)} vs paid ${fmtAmt(freightPaid)}. Credit memos ${fmtAmt(cmValue)}.
BY TYPE: ${summary.map(s => `${s.type} ${fmtAmt(s.leak)} (${s.lines})`).join('; ')}
TOP LEAKS:
${ctxTable(all2.sort((a, z) => z.leak - a.leak), [['type', 'Type'], ['docNum', 'Inv'], ['cardName', 'Customer'], ['itemCode', 'Item'], ['unitPrice', 'Price'], ['unitCost', 'Cost'], ['marginPct', 'GM%'], ['discountPct', 'Disc%'], ['leak', 'Leak'], ['salesperson', 'Slp']], 25)}
BY SALES EMPLOYEE:
${ctxTable(bySlp, [['salesperson', 'Slp'], ['leak', 'Leak'], ['lines', 'Lines'], ['mainType', 'MainType']], 10)}
INCONSISTENT PRICES:
${ctxTable(inconsistent, [['cardName', 'Customer'], ['itemCode', 'Item'], ['minPrice', 'Min'], ['maxPrice', 'Max'], ['spreadPct', 'Spread%']], 10)}`;

  const lineCols = [
    { key: 'type', label: 'Leak type', fmt: 'badge', badge: { 'BELOW COST': 'red', 'BELOW TARGET': 'amber', 'EXCESSIVE DISCOUNT': 'purple', 'PRICE ANOMALY': 'amber', 'ZERO PRICE': 'red', 'FREIGHT NOT CHARGED': 'blue' } },
    { key: 'docNum', label: 'Invoice #' }, { key: 'date', label: 'Date', fmt: 'date' }, { key: 'cardName', label: 'Customer', sub: 'cardCode' },
    { key: 'itemCode', label: 'Item', sub: 'itemName' }, { key: 'qty', label: 'Qty', fmt: 'num' }, { key: 'unitPrice', label: 'Unit price', fmt: 'price' },
    { key: 'unitCost', label: 'Unit cost', fmt: 'price' }, { key: 'marginPct', label: 'Margin', fmt: 'pct' }, { key: 'discountPct', label: 'Discount', fmt: 'pct' },
    { key: 'leak', label: 'Leakage', fmt: 'amt', strong: true }, { key: 'salesperson', label: 'Sales employee' }, { key: 'detail', label: 'Why', wrap: true },
  ];
  const ofType = (...t) => flagged.filter(r => t.includes(r.type) || t.some(x => r.types.includes(x)));

  return {
    kpis: [
      { label: 'Revenue', value: revenue, fmt: 'amt' },
      { label: 'Gross margin', value: revenue ? (gp / revenue) * 100 : null, fmt: 'pct' },
      { label: 'Estimated leakage', value: totalLeak, fmt: 'amt', tone: totalLeak ? 'bad' : 'good' },
      { label: 'Leakage % revenue', value: revenue ? (totalLeak / revenue) * 100 : 0, fmt: 'pct', tone: totalLeak / (revenue || 1) > 0.02 ? 'bad' : 'warn' },
      { label: 'Lines below target', value: ofType('BELOW COST', 'BELOW TARGET').length, fmt: 'int' },
      { label: 'Excessive discounts', value: ofType('EXCESSIVE DISCOUNT').length, fmt: 'int' },
      { label: 'Freight unrecovered', value: Math.max(0, freightPaid - freightCharged), fmt: 'amt', hint: `Charged ${fmtAmt(freightCharged)} vs paid ${fmtAmt(freightPaid)}` },
      { label: 'Credit memos', value: cmValue, fmt: 'amt' },
    ],
    chart: { title: 'Leakage by type', type: 'bar', labels: summary.map(s => s.type), series: [{ name: 'Leakage', values: summary.map(s => s.leak), color: '#DC2626' }] },
    tabs: [
      { key: 'all', label: `All leaks (${all2.length})`, rows: all2.sort((a, z) => z.leak - a.leak), columns: lineCols },
      { key: 'margin', label: `Below target (${ofType('BELOW COST', 'BELOW TARGET').length})`, rows: ofType('BELOW COST', 'BELOW TARGET'), columns: lineCols },
      { key: 'discount', label: `Discounts (${ofType('EXCESSIVE DISCOUNT').length})`, rows: ofType('EXCESSIVE DISCOUNT'), columns: lineCols },
      { key: 'anomaly', label: `Price anomalies (${ofType('PRICE ANOMALY', 'ZERO PRICE').length})`, rows: ofType('PRICE ANOMALY', 'ZERO PRICE'), columns: lineCols },
      { key: 'freight', label: `Freight (${freightRows.length})`, rows: freightRows,
        columns: [lineCols[0], { key: 'docNum', label: 'Invoice #' }, { key: 'date', label: 'Date', fmt: 'date' }, { key: 'cardName', label: 'Customer', sub: 'cardCode' },
          { key: 'leak', label: 'Est. freight', fmt: 'amt', strong: true }, { key: 'salesperson', label: 'Sales employee' }, { key: 'detail', label: 'Why', wrap: true }] },
      { key: 'inconsistent', label: `Inconsistent prices (${inconsistent.length})`, rows: inconsistent,
        columns: [{ key: 'cardName', label: 'Customer', sub: 'cardCode' }, { key: 'itemCode', label: 'Item', sub: 'itemName' }, { key: 'sales', label: 'Sales', fmt: 'int' },
          { key: 'minPrice', label: 'Lowest', fmt: 'price' }, { key: 'maxPrice', label: 'Highest', fmt: 'price' }, { key: 'spreadPct', label: 'Spread', fmt: 'pct', strong: true }, { key: 'qty', label: 'Qty', fmt: 'num' }] },
      { key: 'slp', label: 'By sales employee', rows: bySlp,
        columns: [{ key: 'salesperson', label: 'Sales employee' }, { key: 'leak', label: 'Leakage', fmt: 'amt', strong: true }, { key: 'lines', label: 'Lines', fmt: 'int' }, { key: 'mainType', label: 'Main leak', fmt: 'badge' }] },
      { key: 'cust', label: 'By customer', rows: byCust,
        columns: [{ key: 'cardName', label: 'Customer', sub: 'cardCode' }, { key: 'leak', label: 'Leakage', fmt: 'amt', strong: true }, { key: 'lines', label: 'Lines', fmt: 'int' }, { key: 'mainType', label: 'Main leak', fmt: 'badge' }] },
    ],
    notes: [
      `Period ${from} → ${to}. Leakage per line = the largest of its leak types (no double counting). Below-target leak = cost ÷ (1 − ${round(target * 100)}%) − revenue; discount leak = value discounted beyond ${maxDisc}%; anomaly leak = (item median − price) × qty.`,
      'Price anomalies need at least 4 sales of the item in the period. Freight uses additional expenses on A/R (INV3) and A/P (PCH3) invoices.',
    ],
    insight, aiContext,
  };
}

export function createMarginLeakageAgentRouter(deps) {
  return createInsightRouter(deps, {
    slug: 'marginleak', title: 'Margin Leakage Agent',
    defaults: { days: 90, targetMarginPct: 15, maxDiscountPct: 10, anomalyPct: 25 },
    persona: 'You are a pricing and margin-assurance analyst reviewing SAP Business One sales.',
    aiTask: 'Review this margin leakage analysis. Explain the biggest sources of leakage, who and what is driving them, and specific pricing, discount-approval and freight-recovery controls to put in place.',
    run,
  });
}
