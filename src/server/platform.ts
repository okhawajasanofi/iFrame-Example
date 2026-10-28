/* The COMMON platform features every business app needs, owned by the mainframe so child apps never have to build them:
 * users, groups, roles, access management, an App Store and reports. Everything here is scoped to the caller's tenant
 * (the tenant comes from the signed-in user's CURRENT database row, never from the request) and every change is audited. */
import { Router } from 'express';
import express from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { z } from 'zod';
import type { Config } from './config';
import type { DB } from './db';
import type { Auth, UserCtx } from './auth';
import { logAudit } from './audit';
import { ApiError, noStore, parseBody } from './security';
import { passesGroupRules } from './access';
import { PLATFORM_PERMS, PLATFORM_PERM_LABELS, ROLE_DESCRIPTIONS, ROLE_SCOPES, SCOPE_LABELS, type Role } from '../shared/scopes';

const RoleEnum = z.enum(['admin', 'user', 'viewer']);
const newId = (p: string) => `${p}-${crypto.randomUUID().slice(0, 8)}`;

const ADMIN_METHODS = ['user.create', 'user.update', 'group.create', 'group.update', 'group.delete', 'group.members', 'access.update', 'app.install', 'app.uninstall'];

export function createPlatformRouter(cfg: Config, db: DB, auth: Auth) {
  const router = Router();
  const small = express.json({ limit: '100kb' });

  /** Every administrative change leaves an audit row (via = mainframe), visible in the Proof Panel evidence and in Reports. */
  const audit = (u: UserCtx, method: string, reason: string | null = null, childId: string | null = null) =>
    logAudit(db, { tenantId: u.tenant, userId: u.sub, childId, method, result: 'allowed', reason, via: 'mainframe' });

  const tenantUser = (u: UserCtx, id: string) => {
    const row = db.prepare('SELECT id, email, role, status FROM users WHERE id = ? AND tenant_id = ?').get(id, u.tenant) as { id: string; email: string; role: Role; status: string } | undefined;
    if (!row) throw new ApiError(404, 'user_not_found', 'No such user in your tenant');
    return row;
  };
  const tenantGroup = (u: UserCtx, id: string) => {
    const row = db.prepare('SELECT id, name, description FROM groups WHERE id = ? AND tenant_id = ?').get(id, u.tenant) as { id: string; name: string; description: string } | undefined;
    if (!row) throw new ApiError(404, 'group_not_found', 'No such group in your tenant');
    return row;
  };

  // ------------------------------------------------------------------ users
  router.get('/admin/users', noStore, async (req, res) => {
    const u = await auth.requirePerm(req, 'users.manage');
    const users = db.prepare('SELECT id, email, role, status FROM users WHERE tenant_id = ? ORDER BY email').all(u.tenant) as { id: string; email: string; role: Role; status: string }[];
    const memberships = db.prepare('SELECT gm.user_id uid, g.id gid, g.name FROM group_members gm JOIN groups g ON g.id = gm.group_id WHERE g.tenant_id = ?').all(u.tenant) as { uid: string; gid: string; name: string }[];
    res.json({ users: users.map((x) => ({ ...x, groups: memberships.filter((m) => m.uid === x.id).map((m) => ({ id: m.gid, name: m.name })) })), self: u.sub });
  });

  router.post('/admin/users', noStore, small, async (req, res) => {
    const u = await auth.requirePerm(req, 'users.manage');
    const b = parseBody(z.object({ email: z.email().max(200), password: z.string().min(8).max(200), role: RoleEnum }), req.body);
    const email = b.email.trim().toLowerCase();
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) throw new ApiError(409, 'email_taken', 'That email is already registered');
    const id = newId('u');
    db.prepare('INSERT INTO users (id, tenant_id, email, password_hash, role) VALUES (?,?,?,?,?)').run(id, u.tenant, email, bcrypt.hashSync(b.password, cfg.bcryptCost), b.role);
    audit(u, 'user.create', b.role);
    res.status(201).json({ id, email, role: b.role, status: 'active' });
  });

  router.patch('/admin/users/:id', noStore, small, async (req, res) => {
    const u = await auth.requirePerm(req, 'users.manage');
    const b = parseBody(z.object({ role: RoleEnum.optional(), status: z.enum(['active', 'disabled']).optional(), password: z.string().min(8).max(200).optional() }), req.body);
    const target = tenantUser(u, String(req.params.id));
    // an admin cannot lock themselves out
    if (target.id === u.sub && ((b.role && b.role !== 'admin') || b.status === 'disabled')) throw new ApiError(400, 'cannot_modify_self', 'You cannot remove your own admin role or disable yourself');
    const role = b.role ?? target.role;
    const status = b.status ?? target.status;
    db.prepare('UPDATE users SET role = ?, status = ? WHERE id = ?').run(role, status, target.id);
    if (b.password) db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(b.password, cfg.bcryptCost), target.id);
    if (status === 'disabled' || b.password) db.prepare('UPDATE refresh_tokens SET revoked = 1 WHERE user_id = ?').run(target.id); // end their sessions
    audit(u, 'user.update', [b.role && `role=${b.role}`, b.status && `status=${b.status}`, b.password && 'password'].filter(Boolean).join(',') || null);
    res.json({ id: target.id, email: target.email, role, status });
  });

  // ------------------------------------------------------------------ groups
  router.get('/admin/groups', noStore, async (req, res) => {
    const u = await auth.requirePerm(req, 'groups.manage');
    const groups = db.prepare('SELECT id, name, description FROM groups WHERE tenant_id = ? ORDER BY name').all(u.tenant) as { id: string; name: string; description: string }[];
    const members = db.prepare('SELECT gm.group_id gid, us.id uid, us.email FROM group_members gm JOIN users us ON us.id = gm.user_id WHERE us.tenant_id = ? ORDER BY us.email').all(u.tenant) as { gid: string; uid: string; email: string }[];
    const users = db.prepare('SELECT id, email FROM users WHERE tenant_id = ? ORDER BY email').all(u.tenant);
    res.json({ groups: groups.map((g) => ({ ...g, members: members.filter((m) => m.gid === g.id).map((m) => ({ id: m.uid, email: m.email })) })), users });
  });

  router.post('/admin/groups', noStore, small, async (req, res) => {
    const u = await auth.requirePerm(req, 'groups.manage');
    const b = parseBody(z.object({ name: z.string().trim().min(1).max(60), description: z.string().trim().max(200).default('') }), req.body);
    if (db.prepare('SELECT 1 FROM groups WHERE tenant_id = ? AND name = ?').get(u.tenant, b.name)) throw new ApiError(409, 'group_exists', 'A group with that name already exists');
    const id = newId('g');
    db.prepare('INSERT INTO groups (id, tenant_id, name, description, created_at) VALUES (?,?,?,?,?)').run(id, u.tenant, b.name, b.description, new Date().toISOString());
    audit(u, 'group.create', b.name);
    res.status(201).json({ id });
  });

  router.patch('/admin/groups/:id', noStore, small, async (req, res) => {
    const u = await auth.requirePerm(req, 'groups.manage');
    const g = tenantGroup(u, String(req.params.id));
    const b = parseBody(z.object({ name: z.string().trim().min(1).max(60).optional(), description: z.string().trim().max(200).optional() }), req.body);
    if (b.name && b.name !== g.name && db.prepare('SELECT 1 FROM groups WHERE tenant_id = ? AND name = ?').get(u.tenant, b.name)) throw new ApiError(409, 'group_exists', 'A group with that name already exists');
    db.prepare('UPDATE groups SET name = ?, description = ? WHERE id = ?').run(b.name ?? g.name, b.description ?? g.description, g.id);
    audit(u, 'group.update', g.name);
    res.json({ ok: true });
  });

  router.delete('/admin/groups/:id', noStore, async (req, res) => {
    const u = await auth.requirePerm(req, 'groups.manage');
    const g = tenantGroup(u, String(req.params.id));
    db.prepare('DELETE FROM groups WHERE id = ?').run(g.id); // members and any app restrictions go with it (ON DELETE CASCADE)
    audit(u, 'group.delete', g.name);
    res.json({ ok: true });
  });

  router.put('/admin/groups/:id/members', noStore, small, async (req, res) => {
    const u = await auth.requirePerm(req, 'groups.manage');
    const g = tenantGroup(u, String(req.params.id));
    const { userIds } = parseBody(z.object({ userIds: z.array(z.string().max(64)).max(500) }), req.body);
    for (const id of userIds) tenantUser(u, id); // every member must belong to this tenant
    db.transaction(() => {
      db.prepare('DELETE FROM group_members WHERE group_id = ?').run(g.id);
      const add = db.prepare('INSERT OR IGNORE INTO group_members VALUES (?,?)');
      for (const id of userIds) add.run(g.id, id);
    })();
    audit(u, 'group.members', `${g.name}: ${userIds.length}`);
    res.json({ ok: true });
  });

  // ------------------------------------------------------------------ roles (built in, read only)
  router.get('/admin/roles', noStore, async (req, res) => {
    const u = await auth.requirePerm(req, 'users.manage');
    const counts = db.prepare('SELECT role, COUNT(*) n FROM users WHERE tenant_id = ? GROUP BY role').all(u.tenant) as { role: Role; n: number }[];
    res.json({
      roles: (['admin', 'user', 'viewer'] as Role[]).map((r) => ({ role: r, description: ROLE_DESCRIPTIONS[r], scopes: ROLE_SCOPES[r], platformPerms: PLATFORM_PERMS[r], users: counts.find((c) => c.role === r)?.n ?? 0 })),
      scopeLabels: SCOPE_LABELS, permLabels: PLATFORM_PERM_LABELS,
    });
  });

  // ------------------------------------------------------------------ access management
  router.get('/admin/access', noStore, async (req, res) => {
    const u = await auth.requirePerm(req, 'access.manage');
    const apps = db.prepare(
      `SELECT cf.id, cf.name, cf.icon, cf.mode FROM child_frames cf JOIN child_frame_tenants t ON t.child_id = cf.id
       WHERE t.tenant_id = ? AND t.enabled = 1 AND cf.status = 'active' ORDER BY cf.name`,
    ).all(u.tenant) as { id: string; name: string; icon: string; mode: string }[];
    const rules = db.prepare('SELECT child_id, group_id FROM app_access WHERE tenant_id = ?').all(u.tenant) as { child_id: string; group_id: string }[];
    const groups = db.prepare('SELECT id, name FROM groups WHERE tenant_id = ? ORDER BY name').all(u.tenant);
    res.json({ apps: apps.map((a) => ({ ...a, groupIds: rules.filter((r) => r.child_id === a.id).map((r) => r.group_id) })), groups });
  });

  router.put('/admin/access/:childId', noStore, small, async (req, res) => {
    const u = await auth.requirePerm(req, 'access.manage');
    const childId = String(req.params.childId);
    const { groupIds } = parseBody(z.object({ groupIds: z.array(z.string().max(64)).max(100) }), req.body);
    const installed = db.prepare("SELECT 1 FROM child_frame_tenants WHERE child_id = ? AND tenant_id = ? AND enabled = 1").get(childId, u.tenant);
    if (!installed) throw new ApiError(404, 'child_not_found', 'That app is not installed for your tenant');
    for (const id of groupIds) tenantGroup(u, id);
    db.transaction(() => {
      db.prepare('DELETE FROM app_access WHERE tenant_id = ? AND child_id = ?').run(u.tenant, childId);
      const add = db.prepare('INSERT OR IGNORE INTO app_access VALUES (?,?,?)');
      for (const id of groupIds) add.run(u.tenant, childId, id);
    })();
    audit(u, 'access.update', groupIds.length ? `restricted to ${groupIds.length} group(s)` : 'open to everyone', childId);
    res.json({ ok: true });
  });

  // ------------------------------------------------------------------ App Store
  router.get('/store', noStore, async (req, res) => {
    const u = await auth.requireUser(req);
    const apps = db.prepare("SELECT * FROM child_frames WHERE status = 'active' ORDER BY category, name").all() as {
      id: string; name: string; description: string; mode: string; scopes: string; category: string; publisher: string; icon: string; url: string }[];
    const installed = new Set((db.prepare('SELECT child_id FROM child_frame_tenants WHERE tenant_id = ? AND enabled = 1').all(u.tenant) as { child_id: string }[]).map((r) => r.child_id));
    const rules = db.prepare('SELECT DISTINCT child_id FROM app_access WHERE tenant_id = ?').all(u.tenant) as { child_id: string }[];
    res.json({
      canInstall: PLATFORM_PERMS[u.role].includes('apps.install'),
      apps: apps.map((a) => ({
        id: a.id, name: a.name, description: a.description, mode: a.mode, scopes: JSON.parse(a.scopes) as string[], category: a.category, publisher: a.publisher, icon: a.icon, version: '1.0',
        host: a.mode === 'link' ? new URL(a.url).origin : null,
        installed: installed.has(a.id),
        restricted: rules.some((r) => r.child_id === a.id),
        canOpen: installed.has(a.id) && passesGroupRules(db, u, a.id),
      })),
    });
  });

  const storeApp = (id: string) => {
    const a = db.prepare("SELECT id, name FROM child_frames WHERE id = ? AND status = 'active'").get(id) as { id: string; name: string } | undefined;
    if (!a) throw new ApiError(404, 'child_not_found', 'No such app');
    return a;
  };

  router.post('/store/:id/install', noStore, async (req, res) => {
    const u = await auth.requirePerm(req, 'apps.install');
    const a = storeApp(String(req.params.id));
    db.prepare('INSERT INTO child_frame_tenants VALUES (?,?,1) ON CONFLICT(child_id, tenant_id) DO UPDATE SET enabled = 1').run(a.id, u.tenant);
    audit(u, 'app.install', a.name, a.id);
    res.json({ ok: true });
  });

  router.delete('/store/:id/install', noStore, async (req, res) => {
    const u = await auth.requirePerm(req, 'apps.install');
    const a = storeApp(String(req.params.id));
    db.transaction(() => {
      db.prepare('UPDATE child_frame_tenants SET enabled = 0 WHERE child_id = ? AND tenant_id = ?').run(a.id, u.tenant);
      db.prepare('DELETE FROM app_access WHERE child_id = ? AND tenant_id = ?').run(a.id, u.tenant);
    })();
    audit(u, 'app.uninstall', a.name, a.id);
    res.json({ ok: true });
  });

  // ------------------------------------------------------------------ reports
  router.get('/reports/summary', noStore, async (req, res) => {
    const u = await auth.requirePerm(req, 'reports.read');
    const days = Math.min(90, Math.max(1, Number(req.query.days ?? 7) || 7));
    const since = new Date(Date.now() - days * 86400_000).toISOString();
    const apiVia = "via IN ('rpc','direct')";

    const totals = db.prepare(`SELECT COUNT(*) calls, COALESCE(SUM(result = 'allowed'), 0) allowed, COALESCE(SUM(result = 'denied'), 0) denied FROM audit_log WHERE tenant_id = ? AND ts >= ? AND ${apiVia}`).get(u.tenant, since) as { calls: number; allowed: number; denied: number };
    const activeUsers = (db.prepare(`SELECT COUNT(DISTINCT user_id) n FROM audit_log WHERE tenant_id = ? AND ts >= ? AND user_id IS NOT NULL AND (${apiVia} OR method = 'child-token')`).get(u.tenant, since) as { n: number }).n;

    const installed = db.prepare(
      `SELECT cf.id, cf.name, cf.icon, cf.mode FROM child_frames cf JOIN child_frame_tenants t ON t.child_id = cf.id WHERE t.tenant_id = ? AND t.enabled = 1 AND cf.status = 'active' ORDER BY cf.name`,
    ).all(u.tenant) as { id: string; name: string; icon: string; mode: string }[];
    const callsByApp = db.prepare(`SELECT child_id id, COUNT(*) calls, SUM(result = 'denied') denied, MAX(ts) last FROM audit_log WHERE tenant_id = ? AND ts >= ? AND ${apiVia} AND child_id IS NOT NULL GROUP BY child_id`).all(u.tenant, since) as { id: string; calls: number; denied: number; last: string }[];
    const opens = db.prepare("SELECT child_id id, COUNT(*) n FROM audit_log WHERE tenant_id = ? AND ts >= ? AND method = 'child-token' AND result = 'allowed' GROUP BY child_id").all(u.tenant, since) as { id: string; n: number }[];
    const byApp = installed.map((a) => {
      const c = callsByApp.find((x) => x.id === a.id);
      return { ...a, opens: opens.find((o) => o.id === a.id)?.n ?? 0, calls: c?.calls ?? 0, denied: c?.denied ?? 0, last: c?.last ?? null };
    });

    const byUser = db.prepare(
      `SELECT us.email, us.role, COUNT(a.id) calls, COALESCE(SUM(a.result = 'denied'), 0) denied, MAX(a.ts) last
       FROM users us LEFT JOIN audit_log a ON a.user_id = us.id AND a.tenant_id = us.tenant_id AND a.ts >= ? AND a.via IN ('rpc','direct')
       WHERE us.tenant_id = ? GROUP BY us.id ORDER BY calls DESC, us.email`,
    ).all(since, u.tenant);

    const dayRows = db.prepare(`SELECT substr(ts, 1, 10) day, SUM(result = 'allowed') allowed, SUM(result = 'denied') denied FROM audit_log WHERE tenant_id = ? AND ts >= ? AND ${apiVia} GROUP BY day`).all(u.tenant, since) as { day: string; allowed: number; denied: number }[];
    const byDay = Array.from({ length: Math.min(days, 30) }, (_, i) => {
      const d = new Date(Date.now() - (Math.min(days, 30) - 1 - i) * 86400_000).toISOString().slice(0, 10);
      const r = dayRows.find((x) => x.day === d);
      return { day: d, allowed: r?.allowed ?? 0, denied: r?.denied ?? 0 };
    });

    const denied = db.prepare("SELECT COALESCE(reason, 'unknown') reason, COUNT(*) n FROM audit_log WHERE tenant_id = ? AND ts >= ? AND result = 'denied' GROUP BY reason ORDER BY n DESC").all(u.tenant, since);
    const marks = ADMIN_METHODS.map(() => '?').join(',');
    const adminActions = db.prepare(
      `SELECT a.ts, a.method, a.reason, us.email FROM audit_log a LEFT JOIN users us ON us.id = a.user_id WHERE a.tenant_id = ? AND a.ts >= ? AND a.method IN (${marks}) ORDER BY a.id DESC LIMIT 50`,
    ).all(u.tenant, since, ...ADMIN_METHODS);
    const users = db.prepare('SELECT role, COUNT(*) n FROM users WHERE tenant_id = ? GROUP BY role').all(u.tenant);
    const groups = (db.prepare('SELECT COUNT(*) n FROM groups WHERE tenant_id = ?').get(u.tenant) as { n: number }).n;

    res.json({ days, since, totals: { ...totals, activeUsers, appsInstalled: installed.length, groups }, byApp, byUser, byDay, denied, adminActions, users });
  });

  return router;
}
