import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { boot, type Harness } from './harness';

let t: Harness;
beforeAll(async () => { t = await boot(); });
afterAll(async () => { await t.close(); });

const names = (vs: any[]) => vs.map((v) => v.name);

describe('authentication', () => {
  it('rejects a wrong password and unknown users the same way', async () => {
    const a = await t.login('alice@acme.test', 'nope');
    const b = await t.login('nobody@acme.test', 'nope');
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect(a.body.error.code).toBe(b.body.error.code);
  });

  it('login returns an access token in the body and an HttpOnly, SameSite=Strict refresh cookie scoped to /auth', async () => {
    const r = await fetch(`${t.main}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'alice@acme.test', password: 'Passw0rd!' }) });
    const setCookie = r.headers.getSetCookie()[0];
    expect(setCookie).toMatch(/^refresh=/);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Strict/i);
    expect(setCookie).toMatch(/Path=\/auth/);
    expect(r.headers.get('cache-control')).toBe('no-store');
    const j = await r.json();
    expect(j.accessToken).toBeTruthy();
    expect(j.user).toMatchObject({ email: 'alice@acme.test', role: 'admin', tenant: { id: 'acme', name: 'Acme' } });
  });

  it('rotates the refresh token, and replaying the old one fails and revokes the family', async () => {
    const { cookie } = await t.login('bob@acme.test');
    const refresh = (c: string) => fetch(`${t.main}/auth/refresh`, { method: 'POST', headers: { Cookie: c } });
    const first = await refresh(cookie!);
    expect(first.status).toBe(200);
    const rotated = first.headers.getSetCookie()[0].split(';')[0];
    expect(rotated).not.toBe(cookie);
    expect((await refresh(cookie!)).status).toBe(401); // old one: reuse
    expect((await refresh(rotated)).status).toBe(401); // the whole family was revoked
  });

  it('refuses refresh and logout that come from another origin', async () => {
    const { cookie } = await t.login('bob@acme.test');
    const r = await fetch(`${t.main}/auth/refresh`, { method: 'POST', headers: { Cookie: cookie!, Origin: t.child } });
    expect(r.status).toBe(403);
  });

  it('logout revokes the refresh token', async () => {
    const { cookie } = await t.login('bob@acme.test');
    await fetch(`${t.main}/auth/logout`, { method: 'POST', headers: { Cookie: cookie! } });
    expect((await fetch(`${t.main}/auth/refresh`, { method: 'POST', headers: { Cookie: cookie! } })).status).toBe(401);
  });
});

describe('CORS', () => {
  it('allows the child origin on /auth/login without credentials, and nobody else', async () => {
    const ok = await fetch(`${t.main}/auth/login`, { method: 'OPTIONS', headers: { Origin: t.child, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' } });
    expect(ok.headers.get('access-control-allow-origin')).toBe(t.child);
    expect(ok.headers.get('access-control-allow-credentials')).toBeNull();
    const evil = await fetch(`${t.main}/auth/login`, { method: 'OPTIONS', headers: { Origin: 'http://evil.test', 'Access-Control-Request-Method': 'POST' } });
    expect(evil.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('gives no CORS headers on /admin, /children, /audit or /me', async () => {
    for (const p of ['/admin/children', '/children', '/audit', '/me']) {
      const r = await fetch(`${t.main}${p}`, { headers: { Origin: t.child } });
      expect(r.headers.get('access-control-allow-origin'), p).toBeNull();
    }
  });

  it('child origin answers only the mainframe origin', async () => {
    const r = await fetch(`${t.child}/sdk.js`, { headers: { Origin: t.main } });
    expect(r.headers.get('access-control-allow-origin')).toBe(t.main);
    const other = await fetch(`${t.child}/c/notes.html`, { headers: { Origin: 'http://evil.test' } });
    expect(other.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('T3: only child tokens work on /api/rpc', () => {
  it('a user access token is refused with 401 not_a_child_token', async () => {
    const r = await t.rpc(await t.access('alice@acme.test'), 'whoami');
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe('not_a_child_token');
  });
  it('no token is 401 no_token', async () => {
    const r = await t.rpc(null, 'whoami');
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe('no_token');
  });
  it('garbage is 401 invalid_token', async () => {
    expect((await t.rpc('abc.def.ghi', 'whoami')).body.error.code).toBe('invalid_token');
  });
});

describe('T4 and T5: tenant isolation', () => {
  it('Acme and Globex see different vehicles, and none cross over', async () => {
    const a = await t.rpc(await t.tokenFor('alice@acme.test', 'fleet'), 'vehicles.list');
    const g = await t.rpc(await t.tokenFor('carol@globex.test', 'fleet'), 'vehicles.list');
    expect(a.status).toBe(200);
    expect(a.body.result).toHaveLength(6);
    expect(g.body.result).toHaveLength(6);
    expect(names(a.body.result).every((n: string) => n.startsWith('Acme'))).toBe(true);
    expect(names(g.body.result).every((n: string) => n.startsWith('Globex'))).toBe(true);
  });

  it('a tenant field in params is ignored and audited as wrong_tenant_ignored', async () => {
    const tok = await t.tokenFor('alice@acme.test', 'fleet');
    const r = await t.rpc(tok, 'vehicles.list', { tenant: 'globex', tenantId: 'globex', userId: 'u-carol' });
    expect(names(r.body.result).every((n: string) => n.startsWith('Acme'))).toBe(true);
    const rows = await t.audit(await t.access('alice@acme.test'));
    expect(rows.some((x) => x.method === 'vehicles.list' && x.reason === 'wrong_tenant_ignored' && x.result === 'allowed')).toBe(true);
  });

  it("another tenant's audit rows are never returned", async () => {
    await t.rpc(await t.tokenFor('carol@globex.test', 'fleet'), 'vehicles.list');
    const rows = await t.audit(await t.access('alice@acme.test'));
    expect(rows.every((x) => x.tenantId === 'acme')).toBe(true);
  });

  it('notes are tenant-scoped too, and new notes land in the token tenant', async () => {
    const tok = await t.tokenFor('bob@acme.test', 'notes');
    const add = await t.rpc(tok, 'notes.add', { text: 'hello from bob', tenant: 'globex' });
    expect(add.status).toBe(200);
    const acme = await t.rpc(tok, 'notes.list');
    expect(acme.body.result[0].text).toBe('hello from bob');
    const globex = await t.rpc(await t.tokenFor('carol@globex.test', 'notes'), 'notes.list');
    expect(globex.body.result.map((n: any) => n.text)).not.toContain('hello from bob');
  });
});

describe('T6, T7: scopes and roles', () => {
  it('Notes (read-only) is refused notes.add by the server with 403 scope_denied', async () => {
    const tok = await t.tokenFor('alice@acme.test', 'notes-ro');
    expect((await t.rpc(tok, 'notes.list')).status).toBe(200);
    const r = await t.rpc(tok, 'notes.add', { text: 'x' });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('scope_denied');
    const rows = await t.audit(await t.access('alice@acme.test'));
    expect(rows.some((x) => x.method === 'notes.add' && x.childId === 'notes-ro' && x.result === 'denied' && x.reason === 'scope_denied' && x.via === 'rpc')).toBe(true);
  });

  it('Team Notes: a viewer is refused notes.add, a user succeeds (the same child frame, different role)', async () => {
    const dave = await t.tokenFor('dave@acme.test', 'notes');
    const bob = await t.tokenFor('bob@acme.test', 'notes');
    const d = await t.rpc(dave, 'notes.add', { text: 'viewer note' });
    expect(d.status).toBe(403);
    expect(d.body.error.code).toBe('scope_denied');
    expect((await t.rpc(dave, 'notes.list')).status).toBe(200);
    expect((await t.rpc(bob, 'notes.add', { text: 'user note' })).status).toBe(200);
  });

  it('effective scopes are the intersection of child scopes and role scopes', async () => {
    const dave = await t.childToken(await t.access('dave@acme.test'), 'notes');
    expect(dave.body.scopes).toEqual(['notes.read']);
    const bob = await t.childToken(await t.access('bob@acme.test'), 'notes');
    expect(bob.body.scopes).toEqual(['notes.read', 'notes.write']);
  });

  it('validates parameters and rejects unknown methods', async () => {
    const tok = await t.tokenFor('bob@acme.test', 'notes');
    expect((await t.rpc(tok, 'notes.add', { text: '' })).status).toBe(400);
    expect((await t.rpc(tok, 'notes.add', { text: 'x'.repeat(501) })).status).toBe(400);
    const u = await t.rpc(tok, 'users.list');
    expect(u.status).toBe(404);
    expect(u.body.error.code).toBe('unknown_method');
    expect((await t.rpc(tok, 'constructor')).status).toBe(404);
  });
});

describe('T8: child frame enablement', () => {
  it('a child frame not enabled for the tenant gets 404, and so does an unknown one', async () => {
    const access = await t.access('carol@globex.test');
    expect((await t.childToken(access, 'notes-ro')).status).toBe(404);
    expect((await t.childToken(access, 'does-not-exist')).status).toBe(404);
  });
  it('a link frame gets no session', async () => {
    expect((await t.childToken(await t.access('alice@acme.test'), 'website')).status).toBe(400);
  });
  it('GET /children lists only the tenant frames with effective scopes', async () => {
    const get = async (email: string) => (await (await fetch(`${t.main}/children`, { headers: { Authorization: `Bearer ${await t.access(email)}` } })).json()).children;
    const globex = await get('carol@globex.test');
    expect(globex.map((c: any) => c.id).sort()).toEqual(['fleet', 'notes', 'rogue-sbx']);
    const acme = await get('dave@acme.test');
    expect(acme).toHaveLength(6);
    expect(acme.find((c: any) => c.id === 'notes').effectiveScopes).toEqual(['notes.read']);
  });
});

describe('T15: multi', () => {
  it('returns an array, even for one call', async () => {
    const tok = await t.tokenFor('alice@acme.test', 'notes');
    const r = await t.rpc(tok, 'multi', { calls: [{ method: 'notes.list', params: {} }] });
    expect(Array.isArray(r.body.result)).toBe(true);
    expect(r.body.result).toHaveLength(1);
    expect(Array.isArray(r.body.result[0].result)).toBe(true);
  });
  it('checks each call on its own and audits each one', async () => {
    const tok = await t.tokenFor('alice@acme.test', 'notes-ro');
    const r = await t.rpc(tok, 'multi', { calls: [{ method: 'notes.list' }, { method: 'notes.add', params: { text: 'x' } }, { method: 'vehicles.list' }] });
    expect(r.status).toBe(200);
    expect(r.body.result[0].result).toBeTruthy();
    expect(r.body.result[1].error.code).toBe('scope_denied');
    expect(r.body.result[2].error.code).toBe('scope_denied');
  });
  it('is limited to 20 calls and cannot be nested', async () => {
    const tok = await t.tokenFor('alice@acme.test', 'notes');
    expect((await t.rpc(tok, 'multi', { calls: Array(21).fill({ method: 'whoami' }) })).status).toBe(400);
    const n = await t.rpc(tok, 'multi', { calls: [{ method: 'multi', params: { calls: [] } }] });
    expect(n.body.result[0].error.code).toBe('nested_multi');
  });
});

describe('T13: expiry', () => {
  it('an expired child token is refused as expired and a fresh one works', async () => {
    const access = await t.access('alice@acme.test');
    const old = (await t.childToken(access, 'fleet')).body.childToken;
    expect((await t.rpc(old, 'whoami')).status).toBe(200);
    await fetch(`${t.main}/dev/expire`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ childTokens: true }) });
    const r = await t.rpc(old, 'whoami');
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe('expired');
    const fresh = (await t.childToken(access, 'fleet')).body.childToken;
    expect((await t.rpc(fresh, 'whoami')).status).toBe(200);
    const rows = await t.audit(access);
    expect(rows.some((x) => x.reason === 'expired' && x.result === 'denied')).toBe(true);
  });
});

describe('admin API (P7)', () => {
  it('is for admins only', async () => {
    const bob = await t.access('bob@acme.test');
    const r = await fetch(`${t.main}/admin/children`, { headers: { Authorization: `Bearer ${bob}` } });
    expect(r.status).toBe(403);
    expect((await fetch(`${t.main}/admin/children`)).status).toBe(401);
  });

  it('uploads HTML, serves it only from the child origin with the right headers, and lists it in the launcher', async () => {
    const access = await t.access('alice@acme.test');
    const create = await fetch(`${t.main}/admin/children`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${access}` },
      body: JSON.stringify({ name: 'Mini Report', mode: 'sandboxed', html: '<!doctype html><h1>mini</h1>', scopes: ['vehicles.read'] }),
    });
    expect(create.status).toBe(201);
    const { id, url } = await create.json();
    expect(url).toBe(`${t.child}/c/${id}.html`);

    const served = await fetch(url);
    expect(served.status).toBe(200);
    expect(await served.text()).toContain('<h1>mini</h1>');
    expect(served.headers.get('content-security-policy')).toBe(`frame-ancestors ${t.main}`);
    expect(served.headers.get('x-content-type-options')).toBe('nosniff');
    expect((await fetch(`${t.main}/c/${id}.html`)).status).toBe(404); // never served from the mainframe origin

    const list = await (await fetch(`${t.main}/children`, { headers: { Authorization: `Bearer ${access}` } })).json();
    expect(list.children.some((c: any) => c.id === id)).toBe(true);
    // Globex was not ticked, so Carol does not see it
    const carol = await (await fetch(`${t.main}/children`, { headers: { Authorization: `Bearer ${await t.access('carol@globex.test')}` } })).json();
    expect(carol.children.some((c: any) => c.id === id)).toBe(false);
  });

  it('adds a link, then enabling it for Globex makes it appear there; disabling hides it', async () => {
    const access = await t.access('alice@acme.test');
    const auth = { 'Content-Type': 'application/json', Authorization: `Bearer ${access}` };
    const c = await (await fetch(`${t.main}/admin/children`, { method: 'POST', headers: auth, body: JSON.stringify({ name: 'Docs link', mode: 'link', url: 'https://example.org/' }) })).json();
    const carolAuth = { Authorization: `Bearer ${await t.access('carol@globex.test')}` };
    const seen = async () => (await (await fetch(`${t.main}/children`, { headers: carolAuth })).json()).children.some((x: any) => x.id === c.id);
    expect(await seen()).toBe(false);
    await fetch(`${t.main}/admin/children/${c.id}/tenants/globex`, { method: 'PUT', headers: auth, body: JSON.stringify({ enabled: true }) });
    expect(await seen()).toBe(true);
    await fetch(`${t.main}/admin/children/${c.id}`, { method: 'DELETE', headers: auth });
    expect(await seen()).toBe(false);
  });

  it('refuses html larger than 1 MB, and bad input', async () => {
    const access = await t.access('alice@acme.test');
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${access}` };
    const big = await fetch(`${t.main}/admin/children`, { method: 'POST', headers, body: JSON.stringify({ name: 'Big', mode: 'sandboxed', html: 'x'.repeat(1_100_000) }) });
    expect(big.status).toBe(413);
    const noSource = await fetch(`${t.main}/admin/children`, { method: 'POST', headers, body: JSON.stringify({ name: 'None', mode: 'sandboxed' }) });
    expect(noSource.status).toBe(400);
    const badScope = await fetch(`${t.main}/admin/children`, { method: 'POST', headers, body: JSON.stringify({ name: 'Bad', mode: 'sandboxed', html: '<p>x</p>', scopes: ['admin.children'] }) });
    expect(badScope.status).toBe(400);
    const js = await fetch(`${t.main}/admin/children`, { method: 'POST', headers, body: JSON.stringify({ name: 'Js', mode: 'link', url: 'javascript:alert(1)' }) });
    expect(js.status).toBe(400);
  });

  it('a disabled child frame can no longer call the API with a token issued earlier', async () => {
    const access = await t.access('alice@acme.test');
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${access}` };
    const c = await (await fetch(`${t.main}/admin/children`, { method: 'POST', headers, body: JSON.stringify({ name: 'Short lived', mode: 'sandboxed', html: '<p>x</p>', scopes: ['vehicles.read'] }) })).json();
    const tok = (await t.childToken(access, c.id)).body.childToken;
    expect((await t.rpc(tok, 'vehicles.list')).status).toBe(200);
    await fetch(`${t.main}/admin/children/${c.id}`, { method: 'DELETE', headers });
    const r = await t.rpc(tok, 'vehicles.list');
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('child_disabled');
  });
});

