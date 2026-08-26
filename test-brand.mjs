import { connectDB, executeSQL, isConnected, getActiveType, getActiveConfig, tableRef } from './db-connector.mjs';
import { dbConnRepo as dbRepo } from './db.mjs';
const all = dbRepo.list.all();
console.log('db_connections:', JSON.stringify(all, null, 2));

const active = dbRepo.getActive();
console.log('\nActive DB:', JSON.stringify(active));

if (!active) { console.log('No active DB — exiting'); process.exit(0); }

try {
  await connectDB(active);
  console.log('\nConnected:', isConnected(), getActiveType());
  const cfg = getActiveConfig();
  console.log('Config schema:', cfg?.schema_name, 'db:', cfg?.database);
  const t  = tableRef('OINV', cfg);
  const t2 = tableRef('INV1', cfg);
  console.log('Tables:', t, t2);

  const rows = await executeSQL(
    `SELECT IFNULL(T1."OcrCode",'(none)') AS DIM, SUM(T1."LineTotal") AS SALES ` +
    `FROM ${t} T0 INNER JOIN ${t2} T1 ON T0."DocEntry"=T1."DocEntry" ` +
    `WHERE T0."DocDate" BETWEEN '2025-01-01' AND '2025-12-31' ` +
    `AND T1."OcrCode" IS NOT NULL AND T1."OcrCode"!='' ` +
    `GROUP BY T1."OcrCode" ORDER BY SALES DESC`
  );
  console.log('\nBrand rows for 2025:', rows.length);
  console.log('Top 5:', JSON.stringify(rows.slice(0,5)));
} catch(e) {
  console.error('Error:', e.message);
}
