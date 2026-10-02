/**
 * OCR Workbench — split view for OCR agents.
 *   Left:  the uploaded PDF / image
 *   Right: an editable SAP form pre-filled from OCR + SAP matching
 *
 * createOcrWorkbench(cfg) builds the shell (upload, preview, splitter, busy state,
 * messages, success screen). Each agent supplies its own form via cfg.form.
 * Exposes window.OcrWorkbench = { create, ui } so other OCR agents can reuse it.
 */
(function () {
  'use strict';

  const tok = () => localStorage.getItem('hanny_token') || '';
  const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const num = v => { const n = Number(String(v ?? '').replace(/,/g, '')); return Number.isFinite(n) ? n : 0; };
  const fmt = (n, d = 2) => Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
  const todayStr = () => new Date().toISOString().slice(0, 10);
  const plusDays = n => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };

  async function api(method, url, body) {
    const opts = { method, headers: { 'x-auth-token': tok() } };
    if (body instanceof FormData) opts.body = body;
    else if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    const r = await fetch(url, opts);
    let data = {};
    try { data = await r.json(); } catch {}
    if (!r.ok || data.ok === false) {
      const err = new Error(data.error || `Server error (${r.status})`);
      err.status = r.status; err.data = data;
      throw err;
    }
    return data;
  }

  // ── Styles (scoped with .owb-) ─────────────────────────────────────────────
  function injectStyles() {
    if (document.getElementById('owb-styles')) return;
    const st = document.createElement('style');
    st.id = 'owb-styles';
    st.textContent = `
.owb{--owb-c:#6366f1;--owb-ok:#107E3E;--owb-ok-bg:#E8F6EE;--owb-warn:#B45309;--owb-warn-bg:#FEF3C7;--owb-bad:#BB0000;--owb-bad-bg:#FDECEC;--owb-chg:#1D4ED8;--owb-chg-bg:#E0E7FF;
  flex:1;display:flex;flex-direction:column;height:100%;overflow:hidden;background:var(--bg,#F5F6F7);font-family:var(--font);color:var(--text,#32363A)}
.owb-top{background:var(--owb-c);color:#fff;padding:10px 18px;display:flex;align-items:center;gap:12px;flex-shrink:0}
.owb-top .ic{width:32px;height:32px;background:rgba(255,255,255,.15);border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:16px}
.owb-top .t1{font-size:13px;font-weight:700}.owb-top .t2{font-size:10px;opacity:.7}
.owb-top .badge{background:rgba(255,255,255,.2);font-size:9.5px;padding:2px 8px;border-radius:10px;font-weight:700;letter-spacing:.3px}
.owb-top button{background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.25);color:#fff;border-radius:4px;padding:4px 10px;font-size:11px;cursor:pointer;font-family:var(--font)}
.owb-top button:hover{background:rgba(255,255,255,.22)}
.owb-body{flex:1;display:flex;overflow:hidden;min-height:0}
.owb-drop{margin:auto;width:min(560px,92%);border:2px dashed #c7cad1;border-radius:12px;background:#fff;padding:44px 24px;text-align:center;cursor:pointer;transition:border-color .15s,background .15s}
.owb-drop:hover,.owb-drop.drag{border-color:var(--owb-c);background:#f7f7ff}
.owb-drop .big{font-size:40px;margin-bottom:8px}.owb-drop .h{font-size:15px;font-weight:700}.owb-drop .s{font-size:12px;color:var(--muted,#6A6D70);margin-top:4px}
.owb-left{width:42%;min-width:260px;display:flex;flex-direction:column;background:#525659;overflow:hidden}
.owb-left .bar{background:#fff;border-bottom:1px solid var(--border,#E5E5E5);padding:7px 12px;font-size:11.5px;display:flex;align-items:center;gap:8px}
.owb-left .bar .fn{flex:1;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.owb-left iframe{flex:1;border:0;width:100%;background:#fff}
.owb-left .imgwrap{flex:1;overflow:auto;padding:12px;text-align:center}
.owb-left .imgwrap img{max-width:100%;box-shadow:0 2px 10px rgba(0,0,0,.4);background:#fff}
.owb-split{width:6px;cursor:col-resize;background:var(--border,#E5E5E5);flex-shrink:0}
.owb-split:hover{background:var(--owb-c)}
.owb-right{flex:1;min-width:0;display:flex;flex-direction:column;overflow:hidden;background:var(--bg,#F5F6F7)}
.owb-scroll{flex:1;overflow:auto;padding:14px 16px 20px}
.owb-foot{flex-shrink:0;background:#fff;border-top:1px solid var(--border,#E5E5E5);padding:10px 16px;display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.owb-foot .sp{flex:1}
.owb-card{background:#fff;border:1px solid var(--border,#E5E5E5);border-radius:8px;padding:14px;margin-bottom:12px}
.owb-card h4{margin:0 0 10px;font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted,#6A6D70);display:flex;align-items:center;gap:8px}
.owb-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:10px 14px}
.owb-f label{display:block;font-size:11px;font-weight:600;color:var(--muted,#6A6D70);margin-bottom:3px}
.owb-f label .req{color:var(--owb-bad)}
.owb-in{width:100%;box-sizing:border-box;padding:6px 8px;border:1px solid #cfd3d8;border-radius:4px;font-size:12.5px;font-family:var(--font);background:#fff;color:inherit;min-height:30px}
.owb-in:focus{outline:none;border-color:var(--owb-c);box-shadow:0 0 0 2px rgba(99,102,241,.18)}
.owb-in[readonly]{background:#f3f4f6}
.owb-in.ok{border-color:#86c79f}.owb-in.warn{border-color:#f0b54a;background:#fffbeb}.owb-in.bad{border-color:#e58a8a;background:#fff5f5}
.owb-hint{font-size:10.5px;color:var(--muted,#6A6D70);margin-top:3px}
.owb-hint b{color:var(--text,#32363A)}
.owb-tbl{width:100%;border-collapse:collapse;font-size:12px}
.owb-tbl th{background:#f3f4f6;color:#4b5563;font-size:10.5px;text-transform:uppercase;letter-spacing:.04em;text-align:left;padding:7px 6px;border-bottom:1px solid var(--border,#E5E5E5);white-space:nowrap}
.owb-tbl td{padding:5px 6px;border-bottom:1px solid #f0f1f3;vertical-align:top}
.owb-tbl tr.off td{opacity:.45}
.owb-tbl tr.rowbad td{background:#fff8f8}
.owb-tbl .r{text-align:right}
.owb-tbl .ocr{font-size:11px;color:#4b5563;min-width:120px;max-width:170px}
.owb-tbl .ocr .m{font-size:10px;color:var(--muted,#6A6D70)}
.owb-tbl .owb-in{min-height:28px;padding:4px 6px;font-size:12px}
.owb-tbl [data-l=qty]{min-width:74px}.owb-tbl [data-l=unitPrice]{min-width:84px}.owb-tbl [data-l=warehouse]{min-width:118px}.owb-tbl [data-l=item]{min-width:200px}
.owb-pill{display:inline-block;font-size:10px;font-weight:700;padding:2px 7px;border-radius:10px;white-space:nowrap}
.owb-pill.ok{background:var(--owb-ok-bg);color:var(--owb-ok)}.owb-pill.warn{background:var(--owb-warn-bg);color:var(--owb-warn)}
.owb-pill.bad{background:var(--owb-bad-bg);color:var(--owb-bad)}.owb-pill.chg{background:var(--owb-chg-bg);color:var(--owb-chg)}
.owb-btn{padding:7px 16px;border-radius:5px;font-size:12.5px;font-weight:600;cursor:pointer;font-family:var(--font);border:1px solid var(--owb-c);background:#fff;color:var(--owb-c)}
.owb-btn:hover{background:#f5f5ff}
.owb-btn.pri{background:var(--owb-c);color:#fff}.owb-btn.pri:hover{filter:brightness(.95)}
.owb-btn:disabled{opacity:.5;cursor:not-allowed}
.owb-x{border:0;background:none;color:#9ca3af;cursor:pointer;font-size:15px;line-height:1;padding:4px}
.owb-x:hover{color:var(--owb-bad)}
.owb-msg{border-radius:6px;padding:9px 12px;font-size:12.5px;margin-bottom:12px;line-height:1.5}
.owb-msg.err{background:var(--owb-bad-bg);color:var(--owb-bad);border:1px solid #f3c0c0}
.owb-msg.warn{background:var(--owb-warn-bg);color:var(--owb-warn);border:1px solid #f5d48a}
.owb-msg.info{background:#eef2ff;color:#3730a3;border:1px solid #c7d2fe}
.owb-sum{display:flex;gap:18px;font-size:12px;flex-wrap:wrap}.owb-sum b{font-size:14px}
.owb-load{padding:40px 20px;text-align:center;color:var(--muted,#6A6D70);font-size:13px}
.owb-spin{width:28px;height:28px;border:3px solid #e5e7eb;border-top-color:var(--owb-c);border-radius:50%;margin:0 auto 12px;animation:owbspin .8s linear infinite}
@keyframes owbspin{to{transform:rotate(360deg)}}
.owb-done{background:#fff;border:1px solid var(--border,#E5E5E5);border-radius:10px;padding:28px;text-align:center;max-width:460px;margin:30px auto}
.owb-done .big{font-size:40px}.owb-done h3{margin:8px 0 14px;font-size:17px}
.owb-done table{margin:0 auto 18px;font-size:12.5px;border-collapse:collapse;text-align:left}
.owb-done td{padding:4px 12px;border-bottom:1px solid #f0f1f3}
.owb-dd{position:fixed;z-index:10050;background:#fff;border:1px solid #cfd3d8;border-radius:6px;box-shadow:0 8px 24px rgba(0,0,0,.15);max-height:260px;overflow:auto;font-size:12px;font-family:var(--font)}
.owb-dd div{padding:6px 10px;cursor:pointer;border-bottom:1px solid #f3f4f6}
.owb-dd div:hover,.owb-dd div.hl{background:#eef2ff}
.owb-dd .c{font-weight:700;color:#0f766e;margin-right:6px}
.owb-dd .e{color:var(--muted,#6A6D70);cursor:default}
.owb-sig{display:inline-flex;align-items:center;gap:4px;font-size:10.5px;font-weight:700;padding:2px 8px;border-radius:10px;white-space:nowrap;vertical-align:middle}
.owb-sig::before{content:'';width:7px;height:7px;border-radius:50%;background:currentColor}
.owb-sig.ok{background:var(--owb-ok-bg);color:var(--owb-ok)}.owb-sig.warn{background:var(--owb-warn-bg);color:var(--owb-warn)}.owb-sig.bad{background:var(--owb-bad-bg);color:var(--owb-bad)}
.owb-sig.na{background:#f3f4f6;color:#6b7280}
.owb-score{display:flex;gap:18px;align-items:flex-start;flex-wrap:wrap}
.owb-ring{--p:0;--rc:var(--owb-bad);width:92px;height:92px;border-radius:50%;flex-shrink:0;display:flex;align-items:center;justify-content:center;
  background:conic-gradient(var(--rc) calc(var(--p)*1%),#e5e7eb 0)}
.owb-ring>div{width:72px;height:72px;border-radius:50%;background:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center}
.owb-ring b{font-size:21px;line-height:1}.owb-ring span{font-size:9.5px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;margin-top:3px}
.owb-ring.ok{--rc:#16a34a}.owb-ring.warn{--rc:#f59e0b}.owb-ring.bad{--rc:#dc2626}
.owb-ring.ok b,.owb-ring.ok span{color:var(--owb-ok)}.owb-ring.warn b,.owb-ring.warn span{color:var(--owb-warn)}.owb-ring.bad b,.owb-ring.bad span{color:var(--owb-bad)}
.owb-crit{flex:1;min-width:260px;display:grid;grid-template-columns:auto 1fr 90px 52px;gap:6px 10px;align-items:center;font-size:12px}
.owb-crit .dot{width:9px;height:9px;border-radius:50%}
.owb-crit .dot.ok{background:#16a34a}.owb-crit .dot.warn{background:#f59e0b}.owb-crit .dot.bad{background:#dc2626}.owb-crit .dot.na{background:#cbd5e1}
.owb-crit .lbl b{font-weight:600}.owb-crit .lbl small{display:block;font-size:10.5px;color:var(--muted,#6A6D70)}
.owb-crit .bar{height:6px;background:#e5e7eb;border-radius:3px;overflow:hidden}
.owb-crit .bar i{display:block;height:100%;border-radius:3px}
.owb-crit .bar i.ok{background:#16a34a}.owb-crit .bar i.warn{background:#f59e0b}.owb-crit .bar i.bad{background:#dc2626}
.owb-crit .pc{text-align:right;font-weight:700}.owb-crit .pc.ok{color:var(--owb-ok)}.owb-crit .pc.warn{color:var(--owb-warn)}.owb-crit .pc.bad{color:var(--owb-bad)}.owb-crit .pc.na{color:#9ca3af}
.owb-legend{font-size:10.5px;color:var(--muted,#6A6D70);margin-top:10px;display:flex;gap:12px;flex-wrap:wrap}
@media (max-width:900px){.owb-body.has-doc{flex-direction:column;overflow:auto}.owb-left{width:100%!important;height:55vh;flex-shrink:0}.owb-split{display:none}.owb-right{overflow:visible}}
/* ── Fiori theme (S/4HANA Horizon controls) — html[data-ui="fiori"] only ── */
html[data-ui="fiori"] .owb{background:#f5f6f7;color:#1d2d3e}
/* Object Page title; scanner colour kept on the icon tile */
html[data-ui="fiori"] .owb .owb-top{background:#fff;color:#1d2d3e;padding:12px 24px;min-height:64px;border-bottom:1px solid #e5e5e5;box-shadow:0 2px 4px rgba(34,53,72,.06)}
html[data-ui="fiori"] .owb .owb-top .ic{width:36px;height:36px;border-radius:10px;background:var(--owb-c);color:#fff}
html[data-ui="fiori"] .owb .owb-top .t1{font-size:20px;font-weight:700;letter-spacing:-.01em}
html[data-ui="fiori"] .owb .owb-top .t2{font-size:13px;color:#556b82;opacity:1;margin-top:2px}
html[data-ui="fiori"] .owb .owb-top .badge{background:#e5f0fa;color:#0064d9;border-radius:6px;font-size:11px;padding:2px 8px}
html[data-ui="fiori"] .owb .owb-top button{height:36px;padding:0 14px;border-radius:8px;border:1px solid #bcc3ca;background:#fff;color:#0064d9;font-size:14px;font-weight:600}
html[data-ui="fiori"] .owb .owb-top button:hover{background:#eaecee}
html[data-ui="fiori"] .owb .owb-top button[data-r="back"]{border-color:transparent;background:transparent}
html[data-ui="fiori"] .owb .owb-top button[data-r="back"]:hover{background:#eaecee}
/* Upload area (sap.m.UploadSet drop zone) */
html[data-ui="fiori"] .owb .owb-drop{border:1px dashed #758ca4;border-radius:16px;box-shadow:none}
html[data-ui="fiori"] .owb .owb-drop:hover,html[data-ui="fiori"] .owb .owb-drop.drag{border-color:#0070f2;background:#ebf8ff}
html[data-ui="fiori"] .owb .owb-drop .h{font-size:16px;color:#1d2d3e}
html[data-ui="fiori"] .owb .owb-drop .s{font-size:13px;color:#556b82}
/* sap.f.Card + sap.ui.layout.form */
html[data-ui="fiori"] .owb .owb-card{border:none;border-radius:12px;padding:16px;margin-bottom:16px;box-shadow:0 0 2px rgba(34,53,72,.15),0 2px 4px rgba(34,53,72,.15)}
html[data-ui="fiori"] .owb .owb-card h4{font-size:16px;font-weight:700;text-transform:none;letter-spacing:0;color:#1d2d3e;margin-bottom:12px}
html[data-ui="fiori"] .owb .owb-grid{gap:12px 16px}
html[data-ui="fiori"] .owb .owb-f label{font-size:12px;font-weight:400;color:#556b82;margin-bottom:4px}
html[data-ui="fiori"] .owb .owb-in{min-height:36px;padding:0 10px;font-size:14px;border:1px solid #bcc3ca;border-bottom-color:#556b82;border-radius:8px;color:#1d2d3e}
html[data-ui="fiori"] .owb .owb-in:hover{background:#f5f6f7}
html[data-ui="fiori"] .owb .owb-in:focus{outline:2px solid #0032a5;outline-offset:-1px;box-shadow:none;border-color:#bcc3ca}
html[data-ui="fiori"] .owb .owb-in[readonly]{background:#f5f6f7;border-color:transparent}
html[data-ui="fiori"] .owb .owb-in.ok{border-bottom:2px solid #256f3a}
html[data-ui="fiori"] .owb .owb-in.warn{background:#fff8d6;border-bottom:2px solid #e76500}
html[data-ui="fiori"] .owb .owb-in.bad{background:#ffeaf4;border-bottom:2px solid #aa0808}
html[data-ui="fiori"] .owb .owb-hint{font-size:12px;color:#556b82}
html[data-ui="fiori"] .owb .owb-scroll{padding:16px 20px 24px}
/* sap.m.Table */
html[data-ui="fiori"] .owb .owb-tbl{font-size:14px}
html[data-ui="fiori"] .owb .owb-tbl th{background:#fff;color:#556b82;font-size:13px;font-weight:600;text-transform:none;letter-spacing:0;padding:10px 8px;border-bottom:1px solid #e5e5e5}
html[data-ui="fiori"] .owb .owb-tbl td{padding:8px;border-bottom:1px solid #e5e5e5}
html[data-ui="fiori"] .owb .owb-tbl tr.rowbad td{background:#ffeaf4}
html[data-ui="fiori"] .owb .owb-tbl .owb-in{min-height:32px}
/* sap.m.ObjectStatus */
html[data-ui="fiori"] .owb .owb-pill,html[data-ui="fiori"] .owb .owb-sig{border-radius:6px;font-size:12px;padding:2px 8px}
html[data-ui="fiori"] .owb .owb-pill.ok,html[data-ui="fiori"] .owb .owb-sig.ok{background:#f5fae5;color:#256f3a}
html[data-ui="fiori"] .owb .owb-pill.warn,html[data-ui="fiori"] .owb .owb-sig.warn{background:#fff8d6;color:#e76500}
html[data-ui="fiori"] .owb .owb-pill.bad,html[data-ui="fiori"] .owb .owb-sig.bad{background:#ffeaf4;color:#aa0808}
html[data-ui="fiori"] .owb .owb-pill.chg{background:#e5f0fa;color:#0064d9}
/* sap.m.Button: Default / Emphasized; footer = sap.m.Bar */
html[data-ui="fiori"] .owb .owb-btn{height:36px;padding:0 16px;border-radius:8px;font-size:14px;border:1px solid #bcc3ca;background:#fff;color:#0064d9}
html[data-ui="fiori"] .owb .owb-btn:hover{background:#eaecee}
html[data-ui="fiori"] .owb .owb-btn.pri{background:#0070f2;border-color:#0070f2;color:#fff}
html[data-ui="fiori"] .owb .owb-btn.pri:hover{background:#0064d9;filter:none}
html[data-ui="fiori"] .owb .owb-foot{padding:10px 20px;border-top:1px solid #e5e5e5;box-shadow:0 -2px 4px rgba(34,53,72,.06)}
/* sap.m.MessageStrip */
html[data-ui="fiori"] .owb .owb-msg{border-radius:8px;font-size:14px;border-width:1px}
html[data-ui="fiori"] .owb .owb-msg.err{background:#ffeaf4;color:#aa0808;border-color:#ff8888}
html[data-ui="fiori"] .owb .owb-msg.warn{background:#fff8d6;color:#e76500;border-color:#ffcf5c}
html[data-ui="fiori"] .owb .owb-msg.info{background:#e5f0fa;color:#0064d9;border-color:#89bfff}
html[data-ui="fiori"] .owb .owb-done{border:none;border-radius:16px;box-shadow:0 0 2px rgba(34,53,72,.15),0 2px 4px rgba(34,53,72,.15)}
html[data-ui="fiori"] .owb .owb-left .bar{font-size:13px;padding:10px 14px}
html[data-ui="fiori"] .owb .owb-split{background:#e5e5e5}
html[data-ui="fiori"] .owb-dd{border-radius:8px;border-color:#d9d9d9;box-shadow:0 0 2px rgba(34,53,72,.2),0 8px 24px rgba(34,53,72,.2);font-size:14px}
html[data-ui="fiori"] .owb-dd div{padding:8px 12px;border-bottom-color:#eef0f2}
html[data-ui="fiori"] .owb-dd div:hover,html[data-ui="fiori"] .owb-dd div.hl{background:#ebf8ff}
@media (max-width:640px){html[data-ui="fiori"] .owb .owb-top{padding:10px 12px;flex-wrap:wrap}html[data-ui="fiori"] .owb .owb-top .t1{font-size:16px}}
`;
    document.head.appendChild(st);
  }

  // ── Remote-search combobox (dropdown is position:fixed so it never gets clipped) ──
  let _openDD = null;
  function closeDD() { if (_openDD) { _openDD.remove(); _openDD = null; } }
  document.addEventListener('mousedown', e => { if (_openDD && !_openDD.contains(e.target) && !e.target.classList?.contains('owb-combo')) closeDD(); });
  window.addEventListener('resize', closeDD);

  /**
   * combo(input, { search: async q => [{code,name,...}], onPick: item => {}, label: item => html })
   * Typing searches SAP; picking sets the input and calls onPick.
   */
  function combo(input, opts) {
    input.classList.add('owb-combo');
    input.setAttribute('autocomplete', 'off');
    let timer = null, items = [], hl = -1, seq = 0;
    const render = (list, loading) => {
      closeDD();
      const dd = document.createElement('div');
      dd.className = 'owb-dd';
      const rc = input.getBoundingClientRect();
      dd.style.left = rc.left + 'px';
      dd.style.minWidth = Math.max(rc.width, 260) + 'px';
      const below = window.innerHeight - rc.bottom;
      if (below < 200 && rc.top > below) dd.style.bottom = (window.innerHeight - rc.top + 2) + 'px';
      else dd.style.top = (rc.bottom + 2) + 'px';
      if (loading) dd.innerHTML = '<div class="e">Searching SAP…</div>';
      else if (!list.length) dd.innerHTML = '<div class="e">No matches in SAP — try another name or code</div>';
      else list.forEach((it, i) => {
        const row = document.createElement('div');
        row.innerHTML = opts.label ? opts.label(it) : `<span class="c">${esc(it.code)}</span>${esc(it.name)}`;
        if (i === hl) row.classList.add('hl');
        row.addEventListener('mousedown', e => { e.preventDefault(); pick(it); });
        dd.appendChild(row);
      });
      document.body.appendChild(dd);
      _openDD = dd;
    };
    const pick = it => { closeDD(); opts.onPick(it); };
    const run = async q => {
      const my = ++seq;
      render([], true);
      try { items = await opts.search(q); } catch { items = []; }
      if (my !== seq || document.activeElement !== input) return;
      hl = items.length ? 0 : -1;
      render(items, false);
    };
    input.addEventListener('focus', () => { input.select(); run(input.dataset.q || ''); });
    input.addEventListener('input', () => {
      input.dataset.q = input.value;
      clearTimeout(timer);
      timer = setTimeout(() => run(input.value.trim()), 250);
    });
    input.addEventListener('keydown', e => {
      if (!_openDD || !items.length) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); hl = Math.min(items.length - 1, hl + 1); render(items); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); hl = Math.max(0, hl - 1); render(items); }
      else if (e.key === 'Enter') { e.preventDefault(); if (items[hl]) pick(items[hl]); }
      else if (e.key === 'Escape') closeDD();
    });
    input.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== input) { closeDD(); opts.onBlur && opts.onBlur(); } }, 150));
  }

  // ── Shell ──────────────────────────────────────────────────────────────────
  function create(cfg) {
    injectStyles();
    const panel = document.getElementById(cfg.panelId);
    if (!panel) return null;
    panel.innerHTML = '';
    panel.className = 'owb';
    panel.style.cssText = 'display:none;position:relative';
    panel.style.setProperty('--owb-c', cfg.color);

    panel.innerHTML = `
      <div class="owb-top">
        <div class="ic">${cfg.icon}</div>
        <div style="flex:1;min-width:0"><div class="t1">${esc(cfg.title)}</div><div class="t2">${esc(cfg.subtitle)}</div></div>
        <span class="badge" data-r="badge">UPLOAD</span>
        <button data-r="back" title="Back to Chat">← Back</button>
        <button data-r="restart" title="Start over with a new document">⟳ New Document</button>
      </div>
      <div class="owb-body" data-r="body"></div>
      <input type="file" data-r="file" accept=".pdf,.jpg,.jpeg,.png,.webp,.tif,.tiff" style="display:none">`;

    const $ = r => panel.querySelector(`[data-r="${r}"]`);
    const body = $('body'), fileIn = $('file');
    const state = { file: null, url: null, ocrData: null, fileName: '' };

    const setBadge = t => { $('badge').textContent = t; };

    function renderUpload(err) {
      setBadge('UPLOAD');
      body.classList.remove('has-doc');
      body.innerHTML = `
        <div style="flex:1;display:flex;flex-direction:column;justify-content:center;padding:20px">
          ${err ? `<div class="owb-msg err" style="width:min(560px,92%);margin:0 auto 12px;box-sizing:border-box">${esc(err)}</div>` : ''}
          <div class="owb-drop" data-r="drop">
            <div class="big">📎</div>
            <div class="h">${esc(cfg.dropText)}</div>
            <div class="s">Drag &amp; drop here, or click to browse · PDF, JPG, PNG, WEBP · max 15 MB</div>
            <div class="s" style="margin-top:12px">The document opens on the left and the SAP form on the right — check the values, fix anything that doesn't match, then post.</div>
          </div>
        </div>`;
      const drop = $('drop');
      drop.addEventListener('click', () => fileIn.click());
      drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('drag'); });
      drop.addEventListener('dragleave', () => drop.classList.remove('drag'));
      drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('drag'); if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]); });
    }

    function renderSplit() {
      body.classList.add('has-doc');
      const isPdf = state.file.type === 'application/pdf';
      body.innerHTML = `
        <div class="owb-left" data-r="left">
          <div class="bar"><span>📄</span><span class="fn" title="${esc(state.fileName)}">${esc(state.fileName)}</span>
            <span style="color:var(--muted)">${(state.file.size / 1024).toFixed(0)} KB</span>
            <a href="${state.url}" target="_blank" rel="noopener" style="font-size:11px;color:${cfg.color}">Open ↗</a></div>
          ${isPdf ? `<iframe src="${state.url}#view=FitH" title="Document preview"></iframe>`
                  : `<div class="imgwrap"><img src="${state.url}" alt="Uploaded document"></div>`}
        </div>
        <div class="owb-split" data-r="split" title="Drag to resize"></div>
        <div class="owb-right" data-r="right"></div>`;
      // Drag-to-resize divider
      const split = $('split'), left = $('left');
      split.addEventListener('mousedown', e => {
        e.preventDefault();
        const startX = e.clientX, startW = left.getBoundingClientRect().width, total = body.getBoundingClientRect().width;
        const ifr = left.querySelector('iframe'); if (ifr) ifr.style.pointerEvents = 'none';
        const mv = ev => { left.style.width = Math.min(total - 360, Math.max(260, startW + ev.clientX - startX)) + 'px'; };
        const up = () => { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); if (ifr) ifr.style.pointerEvents = ''; };
        document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
      });
    }

    const right = () => $('right');

    function renderLoading(text) {
      right().innerHTML = `<div class="owb-scroll"><div class="owb-load"><div class="owb-spin"></div>${esc(text)}</div></div>`;
    }

    async function handleFile(file) {
      const allowed = ['application/pdf', 'image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/tiff'];
      if (!allowed.includes(file.type)) return renderUpload('Please upload a PDF or an image (JPG, PNG, WEBP, TIFF).');
      if (file.size > 15 * 1024 * 1024) return renderUpload('That file is larger than 15 MB.');
      if (state.url) URL.revokeObjectURL(state.url);
      Object.assign(state, { file, fileName: file.name, url: URL.createObjectURL(file), ocrData: null });
      renderSplit();
      setBadge('READING');
      renderLoading('Reading the document with OCR… this usually takes 10–30 seconds.');
      try {
        const fd = new FormData(); fd.append('file', file);
        const up = await api('POST', cfg.api + '/upload', fd);
        state.ocrData = up.ocrData;
        setBadge('MATCHING');
        renderLoading('Matching against SAP master data…');
        await cfg.form.load(ctx);
        setBadge('REVIEW');
      } catch (e) {
        setBadge('ERROR');
        right().innerHTML = `<div class="owb-scroll"><div class="owb-msg err">❌ ${esc(e.message)}</div>
          <button class="owb-btn" data-r="retry">Try another file</button></div>`;
        $('retry').addEventListener('click', () => fileIn.click());
      }
    }

    function renderDone(rows, againText) {
      setBadge('POSTED');
      right().innerHTML = `<div class="owb-scroll"><div class="owb-done">
        <div class="big">✅</div><h3>${esc(cfg.doneTitle)}</h3>
        <table>${rows.map(([k, v]) => `<tr><td style="color:var(--muted)">${esc(k)}</td><td><b>${esc(v)}</b></td></tr>`).join('')}</table>
        <button class="owb-btn pri" data-r="again">${esc(againText || 'Scan Another Document')}</button></div></div>`;
      $('again').addEventListener('click', reset);
    }

    function reset() {
      closeDD();
      if (state.url) URL.revokeObjectURL(state.url);
      Object.assign(state, { file: null, url: null, ocrData: null, fileName: '' });
      renderUpload();
    }

    fileIn.addEventListener('change', () => { const f = fileIn.files[0]; fileIn.value = ''; if (f) handleFile(f); });
    $('restart').addEventListener('click', reset);
    $('back').addEventListener('click', () => { closeDD(); window.showChatPanel && window.showChatPanel(); });

    function show() {
      if (window.showChatPanel) window.showChatPanel();
      ['messages'].forEach(id => { const el = document.getElementById(id); if (el) el.style.display = 'none'; });
      const bb = document.querySelector('.bottom-bar'); if (bb) bb.style.display = 'none';
      const ia = document.querySelector('.input-area'); if (ia) ia.style.display = 'none';
      const main = document.querySelector('.main');
      if (main && panel.parentElement !== main) main.appendChild(panel);
      panel.style.display = 'flex';
      document.querySelectorAll('.nav-item,.nav-subitem').forEach(n => n.classList.remove('active'));
      document.getElementById(cfg.navId)?.classList.add('active');
      if (!state.file) renderUpload();
    }

    const ctx = { cfg, state, api, right, setBadge, renderDone, reset, pickFile: () => fileIn.click() };
    renderUpload();
    window[cfg.showFnName] = show;
    return { show, reset };
  }

  // ── Match scoring (shared by every OCR agent) ──────────────────────────────
  // Signal thresholds: green ≥ 90 %, amber ≥ 70 %, red below.
  const level = p => (p == null ? 'na' : p >= 0.9 ? 'ok' : p >= 0.7 ? 'warn' : 'bad');
  const pctTxt = p => (p == null ? 'n/a' : Math.round(p * 100) + '%');
  // How closely two amounts agree (1 = identical); null when there is nothing to compare.
  const amtScore = (a, b) => {
    a = num(a); b = num(b);
    if (!a && !b) return null;
    const m = Math.max(Math.abs(a), Math.abs(b));
    return Math.max(0, 1 - Math.abs(a - b) / m);
  };
  const avg = arr => { const v = arr.filter(x => x != null); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null; };
  const lineSig = (p, status) => `${sig(p)}<div style="font-size:10px;color:var(--muted,#6A6D70);margin-top:2px;white-space:nowrap">${esc(status)}</div>`;
  const sig = (p, label) => `<span class="owb-sig ${level(p)}" title="Match confidence">${pctTxt(p)}${label ? ' · ' + esc(label) : ''}</span>`;

  /**
   * criteria: [{ label, score: 0..1|null, note, weight, blocking }] → { overall, html }
   * A criterion with blocking:true (e.g. no vendor, a line with no SAP item) means SAP
   * would reject the post, so the overall score is capped in the red band.
   */
  function scorecard(criteria) {
    const used = criteria.filter(c => c.score != null);
    const wsum = used.reduce((s, c) => s + (c.weight || 1), 0);
    let overall = wsum ? used.reduce((s, c) => s + c.score * (c.weight || 1), 0) / wsum : null;
    if (overall != null && criteria.some(c => c.blocking)) overall = Math.min(overall, 0.69);
    const lv = level(overall);
    const verdict = { ok: 'Ready', warn: 'Review', bad: 'Fix needed', na: '—' }[lv];
    const html = `<div class="owb-card"><h4>Match Score</h4><div class="owb-score">
      <div class="owb-ring ${lv}" style="--p:${overall == null ? 0 : Math.round(overall * 100)}"><div><b>${pctTxt(overall)}</b><span>${verdict}</span></div></div>
      <div class="owb-crit">${criteria.map(c => {
        const l = level(c.score);
        return `<span class="dot ${l}"></span>
          <div class="lbl"><b>${esc(c.label)}</b>${c.note ? `<small>${esc(c.note)}</small>` : ''}</div>
          <div class="bar"><i class="${l}" style="width:${c.score == null ? 0 : Math.round(c.score * 100)}%"></i></div>
          <div class="pc ${l}">${pctTxt(c.score)}</div>`;
      }).join('')}</div></div>
      <div class="owb-legend"><span><span class="owb-sig ok">≥ 90%</span> matched</span><span><span class="owb-sig warn">70–89%</span> please check</span><span><span class="owb-sig bad">&lt; 70%</span> fix before posting</span><span>Anything you pick yourself counts as 100%.</span></div></div>`;
    return { overall, html };
  }

  window.OcrWorkbench = { create, ui: { esc, num, fmt, todayStr, plusDays, combo, closeDD, api, level, pctTxt, amtScore, avg, sig, lineSig, scorecard } };
})();

