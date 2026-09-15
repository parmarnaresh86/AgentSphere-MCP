/**
 * Branding (Company Setup / Developer Settings) — lets one deployed instance
 * be re-skinned per client (product/company/developer name + logo) without
 * code changes. GET is unauthenticated on purpose — the login page needs it
 * before a session exists. PUT is admin-only.
 *
 * Extracted from chat-server.mjs (was ~45 inline lines under "Branding") as
 * part of splitting that file into smaller modules.
 */
import { Router } from 'express';
import { brandingRepo } from '../db.mjs';

function brandingToJson(row) {
  return {
    companyName:     row.company_name      || "",
    companyLogo:     row.company_logo      || "",
    developedBy:     row.developed_by      || "",
    developedByLogo: row.developed_by_logo || "",
    productName:     row.product_name      || "",
    productLogo:     row.product_logo      || "",
  };
}
function isValidLogoValue(v) {
  if (v == null || v === "") return true;
  if (typeof v !== "string") return false;
  return v.startsWith("data:image/") || v.startsWith("/assets/");
}

export function createBrandingRouter(deps) {
  const { requireAuth } = deps;
  const router = Router();

  router.get('/', (_req, res) => {
    try {
      res.json(brandingToJson(brandingRepo.get()));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.put('/', requireAuth, (req, res) => {
    if (req.user.role !== "admin" && req.user.role !== "superadmin") return res.status(403).json({ error: "Admin only" });
    const { companyName, companyLogo, developedBy, developedByLogo, productName, productLogo } = req.body || {};
    for (const [label, v] of [["companyLogo", companyLogo], ["developedByLogo", developedByLogo], ["productLogo", productLogo]]) {
      if (!isValidLogoValue(v)) return res.status(400).json({ error: `${label} must be an uploaded image or empty` });
    }
    try {
      const fields = {};
      if (companyName      !== undefined) fields.company_name      = String(companyName).slice(0, 200);
      if (companyLogo      !== undefined) fields.company_logo      = companyLogo;
      if (developedBy      !== undefined) fields.developed_by      = String(developedBy).slice(0, 200);
      if (developedByLogo  !== undefined) fields.developed_by_logo = developedByLogo;
      if (productName      !== undefined) fields.product_name      = String(productName).slice(0, 200);
      if (productLogo      !== undefined) fields.product_logo      = productLogo;
      const saved = brandingRepo.save(fields, req.user.username || req.user.email || "");
      res.json({ ok: true, branding: brandingToJson(saved) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  return router;
}
