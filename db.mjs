/**
 * db.mjs — SQLite database for users and SAP B1 connection profiles
 * Tables: users, connections, auth_sessions
 */
import Database from "better-sqlite3";
import crypto   from "node:crypto";
import path     from "node:path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const db = new Database(path.join(__dirname, "hanny.db"));

// ── Pragmas ──────────────────────────────────────────────────────────────────
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// ── Schema ───────────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    username     TEXT    UNIQUE NOT NULL,
    password_hash TEXT   NOT NULL,
    full_name    TEXT    DEFAULT '',
    role         TEXT    DEFAULT 'user',
    created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS connections (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    name              TEXT    NOT NULL,
    base_url          TEXT    NOT NULL,
    company           TEXT    NOT NULL,
    sl_user           TEXT    NOT NULL,
    sl_password       TEXT    NOT NULL,
    is_active         INTEGER DEFAULT 0,
    created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
    hana_host         TEXT    DEFAULT '',
    hana_port         INTEGER DEFAULT 30015,
    hana_database     TEXT    DEFAULT '',
    hana_schema       TEXT    DEFAULT '',
    hana_user         TEXT    DEFAULT '',
    hana_password     TEXT    DEFAULT '',
    hana_encrypted    INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS auth_sessions (
    token        TEXT    PRIMARY KEY,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
    expires_at   DATETIME NOT NULL
  );
`);

// ── Migrate connections table — add HANA columns for existing installs ────────
try { db.exec(`ALTER TABLE connections ADD COLUMN hana_host      TEXT    DEFAULT ''`);    } catch {}
try { db.exec(`ALTER TABLE connections ADD COLUMN hana_port      INTEGER DEFAULT 30015`); } catch {}
try { db.exec(`ALTER TABLE connections ADD COLUMN hana_database  TEXT    DEFAULT ''`);    } catch {}
try { db.exec(`ALTER TABLE connections ADD COLUMN hana_schema    TEXT    DEFAULT ''`);    } catch {}
try { db.exec(`ALTER TABLE connections ADD COLUMN hana_user      TEXT    DEFAULT ''`);    } catch {}
try { db.exec(`ALTER TABLE connections ADD COLUMN hana_password  TEXT    DEFAULT ''`);    } catch {}
try { db.exec(`ALTER TABLE connections ADD COLUMN hana_encrypted INTEGER DEFAULT 0`);     } catch {}
try { db.exec(`ALTER TABLE connections ADD COLUMN schema_hint    TEXT    DEFAULT ''`);    } catch {}
try { db.exec(`ALTER TABLE connections ADD COLUMN dim_names      TEXT    DEFAULT ''`);    } catch {}

// ── Password helpers ─────────────────────────────────────────────────────────
export function hashPassword(plain) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(plain, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPassword(plain, stored) {
  const [salt, hash] = stored.split(":");
  const attempt = crypto.scryptSync(plain, salt, 64).toString("hex");
  return attempt === hash;
}

// ── User helpers ─────────────────────────────────────────────────────────────
export const userRepo = {
  findByUsername: db.prepare(`SELECT * FROM users WHERE username = ?`),
  findById:       db.prepare(`SELECT id, username, full_name, role, created_at FROM users WHERE id = ?`),
  list:           db.prepare(`SELECT id, username, full_name, role, created_at FROM users ORDER BY id`),
  create(username, plain, fullName = "", role = "user") {
    return db.prepare(
      `INSERT INTO users (username, password_hash, full_name, role) VALUES (?,?,?,?)`
    ).run(username, hashPassword(plain), fullName, role);
  },
  changePassword(id, newPlain) {
    return db.prepare(`UPDATE users SET password_hash=? WHERE id=?`).run(hashPassword(newPlain), id);
  },
  delete: db.prepare(`DELETE FROM users WHERE id = ?`),
};

// ── Session helpers ──────────────────────────────────────────────────────────
const SESSION_TTL_HOURS = 12;

export const sessionRepo = {
  create(userId) {
    const token     = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + SESSION_TTL_HOURS * 3600 * 1000).toISOString();
    db.prepare(
      `INSERT INTO auth_sessions (token, user_id, expires_at) VALUES (?,?,?)`
    ).run(token, userId, expiresAt);
    return token;
  },
  verify(token) {
    if (!token) return null;
    const row = db.prepare(
      `SELECT s.user_id, u.username, u.full_name, u.role
       FROM auth_sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token = ? AND s.expires_at > datetime('now')`
    ).get(token);
    return row || null;
  },
  delete: db.prepare(`DELETE FROM auth_sessions WHERE token = ?`),
  purgeExpired() {
    db.prepare(`DELETE FROM auth_sessions WHERE expires_at <= datetime('now')`).run();
  },
};

// ── Connection helpers ────────────────────────────────────────────────────────
export const connRepo = {
  list: db.prepare(`SELECT id, name, base_url, company, sl_user, is_active, created_at,
    hana_host, hana_port, hana_database, hana_schema, hana_user, hana_encrypted,
    schema_hint, dim_names
    FROM connections ORDER BY id`),
  getActive() {
    const row = db.prepare(`SELECT * FROM connections WHERE is_active = 1 LIMIT 1`).get();
    if (row && row.hana_encrypted) row.hana_password = decryptDbPassword(row.hana_password);
    return row;
  },
  create(name, base_url, company, sl_user, sl_password, hana = {}, schema_hint = '', dim_names = '') {
    const hanaEnc  = hana.encrypted ? 1 : 0;
    const hanaPass = hana.encrypted ? encryptDbPassword(hana.password || '') : (hana.password || '');
    return db.prepare(
      `INSERT INTO connections (name,base_url,company,sl_user,sl_password,
        hana_host,hana_port,hana_database,hana_schema,hana_user,hana_password,hana_encrypted,
        schema_hint,dim_names)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(name, base_url, company, sl_user, sl_password,
      hana.host||'', hana.port||30015, hana.database||'', hana.schema||'',
      hana.user||'', hanaPass, hanaEnc, schema_hint, dim_names);
  },
  update(id, name, base_url, company, sl_user, sl_password, hana = {}, schema_hint = '', dim_names = '') {
    const hanaEnc  = hana.encrypted ? 1 : 0;
    const hanaPass = hana.encrypted ? encryptDbPassword(hana.password || '') : (hana.password || '');
    return db.prepare(
      `UPDATE connections SET name=?,base_url=?,company=?,sl_user=?,sl_password=?,
        hana_host=?,hana_port=?,hana_database=?,hana_schema=?,hana_user=?,hana_password=?,hana_encrypted=?,
        schema_hint=?,dim_names=?
       WHERE id=?`
    ).run(name, base_url, company, sl_user, sl_password,
      hana.host||'', hana.port||30015, hana.database||'', hana.schema||'',
      hana.user||'', hanaPass, hanaEnc, schema_hint, dim_names, id);
  },
  activate(id) {
    db.transaction(() => {
      db.prepare(`UPDATE connections SET is_active = 0`).run();
      db.prepare(`UPDATE connections SET is_active = 1 WHERE id = ?`).run(id);
    })();
  },
  delete: db.prepare(`DELETE FROM connections WHERE id = ?`),
  getById(id) {
    const row = db.prepare(`SELECT * FROM connections WHERE id = ?`).get(id);
    if (row && row.hana_encrypted) row.hana_password = decryptDbPassword(row.hana_password);
    return row;
  },
  getByCompany(company) {
    const row = db.prepare(`SELECT * FROM connections WHERE company = ? LIMIT 1`).get(company);
    if (row && row.hana_encrypted) row.hana_password = decryptDbPassword(row.hana_password);
    return row;
  },
  upsertByCompany(name, base_url, company, sl_user, sl_password) {
    const existing = db.prepare(`SELECT id FROM connections WHERE company = ?`).get(company);
    if (existing) {
      db.prepare(`UPDATE connections SET name=?, base_url=?, sl_user=?, sl_password=? WHERE id=?`)
        .run(name, base_url, sl_user, sl_password, existing.id);
      return existing.id;
    }
    const info = db.prepare(`INSERT INTO connections (name, base_url, company, sl_user, sl_password) VALUES (?,?,?,?,?)`)
      .run(name, base_url, company, sl_user, sl_password);
    return info.lastInsertRowid;
  },
};

// ── Mail configuration ────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS mail_config (
    id        INTEGER PRIMARY KEY DEFAULT 1,
    imap_host TEXT DEFAULT '',
    imap_port INTEGER DEFAULT 993,
    imap_tls  INTEGER DEFAULT 1,
    mail_user TEXT DEFAULT '',
    mail_pass TEXT DEFAULT '',
    smtp_host TEXT DEFAULT '',
    smtp_port INTEGER DEFAULT 587,
    smtp_tls  INTEGER DEFAULT 0,
    folder    TEXT DEFAULT 'INBOX',
    poll_ms   INTEGER DEFAULT 60000
  )
`);

export const mailConfigRepo = {
  get() {
    return db.prepare('SELECT * FROM mail_config WHERE id=1').get() || null;
  },
  save({ imap_host='', imap_port=993, imap_tls=1, mail_user='', mail_pass='', smtp_host='', smtp_port=587, smtp_tls=0, folder='INBOX', poll_ms=60000 } = {}) {
    const has = db.prepare('SELECT id FROM mail_config WHERE id=1').get();
    const vals = [imap_host, imap_port, imap_tls?1:0, mail_user, mail_pass, smtp_host, smtp_port, smtp_tls?1:0, folder, poll_ms];
    if (has) {
      db.prepare(`UPDATE mail_config SET imap_host=?,imap_port=?,imap_tls=?,mail_user=?,mail_pass=?,smtp_host=?,smtp_port=?,smtp_tls=?,folder=?,poll_ms=? WHERE id=1`).run(...vals);
    } else {
      db.prepare(`INSERT INTO mail_config (id,imap_host,imap_port,imap_tls,mail_user,mail_pass,smtp_host,smtp_port,smtp_tls,folder,poll_ms) VALUES (1,?,?,?,?,?,?,?,?,?,?)`).run(...vals);
    }
  },
};

// ── Branding (dynamic company / product / developer identity) ────────────────
// Lets one deployed instance be re-skinned per client without touching code —
// product name/logo (the app itself), developed-by name/logo (the vendor who
// built it), and company name/logo (the client this instance is deployed for).
// Logos are stored as data: URIs so the login page (pre-auth) can render them
// with a single unauthenticated GET, no separate file serving needed.
db.exec(`
  CREATE TABLE IF NOT EXISTS branding_settings (
    id                 INTEGER PRIMARY KEY DEFAULT 1,
    company_name       TEXT DEFAULT '',
    company_logo       TEXT DEFAULT '',
    developed_by       TEXT DEFAULT '',
    developed_by_logo  TEXT DEFAULT '',
    product_name       TEXT DEFAULT '',
    product_logo       TEXT DEFAULT '',
    updated_at         TEXT DEFAULT '',
    updated_by         TEXT DEFAULT ''
  )
