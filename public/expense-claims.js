/**
 * Employee Expense Claims — frontend module (Finance → Employee Expenses).
 *   Views: mine | approvals | all | master | settings  (+ claim form)
 *   API:   /api/expense (controllers/expense-claim-agent.mjs), header x-auth-token = localStorage.hanny_token
 * Exposes window.showExpensePanel(view).
 */
(function () {
  'use strict';

  const BASE = '/api/expense';
  const VIEWS = [
    ['mine', 'My Expense Claims', 'expense.claims'], ['approvals', 'Expense Approval', 'expense.approvals'],
    ['all', 'All Claims', 'expense.all'], ['master', 'Approval Master', 'expense.master'], ['settings', 'Settings', 'expense.settings'],
  ];

  // ── Helpers ────────────────────────────────────────────────────────────────
  const tok = () => localStorage.getItem('hanny_token') || '';
  const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const enc = encodeURIComponent;
  const num = v => { const n = Number(String(v ?? '').replace(/,/g, '')); return Number.isFinite(n) ? n : 0; };
  const fmt = n => Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtD = v => { if (!v) return ''; const d = new Date(String(v).length === 10 ? v + 'T00:00:00' : v); return isNaN(d) ? String(v) : d.toLocaleDateString(); };
  const today = () => new Date().toISOString().slice(0, 10);
  const fileUrl = rid => `${BASE}/receipts/${enc(rid)}/file?token=${enc(tok())}`;

  async function api(method, path, body) {
    const opts = { method, headers: { 'x-auth-token': tok() } };
    if (body instanceof FormData) opts.body = body;
    else if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    let r;
    try { r = await fetch(BASE + path, opts); } catch { throw new Error('Network error — server unreachable'); }
    let data = {};
    try { data = await r.json(); } catch { /* not JSON */ }
    if (!r.ok || data.ok === false) throw Object.assign(new Error(data.error || `Server error (${r.status})`), { status: r.status, data });
    return data;
  }

  function toast(msg, kind = 'ok', ms = 3500) {
    let host = document.getElementById('exp-toasts');
    if (!host) { host = document.createElement('div'); host.id = 'exp-toasts'; document.body.appendChild(host); }
    const t = document.createElement('div');
    t.className = `exp-toast ${kind}`;
    t.textContent = msg;
    host.appendChild(t);
    setTimeout(() => t.remove(), ms);
  }
  function modal(title, html, buttons) {
    const bg = document.createElement('div');
    bg.className = 'exp-modal-bg';
    bg.innerHTML = `<div class="exp-modal"><h3>${esc(title)}</h3><div class="exp-modal-b">${html}</div><div class="exp-modal-f"></div></div>`;
    const close = () => bg.remove();
    const f = bg.querySelector('.exp-modal-f');
    buttons.forEach(b => {
      const el = document.createElement('button');
      el.className = `exp-btn ${b.cls || ''}`;
      el.textContent = b.label;
      el.onclick = async () => { if (b.onClick) { if (await b.onClick(bg, close) === false) return; } close(); };
      f.appendChild(el);
    });
    document.body.appendChild(bg);
    bg.querySelector('input,textarea,select')?.focus();
    return { bg, close };
  }
  const confirmDlg = (title, html, okLabel = 'OK', cls = 'pri') => new Promise(res => modal(title, html, [
    { label: 'Cancel', onClick: () => res(false) }, { label: okLabel, cls, onClick: () => res(true) }]));

  const STATUS = { draft: ['Draft', ''], submitted: ['Submitted', 'amber'], approved: ['Approved', 'ok'], rejected: ['Rejected', 'bad'], posted: ['Posted', 'indigo'] };
  const APPR = { DRAFT: ['—', ''], PENDING: ['Pending', 'amber'], PARTIAL: ['Partially approved', 'blue'], APPROVED: ['Approved', 'ok'], REJECTED: ['Rejected', 'bad'], NOT_REQUIRED: ['Not required', ''] };
  const pill = ([t, c]) => `<span class="exp-pill ${c}">${esc(t)}</span>`;
  const loading = (t = 'Loading…') => `<div class="exp-load"><div class="exp-spin"></div>${esc(t)}</div>`;
  const errBox = m => `<div class="exp-msg err">${esc(m)}</div>`;

  // ── Styles ─────────────────────────────────────────────────────────────────
  function injectStyles() {
    if (document.getElementById('exp-styles')) return;
    const st = document.createElement('style');
    st.id = 'exp-styles';
    st.textContent = `
.exp,.exp-modal-bg,#exp-toasts{--x-p:#0b6bcb;--x-line:#e3e8ef;--x-mut:#64748b;--x-card:#fff;--x-bg:#f4f6fa}
.exp{flex:1;display:flex;flex-direction:column;height:100%;min-height:0;background:var(--x-bg);font-family:inherit;color:#1e293b}
.exp-top{display:flex;align-items:center;gap:14px;padding:0 16px;background:linear-gradient(135deg,#354a5e,#1a2d40);color:#fff;min-height:46px;flex-shrink:0;flex-wrap:wrap}
.exp-top b{font-size:14px;display:flex;align-items:center;gap:8px}
.exp-nav{display:flex;gap:2px;flex-wrap:wrap}
.exp-nav button{background:none;border:0;color:rgba(255,255,255,.75);padding:13px 12px;font:inherit;font-size:12.5px;cursor:pointer;border-bottom:3px solid transparent}
.exp-nav button.on{color:#fff;border-bottom-color:#5ec2ff;font-weight:600}
.exp-nav button .cnt{background:#ef4444;color:#fff;border-radius:9px;padding:0 6px;font-size:10.5px;margin-left:4px}
.exp-body{flex:1;overflow:auto;padding:16px;min-height:0}
.exp-ph{display:flex;justify-content:space-between;align-items:flex-end;gap:12px;margin-bottom:12px;flex-wrap:wrap}
.exp-ph h2{margin:0;font-size:18px}.exp-ph p{margin:3px 0 0;color:var(--x-mut);font-size:12.5px}
.exp-card{background:var(--x-card);border:1px solid var(--x-line);border-radius:10px;padding:14px;margin-bottom:12px}
.exp-card h4{margin:0 0 10px;font-size:13.5px}
.exp-btn{border:1px solid var(--x-line);background:#fff;color:#1e293b;border-radius:7px;padding:7px 13px;font:inherit;font-size:12.5px;font-weight:600;cursor:pointer;display:inline-flex;align-items:center;gap:6px}
.exp-btn:hover{border-color:#94a3b8}.exp-btn:disabled{opacity:.5;cursor:not-allowed}
.exp-btn.pri{background:var(--x-p);border-color:var(--x-p);color:#fff}.exp-btn.ok{background:#15803d;border-color:#15803d;color:#fff}
.exp-btn.bad{background:#fff;border-color:#fecaca;color:#b91c1c}.exp-btn.sm{padding:4px 9px;font-size:11.5px}
.exp-in,.exp-sel,textarea.exp-in{border:1px solid #cbd5e1;border-radius:6px;padding:6px 8px;font:inherit;font-size:12.5px;background:#fff;color:inherit;width:100%;box-sizing:border-box}
.exp-in.bad,.exp-sel.bad{border-color:#ef4444;background:#fef2f2}
.exp-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px}
.exp-f label{display:block;font-size:11px;font-weight:600;color:var(--x-mut);margin-bottom:3px;text-transform:uppercase;letter-spacing:.03em}
.exp-tbl{width:100%;border-collapse:collapse;font-size:12.5px}
.exp-tbl th{text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.03em;color:var(--x-mut);padding:7px 8px;border-bottom:1px solid var(--x-line);background:#f8fafc;white-space:nowrap}
.exp-tbl td{padding:7px 8px;border-bottom:1px solid #f1f5f9;vertical-align:middle}
.exp-tbl tr.click{cursor:pointer}.exp-tbl tr.click:hover td{background:#f8fbff}
.exp-tbl tr.rowbad td{background:#fff7f7}.exp-tbl .r{text-align:right}
.exp-tbl input,.exp-tbl select{min-width:70px}
.exp-pill{display:inline-block;padding:2px 9px;border-radius:10px;font-size:11px;font-weight:600;background:#eef2f7;color:#475569;white-space:nowrap}
.exp-pill.ok{background:#dcfce7;color:#166534}.exp-pill.bad{background:#fee2e2;color:#991b1b}.exp-pill.amber{background:#fef3c7;color:#92400e}
.exp-pill.blue{background:#dbeafe;color:#1e40af}.exp-pill.indigo{background:#e0e7ff;color:#3730a3}
.exp-msg{padding:9px 12px;border-radius:8px;font-size:12.5px;margin-bottom:10px}
.exp-msg.err{background:#fef2f2;border:1px solid #fecaca;color:#991b1b}.exp-msg.warn{background:#fffbeb;border:1px solid #fde68a;color:#92400e}
.exp-msg.ok{background:#f0fdf4;border:1px solid #bbf7d0;color:#166534}.exp-msg.info{background:#eff6ff;border:1px solid #bfdbfe;color:#1e40af}
.exp-msg ul{margin:4px 0 0;padding-left:18px}
.exp-load{padding:40px;text-align:center;color:var(--x-mut)}
.exp-spin{width:28px;height:28px;border:3px solid #e5e7eb;border-top-color:var(--x-p);border-radius:50%;margin:0 auto 10px;animation:expspin .8s linear infinite}
@keyframes expspin{to{transform:rotate(360deg)}}
.exp-drop{border:2px dashed #93c5fd;border-radius:10px;padding:22px;text-align:center;background:#f8fbff;cursor:pointer;color:#1e40af;font-size:13px}
.exp-drop.over{background:#e0efff;border-color:var(--x-p)}.exp-drop small{display:block;color:var(--x-mut);margin-top:4px}
.exp-split{display:grid;grid-template-columns:minmax(0,1fr) 380px;gap:12px;align-items:start}
@media (max-width:1100px){.exp-split{grid-template-columns:1fr}}
.exp-prev{position:sticky;top:0;height:calc(100vh - 150px);min-height:360px;background:#fff;border:1px solid var(--x-line);border-radius:10px;display:flex;flex-direction:column;overflow:hidden}
.exp-prev .h{padding:8px 12px;border-bottom:1px solid var(--x-line);font-size:12px;font-weight:600;display:flex;justify-content:space-between;gap:8px}
.exp-prev iframe,.exp-prev img{flex:1;width:100%;border:0;object-fit:contain;background:#f1f5f9;min-height:0}
.exp-prev .empty{flex:1;display:grid;place-items:center;color:var(--x-mut);font-size:12.5px;padding:20px;text-align:center}
.exp-tot{display:flex;justify-content:flex-end;gap:24px;padding:10px 8px 0;font-size:13px}.exp-tot b{font-size:16px}
.exp-foot{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:12px}.exp-foot .sp{flex:1}
.exp-steps{display:flex;gap:6px;flex-wrap:wrap}
.exp-stage{border:1px solid var(--x-line);border-radius:8px;padding:8px 10px;font-size:12px;min-width:170px;flex:1}
.exp-stage b{display:block;margin-bottom:3px}.exp-stage .a{color:var(--x-mut);font-size:11.5px;margin-top:4px}
.exp-ocr{font-size:11px;color:var(--x-mut)}.exp-ocr.failed{color:#b91c1c}
.exp-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:12px}
.exp-kpi{background:#fff;border:1px solid var(--x-line);border-top:3px solid var(--k,var(--x-p));border-radius:8px;padding:10px 12px}
.exp-kpi small{display:block;color:var(--x-mut);font-size:11px}.exp-kpi strong{font-size:18px}
.exp-modal-bg{position:fixed;inset:0;background:rgba(15,23,42,.45);display:grid;place-items:center;z-index:9999}
.exp-modal{background:#fff;border-radius:12px;width:min(560px,94vw);max-height:90vh;display:flex;flex-direction:column;box-shadow:0 20px 50px rgba(0,0,0,.3)}
.exp-modal h3{margin:0;padding:14px 16px;border-bottom:1px solid var(--x-line,#e3e8ef);font-size:15px}
.exp-modal-b{padding:14px 16px;overflow:auto;font-size:13px}.exp-modal-f{display:flex;justify-content:flex-end;gap:8px;padding:12px 16px;border-top:1px solid #e3e8ef}
#exp-toasts{position:fixed;right:18px;bottom:18px;z-index:10000;display:flex;flex-direction:column;gap:8px}
.exp-toast{padding:10px 14px;border-radius:8px;color:#fff;font-size:13px;box-shadow:0 6px 18px rgba(0,0,0,.2);max-width:420px;background:#15803d}
.exp-toast.err{background:#b91c1c}.exp-toast.warn{background:#b45309}
.exp-busy{position:absolute;inset:0;background:rgba(255,255,255,.8);display:grid;place-items:center;z-index:30;border-radius:10px}
.exp-chips{display:flex;flex-wrap:wrap;gap:5px;align-items:center;border:1px solid #cbd5e1;border-radius:6px;padding:4px;background:#fff;min-height:32px}
.exp-chip{background:#e0f2fe;color:#075985;border-radius:12px;padding:2px 8px;font-size:11.5px;display:inline-flex;gap:4px;align-items:center}
.exp-chip.role{background:#ede9fe;color:#5b21b6}.exp-chip.manager{background:#dcfce7;color:#166534}
.exp-chip button{background:none;border:0;cursor:pointer;color:inherit;font-size:13px;padding:0}
.exp-rule{display:grid;grid-template-columns:1.2fr 1fr 1.4fr auto;gap:6px;margin-bottom:6px}
.exp-stage-ed{border:1px solid var(--x-line);border-radius:8px;padding:10px;margin-bottom:10px;background:#fafcff}
.exp-gl{position:relative}.exp-dd{position:absolute;z-index:50;left:0;right:0;top:100%;background:#fff;border:1px solid #cbd5e1;border-radius:6px;max-height:220px;overflow:auto;box-shadow:0 8px 20px rgba(0,0,0,.12)}
.exp-dd div{padding:6px 9px;font-size:12px;cursor:pointer}.exp-dd div:hover{background:#eff6ff}
.mut{color:var(--x-mut)}`;
    document.head.appendChild(st);
  }

  // ── Panel shell ────────────────────────────────────────────────────────────
  const S = { view: null, me: null, seq: 0 };
  let panel = null, navEl = null, bodyEl = null;

  function ensurePanel() {
    injectStyles();
    const main = document.querySelector('.main') || document.body;
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'expense-panel';
      panel.className = 'exp';
      panel.innerHTML = `<div class="exp-top"><b>🧾 Employee Expenses</b><div class="exp-nav"></div></div><div class="exp-body"></div>`;
      navEl = panel.querySelector('.exp-nav');
      bodyEl = panel.querySelector('.exp-body');
      navEl.addEventListener('click', e => { const b = e.target.closest('[data-v]'); if (b) window.showExpensePanel(b.dataset.v); });
      // Hide when any other sidebar item is opened (other panels don't all know this one)
      document.addEventListener('click', e => {
        const n = e.target.closest('.nav-item,.nav-subitem');
        if (n && panel.style.display !== 'none' && !/^nav-exp-/.test(n.id || '')) panel.style.display = 'none';
      }, true);
    }
    if (panel.parentElement !== main) main.appendChild(panel);
  }
  function renderNav() {
    const perms = new Set(S.me?.perms || []);
    const active = S.view === 'claim' ? S.back : S.view;
    navEl.innerHTML = VIEWS.filter(([, , p]) => perms.has(p)).map(([v, l]) =>
      `<button data-v="${v}" class="${v === active ? 'on' : ''}">${esc(l)}${v === 'approvals' && S.me?.inbox ? `<span class="cnt">${S.me.inbox}</span>` : ''}</button>`).join('');
  }
  function start(view) {
    S.view = view; S.seq++;
    const nb = bodyEl.cloneNode(false);           // fresh element per view drops old listeners
    bodyEl.replaceWith(nb); bodyEl = nb;
    renderNav();
    document.querySelectorAll('.nav-item,.nav-subitem').forEach(n => n.classList.remove('active'));
    document.getElementById('nav-exp-' + (view === 'claim' ? S.back : view))?.classList.add('active');
    return S.seq;
  }
  function wrapShowChat() {
    const orig = window.showChatPanel;
    if (typeof orig !== 'function' || orig.__exp) return;
    const w = function () { if (panel) panel.style.display = 'none'; return orig.apply(this, arguments); };
    w.__exp = true;
    window.showChatPanel = w;
  }

  window.showExpensePanel = async function (view, opts = {}) {
    wrapShowChat();
    const main = document.querySelector('.main');
    if (main) [...main.children].forEach(c => { if (c.id && c.id !== 'expense-panel' && /-panel$/.test(c.id)) c.style.display = 'none'; });
    document.getElementById('messages')?.style.setProperty('display', 'none');
    const bb = document.querySelector('.bottom-bar'); if (bb) bb.style.display = 'none';
    const ia = document.querySelector('.input-area'); if (ia) ia.style.display = 'none';
    ensurePanel();
    panel.style.display = 'flex';
    try { S.me = (await api('GET', '/me')); } catch (e) { bodyEl.innerHTML = errBox(e.message); return; }
    const allowed = VIEWS.filter(([, , p]) => S.me.perms.includes(p)).map(([v]) => v);
    if (view === 'claim') return openClaim(opts.id, opts.back || 'mine');
    if (!allowed.includes(view)) view = allowed[0];
    if (!view) { start('none'); bodyEl.innerHTML = errBox('You do not have access to Employee Expenses. Ask an administrator to grant it under Admin → Roles & Permissions → Finance.'); return; }
    ({ mine: vMine, approvals: vApprovals, all: vAll, master: vMaster, settings: vSettings })[view]();
  };

  // ── My claims ──────────────────────────────────────────────────────────────
  function claimTable(rows, { showEmp = false } = {}) {
    if (!rows.length) return `<div class="exp-load">No claims yet.</div>`;
    return `<table class="exp-tbl"><thead><tr><th>#</th><th>Title</th>${showEmp ? '<th>Employee</th><th>Department</th>' : ''}<th class="r">Bills</th><th class="r">Total</th>
      <th>Status</th><th>Approval</th><th>Submitted</th><th>SAP JE</th></tr></thead><tbody>
      ${rows.map(r => `<tr class="click" data-id="${r.id}"><td>#${r.id}</td><td>${esc(r.title || '(untitled)')}${r.error ? ` <span title="${esc(r.error)}">⚠️</span>` : ''}</td>
        ${showEmp ? `<td>${esc(r.empName || r.userName)}</td><td>${esc(r.department || '')}</td>` : ''}
        <td class="r">${r.bills}</td><td class="r"><b>${fmt(r.total)}</b> ${esc(r.currency || '')}</td>
        <td>${pill(STATUS[r.status] || [r.status, ''])}</td><td>${pill(APPR[r.approvalStatus] || [r.approvalStatus, ''])}</td>
        <td>${esc(fmtD(r.submittedAt))}</td><td>${r.sapNumber ? `<b>${r.sapNumber}</b>` : ''}</td></tr>`).join('')}</tbody></table>`;
  }
  async function vMine() {
    const seq = start('mine');
    const emp = S.me.employee;
    bodyEl.innerHTML = `<div class="exp-ph"><div><h2>My Expense Claims</h2><p>Upload your bills, check the amounts and submit for approval. Finance posts the approved claim to SAP as a journal entry.</p></div>
      <div><button class="exp-btn pri" id="exp-new">＋ New Expense Claim</button></div></div>
      ${emp ? `<div class="exp-msg info">Claiming as <b>${esc(emp.empName)}</b> (SAP employee ${emp.empId})${emp.department ? ` · ${esc(emp.department)}` : ''}${emp.managerName ? ` · Manager: ${esc(emp.managerName)}` : ''}</div>`
        : `<div class="exp-msg warn">Your login is not linked to an SAP employee yet, so claims cannot be submitted. Ask an administrator to link it under <b>Employee Expenses → Settings</b>.</div>`}
      <div class="exp-card" id="exp-list">${loading()}</div>`;
    bodyEl.querySelector('#exp-new').onclick = newClaim;
    try {
      const d = await api('GET', '/claims?scope=mine');
      if (seq !== S.seq) return;
      const host = bodyEl.querySelector('#exp-list');
      host.innerHTML = claimTable(d.rows);
      host.querySelectorAll('tr[data-id]').forEach(tr => tr.onclick = () => openClaim(+tr.dataset.id, 'mine'));
    } catch (e) { bodyEl.querySelector('#exp-list').innerHTML = errBox(e.message); }
  }
  function newClaim() {
    modal('New Expense Claim', `<div class="exp-f"><label>Title</label><input class="exp-in" id="nc-t" placeholder="e.g. Client visit — Chicago, Nov 2026" maxlength="100"></div>
      <div class="exp-f" style="margin-top:10px"><label>Business purpose (optional)</label><textarea class="exp-in" id="nc-p" rows="2" maxlength="500"></textarea></div>`, [
      { label: 'Cancel' },
      { label: 'Create & Add Bills', cls: 'pri', onClick: async bg => {
        const title = bg.querySelector('#nc-t').value.trim();
        if (!title) { bg.querySelector('#nc-t').classList.add('bad'); return false; }
        try { const d = await api('POST', '/claims', { title, purpose: bg.querySelector('#nc-p').value }); openClaim(d.claim.id, 'mine'); }
        catch (e) { toast(e.message, 'err'); return false; }
      } }]);
  }

  // ── Claim form ─────────────────────────────────────────────────────────────
  async function openClaim(id, back) {
    S.back = back;
    const seq = start('claim');
    bodyEl.innerHTML = loading('Loading claim…');
    try { const d = await api('GET', `/claims/${enc(id)}`); if (seq === S.seq) renderClaim(d.claim); }
    catch (e) { bodyEl.innerHTML = errBox(e.message); }
  }

  function renderClaim(c, { issues = [], previewRid = null } = {}) {
    S.claim = c;
    const ed = c.canEdit;
    const cats = S.me.categories || [];
    const lineIssues = i => issues.filter(x => x.line === i);
    const glEditable = ed && S.me.perms.includes('expense.all');
    const pr = previewRid ?? c.receipts[0]?.id ?? null;
    bodyEl.innerHTML = `
      <div class="exp-ph"><div><h2>#${c.id} · ${esc(c.title || 'Expense claim')}</h2>
        <p>${esc(c.empName || c.userName)}${c.department ? ' · ' + esc(c.department) : ''} · created ${esc(fmtD(c.createdAt))}</p></div>
        <div style="display:flex;gap:6px;align-items:center">${pill(STATUS[c.status] || [c.status, ''])} ${!['DRAFT', 'NOT_REQUIRED'].includes(c.approvalStatus) && (APPR[c.approvalStatus]?.[0] !== STATUS[c.status]?.[0]) ? pill(APPR[c.approvalStatus] || [c.approvalStatus, '']) : ''}
        <button class="exp-btn sm" id="exp-back">← Back</button></div></div>
      ${c.status === 'posted' ? `<div class="exp-msg ok"><b>✓ Posted to SAP.</b> Journal Entry <b>${c.sapNumber ?? '—'}</b> (TransId ${c.sapTransId ?? '—'}) dated ${esc(fmtD(c.postingDate))}, posted by ${esc(c.postedBy)}.</div>` : ''}
      ${c.status === 'rejected' ? `<div class="exp-msg err"><b>Rejected.</b> See the approver's comment below, correct the claim and submit again.</div>` : ''}
      ${c.error ? `<div class="exp-msg err">${esc(c.error)}</div>` : ''}
      <div id="exp-issues">${issuesHtml(issues)}</div>
      <div class="exp-split"><div>
        <div class="exp-card"><div class="exp-grid">
          <div class="exp-f"><label>Title</label><input class="exp-in" id="c-title" value="${esc(c.title)}" ${ed ? '' : 'disabled'} maxlength="100"></div>
          <div class="exp-f"><label>Business purpose</label><input class="exp-in" id="c-purpose" value="${esc(c.purpose)}" ${ed ? '' : 'disabled'} maxlength="500"></div>
          <div class="exp-f"><label>Employee (SAP)</label><input class="exp-in" value="${esc(c.empName ? `${c.empName} (${c.empId})` : 'Not linked')}" disabled></div>
          <div class="exp-f"><label>Currency</label><input class="exp-in" id="c-ccy" value="${esc(c.currency)}" ${ed ? '' : 'disabled'} maxlength="3" placeholder="e.g. USD"></div>
        </div></div>
        ${ed ? `<div class="exp-card"><div class="exp-drop" id="exp-drop">📎 <b>Drop bills here</b> or click to choose — PDF or photo (JPG, PNG)<small>Each bill is read automatically: date, merchant, amount and category. Up to 20 files, 20 MB each.</small>
          <input type="file" id="exp-file" multiple accept=".pdf,.jpg,.jpeg,.png,.webp,application/pdf,image/*" hidden></div></div>` : ''}
        <div class="exp-card" style="position:relative" id="exp-lines-card"><h4>Bills (${c.lines.length})</h4>
          ${c.lines.length ? `<div style="overflow-x:auto"><table class="exp-tbl" id="exp-lines"><thead><tr><th></th><th>Date</th><th>Merchant</th><th>Bill no.</th><th>Category</th><th>Description</th>
            <th class="r">Tax</th><th class="r">Amount</th><th>Expense G/L</th>${ed ? '<th></th>' : ''}</tr></thead><tbody>
            ${c.lines.map((l, i) => {
              const rec = c.receipts.find(r => r.id === l.receiptId);
              const bad = lineIssues(i).some(x => x.severity === 'error');
              return `<tr data-i="${i}" class="${bad ? 'rowbad' : ''}" title="${esc(lineIssues(i).map(x => x.message).join('\n'))}">
                <td>${rec ? `<button class="exp-btn sm" data-prev="${rec.id}" title="Show bill">📄</button>${rec.ocrStatus === 'failed' ? `<div class="exp-ocr failed" title="${esc(rec.error)}">not read</div>` : ''}` : ''}</td>
                <td><input class="exp-in" type="date" data-l="date" value="${esc(l.date)}" max="${today()}" ${ed ? '' : 'disabled'}></td>
                <td><input class="exp-in" data-l="merchant" value="${esc(l.merchant)}" ${ed ? '' : 'disabled'}></td>
                <td><input class="exp-in" data-l="billNo" value="${esc(l.billNo)}" ${ed ? '' : 'disabled'} style="width:90px"></td>
                <td><select class="exp-sel" data-l="category" ${ed ? '' : 'disabled'}><option value="">— choose —</option>${cats.map(k => `<option ${k === l.category ? 'selected' : ''}>${esc(k)}</option>`).join('')}</select></td>
                <td><input class="exp-in" data-l="description" value="${esc(l.description)}" ${ed ? '' : 'disabled'}></td>
                <td class="r"><input class="exp-in" data-l="tax" value="${l.tax ? fmt(l.tax) : ''}" ${ed ? '' : 'disabled'} style="width:80px;text-align:right"></td>
                <td class="r"><input class="exp-in" data-l="amount" value="${fmt(l.amount)}" ${ed ? '' : 'disabled'} style="width:95px;text-align:right;font-weight:600"></td>
                <td>${glEditable ? `<div class="exp-gl"><input class="exp-in" data-l="account" value="${esc(l.account)}" placeholder="${esc(l.resolvedAccount || 'from category')}" style="width:120px"></div>` : `<span class="mut">${esc(l.resolvedAccount || '—')}</span>`}</td>
                ${ed ? `<td><button class="exp-btn sm bad" data-rm="${i}" title="Remove bill">✕</button></td>` : ''}</tr>`;
            }).join('')}</tbody></table></div>
            <div class="exp-tot"><span class="mut">${c.lines.length} bill(s)</span><span>Claim total: <b id="exp-total">${fmt(c.total)}</b> ${esc(c.currency || '')}</span></div>`
          : `<div class="exp-load">No bills yet${ed ? ' — drop PDFs or photos above' : ''}.</div>`}
        </div>
        ${c.approvalView ? approvalHtml(c.approvalView) : ''}
        <div class="exp-foot">
          ${c.canDelete ? `<button class="exp-btn bad" id="a-del">Delete claim</button>` : ''}<span class="sp"></span>
          ${ed ? `<button class="exp-btn" id="a-save">Save</button>` : ''}
          ${c.canSubmit ? `<button class="exp-btn pri" id="a-submit">${c.status === 'rejected' ? 'Resubmit for approval' : 'Submit for approval'}</button>` : ''}
          ${c.canApprove ? `<button class="exp-btn bad" id="a-reject">Reject</button><button class="exp-btn ok" id="a-approve">Approve</button>` : ''}
          ${c.canPost ? `<button class="exp-btn ok" id="a-post">Post Journal Entry to SAP</button>` : ''}
        </div>
      </div>
      <div class="exp-prev" id="exp-prev"></div></div>`;
    showPreview(pr);

    bodyEl.querySelector('#exp-back').onclick = () => window.showExpensePanel(S.back || 'mine');
    bodyEl.querySelectorAll('[data-prev]').forEach(b => b.onclick = () => showPreview(+b.dataset.prev));
    if (ed) {
      const drop = bodyEl.querySelector('#exp-drop'), fi = bodyEl.querySelector('#exp-file');
      drop.onclick = () => fi.click();
      fi.onchange = () => fi.files.length && upload([...fi.files]);
      drop.ondragover = e => { e.preventDefault(); drop.classList.add('over'); };
      drop.ondragleave = () => drop.classList.remove('over');
      drop.ondrop = e => { e.preventDefault(); drop.classList.remove('over'); if (e.dataTransfer.files.length) upload([...e.dataTransfer.files]); };
      bodyEl.querySelectorAll('[data-rm]').forEach(b => b.onclick = () => removeLine(+b.dataset.rm));
      bodyEl.querySelectorAll('#exp-lines [data-l="amount"]').forEach(inp => inp.oninput = () => {
        const t = [...bodyEl.querySelectorAll('#exp-lines [data-l="amount"]')].reduce((s, x) => s + num(x.value), 0);
        bodyEl.querySelector('#exp-total').textContent = fmt(t);
      });
      bodyEl.querySelectorAll('#exp-lines [data-l="account"]').forEach(glPicker);
      bodyEl.querySelector('#a-save').onclick = () => save(true);
    }
    bodyEl.querySelector('#a-del')?.addEventListener('click', delClaim);
    bodyEl.querySelector('#a-submit')?.addEventListener('click', submit);
    bodyEl.querySelector('#a-approve')?.addEventListener('click', () => act('approve'));
    bodyEl.querySelector('#a-reject')?.addEventListener('click', () => act('reject'));
    bodyEl.querySelector('#a-post')?.addEventListener('click', post);
  }

  function issuesHtml(issues) {
    if (!issues.length) return '';
    const errs = issues.filter(i => i.severity === 'error');
    return `<div class="exp-msg ${errs.length ? 'err' : 'warn'}"><b>${errs.length ? `${errs.length} problem(s) to fix` : 'Please check'}</b><ul>
      ${issues.map(i => `<li>${i.line != null ? `Bill ${i.line + 1}: ` : ''}${esc(i.message)}</li>`).join('')}</ul></div>`;
  }
  function approvalHtml(a) {
    const who = p => p.type === 'manager' ? 'Reporting manager' : p.name;
    return `<div class="exp-card"><h4>Approval — ${esc(a.templateName)}</h4><div class="exp-steps">
      ${a.stages.map(s => `<div class="exp-stage"><b>${s.no}. ${esc(s.name)}</b>${pill(APPR[s.status] || [s.status === 'WAITING' ? 'Waiting' : s.status, ''])}
        <div class="a">Approvers: ${esc(s.approvers.map(who).join(', '))}${s.approvalsRequired > 1 ? ` · needs ${s.approvalsRequired}` : ''}</div>
        ${s.actions.map(x => `<div class="a">${x.action === 'approve' ? '✅' : '❌'} ${esc(x.user)} · ${esc(fmtD(x.at))}${x.comment ? ` — “${esc(x.comment)}”` : ''}</div>`).join('')}</div>`).join('')}
    </div></div>`;
  }
  function showPreview(rid) {
    const host = bodyEl.querySelector('#exp-prev');
    if (!host) return;
    const rec = S.claim.receipts.find(r => r.id === rid);
    if (!rec) { host.innerHTML = `<div class="h">Bill preview</div><div class="empty">Bills you add appear here so you can check them against the amounts.</div>`; return; }
    const url = fileUrl(rec.id);
    host.innerHTML = `<div class="h"><span>${esc(rec.fileName)}</span><span>${S.claim.canEdit ? `<button class="exp-btn sm" id="exp-rescan" title="Read this bill again">↻ Re-read</button> ` : ''}<a href="${url}" target="_blank">Open ↗</a></span></div>
      ${rec.mime === 'application/pdf' ? `<iframe src="${url}#toolbar=0&view=FitH"></iframe>` : `<img src="${url}" alt="">`}`;
    host.querySelector('#exp-rescan')?.addEventListener('click', async () => {
      busy(true, 'Reading the bill again…');
      try { const d = await api('POST', `/claims/${S.claim.id}/receipts/${rec.id}/rescan`); renderClaim(d.claim, { previewRid: rec.id }); toast('Bill read again.'); }
      catch (e) { busy(false); toast(e.message, 'err', 6000); }
    });
  }
  function busy(on, text = 'Working…') {
    const card = bodyEl.querySelector('#exp-lines-card');
    card?.querySelector('.exp-busy')?.remove();
    if (on && card) card.insertAdjacentHTML('beforeend', `<div class="exp-busy"><div style="text-align:center"><div class="exp-spin"></div>${esc(text)}</div></div>`);
    bodyEl.querySelectorAll('.exp-foot button').forEach(b => { b.disabled = on; });
  }
  function collect() {
    const c = S.claim;
    const lines = c.lines.map((l, i) => {
      const tr = bodyEl.querySelector(`#exp-lines tr[data-i="${i}"]`);
      if (!tr) return l;
      const v = k => tr.querySelector(`[data-l="${k}"]`);
      return { ...l, date: v('date').value, merchant: v('merchant').value, billNo: v('billNo').value, category: v('category').value,
        description: v('description').value, tax: num(v('tax').value), amount: num(v('amount').value), account: v('account') ? v('account').value.trim() : l.account };
    });
    return { title: bodyEl.querySelector('#c-title').value, purpose: bodyEl.querySelector('#c-purpose').value, currency: bodyEl.querySelector('#c-ccy').value, lines };
  }
  async function save(showToast) {
    if (!S.claim.canEdit) return S.claim;
    const d = await api('PUT', `/claims/${S.claim.id}`, collect());
    S.claim = d.claim;
    if (showToast) { renderClaim(d.claim); toast('Claim saved.'); }
    return d.claim;
  }
  async function upload(files) {
    try { await save(false); } catch (e) { toast(e.message, 'err'); return; }
    busy(true, `Reading ${files.length} bill(s)… this can take 10–30 seconds per bill`);
    const fd = new FormData();
    files.forEach(f => fd.append('files', f, f.name));
    try {
      const d = await api('POST', `/claims/${S.claim.id}/receipts`, fd);
      const added = d.claim.receipts.slice(-files.length);
      const failed = added.filter(r => r.ocrStatus === 'failed').length;
      renderClaim(d.claim, { previewRid: added[0]?.id });
      toast(failed ? `${files.length - failed} bill(s) read; ${failed} could not be read — enter those amounts by hand.` : `${files.length} bill(s) added — check the amounts.`, failed ? 'warn' : 'ok', 6000);
    } catch (e) { busy(false); toast(e.message, 'err', 6000); }
  }
  async function removeLine(i) {
    const l = S.claim.lines[i];
    if (!await confirmDlg('Remove bill', `Remove <b>${esc(l.merchant || l.description || 'this bill')}</b> (${fmt(l.amount)}) from the claim?`, 'Remove', 'bad')) return;
    try {
      let d;
      if (l.receiptId) { await save(false); d = await api('DELETE', `/claims/${S.claim.id}/receipts/${l.receiptId}`); }
      else { const body = collect(); body.lines.splice(i, 1); d = await api('PUT', `/claims/${S.claim.id}`, body); }
      renderClaim(d.claim);
    } catch (e) { toast(e.message, 'err'); }
  }
  async function delClaim() {
    if (!await confirmDlg('Delete claim', `Delete draft claim <b>#${S.claim.id}</b> and its bills?`, 'Delete', 'bad')) return;
    try { await api('DELETE', `/claims/${S.claim.id}`); toast('Claim deleted.'); window.showExpensePanel('mine'); } catch (e) { toast(e.message, 'err'); }
  }
  async function submit() {
    busy(true, 'Submitting…');
    try {
      await save(false);
      const d = await api('POST', `/claims/${S.claim.id}/submit`);
      renderClaim(d.claim); toast(d.message || 'Submitted.');
    } catch (e) { busy(false); renderClaim(S.claim, { issues: e.data?.issues || [{ severity: 'error', message: e.message }] }); }
  }
  function act(action) {
    const c = S.claim;
    modal(action === 'approve' ? 'Approve expense claim' : 'Reject expense claim',
      `<p>${esc(c.empName)} · claim #${c.id} · <b>${fmt(c.total)} ${esc(c.currency || '')}</b> (${c.lines.length} bills)</p>
       <div class="exp-f"><label>Comment${action === 'reject' ? ' (required)' : ' (optional)'}</label><textarea class="exp-in" id="ap-c" rows="3"></textarea></div>`, [
      { label: 'Cancel' },
      { label: action === 'approve' ? 'Approve' : 'Reject', cls: action === 'approve' ? 'ok' : 'bad', onClick: async bg => {
        const comment = bg.querySelector('#ap-c').value.trim();
        if (action === 'reject' && !comment) { bg.querySelector('#ap-c').classList.add('bad'); return false; }
        try { const d = await api('POST', `/claims/${c.id}/${action}`, { comment }); toast(d.message); S.me.inbox = Math.max(0, (S.me.inbox || 1) - 1); renderNav(); renderClaim(d.claim); }
        catch (e) { toast(e.message, 'err', 6000); return false; }
      } }]);
  }
  function post() {
    const c = S.claim;
    modal('Post Journal Entry to SAP', `<p>One journal entry will be created in SAP Business One:</p>
      <ul style="margin:6px 0 12px;padding-left:18px;font-size:12.5px"><li><b>Debit</b> the expense G/L of each bill (${c.lines.length} line(s))</li>
      <li><b>Credit</b> the Employee Reimbursement Payable G/L: <b>${fmt(c.total)} ${esc(c.currency || '')}</b> for ${esc(c.empName)}</li></ul>
      <div class="exp-f"><label>Posting date</label><input type="date" class="exp-in" id="p-date" value="${today()}" style="max-width:180px"></div>`, [
      { label: 'Cancel' },
      { label: 'Post to SAP', cls: 'ok', onClick: async (bg, close) => {
        const postingDate = bg.querySelector('#p-date').value;
        close();
        await save(false).catch(() => {});
        busy(true, 'Posting journal entry to SAP…');
        try { const d = await api('POST', `/claims/${c.id}/post`, { postingDate }); renderClaim(d.claim); toast(`Journal Entry ${d.docNum} created in SAP.`, 'ok', 6000); }
        catch (e) { busy(false); renderClaim(S.claim, { issues: e.data?.issues || [{ severity: 'error', message: e.message }] }); toast(e.message, 'err', 6000); }
      } }]);
  }

  // G/L type-ahead on an <input>
  function glPicker(inp) {
    let dd = null, t = null;
    const close = () => { dd?.remove(); dd = null; };
    inp.addEventListener('input', () => {
      clearTimeout(t);
      t = setTimeout(async () => {
        const qv = inp.value.trim();
        if (qv.length < 2) return close();
        try {
          const d = await api('GET', '/gl-accounts?q=' + enc(qv));
          close();
          dd = document.createElement('div');
          dd.className = 'exp-dd';
          dd.innerHTML = d.rows.length ? d.rows.map(a => `<div data-c="${esc(a.code)}">${esc(a.format || a.code)} — ${esc(a.name)}</div>`).join('') : '<div class="mut">No accounts found</div>';
          inp.parentElement.appendChild(dd);
          dd.querySelectorAll('[data-c]').forEach(x => x.onmousedown = e => { e.preventDefault(); inp.value = x.dataset.c; close(); inp.dispatchEvent(new Event('change')); });
        } catch { close(); }
      }, 250);
    });
    inp.addEventListener('blur', () => setTimeout(close, 150));
  }

  // ── Approvals ──────────────────────────────────────────────────────────────
  async function vApprovals(tab = 'mine') {
    const seq = start('approvals');
    bodyEl.innerHTML = `<div class="exp-ph"><div><h2>Expense Approval</h2><p>Claims waiting for you, and claims you have already acted on.</p></div>
      <div><button class="exp-btn ${tab === 'mine' ? 'pri' : ''}" data-t="mine">Waiting for me</button> <button class="exp-btn ${tab === 'history' ? 'pri' : ''}" data-t="history">My history</button></div></div>
      <div class="exp-card" id="exp-list">${loading()}</div>`;
    bodyEl.querySelectorAll('[data-t]').forEach(b => b.onclick = () => vApprovals(b.dataset.t));
    try {
      const d = await api('GET', '/approvals?tab=' + tab);
      if (seq !== S.seq) return;
      const host = bodyEl.querySelector('#exp-list');
      host.innerHTML = d.rows.length ? `<table class="exp-tbl"><thead><tr><th>#</th><th>Employee</th><th>Title</th><th class="r">Bills</th><th class="r">Total</th><th>Stage</th><th>Status</th><th>Submitted</th></tr></thead><tbody>
        ${d.rows.map(r => `<tr class="click" data-id="${r.id}"><td>#${r.id}</td><td>${esc(r.empName)}<div class="mut">${esc(r.department)}</div></td><td>${esc(r.title)}</td><td class="r">${r.bills}</td>
          <td class="r"><b>${fmt(r.total)}</b> ${esc(r.currency)}</td><td>${r.stageNo ? `${r.stageNo}/${r.stageCount} ${esc(r.stageName)}` : ''}</td>
          <td>${pill(APPR[r.approvalStatus] || [r.approvalStatus, ''])}</td><td>${esc(fmtD(r.submittedAt))}</td></tr>`).join('')}</tbody></table>`
        : `<div class="exp-load">${tab === 'mine' ? 'Nothing waiting for your approval. ✓' : 'You have not acted on any claims yet.'}</div>`;
      host.querySelectorAll('tr[data-id]').forEach(tr => tr.onclick = () => openClaim(+tr.dataset.id, 'approvals'));
    } catch (e) { bodyEl.querySelector('#exp-list').innerHTML = errBox(e.message); }
  }

  // ── All claims (finance) ───────────────────────────────────────────────────
  async function vAll(status = 'approved') {
    const seq = start('all');
    const tabs = [['approved', 'Ready to post'], ['submitted', 'In approval'], ['posted', 'Posted'], ['rejected', 'Rejected'], ['', 'All']];
    bodyEl.innerHTML = `<div class="exp-ph"><div><h2>All Expense Claims</h2><p>Approved claims are ready to post to SAP as journal entries.</p></div>
      <div>${tabs.map(([v, l]) => `<button class="exp-btn ${v === status ? 'pri' : ''}" data-s="${v}">${l}</button>`).join(' ')}</div></div>
      <div class="exp-card" id="exp-list">${loading()}</div>`;
    bodyEl.querySelectorAll('[data-s]').forEach(b => b.onclick = () => vAll(b.dataset.s));
    try {
      const d = await api('GET', '/claims?scope=all&status=' + enc(status));
      if (seq !== S.seq) return;
      const host = bodyEl.querySelector('#exp-list');
      const tot = d.rows.reduce((s, r) => s + r.total, 0);
      host.innerHTML = (d.rows.length ? `<div class="mut" style="margin-bottom:8px">${d.rows.length} claim(s) · total ${fmt(tot)}</div>` : '') + claimTable(d.rows, { showEmp: true });
      host.querySelectorAll('tr[data-id]').forEach(tr => tr.onclick = () => openClaim(+tr.dataset.id, 'all'));
    } catch (e) { bodyEl.querySelector('#exp-list').innerHTML = errBox(e.message); }
  }

  // ── Approval master (templates) ────────────────────────────────────────────
  let _cf = null, _pr = null;
  async function condMeta() { if (!_cf) _cf = await api('GET', '/condition-fields'); if (!_pr) _pr = (await api('GET', '/principals')).rows; return { cf: _cf, pr: _pr }; }
  async function vMaster() {
    const seq = start('master');
    _cf = null;
    bodyEl.innerHTML = `<div class="exp-ph"><div><h2>Expense Approval Master</h2><p>Templates decide who approves a claim. The first template whose rules match is used (lower priority number first). Each stage can have its own rules, e.g. a director stage only above 1,000.</p></div>
      <div><button class="exp-btn pri" id="t-new">＋ New Template</button></div></div><div class="exp-card" id="exp-list">${loading()}</div>`;
    bodyEl.querySelector('#t-new').onclick = () => editTemplate(null);
    try {
      const d = await api('GET', '/templates');
      if (seq !== S.seq) return;
      const host = bodyEl.querySelector('#exp-list');
      const who = p => p.type === 'manager' ? 'Reporting manager' : p.name;
      host.innerHTML = d.rows.length ? `<table class="exp-tbl"><thead><tr><th>Priority</th><th>Template</th><th>Applies when</th><th>Stages</th><th></th></tr></thead><tbody>
        ${d.rows.map(t => `<tr><td>${t.priority}</td><td><b>${esc(t.name)}</b><div class="mut">${esc(t.description)}</div></td><td>${esc(t.conditionsText || 'Always')}</td>
          <td>${t.stages.map((s, i) => `<div>${i + 1}. <b>${esc(s.name)}</b> — ${esc(s.approvers.map(who).join(', '))}${s.conditionsText ? ` <span class="mut">(if ${esc(s.conditionsText)})</span>` : ''}</div>`).join('')}</td>
          <td style="white-space:nowrap"><button class="exp-btn sm" data-ed="${t.id}">Edit</button> <button class="exp-btn sm bad" data-del="${t.id}">Delete</button></td></tr>`).join('')}</tbody></table>`
        : `<div class="exp-load">No templates yet. Create one so employees can submit claims, e.g. "Manager approval": stage 1 = Employee's reporting manager.</div>`;
      host.querySelectorAll('[data-ed]').forEach(b => b.onclick = () => editTemplate(d.rows.find(t => t.id === +b.dataset.ed)));
      host.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
        if (!await confirmDlg('Delete template', 'Delete this approval template? Claims already in approval keep their stages.', 'Delete', 'bad')) return;
        try { await api('DELETE', '/templates/' + b.dataset.del); vMaster(); } catch (e) { toast(e.message, 'err'); }
      });
    } catch (e) { bodyEl.querySelector('#exp-list').innerHTML = errBox(e.message); }
  }

  function chipEditor(host, options, value) {
    const render = () => {
      host.innerHTML = `<div class="exp-chips">${value.map((v, i) => `<span class="exp-chip ${v.type}">${esc(v.type === 'manager' ? 'Reporting manager' : v.name)}<button type="button" data-rm="${i}">×</button></span>`).join('')}
        <select class="exp-sel" style="width:auto;border:0;min-width:160px"><option value="">＋ add…</option>
        ${options.filter(o => !value.some(v => v.type === o.type && String(v.id) === String(o.id))).map((o, i) => `<option value="${i}">${o.type === 'role' ? 'Role: ' : o.type === 'user' ? '' : '★ '}${esc(o.name)}</option>`).join('')}</select></div>`;
      host.querySelectorAll('[data-rm]').forEach(b => b.onclick = () => { value.splice(+b.dataset.rm, 1); render(); });
      const sel = host.querySelector('select');
      const avail = options.filter(o => !value.some(v => v.type === o.type && String(v.id) === String(o.id)));
      sel.onchange = () => { if (sel.value !== '') { value.push({ ...avail[+sel.value] }); render(); } };
    };
    render();
  }
  function rulesEditor(host, cond, cf) {
    cond.rules = cond.rules || [];
    const F = Object.fromEntries(cf.fields.map(f => [f.key, f]));
    const render = () => {
      host.innerHTML = `<div style="margin-bottom:6px;font-size:12px">Match <select class="exp-sel" data-m style="width:auto"><option value="all" ${cond.match !== 'any' ? 'selected' : ''}>all rules</option><option value="any" ${cond.match === 'any' ? 'selected' : ''}>any rule</option></select></div>
        ${cond.rules.map((r, i) => {
          const f = F[r.field] || cf.fields[0];
          const ops = cf.ops[f.kind];
          const src = cf.sources[f.source] || [];
          const val = f.kind === 'number' ? (r.op === 'between' ? `<div style="display:flex;gap:4px"><input class="exp-in" data-v0 value="${esc(r.value?.[0] ?? '')}"><input class="exp-in" data-v1 value="${esc(r.value?.[1] ?? '')}"></div>` : `<input class="exp-in" data-v value="${esc(Array.isArray(r.value) ? r.value[0] : r.value ?? '')}">`)
            : `<select class="exp-sel" data-vl multiple size="3">${src.map(o => `<option value="${esc(o.code)}" ${(r.value || []).some(v => v.code === o.code) ? 'selected' : ''}>${esc(o.name ? `${o.name} (${o.code})` : o.code)}</option>`).join('')}</select>`;
          return `<div class="exp-rule" data-i="${i}"><select class="exp-sel" data-f>${cf.fields.map(x => `<option value="${x.key}" ${x.key === f.key ? 'selected' : ''}>${esc(x.label)}</option>`).join('')}</select>
            <select class="exp-sel" data-o>${ops.map(([k, l]) => `<option value="${k}" ${k === r.op ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>${val}
            <button class="exp-btn sm bad" data-x>✕</button></div>`;
        }).join('')}<button class="exp-btn sm" data-add>＋ Add rule</button>`;
      host.querySelector('[data-m]').onchange = e => { cond.match = e.target.value; };
      host.querySelector('[data-add]').onclick = () => { cond.rules.push({ field: cf.fields[0].key, op: 'gt', value: '' }); render(); };
      host.querySelectorAll('.exp-rule').forEach(row => {
        const r = cond.rules[+row.dataset.i];
        row.querySelector('[data-f]').onchange = e => { r.field = e.target.value; const k = F[r.field].kind; r.op = cf.ops[k][0][0]; r.value = k === 'number' ? '' : []; render(); };
        row.querySelector('[data-o]').onchange = e => { r.op = e.target.value; render(); };
        row.querySelector('[data-x]').onclick = () => { cond.rules.splice(+row.dataset.i, 1); render(); };
        row.querySelector('[data-v]')?.addEventListener('input', e => { r.value = e.target.value; });
        row.querySelector('[data-v0]')?.addEventListener('input', e => { r.value = [e.target.value, (r.value || [])[1] ?? '']; });
        row.querySelector('[data-v1]')?.addEventListener('input', e => { r.value = [(r.value || [])[0] ?? '', e.target.value]; });
        row.querySelector('[data-vl]')?.addEventListener('change', e => { r.value = [...e.target.selectedOptions].map(o => ({ code: o.value, name: '' })); });
      });
    };
    render();
  }
  async function editTemplate(t) {
    const seq = start('master');
    bodyEl.innerHTML = loading();
    let meta;
    try { meta = await condMeta(); } catch (e) { bodyEl.innerHTML = errBox(e.message); return; }
    if (seq !== S.seq) return;
    const T = t ? JSON.parse(JSON.stringify(t)) : { name: '', description: '', priority: 100, requestors: [], conditions: { match: 'all', rules: [] },
      stages: [{ name: 'Manager approval', approvalsRequired: 1, rejectorsRequired: 1, approvers: [{ type: 'manager', id: 'manager', name: "Employee's reporting manager (SAP)" }], conditions: { match: 'all', rules: [] } }] };
    const reqOpts = meta.pr.filter(p => p.type !== 'manager');
    const render = () => {
      bodyEl.innerHTML = `<div class="exp-ph"><div><h2>${t ? 'Edit' : 'New'} Approval Template</h2></div><div><button class="exp-btn" id="t-cancel">Cancel</button> <button class="exp-btn pri" id="t-save">Save Template</button></div></div>
        <div class="exp-card"><div class="exp-grid">
          <div class="exp-f"><label>Name</label><input class="exp-in" id="t-name" value="${esc(T.name)}"></div>
          <div class="exp-f"><label>Priority (lower wins)</label><input class="exp-in" id="t-pri" type="number" min="1" max="999" value="${T.priority}"></div>
          <div class="exp-f" style="grid-column:1/-1"><label>Description</label><input class="exp-in" id="t-desc" value="${esc(T.description)}"></div>
          <div class="exp-f" style="grid-column:1/-1"><label>Only for these employees (users / roles) — empty = everyone</label><div id="t-req"></div></div>
        </div></div>
        <div class="exp-card"><h4>Use this template when…</h4><div id="t-cond"></div></div>
        <div class="exp-card"><h4>Stages</h4><div id="t-stages"></div><button class="exp-btn" id="t-addst">＋ Add stage</button></div>`;
      chipEditor(bodyEl.querySelector('#t-req'), reqOpts, T.requestors);
      rulesEditor(bodyEl.querySelector('#t-cond'), T.conditions, meta.cf);
      const sh = bodyEl.querySelector('#t-stages');
      sh.innerHTML = T.stages.map((s, i) => `<div class="exp-stage-ed" data-s="${i}"><div class="exp-grid">
          <div class="exp-f"><label>Stage ${i + 1} name</label><input class="exp-in" data-sn value="${esc(s.name)}"></div>
          <div class="exp-f"><label>Approvals needed</label><input class="exp-in" data-sa type="number" min="1" value="${s.approvalsRequired || 1}"></div>
          <div class="exp-f" style="grid-column:1/-1"><label>Approvers</label><div data-sp></div></div>
          <div class="exp-f" style="grid-column:1/-1"><label>Only when (empty = always)</label><div data-sc></div></div></div>
          <div style="text-align:right;margin-top:6px"><button class="exp-btn sm bad" data-sx>Remove stage</button></div></div>`).join('');
      sh.querySelectorAll('[data-s]').forEach(el => {
        const s = T.stages[+el.dataset.s];
        s.conditions = s.conditions || { match: 'all', rules: [] };
        chipEditor(el.querySelector('[data-sp]'), meta.pr, s.approvers);
        rulesEditor(el.querySelector('[data-sc]'), s.conditions, meta.cf);
        el.querySelector('[data-sn]').oninput = e => { s.name = e.target.value; };
        el.querySelector('[data-sa]').oninput = e => { s.approvalsRequired = +e.target.value || 1; };
        el.querySelector('[data-sx]').onclick = () => { T.stages.splice(+el.dataset.s, 1); render(); };
      });
      bodyEl.querySelector('#t-addst').onclick = () => { T.stages.push({ name: `Stage ${T.stages.length + 1}`, approvalsRequired: 1, rejectorsRequired: 1, approvers: [], conditions: { match: 'all', rules: [] } }); render(); };
      bodyEl.querySelector('#t-name').oninput = e => { T.name = e.target.value; };
      bodyEl.querySelector('#t-pri').oninput = e => { T.priority = e.target.value; };
      bodyEl.querySelector('#t-desc').oninput = e => { T.description = e.target.value; };
      bodyEl.querySelector('#t-cancel').onclick = vMaster;
      bodyEl.querySelector('#t-save').onclick = async () => {
        try { await api(t ? 'PUT' : 'POST', t ? `/templates/${t.id}` : '/templates', T); toast('Template saved.'); vMaster(); }
        catch (e) { toast(e.message, 'err', 6000); }
      };
    };
    render();
  }

  // ── Settings & employee mapping ────────────────────────────────────────────
  async function vSettings() {
    const seq = start('settings');
    bodyEl.innerHTML = loading();
    let s, map;
    try { [s, map] = await Promise.all([api('GET', '/settings'), api('GET', '/employee-map')]); } catch (e) { bodyEl.innerHTML = errBox(e.message); return; }
    if (seq !== S.seq) return;
    s = s.settings;
    bodyEl.innerHTML = `<div class="exp-ph"><div><h2>Expense Settings</h2><p>Accounts used for the journal entry, expense categories, approval behaviour and which SAP employee each login claims as.</p></div>
      <div><button class="exp-btn pri" id="s-save">Save Settings</button></div></div>
      <div class="exp-card"><h4>Journal entry accounts</h4><div class="exp-grid">
        <div class="exp-f exp-gl"><label>Employee Reimbursement Payable G/L (credit) *</label><input class="exp-in" id="s-pay" value="${esc(s.payableAccount)}" placeholder="type to search"></div>
        <div class="exp-f exp-gl"><label>Default expense G/L (when a category has none)</label><input class="exp-in" id="s-def" value="${esc(s.defaultExpenseAccount)}" placeholder="type to search"></div>
        <div class="exp-f"><label>Journal entry memo prefix</label><input class="exp-in" id="s-memo" value="${esc(s.memoPrefix)}" maxlength="30"></div>
        <div class="exp-f"><label>Warn when a bill is older than (days, 0 = off)</label><input class="exp-in" id="s-age" type="number" min="0" value="${s.maxBillAgeDays}"></div>
      </div>
      <div style="margin-top:10px;display:flex;gap:18px;flex-wrap:wrap;font-size:12.5px">
        <label><input type="checkbox" id="s-appr" ${s.approvalRequired ? 'checked' : ''}> Claims need approval before posting</label>
        <label><input type="checkbox" id="s-auto" ${s.autoPostOnApproval ? 'checked' : ''}> Post the journal entry automatically when fully approved</label>
      </div></div>
      <div class="exp-card"><h4>Expense categories → G/L account (debit)</h4>
        <table class="exp-tbl" id="s-cats"><thead><tr><th>Category</th><th>Expense G/L</th><th></th></tr></thead><tbody>
        ${s.categories.map((c, i) => `<tr data-i="${i}"><td><input class="exp-in" data-cn value="${esc(c.name)}"></td><td class="exp-gl"><input class="exp-in" data-ca value="${esc(c.account)}" placeholder="default G/L"></td><td><button class="exp-btn sm bad" data-cx>✕</button></td></tr>`).join('')}
        </tbody></table><button class="exp-btn sm" id="s-addcat" style="margin-top:8px">＋ Add category</button></div>
      <div class="exp-card"><h4>Logins → SAP employees</h4><p class="mut" style="margin:-4px 0 10px;font-size:12px">Each employee's name and SAP employee ID go on the journal entry. Their SAP reporting manager is used for "Reporting manager" approval stages.</p>
        <div style="margin-bottom:8px"><button class="exp-btn sm" id="s-emprefresh">↻ Reload SAP employees</button> <span class="mut" id="s-empstat"></span></div>
        <div id="s-map">${loading('Loading SAP employees…')}</div></div>`;
    ['#s-pay', '#s-def'].forEach(sel => glPicker(bodyEl.querySelector(sel)));
    bodyEl.querySelectorAll('[data-ca]').forEach(glPicker);
    bodyEl.querySelectorAll('[data-cx]').forEach(b => b.onclick = () => b.closest('tr').remove());
    bodyEl.querySelector('#s-addcat').onclick = () => {
      bodyEl.querySelector('#s-cats tbody').insertAdjacentHTML('beforeend', `<tr><td><input class="exp-in" data-cn></td><td class="exp-gl"><input class="exp-in" data-ca placeholder="default G/L"></td><td><button class="exp-btn sm bad" data-cx>✕</button></td></tr>`);
      const tr = bodyEl.querySelector('#s-cats tbody tr:last-child');
      glPicker(tr.querySelector('[data-ca]'));
      tr.querySelector('[data-cx]').onclick = () => tr.remove();
    };
    bodyEl.querySelector('#s-save').onclick = async () => {
      const body = {
        payableAccount: bodyEl.querySelector('#s-pay').value.trim(), defaultExpenseAccount: bodyEl.querySelector('#s-def').value.trim(),
        memoPrefix: bodyEl.querySelector('#s-memo').value, maxBillAgeDays: +bodyEl.querySelector('#s-age').value || 0,
        approvalRequired: bodyEl.querySelector('#s-appr').checked, autoPostOnApproval: bodyEl.querySelector('#s-auto').checked,
        categories: [...bodyEl.querySelectorAll('#s-cats tbody tr')].map(tr => ({ name: tr.querySelector('[data-cn]').value.trim(), account: tr.querySelector('[data-ca]').value.trim() })).filter(c => c.name),
      };
      try { await api('PUT', '/settings', body); toast('Settings saved.'); S.me.categories = body.categories.map(c => c.name); } catch (e) { toast(e.message, 'err', 7000); }
    };
    const loadMap = async refresh => {
      const host = bodyEl.querySelector('#s-map');
      host.innerHTML = loading('Loading SAP employees…');
      let emps;
      try { emps = (await api('GET', '/employees' + (refresh ? '?refresh=1' : ''))).rows; } catch (e) { host.innerHTML = errBox(`SAP employees could not be loaded: ${e.message}`); return; }
      if (seq !== S.seq) return;
      bodyEl.querySelector('#s-empstat').textContent = `${emps.length} active employees in SAP`;
      const opts = emps.map(e => `<option value="${e.empId}">${esc(e.name)} (${e.empId})${e.department ? ' · ' + esc(e.department) : ''}</option>`).join('');
      host.innerHTML = `<table class="exp-tbl"><thead><tr><th>Login</th><th>Role</th><th>SAP employee</th><th>Department</th><th>Reporting manager</th></tr></thead><tbody>
        ${map.rows.map(u => `<tr data-u="${esc(u.userId)}"><td><b>${esc(u.name)}</b><div class="mut">${esc(u.username)}</div></td><td>${esc(u.role)}</td>
          <td><select class="exp-sel" data-emp><option value="">— not linked —</option>${opts}</select></td>
          <td class="dep">${esc(u.employee?.department || '')}</td><td class="mgr">${esc(u.employee?.managerName || '')}</td></tr>`).join('')}</tbody></table>`;
      host.querySelectorAll('tr[data-u]').forEach(tr => {
        const u = map.rows.find(x => x.userId === tr.dataset.u);
        const sel = tr.querySelector('[data-emp]');
        sel.value = u.employee ? String(u.employee.empId) : '';
        sel.onchange = async () => {
          try {
            const d = await api('PUT', `/employee-map/${enc(u.userId)}`, { empId: sel.value || null });
            u.employee = d.employee;
            tr.querySelector('.dep').textContent = d.employee?.department || '';
            tr.querySelector('.mgr').textContent = d.employee?.managerName || '';
            toast(d.employee ? `${u.name} → ${d.employee.empName}` : `${u.name} unlinked`);
          } catch (e) { toast(e.message, 'err'); }
        };
      });
    };
    bodyEl.querySelector('#s-emprefresh').onclick = () => loadMap(true);
    loadMap(false);
  }
})();
