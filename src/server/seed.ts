import { loadConfig } from './config';
import { openDb, seedDb, upgradeDb } from './db';

const cfg = loadConfig();
const db = openDb(cfg.dbPath);
const reset = process.argv.includes('--reset');
const did = seedDb(db, cfg, reset);
upgradeDb(db, cfg);
console.log(did ? `Seeded ${cfg.dbPath}${reset ? ' (reset)' : ''}` : `${cfg.dbPath} already seeded (use "npm run seed -- --reset" to start over)`);
db.close();
