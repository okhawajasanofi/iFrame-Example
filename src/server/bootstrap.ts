import http from 'node:http';
import { loadConfig, type Config } from './config';
import { openDb, seedDb, upgradeDb, type DB } from './db';
import { buildAssets } from './build';
import { createMainframe } from './mainframe';
import { createChildOrigin } from './childOrigin';

export interface Running { cfg: Config; db: DB; close: () => Promise<void> }

const listen = (app: http.RequestListener, port: number, host: string) =>
  new Promise<http.Server>((resolve, reject) => {
    const s = http.createServer(app);
    s.once('error', reject);
    s.listen(port, host, () => resolve(s));
  });

/** Starts both servers (mainframe on localhost, child origin on 127.0.0.1). Used by main.ts and by the tests. */
export async function startServers(overrides: Partial<Config> = {}): Promise<Running> {
  const cfg = loadConfig(overrides);
  const db = openDb(cfg.dbPath);
  if (seedDb(db, cfg)) console.log('Seeded demo data (4 users, 2 tenants, 6 child frames).');
  upgradeDb(db, cfg); // platform features: App Store metadata, demo groups, access rule (once; older databases keep their data)
  if (cfg.buildAssets) await buildAssets(cfg);
  const main = await listen(createMainframe(cfg, db), cfg.mainPort, 'localhost');
  const child = await listen(createChildOrigin(cfg), cfg.childPort, '127.0.0.1');
  return {
    cfg,
    db,
    close: async () => {
      await Promise.all([main, child].map((s) => new Promise<void>((r) => { s.closeAllConnections?.(); s.close(() => r()); })));
      db.close();
    },
  };
}
