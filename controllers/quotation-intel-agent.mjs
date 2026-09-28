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

  const floor = cost > 0 ? cost / (1 - minMargin) : 0;
  let anchor = custLast ?? mkt.median ?? (cost > 0 ? cost / (1 - targetMargin) : line.price);
  let basis = custLast != null ? `customer's last price (${custHist[0].date})` : mkt.median != null ? `12-month market median (${mkt.n} sales)` : cost > 0 ? `cost + ${Math.round(targetMargin * 100)}% target margin` : 'quoted price (no cost or history)';
  if (opts.competitorPrice > 0 && opts.competitorPrice < anchor) {
    anchor = opts.competitorPrice * 0.99;
    basis += `, undercut competitor ${fmtAmt(opts.competitorPrice)}`;
  }
  if (typicalQty && line.qty >= typicalQty * 2) { anchor *= 0.97; basis += ', 3% volume discount'; }
  const recommended = round(Math.max(floor, anchor), 2);
  if (floor > anchor) basis += ` — held at the ${Math.round(minMargin * 100)}% minimum-margin floor`;

  const margin = line.price > 0 && cost > 0 ? ((line.price - cost) / line.price) * 100 : null;
  const recMargin = recommended > 0 && cost > 0 ? ((recommended - cost) / recommended) * 100 : null;
  let verdict = 'OK', note = 'Price is consistent with cost and history';
  if (line.price > 0 && ((mkt.median && line.price < mkt.median * 0.1) || (cost && line.price < cost * 0.1))) {
    verdict = 'CHECK UOM'; note = `Quoted price is under 10% of cost/market (${fmtAmt(mkt.median || cost)}) — likely a unit-of-measure or pack-size mismatch`;
  }
  else if (line.price > 0 && floor > 0 && line.price < floor) { verdict = 'BELOW MIN MARGIN'; note = `Below the ${Math.round(minMargin * 100)}% margin floor (${fmtAmt(floor)})`; }
  else if (custLast != null && line.price < custLast * 0.95) { verdict = 'UNDER-PRICED'; note = `${Math.round((1 - line.price / custLast) * 100)}% below this customer's last price ${round(custLast, 2)}`; }
  else if (mkt.p75 != null && line.price > mkt.p75 * 1.1) { verdict = 'ABOVE MARKET'; note = `Above the 75th percentile of recent prices (${round(mkt.p75, 2)}) — risk of losing the deal`; }
  else if (!mkt.n && !cost) { verdict = 'NO DATA'; note = 'No cost or sales history — check pricing manually'; }
  else if (!mkt.n) { verdict = 'NEW ITEM'; note = 'No sales history — priced from cost'; }

  return {
    ...line, cost: round(cost, 2), margin: margin != null ? round(margin, 1) : null,
    custLast: custLast != null ? round(custLast, 2) : null, custSales: custHist.length,
    marketMedian: mkt.median != null ? round(mkt.median, 2) : null, marketLow: mkt.p25 != null ? round(mkt.p25, 2) : null,
    marketHigh: mkt.p75 != null ? round(mkt.p75, 2) : null, marketSales: mkt.n,
    floor: round(floor, 2), recommended, recMargin: recMargin != null ? round(recMargin, 1) : null,
    gap: round(recommended - line.price, 2), impact: round((recommended - line.price) * line.qty, 2),
    verdict, note, basis,
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
  if (adhoc && !rows[0].price) { rows[0].verdict = 'RECOMMENDATION'; rows[0].note = 'No proposed price entered'; rows[0].gap = null; rows[0].impact = null; }

  const quotes = new Map();
  for (const r of rows) {
    const q = quotes.get(r.docNum) || { docNum: r.docNum, cardCode: r.cardCode, cardName: r.cardName, docDate: r.docDate, validUntil: r.validUntil, lines: 0, value: 0, cost: 0, flagged: 0, uplift: 0 };
    q.lines++; q.value += r.price * r.qty; q.cost += r.cost * r.qty;
    if (r.verdict !== 'OK') q.flagged++;
    if (r.impact > 0 && r.verdict !== 'CHECK UOM') q.uplift += r.impact;
    quotes.set(r.docNum, q);
  }
  const quoteRows = [...quotes.values()].map(q => ({ ...q, value: round(q.value), margin: q.value > 0 && q.cost > 0 ? round(((q.value - q.cost) / q.value) * 100, 1) : null, uplift: round(q.uplift) }))
    .sort((a, z) => z.uplift - a.uplift);

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

  const lineCols = [
    { key: 'verdict', label: 'Verdict', fmt: 'badge' }, { key: 'docNum', label: 'Quote #' },
    { key: 'cardName', label: 'Customer', sub: 'cardCode' }, { key: 'itemCode', label: 'Item', sub: 'itemName' },
    { key: 'qty', label: 'Qty', fmt: 'num' }, { key: 'price', label: 'Quoted', fmt: 'price' }, { key: 'cost', label: 'Cost', fmt: 'price' },
    { key: 'margin', label: 'Margin', fmt: 'pct' }, { key: 'custLast', label: 'Cust. last', fmt: 'price' },
    { key: 'marketMedian', label: 'Market median', fmt: 'price' }, { key: 'marketHigh', label: 'Market P75', fmt: 'price' },
    { key: 'recommended', label: 'Recommended', fmt: 'price', strong: true }, { key: 'recMargin', label: 'Rec. margin', fmt: 'pct' },
    { key: 'impact', label: 'Value impact', fmt: 'amt' }, { key: 'note', label: 'Why', wrap: true }, { key: 'basis', label: 'Basis', wrap: true },
  ];

  return {
    kpis: adhoc ? [
      { label: 'Recommended price', value: r0.recommended, fmt: 'price', tone: 'good' },
      { label: 'Margin at recommended', value: r0.recMargin, fmt: 'pct' },
      { label: 'Cost', value: r0.cost, fmt: 'price' },
      { label: 'Margin floor price', value: r0.floor, fmt: 'price' },
      { label: 'Customer last price', value: r0.custLast, fmt: 'price' },
      { label: 'Market median (12m)', value: r0.marketMedian, fmt: 'price' },
      { label: 'Sales in history', value: r0.marketSales, fmt: 'int' },
    ] : [
      { label: 'Open quote lines', value: rows.length, fmt: 'int' },
      { label: 'Quoted value', value: totalValue, fmt: 'amt' },
      { label: 'Avg quoted margin', value: totalValue > 0 && totalCost > 0 ? ((totalValue - totalCost) / totalValue) * 100 : null, fmt: 'pct' },
      { label: 'Below min margin', value: count('BELOW MIN MARGIN'), fmt: 'int', tone: count('BELOW MIN MARGIN') ? 'bad' : 'good' },
      { label: 'Under-priced vs history', value: count('UNDER-PRICED'), fmt: 'int', tone: count('UNDER-PRICED') ? 'warn' : 'good' },
      { label: 'Above market', value: count('ABOVE MARKET'), fmt: 'int', tone: count('ABOVE MARKET') ? 'warn' : 'good' },
      { label: 'Potential uplift', value: uplift, fmt: 'amt', tone: 'good' },
    ],
    tabs: [
      { key: 'lines', label: adhoc ? 'Price check' : `Quote lines (${rows.length})`, rows: adhoc ? rows : [...flagged, ...rows.filter(r => r.verdict === 'OK')], columns: lineCols },
      ...(adhoc ? [] : [{ key: 'quotes', label: `Quotations (${quoteRows.length})`, rows: quoteRows,
        columns: [{ key: 'docNum', label: 'Quote #' }, { key: 'cardName', label: 'Customer', sub: 'cardCode' },
          { key: 'docDate', label: 'Date', fmt: 'date' }, { key: 'validUntil', label: 'Valid until', fmt: 'date' },
          { key: 'lines', label: 'Lines', fmt: 'int' }, { key: 'value', label: 'Value', fmt: 'amt' }, { key: 'margin', label: 'Margin', fmt: 'pct' },
          { key: 'flagged', label: 'Flagged lines', fmt: 'int' }, { key: 'uplift', label: 'Uplift', fmt: 'amt' }] }]),
      { key: 'history', label: `Price history (${histRows.length})`, rows: histRows,
        columns: [{ key: 'date', label: 'Date', fmt: 'date' }, { key: 'docNum', label: 'Invoice #' }, { key: 'itemCode', label: 'Item' },
          { key: 'cardCode', label: 'Customer' }, { key: 'sameCustomer', label: 'Quoted cust.', fmt: 'badge' },
          { key: 'qty', label: 'Qty', fmt: 'num' }, { key: 'price', label: 'Price', fmt: 'price' }, { key: 'cost', label: 'Cost', fmt: 'price' }, { key: 'margin', label: 'Margin', fmt: 'pct' }] },
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