`);
// UI theme picked by an admin: 'hana' (original dark shell) or 'fiori'
// (S/4HANA Horizon launchpad). Added after the table shipped, so migrate.
if (!db.prepare(`PRAGMA table_info(branding_settings)`).all().some(c => c.name === 'ui_theme')) {
  db.exec(`ALTER TABLE branding_settings ADD COLUMN ui_theme TEXT DEFAULT 'hana'`);
}

const BRANDING_DEFAULTS = {
  company_name:      '',
  company_logo:      '',
  developed_by:      'Henny AI Solution',
  developed_by_logo: '/assets/henny-ai-logo.png',
  product_name:      'AgentSphere',
  product_logo:      '/assets/henny-agentic-logo.png',
  ui_theme:          'hana',
};

export const brandingRepo = {
  get() {
    const row = db.prepare('SELECT * FROM branding_settings WHERE id=1').get();
    return { ...BRANDING_DEFAULTS, ...(row || {}) };
  },
  save(fields = {}, updatedBy = '') {
    const current = this.get();
    const merged = { ...current, ...fields };
    const has = db.prepare('SELECT id FROM branding_settings WHERE id=1').get();
    const vals = [
      merged.company_name, merged.company_logo,
      merged.developed_by, merged.developed_by_logo,
      merged.product_name, merged.product_logo, merged.ui_theme || 'hana',
      new Date().toISOString(), updatedBy,
    ];
    if (has) {
      db.prepare(`UPDATE branding_settings SET company_name=?,company_logo=?,developed_by=?,developed_by_logo=?,product_name=?,product_logo=?,ui_theme=?,updated_at=?,updated_by=? WHERE id=1`).run(...vals);
    } else {
      db.prepare(`INSERT INTO branding_settings (id,company_name,company_logo,developed_by,developed_by_logo,product_name,product_logo,ui_theme,updated_at,updated_by) VALUES (1,?,?,?,?,?,?,?,?,?)`).run(...vals);
    }
    return this.get();
  },
};

// ── Direct DB connections (MSSQL / HANA) ─────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS db_connections (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    name               TEXT    NOT NULL,
    db_type            TEXT    NOT NULL DEFAULT 'mssql',
    host               TEXT    NOT NULL,
    port               INTEGER,
    database           TEXT    NOT NULL,
    schema_name        TEXT    DEFAULT '',
    query_name         TEXT    DEFAULT '',
    username           TEXT    NOT NULL,
    password           TEXT    NOT NULL,
    password_encrypted INTEGER DEFAULT 0,
    is_active          INTEGER DEFAULT 0,
    created_at         DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);
// Migrate db_connections — safe no-op if columns already exist
try { db.exec(`ALTER TABLE db_connections ADD COLUMN query_name TEXT DEFAULT ''`); } catch {}
try { db.exec(`ALTER TABLE db_connections ADD COLUMN password_encrypted INTEGER DEFAULT 0`); } catch {}

// ── Password encryption (AES-256-GCM) ────────────────────────────────────────
// Set DB_ENCRYPT_KEY in .env as a 64-char hex string (32 bytes).
// Generate with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
const _ENCRYPT_KEY = process.env.DB_ENCRYPT_KEY || null;

function encryptDbPassword(plain) {
  if (!_ENCRYPT_KEY) return plain;
  const key    = Buffer.from(_ENCRYPT_KEY, 'hex');
  const iv     = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc    = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag    = cipher.getAuthTag();
  return `enc:${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`;
}

function decryptDbPassword(stored) {
  if (!stored || !stored.startsWith('enc:') || !_ENCRYPT_KEY) return stored;
  try {
    const [, ivHex, tagHex, encHex] = stored.split(':');
    const key      = Buffer.from(_ENCRYPT_KEY, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    return decipher.update(Buffer.from(encHex, 'hex'), undefined, 'utf8') + decipher.final('utf8');
  } catch { return stored; }
}

export { encryptDbPassword, decryptDbPassword };

export const dbConnRepo = {
  list: db.prepare(`SELECT id,name,db_type,host,port,database,schema_name,query_name,username,password_encrypted,is_active,created_at FROM db_connections ORDER BY id`),
  getActive() {
    const row = db.prepare(`SELECT * FROM db_connections WHERE is_active=1 LIMIT 1`).get();
    if (row && row.password_encrypted) row.password = decryptDbPassword(row.password);
    return row;
  },
  getById(id) {
    const row = db.prepare(`SELECT * FROM db_connections WHERE id=?`).get(id);
    if (row && row.password_encrypted) row.password = decryptDbPassword(row.password);
    return row;
  },
  create(name, db_type, host, port, database, schema_name, query_name, username, password, password_encrypted) {
    const enc = password_encrypted ? 1 : 0;
    const stored = enc ? encryptDbPassword(password) : password;
    return db.prepare(
      `INSERT INTO db_connections (name,db_type,host,port,database,schema_name,query_name,username,password,password_encrypted) VALUES (?,?,?,?,?,?,?,?,?,?)`
    ).run(name, db_type, host, port||null, database, schema_name||'', query_name||'', username, stored, enc);
  },
  activate(id) {
    db.transaction(() => {
      db.prepare(`UPDATE db_connections SET is_active=0`).run();
      db.prepare(`UPDATE db_connections SET is_active=1 WHERE id=?`).run(id);
    })();
  },
  delete: db.prepare(`DELETE FROM db_connections WHERE id=?`),
  update(id, name, db_type, host, port, database, schema_name, query_name, username, password, password_encrypted) {
    const enc = password_encrypted ? 1 : 0;
    const stored = enc ? encryptDbPassword(password) : password;
    return db.prepare(
      `UPDATE db_connections SET name=?,db_type=?,host=?,port=?,database=?,schema_name=?,query_name=?,username=?,password=?,password_encrypted=? WHERE id=?`
    ).run(name, db_type, host, port||null, database, schema_name||'', query_name||'', username, stored, enc, id);
  },
};

// ── Schema Registry — per-company UDFs, views, tables, saved queries ─────────
db.exec(`
  CREATE TABLE IF NOT EXISTS schema_registry (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    company     TEXT    NOT NULL,
    type        TEXT    NOT NULL DEFAULT 'udf',
    name        TEXT    NOT NULL,
    table_name  TEXT    DEFAULT '',
    definition  TEXT    DEFAULT '',
    description TEXT    DEFAULT '',
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_sr_company ON schema_registry(company);
`);

export const schemaRepo = {
  listByCompany: db.prepare(`SELECT * FROM schema_registry WHERE company=? ORDER BY type, name`),
  getById:       db.prepare(`SELECT * FROM schema_registry WHERE id=?`),
  create(company, type, name, table_name, definition, description) {
    return db.prepare(
      `INSERT INTO schema_registry (company,type,name,table_name,definition,description) VALUES (?,?,?,?,?,?)`
    ).run(company, type, name, table_name||'', definition||'', description||'');
  },
  update(id, type, name, table_name, definition, description) {
    return db.prepare(
      `UPDATE schema_registry SET type=?,name=?,table_name=?,definition=?,description=? WHERE id=?`
    ).run(type, name, table_name||'', definition||'', description||'', id);
  },
  delete: db.prepare(`DELETE FROM schema_registry WHERE id=?`),
  deleteByCompany: db.prepare(`DELETE FROM schema_registry WHERE company=?`),
};

// ── Prompt cache ─────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS prompt_cache (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    prompt_norm    TEXT    NOT NULL,
    prompt_orig    TEXT    NOT NULL,
    tool_name      TEXT    NOT NULL,
    tool_params    TEXT    DEFAULT '{}',
    response_preview TEXT  DEFAULT '',
    used_count     INTEGER DEFAULT 0,
    last_used      DATETIME DEFAULT CURRENT_TIMESTAMP,
    created_at     DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_pc_norm ON prompt_cache(prompt_norm);
`);

// ── AI-generated SQL result cache ────────────────────────────────────────────
// Caches (company + normalized question) → (sql, rows) for a short TTL so
// repeated analytics questions in a session answer instantly instead of
// re-generating SQL via an LLM call and re-querying HANA/MSSQL every time.
db.exec(`
  CREATE TABLE IF NOT EXISTS sql_query_cache (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    cache_key  TEXT    NOT NULL UNIQUE,
    company    TEXT    NOT NULL,
    question   TEXT    NOT NULL,
    sql        TEXT    NOT NULL,
    rows_json  TEXT    NOT NULL,
    row_count  INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_sqc_key ON sql_query_cache(cache_key);
`);

export const sqlCacheRepo = {
  // Returns the cached entry if present and younger than ttlMs, else null.
  get(cacheKey, ttlMs) {
    const row = db.prepare(`SELECT * FROM sql_query_cache WHERE cache_key = ?`).get(cacheKey);
    if (!row) return null;
    const ageMs = Date.now() - new Date(row.created_at + 'Z').getTime();
    if (ageMs > ttlMs) return null;
    return { sql: row.sql, rows: JSON.parse(row.rows_json), rowCount: row.row_count };
  },
  set(cacheKey, company, question, sql, rows) {
    db.prepare(`
      INSERT INTO sql_query_cache (cache_key, company, question, sql, rows_json, row_count)
      VALUES (?,?,?,?,?,?)
      ON CONFLICT(cache_key) DO UPDATE SET
        sql=excluded.sql, rows_json=excluded.rows_json, row_count=excluded.row_count,
        created_at=CURRENT_TIMESTAMP
    `).run(cacheKey, company, question, sql, JSON.stringify(rows), rows.length);
  },
  clear: db.prepare(`DELETE FROM sql_query_cache`),
  // Drop entries older than maxAgeMs — call occasionally to keep the table small.
  prune(maxAgeMs) {
    const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
    db.prepare(`DELETE FROM sql_query_cache WHERE created_at < ?`).run(cutoff);
  },
};

export const queryCacheRepo = {
  list:   db.prepare(`SELECT id, prompt_orig, tool_name, tool_params, response_preview, used_count, last_used, created_at FROM prompt_cache ORDER BY used_count DESC, last_used DESC`),
  findExact(norm) {
    return db.prepare(`SELECT * FROM prompt_cache WHERE prompt_norm = ? ORDER BY used_count DESC LIMIT 1`).get(norm);
  },
  findAll() {
    return db.prepare(`SELECT * FROM prompt_cache ORDER BY used_count DESC`).all();
  },
  upsert(promptNorm, promptOrig, toolName, toolParams, responsePreview) {
    const existing = db.prepare(`SELECT id FROM prompt_cache WHERE prompt_norm = ? AND tool_name = ?`).get(promptNorm, toolName);
    if (existing) {
      db.prepare(`UPDATE prompt_cache SET tool_params=?, response_preview=?, used_count=used_count+1, last_used=CURRENT_TIMESTAMP WHERE id=?`)
        .run(toolParams, responsePreview, existing.id);
      return existing.id;
    } else {
      const r = db.prepare(`INSERT INTO prompt_cache (prompt_norm, prompt_orig, tool_name, tool_params, response_preview) VALUES (?,?,?,?,?)`)
        .run(promptNorm, promptOrig, toolName, toolParams, responsePreview);
      return r.lastInsertRowid;
    }
  },
  incrementUsed: db.prepare(`UPDATE prompt_cache SET used_count=used_count+1, last_used=CURRENT_TIMESTAMP WHERE id=?`),
  delete: db.prepare(`DELETE FROM prompt_cache WHERE id=?`),
  clear:  db.prepare(`DELETE FROM prompt_cache`),
};

// ── Seed: default users ────────────────────────────────────────────────────────
const existingAdmin = userRepo.findByUsername.get("admin");
if (!existingAdmin) {
  userRepo.create("admin", "admin123", "Administrator", "admin");
  console.log("✓ Default admin created  (username: admin / password: admin123)");
}

const existingSuperAdmin = userRepo.findByUsername.get("superadmin");
if (!existingSuperAdmin) {
  userRepo.create("superadmin", "admin123", "Super Administrator", "superadmin");
  console.log("✓ SuperAdmin created  (username: superadmin / password: admin123)");
}

const existingConn = db.prepare(`SELECT COUNT(*) as n FROM connections`).get();
if (existingConn.n === 0 && process.env.SL_BASE_URL) {
  connRepo.create(
    "Default (from .env)",
    process.env.SL_BASE_URL,
    process.env.SL_COMPANY || "",
    process.env.SL_USER    || "",
    process.env.SL_PASSWORD|| ""
  );
  connRepo.activate(1);
  console.log("✓ Default connection seeded from .env");
}

// ── Roles & Permissions ───────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS roles (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    UNIQUE NOT NULL,
    description TEXT    DEFAULT '',
    is_system   INTEGER DEFAULT 0,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS role_permissions (
    role_id  INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    perm_key TEXT    NOT NULL,
    PRIMARY KEY (role_id, perm_key)
  );
`);

// All available permission keys with labels — one entry per individual sidebar
// menu item (not per section) so roles/users can be granted access at
// menu-item granularity. `group` identifies the collapsible sub-group within
// a section for nested display in the admin UI; omitted for items that sit
// directly under a section with no sub-group.
export const ALL_PERMISSIONS = [
  { key: 'home',              label: 'Home (Chat & Dashboard)',      section: 'Home' },
  { key: 'ui.form_mode',      label: 'Form Mode Toggle (Chat/Form switch)', section: 'Home' },

  // Home Insights — the live KPI cards on the launchpad's My Home page. Each
  // key gates its cards, alerts and drill-down lists, in the page and in
  // /api/home/insights (controllers/home-insights.mjs).
  { key: 'insights.finance.pnl',         label: 'Profit & Loss (revenue, margins, expenses, trend)', section: 'Home Insights', group: 'Finance' },
  { key: 'insights.finance.cash',        label: 'Cash & Bank, Cash Flow',          section: 'Home Insights', group: 'Finance' },
  { key: 'insights.finance.balance',     label: 'Balance Sheet & Working Capital', section: 'Home Insights', group: 'Finance' },
  { key: 'insights.finance.ratios',      label: 'Financial Ratios (liquidity, DSO/DPO/DIO, ROE/ROA)', section: 'Home Insights', group: 'Finance' },
  { key: 'insights.finance.receivables', label: 'Receivables Aging & Credit Limits', section: 'Home Insights', group: 'Finance' },
  { key: 'insights.finance.payables',    label: 'Payables Aging',                  section: 'Home Insights', group: 'Finance' },
  { key: 'insights.sales.trend',         label: 'Sales This Month & Trend',        section: 'Home Insights', group: 'Sales' },
  { key: 'insights.sales.orders',        label: 'Open Sales Orders',               section: 'Home Insights', group: 'Sales' },
  { key: 'insights.sales.quotations',    label: 'Open Quotations',                 section: 'Home Insights', group: 'Sales' },
  { key: 'insights.sales.top_customers', label: 'Top Customers',                   section: 'Home Insights', group: 'Sales' },
  { key: 'insights.sales.top_items',     label: 'Top Selling Items',               section: 'Home Insights', group: 'Sales' },
  { key: 'insights.purchase.trend',      label: 'Purchases This Month & Trend',    section: 'Home Insights', group: 'Purchase' },
  { key: 'insights.purchase.orders',     label: 'Open Purchase Orders',            section: 'Home Insights', group: 'Purchase' },
  { key: 'insights.purchase.top_vendors',label: 'Top Vendors',                     section: 'Home Insights', group: 'Purchase' },
  { key: 'insights.inventory.stock',     label: 'Stock Value & Shortages',         section: 'Home Insights', group: 'Inventory' },

  // Master Data
  { key: 'master.item',          label: 'Item Master',          section: 'Master Data' },
  { key: 'master.customer',      label: 'Customer Master',      section: 'Master Data' },
  { key: 'master.gstin_check',   label: 'GSTIN Check',          section: 'Master Data' },
  { key: 'master.bp_check',      label: 'BP Duplicate Check',   section: 'Master Data' },
  { key: 'master.supplier',      label: 'Supplier Master',      section: 'Master Data' },
  { key: 'master.bom',           label: 'Bill of Material',     section: 'Master Data' },
  { key: 'master.service_call',  label: 'Service Call',         section: 'Master Data' },
  { key: 'master.excel_import.item', label: 'Item Master Import (Excel)',      section: 'Master Data', group: 'Excel Import' },
  { key: 'master.excel_import.bp',   label: 'Business Partner Import (Excel)', section: 'Master Data', group: 'Excel Import' },
  { key: 'master.excel_import.bom',  label: 'Bill of Materials Import (Excel)', section: 'Master Data', group: 'Excel Import' },

  // Service Call
  { key: 'service.sc_view',    label: 'Service Call Dashboard', section: 'Service Call' },
  { key: 'service.svc_call',   label: 'New Service Call',       section: 'Service Call' },
  { key: 'service.sc_form',    label: 'Service Call',           section: 'Service Call' },
  { key: 'service.sc_wizard',  label: 'New Call Wizard',        section: 'Service Call' },

  // Sales — O2C : Quick Create
  { key: 'sales.create.quotation', label: 'Quotation',        section: 'Sales — O2C', group: 'Quick Create' },
  { key: 'sales.create.order',     label: 'Sales Order',      section: 'Sales — O2C', group: 'Quick Create' },
  { key: 'sales.create.delivery',  label: 'Delivery',         section: 'Sales — O2C', group: 'Quick Create' },
  { key: 'sales.create.pod',       label: 'Confirm POD',      section: 'Sales — O2C', group: 'Quick Create' },
  { key: 'sales.create.invoice',   label: 'AR Invoice',       section: 'Sales — O2C', group: 'Quick Create' },
  { key: 'sales.create.payment',   label: 'Incoming Payment', section: 'Sales — O2C', group: 'Quick Create' },
  { key: 'sales.create.atp',       label: 'ATP Check',        section: 'Sales — O2C', group: 'Quick Create' },

  // Sales — O2C : AI Workflow
  { key: 'sales.workflow.sales_order',       label: 'Sales Order',        section: 'Sales — O2C', group: 'AI Workflow' },
  { key: 'sales.workflow.quotation',         label: 'Sales Quotation',    section: 'Sales — O2C', group: 'AI Workflow' },
  { key: 'sales.workflow.quote_compare',     label: 'Quotation Compare',  section: 'Sales — O2C', group: 'AI Workflow' },
  { key: 'sales.workflow.quote_to_order',    label: 'Quot → Order',       section: 'Sales — O2C', group: 'AI Workflow' },
  { key: 'sales.workflow.order_confirmation', label: 'Order Confirmation', section: 'Sales — O2C', group: 'AI Workflow' },
  { key: 'sales.workflow.load_planner',      label: 'Load Planner',       section: 'Sales — O2C', group: 'AI Workflow' },
  { key: 'sales.workflow.so_excel_import',   label: 'Sales Order Excel Import', section: 'Sales — O2C', group: 'AI Workflow' },
  { key: 'sales.workflow.so_excel_import_templates', label: 'Sales Order Excel Import — Manage Templates', section: 'Sales — O2C', group: 'AI Workflow' },
  { key: 'tools.excel_import_templates', label: 'Excel Import — Manage Templates (all import agents)', section: 'Tools' },
  { key: 'sales.workflow.order_to_delivery', label: 'Order → Delivery',   section: 'Sales — O2C', group: 'AI Workflow' },
  { key: 'sales.workflow.delivery_to_arinv', label: 'Delivery → AR Inv',  section: 'Sales — O2C', group: 'AI Workflow' },
  { key: 'sales.workflow.arinv_to_arcm',     label: 'AR Inv → Credit',    section: 'Sales — O2C', group: 'AI Workflow' },
  { key: 'sales.workflow.incoming_payment',  label: 'Incoming Payment',   section: 'Sales — O2C', group: 'AI Workflow' },
  { key: 'sales.workflow.sales_analysis_link', label: 'Sales Analysis',  section: 'Sales — O2C', group: 'AI Workflow' },

  // Sales — O2C : Sales Report
  { key: 'sales.analysis.open_orders',     label: 'Open Orders',       section: 'Sales — O2C', group: 'Sales Report' },
  { key: 'sales.analysis.open_quotations', label: 'Open Quotations',   section: 'Sales — O2C', group: 'Sales Report' },
  { key: 'sales.analysis.top_customers',   label: 'Top Customers',     section: 'Sales — O2C', group: 'Sales Report' },
  { key: 'sales.analysis.monthly_trend',   label: 'Monthly Trend',     section: 'Sales — O2C', group: 'Sales Report' },
  { key: 'sales.analysis.quarterly_sales', label: 'Quarterly Sales',   section: 'Sales — O2C', group: 'Sales Report' },
  { key: 'sales.analysis.top_items',       label: 'Top Items',         section: 'Sales — O2C', group: 'Sales Report' },
  { key: 'sales.analysis.by_salesperson',  label: 'By Salesperson',    section: 'Sales — O2C', group: 'Sales Report' },
  { key: 'sales.analysis.by_gross_profit', label: 'By Gross Profit',   section: 'Sales — O2C', group: 'Sales Report' },
  { key: 'sales.analysis.by_gp_margin',    label: 'By GP Margin',      section: 'Sales — O2C', group: 'Sales Report' },
  { key: 'sales.analysis.by_warehouse',    label: 'By Warehouse',      section: 'Sales — O2C', group: 'Sales Report' },

  // Purchase — P2P : Quick Create
  { key: 'purchase.create.purchase_order',   label: 'Purchase Order',    section: 'Purchase — P2P', group: 'Quick Create' },
  { key: 'purchase.create.grpo',             label: 'Goods Receipt PO',  section: 'Purchase — P2P', group: 'Quick Create' },
  { key: 'purchase.create.ap_invoice',       label: 'A/P Invoice',       section: 'Purchase — P2P', group: 'Quick Create' },
  { key: 'purchase.create.outgoing_payment', label: 'Pay Vendor',        section: 'Purchase — P2P', group: 'Quick Create' },

  // Purchase — P2P : AI Workflow
  { key: 'purchase.workflow.pr_agent',        label: 'Purchase Request Agent', section: 'Purchase — P2P', group: 'AI Workflow' },
  { key: 'purchase.workflow.po_agent',        label: 'Purchase Order',         section: 'Purchase — P2P', group: 'AI Workflow' },
  { key: 'purchase.workflow.pr_to_po',        label: 'PR → PO',                section: 'Purchase — P2P', group: 'AI Workflow' },
  { key: 'purchase.workflow.po_to_grpo',      label: 'PO → GRPO',              section: 'Purchase — P2P', group: 'AI Workflow' },
  { key: 'purchase.workflow.grpo_to_apinv',   label: 'GRPO → AP Inv',          section: 'Purchase — P2P', group: 'AI Workflow' },
  { key: 'purchase.workflow.apinv_service',   label: 'AP Service Invoice',     section: 'Purchase — P2P', group: 'AI Workflow' },
  { key: 'purchase.workflow.apinv_excel_import', label: 'A/P Expense Invoice Import (Excel)', section: 'Purchase — P2P', group: 'AI Workflow' },
  { key: 'purchase.workflow.three_way_match', label: '3-Way Match',            section: 'Purchase — P2P', group: 'AI Workflow' },
  { key: 'purchase.workflow.apinv_to_apcm',   label: 'AP Inv → Credit',        section: 'Purchase — P2P', group: 'AI Workflow' },
  { key: 'purchase.workflow.outgoing_payment',label: 'Outgoing Payment',       section: 'Purchase — P2P', group: 'AI Workflow' },
  { key: 'purchase.workflow.vp_aging',        label: 'AP Aging Report',        section: 'Purchase — P2P', group: 'AI Workflow' },
  { key: 'purchase.workflow.purchase_analysis_link', label: 'Purchase Analysis', section: 'Purchase — P2P', group: 'AI Workflow' },
  { key: 'purchase.workflow.grpo_sorting',    label: 'GRPO Sorting',           section: 'Purchase — P2P', group: 'AI Workflow' },
  { key: 'purchase.workflow.grpo_sorting_supervise', label: 'GRPO Sorting — Supervisor', section: 'Purchase — P2P', group: 'AI Workflow' },
  { key: 'purchase.workflow.sorting_analytics', label: 'Sorting Analytics', section: 'Purchase — P2P', group: 'AI Workflow' },
  { key: 'purchase.workflow.putaway_analytics', label: 'Putaway Analytics', section: 'Purchase — P2P', group: 'AI Workflow' },
  { key: 'purchase.workflow.warehouse_twin',    label: 'Warehouse Digital Twin', section: 'Purchase — P2P', group: 'AI Workflow' },

  // Purchase — P2P : Procurement Analysis
  { key: 'purchase.analysis.purchase_analysis', label: 'Purchase Analysis', section: 'Purchase — P2P', group: 'Procurement Analysis' },
  { key: 'purchase.analysis.top_vendors',       label: 'Top Vendors',       section: 'Purchase — P2P', group: 'Procurement Analysis' },
  { key: 'purchase.analysis.vendor_list',       label: 'Vendor List',       section: 'Purchase — P2P', group: 'Procurement Analysis' },
  { key: 'purchase.analysis.customer_list',     label: 'Customer List',     section: 'Purchase — P2P', group: 'Procurement Analysis' },

  // Finance
  { key: 'finance.ar_aging',            label: 'AR Aging',              section: 'Finance', group: 'AR & Collections' },
  { key: 'finance.overdue_30',          label: 'Overdue 30 Days',       section: 'Finance', group: 'AR & Collections' },
  { key: 'finance.overdue_60',          label: 'Overdue 60 Days',       section: 'Finance', group: 'AR & Collections' },
  { key: 'finance.ap_aging',            label: 'AP Aging',              section: 'Finance', group: 'AR & Collections' },
  { key: 'finance.financial_dashboard', label: 'Financial Dashboard',   section: 'Finance' },
  { key: 'finance.customer_aging',      label: 'Customer Aging Detail', section: 'Finance' },
  { key: 'finance.salary_jv_import',    label: 'Salary → Journal Entry (Excel)', section: 'Finance' },
  { key: 'finance.reports.balance_sheet', label: 'Balance Sheet',        section: 'Finance', group: 'Financial Reports' },
  { key: 'finance.reports.profit_loss',   label: 'Profit & Loss',        section: 'Finance', group: 'Financial Reports' },
  { key: 'finance.reports.trial_balance', label: 'Trial Balance',        section: 'Finance', group: 'Financial Reports' },

  // Inventory
  { key: 'inventory.stock_levels',   label: 'Stock Levels',     section: 'Inventory', group: 'Stock & Warehouse' },
  { key: 'inventory.in_stock_items', label: 'In-Stock Items',   section: 'Inventory', group: 'Stock & Warehouse' },
  { key: 'inventory.pick_list',      label: 'Pick List',        section: 'Inventory', group: 'Stock & Warehouse' },
  { key: 'inventory.atp_check',      label: 'ATP Check',        section: 'Inventory', group: 'Stock & Warehouse' },
  { key: 'inventory.dashboard',      label: 'Inventory Dashboard & Reports', section: 'Inventory', group: 'Stock & Warehouse' },

  // Inventory : AI Workflow — these post stock-moving documents, so the
  // inventory-agent controller also enforces them server-side per request.
  { key: 'inventory.workflow.transfer_request',      label: 'Stock Transfer Request',      section: 'Inventory', group: 'AI Workflow' },
  { key: 'inventory.workflow.transfer_from_request', label: 'Stock Transfer from Request', section: 'Inventory', group: 'AI Workflow' },
  { key: 'inventory.workflow.transfer_direct',       label: 'Stock Transfer (Direct)',     section: 'Inventory', group: 'AI Workflow' },
  { key: 'inventory.workflow.goods_issue',           label: 'Goods Issue',                 section: 'Inventory', group: 'AI Workflow' },
  { key: 'inventory.workflow.goods_receipt',         label: 'Goods Receipt',               section: 'Inventory', group: 'AI Workflow' },

  // AI Agents : Finance & Credit
  { key: 'ai.finance.collections',   label: 'Collections & Receivables', section: 'AI Agents', group: 'Finance & Credit' },
  { key: 'ai.finance.cashflow',      label: 'Cash Flow Forecast',        section: 'AI Agents', group: 'Finance & Credit' },
  { key: 'ai.finance.creditrisk',    label: 'Credit Risk',               section: 'AI Agents', group: 'Finance & Credit' },
  { key: 'ai.finance.appayment',     label: 'AP Payment Optimization',   section: 'AI Agents', group: 'Finance & Credit' },
  { key: 'ai.finance.profitability', label: 'Profitability',             section: 'AI Agents', group: 'Finance & Credit' },
  { key: 'ai.finance.marginleak',    label: 'Margin Leakage',            section: 'AI Agents', group: 'Finance & Credit' },
  { key: 'ai.finance.commission',    label: 'Sales Commission',          section: 'AI Agents', group: 'Finance & Credit' },
  { key: 'ai.finance.monthend',      label: 'Month-End Closing',         section: 'AI Agents', group: 'Finance & Credit' },

  // AI Agents : Supply Chain
  { key: 'ai.supply.mrp_auto_po',       label: 'MRP Auto-PO',              section: 'AI Agents', group: 'Supply Chain' },
  { key: 'ai.supply.procurement_agent', label: 'Stock Reorder Monitor',    section: 'AI Agents', group: 'Supply Chain' },
  { key: 'ai.supply.three_way_match',   label: 'Purchase Three Way Match', section: 'AI Agents', group: 'Supply Chain' },
  { key: 'ai.supply.production_agent',  label: 'Production Agent',         section: 'AI Agents', group: 'Supply Chain' },
  { key: 'ai.supply.purchasing_agent',  label: 'Purchase Recommendation',  section: 'AI Agents', group: 'Supply Chain' },
  { key: 'ai.supply.rush_orders',       label: 'Rush Orders',              section: 'AI Agents', group: 'Supply Chain' },
  { key: 'ai.supply.shipment_delay',    label: 'Shipment Delays',          section: 'AI Agents', group: 'Supply Chain' },
  { key: 'ai.supply.sc_forecast',       label: 'Supply Chain Demand Forecast', section: 'AI Agents', group: 'Supply Chain' },
  { key: 'ai.supply.inv_opt',           label: 'Inventory Optimization',   section: 'AI Agents', group: 'Supply Chain' },
  { key: 'ai.supply.dead_stock',        label: 'Dead Stock',               section: 'AI Agents', group: 'Supply Chain' },
  { key: 'ai.supply.vendor_perf',       label: 'Vendor Performance',       section: 'AI Agents', group: 'Supply Chain' },

  // AI Agents : OCR Processing
  { key: 'ai.ocr.po_scan',  label: 'Scan PO',           section: 'AI Agents', group: 'OCR Processing' },
  { key: 'ai.ocr.expense',  label: 'Scan Expense Invoice', section: 'AI Agents', group: 'OCR Processing' },
  { key: 'ai.ocr.apinv',    label: 'Scan A/P Invoice',     section: 'AI Agents', group: 'OCR Processing' },
  { key: 'ai.ocr.bank_reco', label: 'Bank Reconciliation', section: 'AI Agents', group: 'OCR Processing' },
  { key: 'ai.ocr.inward',   label: 'Scan Inward',          section: 'AI Agents', group: 'OCR Processing' },
  { key: 'ai.ocr.gatepass', label: 'Scan Gate Pass',       section: 'AI Agents', group: 'OCR Processing' },
  { key: 'ai.ocr.document', label: 'Scan Document Mode',  section: 'AI Agents', group: 'OCR Processing' },

  // AP Invoice Processing (folder / mail / upload intake → OCR → approval → SAP A/P Invoice)
  { key: 'apip.dashboard', label: 'Processing Dashboard', section: 'AP Invoice Processing', group: 'AP Invoice Processing' },
  { key: 'apip.queue', label: 'Invoice Queue', section: 'AP Invoice Processing', group: 'AP Invoice Processing' },
  { key: 'apip.approvals', label: 'Invoice Approval', section: 'AP Invoice Processing', group: 'AP Invoice Processing' },
  { key: 'apip.stages', label: 'Approval Stage', section: 'AP Invoice Processing', group: 'AP Invoice Processing' },
  { key: 'apip.master', label: 'Approval Master', section: 'AP Invoice Processing', group: 'AP Invoice Processing' },
  { key: 'apip.vitems', label: 'Vendor Item Mapping', section: 'AP Invoice Processing', group: 'AP Invoice Processing' },
  { key: 'apip.vexpense', label: 'Vendor Expense G/L', section: 'AP Invoice Processing', group: 'AP Invoice Processing' },
  { key: 'apip.mail', label: 'Mail Configuration', section: 'AP Invoice Processing', group: 'AP Invoice Processing' },
  { key: 'apip.settings', label: 'Settings', section: 'AP Invoice Processing', group: 'AP Invoice Processing' },

  // AI Agents : Sales & Pricing
  { key: 'ai.sales.dynamic_pricing',    label: 'Dynamic Pricing',       section: 'AI Agents', group: 'Sales & Pricing' },
  { key: 'ai.sales.order_intelligence', label: 'Order Intelligence',    section: 'AI Agents', group: 'Sales & Pricing' },
  { key: 'ai.sales.product_forecast',   label: 'Product Forecasting',   section: 'AI Agents', group: 'Sales & Pricing' },
  { key: 'ai.sales.followup',           label: 'Sales Follow-up',       section: 'AI Agents', group: 'Sales & Pricing' },
  { key: 'ai.sales.quote_intel',        label: 'Quotation Intelligence',section: 'AI Agents', group: 'Sales & Pricing' },
  { key: 'ai.sales.mail_po',            label: 'Mail PO → SO',          section: 'AI Agents', group: 'Sales & Pricing' },
  { key: 'ai.sales.po_workflow',        label: 'PO → Sales Order',      section: 'AI Agents', group: 'Sales & Pricing' },

  // AI Agents : CRM & Service
  { key: 'ai.crm.activity_agent',  label: 'Activity Agent',  section: 'AI Agents', group: 'CRM & Service' },
  { key: 'ai.crm.prompt_activity', label: 'Prompt Activity', section: 'AI Agents', group: 'CRM & Service' },

  // Analytics AI
  { key: 'analytics.inv.abc_xyz',             label: 'ABC-XYZ Classification', section: 'Analytics AI', group: 'Inventory' },
  { key: 'analytics.inv.stockout_prediction', label: 'Stockout Prediction',    section: 'Analytics AI', group: 'Inventory' },
  { key: 'analytics.inv.dead_slow_stock',     label: 'Dead/Slow Stock',        section: 'Analytics AI', group: 'Inventory' },
  { key: 'analytics.inv.reorder_points',      label: 'Reorder Points (ROP)',   section: 'Analytics AI', group: 'Inventory' },
  { key: 'analytics.inv.eoq',                 label: 'EOQ Calculator',         section: 'Analytics AI', group: 'Inventory' },

  { key: 'analytics.cust.rfm',                   label: 'RFM Segmentation',      section: 'Analytics AI', group: 'Customer Intelligence' },
  { key: 'analytics.cust.churn',                  label: 'Churn Prediction',      section: 'Analytics AI', group: 'Customer Intelligence' },
  { key: 'analytics.cust.clv',                    label: 'Customer CLV',          section: 'Analytics AI', group: 'Customer Intelligence' },
  { key: 'analytics.cust.revenue_concentration',  label: 'Revenue Concentration', section: 'Analytics AI', group: 'Customer Intelligence' },
  { key: 'analytics.cust.quote_win_rate',         label: 'Quotation Win Rate',    section: 'Analytics AI', group: 'Customer Intelligence' },

  { key: 'analytics.fin.working_capital',      label: 'Working Capital (CCC)', section: 'Analytics AI', group: 'Finance' },
  { key: 'analytics.fin.margin_erosion',       label: 'Margin Erosion',        section: 'Analytics AI', group: 'Finance' },
  { key: 'analytics.fin.transaction_outliers', label: 'Transaction Outliers',  section: 'Analytics AI', group: 'Finance' },
  { key: 'analytics.fin.cash_flow_forecast',   label: 'Cash Flow Forecast',    section: 'Analytics AI', group: 'Finance' },

  { key: 'analytics.vend.lead_time',        label: 'Vendor Lead Time',      section: 'Analytics AI', group: 'Vendor / Procurement' },
  { key: 'analytics.vend.on_time_delivery', label: 'On-Time Delivery',      section: 'Analytics AI', group: 'Vendor / Procurement' },
  { key: 'analytics.vend.concentration',    label: 'Vendor Concentration',  section: 'Analytics AI', group: 'Vendor / Procurement' },

  { key: 'analytics.fcast.sales_forecast',  label: 'Sales Forecast',        section: 'Analytics AI', group: 'Forecasting' },
  { key: 'analytics.fcast.demand_forecast', label: 'Demand Forecast',       section: 'Analytics AI', group: 'Forecasting' },
  { key: 'analytics.fcast.seasonality',     label: 'Seasonality Detection', section: 'Analytics AI', group: 'Forecasting' },

  // Forecast
  { key: 'forecast.demand_forecast', label: 'Demand Forecast',    section: 'Forecast', group: 'Forecasting Tools' },
  { key: 'forecast.b1_forecast',     label: 'Forecast with B1',   section: 'Forecast', group: 'Forecasting Tools' },
  { key: 'forecast.dashboard',       label: 'Forecast Dashboard', section: 'Forecast', group: 'Forecasting Tools' },

  // Tools
  { key: 'tools.ai_model',   label: 'AI Model Selector',              section: 'Tools' },
  { key: 'tools.chat_panel', label: 'AI Chat Panel',                  section: 'Tools' },
  { key: 'tools.data_sync',  label: 'Data Sync (SAP to Local Cache)', section: 'Tools' },
  { key: 'tools.db',         label: 'DB Connection',                  section: 'Tools' },
  { key: 'tools.builder',    label: 'DB Query Builder', section: 'Tools', group: 'Developer Tools' },
  { key: 'tools.udt_create', label: 'Create UDT',       section: 'Tools', group: 'Developer Tools' },
  { key: 'tools.udt_view',   label: 'View UDTs',        section: 'Tools', group: 'Developer Tools' },
  { key: 'tools.library',    label: 'Query Library',    section: 'Tools', group: 'Developer Tools' },
  { key: 'tools.schema',     label: 'Schema Registry',  section: 'Tools', group: 'Developer Tools' },
  { key: 'tools.reports',    label: 'Reports Engine',   section: 'Tools', group: 'Developer Tools' },

  // Admin
  { key: 'admin.users',              label: 'User Management',    section: 'Admin' },
  { key: 'admin.roles',              label: 'Roles & Permissions',section: 'Admin' },
  { key: 'admin.user_rights',        label: 'User Rights',        section: 'Admin' },
  { key: 'admin.company_setup',      label: 'Company Setup',      section: 'Admin' },
  { key: 'admin.developer_settings', label: 'Developer Settings',section: 'Admin' },
  { key: 'admin.ai_credits',         label: 'AI Credits & Usage', section: 'Admin' },
];

// ── Legacy → item-level permission migration map ──────────────────────────────
// Before this upgrade, permissions gated whole menu sections/groups at once
// (e.g. one 'sales.create' key covered all 7 Quick Create forms). These keys
// no longer appear in ALL_PERMISSIONS above; this map lets the one-time
// migration below expand any role/user still holding an old key into the
// equivalent set of new item-level keys, so nobody's access changes.
export const LEGACY_PERMISSION_CHILDREN = {
  'sales.create':    ['sales.create.quotation','sales.create.order','sales.create.delivery','sales.create.pod','sales.create.invoice','sales.create.payment','sales.create.atp'],
  'sales.workflow':  ['sales.workflow.sales_order','sales.workflow.quotation','sales.workflow.quote_compare','sales.workflow.quote_to_order','sales.workflow.order_to_delivery','sales.workflow.delivery_to_arinv','sales.workflow.arinv_to_arcm','sales.workflow.incoming_payment','sales.workflow.sales_analysis_link'],
  'sales.analysis':  ['sales.analysis.open_orders','sales.analysis.open_quotations','sales.analysis.top_customers','sales.analysis.monthly_trend','sales.analysis.quarterly_sales','sales.analysis.top_items','sales.analysis.by_salesperson','sales.analysis.by_gross_profit','sales.analysis.by_gp_margin','sales.analysis.by_warehouse'],
  'purchase.create':   ['purchase.create.purchase_order','purchase.create.grpo','purchase.create.ap_invoice','purchase.create.outgoing_payment'],
  'purchase.workflow': ['purchase.workflow.pr_agent','purchase.workflow.po_agent','purchase.workflow.pr_to_po','purchase.workflow.po_to_grpo','purchase.workflow.grpo_to_apinv','purchase.workflow.apinv_service','purchase.workflow.three_way_match','purchase.workflow.apinv_to_apcm','purchase.workflow.outgoing_payment','purchase.workflow.vp_aging','purchase.workflow.purchase_analysis_link','purchase.workflow.grpo_sorting'],
  'purchase.analysis': ['purchase.analysis.purchase_analysis','purchase.analysis.top_vendors','purchase.analysis.vendor_list','purchase.analysis.customer_list'],
  'finance':    ['finance.ar_aging','finance.overdue_30','finance.overdue_60','finance.ap_aging','finance.financial_dashboard','finance.customer_aging','finance.reports.balance_sheet','finance.reports.profit_loss','finance.reports.trial_balance'],
  'inventory':  ['inventory.stock_levels','inventory.in_stock_items','inventory.pick_list','inventory.atp_check','inventory.dashboard'],
  'ai.supply':  ['ai.supply.mrp_auto_po','ai.supply.procurement_agent','ai.supply.three_way_match','ai.supply.production_agent','ai.supply.purchasing_agent','ai.supply.rush_orders','ai.supply.shipment_delay','ai.supply.inv_opt','ai.supply.dead_stock','ai.supply.vendor_perf'],
  'ai.ocr':     ['ai.ocr.po_scan','ai.ocr.expense','ai.ocr.apinv','ai.ocr.bank_reco','ai.ocr.inward','ai.ocr.gatepass','ai.ocr.document'],
  'ai.sales':   ['ai.sales.dynamic_pricing','ai.sales.order_intelligence','ai.sales.product_forecast','ai.sales.followup','ai.sales.quote_intel','ai.sales.mail_po','ai.sales.po_workflow'],
  'ai.crm':     ['ai.crm.activity_agent','ai.crm.prompt_activity'],
  'analytics':  ['analytics.inv.abc_xyz','analytics.inv.stockout_prediction','analytics.inv.dead_slow_stock','analytics.inv.reorder_points','analytics.inv.eoq','analytics.cust.rfm','analytics.cust.churn','analytics.cust.clv','analytics.cust.revenue_concentration','analytics.cust.quote_win_rate','analytics.fin.working_capital','analytics.fin.margin_erosion','analytics.fin.transaction_outliers','analytics.fin.cash_flow_forecast','analytics.vend.lead_time','analytics.vend.on_time_delivery','analytics.vend.concentration','analytics.fcast.sales_forecast','analytics.fcast.demand_forecast','analytics.fcast.seasonality'],
  'forecast':   ['forecast.demand_forecast','forecast.b1_forecast','forecast.dashboard'],
  'tools.udt':  ['tools.udt_create','tools.udt_view'],
};

// Special case: the 8 "Finance & Credit" AI agent items had no permission
// gate of their own before — they were visible to anyone who could see the
// AI Agents section at all (i.e. held any one of these 5 legacy keys).
const AI_FINANCE_CHILDREN    = ['ai.finance.collections','ai.finance.cashflow','ai.finance.creditrisk','ai.finance.appayment','ai.finance.profitability','ai.finance.marginleak','ai.finance.commission','ai.finance.monthend'];
const AI_FINANCE_TRIGGER_KEYS = ['ai.supply','ai.ocr','ai.sales','ai.crm','finance'];

// Special case: User Rights / Company Setup / Developer Settings had no
// permission gate of their own — they appeared whenever the whole Admin
// section was revealed (i.e. admin.users or admin.roles was granted).
const ADMIN_EXTRA_CHILDREN  = ['admin.user_rights','admin.company_setup','admin.developer_settings'];
const ADMIN_TRIGGER_KEYS    = ['admin.users','admin.roles'];

// Special case: GSTIN Check / BP Duplicate Check had no permission gate of
// their own — they appeared whenever Customer Master was granted. Unlike the
// LEGACY_PERMISSION_CHILDREN map above, 'master.customer' is NOT a removed
// key (it still gates the Customer Master menu item itself), so it must be
// additively granted here, never deleted.
const MASTER_CUSTOMER_EXTRA_CHILDREN = ['master.gstin_check','master.bp_check'];
const MASTER_CUSTOMER_TRIGGER_KEYS   = ['master.customer'];

export const roleRepo = {
  list:    db.prepare(`SELECT * FROM roles ORDER BY id`),
  getById: db.prepare(`SELECT * FROM roles WHERE id=?`),
  getByName: db.prepare(`SELECT * FROM roles WHERE name=?`),
  create(name, description='') {
    return db.prepare(`INSERT INTO roles(name,description) VALUES(?,?)`).run(name, description);
  },
  update(id, name, description) {
    return db.prepare(`UPDATE roles SET name=?,description=? WHERE id=? AND is_system=0`).run(name, description, id);
  },
  delete(id) {
    return db.prepare(`DELETE FROM roles WHERE id=? AND is_system=0`).run(id);
  },
  getPermissions(roleId) {
    return db.prepare(`SELECT perm_key FROM role_permissions WHERE role_id=?`).all(roleId).map(r=>r.perm_key);
  },
  setPermissions(roleId, keys) {
    db.transaction(() => {
      db.prepare(`DELETE FROM role_permissions WHERE role_id=?`).run(roleId);
      const ins = db.prepare(`INSERT OR IGNORE INTO role_permissions(role_id,perm_key) VALUES(?,?)`);
      for (const k of keys) ins.run(roleId, k);
    })();
  },
  getPermissionsByRoleName(roleName) {
    if (roleName === 'superadmin') return ALL_PERMISSIONS.map(p=>p.key);
    const role = db.prepare(`SELECT id FROM roles WHERE name=?`).get(roleName);
    if (!role) return [];
    return db.prepare(`SELECT perm_key FROM role_permissions WHERE role_id=?`).all(role.id).map(r=>r.perm_key);
  },
};

// ── Per-user permission overrides ─────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS user_permissions (
    user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    perm_key TEXT    NOT NULL,
    granted  INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (user_id, perm_key)
  );
`);

