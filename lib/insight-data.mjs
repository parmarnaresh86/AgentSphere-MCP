// Shared SAP B1 dataset loaders for the insight agents (see insight-kit.mjs).
// All reads are plain SELECTs through DB Direct; every column is verified with
// k.need() first. Rows are normalised to camelCase JS objects with ISO dates
// and numeric amounts so the agents never touch dialect-specific values.
import { isoDate, num, addDays } from './insight-kit.mjs';

const inList = (k, vals) => vals.map(v => k.lit(v)).join(',');

async function chunked(vals, size, fn) {
  const out = [];
  for (let i = 0; i < vals.length; i += size) out.push(...await fn(vals.slice(i, i + size)));
  return out;
}

// ── Business partners ────────────────────────────────────────────────────────
export async function loadPartners(k, cardType /* 'C' | 'S' */) {
  const cols = ['CardCode', 'CardName', 'CardType', 'CreditLine', 'Balance', 'OrdersBal', 'DNotesBal',
    'GroupNum', 'Phone1', 'E_Mail', 'CntctPrsn', 'SlpCode', 'frozenFor'];
  await k.need('OCRD', cols);
  const rows = await k.run(`SELECT ${cols.map(c => `{${c}}`).join(', ')} FROM @OCRD WHERE {CardType} = ${k.lit(cardType)}`);
  const map = new Map();
  for (const r of rows) {
    map.set(r.CardCode, {
      cardCode: r.CardCode, cardName: r.CardName || '', creditLimit: num(r.CreditLine),
      balance: num(r.Balance), ordersBal: num(r.OrdersBal), dnotesBal: num(r.DNotesBal),
      groupNum: r.GroupNum, phone: r.Phone1 || '', email: r.E_Mail || '', contact: r.CntctPrsn || '',
      slpCode: r.SlpCode, frozen: r.frozenFor === 'Y',
    });
  }
  return map;
}

// Payment terms → net days (ExtraMonth counted as 30 days).
export async function loadPaymentTerms(k) {
  await k.need('OCTG', ['GroupNum', 'PymntGroup', 'ExtraMonth', 'ExtraDays']);
  const hasDisc = await k.has('OCTG', 'DiscCode');
  const rows = await k.run(`SELECT {GroupNum}, {PymntGroup}, {ExtraMonth}, {ExtraDays}${hasDisc ? ', {DiscCode}' : ''} FROM @OCTG`);
  const map = new Map();
  for (const r of rows) {
    map.set(String(r.GroupNum), {
      name: r.PymntGroup || '', days: num(r.ExtraMonth) * 30 + num(r.ExtraDays),
      discCode: hasDisc && r.DiscCode != null && String(r.DiscCode).trim() ? String(r.DiscCode).trim() : null,
    });
  }
  return map;
}

// Cash-discount tiers (OCDC header / CDC1 lines): code → [{ days, pct }] sorted
// by days. Empty map when the tables or columns are not present.
export async function loadCashDiscounts(k) {
  const map = new Map();
  for (const c of ['CdcCode', 'NumOfDays', 'Discount']) if (!(await k.has('CDC1', c))) return map;
  const rows = await k.run(`SELECT {CdcCode}, {NumOfDays}, {Discount} FROM @CDC1`);
  for (const r of rows) {
    const code = String(r.CdcCode ?? '').trim();
    const pct = num(r.Discount);
    if (!code || pct <= 0) continue;
    if (!map.has(code)) map.set(code, []);
    map.get(code).push({ days: num(r.NumOfDays), pct });
  }
  for (const tiers of map.values()) tiers.sort((a, z) => a.days - z.days);
  return map;
}
export const termDays = (terms, groupNum) => terms.get(String(groupNum))?.days ?? 30;

export async function loadSalesEmployees(k) {
  try {
    await k.need('OSLP', ['SlpCode', 'SlpName']);
    const rows = await k.run(`SELECT {SlpCode}, {SlpName} FROM @OSLP`);
    return new Map(rows.map(r => [String(r.SlpCode), r.SlpName || '']));
  } catch { return new Map(); }
}

