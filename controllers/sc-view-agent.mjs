/**
 * Service Call View Agent — conversational query panel for SAP B1 Service Calls
 * Routes: POST /api/sc-agent/chat, POST /api/sc-agent/reset
 */
import { Router } from 'express';

const esc = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const arr = r => Array.isArray(r) ? r : (r?.value ?? []);

const _sess = new Map();

function sessInit() {
  return {
    sid: `sc_view_${Date.now()}_${Math.random().toString(36).slice(2,6)}`,
    step: 'INIT',
    customerCode: null, customerName: null,
  };
}

// ── Formatting helpers ────────────────────────────────────────────────────────
const STATUS_MAP = {
  scs_Open:    { label:'Open',    bg:'#dcfce7', color:'#166534', dot:'#16a34a' },
  scs_Pending: { label:'Pending', bg:'#fef9c3', color:'#854d0e', dot:'#ca8a04' },
  scs_Closed:  { label:'Closed',  bg:'#fee2e2', color:'#991b1b', dot:'#dc2626' },
};
const PRIORITY_MAP = {
  scp_Low:    { label:'Low',    color:'#166534', bg:'#dcfce7' },
  scp_Medium: { label:'Medium', color:'#92400e', bg:'#fef3c7' },
  scp_High:   { label:'High',   color:'#991b1b', bg:'#fee2e2' },
};

function statusBadge(status) {
  const s = STATUS_MAP[status] || { label: status||'Unknown', bg:'#f3f4f6', color:'#374151', dot:'#9ca3af' };
  return `<span style="display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:12px;font-size:11px;font-weight:700;background:${s.bg};color:${s.color}"><span style="width:7px;height:7px;border-radius:50%;background:${s.dot};display:inline-block"></span>${s.label}</span>`;
}
function priorityBadge(p) {
  const m = PRIORITY_MAP[p] || { label: p||'—', color:'#374151', bg:'#f3f4f6' };
  return `<span style="padding:2px 8px;border-radius:12px;font-size:11px;font-weight:600;background:${m.bg};color:${m.color}">${m.label}</span>`;
}
function fmtDate(d) {
  if (!d) return '—';
  try { return new Date(d).toLocaleDateString('en-GB', { day:'2-digit', month:'short', year:'numeric' }); } catch(_) { return d; }
}

function callCard(c, detailed = false) {
  const id = c.ServiceCallID ?? c.CallID ?? '—';
  const statusHtml  = statusBadge(c.Status);
  const priorityHtml = priorityBadge(c.Priority);
  return `<div style="background:var(--card-bg,#fff);border:1px solid var(--border,#e5e7eb);border-radius:10px;padding:14px;margin:6px 0;position:relative">
    <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;flex-wrap:wrap">
      <div>
        <div style="font-size:13px;font-weight:700;color:#0e7490">Call #${esc(String(id))}</div>
        <div style="font-size:13.5px;font-weight:600;margin-top:2px">${esc(c.Subject||'(No subject)')}</div>
        <div style="font-size:12px;color:#6b7280;margin-top:2px">
          ${esc(c.CustomerCode||'')}${c.CustomerCode && c.CustomerName ? ' — '+esc(c.CustomerName) : ''}
        </div>
      </div>
      <div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px;flex-shrink:0">
        ${statusHtml}${priorityHtml}
      </div>
    </div>
    <div style="margin-top:10px;display:grid;grid-template-columns:1fr 1fr;gap:4px 16px;font-size:12px">
      ${c.ItemCode ? `<div><span style="color:#6b7280">Item:</span> <strong>${esc(c.ItemCode)}</strong></div>` : ''}
      ${c.TechnicianCode ? `<div><span style="color:#6b7280">Technician:</span> <strong>${esc(String(c.TechnicianCode))}</strong></div>` : ''}
      <div><span style="color:#6b7280">Created:</span> <strong>${fmtDate(c.CreateDate||c.CreationDate)}</strong></div>
      ${c.CloseDate ? `<div><span style="color:#6b7280">Closed:</span> <strong>${fmtDate(c.CloseDate)}</strong></div>` : ''}
    </div>
    ${detailed && c.Description ? `<div style="margin-top:10px;font-size:12.5px;padding:8px;background:var(--bg,#f9fafb);border-radius:6px;border-left:3px solid #0e7490"><strong>Description:</strong> ${esc(c.Description)}</div>` : ''}
    ${detailed && c.Resolution  ? `<div style="margin-top:8px;font-size:12.5px;padding:8px;background:#f0fdf4;border-radius:6px;border-left:3px solid #16a34a"><strong>Resolution:</strong> ${esc(c.Resolution)}</div>` : ''}
    <div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap">
      ${!detailed ? `<button onclick="scViewSend('view_call:${id}')" style="padding:5px 14px;background:#0e7490;color:#fff;border:none;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer">📋 View Details</button>` : ''}
      <button onclick="scViewSend('update_call:${id}')" style="padding:5px 14px;background:#f0fdf4;color:#0e7490;border:1.5px solid #0e7490;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer">✏️ Update Status</button>
      <button onclick="window.openActivityModal&&window.openActivityModal({cardCode:'${esc(c.CustomerCode||'')}',cardName:'${esc(c.CustomerName||'')}',docType:191,docNum:${id},entityLabel:'Service Call #${id}',subject:'${esc((c.Subject||'').slice(0,50))}'})" style="padding:5px 14px;background:#fdf2f8;color:#9d174d;border:1.5px solid #fbcfe8;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer">📝 Log Activity</button>
      <button onclick="scViewSend('search_customer')" style="padding:5px 12px;background:transparent;color:#6b7280;border:1px solid #d1d5db;border-radius:6px;font-size:12px;cursor:pointer">↩ Back</button>
    </div>
  </div>`;
}

