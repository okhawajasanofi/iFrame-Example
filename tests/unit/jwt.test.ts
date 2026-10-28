import { describe, expect, it } from 'vitest';
import { SignJWT } from 'jose';
import { loadConfig } from '../../src/server/config';
import { openDb } from '../../src/server/db';
import { createAuth, ISS, AUD_API, AUD_USER } from '../../src/server/auth';
import { effectiveScopes, intersect, ROLE_SCOPES } from '../../src/shared/scopes';

const SECRET = 'unit-test-secret-unit-test-secret-1234567';
const cfg = loadConfig({ jwtSecret: SECRET, dbPath: ':memory:', buildAssets: false });
const auth = createAuth(cfg, openDb(':memory:'));
const key = (s = SECRET) => new TextEncoder().encode(s);

function make(claims: Record<string, unknown> = {}, opts: { secret?: string; aud?: string; exp?: string | number; iss?: string; alg?: string } = {}) {
  return new SignJWT({ tenant: 'acme', role: 'user', cid: 'notes', scope: ['notes.read'], iatMs: Date.now(), ...claims })
    .setProtectedHeader({ alg: (opts.alg ?? 'HS256') as 'HS256' })
    .setSubject('u-bob').setIssuer(opts.iss ?? ISS).setAudience(opts.aud ?? AUD_API)
    .setIssuedAt().setExpirationTime(opts.exp ?? '5m')
    .sign(key(opts.secret));
}

describe('T17: child token verification', () => {
  it('accepts a good token', async () => {
    const r = await auth.verifyChild(await make());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.claims).toMatchObject({ sub: 'u-bob', tenant: 'acme', cid: 'notes', scope: ['notes.read'] });
  });

  it('rejects a wrong signature', async () => {
    const r = await auth.verifyChild(await make({}, { secret: 'a-completely-different-secret-value-1234567890' }));
    expect(r).toMatchObject({ ok: false, reason: 'invalid_token' });
  });

  it('rejects an expired token (and says so)', async () => {
    const r = await auth.verifyChild(await make({}, { exp: Math.floor(Date.now() / 1000) - 60 }));
    expect(r).toMatchObject({ ok: false, reason: 'expired' });
  });

  it('rejects the wrong audience', async () => {
    expect(await auth.verifyChild(await make({}, { aud: 'somebody-else' }))).toMatchObject({ ok: false, reason: 'invalid_token' });
    expect(await auth.verifyChild(await make({}, { aud: AUD_USER }))).toMatchObject({ ok: false, reason: 'invalid_token' });
  });

  it('rejects a token without cid (a user access token is "not_a_child_token")', async () => {
    const noCid = await make({ cid: undefined });
    expect(await auth.verifyChild(noCid)).toMatchObject({ ok: false, reason: 'not_a_child_token' });
    const user = await auth.signAccess({ id: 'u-bob', tenant_id: 'acme', email: 'bob@acme.test', password_hash: '', role: 'user' });
    expect(await auth.verifyChild(user)).toMatchObject({ ok: false, reason: 'not_a_child_token' });
  });

  it('rejects the wrong issuer, an unsigned token and garbage', async () => {
    expect(await auth.verifyChild(await make({}, { iss: 'evil' }))).toMatchObject({ ok: false });
    const unsigned = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from('{"cid":"notes","aud":"platform-api","iss":"mainframe","sub":"x","tenant":"acme","scope":[]}').toString('base64url')}.`;
    expect(await auth.verifyChild(unsigned)).toMatchObject({ ok: false });
    expect(await auth.verifyChild('not-a-jwt')).toMatchObject({ ok: false, reason: 'invalid_token' });
  });

  it('a child token is not a valid user access token', async () => {
    await expect(auth.verifyAccess(await make())).rejects.toMatchObject({ status: 401 });
  });
});

describe('scope intersection', () => {
  it('is child scopes ∩ role scopes', () => {
    expect(intersect(['a', 'b'], ['b', 'c'])).toEqual(['b']);
    expect(effectiveScopes(['notes.read', 'notes.write'], 'viewer')).toEqual(['notes.read']);
    expect(effectiveScopes(['notes.read', 'notes.write'], 'user')).toEqual(['notes.read', 'notes.write']);
    expect(effectiveScopes(['admin.children'], 'user')).toEqual([]);
    expect(ROLE_SCOPES.viewer).not.toContain('notes.write');
  });
});