// ═══════════════════════════════════════════════════════════════════════════
//  Agent 1: Scan Purchase Order → SAP Purchase Order form
// ═══════════════════════════════════════════════════════════════════════════
(function () {
  'use strict';
  const { esc, num, fmt, todayStr, plusDays, combo, closeDD, amtScore, avg, sig, lineSig, scorecard, level } = window.OcrWorkbench.ui;

  const poForm = {
    async load(ctx) {
      const { cfg, state, api } = ctx;
      const [prep, look] = await Promise.all([
        api('POST', cfg.api + '/prepare', { ocrData: state.ocrData }),
        api('GET', cfg.api + '/lookups').catch(() => ({ warehouses: [], taxCodes: [], localCurrency: null })),
      ]);
      const od = state.ocrData || {};
      const f = {
        vendor: prep.vendor,                      // {code,name,currency}
        vendorCandidates: prep.vendorCandidates || [],
        vendorChanged: false,
        numAtCard: od.docNumber || '',
        docDate: od.docDate || todayStr(),
        dueDate: plusDays(14),
        comments: `Created from scanned document ${state.fileName}`.slice(0, 250),
        warehouses: look.warehouses || [],
        taxCodes: look.taxCodes || [],
        localCurrency: look.localCurrency || null,
        lines: (prep.lines || []).map(l => ({
          include: true,
          ocr: l.ocrLine || {},
          itemCode: l.match?.itemCode || '',
          itemName: l.match?.itemName || '',
          unit: l.match?.unit || l.ocrLine?.unit || '',
          score: l.match ? l.match.score : 0,
          changed: false,
          qty: num(l.ocrLine?.qty) || 1,
          unitPrice: num(l.ocrLine?.unitPrice),
          warehouse: '',
          taxCode: '',
        })),
        msg: null,
      };
      if (!f.lines.length) f.lines.push(blankLine());
      state.form = f;
      render(ctx);
    },
  };

  function blankLine() {
    return { include: true, ocr: {}, itemCode: '', itemName: '', unit: '', score: 0, changed: true, qty: 1, unitPrice: 0, warehouse: '', taxCode: '' };
  }

  function lineStatus(l) {
    if (!l.itemCode) return ['bad', 'Not in SAP'];
    if (l.changed) return ['chg', 'Selected'];
    if (l.score >= 0.9) return ['ok', 'Matched'];
    return ['warn', 'Check match'];
  }

  // ── Match scoring ──
  const itemScore  = l => (!l.itemCode ? 0 : l.changed ? 1 : num(l.score));
  const qtyScore   = l => (num(l.ocr.qty) ? amtScore(l.qty, l.ocr.qty) : null);
  const priceScore = l => (l.ocr.unitPrice != null && num(l.ocr.unitPrice) ? amtScore(l.unitPrice, l.ocr.unitPrice) : null);
  function lineScore(l) {
    if (!l.itemCode) return 0;
    const parts = [[itemScore(l), 0.6], [qtyScore(l), 0.2], [priceScore(l), 0.2]].filter(([v]) => v != null);
    const w = parts.reduce((s, [, x]) => s + x, 0);
    return parts.reduce((s, [v, x]) => s + v * x, 0) / w;
  }
  const vendorScore = f => (!f.vendor ? 0 : f.vendorChanged ? 1 : (f.vendor.score ?? 1));

  function criteria(f, od) {
    const inc = f.lines.filter(l => l.include);
    const withQty = inc.filter(l => qtyScore(l) != null), withPrice = inc.filter(l => priceScore(l) != null);
    const qtyDiff = withQty.filter(l => qtyScore(l) < 0.999).length, priceDiff = withPrice.filter(l => priceScore(l) < 0.999).length;
    const good = inc.filter(l => itemScore(l) >= 0.9).length;
    const docTotal = (od.lines || []).reduce((s, l) => s + (num(l.lineTotal) || num(l.qty) * num(l.unitPrice)), 0);
    const formTotal = inc.reduce((s, l) => s + num(l.qty) * num(l.unitPrice), 0);
    const hdr = [!!String(f.numAtCard || '').trim(), !!(od.docDate && f.docDate)];
    return [
      { label: 'Vendor', weight: 25, score: vendorScore(f), blocking: !f.vendor,
        note: !f.vendor ? `"${od.vendorName || '—'}" not found in SAP` : f.vendorChanged ? 'Selected by you' : `"${od.vendorName || '—'}" → ${f.vendor.code}` },
      { label: 'Items vs SAP item master', weight: 30, score: inc.length ? avg(inc.map(itemScore)) : 0,
        blocking: !inc.length || inc.some(l => !l.itemCode),
        note: `${good} of ${inc.length} line(s) matched${inc.some(l => !l.itemCode) ? ' · missing items block posting' : ''}` },
      { label: 'Quantities vs document', weight: 10, score: avg(withQty.map(qtyScore)),
        note: withQty.length ? (qtyDiff ? `${qtyDiff} line(s) differ from the document` : 'All quantities as on document') : 'No quantities on document' },
      { label: 'Unit prices vs document', weight: 10, score: avg(withPrice.map(priceScore)),
        note: withPrice.length ? (priceDiff ? `${priceDiff} line(s) differ from the document` : 'All prices as on document') : 'No prices on document' },
      { label: 'Total vs document', weight: 15, score: amtScore(formTotal, docTotal),
        note: docTotal ? `Form ${fmt(formTotal)} · document ${fmt(docTotal)}` : 'No total on document' },
      { label: 'Header details', weight: 10, score: hdr.filter(Boolean).length / hdr.length,
        note: `${hdr[0] ? 'Ref. no. ✓' : 'Ref. no. missing'} · ${hdr[1] ? 'Date ✓' : 'Date not read'}` },
    ];
  }

  function currencyLabel(f) {
    const c = f.vendor?.currency;
    if (!c || c === '##') return f.localCurrency ? `${f.localCurrency} (local)` : 'Local currency';
    return c === f.localCurrency ? `${c} (local)` : `${c} — foreign, SAP rate used`;
  }

  function render(ctx) {
    const f = ctx.state.form, od = ctx.state.ocrData || {};
    const root = ctx.right();
    const vState = !f.vendor ? 'bad' : f.vendorChanged ? '' : level(vendorScore(f));
    const hasTax = f.taxCodes.length > 0;
    const whOpts = ['<option value="">Item default</option>']
      .concat(f.warehouses.map(w => `<option value="${esc(w.code)}">${esc(w.code)}${w.name ? ' — ' + esc(w.name) : ''}</option>`)).join('');
    const taxOpts = ['<option value="">—</option>']
      .concat(f.taxCodes.map(t => `<option value="${esc(t.code)}">${esc(t.code)} (${t.rate || 0}%)</option>`)).join('');

    const unmatched = f.lines.filter(l => l.include && !l.itemCode).length;
    const fuzzy = f.lines.filter(l => l.include && l.itemCode && !l.changed && l.score < 0.9).length;

    root.innerHTML = `
      <div class="owb-scroll" data-r="scroll">
        ${f.msg ? `<div class="owb-msg ${f.msg.type}">${f.msg.html}</div>` : ''}
        <div data-r="score"></div>
        ${!f.vendor || unmatched || fuzzy ? `<div class="owb-msg warn">
            ${!f.vendor ? '⚠️ The vendor on the document was not found in SAP — choose one below.<br>' : ''}
            ${unmatched ? `⚠️ ${unmatched} line(s) have no SAP item — pick an item or untick the line.<br>` : ''}
            ${fuzzy ? `🔎 ${fuzzy} line(s) matched approximately — please confirm the item.` : ''}</div>` : ''}

        <div class="owb-card">
          <h4>Purchase Order — Header</h4>
          <div class="owb-grid">
            <div class="owb-f" style="grid-column:span 2">
              <label>Vendor <span class="req">*</span> ${sig(vendorScore(f))}</label>
              <input class="owb-in ${vState}" data-r="vendor" placeholder="Search SAP vendor by name or code…"
                value="${f.vendor ? esc(`${f.vendor.code} — ${f.vendor.name}`) : ''}">
              <div class="owb-hint">On document: <b>${esc(od.vendorName || '—')}</b>${od.vendorCode ? ` (${esc(od.vendorCode)})` : ''}</div>
            </div>
            <div class="owb-f"><label>Currency</label><input class="owb-in" readonly value="${esc(currencyLabel(f))}"></div>
            <div class="owb-f"><label>Vendor Ref. No.</label><input class="owb-in" data-h="numAtCard" maxlength="100" value="${esc(f.numAtCard)}">
              <div class="owb-hint">Document #: <b>${esc(od.docNumber || '—')}</b></div></div>
            <div class="owb-f"><label>Posting Date <span class="req">*</span></label><input type="date" class="owb-in" data-h="docDate" value="${esc(f.docDate)}">
              <div class="owb-hint">On document: <b>${esc(od.docDate || '—')}</b></div></div>
            <div class="owb-f"><label>Delivery Date <span class="req">*</span></label><input type="date" class="owb-in" data-h="dueDate" value="${esc(f.dueDate)}"></div>
            <div class="owb-f" style="grid-column:1/-1"><label>Remarks</label><input class="owb-in" data-h="comments" maxlength="254" value="${esc(f.comments)}"></div>
          </div>
        </div>

        <div class="owb-card" style="padding:14px 0 6px">
          <h4 style="padding:0 14px">Items <span style="flex:1"></span>
            <button class="owb-btn" data-r="addline" style="padding:4px 10px;font-size:11.5px;text-transform:none;letter-spacing:0">+ Add line</button></h4>
          <div style="overflow-x:auto">
          <table class="owb-tbl">
            <thead><tr>
              <th title="Include this line in the PO"></th><th>On document</th><th style="min-width:210px">SAP Item <span style="color:var(--owb-bad)">*</span></th>
              <th class="r" style="width:80px">Qty</th><th>UoM</th><th class="r" style="width:100px">Unit Price</th>
              <th style="min-width:120px">Warehouse</th>${hasTax ? '<th style="min-width:90px">Tax</th>' : ''}
              <th class="r">Total</th><th>Match</th><th></th>
            </tr></thead>
            <tbody>
            ${f.lines.map((l, i) => {
              const [sc, st] = lineStatus(l);
              const off = !l.include;
              return `<tr data-i="${i}" class="${off ? 'off' : ''} ${!off && !l.itemCode ? 'rowbad' : ''}">
                <td><input type="checkbox" data-l="include" ${l.include ? 'checked' : ''}></td>
                <td class="ocr">${l.ocr.description ? esc(l.ocr.description) : '<i>added manually</i>'}
                  ${l.ocr.itemCode || l.ocr.qty ? `<div class="m">${l.ocr.itemCode ? esc(l.ocr.itemCode) + ' · ' : ''}${l.ocr.qty ? esc(l.ocr.qty) + ' × ' + esc(l.ocr.unitPrice ?? 0) : ''}</div>` : ''}</td>
                <td><input class="owb-in ${sc === 'bad' ? 'bad' : sc === 'warn' ? 'warn' : ''}" data-l="item" placeholder="Search item…"
                      value="${l.itemCode ? esc(`${l.itemCode} — ${l.itemName}`) : ''}" title="${esc(l.itemName)}"></td>
                <td><input class="owb-in r" data-l="qty" inputmode="decimal" value="${esc(l.qty)}"></td>
                <td style="font-size:11px;padding-top:10px">${esc(l.unit || '—')}</td>
                <td><input class="owb-in r" data-l="unitPrice" inputmode="decimal" value="${esc(l.unitPrice)}"></td>
                <td><select class="owb-in" data-l="warehouse">${whOpts}</select></td>
                ${hasTax ? `<td><select class="owb-in" data-l="taxCode">${taxOpts}</select></td>` : ''}
                <td class="r" data-l="total" style="padding-top:10px;white-space:nowrap">${fmt(num(l.qty) * num(l.unitPrice))}</td>
                <td style="padding-top:9px" data-l="sig">${lineSig(lineScore(l), st)}</td>
                <td><button class="owb-x" data-l="del" title="Remove line">✕</button></td>
              </tr>`;
            }).join('')}
            </tbody>
          </table>
          </div>
        </div>
      </div>
      <div class="owb-foot">
        <div class="owb-sum" data-r="sum"></div>
        <span class="sp"></span>
        <button class="owb-btn" data-r="reupload">Re-upload</button>
        <button class="owb-btn pri" data-r="post">Post Purchase Order to SAP</button>
      </div>`;

    const q = s => root.querySelector(s);
    const rows = [...root.querySelectorAll('tbody tr')];

    // Restore select values
    rows.forEach((tr, i) => {
      const l = f.lines[i];
      const wh = tr.querySelector('[data-l="warehouse"]'); if (wh) wh.value = l.warehouse;
      const tx = tr.querySelector('[data-l="taxCode"]'); if (tx) tx.value = l.taxCode;
    });

    const updateSum = () => {
      const inc = f.lines.filter(l => l.include);
      const total = inc.reduce((s, l) => s + num(l.qty) * num(l.unitPrice), 0);
      const cur = f.vendor?.currency && f.vendor.currency !== '##' ? f.vendor.currency : (f.localCurrency || '');
      q('[data-r="sum"]').innerHTML = `<span>Lines: <b>${inc.length}</b></span><span>Total before tax: <b>${esc(cur)} ${fmt(total)}</b></span>`;
    };
    updateSum();

    const updateScore = () => {
      q('[data-r="score"]').innerHTML = scorecard(criteria(f, od)).html;
      rows.forEach((tr, i) => { const l = f.lines[i]; tr.querySelector('[data-l="sig"]').innerHTML = lineSig(lineScore(l), lineStatus(l)[1]); });
    };
    updateScore();

    // Header fields
    root.querySelectorAll('[data-h]').forEach(el => el.addEventListener('input', () => { f[el.dataset.h] = el.value; updateScore(); }));

    // Vendor combobox
    const vIn = q('[data-r="vendor"]');
    combo(vIn, {
      search: async s => (await ctx.api('GET', `${ctx.cfg.api}/vendors?q=${encodeURIComponent(s)}`)).vendors,
      label: v => `<span class="c">${esc(v.code)}</span>${esc(v.name)}${v.currency ? ` <span style="color:var(--muted)">· ${esc(v.currency)}</span>` : ''}`,
      onPick: v => { f.vendor = v; f.vendorChanged = true; f.msg = null; render(ctx); },
      onBlur: () => { vIn.value = f.vendor ? `${f.vendor.code} — ${f.vendor.name}` : ''; },
    });

    // Line fields
    rows.forEach((tr, i) => {
      const l = f.lines[i];
      tr.querySelector('[data-l="include"]').addEventListener('change', e => { l.include = e.target.checked; render(ctx); });
      tr.querySelector('[data-l="del"]').addEventListener('click', () => { f.lines.splice(i, 1); if (!f.lines.length) f.lines.push(blankLine()); render(ctx); });
      ['qty', 'unitPrice'].forEach(k => tr.querySelector(`[data-l="${k}"]`).addEventListener('input', e => {
        l[k] = e.target.value;
        tr.querySelector('[data-l="total"]').textContent = fmt(num(l.qty) * num(l.unitPrice));
        updateSum(); updateScore();
      }));
      tr.querySelector('[data-l="warehouse"]').addEventListener('change', e => { l.warehouse = e.target.value; });
      tr.querySelector('[data-l="taxCode"]')?.addEventListener('change', e => { l.taxCode = e.target.value; });
      const itIn = tr.querySelector('[data-l="item"]');
      itIn.dataset.q = l.itemCode ? '' : (l.ocr.description || '').slice(0, 30);
      combo(itIn, {
        search: async s => (await ctx.api('GET', `${ctx.cfg.api}/items?q=${encodeURIComponent(s)}`)).items,
        label: it => `<span class="c">${esc(it.code)}</span>${esc(it.name)}${it.unit ? ` <span style="color:var(--muted)">· ${esc(it.unit)}</span>` : ''}`,
        onPick: it => { Object.assign(l, { itemCode: it.code, itemName: it.name, unit: it.unit || l.unit, changed: true, include: true }); render(ctx); },
        onBlur: () => { itIn.value = l.itemCode ? `${l.itemCode} — ${l.itemName}` : ''; },
      });
    });

    q('[data-r="addline"]').addEventListener('click', () => { f.lines.push(blankLine()); render(ctx); });
    q('[data-r="reupload"]').addEventListener('click', () => ctx.pickFile());
    q('[data-r="post"]').addEventListener('click', () => post(ctx));
  }

  function showMsg(ctx, type, html) {
    ctx.state.form.msg = { type, html };
    render(ctx);
    const sc = ctx.right().querySelector('[data-r="scroll"]'); if (sc) sc.scrollTop = 0;
  }

  async function post(ctx) {
    closeDD();
    const f = ctx.state.form;
    const inc = f.lines.filter(l => l.include);
    const errs = [];
    if (!f.vendor) errs.push('Select a vendor.');
    if (!f.docDate) errs.push('Enter a posting date.');
    if (!f.dueDate) errs.push('Enter a delivery date.');
    if (!inc.length) errs.push('Tick at least one line.');
    inc.forEach(l => {
      const n = f.lines.indexOf(l) + 1;
      if (!l.itemCode) errs.push(`Line ${n}: choose an SAP item (or untick the line).`);
      if (!(num(l.qty) > 0)) errs.push(`Line ${n}: quantity must be greater than 0.`);
    });
    if (errs.length) return showMsg(ctx, 'err', '<b>Please fix before posting:</b><br>' + errs.map(esc).join('<br>'));

    const btn = ctx.right().querySelector('[data-r="post"]');
    btn.disabled = true; btn.textContent = 'Posting to SAP…';
    try {
      const r = await ctx.api('POST', ctx.cfg.api + '/post', {
        header: { cardCode: f.vendor.code, currency: f.vendor.currency || null, docDate: f.docDate, dueDate: f.dueDate, numAtCard: f.numAtCard, comments: f.comments },
        lines: inc.map(l => ({ itemCode: l.itemCode, qty: num(l.qty), unitPrice: num(l.unitPrice), warehouse: l.warehouse, taxCode: l.taxCode, freeText: l.ocr.description || '' })),
        ocrData: ctx.state.ocrData, fileName: ctx.state.fileName,
      });
      ctx.renderDone([
        ['PO Number', r.docNum], ['Doc Entry', r.docEntry],
        ['Vendor', `${f.vendor.name} (${f.vendor.code})`], ['Lines', r.lines],
      ], 'Scan Another Purchase Order');
    } catch (e) {
      showMsg(ctx, 'err', `<b>SAP did not accept the Purchase Order.</b><br>${esc(e.message)}<br><span style="font-size:11.5px">Fix the field mentioned above and post again — your entries are kept.</span>`);
    }
  }

  function init() {
    window.OcrWorkbench.create({
      panelId: 'ocr-po-scan-panel', navId: 'nav-ocr-po-scan', showFnName: 'showOcrPoScanPanel',
      api: '/api/ocr-po-scan', color: '#6366f1', icon: '📦',
      title: 'Purchase Order Scan Agent',
      subtitle: 'Document on the left · SAP Purchase Order on the right · review, correct and post',
      dropText: 'Upload a supplier PO',
      doneTitle: 'Purchase Order posted to SAP',
      form: poForm,
    });
  }
  if (document.getElementById('ocr-po-scan-panel')) init(); else document.addEventListener('DOMContentLoaded', init);
})();

