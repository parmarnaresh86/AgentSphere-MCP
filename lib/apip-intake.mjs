/**
 * apip-intake.mjs — intake channels for AP Invoice Processing.
 *
 *  - Folder watcher: polls settings.inputFolder with fs.readdir every settings.folderPollSec
 *    seconds; each new *.pdf is copied into app storage and queued (source='folder').
 *    After processing the controller calls finalizeFolderOriginal() to move the original to
 *    the processed / failed folder.
 *  - Mail pollers: one timer per enabled mailbox in apip_mail_configs (IMAP via `imap` +
 *    `mailparser`, same pattern as mail-po.mjs). Unseen mails whose subject matches the
 *    mailbox's subjectFilter regex with PDF attachments → queued (source='mail'), then
 *    marked \Seen.
 *
 * The controller registers onEnqueued(id) via configureIntake() so new items can be
 * auto-processed.
 */
import fs from 'node:fs';
import path from 'node:path';
import Imap from 'imap';
import { simpleParser } from 'mailparser';
import { settingsRepo, queueRepo, mailRepo, apipLog } from './apip-store.mjs';

let _onEnqueued = null;
let _getCompanyId = () => '';

const _state = {
  folderTimer: null, folderRunning: false, folderBusy: false, lastFolderScan: null, lastFolderError: '',
  mailTimers: new Map(),      // mailbox id → interval handle
  mailBusy: new Set(),        // mailbox ids currently polling
  mailRunning: false, lastMailScan: null,
  attempted: new Map(),       // mailbox id → Set(uid) of unseen mails already inspected (no PDF / subject mismatch)
};

export function configureIntake({ onEnqueued, getCompanyId } = {}) {
  if (typeof onEnqueued === 'function') _onEnqueued = onEnqueued;
  if (typeof getCompanyId === 'function') _getCompanyId = getCompanyId;
}

function notify(row) {
  try { if (_onEnqueued && row) _onEnqueued(row.id); } catch (e) { apipLog('WARN', `onEnqueued failed: ${e.message}`); }
}

export function getIntakeStatus() {
  return {
    folderRunning: _state.folderRunning,
    mailRunning: _state.mailRunning,
    lastFolderScan: _state.lastFolderScan,
    lastMailScan: _state.lastMailScan,
    // additions
    lastFolderError: _state.lastFolderError,
    mailboxes: [..._state.mailTimers.keys()],
  };
}

// ── Folder helpers ────────────────────────────────────────────────────────────
export function resolveFolders(settings) {
  const input = settings.inputFolder ? path.resolve(settings.inputFolder) : '';
  return {
    input,
    processed: settings.processedFolder ? path.resolve(settings.processedFolder) : (input ? path.join(input, 'processed') : ''),
    failed: settings.failedFolder ? path.resolve(settings.failedFolder) : (input ? path.join(input, 'failed') : ''),
  };
}

/** Validate folder settings: exists or creatable; input must differ from processed/failed. Returns error string or ''. */
export function validateFolders(settings) {
  const { input, processed, failed } = resolveFolders(settings);
  if (settings.folderWatchEnabled && !input) return 'Input folder is required when folder watch is enabled.';
  if (!input) return '';
  const same = (a, b) => a && b && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
  if (same(input, processed)) return 'Input folder must be different from the processed folder.';
  if (same(input, failed)) return 'Input folder must be different from the failed folder.';
  for (const [label, p] of [['Input', input], ['Processed', processed], ['Failed', failed]]) {
    if (!p) continue;
    try {
      if (fs.existsSync(p)) { if (!fs.statSync(p).isDirectory()) return `${label} folder path is a file, not a folder: ${p}`; }
      else fs.mkdirSync(p, { recursive: true });
    } catch (e) { return `${label} folder is not accessible/creatable (${p}): ${e.message}`; }
  }
  return '';
}

function uniqueTarget(dir, baseName) {
  let target = path.join(dir, baseName);
  if (!fs.existsSync(target)) return target;
  const ext = path.extname(baseName), stem = path.basename(baseName, ext);
  const ts = new Date().toISOString().replace(/[-:T]/g, '').replace(/\..+/, '');
  target = path.join(dir, `${stem}_${ts}${ext}`);
  let n = 1;
  while (fs.existsSync(target)) target = path.join(dir, `${stem}_${ts}_${n++}${ext}`);
  return target;
}

