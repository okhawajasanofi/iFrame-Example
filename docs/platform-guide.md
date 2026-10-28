# Reference: adding "embed a website in an iframe" to your platform

**Audience:** a developer or a coding agent (LLM) who owns a web platform and wants to let users or admins embed other websites inside it. **Scope:** embedding websites by URL only. This guide uses the Link mode of the sample app in this repository as the reference implementation. It ignores the app's other features (login sharing, child-frame SDK, injected apps), which are about giving embedded apps a session. A plain website gets no session.

If you are an LLM reading this: use sections 2 to 6 to understand the design, section 7 to implement it in your own stack, and section 9 for the checklist. File paths are relative to the repository root.

## 1. What the feature does

1. An admin registers a website: a name, a URL, and which tenants (customer accounts) may see it.
2. Registered sites appear in a launcher (sidebar) with a "Link" badge and "no session".
3. Clicking one opens it in a tab inside the platform, in an **iframe**, under a banner that says it is an external site that cannot see the user's session.
4. If the site refuses to be framed, the user gets a clear hint and an "Open in a new tab" link, instead of a blank box.

That is all. No tokens, no messaging, no SDK. The security comes from the iframe's `sandbox` attribute, the platform's Content-Security-Policy, and validating the URL on the server.

## 2. The one fact that shapes everything

**Whether a page may be framed is decided by the framed site's response headers (`X-Frame-Options`, `Content-Security-Policy: frame-ancestors`), not by the platform.** The embedding platform cannot override it. So:

- Some sites will never embed (banks, Google, GitHub, most login pages). Your UI must handle that gracefully.
- Site owners can often fix it on their side. Give them a page that explains how. This repo ships one: `docs/site-owners.md`, shown in the app as "For website owners".
- The embedder **cannot reliably detect** a blocked frame. Browsers fire `load` on the frame even when they show their "refused to connect" error page, and cross-origin scripts cannot read the frame to check. So do not rely on a "failed to load" signal. Always show an "Open in a new tab" link next to the frame, and add a timeout hint for frames that never finish loading.

## 3. Architecture of the reference app

```
Browser
 └─ Mainframe page (http://localhost:3000)
     ├─ Launcher (sidebar)          lists registered sites
     ├─ Tabs (max 3 open)           one pane per site
     └─ Pane
         ├─ Banner                  "Link", origin, "Session: none", warning text, Open in new tab
         └─ <iframe sandbox="allow-scripts allow-forms allow-popups" src="https://other.site">

Server (Express, same origin as the page)
 ├─ POST /admin/children            validate + store a site (admin only)
 ├─ GET  /children                  sites enabled for the caller's tenant
 └─ SQLite: child_frames + child_frame_tenants
```

| Concern | File | What it does |
|---|---|---|
| Frame creation | `src/web/iframeHost.ts`, function `embedLink` | Creates the sandboxed iframe, starts the 6 second timer |
| Tabs, banner, open/close | `src/web/workspace.ts`, `openChild`, `banner` | Max 3 open, banner text, "slow" hint, cleanup on close |
| Launcher | `src/web/views/shell.ts` | Lists sites, "Link" badge, "no session" chip |
| Admin form | `src/web/views/admin.ts`, `addDialog` | Name, mode = Link, URL, tenants |
| Validation + storage | `src/server/mainframe.ts`, `CreateChild`, `HttpUrl`, `POST /admin/children` | Accepts only `http:`/`https:` URLs, stores the row |
| Tenant visibility | `src/server/mainframe.ts`, `GET /children` | Only active rows enabled for the user's tenant |
| Platform CSP | `src/server/security.ts`, `mainframeHelmet` | `frame-src ... https:` so the browser lets the platform frame sites |
| Schema | `src/server/db.ts` | `child_frames`, `child_frame_tenants` |
| Tests | `tests/e2e/poc.spec.ts` ("T11 / P7") and `tests/api/api.test.ts` ("admin API") | Add a link, see it, banner shown, sandbox has no `allow-same-origin` |

## 4. Data model (the only two tables this feature needs)

```sql
child_frames(
  id TEXT PRIMARY KEY,              -- slug, e.g. 'company-site'
  name TEXT, description TEXT,
  mode TEXT,                        -- 'link' for websites
  url TEXT,                         -- the external URL
  scopes TEXT,                      -- unused for links ('[]')
  created_by TEXT, created_at TEXT,
  status TEXT                       -- 'active' | 'disabled' (soft delete)
);
child_frame_tenants(child_id TEXT, tenant_id TEXT, enabled INTEGER);  -- who may see it
```