// ═══════════════════════════════════════════════════════════════════════════
//  Agent 2: Scan Expense Invoice → SAP A/P Invoice (service type, G/L lines)
// ═══════════════════════════════════════════════════════════════════════════
(function () {
  'use strict';
  const { esc, num, fmt, todayStr, plusDays, combo, closeDD, amtScore, avg, sig, lineSig, scorecard, level } = window.OcrWorkbench.ui;

  const expForm = {
    async load(ctx) {
      const { cfg, state, api } = ctx;
      const [prep, look] = await Promise.all([
        api('POST', cfg.api + '/prepare', { ocrData: state.ocrData }),
        api('GET', cfg.api + '/lookups').catch(() => ({ taxCodes: [], localCurrency: null })),
      ]);
      const od = state.ocrData || {};
      const taxCodes = look.taxCodes || [];
      // Suggest a tax code whose rate matches the document's tax ÷ net
      const net = num(od.subtotal) || Math.max(0, num(od.grandTotal) - num(od.taxTotal));
      let taxGuess = '';
      if (taxCodes.length && net > 0) {
        const pct = num(od.taxTotal) / net * 100;
        const hit = taxCodes.find(t => Math.abs(num(t.rate) - pct) < 0.15 && (pct > 0 || /ex/i.test(t.code)));
        if (hit) taxGuess = hit.code;
      }
      state.form = {
        vendor: prep.vendor, vendorChanged: false,
        numAtCard: od.invoiceNumber || '',
        docDate: todayStr(),
        taxDate: od.invoiceDate || todayStr(),
        dueDate: od.dueDate || plusDays(30),
        comments: [od.expenseCategory, od.description].filter(Boolean).join(' — ').slice(0, 250),
        taxCodes, localCurrency: look.localCurrency || null,
        lines: (prep.lines || []).map(l => ({
          include: true,
          description: l.ocrLine?.description || od.description || 'Expense',
          ocrAmount: num(l.ocrLine?.amount),
          amount: num(l.ocrLine?.amount),
          account: l.account ? { code: l.account.code, name: l.account.name, format: l.account.format, score: num(l.account.score) } : null,
          accountSuggested: !!l.account,
          taxCode: taxGuess,
        })),
        msg: null,
      };
      if (!state.form.lines.length) state.form.lines.push(blankLine(taxGuess));
      render(ctx);
    },
  };

  function blankLine(taxCode = '') {
    return { include: true, description: '', ocrAmount: 0, amount: 0, account: null, accountSuggested: false, taxCode };
  }

  const rateOf = (f, code) => num(f.taxCodes.find(t => t.code === code)?.rate);
  const lineTax = (f, l) => num(l.amount) * rateOf(f, l.taxCode) / 100;

  function acctStatus(l) {
    if (!l.account) return ['bad', 'No account'];
    if (l.accountSuggested) return ['warn', 'Suggested'];
    return ['chg', 'Selected'];
  }

  // ── Match scoring ──
  const acctScore = l => (!l.account ? 0 : !l.accountSuggested ? 1 : num(l.account.score));
  const amtLineScore = l => (l.ocrAmount ? amtScore(l.amount, l.ocrAmount) : null);
  function lineScore(l) {
    if (!l.account) return 0;
    const parts = [[acctScore(l), 0.6], [amtLineScore(l), 0.4]].filter(([v]) => v != null);
    const w = parts.reduce((s, [, x]) => s + x, 0);
    return parts.reduce((s, [v, x]) => s + v * x, 0) / w;
  }
  const vendorScore = f => (!f.vendor ? 0 : f.vendorChanged ? 1 : (f.vendor.score ?? 1));

  function criteria(f, od) {
    const inc = f.lines.filter(l => l.include);
    const netT = inc.reduce((s, l) => s + num(l.amount), 0);
    const taxT = inc.reduce((s, l) => s + lineTax(f, l), 0);
    const docNet = num(od.subtotal) || Math.max(0, num(od.grandTotal) - num(od.taxTotal));
    const confirmed = inc.filter(l => acctScore(l) >= 0.9).length;
    const hdr = [!!String(f.numAtCard || '').trim(), !!od.invoiceDate, !!od.dueDate];
    const out = [
      { label: 'Vendor', weight: 25, score: vendorScore(f), blocking: !f.vendor,
        note: !f.vendor ? `"${od.vendorName || '—'}" not found in SAP` : f.vendorChanged ? 'Selected by you' : `"${od.vendorName || '—'}" → ${f.vendor.code}` },
      { label: 'G/L expense accounts', weight: 25, score: inc.length ? avg(inc.map(acctScore)) : 0,
        blocking: !inc.length || inc.some(l => !l.account),
        note: `${confirmed} of ${inc.length} line(s) confirmed${inc.some(l => l.account && l.accountSuggested) ? ' · AI suggestions need a check' : ''}` },
      { label: 'Net amount vs invoice', weight: 15, score: amtScore(netT, docNet),
        note: docNet ? `Form ${fmt(netT)} · invoice ${fmt(docNet)}` : 'No net amount on invoice' },
    ];
    if (f.taxCodes.length) out.push({ label: 'Tax vs invoice', weight: 10, score: amtScore(taxT, od.taxTotal),
      note: num(od.taxTotal) || taxT ? `Form ${fmt(taxT)} · invoice ${fmt(od.taxTotal)}` : 'No tax on either side' });
    out.push(
      { label: 'Total vs invoice', weight: 15, score: amtScore(netT + taxT, od.grandTotal),
        note: num(od.grandTotal) ? `Form ${fmt(netT + taxT)} · invoice ${fmt(od.grandTotal)}` : 'No total on invoice' },
      { label: 'Header details', weight: 10, score: hdr.filter(Boolean).length / hdr.length,
        note: `${hdr[0] ? 'Invoice no. ✓' : 'Invoice no. missing'} · ${hdr[1] ? 'Date ✓' : 'Date not read'} · ${hdr[2] ? 'Due date ✓' : 'Due date not read'}` },
    );
    return out;
  }

  function currencyLabel(f) {
    const c = f.vendor?.currency;
    if (!c || c === '##') return f.localCurrency ? `${f.localCurrency} (local)` : 'Local currency';
    return c === f.localCurrency ? `${c} (local)` : `${c} — foreign, SAP rate used`;
  }

  function cmpRow(label, form, doc) {
    const diff = Math.abs(num(form) - num(doc));
    const ok = !num(doc) || diff < 0.01;
    return `<tr><td>${esc(label)}</td><td class="r">${fmt(form)}</td><td class="r">${num(doc) ? fmt(doc) : '—'}</td>
      <td>${!num(doc) ? '' : ok ? '<span class="owb-pill ok">Matches</span>' : `<span class="owb-pill warn">Diff ${fmt(num(form) - num(doc))}</span>`}</td></tr>`;
  }

  function render(ctx) {
    const f = ctx.state.form, od = ctx.state.ocrData || {};
    const root = ctx.right();
    const hasTax = f.taxCodes.length > 0;
    const taxOpts = ['<option value="">— none —</option>']
      .concat(f.taxCodes.map(t => `<option value="${esc(t.code)}">${esc(t.code)} — ${esc(t.name)} (${t.rate}%)</option>`)).join('');
    const inc = f.lines.filter(l => l.include);
    const noAcct = inc.filter(l => !l.account).length;
    const suggested = inc.filter(l => l.account && l.accountSuggested).length;
    const vState = !f.vendor ? 'bad' : f.vendorChanged ? '' : level(vendorScore(f));

    root.innerHTML = `
      <div class="owb-scroll" data-r="scroll">
        ${f.msg ? `<div class="owb-msg ${f.msg.type}">${f.msg.html}</div>` : ''}
        <div data-r="score"></div>
        ${!f.vendor || noAcct || suggested ? `<div class="owb-msg warn">
            ${!f.vendor ? '⚠️ The vendor on the invoice was not found in SAP — choose one below.<br>' : ''}
            ${noAcct ? `⚠️ ${noAcct} line(s) need a G/L expense account.<br>` : ''}
            ${suggested ? `🔎 ${suggested} line(s) have an AI-suggested account — please confirm it is correct.` : ''}</div>` : ''}

        <div class="owb-card">
          <h4>A/P Invoice (Service) — Header</h4>
          <div class="owb-grid">
            <div class="owb-f" style="grid-column:span 2">
              <label>Vendor <span class="req">*</span> ${sig(vendorScore(f))}</label>
              <input class="owb-in ${vState}" data-r="vendor" placeholder="Search SAP vendor by name or code…"
                value="${f.vendor ? esc(`${f.vendor.code} — ${f.vendor.name}`) : ''}">
              <div class="owb-hint">On invoice: <b>${esc(od.vendorName || '—')}</b>${od.vendorCode ? ` (${esc(od.vendorCode)})` : ''}</div>
            </div>
            <div class="owb-f"><label>Currency</label><input class="owb-in" readonly value="${esc(currencyLabel(f))}"></div>
            <div class="owb-f"><label>Vendor Invoice No.</label><input class="owb-in" data-h="numAtCard" maxlength="100" value="${esc(f.numAtCard)}">
              <div class="owb-hint">On invoice: <b>${esc(od.invoiceNumber || '—')}</b></div></div>
            <div class="owb-f"><label>Posting Date <span class="req">*</span></label><input type="date" class="owb-in" data-h="docDate" value="${esc(f.docDate)}"></div>
            <div class="owb-f"><label>Document Date <span class="req">*</span></label><input type="date" class="owb-in" data-h="taxDate" value="${esc(f.taxDate)}">
              <div class="owb-hint">Invoice date: <b>${esc(od.invoiceDate || '—')}</b></div></div>
            <div class="owb-f"><label>Due Date <span class="req">*</span></label><input type="date" class="owb-in" data-h="dueDate" value="${esc(f.dueDate)}">
              <div class="owb-hint">On invoice: <b>${esc(od.dueDate || '—')}</b></div></div>
            <div class="owb-f" style="grid-column:1/-1"><label>Remarks</label><input class="owb-in" data-h="comments" maxlength="254" value="${esc(f.comments)}"></div>
          </div>
        </div>

        <div class="owb-card" style="padding:14px 0 6px">
          <h4 style="padding:0 14px">Expense Lines <span style="flex:1"></span>
            <button class="owb-btn" data-r="addline" style="padding:4px 10px;font-size:11.5px;text-transform:none;letter-spacing:0">+ Add line</button></h4>
          <div style="overflow-x:auto">
          <table class="owb-tbl">
            <thead><tr>
              <th></th><th style="min-width:170px">Description</th><th style="min-width:230px">G/L Account <span style="color:var(--owb-bad)">*</span></th>
              ${hasTax ? '<th style="min-width:130px">Tax Code</th>' : ''}
              <th class="r">Net Amount</th>${hasTax ? '<th class="r">Tax</th>' : ''}<th class="r">Gross</th><th>Match</th><th></th>
            </tr></thead>
            <tbody>
            ${f.lines.map((l, i) => {
              const [sc, st] = acctStatus(l);
              const tax = lineTax(f, l);
              return `<tr data-i="${i}" class="${l.include ? '' : 'off'} ${l.include && !l.account ? 'rowbad' : ''}">
                <td><input type="checkbox" data-l="include" ${l.include ? 'checked' : ''}></td>
                <td><input class="owb-in" data-l="description" maxlength="100" value="${esc(l.description)}" style="min-width:160px">
                  ${l.ocrAmount ? `<div class="owb-hint">On invoice: <b>${fmt(l.ocrAmount)}</b></div>` : ''}</td>
                <td><input class="owb-in ${sc === 'bad' ? 'bad' : sc === 'warn' ? 'warn' : ''}" data-l="account" style="min-width:220px" placeholder="Search G/L account…"
                  value="${l.account ? esc(`${l.account.format || l.account.code} — ${l.account.name}`) : ''}"></td>
                ${hasTax ? `<td><select class="owb-in" data-l="taxCode" style="min-width:120px">${taxOpts}</select></td>` : ''}
                <td><input class="owb-in r" data-l="amount" inputmode="decimal" style="min-width:96px" value="${esc(l.amount)}"></td>
                ${hasTax ? `<td class="r" data-l="tax" style="padding-top:10px">${fmt(tax)}</td>` : ''}
                <td class="r" data-l="gross" style="padding-top:10px;white-space:nowrap">${fmt(num(l.amount) + tax)}</td>
                <td style="padding-top:9px" data-l="sig">${lineSig(lineScore(l), st)}</td>
                <td><button class="owb-x" data-l="del" title="Remove line">✕</button></td>
              </tr>`;
            }).join('')}
            </tbody>
          </table>
          </div>
        </div>

        <div class="owb-card">
          <h4>Totals — form vs. invoice</h4>
          <table class="owb-tbl" data-r="cmp" style="max-width:520px"></table>
          <div class="owb-hint" style="margin-top:6px">SAP calculates the final tax from the tax code; a difference here usually means the tax code or net amount needs a look.</div>
        </div>
      </div>
      <div class="owb-foot">
        <div class="owb-sum" data-r="sum"></div>
        <span class="sp"></span>
        <button class="owb-btn" data-r="reupload">Re-upload</button>
        <button class="owb-btn pri" data-r="post">Post A/P Invoice to SAP</button>
      </div>`;

    const q = s => root.querySelector(s);
    const rows = [...root.querySelectorAll('tbody tr')];
    rows.forEach((tr, i) => { const tx = tr.querySelector('[data-l="taxCode"]'); if (tx) tx.value = f.lines[i].taxCode; });

    const cur = () => (f.vendor?.currency && f.vendor.currency !== '##' ? f.vendor.currency : (f.localCurrency || ''));
    const updateTotals = () => {
      const incl = f.lines.filter(l => l.include);
      const netT = incl.reduce((s, l) => s + num(l.amount), 0);
      const taxT = incl.reduce((s, l) => s + lineTax(f, l), 0);
      q('[data-r="cmp"]').innerHTML = `<thead><tr><th></th><th class="r">This form</th><th class="r">On invoice</th><th></th></tr></thead><tbody>
        ${cmpRow('Net', netT, od.subtotal)}${hasTax ? cmpRow('Tax', taxT, od.taxTotal) : ''}${cmpRow('Total', netT + taxT, od.grandTotal)}</tbody>`;
      q('[data-r="sum"]').innerHTML = `<span>Lines: <b>${incl.length}</b></span><span>Total: <b>${esc(cur())} ${fmt(netT + taxT)}</b></span>`;
      q('[data-r="score"]').innerHTML = scorecard(criteria(f, od)).html;
      rows.forEach((tr, i) => { const l = f.lines[i]; tr.querySelector('[data-l="sig"]').innerHTML = lineSig(lineScore(l), acctStatus(l)[1]); });
    };
    updateTotals();

    root.querySelectorAll('[data-h]').forEach(el => el.addEventListener('input', () => { f[el.dataset.h] = el.value; updateTotals(); }));

    const vIn = q('[data-r="vendor"]');
    combo(vIn, {
      search: async s => (await ctx.api('GET', `${ctx.cfg.api}/vendors?q=${encodeURIComponent(s)}`)).vendors,
      label: v => `<span class="c">${esc(v.code)}</span>${esc(v.name)}${v.currency ? ` <span style="color:var(--muted)">· ${esc(v.currency)}</span>` : ''}`,
      onPick: v => { f.vendor = v; f.vendorChanged = true; f.msg = null; render(ctx); },
      onBlur: () => { vIn.value = f.vendor ? `${f.vendor.code} — ${f.vendor.name}` : ''; },
    });

    rows.forEach((tr, i) => {
      const l = f.lines[i];
      const refresh = () => {
        const tax = lineTax(f, l);
        const tEl = tr.querySelector('[data-l="tax"]'); if (tEl) tEl.textContent = fmt(tax);
        tr.querySelector('[data-l="gross"]').textContent = fmt(num(l.amount) + tax);
        updateTotals();
      };
      tr.querySelector('[data-l="include"]').addEventListener('change', e => { l.include = e.target.checked; render(ctx); });
      tr.querySelector('[data-l="del"]').addEventListener('click', () => { f.lines.splice(i, 1); if (!f.lines.length) f.lines.push(blankLine()); render(ctx); });
      tr.querySelector('[data-l="description"]').addEventListener('input', e => { l.description = e.target.value; });
      tr.querySelector('[data-l="amount"]').addEventListener('input', e => { l.amount = e.target.value; refresh(); });
      tr.querySelector('[data-l="taxCode"]')?.addEventListener('change', e => { l.taxCode = e.target.value; refresh(); });
      const aIn = tr.querySelector('[data-l="account"]');
      if (!l.account) aIn.dataset.q = (od.expenseCategory || '').slice(0, 30);
      combo(aIn, {
        search: async s => (await ctx.api('GET', `${ctx.cfg.api}/gl-accounts?q=${encodeURIComponent(s)}`)).accounts,
        label: a => `<span class="c">${esc(a.format || a.code)}</span>${esc(a.name)}`,
        onPick: a => { l.account = a; l.accountSuggested = false; l.include = true; render(ctx); },
        onBlur: () => { aIn.value = l.account ? `${l.account.format || l.account.code} — ${l.account.name}` : ''; },
      });
    });

    q('[data-r="addline"]').addEventListener('click', () => { f.lines.push(blankLine(f.lines[0]?.taxCode || '')); render(ctx); });
    q('[data-r="reupload"]').addEventListener('click', () => ctx.pickFile());
    q('[data-r="post"]').addEventListener('click', () => post(ctx));
  }

  function showMsg(ctx, type, html) {
    ctx.state.form.msg = { type, html };
    render(ctx);
    const sc = ctx.right().querySelector('[data-r="scroll"]'); if (sc) sc.scrollTop = 0;
  }

  async function post(ctx) {
    closeDD();
    const f = ctx.state.form;
    const inc = f.lines.filter(l => l.include);
    const errs = [];
    if (!f.vendor) errs.push('Select a vendor.');
    if (!f.docDate || !f.taxDate || !f.dueDate) errs.push('Fill in the posting, document and due dates.');
    if (!inc.length) errs.push('Tick at least one line.');
    inc.forEach(l => {
      const n = f.lines.indexOf(l) + 1;
      if (!l.account) errs.push(`Line ${n}: choose a G/L expense account (or untick the line).`);
      if (!(num(l.amount) > 0)) errs.push(`Line ${n}: net amount must be greater than 0.`);
    });
    if (errs.length) return showMsg(ctx, 'err', '<b>Please fix before posting:</b><br>' + errs.map(esc).join('<br>'));

    const btn = ctx.right().querySelector('[data-r="post"]');
    btn.disabled = true; btn.textContent = 'Posting to SAP…';
    try {
      const r = await ctx.api('POST', ctx.cfg.api + '/post', {
        header: { cardCode: f.vendor.code, currency: f.vendor.currency || null, docDate: f.docDate, taxDate: f.taxDate, dueDate: f.dueDate, numAtCard: f.numAtCard, comments: f.comments },
        lines: inc.map(l => ({ description: l.description, accountCode: l.account.code, amount: num(l.amount), taxCode: l.taxCode })),
        ocrData: ctx.state.ocrData, fileName: ctx.state.fileName,
      });
      ctx.renderDone([
        ['A/P Invoice No.', r.docNum], ['Doc Entry', r.docEntry],
        ['Vendor', `${f.vendor.name} (${f.vendor.code})`], ['Lines', r.lines],
        ...(r.docTotal != null ? [['Document Total (SAP)', fmt(r.docTotal)]] : []),
      ], 'Scan Another Expense Invoice');
    } catch (e) {
      showMsg(ctx, 'err', `<b>SAP did not accept the A/P Invoice.</b><br>${esc(e.message)}<br><span style="font-size:11.5px">Fix the field mentioned above and post again — your entries are kept.</span>`);
    }
  }

  function init() {
    window.OcrWorkbench.create({
      panelId: 'ocr-expense-panel', navId: 'nav-ocr-expense', showFnName: 'showOcrExpensePanel',
      api: '/api/ocr-expense', color: '#f59e0b', icon: '🧾',
      title: 'Expense Invoice Scan Agent',
      subtitle: 'Invoice on the left · SAP A/P Invoice (service) on the right · review, correct and post',
      dropText: 'Upload a supplier expense invoice (courier, rent, telephone, fees…)',
      doneTitle: 'A/P Invoice posted to SAP',
      form: expForm,
    });
  }
  if (document.getElementById('ocr-expense-panel')) init(); else document.addEventListener('DOMContentLoaded', init);
})();