function callListHtml(calls, title) {
  if (!calls.length) return `<div style="font-size:13px;color:#6b7280;padding:12px 0">No service calls found.</div>`;
  return `<div style="font-size:13px;font-weight:600;color:#0e7490;margin-bottom:6px">${title} (${calls.length})</div>` +
    calls.map(c => callCard(c, false)).join('');
}

function welcomeHtml() {
  const btn = (icon, label, action, color) =>
    `<button onclick="scViewSend('${action}')" style="display:flex;align-items:center;gap:8px;padding:10px 16px;background:${color};color:#fff;border:none;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;width:100%;text-align:left;margin:4px 0">${icon} ${label}</button>`;
  return `<div style="padding:4px 0">
    ${btn('🔍','Search by Customer','search_customer','#0e7490')}
    ${btn('🔢','Search by Call ID','search_call_id','#7c3aed')}
    ${btn('📋','Show All Open Calls','show_open_calls','#dc2626')}
    ${btn('🕐','Recent Service Calls','show_recent_calls','#d97706')}
  </div>`;
}

function statusUpdateHtml(callId) {
  return `<div style="background:var(--card-bg,#f9fafb);border:1px solid var(--border,#e5e7eb);border-radius:8px;padding:14px;margin:6px 0">
    <div style="font-size:13px;font-weight:700;margin-bottom:10px">Update Service Call #${callId}</div>
    <div style="font-size:12.5px;margin-bottom:8px">Select new status:</div>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <button onclick="scViewSend('set_status:${callId}:scs_Open')"    style="padding:7px 16px;background:#dcfce7;border:1.5px solid #16a34a;border-radius:20px;font-size:12.5px;color:#166534;font-weight:700;cursor:pointer">🟢 Open</button>
      <button onclick="scViewSend('set_status:${callId}:scs_Pending')" style="padding:7px 16px;background:#fef9c3;border:1.5px solid #ca8a04;border-radius:20px;font-size:12.5px;color:#854d0e;font-weight:700;cursor:pointer">🟡 Pending</button>
      <button onclick="scViewSend('set_status:${callId}:scs_Closed')"  style="padding:7px 16px;background:#fee2e2;border:1.5px solid #dc2626;border-radius:20px;font-size:12.5px;color:#991b1b;font-weight:700;cursor:pointer">🔴 Close</button>
    </div>
    <div style="margin-top:12px;font-size:12.5px">Add resolution note (optional):</div>
    <textarea id="sc-resolution-${callId}" placeholder="Enter resolution details..." style="width:100%;margin-top:6px;padding:8px;border:1px solid #d1d5db;border-radius:6px;font-size:12.5px;resize:vertical;min-height:60px;box-sizing:border-box"></textarea>
    <button onclick="scViewSend('cancel_update')" style="margin-top:8px;padding:5px 12px;background:transparent;color:#6b7280;border:1px solid #d1d5db;border-radius:6px;font-size:12px;cursor:pointer">Cancel</button>
  </div>`;
}

