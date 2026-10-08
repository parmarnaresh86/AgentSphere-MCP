/**
 * Dynamic Pricing Agent — analyzes every sale item against demand, inventory,
 * margin-target and competitor/benchmark signals to recommend price changes
 * (9 scenarios: Dead Stock, Discount Recovery, Margin Recovery, Shortage
 * Pricing, Demand Capture, Margin Improvement, Overstock Clearance, Market
 * Alignment, Price Establishment), applies changes to SAP price lists, and
 * exposes a tool-calling AI chat over all of it.
 *
 * Extracted from chat-server.mjs (was ~515 inline lines under
 * "DYNAMIC PRICING AGENT") as part of splitting that file into per-agent
 * modules, following the same createXRouter(deps) factory pattern already
 * used by po-agent.mjs / production-agent.mjs / mrp-agent.mjs.
 *
 * callSMLSVCPost/buildParamList/aggregateRows are passed in via deps rather
 * than imported directly — they're entangled with chat-server.mjs's
 * request-scoped query-logging state (_logQ/_reqQueryLog) and shared by
 * several other still-inline sections, so pulling them out cleanly is a
 * separate piece of work, not part of this slice.
 */
import { Router } from 'express';
import { executeSQL, isConnected, getActiveType, getActiveConfig, tableRef, getTableColumns, resolveFieldMap } from '../db-connector.mjs';
import { qcol } from '../lib/sql-dialect.mjs';

