/**
 * Activity Agent — backend controller
 * Mounted at /api/activity-agent by chat-server.mjs
 *
 * Creates, logs, and manages SAP B1 Activities linked to BPs, orders, and service calls.
 * Supports AI-powered recommendations, bulk creation, and follow-up scheduling.
 */

import { Router } from 'express';

const _sessions = new Map();
const _history  = [];

// ── AI helper ──────────────────────────────────────────────────────────────
async function callAI(aiDeps, messages, system, maxTokens = 900) {
  if (!aiDeps) return '';
  const { AI_PROVIDER, gptChatComplete, azureMessagesCreate } = aiDeps;
  try {
    if (AI_PROVIDER === 'gpt' && process.env.AZURE_GPT_ENDPOINT) {
      const msgs = system ? [{ role: 'system', content: system }, ...messages] : messages;
      const r = await gptChatComplete({ messages: msgs, max_tokens: maxTokens });
      return r.choices?.[0]?.message?.content || '';
    }
    if (AI_PROVIDER === 'azure' && process.env.AZURE_OPENAI_API_KEY) {
      const model = process.env.AZURE_CLAUDE_MODEL || 'claude-3-5-sonnet-20241022';
      const msgs  = system ? [{ role: 'system', content: system }, ...messages] : messages;
      const r = await azureMessagesCreate({ model, messages: msgs, max_tokens: maxTokens });
      return r.content?.[0]?.text || r.choices?.[0]?.message?.content || '';
    }
    if (process.env.ANTHROPIC_API_KEY) {
      const { default: Anthropic } = await import('@anthropic-ai/sdk');
      const ant  = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      const resp = await ant.messages.create({
        model: 'claude-sonnet-4-6', max_tokens: maxTokens,
        system: system || undefined, messages,
      });
      return resp.content?.[0]?.text || '';
    }
  } catch (e) {
    console.warn('[ActivityAgent/AI]', e.message);
  }
  return '';
}

// ── Fetch service calls ────────────────────────────────────────────────────
async function fetchServiceCalls(sap, top = 100) {
  try {
    const r = await sap.get('/ServiceCalls', {
      $filter: "Status ne 'scsClosed'",
      $select: 'ServiceCallID,Subject,CardCode,CardName,Priority,Status,CreationDate,ResolutionDate,TechnicianCode',
      $orderby: 'CreationDate desc',
      $top: top,
    });
    return r.value || [];
  } catch (e) {
    console.warn('[ActivityAgent] fetchServiceCalls:', e.message);
    return [];
  }
}

// ── Fetch open orders nearing due date ────────────────────────────────────
async function fetchOpenOrders(sap, daysAhead = 14, top = 100) {
  try {
    const future = new Date();
    future.setDate(future.getDate() + daysAhead);
    const fStr = future.toISOString().slice(0, 10);
    const r = await sap.get('/Orders', {
      $filter: `DocumentStatus eq 'bost_Open' and Cancelled eq 'tNO' and DocDueDate le '${fStr}'`,
      $select: 'DocEntry,DocNum,CardCode,CardName,DocDueDate,DocTotal,SalesPersonCode,Priority',
      $orderby: 'DocDueDate asc',
      $top: top,
    });
    return r.value || [];
  } catch (e) {
    console.warn('[ActivityAgent] fetchOpenOrders:', e.message);
    return [];
  }
}

