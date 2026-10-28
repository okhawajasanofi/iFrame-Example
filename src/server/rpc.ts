import express, { Router, type Request, type Response } from 'express';
import cors from 'cors';
import crypto from 'node:crypto';
import { z } from 'zod';
import type { Config } from './config';
import type { DB } from './db';
import type { Auth, ChildClaims } from './auth';
import { logAudit } from './audit';
import { onlyOrigin, rpcLimiter, sendError } from './security';
import { canUseApp, currentUser } from './access';
import { METHOD_SCOPE } from '../shared/scopes';

type Outcome = { ok: true; result: unknown } | { ok: false; status: number; code: string; message: string };

interface MethodDef {
  scope: string | null;
  run: (db: DB, ctx: ChildClaims, params: Record<string, unknown>) => unknown;
}

const NoteAdd = z.object({ text: z.string().trim().min(1).max(500) });

/** The method registry. Every query below filters by the tenant taken from the TOKEN, never from params. */
const METHODS: Record<string, MethodDef> = {
  whoami: {
    scope: METHOD_SCOPE.whoami,
    run: (db, c) => {
      const u = db.prepare('SELECT email FROM users WHERE id = ?').get(c.sub) as { email: string } | undefined;
      const t = db.prepare('SELECT id, name FROM tenants WHERE id = ?').get(c.tenant) as { id: string; name: string } | undefined;
      return { user: u?.email ?? c.sub, role: c.role, tenant: t ?? { id: c.tenant, name: c.tenant }, child: c.cid, scopes: c.scope };
    },
  },
  'vehicles.list': {
    scope: METHOD_SCOPE['vehicles.list'],
    run: (db, c) =>
      (db.prepare('SELECT id, name, plate, status, odometer_km FROM vehicles WHERE tenant_id = ? ORDER BY id').all(c.tenant) as { id: string; name: string; plate: string; status: string; odometer_km: number }[]).map(
        (v) => ({ id: v.id, name: v.name, plate: v.plate, status: v.status, odometerKm: v.odometer_km }),
      ),
  },
  'notes.list': {
    scope: METHOD_SCOPE['notes.list'],
    run: (db, c) =>
      (db.prepare('SELECT n.id, n.text, n.created_at, u.email FROM notes n LEFT JOIN users u ON u.id = n.author_id WHERE n.tenant_id = ? ORDER BY n.created_at DESC, n.rowid DESC').all(c.tenant) as { id: string; text: string; created_at: string; email: string | null }[]).map(
        (n) => ({ id: n.id, text: n.text, author: n.email?.split('@')[0] ?? 'unknown', createdAt: n.created_at }),
      ),
  },
  'notes.add': {
    scope: METHOD_SCOPE['notes.add'],
    run: (db, c, params) => {
      const { text } = NoteAdd.parse(params);
      const id = 'n-' + crypto.randomUUID().slice(0, 8);
      const createdAt = new Date().toISOString();
      db.prepare('INSERT INTO notes VALUES (?,?,?,?,?)').run(id, c.tenant, c.sub, text, createdAt);
      return { id, text, createdAt };
    },
  },
};

const CALL = z.object({ method: z.string().min(1).max(64), params: z.record(z.string(), z.unknown()).optional() });

/** A foreign tenant or user id in params is never honoured. We note the attempt in the audit log. */
function foreignIdentity(params: Record<string, unknown>, c: ChildClaims): boolean {
  for (const k of ['tenant', 'tenantId', 'tenant_id']) if (k in params && params[k] !== c.tenant) return true;
  for (const k of ['userId', 'user_id', 'user']) if (k in params && params[k] !== c.sub) return true;
  return false;
}

