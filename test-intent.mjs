// Quick test: does detectIntent route "brandwise sales from last year" correctly?
// And does parseSalesAnalysisQuery extract ccDimField?

import { dbConnRepo } from './db.mjs';
import { connectDB, executeSQL, isConnected, getActiveConfig, getActiveType, tableRef } from './db-connector.mjs';

// --- simulate detectDimensions logic inline ---
const DIM1_NAME = process.env.DIM1_NAME || 'Brand';
const brandAlias = DIM1_NAME.toLowerCase();
const msg = 'brandwise sales from last year';
const m = msg.toLowerCase().replace(/[^\w\s]/g, ' ');

console.log('Message:', msg);
console.log('Lowercased:', m);
console.log('Includes "brandwise":', m.includes('brandwise'));
console.log('Includes brand alias:', m.includes(brandAlias));
console.log('Includes "brand wise":', m.includes('brand wise'));

// --- test date ---
const now = new Date();
const curY = now.getFullYear();
const yr = curY - 1;
const slFromDate = `${yr}-01-01`;
const slToDate   = `${yr}-12-31`;
console.log('\nDate range:', slFromDate, '->', slToDate);

// --- test SQL ---
const active = dbConnRepo.getActive();
console.log('\nActive DB connected:', !!active);
if (active) {
  await connectDB(active);
  console.log('isConnected():', isConnected());
  const cfg = getActiveConfig();
  const inv0 = tableRef('OINV', cfg);
  const inv1 = tableRef('INV1', cfg);
  const isHana = getActiveType() === 'hana';
  const col = isHana ? `"OcrCode"` : `OcrCode`;
  const LT  = isHana ? `T1."LineTotal"` : `T1.LineTotal`;
  const GP  = isHana ? `T1."GrssProfit"` : `T1.GrssProfit`;
  const QTY = isHana ? `T1."Quantity"` : `T1.Quantity`;
  const DE  = isHana ? `T0."DocEntry"` : `T0.DocEntry`;
  const JOIN = isHana ? `T0."DocEntry"=T1."DocEntry"` : `T0.DocEntry=T1.DocEntry`;
  const dateFilter = isHana
    ? `T0."DocDate" BETWEEN '${slFromDate}' AND '${slToDate}'`
    : `T0.DocDate BETWEEN '${slFromDate}' AND '${slToDate}'`;
  const nullFn = isHana ? `IFNULL(T1.${col},'(none)')` : `ISNULL(T1.OcrCode,'(none)')`;
  const sqlFirst = `SELECT ${nullFn} AS DIM, SUM(${LT}) AS SALES, SUM(${GP}) AS GP, SUM(${QTY}) AS QTY, COUNT(DISTINCT ${DE}) AS DOCS FROM ${inv0} T0 INNER JOIN ${inv1} T1 ON ${JOIN} WHERE ${dateFilter} AND T1.${col} IS NOT NULL AND T1.${col}!='' GROUP BY T1.${col} ORDER BY SALES DESC`;
  console.log('\nSQL:', sqlFirst.slice(0, 200) + '...');
  const rows = await executeSQL(sqlFirst);
  console.log('\nRows:', rows.length);
  console.log('Top 5:', JSON.stringify(rows.slice(0, 5), null, 2));
}
