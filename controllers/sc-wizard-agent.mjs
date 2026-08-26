import { Router } from 'express';

export function createScWizardRouter({ requireAuth, getActiveSap }) {
  const router = Router();

  // GET /customers — full customer list for combo
  router.get('/customers', requireAuth, async (req, res) => {
    const sap = getActiveSap();
    if (!sap) return res.json({ ok: false, error: 'No active SAP connection' });
    try {
      const all = [];
      let skip = 0;
      while (true) {
        const data = await sap.get(
          `/BusinessPartners?$filter=CardType eq 'cCustomer'&$select=CardCode,CardName&$orderby=CardName&$top=200&$skip=${skip}`
        ).catch(() => ({ value: [] }));
        const rows = data.value || [];
        all.push(...rows);
        if (rows.length < 200) break;
        skip += 200;
      }
      res.json({ ok: true, customers: all });
    } catch (e) {
      res.json({ ok: false, error: e.message });
    }
  });

  // GET /equipment?customerCode=X — equipment cards for customer
  router.get('/equipment', requireAuth, async (req, res) => {
    const sap = getActiveSap();
    if (!sap) return res.json({ ok: false, error: 'No active SAP connection' });
    const { customerCode } = req.query;
    if (!customerCode) return res.json({ ok: false, error: 'customerCode is required' });
    try {
      const filter = `CustomerCode eq '${customerCode}'`;
      const data = await sap.get(
        `/EquipmentCards?$filter=${encodeURIComponent(filter)}&$select=ItemCode,ItemDescription,InternalSerialNum,ManufacturerSerialNum,ManufactureDate,SaleDate&$top=500`
      ).catch(() => ({ value: [] }));
      res.json({ ok: true, equipment: data.value || [] });
    } catch (e) {
      res.json({ ok: false, error: e.message });
    }
  });

  // GET /employees — technician list
  router.get('/employees', requireAuth, async (req, res) => {
    const sap = getActiveSap();
    if (!sap) return res.json({ ok: false, error: 'No active SAP connection' });
    try {
      const data = await sap.get(
        '/EmployeesInfo?$select=EmployeeID,FirstName,LastName&$top=200'
      ).catch(() => ({ value: [] }));
      const employees = (data.value || []).map(t => ({
        id:   t.EmployeeID,
        name: [t.FirstName, t.LastName].filter(Boolean).join(' ') || `ID ${t.EmployeeID}`,
      }));
      res.json({ ok: true, employees });
    } catch (e) {
      res.json({ ok: false, error: e.message });
    }
  });

  // POST /create — create new service call
  router.post('/create', requireAuth, async (req, res) => {
    const sap = getActiveSap();
    if (!sap) return res.json({ ok: false, error: 'No active SAP connection' });
    const { customerCode, itemCode, serialNum, subject, description, remarks, technicianId, callDate, priority } = req.body;
    if (!customerCode)        return res.json({ ok: false, error: 'Customer is required' });
    if (!subject?.trim())     return res.json({ ok: false, error: 'Subject / complaint is required' });

    const payload = {
      CustomerCode: customerCode,
      Subject:      subject.trim(),
      Description:  (description || '').trim(),
    };
    if (remarks?.trim())   payload.Resolution    = remarks.trim();
    if (technicianId)      payload.TechnicianCode = Number(technicianId);
    if (itemCode)          payload.ItemCode       = itemCode;
    if (serialNum?.trim()) payload.SerialNum      = serialNum.trim();
    if (callDate)          payload.CreateDate     = callDate;

    try {
      const result = await sap.post('/ServiceCalls', payload);
      res.json({ ok: true, callId: result.ServiceCallID });
    } catch (e) {
      res.json({ ok: false, error: e.message });
    }
  });

  return router;
}