If your platform is single-tenant, drop `child_frame_tenants` and keep one table `embedded_sites(id, name, url, status)`.

## 5. Request flow

1. **Register.** Admin submits `{ name, mode: "link", url, tenants: [...] }` to `POST /admin/children`. The server checks the caller is an admin, validates with zod (`url` must parse and its protocol must be `http:` or `https:`, which rejects `javascript:` and `data:` URLs), generates an id, inserts the rows. The reference implementation also requires that a link has a `url` and no `html`.
2. **List.** The launcher calls `GET /children`. The server returns only rows with `status = 'active'` and `enabled = 1` for the caller's tenant.
3. **Open.** A click calls `openChild(entry)` in `workspace.ts`. For `mode === 'link'` it calls `embedLink(entry, container, onSlow)` and shows the banner. No token is requested.
4. **Close.** `closeChild` removes the iframe and the timer.

## 6. Security design (and why each part is there)

- **`sandbox="allow-scripts allow-forms allow-popups"` and NOT `allow-same-origin`.** Without `allow-same-origin` the framed page gets an opaque origin: it cannot read your cookies or storage, cannot call your APIs as the user, and cannot reach into your DOM. `allow-scripts` and `allow-forms` let ordinary sites work; `allow-popups` lets links with `target="_blank"` open. Never combine `allow-scripts` with `allow-same-origin` for a site you do not control **and** that is served from your own origin. (The reference app only uses that combination for its own sample apps, which are on a different origin.)
- **Do not add `allow-top-navigation`.** It would let the framed site redirect your whole platform page (phishing risk).
- **Validate the URL on the server**, not only in the form: `http:`/`https:` only, length-limited. Consider an allow-list of domains if admins are not fully trusted.
- **Platform CSP `frame-src`.** If your platform sets a CSP, `frame-src` (or `default-src`) must allow the embedded origins, for example `frame-src https:`. Otherwise the browser blocks the iframe before it even asks the site. Reference value: `frame-src http://127.0.0.1:3001 https:`.
- **Do not send secrets to the frame.** No tokens in the URL, no `postMessage` to it, no session. The banner tells the user the site cannot see their session.
- **Only admins can register sites**, and a site is visible only to the tenants it is enabled for.
- **Your own pages should not be frameable.** The reference app sends `frame-ancestors 'none'` (see `mainframeHelmet`). Embedding other sites does not require allowing your site to be embedded.

## 7. Minimal implementation (framework-agnostic)

This is the whole client-side mechanism, distilled from `embedLink` in `src/web/iframeHost.ts` and `openChild` in `src/web/workspace.ts`.

```ts
export interface EmbedHandle { frame: HTMLIFrameElement; destroy(): void }

/** Embeds any website in a sandboxed iframe. No session, no messaging. */
export function embedWebsite(url: string, container: HTMLElement, onSlow: () => void): EmbedHandle {
  const u = new URL(url);                                   // throws on garbage
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('Only http(s) URLs can be embedded');

  const frame = document.createElement('iframe');
  frame.title = u.hostname;                                 // accessibility
  frame.setAttribute('sandbox', 'allow-scripts allow-forms allow-popups'); // NO allow-same-origin, NO allow-top-navigation
  frame.setAttribute('loading', 'lazy');
  frame.style.cssText = 'width:100%;height:100%;border:0';

  let loaded = false;
  frame.addEventListener('load', () => { loaded = true; });
  const timer = window.setTimeout(() => { if (!loaded) onSlow(); }, 6000);  // hint if it never finishes

  frame.src = u.href;
  container.replaceChildren(frame);
  return { frame, destroy: () => { clearTimeout(timer); frame.remove(); } };
}
```

Around it, render a banner and an always-visible escape hatch:

```ts
const banner = `External site (${new URL(url).origin}). It cannot see your session.
                Some sites refuse to be framed.`;
// <a href={url} target="_blank" rel="noopener noreferrer">Open in a new tab</a>
```

Server side (Express + zod shown; the idea is the same anywhere):