export const userPermRepo = {
  getOverrides(userId) {
    return db.prepare(`SELECT perm_key, granted FROM user_permissions WHERE user_id=?`).all(userId);
  },
  setOverrides(userId, overrides) {
    // overrides: [{perm_key, granted}]
    db.transaction(() => {
      db.prepare(`DELETE FROM user_permissions WHERE user_id=?`).run(userId);
      const ins = db.prepare(`INSERT INTO user_permissions(user_id,perm_key,granted) VALUES(?,?,?)`);
      for (const o of overrides) ins.run(userId, o.perm_key, o.granted ? 1 : 0);
    })();
  },
  // Merge role perms + user overrides → final effective set
  getEffective(userId, roleName) {
    if (roleName === 'superadmin') return ALL_PERMISSIONS.map(p => p.key);
    const rolePerms = new Set(roleRepo.getPermissionsByRoleName(roleName));
    const overrides = db.prepare(`SELECT perm_key, granted FROM user_permissions WHERE user_id=?`).all(userId);
    for (const o of overrides) {
      if (o.granted) rolePerms.add(o.perm_key);
      else rolePerms.delete(o.perm_key);
    }
    return [...rolePerms];
  },
};

// Seed default roles
const seedRoles = [
  { name:'superadmin', desc:'Full access — all permissions, cannot be modified', perms: ALL_PERMISSIONS.map(p=>p.key) },
  { name:'admin',      desc:'Manage users, view all data, configure settings',   perms: ALL_PERMISSIONS.map(p=>p.key) },
  { name:'user',       desc:'Standard user — basic sales and purchase access',   perms: [
      'home','ui.form_mode',
      ...LEGACY_PERMISSION_CHILDREN['sales.create'],
      ...LEGACY_PERMISSION_CHILDREN['sales.workflow'],
      ...LEGACY_PERMISSION_CHILDREN['sales.analysis'],
      ...LEGACY_PERMISSION_CHILDREN['purchase.create'],
      ...LEGACY_PERMISSION_CHILDREN['purchase.workflow'],
      ...LEGACY_PERMISSION_CHILDREN['purchase.analysis'],
      ...LEGACY_PERMISSION_CHILDREN['finance'],
      ...LEGACY_PERMISSION_CHILDREN['inventory'],
    ] },
];
for (const r of seedRoles) {
  const existing = db.prepare(`SELECT id FROM roles WHERE name=?`).get(r.name);
  if (!existing) {
    const info = db.prepare(`INSERT INTO roles(name,description,is_system) VALUES(?,?,1)`).run(r.name, r.desc);
    roleRepo.setPermissions(info.lastInsertRowid, r.perms);
    console.log(`✓ Role seeded: ${r.name}`);
  } else if (r.name === 'superadmin') {
    // superadmin is fixed/immutable by design — always force the full set
    roleRepo.setPermissions(existing.id, r.perms);
  }
  // admin/user are editable via Roles & Permissions and, once the role row
  // exists, are never touched here again — not even to "backfill" keys that
  // are absent from their current stored set. An absent key on an existing
  // role is indistinguishable from "an admin deliberately unchecked this",
  // and re-adding it on every restart would silently undo that edit forever
  // (this previously happened to the 'admin' role in practice). A newly
  // introduced permission key reaching an existing role is instead handled
  // by an explicit, one-time migration entry (see LEGACY_PERMISSION_CHILDREN
  // and expandLegacyKeys below) — a deliberate decision, not a blanket sync.
}

// ── One-time migration: expand legacy group-level permission keys into the
// new per-menu-item keys, so existing roles/users keep exactly the access
// they had before menus were split to item-level granularity. Purely
// additive (never removes a new key) and self-terminating: it deletes the
// legacy key once expanded, so there is nothing left to re-expand on the
// next boot, and an admin's later deliberate revocation of a child key
// sticks.
function expandLegacyKeys(keys) {
  const set = new Set(keys);
  const toAdd = new Set();
  const legacyPresent = [];
  // Only queue a child key if it isn't already held — otherwise every role
  // holding a still-valid trigger key (e.g. 'admin.roles', 'finance') would
  // report a "migration" on every single boot even though nothing changed.
  const addIfMissing = k => { if (!set.has(k)) toAdd.add(k); };
  // ADMIN_* / MASTER_CUSTOMER_* triggers are still-valid keys, so they can't
  // run here (every boot) — they'd re-grant a child an admin later unchecked.
  // They're applied once via ONE_TIME_GRANTS below instead.
  if (AI_FINANCE_TRIGGER_KEYS.some(k => set.has(k)))       AI_FINANCE_CHILDREN.forEach(addIfMissing);
  for (const [legacy, children] of Object.entries(LEGACY_PERMISSION_CHILDREN)) {
    if (set.has(legacy)) {
      children.forEach(addIfMissing);
      legacyPresent.push(legacy);
    }
  }
  return { toAdd: [...toAdd], legacyPresent };
}

