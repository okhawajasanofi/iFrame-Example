// Starts a clean mainframe for the e2e run: fresh database and uploads, test hooks on, generous rate limits.
import fs from 'node:fs';
import path from 'node:path';
import { startServers } from '../../src/server/bootstrap';
import { ROOT } from '../../src/server/config';

const db = path.join(ROOT, 'data', 'e2e.db');
for (const f of [db, db + '-wal', db + '-shm']) fs.rmSync(f, { force: true });
const uploadsDir = path.join(ROOT, 'uploads-e2e');
fs.rmSync(uploadsDir, { recursive: true, force: true });

startServers({
  mainPort: 3100, childPort: 3101, dbPath: db, uploadsDir, jwtSecret: 'e2e-secret-e2e-secret-e2e-secret-1234567',
  bcryptCost: 4, loginLimit: 1000, rpcLimit: 5000, testHooks: true,
}).then(() => console.log('e2e servers up'));
