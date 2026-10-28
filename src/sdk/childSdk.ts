/* CHILD SDK, served from the child origin as /sdk.js. One file, three modes, the same surface for child-frame authors:
 *
 *   injected   PlatformSDK.fromHost(api)      the mainframe passed `api` to initialize(); wrap it
 *   sandboxed  PlatformSDK.connect(childId)   postMessage to the mainframe (reference: b_child_sdk.js)
 *   standalone PlatformSDK.connect(childId)   opened on its own (no parent, or no host answer in 3 s): shows a sign-in form
 *
 * Surface (promise style; the callback style from the contract also works when you pass ok/fail):
 *   await api.getSession()            -> { user, email, tenant, tenantId, role, scopes }   identity only, never a token
 *   await api.call(method, params)    -> result
 *   await api.multiCall([[m, p], ...]) -> array of { result } | { error }   always an array
 */
declare const __HOST_ORIGIN__: string; // build-time constant: the mainframe origin

export interface Identity { user: string; email?: string; tenant: string; tenantId?: string; role?: string; scopes?: string[] }
export interface PlatformError extends Error { code?: string }
export interface PlatformApi {
  mode: 'injected' | 'sandboxed' | 'standalone';
  getSession(): Promise<Identity>;
  call(method: string, params?: object, ok?: (r: any) => void, fail?: (e: PlatformError) => void): Promise<any>;
  multiCall(calls: [string, object?][], ok?: (r: any[]) => void, fail?: (e: PlatformError) => void): Promise<any[]>;
  /** Sandboxed only: run `fn` when the mainframe sends { type: 'command', name }. Used by the Proof Panel's attack demo. */
  onCommand(name: string, fn: () => void): void;
  /** Sandboxed only: send a result object to the mainframe. */
  report(payload: unknown): void;
}

const HOST = __HOST_ORIGIN__;

const mkError = (e: { code?: string; message?: string } | string | undefined): PlatformError => {
  const err: PlatformError = new Error(typeof e === 'string' ? e : e?.message || 'error');
  if (typeof e === 'object' && e?.code) err.code = e.code;
  return err;
};

/** Adds the callback style on top of any promise-returning transport. */
function build(mode: PlatformApi['mode'], t: { session: () => Promise<Identity>; call: (m: string, p: object) => Promise<any>; onCommand?: PlatformApi['onCommand']; report?: PlatformApi['report'] }): PlatformApi {
  const wrap = <T>(p: Promise<T>, ok?: (r: T) => void, fail?: (e: PlatformError) => void): Promise<T> => {
    if (typeof ok === 'function') p.then(ok, (e) => (typeof fail === 'function' ? fail(e) : undefined));
    return p;
  };
  const api: PlatformApi = {
    mode,
    getSession: () => t.session(),
    call: (method, params, ok, fail) => wrap(t.call(method, params ?? {}), ok, fail),
    multiCall: (calls, ok, fail) => wrap(t.call('multi', { calls: calls.map(([method, params]) => ({ method, params: params ?? {} })) }) as Promise<any[]>, ok, fail),
    onCommand: t.onCommand ?? (() => {}),
    report: t.report ?? (() => {}),
  };
  return Object.freeze(api);
}

// ---------------------------------------------------------------- injected
function fromHost(host: { getSession: (cb: (s: Identity) => void) => void; call: (m: string, p: object, ok: (r: any) => void, fail: (e: any) => void) => void }): PlatformApi {
  return build('injected', {
    session: () => new Promise((resolve) => host.getSession(resolve)),
    call: (m, p) => new Promise((resolve, reject) => host.call(m, p, resolve, (e) => reject(mkError(e)))),
  });
}

// ---------------------------------------------------------------- sandboxed
function connectSandboxed(childId: string): Promise<PlatformApi> {
  return new Promise((resolve) => {
    const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
    const commands = new Map<string, () => void>();
    let nextId = 1;
    let identity: Identity | null = null;
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) { settled = true; window.removeEventListener('message', onMessage); resolve(standalone(childId)); }
    }, 3000); // no session message within 3 seconds: assume we are standalone

    function onMessage(e: MessageEvent) {
      // Only the real parent, only the mainframe origin. Everything else is ignored.
      if (e.origin !== HOST || e.source !== window.parent) return;
      const m = e.data || {};
      if (m.type === 'session' && !identity) {
        identity = { user: m.user, email: m.email, tenant: m.tenant, tenantId: m.tenantId, role: m.role, scopes: m.scopes };
        if (!settled) { settled = true; clearTimeout(timer); resolve(api); }
      } else if (m.type === 'rpc-result' || m.type === 'rpc-error') {
        const p = pending.get(m.id);
        if (!p) return;
        pending.delete(m.id);
        m.type === 'rpc-result' ? p.resolve(m.result) : p.reject(mkError(m.error));
      } else if (m.type === 'command' && typeof m.name === 'string') {
        commands.get(m.name)?.();
      }
    }
    window.addEventListener('message', onMessage);

    const api = build('sandboxed', {
      session: () => Promise.resolve(identity as Identity),
      call: (method, params) => new Promise((res, rej) => {
        const id = nextId++;
        pending.set(id, { resolve: res, reject: rej });
        window.parent.postMessage({ type: 'rpc', id, method, params }, HOST); // never '*'
      }),
      onCommand: (name, fn) => { commands.set(name, fn); },
      report: (payload) => window.parent.postMessage({ type: 'report', payload }, HOST),
    });
    window.parent.postMessage({ type: 'hello' }, HOST);
  });
}

