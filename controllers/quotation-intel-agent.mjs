/**
 * Quotation Intelligence Agent — mounted at /api/quotation-intel-agent
 *
 * For every open sales-quotation line (or an ad-hoc customer + item price
 * check) compares the quoted price with: the line/item cost, this customer's
 * previous invoiced prices, what all customers paid over the last 12 months,
 * and an optional competitor price — then recommends a quote price and flags
 * margin leaks and deal-losing prices.
 */
import { createInsightRouter, AgentDataError, ctxTable, isoDate, num, round, clamp, median, percentile, fmtAmt } from '../lib/insight-kit.mjs';
import { loadItems, loadPartners, loadSalesPriceHistory, since } from '../lib/insight-data.mjs';

// KPI drill-through (calc blocks → lib/insight-kit.mjs withKpiDetails).
const SRC = {
  oqut: 'OQUT + QUT1 — open sales quotations and lines: quoted price, list price, discount, quantity, line cost, valid-until date',
  hist: 'OINV + INV1 — A/R invoice lines of the last 12 months: customer, item, quantity, price, item cost',
  oitm: 'OITM — item master: average cost, last purchase price',
  ocrd: 'OCRD — customer master',
  input: 'Values entered in the options (minimum / target margin, competitor price, proposed price, quantity)',
};

async function loadOpenQuoteLines(k) {
  await k.need('OQUT', ['DocEntry', 'DocNum', 'CardCode', 'CardName', 'DocDate', 'DocDueDate', 'DocStatus', 'CANCELED']);
  await k.need('QUT1', ['DocEntry', 'LineNum', 'ItemCode', 'Dscription', 'Quantity', 'Price', 'PriceBefDi', 'DiscPrcnt', 'StockPrice', 'GrossBuyPr', 'LineTotal', 'LineStatus']);
  const rows = await k.run(`SELECT T0.{DocEntry} AS {DocEntry}, T0.{DocNum} AS {DocNum}, T0.{CardCode} AS {CardCode}, T0.{CardName} AS {CardName},
      T0.{DocDate} AS {DocDate}, T0.{DocDueDate} AS {DocDueDate}, T1.{LineNum} AS {LineNum}, T1.{ItemCode} AS {ItemCode},
      T1.{Dscription} AS {Dscription}, T1.{Quantity} AS {Quantity}, T1.{Price} AS {Price}, T1.{PriceBefDi} AS {PriceBefDi},
      T1.{DiscPrcnt} AS {DiscPrcnt}, T1.{StockPrice} AS {StockPrice}, T1.{GrossBuyPr} AS {GrossBuyPr}, T1.{LineTotal} AS {LineTotal}
    FROM @OQUT T0 INNER JOIN @QUT1 T1 ON T1.{DocEntry} = T0.{DocEntry}
    WHERE T0.{DocStatus} = 'O' AND T0.{CANCELED} = 'N' AND T1.{LineStatus} = 'O' AND T1.{ItemCode} IS NOT NULL`);
  return rows.map(r => ({
    docEntry: r.DocEntry, docNum: r.DocNum, cardCode: r.CardCode, cardName: r.CardName || '', docDate: isoDate(r.DocDate),
    validUntil: isoDate(r.DocDueDate), lineNum: r.LineNum, itemCode: r.ItemCode, itemName: r.Dscription || '',
    qty: num(r.Quantity), price: num(r.Price), listPrice: num(r.PriceBefDi), discount: num(r.DiscPrcnt),
    lineCost: num(r.GrossBuyPr) || num(r.StockPrice), lineTotal: num(r.LineTotal),
  }));
}