// ── Open A/R or A/P invoices ─────────────────────────────────────────────────
// table: 'OINV' (A/R) or 'OPCH' (A/P)
export async function loadOpenInvoices(k, table) {
  const cols = ['DocEntry', 'DocNum', 'CardCode', 'CardName', 'DocDate', 'DocDueDate', 'DocTotal', 'PaidToDate',
    'SlpCode', 'GroupNum', 'DocStatus', 'CANCELED'];
  await k.need(table, cols);
  const hasBlock = await k.has(table, 'PayBlock');
  const rows = await k.run(`SELECT {DocEntry}, {DocNum}, {CardCode}, {CardName}, {DocDate}, {DocDueDate}, {DocTotal}, {PaidToDate}, {SlpCode}, {GroupNum}${hasBlock ? ', {PayBlock}' : ''}
    FROM @${table} WHERE {DocStatus} = 'O' AND {CANCELED} = 'N'`);
  return rows.map(r => ({
    docEntry: r.DocEntry, docNum: r.DocNum, cardCode: r.CardCode, cardName: r.CardName || '',
    docDate: isoDate(r.DocDate), dueDate: isoDate(r.DocDueDate) || isoDate(r.DocDate),
    total: num(r.DocTotal), paid: num(r.PaidToDate), balance: num(r.DocTotal) - num(r.PaidToDate),
    slpCode: r.SlpCode, groupNum: r.GroupNum, payBlocked: hasBlock && r.PayBlock === 'Y',
  })).filter(r => r.balance > 0.005);
}

// ── A/R payment behaviour ────────────────────────────────────────────────────
// For every A/R invoice closed by incoming payments since `since`: when it was
// due and when the last payment against it landed.
export function loadArPaymentHistory(k, since) {
  return loadPaymentHistory(k, since, { pay: 'ORCT', lines: 'RCT2', inv: 'OINV', invType: '13' });
}
// Same for A/P: when we actually paid each closed supplier invoice.
export function loadApPaymentHistory(k, since) {
  return loadPaymentHistory(k, since, { pay: 'OVPM', lines: 'VPM2', inv: 'OPCH', invType: '18' });
}

async function loadPaymentHistory(k, since, { pay, lines, inv, invType }) {
  await k.need(pay, ['DocEntry', 'DocDate', 'Canceled']);
  await k.need(lines, ['DocNum', 'DocEntry', 'InvType', 'SumApplied']);
  await k.need(inv, ['DocEntry', 'CardCode', 'DocDate', 'DocDueDate', 'DocTotal', 'DocStatus']);
  const rows = await k.run(`SELECT T2.{DocEntry} AS {DocEntry}, T2.{CardCode} AS {CardCode}, T2.{DocDate} AS {DocDate},
      T2.{DocDueDate} AS {DocDueDate}, T2.{DocTotal} AS {DocTotal}, MAX(T0.{DocDate}) AS {PayDate}
    FROM @${pay} T0
    INNER JOIN @${lines} T1 ON T1.{DocNum} = T0.{DocEntry}
    INNER JOIN @${inv} T2 ON T2.{DocEntry} = T1.{DocEntry}
    WHERE T1.{InvType} = '${invType}' AND T0.{Canceled} = 'N' AND T2.{DocStatus} = 'C' AND T2.{DocDate} >= ${k.lit(since)}
    GROUP BY T2.{DocEntry}, T2.{CardCode}, T2.{DocDate}, T2.{DocDueDate}, T2.{DocTotal}`);
  return rows.map(r => ({
    docEntry: r.DocEntry, cardCode: r.CardCode, docDate: isoDate(r.DocDate),
    dueDate: isoDate(r.DocDueDate) || isoDate(r.DocDate), payDate: isoDate(r.PayDate), total: num(r.DocTotal),
  }));
}

