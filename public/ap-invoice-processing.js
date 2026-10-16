/**
 * AP Invoice Processing (APIP) — frontend module.
 *   Views: dashboard | queue | approvals | stages | master | mail | settings  (+ invoice form)
 *   API:   /api/apip  (see docs/apip-spec.md), header x-auth-token = localStorage.hanny_token
 * Exposes window.showApipPanel(view) and window.ApipUI (helpers for debugging).
 */
(function () {
  'use strict';

  const BASE = '/api/apip';
  const VIEWS = ['dashboard', 'queue', 'approvals', 'stages', 'master', 'mail', 'settings'];
  const VIEW_LABEL = {
    dashboard: 'Processing Dashboard', queue: 'Invoice Queue', approvals: 'Invoice Approval',
    stages: 'Approval Stage', master: 'Approval Master', mail: 'Mail Configuration', settings: 'Settings',
  };
  const HIDE_PANELS = ['messages', 'workflow-panel', 'mail-po-panel', 'demand-forecast-panel', 'b1-forecast-panel',
    'forecast-dashboard-panel', 'procurement-agent-panel', 'production-agent-panel',
    'mrp-auto-po-panel', 'dynamic-pricing-panel', 'product-forecast-panel', 'rush-orders-panel',
    'po-agent-panel', 'inv-agent-panel', 'pr-agent-panel', 'pr-to-po-panel', 'po-to-grpo-panel', 'grpo-apinv-panel', 'scan-apinv-panel', 'apsv-panel',
    'ocr-po-scan-panel', 'ocr-expense-panel', 'ocr-inward-panel', 'ocr-gatepass-panel', 'ocr-document-panel', 'apcm-panel',
    'soa-panel', 'sq-panel', 'qcomp-panel', 'q2o-panel', 'o2d-panel', 'd2arinv-panel', 'arinv2arcm-panel',
    'inpmt-panel', 'outpmt-panel', 'three-way-match-panel',
    'master-item-panel', 'master-customer-panel', 'master-supplier-panel', 'master-bom-panel', 'master-service-call-panel', 'svc-call-panel', 'sc-view-panel', 'sc-form-panel', 'sc-wizard-panel',
    'user-rights-panel', 'data-sync-panel', 'activity-agent-panel', 'prompt-activity-panel', 'financial-dashboard-panel', 'customer-aging-panel',
    'company-setup-panel', 'developer-settings-panel', 'ai-credits-panel', 'roles-perms-panel', 'user-management-panel', 'db-builder-panel', 'udt-panel',
    'query-library-panel', 'schema-registry-panel', 'create-agent-panel', 'custom-agent-panel', 'custom-transaction-panel', 'custom-api-panel', 'local-table-panel', 'workflow-run-panel', 'insight-agent-panel', 'fin-reports-panel',
    'vendor-payment-aging-panel', 'purchase-analysis-panel', 'sales-analysis-panel', 'inv-dashboard-panel', 'soc-panel'];

  // ── Helpers ────────────────────────────────────────────────────────────────
  const tok = () => localStorage.getItem('hanny_token') || '';
  const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const enc = encodeURIComponent;
  const num = v => { const n = Number(String(v ?? '').replace(/,/g, '')); return Number.isFinite(n) ? n : 0; };
  const fmt = (n, d = 2) => Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
  const pad2 = n => String(n).padStart(2, '0');
  const toDate = v => { if (!v) return null; const d = new Date(typeof v === 'number' ? v : String(v).replace(' ', 'T')); return isNaN(d) ? null : d; };
  const fmtD = v => { const d = toDate(v); return d ? `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()}` : (v ? String(v) : ''); };
  const fmtT = v => { const d = toDate(v); return d ? `${pad2(d.getHours())}:${pad2(d.getMinutes())}` : ''; };
  const fmtDT = v => { const d = toDate(v); return d ? `${fmtD(d)} ${fmtT(d)}` : (v ? String(v) : '—'); };
  const toISO = v => { if (!v) return ''; const s = String(v); if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10); const d = toDate(v); return d ? `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}` : ''; };
  const curUser = () => { try { return JSON.parse(localStorage.getItem('hanny_user') || '{}') || {}; } catch { return {}; } };
  const pdfUrl = id => `${BASE}/queue/${enc(id)}/pdf?token=${enc(tok())}`;

  async function api(method, path, body) {
    const opts = { method, headers: { 'x-auth-token': tok() } };
    if (body instanceof FormData) opts.body = body;
    else if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    let r;
    try { r = await fetch(BASE + path, opts); }
    catch (e) { const err = new Error('Network error — server unreachable'); err.status = 0; throw err; }
    let data = {};
    try { data = await r.json(); } catch { data = {}; }
    if (!r.ok || data.ok === false) {
      const err = new Error(data.error || data.message || `Server error (${r.status})`);
      err.status = r.status; err.data = data;
      throw err;
    }
    return data;
  }

  // first array found in a response (by preferred keys, then any)
  function arr(d, ...keys) {
    if (Array.isArray(d)) return d;
    if (!d || typeof d !== 'object') return [];
    for (const k of keys) if (Array.isArray(d[k])) return d[k];
    for (const k of Object.keys(d)) if (Array.isArray(d[k])) return d[k];
    return [];
  }
  function normOpt(o) {
    if (o == null) return null;
    if (typeof o !== 'object') return { code: String(o), name: '', rate: null };
    const code = o.code ?? o.Code ?? o.id ?? o.WarehouseCode ?? o.WhsCode ?? o.Series ?? o.CurrCode ?? o.GroupNumber ?? o.value ?? o.key ?? '';
    const name = o.name ?? o.Name ?? o.WarehouseName ?? o.WhsName ?? o.CurrName ?? o.PaymentTermsGroupName ?? o.SeriesName ?? o.label ?? o.description ?? '';
    const rate = o.rate ?? o.Rate ?? o.VatPercent ?? o.percent ?? null;
    return { code: String(code), name: String(name || ''), rate: rate == null || rate === '' ? null : num(rate) };
  }
  function normHit(o) {
    if (o == null) return null;
    if (typeof o !== 'object') return { code: String(o), name: '' };
    return {
      code: String(o.CardCode ?? o.ItemCode ?? o.AcctCode ?? o.Code ?? o.code ?? o.id ?? ''),
      name: String(o.CardName ?? o.ItemName ?? o.AcctName ?? o.Name ?? o.name ?? ''),
      currency: o.Currency ?? o.currency ?? '',
      uom: o.InventoryUOM ?? o.PurchaseUnit ?? o.InvntryUom ?? o.BuyUnitMsr ?? o.uom ?? o.unit ?? '',
      price: o.LastPurchasePrice ?? o.price ?? null,
      taxCode: o.taxCode ?? o.TaxCode ?? o.VatGroup ?? '',
    };
  }
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

  // ── Icons ──────────────────────────────────────────────────────────────────
  const svg = (p, s = 15) => `<svg viewBox="0 0 24 24" width="${s}" height="${s}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
  const I = {
    play: svg('<polygon points="6 4 20 12 6 20 6 4"/>'),
    redo: svg('<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>'),
    pdf: svg('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M8 13h8M8 17h5"/>'),
    code: svg('<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>'),
    trash: svg('<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/>'),
    eye: svg('<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>'),
    edit: svg('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>'),
    info: svg('<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>'),
    alert: svg('<circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/>'),
    upload: svg('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><path d="M12 3v12"/>'),
    search: svg('<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>', 14),
    plus: svg('<path d="M12 5v14M5 12h14"/>'),
    back: svg('<path d="M19 12H5"/><path d="m12 19-7-7 7-7"/>'),
    tpl: svg('<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/>', 18),
    users: svg('<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.9"/><path d="M16 3.1a4 4 0 0 1 0 7.8"/>', 13),
    mail: svg('<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 6-10 7L2 6"/>', 18),
    folder: svg('<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>', 18),
    check: svg('<polyline points="20 6 9 17 4 12"/>'),
    x: svg('<path d="M18 6 6 18M6 6l12 12"/>'),
    send: svg('<path d="m22 2-7 20-4-9-9-4z"/><path d="M22 2 11 13"/>'),
    link: svg('<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>'),
    file: svg('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>', 18),
    stack: svg('<path d="m12 2 10 5-10 5L2 7z"/><path d="m2 17 10 5 10-5"/><path d="m2 12 10 5 10-5"/>', 18),
    clock: svg('<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>', 18),
    ok: svg('<path d="M22 11.1V12a10 10 0 1 1-5.9-9.1"/><polyline points="22 4 12 14 9 11"/>', 18),
    bad: svg('<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6M9 9l6 6"/>', 18),
    upl: svg('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><path d="M12 3v12"/>', 18),
    gear: svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>', 18),
  };

  // ── Styles ─────────────────────────────────────────────────────────────────
  function injectStyles() {
    if (document.getElementById('apip-styles')) return;
    const st = document.createElement('style');
    st.id = 'apip-styles';
    st.textContent = `
.apip{--ap-p:#7c3aed;--ap-i:#4f46e5;--ap-p-bg:#f3efff;--ap-ok:#15803d;--ap-ok-bg:#dcfce7;--ap-bad:#dc2626;--ap-bad-bg:#fee2e2;--ap-amb:#b45309;--ap-amb-bg:#fef3c7;
  --ap-blue:#2563eb;--ap-blue-bg:#dbeafe;--ap-ind:#4338ca;--ap-ind-bg:#e0e7ff;--ap-grey:#4b5563;--ap-grey-bg:#f3f4f6;--ap-org:#ea580c;--ap-card:var(--white,#fff);
  --ap-line:var(--border,#e5e7eb);--ap-mut:var(--muted,#6b7280);
  flex:1;display:none;flex-direction:column;height:100%;min-height:0;overflow:hidden;background:var(--bg,#f5f6f7);font-family:var(--font,system-ui,sans-serif);color:var(--text,#1f2937);font-size:13px}
.apip *{box-sizing:border-box}
.apip-top{flex-shrink:0;display:flex;align-items:center;gap:14px;padding:9px 18px;background:var(--ap-card);border-bottom:1px solid var(--ap-line);overflow-x:auto}
.apip-brand{display:flex;align-items:center;gap:9px;white-space:nowrap}
.apip-brand .ic{width:30px;height:30px;border-radius:8px;background:linear-gradient(135deg,var(--ap-p),var(--ap-i));color:#fff;display:flex;align-items:center;justify-content:center}
.apip-brand b{font-size:13.5px}
.apip-nav{display:flex;gap:4px}
.apip-nav button{border:0;background:none;padding:6px 11px;border-radius:7px;font:inherit;font-size:12px;color:var(--ap-mut);cursor:pointer;white-space:nowrap}
.apip-nav button:hover{background:var(--ap-grey-bg);color:var(--text,#1f2937)}
.apip-nav button.on{background:var(--ap-p-bg);color:var(--ap-p);font-weight:600}
.apip-body{flex:1;min-height:0;overflow:auto;padding:18px 22px 30px}
.apip-body.full{padding:0;overflow:hidden;display:flex;flex-direction:column}
.apip-ph{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:16px;flex-wrap:wrap}
.apip-ph h2{margin:0;font-size:20px;font-weight:700;letter-spacing:-.01em}
.apip-ph p{margin:3px 0 0;color:var(--ap-mut);font-size:12.5px}
.apip-ph-r{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.apip-card{background:var(--ap-card);border:1px solid var(--ap-line);border-radius:12px;padding:16px 18px;margin-bottom:16px;box-shadow:0 1px 2px rgba(16,24,40,.04)}
.apip-card>h3,.apip-ch h3{margin:0;font-size:14px;font-weight:700}
.apip-card>h3{margin-bottom:12px}
.apip-ch{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:14px}
.apip-ch .sp{flex:1}
.apip-sub{font-size:12px;color:var(--ap-mut);margin:-8px 0 12px}
.apip-btn{display:inline-flex;align-items:center;gap:6px;padding:8px 14px;border-radius:8px;font:inherit;font-size:12.5px;font-weight:600;cursor:pointer;border:1px solid var(--ap-line);background:var(--ap-card);color:var(--text,#1f2937);white-space:nowrap;transition:filter .12s,background .12s}
.apip-btn:hover{background:var(--ap-grey-bg)}
.apip-btn.pri{background:var(--ap-p);border-color:var(--ap-p);color:#fff}.apip-btn.pri:hover{filter:brightness(.93);background:var(--ap-p)}
.apip-btn.blue{background:var(--ap-blue);border-color:var(--ap-blue);color:#fff}.apip-btn.blue:hover{filter:brightness(.93);background:var(--ap-blue)}
.apip-btn.ind{background:var(--ap-i);border-color:var(--ap-i);color:#fff}.apip-btn.ind:hover{filter:brightness(.93);background:var(--ap-i)}
.apip-btn.ok{background:var(--ap-ok);border-color:var(--ap-ok);color:#fff}.apip-btn.ok:hover{filter:brightness(.93);background:var(--ap-ok)}
.apip-btn.bad{background:var(--ap-bad);border-color:var(--ap-bad);color:#fff}.apip-btn.bad:hover{filter:brightness(.93);background:var(--ap-bad)}
.apip-btn.org{background:var(--ap-org);border-color:var(--ap-org);color:#fff}.apip-btn.org:hover{filter:brightness(.93);background:var(--ap-org)}
.apip-btn.ghost{background:transparent}
.apip-btn.sm{padding:5px 10px;font-size:11.5px}
.apip-btn:disabled{opacity:.5;cursor:not-allowed;filter:none}
.apip-btn.pulse{animation:apippulse 1.2s ease-in-out 3}
@keyframes apippulse{50%{box-shadow:0 0 0 6px rgba(21,128,61,.25)}}
.apip-ib{display:inline-flex;align-items:center;justify-content:center;gap:4px;min-width:28px;height:28px;padding:0 6px;border-radius:7px;border:1px solid transparent;background:var(--ap-grey-bg);color:var(--ap-grey);cursor:pointer;font:inherit;font-size:11px;font-weight:700;white-space:nowrap}
.apip-ib:hover{filter:brightness(.95)}
.apip-ib:disabled{opacity:.4;cursor:not-allowed}
.apip-ib.p{background:var(--ap-p-bg);color:var(--ap-p)}.apip-ib.r{background:var(--ap-bad-bg);color:var(--ap-bad)}
.apip-ib.o{background:#ffedd5;color:var(--ap-org)}.apip-ib.b{background:var(--ap-blue-bg);color:var(--ap-blue)}
.apip-ib.g{background:var(--ap-ok-bg);color:var(--ap-ok)}.apip-ib.i{background:var(--ap-ind-bg);color:var(--ap-ind)}
.apip-acts{display:flex;gap:5px;flex-wrap:nowrap}
.apip-in{width:100%;padding:7px 10px;border:1px solid #d1d5db;border-radius:8px;font:inherit;font-size:12.5px;background:var(--ap-card);color:inherit;min-height:34px}
.apip-in:focus{outline:none;border-color:var(--ap-p);box-shadow:0 0 0 3px rgba(124,58,237,.15)}
.apip-in:disabled,.apip-in[readonly]{background:#f9fafb;color:#4b5563}
.apip-in.bad{border-color:#f87171;background:#fff5f5}
textarea.apip-in{min-height:64px;resize:vertical}
.apip-search{position:relative;min-width:220px;flex:0 1 300px}
.apip-search .apip-in{padding-left:32px}
.apip-search svg{position:absolute;left:10px;top:50%;transform:translateY(-50%);color:#9ca3af}
.apip-f label{display:block;font-size:11.5px;font-weight:600;color:#374151;margin-bottom:4px}
.apip-f label i{color:var(--ap-bad);font-style:normal}
.apip-f .hint{font-size:11px;color:var(--ap-mut);margin-top:3px}
.apip-f .ferr{font-size:11px;color:var(--ap-bad);margin-top:3px}
.apip-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px 16px}
.apip-grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px 16px}
.apip-tw{overflow-x:auto;-webkit-overflow-scrolling:touch;border:1px solid var(--ap-line);border-radius:10px}
.apip-tbl{width:100%;border-collapse:collapse;font-size:12.5px}
.apip-tbl th{background:#f9fafb;color:#6b7280;font-size:11px;text-transform:uppercase;letter-spacing:.04em;font-weight:700;text-align:left;padding:10px 12px;border-bottom:1px solid var(--ap-line);white-space:nowrap}
.apip-tbl td{padding:10px 12px;border-bottom:1px solid #f1f2f4;vertical-align:middle}
.apip-tbl tr:last-child td{border-bottom:0}
.apip-tbl tbody tr:hover td{background:#fafaff}
.apip-tbl .r{text-align:right}.apip-tbl .c{text-align:center}
.apip-tbl .nm{font-weight:600;max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.apip-tbl .mut{color:var(--ap-mut);font-size:11.5px}
.apip-empty{padding:34px 16px;text-align:center;color:var(--ap-mut)}
.apip-pill{display:inline-flex;align-items:center;gap:5px;font-size:11px;font-weight:600;padding:3px 10px;border-radius:999px;white-space:nowrap;text-transform:capitalize;background:var(--ap-grey-bg);color:var(--ap-grey)}
.apip-pill.ok{background:var(--ap-ok-bg);color:var(--ap-ok)}.apip-pill.bad{background:var(--ap-bad-bg);color:var(--ap-bad)}
.apip-pill.amber{background:var(--ap-amb-bg);color:var(--ap-amb)}.apip-pill.blue{background:var(--ap-blue-bg);color:var(--ap-blue)}
.apip-pill.indigo{background:var(--ap-ind-bg);color:var(--ap-ind)}.apip-pill.purple{background:var(--ap-p-bg);color:var(--ap-p)}
.apip-pill.spin::before{content:'';width:8px;height:8px;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;animation:apipspin .8s linear infinite}
.apip-err-ic{display:inline-flex;color:var(--ap-bad);vertical-align:middle;margin-left:5px;cursor:help}
.apip-tabs{display:flex;gap:4px;border-bottom:1px solid var(--ap-line);margin-bottom:16px;overflow-x:auto}
.apip-tabs button{border:0;background:none;padding:10px 14px;font:inherit;font-size:13px;font-weight:600;color:var(--ap-mut);cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-1px;display:inline-flex;align-items:center;gap:7px;white-space:nowrap}
.apip-tabs button.on{color:var(--ap-p);border-bottom-color:var(--ap-p)}
.apip-badge{display:inline-flex;align-items:center;justify-content:center;min-width:20px;height:20px;padding:0 6px;border-radius:10px;font-size:11px;font-weight:700;background:var(--ap-grey-bg);color:var(--ap-grey)}
.apip-tabs button.on .apip-badge{background:var(--ap-p);color:#fff}
.apip-dot{width:8px;height:8px;border-radius:50%;display:inline-block}
.apip-msg{border-radius:9px;padding:10px 13px;font-size:12.5px;margin-bottom:12px;line-height:1.5}
.apip-msg.err{background:var(--ap-bad-bg);color:#991b1b;border:1px solid #fecaca}
.apip-msg.warn{background:var(--ap-amb-bg);color:#92400e;border:1px solid #fde68a}
.apip-msg.info{background:#eef2ff;color:#3730a3;border:1px solid #c7d2fe}
.apip-msg.ok{background:var(--ap-ok-bg);color:#166534;border:1px solid #bbf7d0}
.apip-msg ul{margin:4px 0 0;padding-left:18px}
.apip-load{padding:40px 20px;text-align:center;color:var(--ap-mut)}
.apip-spin{width:26px;height:26px;border:3px solid #e5e7eb;border-top-color:var(--ap-p);border-radius:50%;margin:0 auto 10px;animation:apipspin .8s linear infinite}
@keyframes apipspin{to{transform:rotate(360deg)}}
/* KPI */
.apip-kpis{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:12px;margin-bottom:16px}
.apip-kpi{background:var(--ap-card);border:1px solid var(--ap-line);border-radius:12px;padding:14px 16px;display:flex;gap:12px;align-items:center}
.apip-kpi .ic{width:40px;height:40px;border-radius:10px;display:flex;align-items:center;justify-content:center;flex-shrink:0}
.apip-kpi .v{font-size:22px;font-weight:700;line-height:1.1}
.apip-kpi .l{font-size:11.5px;color:var(--ap-mut);margin-top:2px}
.apip-dash{display:grid;grid-template-columns:minmax(0,2fr) minmax(0,1fr);gap:16px}
@media (max-width:1000px){.apip-dash{grid-template-columns:1fr}}
.apip-srcs .row{display:flex;align-items:center;gap:10px;margin-bottom:12px;font-size:12.5px}
.apip-srcs .row .lbl{width:78px;display:flex;align-items:center;gap:6px}
.apip-bar{flex:1;height:8px;background:var(--ap-grey-bg);border-radius:6px;overflow:hidden}
.apip-bar>div{height:100%;border-radius:6px}
.apip-legend{display:flex;gap:14px;font-size:11.5px;color:var(--ap-mut);flex-wrap:wrap}
.apip-legend span{display:inline-flex;align-items:center;gap:5px}
.apip-legend i{width:10px;height:10px;border-radius:3px;display:inline-block}
.apip-chart svg{width:100%;height:auto;display:block}
.apip-intake .it{display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid #f1f2f4}
.apip-intake .it:last-of-type{border-bottom:0}
.apip-intake .it .t{flex:1}.apip-intake .it .t b{display:block;font-size:12.5px}.apip-intake .it .t span{font-size:11.5px;color:var(--ap-mut)}
.apip-logs{background:#0f172a;color:#cbd5e1;border-radius:10px;padding:10px 12px;font-family:Consolas,Menlo,monospace;font-size:11.5px;max-height:260px;overflow:auto;line-height:1.55}
.apip-logs .ts{color:#64748b;margin-right:8px}.apip-logs .error{color:#f87171}.apip-logs .warn{color:#fbbf24}.apip-logs .info{color:#93c5fd}
/* drop */
.apip-dropwrap{position:relative}
.apip-dropwrap.drag::after{content:'Drop PDF invoices to upload';position:absolute;inset:0;background:rgba(124,58,237,.08);border:2px dashed var(--ap-p);border-radius:12px;display:flex;align-items:center;justify-content:center;font-size:15px;font-weight:700;color:var(--ap-p);z-index:5}
/* modal */
.apip-ov{position:fixed;inset:0;background:rgba(15,23,42,.45);z-index:10040;display:flex;align-items:center;justify-content:center;padding:16px}
.apip-modal{background:var(--ap-card,#fff);border-radius:14px;box-shadow:0 20px 50px rgba(0,0,0,.25);width:min(520px,100%);max-height:calc(100vh - 32px);display:flex;flex-direction:column;font-family:var(--font,system-ui,sans-serif);color:var(--text,#1f2937);font-size:13px}
.apip-modal.wide{width:min(900px,100%)}
.apip-modal .mh{display:flex;align-items:center;gap:10px;padding:14px 18px;border-bottom:1px solid var(--ap-line,#e5e7eb)}
.apip-modal .mh h4{margin:0;font-size:15px;flex:1}
.apip-modal .mb{padding:16px 18px;overflow:auto;flex:1}
.apip-modal .mf{display:flex;justify-content:flex-end;gap:8px;padding:12px 18px;border-top:1px solid var(--ap-line,#e5e7eb);flex-wrap:wrap}
.apip-x{border:0;background:none;color:#9ca3af;cursor:pointer;padding:4px;display:inline-flex;border-radius:6px}
.apip-x:hover{color:var(--ap-bad,#dc2626);background:#fef2f2}
.apip-pre{background:#0f172a;color:#e2e8f0;border-radius:10px;padding:12px;font-family:Consolas,Menlo,monospace;font-size:11.5px;white-space:pre;overflow:auto;max-height:60vh;margin:0}
/* toast */
.apip-toasts{position:fixed;right:18px;bottom:18px;z-index:10060;display:flex;flex-direction:column;gap:8px;max-width:min(380px,calc(100vw - 36px))}
.apip-toast{background:#111827;color:#fff;padding:10px 14px;border-radius:10px;font-family:var(--font,system-ui,sans-serif);font-size:12.5px;box-shadow:0 8px 24px rgba(0,0,0,.2);border-left:4px solid #818cf8;animation:apipin .2s ease-out}
.apip-toast.ok{border-left-color:#22c55e}.apip-toast.err{border-left-color:#ef4444}.apip-toast.warn{border-left-color:#f59e0b}
@keyframes apipin{from{transform:translateY(8px);opacity:0}}
/* dropdown */
.apip-dd{position:fixed;z-index:10070;background:#fff;border:1px solid #d1d5db;border-radius:9px;box-shadow:0 10px 28px rgba(0,0,0,.16);max-height:280px;overflow:auto;font-family:var(--font,system-ui,sans-serif);font-size:12.5px;color:#1f2937;min-width:220px}
.apip-dd>div{padding:7px 11px;cursor:pointer;border-bottom:1px solid #f3f4f6}
.apip-dd>div:hover,.apip-dd>div.hl{background:#f3efff}
.apip-dd>div.hd{background:#f9fafb;font-size:10.5px;text-transform:uppercase;letter-spacing:.05em;color:#6b7280;font-weight:700;cursor:default}
.apip-dd>div.e{color:#6b7280;cursor:default}
.apip-dd .c{font-weight:700;color:#6d28d9;margin-right:7px}
/* chips */
.apip-chips{display:flex;flex-wrap:wrap;gap:6px;align-items:center;padding:5px 8px;border:1px solid #d1d5db;border-radius:8px;min-height:38px;background:var(--ap-card);cursor:text}
.apip-chips.bad{border-color:#f87171;background:#fff5f5}
.apip-chips:focus-within{border-color:var(--ap-p);box-shadow:0 0 0 3px rgba(124,58,237,.15)}
.apip-chip{display:inline-flex;align-items:center;gap:5px;background:var(--ap-p-bg);color:#5b21b6;padding:3px 4px 3px 9px;border-radius:999px;font-size:11.5px;font-weight:600}
.apip-chip.role{background:var(--ap-blue-bg);color:#1d4ed8}
.apip-chip button{border:0;background:rgba(0,0,0,.08);color:inherit;width:17px;height:17px;border-radius:50%;cursor:pointer;line-height:1;font-size:12px;padding:0}
.apip-chip-in{border:0;outline:none;font:inherit;font-size:12.5px;flex:1;min-width:120px;background:transparent;color:inherit;padding:3px 0}
.apip-chips.ro{background:#f9fafb;cursor:default}
/* toggle */
.apip-tg{position:relative;display:inline-block;width:38px;height:21px;flex-shrink:0}
.apip-tg input{opacity:0;width:0;height:0}
.apip-tg span{position:absolute;inset:0;background:#d1d5db;border-radius:21px;cursor:pointer;transition:.15s}
.apip-tg span::before{content:'';position:absolute;width:15px;height:15px;left:3px;top:3px;background:#fff;border-radius:50%;transition:.15s;box-shadow:0 1px 2px rgba(0,0,0,.2)}
.apip-tg input:checked+span{background:var(--ap-p)}
.apip-tg input:checked+span::before{transform:translateX(17px)}
.apip-tgrow{display:flex;align-items:center;gap:10px;padding:8px 0}
.apip-tgrow .t{flex:1}.apip-tgrow .t b{display:block;font-size:12.5px;font-weight:600}.apip-tgrow .t span{font-size:11.5px;color:var(--ap-mut)}
/* progress */
.apip-prog{display:flex;flex-direction:column;gap:4px;min-width:130px}
.apip-prog .tx{font-size:11px;color:var(--ap-mut);display:flex;justify-content:space-between;gap:8px}
/* user card */
.apip-who{display:flex;align-items:center;gap:12px}
.apip-av{width:40px;height:40px;border-radius:50%;background:linear-gradient(135deg,var(--ap-p),var(--ap-i));color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:14px;flex-shrink:0}
/* stage card */
.apip-stage{border:1px solid var(--ap-line);border-radius:12px;padding:14px 16px;margin-bottom:12px;background:#fcfcff}
.apip-stage .sh{display:flex;align-items:center;gap:10px;margin-bottom:12px}
.apip-stage .sh .no{width:26px;height:26px;border-radius:50%;background:var(--ap-blue);color:#fff;font-weight:700;display:flex;align-items:center;justify-content:center;font-size:12px}
.apip-stage .sh b{flex:1;font-size:13px}
/* mail cards */
.apip-mcards{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:14px}
.apip-mcard{background:var(--ap-card);border:1px solid var(--ap-line);border-radius:12px;padding:16px;display:flex;flex-direction:column;gap:10px}
.apip-mcard .hd{display:flex;align-items:center;gap:10px}
.apip-mcard .hd .ic{width:36px;height:36px;border-radius:9px;background:var(--ap-p-bg);color:var(--ap-p);display:flex;align-items:center;justify-content:center}
.apip-mcard .hd b{flex:1;font-size:13.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.apip-kv{display:grid;grid-template-columns:96px 1fr;gap:4px 8px;font-size:12px}
.apip-kv span:nth-child(odd){color:var(--ap-mut)}
.apip-kv span:nth-child(even){overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.apip-mcard .ft{display:flex;gap:6px;margin-top:auto;padding-top:8px;border-top:1px solid #f1f2f4}
/* invoice form */
.apip-inv{flex:1;display:flex;flex-direction:column;min-height:0}
.apip-inv-top{flex-shrink:0;display:flex;align-items:center;gap:10px;padding:9px 16px;background:var(--ap-card);border-bottom:1px solid var(--ap-line);flex-wrap:wrap}
.apip-inv-top .ttl{display:flex;flex-direction:column;min-width:0}
.apip-inv-top .ttl b{font-size:14px}.apip-inv-top .ttl span{font-size:11.5px;color:var(--ap-mut);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:340px}
.apip-inv-top .sp{flex:1}
.apip-inv-body{flex:1;display:flex;min-height:0;overflow:hidden}
.apip-inv-left{min-width:220px;display:flex;flex-direction:column;background:#525659}
.apip-inv-left iframe{flex:1;border:0;width:100%;background:#fff}
.apip-split{width:7px;cursor:col-resize;background:var(--ap-line);flex-shrink:0}
.apip-split:hover,.apip-split.drag{background:var(--ap-p)}
.apip-inv-right{flex:1;min-width:0;display:flex;flex-direction:column;overflow:hidden}
.apip-inv-scroll{flex:1;overflow:auto;padding:14px 16px 24px}
.apip-inv-foot{flex-shrink:0;background:var(--ap-card);border-top:1px solid var(--ap-line);padding:10px 16px;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.apip-inv-foot .sp{flex:1}
@media (max-width:800px){.apip-inv-body{flex-direction:column;overflow:auto}.apip-inv-left{width:100%!important;height:55vh;flex-shrink:0}.apip-split{display:none}.apip-inv-right{overflow:visible}.apip-inv-scroll{overflow:visible}}
.apip-lines .apip-in{min-height:30px;padding:5px 7px;font-size:12px}
.apip-lines td{padding:6px 6px;vertical-align:top}
.apip-lines th{padding:8px 6px}
.apip-lines .w-code{min-width:150px}.apip-lines .w-desc{min-width:180px}.apip-lines .w-n{width:86px;min-width:76px}.apip-lines .w-s{min-width:96px}
.apip-lines .ocr{font-size:11px;color:#4b5563;min-width:140px;max-width:200px}
.apip-lines .lt{font-weight:600;white-space:nowrap;padding-top:12px}
.apip-lines .base{font-size:11px;color:var(--ap-ind);white-space:nowrap;padding-top:12px}
.apip-lines tr.rowbad td{background:#fff5f5}
.apip-score{display:inline-block;font-size:10px;font-weight:700;padding:1px 7px;border-radius:999px;margin-top:3px}
.apip-score.ok{background:var(--ap-ok-bg);color:var(--ap-ok)}.apip-score.warn{background:var(--ap-amb-bg);color:var(--ap-amb)}.apip-score.bad{background:var(--ap-bad-bg);color:var(--ap-bad)}
.apip-tot{display:grid;grid-template-columns:1fr auto;gap:6px 18px;max-width:380px;margin-left:auto;font-size:13px}
.apip-tot .k{color:var(--ap-mut)}.apip-tot .v{text-align:right;font-weight:600;font-variant-numeric:tabular-nums}
.apip-tot .big{font-size:15px;font-weight:800;border-top:1px solid var(--ap-line);padding-top:6px}
.apip-tot .mm{color:var(--ap-bad)}.apip-tot .mok{color:var(--ap-ok)}
.apip-tl{position:relative;padding-left:22px}
.apip-tl::before{content:'';position:absolute;left:8px;top:4px;bottom:4px;width:2px;background:var(--ap-line)}
.apip-tl .st{position:relative;margin-bottom:14px}
.apip-tl .st::before{content:'';position:absolute;left:-19px;top:3px;width:12px;height:12px;border-radius:50%;background:#d1d5db;border:2px solid #fff;box-shadow:0 0 0 1px #d1d5db}
.apip-tl .st.ok::before{background:var(--ap-ok);box-shadow:0 0 0 1px var(--ap-ok)}
.apip-tl .st.bad::before{background:var(--ap-bad);box-shadow:0 0 0 1px var(--ap-bad)}
.apip-tl .st.cur::before{background:var(--ap-amb);box-shadow:0 0 0 1px var(--ap-amb)}
.apip-tl .st b{font-size:12.5px}
.apip-tl .ac{font-size:11.5px;color:#4b5563;margin-top:4px;padding:6px 9px;background:#f9fafb;border-radius:7px}
.apip-done{background:var(--ap-card);border:1px solid var(--ap-line);border-radius:14px;padding:30px;text-align:center;max-width:460px;margin:30px auto}
.apip-done .big{width:62px;height:62px;border-radius:50%;background:var(--ap-ok-bg);color:var(--ap-ok);display:flex;align-items:center;justify-content:center;margin:0 auto 12px}
.apip-done h3{margin:0 0 6px;font-size:18px}
.apip-done .dn{font-size:26px;font-weight:800;color:var(--ap-ind);margin:10px 0 18px}
.apip-cf td{padding:6px}
.apip-cf .apip-in{min-height:30px;padding:5px 8px;font-size:12px}
@media (max-width:640px){.apip-body{padding:14px 12px 24px}.apip-ph h2{font-size:17px}.apip-search{flex:1 1 100%}}
`;
    document.head.appendChild(st);
  }

  // ── Toast / modal / dropdown ───────────────────────────────────────────────
  function toast(msg, type = 'info', ms = 3500) {
    let host = document.querySelector('.apip-toasts');
    if (!host) { host = document.createElement('div'); host.className = 'apip-toasts'; document.body.appendChild(host); }
    const t = document.createElement('div');
    t.className = 'apip-toast ' + type;
    t.textContent = msg;
    host.appendChild(t);
    setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; setTimeout(() => t.remove(), 320); }, ms);
  }

  function modal({ title, body = '', wide = false, buttons = [], onMount }) {
    injectStyles();
    const ov = document.createElement('div');
    ov.className = 'apip-ov apip';
    ov.style.display = 'flex';
    ov.style.height = 'auto';
    ov.innerHTML = `<div class="apip-modal${wide ? ' wide' : ''}" role="dialog" aria-modal="true">
      <div class="mh"><h4>${esc(title)}</h4><button class="apip-x" data-x>${I.x}</button></div>
      <div class="mb">${body}</div>
      ${buttons.length ? `<div class="mf">${buttons.map((b, i) => `<button class="apip-btn ${b.cls || ''}" data-b="${i}">${b.label}</button>`).join('')}</div>` : ''}
    </div>`;
    let closed = false;
    const onKey = e => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
    function close() { if (closed) return; closed = true; closeDD(); ov.remove(); document.removeEventListener('keydown', onKey, true); if (api_.onClose) api_.onClose(); }
    const api_ = { el: ov, body: ov.querySelector('.mb'), close, onClose: null, btn: i => ov.querySelector(`[data-b="${i}"]`) };
    ov.addEventListener('mousedown', e => { if (e.target === ov) close(); });
    ov.querySelector('[data-x]').addEventListener('click', close);
    buttons.forEach((b, i) => api_.btn(i).addEventListener('click', () => { if (b.onClick) b.onClick(api_); else close(); }));
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(ov);
    if (onMount) onMount(api_);
    return api_;
  }
  function confirmDlg(msg, { title = 'Please confirm', okLabel = 'Confirm', okCls = 'pri' } = {}) {
    return new Promise(res => {
      const m = modal({
        title, body: `<div style="line-height:1.55">${msg}</div>`,
        buttons: [{ label: 'Cancel', onClick: x => { res(false); x.close(); } }, { label: okLabel, cls: okCls, onClick: x => { res(true); x.close(); } }],
      });
      m.onClose = () => res(false);
    });
  }
  function promptDlg({ title, label, placeholder = '', required = false, okLabel = 'OK', okCls = 'pri' }) {
    return new Promise(res => {
      const m = modal({
        title,
        body: `<div class="apip-f"><label>${esc(label)}${required ? ' <i>*</i>' : ''}</label><textarea class="apip-in" rows="4" placeholder="${esc(placeholder)}"></textarea><div class="ferr" style="display:none">This field is required.</div></div>`,
        buttons: [{ label: 'Cancel', onClick: x => { res(null); x.close(); } }, {
          label: okLabel, cls: okCls, onClick: x => {
            const v = x.body.querySelector('textarea').value.trim();
            if (required && !v) { x.body.querySelector('textarea').classList.add('bad'); x.body.querySelector('.ferr').style.display = ''; return; }
            res(v); x.close();
          },
        }],
        onMount: x => setTimeout(() => x.body.querySelector('textarea').focus(), 30),
      });
      m.onClose = () => res(null);
    });
  }

  let dd = null;
  function closeDD() { if (dd) { dd.remove(); dd = null; } }
  function openDD(anchor, items, onPick) {
    closeDD();
    dd = document.createElement('div');
    dd.className = 'apip-dd';
    dd._anchor = anchor; dd._items = items; dd._pick = onPick; dd._hl = -1;
    dd.innerHTML = items.length
      ? items.map((it, k) => it.header ? `<div class="hd">${it.html}</div>` : it.disabled ? `<div class="e">${it.html}</div>` : `<div data-k="${k}">${it.html}</div>`).join('')
      : '<div class="e">No matches</div>';
    const r = anchor.getBoundingClientRect();
    dd.style.left = Math.max(4, Math.min(r.left, window.innerWidth - Math.max(r.width, 240) - 4)) + 'px';
    dd.style.minWidth = Math.max(r.width, 240) + 'px';
    const below = window.innerHeight - r.bottom;
    if (below < 200 && r.top > below) { dd.style.bottom = (window.innerHeight - r.top + 3) + 'px'; }
    else dd.style.top = (r.bottom + 3) + 'px';
    dd.addEventListener('mousedown', e => {
      e.preventDefault();
      const k = e.target.closest('[data-k]');
      if (!k) return;
      const it = items[+k.dataset.k]; const fn = onPick;
      closeDD(); fn(it.value);
    });
    document.body.appendChild(dd);
  }
  function ddKey(e, anchor) {
    if (!dd || dd._anchor !== anchor) return false;
    const opts = [...dd.querySelectorAll('[data-k]')];
    if (e.key === 'Escape') { closeDD(); e.preventDefault(); e.stopPropagation(); return true; }
    if (!opts.length) return false;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      dd._hl = Math.max(0, Math.min(opts.length - 1, dd._hl + (e.key === 'ArrowDown' ? 1 : -1)));
      opts.forEach((o, i) => o.classList.toggle('hl', i === dd._hl));
      opts[dd._hl].scrollIntoView({ block: 'nearest' });
      e.preventDefault(); return true;
    }
    if (e.key === 'Enter' && dd._hl >= 0) {
      const it = dd._items[+opts[dd._hl].dataset.k]; const fn = dd._pick;
      closeDD(); fn(it.value); e.preventDefault(); return true;
    }
    return false;
  }
  document.addEventListener('mousedown', e => { if (dd && !dd.contains(e.target) && e.target !== dd._anchor && !(dd._anchor && dd._anchor.contains && dd._anchor.contains(e.target))) closeDD(); });
  window.addEventListener('scroll', e => { if (dd && !dd.contains(e.target)) closeDD(); }, true);
  window.addEventListener('resize', closeDD);

  // autocomplete on an input: fetcher(q) -> Promise<[{code,name}]>
  function attachAC(input, fetcher, onPick) {
    let seq = 0;
    const run = async () => {
      const my = ++seq;
      const q = input.value.trim();
      openDD(input, [{ html: 'Searching…', disabled: true }], () => {});
      let hits = [], err = '';
      try { hits = (await fetcher(q)).filter(Boolean); } catch (e) { err = e.message; }
      if (my !== seq || document.activeElement !== input) return;
      if (err) { openDD(input, [{ html: esc('Error: ' + err), disabled: true }], () => {}); return; }
      openDD(input, hits.slice(0, 50).map(h => ({ html: `<span class="c">${esc(h.code)}</span>${esc(h.name)}`, value: h })), h => onPick(h));
    };
    const deb = debounce(run, 260);
    input.addEventListener('input', deb);
    input.addEventListener('keydown', e => {
      if (ddKey(e, input)) return;
      if (e.key === 'F2' || (e.key === 'ArrowDown' && !dd)) { e.preventDefault(); run(); }
    });
    input.addEventListener('blur', () => setTimeout(() => { if (dd && dd._anchor === input && document.activeElement !== input) closeDD(); }, 150));
    input._acRun = () => { input.focus(); run(); };
  }
  const fetchVendors = async q => arr(await api('GET', '/vendors?q=' + enc(q)), 'rows', 'vendors', 'items').map(normHit);
  const fetchItems = async q => arr(await api('GET', '/items?q=' + enc(q)), 'rows', 'items').map(normHit);
  const fetchGL = async q => arr(await api('GET', '/gl-accounts?q=' + enc(q)), 'rows', 'accounts', 'items').map(normHit);

  // multi-select chips. options: [{type,id,name}], value: array (mutated)
  function chipSelect(host, options, value, { placeholder = 'Search users or roles…', readOnly = false, onChange } = {}) {
    const key = o => `${o.type}:${o.id}`;
    function render() {
      host.innerHTML = `<div class="apip-chips${readOnly ? ' ro' : ''}">${value.map((v, i) =>
        `<span class="apip-chip ${v.type === 'role' ? 'role' : ''}">${v.type === 'role' ? I.users : ''}${esc(v.name || v.id)}${readOnly ? '' : `<button type="button" data-rm="${i}" title="Remove">×</button>`}</span>`).join('')}
        ${readOnly ? '' : `<input class="apip-chip-in" placeholder="${value.length ? '' : esc(placeholder)}">`}</div>`;
      if (readOnly) return;
      const box = host.querySelector('.apip-chips');
      const inp = host.querySelector('input');
      box.addEventListener('mousedown', e => { if (e.target === box) { e.preventDefault(); inp.focus(); show(); } });
      box.querySelectorAll('[data-rm]').forEach(b => b.addEventListener('click', e => {
        e.stopPropagation(); value.splice(+b.dataset.rm, 1); onChange && onChange(value); render();
      }));
      const show = () => {
        const q = inp.value.trim().toLowerCase();
        const taken = new Set(value.map(key));
        const avail = options.filter(o => !taken.has(key(o)) && (!q || String(o.name || o.id).toLowerCase().includes(q)));
        const items = [];
        const users = avail.filter(o => o.type !== 'role'), roles = avail.filter(o => o.type === 'role');
        if (users.length) { items.push({ header: true, html: 'Users' }); users.forEach(o => items.push({ html: esc(o.name || o.id), value: o })); }
        if (roles.length) { items.push({ header: true, html: 'Roles' }); roles.forEach(o => items.push({ html: `${I.users} ${esc(o.name || o.id)}`, value: o })); }
        if (!items.length) items.push({ html: options.length ? 'No more matches' : 'No users / roles available', disabled: true });
        openDD(box, items, o => { value.push({ type: o.type, id: o.id, name: o.name }); onChange && onChange(value); render(); setTimeout(() => { const ni = host.querySelector('input'); if (ni) { ni.focus(); } }, 0); });
      };
      inp.addEventListener('focus', show);
      inp.addEventListener('input', show);
      inp.addEventListener('keydown', e => {
        if (ddKey(e, box)) return;
        if (e.key === 'Backspace' && !inp.value && value.length) { value.pop(); onChange && onChange(value); render(); host.querySelector('input')?.focus(); }
      });
      inp.addEventListener('blur', () => setTimeout(() => { if (dd && dd._anchor === box && !host.contains(document.activeElement)) closeDD(); }, 150));
    }
    render();
    return { render, setInvalid: b => host.querySelector('.apip-chips')?.classList.toggle('bad', !!b) };
  }

  // ── Pills ──────────────────────────────────────────────────────────────────
  const PS = { processed: 'ok', failed: 'bad', pending: '', processing: 'blue spin', duplicate: 'amber', posted: 'indigo' };
  const AS = { NOT_REQUIRED: '', DRAFT: '', PENDING: 'amber', PARTIAL: 'blue', APPROVED: 'ok', REJECTED: 'bad' };
  const AS_LABEL = { NOT_REQUIRED: 'Not Required', DRAFT: 'Draft', PENDING: 'Pending', PARTIAL: 'Partially Approved', APPROVED: 'Approved', REJECTED: 'Rejected' };
  function pillP(s) { const v = String(s || 'pending').toLowerCase(); return `<span class="apip-pill ${PS[v] ?? ''}">${esc(v)}</span>`; }
  function pillA(s) { const v = String(s || 'DRAFT').toUpperCase(); return `<span class="apip-pill ${AS[v] ?? ''}" style="text-transform:none">${esc(AS_LABEL[v] || s)}</span>`; }
  const loading = (t = 'Loading…') => `<div class="apip-load"><div class="apip-spin"></div>${esc(t)}</div>`;
  const errBox = (m, extra = '') => `<div class="apip-msg err"><b>Error:</b> ${esc(m)}${extra}</div>`;
  const pageHead = (title, sub, right = '') => `<div class="apip-ph"><div><h2>${esc(title)}</h2>${sub ? `<p>${esc(sub)}</p>` : ''}</div><div class="apip-ph-r">${right}</div></div>`;
  const searchBox = (id, ph, val = '') => `<div class="apip-search">${I.search}<input class="apip-in" id="${id}" placeholder="${esc(ph)}" value="${esc(val)}"></div>`;
  const toggle = (attrs, on) => `<label class="apip-tg"><input type="checkbox" ${attrs} ${on ? 'checked' : ''}><span></span></label>`;
  const sourceLabel = r => {
    const s = String(r.source || '').toLowerCase();
    if (s === 'upload') return 'Uploaded Invoice';
    if (s === 'folder') return `Folder${r.sourceRef ? `<div class="mut">${esc(r.sourceRef)}</div>` : ''}`;
    if (s === 'mail') return `Mail: ${esc(r.sourceRef || '')}`;
    return esc(r.source || '—');
  };

  // ── Panel shell / routing ──────────────────────────────────────────────────
  const S = {
    view: null, seq: 0, timers: [], lookups: null, settings: null,
    queueTab: 'queue', queueSearch: '', apprTab: 'mine', apprSearch: '', splitW: 45, inv: null,
  };
  let panel = null, topEl = null, bodyEl = null;

  function ensurePanel() {
    injectStyles();
    const main = document.querySelector('.main') || document.body;
    if (!panel) {
      panel = document.getElementById('apip-panel') || document.createElement('div');
      panel.id = 'apip-panel';
      panel.className = 'apip';
      panel.innerHTML = `<div class="apip-top"><div class="apip-brand"><div class="ic">${I.file}</div><b>AP Invoice Processing</b></div><div class="apip-nav"></div></div><div class="apip-body"></div>`;
      topEl = panel.querySelector('.apip-nav');
      bodyEl = panel.querySelector('.apip-body');
      topEl.addEventListener('click', e => { const b = e.target.closest('[data-v]'); if (b) window.showApipPanel(b.dataset.v); });
    }
    if (panel.parentElement !== main) main.appendChild(panel);
  }
  function renderTop() {
    const active = S.view === 'invoice' ? (S.inv && S.inv.back) : S.view;
    topEl.innerHTML = VIEWS.map(v => `<button data-v="${v}" class="${v === active ? 'on' : ''}">${esc(VIEW_LABEL[v])}</button>`).join('');
  }
  const visible = () => !!panel && panel.style.display !== 'none' && document.body.contains(panel);
  function clearTimers() { S.timers.forEach(t => clearInterval(t)); S.timers = []; }
  function every(ms, fn) { const t = setInterval(() => { if (visible()) fn(); }, ms); S.timers.push(t); }
  function startView(name) {
    clearTimers(); closeDD();
    S.view = name; S.seq++;
    // fresh body element per view → drops listeners bound by the previous view
    const nb = bodyEl.cloneNode(false);
    bodyEl.replaceWith(nb);
    bodyEl = nb;
    bodyEl.classList.toggle('full', name === 'invoice');
    bodyEl.scrollTop = 0;
    renderTop();
    return S.seq;
  }
  function setNav(view) {
    document.querySelectorAll('.nav-item,.nav-subitem').forEach(n => n.classList.remove('active'));
    document.getElementById('nav-apip-' + view)?.classList.add('active');
  }

  function wrapShowChat() {
    const orig = window.showChatPanel;
    if (typeof orig !== 'function' || orig.__apip) return;
    const w = function () { if (panel) panel.style.display = 'none'; clearTimers(); closeDD(); return orig.apply(this, arguments); };
    w.__apip = true;
    window.showChatPanel = w;
  }

  window.showApipPanel = function (view) {
    view = VIEWS.includes(view) ? view : 'dashboard';
    wrapShowChat();
    HIDE_PANELS.forEach(id => { const el = document.getElementById(id); if (el) el.style.display = 'none'; });
    // also hide any other full-screen panel that is a direct child of .main
    const main = document.querySelector('.main');
    if (main) [...main.children].forEach(c => { if (c.id && c.id !== 'apip-panel' && /-panel$/.test(c.id)) c.style.display = 'none'; });
    const bb = document.querySelector('.bottom-bar'); if (bb) bb.style.display = 'none';
    const ia = document.querySelector('.input-area'); if (ia) ia.style.display = 'none';
    ensurePanel();
    panel.style.display = 'flex';
    setNav(view);
    go(view);
  };

  function go(view, opts) {
    if (view === 'invoice') return openInvoice(opts.id, opts);
    setNav(view);
    const fn = { dashboard: vDashboard, queue: vQueue, approvals: vApprovals, stages: vStages, master: vMaster, mail: vMail, settings: vSettings }[view];
    try { fn(opts || {}); } catch (e) { console.error('[apip]', e); bodyEl.innerHTML = errBox(e.message || String(e)); }
  }

  async function getLookups(force) {
    if (S.lookups && !force) return S.lookups;
    try {
      const d = await api('GET', '/lookups');
      S.lookups = {
        taxCodes: arr(d.taxCodes).map(normOpt).filter(Boolean),
        warehouses: arr(d.warehouses).map(normOpt).filter(Boolean),
        currencies: arr(d.currencies).map(normOpt).filter(Boolean),
        paymentTerms: arr(d.paymentTerms).map(normOpt).filter(Boolean),
        series: arr(d.series).map(normOpt).filter(Boolean),
      };
    } catch (e) {
      console.warn('[apip] lookups failed', e.message);
      return { taxCodes: [], warehouses: [], currencies: [], paymentTerms: [], series: [], error: e.message };
    }
    return S.lookups;
  }
  async function getSettings(force) {
    if (S.settings && !force) return S.settings;
    try { const d = await api('GET', '/settings'); S.settings = d.settings || {}; }
    catch (e) { console.warn('[apip] settings failed', e.message); return {}; }
    return S.settings;
  }
  const optsHtml = (list, cur, blank = '— Select —') => {
    const has = list.some(o => o.code === String(cur ?? ''));
    return `<option value="">${esc(blank)}</option>` +
      (cur && !has ? `<option value="${esc(cur)}" selected>${esc(cur)}</option>` : '') +
      list.map(o => `<option value="${esc(o.code)}" ${o.code === String(cur ?? '') ? 'selected' : ''}>${esc(o.code)}${o.name && o.name !== o.code ? ' — ' + esc(o.name) : ''}</option>`).join('');
  };

  // ═════════════════════════════════════════════════════════════════════════
  // 1. Processing Dashboard
  // ═════════════════════════════════════════════════════════════════════════
  function vDashboard() {
    const seq = startView('dashboard');
    bodyEl.innerHTML = pageHead('Processing Dashboard', 'Overview of AP invoice intake, OCR processing, approvals and SAP posting',
      `<button class="apip-btn" data-a="refresh">${I.redo} Refresh</button><button class="apip-btn pri" data-a="queue">Open Invoice Queue</button>`) +
      `<div id="apip-dash">${loading()}</div>`;
    bodyEl.querySelector('[data-a=refresh]').onclick = () => load();
    bodyEl.querySelector('[data-a=queue]').onclick = () => window.showApipPanel('queue');
    const host = bodyEl.querySelector('#apip-dash');
    host.addEventListener('click', async e => {
      const b = e.target.closest('[data-intake]');
      if (b) {
        b.disabled = true;
        try { const r = await api('POST', '/intake/' + b.dataset.intake); toast(r.message || `Intake: ${b.dataset.intake} OK`, 'ok'); }
        catch (er) { toast(er.message, 'err', 5000); }
        load();
        return;
      }
      const r = e.target.closest('[data-open]');
      if (r) openInvoice(r.dataset.open, { back: 'dashboard' });
    });

    let first = true;
    async function load() {
      let d, logs = [];
      try {
        const [dd_, ll] = await Promise.all([api('GET', '/dashboard'), api('GET', '/logs').catch(() => ({ logs: [] }))]);
        d = dd_; logs = arr(ll, 'logs');
      } catch (e) {
        if (seq !== S.seq) return;
        if (first) host.innerHTML = errBox(e.message);
        return;
      }
      if (seq !== S.seq) return;
      first = false;
      const prevLog = host.querySelector('.apip-logs');
      const stick = !prevLog || prevLog.scrollTop + prevLog.clientHeight >= prevLog.scrollHeight - 20;
      host.innerHTML = renderDash(d, logs);
      const lg = host.querySelector('.apip-logs');
      if (lg) lg.scrollTop = stick ? lg.scrollHeight : (prevLog ? prevLog.scrollTop : 0);
    }
    load();
    every(10000, load);
  }

  function renderDash(d, logs) {
    const c = d.counts || {}, a = d.approval || {}, src = d.bySource || {}, it = d.intake || {};
    const tile = (label, v, col, bg, ic) => `<div class="apip-kpi"><div class="ic" style="background:${bg};color:${col}">${ic}</div><div><div class="v">${fmt(v || 0, 0)}</div><div class="l">${esc(label)}</div></div></div>`;
    const kpis = `<div class="apip-kpis">
      ${tile('Total Invoices', c.total, '#7c3aed', '#f3efff', I.stack)}
      ${tile('Pending', num(c.pending) + num(c.processing), '#4b5563', '#f3f4f6', I.clock)}
      ${tile('Processed', c.processed, '#15803d', '#dcfce7', I.ok)}
      ${tile('Failed', c.failed, '#dc2626', '#fee2e2', I.bad)}
      ${tile('Posted to SAP', c.posted, '#4338ca', '#e0e7ff', I.upl)}
      ${tile('Approval Pending', num(a.pending) + num(a.partial), '#b45309', '#fef3c7', I.users.replace(/13/g, '18'))}
    </div>`;
    const totalSrc = num(src.folder) + num(src.mail) + num(src.upload) || 1;
    const srow = (lbl, ic, v, col) => `<div class="row"><div class="lbl" style="color:${col}">${ic}<span style="color:var(--text,#1f2937)">${lbl}</span></div><div class="apip-bar"><div style="width:${(num(v) / totalSrc * 100).toFixed(1)}%;background:${col}"></div></div><b style="width:40px;text-align:right">${fmt(v || 0, 0)}</b><span class="mut" style="width:42px;text-align:right;color:var(--ap-mut)">${(num(v) / totalSrc * 100).toFixed(0)}%</span></div>`;
    const sources = `<div class="apip-card apip-srcs"><h3>Invoice Sources</h3>
      ${srow('Folder', I.folder, src.folder, '#7c3aed')}${srow('Mail', I.mail, src.mail, '#2563eb')}${srow('Upload', I.upl, src.upload, '#0d9488')}
      <div class="apip-legend" style="margin-top:6px"><span>Approval —</span><span><i style="background:#f59e0b"></i>Pending ${fmt(a.pending || 0, 0)}</span><span><i style="background:#3b82f6"></i>Partial ${fmt(a.partial || 0, 0)}</span><span><i style="background:#22c55e"></i>Approved ${fmt(a.approved || 0, 0)}</span><span><i style="background:#ef4444"></i>Rejected ${fmt(a.rejected || 0, 0)}</span></div></div>`;
    const chart = `<div class="apip-card apip-chart"><div class="apip-ch"><h3>Last 14 Days</h3><div class="sp"></div><div class="apip-legend"><span><i style="background:#7c3aed"></i>Received</span><span><i style="background:#4f46e5;opacity:.55"></i>Posted</span><span><i style="background:#ef4444"></i>Failed</span></div></div>${barChart(arr(d.daily))}</div>`;
    const dot = on => `<span class="apip-dot" style="background:${on ? '#22c55e' : '#d1d5db'};box-shadow:0 0 0 3px ${on ? 'rgba(34,197,94,.18)' : 'transparent'}"></span>`;
    const intake = `<div class="apip-card apip-intake"><h3>Intake Status</h3>
      <div class="it">${dot(it.folderRunning)}<div class="t"><b>Folder watcher — ${it.folderRunning ? 'Running' : 'Stopped'}</b><span>Last scan: ${esc(fmtDT(it.lastFolderScan))}</span></div><span style="color:#7c3aed">${I.folder}</span></div>
      <div class="it">${dot(it.mailRunning)}<div class="t"><b>Mail poller — ${it.mailRunning ? 'Running' : 'Stopped'}</b><span>Last check: ${esc(fmtDT(it.lastMailScan))}</span></div><span style="color:#2563eb">${I.mail}</span></div>
      <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap">
        <button class="apip-btn ok sm" data-intake="start">${I.play} Start</button>
        <button class="apip-btn bad sm" data-intake="stop">${I.x} Stop</button>
        <button class="apip-btn pri sm" data-intake="scan-now">${I.redo} Scan now</button>
      </div></div>`;
    const recent = arr(d.recent);
    const recentHtml = `<div class="apip-card"><h3>Recent Invoices</h3>${recent.length ? `<div class="apip-tw"><table class="apip-tbl"><thead><tr><th>Invoice</th><th>Vendor</th><th>Source</th><th>Status</th><th class="r">Total</th><th>Received</th></tr></thead><tbody>
      ${recent.map(r => `<tr style="cursor:pointer" data-open="${esc(r.id)}"><td class="nm" title="${esc(r.fileName)}">${esc(r.fileName)}</td><td>${esc(r.vendorName || '—')}</td><td class="mut">${esc(r.source || '')}</td><td>${pillP(r.processingStatus)}</td><td class="r">${r.total != null ? fmt(r.total) + ' ' + esc(r.currency || '') : '—'}</td><td class="mut">${esc(fmtDT(r.receivedAt))}</td></tr>`).join('')}
      </tbody></table></div>` : '<div class="apip-empty">No invoices received yet.</div>'}</div>`;
    const logHtml = `<div class="apip-card"><h3>Live Log</h3><div class="apip-logs">${logs.length ? logs.slice(-200).map(l => `<div><span class="ts">${esc(fmtT(l.ts) || l.ts || '')}</span><span class="${esc(String(l.level || 'info').toLowerCase())}">${esc(String(l.level || 'info').toUpperCase())}</span> ${esc(l.msg)}</div>`).join('') : '<div class="ts">No log entries.</div>'}</div></div>`;
    return kpis + `<div class="apip-dash"><div>${chart}${recentHtml}</div><div>${intake}${sources}${logHtml}</div></div>`;
  }

  function barChart(days) {
    if (!days.length) return '<div class="apip-empty">No data for the last 14 days.</div>';
    const W = 640, H = 200, padL = 30, padB = 26, padT = 10;
    const max = Math.max(1, ...days.map(d => Math.max(num(d.received), num(d.posted), num(d.failed))));
    const step = (W - padL - 6) / days.length, bw = Math.min(10, step / 4);
    const y = v => padT + (H - padT - padB) * (1 - v / max);
    let g = '';
    for (let i = 0; i <= 4; i++) {
      const v = max * i / 4, yy = y(v);
      g += `<line x1="${padL}" x2="${W}" y1="${yy}" y2="${yy}" stroke="#eef0f3"/><text x="${padL - 6}" y="${yy + 3}" font-size="9" text-anchor="end" fill="#9ca3af">${Math.round(v)}</text>`;
    }
    days.forEach((d, i) => {
      const x0 = padL + i * step + step / 2 - bw * 1.5;
      [['received', '#7c3aed', 1], ['posted', '#4f46e5', .55], ['failed', '#ef4444', 1]].forEach(([k, col, op], j) => {
        const v = num(d[k]), yy = y(v);
        g += `<rect x="${x0 + j * bw}" y="${yy}" width="${bw - 1}" height="${Math.max(0, H - padB - yy)}" rx="2" fill="${col}" opacity="${op}"><title>${esc(fmtD(d.date))} — ${k}: ${v}</title></rect>`;
      });
      const dt = toDate(d.date);
      if (i % 2 === 0 || days.length <= 8) g += `<text x="${padL + i * step + step / 2}" y="${H - 8}" font-size="9" text-anchor="middle" fill="#6b7280">${dt ? pad2(dt.getDate()) + '/' + pad2(dt.getMonth() + 1) : esc(d.date)}</text>`;
    });
    return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Invoices per day">${g}</svg>`;
  }

  // ═════════════════════════════════════════════════════════════════════════
  // 2. Invoice Queue
  // ═════════════════════════════════════════════════════════════════════════
  function vQueue() {
    const seq = startView('queue');
    const Q = { rows: [], counts: { queue: null, sent: null }, busyAll: false, err: '' };
    bodyEl.innerHTML = pageHead('Invoice Queue', 'Upload, OCR-process, review and post supplier invoices') +
      `<div class="apip-tabs" id="apip-qtabs"></div>
       <div class="apip-card apip-dropwrap" id="apip-qcard">
         <div class="apip-ch"><h3>Invoice List</h3><div class="sp"></div>
           ${searchBox('apip-qsearch', 'Search by invoice name...', S.queueSearch)}
           <button class="apip-btn" id="apip-upl">${I.upload} Upload PDFs</button>
           <button class="apip-btn pri" id="apip-pall">${I.play} Process All Pending (0)</button>
           <input type="file" id="apip-file" accept="application/pdf,.pdf" multiple style="display:none">
         </div>
         <div id="apip-qtbl">${loading()}</div>
       </div>`;
    const $ = s => bodyEl.querySelector(s);
    const tabsEl = $('#apip-qtabs'), tblEl = $('#apip-qtbl'), card = $('#apip-qcard'), fileIn = $('#apip-file');

    function renderTabs() {
      const b = n => n == null ? '' : `<span class="apip-badge">${n}</span>`;
      tabsEl.innerHTML = `<button data-t="queue" class="${S.queueTab === 'queue' ? 'on' : ''}">Invoice Queue ${b(Q.counts.queue)}</button>
        <button data-t="sent" class="${S.queueTab === 'sent' ? 'on' : ''}">Sent for Approval ${b(Q.counts.sent)}</button>`;
    }
    tabsEl.addEventListener('click', e => { const b = e.target.closest('[data-t]'); if (b && b.dataset.t !== S.queueTab) { S.queueTab = b.dataset.t; renderTabs(); tblEl.innerHTML = loading(); load(); } });
    $('#apip-qsearch').addEventListener('input', debounce(e => { S.queueSearch = e.target.value.trim(); load(); }, 300));
    $('#apip-upl').onclick = () => fileIn.click();
    fileIn.onchange = () => { const f = [...fileIn.files]; fileIn.value = ''; upload(f); };
    let dragN = 0;
    card.addEventListener('dragenter', e => { e.preventDefault(); dragN++; card.classList.add('drag'); });
    card.addEventListener('dragover', e => e.preventDefault());
    card.addEventListener('dragleave', () => { if (--dragN <= 0) { dragN = 0; card.classList.remove('drag'); } });
    card.addEventListener('drop', e => { e.preventDefault(); dragN = 0; card.classList.remove('drag'); upload([...(e.dataTransfer?.files || [])]); });

    $('#apip-pall').onclick = async () => {
      const n = pendingCount();
      if (!n) { toast('No pending or failed invoices to process.', 'warn'); return; }
      if (!await confirmDlg(`Process <b>${n}</b> pending / failed invoice(s) now?`, { okLabel: 'Process All' })) return;
      try { const r = await api('POST', '/queue/process-all'); Q.busyAll = true; toast(`Processing started for ${r.count ?? n} invoice(s).`, 'ok'); setTimeout(() => { Q.busyAll = false; }, 30000); }
      catch (e) { toast(e.message, 'err', 5000); }
      load();
    };

    const pendingCount = () => S.queueTab === 'queue' ? Q.rows.filter(r => ['pending', 'failed'].includes(String(r.processingStatus).toLowerCase())).length : 0;

    async function upload(files) {
      const pdfs = files.filter(f => /\.pdf$/i.test(f.name) || f.type === 'application/pdf');
      if (!pdfs.length) { if (files.length) toast('Only PDF files can be uploaded.', 'warn'); return; }
      if (pdfs.length < files.length) toast(`${files.length - pdfs.length} non-PDF file(s) skipped.`, 'warn');
      const fd = new FormData();
      pdfs.forEach(f => fd.append('files', f, f.name));
      const btn = $('#apip-upl'); if (btn) { btn.disabled = true; btn.innerHTML = `${I.upload} Uploading ${pdfs.length}…`; }
      try { const r = await api('POST', '/queue/upload', fd); toast(`${arr(r, 'rows').length || pdfs.length} invoice(s) uploaded.`, 'ok'); if (S.queueTab !== 'queue') { S.queueTab = 'queue'; renderTabs(); } }
      catch (e) { toast('Upload failed: ' + e.message, 'err', 6000); }
      if (btn && seq === S.seq) { btn.disabled = false; btn.innerHTML = `${I.upload} Upload PDFs`; }
      load();
    }

    async function load() {
      const q = `/queue?tab=${S.queueTab}&search=${enc(S.queueSearch)}`;
      const other = S.queueTab === 'queue' ? 'sent' : 'queue';
      try {
        const [d, o] = await Promise.all([api('GET', q), api('GET', `/queue?tab=${other}&search=${enc(S.queueSearch)}`).catch(() => null)]);
        if (seq !== S.seq) return;
        Q.rows = arr(d, 'rows'); Q.err = '';
        Q.counts[S.queueTab] = Q.rows.length;
        if (o) Q.counts[other] = arr(o, 'rows').length;
      } catch (e) { if (seq !== S.seq) return; Q.err = e.message; }
      renderTabs(); renderTable();
    }

    function renderTable() {
      const pa = $('#apip-pall');
      if (pa) { const n = pendingCount(); pa.innerHTML = `${I.play} Process All Pending (${n})`; pa.disabled = S.queueTab !== 'queue'; }
      if (Q.err) { tblEl.innerHTML = errBox(Q.err, ` <button class="apip-btn sm" data-act="retry" style="margin-left:8px">Retry</button>`); return; }
      if (!Q.rows.length) {
        tblEl.innerHTML = `<div class="apip-empty">${S.queueSearch ? 'No invoices match your search.' : S.queueTab === 'sent' ? 'No invoices have been sent for approval yet.' : `No invoices in the queue. Click <b>Upload PDFs</b> or drop PDF files here.`}</div>`;
        return;
      }
      tblEl.innerHTML = `<div class="apip-tw"><table class="apip-tbl"><thead><tr>
        <th>Sr. No</th><th>Invoice Name</th><th>Date</th><th>Processing Status</th><th>Approval Status</th><th>Invoice From</th><th>Action</th></tr></thead><tbody>
        ${Q.rows.map((r, i) => queueRow(r, i)).join('')}</tbody></table></div>`;
    }

    function queueRow(r, i) {
      const ps = String(r.processingStatus || 'pending').toLowerCase();
      const as = String(r.approvalStatus || 'DRAFT').toUpperCase();
      const id = esc(r.id);
      const busy = ps === 'processing';
      const acts = [];
      if (ps === 'pending') acts.push(`<button class="apip-ib p" data-act="process" data-id="${id}" title="Process">${I.play}</button>`);
      else if (ps === 'failed') acts.push(`<button class="apip-ib p" data-act="process" data-id="${id}" title="Re-process">${I.redo}</button>`);
      acts.push(`<button class="apip-ib" data-act="pdf" data-id="${id}" title="View PDF">${I.pdf}</button>`);
      acts.push(`<button class="apip-ib" data-act="json" data-id="${id}" title="View JSON" ${ps === 'pending' || busy ? 'disabled' : ''}>${I.code}</button>`);
      acts.push(`<button class="apip-ib r" data-act="delete" data-id="${id}" title="Delete" ${ps === 'posted' || busy ? 'disabled' : ''}>${I.trash}</button>`);
      if (ps === 'processed' && !['PENDING', 'PARTIAL', 'APPROVED'].includes(as) && as !== 'NOT_REQUIRED')
        acts.push(`<button class="apip-ib o" data-act="send" data-id="${id}" title="Send for approval">⚠ Send</button>`);
      if (['processed', 'duplicate', 'posted', 'failed'].includes(ps))
        acts.push(`<button class="apip-ib b" data-act="view" data-id="${id}" title="Open invoice form">${I.eye}</button>`);
      if (ps === 'processed' && !r.sapDocNum)
        acts.push(`<button class="apip-ib g" data-act="miro" data-id="${id}" title="Post A/P Invoice to SAP">SAP</button>`);
      const errIc = ps === 'failed' && r.error ? `<span class="apip-err-ic" title="${esc(r.error)}">${I.alert}</span>` : '';
      return `<tr>
        <td class="mut">${i + 1}</td>
        <td><div class="nm" title="${esc(r.fileName)}">${esc(r.fileName)}</div>${r.vendorName || r.invoiceNo ? `<div class="mut">${esc(r.vendorName || '')}${r.invoiceNo ? ' · #' + esc(r.invoiceNo) : ''}${r.total != null && r.total !== '' ? ' · ' + fmt(r.total) + ' ' + esc(r.currency || '') : ''}</div>` : ''}</td>
        <td style="white-space:nowrap">${esc(fmtD(r.receivedAt))}<div class="mut">${esc(fmtT(r.receivedAt))}</div></td>
        <td style="white-space:nowrap">${pillP(ps)}${errIc}${r.sapDocNum ? `<div class="mut">SAP #${esc(r.sapDocNum)}</div>` : ''}</td>
        <td>${pillA(as)}</td>
        <td>${sourceLabel(r)}</td>
        <td><div class="apip-acts">${acts.join('')}</div></td></tr>`;
    }

    tblEl.addEventListener('click', async e => {
      const b = e.target.closest('[data-act]');
      if (!b || b.disabled) return;
      const id = b.dataset.id, act = b.dataset.act;
      const row = Q.rows.find(r => String(r.id) === String(id)) || {};
      if (act === 'retry') { tblEl.innerHTML = loading(); return load(); }
      if (act === 'pdf') return window.open(pdfUrl(id), '_blank');
      if (act === 'json') return showJson(id, row.fileName);
      if (act === 'view') return openInvoice(id, { back: 'queue' });
      if (act === 'miro') return openInvoice(id, { back: 'queue', focusPost: true });
      if (act === 'process') {
        b.disabled = true; row.processingStatus = 'processing'; renderTable();
        try { await api('POST', `/queue/${enc(id)}/process`); toast(`Processed: ${row.fileName || id}`, 'ok'); }
        catch (er) { toast(`Processing failed: ${er.message}`, 'err', 6000); }
        return load();
      }
      if (act === 'delete') {
        if (!await confirmDlg(`Delete <b>${esc(row.fileName || id)}</b> from the queue? This cannot be undone.`, { okLabel: 'Delete', okCls: 'bad' })) return;
        try { await api('DELETE', `/queue/${enc(id)}`); toast('Invoice deleted.', 'ok'); } catch (er) { toast(er.message, 'err', 5000); }
        return load();
      }
      if (act === 'send') {
        const body = await pickTemplate();
        if (!body) return;
        try { await api('POST', `/queue/${enc(id)}/send-approval`, body); toast('Sent for approval.', 'ok'); } catch (er) { toast(er.message, 'err', 6000); }
        return load();
      }
    });

    renderTabs();
    load();
    every(5000, () => { if (Q.busyAll || Q.rows.some(r => String(r.processingStatus).toLowerCase() === 'processing')) load(); });
  }

  async function showJson(id, name) {
    const m = modal({ title: `Extracted & Mapped JSON — ${name || id}`, wide: true, body: loading() });
    let d;
    try { d = await api('GET', `/queue/${enc(id)}/json`); }
    catch (e) { m.body.innerHTML = errBox(e.message); return; }
    const parts = { extracted: d.extracted ?? null, mapped: d.mapped ?? null };
    let cur = 'extracted';
    const draw = () => {
      m.body.innerHTML = `<div class="apip-tabs" style="margin-bottom:10px"><button data-j="extracted" class="${cur === 'extracted' ? 'on' : ''}">Extracted (OCR)</button><button data-j="mapped" class="${cur === 'mapped' ? 'on' : ''}">Mapped (SAP)</button><span style="flex:1"></span><button data-copy style="font-weight:500">Copy</button></div>
        <pre class="apip-pre">${esc(JSON.stringify(parts[cur], null, 2))}</pre>`;
      m.body.querySelectorAll('[data-j]').forEach(b => b.onclick = () => { cur = b.dataset.j; draw(); });
      m.body.querySelector('[data-copy]').onclick = () => { navigator.clipboard?.writeText(JSON.stringify(parts[cur], null, 2)).then(() => toast('Copied', 'ok'), () => toast('Copy failed', 'err')); };
    };
    draw();
  }

  // returns {templateId?} or null if cancelled
  function pickTemplate() {
    return new Promise(async res => {
      let done = false;
      const fin = v => { if (!done) { done = true; res(v); } };
      const m = modal({
        title: 'Send for Approval',
        body: loading('Loading templates…'),
        buttons: [{ label: 'Cancel', onClick: x => { fin(null); x.close(); } }, {
          label: `${I.send} Send`, cls: 'org', onClick: x => {
            const v = x.body.querySelector('select')?.value || '';
            fin(v ? { templateId: v } : {}); x.close();
          },
        }],
      });
      m.onClose = () => fin(null);
      let rows = [];
      try { rows = arr(await api('GET', '/templates'), 'rows'); } catch (e) { /* fall back to auto */ }
      m.body.innerHTML = `<div class="apip-f"><label>Approval template</label><select class="apip-in"><option value="">Auto — first matching template</option>${rows.map(t => `<option value="${esc(t.id)}">${esc(t.name)} (${esc(t.stageCount ?? '?')} stage${t.stageCount == 1 ? '' : 's'})</option>`).join('')}</select>
        <div class="hint">Auto selects the first template where you are a requestor and the invoice total is within the stage thresholds.</div></div>`;
    });
  }

  // ═════════════════════════════════════════════════════════════════════════
  // 3. Invoice form (SAP B1 A/P Invoice)
  // ═════════════════════════════════════════════════════════════════════════
  function normalizeMapped(m) {
    m = m && typeof m === 'object' ? JSON.parse(JSON.stringify(m)) : {};
    if (!Array.isArray(m.lines)) m.lines = [];
    if (!m.DocType) m.DocType = 'dDocument_Items';
    if (!Array.isArray(m.warnings)) m.warnings = m.warnings ? [String(m.warnings)] : [];
    if (!m.totals || typeof m.totals !== 'object') m.totals = {};
    return m;
  }
  const lineTotal = l => num(l.Quantity) * num(l.UnitPrice) * (1 - num(l.DiscountPercent) / 100);
  const NUM_KEYS = new Set(['Quantity', 'UnitPrice', 'DiscountPercent']);

  async function openInvoice(id, opts = {}) {
    if (!panel || !visible()) { window.showApipPanel(opts.back || 'queue'); }
    const back = opts.back || (S.view && S.view !== 'invoice' ? S.view : 'queue');
    const mode = opts.mode || 'edit';
    S.inv = { id, back };
    const seq = startView('invoice');
    bodyEl.innerHTML = loading('Loading invoice…');
    let d, lk, st;
    try { [d, lk, st] = await Promise.all([api('GET', `/invoice/${enc(id)}`), getLookups(), getSettings()]); }
    catch (e) {
      if (seq !== S.seq) return;
      bodyEl.innerHTML = `<div style="padding:18px"><button class="apip-btn sm" data-a="back">${I.back} Back</button><div style="height:12px"></div>${errBox(e.message)}</div>`;
      bodyEl.querySelector('[data-a=back]').onclick = () => go(back);
      return;
    }
    if (seq !== S.seq) return;
    const row = d.row || {};
    const posted = String(row.processingStatus).toLowerCase() === 'posted' || !!row.sapDocNum;
    const inv = S.inv = {
      id, back, mode, seq, row, lookups: lk, settings: st || {},
      extracted: d.extracted || {}, mapped: normalizeMapped(d.mapped), approval: d.approval || null,
      ro: mode !== 'edit' || posted, posted, focusPost: !!opts.focusPost,
    };
    inv.fallbackTax = num(inv.mapped.totals.tax ?? inv.extracted.taxTotal);
    renderInvoice();
  }

  function renderInvoice() {
    const inv = S.inv, r = inv.row;
    bodyEl.innerHTML = `<div class="apip-inv">
      <div class="apip-inv-top">
        <button class="apip-btn sm" data-a="back">${I.back} Back</button>
        <div class="ttl"><b>A/P Invoice${inv.mode === 'approve' ? ' — Approval Review' : inv.ro ? ' (read-only)' : ''}</b><span title="${esc(r.fileName)}">${esc(r.fileName || '')}</span></div>
        ${pillP(r.processingStatus)} ${pillA(r.approvalStatus)}
        ${r.sapDocNum ? `<span class="apip-pill indigo" style="text-transform:none">SAP Doc ${esc(r.sapDocNum)}</span>` : ''}
        <div class="sp"></div>
        <button class="apip-btn sm" data-a="sync" title="Refresh cached SAP masters used for mapping">${I.redo} Sync Masters</button>
        <button class="apip-btn sm" data-a="pdf">${I.pdf} Open PDF</button>
      </div>
      <div class="apip-inv-body">
        <div class="apip-inv-left" style="width:${S.splitW}%"><iframe src="${pdfUrl(inv.id)}" title="Invoice PDF"></iframe></div>
        <div class="apip-split" title="Drag to resize"></div>
        <div class="apip-inv-right"><div class="apip-inv-scroll"><div id="apip-inv-msg"></div><div id="apip-inv-form"></div></div><div class="apip-inv-foot" id="apip-inv-foot"></div></div>
      </div></div>`;
    const top = bodyEl.querySelector('.apip-inv-top');
    top.querySelector('[data-a=back]').onclick = () => go(inv.back);
    top.querySelector('[data-a=pdf]').onclick = () => window.open(pdfUrl(inv.id), '_blank');
    top.querySelector('[data-a=sync]').onclick = async e => {
      const b = e.currentTarget; b.disabled = true;
      try {
        const res = await api('POST', '/master-sync');
        const s = res.synced || {};
        toast('Masters synced: ' + (Object.keys(s).map(k => `${k} ${s[k]}`).join(', ') || 'done'), 'ok', 5000);
        S.lookups = null; inv.lookups = await getLookups(true);
        if (!inv.ro) { renderLines(); }
      } catch (er) { toast('Sync failed: ' + er.message, 'err', 6000); }
      b.disabled = false;
    };
    // splitter
    const split = bodyEl.querySelector('.apip-split'), left = bodyEl.querySelector('.apip-inv-left'), ib = bodyEl.querySelector('.apip-inv-body');
    split.addEventListener('mousedown', e => {
      e.preventDefault();
      const ifr = left.querySelector('iframe'); if (ifr) ifr.style.pointerEvents = 'none';
      split.classList.add('drag');
      const rect = ib.getBoundingClientRect();
      const mv = ev => { const p = Math.max(18, Math.min(75, (ev.clientX - rect.left) / rect.width * 100)); S.splitW = p; left.style.width = p + '%'; };
      const up = () => { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); split.classList.remove('drag'); if (ifr) ifr.style.pointerEvents = ''; };
      document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
    });
    renderForm();
    renderFoot();
    if (inv.focusPost) {
      inv.focusPost = false;
      setTimeout(() => {
        bodyEl.querySelector('#apip-totals')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        const pb = bodyEl.querySelector('[data-f-act=post]'); if (pb) { pb.classList.add('pulse'); pb.focus(); }
      }, 120);
    }
  }

  function renderForm() {
    const inv = S.inv, m = inv.mapped, lk = inv.lookups, ex = inv.extracted;
    const dis = inv.ro ? 'disabled' : '';
    const f = (label, inner, req, hint) => `<div class="apip-f"><label>${esc(label)}${req ? ' <i>*</i>' : ''}</label>${inner}${hint ? `<div class="hint">${hint}</div>` : ''}</div>`;
    const inp = (k, type = 'text', extra = '') => `<input class="apip-in" data-f="${k}" type="${type}" value="${esc(type === 'date' ? toISO(m[k]) : (m[k] ?? ''))}" ${dis} ${extra}>`;
    const extras = arr(inv.settings.extraFields).map(x => {
      const k = x.sapField || x.key; if (!k) return '';
      const v = m[k] ?? '';
      let inner;
      if (x.type === 'select') {
        const opts = Array.isArray(x.options) ? x.options : String(x.options || '').split(',').map(s => s.trim()).filter(Boolean);
        inner = `<select class="apip-in" data-f="${esc(k)}" ${dis}><option value=""></option>${opts.map(o => `<option ${String(o) === String(v) ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
      } else inner = `<input class="apip-in" data-f="${esc(k)}" type="${x.type === 'number' ? 'number' : x.type === 'date' ? 'date' : 'text'}" value="${esc(x.type === 'date' ? toISO(v) : v)}" ${dis}>`;
      return f(x.label || x.key, inner, x.required, x.sapField ? esc(x.sapField) : '');
    }).join('');
    const baseLbl = m.BaseEntry ? `${num(m.BaseType) === 20 ? 'GRPO' : 'Purchase Order'} #${esc(m.BaseDocNum || m.BaseEntry)}` : 'None';
    const ocrSummary = (ex.vendorName || ex.invoiceNo || ex.total != null) ? `<div class="apip-msg info" style="display:flex;gap:16px;flex-wrap:wrap"><span><b>OCR:</b> ${esc(ex.vendorName || '—')}${ex.vendorGstin ? ' (' + esc(ex.vendorGstin) + ')' : ''}</span><span>Invoice # <b>${esc(ex.invoiceNo || '—')}</b></span><span>Date <b>${esc(fmtD(ex.invoiceDate) || '—')}</b></span>${ex.poNumber ? `<span>PO <b>${esc(ex.poNumber)}</b></span>` : ''}<span>Total <b>${ex.total != null ? fmt(ex.total) + ' ' + esc(ex.currency || '') : '—'}</b></span></div>` : '';
    const warns = m.warnings.length ? `<div class="apip-msg warn"><b>Warnings</b><ul>${m.warnings.map(w => `<li>${esc(typeof w === 'string' ? w : (w.message || JSON.stringify(w)))}</li>`).join('')}</ul></div>` : '';
    const form = bodyEl.querySelector('#apip-inv-form');
    form.innerHTML = `${ocrSummary}${warns}
      <div class="apip-card"><h3>Header</h3><div class="apip-grid">
        ${f('Vendor Code', `<div style="display:flex;gap:4px"><input class="apip-in" data-f="CardCode" id="apip-vcode" value="${esc(m.CardCode || '')}" placeholder="Type to search…" autocomplete="off" ${dis}>${inv.ro ? '' : `<button class="apip-ib p" style="height:34px" data-a="vsearch" title="Search vendors">${I.search}</button>`}</div>`, true)}
        ${f('Vendor Name', inp('CardName'))}
        ${f('Vendor Ref No.', inp('NumAtCard'), true)}
        ${f('Posting Date', inp('DocDate', 'date'), true)}
        ${f('Due Date', inp('DocDueDate', 'date'))}
        ${f('Document Date', inp('TaxDate', 'date'))}
        ${f('Currency', `<select class="apip-in" data-f="DocCurrency" ${dis}>${optsHtml(lk.currencies, m.DocCurrency, '— Local —')}</select>`)}
        ${f('Series', `<select class="apip-in" data-f="Series" ${dis}>${optsHtml(lk.series, m.Series, '— Default —')}</select>`)}
        ${f('Doc. Type', `<select class="apip-in" data-f="DocType" ${dis}><option value="dDocument_Items" ${m.DocType !== 'dDocument_Service' ? 'selected' : ''}>Item</option><option value="dDocument_Service" ${m.DocType === 'dDocument_Service' ? 'selected' : ''}>Service</option></select>`)}
        ${f('Discount %', inp('DiscountPercent', 'number', 'step="any" min="0" max="100"'))}
        ${f('Base Document', `<div style="display:flex;gap:4px;align-items:center"><input class="apip-in" readonly value="${baseLbl}">${inv.ro ? '' : `<button class="apip-ib i" style="height:34px" data-a="basedoc" title="Link PO / GRPO">${I.link}</button>${m.BaseEntry ? `<button class="apip-ib r" style="height:34px" data-a="baseclear" title="Remove link">${I.x}</button>` : ''}`}</div>`)}
        ${extras}
      </div></div>
      <div class="apip-card"><div class="apip-ch"><h3>Lines</h3><div class="sp"></div>${inv.ro ? '' : `<button class="apip-btn sm" data-a="addline">${I.plus} Add Line</button>`}</div><div id="apip-lines"></div></div>
      <div class="apip-card" id="apip-totals"></div>
      <div class="apip-card"><h3>Remarks</h3><textarea class="apip-in" data-f="Comments" rows="3" ${dis}>${esc(m.Comments || '')}</textarea></div>
      ${approvalTimeline(inv.approval)}`;
    renderLines();
    renderTotals();
    if (inv.ro) return;
    // vendor autocomplete
    const vin = form.querySelector('#apip-vcode');
    attachAC(vin, fetchVendors, h => {
      m.CardCode = h.code; m.CardName = h.name || m.CardName;
      if (h.currency && h.currency !== '##') m.DocCurrency = h.currency;
      vin.value = h.code;
      const nm = form.querySelector('[data-f=CardName]'); if (nm) nm.value = m.CardName || '';
      const cu = form.querySelector('[data-f=DocCurrency]'); if (cu && m.DocCurrency) { cu.innerHTML = optsHtml(inv.lookups.currencies, m.DocCurrency, '— Local —'); }
    });
    form.onclick = e => {
      const b = e.target.closest('[data-a]'); if (!b) return;
      const a = b.dataset.a;
      if (a === 'vsearch') vin._acRun && vin._acRun();
      else if (a === 'addline') { m.lines.push({ ItemCode: '', ItemDescription: '', Quantity: 1, UnitPrice: 0, DiscountPercent: 0, TaxCode: inv.settings.defaultTaxCode || '', WarehouseCode: inv.settings.defaultWarehouse || '', AccountCode: m.DocType === 'dDocument_Service' ? (inv.settings.defaultGlAccount || '') : '' }); renderLines(); renderTotals(); }
      else if (a === 'rmline') { m.lines.splice(+b.dataset.i, 1); renderLines(); renderTotals(); }
      else if (a === 'basedoc') pickBaseDoc();
      else if (a === 'baseclear') { m.BaseType = null; m.BaseEntry = null; m.BaseDocNum = null; m.lines.forEach(l => { l.BaseType = null; l.BaseEntry = null; l.BaseLine = null; }); renderForm(); }
    };
    const onEdit = e => {
      const t = e.target;
      if (t.dataset.f) {
        const k = t.dataset.f;
        m[k] = t.type === 'number' ? (t.value === '' ? null : num(t.value)) : t.value;
        if (k === 'DocType' && e.type === 'change') { renderLines(); }
        if (k === 'DiscountPercent') renderTotals();
        t.classList.remove('bad');
      } else if (t.dataset.l != null && t.dataset.i != null) {
        const l = m.lines[+t.dataset.i]; if (!l) return;
        const k = t.dataset.l;
        l[k] = NUM_KEYS.has(k) ? num(t.value) : t.value;
        t.classList.remove('bad');
        if (NUM_KEYS.has(k) || k === 'TaxCode') {
          const tr = t.closest('tr'); const c = tr && tr.querySelector('.lt'); if (c) c.textContent = fmt(lineTotal(l));
          renderTotals();
        }
      }
    };
    form.oninput = onEdit;
    form.onchange = onEdit;
  }

  function renderLines() {
    const inv = S.inv, m = inv.mapped, lk = inv.lookups;
    const host = bodyEl.querySelector('#apip-lines'); if (!host) return;
    const svc = m.DocType === 'dDocument_Service', dis = inv.ro ? 'disabled' : '';
    const score = s => {
      if (s == null || s === '') return '';
      let v = num(s); if (v <= 1) v *= 100;
      return `<span class="apip-score ${v >= 80 ? 'ok' : v >= 50 ? 'warn' : 'bad'}">${Math.round(v)}% match</span>`;
    };
    if (!m.lines.length) { host.innerHTML = `<div class="apip-empty">No lines. ${inv.ro ? '' : 'Click <b>Add Line</b> or link a base document.'}</div>`; return; }
    host.innerHTML = `<div class="apip-tw"><table class="apip-tbl apip-lines"><thead><tr>
      <th>#</th><th>${svc ? 'G/L Account' : 'Item No.'}</th><th>Description</th><th>OCR Text</th><th class="r">Qty</th><th>UoM</th><th class="r">Unit Price</th><th class="r">Disc %</th><th>Tax Code</th>${svc ? '' : '<th>Warehouse</th>'}<th class="r">Line Total</th><th>Base Ref</th>${inv.ro ? '' : '<th></th>'}</tr></thead><tbody>
      ${m.lines.map((l, i) => `<tr data-i="${i}">
        <td class="mut" style="padding-top:12px">${i + 1}</td>
        <td class="w-code"><input class="apip-in" data-l="${svc ? 'AccountCode' : 'ItemCode'}" data-i="${i}" data-ac="${svc ? 'gl' : 'item'}" value="${esc(svc ? (l.AccountCode || '') : (l.ItemCode || ''))}" placeholder="${svc ? 'G/L account' : 'Item no.'}" autocomplete="off" ${dis}></td>
        <td class="w-desc"><input class="apip-in" data-l="ItemDescription" data-i="${i}" value="${esc(l.ItemDescription || '')}" ${dis}></td>
        <td class="ocr">${esc(l.ocrDescription || '')}${l.ocrDescription ? '<br>' : ''}${score(l.matchScore)}</td>
        <td class="w-n"><input class="apip-in" style="text-align:right" type="number" step="any" data-l="Quantity" data-i="${i}" value="${esc(l.Quantity ?? '')}" ${dis}></td>
        <td><input class="apip-in" style="width:70px" data-l="UoMCode" data-i="${i}" value="${esc(l.UoMCode || '')}" ${dis}></td>
        <td class="w-n"><input class="apip-in" style="text-align:right" type="number" step="any" data-l="UnitPrice" data-i="${i}" value="${esc(l.UnitPrice ?? '')}" ${dis}></td>
        <td><input class="apip-in" style="text-align:right;width:66px" type="number" step="any" data-l="DiscountPercent" data-i="${i}" value="${esc(l.DiscountPercent ?? '')}" ${dis}></td>
        <td class="w-s"><select class="apip-in" data-l="TaxCode" data-i="${i}" ${dis}>${optsHtml(lk.taxCodes, l.TaxCode, '—')}</select></td>
        ${svc ? '' : `<td class="w-s"><select class="apip-in" data-l="WarehouseCode" data-i="${i}" ${dis}>${optsHtml(lk.warehouses, l.WarehouseCode, '—')}</select></td>`}
        <td class="r lt">${fmt(lineTotal(l))}</td>
        <td class="base">${l.BaseEntry ? `${num(l.BaseType) === 20 ? 'GRPO' : 'PO'} ${esc(l.BaseEntry)}/${esc(l.BaseLine ?? '')}` : '—'}</td>
        ${inv.ro ? '' : `<td><button class="apip-x" data-a="rmline" data-i="${i}" title="Remove line">${I.trash}</button></td>`}
      </tr>`).join('')}</tbody></table></div>`;
    if (inv.ro) return;
    host.querySelectorAll('[data-ac]').forEach(inp => {
      const i = +inp.dataset.i;
      const isGl = inp.dataset.ac === 'gl';
      attachAC(inp, isGl ? fetchGL : fetchItems, h => {
        const l = m.lines[i]; if (!l) return;
        if (isGl) { l.AccountCode = h.code; if (!l.ItemDescription) l.ItemDescription = h.name; }
        else {
          l.ItemCode = h.code;
          if (!l.ItemDescription || l.ItemDescription === l.ocrDescription) l.ItemDescription = h.name;
          if (h.uom && !l.UoMCode) l.UoMCode = h.uom;
          if (h.taxCode && !l.TaxCode) l.TaxCode = h.taxCode;
        }
        l.matchScore = 1;
        renderLines(); renderTotals();
      });
    });
  }

  function calcTotals() {
    const inv = S.inv, m = inv.mapped;
    const rates = new Map(inv.lookups.taxCodes.filter(t => t.rate != null).map(t => [t.code, t.rate]));
    const before = m.lines.reduce((s, l) => s + lineTotal(l), 0);
    const hd = num(m.DiscountPercent);
    const discount = before * hd / 100;
    let tax = 0, known = false;
    m.lines.forEach(l => { const r = rates.get(String(l.TaxCode || '')); if (r != null) { known = true; tax += lineTotal(l) * (1 - hd / 100) * r / 100; } });
    if (!known) tax = inv.fallbackTax;
    const t = { beforeDiscount: +before.toFixed(2), discount: +discount.toFixed(2), tax: +tax.toFixed(2), total: +(before - discount + tax).toFixed(2) };
    m.totals = t;
    return t;
  }

  function renderTotals() {
    const inv = S.inv, ex = inv.extracted;
    const host = bodyEl.querySelector('#apip-totals'); if (!host) return;
    const t = calcTotals();
    const ocrTotal = ex.total ?? ex.Total;
    const tol = inv.settings.totalTolerance != null && inv.settings.totalTolerance !== '' ? num(inv.settings.totalTolerance) : 1;
    let cmp = '';
    if (ocrTotal != null && ocrTotal !== '') {
      const diff = t.total - num(ocrTotal);
      const bad = Math.abs(diff) > tol;
      cmp = `<span class="k">OCR Invoice Total</span><span class="v">${fmt(ocrTotal)}</span>
        <span class="k">Difference</span><span class="v ${bad ? 'mm' : 'mok'}">${diff > 0 ? '+' : ''}${fmt(diff)} ${bad ? '⚠ mismatch' : '✓'}</span>`;
    }
    const cur = esc(inv.mapped.DocCurrency || ex.currency || '');
    host.innerHTML = `<div class="apip-ch"><h3>Totals</h3><div class="sp"></div>${cur ? `<span class="apip-pill">${cur}</span>` : ''}</div>
      <div class="apip-tot">
        <span class="k">Total Before Discount</span><span class="v">${fmt(t.beforeDiscount)}</span>
        <span class="k">Discount (${fmt(inv.mapped.DiscountPercent || 0)}%)</span><span class="v">−${fmt(t.discount)}</span>
        <span class="k">Tax</span><span class="v">${fmt(t.tax)}</span>
        <span class="k big">Total Payment Due</span><span class="v big">${fmt(t.total)}</span>
        ${cmp}
      </div>`;
  }

  function approvalTimeline(ap) {
    if (!ap || !arr(ap.stages).length) return '';
    const cls = s => { const v = String(s || '').toUpperCase(); return v === 'APPROVED' ? 'ok' : v === 'REJECTED' ? 'bad' : (v === 'PENDING' || v === 'ACTIVE' || v === 'IN_PROGRESS' || v === 'PARTIAL') ? 'cur' : ''; };
    return `<div class="apip-card"><h3>Approval Timeline${ap.templateName ? ` <span class="apip-pill purple" style="text-transform:none;margin-left:6px">${esc(ap.templateName)}</span>` : ''}</h3>
      <div class="apip-tl">${arr(ap.stages).map(s => `<div class="st ${cls(s.status)}"><b>Stage ${esc(s.no ?? '')}: ${esc(s.name || '')}</b> ${s.status ? pillA(s.status) : ''}
        ${arr(s.approvals).map(a => `<div class="ac"><b>${esc(a.user || '')}</b> — ${esc(String(a.action || '').toLowerCase())} <span style="color:#9ca3af">${esc(fmtDT(a.at))}</span>${a.comment ? `<div style="margin-top:2px">“${esc(a.comment)}”</div>` : ''}</div>`).join('') || '<div class="ac" style="color:#9ca3af">No actions yet</div>'}
      </div>`).join('')}</div></div>`;
  }

  function renderFoot() {
    const inv = S.inv, r = inv.row, as = String(r.approvalStatus || 'DRAFT').toUpperCase();
    const foot = bodyEl.querySelector('#apip-inv-foot');
    if (inv.posted) {
      foot.innerHTML = `<span class="apip-pill indigo" style="text-transform:none">Posted to SAP${r.sapDocNum ? ' — Doc No. ' + esc(r.sapDocNum) : ''}</span><div class="sp"></div><button class="apip-btn" data-f-act="back">${I.back} Back</button>`;
    } else if (inv.mode === 'approve') {
      foot.innerHTML = `<span style="font-size:12px;color:var(--ap-mut)">Review the invoice and record your decision.</span><div class="sp"></div>
        <button class="apip-btn bad" data-f-act="reject">${I.x} Reject</button><button class="apip-btn ok" data-f-act="approve">${I.check} Approve</button>`;
    } else if (inv.ro) {
      foot.innerHTML = `<div class="sp"></div><button class="apip-btn" data-f-act="back">${I.back} Back</button>`;
    } else {
      const lockedSend = ['PENDING', 'PARTIAL', 'APPROVED'].includes(as);
      foot.innerHTML = `<button class="apip-btn" data-f-act="save">Save</button>
        <button class="apip-btn ind" data-f-act="validate">${I.check} Validate</button>
        <div class="sp"></div>
        <button class="apip-btn org" data-f-act="send" ${lockedSend ? 'disabled title="Already in approval"' : ''}>${I.send} Send for Approval</button>
        <button class="apip-btn ok" data-f-act="post">${I.upload} Post to SAP</button>`;
    }
    foot.onclick = e => { const b = e.target.closest('[data-f-act]'); if (b && !b.disabled) footAction(b.dataset.fAct, b); };
  }

  function setBusy(on) { bodyEl.querySelectorAll('#apip-inv-foot button').forEach(b => { if (on) { b.dataset.wasDis = b.disabled ? '1' : ''; b.disabled = true; } else b.disabled = b.dataset.wasDis === '1'; }); }
  function invMsg(html) { const h = bodyEl.querySelector('#apip-inv-msg'); if (h) { h.innerHTML = html; if (html) h.scrollIntoView({ block: 'nearest' }); } }

  async function saveInvoice(silent) {
    const inv = S.inv;
    calcTotals();
    const d = await api('PUT', `/invoice/${enc(inv.id)}`, { mapped: inv.mapped });
    if (S.inv !== inv) return false;
    if (d.mapped) { inv.mapped = normalizeMapped(d.mapped); renderForm(); }
    if (!silent) toast('Invoice saved.', 'ok');
    return true;
  }

  async function footAction(act, btn) {
    const inv = S.inv;
    if (act === 'back') return go(inv.back);
    if (act === 'approve' || act === 'reject') {
      const c = await promptDlg({
        title: act === 'approve' ? 'Approve Invoice' : 'Reject Invoice', label: 'Comment',
        placeholder: act === 'approve' ? 'Optional comment…' : 'Reason for rejection…', required: act === 'reject',
        okLabel: act === 'approve' ? 'Approve' : 'Reject', okCls: act === 'approve' ? 'ok' : 'bad',
      });
      if (c == null) return;
      setBusy(true);
      try { await api('POST', `/approvals/${enc(inv.id)}/${act}`, { comment: c }); toast(act === 'approve' ? 'Invoice approved.' : 'Invoice rejected.', 'ok'); go(inv.back || 'approvals'); }
      catch (e) { toast(e.message, 'err', 6000); invMsg(errBox(e.message)); setBusy(false); }
      return;
    }
    setBusy(true); invMsg('');
    try {
      if (act === 'save') { await saveInvoice(false); }
      else if (act === 'validate') {
        await saveInvoice(true);
        const d = await api('POST', `/invoice/${enc(inv.id)}/validate`);
        showIssues(arr(d, 'issues'));
      } else if (act === 'send') {
        await saveInvoice(true);
        const body = await pickTemplate();
        if (body) {
          const d = await api('POST', `/queue/${enc(inv.id)}/send-approval`, body);
          toast('Sent for approval.', 'ok');
          if (d.row) inv.row = d.row; else inv.row.approvalStatus = 'PENDING';
          renderInvoice(); return;
        }
      } else if (act === 'post') {
        if (!await confirmDlg(`Post this A/P Invoice to SAP Business One${inv.settings.postAsDraft ? ' <b>as a draft</b>' : ''}?<br><span style="color:#6b7280;font-size:12px">Total: <b>${fmt(inv.mapped.totals.total)} ${esc(inv.mapped.DocCurrency || '')}</b> · Vendor: <b>${esc(inv.mapped.CardCode || '—')}</b></span>`, { okLabel: 'Post to SAP', okCls: 'ok' })) { setBusy(false); return; }
        await saveInvoice(true);
        const d = await api('POST', `/invoice/${enc(inv.id)}/post`);
        showPosted(d);
        return;
      }
    } catch (e) {
      const issues = arr(e.data, 'issues');
      invMsg(issues.length ? '' : errBox(e.message));
      if (issues.length) showIssues(issues, e.message);
      toast(e.message, 'err', 6000);
    }
    if (S.inv === inv) setBusy(false);
  }

  function showIssues(issues, headline) {
    const form = bodyEl.querySelector('#apip-inv-form');
    form.querySelectorAll('.bad').forEach(x => x.classList.remove('bad'));
    form.querySelectorAll('tr.rowbad').forEach(x => x.classList.remove('rowbad'));
    if (!issues.length) { invMsg(`<div class="apip-msg ok"><b>${I.check} Validation passed.</b> The invoice is ready to send for approval or post.</div>`); return; }
    const errs = issues.filter(i => String(i.severity || 'error').toLowerCase() === 'error');
    const lineLbl = i => i.line != null && i.line !== '' ? `Line ${num(i.line) + 1}: ` : '';
    invMsg(`<div class="apip-msg ${errs.length ? 'err' : 'warn'}"><b>${esc(headline || (errs.length ? `${errs.length} error(s) found` : 'Warnings'))}</b><ul>
      ${issues.map(i => `<li><b>${esc(String(i.severity || 'error').toUpperCase())}</b> — ${esc(lineLbl(i))}${i.field ? `<code>${esc(i.field)}</code> ` : ''}${esc(i.message)}</li>`).join('')}</ul></div>`);
    issues.forEach(i => {
      let field = String(i.field || ''), line = i.line;
      const mm = field.match(/lines?\[(\d+)\]\.?(\w+)?/i);
      if (mm) { line = +mm[1]; field = mm[2] || ''; }
      if (line != null && line !== '') {
        const tr = form.querySelector(`#apip-lines tr[data-i="${num(line)}"]`);
        if (tr) { tr.classList.add('rowbad'); if (field) tr.querySelector(`[data-l="${field}"]`)?.classList.add('bad'); }
      } else if (field) form.querySelector(`[data-f="${field}"]`)?.classList.add('bad');
    });
  }

  function showPosted(d) {
    const inv = S.inv;
    inv.posted = true; inv.ro = true;
    inv.row.processingStatus = 'posted'; inv.row.sapDocNum = d.docNum; inv.row.sapDocEntry = d.docEntry;
    const sc = bodyEl.querySelector('.apip-inv-scroll');
    sc.innerHTML = `<div class="apip-done"><div class="big">${svg('<polyline points="20 6 9 17 4 12"/>', 30)}</div>
      <h3>${inv.settings.postAsDraft ? 'Draft created in SAP' : 'A/P Invoice posted to SAP'}</h3>
      <div style="color:var(--ap-mut)">${esc(inv.mapped.CardCode || '')} ${esc(inv.mapped.CardName || '')} · Ref ${esc(inv.mapped.NumAtCard || '—')}</div>
      <div class="dn">Doc No. ${esc(d.docNum ?? '—')}</div>
      <div style="font-size:12px;color:var(--ap-mut);margin-bottom:18px">DocEntry ${esc(d.docEntry ?? '—')} · Total ${fmt(inv.mapped.totals.total)} ${esc(inv.mapped.DocCurrency || '')}</div>
      <div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap"><button class="apip-btn pri" data-done="queue">Back to Invoice Queue</button><button class="apip-btn" data-done="view">View Invoice</button></div></div>`;
    sc.querySelector('[data-done=queue]').onclick = () => window.showApipPanel('queue');
    sc.querySelector('[data-done=view]').onclick = () => openInvoice(inv.id, { back: inv.back });
    bodyEl.querySelector('#apip-inv-foot').innerHTML = '';
    toast(`Posted — SAP Doc No. ${d.docNum ?? ''}`, 'ok', 6000);
  }

  async function pickBaseDoc() {
    const inv = S.inv, m = inv.mapped;
    if (!m.CardCode) { toast('Select a vendor first.', 'warn'); bodyEl.querySelector('#apip-vcode')?.focus(); return; }
    const md = modal({ title: `Open Purchase Orders / GRPOs — ${m.CardCode}`, wide: true, body: loading('Loading open documents…') });
    let d;
    try { d = await api('GET', `/open-docs?cardCode=${enc(m.CardCode)}`); } catch (e) { md.body.innerHTML = errBox(e.message); return; }
    const docs = [...arr(d.grpos).map(x => ({ ...x, _bt: 20 })), ...arr(d.pos).map(x => ({ ...x, _bt: 22 }))];
    const lines = x => arr(x.DocumentLines || x.lines || x.Lines);
    if (!docs.length) { md.body.innerHTML = '<div class="apip-empty">No open purchase orders or goods receipts for this vendor.</div>'; return; }
    md.body.innerHTML = `<div class="apip-tw"><table class="apip-tbl"><thead><tr><th>Type</th><th>Doc No.</th><th>Date</th><th>Ref</th><th class="r">Lines</th><th class="r">Total</th><th>Action</th></tr></thead><tbody>
      ${docs.map((x, k) => `<tr><td>${x._bt === 20 ? '<span class="apip-pill indigo">GRPO</span>' : '<span class="apip-pill purple">PO</span>'}</td><td><b>${esc(x.DocNum ?? x.docNum ?? x.DocEntry ?? x.docEntry)}</b></td><td>${esc(fmtD(x.DocDate ?? x.docDate))}</td><td class="mut">${esc(x.NumAtCard || x.numAtCard || '')}</td><td class="r">${lines(x).length}</td><td class="r">${fmt(x.DocTotal ?? x.docTotal ?? 0)} ${esc(x.DocCurrency || x.currency || '')}</td>
        <td><div class="apip-acts"><button class="apip-btn pri sm" data-k="${k}" data-m="copy">Copy lines</button><button class="apip-btn sm" data-k="${k}" data-m="link">Link only</button></div></td></tr>`).join('')}</tbody></table></div>
      <div class="hint" style="font-size:11.5px;color:#6b7280;margin-top:8px"><b>Copy lines</b> replaces the invoice lines with the open lines of the document (OCR text is kept where the item matches). <b>Link only</b> keeps current lines and links matching items.</div>`;
    md.body.onclick = e => {
      const b = e.target.closest('[data-k]'); if (!b) return;
      const x = docs[+b.dataset.k];
      const entry = x.DocEntry ?? x.docEntry;
      m.BaseType = x._bt; m.BaseEntry = entry; m.BaseDocNum = x.DocNum ?? x.docNum ?? entry;
      const src = lines(x).map(l => ({
        ItemCode: l.ItemCode || l.itemCode || '', ItemDescription: l.ItemDescription || l.Dscription || l.description || '', AccountCode: l.AccountCode || l.accountCode || '',
        Quantity: num(l.openQty ?? l.RemainingOpenQuantity ?? l.OpenQty ?? l.Quantity ?? l.quantity), UnitPrice: num(l.price ?? l.UnitPrice ?? l.Price),
        DiscountPercent: num(l.discountPct ?? l.DiscountPercent ?? 0), TaxCode: l.taxCode || l.TaxCode || l.VatGroup || '', WarehouseCode: l.warehouse || l.WarehouseCode || l.WhsCode || '',
        UoMCode: l.uom || l.UoMCode || l.unitMsr || l.MeasureUnit || '', BaseType: x._bt, BaseEntry: entry, BaseLine: l.lineNum ?? l.LineNum ?? null,
      }));
      if (b.dataset.m === 'copy') {
        const old = m.lines.slice();
        m.lines = src.map((l, i) => {
          const o = old.find(z => z.ItemCode && z.ItemCode === l.ItemCode) || old[i];
          if (o) { l.ocrDescription = o.ocrDescription; l.matchScore = o.matchScore; }
          return l;
        });
      } else {
        const used = new Set();
        m.lines.forEach(l => {
          const k = src.findIndex((s, j) => !used.has(j) && s.ItemCode && s.ItemCode === l.ItemCode);
          if (k >= 0) { used.add(k); l.BaseType = x._bt; l.BaseEntry = entry; l.BaseLine = src[k].BaseLine; }
        });
      }
      md.close();
      renderForm();
      toast(`Linked ${x._bt === 20 ? 'GRPO' : 'PO'} ${m.BaseDocNum}.`, 'ok');
    };
  }

  // ═════════════════════════════════════════════════════════════════════════
  // 4. Invoice Approval
  // ═════════════════════════════════════════════════════════════════════════
  const APPR_TABS = [
    { k: 'mine', l: 'Your Approval', c: '#f59e0b' }, { k: 'partial', l: 'Partially Approved', c: '#3b82f6' },
    { k: 'approved', l: 'Approved', c: '#22c55e' }, { k: 'rejected', l: 'Rejected', c: '#ef4444' },
  ];
  function vApprovals() {
    const seq = startView('approvals');
    const u = curUser();
    const nm = u.name || u.fullName || u.displayName || u.username || 'User';
    const initials = String(nm).split(/\s+/).map(s => s[0]).join('').slice(0, 2).toUpperCase();
    const A = { rows: [], counts: {}, err: '' };
    bodyEl.innerHTML = pageHead('Invoice Approvals', 'Review and approve invoices pending your approval', `<button class="apip-btn" data-a="refresh">${I.redo} Refresh</button>`) +
      `<div class="apip-card"><div class="apip-who"><div class="apip-av">${esc(initials)}</div><div><div style="font-size:11.5px;color:var(--ap-mut)">Logged in as</div><div style="font-weight:700;font-size:14px">${esc(nm)}</div><div style="font-size:12px;color:var(--ap-mut)">${esc(u.role || u.roleName || '')}${u.email ? ' · ' + esc(u.email) : ''}</div></div></div></div>
       <div class="apip-card"><div class="apip-ch"><h3>Invoice Status</h3><div class="sp"></div>${searchBox('apip-asearch', 'Search invoices or vendors...', S.apprSearch)}</div>
         <div class="apip-tabs" id="apip-atabs"></div><div id="apip-atbl">${loading()}</div></div>`;
    const tabsEl = bodyEl.querySelector('#apip-atabs'), tblEl = bodyEl.querySelector('#apip-atbl');
    bodyEl.querySelector('[data-a=refresh]').onclick = () => load();
    const renderTabs = () => { tabsEl.innerHTML = APPR_TABS.map(t => `<button data-t="${t.k}" class="${S.apprTab === t.k ? 'on' : ''}"><span class="apip-dot" style="background:${t.c}"></span>${t.l}${A.counts[t.k] != null ? ` <span class="apip-badge">${A.counts[t.k]}</span>` : ''}</button>`).join(''); };
    tabsEl.addEventListener('click', e => { const b = e.target.closest('[data-t]'); if (b) { S.apprTab = b.dataset.t; renderTabs(); tblEl.innerHTML = loading(); load(); } });
    bodyEl.querySelector('#apip-asearch').addEventListener('input', debounce(e => { S.apprSearch = e.target.value.trim(); load(); }, 300));
    tblEl.addEventListener('click', e => { const b = e.target.closest('[data-view]'); if (b) openInvoice(b.dataset.view, { back: 'approvals', mode: S.apprTab === 'mine' ? 'approve' : 'view' }); });

    async function load() {
      const res = await Promise.allSettled(APPR_TABS.map(t => api('GET', `/approvals?tab=${t.k}&search=${enc(S.apprSearch)}`)));
      if (seq !== S.seq) return;
      res.forEach((r, i) => { if (r.status === 'fulfilled') A.counts[APPR_TABS[i].k] = arr(r.value, 'rows').length; });
      const cur = res[APPR_TABS.findIndex(t => t.k === S.apprTab)];
      if (cur.status === 'fulfilled') { A.rows = arr(cur.value, 'rows'); A.err = ''; } else A.err = cur.reason?.message || 'Failed to load approvals';
      renderTabs(); render();
    }
    function render() {
      if (A.err) { tblEl.innerHTML = errBox(A.err); return; }
      if (!A.rows.length) { tblEl.innerHTML = `<div class="apip-empty">${S.apprTab === 'mine' ? 'Nothing is waiting for your approval. 🎉' : 'No invoices in this status.'}</div>`; return; }
      tblEl.innerHTML = `<div class="apip-tw"><table class="apip-tbl"><thead><tr><th>Invoice Details</th><th>Stage</th><th>Status</th><th>Progress</th><th>SAP Doc Number</th><th>Date</th><th>Actions</th></tr></thead><tbody>
        ${A.rows.map(r => {
          const pct = Math.max(0, Math.min(100, num(r.progressPct ?? (r.requiredCount ? r.approvedCount / r.requiredCount * 100 : 0))));
          const st = String(r.status || '').toUpperCase();
          const col = st === 'REJECTED' ? '#ef4444' : pct >= 100 ? '#22c55e' : '#3b82f6';
          return `<tr><td><div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap"><span class="nm" title="${esc(r.fileName)}">${esc(r.fileName)}</span>${pillA(st)}</div><div class="mut">Vendor: ${esc(r.vendorName || '—')}</div></td>
            <td style="white-space:nowrap"><b>Stage ${esc(r.stageNo ?? '—')} of ${esc(r.stageCount ?? '—')}</b><div class="mut">${esc(r.stageName || '')}${r.templateName ? ' · ' + esc(r.templateName) : ''}</div></td>
            <td>${pillA(st)}</td>
            <td><div class="apip-prog"><div class="tx"><span>${esc(r.approvedCount ?? 0)}/${esc(r.requiredCount ?? 0)} approved</span><b>${Math.round(pct)}%</b></div><div class="apip-bar"><div style="width:${pct}%;background:${col}"></div></div></div></td>
            <td>${r.sapDocNum ? `<b>${esc(r.sapDocNum)}</b>` : '<span class="mut">—</span>'}</td>
            <td style="white-space:nowrap">${esc(fmtD(r.date))}<div class="mut">${esc(fmtT(r.date))}</div></td>
            <td><button class="apip-btn sm ${S.apprTab === 'mine' ? 'pri' : ''}" data-view="${esc(r.id)}">${I.eye} View</button></td></tr>`;
        }).join('')}</tbody></table></div>`;
    }
    renderTabs();
    load();
  }

  // ═════════════════════════════════════════════════════════════════════════
  // 5. Approval Stage (flat list)
  // ═════════════════════════════════════════════════════════════════════════
  function vStages() {
    const seq = startView('stages');
    let rows = [], q = '';
    bodyEl.innerHTML = pageHead('Approval Stages', 'All approval stages across templates, with approvers and pending workload',
      `<button class="apip-btn blue" data-a="master">Manage Templates</button>`) +
      `<div class="apip-card"><div class="apip-ch"><h3>Stages</h3><span class="apip-sub" id="apip-scount" style="margin:0"></span><div class="sp"></div>${searchBox('apip-ssearch', 'Search template, stage or approver...')}</div><div id="apip-stbl">${loading()}</div></div>`;
    bodyEl.querySelector('[data-a=master]').onclick = () => window.showApipPanel('master');
    const tbl = bodyEl.querySelector('#apip-stbl');
    bodyEl.querySelector('#apip-ssearch').addEventListener('input', e => { q = e.target.value.trim().toLowerCase(); render(); });
    function render() {
      const f = rows.filter(r => !q || [r.templateName, r.name, r.description, ...arr(r.approvers).map(a => a.name)].join(' ').toLowerCase().includes(q));
      bodyEl.querySelector('#apip-scount').textContent = `Showing ${f.length} of ${rows.length} stages`;
      if (!f.length) { tbl.innerHTML = `<div class="apip-empty">${rows.length ? 'No stages match your search.' : 'No approval stages defined yet. Create a template in Approval Master.'}</div>`; return; }
      tbl.innerHTML = `<div class="apip-tw"><table class="apip-tbl"><thead><tr><th>Template</th><th class="c">Stage No.</th><th>Stage Name</th><th class="c">Approvals Req.</th><th class="c">Rejectors Req.</th><th class="r">Max Invoice Total</th><th>Approvers</th><th class="c">Pending</th></tr></thead><tbody>
        ${f.map(r => `<tr><td><b>${esc(r.templateName)}</b></td><td class="c"><span class="apip-badge">${esc(r.stageNo)}</span></td><td><b>${esc(r.name)}</b>${r.description ? `<div class="mut">${esc(r.description)}</div>` : ''}</td>
          <td class="c">${esc(r.approvalsRequired ?? 1)}</td><td class="c">${esc(r.rejectorsRequired ?? 1)}</td>
          <td class="r">${r.maxInvoiceTotal != null && r.maxInvoiceTotal !== '' && num(r.maxInvoiceTotal) > 0 ? fmt(r.maxInvoiceTotal) : '<span class="mut">No limit</span>'}</td>
          <td><div style="display:flex;flex-wrap:wrap;gap:4px">${arr(r.approvers).map(a => `<span class="apip-chip ${a.type === 'role' ? 'role' : ''}" style="padding-right:9px">${a.type === 'role' ? I.users : ''}${esc(a.name || a.id)}</span>`).join('') || '<span class="mut">—</span>'}</div></td>
          <td class="c">${num(r.pendingCount) ? `<span class="apip-pill amber">${esc(r.pendingCount)}</span>` : '<span class="mut">0</span>'}</td></tr>`).join('')}</tbody></table></div>`;
    }
    api('GET', '/approval-stages').then(d => { if (seq !== S.seq) return; rows = arr(d, 'rows', 'stages'); render(); })
      .catch(e => { if (seq === S.seq) tbl.innerHTML = errBox(e.message); });
  }

  // ═════════════════════════════════════════════════════════════════════════
  // 6. Approval Master (templates)
  // ═════════════════════════════════════════════════════════════════════════
  function vMaster() {
    const seq = startView('master');
    let rows = [], q = '';
    bodyEl.innerHTML = pageHead('Approval Templates', 'Manage approval workflow templates and configurations',
      `<button class="apip-btn blue" data-a="create">${I.plus} Create Template</button>`) +
      `<div class="apip-card"><div class="apip-ch">${searchBox('apip-tsearch', 'Search templates...')}<div class="sp"></div><span id="apip-tcount" style="font-size:12px;color:var(--ap-mut)"></span></div><div id="apip-ttbl">${loading()}</div></div>`;
    bodyEl.querySelector('[data-a=create]').onclick = () => templateForm(null);
    const tbl = bodyEl.querySelector('#apip-ttbl');
    bodyEl.querySelector('#apip-tsearch').addEventListener('input', e => { q = e.target.value.trim().toLowerCase(); render(); });
    function render() {
      const f = rows.filter(r => !q || `${r.name} ${r.description}`.toLowerCase().includes(q));
      bodyEl.querySelector('#apip-tcount').textContent = `Showing ${f.length} of ${rows.length} templates`;
      if (!f.length) { tbl.innerHTML = `<div class="apip-empty">${rows.length ? 'No templates match your search.' : 'No approval templates yet. Click <b>+ Create Template</b> to define one.'}</div>`; return; }
      tbl.innerHTML = `<div class="apip-tw"><table class="apip-tbl"><thead><tr><th>Template Name</th><th>Description</th><th class="c">Stages</th><th>Settings</th><th>Requestors</th><th>Actions</th></tr></thead><tbody>
        ${f.map(r => `<tr><td><div style="display:flex;align-items:center;gap:10px"><div style="width:34px;height:34px;border-radius:9px;background:#dbeafe;color:#2563eb;display:flex;align-items:center;justify-content:center;flex-shrink:0">${I.tpl}</div><div><b>${esc(r.name)}</b><div class="mut">Created ${esc(fmtD(r.createdAt))}</div></div></div></td>
          <td style="max-width:320px">${esc(r.description || '')}</td>
          <td class="c"><span class="apip-badge">${esc(r.stageCount ?? 0)}</span></td>
          <td>${r.settingsEnabled ? '<span class="apip-pill ok">Enabled</span>' : '<span class="apip-pill">Disabled</span>'}</td>
          <td><span style="display:inline-flex;align-items:center;gap:5px;color:#4b5563">${I.users}<b>${esc(r.requestorCount ?? 0)}</b></span></td>
          <td><div class="apip-acts"><button class="apip-ib b" data-e="${esc(r.id)}" title="Edit">${I.edit}</button><button class="apip-ib" data-n="${esc(r.id)}" title="Details">${I.info}</button><button class="apip-ib r" data-d="${esc(r.id)}" title="Delete">${I.trash}</button></div></td></tr>`).join('')}</tbody></table></div>`;
    }
    tbl.addEventListener('click', async e => {
      const ed = e.target.closest('[data-e]'), inf = e.target.closest('[data-n]'), del = e.target.closest('[data-d]');
      if (ed) templateForm(ed.dataset.e);
      else if (inf) templateInfo(inf.dataset.n);
      else if (del) {
        const r = rows.find(x => String(x.id) === del.dataset.d) || {};
        if (!await confirmDlg(`Delete template <b>${esc(r.name || del.dataset.d)}</b>? Invoices already in approval keep their history.`, { okLabel: 'Delete', okCls: 'bad' })) return;
        try { await api('DELETE', `/templates/${enc(del.dataset.d)}`); toast('Template deleted.', 'ok'); load(); } catch (er) { toast(er.message, 'err', 6000); }
      }
    });
    function load() {
      api('GET', '/templates').then(d => { if (seq !== S.seq) return; rows = arr(d, 'rows'); render(); })
        .catch(e => { if (seq === S.seq) tbl.innerHTML = errBox(e.message); });
    }
    load();
  }

  async function templateInfo(id) {
    const m = modal({ title: 'Template Details', wide: true, body: loading() });
    try {
      const t = (await api('GET', `/templates/${enc(id)}`)).template || {};
      const chips = l => arr(l).map(a => `<span class="apip-chip ${a.type === 'role' ? 'role' : ''}" style="padding-right:9px">${a.type === 'role' ? I.users : ''}${esc(a.name || a.id)}</span>`).join(' ') || '<span style="color:#9ca3af">—</span>';
      const ad = t.additionalSettings || {};
      m.body.innerHTML = `<h3 style="margin:0 0 4px;font-size:16px">${esc(t.name)}</h3><p style="margin:0 0 12px;color:#6b7280">${esc(t.description || '')}</p>
        <div class="apip-f" style="margin-bottom:12px"><label>Requestors</label><div style="display:flex;flex-wrap:wrap;gap:4px">${chips(t.requestors)}</div></div>
        <div class="apip-f" style="margin-bottom:12px"><label>Additional Settings</label>${ad.enabled ? `Enabled · Deviation ${esc(ad.deviationPct ?? 0)}% · Vendors: ${esc(arr(ad.vendorCodes).join(', ') || 'All')}` : 'Disabled'}</div>
        ${arr(t.stages).map((s, i) => `<div class="apip-stage"><div class="sh"><span class="no">${i + 1}</span><b>${esc(s.name)}</b><span class="apip-pill">${esc(s.approvalsRequired ?? 1)} approval(s) · ${esc(s.rejectorsRequired ?? 1)} rejector(s)${num(s.maxInvoiceTotal) > 0 ? ' · ≤ ' + fmt(s.maxInvoiceTotal) : ''}</span></div><div style="color:#6b7280;margin-bottom:8px">${esc(s.description || '')}</div><div style="display:flex;flex-wrap:wrap;gap:4px">${chips(s.approvers)}</div></div>`).join('')}`;
    } catch (e) { m.body.innerHTML = errBox(e.message); }
  }

  async function templateForm(id) {
    const seq = startView('master');
    bodyEl.innerHTML = loading('Loading…');
    let principals = { users: [], roles: [] }, t;
    try {
      const [p, td] = await Promise.all([api('GET', '/principals').catch(e => { toast('Could not load users/roles: ' + e.message, 'err'); return {}; }), id ? api('GET', `/templates/${enc(id)}`) : Promise.resolve(null)]);
      principals = { users: arr(p?.users), roles: arr(p?.roles) };
      t = td ? td.template : null;
    } catch (e) {
      if (seq !== S.seq) return;
      bodyEl.innerHTML = `<button class="apip-btn sm" data-a="back">${I.back} Back</button><div style="height:12px"></div>${errBox(e.message)}`;
      bodyEl.querySelector('[data-a=back]').onclick = () => vMaster();
      return;
    }
    if (seq !== S.seq) return;
    const options = [...principals.users.map(u => ({ type: 'user', id: u.id, name: u.name || u.username || String(u.id) })), ...principals.roles.map(r => ({ type: 'role', id: r.id, name: r.name || String(r.id) }))];
    const newStage = () => ({ name: '', description: '', approvalsRequired: 1, rejectorsRequired: 1, maxInvoiceTotal: '', approvers: [] });
    const T = t ? JSON.parse(JSON.stringify(t)) : { name: '', description: '', requestors: [], additionalSettings: { enabled: false, deviationPct: 0, vendorCodes: [] }, stages: [newStage()] };
    T.requestors = arr(T.requestors); T.stages = arr(T.stages); if (!T.stages.length) T.stages.push(newStage());
    T.additionalSettings = Object.assign({ enabled: false, deviationPct: 0, vendorCodes: [] }, T.additionalSettings || {});
    T.stages.forEach(s => { s.approvers = arr(s.approvers); });

    bodyEl.innerHTML = `<div class="apip-ph"><div style="display:flex;gap:12px;align-items:flex-start"><button class="apip-btn sm" data-a="back">${I.back} Back</button><div><h2>Approval Master</h2><p>Configure approval templates and stages${id ? ' — editing <b>' + esc(T.name) + '</b>' : ''}</p></div></div>
        <div class="apip-ph-r"><button class="apip-btn" data-a="cancel">Cancel</button><button class="apip-btn blue" data-a="save">${I.check} Save</button></div></div>
      <div id="apip-tmsg"></div>
      <div class="apip-card"><h3>Template Information</h3>
        <div class="apip-grid2">
          <div class="apip-f"><label>Template Name <i>*</i></label><input class="apip-in" data-t="name" value="${esc(T.name)}" placeholder="e.g. Standard AP Approval"><div class="ferr" data-err="name"></div></div>
          <div class="apip-f"><label>Description <i>*</i></label><input class="apip-in" data-t="description" value="${esc(T.description)}" placeholder="What this template is used for"><div class="ferr" data-err="description"></div></div>
        </div>
        <div class="apip-f" style="margin-top:12px"><label>Requestors <i>*</i></label><div id="apip-req"></div><div class="hint">Users or roles whose invoices use this template.</div><div class="ferr" data-err="requestors"></div></div>
        <div class="apip-tgrow" style="margin-top:8px">${toggle('data-t="adEnabled"', T.additionalSettings.enabled)}<div class="t"><b>Additional Settings</b><span>Restrict by price deviation and vendor codes</span></div></div>
        <div id="apip-adv" class="apip-grid2" style="${T.additionalSettings.enabled ? '' : 'display:none'}">
          <div class="apip-f"><label>Deviation %</label><input class="apip-in" type="number" step="any" min="0" data-t="deviationPct" value="${esc(T.additionalSettings.deviationPct ?? 0)}"><div class="hint">Apply only when the invoice deviates from PO / GRPO by more than this %.</div></div>
          <div class="apip-f"><label>Vendor Codes</label><input class="apip-in" data-t="vendorCodes" value="${esc(arr(T.additionalSettings.vendorCodes).join(', '))}" placeholder="V0001, V0002"><div class="hint">Comma separated. Blank = all vendors.</div></div>
        </div>
      </div>
      <div class="apip-card"><div class="apip-ch"><h3>Approval Stages <i style="color:#dc2626;font-style:normal">*</i></h3><div class="sp"></div><button class="apip-btn sm blue" data-a="addstage">${I.plus} Add Stage</button></div><div class="ferr" data-err="stages" style="font-size:11.5px;color:#dc2626"></div><div id="apip-stages"></div></div>`;
    const $ = s => bodyEl.querySelector(s);
    const reqSel = chipSelect($('#apip-req'), options, T.requestors, { onChange: () => reqSel.setInvalid(false) });
    let stageSels = [];
    function renderStages() {
      const host = $('#apip-stages');
      host.innerHTML = T.stages.map((s, i) => `<div class="apip-stage" data-si="${i}"><div class="sh"><span class="no">${i + 1}</span><b>Stage ${i + 1}</b>${T.stages.length > 1 ? `<button class="apip-x" data-rmstage="${i}" title="Delete stage">${I.trash}</button>` : ''}</div>
        <div class="apip-grid2">
          <div class="apip-f"><label>Stage Name <i>*</i></label><input class="apip-in" data-s="name" data-si="${i}" value="${esc(s.name)}" placeholder="e.g. Finance Manager"><div class="ferr" data-err="s${i}name"></div></div>
          <div class="apip-f"><label>Description <i>*</i></label><input class="apip-in" data-s="description" data-si="${i}" value="${esc(s.description)}"><div class="ferr" data-err="s${i}description"></div></div>
        </div>
        <div class="apip-grid" style="margin-top:12px">
          <div class="apip-f"><label>Approvals Required</label><input class="apip-in" type="number" min="1" step="1" data-s="approvalsRequired" data-si="${i}" value="${esc(s.approvalsRequired ?? 1)}"><div class="ferr" data-err="s${i}approvalsRequired"></div></div>
          <div class="apip-f"><label>Rejectors Required</label><input class="apip-in" type="number" min="1" step="1" data-s="rejectorsRequired" data-si="${i}" value="${esc(s.rejectorsRequired ?? 1)}"><div class="ferr" data-err="s${i}rejectorsRequired"></div></div>
          <div class="apip-f"><label>Invoice Total (max amount)</label><input class="apip-in" type="number" min="0" step="any" data-s="maxInvoiceTotal" data-si="${i}" value="${esc(s.maxInvoiceTotal ?? '')}" placeholder="No limit"><div class="hint">Stage applies to invoices up to this total.</div></div>
        </div>
        <div class="apip-f" style="margin-top:12px"><label>Approvers <i>*</i></label><div data-appr="${i}"></div><div class="ferr" data-err="s${i}approvers"></div></div>
      </div>`).join('');
      stageSels = T.stages.map((s, i) => chipSelect(host.querySelector(`[data-appr="${i}"]`), options, s.approvers, { placeholder: 'Search approvers…', onChange: () => stageSels[i].setInvalid(false) }));
    }
    renderStages();
    bodyEl.addEventListener('input', e => {
      const el = e.target;
      if (el.dataset.t) {
        const k = el.dataset.t;
        if (k === 'name' || k === 'description') T[k] = el.value;
        else if (k === 'deviationPct') T.additionalSettings.deviationPct = num(el.value);
        else if (k === 'vendorCodes') T.additionalSettings.vendorCodes = el.value.split(',').map(s => s.trim()).filter(Boolean);
        el.classList.remove('bad');
      } else if (el.dataset.s) {
        const s = T.stages[+el.dataset.si]; const k = el.dataset.s;
        s[k] = ['approvalsRequired', 'rejectorsRequired'].includes(k) ? Math.max(0, parseInt(el.value, 10) || 0) : k === 'maxInvoiceTotal' ? (el.value === '' ? null : num(el.value)) : el.value;
        el.classList.remove('bad');
      }
    });
    bodyEl.addEventListener('change', e => {
      if (e.target.dataset.t === 'adEnabled') { T.additionalSettings.enabled = e.target.checked; $('#apip-adv').style.display = e.target.checked ? '' : 'none'; }
    });
    bodyEl.addEventListener('click', async e => {
      const a = e.target.closest('[data-a]'), rm = e.target.closest('[data-rmstage]');
      if (rm) { T.stages.splice(+rm.dataset.rmstage, 1); renderStages(); return; }
      if (!a) return;
      if (a.dataset.a === 'back' || a.dataset.a === 'cancel') return vMaster();
      if (a.dataset.a === 'addstage') { T.stages.push(newStage()); renderStages(); $('#apip-stages').lastElementChild?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); return; }
      if (a.dataset.a === 'save') {
        if (!validate()) { $('#apip-tmsg').innerHTML = `<div class="apip-msg err">Please fill in all required fields.</div>`; bodyEl.querySelector('.bad')?.scrollIntoView({ behavior: 'smooth', block: 'center' }); return; }
        a.disabled = true; $('#apip-tmsg').innerHTML = '';
        const body = {
          name: T.name.trim(), description: T.description.trim(), requestors: T.requestors,
          additionalSettings: { enabled: !!T.additionalSettings.enabled, deviationPct: num(T.additionalSettings.deviationPct), vendorCodes: arr(T.additionalSettings.vendorCodes) },
          stages: T.stages.map(s => ({ name: s.name.trim(), description: s.description.trim(), approvalsRequired: Math.max(1, parseInt(s.approvalsRequired, 10) || 1), rejectorsRequired: Math.max(1, parseInt(s.rejectorsRequired, 10) || 1), maxInvoiceTotal: s.maxInvoiceTotal === '' || s.maxInvoiceTotal == null ? null : num(s.maxInvoiceTotal), approvers: s.approvers })),
        };
        try {
          await api(id ? 'PUT' : 'POST', id ? `/templates/${enc(id)}` : '/templates', body);
          toast(id ? 'Template updated.' : 'Template created.', 'ok');
          vMaster();
        } catch (er) { $('#apip-tmsg').innerHTML = errBox(er.message); a.disabled = false; bodyEl.scrollTop = 0; }
      }
    });
    function validate() {
      bodyEl.querySelectorAll('.ferr').forEach(x => { x.textContent = ''; });
      bodyEl.querySelectorAll('.bad').forEach(x => x.classList.remove('bad'));
      let ok = true;
      const fail = (key, msg, el) => { ok = false; const er = bodyEl.querySelector(`[data-err="${key}"]`); if (er) er.textContent = msg; if (el) el.classList.add('bad'); };
      if (!T.name.trim()) fail('name', 'Template name is required.', $('[data-t=name]'));
      if (!T.description.trim()) fail('description', 'Description is required.', $('[data-t=description]'));
      if (!T.requestors.length) { fail('requestors', 'Select at least one requestor.'); reqSel.setInvalid(true); }
      if (!T.stages.length) fail('stages', 'Add at least one approval stage.');
      T.stages.forEach((s, i) => {
        const el = k => bodyEl.querySelector(`[data-s="${k}"][data-si="${i}"]`);
        if (!String(s.name || '').trim()) fail(`s${i}name`, 'Stage name is required.', el('name'));
        if (!String(s.description || '').trim()) fail(`s${i}description`, 'Description is required.', el('description'));
        if (!s.approvers.length) { fail(`s${i}approvers`, 'Select at least one approver.'); stageSels[i] && stageSels[i].setInvalid(true); }
        if ((parseInt(s.approvalsRequired, 10) || 0) < 1) fail(`s${i}approvalsRequired`, 'Must be at least 1.', el('approvalsRequired'));
        else if (s.approvers.length && s.approvers.every(a => a.type === 'user') && s.approvalsRequired > s.approvers.length) fail(`s${i}approvalsRequired`, `Cannot exceed the number of approvers (${s.approvers.length}).`, el('approvalsRequired'));
        if ((parseInt(s.rejectorsRequired, 10) || 0) < 1) fail(`s${i}rejectorsRequired`, 'Must be at least 1.', el('rejectorsRequired'));
      });
      return ok;
    }
  }

  // ═════════════════════════════════════════════════════════════════════════
  // 7. Mail Configuration
  // ═════════════════════════════════════════════════════════════════════════
  function vMail() {
    const seq = startView('mail');
    let rows = [];
    bodyEl.innerHTML = pageHead('Mail Configuration', 'Mailboxes polled over IMAP for incoming PDF invoices',
      `<button class="apip-btn" data-a="refresh">${I.redo} Refresh</button><button class="apip-btn pri" data-a="add">${I.plus} Add Mailbox</button>`) + `<div id="apip-mlist">${loading()}</div>`;
    const host = bodyEl.querySelector('#apip-mlist');
    bodyEl.querySelector('[data-a=add]').onclick = () => mailForm(null);
    bodyEl.querySelector('[data-a=refresh]').onclick = () => load();
    function render() {
      if (!rows.length) { host.innerHTML = `<div class="apip-card"><div class="apip-empty">No mailboxes configured. Click <b>Add Mailbox</b> to start receiving invoices by email.</div></div>`; return; }
      host.innerHTML = `<div class="apip-mcards">${rows.map(r => `<div class="apip-mcard">
        <div class="hd"><div class="ic">${I.mail}</div><b title="${esc(r.name)}">${esc(r.name)}</b>${toggle(`data-en="${esc(r.id)}"`, r.enabled)}</div>
        <div class="apip-kv"><span>Server</span><span title="${esc(r.imapHost)}">${esc(r.imapHost)}:${esc(r.imapPort)} ${r.imapTls ? '(TLS)' : ''}</span>
          <span>User</span><span title="${esc(r.user)}">${esc(r.user)}</span><span>Folder</span><span>${esc(r.folder || 'INBOX')}</span>
          <span>Subject filter</span><span>${r.subjectFilter ? `<code>${esc(r.subjectFilter)}</code>` : 'Any'}</span><span>Poll every</span><span>${esc(r.pollSec || 60)} s</span>
          <span>Last check</span><span>${esc(fmtDT(r.lastCheck))}</span></div>
        ${r.lastError ? `<div class="apip-msg err" style="margin:0;font-size:11.5px">${I.alert} ${esc(r.lastError)}</div>` : r.lastCheck ? '<div style="font-size:11.5px;color:#15803d">● Last check OK</div>' : ''}
        <div class="ft"><button class="apip-btn sm" data-ed="${esc(r.id)}">${I.edit} Edit</button><button class="apip-btn sm" data-ts="${esc(r.id)}">${I.check} Test</button><span style="flex:1"></span><button class="apip-btn sm" style="color:#dc2626" data-del="${esc(r.id)}">${I.trash} Delete</button></div>
      </div>`).join('')}</div>`;
    }
    host.addEventListener('click', async e => {
      const ed = e.target.closest('[data-ed]'), ts = e.target.closest('[data-ts]'), del = e.target.closest('[data-del]');
      if (ed) mailForm(rows.find(r => String(r.id) === ed.dataset.ed));
      else if (ts) testMail(ts.dataset.ts, ts);
      else if (del) {
        const r = rows.find(x => String(x.id) === del.dataset.del) || {};
        if (!await confirmDlg(`Delete mailbox <b>${esc(r.name || '')}</b>?`, { okLabel: 'Delete', okCls: 'bad' })) return;
        try { await api('DELETE', `/mail-configs/${enc(del.dataset.del)}`); toast('Mailbox deleted.', 'ok'); load(); } catch (er) { toast(er.message, 'err', 6000); }
      }
    });
    host.addEventListener('change', async e => {
      const t = e.target.closest('[data-en]'); if (!t) return;
      const r = rows.find(x => String(x.id) === t.dataset.en); if (!r) return;
      const { lastCheck, lastError, ...rest } = r;
      try { await api('PUT', `/mail-configs/${enc(r.id)}`, { ...rest, enabled: t.checked }); r.enabled = t.checked; toast(`${r.name} ${t.checked ? 'enabled' : 'disabled'}.`, 'ok'); }
      catch (er) { t.checked = !t.checked; toast(er.message, 'err', 6000); }
    });
    function load() {
      api('GET', '/mail-configs').then(d => { if (seq !== S.seq) return; rows = arr(d, 'rows'); render(); })
        .catch(e => { if (seq === S.seq) host.innerHTML = errBox(e.message); });
    }
    function mailForm(r) {
      const v = Object.assign({ name: '', imapHost: '', imapPort: 993, imapTls: true, user: '', folder: 'INBOX', subjectFilter: '', pollSec: 60, enabled: true }, r || {});
      const fld = (k, label, type = 'text', req, ph = '', hint = '') => `<div class="apip-f"><label>${label}${req ? ' <i>*</i>' : ''}</label><input class="apip-in" data-k="${k}" type="${type}" value="${esc(v[k] ?? '')}" placeholder="${esc(ph)}" autocomplete="off">${hint ? `<div class="hint">${hint}</div>` : ''}</div>`;
      const btns = [{ label: 'Cancel' }];
      if (r) btns.push({ label: `${I.check} Test`, onClick: x => testMail(r.id, x.btn(1)) });
      btns.push({
        label: 'Save', cls: 'pri', onClick: async x => {
          const g = k => x.body.querySelector(`[data-k="${k}"]`);
          const body = { name: g('name').value.trim(), imapHost: g('imapHost').value.trim(), imapPort: parseInt(g('imapPort').value, 10) || 993, imapTls: g('imapTls').checked, user: g('user').value.trim(), folder: g('folder').value.trim() || 'INBOX', subjectFilter: g('subjectFilter').value, pollSec: Math.max(10, parseInt(g('pollSec').value, 10) || 60), enabled: g('enabled').checked };
          const pw = g('password').value;
          if (pw) body.password = pw;
          const miss = ['name', 'imapHost', 'user'].filter(k => !body[k]);
          if (!r && !pw) miss.push('password');
          x.body.querySelectorAll('.bad').forEach(el => el.classList.remove('bad'));
          miss.forEach(k => g(k).classList.add('bad'));
          const msg = x.body.querySelector('#apip-mmsg');
          if (miss.length) { msg.innerHTML = '<div class="apip-msg err">Please fill in the required fields.</div>'; return; }
          if (body.subjectFilter) { try { new RegExp(body.subjectFilter); } catch { g('subjectFilter').classList.add('bad'); msg.innerHTML = '<div class="apip-msg err">Subject filter is not a valid regular expression.</div>'; return; } }
          const sv = x.btn(btns.length - 1); sv.disabled = true;
          try { await api(r ? 'PUT' : 'POST', r ? `/mail-configs/${enc(r.id)}` : '/mail-configs', body); toast('Mailbox saved.', 'ok'); x.close(); load(); }
          catch (er) { msg.innerHTML = errBox(er.message); sv.disabled = false; }
        },
      });
      modal({
        title: r ? `Edit Mailbox — ${r.name}` : 'Add Mailbox', wide: true, buttons: btns,
        body: `<div id="apip-mmsg"></div><div class="apip-grid2">
          ${fld('name', 'Name', 'text', true, 'e.g. AP Inbox')}
          ${fld('imapHost', 'IMAP Host', 'text', true, 'imap.example.com')}
          ${fld('imapPort', 'Port', 'number', true)}
          <div class="apip-f"><label>Security</label><div class="apip-tgrow" style="padding:6px 0">${toggle('data-k="imapTls"', v.imapTls)}<div class="t"><b>Use TLS / SSL</b></div></div></div>
          ${fld('user', 'User', 'text', true, 'ap@example.com')}
          <div class="apip-f"><label>Password${r ? '' : ' <i>*</i>'}</label><input class="apip-in" data-k="password" type="password" autocomplete="new-password" placeholder="${r ? 'Leave blank to keep current' : ''}"></div>
          ${fld('folder', 'Folder', 'text', false, 'INBOX')}
          ${fld('subjectFilter', 'Subject Filter (regex)', 'text', false, 'invoice|bill', 'Blank = any subject')}
          ${fld('pollSec', 'Poll Interval (seconds)', 'number', false)}
          <div class="apip-f"><label>Status</label><div class="apip-tgrow" style="padding:6px 0">${toggle('data-k="enabled"', v.enabled)}<div class="t"><b>Enabled</b></div></div></div>
        </div>`,
      });
    }
    async function testMail(id, btn) {
      if (btn) btn.disabled = true;
      try { const r = await api('POST', `/mail-configs/${enc(id)}/test`); toast(r.message || 'Connection successful.', 'ok', 5000); }
      catch (e) { toast('Test failed: ' + e.message, 'err', 7000); }
      if (btn) btn.disabled = false;
      if (S.view === 'mail') load();
    }
    load();
  }

  // ═════════════════════════════════════════════════════════════════════════
  // 8. Settings
  // ═════════════════════════════════════════════════════════════════════════
  async function vSettings() {
    const seq = startView('settings');
    bodyEl.innerHTML = loading('Loading settings…');
    let st, lk;
    try { [st, lk] = await Promise.all([api('GET', '/settings').then(d => d.settings || {}), getLookups()]); }
    catch (e) { if (seq === S.seq) bodyEl.innerHTML = pageHead('Settings', 'AP Invoice Processing configuration') + errBox(e.message); return; }
    if (seq !== S.seq) return;
    S.settings = st;
    const v = JSON.parse(JSON.stringify(st)); delete v.settings;
    v.extraFields = arr(v.extraFields).map(f => ({ ...f, options: Array.isArray(f.options) ? f.options.join(', ') : (f.options || '') }));
    const txt = (k, label, ph = '', hint = '') => `<div class="apip-f"><label>${label}</label><input class="apip-in" data-k="${k}" value="${esc(v[k] ?? '')}" placeholder="${esc(ph)}">${hint ? `<div class="hint">${hint}</div>` : ''}<div class="ferr" data-err="${k}"></div></div>`;
    const nmb = (k, label, hint = '', step = 'any') => `<div class="apip-f"><label>${label}</label><input class="apip-in" type="number" step="${step}" min="0" data-k="${k}" value="${esc(v[k] ?? '')}">${hint ? `<div class="hint">${hint}</div>` : ''}<div class="ferr" data-err="${k}"></div></div>`;
    const sel = (k, label, list, blank) => `<div class="apip-f"><label>${label}</label><select class="apip-in" data-k="${k}">${optsHtml(list, v[k], blank)}</select><div class="ferr" data-err="${k}"></div></div>`;
    const tg = (k, label, sub) => `<div class="apip-tgrow">${toggle(`data-k="${k}"`, !!v[k])}<div class="t"><b>${label}</b>${sub ? `<span>${sub}</span>` : ''}</div></div>`;
    const card = (title, icon, inner) => `<div class="apip-card"><h3 style="display:flex;align-items:center;gap:8px"><span style="color:var(--ap-p)">${icon}</span>${title}</h3>${inner}</div>`;
    bodyEl.innerHTML = pageHead('Settings', 'Intake, processing, approval and SAP posting configuration', `<button class="apip-btn" data-a="reload">${I.redo} Reload</button><button class="apip-btn pri" data-a="save">${I.check} Save Settings</button>`) +
      `<div id="apip-smsg"></div>
      ${card('Folder Intake', I.folder, `<div class="apip-grid2">${txt('inputFolder', 'Input Folder Path', 'D:\\Invoices\\In', 'New PDFs in this folder are picked up automatically.')}${txt('processedFolder', 'Processed Folder Path', 'D:\\Invoices\\Processed')}${txt('failedFolder', 'Failed Folder Path', 'D:\\Invoices\\Failed')}${nmb('folderPollSec', 'Poll Interval (seconds)', 'Default 30', '1')}</div>${tg('folderWatchEnabled', 'Watch input folder', 'Scan the input folder on every poll interval')}`)}
      ${card('Mail Intake', I.mail, `${tg('mailEnabled', 'Enable mail intake', 'Poll all enabled mailboxes configured under Mail Configuration')}<button class="apip-btn sm" data-a="mailcfg" style="margin-top:6px">Open Mail Configuration</button>`)}
      ${card('Processing', I.gear, `<div class="apip-grid2"><div class="apip-f"><label>OCR Engine</label><select class="apip-in" data-k="ocrEngine"><option value="ai" ${v.ocrEngine !== 'text' ? 'selected' : ''}>AI vision (recommended)</option><option value="text" ${v.ocrEngine === 'text' ? 'selected' : ''}>PDF text extraction</option></select></div>${nmb('priceTolerancePct', 'Price Tolerance %', 'Allowed unit price deviation vs PO / GRPO')}${nmb('totalTolerance', 'Total Tolerance (amount)', 'Allowed difference between computed and OCR total')}</div>${tg('autoProcess', 'Auto process', 'OCR-process new queue items immediately')}${tg('duplicateCheck', 'Duplicate check', 'Flag invoices with the same vendor + invoice number already posted')}`)}
      ${card('Approval', I.users.replace(/13/g, '18'), `${tg('approvalRequired', 'Approval required', 'Invoices must be approved before posting')}${tg('autoSendApproval', 'Auto send for approval', 'Send processed invoices to the first matching template automatically')}${tg('postWithoutApproval', 'Allow posting without approval', 'Override approval requirement when posting')}${tg('autoPostOnApproval', 'Auto post on final approval', 'Post to SAP as soon as the last stage approves')}`)}
      ${card('SAP Posting', I.upl, `${tg('postAsDraft', 'Post as draft', 'Create A/P Invoice drafts instead of final documents')}<div class="apip-grid2" style="margin-top:8px">${sel('defaultSeries', 'Default Series', lk.series, '— SAP default —')}${sel('defaultTaxCode', 'Default Tax Code', lk.taxCodes, '— None —')}${sel('defaultWarehouse', 'Default Warehouse', lk.warehouses, '— None —')}<div class="apip-f"><label>Default G/L Account</label><input class="apip-in" data-k="defaultGlAccount" id="apip-sgl" value="${esc(v.defaultGlAccount ?? '')}" placeholder="Type to search…" autocomplete="off"><div class="hint">Used for service-type invoices.</div></div><div class="apip-f"><label>Default Doc Type</label><select class="apip-in" data-k="defaultDocType"><option value="dDocument_Items" ${v.defaultDocType !== 'dDocument_Service' ? 'selected' : ''}>Item</option><option value="dDocument_Service" ${v.defaultDocType === 'dDocument_Service' ? 'selected' : ''}>Service</option></select></div></div>${lk.error ? `<div class="apip-msg warn" style="margin-top:10px">SAP lookups unavailable: ${esc(lk.error)}</div>` : ''}`)}
      <div class="apip-card"><div class="apip-ch"><h3>Custom Fields</h3><div class="sp"></div><button class="apip-btn sm" data-a="addcf">${I.plus} Add Field</button></div><p class="apip-sub" style="margin:-6px 0 12px">Extra header fields shown on the invoice form and posted to SAP (e.g. user-defined fields <code>U_xxx</code>).</p><div id="apip-cf"></div></div>
      <div style="display:flex;justify-content:flex-end"><button class="apip-btn pri" data-a="save">${I.check} Save Settings</button></div>`;
    const $ = s => bodyEl.querySelector(s);
    const gl = $('#apip-sgl');
    attachAC(gl, fetchGL, h => { gl.value = h.code; v.defaultGlAccount = h.code; });
    function renderCF() {
      const host = $('#apip-cf');
      if (!v.extraFields.length) { host.innerHTML = '<div class="apip-empty" style="padding:16px">No custom fields.</div>'; return; }
      host.innerHTML = `<div class="apip-tw"><table class="apip-tbl apip-cf"><thead><tr><th>Key *</th><th>Label *</th><th>Type</th><th>Options (select)</th><th>SAP Field</th><th class="c">Required</th><th></th></tr></thead><tbody>
        ${v.extraFields.map((f, i) => `<tr><td><input class="apip-in" data-cf="key" data-i="${i}" value="${esc(f.key || '')}" placeholder="costCenter" style="min-width:110px"></td>
          <td><input class="apip-in" data-cf="label" data-i="${i}" value="${esc(f.label || '')}" placeholder="Cost Center" style="min-width:130px"></td>
          <td><select class="apip-in" data-cf="type" data-i="${i}" style="min-width:92px">${['text', 'number', 'date', 'select'].map(t => `<option ${f.type === t ? 'selected' : ''}>${t}</option>`).join('')}</select></td>
          <td><input class="apip-in" data-cf="options" data-i="${i}" value="${esc(f.options || '')}" placeholder="A, B, C" ${f.type === 'select' ? '' : 'disabled'} style="min-width:120px"></td>
          <td><input class="apip-in" data-cf="sapField" data-i="${i}" value="${esc(f.sapField || '')}" placeholder="U_CostCenter" style="min-width:120px"></td>
          <td class="c"><input type="checkbox" data-cf="required" data-i="${i}" ${f.required ? 'checked' : ''}></td>
          <td><button class="apip-x" data-rmcf="${i}" title="Remove">${I.trash}</button></td></tr>`).join('')}</tbody></table></div>`;
    }
    renderCF();
    const onEdit = e => {
      const el = e.target;
      if (el.dataset.k) { v[el.dataset.k] = el.type === 'checkbox' ? el.checked : el.type === 'number' ? (el.value === '' ? null : num(el.value)) : el.value; el.classList.remove('bad'); }
      else if (el.dataset.cf) {
        const f = v.extraFields[+el.dataset.i]; if (!f) return;
        f[el.dataset.cf] = el.type === 'checkbox' ? el.checked : el.value;
        el.classList.remove('bad');
        if (el.dataset.cf === 'type' && e.type === 'change') renderCF();
      }
    };
    bodyEl.addEventListener('input', onEdit);
    bodyEl.addEventListener('change', onEdit);
    bodyEl.addEventListener('click', async e => {
      const rm = e.target.closest('[data-rmcf]');
      if (rm) { v.extraFields.splice(+rm.dataset.rmcf, 1); renderCF(); return; }
      const a = e.target.closest('[data-a]'); if (!a) return;
      if (a.dataset.a === 'addcf') { v.extraFields.push({ key: '', label: '', type: 'text', options: '', sapField: '', required: false }); renderCF(); return; }
      if (a.dataset.a === 'reload') return vSettings();
      if (a.dataset.a === 'mailcfg') return window.showApipPanel('mail');
      if (a.dataset.a === 'save') save();
    });
    async function save() {
      const msg = $('#apip-smsg');
      bodyEl.querySelectorAll('.bad').forEach(x => x.classList.remove('bad'));
      bodyEl.querySelectorAll('.ferr').forEach(x => { x.textContent = ''; });
      // client-side checks
      const errs = [];
      const keys = new Set();
      v.extraFields.forEach((f, i) => {
        const g = k => bodyEl.querySelector(`[data-cf="${k}"][data-i="${i}"]`);
        if (!String(f.key || '').trim()) { errs.push(`Custom field ${i + 1}: key is required.`); g('key')?.classList.add('bad'); }
        else if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(f.key.trim())) { errs.push(`Custom field ${i + 1}: key may only contain letters, digits and _.`); g('key')?.classList.add('bad'); }
        else if (keys.has(f.key.trim())) { errs.push(`Custom field ${i + 1}: duplicate key "${f.key}".`); g('key')?.classList.add('bad'); }
        keys.add(String(f.key || '').trim());
        if (!String(f.label || '').trim()) { errs.push(`Custom field ${i + 1}: label is required.`); g('label')?.classList.add('bad'); }
        if (f.sapField && !/^U_\w+$/.test(f.sapField.trim()) && !/^[A-Za-z]\w*$/.test(f.sapField.trim())) { errs.push(`Custom field ${i + 1}: invalid SAP field name.`); g('sapField')?.classList.add('bad'); }
        if (f.type === 'select' && !String(f.options || '').trim()) { errs.push(`Custom field ${i + 1}: select type needs options.`); g('options')?.classList.add('bad'); }
      });
      const fp = ['inputFolder', 'processedFolder', 'failedFolder'].map(k => String(v[k] || '').trim().toLowerCase().replace(/[\\/]+$/, ''));
      if (fp[0] && (fp[0] === fp[1] || fp[0] === fp[2])) { errs.push('Input folder must differ from processed / failed folders.'); $('[data-k=inputFolder]')?.classList.add('bad'); }
      if (errs.length) { msg.innerHTML = `<div class="apip-msg err"><b>Please fix the following:</b><ul>${errs.map(x => `<li>${esc(x)}</li>`).join('')}</ul></div>`; bodyEl.scrollTop = 0; return; }
      const out = { ...v };
      delete out.settings;
      out.extraFields = v.extraFields.map(f => ({
        key: f.key.trim(), label: f.label.trim(), type: f.type || 'text',
        options: f.type === 'select' ? String(f.options || '').split(',').map(s => s.trim()).filter(Boolean) : undefined,
        sapField: String(f.sapField || '').trim(), required: !!f.required,
      }));
      bodyEl.querySelectorAll('[data-a=save]').forEach(b => { b.disabled = true; });
      try {
        const d = await api('PUT', '/settings', Object.assign({}, out, { settings: out }));
        S.settings = d.settings || out;
        msg.innerHTML = '<div class="apip-msg ok">Settings saved.</div>';
        toast('Settings saved.', 'ok');
      } catch (e) {
        const dt = e.data || {};
        let extra = '';
        const list = Array.isArray(dt.errors) ? dt.errors : dt.errors && typeof dt.errors === 'object' ? Object.entries(dt.errors).map(([field, message]) => ({ field, message })) : [];
        if (dt.field) list.push({ field: dt.field, message: dt.error });
        list.forEach(x => {
          const field = typeof x === 'string' ? '' : x.field;
          const m = typeof x === 'string' ? x : x.message;
          if (field) { $(`[data-k="${field}"]`)?.classList.add('bad'); const fe = $(`[data-err="${field}"]`); if (fe) fe.textContent = m || ''; }
        });
        if (list.length) extra = `<ul>${list.map(x => `<li>${esc(typeof x === 'string' ? x : `${x.field ? x.field + ': ' : ''}${x.message || ''}`)}</li>`).join('')}</ul>`;
        msg.innerHTML = errBox(e.message, extra);
        bodyEl.scrollTop = 0;
      }
      bodyEl.querySelectorAll('[data-a=save]').forEach(b => { b.disabled = false; });
    }
  }

  // ── Public ─────────────────────────────────────────────────────────────────
  window.ApipUI = { esc, api, toast, modal, confirmDlg, openInvoice: (id, o) => { if (!panel || !visible()) window.showApipPanel((o && o.back) || 'queue'); openInvoice(id, o || {}); } };
})();