function evaluate(line, item, history, opts) {
  const { minMargin, targetMargin } = opts;
  const cost = line.lineCost || item?.avgPrice || item?.lastPurPrice || 0;
  const itemHist = history.filter(h => h.itemCode === line.itemCode && h.price > 0);
  const custHist = itemHist.filter(h => h.cardCode === line.cardCode).sort((a, z) => z.date.localeCompare(a.date));
  const prices = itemHist.map(h => h.price);
  const mkt = { median: median(prices), p25: percentile(prices, 0.25), p75: percentile(prices, 0.75), n: prices.length };
  const typicalQty = median(itemHist.map(h => h.qty));
  const custLast = custHist[0]?.price ?? null;

  const minPct = Math.round(minMargin * 100), tgtPct = Math.round(targetMargin * 100);
  const p2 = v => round(v, 2);
  const floor = cost > 0 ? cost / (1 - minMargin) : 0;
  let anchor = custLast ?? mkt.median ?? (cost > 0 ? cost / (1 - targetMargin) : line.price);
  let basis = custLast != null ? `customer's last price (${custHist[0].date})` : mkt.median != null ? `12-month market median (${mkt.n} sales)` : cost > 0 ? `cost + ${Math.round(targetMargin * 100)}% target margin` : 'quoted price (no cost or history)';
  // Explanation of the recommended price, recorded as each step is applied.
  const startHit = custLast != null ? 0 : mkt.median != null ? 1 : cost > 0 ? 2 : 3;
  const recSteps = [{ label: 'Starting price', formula: 'see the rules below', value: p2(anchor), detail: basis }];
  if (opts.competitorPrice > 0 && opts.competitorPrice < anchor) {
    anchor = opts.competitorPrice * 0.99;
    basis += `, undercut competitor ${fmtAmt(opts.competitorPrice)}`;
    recSteps.push({ label: 'Undercut competitor', formula: 'competitor price × 0.99 (1% below), when it is lower', value: p2(anchor), detail: `Competitor price ${p2(opts.competitorPrice)}` });
  }
  if (typicalQty && line.qty >= typicalQty * 2) {
    anchor *= 0.97; basis += ', 3% volume discount';
    recSteps.push({ label: 'Volume discount', formula: '− 3% when quantity is at least 2× the typical order', value: p2(anchor), detail: `Quantity ${line.qty} vs typical ${typicalQty}` });
  }
  const recommended = round(Math.max(floor, anchor), 2);
  if (floor > anchor) basis += ` — held at the ${Math.round(minMargin * 100)}% minimum-margin floor`;
  recSteps.push({ label: 'Minimum-margin floor', formula: `cost ÷ (1 − ${minPct}%)`, value: p2(floor), detail: cost > 0 ? `Cost ${p2(cost)}` : 'No cost known — no floor' });

  const margin = line.price > 0 && cost > 0 ? ((line.price - cost) / line.price) * 100 : null;
  const recMargin = recommended > 0 && cost > 0 ? ((recommended - cost) / recommended) * 100 : null;
  // Verdict: the first rule that matches wins.
  const verdictRules = [
    { rule: 'Quoted price is under 10% of the market median or of cost', result: 'CHECK UOM',
      test: () => line.price > 0 && ((mkt.median && line.price < mkt.median * 0.1) || (cost && line.price < cost * 0.1)),
      note: () => `Quoted price is under 10% of cost/market (${fmtAmt(mkt.median || cost)}) — likely a unit-of-measure or pack-size mismatch` },
    { rule: `Quoted price is below the ${minPct}% minimum-margin floor${floor > 0 ? ` (${p2(floor)})` : ''}`, result: 'BELOW MIN MARGIN',
      test: () => line.price > 0 && floor > 0 && line.price < floor,
      note: () => `Below the ${minPct}% margin floor (${fmtAmt(floor)})` },
    { rule: `Quoted price is more than 5% below this customer's last price${custLast != null ? ` (${p2(custLast)})` : ''}`, result: 'UNDER-PRICED',
      test: () => custLast != null && line.price < custLast * 0.95,
      note: () => `${Math.round((1 - line.price / custLast) * 100)}% below this customer's last price ${round(custLast, 2)}` },
    { rule: `Quoted price is more than 10% above the market 75th percentile${mkt.p75 != null ? ` (${p2(mkt.p75)})` : ''}`, result: 'ABOVE MARKET',
      test: () => mkt.p75 != null && line.price > mkt.p75 * 1.1,
      note: () => `Above the 75th percentile of recent prices (${round(mkt.p75, 2)}) — risk of losing the deal` },
    { rule: 'No cost and no sales in the last 12 months', result: 'NO DATA', test: () => !mkt.n && !cost,
      note: () => 'No cost or sales history — check pricing manually' },
    { rule: 'No sales in the last 12 months (cost is known)', result: 'NEW ITEM', test: () => !mkt.n,
      note: () => 'No sales history — priced from cost' },
    { rule: 'None of the above', result: 'OK', test: () => true, note: () => 'Price is consistent with cost and history' },
  ];
  const vHit = verdictRules.find(r => r.test());
  const verdict = vHit.result, note = vHit.note();

  const costHit = line.lineCost ? 0 : item?.avgPrice ? 1 : item?.lastPurPrice ? 2 : 3;
  const marginEx = (label, price) => ({
    title: label,
    steps: [{ label: 'Price', value: p2(price) }, { label: 'Cost', value: p2(cost), detail: 'See the Cost column for its source' },
      { label: 'Profit per unit', formula: 'price − cost', value: p2(price - cost) }],
    result: { label: 'Margin = (price − cost) ÷ price', value: `${round(((price - cost) / price) * 100, 1)}%` },
  });
  const impact = round((recommended - line.price) * line.qty, 2);
  const explain = {
    recommended: {
      title: 'Recommended price', steps: recSteps,
      result: { label: 'Recommended = the higher of the price and the floor', value: recommended },
      rules: [
        { rule: 'Customer bought this item in the last 12 months', result: 'Start from the customer\'s last price', hit: startHit === 0 },
        { rule: 'Otherwise, the item was sold to anyone in the last 12 months', result: `Start from the market median (${mkt.n} sales)`, hit: startHit === 1 },
        { rule: 'Otherwise, cost is known', result: `Start from cost ÷ (1 − ${tgtPct}% target margin)`, hit: startHit === 2 },
        { rule: 'Otherwise', result: 'Start from the quoted price', hit: startHit === 3 },
      ],
      note: `Never below the ${minPct}% minimum-margin floor.`,
    },
    verdict: { title: 'Verdict', rules: verdictRules.map(r => ({ rule: r.rule, result: r.result, hit: r === vHit })),
      note: `Rules are checked from top to bottom; the first match wins. Quoted price ${p2(line.price)}.` },
    cost: { title: 'Cost used',
      rules: [
        { rule: 'The quote line has a cost (gross-profit base price)', result: 'Use the quote line cost', hit: costHit === 0 },
        { rule: 'Otherwise', result: 'Item average cost', hit: costHit === 1 },
        { rule: 'Otherwise', result: 'Item last purchase price', hit: costHit === 2 },
        { rule: 'No cost found', result: '0 (unknown)', hit: costHit === 3 },
      ],
      result: { label: 'Cost', value: p2(cost) } },
    impact: { title: 'Value impact',
      steps: [{ label: 'Recommended price', value: recommended }, { label: '− Quoted price', value: p2(line.price) },
        { label: '= Difference per unit', value: p2(recommended - line.price) }, { label: '× Quantity', value: line.qty }],
      result: { label: 'Value impact', value: impact },
      note: impact > 0 ? 'Extra revenue if the recommended price is quoted.' : 'Negative = the recommended price is lower (e.g. to stay competitive).' },
  };
  if (margin != null) explain.margin = marginEx('Quoted margin', line.price);
  if (recMargin != null) explain.recMargin = marginEx('Margin at recommended price', recommended);

  return {
    ...line, cost: round(cost, 2), margin: margin != null ? round(margin, 1) : null,
    custLast: custLast != null ? round(custLast, 2) : null, custSales: custHist.length,
    marketMedian: mkt.median != null ? round(mkt.median, 2) : null, marketLow: mkt.p25 != null ? round(mkt.p25, 2) : null,
    marketHigh: mkt.p75 != null ? round(mkt.p75, 2) : null, marketSales: mkt.n,
    floor: round(floor, 2), recommended, recMargin: recMargin != null ? round(recMargin, 1) : null,
    gap: round(recommended - line.price, 2), impact,
    verdict, note, basis, explain,
  };
}