function moveFile(src, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const target = uniqueTarget(destDir, path.basename(src));
  try { fs.renameSync(src, target); }
  catch (e) {
    if (e.code !== 'EXDEV') throw e;            // different volume → copy + delete
    fs.copyFileSync(src, target); fs.unlinkSync(src);
  }
  return target;
}

/** Move a folder-sourced original out of the input folder once processing has finished. */
export function finalizeFolderOriginal(row, success) {
  if (!row || row.source !== 'folder' || !row.original_path || row.original_moved) return null;
  const { processed, failed } = resolveFolders(settingsRepo.get());
  const destDir = success ? processed : failed;
  try {
    if (!fs.existsSync(row.original_path)) { queueRepo.update(row.id, { original_moved: 1 }); return null; }
    if (!destDir) return null;
    const target = moveFile(row.original_path, destDir);
    queueRepo.update(row.id, { original_moved: 1 });
    apipLog('INFO', `Moved ${path.basename(row.original_path)} → ${success ? 'processed' : 'failed'} folder (${target})`);
    return target;
  } catch (e) {
    apipLog('WARN', `Could not move ${row.original_path}: ${e.message}`);
    return null;
  }
}

/** One pass over the input folder. Returns number of files queued. */
export async function scanFolderOnce() {
  if (_state.folderBusy) return 0;
  _state.folderBusy = true;
  let queued = 0;
  try {
    const settings = settingsRepo.get();
    const { input } = resolveFolders(settings);
    _state.lastFolderScan = new Date().toISOString();
    if (!input) { _state.lastFolderError = 'No input folder configured'; return 0; }
    if (!fs.existsSync(input)) { _state.lastFolderError = `Input folder not found: ${input}`; apipLog('WARN', _state.lastFolderError); return 0; }
    const entries = await fs.promises.readdir(input, { withFileTypes: true });
    for (const ent of entries) {
      if (!ent.isFile() || !/\.pdf$/i.test(ent.name)) continue;
      const full = path.join(input, ent.name);
      try {
        if (queueRepo.hasPendingOriginal(full)) continue;
        const st = await fs.promises.stat(full);
        if (Date.now() - st.mtimeMs < 3000) continue;          // still being written — pick up next scan
        const buffer = await fs.promises.readFile(full);
        if (!buffer.length) continue;
        const row = queueRepo.create({ buffer, fileName: ent.name, source: 'folder', sourceRef: input, originalPath: full,
          companyId: _getCompanyId(), approvalStatus: settings.approvalRequired ? 'DRAFT' : 'NOT_REQUIRED' });
        queued++;
        apipLog('INFO', `Folder intake: queued ${ent.name} as #${row.id}`);
        notify(row);
      } catch (e) {
        apipLog('ERROR', `Folder intake failed for ${ent.name}: ${e.message}`);
      }
    }
    _state.lastFolderError = '';
  } catch (e) {
    _state.lastFolderError = e.message;
    apipLog('ERROR', `Folder scan failed: ${e.message}`);
  } finally {
    _state.folderBusy = false;
  }
  return queued;
}

export function startFolderWatcher() {
  stopFolderWatcher();
  const s = settingsRepo.get();
  const { input } = resolveFolders(s);
  if (!input) { apipLog('WARN', 'Folder watcher not started: no input folder configured'); return false; }
  _state.folderRunning = true;
  const ms = Math.max(5, Number(s.folderPollSec) || 30) * 1000;
  _state.folderTimer = setInterval(() => { scanFolderOnce().catch(() => {}); }, ms);
  if (_state.folderTimer.unref) _state.folderTimer.unref();
  apipLog('INFO', `Folder watcher started on ${input} (every ${ms / 1000}s)`);
  scanFolderOnce().catch(() => {});
  return true;
}

export function stopFolderWatcher() {
  if (_state.folderTimer) { clearInterval(_state.folderTimer); _state.folderTimer = null; apipLog('INFO', 'Folder watcher stopped'); }
  _state.folderRunning = false;
}

// ── Mail ──────────────────────────────────────────────────────────────────────
function imapFor(cfg) {
  return new Imap({
    user: cfg.user, password: cfg.password, host: cfg.imapHost, port: Number(cfg.imapPort) || 993, tls: !!cfg.imapTls,
    tlsOptions: { rejectUnauthorized: false }, authTimeout: 15000, connTimeout: 20000,
  });
}