// ---------------------------------------------------------------- standalone (P8)
const CSS = `
  :host { all: initial; font: 14px system-ui, sans-serif; }
  .backdrop { position: fixed; inset: 0; background: rgba(20,24,33,.55); display: grid; place-items: center; z-index: 2147483000; }
  form { background: #fff; color: #1b2430; padding: 24px; border-radius: 10px; width: 300px; box-shadow: 0 10px 40px rgba(0,0,0,.35); display: grid; gap: 10px; }
  h2 { margin: 0 0 4px; font-size: 16px; }
  p { margin: 0; color: #5b6676; font-size: 12px; }
  input, button { font: inherit; padding: 8px 10px; border-radius: 6px; border: 1px solid #b9c2cf; }
  button { background: #2f5fd0; color: #fff; border-color: #2f5fd0; cursor: pointer; }
  .err { color: #b3261e; min-height: 1.2em; font-size: 12px; }
  .badge { position: fixed; top: 8px; right: 8px; background: #fff7d6; color: #5a4300; border: 1px solid #e6c84c; padding: 3px 9px; border-radius: 99px; font-size: 12px; z-index: 2147483000; }
`;

function standalone(childId: string): Promise<PlatformApi> {
  let accessToken = '';
  let childToken = '';
  let childExp = 0;
  let identity: Identity | null = null;
  const host = document.createElement('div');
  host.setAttribute('data-platform-standalone', '');
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `<style>${CSS}</style>`;
  document.body.appendChild(host);

  const post = async (path: string, body: object, bearer?: string) => {
    const r = await fetch(HOST + path, {
      method: 'POST', // credentials omitted on purpose: this page must never touch the mainframe cookie
      credentials: 'omit',
      headers: { 'Content-Type': 'application/json', ...(bearer ? { Authorization: 'Bearer ' + bearer } : {}) },
      body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({}));
    return { status: r.status, body: j };
  };

  async function fetchChildToken(): Promise<boolean> {
    const r = await post('/auth/child-token', { childId, standalone: true }, accessToken);
    if (r.status !== 200) return false;
    childToken = r.body.childToken;
    childExp = Date.now() + r.body.expiresIn * 1000 * 0.8; // refresh at 80% of its life
    return true;
  }

  function signIn(): Promise<void> {
    return new Promise((resolve) => {
      const wrap = document.createElement('div');
      wrap.className = 'backdrop';
      wrap.innerHTML = `<form><h2>Sign in</h2><p>Standalone mode: this page is not inside the mainframe, so it asks for its own login.</p>
        <input name="email" type="email" placeholder="email" autocomplete="username" required>
        <input name="password" type="password" placeholder="password" autocomplete="current-password" required>
        <div class="err" role="alert"></div><button type="submit">Sign in</button></form>`;
      shadow.appendChild(wrap);
      const form = wrap.querySelector('form')!;
      const err = wrap.querySelector('.err') as HTMLElement;
      form.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        err.textContent = '';
        const fd = new FormData(form);
        try {
          const login = await post('/auth/login', { email: fd.get('email'), password: fd.get('password') });
          if (login.status !== 200) { err.textContent = login.body?.error?.message || 'Sign-in failed'; return; }
          accessToken = login.body.accessToken;
          if (!(await fetchChildToken())) { err.textContent = 'Your tenant cannot open this child frame.'; return; }
          const u = login.body.user;
          const scopes = (await post('/api/rpc', { method: 'whoami', params: {} }, childToken)).body?.result?.scopes ?? [];
          identity = { user: u.email.split('@')[0], email: u.email, tenant: u.tenant.name, tenantId: u.tenant.id, role: u.role, scopes };
          wrap.remove();
          const badge = document.createElement('div');
          badge.className = 'badge';
          badge.textContent = 'Standalone: signed in directly';
          shadow.appendChild(badge);
          resolve();
        } catch { err.textContent = 'Could not reach the mainframe.'; }
      });
    });
  }

  const signedIn = signIn();

  async function rpc(method: string, params: object): Promise<any> {
    await signedIn;
    if (Date.now() >= childExp) await fetchChildToken();
    let r = await post('/api/rpc', { method, params }, childToken);
    if (r.status === 401 && (await fetchChildToken())) r = await post('/api/rpc', { method, params }, childToken); // refresh once, retry once
    if (r.status === 401) throw mkError({ code: 'session_expired', message: 'Session expired, sign in again' });
    if (r.body?.error) throw mkError(r.body.error);
    return r.body.result;
  }

  const api = build('standalone', { session: () => signedIn.then(() => identity as Identity), call: rpc });
  return Promise.resolve(api);
}

// ---------------------------------------------------------------- entry points
async function connect(childId: string): Promise<PlatformApi> {
  const api = window.parent === window ? await standalone(childId) : await connectSandboxed(childId);
  (window as any).platformApi = api; // this window is the child's own, so a global is safe here
  return api;
}

(window as any).PlatformSDK = Object.freeze({ fromHost, connect, standalone, hostOrigin: HOST });