async function run(k, p) {
  const asOf = p.asOf;
  const opts = {
    minMargin: clamp(num(p.minMarginPct ?? 15) / 100, 0, 0.9),
    targetMargin: clamp(num(p.targetMarginPct ?? 25) / 100, 0, 0.9),
    competitorPrice: num(p.competitorPrice),
  };
  const items = await loadItems(k);
  const adhoc = String(p.itemCode || '').trim();
  let lines = [];
  if (adhoc) {
    const it = items.get(adhoc);
    if (!it) throw new AgentDataError(`Item ${adhoc} was not found (inventory items only).`);
    const cardCode = String(p.cardCode || '').trim();
    const bp = cardCode ? (await loadPartners(k, 'C')).get(cardCode) : null;
    if (cardCode && !bp) throw new AgentDataError(`Customer ${cardCode} was not found.`);
    lines = [{ docNum: 'CHECK', cardCode, cardName: bp?.cardName || '(any customer)', itemCode: adhoc, itemName: it.itemName,
      qty: num(p.qty) || 1, price: num(p.proposedPrice), lineCost: 0, docDate: asOf, validUntil: null }];
  } else {
    lines = await loadOpenQuoteLines(k);
  }
  const codes = [...new Set(lines.map(l => l.itemCode))];
  const history = await loadSalesPriceHistory(k, since(asOf, 365), codes);
  const rows = lines.map(l => evaluate(l, items.get(l.itemCode), history, opts));
  if (adhoc && !rows[0].price) {
    rows[0].verdict = 'RECOMMENDATION'; rows[0].note = 'No proposed price entered'; rows[0].gap = null; rows[0].impact = null;
    const { impact: _i, ...ex } = rows[0].explain;
    rows[0].explain = { ...ex, verdict: { title: 'Verdict', rules: [{ rule: 'No proposed price entered', result: 'RECOMMENDATION', hit: true }],
      note: 'Enter a proposed price to check it against cost, customer history and the market.' } };
  }

  const quotes = new Map();
  for (const r of rows) {
    const q = quotes.get(r.docNum) || { docNum: r.docNum, cardCode: r.cardCode, cardName: r.cardName, docDate: r.docDate, validUntil: r.validUntil, lines: 0, value: 0, cost: 0, flagged: 0, uplift: 0, upSteps: [] };
    q.lines++; q.value += r.price * r.qty; q.cost += r.cost * r.qty;
    if (r.verdict !== 'OK') q.flagged++;
    if (r.impact > 0 && r.verdict !== 'CHECK UOM') {
      q.uplift += r.impact;
      q.upSteps.push({ label: `${r.itemCode} (${r.verdict})`, formula: '(recommended − quoted) × qty', value: r.impact,
        detail: `(${r.recommended} − ${r.price}) × ${r.qty}` });
    }
    quotes.set(r.docNum, q);
  }
  const quoteRows = [...quotes.values()].map(({ upSteps, ...q }) => {
    const out = { ...q, value: round(q.value), margin: q.value > 0 && q.cost > 0 ? round(((q.value - q.cost) / q.value) * 100, 1) : null, uplift: round(q.uplift) };
    out.explain = {
      uplift: { title: 'Quote uplift', steps: upSteps.slice(0, 15), result: { label: 'Uplift = sum of positive value impacts', value: out.uplift },
        note: `Only lines where the recommended price is higher count; CHECK UOM lines are left out.${upSteps.length > 15 ? ` ${upSteps.length - 15} more lines not shown.` : ''}${upSteps.length ? '' : ' No line on this quote is priced below the recommendation.'}` },
      ...(out.margin != null ? { margin: { title: 'Quote margin',
        steps: [{ label: 'Quoted value', formula: 'sum of quoted price × qty', value: out.value }, { label: 'Cost', formula: 'sum of cost × qty', value: round(q.cost) }],
        result: { label: 'Margin = (value − cost) ÷ value', value: `${out.margin}%` } } } : {}),
    };
    return out;
  }).sort((a, z) => z.uplift - a.uplift);

  const flagged = rows.filter(r => r.verdict !== 'OK').sort((a, z) => Math.abs(z.impact || 0) - Math.abs(a.impact || 0));
  const totalValue = rows.reduce((s, r) => s + r.price * r.qty, 0);
  const totalCost = rows.reduce((s, r) => s + r.cost * r.qty, 0);
  const uplift = rows.filter(r => r.verdict !== 'CHECK UOM').reduce((s, r) => s + Math.max(0, r.impact || 0), 0);
  const count = v => rows.filter(r => r.verdict === v).length;

  const histRows = history
    .filter(h => !adhoc || h.itemCode === adhoc)
    .sort((a, z) => z.date.localeCompare(a.date)).slice(0, 300)
    .map(h => ({ ...h, sameCustomer: rows.some(r => r.itemCode === h.itemCode && r.cardCode === h.cardCode) ? 'YES' : '',
      margin: h.price > 0 && h.cost > 0 ? round(((h.price - h.cost) / h.price) * 100, 1) : null }));

  const r0 = rows[0];
  const insight = adhoc
    ? `**Recommended price for ${r0.itemCode} ${r0.cardCode ? `to ${r0.cardName}` : ''}: ${fmtAmt(r0.recommended)}${r0.recMargin != null ? ` (${r0.recMargin}% margin)` : ''}.**\n\n- Basis: ${r0.basis}.\n- Cost ${r0.cost || 'n/a'}, margin floor ${r0.floor || 'n/a'} at ${Math.round(opts.minMargin * 100)}% minimum margin.\n` +
      (r0.custLast != null ? `- This customer last paid ${r0.custLast} (${r0.custSales} purchases in 12 months).\n` : '- No purchases of this item by this customer in the last 12 months.\n') +
      (r0.marketMedian != null ? `- Market over 12 months: median ${r0.marketMedian}, typical range ${r0.marketLow}–${r0.marketHigh} (${r0.marketSales} sales).\n` : '') +
      (r0.price ? `- Proposed ${r0.price}: **${r0.verdict}** — ${r0.note}.\n` : '')
    : rows.length
      ? `**${flagged.length} of ${rows.length} open quote lines need a pricing review; potential uplift ${fmtAmt(uplift)}.**\n\n` +
        `- Average quoted margin ${totalValue > 0 && totalCost > 0 ? round(((totalValue - totalCost) / totalValue) * 100, 1) : 'n/a'}%.\n` +
        (count('CHECK UOM') ? `- ${count('CHECK UOM')} line(s) are priced at under 10% of cost/market — check the unit of measure before sending.
` : '') +
        `- ${count('BELOW MIN MARGIN')} below the minimum margin, ${count('UNDER-PRICED')} below the customer's own last price, ${count('ABOVE MARKET')} above market.\n` +
        (flagged[0] ? `- Biggest gap: quote #${flagged[0].docNum} ${flagged[0].itemCode} for ${flagged[0].cardName} — quoted ${flagged[0].price}, recommend ${flagged[0].recommended} (${flagged[0].note}).\n` : '')
      : '**No open quotation lines.** Enter a customer and item above to get a price recommendation.';

  const aiContext = `QUOTATION PRICING as of ${asOf}. Min margin ${Math.round(opts.minMargin * 100)}%, target ${Math.round(opts.targetMargin * 100)}%${opts.competitorPrice ? `, competitor price ${opts.competitorPrice}` : ''}.
Lines ${rows.length}, flagged ${flagged.length}, quoted value ${fmtAmt(totalValue)}, potential uplift ${fmtAmt(uplift)}.
LINES:
${ctxTable(adhoc ? rows : flagged.length ? flagged : rows, [['docNum', 'Quote'], ['cardName', 'Customer'], ['itemCode', 'Item'], ['qty', 'Qty'], ['price', 'Quoted'], ['cost', 'Cost'], ['margin', 'Margin%'], ['custLast', 'CustLast'], ['marketMedian', 'MktMedian'], ['marketHigh', 'MktP75'], ['recommended', 'Recommended'], ['verdict', 'Verdict']], 30)}
${adhoc ? `RECENT SALES OF ${adhoc}:\n${ctxTable(histRows, [['date', 'Date'], ['cardCode', 'Customer'], ['qty', 'Qty'], ['price', 'Price'], ['margin', 'Margin%']], 20)}` : ''}`;

  const minPct = Math.round(opts.minMargin * 100), tgtPct = Math.round(opts.targetMargin * 100);
  const lineCols = [
    { key: 'verdict', label: 'Verdict', fmt: 'badge', hint: `Pricing check result, first match wins: CHECK UOM (price < 10% of cost/market), BELOW MIN MARGIN (< ${minPct}% margin), UNDER-PRICED (> 5% below customer’s last price), ABOVE MARKET (> 10% above market P75), NEW ITEM / NO DATA, else OK.` },
    { key: 'docNum', label: 'Quote #', hint: 'SAP sales quotation number (CHECK for an ad-hoc price check).' },
    { key: 'cardName', label: 'Customer', sub: 'cardCode', hint: 'Customer name with its business-partner code.' },
    { key: 'itemCode', label: 'Item', sub: 'itemName', hint: 'Item code with its description.' },
    { key: 'qty', label: 'Qty', fmt: 'num', hint: 'Quantity quoted.' },
    { key: 'price', label: 'Quoted', fmt: 'price', hint: 'Unit price on the quotation after line discount.' },
    { key: 'cost', label: 'Cost', fmt: 'price', hint: 'Unit cost: quote line gross-profit base price, else item average cost, else last purchase price.' },
    { key: 'margin', label: 'Margin', fmt: 'pct', hint: 'Quoted margin % = (quoted price − cost) ÷ quoted price × 100.' },
    { key: 'custLast', label: 'Cust. last', fmt: 'price', hint: 'Price this customer paid on their most recent invoice for this item (last 12 months).' },
    { key: 'marketMedian', label: 'Market median', fmt: 'price', hint: 'Middle price paid by all customers for this item over the last 12 months.' },
    { key: 'marketHigh', label: 'Market P75', fmt: 'price', hint: '75th percentile of 12-month prices — three quarters of sales were at or below this price.' },
    { key: 'recommended', label: 'Recommended', fmt: 'price', strong: true, hint: `Suggested price: customer’s last price → else market median → else cost + ${tgtPct}% target margin; adjusted for competitor/volume, never below the ${minPct}% margin floor.` },
    { key: 'recMargin', label: 'Rec. margin', fmt: 'pct', hint: 'Margin % at the recommended price = (recommended − cost) ÷ recommended × 100.' },
    { key: 'impact', label: 'Value impact', fmt: 'amt', hint: 'Value impact = (recommended − quoted price) × quantity; positive = extra revenue available.' },
    { key: 'note', label: 'Why', wrap: true, hint: 'Plain-language reason for the verdict.' },
    { key: 'basis', label: 'Basis', wrap: true, hint: 'What the recommended price was built from and which adjustments were applied.' },
  ];
  const quotedMargin = totalValue > 0 && totalCost > 0 ? ((totalValue - totalCost) / totalValue) * 100 : null;
  const verdictCalc = (v, formula, steps) => ({ formula, steps, sources: [SRC.oqut, SRC.hist, SRC.oitm], tab: 'lines', filter: r => r.verdict === v, sortBy: 'impact', chart: null,
    stats: [{ label: 'Lines', value: count(v), fmt: 'int' }, { label: 'Quoted value', value: round(rows.filter(r => r.verdict === v).reduce((s, r) => s + r.price * r.qty, 0)), fmt: 'amt' },
      { label: 'Value impact', value: round(rows.filter(r => r.verdict === v).reduce((s, r) => s + (r.impact || 0), 0)), fmt: 'amt' },
      { label: 'Quotations affected', value: new Set(rows.filter(r => r.verdict === v).map(r => r.docNum)).size, fmt: 'int' }] });
  const ownHist = adhoc ? histRows.filter(h => h.cardCode === r0.cardCode) : [];

  return {
    kpis: adhoc ? [
      { label: 'Recommended price', value: r0.recommended, fmt: 'price', tone: 'good', hint: 'Suggested unit price for this customer and item',
        calc: { formula: `Start from the customer’s last price → else the 12-month market median → else cost ÷ (1 − ${tgtPct}% target margin); undercut a lower competitor price by 1%; −3% when quantity ≥ 2× the typical order; never below cost ÷ (1 − ${minPct}%).`,
          steps: [`Applied here: ${r0.basis}.`, 'Click the Recommended cell in the "Price check" tab for each step.'],
          sources: [SRC.hist, SRC.oitm, SRC.input], tab: 'lines', chart: null,
          stats: [{ label: 'Cost', value: r0.cost, fmt: 'price' }, { label: 'Margin floor', value: r0.floor, fmt: 'price' },
            { label: 'Customer last price', value: r0.custLast ?? '—', fmt: r0.custLast != null ? 'price' : undefined },
            { label: 'Market median', value: r0.marketMedian ?? '—', fmt: r0.marketMedian != null ? 'price' : undefined },
            ...(opts.competitorPrice > 0 ? [{ label: 'Competitor price', value: opts.competitorPrice, fmt: 'price' }] : [])] } },
      { label: 'Margin at recommended', value: r0.recMargin, fmt: 'pct', hint: 'Gross margin % if quoted at the recommended price',
        calc: { formula: 'Margin = (recommended price − cost) ÷ recommended price × 100.', steps: [`Minimum margin ${minPct}%, target margin ${tgtPct}%.`, 'Blank when the cost is unknown.'],
          sources: [SRC.oitm, SRC.hist], tab: 'lines', chart: null,
          stats: [{ label: 'Recommended price', value: r0.recommended, fmt: 'price' }, { label: 'Cost', value: r0.cost, fmt: 'price' },
            { label: 'Profit per unit', value: round(r0.recommended - r0.cost, 2), fmt: 'price' }, ...(r0.margin != null ? [{ label: 'Margin at proposed price', value: r0.margin, fmt: 'pct' }] : [])] } },
      { label: 'Cost', value: r0.cost, fmt: 'price', hint: 'Unit cost used for margin checks',
        calc: { formula: 'Cost = item average cost, else the item’s last purchase price (an ad-hoc check has no quote-line cost).', steps: ['0 means no cost is known — the margin floor then does not apply.'],
          sources: [SRC.oitm], tab: 'lines', chart: null,
          stats: [{ label: 'Cost', value: r0.cost, fmt: 'price' }, { label: 'Margin floor price', value: r0.floor, fmt: 'price' },
            { label: 'Avg historical cost', value: histRows.length ? round(histRows.reduce((s, h) => s + h.cost, 0) / histRows.length, 2) : 0, fmt: 'price' }] } },
      { label: 'Margin floor price', value: r0.floor, fmt: 'price', hint: `Lowest price that still earns the ${minPct}% minimum margin`,
        calc: { formula: `Floor = cost ÷ (1 − ${minPct}% minimum margin).`, steps: ['The recommended price is never set below this floor.', 'A proposed price under the floor gets the verdict BELOW MIN MARGIN.'],
          sources: [SRC.oitm, SRC.input], tab: 'lines', chart: null,
          stats: [{ label: 'Cost', value: r0.cost, fmt: 'price' }, { label: 'Minimum margin', value: minPct, fmt: 'pct' }, { label: 'Recommended price', value: r0.recommended, fmt: 'price' }] } },
      { label: 'Customer last price', value: r0.custLast, fmt: 'price', hint: 'What this customer paid on their latest invoice for this item (12 months)',
        calc: { formula: 'Unit price on this customer’s most recent A/R invoice line for the item in the last 12 months.', steps: ['Blank when the customer has not bought the item in 12 months or no customer was entered.'],
          sources: [SRC.hist], rows: ownHist, tab: 'history', sortBy: 'price', chart: null,
          stats: [{ label: 'Customer purchases (12m)', value: r0.custSales, fmt: 'int' },
            { label: 'Customer lowest price', value: ownHist.length ? Math.min(...ownHist.map(h => h.price)) : '—', fmt: ownHist.length ? 'price' : undefined },
            { label: 'Customer highest price', value: ownHist.length ? Math.max(...ownHist.map(h => h.price)) : '—', fmt: ownHist.length ? 'price' : undefined }] } },
      { label: 'Market median (12m)', value: r0.marketMedian, fmt: 'price', hint: 'Middle price all customers paid for this item over 12 months',
        calc: { formula: 'Median unit price of all A/R invoice lines for the item in the last 12 months (all customers, price > 0).', steps: ['Typical range = 25th to 75th percentile of those prices.'],
          sources: [SRC.hist], tab: 'history', sortBy: 'price', chart: null,
          stats: [{ label: 'Market low (P25)', value: r0.marketLow ?? '—', fmt: r0.marketLow != null ? 'price' : undefined }, { label: 'Market high (P75)', value: r0.marketHigh ?? '—', fmt: r0.marketHigh != null ? 'price' : undefined },
            { label: 'Sales counted', value: r0.marketSales, fmt: 'int' }] } },
      { label: 'Sales in history', value: r0.marketSales, fmt: 'int', hint: 'Priced invoice lines for this item in the last 12 months',
        calc: { formula: 'Count of A/R invoice lines with a price above zero for this item in the last 12 months.', steps: ['The more sales, the more reliable the market median and range.'],
          sources: [SRC.hist], tab: 'history', chart: null,
          stats: [{ label: 'Customers', value: new Set(histRows.map(h => h.cardCode)).size, fmt: 'int' }, { label: 'Total quantity', value: round(histRows.reduce((s, h) => s + h.qty, 0), 2), fmt: 'num' },
            { label: 'This customer', value: r0.custSales, fmt: 'int' }] } },
    ] : [
      { label: 'Open quote lines', value: rows.length, fmt: 'int', hint: 'Lines on open, non-cancelled sales quotations',
        calc: { formula: 'Count of open lines (with an item) on open, non-cancelled sales quotations.', sources: [SRC.oqut], tab: 'lines', sortBy: 'impact',
          stats: [{ label: 'Quotations', value: quoteRows.length, fmt: 'int' }, { label: 'Flagged lines', value: flagged.length, fmt: 'int' },
            { label: 'OK lines', value: count('OK'), fmt: 'int' }, { label: 'New items / no data', value: count('NEW ITEM') + count('NO DATA'), fmt: 'int' }] } },
      { label: 'Quoted value', value: totalValue, fmt: 'amt', hint: 'Total value of open quote lines at the quoted prices',
        calc: { formula: 'Σ quoted unit price × quantity over all open quote lines.', sources: [SRC.oqut], tab: 'quotes', sortBy: 'value',
          stats: [{ label: 'Quotations', value: quoteRows.length, fmt: 'int' }, { label: 'Largest quotation', value: quoteRows.reduce((m, q) => Math.max(m, q.value), 0), fmt: 'amt' },
            { label: 'Value on flagged lines', value: round(flagged.reduce((s, r) => s + r.price * r.qty, 0)), fmt: 'amt' }] } },
      { label: 'Avg quoted margin', value: quotedMargin, fmt: 'pct', hint: 'Gross margin across all open quote lines',
        calc: { formula: 'Margin = (Σ quoted price × qty − Σ cost × qty) ÷ Σ quoted price × qty × 100.', steps: ['Cost = quote line gross-profit base price, else item average cost, else last purchase price.', `Minimum margin ${minPct}%, target ${tgtPct}%.`],
          sources: [SRC.oqut, SRC.oitm], tab: 'quotes', sortBy: 'value',
          stats: [{ label: 'Quoted value', value: round(totalValue), fmt: 'amt' }, { label: 'Cost', value: round(totalCost), fmt: 'amt' },
            { label: 'Lines below min margin', value: count('BELOW MIN MARGIN'), fmt: 'int' }] } },
      { label: 'Below min margin', value: count('BELOW MIN MARGIN'), fmt: 'int', tone: count('BELOW MIN MARGIN') ? 'bad' : 'good', hint: `Lines quoted under the ${minPct}% minimum margin`,
        calc: verdictCalc('BELOW MIN MARGIN', `Count of lines whose quoted price is below the floor = cost ÷ (1 − ${minPct}%).`, ['Lines priced under 10% of cost are classed CHECK UOM instead.']) },
      { label: 'Under-priced vs history', value: count('UNDER-PRICED'), fmt: 'int', tone: count('UNDER-PRICED') ? 'warn' : 'good', hint: 'Lines quoted >5% below the customer’s own last price',
        calc: verdictCalc('UNDER-PRICED', 'Count of lines quoted more than 5% below the price this customer last paid for the item (12 months).', ['Only lines that pass the minimum-margin check reach this rule.']) },
      { label: 'Above market', value: count('ABOVE MARKET'), fmt: 'int', tone: count('ABOVE MARKET') ? 'warn' : 'good', hint: 'Lines quoted >10% above the market 75th percentile — deal at risk',
        calc: verdictCalc('ABOVE MARKET', 'Count of lines quoted more than 10% above the 75th-percentile price all customers paid in the last 12 months.', ['Negative value impact = lowering to the recommendation reduces revenue but improves win chances.']) },
      { label: 'Potential uplift', value: uplift, fmt: 'amt', tone: 'good', hint: 'Extra revenue if under-priced lines were quoted at the recommended price',
        calc: { formula: 'Σ (recommended − quoted price) × qty over lines where the recommendation is higher; CHECK UOM lines are excluded.',
          sources: [SRC.oqut, SRC.hist, SRC.oitm], tab: 'quotes', sortBy: 'uplift', filter: q => q.uplift > 0,
          stats: [{ label: 'Lines with uplift', value: rows.filter(r => r.verdict !== 'CHECK UOM' && r.impact > 0).length, fmt: 'int' },
            { label: 'Quotations with uplift', value: quoteRows.filter(q => q.uplift > 0).length, fmt: 'int' }, { label: 'CHECK UOM lines (excluded)', value: count('CHECK UOM'), fmt: 'int' }] } },
    ],
    tabs: [
      { key: 'lines', label: adhoc ? 'Price check' : `Quote lines (${rows.length})`, rows: adhoc ? rows : [...flagged, ...rows.filter(r => r.verdict === 'OK')], columns: lineCols,
        desc: adhoc ? 'The proposed price compared with cost, this customer’s history and the market, with a recommended price — click a cell to see the reasoning.'
          : 'Every open quote line with its pricing verdict and recommended price; flagged lines come first, biggest value impact on top.' },
      ...(adhoc ? [] : [{ key: 'quotes', label: `Quotations (${quoteRows.length})`, rows: quoteRows,
        desc: 'One row per open quotation with its value, margin and possible uplift — prioritise quotes to revise before they are sent or accepted.',
        columns: [{ key: 'docNum', label: 'Quote #', hint: 'SAP sales quotation number.' }, { key: 'cardName', label: 'Customer', sub: 'cardCode', hint: 'Customer name with its business-partner code.' },
          { key: 'docDate', label: 'Date', fmt: 'date', hint: 'Quotation date.' }, { key: 'validUntil', label: 'Valid until', fmt: 'date', hint: 'Date the quotation expires.' },
          { key: 'lines', label: 'Lines', fmt: 'int', hint: 'Number of open lines on the quotation.' },
          { key: 'value', label: 'Value', fmt: 'amt', hint: 'Σ quoted price × quantity.' },
          { key: 'margin', label: 'Margin', fmt: 'pct', hint: 'Quote margin % = (value − Σ cost × qty) ÷ value × 100.' },
          { key: 'flagged', label: 'Flagged lines', fmt: 'int', hint: 'Lines whose verdict is not OK.' },
          { key: 'uplift', label: 'Uplift', fmt: 'amt', hint: 'Σ positive value impacts — extra revenue if under-priced lines are raised to the recommendation.' }] }]),
      { key: 'history', label: `Price history (${histRows.length})`, rows: histRows,
        desc: 'Recent A/R invoice prices (last 12 months) for the quoted items, newest first — the evidence behind the market and customer prices.',
        columns: [{ key: 'date', label: 'Date', fmt: 'date', hint: 'Invoice date.' }, { key: 'docNum', label: 'Invoice #', hint: 'SAP A/R invoice number.' },
          { key: 'itemCode', label: 'Item', hint: 'Item code.' }, { key: 'cardCode', label: 'Customer', hint: 'Customer code on the invoice.' },
          { key: 'sameCustomer', label: 'Quoted cust.', fmt: 'badge', hint: 'YES when this invoice is for the same customer and item as a quote line.' },
          { key: 'qty', label: 'Qty', fmt: 'num', hint: 'Quantity invoiced.' }, { key: 'price', label: 'Price', fmt: 'price', hint: 'Unit price invoiced after line discount.' },
          { key: 'cost', label: 'Cost', fmt: 'price', hint: 'Item cost at the time of the invoice.' },
          { key: 'margin', label: 'Margin', fmt: 'pct', hint: 'Margin % = (price − cost) ÷ price × 100.' }] },
    ],
    notes: [
      'Recommended price = customer\'s last price → else 12-month market median → else cost + target margin; undercuts a lower competitor price by 1%, gives 3% for orders ≥ 2× the typical quantity, and never goes below the minimum-margin floor.',
      'Cost uses the quote line\'s gross-profit base price, falling back to the item\'s average cost, then last purchase price. Price history is A/R invoice lines from the last 12 months.',
      'SAP B1 has no competitor price data — enter a competitor price above to include it.',
    ],
    insight, aiContext,
  };
}

export function createQuotationIntelAgentRouter(deps) {
  return createInsightRouter(deps, {
    slug: 'quoteintel', title: 'Quotation Intelligence Agent',
    defaults: { minMarginPct: 15, targetMarginPct: 25 },
    persona: 'You are a B2B pricing analyst advising sales on quotation prices from SAP Business One history.',
    aiTask: 'Review these quotation prices against cost, customer history and market prices. Recommend price changes line by line, quantify the margin impact, and flag deals at risk of being lost.',
    run,
  });
}
