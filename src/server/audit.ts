import type { DB } from './db';

export type AuditVia = 'rpc' | 'direct' | 'mainframe';

export interface AuditEntry {
  tenantId: string | null;
  userId: string | null;
  childId: string | null;
  method: string;
  result: 'allowed' | 'denied';
  reason?: string | null;
  via: AuditVia;
}

export function logAudit(db: DB, e: AuditEntry) {
  db.prepare('INSERT INTO audit_log (ts, tenant_id, user_id, child_id, method, result, reason, via) VALUES (?,?,?,?,?,?,?,?)').run(
    new Date().toISOString(), e.tenantId, e.userId, e.childId, e.method, e.result, e.reason ?? null, e.via,
  );
}

interface Row { id: number; ts: string; tenant_id: string | null; user_id: string | null; child_id: string | null; method: string; result: string; reason: string | null; via: string }

const toJson = (r: Row) => ({ id: r.id, ts: r.ts, tenantId: r.tenant_id, userId: r.user_id, childId: r.child_id, method: r.method, result: r.result, reason: r.reason, via: r.via });

/** Last 200 rows for one tenant, oldest first. `after` returns only newer rows (used for live polling). */
export function tenantAudit(db: DB, tenantId: string, after = 0) {
  const rows = db.prepare('SELECT * FROM (SELECT * FROM audit_log WHERE tenant_id = ? AND id > ? ORDER BY id DESC LIMIT 200) ORDER BY id ASC').all(tenantId, after) as Row[];
  return rows.map(toJson);
}

/** Per-tenant row counts only (admins never see another tenant's rows). */
export function auditCounts(db: DB): Record<string, number> {
  const rows = db.prepare('SELECT tenant_id t, COUNT(*) c FROM audit_log WHERE tenant_id IS NOT NULL GROUP BY tenant_id').all() as { t: string; c: number }[];
  return Object.fromEntries(rows.map((r) => [r.t, r.c]));
}