// ── Check last activity for a BP ───────────────────────────────────────────
async function getLastActivity(sap, cardCode) {
  try {
    const safe = cardCode.replace(/'/g, "''");
    const r = await sap.get('/Activities', {
      $filter: `CardCode eq '${safe}'`,
      $select: 'ActivityCode,ActivityDate,Subject,Closed,ActivityType',
      $orderby: 'ActivityDate desc',
      $top: 1,
    });
    return (r.value || [])[0] || null;
  } catch {
    return null;
  }
}

// ── AI recommendations ─────────────────────────────────────────────────────
async function getAIRecommendations(aiDeps, entities) {
  const sys = `You are an SAP B1 CRM assistant. Return ONLY valid JSON array — no markdown, no explanation.`;
  const sample = entities.slice(0, 12).map(e => ({
    ref:  e.ref,
    type: e.type,
    card: e.cardName,
    desc: e.description,
    lastActivity: e.lastActivityDate || 'never',
  }));

  const prompt = `Analyse these SAP B1 entities with no recent CRM activity and recommend follow-up activities.

Entities:
${JSON.stringify(sample, null, 2)}

Return a JSON array, one object per entity, with exactly these keys:
{
  "entityRef": "<ref field from entity>",
  "activityType": "Phone Call" | "Note" | "Meeting" | "Task",
  "priority": "acp_High" | "acp_Normal" | "acp_Low",
  "subject": "<concise subject, max 80 chars>",
  "notes": "<2-3 sentence activity notes explaining context and next steps>",
  "followUpDays": <1-14>,
  "reason": "<one sentence why follow-up is needed>"
}`;

  try {
    const raw = await callAI(aiDeps, [{ role: 'user', content: prompt }], sys, 1400);
    const match = raw.match(/\[[\s\S]+\]/);
    if (match) return JSON.parse(match[0]);
  } catch (e) {
    console.warn('[ActivityAgent/AI] recommendation parse failed:', e.message);
  }

  // Rule-based fallback
  return entities.map(e => ({
    entityRef:    e.ref,
    activityType: e.type === 'ServiceCall' ? 'Phone Call' : 'Note',
    priority:     'acp_Normal',
    subject:      `Follow-up: ${e.description?.slice(0, 70) || e.ref}`,
    notes:        `Automated follow-up for ${e.type} ${e.ref} — ${e.cardName}. No activity recorded in the past ${e.inactiveDays || 7} days. Please contact the customer and update status accordingly.`,
    followUpDays: e.type === 'ServiceCall' ? 2 : 5,
    reason:       'No recent activity found — automated follow-up recommended.',
  }));
}

// ── Core scan function ─────────────────────────────────────────────────────
export async function runActivityScan(sap, {
  daysAhead         = 14,
  scanServiceCalls  = true,
  scanOrders        = true,
  maxInactivityDays = 7,
  dryRun            = true,
  createActivities  = false,
  aiDeps            = null,
} = {}) {
  const today   = new Date();
  const cutoff  = new Date(today);
  cutoff.setDate(cutoff.getDate() - maxInactivityDays);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  const todayStr  = today.toISOString().slice(0, 10);

  const entities = [];

  // ── Service Calls ─────────────────────────────────────────────────────────
  if (scanServiceCalls) {
    const calls = await fetchServiceCalls(sap, 80);
    for (const sc of calls) {
      const last       = await getLastActivity(sap, sc.CardCode);
      const lastDate   = last?.ActivityDate?.slice(0, 10) || null;
      const inactive   = !lastDate || lastDate < cutoffStr;
      const inactiveDays = lastDate
        ? Math.floor((today - new Date(lastDate)) / 86_400_000)
        : maxInactivityDays + 1;
      entities.push({
        ref:              `SC-${sc.ServiceCallID}`,
        type:             'ServiceCall',
        cardCode:         sc.CardCode,
        cardName:         sc.CardName || '',
        description:      sc.Subject || `Service Call #${sc.ServiceCallID}`,
        status:           sc.Status,
        priority:         sc.Priority,
        createdDate:      sc.CreationDate?.slice(0, 10),
        lastActivityDate: lastDate,
        inactiveDays,
        inactive,
        docType:          191,
        docNum:           sc.ServiceCallID,
      });
    }
  }

  // ── Open Sales Orders ─────────────────────────────────────────────────────
  if (scanOrders) {
    const orders = await fetchOpenOrders(sap, daysAhead, 60);
    for (const ord of orders) {
      const last       = await getLastActivity(sap, ord.CardCode);
      const lastDate   = last?.ActivityDate?.slice(0, 10) || null;
      const inactive   = !lastDate || lastDate < cutoffStr;
      const inactiveDays = lastDate
        ? Math.floor((today - new Date(lastDate)) / 86_400_000)
        : maxInactivityDays + 1;
      const dueDate = ord.DocDueDate?.slice(0, 10);
      const daysLeft = dueDate
        ? Math.ceil((new Date(dueDate) - today) / 86_400_000)
        : 99;
      entities.push({
        ref:              `SO-${ord.DocNum}`,
        type:             'SalesOrder',
        cardCode:         ord.CardCode,
        cardName:         ord.CardName || '',
        description:      `Sales Order #${ord.DocNum} — Due ${dueDate} — Value: ${Number(ord.DocTotal || 0).toFixed(2)}`,
        dueDate,
        daysLeft,
        value:            Number(ord.DocTotal || 0),
        lastActivityDate: lastDate,
        inactiveDays,
        inactive,
        docType:          17,
        docNum:           ord.DocNum,
        docEntry:         ord.DocEntry,
      });
    }
  }

  const needsActivity = entities.filter(e => e.inactive);
  let recommendations = [];
  let created = 0;

  if (needsActivity.length > 0) {
    recommendations = await getAIRecommendations(aiDeps, needsActivity);

    if (createActivities && !dryRun) {
      const actTypeMap = { 'Phone Call': 1, 'Note': 2, 'Meeting': 3, 'Task': 4 };
      for (let i = 0; i < Math.min(recommendations.length, needsActivity.length); i++) {
        const rec = recommendations[i];
        const ent = needsActivity[i];
        const followUp = new Date(today);
        followUp.setDate(followUp.getDate() + (rec.followUpDays || 3));

        const payload = {
          CardCode:     ent.cardCode,
          ActivityDate: todayStr,
          Recontact:    followUp.toISOString().slice(0, 10),
          Subject:      rec.subject,
          Notes:        `${rec.notes}\n\nAuto-generated by Activity Agent | Entity: ${ent.ref}`,
          Closed:       'tNO',
          ActivityType: actTypeMap[rec.activityType] || 2,
          Priority:     rec.priority || 'acp_Normal',
        };
        if (ent.docType) payload.DocType = ent.docType;
        if (ent.docNum)  payload.DocNum  = ent.docNum;

        try {
          await sap.post('/Activities', payload);
          ent._activityCreated = true;
          created++;
        } catch (e) {
          console.warn('[ActivityAgent] create failed:', ent.ref, e.message);
          ent._activityCreated = false;
        }
      }
    }
  }

  const run = {
    ts:              todayStr,
    scanned:         entities.length,
    needsActivity:   needsActivity.length,
    serviceCalls:    entities.filter(e => e.type === 'ServiceCall').length,
    orders:          entities.filter(e => e.type === 'SalesOrder').length,
    created,
    dryRun,
    entities:        entities.slice(0, 200),
    recommendations: recommendations.slice(0, 100),
  };

  _history.unshift(run);
  if (_history.length > 20) _history.pop();

  return run;
}

// ── List activities from SAP ───────────────────────────────────────────────
async function listActivitiesFromSAP(sap, { cardCode, dateFrom, dateTo, closed, top = 50 } = {}) {
  const filters = [];
  if (cardCode) filters.push(`CardCode eq '${cardCode.replace(/'/g, "''")}'`);
  if (dateFrom) filters.push(`ActivityDate ge '${dateFrom}'`);
  if (dateTo)   filters.push(`ActivityDate le '${dateTo}'`);
  if (closed === 'open')   filters.push(`Closed eq 'tNO'`);
  if (closed === 'closed') filters.push(`Closed eq 'tYES'`);

  try {
    const r = await sap.get('/Activities', {
      ...(filters.length ? { $filter: filters.join(' and ') } : {}),
      $select: 'ActivityCode,CardCode,CardName,ActivityDate,Subject,Notes,Closed,ActivityType,Priority,Recontact',
      $orderby: 'ActivityDate desc',
      $top: top,
    });
    return r.value || [];
  } catch (e) {
    console.warn('[ActivityAgent] listActivities:', e.message);
    return [];
  }
}

// ── Router factory ─────────────────────────────────────────────────────────
export function createActivityAgentRouter({
  requireAuth, getActiveSap,
  gptChatComplete, azureMessagesCreate,
  AI_PROVIDER, USE_AI,
}) {
  const router = Router();
  const _aiDeps = () => USE_AI ? { AI_PROVIDER, gptChatComplete, azureMessagesCreate } : null;

  // GET /config
  router.get('/config', requireAuth, (_req, res) => {
    res.json({
      daysAhead:         14,
      maxInactivityDays: 7,
      scanServiceCalls:  true,
      scanOrders:        true,
      createActivities:  false,
      dryRun:            true,
    });
  });

  // POST /scan
  router.post('/scan', requireAuth, async (req, res) => {
    try {
      const {
        daysAhead         = 14,
        maxInactivityDays = 7,
        scanServiceCalls  = true,
        scanOrders        = true,
        dryRun            = true,
        createActivities  = false,
        useAI             = true,
      } = req.body || {};

      const result = await runActivityScan(getActiveSap(), {
        daysAhead, maxInactivityDays, scanServiceCalls, scanOrders,
        dryRun, createActivities,
        aiDeps: useAI ? _aiDeps() : null,
      });
      res.json({ ok: true, ...result });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // POST /create — single activity
  router.post('/create', requireAuth, async (req, res) => {
    try {
      const {
        cardCode, subject, notes = '',
        activityType = 2,
        priority     = 'acp_Normal',
        activityDate, followUpDate,
        docType, docNum,
        closed = 'tNO',
      } = req.body || {};

      if (!cardCode || !subject) {
        return res.status(400).json({ ok: false, error: 'cardCode and subject are required' });
      }

      const today = new Date().toISOString().slice(0, 10);
      const payload = {
        CardCode:     cardCode,
        ActivityDate: activityDate || today,
        Subject:      subject,
        Notes:        notes,
        Closed:       closed,
        ActivityType: Number(activityType) || 2,
        Priority:     priority,
      };
      if (followUpDate) payload.Recontact = followUpDate;
      if (docType)      payload.DocType   = Number(docType);
      if (docNum)       payload.DocNum    = Number(docNum);

      await getActiveSap().post('/Activities', payload);
      res.json({ ok: true, message: 'Activity created successfully in SAP B1' });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // POST /close/:id
  router.post('/close/:id', requireAuth, async (req, res) => {
    try {
      await getActiveSap().patch(`/Activities(${Number(req.params.id)})`, { Closed: 'tYES' });
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // GET /list
  router.get('/list', requireAuth, async (req, res) => {
    try {
      const { cardCode, dateFrom, dateTo, closed, top } = req.query;
      const activities = await listActivitiesFromSAP(getActiveSap(), {
        cardCode, dateFrom, dateTo, closed, top: Number(top) || 50,
      });
      res.json({ ok: true, activities, count: activities.length });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // GET /history
  router.get('/history', requireAuth, (_req, res) => {
    res.json({ ok: true, history: _history.slice(0, 20) });
  });

  // POST /prompt-parse — parse natural language into activity fields (preview, no SAP write)
  router.post('/prompt-parse', requireAuth, async (req, res) => {
    try {
      const { prompt } = req.body || {};
      if (!prompt?.trim()) return res.status(400).json({ ok: false, error: 'prompt is required' });

      const today = new Date().toISOString().slice(0, 10);
      const fuDefault = (() => { const d = new Date(); d.setDate(d.getDate() + 3); return d.toISOString().slice(0, 10); })();

      const sys = `You are an SAP B1 CRM data extractor. Return ONLY valid JSON — no markdown, no explanation.`;
      const userMsg = `Today is ${today}. Extract SAP B1 activity details from this user request:

"${prompt.trim()}"

Return exactly this JSON (use null for missing fields):
{
  "cardCode": "<BP/customer code if mentioned, else null>",
  "subject": "<concise subject max 80 chars>",
  "notes": "<full notes including context from the prompt, 2-4 sentences>",
  "activityType": <1=Phone Call | 2=Note | 3=Meeting | 4=Task>,
  "activityTypeName": "<Phone Call|Note|Meeting|Task>",
  "priority": "<acp_High|acp_Normal|acp_Low>",
  "activityDate": "<YYYY-MM-DD or null — default ${today}>",
  "followUpDate": "<YYYY-MM-DD or null — default ${fuDefault}>",
  "docType": <17=SalesOrder | 13=Invoice | 23=Quotation | 191=ServiceCall | 22=PurchaseOrder | null>,
  "docTypeName": "<document type name or null>",
  "docNum": <document number as integer or null>,
  "confidence": "<high|medium|low>",
  "missingInfo": ["<list any critical missing fields, e.g. BP Code>"]
}`;

      const aiDeps = _aiDeps();
      let parsed = null;

      if (aiDeps) {
        const raw = await callAI(aiDeps, [{ role: 'user', content: userMsg }], sys, 700);
        const match = raw.match(/\{[\s\S]+\}/);
        if (match) {
          try { parsed = JSON.parse(match[0]); } catch {}
        }
      }

      // Fallback: return partial parse
      if (!parsed) {
        parsed = {
          cardCode: null, subject: prompt.slice(0, 80), notes: prompt,
          activityType: 2, activityTypeName: 'Note',
          priority: 'acp_Normal',
          activityDate: today, followUpDate: fuDefault,
          docType: null, docTypeName: null, docNum: null,
          confidence: 'low',
          missingInfo: ['AI unavailable — please fill in fields manually'],
        };
      }
      // Always default dates
      if (!parsed.activityDate) parsed.activityDate = today;
      if (!parsed.followUpDate) parsed.followUpDate = fuDefault;

      res.json({ ok: true, parsed });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // POST /prompt-create — parse + create in SAP in one call
  router.post('/prompt-create', requireAuth, async (req, res) => {
    try {
      const {
        cardCode, subject, notes = '', activityType = 2, priority = 'acp_Normal',
        activityDate, followUpDate, docType, docNum,
      } = req.body || {};

      if (!cardCode || !subject) {
        return res.status(400).json({ ok: false, error: 'cardCode and subject are required to post to SAP' });
      }

      const today = new Date().toISOString().slice(0, 10);
      const payload = {
        CardCode:     cardCode.trim().toUpperCase(),
        ActivityDate: activityDate || today,
        Subject:      subject,
        Notes:        notes,
        Closed:       'tNO',
        ActivityType: Number(activityType) || 2,
        Priority:     priority,
      };
      if (followUpDate) payload.Recontact = followUpDate;
      if (docType)      payload.DocType   = Number(docType);
      if (docNum)       payload.DocNum    = Number(docNum);

      const sap = getActiveSap();
      await sap.post('/Activities', payload);
      res.json({ ok: true, message: `Activity posted to SAP B1 — "${subject}" for BP ${payload.CardCode}` });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // POST /chat
  router.post('/chat', requireAuth, async (req, res) => {
    try {
      const { message, sessionId = 'default' } = req.body || {};
      if (!message) return res.status(400).json({ ok: false, error: 'message required' });

      if (!_sessions.has(sessionId)) _sessions.set(sessionId, []);
      const hist = _sessions.get(sessionId);
      hist.push({ role: 'user', content: message });

      const sys = `You are an SAP B1 Activity Management assistant. You help users:
- Create and log CRM activities (calls, notes, meetings, tasks) linked to BPs, orders, and service calls
- Schedule follow-ups and assign tasks to responsible employees
- Review open service calls and orders that need customer contact
- Query activity history for business partners and customers

Keep responses concise and practical. When creating activities, always confirm key details (BP, subject, type, date).`;

      const reply = await callAI(_aiDeps(), hist, sys, 600);
      hist.push({ role: 'assistant', content: reply });
      if (hist.length > 30) hist.splice(0, 2);

      res.json({ ok: true, reply });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  return router;
}
