import express, { type Express } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { z } from 'zod';
import { ROOT, type Config } from './config';
import type { DB } from './db';
import { createAuth } from './auth';
import { createRpcRouter } from './rpc';
import { createPlatformRouter } from './platform';
import { canUseApp } from './access';
import { auditCounts, logAudit, tenantAudit } from './audit';
import { ApiError, errorHandler, mainframeHelmet, noStore, parseBody, sendError } from './security';
import { ASSIGNABLE_SCOPES, effectiveScopes, type Role } from '../shared/scopes';

interface ChildRow { category: string; publisher: string; icon: string; id: string; name: string; description: string; mode: 'injected' | 'sandboxed' | 'link'; url: string; scopes: string; created_by: string | null; created_at: string; status: 'active' | 'disabled' }

const manifestOf = (c: ChildRow) => ({ id: c.id, name: c.name, description: c.description, mode: c.mode, url: c.url, scopes: JSON.parse(c.scopes) as string[], version: '1.0', category: c.category, publisher: c.publisher, icon: c.icon });

const ScopeList = z.array(z.enum(ASSIGNABLE_SCOPES)).max(10);
const Mode = z.enum(['injected', 'sandboxed', 'link']);
const HttpUrl = z.string().max(2000).refine((u) => {
  try { return ['http:', 'https:'].includes(new URL(u).protocol); } catch { return false; }
}, 'must be an http(s) URL');

const CreateChild = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,40}$/, 'lowercase letters, digits and dashes').optional(),
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(300).default(''),
  mode: Mode,
  scopes: ScopeList.default([]), // default scopes: none
  html: z.string().max(1_000_000).optional(), // pasted text, or the contents of an uploaded .html file read by the browser
  url: HttpUrl.optional(),
  tenants: z.array(z.string().max(64)).max(50).optional(),
  category: z.string().trim().min(1).max(40).default('General'),
  publisher: z.string().trim().min(1).max(60).default('Custom'),
  icon: z.string().trim().min(1).max(8).default('🧩'),
});

const PatchChild = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  description: z.string().trim().max(300).optional(),
  mode: Mode.optional(),
  scopes: ScopeList.optional(),
  status: z.enum(['active', 'disabled']).optional(),
  category: z.string().trim().min(1).max(40).optional(),
  publisher: z.string().trim().min(1).max(60).optional(),
  icon: z.string().trim().min(1).max(8).optional(),
});

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'frame';

