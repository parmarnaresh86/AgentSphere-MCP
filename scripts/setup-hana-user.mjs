/**
 * Creates (or refreshes) the read-only HANA user AgentSphere connects with.
 *
 * Reads .env from the app folder:
 *   HANA_HOST, HANA_PORT, HANA_TENANT    where HANA is
 *   HANA_ADMIN_USER, HANA_ADMIN_PASSWORD  admin used once to create the user
 *   HANA_USER, HANA_PASSWORD              the read-only app user
 *   HANA_SCHEMA                           company schema(s), comma-separated (default SL_COMPANY)
 *
 * Without admin credentials it only tests that HANA_USER can log in and read.
 *
 * Usage:  node scripts/setup-hana-user.mjs [--dry-run]
 * Exit:   0 = ready (or HANA not configured), 1 = failed
 */
import { createRequire } from "module";
import { fileURLToPath } from "url";
import path from "path";

const require = createRequire(import.meta.url);
const appDir  = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
require("dotenv").config({ path: path.join(appDir, ".env") });
const hdb = require("hdb");

const DRY = process.argv.includes("--dry-run");
const env = (k) => (process.env[k] || "").trim();

const ok   = (m) => console.log(`        OK   ${m}`);
const warn = (m) => console.log(`        WARN ${m}`);
const fail = (m) => { console.log(`        FAIL ${m}`); process.exit(1); };

const host = env("HANA_HOST");
if (!host) { console.log("        SKIP HANA_HOST not set - direct DB access not configured"); process.exit(0); }

const port      = Number(env("HANA_PORT")) || 30015;
const tenant    = env("HANA_TENANT");
const adminUser = env("HANA_ADMIN_USER");
const adminPass = process.env.HANA_ADMIN_PASSWORD || "";
const appUser   = env("HANA_USER").toUpperCase();
const appPass   = process.env.HANA_PASSWORD || "";
const schemas   = (env("HANA_SCHEMA") || env("SL_COMPANY") || env("SAP_B1_COMPANY"))
  .split(",").map(s => s.trim()).filter(Boolean);

if (!appUser || !appPass) fail("HANA_USER and HANA_PASSWORD must be set");
if (!/^[A-Z][A-Z0-9_]*$/.test(appUser)) fail(`HANA_USER "${appUser}" may only contain letters, digits and _`);
if (!schemas.length) fail("HANA_SCHEMA (or SL_COMPANY) must name the company schema");
for (const s of schemas) if (!/^[A-Za-z0-9_]+$/.test(s)) fail(`Schema name "${s}" is not valid`);

const quoteId  = (s) => `"${s.replace(/"/g, '""')}"`;
const quotePwd = (s) => `"${s.replace(/"/g, '""')}"`;

function connect(user, password) {
  return new Promise((resolve, reject) => {
    const client = hdb.createClient({ host, port, user, password, ...(tenant ? { databaseName: tenant } : {}) });
    client.on("error", () => {});
    client.connect(err => err ? reject(err) : resolve(client));
  });
}
const exec = (client, sql) => new Promise((resolve, reject) =>
  client.exec(sql, (err, rows) => err ? reject(err) : resolve(rows)));

async function testAppUser() {
  let c;
  try { c = await connect(appUser, appPass); }
  catch (e) { fail(`${appUser} cannot log in: ${e.message}`); }
  for (const s of schemas) {
    try {
      const r = await exec(c, `SELECT COUNT(*) AS "N" FROM ${quoteId(s)}."OCRD"`);
      ok(`${appUser} can read ${s} (${r[0].N} business partners)`);
    } catch (e) { c.end(); fail(`${appUser} cannot read schema ${s}: ${e.message}`); }
  }
  c.end();
}

console.log(`        HANA ${host}:${port}${tenant ? ` tenant ${tenant}` : ""}, schema(s) ${schemas.join(", ")}`);

// No admin credentials (or the app uses the admin account itself): just verify.
if (!adminUser || !adminPass || adminUser.toUpperCase() === appUser) {
  if (adminUser.toUpperCase() === appUser) warn(`HANA_USER is the admin account ${appUser} - use a read-only user in production`);
  else console.log(`        No HANA_ADMIN_PASSWORD - testing existing user ${appUser} only`);
  if (!DRY) await testAppUser();
  process.exit(0);
}

let admin;
try { admin = await connect(adminUser, adminPass); }
catch (e) { fail(`Admin login as ${adminUser} failed: ${e.message}`); }
ok(`Logged in as ${adminUser}`);

const found = await exec(admin, `SELECT SCHEMA_NAME FROM SYS.SCHEMAS WHERE SCHEMA_NAME IN (${schemas.map(s => `'${s}'`).join(",")})`);
const missing = schemas.filter(s => !found.some(r => r.SCHEMA_NAME === s));
if (missing.length) { admin.end(); fail(`Schema(s) not found in HANA: ${missing.join(", ")}`); }

const exists = (await exec(admin, `SELECT COUNT(*) AS "N" FROM SYS.USERS WHERE USER_NAME = '${appUser}'`))[0].N > 0;

const steps = [
  exists
    ? [`ALTER USER ${quoteId(appUser)} PASSWORD ${quotePwd(appPass)} NO FORCE_FIRST_PASSWORD_CHANGE`, `Password refreshed for existing user ${appUser}`]
    : [`CREATE USER ${quoteId(appUser)} PASSWORD ${quotePwd(appPass)} NO FORCE_FIRST_PASSWORD_CHANGE`, `User ${appUser} created`],
  [`ALTER USER ${quoteId(appUser)} DISABLE PASSWORD LIFETIME`, "Password set to never expire"],
  ...schemas.map(s => [`GRANT SELECT ON SCHEMA ${quoteId(s)} TO ${quoteId(appUser)}`, `SELECT granted on ${s}`]),
];

if (DRY) {
  console.log("        DRY RUN - would execute:");
  for (const [sql] of steps) console.log(`          ${sql.replace(quotePwd(appPass), '"********"')}`);
  console.log(`          GRANT SELECT ON SCHEMA "_SYS_BIC" TO ${quoteId(appUser)}   (best effort)`);
  admin.end();
  process.exit(0);
}

for (const [sql, msg] of steps) {
  try { await exec(admin, sql); ok(msg); }
  catch (e) { admin.end(); fail(`${msg.split(" ")[0]} step failed: ${e.message}`); }
}
// Calculation views used by the financial reports. Needs the admin to hold it WITH GRANT OPTION.
try { await exec(admin, `GRANT SELECT ON SCHEMA "_SYS_BIC" TO ${quoteId(appUser)}`); ok("SELECT granted on _SYS_BIC (analytic views)"); }
catch (e) { warn(`_SYS_BIC grant skipped (${e.message}) - HANA analytic-view reports may be unavailable`); }
admin.end();

await testAppUser();
