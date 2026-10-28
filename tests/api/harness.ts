import { startServers, type Running } from '../../src/server/bootstrap';
import type { Config } from '../../src/server/config';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

export interface Harness {
  srv: Running;
  main: string;
  child: string;
  login(email: string, password?: string): Promise<{ status: number; body: any; cookie: string | null }>;
  access(email: string): Promise<string>;
  childToken(access: string, childId: string): Promise<{ status: number; body: any }>;
  /** Access token -> child token for a child, in one step. */
  tokenFor(email: string, childId: string): Promise<string>;
  rpc(token: string | null, method: string, params?: object): Promise<{ status: number; body: any }>;
  audit(access: string): Promise<any[]>;
  close(): Promise<void>;
}

export async function boot(overrides: Partial<Config> = {}, ports: [number, number] = [4000, 4001]): Promise<Harness> {
  const uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'poc-uploads-'));
  const srv = await startServers({
    mainPort: ports[0], childPort: ports[1], dbPath: ':memory:', uploadsDir, jwtSecret: 'test-secret-test-secret-test-secret-123456',
    bcryptCost: 4, loginLimit: 1000, rpcLimit: 1000, testHooks: true, buildAssets: false, ...overrides,
  });
  const main = srv.cfg.mainOrigin;
  const post = async (url: string, body: unknown, bearer?: string | null, headers: Record<string, string> = {}) => {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}), ...headers }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => ({})), headers: r.headers };
  };
  const h: Harness = {
    srv, main, child: srv.cfg.childOrigin,
    async login(email, password = 'Passw0rd!') {
      const r = await post(`${main}/auth/login`, { email, password });
      const cookie = r.headers.getSetCookie?.()[0]?.split(';')[0] ?? null;
      return { status: r.status, body: r.body, cookie };
    },
    async access(email) { return (await h.login(email)).body.accessToken; },
    childToken: (access, childId) => post(`${main}/auth/child-token`, { childId }, access),
    async tokenFor(email, childId) {
      const r = await h.childToken(await h.access(email), childId);
      if (r.status !== 200) throw new Error(`child token failed: ${r.status} ${JSON.stringify(r.body)}`);
      return r.body.childToken;
    },
    rpc: (token, method, params = {}) => post(`${main}/api/rpc`, { method, params }, token),
    async audit(access) {
      const r = await fetch(`${main}/audit`, { headers: { Authorization: `Bearer ${access}` } });
      return (await r.json()).rows;
    },
    close: () => srv.close(),
  };
  return h;
}