const esc = s => String(s || '').replace(/'/g, "''");

// ── DB Direct (ODBC/HANA) reads, Service Layer/SMLSVC fallback ─────────────
// Same pattern as MRP/Purchasing/Procurement/Production/RushOrders/ShipDelays:
// resolve every logical field against the LIVE column list before building SQL
// — never guess — and fall back on any connection/mapping failure.
const PRICING_OITM_CANDIDATES = {
  itemCode: ['ItemCode'], itemName: ['ItemName'], itemGroup: ['ItmsGrpCod'],
  onHand: ['OnHand'], minInventory: ['MinLevel', 'MinInvntry'], maxInventory: ['MaxLevel', 'MaxInvntry'],
  avgPrice: ['AvgPrice'], sellItem: ['SellItem'],
};
const PRICING_OINV_CANDIDATES = { docEntry: ['DocEntry'], docDate: ['DocDate'], cancelled: ['CANCELED', 'Cancelled'] };
const PRICING_INV1_CANDIDATES = {
  docEntry: ['DocEntry'], itemCode: ['ItemCode'], lineTotal: ['LineTotal'],
  grossProfit: ['GrssProfit'], quantity: ['Quantity'],
};

async function fetchPricingItemsViaDB() {
  const cfg    = getActiveConfig();
  const isHana = getActiveType() === 'hana';
  const q      = n => qcol(n, isHana);
  const cols   = await getTableColumns('OITM');
  const { resolved, missing } = resolveFieldMap(cols, PRICING_OITM_CANDIDATES);
  if (missing.length) throw new Error(`OITM field mapping incomplete: ${missing.join(', ')}`);

  const sql = `SELECT ${q(resolved.itemCode)} AS ${q('ItemCode')}, ${q(resolved.itemName)} AS ${q('ItemName')}, ` +
    `${q(resolved.itemGroup)} AS ${q('ItemsGroupCode')}, ${q(resolved.onHand)} AS ${q('OnHand')}, ` +
    `${q(resolved.minInventory)} AS ${q('MinInventory')}, ${q(resolved.maxInventory)} AS ${q('MaxInventory')}, ` +
    `${q(resolved.avgPrice)} AS ${q('AvgStdPrice')} ` +
    `FROM ${tableRef('OITM', cfg)} WHERE ${q(resolved.sellItem)} = 'Y'`;
  const rows = await executeSQL(sql);
  // Normalized to the same shape the Service Layer /Items response provides.
  return rows.map(r => ({
    ItemCode: r.ItemCode, ItemName: r.ItemName, ItemsGroupCode: r.ItemsGroupCode,
    QuantityOnStock: r.OnHand, MinInventory: r.MinInventory, MaxInventory: r.MaxInventory,
    AvgStdPrice: r.AvgStdPrice,
  }));
}

// Replaces callSMLSVCPost("sales", ...) — aggregates AR invoice lines by ItemCode
// directly over ODBC instead of going through sml.svc's SalesAnalysisQuery.
// Output feeds the same aggregateRows() used for the SMLSVC path, so GPMarginPct
// etc. are computed identically regardless of source.
async function fetchSalesSignalsViaDB(fromDate, toDate) {
  const cfg    = getActiveConfig();
  const isHana = getActiveType() === 'hana';
  const q      = n => qcol(n, isHana);
  const hCols  = await getTableColumns('OINV');
  const { resolved: rH, missing: mH } = resolveFieldMap(hCols, PRICING_OINV_CANDIDATES);
  if (mH.length) throw new Error(`OINV field mapping incomplete: ${mH.join(', ')}`);
  const lCols  = await getTableColumns('INV1');
  const { resolved: rL, missing: mL } = resolveFieldMap(lCols, PRICING_INV1_CANDIDATES);
  if (mL.length) throw new Error(`INV1 field mapping incomplete: ${mL.join(', ')}`);

  const h = tableRef('OINV', cfg), l = tableRef('INV1', cfg);
  const sql = `SELECT L.${q(rL.itemCode)} AS ${q('ItemCode')}, ` +
    `SUM(L.${q(rL.lineTotal)}) AS ${q('NetSalesAmountLC')}, ` +
    `SUM(L.${q(rL.grossProfit)}) AS ${q('GrossProfitLC')}, ` +
    `SUM(L.${q(rL.quantity)}) AS ${q('QuantityInInventoryUoM')} ` +
    `FROM ${h} H JOIN ${l} L ON H.${q(rH.docEntry)} = L.${q(rL.docEntry)} ` +
    `WHERE H.${q(rH.cancelled)} = 'N' AND H.${q(rH.docDate)} >= '${fromDate}' AND H.${q(rH.docDate)} <= '${toDate}' ` +
    `GROUP BY L.${q(rL.itemCode)}`;
  const rows = await executeSQL(sql);
  return rows.map(r => ({
    ItemCode: r.ItemCode, ItemDescription: '',
    NetSalesAmountLC: r.NetSalesAmountLC, GrossProfitLC: r.GrossProfitLC,
    QuantityInInventoryUoM: r.QuantityInInventoryUoM,
  }));
}

const PRICING_ITM1_CANDIDATES = { itemCode: ['ItemCode'], priceList: ['PriceList'], price: ['Price'], currency: ['Currency'] };

// Actual price of every item on the SELECTED price list (ITM1) — this is what
// the recommendation must be based on, since it is what apply writes back to.
async function fetchListPricesViaDB(priceListNum) {
  const cfg    = getActiveConfig();
  const isHana = getActiveType() === 'hana';
  const q      = n => qcol(n, isHana);
  const cols   = await getTableColumns('ITM1');
  const { resolved, missing } = resolveFieldMap(cols, PRICING_ITM1_CANDIDATES);
  if (missing.length) throw new Error(`ITM1 field mapping incomplete: ${missing.join(', ')}`);

  const sql = `SELECT ${q(resolved.itemCode)} AS ${q('ItemCode')}, ${q(resolved.price)} AS ${q('Price')}, ` +
    `${q(resolved.currency)} AS ${q('Currency')} FROM ${tableRef('ITM1', cfg)} ` +
    `WHERE ${q(resolved.priceList)} = ${Number(priceListNum)}`;
  const rows = await executeSQL(sql);
  return new Map(rows.map(r => [r.ItemCode, { price: Number(r.Price || 0), currency: r.Currency || '' }]));
}

// Writes one item's price on one price list the same way a manual edit in the
// SAP item master / price list window does, then reads it back to confirm SAP
// actually stored it. Always via Service Layer — DB Direct is SELECT-only.
async function applyPriceListPrice(sap, itemCode, priceListNum, newPrice) {
  const listNo = Number(priceListNum);
  const price  = Math.round(Number(newPrice) * 1e6) / 1e6;
  if (!itemCode || !listNo || !Number.isFinite(price) || price < 0)
    throw new Error('Valid itemCode, priceListNum and newPrice are required');

  const path = `/Items('${esc(itemCode)}')`;
  const [item, list] = await Promise.all([
    sap.get(path, { $select: 'ItemCode,ItemPrices' }),
    sap.get(`/PriceLists(${listNo})`).catch(() => null),
  ]);
  const line = (item.ItemPrices || []).find(p => Number(p.PriceList) === listNo);
  if (!line) throw new Error(`Price list ${listNo} not found on item ${itemCode}`);

  const oldPrice = Number(line.Price || 0);
  const update = { PriceList: listNo, Price: price };
  const currency = line.Currency || list?.DefaultPrimeCurrency;
  if (currency) update.Currency = currency;
  // A list derived from another list (Factor x base) would recalculate over a
  // plain Price write. Pointing the line's base at itself makes it a manual
  // price — what SAP does when you overwrite a derived price by hand.
  const base = Number(line.BasePriceList ?? list?.BasePriceList ?? listNo);
  if (base && base !== listNo) { update.BasePriceList = listNo; update.Factor = 1; }

  await sap.patch(path, { ItemPrices: [update] });

  const after = await sap.get(path, { $select: 'ItemPrices' });
  const saved = (after.ItemPrices || []).find(p => Number(p.PriceList) === listNo);
  const savedPrice = Number(saved?.Price);
  if (!saved || Math.abs(savedPrice - price) > 0.005)
    throw new Error(`SAP did not store the new price for ${itemCode} on price list ${listNo} (now ${saved ? savedPrice : 'n/a'})`);

  return {
    itemCode, priceListNum: listNo, priceListName: list?.PriceListName || '',
    oldPrice, newPrice: savedPrice, currency: saved.Currency || currency || '',
  };
}

const PRICING_OPLN_CANDIDATES = { listNum: ['ListNum'], listName: ['ListName'], currency: ['PrimCurr'] };

async function fetchPriceListsViaDB() {
  const cfg    = getActiveConfig();
  const isHana = getActiveType() === 'hana';
  const q      = n => qcol(n, isHana);
  const cols   = await getTableColumns('OPLN');
  const { resolved, missing } = resolveFieldMap(cols, PRICING_OPLN_CANDIDATES);
  if (missing.length) throw new Error(`OPLN field mapping incomplete: ${missing.join(', ')}`);

  const sql = `SELECT ${q(resolved.listNum)} AS ${q('PriceListNo')}, ${q(resolved.listName)} AS ${q('PriceListName')}, ` +
    `${q(resolved.currency)} AS ${q('Currency')} FROM ${tableRef('OPLN', cfg)} ORDER BY ${q(resolved.listNum)}`;
  return executeSQL(sql);
}

// Core pricing analysis — shared by the GET /analysis route and the get_pricing_recommendations
// chat tool, so both use identical logic regardless of how they're invoked.
async function runPricingAnalysis(sap, { priceListNum = 1, marginTarget = 30 } = {}, { callSMLSVCPost, buildParamList, aggregateRows }) {
    const today    = new Date();
    const fromDate = new Date(today);
    fromDate.setFullYear(fromDate.getFullYear() - 1);
    const fromStr  = fromDate.toISOString().slice(0, 10).replace(/-/g, '');
    const toStr    = today.toISOString().slice(0, 10).replace(/-/g, '');

    // ── Step 1: fetch all sale items + sales signals — DB Direct (ODBC/HANA)
    //    preferred, Service Layer/SMLSVC fallback ─────────────────────────────
    const slFrom = fromDate.toISOString().slice(0, 10);
    const slTo   = today.toISOString().slice(0, 10);

    let items, salesRows, listPrices, source = 'service-layer';
    if (isConnected()) {
      try {
        [items, salesRows, listPrices] = await Promise.all([
          fetchPricingItemsViaDB(),
          fetchSalesSignalsViaDB(slFrom, slTo),
          fetchListPricesViaDB(priceListNum),
        ]);
        source = getActiveType();
      } catch (dbErr) {
        console.warn('[Pricing/analysis] DB Direct failed, falling back to Service Layer:', dbErr.message);
      }
    }
    if (!items) {
      const [itemsR, salesRowsR] = await Promise.allSettled([
        sap.get("/Items", {
          $filter: "SalesItem eq 'tYES' and Frozen eq 'tNO'",
          $select: "ItemCode,ItemName,ItemsGroupCode,QuantityOnStock,MinInventory,MaxInventory,AvgStdPrice,ItemPrices",
          $top: 1000,
        }),
        callSMLSVCPost("sales", buildParamList({ fromDate: fromStr, toDate: toStr })).catch(() => []),
      ]);
      items     = itemsR.status === 'fulfilled' ? (itemsR.value?.value || []) : [];
      salesRows = salesRowsR.status === 'fulfilled' ? (salesRowsR.value || []) : [];
      source    = 'service-layer';
      listPrices = new Map();
      for (const it of items) {
        const p = (it.ItemPrices || []).find(x => Number(x.PriceList) === Number(priceListNum));
        if (p) listPrices.set(it.ItemCode, { price: Number(p.Price || 0), currency: p.Currency || '' });
      }
    }
    const dataSource = `all sale items · signals from SO/PO activity (${slFrom} – ${slTo})`;

    // Aggregate sales by ItemCode
    const salesAgg = aggregateRows(salesRows, ["ItemCode", "ItemDescription"],
      ["NetSalesAmountLC", "GrossProfitLC", "QuantityInInventoryUoM"]);
    const salesMap  = new Map(salesAgg.map(r => [r.ItemCode, r]));

    const result = [];
    for (const it of items) {
      const onHand    = Number(it.QuantityOnStock || 0);
      const minStock  = Number(it.MinInventory    || 0);
      const maxStock  = Number(it.MaxInventory    || 0);
      const costPrice = Number(it.AvgStdPrice || 0);

      const sales    = salesMap.get(it.ItemCode) || {};
      const revenue  = Number(sales.NetSalesAmountLC          || 0);
      const quantity = Number(sales.QuantityInInventoryUoM    || 0);
      const gp       = Number(sales.GrossProfitLC             || 0);
      const gpPct    = Number(sales.GPMarginPct               || 0);

      // ── Current price derivation (five tiers — selected price list first) ────
      const avgSellingPrice = revenue > 0 && quantity > 0 ? revenue / quantity : 0;
      const impliedPrice    = costPrice > 0 ? costPrice / (1 - marginTarget / 100) : 0;
      const listEntry       = listPrices.get(it.ItemCode);
      const listPrice       = listEntry?.price || 0;
      let currentPrice, priceSource;
      if (listPrice > 0) {
        currentPrice = listPrice;
        priceSource  = `Price list ${priceListNum} price`;
      } else if (avgSellingPrice > 0) {
        currentPrice = avgSellingPrice;
        priceSource  = 'Avg realized selling price (last 12 months)';
      } else if (costPrice > 0) {
        currentPrice = costPrice;          // treat cost as floor price
        priceSource  = 'Cost price (no selling price available — priced at cost)';
      } else if (onHand > 0) {
        currentPrice = 1;                  // nominal placeholder for unpriced stock
        priceSource  = 'Unpriced stock — no cost or sales data';
      } else {
        continue;                          // truly no data — skip
      }

      // No price-list price and no sales in 12 months: there is no selling price to adjust yet.
      const hasSellingPrice = listPrice > 0 || avgSellingPrice > 0;
      const calcMarginPct = costPrice > 0 && currentPrice > 0
        ? ((currentPrice - costPrice) / currentPrice) * 100 : gpPct;
      const marginGap = calcMarginPct - marginTarget;

      // ── Demand signal (lower thresholds for smaller companies) ───────────────
      let demandSignal, demandReason;
      if (quantity > 200)     { demandSignal = 'high';   demandReason = `${Math.round(quantity)} units sold in last 12 months — high velocity`; }
      else if (quantity > 30) { demandSignal = 'medium'; demandReason = `${Math.round(quantity)} units sold in last 12 months — moderate velocity`; }
      else if (quantity > 0)  { demandSignal = 'low';    demandReason = `Only ${Math.round(quantity)} units sold in last 12 months — slow moving`; }
      else                    { demandSignal = 'none';   demandReason = 'No sales recorded in last 12 months'; }

      // ── Inventory signal ──────────────────────────────────────────────────────
      let inventorySignal, inventoryReason;
      if (maxStock > 0 && onHand > maxStock * 1.1) {
        inventorySignal = 'overstocked';
        inventoryReason = `${onHand} on hand exceeds max stock of ${maxStock} (overstocked ${Math.round(((onHand / maxStock) - 1) * 100)}%)`;
      } else if (minStock > 0 && onHand < minStock) {
        inventorySignal = 'understocked';
        inventoryReason = `${onHand} on hand is below minimum stock of ${minStock}`;
      } else if (onHand === 0) {
        inventorySignal = 'zero_stock';
        inventoryReason = 'Zero stock on hand';
      } else {
        inventorySignal = 'normal';
        inventoryReason = `${onHand} on hand${minStock > 0 ? ` (min: ${minStock}${maxStock > 0 ? `, max: ${maxStock}` : ''})` : ''}`;
      }

      // ── Margin signal (tighter band = more items flagged) ────────────────────
      let marginSignal, marginReason;
      if (marginGap < -2) {
        marginSignal = 'below_target';
        marginReason = `GP ${calcMarginPct.toFixed(1)}% is ${Math.abs(marginGap).toFixed(1)}% below target of ${marginTarget}%`;
      } else if (marginGap > 8) {
        marginSignal = 'above_target';
        marginReason = `GP ${calcMarginPct.toFixed(1)}% is ${marginGap.toFixed(1)}% above target — possible room to reduce`;
      } else {
        marginSignal = 'on_target';
        marginReason = `GP ${calcMarginPct.toFixed(1)}% is near target of ${marginTarget}%`;
      }

      // ── Competitor / benchmark signal ─────────────────────────────────────────
      const benchmarkGP    = 35;
      const SEVERE_MARGIN_GAP = 10;   // margin gap (points) above which Margin Recovery applies instead of Margin Improvement
      const priceVsCost    = costPrice > 0 ? currentPrice / costPrice : 1;
      // discount depth: how far avg selling price is below the implied (target-margin) price
      const discountDepth  = impliedPrice > 0 && avgSellingPrice > 0
        ? ((impliedPrice - avgSellingPrice) / impliedPrice) * 100 : 0;
      let competitorSignal, competitorReason;
      if (discountDepth > 15) {
        competitorSignal = 'discount_heavy';
        competitorReason = `Customers receiving avg ${discountDepth.toFixed(1)}% discount below target price — margin leakage`;
      } else if (gpPct > 0 && gpPct < benchmarkGP - 5) {
        competitorSignal = 'underpriced';
        competitorReason = `Realized GP ${gpPct.toFixed(1)}% is below industry benchmark ~${benchmarkGP}% — possibly underpriced vs market`;
      } else if (demandSignal === 'none' && (inventorySignal === 'overstocked' || onHand > 0)) {
        competitorSignal = 'overpriced';
        competitorReason = 'No recent demand with stock on hand — suggests market price pressure or obsolescence';
      } else {
        competitorSignal = 'competitive';
        competitorReason = `Price-to-cost ratio ${priceVsCost.toFixed(2)}x within competitive range`;
      }

      // ── Final recommendation (9 scenarios) ───────────────────────────────────
      let recommendation, changePct, reason, scenario;

      // 1. Price establishment: no price-list price and no sales → set the first price at the
      //    target margin (cost ÷ (1 − target)); without a cost the price must be set manually.
      if (!hasSellingPrice) {
        scenario = 'Price Establishment';
        if (costPrice > 0) {
          recommendation = 'increase'; changePct = (1 / (1 - marginTarget / 100) - 1) * 100;
          reason = `No selling price yet — set the first price at cost ÷ (1 − ${marginTarget}%) = ${marginTarget}% margin`;
        } else {
          recommendation = 'hold'; changePct = 0;
          reason = 'No price, no sales and no cost in SAP — set the price manually';
        }

      // 2. Dead stock: has stock, zero sales for 12 months → aggressive price cut
      } else if (demandSignal === 'none' && onHand > 0 && inventorySignal !== 'zero_stock') {
        recommendation = 'decrease'; changePct = -15;
        scenario = 'Dead Stock';
        reason = `No sales in 12 months with ${onHand} units on hand — aggressive price reduction to clear dead stock`;

      // 3. Discount heavy: customers consistently getting large discounts → recover margin
      } else if (competitorSignal === 'discount_heavy') {
        recommendation = 'increase'; changePct = Math.min(15, discountDepth * 0.7);
        scenario = 'Discount Recovery';
        reason = `Avg ${discountDepth.toFixed(1)}% discount below target price — increase list price to recover margin leakage`;

      // 4. Margin far below target (more than SEVERE_MARGIN_GAP points) → strong price increase
      } else if (marginSignal === 'below_target' && marginGap < -SEVERE_MARGIN_GAP) {
        recommendation = 'increase'; changePct = Math.min(20, Math.abs(marginGap) * 1.3);
        scenario = 'Margin Recovery';
        reason = `GP ${calcMarginPct.toFixed(1)}% is ${Math.abs(marginGap).toFixed(1)}% below ${marginTarget}% target — price increase required`;

      // 5. Shortage pricing: high demand + understocked → increase while supply is tight
      } else if (demandSignal === 'high' && inventorySignal === 'understocked') {
        recommendation = 'increase'; changePct = 8;
        scenario = 'Shortage Pricing';
        reason = `High demand (${Math.round(quantity)} units/yr) with stock below minimum — increase price to manage demand during shortage`;

      // 6. Strong demand + healthy stock → capture value
      } else if (demandSignal === 'high' && inventorySignal !== 'understocked' && marginSignal !== 'above_target') {
        recommendation = 'increase'; changePct = 5;
        scenario = 'Demand Capture';
        reason = `Strong demand signal — price increase to capture value while demand is high`;

      // 7. Margin moderately below target (2–SEVERE_MARGIN_GAP points) with sales → partial increase
      } else if (marginSignal === 'below_target' && demandSignal !== 'none') {
        recommendation = 'increase'; changePct = Math.min(10, Math.abs(marginGap));
        scenario = 'Margin Improvement';
        reason = `Margin ${Math.abs(marginGap).toFixed(1)}% below target with ${demandSignal} demand — partial price increase`;

      // 8. Overstocked + weak demand → clear inventory (no-demand items are already Dead Stock)
      } else if (inventorySignal === 'overstocked' && demandSignal !== 'high') {
        recommendation = 'decrease'; changePct = -7;
        scenario = 'Overstock Clearance';
        reason = `Inventory above maximum with ${demandSignal} demand — reduce price to accelerate stock movement`;

      // 9. Underpriced vs market benchmark
      } else if (competitorSignal === 'underpriced' && demandSignal !== 'none') {
        recommendation = 'increase'; changePct = 8;
        scenario = 'Market Alignment';
        reason = `Realized margin ${gpPct.toFixed(1)}% below industry benchmark ~${benchmarkGP}% — align price with market`;

      // Hold: balanced
      } else {
        recommendation = 'hold'; changePct = 0;
        scenario = 'Balanced';
        reason = 'Pricing is balanced across demand, inventory and margin signals — no adjustment needed';
      }

      const suggestedPrice = Math.round(currentPrice * (1 + changePct / 100) * 100) / 100;

      // "How is this calculated?" popup — built from the same variables as the rules above.
      const _f = (n, d = 2) => Number(n || 0).toLocaleString('en-GB', { maximumFractionDigits: d });
      const chgFormula = {
        'Dead Stock':          'Fixed −15% (clear dead stock)',
        'Discount Recovery':   `Discount depth ${_f(discountDepth, 1)}% × 0.7, max 15%`,
        'Margin Recovery':     `Margin gap ${_f(Math.abs(marginGap), 1)}% (more than ${SEVERE_MARGIN_GAP}%) × 1.3, max 20%`,
        'Shortage Pricing':    'Fixed +8%',
        'Demand Capture':      'Fixed +5%',
        'Margin Improvement':  `Margin gap ${_f(Math.abs(marginGap), 1)}%, max 10%`,
        'Overstock Clearance': 'Fixed −7%',
        'Market Alignment':    'Fixed +8%',
        'Price Establishment': costPrice > 0 ? `Cost ${_f(costPrice)} ÷ (1 − ${marginTarget}%) = ${marginTarget}% margin` : 'No cost — set the price manually',
        'Balanced':            'No change (0%)',
      }[scenario];
      const pricingSteps = [
        { label: 'Current price', formula: priceSource, value: _f(currentPrice) },
        { label: 'Demand (units sold, 12 months)', formula: '>200 high · >30 medium · >0 low · 0 none', value: `${_f(quantity, 0)} → ${demandSignal}` },
        { label: 'Inventory', formula: `On hand ${_f(onHand)} vs min ${_f(minStock)} / max ${_f(maxStock)} (overstocked above max + 10%)`, value: inventorySignal },
        { label: 'Margin', formula: costPrice > 0 ? `(Price ${_f(currentPrice)} − cost ${_f(costPrice)}) ÷ price; target ${marginTarget}% (below if gap < −2%, above if > +8%)` : `Realized GP%; target ${marginTarget}%`, value: `${_f(calcMarginPct, 1)}% (gap ${_f(marginGap, 1)}%) → ${marginSignal}` },
        { label: 'Discount / benchmark', formula: `Discount depth (target-margin price vs avg selling price) >15% = discount heavy; realized GP below ${benchmarkGP - 5}% = underpriced`, value: `${_f(discountDepth, 1)}% / GP ${_f(gpPct, 1)}% → ${competitorSignal}` },
        { label: 'Change %', formula: `${scenario}: ${chgFormula}`, value: `${Math.round(changePct * 10) / 10}%` },
        { label: 'Suggested price', formula: `Current ${_f(currentPrice)} × (1 + ${Math.round(changePct * 10) / 10}%), rounded to 2 decimals`, value: _f(suggestedPrice) },
      ];
      const pricingRules = [
        ['Price Establishment', 'No price-list price and no sales in 12 months', `Cost ÷ (1 − ${marginTarget}%); no cost → set manually`],
        ['Dead Stock', 'No sales in 12 months and stock on hand', '−15%'],
        ['Discount Recovery', 'Avg discount more than 15% below target-margin price', '+ discount × 0.7 (max 15%)'],
        ['Margin Recovery', `Margin more than ${SEVERE_MARGIN_GAP}% below target`, '+ gap × 1.3 (max 20%)'],
        ['Shortage Pricing', 'High demand and stock below minimum', '+8%'],
        ['Demand Capture', 'High demand, stock not short, margin not above target', '+5%'],
        ['Margin Improvement', `Margin 2–${SEVERE_MARGIN_GAP}% below target and some sales`, '+ gap (max 10%)'],
        ['Overstock Clearance', 'Stock above max + 10% and demand low or medium', '−7%'],
        ['Market Alignment', `Realized GP below ${benchmarkGP - 5}% benchmark and some demand`, '+8%'],
        ['Balanced', 'None of the above', 'Hold (0%)'],
      ].map(([sc, rule, res], i) => ({ rule: `${i < 9 ? i + 1 + '. ' : ''}${sc}: ${rule}`, result: res, hit: sc === scenario }));
      const pricingExplain = {
        title: `How the suggested price is calculated — ${scenario}`,
        steps: pricingSteps,
        rules: pricingRules,
        note: 'Rules are checked in order 1 → 9; the first one that matches decides the change.',
      };

      result.push({
        itemCode: it.ItemCode,
        itemName: it.ItemName,
        itemGroup: it.ItemsGroupCode || '',
        priceListNum,
        currentPrice,
        suggestedPrice,
        changePct: Math.round(changePct * 10) / 10,
        recommendation,
        scenario,
        reason,
        explain: { suggestedPrice: pricingExplain },  // also used for Change % / Recommendation in the UI
        currency: listEntry?.currency || '',
        listPrice,
        priceSource,
        factors: {
          demand: {
            signal: demandSignal, reason: demandReason,
            revenue: Math.round(revenue), quantity: Math.round(quantity), gp: Math.round(gp),
            source: source === 'service-layer'
              ? 'SAP B1 Sales Analysis via SMLSVC (last 12 months)'
              : `SAP B1 Sales Analysis via ${source.toUpperCase()} Direct (last 12 months)`,
          },
          inventory: {
            signal: inventorySignal, reason: inventoryReason,
            onHand, minStock, maxStock,
            source: 'SAP B1 Item Warehouse Stock',
          },
          margin: {
            signal: marginSignal, reason: marginReason,
            currentPct: Math.round(calcMarginPct * 10) / 10,
            targetPct: marginTarget,
            gap: Math.round(marginGap * 10) / 10,
            costPrice,
            source: `SAP B1 cost vs ${priceSource}`,
          },
          competitor: {
            signal: competitorSignal, reason: competitorReason,
            realizedGP: Math.round(gpPct * 10) / 10,
            priceVsCost: Math.round(priceVsCost * 100) / 100,
            source: 'Internal Benchmark — Realized GP vs Industry Average (~35%)',
          },
        },
      });
    }

    // Decreases first, then increases, then holds; biggest change first within each group.
    // (`??` not `||`: decrease has rank 0, which `||` treated as "unknown" and sorted last.)
    const ord = { decrease: 0, increase: 1, hold: 2 };
    result.sort((a, b) => ((ord[a.recommendation] ?? 3) - (ord[b.recommendation] ?? 3))
      || (Math.abs(b.changePct) - Math.abs(a.changePct)));

    return {
      items: result,
      summary: {
        total:    result.length,
        increase: result.filter(r => r.recommendation === 'increase').length,
        decrease: result.filter(r => r.recommendation === 'decrease').length,
        hold:     result.filter(r => r.recommendation === 'hold').length,
        avgChange: result.length > 0
          ? Math.round(result.reduce((s, r) => s + r.changePct, 0) / result.length * 10) / 10
          : 0,
      },
      priceListNum,
      marginTarget,
      analysisDate: today.toISOString().slice(0, 10),
      periodFrom: slFrom,
      periodTo:   slTo,
      dataSource,
      source,
    };
}

const _pricingChatSessions = new Map();

const PRICING_GPT_TOOLS = [
  { type:"function", function:{ name:"get_pricing_recommendations",
    description:"Get AI pricing recommendations for items — demand, inventory, margin and competitor signals with suggested price changes. Returns up to `limit` items, sorted by largest absolute suggested change first.",
    parameters:{ type:"object", properties:{
      recommendation: { type:"string", enum:["increase","decrease","hold","all"], description:"Filter by recommendation type. Default: all" },
      itemCode:      { type:"string", description:"Filter to one specific item code" },
      priceList:     { type:"integer", description:"Price list number to price against (default 1)" },
      marginTarget:  { type:"number", description:"Target gross margin % (default 30)" },
      limit:         { type:"integer", description:"Max items to return (default 20, max 100)" },
    } } } },
  { type:"function", function:{ name:"get_price_lists",
    description:"Get all SAP B1 price lists — number, name, currency.",
    parameters:{ type:"object", properties:{} } } },
  { type:"function", function:{ name:"apply_price_change",
    description:"Apply a new price to an item on a specific price list in SAP B1. This WRITES to SAP — only call after the user has explicitly confirmed the exact item code, price list number, and new price.",
    parameters:{ type:"object", properties:{
      itemCode:     { type:"string" },
      priceListNum: { type:"integer" },
      newPrice:     { type:"number" },
    }, required:["itemCode","priceListNum","newPrice"] } } },
];

async function executePricingTool(name, args, sap, smlsvcDeps) {
  if (name === 'get_pricing_recommendations') {
    const priceListNum = parseInt(args.priceList) || 1;
    const marginTarget = parseFloat(args.marginTarget) || 30;
    const limit = Math.min(parseInt(args.limit) || 20, 100);
    const data = await runPricingAnalysis(sap, { priceListNum, marginTarget }, smlsvcDeps);
    let items = data.items;
    if (args.itemCode) items = items.filter(i => i.itemCode === args.itemCode);
    else if (args.recommendation && args.recommendation !== 'all') items = items.filter(i => i.recommendation === args.recommendation);
    items = [...items].sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct)).slice(0, limit).map(({ explain, ...i }) => i);
    return { items, summary: data.summary, priceListNum, marginTarget, source: data.source, totalMatching: items.length };
  }
  if (name === 'get_price_lists') {
    if (isConnected()) {
      try { return { priceLists: await fetchPriceListsViaDB(), source: getActiveType() }; }
      catch { /* fall through to SL */ }
    }
    const r = await sap.get("/PriceLists", { $select: "PriceListNo,PriceListName,Currency", $top: 50 });
    return { priceLists: r.value || [], source: 'service-layer' };
  }
  if (name === 'apply_price_change') {
    const r = await applyPriceListPrice(sap, args.itemCode, args.priceListNum, args.newPrice);
    return { applied: true, ...r };
  }
  return { error: `Unknown pricing tool: ${name}` };
}