function subjectMatches(filter, subject) {
  if (!filter || !String(filter).trim()) return true;
  try { return new RegExp(filter, 'i').test(subject || ''); }
  catch { return String(subject || '').toLowerCase().includes(String(filter).toLowerCase()); }
}

const isPdf = a => a && (a.contentType === 'application/pdf' || (a.filename && /\.pdf$/i.test(a.filename)));

/** Test IMAP login + folder open. cfg uses the public shape + password. */
export function testMailbox(cfg) {
  return new Promise(resolve => {
    if (!cfg?.imapHost || !cfg?.user || !cfg?.password) return resolve({ ok: false, message: 'Host, user and password are required.' });
    let done = false;
    const finish = r => { if (!done) { done = true; resolve(r); } };
    const imap = imapFor(cfg);
    imap.once('ready', () => {
      imap.openBox(cfg.folder || 'INBOX', true, (err, box) => {
        try { imap.end(); } catch { /* ignore */ }
        if (err) return finish({ ok: false, message: `Connected, but could not open folder "${cfg.folder || 'INBOX'}": ${err.message}` });
        finish({ ok: true, message: `Connected to ${cfg.imapHost}. Folder "${cfg.folder || 'INBOX'}" has ${box?.messages?.total ?? 0} message(s).` });
      });
    });
    imap.once('error', e => finish({ ok: false, message: e.message }));
    try { imap.connect(); } catch (e) { finish({ ok: false, message: e.message }); }
  });
}

/** Poll one mailbox once. Returns number of PDFs queued. */
export function pollMailbox(cfg) {
  return new Promise(resolve => {
    if (!cfg?.id) return resolve(0);
    if (_state.mailBusy.has(cfg.id)) return resolve(0);
    if (!cfg.imapHost || !cfg.user || !cfg.password) {
      mailRepo.setStatus(cfg.id, { lastError: 'Host, user or password missing' });
      return resolve(0);
    }
    _state.mailBusy.add(cfg.id);
    _state.lastMailScan = new Date().toISOString();
    let queued = 0, finished = false;
    const attempted = _state.attempted.get(cfg.id) || new Set();
    _state.attempted.set(cfg.id, attempted);
    const imap = imapFor(cfg);
    const finish = (err) => {
      if (finished) return;
      finished = true;
      _state.mailBusy.delete(cfg.id);
      mailRepo.setStatus(cfg.id, { lastCheck: new Date().toISOString(), lastError: err ? err.message || String(err) : '' });
      if (err) apipLog('ERROR', `Mailbox "${cfg.name}": ${err.message || err}`);
      else if (queued) apipLog('INFO', `Mailbox "${cfg.name}": queued ${queued} PDF(s)`);
      resolve(queued);
    };
    const safeEnd = () => { try { imap.end(); } catch { /* ignore */ } };

    imap.once('ready', () => {
      imap.openBox(cfg.folder || 'INBOX', false, (err) => {
        if (err) { safeEnd(); return finish(err); }
        const since = new Date(Date.now() - 30 * 86400000);
        imap.search(['UNSEEN', ['SINCE', since]], (err2, uids) => {
          if (err2) { safeEnd(); return finish(err2); }
          uids = (uids || []).sort((a, b) => a - b);
          // forget UIDs that are no longer unseen
          for (const u of [...attempted]) if (!uids.includes(u)) attempted.delete(u);
          const fresh = uids.filter(u => !attempted.has(u)).slice(-50);
          if (!fresh.length) { safeEnd(); return finish(null); }

          const parsing = [];
          const f = imap.fetch(fresh, { bodies: '', markSeen: false });
          f.on('message', (msg) => {
            const chunks = []; let uid = null;
            msg.on('body', stream => stream.on('data', c => chunks.push(c)));
            msg.once('attributes', a => { uid = a.uid; });
            msg.once('end', () => parsing.push((async () => {
              try {
                const parsed = await simpleParser(Buffer.concat(chunks));
                return { uid, parsed };
              } catch (e) { apipLog('WARN', `Mailbox "${cfg.name}": parse error uid=${uid}: ${e.message}`); return { uid, parsed: null }; }
            })()));
          });
          f.once('error', e => { safeEnd(); finish(e); });
          f.once('end', async () => {
            const results = await Promise.all(parsing);
            const toMark = [];
            const settings = settingsRepo.get();
            for (const { uid, parsed } of results) {
              if (uid != null) attempted.add(uid);
              if (!parsed) continue;
              const subject = parsed.subject || '';
              const pdfs = (parsed.attachments || []).filter(isPdf);
              if (!pdfs.length || !subjectMatches(cfg.subjectFilter, subject)) continue;
              const from = parsed.from?.text || '';
              let ok = 0;
              for (const a of pdfs) {
                try {
                  const row = queueRepo.create({
                    buffer: a.content, fileName: a.filename || `mail-${uid}.pdf`, source: 'mail',
                    sourceRef: `${cfg.name} / ${from} / ${subject}`.slice(0, 500), companyId: _getCompanyId(),
                    approvalStatus: settings.approvalRequired ? 'DRAFT' : 'NOT_REQUIRED',
                  });
                  ok++; queued++;
                  apipLog('INFO', `Mail intake (${cfg.name}): queued ${row.file_name} as #${row.id} from ${from}`);
                  notify(row);
                } catch (e) { apipLog('ERROR', `Mail intake (${cfg.name}): could not queue ${a.filename}: ${e.message}`); }
              }
              if (ok && uid != null) toMark.push(uid);
            }
            if (!toMark.length) { safeEnd(); return finish(null); }
            imap.addFlags(toMark, '\\Seen', (err3) => {
              if (err3) apipLog('WARN', `Mailbox "${cfg.name}": could not mark ${toMark.length} mail(s) as seen: ${err3.message}`);
              safeEnd(); finish(null);
            });
          });
        });
      });
    });
    imap.once('error', e => finish(e));
    imap.once('end', () => { if (!finished) finish(null); });
    try { imap.connect(); } catch (e) { finish(e); }
  });
}