/** Steps 3 to 6 of section 7: look up, check scope, run with the token's tenant, audit. */
export function runCall(db: DB, c: ChildClaims, method: string, params: Record<string, unknown> = {}): Outcome {
  const audit = (result: 'allowed' | 'denied', reason: string | null) =>
    logAudit(db, { tenantId: c.tenant, userId: c.sub, childId: c.cid, method, result, reason, via: c.via === 'direct' ? 'direct' : 'rpc' });
  const def = Object.hasOwn(METHODS, method) ? METHODS[method] : undefined;
  if (!def) {
    audit('denied', 'unknown_method');
    return { ok: false, status: 404, code: 'unknown_method', message: `Unknown method "${method}"` };
  }
  if (def.scope && !c.scope.includes(def.scope)) {
    audit('denied', 'scope_denied');
    return { ok: false, status: 403, code: 'scope_denied', message: `This child frame (as ${c.role}) may not call ${method}; it needs ${def.scope}` };
  }
  try {
    const result = def.run(db, c, params);
    audit('allowed', foreignIdentity(params, c) ? 'wrong_tenant_ignored' : null);
    return { ok: true, result };
  } catch (e) {
    if (e instanceof z.ZodError) {
      audit('denied', 'bad_params');
      return { ok: false, status: 400, code: 'bad_params', message: e.issues.map((i) => `${i.path.join('.') || 'params'}: ${i.message}`).join('; ') };
    }
    throw e;
  }
}

export function createRpcRouter(cfg: Config, db: DB, auth: Auth) {
  const router = Router();
  // The child origin may call /api/rpc (the standalone fallback uses a child token), never with credentials. Nobody else.
  const childCors = cors({ origin: onlyOrigin(cfg.childOrigin), credentials: false, methods: ['POST', 'OPTIONS'], allowedHeaders: ['Content-Type', 'Authorization'], maxAge: 600 });
  router.options('/rpc', childCors);

  router.post('/rpc', childCors, rpcLimiter(cfg), express.json({ limit: '100kb' }), async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    const deny = (status: number, code: string, message: string, c?: { tenant?: string; sub?: string; cid?: string }) => {
      logAudit(db, { tenantId: c?.tenant ?? null, userId: c?.sub ?? null, childId: c?.cid ?? null, method: 'rpc', result: 'denied', reason: code, via: 'rpc' });
      return sendError(res, status, code, message);
    };
    // 1. Verify the JWT. A user access token (no cid) is refused.
    const token = auth.bearer(req);
    if (!token) return deny(401, 'no_token', 'A child token is required');
    const v = await auth.verifyChild(token);
    if (!v.ok) return deny(v.status, v.reason, v.reason === 'expired' ? 'Token expired' : v.reason === 'not_a_child_token' ? 'This endpoint takes child tokens only' : 'Invalid token', v.partial);
    const c = v.claims;

    // The child frame must still be active and enabled for the tenant (it may have been disabled after the token was issued).
    const who = currentUser(db, c.sub);
    if (!who || who.status !== 'active') return deny(401, 'account_disabled', 'This account is disabled', { tenant: c.tenant, sub: c.sub, cid: c.cid });
    // Installed for the tenant AND still allowed for this user by the group rules (an uninstall or a group change takes effect at once).
    if (!canUseApp(db, { tenant: c.tenant, sub: c.sub, role: who.role }, c.cid)) return deny(403, 'child_disabled', 'This child frame is no longer available to you', { tenant: c.tenant, sub: c.sub, cid: c.cid });

    // 2. tenant, sub and role come from the token. Anything in params is ignored.
    const body = CALL.safeParse(req.body);
    if (!body.success) return deny(400, 'bad_request', 'Expected { method, params }', { tenant: c.tenant, sub: c.sub, cid: c.cid });
    const { method, params = {} } = body.data;

    if (method === 'multi') {
      const m = z.object({ calls: z.array(CALL).min(1).max(20) }).safeParse(params);
      if (!m.success) return deny(400, 'bad_request', 'multi takes 1 to 20 calls', { tenant: c.tenant, sub: c.sub, cid: c.cid });
      // Each call gets the same checks and its own audit row. Always an array, even for one call.
      const results = m.data.calls.map((call) => {
        if (call.method === 'multi') {
          logAudit(db, { tenantId: c.tenant, userId: c.sub, childId: c.cid, method: 'multi', result: 'denied', reason: 'nested_multi', via: 'rpc' });
          return { error: { code: 'nested_multi', message: 'multi cannot be nested' } };
        }
        const o = runCall(db, c, call.method, call.params);
        return o.ok ? { result: o.result } : { error: { code: o.code, message: o.message } };
      });
      return void res.json({ result: results });
    }

    const o = runCall(db, c, method, params);
    if (!o.ok) return sendError(res, o.status, o.code, o.message);
    res.json({ result: o.result });
  });

  return router;
}