// Per-customer behaviour summary from loadArPaymentHistory rows.
export function summarisePaymentBehaviour(history, graceDays = 3) {
  const byCard = new Map();
  for (const h of history) {
    if (!h.payDate || !h.dueDate) continue;
    const late = (Date.parse(h.payDate) - Date.parse(h.dueDate)) / 86_400_000;
    const toPay = (Date.parse(h.payDate) - Date.parse(h.docDate)) / 86_400_000;
    const w = Math.max(h.total, 1);
    const b = byCard.get(h.cardCode) || { n: 0, w: 0, lateW: 0, toPayW: 0, onTime: 0, maxLate: 0 };
    b.n++; b.w += w; b.lateW += late * w; b.toPayW += toPay * w;
    if (late <= graceDays) b.onTime++;
    b.maxLate = Math.max(b.maxLate, late);
    byCard.set(h.cardCode, b);
  }
  const out = new Map();
  for (const [card, b] of byCard) {
    out.set(card, {
      paidInvoices: b.n,
      avgDaysLate: Math.round(b.lateW / b.w),
      avgDaysToPay: Math.round(b.toPayW / b.w),
      onTimeRate: Math.round((b.onTime / b.n) * 100),
      maxDaysLate: Math.round(b.maxLate),
    });
  }
  return out;
}

// Incoming payments per customer since a date (used to test promises-to-pay).
export async function loadIncomingPayments(k, since) {
  await k.need('ORCT', ['CardCode', 'DocDate', 'DocTotal', 'Canceled']);
  const rows = await k.run(`SELECT {CardCode}, {DocDate}, {DocTotal} FROM @ORCT WHERE {Canceled} = 'N' AND {DocDate} >= ${k.lit(since)}`);
  return rows.map(r => ({ cardCode: r.CardCode, date: isoDate(r.DocDate), amount: num(r.DocTotal) }));
}

// Net invoiced value per BP since a date (invoices minus credit memos).
export async function loadInvoicedByPartner(k, since, invTable = 'OINV', cmTable = 'ORIN') {
  await k.need(invTable, ['CardCode', 'DocTotal', 'DocDate', 'CANCELED']);
  const inv = await k.run(`SELECT {CardCode}, SUM({DocTotal}) AS {Total}, COUNT(*) AS {Cnt} FROM @${invTable}
    WHERE {CANCELED} = 'N' AND {DocDate} >= ${k.lit(since)} GROUP BY {CardCode}`);
  const map = new Map(inv.map(r => [r.CardCode, { total: num(r.Total), count: num(r.Cnt) }]));
  if (await k.has(cmTable, 'CardCode')) {
    const cm = await k.run(`SELECT {CardCode}, SUM({DocTotal}) AS {Total} FROM @${cmTable}
      WHERE {CANCELED} = 'N' AND {DocDate} >= ${k.lit(since)} GROUP BY {CardCode}`);
    for (const r of cm) {
      const e = map.get(r.CardCode) || { total: 0, count: 0 };
      e.total -= num(r.Total);
      map.set(r.CardCode, e);
    }
  }
  return map;
}

