import { Router, type Request, type Response } from 'express';
import express from 'express';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { SignJWT, jwtVerify, errors } from 'jose';
import { z } from 'zod';
import type { Config } from './config';
import type { DB } from './db';
import { logAudit } from './audit';
import { ApiError, noStore, onlyOrigin, parseBody, loginLimiter, sha256 } from './security';
import { effectiveScopes, PLATFORM_PERMS, type Role } from '../shared/scopes';
import { canUseApp, currentUser, isInstalled } from './access';

export const ISS = 'mainframe';
export const AUD_USER = 'platform-user';
export const AUD_API = 'platform-api';

export interface UserRow { id: string; tenant_id: string; email: string; password_hash: string; role: Role }
export interface UserCtx { sub: string; tenant: string; role: Role }
export interface ChildClaims { sub: string; tenant: string; role: Role; cid: string; scope: string[]; via: 'rpc' | 'direct'; iatMs: number; exp: number }

export type ChildVerify =
  | { ok: true; claims: ChildClaims }
  | { ok: false; status: 401; reason: 'invalid_token' | 'expired' | 'not_a_child_token'; partial?: { sub?: string; tenant?: string; cid?: string } };

/** Server-side switches used only by the automated tests (see /dev/expire). */
export interface TokenGate { childBefore: number; accessBefore: number }