// ── Session handler ────────────────────────────────────────────────────────────
async function handleChat(sess, msg, sap, res) {
  const sid = sess.sid;

  // ── Global resets / nav ───────────────────────────────────────────────────
  if (msg==='menu'||msg==='restart'||msg==='Start Over'||msg==='') {
    sess.step = 'MENU';
    return res.json({ ok:true, reply:`<div>What would you like to do?</div>${welcomeHtml()}`, sessionId:sid });
  }

  // ── Search by customer ────────────────────────────────────────────────────
  if (msg==='search_customer') {
    sess.step = 'AWAIT_CUSTOMER';
    return res.json({ ok:true, reply:'<div>Enter <strong>customer code or name</strong> to search:</div>', sessionId:sid });
  }

  // ── Search by Call ID ─────────────────────────────────────────────────────
  if (msg==='search_call_id') {
    sess.step = 'AWAIT_CALL_ID';
    return res.json({ ok:true, reply:'<div>Enter the <strong>Service Call ID</strong> (numeric):</div>', sessionId:sid });
  }

  // ── Show open calls ───────────────────────────────────────────────────────
  if (msg==='show_open_calls') {
    try {
      const r = await sap.get('/ServiceCalls', {
        $filter:"Status eq 'scs_Open'",
        $select:'ServiceCallID,Subject,CustomerCode,CustomerName,Status,Priority,ItemCode,TechnicianCode,CreateDate',
        $orderby:'CreateDate desc',
        $top:50,
      });
      const calls = arr(r);
      return res.json({ ok:true, reply: callListHtml(calls, '🟢 Open Service Calls'), sessionId:sid });
    } catch(e) {
      return res.json({ ok:true, reply:`<div style="color:#b91c1c">❌ ${esc(e.message)}</div>`, sessionId:sid });
    }
  }

  // ── Show recent calls ─────────────────────────────────────────────────────
  if (msg==='show_recent_calls') {
    try {
      const r = await sap.get('/ServiceCalls', {
        $select:'ServiceCallID,Subject,CustomerCode,CustomerName,Status,Priority,ItemCode,TechnicianCode,CreateDate',
        $orderby:'CreateDate desc',
        $top:20,
      });
      const calls = arr(r);
      return res.json({ ok:true, reply: callListHtml(calls, '🕐 Recent Service Calls'), sessionId:sid });
    } catch(e) {
      return res.json({ ok:true, reply:`<div style="color:#b91c1c">❌ ${esc(e.message)}</div>`, sessionId:sid });
    }
  }

  // ── View single call detail ───────────────────────────────────────────────
  if (msg.startsWith('view_call:')) {
    const id = parseInt(msg.split(':')[1]);
    try {
      const c = await sap.get(`/ServiceCalls(${id})`);
      return res.json({ ok:true, reply:`<div style="font-size:13px;font-weight:600;color:#0e7490;margin-bottom:6px">📋 Service Call Detail</div>${callCard(c, true)}`, sessionId:sid });
    } catch(e) {
      return res.json({ ok:true, reply:`<div style="color:#b91c1c">❌ Call #${id} not found: ${esc(e.message)}</div>`, sessionId:sid });
    }
  }

  // ── Update status UI ──────────────────────────────────────────────────────
  if (msg.startsWith('update_call:')) {
    const id = msg.split(':')[1];
    sess.step = 'AWAIT_UPDATE';
    sess.pendingUpdateId = id;
    return res.json({ ok:true, reply: statusUpdateHtml(id), sessionId:sid });
  }

  if (msg==='cancel_update') {
    sess.step = 'MENU';
    return res.json({ ok:true, reply:`<div>Cancelled. What would you like to do?</div>${welcomeHtml()}`, sessionId:sid });
  }

  // ── Apply status update ───────────────────────────────────────────────────
  if (msg.startsWith('set_status:')) {
    const parts = msg.split(':');
    const callId = parseInt(parts[1]);
    const newStatus = parts[2];
    const resolution = (parts[3]||'').trim() || null; // optional resolution from textarea
    const statusLabel = {scs_Open:'Open',scs_Pending:'Pending',scs_Closed:'Closed'}[newStatus]||newStatus;
    try {
      const patch = { Status: newStatus, ...(resolution ? {Resolution: resolution} : {}) };
      await sap.patch(`/ServiceCalls(${callId})`, patch);
      const c = await sap.get(`/ServiceCalls(${callId})`);
      sess.step = 'MENU';
      return res.json({ ok:true, reply:`<div style="background:#f0fdf4;border:1px solid #0e7490;border-radius:8px;padding:10px;margin-bottom:6px;font-size:12.5px;color:#065f46">✅ Call #${callId} updated to <strong>${statusLabel}</strong></div>${callCard(c, false)}<div style="margin-top:8px">${welcomeHtml()}</div>`, sessionId:sid });
    } catch(e) {
      return res.json({ ok:true, reply:`<div style="color:#b91c1c">❌ Update failed: ${esc(e.message)}</div>`, sessionId:sid });
    }
  }

  // ── Text input: customer search ───────────────────────────────────────────
  if (sess.step==='AWAIT_CUSTOMER') {
    const q = msg.trim();
    if (!q) return res.json({ ok:true, reply:'<div>Please enter a customer code or name.</div>', sessionId:sid });
    try {
      const isCode = /^[A-Z0-9_-]+$/i.test(q) && q.length <= 20;
      const filter = isCode
        ? `CustomerCode eq '${q}'`
        : `contains(CustomerCode,'${q}') or contains(CustomerName,'${q}')`;
      const r = await sap.get('/ServiceCalls', {
        $filter: filter,
        $select:'ServiceCallID,Subject,CustomerCode,CustomerName,Status,Priority,ItemCode,TechnicianCode,CreateDate',
        $orderby:'CreateDate desc',
        $top:50,
      });
      const calls = arr(r);
      if (!calls.length) {
        return res.json({ ok:true, reply:`<div>No service calls found for "<strong>${esc(q)}</strong>".</div><div style="margin-top:8px">${welcomeHtml()}</div>`, sessionId:sid });
      }
      sess.step = 'MENU';
      return res.json({ ok:true, reply: callListHtml(calls, `Service Calls for "${esc(q)}"`) + `<div style="margin-top:12px;font-size:12.5px;font-weight:600;color:#6b7280">Search again or choose another option:</div><div style="margin-top:4px">${welcomeHtml()}</div>`, sessionId:sid });
    } catch(e) {
      return res.json({ ok:true, reply:`<div style="color:#b91c1c">❌ Search failed: ${esc(e.message)}</div>`, sessionId:sid });
    }
  }

  // ── Text input: call ID ───────────────────────────────────────────────────
  if (sess.step==='AWAIT_CALL_ID') {
    const id = parseInt(msg.trim());
    if (isNaN(id)) return res.json({ ok:true, reply:'<div>Please enter a valid numeric Call ID.</div>', sessionId:sid });
    try {
      const c = await sap.get(`/ServiceCalls(${id})`);
      sess.step = 'MENU';
      return res.json({ ok:true, reply:`<div style="font-size:13px;font-weight:600;color:#0e7490;margin-bottom:6px">📋 Service Call Detail</div>${callCard(c, true)}`, sessionId:sid });
    } catch(e) {
      return res.json({ ok:true, reply:`<div style="color:#b91c1c">❌ Call #${id} not found: ${esc(e.message)}</div>`, sessionId:sid });
    }
  }

  // ── Fallback: treat as customer search ────────────────────────────────────
  const q = msg.trim();
  if (q) {
    try {
      const isNumeric = /^\d+$/.test(q);
      if (isNumeric) {
        const c = await sap.get(`/ServiceCalls(${parseInt(q)})`);
        return res.json({ ok:true, reply:`<div style="font-size:13px;font-weight:600;color:#0e7490;margin-bottom:6px">📋 Service Call #${q}</div>${callCard(c, true)}`, sessionId:sid });
      }
      const filter = `contains(CustomerCode,'${q}') or contains(CustomerName,'${q}') or contains(Subject,'${q}')`;
      const r = await sap.get('/ServiceCalls', {
        $filter: filter, $select:'ServiceCallID,Subject,CustomerCode,CustomerName,Status,Priority,ItemCode,TechnicianCode,CreateDate',
        $orderby:'CreateDate desc', $top:50,
      });
      const calls = arr(r);
      return res.json({ ok:true, reply: calls.length ? callListHtml(calls, `Results for "${esc(q)}"`) : `<div>No service calls found for "<strong>${esc(q)}</strong>".</div><div style="margin-top:8px">${welcomeHtml()}</div>`, sessionId:sid });
    } catch(e) {
      return res.json({ ok:true, reply:`<div style="color:#b91c1c">❌ ${esc(e.message)}</div>`, sessionId:sid });
    }
  }

  sess.step = 'MENU';
  return res.json({ ok:true, reply:`<div>What would you like to do?</div>${welcomeHtml()}`, sessionId:sid });
}

// ── Router factory ─────────────────────────────────────────────────────────────
export function createScViewRouter({ requireAuth, getActiveSap }) {
  const router = Router();

  router.post('/reset', requireAuth, (req, res) => {
    const { sessionId } = req.body;
    if (sessionId) _sess.delete(sessionId);
    res.json({ ok:true });
  });

  router.post('/chat', requireAuth, async (req, res) => {
    try {
      const sap = getActiveSap();
      const { message = '', sessionId } = req.body;
      let sess = sessionId && _sess.get(sessionId);
      if (!sess) {
        sess = sessInit(); _sess.set(sess.sid, sess);
        return res.json({
          ok:true,
          sessionId: sess.sid,
          reply:`<div style="font-size:14px;font-weight:700;color:#0e7490;margin-bottom:8px">👋 Welcome to <strong>Service Call Agent</strong></div>
<div style="font-size:12.5px;color:#6b7280;margin-bottom:12px">Search customer service calls, view details, and update status — all in one place.</div>
${welcomeHtml()}`,
        });
      }
      await handleChat(sess, message, sap, res);
    } catch(e) {
      res.json({ ok:false, error: e.message });
    }
  });

  return router;
}