// ── Open marketing documents (header + open value) ───────────────────────────
// head/lines: ORDR/RDR1 (sales orders), OPOR/POR1 (purchase orders),
// OQUT/QUT1 (sales quotations). openValue is the remaining gross amount:
// the open line total grossed up by the document's total/lines ratio so VAT,
// freight and header discounts are carried proportionally.
export async function loadOpenDocs(k, head, lines) {
  await k.need(head, ['DocEntry', 'DocNum', 'CardCode', 'CardName', 'DocDate', 'DocDueDate', 'DocTotal',
    'SlpCode', 'GroupNum', 'UpdateDate', 'DocStatus', 'CANCELED']);
  await k.need(lines, ['DocEntry', 'OpenSum', 'LineTotal']);
  const rows = await k.run(`SELECT T0.{DocEntry} AS {DocEntry}, T0.{DocNum} AS {DocNum}, T0.{CardCode} AS {CardCode},
      T0.{CardName} AS {CardName}, T0.{DocDate} AS {DocDate}, T0.{DocDueDate} AS {DocDueDate}, T0.{DocTotal} AS {DocTotal},
      T0.{SlpCode} AS {SlpCode}, T0.{GroupNum} AS {GroupNum}, T0.{UpdateDate} AS {UpdateDate},
      SUM(T1.{OpenSum}) AS {OpenSum}, SUM(T1.{LineTotal}) AS {LinesTotal}
    FROM @${head} T0 INNER JOIN @${lines} T1 ON T1.{DocEntry} = T0.{DocEntry}
    WHERE T0.{DocStatus} = 'O' AND T0.{CANCELED} = 'N'
    GROUP BY T0.{DocEntry}, T0.{DocNum}, T0.{CardCode}, T0.{CardName}, T0.{DocDate}, T0.{DocDueDate}, T0.{DocTotal},
      T0.{SlpCode}, T0.{GroupNum}, T0.{UpdateDate}`);
  return rows.map(r => {
    const total = num(r.DocTotal), linesTotal = num(r.LinesTotal), openSum = num(r.OpenSum);
    const ratio = linesTotal > 0 ? total / linesTotal : 1;
    return {
      docEntry: r.DocEntry, docNum: r.DocNum, cardCode: r.CardCode, cardName: r.CardName || '',
      docDate: isoDate(r.DocDate), dueDate: isoDate(r.DocDueDate) || isoDate(r.DocDate), updateDate: isoDate(r.UpdateDate),
      total, openValue: linesTotal > 0 ? openSum * ratio : total, slpCode: r.SlpCode, groupNum: r.GroupNum,
    };
  });
}

// ── Items & stock ────────────────────────────────────────────────────────────
export async function loadItems(k) {
  const cols = ['ItemCode', 'ItemName', 'ItmsGrpCod', 'OnHand', 'IsCommited', 'OnOrder', 'MinLevel', 'MaxLevel',
    'AvgPrice', 'LastPurPrc', 'LeadTime', 'CardCode', 'InvntItem', 'PrchseItem', 'SellItem', 'frozenFor'];
  await k.need('OITM', cols);
  const rows = await k.run(`SELECT ${cols.map(c => `{${c}}`).join(', ')} FROM @OITM WHERE {InvntItem} = 'Y'`);
  let groups = new Map();
  if (await k.has('OITB', 'ItmsGrpNam')) {
    const g = await k.run(`SELECT {ItmsGrpCod}, {ItmsGrpNam} FROM @OITB`);
    groups = new Map(g.map(r => [String(r.ItmsGrpCod), r.ItmsGrpNam]));
  }
  const map = new Map();
  for (const r of rows) {
    map.set(r.ItemCode, {
      itemCode: r.ItemCode, itemName: r.ItemName || '', group: groups.get(String(r.ItmsGrpCod)) || String(r.ItmsGrpCod ?? ''),
      onHand: num(r.OnHand), committed: num(r.IsCommited), onOrder: num(r.OnOrder),
      minLevel: num(r.MinLevel), maxLevel: num(r.MaxLevel), avgPrice: num(r.AvgPrice), lastPurPrice: num(r.LastPurPrc),
      leadTime: num(r.LeadTime), prefVendor: r.CardCode || '', purchasable: r.PrchseItem === 'Y',
      sellable: r.SellItem === 'Y', frozen: r.frozenFor === 'Y',
    });
  }
  return map;
}

export async function loadWarehouseStock(k, { warehouse, onlyPositive = false } = {}) {
  await k.need('OITW', ['ItemCode', 'WhsCode', 'OnHand', 'IsCommited', 'OnOrder', 'MinStock', 'MaxStock']);
  const hasAvg = await k.has('OITW', 'AvgPrice');
  const conds = [];
  if (warehouse) conds.push(`{WhsCode} = ${k.lit(warehouse)}`);
  if (onlyPositive) conds.push(`{OnHand} > 0`);
  const rows = await k.run(`SELECT {ItemCode}, {WhsCode}, {OnHand}, {IsCommited}, {OnOrder}, {MinStock}, {MaxStock}${hasAvg ? ', {AvgPrice}' : ''}
    FROM @OITW${conds.length ? ` WHERE ${conds.join(' AND ')}` : ''}`);
  return rows.map(r => ({
    itemCode: r.ItemCode, whsCode: r.WhsCode, onHand: num(r.OnHand), committed: num(r.IsCommited),
    onOrder: num(r.OnOrder), minStock: num(r.MinStock), maxStock: num(r.MaxStock), avgPrice: hasAvg ? num(r.AvgPrice) : null,
  }));
}

