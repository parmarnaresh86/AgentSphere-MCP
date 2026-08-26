/**
 * Roles & Permissions Controller
 * GET    /api/roles                    — list roles
 * POST   /api/roles                    — create role
 * PUT    /api/roles/:id                — update role name/desc
 * DELETE /api/roles/:id                — delete role
 * GET    /api/roles/:id/permissions    — get role permission keys
 * PUT    /api/roles/:id/permissions    — set role permission keys
 * GET    /api/permissions              — list all available permission definitions
 */
import { Router } from 'express';
import { roleRepo, ALL_PERMISSIONS } from '../db.mjs';

export function createRolesPermissionsRouter({ requireAuth }) {

  function requireAdminOrSuper(req, res, next) {
    if (!req.user) return res.status(401).json({ error: 'Unauthorised' });
    if (req.user.role !== 'admin' && req.user.role !== 'superadmin')
      return res.status(403).json({ error: 'Admin access required' });
    next();
  }

  const router = Router();

  // List all permission definitions
  router.get('/permissions', requireAuth, (req, res) => {
    res.json(ALL_PERMISSIONS);
  });

  // List all roles with their permission keys
  router.get('/', requireAuth, requireAdminOrSuper, (req, res) => {
    const roles = roleRepo.list.all();
    const result = roles.map(r => ({
      ...r,
      permissions: r.name === 'superadmin'
        ? ALL_PERMISSIONS.map(p => p.key)
        : roleRepo.getPermissions(r.id),
    }));
    res.json(result);
  });

  // Get single role
  router.get('/:id', requireAuth, requireAdminOrSuper, (req, res) => {
    const role = roleRepo.getById.get(Number(req.params.id));
    if (!role) return res.status(404).json({ error: 'Role not found' });
    res.json({ ...role, permissions: roleRepo.getPermissions(role.id) });
  });

  // Create role
  router.post('/', requireAuth, requireAdminOrSuper, (req, res) => {
    const { name, description = '', permissions = [] } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'Name is required' });
    try {
      const info = roleRepo.create(name.trim(), description.trim());
      roleRepo.setPermissions(info.lastInsertRowid, permissions);
      res.json({ ok: true, id: info.lastInsertRowid });
    } catch(e) {
      res.status(400).json({ error: e.message.includes('UNIQUE') ? 'Role name already exists' : e.message });
    }
  });

  // Update role name/description
  router.put('/:id', requireAuth, requireAdminOrSuper, (req, res) => {
    const id = Number(req.params.id);
    const { name, description = '' } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'Name is required' });
    const role = roleRepo.getById.get(id);
    if (!role) return res.status(404).json({ error: 'Role not found' });
    if (role.is_system) return res.status(403).json({ error: 'System roles cannot be renamed' });
    try {
      roleRepo.update(id, name.trim(), description.trim());
      res.json({ ok: true });
    } catch(e) {
      res.status(400).json({ error: e.message });
    }
  });

  // Set permissions for a role
  router.put('/:id/permissions', requireAuth, requireAdminOrSuper, (req, res) => {
    const id = Number(req.params.id);
    const role = roleRepo.getById.get(id);
    if (!role) return res.status(404).json({ error: 'Role not found' });
    if (role.name === 'superadmin') return res.status(403).json({ error: 'superadmin permissions cannot be changed' });
    const { permissions = [] } = req.body;
    const valid = ALL_PERMISSIONS.map(p => p.key);
    const filtered = permissions.filter(k => valid.includes(k));
    roleRepo.setPermissions(id, filtered);
    res.json({ ok: true, count: filtered.length });
  });

  // Delete role
  router.delete('/:id', requireAuth, requireAdminOrSuper, (req, res) => {
    const id = Number(req.params.id);
    const role = roleRepo.getById.get(id);
    if (!role) return res.status(404).json({ error: 'Role not found' });
    if (role.is_system) return res.status(403).json({ error: 'System roles cannot be deleted' });
    roleRepo.delete(id);
    res.json({ ok: true });
  });

  return router;
}