for (const role of roleRepo.list.all()) {
  if (role.name === 'superadmin') continue; // always gets the full current set already
  const current = roleRepo.getPermissions(role.id);
  const { toAdd, legacyPresent } = expandLegacyKeys(current);
  if (toAdd.length || legacyPresent.length) {
    const next = new Set(current);
    toAdd.forEach(k => next.add(k));
    legacyPresent.forEach(k => next.delete(k));
    roleRepo.setPermissions(role.id, [...next]);
    console.log(`✓ Role '${role.name}': migrated legacy permission(s) [${legacyPresent.join(', ')}] → ${toAdd.length} item-level key(s)`);
  }
}
{
  const userIds = db.prepare(`SELECT DISTINCT user_id FROM user_permissions`).all().map(r => r.user_id);
  for (const uid of userIds) {
    const overrides = db.prepare(`SELECT perm_key, granted FROM user_permissions WHERE user_id=?`).all(uid);
    const granted = overrides.filter(o => o.granted).map(o => o.perm_key);
    const { toAdd, legacyPresent } = expandLegacyKeys(granted);
    if (toAdd.length || legacyPresent.length) {
      const keep = overrides.filter(o => !legacyPresent.includes(o.perm_key));
      const additions = toAdd.map(k => ({ perm_key: k, granted: 1 }));
      db.transaction(() => {
        db.prepare(`DELETE FROM user_permissions WHERE user_id=?`).run(uid);
        const ins = db.prepare(`INSERT INTO user_permissions(user_id,perm_key,granted) VALUES(?,?,?)`);
        for (const o of [...keep, ...additions]) ins.run(uid, o.perm_key, o.granted ? 1 : 0);
      })();
      console.log(`✓ User #${uid}: migrated legacy permission override(s) [${legacyPresent.join(', ')}] → ${toAdd.length} item-level key(s)`);
    }
  }
}

// ── One-time grants for newly introduced menu items. Unlike expandLegacyKeys
// above (which re-runs every boot), each entry here is applied exactly once
// and recorded, so an admin who later revokes the new key keeps it revoked.
db.exec(`CREATE TABLE IF NOT EXISTS permission_grants_applied (name TEXT PRIMARY KEY, applied_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
const ONE_TIME_GRANTS = [
  // User Rights / Company Setup / Developer Settings and GSTIN Check / BP
  // Duplicate Check — formerly re-granted on every boot by expandLegacyKeys,
  // which made unchecking them impossible.
  { name: 'admin.extra_children.v1', trigger: ADMIN_TRIGGER_KEYS, keys: ADMIN_EXTRA_CHILDREN },
  { name: 'master.customer_extra_children.v1', trigger: MASTER_CUSTOMER_TRIGGER_KEYS, keys: MASTER_CUSTOMER_EXTRA_CHILDREN },
  // Financial Reports (Balance Sheet / P&L / Trial Balance) → whoever could
  // already see the Financial Dashboard.
  { name: 'finance.reports.v1', trigger: ['finance.financial_dashboard'],
    keys: ['finance.reports.balance_sheet','finance.reports.profit_loss','finance.reports.trial_balance'] },
  // Inventory AI Workflow (transfers / goods issue / goods receipt) → only
  // whoever can already manage roles, since these post stock movements;
  // admins then assign them to other roles via Roles & Permissions.
  { name: 'inventory.workflow.v1', trigger: ['admin.roles'],
    keys: ['inventory.workflow.transfer_request','inventory.workflow.transfer_from_request','inventory.workflow.transfer_direct','inventory.workflow.goods_issue','inventory.workflow.goods_receipt'] },
  // Supply Chain Demand Forecast → whoever could already see its sibling
  // insight agent, Inventory Optimization, so the new menu item doesn't
  // vanish for existing admins/users.
  { name: 'ai.supply.sc_forecast.v1', trigger: ['ai.supply.inv_opt'],
    keys: ['ai.supply.sc_forecast'] },
  // Sales Order Confirmation → whoever could already use the Sales Order
  // agent, since confirming is the next step on the same documents.
  { name: 'sales.workflow.order_confirmation.v1', trigger: ['sales.workflow.sales_order'],
    keys: ['sales.workflow.order_confirmation'] },
  // Load Planner (reads open SOs, simulates container / pallet loading) → admins and order-to-delivery users.
  { name: 'sales.workflow.load_planner.v1', trigger: ['admin.roles','sales.workflow.order_to_delivery','sales.workflow.order_confirmation'],
    keys: ['sales.workflow.load_planner'] },
  // Sales Order Excel Import (posts SOs) → admins and whoever can already post sales orders.
  { name: 'sales.workflow.so_excel_import.v1', trigger: ['admin.roles','sales.workflow.sales_order'],
    keys: ['sales.workflow.so_excel_import'] },
  // Excel import agents → admins and whoever already maintains that master / posts that document.
  { name: 'master.excel_import.v1', trigger: ['admin.roles'], keys: ['master.excel_import.item', 'master.excel_import.bp', 'master.excel_import.bom'] },
  { name: 'master.excel_import.item.v1', trigger: ['master.item'], keys: ['master.excel_import.item'] },
  { name: 'master.excel_import.bp.v1', trigger: ['master.customer', 'master.supplier'], keys: ['master.excel_import.bp'] },
  { name: 'master.excel_import.bom.v1', trigger: ['master.bom'], keys: ['master.excel_import.bom'] },
  { name: 'purchase.workflow.apinv_excel_import.v1', trigger: ['admin.roles', 'purchase.workflow.apinv_service'], keys: ['purchase.workflow.apinv_excel_import'] },
  { name: 'finance.salary_jv_import.v1', trigger: ['admin.roles'], keys: ['finance.salary_jv_import'] },
  { name: 'tools.excel_import_templates.v1', trigger: ['admin.roles', 'sales.workflow.so_excel_import_templates'], keys: ['tools.excel_import_templates'] },
  // Designing import templates (column → SAP field mapping) → admins only to start with.
  { name: 'sales.workflow.so_excel_import_templates.v1', trigger: ['admin.roles'],
    keys: ['sales.workflow.so_excel_import_templates'] },
  // Inventory Dashboard & Reports (read-only) → whoever can already see Stock Levels.
  { name: 'inventory.dashboard.v1', trigger: ['inventory.stock_levels'],
    keys: ['inventory.dashboard'] },
  // …and to admin roles (anyone who can manage roles) — v1 missed admin roles
  // that had never been given Stock Levels.
  { name: 'inventory.dashboard.v2', trigger: ['admin.roles'],
    keys: ['inventory.dashboard'] },
  // A/P Service Invoice agent → whoever can already post A/P invoices from GRPOs.
  { name: 'purchase.workflow.apinv_service.v1', trigger: ['purchase.workflow.grpo_to_apinv'],
    keys: ['purchase.workflow.apinv_service'] },
  // GRPO Sorting → sorters are whoever already receives goods (PO → GRPO);
  // the supervisor screen (load, assign, reports) starts with admin roles only.
  { name: 'purchase.workflow.grpo_sorting.v1', trigger: ['purchase.workflow.po_to_grpo','admin.roles'],
    keys: ['purchase.workflow.grpo_sorting'] },
  { name: 'purchase.workflow.grpo_sorting_supervise.v1', trigger: ['admin.roles'],
    keys: ['purchase.workflow.grpo_sorting_supervise'] },
  // Sorting Analytics (reads SAP @SORTING) → admins and sorting supervisors.
  { name: 'purchase.workflow.sorting_analytics.v1', trigger: ['admin.roles','purchase.workflow.grpo_sorting_supervise'],
    keys: ['purchase.workflow.sorting_analytics'] },
  // Putaway Analytics (reads SAP UDO STTL_PUTAWAY) → the same audience as Sorting Analytics.
  { name: 'purchase.workflow.putaway_analytics.v1', trigger: ['admin.roles','purchase.workflow.sorting_analytics'],
    keys: ['purchase.workflow.putaway_analytics'] },
  // Warehouse Digital Twin (3D bins & stock, read-only, moves are simulated) → admins and putaway / stock users.
  { name: 'purchase.workflow.warehouse_twin.v1', trigger: ['admin.roles','purchase.workflow.putaway_analytics','inventory.stock_levels'],
    keys: ['purchase.workflow.warehouse_twin'] },
  // Bank Reconciliation (reads SAP bank G/L lines) → admins and finance dashboard / trial balance users.
  { name: 'ai.ocr.bank_reco.v1', trigger: ['admin.roles','finance.financial_dashboard','finance.reports.trial_balance'],
    keys: ['ai.ocr.bank_reco'] },
  // AP Invoice Processing menu → admins and whoever can already scan A/P invoices.
  { name: 'apip.v1', trigger: ['admin.roles','ai.ocr.apinv'],
    keys: ['apip.dashboard','apip.queue','apip.approvals','apip.stages','apip.master','apip.mail','apip.settings'] },
  // Vendor Item Mapping / Vendor Expense G/L → whoever can already change AP Invoice Processing settings.
  { name: 'apip.vendor_mapping.v1', trigger: ['admin.roles','apip.settings'],
    keys: ['apip.vitems','apip.vexpense'] },
  // Home Insights → whoever held any permission in that module, which is
  // exactly who saw those insight cards before they had keys of their own.
  ...['finance', 'sales', 'purchase', 'inventory'].map(area => ({
    name: `insights.${area}.v1`,
    trigger: ALL_PERMISSIONS.map(x => x.key).filter(k => k.startsWith(area + '.')),
    keys: ALL_PERMISSIONS.map(x => x.key).filter(k => k.startsWith(`insights.${area}.`)),
  })),
];
// Databases that already ran the old every-boot version of these two grants
// must not get them once more — that would undo the admin's latest uncheck.
for (const name of ['admin.extra_children.v1', 'master.customer_extra_children.v1']) {
  const g = ONE_TIME_GRANTS.find(x => x.name === name);
  const alreadyRan = db.prepare(`SELECT 1 FROM role_permissions WHERE perm_key IN (${g.keys.map(() => '?').join(',')}) LIMIT 1`).get(...g.keys);
  if (alreadyRan) db.prepare(`INSERT OR IGNORE INTO permission_grants_applied(name) VALUES(?)`).run(name);
}
for (const g of ONE_TIME_GRANTS) {
  if (db.prepare(`SELECT 1 FROM permission_grants_applied WHERE name=?`).get(g.name)) continue;
  db.transaction(() => {
    const insRole = db.prepare(`INSERT OR IGNORE INTO role_permissions(role_id,perm_key) VALUES(?,?)`);
    for (const role of roleRepo.list.all()) {
      if (role.name === 'superadmin') continue;
      if (roleRepo.getPermissions(role.id).some(k => g.trigger.includes(k))) g.keys.forEach(k => insRole.run(role.id, k));
    }
    const insUser = db.prepare(`INSERT OR IGNORE INTO user_permissions(user_id,perm_key,granted) VALUES(?,?,1)`);
    const users = db.prepare(`SELECT DISTINCT user_id FROM user_permissions WHERE granted=1 AND perm_key IN (${g.trigger.map(() => '?').join(',')})`).all(...g.trigger);
    for (const u of users) g.keys.forEach(k => insUser.run(u.user_id, k));
    db.prepare(`INSERT INTO permission_grants_applied(name) VALUES(?)`).run(g.name);
  })();
  console.log(`✓ Permission grant '${g.name}' applied`);
}

// ── Master Data Cache (company-wise SAP mirrors) ──────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS cache_items (
    company_id   TEXT NOT NULL,
    ItemCode     TEXT NOT NULL,
    ItemName     TEXT DEFAULT '',
    ItemsGroupCode INTEGER,
    ItemGroupName TEXT DEFAULT '',
    SalesUnit    TEXT DEFAULT '',
    PurchaseUnit TEXT DEFAULT '',
    InventoryUoM TEXT DEFAULT '',
    SalesVATGroup TEXT DEFAULT '',
    PurchVATGroup TEXT DEFAULT '',
    ManageBatchNumbers TEXT DEFAULT 'tNO',
    ManageSerialNumbers TEXT DEFAULT 'tNO',
    QuantityOnStock REAL DEFAULT 0,
    Frozen       TEXT DEFAULT 'tNO',
    PRIMARY KEY (company_id, ItemCode)
  );
  CREATE TABLE IF NOT EXISTS cache_business_partners (
    company_id   TEXT NOT NULL,
    CardCode     TEXT NOT NULL,
    CardName     TEXT DEFAULT '',
    CardType     TEXT DEFAULT '',
    GroupCode    INTEGER,
    GroupName    TEXT DEFAULT '',
    Currency     TEXT DEFAULT '',
    PayTermsGrpCode INTEGER,
    Phone1       TEXT DEFAULT '',
    EmailAddress TEXT DEFAULT '',
    City         TEXT DEFAULT '',
    Country      TEXT DEFAULT '',
    Frozen       TEXT DEFAULT 'tNO',
    PRIMARY KEY (company_id, CardCode)
  );
  CREATE TABLE IF NOT EXISTS cache_tax_codes (
    company_id TEXT NOT NULL,
    Code       TEXT NOT NULL,
    Name       TEXT DEFAULT '',
    Rate       REAL DEFAULT 0,
    Category   TEXT DEFAULT '',
    PRIMARY KEY (company_id, Code)
  );
  CREATE TABLE IF NOT EXISTS cache_warehouses (
    company_id     TEXT NOT NULL,
    WarehouseCode  TEXT NOT NULL,
    WarehouseName  TEXT DEFAULT '',
    Inactive       TEXT DEFAULT 'tNO',
    PRIMARY KEY (company_id, WarehouseCode)
  );
  CREATE TABLE IF NOT EXISTS cache_uom (
    company_id TEXT NOT NULL,
    AbsEntry   INTEGER NOT NULL,
    Code       TEXT DEFAULT '',
    Name       TEXT DEFAULT '',
    PRIMARY KEY (company_id, AbsEntry)
  );
  CREATE TABLE IF NOT EXISTS cache_payment_terms (
    company_id             TEXT NOT NULL,
    GroupNumber            INTEGER NOT NULL,
    PaymentTermsGroupName  TEXT DEFAULT '',
    PRIMARY KEY (company_id, GroupNumber)
  );
  CREATE TABLE IF NOT EXISTS cache_currencies (
    company_id TEXT NOT NULL,
    Code       TEXT NOT NULL,
    Name       TEXT DEFAULT '',
    PRIMARY KEY (company_id, Code)
  );
  CREATE TABLE IF NOT EXISTS cache_item_groups (
    company_id TEXT NOT NULL,
    Number     INTEGER NOT NULL,
    GroupName  TEXT DEFAULT '',
    PRIMARY KEY (company_id, Number)
  );
  CREATE TABLE IF NOT EXISTS cache_bp_groups (
    company_id TEXT NOT NULL,
    Code       INTEGER NOT NULL,
    Name       TEXT DEFAULT '',
    PRIMARY KEY (company_id, Code)
  );
  CREATE TABLE IF NOT EXISTS cache_open_orders (
    company_id TEXT NOT NULL,
    DocEntry   INTEGER NOT NULL,
    DocNum     INTEGER,
    CardCode   TEXT,
    CardName   TEXT DEFAULT '',
    DocDate    TEXT DEFAULT '',
    DocDueDate TEXT DEFAULT '',
    DocTotal   REAL DEFAULT 0,
    NumAtCard  TEXT DEFAULT '',
    PRIMARY KEY (company_id, DocEntry)
  );
  CREATE TABLE IF NOT EXISTS cache_gl_accounts (
    company_id TEXT NOT NULL,
    AcctCode   TEXT NOT NULL,
    AcctName   TEXT DEFAULT '',
    FormatCode TEXT DEFAULT '',
    Postable   TEXT DEFAULT 'tYES',            -- tYES = active (postable) account, tNO = title account
    Frozen     TEXT DEFAULT 'tNO',
    AcctType   TEXT DEFAULT '',                -- SL AccountType: at_Expenses | at_Revenues | at_Other
    PRIMARY KEY (company_id, AcctCode)
  );
  CREATE TABLE IF NOT EXISTS cache_bom_lines (
    company_id   TEXT NOT NULL,
    TreeCode     TEXT NOT NULL,                -- parent (finished) item
    ParentName   TEXT DEFAULT '',
    TreeType     TEXT DEFAULT '',              -- SL BoMObjectTypes: iProductionTree | iSalesTree | iTemplateTree | iAssemblyTree
    BaseQty      REAL DEFAULT 1,
    BomWarehouse TEXT DEFAULT '',
    LineNum      INTEGER NOT NULL,
    ItemCode     TEXT DEFAULT '',              -- component
    ItemName     TEXT DEFAULT '',
    Quantity     REAL DEFAULT 0,
    Warehouse    TEXT DEFAULT '',
    IssueMethod  TEXT DEFAULT '',
    PRIMARY KEY (company_id, TreeCode, LineNum)
  );
  CREATE TABLE IF NOT EXISTS cache_sync_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id TEXT NOT NULL,
    entity     TEXT NOT NULL,
    status     TEXT DEFAULT 'pending',
    record_count INTEGER DEFAULT 0,
    error_msg  TEXT DEFAULT '',
    synced_at  DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS ocr_documents (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id     TEXT DEFAULT '',
    doc_type       TEXT NOT NULL,
    session_id     TEXT DEFAULT '',
    file_name      TEXT DEFAULT '',
    mime_type      TEXT DEFAULT '',
    uploaded_by    TEXT DEFAULT '',
    uploaded_at    TEXT DEFAULT (datetime('now')),
    extracted_json TEXT DEFAULT '',
    match_json     TEXT DEFAULT '',
    status         TEXT DEFAULT 'pending',
    sap_doc_type   TEXT DEFAULT '',
    sap_doc_entry  INTEGER,
    sap_doc_num    INTEGER,
    notes          TEXT DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS custom_agents (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    key            TEXT UNIQUE NOT NULL,
    name           TEXT NOT NULL,
    icon           TEXT DEFAULT '🤖',
    color          TEXT DEFAULT '#0070F2',
    menu_section   TEXT DEFAULT 'Tools',
    menu_group     TEXT DEFAULT 'Custom Agents',
    requirement    TEXT DEFAULT '',
    system_prompt  TEXT DEFAULT '',
    greeting       TEXT DEFAULT '',
    quick_replies  TEXT DEFAULT '[]',
    status         TEXT DEFAULT 'active',
    created_by     TEXT DEFAULT '',
    created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at     DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_cache_items_name    ON cache_items(company_id, ItemName);
  CREATE INDEX IF NOT EXISTS idx_cache_bp_name       ON cache_business_partners(company_id, CardName, CardType);
  CREATE INDEX IF NOT EXISTS idx_cache_sync_company  ON cache_sync_log(company_id, entity);
  CREATE INDEX IF NOT EXISTS idx_cache_open_orders_cust ON cache_open_orders(company_id, CardCode);
  CREATE INDEX IF NOT EXISTS idx_cache_bom_lines_item   ON cache_bom_lines(company_id, ItemCode);
  CREATE INDEX IF NOT EXISTS idx_ocr_documents_type   ON ocr_documents(company_id, doc_type, uploaded_at);
`);

// ── Migration: custom_agents.type / spec_json (added for Transaction Screen agents) ──
(function migrateCustomAgents() {
  const cols = db.prepare(`PRAGMA table_info(custom_agents)`).all().map(c => c.name);
  if (!cols.includes('type'))      db.exec(`ALTER TABLE custom_agents ADD COLUMN type TEXT DEFAULT 'chat'`);
  if (!cols.includes('spec_json')) db.exec(`ALTER TABLE custom_agents ADD COLUMN spec_json TEXT DEFAULT ''`);
})();

export const ocrDocumentsRepo = {
  insert(row) {
    const stmt = db.prepare(`INSERT INTO ocr_documents
      (company_id, doc_type, session_id, file_name, mime_type, uploaded_by, extracted_json, match_json, status, sap_doc_type, sap_doc_entry, sap_doc_num, notes)
      VALUES (@company_id,@doc_type,@session_id,@file_name,@mime_type,@uploaded_by,@extracted_json,@match_json,@status,@sap_doc_type,@sap_doc_entry,@sap_doc_num,@notes)`);
    const info = stmt.run({
      company_id:     row.company_id || '',
      doc_type:       row.doc_type,
      session_id:     row.session_id || '',
      file_name:      row.file_name || '',
      mime_type:      row.mime_type || '',
      uploaded_by:    row.uploaded_by || '',
      extracted_json: row.extracted_json ? JSON.stringify(row.extracted_json) : '',
      match_json:     row.match_json ? JSON.stringify(row.match_json) : '',
      status:         row.status || 'pending',
      sap_doc_type:   row.sap_doc_type || '',
      sap_doc_entry:  row.sap_doc_entry ?? null,
      sap_doc_num:    row.sap_doc_num ?? null,
      notes:          row.notes || '',
    });
    return info.lastInsertRowid;
  },
  updateStatus(id, status, extra = {}) {
    const fields = { status };
    if (extra.sap_doc_entry != null) fields.sap_doc_entry = extra.sap_doc_entry;
    if (extra.sap_doc_num != null)   fields.sap_doc_num   = extra.sap_doc_num;
    if (extra.sap_doc_type != null)  fields.sap_doc_type  = extra.sap_doc_type;
    if (extra.match_json != null)    fields.match_json    = JSON.stringify(extra.match_json);
    if (extra.notes != null)         fields.notes         = extra.notes;
    const cols = Object.keys(fields);
    db.prepare(`UPDATE ocr_documents SET ${cols.map(c => `${c}=@${c}`).join(', ')} WHERE id=@id`)
      .run({ ...fields, id });
  },
  getById(id) {
    const row = db.prepare(`SELECT * FROM ocr_documents WHERE id=?`).get(id);
    return row ? deserializeOcrRow(row) : null;
  },
  list(companyId, docType, limit = 50) {
    const rows = docType
      ? db.prepare(`SELECT * FROM ocr_documents WHERE company_id=? AND doc_type=? ORDER BY uploaded_at DESC LIMIT ?`).all(companyId || '', docType, limit)
      : db.prepare(`SELECT * FROM ocr_documents WHERE company_id=? ORDER BY uploaded_at DESC LIMIT ?`).all(companyId || '', limit);
    return rows.map(deserializeOcrRow);
  },
};