// Demand movements from the inventory journal (OINM):
//   out: 13 A/R invoice, 15 delivery, 60 goods issue (incl. issue for production)
//   in (reduces demand): 14 A/R credit memo, 16 sales return
// Invoices based on deliveries post no OINM row, so nothing is double counted.
// Goods issues are included so raw/packing materials consumed by production
// are not mistaken for dead stock just because they are never sold.
export const DEMAND_OUT_TYPES = [13, 15, 60, 202];   // 202 = production order issues
export const DEMAND_IN_TYPES = [14, 16];

// Daily net demand quantity per item (and warehouse) since a date.
export async function loadDemandMovements(k, since, { warehouse, byWarehouse = false } = {}) {
  await k.need('OINM', ['ItemCode', 'DocDate', 'InQty', 'OutQty', 'TransType', 'Warehouse']);
  const types = [...DEMAND_OUT_TYPES, ...DEMAND_IN_TYPES].join(',');
  const conds = [`{TransType} IN (${types})`, `{DocDate} >= ${k.lit(since)}`];
  if (warehouse) conds.push(`{Warehouse} = ${k.lit(warehouse)}`);
  const whs = byWarehouse ? ', {Warehouse}' : '';
  const rows = await k.run(`SELECT {ItemCode}${whs}, {DocDate}, {TransType}, SUM({OutQty}) AS {OutQ}, SUM({InQty}) AS {InQ}
    FROM @OINM WHERE ${conds.join(' AND ')} GROUP BY {ItemCode}${whs}, {DocDate}, {TransType}`);
  return rows.map(r => ({
    itemCode: r.ItemCode, whsCode: byWarehouse ? r.Warehouse : null, date: isoDate(r.DocDate),
    // For issues only the outbound qty is demand — InQty on production rows is
    // finished-goods receipt, not a negative consumption.
    ...(() => { const issue = [60, 202].includes(Number(r.TransType));
      return { kind: issue ? 'issue' : 'sale', qty: num(r.OutQ) - (issue ? 0 : num(r.InQ)) }; })(),
  }));
}

// Last usage (sale or goods issue) and last movement of any kind per
// item+warehouse, all time.
export async function loadLastMovements(k) {
  await k.need('OINM', ['ItemCode', 'DocDate', 'TransType', 'Warehouse', 'OutQty']);
  const types = DEMAND_OUT_TYPES.join(',');
  const use = await k.run(`SELECT {ItemCode}, {Warehouse}, MAX({DocDate}) AS {LastDate} FROM @OINM
    WHERE {TransType} IN (${types}) AND {OutQty} > 0 GROUP BY {ItemCode}, {Warehouse}`);
  const any = await k.run(`SELECT {ItemCode}, {Warehouse}, MAX({DocDate}) AS {LastDate} FROM @OINM GROUP BY {ItemCode}, {Warehouse}`);
  // Items that have ever been sold (any warehouse) — lets callers tell
  // consumed-only raw/packing materials apart from finished goods.
  const soldEver = await k.run(`SELECT DISTINCT {ItemCode} FROM @OINM WHERE {TransType} IN (13, 15) AND {OutQty} > 0`);
  const key = (i, w) => `${i}${w}`;
  return {
    soldItems: new Set(soldEver.map(r => r.ItemCode)),
    lastUse: new Map(use.map(r => [key(r.ItemCode, r.Warehouse), isoDate(r.LastDate)])),
    lastMove: new Map(any.map(r => [key(r.ItemCode, r.Warehouse), isoDate(r.LastDate)])),
    key,
  };
}

