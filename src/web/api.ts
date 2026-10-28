/* PATTERN A api factory (see mainframe-poc-reference/a_mainframe.js).
 * Changes from the reference: calls go through session.rpc() (which owns the token and refreshes it), errors carry
 * { code, message }, getSession returns richer identity, and each frame's api is bound to ITS OWN child id. */
import { rpc, currentUser } from './session';

export interface ChildEntry {
  id: string;
  name: string;
  description: string;
  mode: 'injected' | 'sandboxed' | 'link';
  url: string;
  scopes: string[];
  effectiveScopes: string[];
  version: string;
  category?: string;
  publisher?: string;
  icon?: string;
}

export function identityOf(entry: ChildEntry) {
  const u = currentUser()!;
  return { user: u.email.split('@')[0], email: u.email, tenant: u.tenant.name, tenantId: u.tenant.id, role: u.role, scopes: entry.effectiveScopes };
}

const toErr = (e: unknown) => ({ code: (e as { code?: string })?.code ?? 'error', message: (e as Error)?.message ?? String(e) });

/** A fresh, frozen api per child frame. It closes over the frame's id, never over a token. */
export function createApi(entry: ChildEntry) {
  function call(method: string, params: object | undefined, ok: (r: any) => void, fail: (e: { code: string; message: string }) => void) {
    // Pattern A has no pre-check here on purpose: the SERVER refuses out-of-scope calls (scope_denied), and the Rogue (injected) demo shows it.
    rpc(entry.id, method, params ?? {}).then(ok, (e) => fail(toErr(e)));
  }
  return Object.freeze({
    // identity only, never a token
    getSession: (cb: (s: ReturnType<typeof identityOf>) => void) => cb(identityOf(entry)),
    call,
    multiCall: (calls: [string, object?][], ok: (r: any[]) => void, fail: (e: { code: string; message: string }) => void) =>
      call('multi', { calls: calls.map(([method, params]) => ({ method, params: params ?? {} })) }, ok, fail),
  });
}