export function startMailPollers() {
  stopMailPollers(true);
  const boxes = mailRepo.listEnabledWithSecret();
  if (!boxes.length) { apipLog('WARN', 'Mail intake not started: no enabled mailbox'); _state.mailRunning = false; return false; }
  for (const cfg of boxes) {
    const ms = Math.max(30, Number(cfg.pollSec) || 120) * 1000;
    const id = cfg.id;
    const tick = () => { const fresh = mailRepo.getWithSecret(id); if (fresh?.enabled) pollMailbox(fresh).catch(() => {}); };
    const t = setInterval(tick, ms);
    if (t.unref) t.unref();
    _state.mailTimers.set(id, t);
    apipLog('INFO', `Mail poller started for "${cfg.name}" (${cfg.user}@${cfg.imapHost}, every ${ms / 1000}s)`);
    tick();
  }
  _state.mailRunning = true;
  return true;
}

export function stopMailPollers(silent = false) {
  for (const t of _state.mailTimers.values()) clearInterval(t);
  if (_state.mailTimers.size && !silent) apipLog('INFO', 'Mail pollers stopped');
  _state.mailTimers.clear();
  _state.mailRunning = false;
}

/** Poll every enabled mailbox once (regardless of running state). */
export async function scanMailOnce() {
  let n = 0;
  for (const cfg of mailRepo.listEnabledWithSecret()) n += await pollMailbox(cfg);
  return n;
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────
/** (Re)start channels according to saved settings. */
export function applyIntakeSettings() {
  const s = settingsRepo.get();
  if (s.folderWatchEnabled && s.inputFolder) startFolderWatcher(); else stopFolderWatcher();
  if (s.mailEnabled) startMailPollers(); else stopMailPollers();
  return getIntakeStatus();
}

/** Manual start: starts whatever channels are configured (folder if an input folder is set, mail if enabled mailboxes exist). */
export function startIntake() {
  const s = settingsRepo.get();
  if (s.inputFolder) startFolderWatcher();
  if (mailRepo.listEnabledWithSecret().length) startMailPollers();
  return getIntakeStatus();
}

export function stopIntake() {
  stopFolderWatcher();
  stopMailPollers();
  return getIntakeStatus();
}

export async function scanNow() {
  const folder = settingsRepo.get().inputFolder ? await scanFolderOnce() : 0;
  const mail = await scanMailOnce();
  return { folder, mail };
}