// Open purchase-order quantity per item.
export async function loadOpenPoQtyByItem(k) {
  await k.need('POR1', ['ItemCode', 'OpenQty', 'LineStatus', 'DocEntry']);
  await k.need('OPOR', ['DocEntry', 'DocNum', 'CANCELED', 'DocStatus']);
  const rows = await k.run(`SELECT T1.{ItemCode} AS {ItemCode}, SUM(T1.{OpenQty}) AS {OpenQty}, COUNT(DISTINCT T0.{DocNum}) AS {PoCount}
    FROM @OPOR T0 INNER JOIN @POR1 T1 ON T1.{DocEntry} = T0.{DocEntry}
    WHERE T0.{DocStatus} = 'O' AND T0.{CANCELED} = 'N' AND T1.{LineStatus} = 'O'
    GROUP BY T1.{ItemCode}`);
  return new Map(rows.map(r => [r.ItemCode, { openQty: num(r.OpenQty), poCount: num(r.PoCount) }]));
}

// ── Sales price history (A/R invoice lines) ──────────────────────────────────
export async function loadSalesPriceHistory(k, since, itemCodes) {
  await k.need('INV1', ['DocEntry', 'ItemCode', 'Quantity', 'Price', 'StockPrice']);
  await k.need('OINV', ['DocEntry', 'DocNum', 'CardCode', 'DocDate', 'CANCELED']);
  if (!itemCodes.length) return [];
  return chunked(itemCodes, 200, async chunk => {
    const rows = await k.run(`SELECT T0.{DocNum} AS {DocNum}, T0.{CardCode} AS {CardCode}, T0.{DocDate} AS {DocDate},
        T1.{ItemCode} AS {ItemCode}, T1.{Quantity} AS {Quantity}, T1.{Price} AS {Price}, T1.{StockPrice} AS {StockPrice}
      FROM @OINV T0 INNER JOIN @INV1 T1 ON T1.{DocEntry} = T0.{DocEntry}
      WHERE T0.{CANCELED} = 'N' AND T0.{DocDate} >= ${k.lit(since)} AND T1.{ItemCode} IN (${inList(k, chunk)})`);
    return rows.map(r => ({
      docNum: r.DocNum, cardCode: r.CardCode, date: isoDate(r.DocDate), itemCode: r.ItemCode,
      qty: num(r.Quantity), price: num(r.Price), cost: num(r.StockPrice),
    }));
  });
}

// ── Purchase lines (A/P invoice) for vendor price comparisons ────────────────
export async function loadPurchasePriceHistory(k, since) {
  await k.need('PCH1', ['DocEntry', 'ItemCode', 'Quantity', 'Price', 'LineTotal']);
  await k.need('OPCH', ['DocEntry', 'DocNum', 'CardCode', 'DocDate', 'CANCELED']);
  const rows = await k.run(`SELECT T0.{DocNum} AS {DocNum}, T0.{CardCode} AS {CardCode}, T0.{DocDate} AS {DocDate},
      T1.{ItemCode} AS {ItemCode}, T1.{Quantity} AS {Quantity}, T1.{Price} AS {Price}, T1.{LineTotal} AS {LineTotal}
    FROM @OPCH T0 INNER JOIN @PCH1 T1 ON T1.{DocEntry} = T0.{DocEntry}
    WHERE T0.{CANCELED} = 'N' AND T0.{DocDate} >= ${k.lit(since)} AND T1.{ItemCode} IS NOT NULL`);
  return rows.map(r => ({
    docNum: r.DocNum, cardCode: r.CardCode, date: isoDate(r.DocDate), itemCode: r.ItemCode,
    qty: num(r.Quantity), price: num(r.Price), lineTotal: num(r.LineTotal),
  }));
}

