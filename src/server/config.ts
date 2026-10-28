import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('../../', import.meta.url));

export interface Config {
  mainPort: number;
  childPort: number;
  mainOrigin: string; // http://localhost:<mainPort>
  childOrigin: string; // http://127.0.0.1:<childPort>  (different host name = different origin AND cookie jar)
  jwtSecret: string;
  dbPath: string;
  uploadsDir: string;
  samplesDir: string;
  distDir: string;
  production: boolean;
  loginLimit: number; // per minute per IP
  rpcLimit: number; // per minute per token
  testHooks: boolean; // enables /dev/* helpers used by the automated tests; never on in production
  bcryptCost: number;
  accessTtlSec: number;
  childTtlSec: number;
  refreshTtlSec: number;
  buildAssets: boolean;
}

function loadDotEnv() {
  const f = path.join(ROOT, '.env');
  if (!fs.existsSync(f)) return;
  for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}

/** JWT_SECRET from the environment, or generated into .env on first run. */
function ensureSecret(): string {
  loadDotEnv();
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  const secret = crypto.randomBytes(48).toString('base64url');
  fs.appendFileSync(path.join(ROOT, '.env'), `JWT_SECRET=${secret}\n`);
  process.env.JWT_SECRET = secret;
  return secret;
}

const num = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) ? Number(v) : d);

export function loadConfig(o: Partial<Config> = {}): Config {
  if (!o.jwtSecret) loadDotEnv();
  const mainPort = o.mainPort ?? num(process.env.MAIN_PORT, 3000);
  const childPort = o.childPort ?? num(process.env.CHILD_PORT, 3001);
  const production = o.production ?? process.env.NODE_ENV === 'production';
  return {
    mainPort,
    childPort,
    mainOrigin: `http://localhost:${mainPort}`,
    childOrigin: `http://127.0.0.1:${childPort}`,
    jwtSecret: o.jwtSecret ?? ensureSecret(),
    dbPath: o.dbPath ?? process.env.DB_PATH ?? path.join(ROOT, 'data', 'mainframe.db'),
    uploadsDir: o.uploadsDir ?? process.env.UPLOADS_DIR ?? path.join(ROOT, 'uploads'),
    samplesDir: path.join(ROOT, 'src', 'samples'),
    distDir: o.distDir ?? path.join(ROOT, 'dist', `p${mainPort}`),
    production,
    loginLimit: o.loginLimit ?? num(process.env.LOGIN_RATE_LIMIT, 10),
    rpcLimit: o.rpcLimit ?? num(process.env.RPC_RATE_LIMIT, 120),
    testHooks: !production && (o.testHooks ?? process.env.ENABLE_TEST_HOOKS === '1'),
    bcryptCost: o.bcryptCost ?? num(process.env.BCRYPT_COST, 10),
    accessTtlSec: o.accessTtlSec ?? 600,
    childTtlSec: o.childTtlSec ?? 300,
    refreshTtlSec: o.refreshTtlSec ?? 8 * 3600,
    buildAssets: o.buildAssets ?? true,
  };
}