```ts
const HttpUrl = z.string().max(2000).refine((u) => {
  try { return ['http:', 'https:'].includes(new URL(u).protocol); } catch { return false; }
}, 'must be an http(s) URL');

app.post('/admin/sites', requireAdmin, express.json({ limit: '100kb' }), (req, res) => {
  const { name, url, tenants } = z.object({ name: z.string().min(1).max(80), url: HttpUrl, tenants: z.array(z.string()).optional() }).parse(req.body);
  // insert into the table, enable for the listed tenants, return 201
});
```

Platform CSP (Express + helmet shown):

```ts
helmet({ contentSecurityPolicy: { useDefaults: false, directives: {
  'default-src': ["'self'"],
  'frame-src': ['https:'],            // let the page frame external sites
  'frame-ancestors': ["'none'"],      // but do not let anyone frame the platform itself
}}})
```

In React or Vue, wrap `embedWebsite` in an effect keyed on the URL and call `destroy()` on cleanup.

## 8. Handling sites that refuse to be framed

What the reference app does, and what it cannot do:

- It always shows a banner, and the link-mode banner includes an **Open in a new tab** link.
- It starts a 6 second timer and, if the frame has not fired `load`, shows: "This site may be blocking embedding (X-Frame-Options or CSP). Open in a new tab."
- It **cannot** tell that a site actively blocked framing, because browsers fire `load` on the error page too. That is why the always-visible "Open in a new tab" link matters.
- Optional improvement for your platform: when an admin saves a URL, have the **server** fetch it with `HEAD`/`GET` and inspect `X-Frame-Options` and `Content-Security-Policy: frame-ancestors`, then warn the admin "this site will probably not embed". Do this only with SSRF protection (block private and loopback IP ranges, limit redirects, short timeout), because the server would be fetching admin-supplied URLs. The reference app does not implement this.
- Point site owners at `docs/site-owners.md` (the "For website owners" page).

Other things that break inside an iframe even when framing is allowed: third-party cookies blocked (logins fail), storage partitioning, frame-busting scripts, and COEP/COOP headers. All of these are listed in the site-owners guide.

## 9. Implementation checklist

- [ ] Table(s) for sites (and tenant enablement if multi-tenant).
- [ ] Admin-only create/update/disable endpoints, with server-side URL validation (`http:`/`https:` only).
- [ ] List endpoint that returns only what the caller may see.
- [ ] Launcher entry with a badge saying it is an external site.
- [ ] Iframe with `sandbox="allow-scripts allow-forms allow-popups"` (no `allow-same-origin`, no `allow-top-navigation`).
- [ ] Banner: origin of the site, "no session", and "Open in a new tab".
- [ ] Timeout hint for frames that never load.
- [ ] Platform CSP `frame-src` allows the embedded origins; your own pages send `frame-ancestors 'none'`.
- [ ] Limit the number of open frames (the reference allows 3) and clean up timers and frames on close.
- [ ] A help page for site owners (`docs/site-owners.md`).
- [ ] Tests: add a link, it appears for the right tenant only, the banner shows, and the iframe's `sandbox` attribute does not contain `allow-same-origin`.

## 10. Run the reference app and see it

```bash
npm install
npm run dev          # http://localhost:3000
```

Sign in as `alice@acme.test` (password `Passw0rd!`). The seeded "Website link" shows a plain site (example.com) in an iframe. To add your own: **Admin: child frames, Add child frame, Mode: Link, paste a URL, Save**. Then open it from the sidebar.

## 11. Prompt you can give an LLM together with this document

> You are working on my web platform (stack: ___). Read the attached reference guide. Implement "embed a website in an iframe" the same way: a table for embedded sites, admin-only endpoints with server-side `http(s)` URL validation, a launcher entry, and a sandboxed iframe (`allow-scripts allow-forms allow-popups`, never `allow-same-origin` or `allow-top-navigation`) with a banner, an "Open in a new tab" link and a 6 second timeout hint. Update our Content-Security-Policy `frame-src` accordingly. Add tests. Do not build any session sharing or `postMessage` features: embedded websites get no session.

## 12. Limits of this approach

- Only sites that allow framing can be embedded. You cannot work around a site's own `X-Frame-Options` or `frame-ancestors` (and should not try: proxying a site to strip those headers breaks its security model and often its terms of use).
- Embedded sites get no login from your platform. If you need that, the embedded app must be your own or a partner's, and you need a token-passing design. The rest of this repository demonstrates one (`README.md`), but it is outside the scope of this guide.
- The reference app is a proof of concept and has not been penetration-tested.
