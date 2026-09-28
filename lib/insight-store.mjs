// Local (SQLite, hanny.db) state for the insight agents — things SAP B1 has
// no standard place for: promises-to-pay logged by collectors, and daily
// credit-risk score snapshots used to show score trends between runs.
import { db } from '../db.mjs';

db.exec(`
  CREATE TABLE IF NOT EXISTS ptp_promises (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    company      TEXT    NOT NULL,
    card_code    TEXT    NOT NULL,
    card_name    TEXT    DEFAULT '',
    amount       REAL    NOT NULL,
    promise_date TEXT    NOT NULL,
    note         TEXT    DEFAULT '',
    status       TEXT    NOT NULL DEFAULT 'open',   -- open | kept | broken | cancelled
    created_by   TEXT    DEFAULT '',
    created_at   TEXT    NOT NULL DEFAULT (date('now')),
    updated_at   DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_ptp_company_card ON ptp_promises(company, card_code);

  CREATE TABLE IF NOT EXISTS credit_risk_snapshots (
    company   TEXT NOT NULL,
    card_code TEXT NOT NULL,
    snap_date TEXT NOT NULL,
    score     REAL NOT NULL,
    grade     TEXT NOT NULL,
    PRIMARY KEY (company, card_code, snap_date)
  );
`);

export const ptpRepo = {
  list(company) {
    return db.prepare(`SELECT * FROM ptp_promises WHERE company=? AND status != 'cancelled' ORDER BY promise_date`).all(company);
  },
  create(company, { cardCode, cardName = '', amount, promiseDate, note = '', createdBy = '' }) {
    return db.prepare(`INSERT INTO ptp_promises(company, card_code, card_name, amount, promise_date, note, created_by)
      VALUES(?,?,?,?,?,?,?)`).run(company, cardCode, cardName, amount, promiseDate, note, createdBy);
  },
  setStatus(company, id, status) {
    return db.prepare(`UPDATE ptp_promises SET status=?, updated_at=CURRENT_TIMESTAMP WHERE id=? AND company=?`).run(status, id, company);
  },
};

export const creditSnapRepo = {
  // Latest snapshot per customer strictly before `beforeDate`.
  previous(company, beforeDate) {
    const rows = db.prepare(`SELECT s.card_code, s.score, s.grade, s.snap_date FROM credit_risk_snapshots s
      JOIN (SELECT card_code, MAX(snap_date) d FROM credit_risk_snapshots WHERE company=? AND snap_date < ? GROUP BY card_code) m
        ON m.card_code = s.card_code AND m.d = s.snap_date
      WHERE s.company=?`).all(company, beforeDate, company);
    return new Map(rows.map(r => [r.card_code, r]));
  },
  save(company, snapDate, rows) {
    const ins = db.prepare(`INSERT OR REPLACE INTO credit_risk_snapshots(company, card_code, snap_date, score, grade) VALUES(?,?,?,?,?)`);
    db.transaction(() => { for (const r of rows) ins.run(company, r.cardCode, snapDate, r.score, r.grade); })();
  },
};