// ── Cash & bank balance (G/L accounts flagged as cash accounts) ─────────────
export async function loadCashBalance(k) {
  try {
    await k.need('OACT', ['Finanse', 'CurrTotal', 'Postable']);
    const r = await k.run(`SELECT SUM({CurrTotal}) AS {Bal}, COUNT(*) AS {Cnt} FROM @OACT WHERE {Finanse} = 'Y' AND {Postable} = 'Y'`);
    return { balance: num(r[0]?.Bal), accounts: num(r[0]?.Cnt) };
  } catch { return { balance: 0, accounts: 0 }; }
}

export const since = (asOf, days) => addDays(asOf, -days);

// ── Sales lines with revenue & cost (profitability / margin / commission) ────
// A/R invoice lines (INV1) and, optionally, A/R credit-memo lines (RIN1, sign
// −1) posted between from..to. Revenue is the line total in local currency
// after the header discount; cost is the gross-profit base price (falling back
// to the item cost at posting) × quantity. Optional dimensions (branch) are
// included only when the column exists.
export async function loadSalesLines(k, from, to, { withCreditMemos = true } = {}) {
  const out = [];
  const slp = await loadSalesEmployees(k);
  const branchNames = new Map();
  if (await k.has('OBPL', 'BPLName')) {
    for (const r of await k.run(`SELECT {BPLId}, {BPLName} FROM @OBPL`)) branchNames.set(String(r.BPLId), r.BPLName);
  }
  for (const [head, lines, sign] of [['OINV', 'INV1', 1], ...(withCreditMemos ? [['ORIN', 'RIN1', -1]] : [])]) {
    if (sign < 0 && !(await k.has(lines, 'LineTotal'))) continue;
    await k.need(head, ['DocEntry', 'DocNum', 'CardCode', 'CardName', 'DocDate', 'SlpCode', 'CANCELED', 'DiscPrcnt']);
    await k.need(lines, ['DocEntry', 'LineNum', 'ItemCode', 'Dscription', 'Quantity', 'Price', 'LineTotal', 'StockPrice', 'WhsCode']);
    const opt = {
      branch: await k.has(head, 'BPLId'),
      gross: await k.has(lines, 'GrossBuyPr'),
      before: await k.has(lines, 'PriceBefDi'),
      disc: await k.has(lines, 'DiscPrcnt'),
    };
    const rows = await k.run(`SELECT T0.{DocEntry} AS {DocEntry}, T0.{DocNum} AS {DocNum}, T0.{CardCode} AS {CardCode}, T0.{CardName} AS {CardName},
        T0.{DocDate} AS {DocDate}, T0.{SlpCode} AS {SlpCode}, T0.{DiscPrcnt} AS {HdrDisc}${opt.branch ? ', T0.{BPLId} AS {BPLId}' : ''},
        T1.{LineNum} AS {LineNum}, T1.{ItemCode} AS {ItemCode}, T1.{Dscription} AS {Dscription}, T1.{Quantity} AS {Quantity},
        T1.{Price} AS {Price}, T1.{LineTotal} AS {LineTotal}, T1.{StockPrice} AS {StockPrice}, T1.{WhsCode} AS {WhsCode}
        ${opt.gross ? ', T1.{GrossBuyPr} AS {GrossBuyPr}' : ''}${opt.before ? ', T1.{PriceBefDi} AS {PriceBefDi}' : ''}${opt.disc ? ', T1.{DiscPrcnt} AS {LineDisc}' : ''}
      FROM @${head} T0 INNER JOIN @${lines} T1 ON T1.{DocEntry} = T0.{DocEntry}
      WHERE T0.{CANCELED} = 'N' AND T0.{DocDate} >= ${k.lit(from)} AND T0.{DocDate} <= ${k.lit(to)}`);
    for (const r of rows) {
      const hdrDisc = num(r.HdrDisc);
      const qty = num(r.Quantity);
      const lineTotal = num(r.LineTotal);
      const revenue = lineTotal * (1 - hdrDisc / 100) * sign;
      const unitCost = (opt.gross && num(r.GrossBuyPr) > 0) ? num(r.GrossBuyPr) : num(r.StockPrice);
      const cost = unitCost * qty * sign;
      const listPrice = opt.before ? num(r.PriceBefDi) : num(r.Price);
      // Gross value before line discount, in LC, scaled from the doc-currency ratio.
      const grossLc = opt.disc && num(r.LineDisc) > 0 && num(r.LineDisc) < 100 ? lineTotal / (1 - num(r.LineDisc) / 100) : lineTotal;
      out.push({
        docType: sign > 0 ? 'Invoice' : 'Credit memo', sign, docEntry: r.DocEntry, docNum: r.DocNum, lineNum: r.LineNum,
        cardCode: r.CardCode, cardName: r.CardName || '', date: isoDate(r.DocDate),
        slpCode: r.SlpCode, salesperson: slp.get(String(r.SlpCode)) || '(none)',
        branch: opt.branch ? (branchNames.get(String(r.BPLId)) || String(r.BPLId ?? '')) : '',
        itemCode: r.ItemCode || '', itemName: r.Dscription || '', whsCode: r.WhsCode || '',
        qty: qty * sign, unitPriceLc: qty ? lineTotal / qty : 0, listPrice, lineDiscPct: opt.disc ? num(r.LineDisc) : 0, hdrDiscPct: hdrDisc,
        discountValue: (grossLc - lineTotal + lineTotal * hdrDisc / 100) * sign,
        revenue, cost, unitCost, gp: revenue - cost,
      });
    }
  }
  return out;
}