export function createAuth(cfg: Config, db: DB) {
  const key = new TextEncoder().encode(cfg.jwtSecret);
  const gate: TokenGate = { childBefore: 0, accessBefore: 0 };

  async function signAccess(u: UserRow): Promise<string> {
    return new SignJWT({ tenant: u.tenant_id, role: u.role, iatMs: Date.now() })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(u.id).setIssuer(ISS).setAudience(AUD_USER)
      .setJti(crypto.randomUUID()).setIssuedAt().setExpirationTime(`${cfg.accessTtlSec}s`)
      .sign(key);
  }

  async function signChild(u: UserCtx, cid: string, scope: string[], via: 'rpc' | 'direct'): Promise<string> {
    return new SignJWT({ tenant: u.tenant, role: u.role, cid, scope, via, iatMs: Date.now() })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(u.sub).setIssuer(ISS).setAudience(AUD_API)
      .setJti(crypto.randomUUID()).setIssuedAt().setExpirationTime(`${cfg.childTtlSec}s`)
      .sign(key);
  }

  async function verifyAccess(token: string): Promise<UserCtx> {
    try {
      const { payload } = await jwtVerify(token, key, { issuer: ISS, audience: AUD_USER, algorithms: ['HS256'] });
      if (payload.cid || typeof payload.sub !== 'string' || typeof payload.tenant !== 'string') throw new Error('shape');
      if ((payload.iatMs as number) <= gate.accessBefore) throw new ApiError(401, 'expired', 'Access token expired');
      return { sub: payload.sub, tenant: payload.tenant as string, role: payload.role as Role };
    } catch (e) {
      if (e instanceof ApiError) throw e;
      throw new ApiError(401, e instanceof errors.JWTExpired ? 'expired' : 'invalid_token', 'Sign in required');
    }
  }

  /** Verifies a child token. A token without `cid` (for example a user access token) is "not_a_child_token". */
  async function verifyChild(token: string): Promise<ChildVerify> {
    try {
      const { payload } = await jwtVerify(token, key, { issuer: ISS, algorithms: ['HS256'] });
      if (typeof payload.cid !== 'string') return { ok: false, status: 401, reason: 'not_a_child_token' };
      const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
      if (!aud.includes(AUD_API) || typeof payload.sub !== 'string' || typeof payload.tenant !== 'string' || !Array.isArray(payload.scope))
        return { ok: false, status: 401, reason: 'invalid_token' };
      const partial = { sub: payload.sub, tenant: payload.tenant, cid: payload.cid };
      if (typeof payload.iatMs === 'number' && payload.iatMs <= gate.childBefore) return { ok: false, status: 401, reason: 'expired', partial };
      return {
        ok: true,
        claims: { sub: payload.sub, tenant: payload.tenant, role: payload.role as Role, cid: payload.cid, scope: payload.scope as string[], via: payload.via === 'direct' ? 'direct' : 'rpc', iatMs: payload.iatMs as number, exp: payload.exp as number },
      };
    } catch (e) {
      if (e instanceof errors.JWTExpired) {
        // jose verifies the signature before the expiry, so the payload carried by this error is trustworthy.
        const p = (e as { payload?: Record<string, unknown> }).payload ?? {};
        const partial = { sub: p.sub as string | undefined, tenant: p.tenant as string | undefined, cid: p.cid as string | undefined };
        if (typeof p.cid !== 'string') return { ok: false, status: 401, reason: 'not_a_child_token' };
        return { ok: false, status: 401, reason: 'expired', partial };
      }
      return { ok: false, status: 401, reason: 'invalid_token' };
    }
  }

  const bearer = (req: Request): string | null => {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? '');
    return m ? m[1] : null;
  };

  /** Resolves the signed-in user from a user access token. Throws 401. */
  async function requireUser(req: Request): Promise<UserCtx> {
    const t = bearer(req);
    if (!t) throw new ApiError(401, 'no_token', 'Sign in required');
    const claims = await verifyAccess(t);
    // The token can be up to 10 minutes old: read the user's CURRENT role, tenant and status, so a demoted or disabled user loses access at once.
    const now = currentUser(db, claims.sub);
    if (!now || now.status !== 'active') throw new ApiError(401, 'account_disabled', 'This account is disabled');
    return { sub: now.id, tenant: now.tenant_id, role: now.role };
  }

  async function requireAdmin(req: Request): Promise<UserCtx> {
    const u = await requireUser(req);
    if (u.role !== 'admin') throw new ApiError(403, 'forbidden', 'Admins only');
    return u;
  }

  /** Mainframe (not child-frame) permission check, for the platform screens. */
  async function requirePerm(req: Request, perm: string): Promise<UserCtx> {
    const u = await requireUser(req);
    if (!PLATFORM_PERMS[u.role].includes(perm)) throw new ApiError(403, 'forbidden', `Your role (${u.role}) may not do this`);
    return u;
  }

  // ---- refresh tokens: random, stored hashed, rotated on use, revocable ----
  function issueRefresh(userId: string): string {
    const id = crypto.randomUUID();
    const secret = crypto.randomBytes(32).toString('base64url');
    db.prepare('INSERT INTO refresh_tokens VALUES (?,?,?,?,0)').run(id, userId, sha256(secret), new Date(Date.now() + cfg.refreshTtlSec * 1000).toISOString());
    return `${id}.${secret}`;
  }

  function setRefreshCookie(res: Response, value: string) {
    const secure = !/^http:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(cfg.mainOrigin);
    res.cookie('refresh', value, { httpOnly: true, sameSite: 'strict', path: '/auth', maxAge: cfg.refreshTtlSec * 1000, secure });
  }

  const cookieValue = (req: Request, name: string): string | null => {
    for (const part of (req.headers.cookie ?? '').split(';')) {
      const [k, ...v] = part.trim().split('=');
      if (k === name) return decodeURIComponent(v.join('='));
    }
    return null;
  };

  /** Rotates the refresh cookie. A revoked token being replayed revokes every refresh token of that user. */
  function rotateRefresh(req: Request, res: Response): UserRow {
    const raw = cookieValue(req, 'refresh');
    const [id, secret] = (raw ?? '').split('.');
    const row = id ? (db.prepare('SELECT * FROM refresh_tokens WHERE id = ?').get(id) as { id: string; user_id: string; token_hash: string; expires_at: string; revoked: number } | undefined) : undefined;
    if (!row || !secret || sha256(secret) !== row.token_hash) throw new ApiError(401, 'invalid_refresh', 'Sign in required');
    if (row.revoked) {
      db.prepare('UPDATE refresh_tokens SET revoked = 1 WHERE user_id = ?').run(row.user_id);
      throw new ApiError(401, 'invalid_refresh', 'Sign in required');
    }
    if (new Date(row.expires_at).getTime() < Date.now()) throw new ApiError(401, 'invalid_refresh', 'Sign in required');
    db.prepare('UPDATE refresh_tokens SET revoked = 1 WHERE id = ?').run(row.id);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(row.user_id) as (UserRow & { status: string }) | undefined;
    if (!user || user.status !== 'active') throw new ApiError(401, 'invalid_refresh', 'Sign in required');
    setRefreshCookie(res, issueRefresh(user.id));
    return user;
  }

  const userJson = (u: UserRow) => {
    const t = db.prepare('SELECT id, name FROM tenants WHERE id = ?').get(u.tenant_id) as { id: string; name: string };
    return { id: u.id, email: u.email, role: u.role, tenant: { id: t.id, name: t.name } };
  };

  // Only the child origin may call these two routes cross-origin (the standalone fallback, P8), and never with credentials.
  const childCors = cors({ origin: onlyOrigin(cfg.childOrigin), credentials: false, methods: ['POST', 'OPTIONS'], allowedHeaders: ['Content-Type', 'Authorization'], maxAge: 600 });
  const small = express.json({ limit: '100kb' });
  const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', cfg.bcryptCost);

  // refresh/logout use the cookie, so they must come from the mainframe page itself (cheap CSRF defence on top of SameSite=Strict)
  const sameOriginOnly = (req: Request) => {
    const o = req.headers.origin;
    if (o && o !== cfg.mainOrigin) throw new ApiError(403, 'bad_origin', 'Cross-origin request refused');
  };

  const router = Router();
  router.use(noStore);

  router.options('/login', childCors);
  router.post('/login', childCors, loginLimiter(cfg), small, (req, res) => {
    const { email, password } = parseBody(z.object({ email: z.string().min(3).max(200), password: z.string().min(1).max(200) }), req.body);
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.trim().toLowerCase()) as UserRow | undefined;
    const ok = bcrypt.compareSync(password, user?.password_hash ?? DUMMY_HASH); // always compare, so timing does not reveal which emails exist
    if (!user || !ok) throw new ApiError(401, 'invalid_credentials', 'Wrong email or password');
    if ((user as UserRow & { status: string }).status !== 'active') throw new ApiError(403, 'account_disabled', 'This account is disabled. Ask an administrator.');
    setRefreshCookie(res, issueRefresh(user.id));
    return signAccess(user).then((accessToken) => res.json({ accessToken, expiresIn: cfg.accessTtlSec, user: userJson(user) }));
  });

  router.post('/refresh', (req, res) => {
    sameOriginOnly(req);
    const user = rotateRefresh(req, res);
    return signAccess(user).then((accessToken) => res.json({ accessToken, expiresIn: cfg.accessTtlSec, user: userJson(user) }));
  });

  router.post('/logout', (req, res) => {
    sameOriginOnly(req);
    const [id] = (cookieValue(req, 'refresh') ?? '').split('.');
    if (id) db.prepare('UPDATE refresh_tokens SET revoked = 1 WHERE id = ?').run(id);
    res.clearCookie('refresh', { path: '/auth', httpOnly: true, sameSite: 'strict' });
    res.json({ ok: true });
  });

  router.options('/child-token', childCors);
  router.post('/child-token', childCors, small, async (req, res) => {
    const u = await requireUser(req);
    const { childId, standalone } = parseBody(z.object({ childId: z.string().min(1).max(64), standalone: z.boolean().optional() }), req.body);
    const child = db.prepare(
      `SELECT cf.* FROM child_frames cf JOIN child_frame_tenants t ON t.child_id = cf.id
       WHERE cf.id = ? AND cf.status = 'active' AND t.tenant_id = ? AND t.enabled = 1`,
    ).get(childId, u.tenant) as { id: string; mode: string; scopes: string } | undefined;
    if (!child || !canUseApp(db, u, childId)) {
      // not installed for the tenant, or installed but the user is outside the groups it is restricted to
      const reason = child && isInstalled(db, u.tenant, childId) ? 'no_access' : 'not_enabled';
      logAudit(db, { tenantId: u.tenant, userId: u.sub, childId, method: 'child-token', result: 'denied', reason, via: 'mainframe' });
      throw new ApiError(404, 'child_not_found', 'No such child frame for you');
    }
    if (child.mode === 'link') throw new ApiError(400, 'no_session_for_link', 'External links get no session');
    const scopes = effectiveScopes(JSON.parse(child.scopes) as string[], u.role);
    const childToken = await signChild(u, child.id, scopes, standalone ? 'direct' : 'rpc');
    logAudit(db, { tenantId: u.tenant, userId: u.sub, childId: child.id, method: 'child-token', result: 'allowed', reason: null, via: standalone ? 'direct' : 'mainframe' });
    res.json({ childToken, expiresIn: cfg.childTtlSec, scopes });
  });

  return { router, signAccess, signChild, verifyAccess, verifyChild, requireUser, requireAdmin, requirePerm, bearer, gate };
}

export type Auth = ReturnType<typeof createAuth>;