function deserializeOcrRow(row) {
  return {
    ...row,
    extracted_json: row.extracted_json ? JSON.parse(row.extracted_json) : null,
    match_json:     row.match_json ? JSON.parse(row.match_json) : null,
  };
}

function deserializeAgentRow(row) {
  if (!row) return null;
  let quickReplies = [];
  try { quickReplies = JSON.parse(row.quick_replies || '[]'); } catch { quickReplies = []; }
  let spec = null;
  try { spec = row.spec_json ? JSON.parse(row.spec_json) : null; } catch { spec = null; }
  return { ...row, quick_replies: quickReplies, spec_json: spec };
}

function slugifyAgentKey(name) {
  const base = String(name || '').toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'agent';
  return base.slice(0, 40);
}

export const customAgentsRepo = {
  list(status = 'active') {
    const rows = status
      ? db.prepare(`SELECT * FROM custom_agents WHERE status=? ORDER BY created_at DESC`).all(status)
      : db.prepare(`SELECT * FROM custom_agents ORDER BY created_at DESC`).all();
    return rows.map(deserializeAgentRow);
  },
  getById(id) {
    return deserializeAgentRow(db.prepare(`SELECT * FROM custom_agents WHERE id=?`).get(id));
  },
  getByKey(key) {
    return deserializeAgentRow(db.prepare(`SELECT * FROM custom_agents WHERE key=?`).get(key));
  },
  insert(row) {
    let key = slugifyAgentKey(row.name);
    if (this.getByKey(key)) key = `${key}-${Date.now().toString(36)}`;
    const stmt = db.prepare(`INSERT INTO custom_agents
      (key, name, icon, color, menu_section, menu_group, requirement, system_prompt, greeting, quick_replies, created_by, type, spec_json)
      VALUES (@key,@name,@icon,@color,@menu_section,@menu_group,@requirement,@system_prompt,@greeting,@quick_replies,@created_by,@type,@spec_json)`);
    const info = stmt.run({
      key,
      name:           row.name,
      icon:           row.icon || '🤖',
      color:          row.color || '#0070F2',
      menu_section:   row.menu_section || 'Tools',
      menu_group:     row.menu_group || 'Custom Agents',
      requirement:    row.requirement || '',
      system_prompt:  row.system_prompt || '',
      greeting:       row.greeting || '',
      quick_replies:  JSON.stringify(row.quick_replies || []),
      created_by:     row.created_by || '',
      type:           row.type || 'chat',
      spec_json:      row.spec_json ? JSON.stringify(row.spec_json) : '',
    });
    return this.getById(info.lastInsertRowid);
  },
  update(id, fields) {
    const allowed = ['name','icon','color','menu_section','menu_group','requirement','system_prompt','greeting','quick_replies','status','type','spec_json'];
    const set = {};
    for (const k of allowed) if (fields[k] !== undefined) set[k] = fields[k];
    if (set.quick_replies !== undefined) set.quick_replies = JSON.stringify(set.quick_replies || []);
    if (set.spec_json !== undefined) set.spec_json = set.spec_json ? JSON.stringify(set.spec_json) : '';
    if (!Object.keys(set).length) return this.getById(id);
    set.updated_at = new Date().toISOString();
    const cols = Object.keys(set);
    db.prepare(`UPDATE custom_agents SET ${cols.map(c => `${c}=@${c}`).join(', ')} WHERE id=@id`)
      .run({ ...set, id });
    return this.getById(id);
  },
  remove(id) {
    db.prepare(`DELETE FROM custom_agents WHERE id=?`).run(id);
  },
};

// ── Local Tables — SAP-independent business tables (AI Studio Phase 1) ────────
db.exec(`
  CREATE TABLE IF NOT EXISTS local_tables (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    key            TEXT UNIQUE NOT NULL,
    name           TEXT NOT NULL,
    icon           TEXT DEFAULT '🗃️',
    color          TEXT DEFAULT '#0f766e',
    columns_json   TEXT NOT NULL DEFAULT '[]',
    menu_section   TEXT DEFAULT 'Tools',
    menu_group     TEXT DEFAULT 'Custom Agents',
    requirement    TEXT DEFAULT '',
    status         TEXT DEFAULT 'active',
    created_by     TEXT DEFAULT '',
    created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at     DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS local_table_rows (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    table_id       INTEGER NOT NULL REFERENCES local_tables(id) ON DELETE CASCADE,
    data_json      TEXT NOT NULL DEFAULT '{}',
    created_by     TEXT DEFAULT '',
    created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at     DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_local_table_rows_table ON local_table_rows(table_id);
`);

function deserializeLocalTable(row) {
  if (!row) return null;
  let columns = [];
  try { columns = JSON.parse(row.columns_json || '[]'); } catch { columns = []; }
  return { ...row, columns_json: columns };
}
function deserializeLocalRow(row) {
  if (!row) return null;
  let data = {};
  try { data = JSON.parse(row.data_json || '{}'); } catch { data = {}; }
  return { id: row.id, table_id: row.table_id, created_by: row.created_by, created_at: row.created_at, updated_at: row.updated_at, ...data };
}
function slugifyLocalTableKey(name) {
  const base = String(name || '').toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'table';
  return base.slice(0, 40);
}

export const localTablesRepo = {
  list(status = 'active') {
    const rows = status
      ? db.prepare(`SELECT * FROM local_tables WHERE status=? ORDER BY created_at DESC`).all(status)
      : db.prepare(`SELECT * FROM local_tables ORDER BY created_at DESC`).all();
    return rows.map(deserializeLocalTable);
  },
  getById(id) {
    return deserializeLocalTable(db.prepare(`SELECT * FROM local_tables WHERE id=?`).get(id));
  },
  getByKey(key) {
    return deserializeLocalTable(db.prepare(`SELECT * FROM local_tables WHERE key=?`).get(key));
  },
  insert(row) {
    let key = slugifyLocalTableKey(row.name);
    if (this.getByKey(key)) key = `${key}-${Date.now().toString(36)}`;
    const stmt = db.prepare(`INSERT INTO local_tables
      (key, name, icon, color, columns_json, menu_section, menu_group, requirement, created_by)
      VALUES (@key,@name,@icon,@color,@columns_json,@menu_section,@menu_group,@requirement,@created_by)`);
    const info = stmt.run({
      key,
      name:          row.name,
      icon:          row.icon || '🗃️',
      color:         row.color || '#0f766e',
      columns_json:  JSON.stringify(row.columns || []),
      menu_section:  row.menu_section || 'Tools',
      menu_group:    row.menu_group || 'Custom Agents',
      requirement:   row.requirement || '',
      created_by:    row.created_by || '',
    });
    return this.getById(info.lastInsertRowid);
  },
  update(id, fields) {
    const allowed = ['name', 'icon', 'color', 'menu_section', 'menu_group', 'requirement', 'status'];
    const set = {};
    for (const k of allowed) if (fields[k] !== undefined) set[k] = fields[k];
    if (fields.columns !== undefined) set.columns_json = JSON.stringify(fields.columns || []);
    if (!Object.keys(set).length) return this.getById(id);
    set.updated_at = new Date().toISOString();
    const cols = Object.keys(set);
    db.prepare(`UPDATE local_tables SET ${cols.map(c => `${c}=@${c}`).join(', ')} WHERE id=@id`).run({ ...set, id });
    return this.getById(id);
  },
  remove(id) {
    db.prepare(`DELETE FROM local_tables WHERE id=?`).run(id);
  },

  // ── Rows ───────────────────────────────────────────────────────────────────
  listRows(tableId, limit = 200) {
    const rows = db.prepare(`SELECT * FROM local_table_rows WHERE table_id=? ORDER BY id DESC LIMIT ?`).all(tableId, limit);
    return rows.map(deserializeLocalRow);
  },
  getRow(tableId, id) {
    const row = db.prepare(`SELECT * FROM local_table_rows WHERE table_id=? AND id=?`).get(tableId, id);
    return deserializeLocalRow(row);
  },
  insertRow(tableId, data, createdBy) {
    const info = db.prepare(`INSERT INTO local_table_rows (table_id, data_json, created_by) VALUES (?,?,?)`)
      .run(tableId, JSON.stringify(data || {}), createdBy || '');
    return this.getRow(tableId, info.lastInsertRowid);
  },
  updateRow(tableId, id, data) {
    const existing = this.getRow(tableId, id);
    if (!existing) return null;
    const { id: _id, table_id, created_by, created_at, updated_at, ...prevData } = existing;
    const merged = { ...prevData, ...data };
    db.prepare(`UPDATE local_table_rows SET data_json=?, updated_at=datetime('now') WHERE table_id=? AND id=?`)
      .run(JSON.stringify(merged), tableId, id);
    return this.getRow(tableId, id);
  },
  removeRow(tableId, id) {
    db.prepare(`DELETE FROM local_table_rows WHERE table_id=? AND id=?`).run(tableId, id);
  },
};

// ── Workflow instances — runtime state for the Workflow Designer (AI Studio Phase 4) ──
db.exec(`
  CREATE TABLE IF NOT EXISTS workflow_instances (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    workflow_id    INTEGER NOT NULL,
    workflow_key   TEXT NOT NULL,
    status         TEXT NOT NULL DEFAULT 'running',
    current_node_id TEXT,
    variables_json TEXT NOT NULL DEFAULT '{}',
    history_json   TEXT NOT NULL DEFAULT '[]',
    started_by     TEXT DEFAULT '',
    started_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
    completed_at   DATETIME
  );
  CREATE INDEX IF NOT EXISTS idx_wf_instances_workflow ON workflow_instances(workflow_key, status);
`);

function deserializeInstance(row) {
  if (!row) return null;
  let variables = {}, history = [];
  try { variables = JSON.parse(row.variables_json || '{}'); } catch { variables = {}; }
  try { history = JSON.parse(row.history_json || '[]'); } catch { history = []; }
  return { ...row, variables_json: variables, history_json: history };
}

export const workflowInstancesRepo = {
  create(workflowId, workflowKey, startedBy) {
    const info = db.prepare(`INSERT INTO workflow_instances (workflow_id, workflow_key, started_by) VALUES (?,?,?)`)
      .run(workflowId, workflowKey, startedBy || '');
    return this.getById(info.lastInsertRowid);
  },
  getById(id) {
    return deserializeInstance(db.prepare(`SELECT * FROM workflow_instances WHERE id=?`).get(id));
  },
  listByWorkflow(workflowKey, limit = 100) {
    const rows = db.prepare(`SELECT * FROM workflow_instances WHERE workflow_key=? ORDER BY started_at DESC LIMIT ?`).all(workflowKey, limit);
    return rows.map(deserializeInstance);
  },
  save(instance) {
    db.prepare(`UPDATE workflow_instances SET status=@status, current_node_id=@current_node_id,
        variables_json=@variables_json, history_json=@history_json, updated_at=datetime('now'),
        completed_at=@completed_at
      WHERE id=@id`).run({
      id: instance.id,
      status: instance.status,
      current_node_id: instance.current_node_id,
      variables_json: JSON.stringify(instance.variables_json || {}),
      history_json: JSON.stringify(instance.history_json || []),
      completed_at: (instance.status === 'completed' || instance.status === 'rejected' || instance.status === 'cancelled')
        ? (instance.completed_at || new Date().toISOString()) : null,
    });
    return this.getById(instance.id);
  },
};

// ── GRPO Sorting — GRPO lines loaded for warehouse sorting, sorter shifts
// (clock in/out) and per-user work intervals. Scoped by SAP company DB.
// All timestamps are ISO-8601 UTC strings written from JS so they compare
// as text and parse unambiguously in the browser.
db.exec(`
  CREATE TABLE IF NOT EXISTS sorting_tasks (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    company          TEXT NOT NULL DEFAULT '',
    doc_entry        INTEGER NOT NULL,
    doc_num          INTEGER,
    line_num         INTEGER NOT NULL,
    doc_date         TEXT,
    card_code        TEXT DEFAULT '',
    card_name        TEXT DEFAULT '',
    item_code        TEXT DEFAULT '',
    item_name        TEXT DEFAULT '',
    quantity         REAL DEFAULT 0,
    uom              TEXT DEFAULT '',
    whs_code         TEXT DEFAULT '',
    status           TEXT NOT NULL DEFAULT 'pending',
    assigned_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    assigned_by      TEXT DEFAULT '',
    assigned_at      TEXT,
    started_at       TEXT,
    active_since     TEXT,
    work_seconds     INTEGER NOT NULL DEFAULT 0,
    completed_at     TEXT,
    completed_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
    sorted_qty       REAL,
    notes            TEXT DEFAULT '',
    loaded_at        TEXT,
    updated_at       TEXT,
    UNIQUE(company, doc_entry, line_num)
  );
  CREATE INDEX IF NOT EXISTS idx_sorting_tasks_status ON sorting_tasks(company, status);
  CREATE INDEX IF NOT EXISTS idx_sorting_tasks_user   ON sorting_tasks(assigned_user_id, status);

  CREATE TABLE IF NOT EXISTS sorting_shifts (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    company    TEXT NOT NULL DEFAULT '',
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    clock_in   TEXT NOT NULL,
    clock_out  TEXT,
    clocked_by TEXT DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS idx_sorting_shifts_user ON sorting_shifts(company, user_id, clock_out);

  CREATE TABLE IF NOT EXISTS sorting_work (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id  INTEGER NOT NULL REFERENCES sorting_tasks(id) ON DELETE CASCADE,
    user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    start_at TEXT NOT NULL,
    end_at   TEXT,
    seconds  INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_sorting_work_task ON sorting_work(task_id);
  CREATE INDEX IF NOT EXISTS idx_sorting_work_user ON sorting_work(user_id, start_at);

  CREATE TABLE IF NOT EXISTS sorting_settings (
    company     TEXT PRIMARY KEY,
    queue_size  INTEGER NOT NULL DEFAULT 5,
    auto_assign INTEGER NOT NULL DEFAULT 1
  );
`);

// SAP @SORTING mirror: sap_dirty=1 → row needs pushing; sap_error holds the
// last Service Layer rejection (cleared by a retry).
(function migrateSortingTasks() {
  const cols = db.prepare(`PRAGMA table_info(sorting_tasks)`).all().map(c => c.name);
  const add = { doc_due_date: 'TEXT', bin_code: `TEXT DEFAULT ''`, bin_all: `TEXT DEFAULT ''`,
    sap_dirty: 'INTEGER NOT NULL DEFAULT 0', sap_synced_at: 'TEXT', sap_error: 'TEXT' };
  for (const [c, t] of Object.entries(add)) if (!cols.includes(c)) db.exec(`ALTER TABLE sorting_tasks ADD COLUMN ${c} ${t}`);
})();
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_sorting_tasks_sap ON sorting_tasks(company, sap_dirty);
  CREATE TABLE IF NOT EXISTS sorting_emp_map (
    company  TEXT NOT NULL,
    user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    emp_id   INTEGER NOT NULL,
    emp_name TEXT DEFAULT '',
    PRIMARY KEY (company, user_id)
  );
