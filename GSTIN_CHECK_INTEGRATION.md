# GSTIN Check — Portable Integration Guide

Drop-in guide for adding "enter a GSTIN, auto-fill the Business Partner form"
to any web client. Extracted from the AgentSphere SAP B1 chat app; no
dependency on that codebase — just Node/Express (or any backend) + vanilla
JS/fetch. Swap in your own framework where noted.

Uses the free **[gstinapi.in](https://www.gstinapi.in)** REST API.

---

## 1. Get an API key

1. Sign up at https://www.gstinapi.in/register (100 free lookups/month, no card).
2. Copy your key from the dashboard's API Keys page — it looks like `gak_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`.
3. **Never put the key in frontend/client-side code.** Keep it on your server
   and call gstinapi.in from there — the browser calls *your* backend, your
   backend calls gstinapi.in.

```env
# .env
GSTIN_API_KEY=gak_your_api_key_here
```

---

## 2. Backend endpoint (Node/Express example)

```js
// routes/gstin.mjs (or .js)
import { Router } from 'express';
import axios from 'axios';

const GSTIN_API_BASE = 'https://www.gstinapi.in';
const GSTIN_API_KEY = process.env.GSTIN_API_KEY;
const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;

const router = Router();

// GET /api/gstin/:gstin
router.get('/:gstin', async (req, res) => {
  const gstin = String(req.params.gstin || '').trim().toUpperCase();
  if (!GSTIN_RE.test(gstin)) {
    return res.json({ ok: false, error: 'Invalid GSTIN format. Expected a 15-character GSTIN (e.g. 22AAAAA0000A1Z5).' });
  }
  try {
    const r = await axios.get(`${GSTIN_API_BASE}/v1/gstin/${gstin}`, {
      headers: { 'x-api-key': GSTIN_API_KEY },
      timeout: 15000,
      validateStatus: () => true, // handle non-200 ourselves instead of throwing
    });
    if (r.status !== 200 || !r.data?.success) {
      const msg = r.data?.error
        || (r.status === 404 ? 'GSTIN not registered in the GST database.'
          : r.status === 402 ? 'GSTIN API is out of credits.'
          : r.status === 401 ? 'GSTIN API key is missing or invalid.'
          : `GSTIN lookup failed (HTTP ${r.status}).`);
      return res.json({ ok: false, error: msg });
    }
    res.json({ ok: true, data: r.data.data, credits_remaining: r.data.credits_remaining });
  } catch (e) {
    res.json({ ok: false, error: e.message || 'GSTIN lookup failed.' });
  }
});

export default router;
```

```js
// app.mjs
import gstinRouter from './routes/gstin.mjs';
app.use('/api/gstin', gstinRouter); // add your own auth middleware here if needed
```

### API response shape (from gstinapi.in)

```json
{
  "success": true,
  "gstin": "22AAAAA0000A1Z5",
  "credits_remaining": 487,
  "data": {
    "gstin": "22AAAAA0000A1Z5",
    "legal_name": "EXAMPLE PRIVATE LIMITED",
    "trade_name": "EXAMPLE PVT LTD",
    "status": "Active",
    "taxpayer_type": "Regular",
    "registration_date": "2017-07-01",
    "cancellation_date": null,
    "state_code": "22",
    "address": "SHOP NO. 12, 1ST FLOOR, 123 BUSINESS PARK, RAIPUR",
    "city": "RAIPUR",
    "address_details": {
      "building_number": "SHOP NO. 12",
      "building_name": "123 BUSINESS PARK",
      "floor": "1ST FLOOR",
      "street": null,
      "locality": "RAIPUR",
      "district": null,
      "city": null,
      "state": null,
      "landmark": null,
      "pincode": "492001"
    },
    "pincode": "492001",
    "block_status": "Unblocked"
  }
}
```

Notes:
- `city` / `state` inside `address_details` are usually `null` on the basic
  lookup (populate them by appending `?include=profile` to the request URL —
  same credit cost). Fall back to the top-level `city` / a state-code lookup
  table (below) when they're null.
- HTTP status codes: `200` success · `400` invalid GSTIN format (no credit
  charged) · `401` bad key · `402` out of credits · `403` account deactivated
  · `404` GSTIN not registered · `429` rate limited · `502` provider down
  (safe to retry).

---

## 3. Map the response onto a SAP B1–style address form

Same field layout used in the AgentSphere Supplier Master form. Adjust the
target field names to whatever your Business Partner form uses.

```js
const GST_STATE_CODES = {
  '01':'Jammu and Kashmir','02':'Himachal Pradesh','03':'Punjab','04':'Chandigarh','05':'Uttarakhand',
  '06':'Haryana','07':'Delhi','08':'Rajasthan','09':'Uttar Pradesh','10':'Bihar','11':'Sikkim',
  '12':'Arunachal Pradesh','13':'Nagaland','14':'Manipur','15':'Mizoram','16':'Tripura','17':'Meghalaya',
  '18':'Assam','19':'West Bengal','20':'Jharkhand','21':'Odisha','22':'Chhattisgarh','23':'Madhya Pradesh',
  '24':'Gujarat','25':'Daman and Diu','26':'Dadra and Nagar Haveli','27':'Maharashtra','28':'Andhra Pradesh (Old)',
  '29':'Karnataka','30':'Goa','31':'Lakshadweep','32':'Kerala','33':'Tamil Nadu','34':'Puducherry',
  '35':'Andaman and Nicobar Islands','36':'Telangana','37':'Andhra Pradesh','38':'Ladakh',
};

function mapGstinToBpFields(data) {
  const ad = data.address_details || {};
  const building = [ad.building_number, ad.building_name, ad.floor].filter(Boolean).join(', ') || null;
  const blockStreet = [ad.street, ad.locality].filter(Boolean).join(', ') || null;
  const address1 = [ad.building_number, ad.building_name].filter(Boolean).join(', ') || null;
  const address2 = [ad.floor, ad.street, ad.landmark, ad.district].filter(Boolean).join(', ') || null;
  const city = ad.city || ad.locality || data.city || null;
  const zip = data.pincode || ad.pincode || null;
  const state = ad.state || GST_STATE_CODES[data.state_code] || null;

  return {
    cardName: data.legal_name || data.trade_name || '',
    gstin: data.gstin,
    federalTaxId: data.gstin,       // SAP B1 BusinessPartners.FederalTaxID
    building, blockStreet, address1, address2,
    city, zip, state, country: 'India',
    // Ready-to-POST SAP B1 BPAddresses row:
    sapAddress: {
      AddressName: 'GSTIN Registered Address',
      AddressType: 'bo_BillTo',       // or 'bo_ShipTo'
      Street: [blockStreet, address1, address2].filter(Boolean).join(', '),
      City: city || '', State: state || '', ZipCode: zip || '', Country: 'IN',
    },
  };
}
```

---

## 4. Frontend — GSTIN box that auto-fills the BP form

Framework-agnostic vanilla JS/fetch. Swap `document.getElementById` calls
for your framework's state bindings (React state, Vue refs, etc.) if needed.

```html
<label>GSTIN Number</label>
<input id="gstin-input" maxlength="15" placeholder="e.g. 22AAAAA0000A1Z5"
       style="text-transform:uppercase" />
<button id="gstin-check-btn" onclick="checkGstin()">Check GSTIN</button>
<div id="gstin-msg"></div>
```

```js
async function checkGstin() {
  const gstin = document.getElementById('gstin-input').value.trim().toUpperCase();
  const msgEl = document.getElementById('gstin-msg');
  msgEl.textContent = '';
  if (!gstin) { msgEl.textContent = 'Please enter a GSTIN.'; return; }

  const btn = document.getElementById('gstin-check-btn');
  btn.disabled = true; btn.textContent = 'Checking…';
  try {
    const r = await fetch(`/api/gstin/${encodeURIComponent(gstin)}`);
    const res = await r.json();
    if (!res.ok) { msgEl.textContent = res.error; return; }

    const bp = mapGstinToBpFields(res.data); // from section 3, or re-implement client-side
    // Auto-fill your Business Partner form:
    document.getElementById('bp-name').value    = bp.cardName;
    document.getElementById('bp-gstin').value   = bp.gstin;
    document.getElementById('bp-address1').value = bp.address1 || '';
    document.getElementById('bp-address2').value = bp.address2 || '';
    document.getElementById('bp-city').value     = bp.city || '';
    document.getElementById('bp-state').value    = bp.state || '';
    document.getElementById('bp-zip').value      = bp.zip || '';
    document.getElementById('bp-country').value  = bp.country;
  } catch (e) {
    msgEl.textContent = e.message;
  } finally {
    btn.disabled = false; btn.textContent = 'Check GSTIN';
  }
}
```

---

## 5. Optional — duplicate-name check before creating the BP

If your backend already has a way to query existing Business Partners
(SAP B1 Service Layer `/BusinessPartners`, or your own DB), reuse this
match logic so you don't accidentally create a duplicate customer/supplier
under a slightly different spelling/casing:

```js
const normBpName = s => String(s || '').trim().toLowerCase().replace(/\s+/g, '');
const BP_STOPWORDS = new Set(['and','the','of','pvt','ltd','private','limited','co','corp','inc','llp','llc','company']);
const nameTokens = s => String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 3 && !BP_STOPWORDS.has(w));

// candidates = your list of {code, name} from wherever BPs are stored
function classifyMatches(targetName, candidates) {
  const target = normBpName(targetName);
  const targetTokens = nameTokens(targetName);
  return candidates.map(c => {
    const cNorm = normBpName(c.name);
    const cTokens = nameTokens(c.name);
    if (cNorm === target) return { ...c, matchType: 'exact' };
    if (cNorm.includes(target) || target.includes(cNorm)) return { ...c, matchType: 'similar' };
    if (targetTokens.some(t => cTokens.includes(t))) return { ...c, matchType: 'partial' };
    return null;
  }).filter(Boolean);
}
```

For SAP B1, fetch candidates with an OData filter like:

```
GET /b1s/v1/BusinessPartners?$filter=contains(tolower(CardName),'abc') or contains(tolower(CardName),'traders')&$select=CardCode,CardName,CardType,Phone1,EmailAddress&$top=200
```

(build the `or` clauses from `nameTokens(targetName)`), then run the results
through `classifyMatches`.

---

## 6. Posting the Business Partner into SAP B1

Once the form is confirmed, `POST /b1s/v1/BusinessPartners`:

```json
{
  "CardName": "EXAMPLE PRIVATE LIMITED",
  "CardType": "cSupplier",
  "GroupCode": 100,
  "FederalTaxID": "22AAAAA0000A1Z5",
  "BPAddresses": [
    {
      "AddressName": "GSTIN Registered Address",
      "AddressType": "bo_BillTo",
      "Street": "SHOP NO. 12, 123 BUSINESS PARK, 1ST FLOOR",
      "City": "RAIPUR",
      "State": "Chhattisgarh",
      "ZipCode": "492001",
      "Country": "IN",
      "RowNum": 0
    }
  ]
}
```

`CardType` is `cCustomer` or `cSupplier`; `GroupCode` must be a valid
`BusinessPartnerGroups.Code` from your SAP company. `FederalTaxID` is the
field SAP B1 uses to store the GSTIN on a Business Partner.

---

## Reference

- Base URL: `https://www.gstinapi.in`
- Endpoint: `GET /v1/gstin/{gstin}`
- Auth: header `x-api-key: <your key>`
- Rate limit: 60 requests/min per key
- Full docs: https://www.gstinapi.in/docs