// Freight / additional expenses charged (INV3) or paid (PCH3) per document
// between from..to. Returns [] when the expense tables are not present.
export async function loadFreight(k, head, expTable, from, to) {
  if (!(await k.has(expTable, 'LineTotal')) || !(await k.has(expTable, 'DocEntry'))) return [];
  await k.need(head, ['DocEntry', 'DocNum', 'CardCode', 'CardName', 'DocDate', 'CANCELED']);
  const rows = await k.run(`SELECT T0.{DocEntry} AS {DocEntry}, T0.{DocNum} AS {DocNum}, T0.{CardCode} AS {CardCode}, T0.{CardName} AS {CardName},
      T0.{DocDate} AS {DocDate}, SUM(T1.{LineTotal}) AS {Freight}
    FROM @${head} T0 INNER JOIN @${expTable} T1 ON T1.{DocEntry} = T0.{DocEntry}
    WHERE T0.{CANCELED} = 'N' AND T0.{DocDate} >= ${k.lit(from)} AND T0.{DocDate} <= ${k.lit(to)}
    GROUP BY T0.{DocEntry}, T0.{DocNum}, T0.{CardCode}, T0.{CardName}, T0.{DocDate}`);
  return rows.map(r => ({ docEntry: r.DocEntry, docNum: r.DocNum, cardCode: r.CardCode, cardName: r.CardName || '', date: isoDate(r.DocDate), freight: num(r.Freight) }));
}

// Generic aggregation of loadSalesLines rows by a key function.
export function groupProfit(lines, keyFn, labelFn) {
  const map = new Map();
  for (const l of lines) {
    const key = keyFn(l);
    const e = map.get(key) || { key, ...labelFn(l), revenue: 0, cost: 0, gp: 0, qty: 0, lines: 0, docs: new Set(), customers: new Set() };
    e.revenue += l.revenue; e.cost += l.cost; e.gp += l.gp; e.qty += l.qty; e.lines++;
    e.docs.add(`${l.docType}:${l.docNum}`); e.customers.add(l.cardCode);
    map.set(key, e);
  }
  return [...map.values()].map(e => ({
    ...e, docs: e.docs.size, customers: e.customers.size,
    revenue: Math.round(e.revenue * 100) / 100, cost: Math.round(e.cost * 100) / 100, gp: Math.round(e.gp * 100) / 100,
    qty: Math.round(e.qty * 100) / 100, marginPct: e.revenue ? Math.round((e.gp / e.revenue) * 1000) / 10 : null,
  })).sort((a, z) => z.gp - a.gp);
}