`);

const sortNow = () => new Date().toISOString();
const sortSecs = (from, to) => Math.max(0, Math.round((new Date(to) - new Date(from)) / 1000));

export const sortingRepo = {
  getSettings(company) {
    return db.prepare(`SELECT queue_size, auto_assign FROM sorting_settings WHERE company=?`).get(company)
      || { queue_size: 5, auto_assign: 1 };
  },
  saveSettings(company, { queue_size, auto_assign }) {
    db.prepare(`INSERT INTO sorting_settings (company, queue_size, auto_assign) VALUES (?,?,?)
      ON CONFLICT(company) DO UPDATE SET queue_size=excluded.queue_size, auto_assign=excluded.auto_assign`)
      .run(company, Math.max(1, Math.min(100, Number(queue_size) || 5)), auto_assign ? 1 : 0);
    return this.getSettings(company);
  },

  // Insert new GRPO lines; refresh SAP fields only on lines nobody has touched yet.
  upsertLines(company, lines) {
    const exists = db.prepare(`SELECT 1 FROM sorting_tasks WHERE company=? AND doc_entry=? AND line_num=?`);
    const up = db.prepare(`INSERT INTO sorting_tasks
        (company, doc_entry, doc_num, line_num, doc_date, doc_due_date, card_code, card_name, item_code, item_name, quantity, uom, whs_code,
         bin_code, bin_all, sap_dirty, loaded_at, updated_at)
      VALUES (@company,@doc_entry,@doc_num,@line_num,@doc_date,@doc_due_date,@card_code,@card_name,@item_code,@item_name,@quantity,@uom,@whs_code,
         @bin_code,@bin_all,1,@now,@now)
      ON CONFLICT(company, doc_entry, line_num) DO UPDATE SET
        doc_num=excluded.doc_num, doc_date=excluded.doc_date, doc_due_date=excluded.doc_due_date, card_code=excluded.card_code,
        card_name=excluded.card_name, item_code=excluded.item_code, item_name=excluded.item_name, quantity=excluded.quantity,
        uom=excluded.uom, whs_code=excluded.whs_code, bin_code=excluded.bin_code, bin_all=excluded.bin_all, sap_dirty=1,
        updated_at=excluded.updated_at
      WHERE sorting_tasks.status='pending'`);
    let inserted = 0, existing = 0;
    const now = sortNow();
    db.transaction(() => {
      for (const l of lines) {
        if (exists.get(company, l.doc_entry, l.line_num)) existing++; else inserted++;
        up.run({ doc_due_date: null, bin_code: '', bin_all: '', ...l, company, now });
      }
    })();
    return { inserted, existing };
  },

  list(company, { status, userId, item, q, from, to, limit = 5000 } = {}) {
    const where = ['t.company=?'], args = [company];
    if (status) { where.push('t.status=?'); args.push(status); }
    if (userId) { where.push('t.assigned_user_id=?'); args.push(userId); }
    if (item)   { where.push('t.item_code=?'); args.push(item); }
    if (from)   { where.push('t.doc_date>=?'); args.push(from); }
    if (to)     { where.push('t.doc_date<=?'); args.push(to); }
    if (q) {
      where.push(`(t.item_code LIKE ? OR t.item_name LIKE ? OR t.card_name LIKE ? OR CAST(t.doc_num AS TEXT) LIKE ?)`);
      const like = `%${q}%`; args.push(like, like, like, like);
    }
    return db.prepare(`SELECT t.*, u.username AS assigned_username, u.full_name AS assigned_name
      FROM sorting_tasks t LEFT JOIN users u ON u.id=t.assigned_user_id
      WHERE ${where.join(' AND ')}
      ORDER BY CASE t.status WHEN 'in_progress' THEN 0 WHEN 'assigned' THEN 1 WHEN 'pending' THEN 2 ELSE 3 END,
        t.doc_date, t.doc_num, t.line_num LIMIT ?`).all(...args, limit);
  },
  get(id) { return db.prepare(`SELECT * FROM sorting_tasks WHERE id=?`).get(id); },
  counts(company) {
    return db.prepare(`SELECT status, COUNT(*) AS n, COALESCE(SUM(quantity),0) AS qty FROM sorting_tasks WHERE company=? GROUP BY status`).all(company);
  },

  // ── Shifts ────────────────────────────────────────────────────────────────
  openShift(company, userId) {
    return db.prepare(`SELECT * FROM sorting_shifts WHERE company=? AND user_id=? AND clock_out IS NULL ORDER BY id DESC LIMIT 1`).get(company, userId);
  },
  clockIn(company, userId, by) {
    if (this.openShift(company, userId)) throw new Error('Already clocked in');
    db.prepare(`INSERT INTO sorting_shifts (company, user_id, clock_in, clocked_by) VALUES (?,?,?,?)`).run(company, userId, sortNow(), by || '');
    return this.openShift(company, userId);
  },
  // Pause the running line, hand unfinished queued lines back to the pool, close the shift.
  clockOut(company, userId, by) {
    const shift = this.openShift(company, userId);
    if (!shift) throw new Error('Not clocked in');
    const now = sortNow();
    db.transaction(() => {
      for (const t of db.prepare(`SELECT id FROM sorting_tasks WHERE company=? AND assigned_user_id=? AND status='in_progress'`).all(company, userId)) {
        this._stopRun(t.id, now);
      }
      db.prepare(`UPDATE sorting_tasks SET status='pending', assigned_user_id=NULL, assigned_by='', assigned_at=NULL, updated_at=?
        WHERE company=? AND assigned_user_id=? AND status='assigned'`).run(now, company, userId);
      db.prepare(`UPDATE sorting_shifts SET clock_out=? WHERE id=?`).run(now, shift.id);
    })();
    return db.prepare(`SELECT * FROM sorting_shifts WHERE id=?`).get(shift.id);
  },
  // Who is on the floor right now, with their current workload.
  onShift(company) {
    return db.prepare(`SELECT s.id AS shift_id, s.user_id, s.clock_in, u.username, u.full_name,
        (SELECT COUNT(*) FROM sorting_tasks t WHERE t.company=s.company AND t.assigned_user_id=s.user_id AND t.status='assigned') AS queued,
        (SELECT COUNT(*) FROM sorting_tasks t WHERE t.company=s.company AND t.assigned_user_id=s.user_id AND t.status='in_progress') AS running,
        (SELECT COUNT(*) FROM sorting_tasks t WHERE t.company=s.company AND t.completed_by=s.user_id AND t.completed_at>=s.clock_in) AS done_this_shift
      FROM sorting_shifts s JOIN users u ON u.id=s.user_id
      WHERE s.company=? AND s.clock_out IS NULL ORDER BY s.clock_in`).all(company);
  },
  shifts(company, { userId, from, to } = {}) {
    const where = ['s.company=?'], args = [company];
    if (userId) { where.push('s.user_id=?'); args.push(userId); }
    if (to)     { where.push('s.clock_in<?'); args.push(to); }
    if (from)   { where.push('(s.clock_out IS NULL OR s.clock_out>?)'); args.push(from); }
    return db.prepare(`SELECT s.*, u.username, u.full_name FROM sorting_shifts s JOIN users u ON u.id=s.user_id
      WHERE ${where.join(' AND ')} ORDER BY s.clock_in DESC`).all(...args);
  },

  // ── Assignment ────────────────────────────────────────────────────────────
  assign(company, ids, userId, by) {
    const now = sortNow();
    const st = db.prepare(`UPDATE sorting_tasks SET status=CASE WHEN ? IS NULL THEN 'pending' ELSE 'assigned' END,
        assigned_user_id=?, assigned_by=?, assigned_at=CASE WHEN ? IS NULL THEN NULL ELSE ? END, updated_at=?
      WHERE company=? AND id=? AND status IN ('pending','assigned')`);
    let changed = 0;
    db.transaction(() => { for (const id of ids) changed += st.run(userId, userId, userId ? by : '', userId, now, now, company, id).changes; })();
    return changed;
  },
  // Fill each clocked-in sorter's queue up to queue_size, least-loaded first.
  // A sorter keeps getting the same item while it is pending (fewer bin
  // changes), otherwise the oldest GRPO line.
  topUp(company, by = 'auto') {
    const { queue_size } = this.getSettings(company);
    const pickSame = db.prepare(`SELECT id FROM sorting_tasks WHERE company=? AND status='pending' AND item_code=?
      ORDER BY doc_date, doc_num, line_num LIMIT 1`);
    const pickOldest = db.prepare(`SELECT id FROM sorting_tasks WHERE company=? AND status='pending'
      ORDER BY doc_date, doc_num, line_num LIMIT 1`);
    const lastItem = db.prepare(`SELECT item_code FROM sorting_tasks WHERE company=? AND assigned_user_id=?
      ORDER BY COALESCE(assigned_at,'') DESC LIMIT 1`);
    const give = db.prepare(`UPDATE sorting_tasks SET status='assigned', assigned_user_id=?, assigned_by=?, assigned_at=?, updated_at=? WHERE id=?`);
    let given = 0;
    db.transaction(() => {
      const crew = this.onShift(company).map(s => ({ ...s, load: s.queued, item: lastItem.get(company, s.user_id)?.item_code }));
      while (crew.length) {
        crew.sort((a, b) => a.load - b.load || a.clock_in.localeCompare(b.clock_in));
        const s = crew[0];
        if (s.load >= queue_size) break;
        const row = (s.item && pickSame.get(company, s.item)) || pickOldest.get(company);
        if (!row) break;
        const now = sortNow();
        give.run(s.user_id, by, now, now, row.id);
        s.load++; given++;
        s.item = this.get(row.id).item_code;
      }
    })();
    return given;
  },
  // Pull every not-yet-started queued line back to the pool and deal it out
  // again across whoever is clocked in now (e.g. after late joiners arrive).
  rebalance(company, by) {
    db.prepare(`UPDATE sorting_tasks SET status='pending', assigned_user_id=NULL, assigned_by='', assigned_at=NULL, updated_at=?
      WHERE company=? AND status='assigned' AND work_seconds=0`).run(sortNow(), company);
    return this.topUp(company, by);
  },

  // ── Work on a line ────────────────────────────────────────────────────────
  _stopRun(taskId, now) {
    const t = this.get(taskId);
    if (!t || t.status !== 'in_progress') return;
    const run = db.prepare(`SELECT * FROM sorting_work WHERE task_id=? AND end_at IS NULL ORDER BY id DESC LIMIT 1`).get(taskId);
    const secs = run ? sortSecs(run.start_at, now) : 0;
    if (run) db.prepare(`UPDATE sorting_work SET end_at=?, seconds=? WHERE id=?`).run(now, secs, run.id);
    db.prepare(`UPDATE sorting_tasks SET status='assigned', active_since=NULL, work_seconds=work_seconds+?, updated_at=? WHERE id=?`)
      .run(secs, now, taskId);
  },
  start(taskId, userId) {
    const now = sortNow();
    db.transaction(() => {
      const t = this.get(taskId);
      if (!t) throw new Error('Line not found');
      if (t.assigned_user_id !== userId || t.status !== 'assigned') throw new Error('This line is not in your queue');
      if (!this.openShift(t.company, userId)) throw new Error('Clock in before you start sorting');
      if (db.prepare(`SELECT 1 FROM sorting_tasks WHERE assigned_user_id=? AND status='in_progress'`).get(userId)) {
        throw new Error('Finish or pause your current line first');
      }
      db.prepare(`INSERT INTO sorting_work (task_id, user_id, start_at) VALUES (?,?,?)`).run(taskId, userId, now);
      db.prepare(`UPDATE sorting_tasks SET status='in_progress', active_since=?, started_at=COALESCE(started_at, ?),
          sap_dirty=CASE WHEN started_at IS NULL THEN 1 ELSE sap_dirty END, updated_at=? WHERE id=?`)
        .run(now, now, now, taskId);
    })();
    return this.get(taskId);
  },
  pause(taskId, userId) {
    const t = this.get(taskId);
    if (!t || t.assigned_user_id !== userId || t.status !== 'in_progress') throw new Error('This line is not running');
    db.transaction(() => this._stopRun(taskId, sortNow()))();
    return this.get(taskId);
  },
  complete(taskId, userId, { sortedQty, notes } = {}) {
    const now = sortNow();
    db.transaction(() => {
      const t = this.get(taskId);
      if (!t || t.assigned_user_id !== userId || t.status !== 'in_progress') throw new Error('Start the line before completing it');
      this._stopRun(taskId, now);
      const qty = sortedQty == null || sortedQty === '' ? t.quantity : Number(sortedQty);
      db.prepare(`UPDATE sorting_tasks SET status='done', completed_at=?, completed_by=?, sorted_qty=?, notes=?, sap_dirty=1, updated_at=? WHERE id=?`)
        .run(now, userId, qty, String(notes || '').slice(0, 500), now, taskId);
    })();
    return this.get(taskId);
  },
  reopen(company, taskId) {
    return db.prepare(`UPDATE sorting_tasks SET status=CASE WHEN assigned_user_id IS NULL THEN 'pending' ELSE 'assigned' END,
        completed_at=NULL, completed_by=NULL, sorted_qty=NULL, sap_dirty=1, updated_at=? WHERE company=? AND id=? AND status='done'`)
      .run(sortNow(), company, taskId).changes;
  },

  // ── SAP @SORTING sync bookkeeping ─────────────────────────────────────────
  sapDirty(company, limit = 50) {
    return db.prepare(`SELECT * FROM sorting_tasks WHERE company=? AND sap_dirty=1 AND sap_error IS NULL ORDER BY id LIMIT ?`).all(company, limit);
  },
  // Only clear the flag if nothing changed the row while it was being pushed.
  sapSynced(id, pushedAt) {
    db.prepare(`UPDATE sorting_tasks SET sap_dirty=CASE WHEN updated_at>? THEN 1 ELSE 0 END, sap_synced_at=?, sap_error=NULL WHERE id=?`)
      .run(pushedAt, sortNow(), id);
  },
  sapFailed(id, error) {
    db.prepare(`UPDATE sorting_tasks SET sap_error=? WHERE id=?`).run(String(error).slice(0, 500), id);
  },
  sapStatus(company) {
    const r = db.prepare(`SELECT
        SUM(CASE WHEN sap_dirty=1 AND sap_error IS NULL THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN sap_error IS NOT NULL THEN 1 ELSE 0 END) AS errors,
        SUM(CASE WHEN sap_dirty=0 AND sap_synced_at IS NOT NULL THEN 1 ELSE 0 END) AS synced
      FROM sorting_tasks WHERE company=?`).get(company);
    const lastErrors = db.prepare(`SELECT id, doc_num, line_num, item_code, sap_error FROM sorting_tasks
      WHERE company=? AND sap_error IS NOT NULL ORDER BY updated_at DESC LIMIT 5`).all(company);
    return { pending: r.pending || 0, errors: r.errors || 0, synced: r.synced || 0, lastErrors };
  },
  sapRetry(company) {
    return db.prepare(`UPDATE sorting_tasks SET sap_error=NULL, sap_dirty=1 WHERE company=? AND sap_error IS NOT NULL`).run(company).changes;
  },

  // ── App user → SAP employee (OHEM) mapping, written to @SORTING.U_USER ─────
  empMap(company) {
    return db.prepare(`SELECT user_id, emp_id, emp_name FROM sorting_emp_map WHERE company=?`).all(company);
  },
  empOf(company, userId) {
    return userId ? db.prepare(`SELECT emp_id, emp_name FROM sorting_emp_map WHERE company=? AND user_id=?`).get(company, userId) : null;
  },
  setEmp(company, userId, empId, empName) {
    db.transaction(() => {
      if (empId == null) db.prepare(`DELETE FROM sorting_emp_map WHERE company=? AND user_id=?`).run(company, userId);
      else db.prepare(`INSERT INTO sorting_emp_map (company, user_id, emp_id, emp_name) VALUES (?,?,?,?)
        ON CONFLICT(company, user_id) DO UPDATE SET emp_id=excluded.emp_id, emp_name=excluded.emp_name`).run(company, userId, empId, empName || '');
      // Lines this user started or finished carry their employee in SAP — resend them.
      db.prepare(`UPDATE sorting_tasks SET sap_dirty=1, sap_error=NULL, updated_at=?
        WHERE company=? AND ((assigned_user_id=? AND started_at IS NOT NULL) OR completed_by=?)`).run(sortNow(), company, userId, userId);
    })();
  },

  // ── Reporting inputs (aggregated in the controller) ───────────────────────
  workIntervals(company, from, to) {
    return db.prepare(`SELECT w.*, t.item_code, t.item_name, t.quantity, t.status, t.completed_by, t.completed_at, t.sorted_qty,
        u.username, u.full_name
      FROM sorting_work w JOIN sorting_tasks t ON t.id=w.task_id JOIN users u ON u.id=w.user_id
      WHERE t.company=? AND w.start_at<? AND (w.end_at IS NULL OR w.end_at>?)`).all(company, to, from);
  },
  completedBetween(company, from, to) {
    return db.prepare(`SELECT t.*, u.username, u.full_name FROM sorting_tasks t LEFT JOIN users u ON u.id=t.completed_by
      WHERE t.company=? AND t.status='done' AND t.completed_at>=? AND t.completed_at<?`).all(company, from, to);
  },
};

export const cacheRepo = {
  // Items
  upsertItems(companyId, rows) {
    const ins = db.prepare(`INSERT OR REPLACE INTO cache_items
      (company_id,ItemCode,ItemName,ItemsGroupCode,ItemGroupName,SalesUnit,PurchaseUnit,
       InventoryUoM,SalesVATGroup,PurchVATGroup,ManageBatchNumbers,ManageSerialNumbers,QuantityOnStock,Frozen)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    db.transaction(() => {
      for (const r of rows) ins.run(companyId,r.ItemCode,r.ItemName||'',r.ItemsGroupCode||null,r.ItemGroupName||'',
        r.SalesUnit||'',r.PurchaseUnit||'',r.InventoryUoM||'',r.SalesVATGroup||'',r.PurchVATGroup||'',
        r.ManageBatchNumbers||'tNO',r.ManageSerialNumbers||'tNO',r.QuantityOnStock||0,r.Frozen||'tNO');
    })();
  },
  searchItems(companyId, q, top=20) {
    const like = `%${q||''}%`;
    // top=0 means no limit — return all stored records
    if (!top) {
      return db.prepare(`SELECT * FROM cache_items WHERE company_id=? AND Frozen='tNO'
        AND (ItemCode LIKE ? OR ItemName LIKE ?) ORDER BY ItemName`).all(companyId,like,like);
    }
    return db.prepare(`SELECT * FROM cache_items WHERE company_id=? AND Frozen='tNO'
      AND (ItemCode LIKE ? OR ItemName LIKE ?) ORDER BY ItemName LIMIT ?`).all(companyId,like,like,top);
  },
  // Business Partners
  upsertBPs(companyId, rows) {
    const ins = db.prepare(`INSERT OR REPLACE INTO cache_business_partners
      (company_id,CardCode,CardName,CardType,GroupCode,GroupName,Currency,PayTermsGrpCode,Phone1,EmailAddress,City,Country,Frozen)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    db.transaction(() => {
      for (const r of rows) ins.run(companyId,r.CardCode,r.CardName||'',r.CardType||'',r.GroupCode||null,r.GroupName||'',
        r.Currency||'',r.PayTermsGrpCode||null,r.Phone1||'',r.EmailAddress||'',r.City||'',r.Country||'',r.Frozen||'tNO');
    })();
  },
  searchBPs(companyId, q, type, top=20) {
    const like = `%${q||''}%`;
    const typeFilter = type ? ` AND CardType=?` : '';
    const args = [companyId, like, like];
    if (type) args.push(type);
    args.push(top);
    return db.prepare(`SELECT * FROM cache_business_partners WHERE company_id=? AND Frozen='tNO'
      ${typeFilter} AND (CardCode LIKE ? OR CardName LIKE ?) ORDER BY CardName LIMIT ?`
      .replace('Frozen=', 'Frozen=').replace('AND (CardCode', typeFilter ? 'AND (CardCode' : 'AND (CardCode'))
      .split('').join('') && // dummy to avoid replace chain
      db.prepare(`SELECT * FROM cache_business_partners WHERE company_id=? AND Frozen='tNO'
        ${type ? "AND CardType='" + type + "'" : ''} AND (CardCode LIKE ? OR CardName LIKE ?) ORDER BY CardName LIMIT ?`).all(companyId,like,like,top);
  },
  // Tax codes
  upsertTaxCodes(companyId, rows) {
    // Ensure Rate column exists (migration for existing installs)
    try { db.exec(`ALTER TABLE cache_tax_codes ADD COLUMN Rate REAL DEFAULT 0`); } catch(_) {}
    const ins = db.prepare(`INSERT OR REPLACE INTO cache_tax_codes(company_id,Code,Name,Category,Rate) VALUES(?,?,?,?,?)`);
    db.transaction(() => { for (const r of rows) ins.run(companyId,r.Code,r.Name||'',r.Category||'',r.Rate||0); })();
  },
  getTaxCodes(companyId) { return db.prepare(`SELECT * FROM cache_tax_codes WHERE company_id=? ORDER BY Code`).all(companyId); },
  // Warehouses
  upsertWarehouses(companyId, rows) {
    const ins = db.prepare(`INSERT OR REPLACE INTO cache_warehouses(company_id,WarehouseCode,WarehouseName,Inactive) VALUES(?,?,?,?)`);
    db.transaction(() => { for (const r of rows) ins.run(companyId,r.WarehouseCode,r.WarehouseName||'',r.Inactive||'tNO'); })();
  },
  getWarehouses(companyId) { return db.prepare(`SELECT * FROM cache_warehouses WHERE company_id=? AND Inactive='tNO' ORDER BY WarehouseCode`).all(companyId); },
  // UOM
  upsertUOM(companyId, rows) {
    const ins = db.prepare(`INSERT OR REPLACE INTO cache_uom(company_id,AbsEntry,Code,Name) VALUES(?,?,?,?)`);
    db.transaction(() => { for (const r of rows) ins.run(companyId,r.AbsEntry,r.Code||'',r.Name||''); })();
  },
  getUOM(companyId) { return db.prepare(`SELECT * FROM cache_uom WHERE company_id=? ORDER BY Name`).all(companyId); },
  // Payment Terms
  upsertPaymentTerms(companyId, rows) {
    const ins = db.prepare(`INSERT OR REPLACE INTO cache_payment_terms(company_id,GroupNumber,PaymentTermsGroupName) VALUES(?,?,?)`);
    db.transaction(() => { for (const r of rows) ins.run(companyId,r.GroupNumber,r.PaymentTermsGroupName||''); })();
  },
  getPaymentTerms(companyId) { return db.prepare(`SELECT * FROM cache_payment_terms WHERE company_id=? ORDER BY PaymentTermsGroupName`).all(companyId); },
  // Currencies
  upsertCurrencies(companyId, rows) {
    const ins = db.prepare(`INSERT OR REPLACE INTO cache_currencies(company_id,Code,Name) VALUES(?,?,?)`);
    db.transaction(() => { for (const r of rows) ins.run(companyId,r.Code,r.Name||''); })();
  },
  getCurrencies(companyId) { return db.prepare(`SELECT * FROM cache_currencies WHERE company_id=? ORDER BY Code`).all(companyId); },
  // Item Groups
  upsertItemGroups(companyId, rows) {
    const ins = db.prepare(`INSERT OR REPLACE INTO cache_item_groups(company_id,Number,GroupName) VALUES(?,?,?)`);
    db.transaction(() => { for (const r of rows) ins.run(companyId,r.Number,r.GroupName||''); })();
  },
  getItemGroups(companyId) { return db.prepare(`SELECT * FROM cache_item_groups WHERE company_id=? ORDER BY GroupName`).all(companyId); },
  // BP Groups
  upsertBPGroups(companyId, rows) {
    const ins = db.prepare(`INSERT OR REPLACE INTO cache_bp_groups(company_id,Code,Name) VALUES(?,?,?)`);
    db.transaction(() => { for (const r of rows) ins.run(companyId,r.Code,r.Name||''); })();
  },
  getBPGroups(companyId) { return db.prepare(`SELECT * FROM cache_bp_groups WHERE company_id=? ORDER BY Name`).all(companyId); },
  // G/L Accounts (Chart of Accounts)
  upsertGLAccounts(companyId, rows) {
    try { db.exec(`ALTER TABLE cache_gl_accounts ADD COLUMN AcctType TEXT DEFAULT ''`); } catch(_) {}
    const ins = db.prepare(`INSERT OR REPLACE INTO cache_gl_accounts(company_id,AcctCode,AcctName,FormatCode,Postable,Frozen,AcctType) VALUES(?,?,?,?,?,?,?)`);
    db.transaction(() => { for (const r of rows) ins.run(companyId,r.AcctCode,r.AcctName||'',r.FormatCode||'',r.Postable||'tYES',r.Frozen||'tNO',r.AcctType||''); })();
  },
  // postable expense accounts (all postable accounts when the type was never synced)
  listExpenseAccounts(companyId) {
    try { db.exec(`ALTER TABLE cache_gl_accounts ADD COLUMN AcctType TEXT DEFAULT ''`); } catch(_) {}
    const exp = db.prepare(`SELECT * FROM cache_gl_accounts WHERE company_id=? AND Postable='tYES' AND Frozen='tNO' AND AcctType='at_Expenses' ORDER BY AcctCode`).all(companyId);
    return exp.length ? exp : db.prepare(`SELECT * FROM cache_gl_accounts WHERE company_id=? AND Postable='tYES' AND Frozen='tNO' AND COALESCE(AcctType,'')='' ORDER BY AcctCode`).all(companyId);
  },
  // postable, non-frozen accounts matching code / format code / name; top=0 → no limit
  searchGLAccounts(companyId, q, top=50) {
    const like = `%${q||''}%`;
    return db.prepare(`SELECT * FROM cache_gl_accounts WHERE company_id=? AND Postable='tYES' AND Frozen='tNO'
      AND (AcctCode LIKE ? OR FormatCode LIKE ? OR AcctName LIKE ?)
      ORDER BY CASE WHEN AcctCode=? OR FormatCode=? THEN 0 ELSE 1 END, AcctCode ${top ? 'LIMIT ' + Number(top) : ''}`)
      .all(companyId,like,like,like,q||'',q||'');
  },
  getGLAccount(companyId, code) { return db.prepare(`SELECT * FROM cache_gl_accounts WHERE company_id=? AND AcctCode=?`).get(companyId, code) || null; },
  countGLAccounts(companyId) { return db.prepare(`SELECT COUNT(*) AS n FROM cache_gl_accounts WHERE company_id=?`).get(companyId)?.n ?? 0; },
  // Open Sales Orders — transactional, not master data: a stale row here (an order
  // that's since been delivered/closed elsewhere) would let someone act on it as if
  // it were still open, so every sync replaces the whole snapshot rather than merging.
  upsertOpenOrders(companyId, rows) {
    const del = db.prepare(`DELETE FROM cache_open_orders WHERE company_id=?`);
    const ins = db.prepare(`INSERT OR REPLACE INTO cache_open_orders
      (company_id,DocEntry,DocNum,CardCode,CardName,DocDate,DocDueDate,DocTotal,NumAtCard)
      VALUES (?,?,?,?,?,?,?,?,?)`);
    db.transaction(() => {
      del.run(companyId);
      for (const r of rows) ins.run(companyId,r.DocEntry,r.DocNum,r.CardCode,r.CardName||'',r.DocDate||'',r.DocDueDate||'',r.DocTotal||0,r.NumAtCard||'');
    })();
  },
  getOpenOrdersCustomers(companyId) {
    return db.prepare(`SELECT CardCode AS cardCode, CardName AS cardName FROM cache_open_orders
      WHERE company_id=? GROUP BY CardCode ORDER BY CardName`).all(companyId);
  },
  // Bill of Materials — one row per component line, header fields repeated on each line
  upsertBomLines(companyId, rows) {
    const ins = db.prepare(`INSERT OR REPLACE INTO cache_bom_lines
      (company_id,TreeCode,ParentName,TreeType,BaseQty,BomWarehouse,LineNum,ItemCode,ItemName,Quantity,Warehouse,IssueMethod)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
    db.transaction(() => {
      for (const r of rows) ins.run(companyId,r.TreeCode,r.ParentName||'',r.TreeType||'',r.BaseQty??1,r.BomWarehouse||'',
        r.LineNum,r.ItemCode||'',r.ItemName||'',r.Quantity||0,r.Warehouse||'',r.IssueMethod||'');
    })();
  },
  // BOM headers (one row per parent) matching code / name; top=0 → no limit
  searchBoms(companyId, q, top=20) {
    const like = `%${q||''}%`;
    return db.prepare(`SELECT TreeCode, ParentName, TreeType, BaseQty, BomWarehouse, COUNT(*) AS ComponentCount
      FROM cache_bom_lines WHERE company_id=? AND (TreeCode LIKE ? OR ParentName LIKE ?)
      GROUP BY TreeCode ORDER BY TreeCode ${top ? 'LIMIT ' + Number(top) : ''}`).all(companyId, like, like);
  },
  getBomLines(companyId, treeCode) {
    return db.prepare(`SELECT * FROM cache_bom_lines WHERE company_id=? AND TreeCode=? ORDER BY LineNum`).all(companyId, treeCode);
  },
  // Where-used: every BOM that consumes this component
  getBomsUsingItem(companyId, itemCode) {
    return db.prepare(`SELECT TreeCode, ParentName, TreeType, Quantity, Warehouse FROM cache_bom_lines
      WHERE company_id=? AND ItemCode=? ORDER BY TreeCode`).all(companyId, itemCode);
  },
  // Sync log
  logSync(companyId, entity, status, count, error='') {
    db.prepare(`INSERT INTO cache_sync_log(company_id,entity,status,record_count,error_msg,synced_at)
      VALUES(?,?,?,?,?,datetime('now'))`).run(companyId,entity,status,count||0,error||'');
  },
  getLastSync(companyId) {
    return db.prepare(`SELECT entity, status, record_count, error_msg, synced_at
      FROM cache_sync_log c WHERE company_id=?
      AND id=(SELECT MAX(id) FROM cache_sync_log WHERE company_id=c.company_id AND entity=c.entity)
      ORDER BY entity`)
      .all(companyId);
  },
  // Exact row counts per entity stored in hanny.db for a company
  getStats(companyId) {
    return {
      company_id:       companyId,
      items:            db.prepare(`SELECT COUNT(*) AS n FROM cache_items            WHERE company_id=?`).get(companyId)?.n ?? 0,
      customers:        db.prepare(`SELECT COUNT(*) AS n FROM cache_business_partners WHERE company_id=? AND CardType='cCustomer'`).get(companyId)?.n ?? 0,
      suppliers:        db.prepare(`SELECT COUNT(*) AS n FROM cache_business_partners WHERE company_id=? AND CardType='cSupplier'`).get(companyId)?.n ?? 0,
      tax_codes:        db.prepare(`SELECT COUNT(*) AS n FROM cache_tax_codes        WHERE company_id=?`).get(companyId)?.n ?? 0,
      warehouses:       db.prepare(`SELECT COUNT(*) AS n FROM cache_warehouses       WHERE company_id=?`).get(companyId)?.n ?? 0,
      uom:              db.prepare(`SELECT COUNT(*) AS n FROM cache_uom              WHERE company_id=?`).get(companyId)?.n ?? 0,
      payment_terms:    db.prepare(`SELECT COUNT(*) AS n FROM cache_payment_terms    WHERE company_id=?`).get(companyId)?.n ?? 0,
      currencies:       db.prepare(`SELECT COUNT(*) AS n FROM cache_currencies       WHERE company_id=?`).get(companyId)?.n ?? 0,
      item_groups:      db.prepare(`SELECT COUNT(*) AS n FROM cache_item_groups      WHERE company_id=?`).get(companyId)?.n ?? 0,
      bp_groups:        db.prepare(`SELECT COUNT(*) AS n FROM cache_bp_groups        WHERE company_id=?`).get(companyId)?.n ?? 0,
      open_orders:      db.prepare(`SELECT COUNT(*) AS n FROM cache_open_orders      WHERE company_id=?`).get(companyId)?.n ?? 0,
      gl_accounts:      db.prepare(`SELECT COUNT(*) AS n FROM cache_gl_accounts      WHERE company_id=?`).get(companyId)?.n ?? 0,
      boms:             db.prepare(`SELECT COUNT(*) AS n FROM cache_bom_lines        WHERE company_id=?`).get(companyId)?.n ?? 0,
    };
  },
  // Wipes cached rows AND sync history for one entity — status goes back to
  // "Never synced" so the next Sync pulls a completely fresh copy from SAP.
  clearEntity(companyId, entity) {
    this.deleteEntityRows(companyId, entity);
    db.prepare(`DELETE FROM cache_sync_log WHERE company_id=? AND entity=?`).run(companyId, entity);
  },
  // Full refresh: drop this entity's cached rows and write the fresh SAP snapshot
  // in ONE transaction — so rows deleted/changed in SAP never linger, and a failed
  // save rolls back to the previous copy instead of leaving the cache half-empty.
  replaceEntity(companyId, entity, saveFn) {
    db.transaction(() => {
      this.deleteEntityRows(companyId, entity);
      saveFn();
    })();
  },
  deleteEntityRows(companyId, entity) {
    const del = (sql, ...args) => db.prepare(sql).run(companyId, ...args);
    const byEntity = {
      items:         () => del(`DELETE FROM cache_items WHERE company_id=?`),
      customers:     () => del(`DELETE FROM cache_business_partners WHERE company_id=? AND CardType='cCustomer'`),
      suppliers:     () => del(`DELETE FROM cache_business_partners WHERE company_id=? AND CardType='cSupplier'`),
      tax_codes:     () => del(`DELETE FROM cache_tax_codes WHERE company_id=?`),
      warehouses:    () => del(`DELETE FROM cache_warehouses WHERE company_id=?`),
      uom:           () => del(`DELETE FROM cache_uom WHERE company_id=?`),
      payment_terms: () => del(`DELETE FROM cache_payment_terms WHERE company_id=?`),
      currencies:    () => del(`DELETE FROM cache_currencies WHERE company_id=?`),
      item_groups:   () => del(`DELETE FROM cache_item_groups WHERE company_id=?`),
      bp_groups:     () => del(`DELETE FROM cache_bp_groups WHERE company_id=?`),
      open_orders:   () => del(`DELETE FROM cache_open_orders WHERE company_id=?`),
      gl_accounts:   () => del(`DELETE FROM cache_gl_accounts WHERE company_id=?`),
      boms:          () => del(`DELETE FROM cache_bom_lines WHERE company_id=?`),
    };
    if (!byEntity[entity]) throw new Error(`Unknown entity: ${entity}`);
    byEntity[entity]();
  },
  clearCompany(companyId) {
    ['cache_items','cache_business_partners','cache_tax_codes','cache_warehouses',
     'cache_uom','cache_payment_terms','cache_currencies','cache_item_groups','cache_bp_groups',
     'cache_open_orders','cache_gl_accounts','cache_bom_lines']
      .forEach(t => db.prepare(`DELETE FROM ${t} WHERE company_id=?`).run(companyId));
    // Also clear sync history so the UI shows "Never synced" instead of stale OK/counts.
    db.prepare(`DELETE FROM cache_sync_log WHERE company_id=?`).run(companyId);
  },
};

