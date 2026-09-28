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

const BRANDING_DEFAULTS = {
  company_name:      '',
  company_logo:      '',
  developed_by:      'Henny AI Solution',
  developed_by_logo: '/assets/henny-ai-logo.png',
  product_name:      'AgentSphere',
  product_logo:      '/assets/henny-agentic-logo.png',
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
      merged.product_name, merged.product_logo,
      new Date().toISOString(), updatedBy,
    ];
    if (has) {
      db.prepare(`UPDATE branding_settings SET company_name=?,company_logo=?,developed_by=?,developed_by_logo=?,product_name=?,product_logo=?,updated_at=?,updated_by=? WHERE id=1`).run(...vals);
    } else {
      db.prepare(`INSERT INTO branding_settings (id,company_name,company_logo,developed_by,developed_by_logo,product_name,product_logo,updated_at,updated_by) VALUES (1,?,?,?,?,?,?,?,?)`).run(...vals);
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

// All available permission keys with labels
export const ALL_PERMISSIONS = [
  { key: 'home',              label: 'Home (Chat & Dashboard)',      section: 'Home' },
  { key: 'ui.form_mode',      label: 'Form Mode Toggle (Chat/Form switch)', section: 'Home' },
  { key: 'master.item',          label: 'Item Master',                  section: 'Master Data' },
  { key: 'master.customer',      label: 'Customer Master',              section: 'Master Data' },
  { key: 'master.supplier',      label: 'Supplier Master',              section: 'Master Data' },
  { key: 'master.bom',           label: 'Bill of Material',             section: 'Master Data' },
  { key: 'master.service_call',  label: 'Service Call Master',          section: 'Master Data' },
  { key: 'service.sc_view',      label: 'Service Calls (View/Search)',   section: 'Service' },
  { key: 'service.svc_call',     label: 'New Service Call (Quick)',      section: 'Service' },
  { key: 'service.sc_form',      label: 'Service Call Management',      section: 'Service' },
  { key: 'service.sc_wizard',    label: 'New Service Call Wizard',       section: 'Service' },
  { key: 'sales.create',         label: 'Sales - Quick Create',          section: 'Sales' },
  { key: 'sales.workflow',    label: 'Sales - AI Workflow',          section: 'Sales' },
  { key: 'sales.analysis',    label: 'Sales - Analysis',             section: 'Sales' },
  { key: 'purchase.create',   label: 'Purchase - Quick Create',      section: 'Purchase' },
  { key: 'purchase.workflow', label: 'Purchase - AI Workflow',       section: 'Purchase' },
  { key: 'purchase.analysis', label: 'Purchase - Analysis',          section: 'Purchase' },
  { key: 'finance',           label: 'Finance & Collections',        section: 'Finance' },
  { key: 'inventory',         label: 'Inventory & Stock',            section: 'Inventory' },
  { key: 'ai.supply',         label: 'AI - Supply Chain Agents',     section: 'AI Agents' },
  { key: 'ai.sales',          label: 'AI - Sales & Pricing Agents',  section: 'AI Agents' },
  { key: 'ai.crm',            label: 'AI - CRM & Activity Agents',   section: 'AI Agents' },
  { key: 'analytics',         label: 'Analytics & BI Models',        section: 'Analytics' },
  { key: 'forecast',          label: 'Forecast Tools',               section: 'Forecast' },
  { key: 'tools.builder',     label: 'DB Query Builder',             section: 'Tools' },
  { key: 'tools.udt',         label: 'UDT Management',               section: 'Tools' },
  { key: 'tools.library',     label: 'Query Library',                section: 'Tools' },
  { key: 'tools.db',          label: 'DB Connection',                section: 'Tools' },
  { key: 'tools.data_sync',   label: 'Data Sync (SAP to Local Cache)', section: 'Tools' },
  { key: 'tools.schema',      label: 'Schema Registry',              section: 'Tools' },
  { key: 'tools.reports',     label: 'Reports Engine',               section: 'Tools' },
  { key: 'admin.users',       label: 'User Management',              section: 'Admin' },
  { key: 'admin.roles',       label: 'Roles & Permissions',          section: 'Admin' },
];

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
  { name:'user',       desc:'Standard user — basic sales and purchase access',   perms: ['home','ui.form_mode','sales.create','sales.workflow','sales.analysis','purchase.create','purchase.workflow','purchase.analysis','finance','inventory'] },
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
  } else {
    // admin/user are editable via Roles & Permissions — never overwrite an
    // existing role's saved permissions on startup (that would silently undo
    // admin edits every restart). Only backfill permission keys that didn't
    // exist yet when this role's row was created, so newly-added features
    // don't just vanish for roles that predate them.
    const current = new Set(roleRepo.getPermissions(existing.id));
    const missing = r.perms.filter(k => !current.has(k));
    if (missing.length) {
      roleRepo.setPermissions(existing.id, [...current, ...missing]);
      console.log(`✓ Role '${r.name}': backfilled new permission(s) ${missing.join(', ')}`);
    }
  }
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
    };
  },
  // Wipes cached rows AND sync history for one entity — status goes back to
  // "Never synced" so the next Sync pulls a completely fresh copy from SAP.
  clearEntity(companyId, entity) {
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
    };
    if (!byEntity[entity]) throw new Error(`Unknown entity: ${entity}`);
    byEntity[entity]();
    db.prepare(`DELETE FROM cache_sync_log WHERE company_id=? AND entity=?`).run(companyId, entity);
  },
  clearCompany(companyId) {
    ['cache_items','cache_business_partners','cache_tax_codes','cache_warehouses',
     'cache_uom','cache_payment_terms','cache_currencies','cache_item_groups','cache_bp_groups',
     'cache_open_orders']
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
  },
  // Most-recently-active conversations belonging to userId, newest first,
  // for the history sidebar — was unfiltered (every user's sessions),
  // returns nothing for an unknown caller rather than falling back to "all".
  list(limit = 50, userId = null) {
    if (userId == null) return [];
    return db.prepare(`SELECT session_id, preview, updated_at FROM chat_sessions WHERE user_id=? ORDER BY updated_at DESC LIMIT ?`).all(userId, limit);
  },
  // Full conversation as displayable {role, text} turns, for loading a past
  // session back into the chat UI. Unscoped — used internally within the
  // same request that owns sessionId, not exposed directly over HTTP.
  getDisplayable(sessionId) {
    const messages = chatSessionRepo.get(sessionId);
    if (!messages) return null;
    return extractDisplayText(messages);
  },
  // Ownership-checked variant for the HTTP route that lets a user reload a
  // past conversation — returns null for a session that doesn't exist OR
  // belongs to someone else (same response either way, so the route can't
  // be used to probe which session ids exist).
  getDisplayableForUser(sessionId, userId) {
    const row = db.prepare(`SELECT messages, user_id FROM chat_sessions WHERE session_id=?`).get(sessionId);
    if (!row || row.user_id == null || row.user_id !== userId) return null;
    try { return extractDisplayText(JSON.parse(row.messages)); } catch { return null; }
  },
  // Drop conversations untouched for maxAgeMs — call occasionally to keep the table small.
  prune(maxAgeMs) {
    const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
    db.prepare(`DELETE FROM chat_sessions WHERE updated_at < ?`).run(cutoff);
  },
};

// Purge stale sessions on startup
sessionRepo.purgeExpired();
chatSessionRepo.prune(30 * 24 * 60 * 60 * 1000); // drop conversations idle > 30 days

export default db;