// ═══════════════════════════════════════════════════════════════════════════
//  Agent 3: Scan Inward → Inward Register (vendor / items / warehouse / open PO checked in SAP)
// ═══════════════════════════════════════════════════════════════════════════
(function () {
  'use strict';
  const { esc, num, fmt, todayStr, combo, closeDD, amtScore, avg, sig, lineSig, scorecard, level } = window.OcrWorkbench.ui;

  const inwForm = {
    async load(ctx) {
      const { cfg, state, api } = ctx;
      const prep = await api('POST', cfg.api + '/prepare', { ocrData: state.ocrData });
      const od = state.ocrData || {};
      state.form = {
        challanNumber: od.challanNumber || '', challanDate: od.challanDate || todayStr(),
        vehicleNumber: od.vehicleNumber || '', driverName: od.driverName || '',
        fromParty: od.fromParty || '', vendor: prep.vendor, vendorChanged: false,
        warehouses: prep.warehouses || [], warehouse: prep.warehouse?.code || '', warehouseScore: prep.warehouse?.score ?? null, warehouseChanged: false,
        pos: prep.pos || [], poDocEntry: prep.po || '', poAuto: !!prep.po,
        remarks: od.remarks || '',
        duplicate: prep.duplicate || null, allowDuplicate: false,
        lines: (prep.lines || []).map(l => ({
          include: true, ocr: l.ocrLine || {},
          itemCode: l.match?.code || '', itemName: l.match?.name || '', unit: l.match?.unit || l.ocrLine?.unit || '',
          score: l.match ? l.match.score : 0, changed: false,
          qty: num(l.ocrLine?.quantity),
        })),
        msg: null,
      };
      if (!state.form.lines.length) state.form.lines.push(blankLine());
      render(ctx);
    },
  };

  const blankLine = () => ({ include: true, ocr: {}, itemCode: '', itemName: '', unit: '', score: 0, changed: true, qty: 0 });
  const curPO = f => f.pos.find(p => String(p.docEntry) === String(f.poDocEntry)) || null;
  const poLine = (f, l) => { const po = curPO(f); return po && l.itemCode ? po.lines.find(x => x.itemCode === l.itemCode) || null : null; };

  const itemScore = l => (!l.itemCode ? 0 : l.changed ? 1 : num(l.score));
  const poQtyScore = (f, l) => {
    if (!curPO(f)) return null;
    const pl = poLine(f, l);
    if (!pl) return 0;
    const q = num(l.qty);
    if (!q) return null;
    return q <= pl.openQty + 1e-9 ? 1 : Math.max(0, pl.openQty / q);
  };
  function lineScore(f, l) {
    if (!l.itemCode) return 0;
    const parts = [[itemScore(l), 0.7], [poQtyScore(f, l), 0.3]].filter(([v]) => v != null);
    const w = parts.reduce((s, [, x]) => s + x, 0);
    const sc = parts.reduce((s, [v, x]) => s + v * x, 0) / w;
    const pl = poLine(f, l);
    if (curPO(f) && !pl) return Math.min(sc, 0.69);                 // item not on the linked PO
    if (pl && num(l.qty) > pl.openQty) return Math.min(sc, 0.79);    // over-receipt → at best amber
    return sc;
  }
  function lineStatus(f, l) {
    if (!l.itemCode) return 'Not in SAP';
    const pl = curPO(f) ? poLine(f, l) : undefined;
    if (pl === null) return 'Not on PO';
    if (pl && num(l.qty) > pl.openQty) return `Over PO by ${fmt(num(l.qty) - pl.openQty, 0)}`;
    if (l.changed) return 'Selected';
    return l.score >= 0.9 ? 'Matched' : 'Check match';
  }
  const vendorScore = f => (!f.vendor ? 0 : f.vendorChanged ? 1 : (f.vendor.score ?? 1));

  function criteria(f) {
    const inc = f.lines.filter(l => l.include);
    const po = curPO(f);
    const hdr = [!!f.challanNumber.trim(), !!f.challanDate, !!f.vehicleNumber.trim()];
    const good = inc.filter(l => itemScore(l) >= 0.9).length;
    const out = [
      { label: 'Duplicate check', weight: 15, score: f.duplicate && !f.allowDuplicate ? 0 : 1, blocking: !!(f.duplicate && !f.allowDuplicate),
        note: f.duplicate ? `Same challan already logged as entry #${f.duplicate.id}${f.allowDuplicate ? ' — saving anyway' : ''}` : 'Not in the register yet' },
      { label: 'Challan details', weight: 20, score: hdr.filter(Boolean).length / hdr.length, blocking: !hdr[0] && !hdr[2],
        note: `${hdr[0] ? 'Challan no. ✓' : 'Challan no. missing'} · ${hdr[1] ? 'Date ✓' : 'Date missing'} · ${hdr[2] ? 'Vehicle ✓' : 'Vehicle no. missing'}` },
      { label: 'Supplier in SAP', weight: 20, score: vendorScore(f),
        note: !f.vendor ? `"${f.fromParty || '—'}" is not an SAP vendor — will be saved as text` : f.vendorChanged ? 'Selected by you' : `"${f.fromParty || '—'}" → ${f.vendor.code}` },
      { label: 'Materials vs SAP items', weight: 25, score: inc.length ? avg(inc.map(itemScore)) : 0, blocking: !inc.length,
        note: `${good} of ${inc.length} line(s) matched` },
    ];
    if (f.vendor) {
      out.push({ label: 'Purchase order link', weight: 10,
        score: po ? 1 : f.pos.length ? 0.5 : null,
        note: po ? `PO ${po.docNum}${f.poAuto ? ' (from challan reference)' : ''}` : f.pos.length ? `Vendor has ${f.pos.length} open PO(s) — link one to check quantities` : 'Vendor has no open POs' });
    }
    if (po) {
      const withQ = inc.filter(l => poQtyScore(f, l) != null);
      const over = inc.filter(l => { const pl = poLine(f, l); return pl && num(l.qty) > pl.openQty; }).length;
      const off = inc.filter(l => l.itemCode && !poLine(f, l)).length;
      out.push({ label: 'Quantities vs PO open qty', weight: 10, score: avg(withQ.map(l => poQtyScore(f, l))),
        note: over || off ? [over ? `${over} line(s) exceed open qty` : '', off ? `${off} item(s) not on PO ${po.docNum}` : ''].filter(Boolean).join(' · ') : 'All within the open PO quantity' });
    }
    return out;
  }

  function render(ctx) {
    const f = ctx.state.form, od = ctx.state.ocrData || {};
    const root = ctx.right();
    const po = curPO(f);
    const whOpts = ['<option value="">— not set —</option>'].concat(f.warehouses.map(w => `<option value="${esc(w.code)}">${esc(w.code)}${w.name ? ' — ' + esc(w.name) : ''}</option>`)).join('');
    const poOpts = [`<option value="">${f.pos.length ? '— not linked —' : f.vendor ? 'No open POs for this vendor' : 'Pick a vendor first'}</option>`]
      .concat(f.pos.map(p => `<option value="${p.docEntry}">PO ${p.docNum} · ${esc(p.docDate)} · ${p.lines.length} open line(s)${p.numAtCard ? ' · ref ' + esc(p.numAtCard) : ''}</option>`)).join('');

    root.innerHTML = `
      <div class="owb-scroll" data-r="scroll">
        ${f.msg ? `<div class="owb-msg ${f.msg.type}">${f.msg.html}</div>` : ''}
        <div data-r="score"></div>
        ${f.duplicate && !f.allowDuplicate ? `<div class="owb-msg err">🔁 <b>Possible duplicate:</b> challan ${esc(f.challanNumber)} dated ${esc(f.challanDate)} is already in the register as entry #${f.duplicate.id}
            (${esc(f.duplicate.uploadedAt || '')}${f.duplicate.uploadedBy ? ', by ' + esc(f.duplicate.uploadedBy) : ''}).
            <button class="owb-btn" data-r="allowdup" style="margin-left:8px;padding:3px 10px;font-size:11.5px">It's a different delivery — allow</button></div>` : ''}

        <div class="owb-card">
          <h4>Inward Entry — Challan</h4>
          <div class="owb-grid">
            <div class="owb-f"><label>Challan No.</label><input class="owb-in" data-h="challanNumber" value="${esc(f.challanNumber)}">
              <div class="owb-hint">On document: <b>${esc(od.challanNumber || '—')}</b></div></div>
            <div class="owb-f"><label>Challan Date</label><input type="date" class="owb-in" data-h="challanDate" value="${esc(f.challanDate)}">
              <div class="owb-hint">On document: <b>${esc(od.challanDate || '—')}</b></div></div>
            <div class="owb-f"><label>Vehicle No.</label><input class="owb-in" data-h="vehicleNumber" value="${esc(f.vehicleNumber)}" style="text-transform:uppercase"></div>
            <div class="owb-f"><label>Driver</label><input class="owb-in" data-h="driverName" value="${esc(f.driverName)}"></div>
            <div class="owb-f" style="grid-column:span 2">
              <label>Supplier (SAP) ${sig(vendorScore(f))}</label>
              <input class="owb-in ${f.vendor ? (f.vendorChanged ? '' : level(vendorScore(f))) : 'warn'}" data-r="vendor" placeholder="Search SAP vendor… (optional)"
                value="${f.vendor ? esc(`${f.vendor.code} — ${f.vendor.name}`) : ''}">
              <div class="owb-hint">On document: <b>${esc(f.fromParty || '—')}</b>${f.vendor ? ' · <a href="#" data-r="clearvendor">clear</a>' : ''}</div>
            </div>
            <div class="owb-f"><label>Received At (Warehouse) ${f.warehouse ? sig(f.warehouseChanged ? 1 : f.warehouseScore ?? 1) : ''}</label><select class="owb-in" data-r="warehouse">${whOpts}</select>
              <div class="owb-hint">On document: <b>${esc(od.toLocation || '—')}</b></div></div>
            <div class="owb-f" style="grid-column:span 2"><label>Against Purchase Order</label><select class="owb-in" data-r="po" ${f.vendor ? '' : 'disabled'}>${poOpts}</select>
              <div class="owb-hint">PO ref. on document: <b>${esc(od.poNumber || '—')}</b></div></div>
            <div class="owb-f" style="grid-column:1/-1"><label>Remarks</label><input class="owb-in" data-h="remarks" maxlength="254" value="${esc(f.remarks)}"></div>
          </div>
        </div>

        <div class="owb-card" style="padding:14px 0 6px">
          <h4 style="padding:0 14px">Materials Received <span style="flex:1"></span>
            <button class="owb-btn" data-r="addline" style="padding:4px 10px;font-size:11.5px;text-transform:none;letter-spacing:0">+ Add line</button></h4>
          <div style="overflow-x:auto">
          <table class="owb-tbl">
            <thead><tr><th></th><th>On document</th><th style="min-width:220px">SAP Item</th><th class="r">Qty Received</th><th>UoM</th>
              ${po ? '<th class="r">PO Open Qty</th>' : ''}<th>Match</th><th></th></tr></thead>
            <tbody>
            ${f.lines.map((l, i) => {
              const pl = po ? poLine(f, l) : null;
              return `<tr data-i="${i}" class="${l.include ? '' : 'off'} ${l.include && !l.itemCode ? 'rowbad' : ''}">
                <td><input type="checkbox" data-l="include" ${l.include ? 'checked' : ''}></td>
                <td class="ocr">${l.ocr.description ? esc(l.ocr.description) : '<i>added manually</i>'}
                  ${l.ocr.quantity ? `<div class="m">${esc(l.ocr.quantity)} ${esc(l.ocr.unit || '')}</div>` : ''}</td>
                <td><input class="owb-in ${!l.itemCode ? 'bad' : !l.changed && l.score < 0.9 ? 'warn' : ''}" data-l="item" style="min-width:210px" placeholder="Search item…"
                  value="${l.itemCode ? esc(`${l.itemCode} — ${l.itemName}`) : ''}"></td>
                <td><input class="owb-in r" data-l="qty" inputmode="decimal" style="min-width:84px" value="${esc(l.qty)}"></td>
                <td style="font-size:11px;padding-top:10px">${esc(l.unit || '—')}</td>
                ${po ? `<td class="r" style="padding-top:10px">${pl ? fmt(pl.openQty, 2) : '<span style="color:var(--owb-bad)">not on PO</span>'}</td>` : ''}
                <td style="padding-top:9px" data-l="sig"></td>
                <td><button class="owb-x" data-l="del" title="Remove line">✕</button></td>
              </tr>`;
            }).join('')}
            </tbody>
          </table>
          </div>
        </div>
      </div>
      <div class="owb-foot">
        <div class="owb-sum" data-r="sum"></div>
        <span class="sp"></span>
        <button class="owb-btn" data-r="reupload">Re-upload</button>
        <button class="owb-btn pri" data-r="save">Save to Inward Register</button>
      </div>`;

    const q = s => root.querySelector(s);
    const rows = [...root.querySelectorAll('tbody tr')];
    q('[data-r="warehouse"]').value = f.warehouse;
    q('[data-r="po"]').value = f.poDocEntry || '';

    const update = () => {
      q('[data-r="score"]').innerHTML = scorecard(criteria(f)).html;
      rows.forEach((tr, i) => { const l = f.lines[i]; tr.querySelector('[data-l="sig"]').innerHTML = lineSig(lineScore(f, l), lineStatus(f, l)); });
      const inc = f.lines.filter(l => l.include);
      q('[data-r="sum"]').innerHTML = `<span>Lines: <b>${inc.length}</b></span><span>Total qty: <b>${fmt(inc.reduce((s, l) => s + num(l.qty), 0), 2)}</b></span>`;
    };
    update();

    root.querySelectorAll('[data-h]').forEach(el => el.addEventListener('input', () => { f[el.dataset.h] = el.value; update(); }));
    q('[data-r="warehouse"]').addEventListener('change', e => { f.warehouse = e.target.value; f.warehouseChanged = true; render(ctx); });
    q('[data-r="po"]').addEventListener('change', e => { f.poDocEntry = e.target.value; f.poAuto = false; render(ctx); });
    q('[data-r="allowdup"]')?.addEventListener('click', () => { f.allowDuplicate = true; render(ctx); });
    q('[data-r="clearvendor"]')?.addEventListener('click', e => { e.preventDefault(); Object.assign(f, { vendor: null, pos: [], poDocEntry: '' }); render(ctx); });

    const vIn = q('[data-r="vendor"]');
    combo(vIn, {
      search: async s => (await ctx.api('GET', `${ctx.cfg.api}/vendors?q=${encodeURIComponent(s)}`)).vendors,
      onPick: async v => {
        Object.assign(f, { vendor: v, vendorChanged: true, pos: [], poDocEntry: '', poAuto: false, msg: null });
        render(ctx);
        try { f.pos = (await ctx.api('GET', `${ctx.cfg.api}/open-pos?cardCode=${encodeURIComponent(v.code)}`)).pos || []; } catch { f.pos = []; }
        render(ctx);
      },
      onBlur: () => { vIn.value = f.vendor ? `${f.vendor.code} — ${f.vendor.name}` : ''; },
    });

    rows.forEach((tr, i) => {
      const l = f.lines[i];
      tr.querySelector('[data-l="include"]').addEventListener('change', e => { l.include = e.target.checked; render(ctx); });
      tr.querySelector('[data-l="del"]').addEventListener('click', () => { f.lines.splice(i, 1); if (!f.lines.length) f.lines.push(blankLine()); render(ctx); });
      tr.querySelector('[data-l="qty"]').addEventListener('input', e => { l.qty = e.target.value; update(); });
      const itIn = tr.querySelector('[data-l="item"]');
      if (!l.itemCode) itIn.dataset.q = (l.ocr.description || '').slice(0, 30);
      combo(itIn, {
        // With a PO linked, offer that PO's open lines first
        search: async s => {
          const poItems = (curPO(f)?.lines || []).filter(x => !s || (x.itemCode + ' ' + x.description).toLowerCase().includes(s.toLowerCase()))
            .map(x => ({ code: x.itemCode, name: x.description, unit: x.uom, onPo: x.openQty }));
          const sap = (await ctx.api('GET', `${ctx.cfg.api}/items?q=${encodeURIComponent(s)}`)).items.filter(it => !poItems.some(p => p.code === it.code));
          return [...poItems, ...sap];
        },
        label: it => `<span class="c">${esc(it.code)}</span>${esc(it.name)}${it.onPo != null ? ` <span class="owb-sig ok" style="margin-left:4px">on PO · open ${fmt(it.onPo, 0)}</span>` : ''}`,
        onPick: it => { Object.assign(l, { itemCode: it.code, itemName: it.name, unit: it.unit || l.unit, changed: true, include: true }); render(ctx); },
        onBlur: () => { itIn.value = l.itemCode ? `${l.itemCode} — ${l.itemName}` : ''; },
      });
    });

    q('[data-r="addline"]').addEventListener('click', () => { f.lines.push(blankLine()); render(ctx); });
    q('[data-r="reupload"]').addEventListener('click', () => ctx.pickFile());
    q('[data-r="save"]').addEventListener('click', () => save(ctx));
  }

  function showMsg(ctx, type, html) {
    ctx.state.form.msg = { type, html };
    render(ctx);
    const sc = ctx.right().querySelector('[data-r="scroll"]'); if (sc) sc.scrollTop = 0;
  }

  async function save(ctx) {
    closeDD();
    const f = ctx.state.form, po = curPO(f);
    const inc = f.lines.filter(l => l.include);
    const errs = [];
    if (!f.challanNumber.trim() && !f.vehicleNumber.trim()) errs.push('Enter the challan no. or the vehicle no.');
    if (!inc.length) errs.push('Tick at least one material line.');
    inc.forEach(l => { if (!l.itemCode && !(l.ocr.description || '').trim()) errs.push(`Line ${f.lines.indexOf(l) + 1}: choose an item or remove the line.`); });
    if (f.duplicate && !f.allowDuplicate) errs.push('This challan is already in the register — confirm it is a different delivery first.');
    if (errs.length) return showMsg(ctx, 'err', '<b>Please fix before saving:</b><br>' + errs.map(esc).join('<br>'));

    const btn = ctx.right().querySelector('[data-r="save"]');
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
      const r = await ctx.api('POST', ctx.cfg.api + '/save', {
        form: {
          header: {
            challanNumber: f.challanNumber.trim(), challanDate: f.challanDate, vehicleNumber: f.vehicleNumber.trim().toUpperCase(), driverName: f.driverName,
            fromParty: f.fromParty, vendor: f.vendor ? { code: f.vendor.code, name: f.vendor.name } : null,
            warehouse: f.warehouse, poDocEntry: po?.docEntry || null, poDocNum: po?.docNum || null, remarks: f.remarks,
            matchScore: Math.round((scorecard(criteria(f)).overall || 0) * 100),
          },
          lines: inc.map(l => ({ description: l.ocr.description || l.itemName, itemCode: l.itemCode, itemName: l.itemName, qty: num(l.qty), unit: l.unit, poOpenQty: poLine(f, l)?.openQty ?? null })),
        },
        ocrData: ctx.state.ocrData, fileName: ctx.state.fileName, allowDuplicate: f.allowDuplicate,
      });
      ctx.renderDone([
        ['Register Entry', `#${r.id}`], ['Challan', `${f.challanNumber || '—'} · ${f.challanDate || ''}`],
        ['Vehicle', f.vehicleNumber || '—'], ['Supplier', f.vendor ? `${f.vendor.name} (${f.vendor.code})` : (f.fromParty || '—')],
        ['Against PO', po ? `PO ${po.docNum}` : '—'], ['Lines', inc.length],
      ], 'Scan Another Inward Slip');
    } catch (e) {
      if (e.data?.duplicate) { f.duplicate = e.data.duplicate; f.allowDuplicate = false; }
      showMsg(ctx, 'err', `<b>Could not save.</b><br>${esc(e.message)}`);
    }
  }

  function init() {
    window.OcrWorkbench.create({
      panelId: 'ocr-inward-panel', navId: 'nav-ocr-inward', showFnName: 'showOcrInwardPanel',
      api: '/api/ocr-inward', color: '#16a34a', icon: '📥',
      title: 'Inward Register Agent',
      subtitle: 'Challan on the left · inward entry on the right · checked against SAP vendor, items and open POs',
      dropText: 'Upload a delivery challan / inward slip',
      doneTitle: 'Logged to the Inward Register',
      form: inwForm,
    });
  }
  if (document.getElementById('ocr-inward-panel')) init(); else document.addEventListener('DOMContentLoaded', init);
})();