// ── Chat conversation history ───────────────────────────────────────────────
// Was an in-memory Map in chat-server.mjs — every server restart (common
// during normal dev/deploy work) silently wiped every open conversation with
// no warning to the user. Persisted here instead so a restart doesn't lose
// mid-conversation context.
db.exec(`
  CREATE TABLE IF NOT EXISTS chat_sessions (
    session_id TEXT PRIMARY KEY,
    messages   TEXT NOT NULL DEFAULT '[]',
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);
// preview: first user message's text, set once (not overwritten on later
// turns) so the conversation-history sidebar can show a stable title
// without re-parsing the full message array on every list request.
try { db.exec(`ALTER TABLE chat_sessions ADD COLUMN preview TEXT DEFAULT ''`); } catch {}
// user_id: who this conversation belongs to, set once at creation (best-
// effort — /api/chat itself doesn't require auth, so this can be NULL for
// an anonymous/widget caller). Added so the history sidebar (list/get) can
// filter to the caller's own sessions instead of exposing every user's
// conversations — it originally had no ownership check at all.
try { db.exec(`ALTER TABLE chat_sessions ADD COLUMN user_id INTEGER`); } catch {}
// title: user-set name for the thread (rename in the history popup); falls
// back to preview when empty.
try { db.exec(`ALTER TABLE chat_sessions ADD COLUMN title TEXT DEFAULT ''`); } catch {}

// Display transcript of each thread — one row per visible user/assistant
// turn, written for EVERY engine. chat_sessions.messages only ever held the
// AI engines' (Claude/GPT) wire format, so Standard / DB Direct / V2
// conversations never showed up in history at all.
db.exec(`
  CREATE TABLE IF NOT EXISTS chat_turns (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    role       TEXT NOT NULL CHECK (role IN ('user','assistant')),
    text       TEXT NOT NULL,
    engine     TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_chat_turns_session ON chat_turns (session_id, id)`);
const TURN_MAX_LEN = 200000; // a big table reply is fine; a runaway payload isn't

// Stored messages are the raw Claude/GPT-4o tool-calling wire format (content
// blocks, tool_use/tool_result turns, etc.) — not something to show a human
// directly. Pulls out just the plain-text user/assistant exchanges, in order,
// for the conversation-history sidebar's preview and full-conversation replay.
function extractDisplayText(messages) {
  const out = [];
  for (const m of messages || []) {
    if (m.role === 'user') {
      if (typeof m.content === 'string') out.push({ role: 'user', text: m.content });
      // else: a tool_result turn (Claude) — internal, not user-typed, skip
    } else if (m.role === 'assistant') {
      let text = '';
      if (typeof m.content === 'string') text = m.content;
      else if (Array.isArray(m.content)) text = m.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
      if (text) out.push({ role: 'assistant', text });
    }
    // role === 'tool' (GPT) or 'system': internal, skip
  }
  return out;
}

// True for text a person typed as a question/command worth re-running —
// false for payloads/data (JSON bodies, table dumps, tool results) and for
// throwaway replies ("2" suggestion picks, yes/no write confirmations).
const CONFIRM_RE = /^(y|yes|yeah|yep|ok|okay|confirm|go ahead|proceed|n|no|nope|cancel|stop|abort)[.!]?$/i;
export function isReusablePrompt(text) {
  const t = String(text || '').trim();
  if (!t || t.length > 2000) return false;
  if (/^\d{1,2}\s*[.):]?$/.test(t) || CONFIRM_RE.test(t)) return false;
  if (/^[\[{]/.test(t)) { try { JSON.parse(t); return false; } catch {} }
  if (/^\s*\|.*\|\s*$/m.test(t) && t.split('\n').length > 2) return false; // pasted markdown table
  if (/^data:[\w/+.-]+;base64,/.test(t)) return false;
  return true;
}

export const chatSessionRepo = {
  get(sessionId) {
    const row = db.prepare(`SELECT messages FROM chat_sessions WHERE session_id=?`).get(sessionId);
    if (!row) return null;
    try { return JSON.parse(row.messages); } catch { return null; }
  },
  // userId: the caller's id, if known (best-effort — set on first insert
  // only, like preview; never overwritten on later turns of the same
  // conversation, so ownership can't be reassigned mid-conversation).
  set(sessionId, messages, userId = null) {
    const existing = db.prepare(`SELECT session_id FROM chat_sessions WHERE session_id=?`).get(sessionId);
    let preview = null;
    if (!existing) {
      const firstUser = (messages || []).find(m => m.role === 'user' && typeof m.content === 'string');
      preview = firstUser ? firstUser.content.slice(0, 120) : '(New conversation)';
    }
    db.prepare(`
      INSERT INTO chat_sessions (session_id, messages, updated_at, preview, user_id)
      VALUES (?,?,CURRENT_TIMESTAMP,?,?)
      ON CONFLICT(session_id) DO UPDATE SET messages=excluded.messages, updated_at=CURRENT_TIMESTAMP
    `).run(sessionId, JSON.stringify(messages), preview || '', userId);
  },
  delete(sessionId) {
    db.prepare(`DELETE FROM chat_sessions WHERE session_id=?`).run(sessionId);
    db.prepare(`DELETE FROM chat_turns WHERE session_id=?`).run(sessionId);
  },
  // Records one visible exchange of a thread (any engine). Creates the
  // thread row if this is its first turn; an anonymous thread is claimed by
  // the first logged-in caller to continue it, never reassigned after that.
  appendExchange(sessionId, userId, userText, replyText, engine = '') {
    const u = String(userText || '').slice(0, TURN_MAX_LEN);
    const a = String(replyText || '').slice(0, TURN_MAX_LEN);
    if (!sessionId || (!u && !a)) return;
    const owner = db.prepare(`SELECT user_id FROM chat_sessions WHERE session_id=?`).get(sessionId)?.user_id;
    if (owner != null && userId != null && owner !== userId) return; // not their thread — don't write into it
    db.transaction(() => {
      db.prepare(`
        INSERT INTO chat_sessions (session_id, messages, updated_at, preview, user_id)
        VALUES (?, '[]', CURRENT_TIMESTAMP, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET
          updated_at = CURRENT_TIMESTAMP,
          user_id    = COALESCE(chat_sessions.user_id, excluded.user_id),
          preview    = CASE WHEN COALESCE(chat_sessions.preview,'') = '' THEN excluded.preview ELSE chat_sessions.preview END
      `).run(sessionId, isReusablePrompt(u) ? u.slice(0, 120) : '', userId);
      const ins = db.prepare(`INSERT INTO chat_turns (session_id, role, text, engine) VALUES (?,?,?,?)`);
      if (u) ins.run(sessionId, 'user', u, engine);
      if (a) ins.run(sessionId, 'assistant', a, engine);
    })();
  },
  // Most-recently-active conversations belonging to userId, newest first,
  // for the history sidebar — was unfiltered (every user's sessions),
  // returns nothing for an unknown caller rather than falling back to "all".
  // q: optional search over title, preview and every turn's text.
  list(limit = 50, userId = null, q = '') {
    if (userId == null) return [];
    const like = q ? `%${String(q).replace(/[\\%_]/g, m => '\\' + m)}%` : null;
    // Search matches what the user typed (title/prompts), never reply data.
    const rows = db.prepare(`
      SELECT c.session_id, c.preview, c.title, c.updated_at, c.messages
      FROM chat_sessions c
      WHERE c.user_id = ?
        AND (? IS NULL OR c.title LIKE ? ESCAPE '\\' OR c.preview LIKE ? ESCAPE '\\'
             OR EXISTS (SELECT 1 FROM chat_turns t WHERE t.session_id = c.session_id AND t.role = 'user' AND t.text LIKE ? ESCAPE '\\'))
      ORDER BY c.updated_at DESC LIMIT ?
    `).all(userId, like, like, like, like, limit);
    return rows.map(({ messages, ...r }) => {
      const prompts = chatSessionRepo._prompts(r.session_id, messages);
      // preview was stored raw — may be a JSON payload; show the first real prompt instead
      const preview = isReusablePrompt(r.preview) ? r.preview : (prompts[0]?.text.slice(0, 120) || '');
      return { ...r, preview, prompt_count: prompts.length };
    }).filter(r => r.prompt_count > 0 || r.title);
  },
  // Only the reusable prompts a user typed in a thread, oldest first,
  // de-duplicated (a re-asked prompt keeps its latest time).
  _prompts(sessionId, messagesJson) {
    const seen = new Map();
    for (const t of chatSessionRepo._turns(sessionId, messagesJson)) {
      if (t.role !== 'user') continue;
      const text = String(t.text).trim();
      if (!isReusablePrompt(text)) continue;
      seen.delete(text);
      seen.set(text, { text, at: t.created_at || null });
    }
    return [...seen.values()];
  },
  promptsForUser(sessionId, userId) {
    const row = db.prepare(`SELECT messages, user_id FROM chat_sessions WHERE session_id=?`).get(sessionId);
    if (!row || row.user_id == null || row.user_id !== userId) return null;
    return chatSessionRepo._prompts(sessionId, row.messages);
  },
  isOwnedBy(sessionId, userId) {
    const row = db.prepare(`SELECT user_id FROM chat_sessions WHERE session_id=?`).get(sessionId);
    return !!row && row.user_id != null && row.user_id === userId;
  },
  rename(sessionId, userId, title) {
    return db.prepare(`UPDATE chat_sessions SET title=? WHERE session_id=? AND user_id=?`)
      .run(String(title || '').trim().slice(0, 120), sessionId, userId).changes > 0;
  },
  // Visible turns of a thread: the all-engine transcript when there is one,
  // else (threads from before chat_turns existed) parsed from the AI wire format.
  _turns(sessionId, messagesJson) {
    const turns = db.prepare(`SELECT role, text, engine, created_at FROM chat_turns WHERE session_id=? ORDER BY id`).all(sessionId);
    if (turns.length) return turns;
    try { return extractDisplayText(JSON.parse(messagesJson || '[]')); } catch { return []; }
  },
  // Full conversation as displayable {role, text} turns, for loading a past
  // session back into the chat UI. Unscoped — used internally within the
  // same request that owns sessionId, not exposed directly over HTTP.
  getDisplayable(sessionId) {
    const row = db.prepare(`SELECT messages FROM chat_sessions WHERE session_id=?`).get(sessionId);
    if (!row) return null;
    return chatSessionRepo._turns(sessionId, row.messages);
  },
  // Ownership-checked variant for the HTTP route that lets a user reload a
  // past conversation — returns null for a session that doesn't exist OR
  // belongs to someone else (same response either way, so the route can't
  // be used to probe which session ids exist).
  getDisplayableForUser(sessionId, userId) {
    const row = db.prepare(`SELECT messages, user_id FROM chat_sessions WHERE session_id=?`).get(sessionId);
    if (!row || row.user_id == null || row.user_id !== userId) return null;
    return chatSessionRepo._turns(sessionId, row.messages);
  },
  // Drop conversations untouched for maxAgeMs — call occasionally to keep the table small.
  prune(maxAgeMs) {
    const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
    db.prepare(`DELETE FROM chat_sessions WHERE updated_at < ?`).run(cutoff);
    db.prepare(`DELETE FROM chat_turns WHERE session_id NOT IN (SELECT session_id FROM chat_sessions)`).run();
  },
};

// ── Prompt history & saved prompts ──────────────────────────────────────────
// Saved prompts used to live only in the browser's localStorage, so they were
// lost on another PC/browser or after clearing site data. One row per
// (user, kind, text): kind 'saved' = bookmarked by the user, kind 'history' =
// recorded automatically from /api/chat (re-asking bumps use_count/last_used_at
// instead of adding a duplicate row).
db.exec(`
  CREATE TABLE IF NOT EXISTS user_prompts (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      INTEGER NOT NULL,
    kind         TEXT NOT NULL CHECK (kind IN ('saved','history')),
    text         TEXT NOT NULL,
    source       TEXT DEFAULT '',
    engine       TEXT DEFAULT '',
    use_count    INTEGER NOT NULL DEFAULT 1,
    created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_used_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (user_id, kind, text)
  )
`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_user_prompts_recent ON user_prompts (user_id, kind, last_used_at DESC)`);

const PROMPT_MAX_LEN = 2000;
const HISTORY_KEEP   = 200; // per user — oldest history rows beyond this are dropped

export const promptRepo = {
  list(userId, kind, limit = 50) {
    return db.prepare(`
      SELECT id, text, source, engine, use_count, created_at, last_used_at
      FROM user_prompts WHERE user_id=? AND kind=?
      ORDER BY last_used_at DESC, id DESC LIMIT ?
    `).all(userId, kind, limit);
  },
  // Insert, or bump use_count/last_used_at when the same text already exists.
  upsert(userId, kind, text, { source = '', engine = '' } = {}) {
    const t = String(text || '').trim().slice(0, PROMPT_MAX_LEN);
    if (!t) return null;
    db.prepare(`
      INSERT INTO user_prompts (user_id, kind, text, source, engine)
      VALUES (?,?,?,?,?)
      ON CONFLICT(user_id, kind, text) DO UPDATE SET
        use_count = use_count + 1, last_used_at = CURRENT_TIMESTAMP,
        source = COALESCE(NULLIF(excluded.source,''), source),
        engine = COALESCE(NULLIF(excluded.engine,''), engine)
    `).run(userId, kind, t, source || '', engine || '');
    if (kind === 'history') {
      db.prepare(`
        DELETE FROM user_prompts WHERE user_id=? AND kind='history' AND id NOT IN (
          SELECT id FROM user_prompts WHERE user_id=? AND kind='history'
          ORDER BY last_used_at DESC, id DESC LIMIT ?)
      `).run(userId, userId, HISTORY_KEEP);
    }
    return db.prepare(`SELECT id, text, source, engine, use_count, created_at, last_used_at FROM user_prompts WHERE user_id=? AND kind=? AND text=?`).get(userId, kind, t);
  },
  // Ownership-scoped — deleting another user's row is a silent no-op.
  delete(userId, id) {
    return db.prepare(`DELETE FROM user_prompts WHERE id=? AND user_id=?`).run(id, userId).changes > 0;
  },
  clear(userId, kind) {
    return db.prepare(`DELETE FROM user_prompts WHERE user_id=? AND kind=?`).run(userId, kind).changes;
  },
};

// ── Excel Import agents (Sales Orders, Items, Business Partners, BOMs, A/P service
//    invoices, salary journal entries) ─────────────────────────────────────────────
// One row per uploaded sheet (the acknowledgement) and one per record found in it
// (a sales order, an item, a journal entry …). doc_type says which agent owns the
// row; every query is scoped to company + doc_type. Lines, header fields and
// validation issues are kept as JSON. The summary columns (card_code = record code,
// card_name = its name, doc_date / due_date, num_at_card = reference) feed the lists.
// status: ready | failed (pending tab) · missing (missing-data tab) · posting · posted
db.exec(`
  CREATE TABLE IF NOT EXISTS so_import_batches (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    company         TEXT NOT NULL DEFAULT '',
    file_name       TEXT DEFAULT '',
    sheet_name      TEXT DEFAULT '',
    uploaded_by     TEXT DEFAULT '',
    uploaded_at     TEXT NOT NULL,
    row_count       INTEGER NOT NULL DEFAULT 0,
    order_count     INTEGER NOT NULL DEFAULT 0,
    line_count      INTEGER NOT NULL DEFAULT 0,
    ready_count     INTEGER NOT NULL DEFAULT 0,
    missing_count   INTEGER NOT NULL DEFAULT 0,
    duplicate_count INTEGER NOT NULL DEFAULT 0,
    superseded_count INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_so_import_batches_company ON so_import_batches(company, id DESC);

  CREATE TABLE IF NOT EXISTS so_import_orders (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_id      INTEGER NOT NULL REFERENCES so_import_batches(id) ON DELETE CASCADE,
    company       TEXT NOT NULL DEFAULT '',
    order_key     TEXT NOT NULL,
    card_code     TEXT DEFAULT '',
    card_name     TEXT DEFAULT '',
    doc_date      TEXT,
    due_date      TEXT,
    num_at_card   TEXT DEFAULT '',
    line_count    INTEGER NOT NULL DEFAULT 0,
    total         REAL NOT NULL DEFAULT 0,
    header_json   TEXT NOT NULL DEFAULT '{}',
    lines_json    TEXT NOT NULL DEFAULT '[]',
    issues_json   TEXT NOT NULL DEFAULT '[]',
    status        TEXT NOT NULL DEFAULT 'ready',
    error         TEXT DEFAULT '',
    sap_doc_entry INTEGER,
    sap_doc_num   INTEGER,
    posted_at     TEXT,
    posted_by     TEXT DEFAULT '',
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_so_import_orders_status ON so_import_orders(company, status);
  CREATE INDEX IF NOT EXISTS idx_so_import_orders_key    ON so_import_orders(company, order_key);

  CREATE TABLE IF NOT EXISTS so_import_templates (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    company     TEXT NOT NULL DEFAULT '',
    name        TEXT NOT NULL,
    description TEXT DEFAULT '',
    is_default  INTEGER NOT NULL DEFAULT 0,
    json        TEXT NOT NULL DEFAULT '{}',
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    updated_by  TEXT DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS idx_so_import_templates_company ON so_import_templates(company);
`);
// Each upload keeps a snapshot of the template it was read with, so later edits
// to the template never change how already-imported records are shown or posted.
// doc_type: rows from before the other agents existed are sales orders.
(function migrateImportTables() {
  const add = {
    so_import_batches: { template_id: 'INTEGER', template_name: `TEXT DEFAULT ''`, template_json: 'TEXT', doc_type: `TEXT NOT NULL DEFAULT 'order'` },
    so_import_orders: { doc_type: `TEXT NOT NULL DEFAULT 'order'` },
    so_import_templates: { doc_type: `TEXT NOT NULL DEFAULT 'order'` },
  };
  for (const [table, cols] of Object.entries(add)) {
    const have = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
    for (const [c, t] of Object.entries(cols)) if (!have.includes(c)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${c} ${t}`);
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_so_import_orders_type ON so_import_orders(company, doc_type, status)`);
})();
// A post cut off by a restart may or may not have reached SAP — never retry it blindly.
db.prepare(`UPDATE so_import_orders SET status='failed',
  error='Posting was interrupted — check SAP for this record before posting it again.' WHERE status='posting'`).run();

const soiNow = () => new Date().toISOString();
const soiRow = r => r && ({
  id: r.id, batchId: r.batch_id, orderKey: r.order_key, cardCode: r.card_code, cardName: r.card_name,
  docDate: r.doc_date, dueDate: r.due_date, numAtCard: r.num_at_card, lineCount: r.line_count, total: r.total,
  status: r.status, error: r.error || '', docEntry: r.sap_doc_entry, docNum: r.sap_doc_num,
  postedAt: r.posted_at, postedBy: r.posted_by, createdAt: r.created_at, updatedAt: r.updated_at,
  fileName: r.file_name, issues: JSON.parse(r.issues_json || '[]'),
  templateId: r.template_id ?? null, templateName: r.template_name || '',
  cells: r.header_json ? (JSON.parse(r.header_json).cells || {}) : {},
  mode: r.header_json ? (JSON.parse(r.header_json).mode || 'create') : 'create',
});
const soiFull = r => ({ ...soiRow(r), header: JSON.parse(r.header_json || '{}'), lines: JSON.parse(r.lines_json || '[]'),
  template: r.template_json ? JSON.parse(r.template_json) : null });
const soiTpl = r => r && ({ id: r.id, name: r.name, description: r.description || '', isDefault: !!r.is_default,
  ...JSON.parse(r.json || '{}'), updatedAt: r.updated_at, updatedBy: r.updated_by || '' });
const SOI_TABS = { pending: ['ready', 'failed', 'posting'], posted: ['posted'], missing: ['missing'] };
const soiSummary = (o, s) => ({ card_code: s.code || '', card_name: s.name || '', doc_date: s.date || null, due_date: s.due || null, num_at_card: s.ref || '' });

// Every method takes the scope { company, type } first.
export const importRepo = {
  // Saves the upload. A key already posted is kept as a duplicate (missing tab);
  // unposted copies from earlier uploads are replaced by the new one.
  saveBatch(sc, meta, orders) {
    const now = soiNow();
    const postedOf = db.prepare(`SELECT sap_doc_num FROM so_import_orders WHERE company=? AND doc_type=? AND order_key=? AND status IN ('posted','posting') LIMIT 1`);
    const dropOld = db.prepare(`DELETE FROM so_import_orders WHERE company=? AND doc_type=? AND order_key=? AND status IN ('ready','failed','missing')`);
    const ins = db.prepare(`INSERT INTO so_import_orders
      (batch_id, company, doc_type, order_key, card_code, card_name, doc_date, due_date, num_at_card, line_count, total,
       header_json, lines_json, issues_json, status, created_at, updated_at)
      VALUES (@batch_id,@company,@doc_type,@order_key,@card_code,@card_name,@doc_date,@due_date,@num_at_card,@line_count,@total,
       @header_json,@lines_json,@issues_json,@status,@now,@now)`);
    return db.transaction(() => {
      const batchId = db.prepare(`INSERT INTO so_import_batches (company, doc_type, file_name, sheet_name, uploaded_by, uploaded_at, row_count, line_count,
          template_id, template_name, template_json)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(sc.company, sc.type, meta.fileName, meta.sheetName, meta.uploadedBy, now, meta.rowCount, meta.lineCount,
          meta.template.id, meta.template.name, JSON.stringify(meta.template)).lastInsertRowid;
      let ready = 0, missing = 0, duplicates = 0, superseded = 0;
      for (const o of orders) {
        const posted = postedOf.get(sc.company, sc.type, o.orderKey);
        if (posted) {
          o.issues.unshift({ local: true, message: `${meta.noun} ${o.orderKey} is already posted to SAP${posted.sap_doc_num ? ` (${meta.docLabel} ${posted.sap_doc_num})` : ''}` });
          duplicates++;
        } else superseded += dropOld.run(sc.company, sc.type, o.orderKey).changes;
        const status = o.issues.length ? 'missing' : 'ready';
        status === 'ready' ? ready++ : missing++;
        ins.run({ batch_id: batchId, company: sc.company, doc_type: sc.type, order_key: o.orderKey, ...soiSummary(o, o.summary),
          line_count: o.lineCount ?? o.lines.length, total: o.total ?? 0, header_json: JSON.stringify(o.header), lines_json: JSON.stringify(o.lines),
          issues_json: JSON.stringify(o.issues), status, now });
      }
      db.prepare(`UPDATE so_import_batches SET order_count=?, ready_count=?, missing_count=?, duplicate_count=?, superseded_count=? WHERE id=?`)
        .run(orders.length, ready, missing, duplicates, superseded, batchId);
      return { batchId: Number(batchId), ready, missing, duplicates, superseded, uploadedAt: now };
    })();
  },
  // templateId: only records imported with that template. q also matches any mapped header value.
  list(sc, tab, { q = '', limit = 2000, templateId = null } = {}) {
    const statuses = SOI_TABS[tab] || SOI_TABS.pending;
    const like = `%${String(q).trim()}%`;
    return db.prepare(`SELECT o.*, b.file_name, b.template_id, b.template_name FROM so_import_orders o JOIN so_import_batches b ON b.id=o.batch_id
      WHERE o.company=? AND o.doc_type=? AND o.status IN (${statuses.map(() => '?').join(',')}) AND (? IS NULL OR b.template_id=?)
        AND (?='%%' OR o.order_key LIKE ? OR o.card_code LIKE ? OR o.card_name LIKE ? OR o.num_at_card LIKE ? OR CAST(o.sap_doc_num AS TEXT) LIKE ?
             OR o.header_json LIKE ?)
      ORDER BY ${tab === 'posted' ? 'o.posted_at DESC' : 'o.id DESC'} LIMIT ?`)
      .all(sc.company, sc.type, ...statuses, templateId, templateId, like, like, like, like, like, like, like, limit).map(soiRow);
  },
  // Latest snapshot of each template that imported records (the columns the tabs show).
  templateSnapshots(sc, ids) {
    if (!ids.length) return [];
    return db.prepare(`SELECT template_id, template_json FROM so_import_batches
      WHERE company=? AND doc_type=? AND template_id IN (${ids.map(() => '?').join(',')}) AND template_json IS NOT NULL ORDER BY id DESC`)
      .all(sc.company, sc.type, ...ids).map(r => ({ id: r.template_id, ...JSON.parse(r.template_json) }));
  },
  // Batches saved without a template id (before templates existed) belong to the template of the same name.
  linkBatches(sc, templates) {
    const up = db.prepare(`UPDATE so_import_batches SET template_id=? WHERE company=? AND doc_type=? AND template_id IS NULL AND template_name=?`);
    for (const t of templates) up.run(t.id, sc.company, sc.type, t.name);
  },
  counts(sc) {
    const rows = db.prepare(`SELECT status, COUNT(*) n, SUM(total) v FROM so_import_orders WHERE company=? AND doc_type=? GROUP BY status`).all(sc.company, sc.type);
    const by = Object.fromEntries(rows.map(r => [r.status, r]));
    const n = s => by[s]?.n || 0, v = s => by[s]?.v || 0;
    return { pending: n('ready') + n('failed') + n('posting'), ready: n('ready'), failed: n('failed'), posting: n('posting'),
      posted: n('posted'), missing: n('missing'), pendingValue: v('ready') + v('failed'), postedValue: v('posted') };
  },
  get(sc, id) {
    const r = db.prepare(`SELECT o.*, b.file_name, b.template_json FROM so_import_orders o JOIN so_import_batches b ON b.id=o.batch_id
      WHERE o.company=? AND o.doc_type=? AND o.id=?`).get(sc.company, sc.type, id);
    return r && soiFull(r);
  },
  // Rows to re-validate (missing / failed), with lines.
  getMany(sc, ids, statuses) {
    if (!ids.length) return [];
    return db.prepare(`SELECT o.*, b.file_name, b.template_json FROM so_import_orders o JOIN so_import_batches b ON b.id=o.batch_id
      WHERE o.company=? AND o.doc_type=? AND o.id IN (${ids.map(() => '?').join(',')}) AND o.status IN (${statuses.map(() => '?').join(',')})`)
      .all(sc.company, sc.type, ...ids, ...statuses).map(soiFull);
  },
  // Every record of a tab with its lines and template (Excel export).
  listFull(sc, tab, limit = 5000) {
    return this.list(sc, tab, { limit }).map(o => this.get(sc, o.id));
  },
  // Sales orders stored before templates existed (flat header / line keys).
  legacy() {
    return db.prepare(`SELECT o.id, o.batch_id, o.order_key, o.header_json, o.lines_json FROM so_import_orders o
      WHERE o.doc_type='order' AND o.header_json NOT LIKE '{"cells"%'`).all();
  },
  rewriteJson(id, header, lines) {
    db.prepare(`UPDATE so_import_orders SET header_json=?, lines_json=? WHERE id=?`).run(JSON.stringify(header), JSON.stringify(lines), id);
  },
  setBatchTemplate(batchId, tpl) {
    db.prepare(`UPDATE so_import_batches SET template_id=?, template_name=?, template_json=? WHERE id=? AND template_json IS NULL`)
      .run(tpl.id, tpl.name, JSON.stringify(tpl), batchId);
  },

  // ── Templates ──
  templates(sc) {
    return db.prepare(`SELECT * FROM so_import_templates WHERE company=? AND doc_type=? ORDER BY is_default DESC, name COLLATE NOCASE`)
      .all(sc.company, sc.type).map(soiTpl);
  },
  template(sc, id) {
    return soiTpl(db.prepare(`SELECT * FROM so_import_templates WHERE company=? AND doc_type=? AND id=?`).get(sc.company, sc.type, id));
  },
  saveTemplate(sc, tpl, user) {
    const now = soiNow();
    const json = JSON.stringify({ dateFormat: tpl.dateFormat, layout: tpl.layout, options: tpl.options || {}, columns: tpl.columns });
    return db.transaction(() => {
      let id = tpl.id;
      if (id) {
        const ch = db.prepare(`UPDATE so_import_templates SET name=?, description=?, json=?, updated_at=?, updated_by=? WHERE company=? AND doc_type=? AND id=?`)
          .run(tpl.name, tpl.description || '', json, now, user || '', sc.company, sc.type, id).changes;
        if (!ch) return null;
      } else {
        id = Number(db.prepare(`INSERT INTO so_import_templates (company, doc_type, name, description, json, created_at, updated_at, updated_by)
          VALUES (?,?,?,?,?,?,?,?)`).run(sc.company, sc.type, tpl.name, tpl.description || '', json, now, now, user || '').lastInsertRowid);
      }
      const hasDefault = db.prepare(`SELECT 1 FROM so_import_templates WHERE company=? AND doc_type=? AND is_default=1`).get(sc.company, sc.type);
      if (tpl.isDefault || !hasDefault) this.setDefaultTemplate(sc, id);
      return this.template(sc, id);
    })();
  },
  setDefaultTemplate(sc, id) {
    db.prepare(`UPDATE so_import_templates SET is_default=CASE WHEN id=? THEN 1 ELSE 0 END WHERE company=? AND doc_type=?`).run(id, sc.company, sc.type);
  },
  deleteTemplate(sc, id) {
    const t = this.template(sc, id);
    if (!t) return false;
    db.prepare(`DELETE FROM so_import_templates WHERE company=? AND doc_type=? AND id=?`).run(sc.company, sc.type, id);
    if (t.isDefault) {
      const next = db.prepare(`SELECT id FROM so_import_templates WHERE company=? AND doc_type=? ORDER BY id LIMIT 1`).get(sc.company, sc.type);
      if (next) this.setDefaultTemplate(sc, next.id);
    }
    return true;
  },
  // ready/failed → posting, atomically, so two users can never post the same record.
  claim(sc, ids) {
    const up = db.prepare(`UPDATE so_import_orders SET status='posting', error='', updated_at=? WHERE company=? AND doc_type=? AND id=? AND status IN ('ready','failed')`);
    return db.transaction(() => ids.filter(id => up.run(soiNow(), sc.company, sc.type, id).changes > 0))();
  },
  markPosted(id, docEntry, docNum, user) {
    const now = soiNow();
    db.prepare(`UPDATE so_import_orders SET status='posted', error='', sap_doc_entry=?, sap_doc_num=?, posted_at=?, posted_by=?, updated_at=? WHERE id=?`)
      .run(docEntry ?? null, docNum ?? null, now, user || '', now, id);
  },
  markFailed(id, error) {
    db.prepare(`UPDATE so_import_orders SET status='failed', error=?, updated_at=? WHERE id=?`).run(String(error || '').slice(0, 2000), soiNow(), id);
  },
  revalidated(id, o) {
    const s = soiSummary(o, o.summary || {});
    db.prepare(`UPDATE so_import_orders SET header_json=?, lines_json=?, issues_json=?, total=?, line_count=?, card_code=?, card_name=?, doc_date=?, due_date=?, num_at_card=?,
      status=?, error='', updated_at=? WHERE id=? AND status IN ('missing','failed')`)
      .run(JSON.stringify(o.header), JSON.stringify(o.lines), JSON.stringify(o.issues), o.total ?? 0, o.lineCount ?? o.lines.length,
        s.card_code, s.card_name, s.doc_date, s.due_date, s.num_at_card, o.issues.length ? 'missing' : 'ready', soiNow(), id);
  },
  remove(sc, ids) {
    if (!ids.length) return 0;
    return db.prepare(`DELETE FROM so_import_orders WHERE company=? AND doc_type=? AND id IN (${ids.map(() => '?').join(',')}) AND status IN ('ready','failed','missing')`)
      .run(sc.company, sc.type, ...ids).changes;
  },
  batches(sc, limit = 30) {
    return db.prepare(`SELECT b.*,
        (SELECT COUNT(*) FROM so_import_orders o WHERE o.batch_id=b.id AND o.status='posted') AS posted_now
      FROM so_import_batches b WHERE b.company=? AND b.doc_type=? ORDER BY b.id DESC LIMIT ?`).all(sc.company, sc.type, limit);
  },
};

// Purge stale sessions on startup
sessionRepo.purgeExpired();
chatSessionRepo.prune(30 * 24 * 60 * 60 * 1000); // drop conversations idle > 30 days

export default db;