export function createPricingAgentRouter(deps) {
  const { requireAuth, getActiveSap, gptChatComplete, callSMLSVCPost, buildParamList, aggregateRows } = deps;
  const smlsvcDeps = { callSMLSVCPost, buildParamList, aggregateRows };
  const router = Router();

  // GET /pricelists
  router.get('/pricelists', requireAuth, async (req, res) => {
    try {
      let priceLists, source = 'service-layer';
      if (isConnected()) {
        try {
          priceLists = await fetchPriceListsViaDB();
          source = getActiveType();
        } catch (dbErr) {
          console.warn('[Pricing/pricelists] DB Direct failed, falling back to Service Layer:', dbErr.message);
        }
      }
      if (!priceLists) {
        const sap = getActiveSap();
        const r = await sap.get("/PriceLists", { $select: "PriceListNo,PriceListName,Currency", $top: 50 });
        priceLists = r.value || [];
        source = 'service-layer';
      }
      res.json({ ok: true, priceLists, source });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // GET /analysis
  router.get('/analysis', requireAuth, async (req, res) => {
    try {
      const sap = getActiveSap();
      const priceListNum = parseInt(req.query.priceList)      || 1;
      const marginTarget = parseFloat(req.query.marginTarget) || 30;
      const data = await runPricingAnalysis(sap, { priceListNum, marginTarget }, smlsvcDeps);
      res.json({ ok: true, ...data });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // POST /apply
  // Always via Service Layer: DB Direct (executeSQL) is SELECT-only by design, so writes
  // (price list updates) cannot go through ODBC/HANA regardless of which source read the data.
  router.post('/apply', requireAuth, async (req, res) => {
    try {
      const { itemCode, priceListNum, newPrice } = req.body;
      if (!itemCode || !priceListNum || newPrice == null)
        return res.status(400).json({ ok: false, error: 'itemCode, priceListNum, and newPrice are required' });
      const r = await applyPriceListPrice(getActiveSap(), itemCode, priceListNum, newPrice);
      const listLabel = r.priceListName ? `${r.priceListName} (${r.priceListNum})` : `price list ${r.priceListNum}`;
      res.json({ ok: true, ...r,
        message: `Price updated for ${itemCode} on ${listLabel}: ${r.oldPrice.toFixed(2)} → ${r.newPrice.toFixed(2)}${r.currency ? ' ' + r.currency : ''}` });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // POST /chat — GPT-4o tool-calling agent (live SAP/HANA data, not just
  // the frontend's last-scan context blob), same pattern as the MRP/Production
  // agents' chat.
  router.post('/chat', requireAuth, async (req, res) => {
    try {
      const { message, sessionId = `pricing_${Date.now()}` } = req.body;
      if (!message?.trim()) return res.status(400).json({ ok: false, error: 'message required' });
      const sap = getActiveSap();
      const today = new Date().toISOString().slice(0, 10);

      const history = _pricingChatSessions.get(sessionId) || [];
      history.push({ role: 'user', content: message });
      if (history.length > 20) history.splice(0, history.length - 20);
      _pricingChatSessions.set(sessionId, history);

      const systemPrompt = `You are a Dynamic Pricing AI analyst for SAP Business One. You optimize price lists based on demand signals, inventory levels, margin targets, and market benchmarks.
Today is ${today}. Always call get_pricing_recommendations (or get_price_lists) to fetch live data before answering — never guess numbers or recommend a price change without having pulled the current analysis first.
Be concise and data-driven: reference specific item codes, percentages, and scenario names (e.g. "Dead Stock", "Margin Recovery"). Before calling apply_price_change, restate the item, price list, and new price and get explicit confirmation from the user unless they already gave it in this message.`;

      const messages = [{ role:"system", content: systemPrompt }, ...history];
      let response = null;
      for (let i = 0; i < 10; i++) {
        const body = { messages, tools: PRICING_GPT_TOOLS, tool_choice:"auto", max_tokens:1500, temperature:0.2 };
        const raw = await gptChatComplete(body);
        const choice = raw?.choices?.[0];
        if (!choice) throw new Error('No response from AI');
        const msg = choice.message;
        messages.push(msg);
        if (choice.finish_reason === 'tool_calls' && msg.tool_calls?.length) {
          const toolResults = await Promise.all(msg.tool_calls.map(async tc => {
            let args = {};
            try { args = JSON.parse(tc.function.arguments || '{}'); } catch {}
            let result;
            try { result = await executePricingTool(tc.function.name, args, sap, smlsvcDeps); }
            catch(e) { result = { error: e.message }; }
            return { role:"tool", tool_call_id: tc.id, content: JSON.stringify(result) };
          }));
          messages.push(...toolResults);
        } else {
          response = msg.content || '';
          break;
        }
      }
      if (!response) response = "Unable to complete that request. Please try again.";
      history.push({ role:"assistant", content: response });
      res.json({ ok: true, reply: response, sessionId });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  return router;
}
