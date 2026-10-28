/**
 * PUTAWAY UDO — creates the SAP schema through the Service Layer (idempotent).
 *
 *   node scripts/putaway-udo-setup.mjs
 *
 * Document-type UDO STTL_PUTAWAY ("Putaway"): one document per GRPO, one row per
 * sorted GRPO line moved from its receiving warehouse/bin to a storage
 * warehouse/bin. Record only — no Inventory Transfer is posted; U_TrfRef can
 * hold the transfer number when one is posted manually.
 *
 *   @STTL_OPTW  header  (bott_Document)       GRPO, vendor, from/to whs, user, status, times
 *   @STTL_PTW1  rows    (bott_DocumentLines)  @SORTING code, item, qty, from → to whs/bin, user, times
 *
 * Existing tables / fields / UDO are left as they are, so re-running is safe.
 * The pre-existing empty no-object table @PUTAWAY is not touched (a no-object
 * table cannot be turned into a document UDO).
 */
import axios from 'axios';
import https from 'node:https';
import { connRepo } from '../db.mjs';

const HEADER = 'STTL_OPTW', LINES = 'STTL_PTW1', UDO = 'STTL_PUTAWAY';
const STATUS = [{ Value: 'O', Description: 'Open' }, { Value: 'P', Description: 'In Process' }, { Value: 'C', Description: 'Completed' }];
const alpha = (Name, Description, Size, extra = {}) => ({ Name, Description, Type: 'db_Alpha', Size, EditSize: Size, ...extra });
const date = (Name, Description) => ({ Name, Description, Type: 'db_Date' });
const time = (Name, Description) => ({ Name, Description, Type: 'db_Date', SubType: 'st_Time' });
const qty = (Name, Description) => ({ Name, Description, Type: 'db_Float', SubType: 'st_Quantity' });
const int = (Name, Description) => ({ Name, Description, Type: 'db_Numeric', Size: 11, EditSize: 11 });
const status = () => alpha('Status', 'Status', 1, { ValidValuesMD: STATUS, DefaultValue: 'O' });

const FIELDS = {
  [HEADER]: [
    date('DocDate', 'Putaway Date'), int('GRPOEntry', 'GRPO DocEntry'), alpha('GRPONum', 'GRPO No.', 20), date('GRPODate', 'GRPO Date'),
    alpha('CardCode', 'Vendor Code', 15), alpha('CardName', 'Vendor Name', 100), alpha('FromWhs', 'From Warehouse', 8),
    alpha('ToWhs', 'Default To Warehouse', 8), alpha('PutUser', 'Putaway User', 20), status(),
    time('StartTime', 'Start Time'), time('EndTime', 'End Time'), qty('TotalQty', 'Total Quantity'), alpha('TrfRef', 'Stock Transfer Ref.', 20),
  ],
  [LINES]: [
    alpha('SortCode', 'Sorting Code', 50), int('GRPOLine', 'GRPO Line No.'), alpha('ItemCode', 'Item No.', 50), alpha('ItemName', 'Item Description', 100),
    qty('Qty', 'Quantity'), alpha('FromWhs', 'From Warehouse', 8), alpha('FromBin', 'From Bin', 50), alpha('ToWhs', 'To Warehouse', 8),
    alpha('ToBin', 'To Bin', 50), alpha('PutUser', 'Putaway User', 20), time('TimeIn', 'Time IN'), time('TimeOut', 'Time OUT'), status(),
    // Copied from the item master "Forklift Required?" (OITM.U_FR) — see putaway-forklift-setup.mjs.
    alpha('Forklift', 'Forklift Required', 3, { ValidValuesMD: [{ Value: 'YES', Description: 'YES' }, { Value: 'NO', Description: 'NO' }], DefaultValue: 'NO' }),
  ],
};

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
await login();
console.log(`SAP: ${conn.company} @ ${base}`);

// ── Tables ────────────────────────────────────────────────────────────────────
for (const [TableName, TableDescription, TableType] of [[HEADER, 'Putaway', 'bott_Document'], [LINES, 'Putaway Lines', 'bott_DocumentLines']]) {
  const g = await http.get(`${base}/UserTablesMD('${TableName}')`, H);
  if (g.status === 200) { console.log(`  table @${TableName} exists (${g.data.TableType})`); continue; }
  const r = await http.post(`${base}/UserTablesMD`, { TableName, TableDescription, TableType }, H);
  if (r.status !== 201) throw new Error(`@${TableName}: ${msg(r)}`);
  console.log(`  table @${TableName} created`);
}

// ── Fields ────────────────────────────────────────────────────────────────────
// Metadata changes invalidate the session's cached schema — log in again after.
await login();
for (const [table, fields] of Object.entries(FIELDS)) {
  const have = await http.get(`${base}/UserFieldsMD`, { ...H, params: { $filter: `TableName eq '@${table}'`, $select: 'Name' } });
  const existing = new Set((have.data?.value || []).map(f => f.Name));
  for (const f of fields) {
    if (existing.has(f.Name)) { console.log(`  @${table}.U_${f.Name} exists`); continue; }
    const r = await http.post(`${base}/UserFieldsMD`, { TableName: `@${table}`, ...f }, H);
    if (r.status !== 201) throw new Error(`@${table}.U_${f.Name}: ${msg(r)}`);
    console.log(`  @${table}.U_${f.Name} created`);
  }
}

// ── UDO ───────────────────────────────────────────────────────────────────────
await login();
const g = await http.get(`${base}/UserObjectsMD('${UDO}')`, H);
if (g.status === 200) console.log(`  UDO ${UDO} exists`);
else {
  const head = FIELDS[HEADER].map(f => `U_${f.Name}`), rows = FIELDS[LINES].map(f => `U_${f.Name}`);
  const r = await http.post(`${base}/UserObjectsMD`, {
    Code: UDO, Name: 'Putaway', TableName: HEADER, ObjectType: 'boud_Document',
    CanFind: 'tYES', CanCancel: 'tYES', CanClose: 'tYES', CanDelete: 'tYES', CanLog: 'tYES', CanYearTransfer: 'tNO',
    ManageSeries: 'tYES', CanCreateDefaultForm: 'tYES', EnableEnhancedForm: 'tYES', MenuItem: 'tNO',
    UserObjectMD_ChildTables: [{ TableName: LINES, ObjectName: LINES }],
    UserObjectMD_FindColumns: ['DocNum', 'U_DocDate', 'U_GRPONum', 'U_CardName', 'U_PutUser', 'U_Status'].map(ColumnAlias => ({ ColumnAlias })),
    UserObjectMD_FormColumns: ['DocEntry', 'DocNum', ...head].map(FormColumnAlias => ({ FormColumnAlias, Editable: FormColumnAlias.startsWith('U_') ? 'tYES' : 'tNO' })),
    UserObjectMD_EnhancedFormColumns: ['LineId', ...rows].map((ColumnAlias, i) => ({
      ColumnAlias, ChildNumber: 1, ColumnNumber: i + 1, ColumnIsUsed: 'tYES', Editable: ColumnAlias === 'LineId' ? 'tNO' : 'tYES',
    })),
  }, H);
  if (r.status !== 201) throw new Error(`UDO ${UDO}: ${msg(r)}`);
  console.log(`  UDO ${UDO} registered`);
}
await login();
const probe = await http.get(`${base}/${UDO}`, { ...H, params: { $top: 1 } });
console.log(`Service Layer /${UDO}: ${probe.status === 200 ? 'available' : `not yet available (${msg(probe)}) — restart the Service Layer if it stays this way`}`);
await http.post(`${base}/Logout`, {}, H);
process.exit(0);