export function createMainframe(cfg: Config, db: DB): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(mainframeHelmet(cfg));

  const auth = createAuth(cfg, db);
  const small = express.json({ limit: '100kb' });
  const big = express.json({ limit: '1mb' }); // uploads only

  app.get('/health', (_req, res) => res.json({ ok: true, dev: !cfg.production }));

  app.use('/auth', auth.router);
  app.use('/api', createRpcRouter(cfg, db, auth));

  // ---- launcher and evidence ----
  app.get('/me', noStore, async (req, res) => {
    const u = await auth.requireUser(req);
    const row = db.prepare('SELECT u.id, u.email, u.role, t.id tid, t.name tname FROM users u JOIN tenants t ON t.id = u.tenant_id WHERE u.id = ?').get(u.sub) as { id: string; email: string; role: Role; tid: string; tname: string };
    res.json({ id: row.id, email: row.email, role: row.role, tenant: { id: row.tid, name: row.tname } });
  });

  // The launcher ("My apps"): installed for the tenant AND allowed for this user by the access-management group rules.
  app.get('/children', noStore, async (req, res) => {
    const u = await auth.requireUser(req);
    const rows = db.prepare(
      `SELECT cf.* FROM child_frames cf JOIN child_frame_tenants t ON t.child_id = cf.id
       WHERE t.tenant_id = ? AND t.enabled = 1 AND cf.status = 'active' ORDER BY cf.created_at, cf.rowid`,
    ).all(u.tenant) as ChildRow[];
    const mine = rows.filter((c) => canUseApp(db, u, c.id));
    res.json({ children: mine.map((c) => ({ ...manifestOf(c), effectiveScopes: effectiveScopes(JSON.parse(c.scopes), u.role) })) });
  });

  app.get('/audit', noStore, async (req, res) => {
    const u = await auth.requireUser(req);
    const after = Number(req.query.after ?? 0) || 0;
    res.json({ rows: tenantAudit(db, u.tenant, after), ...(u.role === 'admin' ? { tenantCounts: auditCounts(db) } : {}) });
  });

  // The mainframe records refusals it makes itself (for example a sandboxed child asking for a method outside its scopes), via = 'mainframe'.
  app.post('/audit/mainframe', noStore, small, async (req, res) => {
    const u = await auth.requireUser(req);
    const b = parseBody(z.object({ childId: z.string().max(64), method: z.string().max(64), reason: z.enum(['scope_denied', 'unknown_method']) }), req.body);
    const ok = db.prepare('SELECT 1 FROM child_frame_tenants WHERE child_id = ? AND tenant_id = ? AND enabled = 1').get(b.childId, u.tenant);
    if (!ok) throw new ApiError(404, 'child_not_found');
    logAudit(db, { tenantId: u.tenant, userId: u.sub, childId: b.childId, method: b.method, result: 'denied', reason: b.reason, via: 'mainframe' });
    res.json({ ok: true });
  });

  // ---- admin (user access token, role admin) ----
  const adminList = () => {
    const tenants = db.prepare('SELECT id, name FROM tenants ORDER BY name').all() as { id: string; name: string }[];
    const rows = db.prepare('SELECT * FROM child_frames ORDER BY created_at, rowid').all() as ChildRow[];
    const enab = db.prepare('SELECT child_id, tenant_id, enabled FROM child_frame_tenants').all() as { child_id: string; tenant_id: string; enabled: number }[];
    return {
      tenants,
      children: rows.map((c) => ({
        ...manifestOf(c), status: c.status, createdBy: c.created_by, createdAt: c.created_at,
        tenants: Object.fromEntries(tenants.map((t) => [t.id, !!enab.find((e) => e.child_id === c.id && e.tenant_id === t.id && e.enabled)])),
      })),
    };
  };

  app.get('/admin/children', noStore, async (req, res) => {
    await auth.requireAdmin(req);
    res.json(adminList());
  });

  app.post('/admin/children', noStore, big, async (req, res) => {
    const admin = await auth.requireAdmin(req);
    const b = parseBody(CreateChild, req.body);
    if (b.mode === 'link') {
      if (!b.url || b.html !== undefined) throw new ApiError(400, 'bad_request', 'A link needs a url and no html');
    } else if ((b.html === undefined) === (b.url === undefined)) {
      throw new ApiError(400, 'bad_request', 'Give exactly one of html or url');
    }
    if (b.html !== undefined && Buffer.byteLength(b.html) > 1_000_000) throw new ApiError(413, 'payload_too_large', 'HTML is limited to 1 MB');
    if (b.html !== undefined && !b.html.trim()) throw new ApiError(400, 'bad_request', 'HTML is empty');

    const id = b.id ?? `${slug(b.name)}-${crypto.randomBytes(2).toString('hex')}`;
    if (db.prepare('SELECT 1 FROM child_frames WHERE id = ?').get(id)) throw new ApiError(409, 'id_taken', `A child frame with id "${id}" already exists`);

    let url = b.url ?? '';
    if (b.html !== undefined) {
      // Stored as given. Never executed on the mainframe origin: only the child origin serves it.
      fs.mkdirSync(cfg.uploadsDir, { recursive: true });
      fs.writeFileSync(path.join(cfg.uploadsDir, `${id}.html`), b.html, 'utf8');
      url = `${cfg.childOrigin}/c/${id}.html`;
    }
    const tenantIds = (db.prepare('SELECT id FROM tenants').all() as { id: string }[]).map((t) => t.id);
    const enabled = new Set((b.tenants ?? [admin.tenant]).filter((t) => tenantIds.includes(t)));
    db.transaction(() => {
      db.prepare('INSERT INTO child_frames (id, name, description, mode, url, scopes, created_by, created_at, status, category, publisher, icon) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(id, b.name, b.description, b.mode, url, JSON.stringify(b.scopes), admin.sub, new Date().toISOString(), 'active', b.category, b.publisher, b.icon);
      const ins = db.prepare('INSERT INTO child_frame_tenants VALUES (?,?,?)');
      for (const t of tenantIds) ins.run(id, t, enabled.has(t) ? 1 : 0);
    })();
    res.status(201).json({ id, url, manifest: manifestOf(db.prepare('SELECT * FROM child_frames WHERE id = ?').get(id) as ChildRow) });
  });

  app.patch('/admin/children/:id', noStore, small, async (req, res) => {
    await auth.requireAdmin(req);
    const b = parseBody(PatchChild, req.body);
    const cur = db.prepare('SELECT * FROM child_frames WHERE id = ?').get(req.params.id) as ChildRow | undefined;
    if (!cur) throw new ApiError(404, 'child_not_found');
    db.prepare('UPDATE child_frames SET name = ?, description = ?, mode = ?, scopes = ?, status = ?, category = ?, publisher = ?, icon = ? WHERE id = ?').run(
      b.name ?? cur.name, b.description ?? cur.description, b.mode ?? cur.mode, b.scopes ? JSON.stringify(b.scopes) : cur.scopes, b.status ?? cur.status,
      b.category ?? cur.category, b.publisher ?? cur.publisher, b.icon ?? cur.icon, cur.id,
    );
    res.json({ manifest: manifestOf(db.prepare('SELECT * FROM child_frames WHERE id = ?').get(cur.id) as ChildRow) });
  });

  app.put('/admin/children/:id/tenants/:tenantId', noStore, small, async (req, res) => {
    await auth.requireAdmin(req);
    const { enabled } = parseBody(z.object({ enabled: z.boolean() }), req.body);
    const child = db.prepare('SELECT 1 FROM child_frames WHERE id = ?').get(req.params.id);
    const tenant = db.prepare('SELECT 1 FROM tenants WHERE id = ?').get(req.params.tenantId);
    if (!child || !tenant) throw new ApiError(404, 'not_found');
    db.prepare('INSERT INTO child_frame_tenants VALUES (?,?,?) ON CONFLICT(child_id, tenant_id) DO UPDATE SET enabled = excluded.enabled').run(req.params.id, req.params.tenantId, enabled ? 1 : 0);
    res.json({ ok: true });
  });

  app.delete('/admin/children/:id', noStore, async (req, res) => {
    await auth.requireAdmin(req);
    const r = db.prepare("UPDATE child_frames SET status = 'disabled' WHERE id = ?").run(req.params.id); // soft delete
    if (!r.changes) throw new ApiError(404, 'child_not_found');
    res.json({ ok: true });
  });

  // ---- common platform features: users, groups, roles, access management, App Store, reports ----
  app.use(createPlatformRouter(cfg, db, auth));

  // ---- test helpers: only when ENABLE_TEST_HOOKS=1 and never in production ----
  if (cfg.testHooks) {
    app.post('/dev/expire', small, (req, res) => {
      const b = (req.body ?? {}) as { childTokens?: boolean; accessTokens?: boolean; revokeRefresh?: boolean };
      const now = Date.now();
      if (b.childTokens) auth.gate.childBefore = now;
      if (b.accessTokens) auth.gate.accessBefore = now;
      if (b.revokeRefresh) db.prepare('UPDATE refresh_tokens SET revoked = 1').run();
      res.json({ ok: true });
    });
  }

  // ---- help pages (plain Markdown, also readable on GitHub or by an LLM) ----
  app.use('/docs', express.static(path.join(ROOT, 'docs'), { index: false, extensions: [], setHeaders: (res) => { res.setHeader('Content-Type', 'text/markdown; charset=utf-8'); res.setHeader('Cache-Control', 'no-cache'); } }));

  // ---- the UI ----
  const webDir = path.join(cfg.distDir, 'web');
  app.use(express.static(webDir, { index: 'index.html', setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache') }));
  app.use((_req, res) => sendError(res, 404, 'not_found', 'Not found'));
  app.use(errorHandler);
  return app;
}
