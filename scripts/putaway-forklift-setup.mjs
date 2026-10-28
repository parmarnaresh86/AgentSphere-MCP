/**
 * PUTAWAY FORKLIFT — adds forklift handling to the putaway UDO (idempotent, POC).
 *
 *   node scripts/putaway-forklift-setup.mjs           # field + UDO form + demo item flags
 *   node scripts/putaway-forklift-setup.mjs --revert  # put the item flags back as they were
 *
 *  1. @STTL_PTW1.U_Forklift (YES / NO, default NO) — "Forklift Required" on each
 *     putaway row, copied from the item master when the row is created.
 *  2. Adds the column to the STTL_PUTAWAY enhanced form.
 *  3. Demo data: sets the existing item UDF OITM.U_FR ("Forklift Required?",
 *     YES / NO) to YES for the pallet / bulk items that appear on putaway rows —
 *     PDQ displays (PD0), raw foam (RF), master cases (MC), display shippers
 *     (DC…DS) and items received 10,000+ per line. Previous values are saved in
 *     scripts/putaway-forklift-items.json so --revert can restore them.
 *
 * Re-run scripts/putaway-demo-data.mjs afterwards so the demo rows carry U_Forklift.
 */
import axios from 'axios';
import fs from 'node:fs';
import https from 'node:https';
import { connRepo, dbConnRepo } from '../db.mjs';
import { connectDB, executeSQL, getActiveConfig, tableRef } from '../db-connector.mjs';

const REVERT = process.argv.includes('--revert');
const LINES = 'STTL_PTW1', UDO = 'STTL_PUTAWAY';
const SAVED = new URL('./putaway-forklift-items.json', import.meta.url);
const YESNO = [{ Value: 'YES', Description: 'YES' }, { Value: 'NO', Description: 'NO' }];

const conn = connRepo.getActive();
if (!conn) throw new Error('No active SAP connection in hanny.db');
const base = conn.base_url.replace(/\/+$/, '');
const http = axios.create({ timeout: 120000, httpsAgent: new https.Agent({ rejectUnauthorized: false }), validateStatus: () => true });
const H = { headers: {} };
async function login() {
  const r = await http.post(`${base}/Login`, { CompanyDB: conn.company, UserName: conn.sl_user, Password: conn.sl_password });
  if (r.status !== 200) throw new Error(`SAP login failed: ${JSON.stringify(r.data)}`);
  H.headers.Cookie = (r.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');
}
const msg = r => r.data?.error?.message?.value || JSON.stringify(r.data);
const patchItem = async (code, U_FR) => {
  let r = await http.patch(`${base}/Items('${encodeURIComponent(code.replace(/'/g, "''"))}')`, { U_FR }, H);
  if (r.status !== 204) { await login(); r = await http.patch(`${base}/Items('${encodeURIComponent(code.replace(/'/g, "''"))}')`, { U_FR }, H); }
  if (r.status !== 204) throw new Error(`Item ${code}: ${msg(r)}`);
};
await login();
console.log(`SAP: ${conn.company} @ ${base}`);

// ── Revert the demo item flags ────────────────────────────────────────────────
if (REVERT) {
  if (!fs.existsSync(SAVED)) { console.log('Nothing to revert (no putaway-forklift-items.json).'); process.exit(0); }
  const saved = JSON.parse(fs.readFileSync(SAVED, 'utf8'));
  for (const s of saved) await patchItem(s.itemCode, s.before || 'NO');
  fs.unlinkSync(SAVED);
  console.log(`Restored U_FR on ${saved.length} item(s).`);
  await http.post(`${base}/Logout`, {}, H);
  process.exit(0);
}

// ── 1. Row field ──────────────────────────────────────────────────────────────
const have = await http.get(`${base}/UserFieldsMD`, { ...H, params: { $filter: `TableName eq '@${LINES}' and Name eq 'Forklift'`, $select: 'Name' } });
if ((have.data?.value || []).length) console.log(`  @${LINES}.U_Forklift exists`);
else {
  const r = await http.post(`${base}/UserFieldsMD`, { TableName: `@${LINES}`, Name: 'Forklift', Description: 'Forklift Required', Type: 'db_Alpha',
    Size: 3, EditSize: 3, ValidValuesMD: YESNO, DefaultValue: 'NO' }, H);
  if (r.status !== 201) throw new Error(`@${LINES}.U_Forklift: ${msg(r)}`);
  console.log(`  @${LINES}.U_Forklift created`);
}

// ── 2. UDO form column ────────────────────────────────────────────────────────
await login();
const udo = await http.get(`${base}/UserObjectsMD('${UDO}')`, H);
if (udo.status !== 200) throw new Error(`UDO ${UDO} not found — run scripts/putaway-udo-setup.mjs first`);
const cols = udo.data.UserObjectMD_EnhancedFormColumns || [];
if (cols.some(c => c.ColumnAlias === 'U_Forklift')) console.log(`  UDO ${UDO} form already shows U_Forklift`);
else {
  const ColumnNumber = Math.max(0, ...cols.filter(c => c.ChildNumber === 1).map(c => c.ColumnNumber)) + 1;
  const r = await http.patch(`${base}/UserObjectsMD('${UDO}')`, { UserObjectMD_EnhancedFormColumns: [...cols,
    { ColumnAlias: 'U_Forklift', ChildNumber: 1, ColumnNumber, ColumnIsUsed: 'tYES', Editable: 'tYES' }] }, H);
  console.log(r.status === 204 ? `  UDO ${UDO} form: U_Forklift column added` : `  WARN UDO form column not added (${msg(r)}) — the field still works`);
}

// ── 3. Demo item flags ────────────────────────────────────────────────────────
await connectDB(dbConnRepo.getActive());
const T = n => tableRef(n, getActiveConfig());
const items = await executeSQL(`SELECT P."ItemCode" AS "ItemCode", MAX(I."U_FR") AS "FR", MAX(L."U_Qty") AS "MaxQty"
  FROM ${T('@STTL_OPTW')} H JOIN ${T('@STTL_PTW1')} L ON L."DocEntry" = H."DocEntry"
  JOIN ${T('PDN1')} P ON P."DocEntry" = H."U_GRPOEntry" AND P."LineNum" = L."U_GRPOLine"
  JOIN ${T('OITM')} I ON I."ItemCode" = P."ItemCode" AND I."InvntItem" = 'Y'
  GROUP BY P."ItemCode"`);
const heavy = i => /PD0/.test(i.ItemCode) || /^(RF|MC)/.test(i.ItemCode) || /^DC.*DS/.test(i.ItemCode) || Number(i.MaxQty) >= 10000;
const pick = items.filter(i => heavy(i) && i.FR !== 'YES');
const saved = fs.existsSync(SAVED) ? JSON.parse(fs.readFileSync(SAVED, 'utf8')) : [];
for (const i of pick) {
  await patchItem(i.ItemCode, 'YES');
  if (!saved.some(s => s.itemCode === i.ItemCode)) saved.push({ itemCode: i.ItemCode, before: i.FR || 'NO' });
}
fs.writeFileSync(SAVED, JSON.stringify(saved, null, 2));
console.log(`  OITM.U_FR = YES set on ${pick.length} item(s); ${items.filter(i => i.FR === 'YES').length} already YES; ` +
  `${items.length - pick.length - items.filter(i => i.FR === 'YES').length} stay NO (of ${items.length} putaway items)`);
await http.post(`${base}/Logout`, {}, H);
console.log('Done. Now run: node scripts/putaway-demo-data.mjs');
process.exit(0);
