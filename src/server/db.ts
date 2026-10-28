import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import type { Config } from './config';

export type DB = Database.Database;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tenants (id TEXT PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id),
  email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('admin','user','viewer')));
CREATE TABLE IF NOT EXISTS child_frames (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  mode TEXT NOT NULL CHECK(mode IN ('injected','sandboxed','link')),
  url TEXT NOT NULL, scopes TEXT NOT NULL DEFAULT '[]',
  created_by TEXT, created_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active','disabled')) DEFAULT 'active');
CREATE TABLE IF NOT EXISTS child_frame_tenants (
  child_id TEXT NOT NULL REFERENCES child_frames(id), tenant_id TEXT NOT NULL REFERENCES tenants(id),
  enabled INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (child_id, tenant_id));
CREATE TABLE IF NOT EXISTS vehicles (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT NOT NULL, plate TEXT NOT NULL,
  status TEXT NOT NULL, odometer_km INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, author_id TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, token_hash TEXT NOT NULL, expires_at TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, tenant_id TEXT, user_id TEXT, child_id TEXT,
  method TEXT NOT NULL, result TEXT NOT NULL, reason TEXT, via TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS audit_tenant ON audit_log(tenant_id, id);

-- common platform features
CREATE TABLE IF NOT EXISTS groups (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, UNIQUE (tenant_id, name));
CREATE TABLE IF NOT EXISTS group_members (
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (group_id, user_id));
-- access management: when an installed app has rows here, only members of those groups (and admins) may open it
CREATE TABLE IF NOT EXISTS app_access (
  tenant_id TEXT NOT NULL, child_id TEXT NOT NULL REFERENCES child_frames(id),
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE, PRIMARY KEY (tenant_id, child_id, group_id));
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

function ensureColumn(db: DB, table: string, column: string, ddl: string) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}

export function openDb(file: string): DB {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  if (file !== ':memory:') db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  // additive migrations, so an existing database keeps its data
  ensureColumn(db, 'users', 'status', "TEXT NOT NULL DEFAULT 'active'");
  ensureColumn(db, 'child_frames', 'category', "TEXT NOT NULL DEFAULT 'General'");
  ensureColumn(db, 'child_frames', 'publisher', "TEXT NOT NULL DEFAULT 'Custom'");
  ensureColumn(db, 'child_frames', 'icon', "TEXT NOT NULL DEFAULT '🧩'");
  return db;
}

export const DEV_PASSWORD = 'Passw0rd!';

const VEHICLES: Record<string, [string, string, string, number][]> = {
  acme: [
    ['Acme Box Truck 01', 'ACM-101', 'active', 48210],
    ['Acme Box Truck 02', 'ACM-102', 'active', 61877],
    ['Acme Cargo Van 03', 'ACM-103', 'maintenance', 90412],
    ['Acme Pickup 04', 'ACM-104', 'active', 23450],
    ['Acme Forklift Hauler 05', 'ACM-105', 'idle', 15200],
    ['Acme Delivery Bike 06', 'ACM-106', 'active', 3120],
  ],
  globex: [
    ['Globex Tanker Zeta', 'GLX-901', 'active', 120540],
    ['Globex Tanker Eta', 'GLX-902', 'idle', 98760],
    ['Globex Crane Rig Theta', 'GLX-903', 'active', 40210],
    ['Globex Survey Jeep Iota', 'GLX-904', 'maintenance', 77300],
    ['Globex Shuttle Kappa', 'GLX-905', 'active', 55120],
    ['Globex Reefer Lambda', 'GLX-906', 'active', 8800],
  ],
};
const NOTES: Record<string, [string, string][]> = {
  acme: [
    ['alice', 'Acme: Q3 route review is on Friday.'],
    ['bob', 'Acme: Truck 03 needs a brake inspection.'],
    ['alice', 'Acme: Remember to rotate the depot keys.'],
    ['dave', 'Acme: Fuel card audit finished, no issues.'],
  ],
  globex: [
    ['carol', 'Globex: Tanker Zeta passed its pressure test.'],
    ['carol', 'Globex: New dispatcher starts Monday.'],
    ['carol', 'Globex: Crane rig certification renews in March.'],
    ['carol', 'Globex: Reefer Lambda trial extended.'],
  ],
};

export interface ChildSeed {
  id: string;
  name: string;
  description: string;
  mode: 'injected' | 'sandboxed' | 'link';
  url: string;
  scopes: string[];
  tenants: string[];
  category: string;
  publisher: string;
  icon: string;
}

export function sampleChildren(cfg: Config): ChildSeed[] {
  const u = (id: string) => `${cfg.childOrigin}/c/${id}.html`;
  return [
    { id: 'notes', name: 'Team Notes', description: 'Shared notes for the tenant (injected, Shadow DOM)', mode: 'injected', url: u('notes'), scopes: ['notes.read', 'notes.write'], tenants: ['acme', 'globex'], category: 'Productivity', publisher: 'Mainframe Labs', icon: '📝' },
    { id: 'fleet', name: 'Fleet Viewer', description: 'Table of the tenant vehicles', mode: 'sandboxed', url: u('fleet'), scopes: ['vehicles.read'], tenants: ['acme', 'globex'], category: 'Operations', publisher: 'Mainframe Labs', icon: '🚚' },
    { id: 'notes-ro', name: 'Notes (read-only)', description: 'Can read notes; its Add note button is refused', mode: 'sandboxed', url: u('notes-ro'), scopes: ['notes.read'], tenants: ['acme'], category: 'Productivity', publisher: 'Mainframe Labs', icon: '📖' },
    { id: 'rogue-sbx', name: 'Rogue (sandboxed)', description: 'Tries attacks from inside the sandbox; all should fail', mode: 'sandboxed', url: u('rogue-sbx'), scopes: ['vehicles.read'], tenants: ['acme', 'globex'], category: 'Security demo', publisher: 'Security Lab', icon: '🕵️' },
    { id: 'rogue-inj', name: 'Rogue (injected)', description: 'UNSAFE BY DESIGN. Shows what pattern A cannot stop', mode: 'injected', url: u('rogue-inj'), scopes: ['vehicles.read'], tenants: ['acme'], category: 'Security demo', publisher: 'Security Lab', icon: '☠️' },
    { id: 'website', name: 'Website link', description: 'A plain external site: no SDK, no session', mode: 'link', url: 'https://example.com/', scopes: [], tenants: ['acme'], category: 'Reference', publisher: 'example.com', icon: '🌐' },
  ];
}

/** More catalog entries for the App Store: plain websites, not installed for anyone until a tenant admin installs them. */
const STORE_EXTRAS: Omit<ChildSeed, 'tenants' | 'scopes'>[] = [
  { id: 'wikipedia', name: 'Wikipedia', description: 'The free encyclopedia, embedded as a website', mode: 'link', url: 'https://www.wikipedia.org', category: 'Reference', publisher: 'Wikimedia Foundation', icon: '📚' },
  { id: 'python-docs', name: 'Python docs', description: 'Official Python documentation', mode: 'link', url: 'https://docs.python.org/3/', category: 'Developer tools', publisher: 'Python Software Foundation', icon: '🐍' },
  { id: 'openstreetmap', name: 'OpenStreetMap', description: 'An embeddable map', mode: 'link', url: 'https://www.openstreetmap.org/export/embed.html', category: 'Maps', publisher: 'OpenStreetMap contributors', icon: '🗺️' },
  { id: 'xkcd', name: 'xkcd', description: 'A webcomic, for the break room', mode: 'link', url: 'https://xkcd.com/', category: 'Fun', publisher: 'xkcd.com', icon: '🎨' },
];

function insertChild(db: DB, c: { id: string; name: string; description: string; mode: string; url: string; scopes: string[]; category: string; publisher: string; icon: string }, createdBy: string | null, status = 'active') {
  db.prepare('INSERT INTO child_frames (id, name, description, mode, url, scopes, created_by, created_at, status, category, publisher, icon) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(
    c.id, c.name, c.description, c.mode, c.url, JSON.stringify(c.scopes), createdBy, new Date().toISOString(), status, c.category, c.publisher, c.icon,
  );
}
export { insertChild };

/** Seeds tenants, users, data and the demo child frames. No-op if already seeded unless force. */
export function seedDb(db: DB, cfg: Config, force = false): boolean {
  const has = db.prepare('SELECT COUNT(*) c FROM tenants').get() as { c: number };
  if (has.c > 0 && !force) return false;
  const hash = bcrypt.hashSync(DEV_PASSWORD, cfg.bcryptCost);
  db.transaction(() => {
    if (force) for (const t of ['audit_log', 'refresh_tokens', 'app_access', 'group_members', 'groups', 'meta', 'notes', 'vehicles', 'child_frame_tenants', 'child_frames', 'users', 'tenants']) db.exec(`DELETE FROM ${t}`);
    const addTenant = db.prepare('INSERT INTO tenants VALUES (?,?)');
    addTenant.run('acme', 'Acme');
    addTenant.run('globex', 'Globex');
    const addUser = db.prepare('INSERT INTO users (id, tenant_id, email, password_hash, role) VALUES (?,?,?,?,?)');
    addUser.run('u-alice', 'acme', 'alice@acme.test', hash, 'admin');
    addUser.run('u-bob', 'acme', 'bob@acme.test', hash, 'user');
    addUser.run('u-dave', 'acme', 'dave@acme.test', hash, 'viewer');
    addUser.run('u-carol', 'globex', 'carol@globex.test', hash, 'admin');
    const addV = db.prepare('INSERT INTO vehicles VALUES (?,?,?,?,?,?)');
    const addN = db.prepare('INSERT INTO notes VALUES (?,?,?,?,?)');
    for (const [tenant, list] of Object.entries(VEHICLES)) list.forEach((v, i) => addV.run(`${tenant}-v${i + 1}`, tenant, ...v));
    for (const [tenant, list] of Object.entries(NOTES))
      list.forEach(([a, text], i) => addN.run(`${tenant}-n${i + 1}`, tenant, `u-${a}`, text, new Date(Date.now() - (list.length - i) * 3600_000).toISOString()));
    const addCT = db.prepare('INSERT INTO child_frame_tenants VALUES (?,?,?)');
    for (const c of sampleChildren(cfg)) {
      insertChild(db, c, 'u-alice');
      for (const t of ['acme', 'globex']) addCT.run(c.id, t, c.tenants.includes(t) ? 1 : 0);
    }
  })();
  return true;
}

/**
 * Idempotent upgrade, run at every start. It brings an older database (and a fresh seed) up to the platform features:
 * App Store metadata, extra catalog apps, demo groups and one access restriction. Runs its data part only once
 * (flag in `meta`), so anything an admin later deletes stays deleted.
 */
export function upgradeDb(db: DB, cfg: Config) {
  const tenants = (db.prepare('SELECT id FROM tenants').all() as { id: string }[]).map((t) => t.id);
  if (!tenants.length) return;
  if (db.prepare("SELECT 1 FROM meta WHERE key = 'platform_seed_v1'").get()) return;
  db.transaction(() => {
    for (const c of sampleChildren(cfg)) {
      db.prepare("UPDATE child_frames SET category = ?, publisher = ?, icon = ? WHERE id = ? AND category = 'General' AND publisher = 'Custom'").run(c.category, c.publisher, c.icon, c.id);
    }
    for (const c of STORE_EXTRAS) {
      if (db.prepare('SELECT 1 FROM child_frames WHERE id = ?').get(c.id)) continue;
      insertChild(db, { ...c, scopes: [] }, null);
      for (const t of tenants) db.prepare('INSERT OR IGNORE INTO child_frame_tenants VALUES (?,?,0)').run(c.id, t);
    }
    const now = new Date().toISOString();
    const addG = db.prepare('INSERT OR IGNORE INTO groups (id, tenant_id, name, description, created_at) VALUES (?,?,?,?,?)');
    const addM = db.prepare('INSERT OR IGNORE INTO group_members VALUES (?,?)');
    const userExists = (id: string) => !!db.prepare('SELECT 1 FROM users WHERE id = ?').get(id);
    if (tenants.includes('acme')) {
      addG.run('g-acme-ops', 'acme', 'Operations', 'Dispatch and fleet staff', now);
      addG.run('g-acme-auditors', 'acme', 'Auditors', 'Read-only reviewers', now);
      for (const [g, u] of [['g-acme-ops', 'u-alice'], ['g-acme-ops', 'u-bob'], ['g-acme-auditors', 'u-dave']]) if (userExists(u)) addM.run(g, u);
      // access management demo: Notes (read-only) is only for Auditors (admins can always open it)
      if (db.prepare("SELECT 1 FROM child_frame_tenants WHERE child_id = 'notes-ro' AND tenant_id = 'acme'").get()) db.prepare("INSERT OR IGNORE INTO app_access VALUES ('acme','notes-ro','g-acme-auditors')").run();
    }
    if (tenants.includes('globex')) {
      addG.run('g-globex-fleet', 'globex', 'Fleet team', 'Everyone who works with vehicles', now);
      if (userExists('u-carol')) addM.run('g-globex-fleet', 'u-carol');
    }
    db.prepare("INSERT INTO meta VALUES ('platform_seed_v1', ?)").run(now);
  })();
}
