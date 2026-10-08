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

// KPI drill-through (calc blocks → lib/insight-kit.mjs withKpiDetails).
const SRC = {
  oinv: 'OINV — A/R invoice headers (not cancelled): date, customer, sales employee, header discount %',
  inv1: 'INV1 — A/R invoice lines: quantity, price before discount, line discount %, line total, gross-profit base price, item cost',
  orin: 'ORIN + RIN1 — A/R credit memos and lines',
  inv3: 'INV3 — freight / additional expenses charged on A/R invoices',
  pch3: 'OPCH + PCH3 — freight / additional expenses paid on A/P invoices',
  oslp: 'OSLP — sales employees',
};

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

  const tgtPct = round(target * 100), anomPct = Math.round(anomaly * 100);
  // Leak-type decision table for the popup (thresholds in business words).
  const lineTypeRules = [
    { type: 'BELOW COST', rule: 'Sold below cost (margin under 0%)' },
    { type: 'BELOW TARGET', rule: `Margin under the ${tgtPct}% target` },
    { type: 'EXCESSIVE DISCOUNT', rule: `Total discount above the ${maxDisc}% allowed` },
    { type: 'ZERO PRICE', rule: 'Invoiced at a zero price' },
    { type: 'PRICE ANOMALY', rule: `Price more than ${anomPct}% below the item's median price (item needs 4+ sales)` },
  ];

  const flagged = [];
  for (const l of lines) {
    const flags = [];
    const margin = l.revenue ? l.gp / l.revenue : null;
    if (l.cost > 0 && margin != null && margin < target) {
      const leak = l.cost / (1 - target) - l.revenue;
      flags.push({ type: margin < 0 ? 'BELOW COST' : 'BELOW TARGET', leak, detail: `${round(margin * 100, 1)}% margin vs ${round(target * 100)}% target`,
        formula: `cost ÷ (1 − ${tgtPct}%) − revenue`, inputs: `Cost ${fmtAmt(l.cost)}, revenue ${fmtAmt(l.revenue)}` });
    }
    const eff = (1 - (1 - l.lineDiscPct / 100) * (1 - l.hdrDiscPct / 100)) * 100;
    if (eff > maxDisc) {
      const gross = l.revenue / (1 - eff / 100);
      flags.push({ type: 'EXCESSIVE DISCOUNT', leak: gross * (eff - maxDisc) / 100, detail: `${round(eff, 1)}% discount (line ${round(l.lineDiscPct, 1)}%, header ${round(l.hdrDiscPct, 1)}%) vs ${maxDisc}% allowed`,
        formula: `value before discount × (discount − ${maxDisc}%)`, inputs: `${fmtAmt(gross)} before discount × (${round(eff, 1)}% − ${maxDisc}%)` });
    }
    const ref = medianByItem.get(l.itemCode);
    if (l.unitPriceLc <= 0) {
      const basis = ref?.median || l.unitCost;
      if (basis > 0) flags.push({ type: 'ZERO PRICE', leak: basis * l.qty, detail: `Invoiced at zero; ${ref?.median ? `typical price ${round(basis, 2)}` : `cost ${round(basis, 2)} (no priced sales to compare)`}`,
        formula: ref?.median ? 'item median price × qty' : 'unit cost × qty', inputs: `${round(basis, 2)} × ${round(l.qty, 2)}` });
    } else if (ref && ref.n >= 4 && l.unitPriceLc < ref.median * (1 - anomaly)) {
      flags.push({ type: 'PRICE ANOMALY', leak: (ref.median - l.unitPriceLc) * l.qty, detail: `${round(l.unitPriceLc, 2)} vs item median ${round(ref.median, 2)} (${Math.round((1 - l.unitPriceLc / ref.median) * 100)}% below)`,
        formula: '(item median price − price) × qty', inputs: `(${round(ref.median, 2)} − ${round(l.unitPriceLc, 2)}) × ${round(l.qty, 2)}; median of ${ref.n} sales` });
    }
    if (!flags.length) continue;
    const main = flags.reduce((m, f) => (f.leak > m.leak ? f : m));
    const leak = round(Math.max(0, main.leak));
    const marginPct = margin != null ? round(margin * 100, 1) : null;
    const typeEx = { title: 'Leak type',
      rules: lineTypeRules.map(r => {
        const f = flags.find(x => x.type === r.type);
        return { rule: r.rule, result: !f ? r.type : f === main ? `${r.type} — largest leak` : `${r.type} — also applies`, hit: f === main };
      }),
      note: flags.length > 1 ? 'Several leak types apply; the one with the largest amount sets the type.' : 'Only one leak type applies to this line.' };
    flagged.push({
      docNum: l.docNum, date: l.date, cardCode: l.cardCode, cardName: l.cardName, salesperson: l.salesperson,
      itemCode: l.itemCode, itemName: l.itemName, whsCode: l.whsCode, qty: round(l.qty, 2),
      unitPrice: round(l.unitPriceLc, 2), unitCost: round(l.unitCost, 2), revenue: round(l.revenue), gp: round(l.gp),
      marginPct, discountPct: round(eff, 1),
      type: main.type, leak, detail: flags.map(f => f.detail).join('; '), types: flags.map(f => f.type).join(', '),
      explain: {
        leak: { title: 'Leakage',
          steps: flags.map(f => ({ label: f === main ? `${f.type} (largest)` : f.type, formula: f.formula, value: round(f.leak), detail: f.inputs })),
          result: { label: 'Leakage = the largest of the above', value: leak },
          note: 'Only the largest amount counts, so the same money is not counted twice.' },
        type: typeEx,
        ...(marginPct != null ? { marginPct: { title: 'Margin',
          steps: [{ label: 'Revenue', value: round(l.revenue) }, { label: 'Gross profit', formula: 'revenue − cost', value: round(l.gp) }],
          result: { label: 'Margin = gross profit ÷ revenue', value: `${marginPct}%` }, note: `Target margin ${tgtPct}%.` } } : {}),
        discountPct: { title: 'Total discount',
          steps: [{ label: 'Line discount', value: `${round(l.lineDiscPct, 1)}%` }, { label: 'Document (header) discount', value: `${round(l.hdrDiscPct, 1)}%` }],
          result: { label: 'Total = 1 − (1 − line) × (1 − header)', value: `${round(eff, 1)}%` }, note: `Allowed: up to ${maxDisc}%.` },
      },
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
    const share = Math.round((charged.length / docs.size) * 100);
    for (const [docNum, l] of docs) {
      if ((freightByDoc.get(docNum) || 0) > 0) continue;
      const fRule = { rule: 'Customer has 3+ invoices, is charged freight on at least 50% of them, and this invoice has none', result: 'FREIGHT NOT CHARGED', hit: true };
      freightRows.push({ docNum, date: l.date, cardCode: card, cardName: l.cardName, salesperson: l.salesperson, type: 'FREIGHT NOT CHARGED',
        leak: round(typical), detail: `Customer is charged freight on ${Math.round((charged.length / docs.size) * 100)}% of invoices (typical ${fmtAmt(typical)})`,
        explain: {
          leak: { title: 'Estimated freight not charged',
            steps: [{ label: 'Invoices for this customer', value: docs.size }, { label: 'Invoices with freight charged', value: charged.length, detail: `${share}% of invoices` },
              { label: 'Typical freight', formula: 'median freight on the invoices that had it', value: round(typical) }],
            result: { label: 'Estimated leak = typical freight', value: round(typical) } },
          type: { title: 'Leak type', rules: [fRule], note: 'Freight is checked per invoice, separately from the line checks.' },
        } });
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
    return [...m.values()].map(e => {
      const types = Object.entries(e.byType).sort((a, z) => z[1] - a[1]);
      const row = { ...e, leak: round(e.leak), mainType: types[0]?.[0] || '', byType: undefined };
      const ex = { title: 'Leakage by type',
        steps: types.map(([t, v]) => ({ label: t, value: round(v) })),
        result: { label: `Total over ${e.lines} line(s)`, value: row.leak },
        note: 'Main leak = the type with the largest amount.' };
      row.explain = { leak: ex, mainType: ex };
      return row;
    }).sort((a, z) => z.leak - a.leak);
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

  const custCol = { key: 'cardName', label: 'Customer', sub: 'cardCode', hint: 'Customer name with its business-partner code.' };
  const slpCol = { key: 'salesperson', label: 'Sales employee', hint: 'Sales employee on the invoice header.' };
  const invCol = { key: 'docNum', label: 'Invoice #', hint: 'SAP A/R invoice number.' };
  const dateCol = { key: 'date', label: 'Date', fmt: 'date', hint: 'Invoice posting date.' };
  const whyCol = { key: 'detail', label: 'Why', wrap: true, hint: 'Plain-language reason for every leak check this line failed, with the figures compared.' };
  const lineCols = [
    { key: 'type', label: 'Leak type', fmt: 'badge', badge: { 'BELOW COST': 'red', 'BELOW TARGET': 'amber', 'EXCESSIVE DISCOUNT': 'purple', 'PRICE ANOMALY': 'amber', 'ZERO PRICE': 'red', 'FREIGHT NOT CHARGED': 'blue' },
      hint: `Main reason margin was lost: below cost, below the ${tgtPct}% target, discount over ${maxDisc}%, price ${anomPct}%+ under the item median, zero price, or freight not charged. If several apply, the largest leak sets the type.` },
    invCol, dateCol, custCol,
    { key: 'itemCode', label: 'Item', sub: 'itemName', hint: 'Item code with its description.' },
    { key: 'qty', label: 'Qty', fmt: 'num', hint: 'Quantity invoiced on the line.' },
    { key: 'unitPrice', label: 'Unit price', fmt: 'price', hint: 'Net selling price per unit in local currency = line total ÷ quantity.' },
    { key: 'unitCost', label: 'Unit cost', fmt: 'price', hint: 'Cost per unit: gross-profit base price, else item cost at posting.' },
    { key: 'marginPct', label: 'Margin', fmt: 'pct', hint: 'Line margin % = (revenue − cost) ÷ revenue × 100.' },
    { key: 'discountPct', label: 'Discount', fmt: 'pct', hint: 'Total discount % = 1 − (1 − line discount) × (1 − header discount).' },
    { key: 'leak', label: 'Leakage', fmt: 'amt', strong: true, hint: 'Estimated money given away on this line = the largest of its leak amounts (click for the calculation).' },
    slpCol, whyCol,
  ];
  const ofType = (...t) => flagged.filter(r => t.includes(r.type) || t.some(x => r.types.includes(x)));
  const sumLeak = rows => round(rows.reduce((s, r) => s + r.leak, 0));
  const typeSum = t => summary.find(s => s.type === t)?.leak || 0;
  const belowRows = ofType('BELOW COST', 'BELOW TARGET'), discRows = ofType('EXCESSIVE DISCOUNT');
  const base = [SRC.oinv, SRC.inv1];

  return {
    kpis: [
      { label: 'Revenue', value: revenue, fmt: 'amt', hint: 'Net invoiced sales in the period (invoices only, credit memos excluded)',
        calc: { formula: `Σ invoice line total in local currency × (1 − header discount %), invoices dated ${from} → ${to} with quantity > 0.`,
          steps: ['Credit memos are not deducted here — they are shown separately in the "Credit memos" KPI.', 'Freight / additional expenses are not part of revenue.'],
          sources: base, tab: 'cust', chart: null,
          stats: [{ label: 'Invoice lines checked', value: lines.length, fmt: 'int' }, { label: 'Lines with a leak', value: flagged.length, fmt: 'int' },
            { label: 'Revenue on leaking lines', value: round(flagged.reduce((s, r) => s + r.revenue, 0)), fmt: 'amt' }] } },
      { label: 'Gross margin', value: revenue ? (gp / revenue) * 100 : null, fmt: 'pct', hint: `Gross profit as % of revenue (target ${tgtPct}%)`,
        calc: { formula: 'Gross margin % = (revenue − cost) ÷ revenue × 100 over all invoice lines in the period.',
          steps: ['Cost = gross-profit base price on the line, else item cost at posting, × quantity.', `Lines under the ${tgtPct}% target are listed in the "Below target" tab.`],
          sources: base, tab: 'margin', sortBy: 'leak',
          stats: [{ label: 'Revenue', value: round(revenue), fmt: 'amt' }, { label: 'Gross profit', value: round(gp), fmt: 'amt' },
            { label: 'Target margin', value: tgtPct, fmt: 'pct' }, { label: 'Lines below target', value: belowRows.length, fmt: 'int' }] } },
      { label: 'Estimated leakage', value: totalLeak, fmt: 'amt', tone: totalLeak ? 'bad' : 'good', hint: 'Money given away through low margins, discounts, low prices and uncharged freight',
        calc: { formula: `Σ leak per invoice line (largest of: below target = cost ÷ (1 − ${tgtPct}%) − revenue; discount = value before discount × (discount − ${maxDisc}%); price anomaly = (item median − price) × qty; zero price = median price × qty) + typical freight on invoices where freight was not charged.`,
          steps: ['Only the largest leak per line counts, so the same money is never counted twice.', `Price anomalies need 4+ sales of the item and a price ${anomPct}%+ below its median.`, 'Freight: customers with 3+ invoices charged freight on at least half of them.'],
          sources: [...base, SRC.inv3], tab: 'all', sortBy: 'leak',
          stats: [{ label: 'Flagged lines / invoices', value: all2.length, fmt: 'int' }, ...summary.filter(s => s.lines).slice(0, 4).map(s => ({ label: s.type, value: s.leak, fmt: 'amt' }))] } },
      { label: 'Leakage % revenue', value: revenue ? (totalLeak / revenue) * 100 : 0, fmt: 'pct', tone: totalLeak / (revenue || 1) > 0.02 ? 'bad' : 'warn', hint: 'Estimated leakage ÷ revenue',
        calc: { formula: 'Leakage % = estimated leakage ÷ revenue × 100.', steps: ['Red above 2% of revenue, otherwise amber.'],
          sources: [...base, SRC.inv3], tab: 'slp', sortBy: 'leak',
          stats: [{ label: 'Estimated leakage', value: round(totalLeak), fmt: 'amt' }, { label: 'Revenue', value: round(revenue), fmt: 'amt' },
            { label: 'Sales employees with leaks', value: bySlp.length, fmt: 'int' }, { label: 'Customers with leaks', value: byCust.length, fmt: 'int' }] } },
      { label: 'Lines below target', value: belowRows.length, fmt: 'int', hint: `Invoice lines with margin under ${tgtPct}% (incl. below cost)`,
        calc: { formula: `Count of invoice lines with a cost and a margin below the ${tgtPct}% target; under 0% is BELOW COST.`,
          steps: [`Leak per line = cost ÷ (1 − ${tgtPct}%) − revenue, i.e. the extra revenue needed to reach the target.`, 'Lines without cost are not checked here.'],
          sources: base, tab: 'margin', sortBy: 'leak',
          stats: [{ label: 'Below cost (lines)', value: belowRows.filter(r => r.types.includes('BELOW COST')).length, fmt: 'int' },
            { label: 'Below target (lines)', value: belowRows.filter(r => r.types.includes('BELOW TARGET')).length, fmt: 'int' },
            { label: 'Below-cost leakage', value: typeSum('BELOW COST'), fmt: 'amt' }, { label: 'Below-target leakage', value: typeSum('BELOW TARGET'), fmt: 'amt' }] } },
      { label: 'Excessive discounts', value: discRows.length, fmt: 'int', hint: `Invoice lines discounted more than ${maxDisc}%`,
        calc: { formula: `Count of invoice lines whose total discount, 1 − (1 − line %) × (1 − header %), is above ${maxDisc}%.`,
          steps: [`Leak = value before discount × (total discount − ${maxDisc}%).`, 'A line can also be below target; its leak type is whichever amount is larger.'],
          sources: base, tab: 'discount', sortBy: 'leak',
          stats: [{ label: 'Lines', value: discRows.length, fmt: 'int' }, { label: 'Discount leakage (main type)', value: typeSum('EXCESSIVE DISCOUNT'), fmt: 'amt' },
            { label: 'Highest discount', value: discRows.reduce((m, r) => Math.max(m, r.discountPct), 0), fmt: 'pct' },
            { label: 'Customers', value: new Set(discRows.map(r => r.cardCode)).size, fmt: 'int' }] } },
      { label: 'Freight unrecovered', value: Math.max(0, freightPaid - freightCharged), fmt: 'amt', hint: `Charged ${fmtAmt(freightCharged)} vs paid ${fmtAmt(freightPaid)}`,
        calc: { formula: 'Freight unrecovered = freight paid to suppliers on A/P invoices − freight charged to customers on A/R invoices (zero if charged ≥ paid).',
          steps: ['Uses additional expenses recorded on the documents in the period.', 'Invoices where a regular freight customer was not charged are listed in the "Freight" tab.'],
          sources: [SRC.inv3, SRC.pch3], tab: 'freight', sortBy: 'leak', chart: null,
          stats: [{ label: 'Charged to customers', value: round(freightCharged), fmt: 'amt' }, { label: 'Paid to suppliers', value: round(freightPaid), fmt: 'amt' },
            { label: 'Invoices without expected freight', value: freightRows.length, fmt: 'int' }, { label: 'Est. freight not charged', value: sumLeak(freightRows), fmt: 'amt' }] } },
      { label: 'Credit memos', value: cmValue, fmt: 'amt', hint: 'Value credited back to customers after the sale',
        calc: { formula: `Σ A/R credit-memo line totals × (1 − header discount %), dated ${from} → ${to}.`,
          steps: ['Not counted in leakage; shown as post-sale concessions that further reduce margin.'],
          sources: [SRC.orin],
          rows: creditMemos.map(l => ({ docNum: l.docNum, date: l.date, cardCode: l.cardCode, cardName: l.cardName, itemCode: l.itemCode, itemName: l.itemName, value: round(-l.revenue) })),
          columns: [{ key: 'docNum', label: 'Credit memo #' }, dateCol, custCol, { key: 'itemCode', label: 'Item', sub: 'itemName' }, { key: 'value', label: 'Credited', fmt: 'amt' }],
          sortBy: 'value', chart: null,
          stats: [{ label: 'Credit memos', value: new Set(creditMemos.map(l => l.docNum)).size, fmt: 'int' }, { label: 'Lines', value: creditMemos.length, fmt: 'int' },
            { label: 'As % of revenue', value: revenue ? round((cmValue / revenue) * 100, 1) : 0, fmt: 'pct' }] } },
    ],
    chart: { title: 'Leakage by type', type: 'bar', labels: summary.map(s => s.type), series: [{ name: 'Leakage', values: summary.map(s => s.leak), color: '#DC2626' }],
      desc: 'Each bar is the estimated money lost through one leak type — the tallest bar is the first control to tighten.' },
    tabs: [
      { key: 'all', label: `All leaks (${all2.length})`, rows: all2.sort((a, z) => z.leak - a.leak), columns: lineCols,
        desc: 'Every invoice line or invoice with a margin leak, largest first — click Leakage to see how it was calculated.' },
      { key: 'margin', label: `Below target (${belowRows.length})`, rows: belowRows, columns: lineCols,
        desc: `Lines sold below cost or under the ${tgtPct}% target margin — review pricing or cost for these items.` },
      { key: 'discount', label: `Discounts (${discRows.length})`, rows: discRows, columns: lineCols,
        desc: `Lines discounted more than the ${maxDisc}% allowed — check who approved them.` },
      { key: 'anomaly', label: `Price anomalies (${ofType('PRICE ANOMALY', 'ZERO PRICE').length})`, rows: ofType('PRICE ANOMALY', 'ZERO PRICE'), columns: lineCols,
        desc: `Lines invoiced at zero or more than ${anomPct}% below the item's usual (median) price — possible keying errors or unapproved deals.` },
      { key: 'freight', label: `Freight (${freightRows.length})`, rows: freightRows,
        desc: 'Invoices without freight for customers who are normally charged freight — the amount is their typical freight charge.',
        columns: [lineCols[0], invCol, dateCol, custCol,
          { key: 'leak', label: 'Est. freight', fmt: 'amt', strong: true, hint: 'Estimated freight not charged = median freight on this customer’s invoices that had freight.' }, slpCol, whyCol] },
      { key: 'inconsistent', label: `Inconsistent prices (${inconsistent.length})`, rows: inconsistent,
        desc: `Customer/item pairs sold at prices ${anomPct}%+ apart in the period — informational, not counted as leakage.`,
        columns: [custCol, { key: 'itemCode', label: 'Item', sub: 'itemName', hint: 'Item code with its description.' },
          { key: 'sales', label: 'Sales', fmt: 'int', hint: 'Number of priced invoice lines for this customer and item.' },
          { key: 'minPrice', label: 'Lowest', fmt: 'price', hint: 'Lowest unit price charged in the period.' },
          { key: 'maxPrice', label: 'Highest', fmt: 'price', hint: 'Highest unit price charged in the period.' },
          { key: 'spreadPct', label: 'Spread', fmt: 'pct', strong: true, hint: 'Spread % = (highest − lowest) ÷ highest × 100.' },
          { key: 'qty', label: 'Qty', fmt: 'num', hint: 'Total quantity sold to this customer.' }] },
      { key: 'slp', label: 'By sales employee', rows: bySlp,
        desc: 'Total leakage per sales employee and their most common leak type — useful for coaching and approval limits.',
        columns: [slpCol, { key: 'leak', label: 'Leakage', fmt: 'amt', strong: true, hint: 'Σ leakage on this sales employee’s flagged lines and invoices.' },
          { key: 'lines', label: 'Lines', fmt: 'int', hint: 'Number of flagged lines / invoices.' }, { key: 'mainType', label: 'Main leak', fmt: 'badge', hint: 'Leak type with the largest amount.' }] },
      { key: 'cust', label: 'By customer', rows: byCust,
        desc: 'Total leakage per customer — shows which accounts receive the most concessions.',
        columns: [custCol, { key: 'leak', label: 'Leakage', fmt: 'amt', strong: true, hint: 'Σ leakage on this customer’s flagged lines and invoices.' },
          { key: 'lines', label: 'Lines', fmt: 'int', hint: 'Number of flagged lines / invoices.' }, { key: 'mainType', label: 'Main leak', fmt: 'badge', hint: 'Leak type with the largest amount.' }] },
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
