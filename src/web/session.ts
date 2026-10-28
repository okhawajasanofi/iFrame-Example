/* THE SESSION. This module is the only place that ever holds a token.
 *
 * - Tokens live in module-level variables below: never localStorage, never a script-readable cookie, never a URL, never a log.
 * - The bundle is an IIFE, so nothing here is reachable by name from a child frame (`typeof session` is "undefined").
 * - `nativeFetch` is captured at boot, before any child code runs. A child frame that replaces window.fetch therefore
 *   cannot see the Authorization header of platform calls (same trick as the reference a_mainframe.js).
 * - Other modules get identity, results and decoded (not raw) claims. They never get a token.
 */
import { emit } from './events';

const nativeFetch = window.fetch.bind(window);

export interface User { id: string; email: string; role: 'admin' | 'user' | 'viewer'; tenant: { id: string; name: string } }
export class RpcError extends Error {
  constructor(public code: string, message: string, public status = 0) { super(message); }
}

interface ChildEntry { token: string; claims: Record<string, any>; refreshAt: number; timer: number | undefined; scopes: string[] }

let accessToken: string | null = null;
let me: User | null = null;
const children = new Map<string, ChildEntry>();
let refreshing: Promise<boolean> | null = null;

const decode = (jwt: string): Record<string, any> => JSON.parse(atob(jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));

async function http(method: string, path: string, body?: unknown, bearer?: string | null): Promise<{ status: number; body: any }> {
  const r = await nativeFetch(path, {
    method,
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(bearer ? { Authorization: 'Bearer ' + bearer } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

function setUser(r: { accessToken: string; user: User }) {
  accessToken = r.accessToken;
  me = r.user;
}

export const currentUser = () => me;

export async function login(email: string, password: string): Promise<User> {
  const r = await http('POST', '/auth/login', { email, password });
  if (r.status !== 200) throw new RpcError(r.body?.error?.code ?? 'login_failed', r.body?.error?.message ?? 'Sign-in failed', r.status);
  setUser(r.body);
  return me!;
}

/** Uses the HttpOnly refresh cookie (the browser attaches it; script cannot read it). Concurrent callers share one request. */
export function refreshAccess(): Promise<boolean> {
  refreshing ??= http('POST', '/auth/refresh')
    .then((r) => { if (r.status === 200) { setUser(r.body); return true; } return false; })
    .catch(() => false)
    .finally(() => { refreshing = null; });
  return refreshing;
}

/** On page load: bring the session back from the refresh cookie, if there is one. */
export const restore = () => refreshAccess().then((ok) => (ok ? me : null));

function wipe() {
  accessToken = null;
  me = null;
  for (const c of children.values()) clearTimeout(c.timer);
  children.clear();
}

export async function logout() {
  await http('POST', '/auth/logout').catch(() => {});
  wipe();
}

/** Both the access token and the refresh cookie are no good: tell the UI to show "Session expired, sign in again". */
function expire(): never {
  wipe();
  emit('session-expired');
  throw new RpcError('session_expired', 'Session expired, sign in again', 401);
}

/** Authenticated call to the mainframe's own endpoints (/children, /audit, /admin/*). Refreshes once on 401. */
export async function authed(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  let r = await http(method, path, body, accessToken);
  if (r.status === 401) {
    if (!(await refreshAccess())) expire();
    r = await http(method, path, body, accessToken);
  }
  return r;
}

// ---- child tokens ----
async function fetchChildToken(childId: string): Promise<ChildEntry> {
  const r = await authed('POST', '/auth/child-token', { childId });
  if (r.status !== 200) throw new RpcError(r.body?.error?.code ?? 'child_token_failed', r.body?.error?.message ?? 'Could not open this child frame', r.status);
  const old = children.get(childId);
  if (old) clearTimeout(old.timer);
  const claims = decode(r.body.childToken);
  const lifeMs = r.body.expiresIn * 1000;
  const entry: ChildEntry = { token: r.body.childToken, claims, refreshAt: Date.now() + lifeMs * 0.8, timer: undefined, scopes: r.body.scopes };
  // Refresh at 80% of the token's life, in the background.
  entry.timer = window.setTimeout(() => { fetchChildToken(childId).catch(() => {}); }, lifeMs * 0.8);
  children.set(childId, entry);
  return entry;
}

async function childToken(childId: string, force = false): Promise<ChildEntry> {
  const c = children.get(childId);
  return !force && c && Date.now() < c.refreshAt ? c : fetchChildToken(childId);
}

/** Gets (and caches) a child token so a frame can open. Returns only the effective scopes. */
export async function prepareChild(childId: string): Promise<string[]> {
  return (await childToken(childId)).scopes;
}

export function dropChild(childId: string) {
  const c = children.get(childId);
  if (c) clearTimeout(c.timer);
  children.delete(childId);
}

/** Decoded claims of the child token currently held for a frame. The raw token is never returned. */
export function inspectChild(childId: string): { claims: Record<string, any>; expiresAtMs: number } | null {
  const c = children.get(childId);
  return c ? { claims: { ...c.claims }, expiresAtMs: c.claims.exp * 1000 } : null;
}

/** One platform call on behalf of a child frame. 401: refresh once, retry once, then "Session expired". */
export async function rpc(childId: string, method: string, params: object = {}): Promise<any> {
  let entry = await childToken(childId);
  let r = await send(entry.token, method, params);
  if (r.status === 401) {
    entry = await childToken(childId, true); // throws "Session expired" if even the refresh cookie is dead
    r = await send(entry.token, method, params);
    if (r.status === 401) expire();
  }
  emit('audit-dirty');
  if (r.body?.error) throw new RpcError(r.body.error.code ?? 'error', r.body.error.message ?? 'error', r.status);
  return r.body.result;
}

const send = (token: string, method: string, params: object) => http('POST', '/api/rpc', { method, params }, token);

// ---- evidence helpers for the Proof Panel (they run inside the closure, so they can touch tokens, but only return verdicts) ----

/** Sends a child token to /api/rpc without the retry logic, so the raw status and code can be shown. */
export async function probeRpc(childId: string, method: string, params: object = {}) {
  const entry = await childToken(childId);
  const r = await send(entry.token, method, params);
  emit('audit-dirty');
  return r;
}

/** The server must refuse a user access token on /api/rpc ("not_a_child_token"). */
export async function probeUserTokenOnRpc() {
  const r = await http('POST', '/api/rpc', { method: 'whoami', params: {} }, accessToken);
  emit('audit-dirty');
  return { status: r.status, code: r.body?.error?.code as string | undefined };
}

/** Looks for any held token in storage, cookies, the URL and the page's DOM. */
export function leakCheck(): { leaked: boolean; where: string[] } {
  const tokens = [accessToken, ...[...children.values()].map((c) => c.token)].filter(Boolean) as string[];
  const where: string[] = [];
  const hay: [string, string][] = [
    ['localStorage', JSON.stringify(Object.entries(localStorage))],
    ['sessionStorage', JSON.stringify(Object.entries(sessionStorage))],
    ['document.cookie', document.cookie],
    ['URL', location.href],
    ['DOM', document.documentElement.outerHTML],
  ];
  for (const [name, text] of hay) if (tokens.some((t) => text.includes(t)) || /eyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/.test(text)) where.push(name);
  return { leaked: where.length > 0, where };
}
