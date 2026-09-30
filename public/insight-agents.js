// ══════════════════════════════════════════════════════════════════════════════
// INSIGHT AGENTS — one generic full-height panel for the 8 analytical agents
// (Collections, Cash Flow, Credit Risk, Sales Follow-up, Quotation Intelligence,
// Inventory Optimization, Dead Stock, Vendor Performance).
//
// Every agent's backend (controllers/*-agent.mjs via lib/insight-kit.mjs)
// returns the same payload — kpis / chart / tabs(columns, rows, actions) /
// insight / notes — so this file renders all of them. Open one with
// showInsightAgent('<key>').
// ══════════════════════════════════════════════════════════════════════════════
(function () {
  'use strict';

  const AGENTS = {
    collections: {
      title: 'Collections & Receivables', badge: 'A/R', api: '/api/collections-agent', c1: '#7C2D12', c2: '#EA580C',
      icon: '<path d="M12 1v22M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>',
      params: [
        { key: 'lookbackMonths', label: 'Payment history (months)', type: 'number', value: 12 },
        { key: 'minOverdueDays', label: 'Min. days overdue', type: 'number', value: 0 },
        { key: 'search', label: 'Customer filter', type: 'text', placeholder: 'code or name' },
      ],
      chips: ['Who should we chase first today?', 'Which customers are getting worse at paying?', 'Summarise the >90 day overdue', 'Draft a call plan for this week'],
    },
    cashflow: {
      title: 'Cash Flow Forecast', badge: 'TREASURY', api: '/api/cash-flow-agent', c1: '#064E3B', c2: '#059669',
      icon: '<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>',
      params: [
        { key: 'weeks', label: 'Horizon (weeks)', type: 'number', value: 13 },
        { key: 'openingBalance', label: 'Opening balance', type: 'number', placeholder: 'auto: G/L cash accounts' },
      ],
      chips: ['Which weeks are at risk of a cash shortfall?', 'What are the biggest drivers of outflow?', 'Which collections would fix the lowest week?', 'Which POs could be deferred?'],
    },
    creditrisk: {
      title: 'Credit Risk', badge: 'RISK', api: '/api/credit-risk-agent', c1: '#7F1D1D', c2: '#DC2626',
      icon: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
      params: [],
      chips: ['Which customers should go on credit hold?', 'Where are open orders most exposed?', 'Which customers deserve a higher limit?', 'Who worsened since the last run?'],
    },
    appayment: {
      title: 'AP Payment Optimization', badge: 'PAYMENT RUN', api: '/api/ap-payment-agent', c1: '#164E63', c2: '#0891B2', asOfLabel: 'Payment date',
      icon: '<rect x="1" y="4" width="22" height="16" rx="2"/><line x1="1" y1="10" x2="23" y2="10"/><line x1="6" y1="15" x2="10" y2="15"/>',
      params: [
        { key: 'cashAvailable', label: 'Cash available', type: 'number', placeholder: 'auto: G/L cash & bank' },
        { key: 'reserve', label: 'Keep in reserve', type: 'number', value: 0 },
        { key: 'horizonDays', label: 'Window (days)', type: 'number', value: 14 },
        { key: 'strategy', label: 'Strategy', type: 'select', value: 'balanced', options: ['balanced', 'discounts', 'overdue', 'preserve'] },
        { key: 'hurdleRatePct', label: 'Discount hurdle % p.a.', type: 'number', value: 12 },
        { key: 'allowPartial', label: 'Partial payments', type: 'select', value: 'no', options: ['no', 'yes'] },
        { key: 'priorityVendors', label: 'Priority vendors', type: 'text', placeholder: 'codes, comma-separated' },
      ],
      chips: ['Which invoices must we pay this week and why?', 'What happens if we only have half the cash?', 'Which vendors are we leaving unpaid, and what is the risk?', 'Which early-payment discounts are worth taking?'],
    },
    profitability: {
      title: 'Profitability', badge: 'GROSS PROFIT', api: '/api/profitability-agent', c1: '#14532D', c2: '#16A34A', asOfLabel: 'Period to',
      icon: '<line x1="12" y1="20" x2="12" y2="10"/><line x1="18" y1="20" x2="18" y2="4"/><line x1="6" y1="20" x2="6" y2="16"/>',
      params: [
        { key: 'days', label: 'Last N days', type: 'number', value: 90 },
        { key: 'fromDate', label: 'Or from date', type: 'date' },
        { key: 'includeCreditMemos', label: 'Net of credit memos', type: 'select', value: 'yes', options: ['yes', 'no'] },
      ],
      chips: ['Where do we make and lose money?', 'Which customers dilute our margin?', 'Compare sales employees by profit', 'Which items should we reprice?'],
    },
    marginleak: {
      title: 'Margin Leakage', badge: 'LEAKAGE', api: '/api/margin-leakage-agent', c1: '#7F1D1D', c2: '#E11D48', asOfLabel: 'Period to',
      icon: '<path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z"/>',
      params: [
        { key: 'days', label: 'Last N days', type: 'number', value: 90 },
        { key: 'fromDate', label: 'Or from date', type: 'date' },
        { key: 'targetMarginPct', label: 'Target margin %', type: 'number', value: 15 },
        { key: 'maxDiscountPct', label: 'Max discount %', type: 'number', value: 10 },
        { key: 'anomalyPct', label: 'Anomaly: % below median', type: 'number', value: 25 },
      ],
      chips: ['What are the biggest sources of leakage?', 'Who is giving the most discount?', 'Are we recovering freight?', 'Which controls would stop this?'],
    },
    commission: {
      title: 'Sales Commission', badge: 'PAYOUT', api: '/api/sales-commission-agent', c1: '#713F12', c2: '#CA8A04', asOfLabel: 'Period to',
      icon: '<circle cx="12" cy="8" r="7"/><polyline points="8.21 13.89 7 23 12 20 17 23 15.79 13.88"/>',
      params: [
        { key: 'fromDate', label: 'Period from', type: 'date' },
        { key: 'basis', label: 'Commission basis', type: 'select', options: ['', 'sales', 'collections', 'margin'] },
        { key: 'defaultRatePct', label: 'Default rate %', type: 'number', placeholder: '2' },
        { key: 'minMarginPct', label: 'Min margin % (0 = off)', type: 'number', placeholder: '0' },
        { key: 'useSapRates', label: 'Use SAP employee %', type: 'select', options: ['', 'yes', 'no'] },
        { key: 'salespersonRates', label: 'Sales employee rates', type: 'text', placeholder: 'Devraj=2.5; Zankhana=3' },
        { key: 'customerRules', label: 'Customer rules', type: 'text', placeholder: 'CUS00001=3; CUS00002=0' },
      ],
      chips: ['Summarise commission by sales employee', 'Is anyone earning commission on low-margin sales?', 'Compare sales vs collections basis', 'Which sales have no sales employee?'],
    },
    monthend: {
      title: 'Month-End Closing', badge: 'CLOSE', api: '/api/month-end-agent', c1: '#1E293B', c2: '#475569', asOfLabel: 'Period end', asOfDefault: 'monthEnd',
      icon: '<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/><polyline points="9 16 11 18 15 14"/>',
      params: [],
      chips: ['What must be done before we can close?', 'How much should we accrue?', 'Give me a close plan by team', 'Which items are critical and why?'],
    },
    salesfollowup: {
      title: 'Sales Follow-up', badge: 'PIPELINE', api: '/api/sales-followup-agent', c1: '#1E3A8A', c2: '#2563EB',
      icon: '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.79 19.79 0 0 1 2.12 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"/>',
      params: [
        { key: 'quoteStaleDays', label: 'Quote stale after (days)', type: 'number', value: 7 },
        { key: 'activityGapDays', label: 'No-contact gap (days)', type: 'number', value: 7 },
      ],
      chips: ['Who should each salesperson call today?', 'Which quotes are most likely to be lost?', 'Which delayed orders need a customer update?', 'Summarise by salesperson'],
    },
    quoteintel: {
      title: 'Quotation Intelligence', badge: 'PRICING', api: '/api/quotation-intel-agent', c1: '#4C1D95', c2: '#8B5CF6',
      icon: '<path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/>',
      params: [
        { key: 'minMarginPct', label: 'Min. margin %', type: 'number', value: 15 },
        { key: 'targetMarginPct', label: 'Target margin %', type: 'number', value: 25 },
        { key: 'itemCode', label: 'Price check: item code', type: 'text', placeholder: 'blank = all open quotes' },
        { key: 'cardCode', label: 'Customer code', type: 'text', placeholder: 'optional' },
        { key: 'qty', label: 'Qty', type: 'number', placeholder: '1' },
        { key: 'proposedPrice', label: 'Proposed price', type: 'number', placeholder: 'optional' },
        { key: 'competitorPrice', label: 'Competitor price', type: 'number', placeholder: 'optional' },
      ],
      chips: ['Which quote lines leak margin?', 'Which quotes risk losing the deal on price?', 'What price should we quote and why?', 'Summarise pricing vs history'],
    },
    scforecast: {
      title: 'Supply Chain Demand Forecast', badge: 'S&OP', api: '/api/demand-forecast-agent', c1: '#1E3A8A', c2: '#2563EB',
      icon: '<polyline points="3 17 9 11 13 15 21 7"/><polyline points="14 7 21 7 21 14"/><line x1="3" y1="21" x2="21" y2="21"/>',
      params: [
        { key: 'item', label: 'Chart item', type: 'text', placeholder: 'blank = all items (value)' },
        { key: 'historyMonths', label: 'History (months)', type: 'number', value: 36 },
        { key: 'horizonMonths', label: 'Horizon (months)', type: 'number', value: 12 },
        { key: 'demandSource', label: 'Actual demand from', type: 'select', value: 'invoices', options: ['invoices', 'orders'] },
        { key: 'safetyMarginPct', label: 'Safety margin %', type: 'number', value: 25 },
        { key: 'defaultLeadTime', label: 'Default lead time (d)', type: 'number', value: 30 },
        { key: 'confidence', label: 'Confidence %', type: 'select', value: '95', options: ['80', '90', '95', '99'] },
        { key: 'excessMonths', label: 'Excess after (months)', type: 'number', value: 6 },
        { key: 'stalePoDays', label: 'Ignore POs late > (days)', type: 'number', value: 180 },
        { key: 'warehouse', label: 'Warehouse', type: 'text', placeholder: 'all' },
        { key: 'group', label: 'Item group', type: 'text', placeholder: 'contains…' },
        { key: 'arrivalField', label: 'PO target-delivery UDF', type: 'text', placeholder: 'e.g. U_TargetDelDate' },
        { key: 'depositField', label: 'PO deposit UDF', type: 'text', placeholder: 'e.g. U_DepositDate' },
      ],
      chips: ['Prepare the S&OP summary for this month', 'Which items will stock out and when?', 'What must we order this week, from whom?', 'Which items are selling faster or slower than plan?', 'Where is the forecast least reliable?'],
    },
    invopt: {
      title: 'Inventory Optimization', badge: 'MIN / MAX', api: '/api/inventory-optimization-agent', c1: '#134E4A', c2: '#0D9488',
      icon: '<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/>',
      params: [
        { key: 'lookbackDays', label: 'Demand lookback (days)', type: 'number', value: 180 },
        { key: 'serviceLevel', label: 'Service level %', type: 'select', value: '95', options: ['90', '95', '97.5', '99'] },
        { key: 'reviewDays', label: 'Review period (days)', type: 'number', value: 14 },
        { key: 'defaultLeadTime', label: 'Default lead time (days)', type: 'number', value: 14 },
        { key: 'warehouse', label: 'Warehouse', type: 'text', placeholder: 'all' },
      ],
      chips: ['What must we order this week?', 'Where is capital tied up in excess stock?', 'Which Min/Max settings should change first?', 'Explain the safety stock for the top A items'],
    },
    deadstock: {
      title: 'Dead Stock', badge: 'SLOW-MOVING', api: '/api/dead-stock-agent', c1: '#78350F', c2: '#D97706',
      icon: '<rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2"/><line x1="4" y1="11" x2="20" y2="19"/>',
      params: [
        { key: 'slowDays', label: 'Slow after (days)', type: 'number', value: 90 },
        { key: 'deadDays', label: 'Dead after (days)', type: 'number', value: 180 },
        { key: 'warehouse', label: 'Warehouse', type: 'text', placeholder: 'all' },
        { key: 'minValue', label: 'Min. line value', type: 'number', value: 0 },
      ],
      chips: ['What is the disposal plan by value?', 'Which purchases should be frozen now?', 'Which items can be transferred?', 'Which item groups hold the most dead stock?'],
    },
    vendorperf: {
      title: 'Vendor Performance', badge: 'SCORECARD', api: '/api/vendor-performance-agent', c1: '#312E81', c2: '#4F46E5',
      icon: '<path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>',
      params: [{ key: 'lookbackMonths', label: 'Lookback (months)', type: 'number', value: 12 }],
      chips: ['Who are our best and worst vendors?', 'Where can we save by switching vendors?', 'Which overdue POs should we escalate?', 'Which vendors need an improvement plan?'],
    },
  };

  const state = {};           // key → { data, params, tab, sessionId, chat:[], sort, search, limit }
  let current = null, chart = null;
  const PANEL_ID = 'insight-agent-panel';

  // ── helpers ────────────────────────────────────────────────────────────────
  const tok = () => localStorage.getItem('hanny_token') || '';
  async function call(url, body) {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-auth-token': tok() }, body: JSON.stringify(body || {}) });
    const ct = r.headers.get('content-type') || '';
    if (!ct.includes('json')) throw new Error(`Server returned ${r.status} (non-JSON). Restart: npm run chat`);
    const d = await r.json();
    if (!r.ok || d.ok === false) throw new Error(d.error || r.statusText);
    return d;
  }
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // Markdown with all raw HTML escaped first (DB values can contain anything).
  const md = s => {
    const safe = String(s || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return typeof marked !== 'undefined' ? marked.parse(safe) : esc(s).replace(/\n/g, '<br>');
  };
  // Formatted per call (not built at load) so they pick up the company locale
  // once refreshAppCurrency() has set window.APP_LOCALE.
  const nfOf = opts => ({ format: v => Number(v).toLocaleString(window.APP_LOCALE || 'en-US', opts) });
  const nf0 = nfOf({ maximumFractionDigits: 0 });
  const nf2 = nfOf({ minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const nfN = nfOf({ maximumFractionDigits: 2 });
  function fmt(v, f) {
    if (v === null || v === undefined || v === '' || (typeof v === 'number' && !isFinite(v))) return '<span class="ia-muted">—</span>';
    switch (f) {
      case 'amt': return nf0.format(v);
      case 'price': return nf2.format(v);
      case 'num': return nfN.format(v);
      case 'int': return nf0.format(Math.round(v));
      case 'pct': return `${nfN.format(Math.round(v * 10) / 10)}%`;
      case 'date': return esc(String(v).slice(0, 10));
      default: return esc(v);
    }
  }
  const TONES = {
    red: ['#FEE2E2', '#991B1B'], amber: ['#FEF3C7', '#92400E'], green: ['#DCFCE7', '#166534'],
    blue: ['#DBEAFE', '#1E40AF'], purple: ['#EDE9FE', '#5B21B6'], grey: ['#F1F5F9', '#475569'],
  };
  const DEFAULT_BADGE = {
    red: ['HIGH', 'CRITICAL', 'E', 'D', 'BROKEN', 'SHORTFALL', 'STOCKOUT RISK', 'DEAD', 'EXPIRED', 'DELAYED', 'BELOW MIN MARGIN', 'CHECK UOM', 'LIQUIDATE', 'FREEZE PURCHASE', '180+', '91-180'],
    amber: ['MEDIUM', 'C', 'DRAWDOWN', 'REORDER', 'SLOW', 'EXPIRING', 'FOLLOW UP', 'UNDER-PRICED', 'ABOVE MARKET', 'PROMOTION', 'ADJUST', 'NOT SET', 'EXCESS', 'OPEN', '61-90', '31-60', 'NO DATA'],
    green: ['OK', 'A', 'KEPT', 'Current', 'BETTER', 'SCHEDULED', 'YES', 'NONE'],
    blue: ['B', 'LOW', 'NEW', 'TRANSFER', 'CONSUME', '1-30', 'RECOMMENDATION', 'NEW ITEM', 'A/R invoice', 'Sales order'],
    purple: ['A/P invoice', 'Purchase order'],
  };
  function badge(v, map) {
    if (v === null || v === undefined || v === '') return '<span class="ia-muted">—</span>';
    let tone = map && map[v];
    if (!tone) tone = Object.keys(DEFAULT_BADGE).find(t => DEFAULT_BADGE[t].includes(String(v))) || 'grey';
    const [bg, fg] = TONES[tone] || TONES.grey;
    return `<span class="ia-badge" style="background:${bg};color:${fg}">${esc(v)}</span>`;
  }
  function scoreBar(v, invert) {
    if (v == null) return '<span class="ia-muted">—</span>';
    const good = invert ? 100 - v : v;
    const c = good >= 70 ? '#16A34A' : good >= 45 ? '#D97706' : '#DC2626';
    return `<span class="ia-score"><span class="ia-score-track"><span style="width:${Math.max(0, Math.min(100, v))}%;background:${c}"></span></span><b style="color:${c}">${Math.round(v)}</b></span>`;
  }
  function cell(row, col) {
    const v = row[col.key];
    let html = col.fmt === 'badge' ? badge(v, col.badge) : col.fmt === 'score' ? scoreBar(v, col.invert) : fmt(v, col.fmt);
    if (col.strong && v != null) html = `<b>${html}</b>`;
    if (col.sub && row[col.sub] != null && row[col.sub] !== '') {
      const sv = col.fmt === 'badge' && typeof row[col.sub] === 'number' ? (row[col.sub] > 0 ? `+${row[col.sub]}` : row[col.sub]) : row[col.sub];
      html += `<div class="ia-sub">${esc(sv)}</div>`;
    }
    return html;
  }
  function toast(msg, bad) {
    const t = document.createElement('div');
    t.className = 'ia-toast' + (bad ? ' bad' : '');
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), bad ? 7000 : 4000);
  }

  // ── styles ─────────────────────────────────────────────────────────────────
  function injectCss() {
    if (document.getElementById('ia-css')) return;
    const s = document.createElement('style');
    s.id = 'ia-css';
    s.textContent = `
#${PANEL_ID}{display:none;flex:1;flex-direction:column;height:100%;overflow:hidden;background:var(--bg,#F5F6F7);position:relative;min-width:0}
#${PANEL_ID} .ia-hdr{color:#fff;padding:10px 18px;display:flex;align-items:center;gap:10px;flex-shrink:0;flex-wrap:wrap}
#${PANEL_ID} .ia-hbtn{background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.25);color:#fff;border-radius:4px;padding:5px 11px;font-size:11px;cursor:pointer;white-space:nowrap;font-weight:600}
#${PANEL_ID} .ia-hbtn.primary{background:#fff;color:#111;border-color:#fff}
#${PANEL_ID} .ia-hbtn:disabled{opacity:.6;cursor:wait}
#${PANEL_ID} .ia-body{flex:1;overflow:auto;padding:12px 16px 40px;display:flex;flex-direction:column;gap:12px;min-width:0}
#${PANEL_ID} .ia-params{display:flex;flex-wrap:wrap;gap:10px;align-items:flex-end;background:#fff;border:1px solid var(--border,#E5E5E5);border-radius:6px;padding:10px 12px}
#${PANEL_ID} .ia-params label{display:flex;flex-direction:column;gap:3px;font-size:10px;font-weight:600;color:var(--muted,#6A6D70);text-transform:uppercase;letter-spacing:.03em}
#${PANEL_ID} .ia-params input,#${PANEL_ID} .ia-params select{font-size:12px;padding:5px 8px;border:1px solid #D0D7E3;border-radius:4px;width:150px;max-width:100%;text-transform:none;font-weight:400;color:var(--text,#32363A);background:#fff}
#${PANEL_ID} .ia-kpis{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px}
#${PANEL_ID} .ia-kpi{background:#fff;border:1px solid var(--border,#E5E5E5);border-radius:6px;padding:9px 12px;border-left:3px solid #94A3B8}
#${PANEL_ID} .ia-kpi.good{border-left-color:#16A34A}#${PANEL_ID} .ia-kpi.bad{border-left-color:#DC2626}#${PANEL_ID} .ia-kpi.warn{border-left-color:#D97706}
#${PANEL_ID} .ia-kpi-l{font-size:9.5px;color:var(--muted,#6A6D70);font-weight:700;text-transform:uppercase;letter-spacing:.04em}
#${PANEL_ID} .ia-kpi-v{font-size:19px;font-weight:700;color:var(--text,#32363A);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#${PANEL_ID} .ia-card{background:#fff;border:1px solid var(--border,#E5E5E5);border-radius:6px;min-width:0}
#${PANEL_ID} .ia-insight{padding:10px 14px;font-size:12.5px;line-height:1.55;color:#1F2937}
#${PANEL_ID} .ia-insight p{margin:0 0 6px}#${PANEL_ID} .ia-insight ul,#${PANEL_ID} .ia-insight ol{margin:4px 0 6px 20px;padding:0}#${PANEL_ID} .ia-insight h1,#${PANEL_ID} .ia-insight h2,#${PANEL_ID} .ia-insight h3{font-size:13px;margin:6px 0 4px}
#${PANEL_ID} .ia-card-t{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--muted,#6A6D70);padding:8px 14px 0;display:flex;gap:8px;align-items:center}
#${PANEL_ID} .ia-notes{font-size:11px;color:var(--muted,#6A6D70);margin:0;padding:6px 14px 10px 30px;line-height:1.5}
#${PANEL_ID} .ia-tabs{display:flex;gap:2px;border-bottom:1px solid var(--border,#E5E5E5);overflow-x:auto;padding:0 8px}
#${PANEL_ID} .ia-tab{background:none;border:none;border-bottom:2px solid transparent;padding:9px 12px;font-size:12px;font-weight:600;color:var(--muted,#6A6D70);cursor:pointer;white-space:nowrap}
#${PANEL_ID} .ia-tab.on{color:var(--ia-c,#0070F2);border-bottom-color:var(--ia-c,#0070F2)}
#${PANEL_ID} .ia-tools{display:flex;gap:8px;align-items:center;padding:8px 12px;flex-wrap:wrap}
#${PANEL_ID} .ia-tools input{font-size:12px;padding:5px 9px;border:1px solid #D0D7E3;border-radius:4px;width:220px;max-width:100%}
#${PANEL_ID} .ia-tbl-wrap{overflow:auto;max-height:62vh}
#${PANEL_ID} table.ia-tbl{border-collapse:collapse;width:100%;font-size:12px}
#${PANEL_ID} .ia-tbl th{position:sticky;top:0;background:#F8FAFC;z-index:1;text-align:left;padding:7px 10px;font-weight:600;color:#475569;border-bottom:1px solid var(--border,#E5E5E5);cursor:pointer;white-space:nowrap;user-select:none}
#${PANEL_ID} .ia-tbl th.num,#${PANEL_ID} .ia-tbl td.num{text-align:right}
#${PANEL_ID} .ia-tbl td{padding:7px 10px;border-bottom:1px solid #F1F5F9;white-space:nowrap;vertical-align:top}
#${PANEL_ID} .ia-tbl td.wrap{white-space:normal;min-width:220px;max-width:380px}
#${PANEL_ID} .ia-tbl tr:hover td{background:#FAFBFF}
#${PANEL_ID} .ia-sub{font-size:10px;color:var(--muted,#6A6D70);margin-top:1px}
#${PANEL_ID} .ia-muted{color:#CBD5E1}
#${PANEL_ID} .ia-badge{display:inline-block;padding:2px 7px;border-radius:4px;font-size:10px;font-weight:700;white-space:nowrap}
#${PANEL_ID} .ia-score{display:inline-flex;align-items:center;gap:6px}
#${PANEL_ID} .ia-score-track{width:46px;height:5px;background:#E5E7EB;border-radius:3px;display:inline-block;overflow:hidden}
#${PANEL_ID} .ia-score-track span{display:block;height:100%}
#${PANEL_ID} .ia-act{font-size:10.5px;padding:3px 8px;border:1px solid #CBD5E1;background:#fff;border-radius:4px;cursor:pointer;margin-right:4px;white-space:nowrap}
#${PANEL_ID} .ia-act:hover{border-color:var(--ia-c,#0070F2);color:var(--ia-c,#0070F2)}
#${PANEL_ID} .ia-more{display:block;margin:8px auto;font-size:11px}
#${PANEL_ID} .ia-empty{padding:40px 16px;text-align:center;color:var(--muted,#6A6D70);font-size:13px}
#${PANEL_ID} .ia-chat{position:absolute;top:0;right:0;bottom:0;width:380px;max-width:100%;background:#fff;box-shadow:-6px 0 24px rgba(0,0,0,.12);display:none;flex-direction:column;z-index:20}
#${PANEL_ID} .ia-chat.open{display:flex}
#${PANEL_ID} .ia-chat-msgs{flex:1;overflow:auto;padding:12px;display:flex;flex-direction:column;gap:9px;background:#F8F9FB}
#${PANEL_ID} .ia-msg{border-radius:10px;padding:8px 12px;font-size:12px;line-height:1.5;max-width:92%;overflow-x:auto}
#${PANEL_ID} .ia-msg.u{align-self:flex-end;color:#fff;white-space:pre-wrap}
#${PANEL_ID} .ia-msg.a{align-self:flex-start;background:#fff;border:1px solid #E8EDF3}
#${PANEL_ID} .ia-msg table{border-collapse:collapse;font-size:11px}#${PANEL_ID} .ia-msg td,#${PANEL_ID} .ia-msg th{border:1px solid #E5E7EB;padding:3px 6px}
#${PANEL_ID} .ia-chips{display:flex;flex-wrap:wrap;gap:5px;padding:8px 10px;border-top:1px solid #EEF1F5}
#${PANEL_ID} .ia-chip{font-size:10.5px;padding:3px 9px;border:1px solid #CBD5E1;border-radius:10px;background:#fff;cursor:pointer}
#${PANEL_ID} .ia-chat-in{display:flex;gap:6px;padding:10px;border-top:1px solid #EEF1F5}
#${PANEL_ID} .ia-chat-in input{flex:1;font-size:12px;padding:8px 12px;border:1px solid #D0D7E3;border-radius:18px;outline:none}
.ia-modal-bg{position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:2000;display:flex;align-items:center;justify-content:center;padding:16px}
.ia-modal{background:#fff;border-radius:8px;width:620px;max-width:100%;max-height:90vh;display:flex;flex-direction:column;box-shadow:0 12px 40px rgba(0,0,0,.25)}
.ia-modal h3{margin:0;padding:12px 16px;font-size:14px;border-bottom:1px solid #E5E7EB}
.ia-modal .ia-m-body{padding:14px 16px;overflow:auto;display:flex;flex-direction:column;gap:10px}
.ia-modal textarea{width:100%;min-height:300px;font:12px/1.5 ui-monospace,Consolas,monospace;padding:10px;border:1px solid #D0D7E3;border-radius:4px;box-sizing:border-box}
.ia-modal label{display:flex;flex-direction:column;gap:4px;font-size:11px;font-weight:600;color:#475569}
.ia-modal input{font-size:13px;padding:6px 9px;border:1px solid #D0D7E3;border-radius:4px}
.ia-modal .ia-m-foot{display:flex;gap:8px;justify-content:flex-end;padding:10px 16px;border-top:1px solid #E5E7EB}
.ia-modal button{font-size:12px;padding:6px 14px;border-radius:4px;border:1px solid #CBD5E1;background:#fff;cursor:pointer}
.ia-modal button.primary{background:#0070F2;border-color:#0070F2;color:#fff}
.ia-toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#1F2937;color:#fff;padding:10px 18px;border-radius:6px;font-size:12.5px;z-index:2100;box-shadow:0 6px 20px rgba(0,0,0,.25);max-width:90vw}
.ia-toast.bad{background:#991B1B}
@keyframes ia-spin{to{transform:rotate(360deg)}}
@media (max-width:640px){#${PANEL_ID} .ia-body{padding:10px 12px 40px}#${PANEL_ID} .ia-params input,#${PANEL_ID} .ia-params select{width:130px}#${PANEL_ID} .ia-hdr{padding:10px 12px}}
`;
    document.head.appendChild(s);
  }

  // ── panel shell ────────────────────────────────────────────────────────────
  function ensurePanel() {
    injectCss();
    let p = document.getElementById(PANEL_ID);
    if (!p) {
      p = document.createElement('div');
      p.id = PANEL_ID;
      p.innerHTML = `<div class="ia-hdr"></div><div class="ia-body"></div>
        <div class="ia-chat"><div class="ia-chat-hdr ia-hdr" style="padding:10px 14px"></div><div class="ia-chat-msgs"></div><div class="ia-chips"></div>
        <div class="ia-chat-in"><input type="text" placeholder="Ask about this analysis…"><button class="ia-hbtn primary" style="border-radius:18px">Send</button></div></div>`;
      const inp = p.querySelector('.ia-chat-in input');
      inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); sendChat(); } });
      p.querySelector('.ia-chat-in button').addEventListener('click', () => sendChat());
    }
    const main = document.querySelector('.main');
    if (main && p.parentElement !== main) main.appendChild(p);
    return p;
  }

  function hideOthers() {
    const main = document.querySelector('.main');
    if (main) {
      for (const el of main.children) {
        if (el.id === PANEL_ID) continue;
        if (el.id === 'messages' || /-panel$/.test(el.id || '')) el.style.display = 'none';
      }
    }
    const bb = document.querySelector('.bottom-bar'), ia = document.querySelector('.input-area');
    if (bb) bb.style.display = 'none';
    if (ia) ia.style.display = 'none';
  }

  function paramValues(key) {
    const st = state[key];
    const out = {};
    for (const f of AGENTS[key].params.concat([{ key: 'asOf' }])) {
      const v = st.params[f.key];
      if (v === '' || v === undefined || v === null) continue;
      out[f.key] = f.type === 'number' ? Number(v) : v;
    }
    return out;
  }

  function renderShell(key) {
    const a = AGENTS[key], st = state[key], p = ensurePanel();
    p.style.setProperty('--ia-c', a.c2);
    const hdr = p.querySelector('.ia-hdr');
    hdr.style.background = `linear-gradient(135deg,${a.c1} 0%,${a.c2} 100%)`;
    hdr.innerHTML = `
      <button class="ia-hbtn" data-a="back">&larr; Back</button>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2">${a.icon}</svg>
      <span style="font-size:14px;font-weight:700">${esc(a.title)} Agent</span>
      <span style="font-size:10px;background:rgba(0,0,0,.25);padding:2px 7px;border-radius:8px;font-weight:700">${esc(a.badge)}</span>
      <div style="display:flex;align-items:center;gap:6px;margin-left:auto;flex-wrap:wrap">
        <span class="ia-status" style="font-size:10.5px;color:rgba(255,255,255,.8)"></span>
        <button class="ia-hbtn" data-a="chat">💬 Ask AI</button>
        <button class="ia-hbtn primary" data-a="run">Analyze</button>
      </div>`;
    hdr.querySelector('[data-a=back]').onclick = () => window.showChatPanel && window.showChatPanel();
    hdr.querySelector('[data-a=run]').onclick = () => runAnalysis(key);
    hdr.querySelector('[data-a=chat]').onclick = () => toggleChat();

    const body = p.querySelector('.ia-body');
    body.innerHTML = `<div class="ia-params"></div><div class="ia-result"></div>`;
    const pf = body.querySelector('.ia-params');
    const fields = a.params.concat([{ key: 'asOf', label: a.asOfLabel || 'As of', type: 'date' }]);
    pf.innerHTML = fields.map(f => {
      const v = st.params[f.key] ?? '';
      const input = f.type === 'select'
        ? `<select data-k="${f.key}">${f.options.map(o => `<option value="${esc(o)}" ${String(o) === String(v) ? 'selected' : ''}>${esc(o === '' ? '(saved / default)' : o)}</option>`).join('')}</select>`
        : `<input data-k="${f.key}" type="${f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : 'text'}" ${f.type === 'number' ? 'step="any"' : ''} value="${esc(v)}" placeholder="${esc(f.placeholder || '')}">`;
      return `<label>${esc(f.label)}${input}</label>`;
    }).join('');
    pf.querySelectorAll('[data-k]').forEach(el => {
      el.addEventListener('change', () => { st.params[el.dataset.k] = el.value; });
      el.addEventListener('keydown', e => { if (e.key === 'Enter') { st.params[el.dataset.k] = el.value; runAnalysis(key); } });
    });

    // chat drawer
    const ch = p.querySelector('.ia-chat');
    ch.classList.toggle('open', !!st.chatOpen);
    const chHdr = p.querySelector('.ia-chat-hdr');
    chHdr.style.background = `linear-gradient(135deg,${a.c1},${a.c2})`;
    chHdr.innerHTML = `<span style="font-weight:700;font-size:13px">${esc(a.title)} AI</span><span style="font-size:10px;opacity:.75">grounded in your last analysis</span>
      <button class="ia-hbtn" style="margin-left:auto" data-a="clear">Clear</button><button class="ia-hbtn" data-a="close">&times;</button>`;
    chHdr.querySelector('[data-a=clear]').onclick = () => { st.chat = []; st.sessionId = null; renderChat(); };
    chHdr.querySelector('[data-a=close]').onclick = () => toggleChat(false);
    p.querySelector('.ia-chips').innerHTML = a.chips.map(c => `<button class="ia-chip">${esc(c)}</button>`).join('');
    p.querySelectorAll('.ia-chip').forEach(b => b.onclick = () => sendChat(b.textContent));
    renderChat();
    renderResult(key);
  }

  function setStatus(text) {
    const el = document.querySelector(`#${PANEL_ID} .ia-status`);
    if (el) el.textContent = text;
  }

  // ── analysis ───────────────────────────────────────────────────────────────
  async function runAnalysis(key) {
    const a = AGENTS[key], st = state[key];
    document.querySelectorAll(`#${PANEL_ID} .ia-params [data-k]`).forEach(el => { st.params[el.dataset.k] = el.value; });
    const btn = document.querySelector(`#${PANEL_ID} [data-a=run]`);
    if (btn) { btn.disabled = true; btn.innerHTML = '<span style="display:inline-block;animation:ia-spin 1s linear infinite">⟳</span> Analyzing…'; }
    setStatus('Reading live SAP data…');
    st.loading = true;
    if (!st.data) renderResult(key);
    try {
      const d = await call(`${a.api}/analyze`, paramValues(key));
      st.data = d; st.error = null; st.limit = 100;
      // Server can hand back effective / saved settings (e.g. commission rules).
      if (d.paramsOut) {
        Object.assign(st.params, d.paramsOut);
        document.querySelectorAll(`#${PANEL_ID} .ia-params [data-k]`).forEach(el => { if (d.paramsOut[el.dataset.k] !== undefined) el.value = d.paramsOut[el.dataset.k]; });
      }
      if (!d.tabs.some(t => t.key === st.tab)) st.tab = d.tabs[0]?.key;
      if (current === key) setStatus(`Updated ${new Date().toLocaleTimeString()} · ${(d.elapsedMs / 1000).toFixed(1)}s`);
    } catch (e) {
      st.error = e.message;
      if (current === key) setStatus('Error');
    } finally {
      st.loading = false;
      if (btn) { btn.disabled = false; btn.textContent = 'Analyze'; }
      if (current === key) renderResult(key);
    }
  }

  function renderResult(key) {
    const st = state[key], a = AGENTS[key];
    const box = document.querySelector(`#${PANEL_ID} .ia-result`);
    if (!box) return;
    if (st.error) {
      box.innerHTML = `<div class="ia-card"><div class="ia-empty" style="color:#991B1B">⚠ ${esc(st.error)}</div></div>`;
      return;
    }
    const d = st.data;
    if (!d) {
      box.innerHTML = `<div class="ia-card"><div class="ia-empty">${st.loading ? 'Analyzing live SAP data…' : `Set the options above and click <b>Analyze</b>.`}</div></div>`;
      return;
    }
    const kpis = (d.kpis || []).map(k => `<div class="ia-kpi ${k.tone || ''}" title="${esc(k.hint || '')}"><div class="ia-kpi-l">${esc(k.label)}</div><div class="ia-kpi-v">${fmt(k.value, k.fmt)}</div></div>`).join('');
    box.innerHTML = `
      <div class="ia-kpis">${kpis}</div>
      <div class="ia-card"><div class="ia-card-t">Insight ${d.aiSource === 'ai-or-rules' ? '· AI' : '· rule-based'}</div><div class="ia-insight">${md(d.insight)}</div>
        ${(d.notes || []).length ? `<ul class="ia-notes">${d.notes.map(n => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}</div>
      ${d.chart ? `<div class="ia-card"><div class="ia-card-t">${esc(d.chart.title || '')}</div><div style="height:230px;padding:6px 12px 10px"><canvas></canvas></div></div>` : ''}
      <div class="ia-card"><div class="ia-tabs">${d.tabs.map(t => `<button class="ia-tab ${t.key === st.tab ? 'on' : ''}" data-t="${esc(t.key)}">${esc(t.label)}</button>`).join('')}</div><div class="ia-tabbody"></div></div>`;
    box.querySelectorAll('.ia-tab').forEach(b => b.onclick = () => { st.tab = b.dataset.t; st.limit = 100; st.search = ''; st.sort = null; renderResult(key); });
    if (d.chart) drawChart(box.querySelector('canvas'), d.chart, a.c2);
    renderTab(key);
  }

  function drawChart(canvas, spec, color) {
    if (chart) { try { chart.destroy(); } catch {} chart = null; }
    if (typeof Chart === 'undefined' || !canvas) return;
    const palette = [color, '#94A3B8', '#0EA5E9', '#F59E0B'];
    chart = new Chart(canvas, {
      data: {
        labels: spec.labels,
        datasets: spec.series.map((s, i) => ({
          type: s.type === 'line' ? 'line' : 'bar', label: s.name, data: s.values,
          backgroundColor: s.color || palette[i % palette.length], borderColor: s.color || palette[i % palette.length],
          borderWidth: s.type === 'line' ? 2 : 0, pointRadius: s.type === 'line' ? 2 : 0, tension: .25, order: s.type === 'line' ? 0 : 1,
        })),
      },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        plugins: { legend: { display: spec.series.length > 1, labels: { boxWidth: 10, font: { size: 11 } } },
          tooltip: { callbacks: { label: c => `${c.dataset.label}: ${nf0.format(c.raw)}` } } },
        scales: { x: { ticks: { font: { size: 10 } }, grid: { display: false } }, y: { ticks: { font: { size: 10 }, callback: v => nf0.format(v) } } },
      },
    });
  }

  function renderTab(key) {
    const st = state[key];
    const tab = st.data.tabs.find(t => t.key === st.tab) || st.data.tabs[0];
    const tb = document.querySelector(`#${PANEL_ID} .ia-tabbody`);
    if (!tab || !tb) return;
    const q = (st.search || '').toLowerCase();
    let rows = q ? tab.rows.filter(r => tab.columns.some(c => String(r[c.key] ?? '').toLowerCase().includes(q) || (c.sub && String(r[c.sub] ?? '').toLowerCase().includes(q)))) : tab.rows.slice();
    if (st.sort) {
      const { k, dir } = st.sort;
      rows.sort((x, y) => {
        const a = x[k], b = y[k];
        if (a == null) return 1; if (b == null) return -1;
        return (typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b))) * dir;
      });
    }
    const numeric = c => ['amt', 'price', 'num', 'int', 'pct', 'score'].includes(c.fmt);
    const actions = tab.actions || [];
    const shown = rows.slice(0, st.limit || 100);
    tb.innerHTML = `
      <div class="ia-tools"><input type="search" placeholder="Filter rows…" value="${esc(st.search || '')}">
        <span style="font-size:11px;color:var(--muted,#6A6D70)">${rows.length} row${rows.length === 1 ? '' : 's'}</span>
        <button class="ia-act" data-csv style="margin-left:auto">⬇ CSV</button></div>
      ${rows.length ? `<div class="ia-tbl-wrap"><table class="ia-tbl"><thead><tr>
        ${tab.columns.map(c => `<th class="${numeric(c) ? 'num' : ''}" data-k="${esc(c.key)}" title="${esc(c.hint || 'Sort')}">${esc(c.label)}${st.sort?.k === c.key ? (st.sort.dir > 0 ? ' ▲' : ' ▼') : ''}</th>`).join('')}
        ${actions.length ? '<th>Actions</th>' : ''}</tr></thead><tbody>
        ${shown.map((r, i) => `<tr>${tab.columns.map(c => `<td class="${numeric(c) ? 'num' : ''} ${c.wrap ? 'wrap' : ''}">${cell(r, c)}</td>`).join('')}
          ${actions.length ? `<td>${actions.map(a => `<button class="ia-act" data-i="${i}" data-act="${esc(a.id)}">${esc(a.label)}</button>`).join('')}</td>` : ''}</tr>`).join('')}
        </tbody></table></div>
        ${rows.length > shown.length ? `<button class="ia-act ia-more">Show ${Math.min(200, rows.length - shown.length)} more of ${rows.length - shown.length}</button>` : ''}`
      : `<div class="ia-empty">No rows${q ? ' match this filter' : ''}.</div>`}`;
    const search = tb.querySelector('.ia-tools input');
    search.addEventListener('input', () => {
      st.search = search.value; st.limit = 100;
      const pos = search.selectionStart;
      renderTab(key);
      const again = document.querySelector(`#${PANEL_ID} .ia-tools input`);
      again.focus(); again.setSelectionRange(pos, pos);
    });
    tb.querySelector('[data-csv]').onclick = () => downloadCsv(tab, rows);
    tb.querySelectorAll('th[data-k]').forEach(th => th.onclick = () => {
      const k = th.dataset.k;
      st.sort = st.sort?.k === k ? { k, dir: -st.sort.dir } : { k, dir: tab.columns.find(c => c.key === k && numeric(c)) ? -1 : 1 };
      renderTab(key);
    });
    const more = tb.querySelector('.ia-more');
    if (more) more.onclick = () => { st.limit = (st.limit || 100) + 200; renderTab(key); };
    tb.querySelectorAll('[data-act]').forEach(b => b.onclick = () => runAction(key, actions.find(a => a.id === b.dataset.act), shown[Number(b.dataset.i)]));
  }

  function downloadCsv(tab, rows) {
    const q = v => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const cols = tab.columns;
    const lines = [cols.map(c => q(c.label)).join(','), ...rows.map(r => cols.map(c => q(r[c.key])).join(','))];
    const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${(AGENTS[current]?.title || 'agent').replace(/\W+/g, '-')}-${tab.key}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  // ── row actions ────────────────────────────────────────────────────────────
  function modal(title, bodyHtml, buttons) {
    const bg = document.createElement('div');
    bg.className = 'ia-modal-bg';
    bg.innerHTML = `<div class="ia-modal"><h3>${esc(title)}</h3><div class="ia-m-body">${bodyHtml}</div><div class="ia-m-foot"></div></div>`;
    const foot = bg.querySelector('.ia-m-foot');
    const close = () => bg.remove();
    for (const b of buttons) {
      const el = document.createElement('button');
      el.textContent = b.label;
      if (b.primary) el.className = 'primary';
      el.onclick = () => b.onClick ? b.onClick(bg, close) : close();
      foot.appendChild(el);
    }
    bg.addEventListener('click', e => { if (e.target === bg) close(); });
    document.body.appendChild(bg);
    return bg;
  }
  const fill = (tpl, row) => String(tpl || '').replace(/\{(\w+)\}/g, (_, k) => row[k] ?? '');

  async function runAction(key, act, row) {
    if (!act || !row) return;
    const post = async (extra) => {
      const d = await call(act.endpoint, { row, ...(act.extra || {}), ...(extra || {}) });
      if (d.message) toast(d.message);
      if (act.refresh) runAnalysis(key);
      return d;
    };
    try {
      if (act.kind === 'focus') {
        // Re-run the analysis with a parameter taken from the row (e.g. chart one item).
        const v = row[act.from] ?? '';
        state[key].params[act.param] = v;
        const el = document.querySelector(`#${PANEL_ID} .ia-params [data-k="${act.param}"]`);
        if (el) el.value = v;
        document.querySelector(`#${PANEL_ID} .ia-body`)?.scrollTo({ top: 0, behavior: 'smooth' });
        return runAnalysis(key);
      }
      if (act.kind === 'post') {
        if (act.confirm && !confirm(fill(act.confirm, row))) return;
        await post();
      } else if (act.kind === 'text') {
        toast('Drafting…');
        const d = await post();
        modal(d.title || act.label, `${d.to ? `<div style="font-size:12px">To: <b>${esc(d.to)}</b></div>` : ''}<textarea>${esc(d.text || '')}</textarea>`, [
          { label: 'Copy', onClick: (bg) => { const t = bg.querySelector('textarea'); t.select(); navigator.clipboard?.writeText(t.value); toast('Copied'); } },
          ...(d.to ? [{ label: 'Open in mail', onClick: (bg) => {
            const t = bg.querySelector('textarea').value; const m = t.match(/^Subject:\s*(.*)\n+/);
            location.href = `mailto:${encodeURIComponent(d.to)}?subject=${encodeURIComponent(m ? m[1] : '')}&body=${encodeURIComponent(m ? t.slice(m[0].length) : t)}`;
          } }] : []),
          { label: 'Close', primary: true },
        ]);
      } else if (act.kind === 'form') {
        const fields = act.fields || [];
        modal(`${act.label} — ${row.cardName || row.itemCode || ''}`, fields.map(f => {
          const v = f.from ? row[f.from] : f.default ?? '';
          return `<label>${esc(f.label)}<input data-f="${esc(f.key)}" type="${f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : 'text'}" step="any" value="${esc(v)}"></label>`;
        }).join(''), [
          { label: 'Cancel' },
          { label: 'Save', primary: true, onClick: async (bg, close) => {
            const values = {};
            bg.querySelectorAll('[data-f]').forEach(i => { values[i.dataset.f] = i.value; });
            try { await post({ values }); close(); } catch (e) { toast(e.message, true); }
          } },
        ]);
      }
    } catch (e) { toast(e.message, true); }
  }

  // ── chat ───────────────────────────────────────────────────────────────────
  function toggleChat(force) {
    const st = state[current];
    if (!st) return;
    st.chatOpen = force === undefined ? !st.chatOpen : force;
    document.querySelector(`#${PANEL_ID} .ia-chat`)?.classList.toggle('open', st.chatOpen);
    if (st.chatOpen) document.querySelector(`#${PANEL_ID} .ia-chat-in input`)?.focus();
  }
  function renderChat() {
    const st = state[current], a = AGENTS[current];
    const box = document.querySelector(`#${PANEL_ID} .ia-chat-msgs`);
    if (!box || !st) return;
    const intro = `<div class="ia-msg a">Ask me anything about the current <b>${esc(a.title)}</b> analysis. I answer only from the live SAP data you loaded with <b>Analyze</b>.</div>`;
    box.innerHTML = intro + st.chat.map(m => m.role === 'user'
      ? `<div class="ia-msg u" style="background:${a.c2}">${esc(m.text)}</div>`
      : `<div class="ia-msg a">${m.pending ? '…' : md(m.text)}</div>`).join('');
    box.scrollTop = box.scrollHeight;
  }
  async function sendChat(text) {
    const key = current, st = state[key];
    const inp = document.querySelector(`#${PANEL_ID} .ia-chat-in input`);
    const msg = (text ?? inp?.value ?? '').trim();
    if (!msg) return;
    if (!st.chatOpen) toggleChat(true);
    if (inp) inp.value = '';
    st.chat.push({ role: 'user', text: msg });
    const pending = { role: 'ai', text: '', pending: true };
    st.chat.push(pending);
    renderChat();
    try {
      const d = await call(`${AGENTS[key].api}/chat`, { message: msg, sessionId: st.sessionId });
      st.sessionId = d.sessionId;
      pending.text = d.reply || 'No answer.';
    } catch (e) { pending.text = `⚠ ${e.message}`; }
    pending.pending = false;
    if (current === key) renderChat();
  }

  // ── navigation ─────────────────────────────────────────────────────────────
  window.showInsightAgent = function (key) {
    if (!AGENTS[key]) return;
    current = key;
    if (!state[key]) {
      const params = {};
      for (const f of AGENTS[key].params) if (f.value !== undefined) params[f.key] = String(f.value);
      params.asOf = new Date().toISOString().slice(0, 10);
      if (AGENTS[key].asOfDefault === 'monthEnd') {
        // Close the current month from the 20th onward, otherwise last month.
        const d = new Date(), m = d.getUTCMonth() + (d.getUTCDate() >= 20 ? 1 : 0);
        params.asOf = new Date(Date.UTC(d.getUTCFullYear(), m, 0)).toISOString().slice(0, 10);
      }
      state[key] = { params, chat: [], sessionId: null, tab: null, data: null, limit: 100 };
    }
    hideOthers();
    const p = ensurePanel();
    p.style.display = 'flex';
    renderShell(key);
    document.querySelectorAll('.nav-item, .nav-subitem').forEach(n => n.classList.remove('active'));
    document.getElementById(`nav-ia-${key}`)?.classList.add('active');
    if (!state[key].data && !state[key].loading && !state[key].error) runAnalysis(key);
  };

  const hidePanel = () => {
    const p = document.getElementById(PANEL_ID);
    if (p && p.style.display !== 'none') {
      p.style.display = 'none';
      if (chart) { try { chart.destroy(); } catch {} chart = null; }
    }
  };
  // Other panels' show functions don't know about this panel, so step aside
  // whenever any other full-height panel (or the chat) becomes visible in
  // .main — covers the sidebar, the collapsed icon rail and programmatic opens.
  const isShown = el => el.style.display !== 'none' && getComputedStyle(el).display !== 'none';
  const observer = new MutationObserver(() => {
    const p = document.getElementById(PANEL_ID);
    const main = document.querySelector('.main');
    if (!p || !main || p.style.display === 'none') return;
    for (const el of main.children) {
      if (el !== p && (el.id === 'messages' || /-panel$/.test(el.id || '')) && isShown(el)) { hidePanel(); return; }
    }
  });
  const observe = () => {
    const main = document.querySelector('.main');
    // subtree is needed to see style changes on .main's children; the callback
    // itself only inspects direct children, so it stays cheap.
    if (main) observer.observe(main, { childList: true, subtree: true, attributes: true, attributeFilter: ['style'] });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', observe); else observe();
  // Sidebar prompt shortcuts (data-prompt) send a chat message without
  // switching views, so bring the chat back when one is clicked from here.
  document.addEventListener('click', e => {
    const nav = e.target.closest?.('.nav-item[data-prompt], .nav-subitem[data-prompt]');
    const p = document.getElementById(PANEL_ID);
    if (nav && p && p.style.display !== 'none' && window.showChatPanel) window.showChatPanel();
  }, true);
  const wrapShowChat = () => {
    const orig = window.showChatPanel;
    if (!orig || orig.__ia) return;
    const wrapped = function (...args) { hidePanel(); return orig.apply(this, args); };
    wrapped.__ia = true;
    window.showChatPanel = wrapped;
  };
  wrapShowChat();
  document.addEventListener('DOMContentLoaded', wrapShowChat);
  window.addEventListener('load', wrapShowChat);
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    if (document.querySelector('.ia-modal-bg')) { document.querySelector('.ia-modal-bg').remove(); return; }
    const st = state[current];
    if (st?.chatOpen) { toggleChat(false); e.stopPropagation(); }
  }, true);
})();
