/* PATTERN B host (see mainframe-poc-reference/b_host.js) plus Mode C (links).
 * Changes from the reference: the token stays in session.ts and calls go through rpc(); scope pre-check against the
 * user's EFFECTIVE scopes, with the refusal written to the audit log (via = mainframe); structured errors; `session` carries
 * more identity; listener removal on close; 'report'/'command' messages for the Proof Panel demo. */
import { rpc, authed } from './session';
import { identityOf, type ChildEntry } from './api';
import { METHOD_SCOPE } from '../shared/scopes';
import { emit } from './events';

export interface FrameHandle { frame: HTMLIFrameElement; send(msg: object): void; destroy(): void }

interface Opts { onReport?: (payload: unknown) => void }

export function embedSandboxed(entry: ChildEntry, container: HTMLElement, opts: Opts = {}): FrameHandle {
  const frame = document.createElement('iframe');
  frame.src = entry.url;
  frame.title = entry.name;
  // allow-same-origin is correct ONLY because the child is served from a different origin than this page.
  frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms');
  container.replaceChildren(frame);
  const childOrigin = new URL(entry.url, location.href).origin;

  const refuse = (method: string) => {
    // Written to the audit log by the mainframe itself, so the Proof Panel shows the refusal.
    authed('POST', '/audit/mainframe', { childId: entry.id, method, reason: METHOD_SCOPE[method] === undefined ? 'unknown_method' : 'scope_denied' })
      .then(() => emit('audit-dirty')).catch(() => {});
  };

  /** Returns a scope error if this method (or any call inside `multi`) is outside the child's effective scopes. */
  function precheck(method: string, params: any): { code: string; message: string } | null {
    const calls: { method: string }[] = method === 'multi' && Array.isArray(params?.calls) ? params.calls : [{ method }];
    for (const c of calls) {
      const need = METHOD_SCOPE[c.method];
      if (need && !entry.effectiveScopes.includes(need)) {
        refuse(c.method);
        return { code: 'scope_denied', message: `Refused by the mainframe: ${entry.name} may not call ${c.method} (needs ${need})` };
      }
    }
    return null;
  }

  async function onMessage(e: MessageEvent) {
    // Only OUR iframe window, only ITS origin. Everything else is ignored, without a reply.
    if (e.source !== frame.contentWindow || e.origin !== childOrigin) return;
    const m = e.data || {};
    const reply = (msg: object) => (e.source as Window).postMessage(msg, childOrigin); // never '*'
    if (m.type === 'hello') return reply({ type: 'session', ...identityOf(entry) });
    if (m.type === 'report') return opts.onReport?.(m.payload);
    if (m.type !== 'rpc' || typeof m.id !== 'number' || typeof m.method !== 'string') return;
    const refused = precheck(m.method, m.params);
    if (refused) return reply({ type: 'rpc-error', id: m.id, error: refused });
    try {
      reply({ type: 'rpc-result', id: m.id, result: await rpc(entry.id, m.method, m.params ?? {}) });
    } catch (err) {
      reply({ type: 'rpc-error', id: m.id, error: { code: (err as { code?: string }).code ?? 'error', message: (err as Error).message } });
    }
  }
  window.addEventListener('message', onMessage);

  return {
    frame,
    send: (msg) => frame.contentWindow?.postMessage(msg, childOrigin),
    destroy: () => { window.removeEventListener('message', onMessage); frame.remove(); },
  };
}

/** Mode C: any external URL. No SDK, no session, no message is ever honoured, and no allow-same-origin. */
export function embedLink(entry: ChildEntry, container: HTMLElement, onSlow: () => void): FrameHandle {
  const frame = document.createElement('iframe');
  frame.title = entry.name;
  frame.setAttribute('sandbox', 'allow-scripts allow-forms allow-popups');
  let loaded = false;
  frame.addEventListener('load', () => { loaded = true; });
  const timer = window.setTimeout(() => { if (!loaded) onSlow(); }, 6000);
  frame.src = entry.url;
  container.replaceChildren(frame);
  return { frame, send: () => {}, destroy: () => { clearTimeout(timer); frame.remove(); } };
}
