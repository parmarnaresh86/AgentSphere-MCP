import { Router } from 'express';

// Active employees with the SAP "Technician" role (HEM6 RoleID -2).
// SL may cap pages below $top (default 20), so advance by rows actually returned.
async function fetchTechnicians(sap) {
  const all = [];
  for (let skip = 0; skip < 2000; ) {
    const data = await sap.get(
      `/EmployeesInfo?$select=EmployeeID,FirstName,LastName,EmployeeRolesInfoLines&$filter=${encodeURIComponent("Active eq 'tYES'")}&$orderby=EmployeeID&$top=100&$skip=${skip}`
    ).catch(() => ({ value: [] }));
    const rows = data.value || [];
    if (!rows.length) break;
    all.push(...rows);
    skip += rows.length;
  }
  return all.filter(e => (e.EmployeeRolesInfoLines || []).some(r => Number(r.RoleID) === -2));
}

export function createScFormRouter({ requireAuth, getActiveSap }) {
  const router = Router();

  // GET /init — call types, problem types, technicians
  router.get('/init', requireAuth, async (req, res) => {
    const sap = getActiveSap();
    if (!sap) return res.json({ ok: false, error: 'No active SAP connection' });
    try {
      const [types, probs, techs] = await Promise.all([
        sap.get('/ServiceCallTypes?$select=CallTypeID,Name&$top=100').catch(() => ({ value: [] })),
        sap.get('/ServiceCallProblemTypes?$select=ProblemTypeID,Name&$top=100').catch(() => ({ value: [] })),
        fetchTechnicians(sap),
      ]);
      res.json({
        ok: true,
        callTypes: types.value || [],
        problemTypes: probs.value || [],
        technicians: techs.map(t => ({
          id: t.EmployeeID,
          name: [t.FirstName, t.LastName].filter(Boolean).join(' ') || `ID ${t.EmployeeID}`,
        })),
      });
    } catch (e) {
      res.json({ ok: false, error: e.message });
    }
  });

  // GET /bp-search?q= — customer search
  router.get('/bp-search', requireAuth, async (req, res) => {
    const sap = getActiveSap();
    if (!sap) return res.json({ ok: false, error: 'No SAP connection' });
    const q = (req.query.q || '').trim();
    if (!q) return res.json({ ok: true, results: [] });
    try {
      const filter = `CardType eq 'cCustomer' and (contains(CardCode,'${q}') or contains(CardName,'${q}'))`;
      const data = await sap.get(`/BusinessPartners?$select=CardCode,CardName&$filter=${encodeURIComponent(filter)}&$top=20`);
      res.json({ ok: true, results: data.value || [] });
    } catch (e) {
      res.json({ ok: false, error: e.message });
    }
  });

  // GET /item-search?q= — item search
  router.get('/item-search', requireAuth, async (req, res) => {
    const sap = getActiveSap();
    if (!sap) return res.json({ ok: false, error: 'No SAP connection' });
    const q = (req.query.q || '').trim();
    if (!q) return res.json({ ok: true, results: [] });
    try {
      const filter = `contains(ItemCode,'${q}') or contains(ItemName,'${q}')`;
      const data = await sap.get(`/Items?$select=ItemCode,ItemName,ManageSerialNumbers,ManageBatchNumbers&$filter=${encodeURIComponent(filter)}&$top=20`);
      res.json({ ok: true, results: data.value || [] });
    } catch (e) {
      res.json({ ok: false, error: e.message });
    }
  });

  // POST /create — create service call in SAP
  router.post('/create', requireAuth, async (req, res) => {
    const sap = getActiveSap();
    if (!sap) return res.json({ ok: false, error: 'No SAP connection' });
    const { customerCode, itemCode, serialNum, subject, description, priority, callTypeId, problemTypeId, technicianId } = req.body;
    if (!customerCode) return res.json({ ok: false, error: 'Customer is required' });
    if (!subject?.trim()) return res.json({ ok: false, error: 'Subject is required' });

    const payload = {
      CustomerCode: customerCode,
      Subject: subject.trim(),
      Description: description?.trim() || '',
    };
    if (priority)      payload.Priority      = priority;
    if (callTypeId)    payload.CallType      = Number(callTypeId);
    if (problemTypeId) payload.ProblemType   = Number(problemTypeId);
    if (technicianId)  payload.TechnicianCode = Number(technicianId);
    if (itemCode)      payload.ItemCode       = itemCode;
    if (serialNum?.trim()) payload.SerialNum  = serialNum.trim();

    try {
      const result = await sap.post('/ServiceCalls', payload);
      res.json({ ok: true, callId: result.ServiceCallID });
    } catch (e) {
      res.json({ ok: false, error: e.message });
    }
  });

  // GET /calls?status=&search=&top= — list service calls
  router.get('/calls', requireAuth, async (req, res) => {
    const sap = getActiveSap();
    if (!sap) return res.json({ ok: false, error: 'No SAP connection' });
    const { status, search, top } = req.query;
    const filters = [];
    if (status) filters.push(`Status eq '${status}'`);
    if (search) {
      const n = parseInt(search);
      if (!isNaN(n)) filters.push(`ServiceCallID eq ${n}`);
      else filters.push(`(contains(CustomerCode,'${search}') or contains(CustomerName,'${search}'))`);
    }
    const qs = filters.length ? `$filter=${encodeURIComponent(filters.join(' and '))}&` : '';
    try {
      const data = await sap.get(
        `/ServiceCalls?${qs}$select=ServiceCallID,Subject,CustomerCode,CustomerName,Status,Priority,TechnicianCode,CreateDate,Description,Resolution&$orderby=ServiceCallID desc&$top=${parseInt(top) || 25}`
      );
      res.json({ ok: true, calls: data.value || [] });
    } catch (e) {
      res.json({ ok: false, error: e.message });
    }
  });

  // PATCH /calls/:id — update status / resolution
  router.patch('/calls/:id', requireAuth, async (req, res) => {
    const sap = getActiveSap();
    if (!sap) return res.json({ ok: false, error: 'No SAP connection' });
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.json({ ok: false, error: 'Invalid call ID' });
    const { status, resolution } = req.body;
    if (!status) return res.json({ ok: false, error: 'Status is required' });
    const payload = { Status: status };
    if (resolution?.trim()) payload.Resolution = resolution.trim();
    try {
      await sap.patch(`/ServiceCalls(${id})`, payload);
      res.json({ ok: true, callId: id });
    } catch (e) {
      res.json({ ok: false, error: e.message });
    }
  });

  return router;
}