// ═══════════════════════════════════════════════════════════════════════════
//  Agent 4: Scan Gate Pass → Gate Pass Register
// ═══════════════════════════════════════════════════════════════════════════
(function () {
  'use strict';
  const { esc, todayStr, combo, closeDD, avg, sig, scorecard, level } = window.OcrWorkbench.ui;

  const TYPES = ['visitor', 'vehicle', 'material', 'other'];
  const toMin = t => { const m = /^(\d{1,2}):(\d{2})/.exec(t || ''); return m ? (+m[1]) * 60 + (+m[2]) : null; };

  const gpForm = {
    async load(ctx) {
      const { cfg, state, api } = ctx;
      const prep = await api('POST', cfg.api + '/prepare', { ocrData: state.ocrData });
      const od = state.ocrData || {};
      const t = String(od.passType || '').toLowerCase();
      state.form = {
        passNumber: od.passNumber || '', passDate: od.passDate || todayStr(),
        passType: TYPES.includes(t) ? t : 'other', direction: /out/i.test(od.direction || '') ? 'out' : 'in',
        personOrVehicle: od.personOrVehicle || '', company: od.company || '',
        partner: prep.partner, partnerChanged: false,
        purpose: od.purpose || '', materialDescription: od.materialDescription || '',
        timeIn: /^\d{1,2}:\d{2}/.test(od.timeIn || '') ? od.timeIn.slice(0, 5).padStart(5, '0') : '',
        timeOut: /^\d{1,2}:\d{2}/.test(od.timeOut || '') ? od.timeOut.slice(0, 5).padStart(5, '0') : '',
        authorizedBy: od.authorizedBy || '',
        duplicate: prep.duplicate || null, allowDuplicate: false, msg: null,
      };
      render(ctx);
    },
  };

  const partnerScore = f => (f.partner ? (f.partnerChanged ? 1 : (f.partner.score ?? 1)) : (f.company.trim() ? 0.5 : null));

  function criteria(f) {
    const req = [['Pass no.', f.passNumber], ['Date', f.passDate], ['Person / vehicle', f.personOrVehicle], ['Purpose', f.purpose], ['Authorised by', f.authorizedBy]];
    const missing = req.filter(([, v]) => !String(v || '').trim()).map(([k]) => k);
    const tin = toMin(f.timeIn), tout = toMin(f.timeOut);
    const timeOk = tin != null && tout != null ? (tout >= tin ? 1 : 0.3) : null;
    const out = [
      { label: 'Duplicate check', weight: 20, score: f.duplicate && !f.allowDuplicate ? 0 : 1, blocking: !!(f.duplicate && !f.allowDuplicate),
        note: f.duplicate ? `Same pass already logged as entry #${f.duplicate.id}${f.allowDuplicate ? ' — saving anyway' : ''}` : 'Not in the register yet' },
      { label: 'Required details', weight: 35, score: (req.length - missing.length) / req.length, blocking: !String(f.personOrVehicle).trim(),
        note: missing.length ? `Missing: ${missing.join(', ')}` : 'All required details captured' },
      { label: 'In / out times', weight: 15, score: avg([tin != null ? 1 : 0, timeOk]),
        note: tin == null ? 'Time in not captured' : timeOk === 0.3 ? 'Time out is before time in' : tout == null ? `In ${f.timeIn} · not out yet` : `In ${f.timeIn} · out ${f.timeOut}` },
      { label: 'Company in SAP', weight: 15, score: partnerScore(f),
        note: f.partner ? (f.partnerChanged ? 'Selected by you' : `"${f.company || '—'}" → ${f.partner.code}`) : f.company.trim() ? `"${f.company}" is not an SAP business partner` : 'No company on the pass' },
    ];
    if (f.passType === 'material') out.push({ label: 'Material details', weight: 15, score: f.materialDescription.trim() ? 1 : 0,
      note: f.materialDescription.trim() ? 'Material described' : 'Material pass without a material description' });
    return out;
  }

  function render(ctx) {
    const f = ctx.state.form, od = ctx.state.ocrData || {};
    const root = ctx.right();
    const ps = partnerScore(f);
    root.innerHTML = `
      <div class="owb-scroll" data-r="scroll">
        ${f.msg ? `<div class="owb-msg ${f.msg.type}">${f.msg.html}</div>` : ''}
        <div data-r="score"></div>
        ${f.duplicate && !f.allowDuplicate ? `<div class="owb-msg err">🔁 <b>Possible duplicate:</b> gate pass ${esc(f.passNumber)} dated ${esc(f.passDate)} is already in the register as entry #${f.duplicate.id}
            (${esc(f.duplicate.uploadedAt || '')}${f.duplicate.uploadedBy ? ', by ' + esc(f.duplicate.uploadedBy) : ''}).
            <button class="owb-btn" data-r="allowdup" style="margin-left:8px;padding:3px 10px;font-size:11.5px">It's a different pass — allow</button></div>` : ''}
        <div class="owb-card">
          <h4>Gate Pass</h4>
          <div class="owb-grid">
            <div class="owb-f"><label>Pass No.</label><input class="owb-in" data-h="passNumber" value="${esc(f.passNumber)}">
              <div class="owb-hint">On pass: <b>${esc(od.passNumber || '—')}</b></div></div>
            <div class="owb-f"><label>Date</label><input type="date" class="owb-in" data-h="passDate" value="${esc(f.passDate)}">
              <div class="owb-hint">On pass: <b>${esc(od.passDate || '—')}</b></div></div>
            <div class="owb-f"><label>Pass Type</label><select class="owb-in" data-h="passType">${TYPES.map(t => `<option value="${t}">${t[0].toUpperCase() + t.slice(1)}</option>`).join('')}</select>
              <div class="owb-hint">On pass: <b>${esc(od.passType || '—')}</b></div></div>
            <div class="owb-f"><label>Direction</label><select class="owb-in" data-h="direction"><option value="in">In</option><option value="out">Out</option></select></div>
            <div class="owb-f" style="grid-column:span 2"><label>${f.passType === 'vehicle' ? 'Vehicle No.' : 'Visitor / Vehicle'} <span class="req">*</span></label>
              <input class="owb-in ${f.personOrVehicle.trim() ? '' : 'bad'}" data-h="personOrVehicle" value="${esc(f.personOrVehicle)}"></div>
            <div class="owb-f" style="grid-column:span 2"><label>Company ${ps != null ? sig(ps) : ''}</label>
              <input class="owb-in ${f.partner && !f.partnerChanged ? level(ps) : ''}" data-r="partner" placeholder="Search SAP customer / vendor… or leave as text"
                value="${f.partner ? esc(`${f.partner.code} — ${f.partner.name}`) : esc(f.company)}">
              <div class="owb-hint">On pass: <b>${esc(od.company || '—')}</b>${f.partner ? ' · <a href="#" data-r="clearpartner">not this partner</a>' : ''}</div></div>
            <div class="owb-f" style="grid-column:span 2"><label>Purpose</label><input class="owb-in" data-h="purpose" value="${esc(f.purpose)}"></div>
            <div class="owb-f" style="grid-column:span 2;${f.passType === 'material' ? '' : 'display:none'}"><label>Material</label>
              <input class="owb-in ${f.passType === 'material' && !f.materialDescription.trim() ? 'warn' : ''}" data-h="materialDescription" value="${esc(f.materialDescription)}"></div>
            <div class="owb-f"><label>Time In</label><input type="time" class="owb-in" data-h="timeIn" value="${esc(f.timeIn)}">
              <div class="owb-hint">On pass: <b>${esc(od.timeIn || '—')}</b></div></div>
            <div class="owb-f"><label>Time Out</label><input type="time" class="owb-in" data-h="timeOut" value="${esc(f.timeOut)}">
              <div class="owb-hint">On pass: <b>${esc(od.timeOut || '—')}</b></div></div>
            <div class="owb-f"><label>Authorised By</label><input class="owb-in" data-h="authorizedBy" value="${esc(f.authorizedBy)}"></div>
          </div>
        </div>
      </div>
      <div class="owb-foot">
        <div class="owb-sum"><span>${esc(f.passType)} · ${esc(f.direction)}</span></div>
        <span class="sp"></span>
        <button class="owb-btn" data-r="reupload">Re-upload</button>
        <button class="owb-btn pri" data-r="save">Save to Gate Pass Register</button>
      </div>`;

    const q = s => root.querySelector(s);
    q('[data-h="passType"]').value = f.passType;
    q('[data-h="direction"]').value = f.direction;
    const update = () => { q('[data-r="score"]').innerHTML = scorecard(criteria(f)).html; };
    update();
    root.querySelectorAll('[data-h]').forEach(el => {
      const ev = el.tagName === 'SELECT' ? 'change' : 'input';
      el.addEventListener(ev, () => { f[el.dataset.h] = el.value; if (el.tagName === 'SELECT') render(ctx); else update(); });
    });
    q('[data-r="allowdup"]')?.addEventListener('click', () => { f.allowDuplicate = true; render(ctx); });
    q('[data-r="clearpartner"]')?.addEventListener('click', e => { e.preventDefault(); f.partner = null; render(ctx); });

    const pIn = q('[data-r="partner"]');
    pIn.addEventListener('input', () => { if (!f.partner) { f.company = pIn.value; update(); } });
    combo(pIn, {
      search: async s => (await ctx.api('GET', `${ctx.cfg.api}/partners?q=${encodeURIComponent(s)}`)).partners,
      label: p => `<span class="c">${esc(p.code)}</span>${esc(p.name)} <span style="color:var(--muted)">· ${p.type === 'cCustomer' ? 'Customer' : p.type === 'cSupplier' ? 'Vendor' : 'Lead'}</span>`,
      onPick: p => { f.partner = p; f.partnerChanged = true; f.company = p.name; render(ctx); },
      onBlur: () => { pIn.value = f.partner ? `${f.partner.code} — ${f.partner.name}` : f.company; },
    });
    q('[data-r="reupload"]').addEventListener('click', () => ctx.pickFile());
    q('[data-r="save"]').addEventListener('click', () => save(ctx));
  }

  function showMsg(ctx, type, html) {
    ctx.state.form.msg = { type, html };
    render(ctx);
    const sc = ctx.right().querySelector('[data-r="scroll"]'); if (sc) sc.scrollTop = 0;
  }

  async function save(ctx) {
    closeDD();
    const f = ctx.state.form;
    const errs = [];
    if (!f.personOrVehicle.trim()) errs.push('Enter the visitor name or vehicle number.');
    const tin = toMin(f.timeIn), tout = toMin(f.timeOut);
    if (tin != null && tout != null && tout < tin) errs.push('Time out is before time in.');
    if (f.duplicate && !f.allowDuplicate) errs.push('This pass is already in the register — confirm it is a different pass first.');
    if (errs.length) return showMsg(ctx, 'err', '<b>Please fix before saving:</b><br>' + errs.map(esc).join('<br>'));

    const btn = ctx.right().querySelector('[data-r="save"]');
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
      const header = {
        passNumber: f.passNumber.trim(), passDate: f.passDate, passType: f.passType, direction: f.direction,
        personOrVehicle: f.personOrVehicle.trim(), company: f.partner ? f.partner.name : f.company.trim(),
        partner: f.partner ? { code: f.partner.code, name: f.partner.name, type: f.partner.type } : null,
        purpose: f.purpose, materialDescription: f.passType === 'material' ? f.materialDescription : '',
        timeIn: f.timeIn, timeOut: f.timeOut, authorizedBy: f.authorizedBy,
        matchScore: Math.round((scorecard(criteria(f)).overall || 0) * 100),
      };
      const r = await ctx.api('POST', ctx.cfg.api + '/save', { form: { header }, ocrData: ctx.state.ocrData, fileName: ctx.state.fileName, allowDuplicate: f.allowDuplicate });
      ctx.renderDone([
        ['Register Entry', `#${r.id}`], ['Pass', `${header.passNumber || '—'} · ${header.passDate || ''}`],
        ['Type / Direction', `${header.passType} / ${header.direction}`], ['Visitor / Vehicle', header.personOrVehicle],
        ['Company', header.partner ? `${header.company} (${header.partner.code})` : (header.company || '—')],
      ], 'Scan Another Gate Pass');
    } catch (e) {
      if (e.data?.duplicate) { f.duplicate = e.data.duplicate; f.allowDuplicate = false; }
      showMsg(ctx, 'err', `<b>Could not save.</b><br>${esc(e.message)}`);
    }
  }

  function init() {
    window.OcrWorkbench.create({
      panelId: 'ocr-gatepass-panel', navId: 'nav-ocr-gatepass', showFnName: 'showOcrGatePassPanel',
      api: '/api/ocr-gatepass', color: '#0891b2', icon: '🪪',
      title: 'Gate Pass Register Agent',
      subtitle: 'Gate pass on the left · register entry on the right · review, correct and save',
      dropText: 'Upload a visitor / vehicle / material gate pass',
      doneTitle: 'Logged to the Gate Pass Register',
      form: gpForm,
    });
  }
  if (document.getElementById('ocr-gatepass-panel')) init(); else document.addEventListener('DOMContentLoaded', init);
})();