describe('mainframe-side audit', () => {
  it('records a refusal the mainframe made itself with via=mainframe', async () => {
    const access = await t.access('alice@acme.test');
    const r = await fetch(`${t.main}/audit/mainframe`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${access}` }, body: JSON.stringify({ childId: 'notes-ro', method: 'notes.add', reason: 'scope_denied' }) });
    expect(r.status).toBe(200);
    const rows = await t.audit(access);
    expect(rows.some((x) => x.via === 'mainframe' && x.method === 'notes.add' && x.result === 'denied')).toBe(true);
  });
});

describe('logs and headers', () => {
  it('never logs a token or a password', async () => {
    const spies = [vi.spyOn(console, 'log'), vi.spyOn(console, 'error'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'info')];
    const login = await t.login('alice@acme.test');
    const tok = await t.tokenFor('alice@acme.test', 'fleet');
    await t.rpc(tok, 'vehicles.list');
    await t.rpc('garbage.token.here', 'vehicles.list');
    await fetch(`${t.main}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{not json' });
    const logged = spies.flatMap((s) => s.mock.calls.flat()).join('\n');
    spies.forEach((s) => s.mockRestore());
    expect(logged).not.toContain(login.body.accessToken);
    expect(logged).not.toContain(tok);
    expect(logged).not.toContain('Passw0rd!');
    expect(logged).not.toMatch(/eyJ[\w-]{10,}\./);
  });

  it('sets the spec CSP on the mainframe and no-store on auth responses', async () => {
    const r = await fetch(`${t.main}/health`);
    const csp = r.headers.get('content-security-policy')!;
    expect(csp).toContain(`frame-src ${t.child} https:`);
    expect(csp).toContain(`script-src 'self' 'unsafe-inline' ${t.child}`);
    expect(csp).toContain(`connect-src 'self' ${t.child}`);
    expect((await fetch(`${t.main}/auth/refresh`, { method: 'POST' })).headers.get('cache-control')).toBe('no-store');
  });

  it('returns the { error: { code, message } } shape for unknown routes and bad JSON', async () => {
    const nf = await fetch(`${t.main}/nope`);
    expect(nf.status).toBe(404);
    expect((await nf.json()).error.code).toBe('not_found');
    const bad = await fetch(`${t.main}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{not json' });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error.code).toBe('bad_json');
  });

  it('serves the two help pages as Markdown, and nothing else from docs', async () => {
    for (const f of ['site-owners.md', 'platform-guide.md']) {
      const r = await fetch(`${t.main}/docs/${f}`);
      expect(r.status).toBe(200);
      expect(r.headers.get('content-type')).toContain('text/markdown');
      expect((await r.text()).startsWith('# ')).toBe(true);
    }
    expect((await fetch(`${t.main}/docs/nope.md`)).status).toBe(404);
    expect((await fetch(`${t.main}/docs/..%2Fpackage.json`)).status).not.toBe(200);
  });

  it('GET /health is ok', async () => {
    expect((await (await fetch(`${t.main}/health`)).json()).ok).toBe(true);
  });
});

describe('rate limits', () => {
  it('limits sign-in attempts per IP', async () => {
    const lim = await boot({ loginLimit: 3 }, [4010, 4011]);
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 5; i++) statuses.push((await lim.login('alice@acme.test', 'wrong')).status);
      expect(statuses).toEqual([401, 401, 401, 429, 429]);
    } finally { await lim.close(); }
  });

  it('limits /api/rpc per token', async () => {
    const lim = await boot({ rpcLimit: 3 }, [4010, 4011]);
    try {
      const tok = await lim.tokenFor('alice@acme.test', 'fleet');
      const statuses: number[] = [];
      for (let i = 0; i < 5; i++) statuses.push((await lim.rpc(tok, 'whoami')).status);
      expect(statuses).toEqual([200, 200, 200, 429, 429]);
    } finally { await lim.close(); }
  });

  it('test hooks are off unless enabled', async () => {
    const off = await boot({ testHooks: false }, [4010, 4011]);
    try { expect((await fetch(`${off.main}/dev/expire`, { method: 'POST' })).status).toBe(404); } finally { await off.close(); }
  });
});
