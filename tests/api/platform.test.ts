import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { boot, type Harness } from './harness';

let t: Harness;
beforeAll(async () => { t = await boot({}, [4020, 4021]); });
afterAll(async () => { await t.close(); });

const call = async (token: string | null, method: string, path: string, body?: unknown) => {
  const r = await fetch(`${t.main}${path}`, {
    method, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const ids = (rows: any[]) => rows.map((r) => r.id);

describe('users', () => {
  it('only admins may manage users, and an admin sees only their own tenant', async () => {
    expect((await call(await t.access('bob@acme.test'), 'GET', '/admin/users')).status).toBe(403);
    expect((await call(await t.access('dave@acme.test'), 'GET', '/admin/users')).status).toBe(403);
    expect((await call(null, 'GET', '/admin/users')).status).toBe(401);
    const acme = await call(await t.access('alice@acme.test'), 'GET', '/admin/users');
    expect(acme.body.users.map((u: any) => u.email)).toEqual(['alice@acme.test', 'bob@acme.test', 'dave@acme.test']);
    expect(acme.body.users.find((u: any) => u.email === 'bob@acme.test').groups.map((g: any) => g.name)).toEqual(['Operations']);
    const globex = await call(await t.access('carol@globex.test'), 'GET', '/admin/users');
    expect(globex.body.users.map((u: any) => u.email)).toEqual(['carol@globex.test']);
  });

  it('creates a user who can sign in; rejects duplicates and weak passwords', async () => {
    const admin = await t.access('alice@acme.test');
    const ok = await call(admin, 'POST', '/admin/users', { email: 'Erin@Acme.test', password: 'a-long-password', role: 'user' });
    expect(ok.status).toBe(201);
    expect((await t.login('erin@acme.test', 'a-long-password')).status).toBe(200);
    expect((await call(admin, 'POST', '/admin/users', { email: 'erin@acme.test', password: 'a-long-password', role: 'user' })).body.error.code).toBe('email_taken');
    expect((await call(admin, 'POST', '/admin/users', { email: 'x@acme.test', password: 'short', role: 'user' })).status).toBe(400);
    expect((await call(admin, 'POST', '/admin/users', { email: 'x@acme.test', password: 'a-long-password', role: 'superuser' })).status).toBe(400);
  });

  it('a role change takes effect immediately, even for a token issued before', async () => {
    const admin = await t.access('alice@acme.test');
    const bobOld = await t.access('bob@acme.test');
    expect((await call(bobOld, 'GET', '/admin/users')).status).toBe(403);
    const bob = (await call(admin, 'GET', '/admin/users')).body.users.find((u: any) => u.email === 'bob@acme.test');
    expect((await call(admin, 'PATCH', `/admin/users/${bob.id}`, { role: 'admin' })).status).toBe(200);
    expect((await call(bobOld, 'GET', '/admin/users')).status).toBe(200); // same token, new role
    expect((await call(admin, 'PATCH', `/admin/users/${bob.id}`, { role: 'user' })).status).toBe(200);
    expect((await call(bobOld, 'GET', '/admin/users')).status).toBe(403);
  });

  it('disabling a user ends their sessions, tokens and sign-in at once', async () => {
    const admin = await t.access('alice@acme.test');
    await call(admin, 'POST', '/admin/users', { email: 'frank@acme.test', password: 'a-long-password', role: 'user' });
    const frank = await t.login('frank@acme.test', 'a-long-password');
    const frankChild = (await t.childToken(frank.body.accessToken, 'fleet')).body.childToken;
    expect((await t.rpc(frankChild, 'whoami')).status).toBe(200);
    const id = (await call(admin, 'GET', '/admin/users')).body.users.find((u: any) => u.email === 'frank@acme.test').id;
    expect((await call(admin, 'PATCH', `/admin/users/${id}`, { status: 'disabled' })).status).toBe(200);
    expect((await call(frank.body.accessToken, 'GET', '/children')).status).toBe(401);
    const rpc = await t.rpc(frankChild, 'whoami');
    expect(rpc.status).toBe(401);
    expect(rpc.body.error.code).toBe('account_disabled');
    const again = await t.login('frank@acme.test', 'a-long-password');
    expect(again.status).toBe(403);
    expect(again.body.error.code).toBe('account_disabled');
    const refresh = await fetch(`${t.main}/auth/refresh`, { method: 'POST', headers: { Cookie: frank.cookie! } });
    expect(refresh.status).toBe(401);
    // and back on
    await call(admin, 'PATCH', `/admin/users/${id}`, { status: 'active' });
    expect((await t.login('frank@acme.test', 'a-long-password')).status).toBe(200);
  });

  it('an admin cannot lock themselves out, and cannot touch another tenant', async () => {
    const admin = await t.access('alice@acme.test');
    const list = (await call(admin, 'GET', '/admin/users')).body;
    expect((await call(admin, 'PATCH', `/admin/users/${list.self}`, { role: 'viewer' })).body.error.code).toBe('cannot_modify_self');
    expect((await call(admin, 'PATCH', `/admin/users/${list.self}`, { status: 'disabled' })).status).toBe(400);
    const carol = (await call(await t.access('carol@globex.test'), 'GET', '/admin/users')).body.users[0];
    expect((await call(admin, 'PATCH', `/admin/users/${carol.id}`, { status: 'disabled' })).status).toBe(404);
    expect((await t.login('carol@globex.test')).status).toBe(200);
  });

  it('a password reset signs the user out everywhere', async () => {
    const admin = await t.access('alice@acme.test');
    await call(admin, 'POST', '/admin/users', { email: 'gina@acme.test', password: 'a-long-password', role: 'viewer' });
    const gina = await t.login('gina@acme.test', 'a-long-password');
    const id = (await call(admin, 'GET', '/admin/users')).body.users.find((u: any) => u.email === 'gina@acme.test').id;
    await call(admin, 'PATCH', `/admin/users/${id}`, { password: 'another-long-one' });
    expect((await fetch(`${t.main}/auth/refresh`, { method: 'POST', headers: { Cookie: gina.cookie! } })).status).toBe(401);
    expect((await t.login('gina@acme.test', 'a-long-password')).status).toBe(401);
    expect((await t.login('gina@acme.test', 'another-long-one')).status).toBe(200);
  });
});

describe('groups and roles', () => {
  it('creates, renames and deletes groups, and manages members within the tenant', async () => {
    const admin = await t.access('alice@acme.test');
    const created = await call(admin, 'POST', '/admin/groups', { name: 'Finance', description: 'Money people' });
    expect(created.status).toBe(201);
    expect((await call(admin, 'POST', '/admin/groups', { name: 'Finance' })).body.error.code).toBe('group_exists');
    const users = (await call(admin, 'GET', '/admin/groups')).body.users;
    const bob = users.find((u: any) => u.email === 'bob@acme.test').id;
    expect((await call(admin, 'PUT', `/admin/groups/${created.body.id}/members`, { userIds: [bob] })).status).toBe(200);
    let g = (await call(admin, 'GET', '/admin/groups')).body.groups.find((x: any) => x.name === 'Finance');
    expect(g.members.map((m: any) => m.email)).toEqual(['bob@acme.test']);
    // a user from another tenant can never be a member
    const carol = (await call(await t.access('carol@globex.test'), 'GET', '/admin/users')).body.users[0].id;
    expect((await call(admin, 'PUT', `/admin/groups/${created.body.id}/members`, { userIds: [carol] })).status).toBe(404);
    expect((await call(admin, 'PATCH', `/admin/groups/${created.body.id}`, { name: 'Finance team' })).status).toBe(200);
    expect((await call(admin, 'DELETE', `/admin/groups/${created.body.id}`)).status).toBe(200);
    g = (await call(admin, 'GET', '/admin/groups')).body.groups.find((x: any) => x.id === created.body.id);
    expect(g).toBeUndefined();
    // groups are tenant-scoped
    expect((await call(await t.access('carol@globex.test'), 'DELETE', `/admin/groups/${created.body.id}`)).status).toBe(404);
    const globexGroups = (await call(await t.access('carol@globex.test'), 'GET', '/admin/groups')).body.groups.map((x: any) => x.name);
    expect(globexGroups).toEqual(['Fleet team']);
  });

  it('non-admins cannot manage groups', async () => {
    expect((await call(await t.access('bob@acme.test'), 'POST', '/admin/groups', { name: 'Sneaky' })).status).toBe(403);
  });

  it('lists the built-in roles with scopes, platform permissions and user counts', async () => {
    const r = (await call(await t.access('alice@acme.test'), 'GET', '/admin/roles')).body;
    expect(r.roles.map((x: any) => x.role)).toEqual(['admin', 'user', 'viewer']);
    expect(r.roles.find((x: any) => x.role === 'viewer').scopes).toEqual(['vehicles.read', 'notes.read']);
    expect(r.roles.find((x: any) => x.role === 'user').platformPerms).toEqual(['reports.read']);
    expect(r.roles.find((x: any) => x.role === 'admin').users).toBeGreaterThanOrEqual(1);
    expect((await call(await t.access('bob@acme.test'), 'GET', '/admin/roles')).status).toBe(403);
  });
});

describe('access management', () => {
  it('Notes (read-only) is seeded as Auditors only: Dave and Alice (admin) can open it, Bob cannot', async () => {
    const list = async (email: string) => ids((await call(await t.access(email), 'GET', '/children')).body.children);
    expect(await list('dave@acme.test')).toContain('notes-ro');
    expect(await list('alice@acme.test')).toContain('notes-ro');
    expect(await list('bob@acme.test')).not.toContain('notes-ro');
    expect((await t.childToken(await t.access('bob@acme.test'), 'notes-ro')).status).toBe(404);
    const rows = await t.audit(await t.access('alice@acme.test'));
    expect(rows.some((r) => r.method === 'child-token' && r.childId === 'notes-ro' && r.reason === 'no_access' && r.result === 'denied')).toBe(true);
  });

  it('a new restriction applies to tokens already issued, and removing it opens the app again', async () => {
    const admin = await t.access('alice@acme.test');
    const bobTok = await t.tokenFor('bob@acme.test', 'fleet');
    expect((await t.rpc(bobTok, 'vehicles.list')).status).toBe(200);
    const { groups } = (await call(admin, 'GET', '/admin/access')).body;
    const auditors = groups.find((g: any) => g.name === 'Auditors').id;
    expect((await call(admin, 'PUT', '/admin/access/fleet', { groupIds: [auditors] })).status).toBe(200);
    const denied = await t.rpc(bobTok, 'vehicles.list');
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('child_disabled');
    expect(ids((await call(await t.access('bob@acme.test'), 'GET', '/children')).body.children)).not.toContain('fleet');
    expect(ids((await call(admin, 'GET', '/children')).body.children)).toContain('fleet'); // admins always can
    expect((await call(admin, 'PUT', '/admin/access/fleet', { groupIds: [] })).status).toBe(200);
    expect((await t.rpc(bobTok, 'vehicles.list')).status).toBe(200);
  });

  it('only installed apps and own-tenant groups can be used in a rule; only admins can edit rules', async () => {
    const admin = await t.access('alice@acme.test');
    expect((await call(admin, 'PUT', '/admin/access/wikipedia', { groupIds: [] })).status).toBe(404); // not installed
    const otherGroup = (await call(await t.access('carol@globex.test'), 'GET', '/admin/groups')).body.groups[0].id;
    expect((await call(admin, 'PUT', '/admin/access/fleet', { groupIds: [otherGroup] })).status).toBe(404);
    expect((await call(await t.access('bob@acme.test'), 'PUT', '/admin/access/fleet', { groupIds: [] })).status).toBe(403);
  });

  it('deleting a group lifts the restriction that depended on it', async () => {
    const admin = await t.access('alice@acme.test');
    const g = await call(admin, 'POST', '/admin/groups', { name: 'Temp' });
    await call(admin, 'PUT', '/admin/access/fleet', { groupIds: [g.body.id] });
    expect(ids((await call(await t.access('bob@acme.test'), 'GET', '/children')).body.children)).not.toContain('fleet');
    await call(admin, 'DELETE', `/admin/groups/${g.body.id}`);
    expect(ids((await call(await t.access('bob@acme.test'), 'GET', '/children')).body.children)).toContain('fleet');
  });
});

describe('App Store', () => {
  it('lists the catalog with installed flags, and tells viewers they cannot install', async () => {
    const dave = (await call(await t.access('dave@acme.test'), 'GET', '/store')).body;
    expect(dave.canInstall).toBe(false);
    expect(dave.apps.length).toBeGreaterThanOrEqual(10);
    const wiki = dave.apps.find((a: any) => a.id === 'wikipedia');
    expect(wiki).toMatchObject({ installed: false, mode: 'link', category: 'Reference', host: 'https://www.wikipedia.org' });
    expect(dave.apps.find((a: any) => a.id === 'fleet')).toMatchObject({ installed: true, canOpen: true });
    const bob = (await call(await t.access('bob@acme.test'), 'GET', '/store')).body;
    expect(bob.apps.find((a: any) => a.id === 'notes-ro')).toMatchObject({ installed: true, restricted: true, canOpen: false });
  });

  it('only admins install; installing makes the app appear in the launcher and open as a link', async () => {
    const carol = await t.access('carol@globex.test');
    expect((await call(await t.access('bob@acme.test'), 'POST', '/store/wikipedia/install')).status).toBe(403);
    expect(ids((await call(carol, 'GET', '/children')).body.children)).not.toContain('wikipedia');
    expect((await call(carol, 'POST', '/store/wikipedia/install')).status).toBe(200);
    const mine = (await call(carol, 'GET', '/children')).body.children;
    expect(mine.find((c: any) => c.id === 'wikipedia')).toMatchObject({ mode: 'link', url: 'https://www.wikipedia.org', icon: '📚' });
    // it is per tenant: Acme did not get it
    expect(ids((await call(await t.access('alice@acme.test'), 'GET', '/children')).body.children)).not.toContain('wikipedia');
    expect((await call(carol, 'POST', '/store/nope/install')).status).toBe(404);
  });

  it('uninstalling removes it, clears its access rules, and is audited', async () => {
    const alice = await t.access('alice@acme.test');
    await call(alice, 'POST', '/store/xkcd/install');
    const g = (await call(alice, 'GET', '/admin/access')).body.groups[0].id;
    await call(alice, 'PUT', '/admin/access/xkcd', { groupIds: [g] });
    expect((await call(alice, 'DELETE', '/store/xkcd/install')).status).toBe(200);
    expect(ids((await call(alice, 'GET', '/children')).body.children)).not.toContain('xkcd');
    expect((await t.childToken(alice, 'xkcd')).status).toBe(404);
    await call(alice, 'POST', '/store/xkcd/install'); // reinstall: no leftover restriction
    expect((await call(alice, 'GET', '/admin/access')).body.apps.find((a: any) => a.id === 'xkcd').groupIds).toEqual([]);
    const rows = await t.audit(alice);
    expect(rows.some((r) => r.method === 'app.install' && r.childId === 'xkcd' && r.via === 'mainframe')).toBe(true);
    expect(rows.some((r) => r.method === 'app.uninstall' && r.childId === 'xkcd')).toBe(true);
  });

  it('uninstalling stops tokens that were already issued', async () => {
    const alice = await t.access('alice@acme.test');
    const tok = await t.tokenFor('alice@acme.test', 'rogue-sbx');
    expect((await t.rpc(tok, 'whoami')).status).toBe(200);
    await call(alice, 'DELETE', '/store/rogue-sbx/install');
    expect((await t.rpc(tok, 'whoami')).status).toBe(403);
    await call(alice, 'POST', '/store/rogue-sbx/install');
  });
});

describe('reports', () => {
  it('admins and users may read reports; viewers may not', async () => {
    expect((await call(await t.access('alice@acme.test'), 'GET', '/reports/summary')).status).toBe(200);
    expect((await call(await t.access('bob@acme.test'), 'GET', '/reports/summary?days=30')).status).toBe(200);
    expect((await call(await t.access('dave@acme.test'), 'GET', '/reports/summary')).status).toBe(403);
    expect((await call(null, 'GET', '/reports/summary')).status).toBe(401);
  });

  it('counts calls per app and per user for the tenant only', async () => {
    const tok = await t.tokenFor('bob@acme.test', 'notes');
    await t.rpc(tok, 'notes.list');
    await t.rpc(tok, 'vehicles.list'); // denied: notes has no vehicles.read
    const r = (await call(await t.access('alice@acme.test'), 'GET', '/reports/summary?days=7')).body;
    expect(r.days).toBe(7);
    expect(r.totals.calls).toBeGreaterThanOrEqual(2);
    expect(r.totals.denied).toBeGreaterThanOrEqual(1);
    const notes = r.byApp.find((a: any) => a.id === 'notes');
    expect(notes).toMatchObject({ name: 'Team Notes' });
    expect(notes.calls).toBeGreaterThanOrEqual(2);
    expect(notes.opens).toBeGreaterThanOrEqual(1);
    expect(r.byUser.find((u: any) => u.email === 'bob@acme.test').calls).toBeGreaterThanOrEqual(2);
    expect(r.byUser.map((u: any) => u.email).every((e: string) => e.endsWith('@acme.test'))).toBe(true); // never Globex people
    expect(r.byDay).toHaveLength(7);
    expect(r.denied.some((d: any) => d.reason === 'scope_denied')).toBe(true);
    expect(r.adminActions.some((a: any) => a.method === 'user.create')).toBe(true);
    expect(r.totals.appsInstalled).toBe(r.byApp.length);
    const globex = (await call(await t.access('carol@globex.test'), 'GET', '/reports/summary')).body;
    expect(globex.byApp.find((a: any) => a.id === 'notes').calls).toBe(0);
  });

  it('clamps the period', async () => {
    const r = (await call(await t.access('alice@acme.test'), 'GET', '/reports/summary?days=9999')).body;
    expect(r.days).toBe(90);
    expect(r.byDay).toHaveLength(30);
  });
});
