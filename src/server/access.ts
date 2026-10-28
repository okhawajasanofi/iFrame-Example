import type { DB } from './db';
import type { Role } from '../shared/scopes';

export interface Who { tenant: string; sub: string; role: Role }

/** Is the app active and installed (enabled) for this tenant? */
export function isInstalled(db: DB, tenant: string, childId: string): boolean {
  return !!db.prepare(
    `SELECT 1 FROM child_frames cf JOIN child_frame_tenants t ON t.child_id = cf.id
     WHERE cf.id = ? AND cf.status = 'active' AND t.tenant_id = ? AND t.enabled = 1`,
  ).get(childId, tenant);
}

/**
 * Access management. An installed app with no rows in app_access is open to everyone in the tenant.
 * With rows, only members of those groups may open it. Admins can always open every installed app.
 */
export function passesGroupRules(db: DB, who: Who, childId: string): boolean {
  const rows = db.prepare('SELECT group_id FROM app_access WHERE tenant_id = ? AND child_id = ?').all(who.tenant, childId) as { group_id: string }[];
  if (!rows.length || who.role === 'admin') return true;
  const marks = rows.map(() => '?').join(',');
  return !!db.prepare(`SELECT 1 FROM group_members WHERE user_id = ? AND group_id IN (${marks})`).get(who.sub, ...rows.map((r) => r.group_id));
}

/** Installed for the tenant AND allowed for this user by the group rules. Used by the launcher, child-token and every RPC. */
export function canUseApp(db: DB, who: Who, childId: string): boolean {
  return isInstalled(db, who.tenant, childId) && passesGroupRules(db, who, childId);
}

/** The user row as it is now (role and status can change after a token was issued). */
export function currentUser(db: DB, id: string): { id: string; tenant_id: string; role: Role; status: string; email: string } | undefined {
  return db.prepare('SELECT id, tenant_id, role, status, email FROM users WHERE id = ?').get(id) as { id: string; tenant_id: string; role: Role; status: string; email: string } | undefined;
}
