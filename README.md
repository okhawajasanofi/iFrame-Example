# Mainframe + child frames: proof of concept

A main app (the **mainframe**) signs a user in once and hosts other apps (**child frames**) that reuse that login, with a **Proof Panel** that shows live that it works and that it is safe. It is a prototype of the pattern MyGeotab uses for add-ins. It was built from `MAINFRAME_POC_BUILD_SPEC.md`.

## Run it

```bash
npm install
npm run seed      # optional: `npm run dev` seeds an empty database by itself
npm run dev
```

| URL | What |
|---|---|
| http://localhost:3000 | **Mainframe**: UI, login, platform API, admin, Proof Panel |
| http://127.0.0.1:3001 | **Child origin**: child-frame HTML and `/sdk.js` |

Use `localhost` for the mainframe and `127.0.0.1` for the child origin, exactly as written. They are different origins **and different cookie jars**, which is what proves the mainframe cookie can never reach a child. (Cookies are not isolated by port.)

Other scripts: `npm run build` (type check and bundle), `npm start` (same as dev, without watching), `npm test` (unit and API tests), `npm run test:e2e` (Playwright; first run needs `npx playwright install chromium`). `npm run seed -- --reset` wipes and re-seeds.

### Seeded logins (development only; password for all: `Passw0rd!`)

| Tenant | Email | Role |
|---|---|---|
| Acme | `alice@acme.test` | admin |
| Acme | `bob@acme.test` | user |
| Acme | `dave@acme.test` | viewer |
| Globex | `carol@globex.test` | admin |

The login screen lists them too (hidden when `NODE_ENV=production`).

### Seeded child frames

| # | Name | Mode | Scopes | Enabled for |
|---|---|---|---|---|
| 1 | Team Notes | injected (Shadow DOM) | `notes.read`, `notes.write` | Acme, Globex |
| 2 | Fleet Viewer | sandboxed | `vehicles.read` | Acme, Globex |
| 3 | Notes (read-only) | sandboxed | `notes.read` | Acme |
| 4 | Rogue (sandboxed) | sandboxed | `vehicles.read` | Acme, Globex |
| 5 | Rogue (injected), **UNSAFE BY DESIGN** | injected | `vehicles.read` | Acme |
| 6 | Website link (example.com) | link | none | Acme |

Each tenant has 6 vehicles and 4 notes with clearly different names ("Acme Box Truck 01" vs "Globex Tanker Zeta"), so any leak between tenants is obvious on screen.

## Common features in the mainframe, unique features in the apps

The idea: the **mainframe owns what every business app needs**, so no child app has to rebuild it. The **child apps (iframes) only carry what is unique to them**.

| In the mainframe (common) | Where | Who |
|---|---|---|
| **App Store**: browse the catalog, install and uninstall apps for your organization | sidebar, Platform | everyone browses, admins install |
| **My apps**: the installed apps you are allowed to open, each as an iframe | sidebar, top | everyone |
| **Users**: add people, change role, disable, reset password | Administration | admin |
| **Groups**: sets of people | Administration | admin |
| **Roles**: what admin, user and viewer may do (a matrix of mainframe permissions and app scopes) | Administration | admin |
| **Access management**: restrict an installed app to certain groups | Administration | admin |
| **Register apps**: add a new app (upload HTML or a URL) to the catalog | Administration | admin |
| **Reports**: calls, denials, usage per app and per person, admin changes, CSV export | sidebar, Platform | admin and user |
| **Proof Panel, About, help pages** | sidebar | everyone |

How they fit together:

* **Install** (App Store) makes an app available to the whole organization. **Access management** can then narrow it to groups (admins can always open it). The launcher, the child token and **every API call** check both, so a change applies at once, even to people who already have the app open.
* A role change, a disabled account or a password reset also applies immediately: the server reads the user's *current* role and status on every request, and ends their sessions.
* Everything is scoped to the signed-in user's organization (tenant). An admin of one organization can never see or change another's users, groups or access, and reports never include other organizations.
* Every administrative change leaves an audit row (`user.create`, `group.members`, `access.update`, `app.install`, ...), shown in Reports and the Proof Panel.
* Seeded: Acme has groups *Operations* (Alice, Bob) and *Auditors* (Dave), and **Notes (read-only) is restricted to Auditors** (so Bob cannot open it, Dave and the admin can). Globex has a *Fleet team* group. The App Store also lists four apps that nobody has installed yet (Wikipedia, Python docs, OpenStreetMap, xkcd): sign in as an admin, install one, and it appears under My apps and opens as an iframe.
* Roles are built in (not editable). Custom roles would need roles stored in the database instead of the constant in `src/shared/scopes.ts`.

## Help pages for embedding websites

Two Markdown guides in `docs/`, also shown in the app under **Embedding websites** in the sidebar (each has Copy and Download buttons):

* `docs/site-owners.md`: what the owner of a website must change so it can be shown in an iframe (headers, proxies, cookies, verification). Send it to the owner of any site that will not embed.
* `docs/platform-guide.md`: a reference for a developer or an LLM who wants to add "embed a website" to their own platform, using this app's Link mode as the reference implementation (file map, data model, security, minimal code, checklist, ready-made prompt).

## What it proves

| # | Proof | Where to see it |
|---|---|---|
| P1 | Single sign-on | Open Team Notes: "Hello alice @ Acme", no second login |
| P2 | No secrets for the child | Token inspector shows decoded claims only; the checklist verifies nothing is in storage, cookies, URL or DOM |
| P3 | Tenant isolation | Carol's Fleet Viewer shows Globex vehicles; `{tenant: ...}` in params is ignored and audited as `wrong_tenant_ignored` |
| P4 | Scopes | Notes (read-only), "Add note": refused by the mainframe and, if sent straight to the server, `403 scope_denied` |
| P5 | Roles | Team Notes is read-only for Dave (viewer), writable for Bob (user) |
| P6 | Two embedding modes | Rogue (sandboxed) is stopped on every attack; Rogue (injected) shows what pattern A cannot stop |
| P7 | Any HTML or link | Admin: upload or paste HTML, or add a URL; links show "Session: none" |
| P8 | Standalone fallback | Open `http://127.0.0.1:3001/c/fleet.html` directly: it asks for its own sign-in |

## 8-minute demo script

1. Sign in as **alice**. Show the launcher (mode badges, effective scopes). Open **Team Notes**: "Hello alice @ Acme", no second login. Add a note.
2. Open the **Proof Panel**: the live audit row for `notes.add`, and the token inspector (decoded `sub`, `tenant`, `role`, `cid`, `scope`, `exp`, with a countdown; never the raw token).
3. Open **Fleet Viewer** next to Team Notes (tabs). In a private window sign in as **carol**: different tenant, different vehicles.
4. Open **Notes (read-only)** and click **Add note**: "Refused: scope_denied". The Proof Panel shows the denied row (`via mainframe`).
5. Open **Rogue (sandboxed)**, click **Run attacks**: every row passes (the attack was stopped).
6. Open **Rogue (injected)** (next to Team Notes), click **Run attacks**: the honest mixed result. It can read the mainframe DOM and the other frame, and draw a fake sign-in box, but cannot read the token, capture the `Authorization` header, call out-of-scope methods or read another tenant. This is why pattern A is for trusted code only.
7. As admin open **Admin: child frames**, **Add child frame**: upload a small HTML file (preview and scope picker shown first), give it `vehicles.read`, enable it, open it. Add a link too.
8. Open a child frame's URL directly (for example `http://127.0.0.1:3001/c/fleet.html`): the standalone sign-in appears and the badge reads "Standalone: signed in directly".

Finish with **Run the attack demo** in the Proof Panel: P1 to P8 turn green.

## Architecture

```
 http://localhost:3000        MAINFRAME: UI + auth + platform API + admin + proof panel
 http://127.0.0.1:3001        CHILD ORIGIN: serves child-frame HTML (uploaded + samples) and /sdk.js
 (any external site)          EXTERNAL LINKS: embedded as-is, no session
```

* **Injected (pattern A)**: the loader fetches the child HTML from the child origin, puts the markup in the page, re-creates its `<script>` elements in order, finds `platform.apps[id]` and calls `initialize(api, state, done)`. The `api` closes over the child token.
* **Sandboxed (pattern B)**: `<iframe sandbox="allow-scripts allow-same-origin allow-forms">` on the child origin. The child only sends `postMessage` requests; the mainframe checks `origin` and `source`, checks the scope, and makes the call. `allow-same-origin` is correct only because the child origin differs from the mainframe's.
* **Link (mode C)**: `<iframe sandbox="allow-scripts allow-forms allow-popups">` with no `allow-same-origin`, no SDK, no session.

### Token model

1. `POST /auth/login` returns a user **access token** (JWT, 10 min) in the body and sets a **refresh cookie** (`HttpOnly`, `SameSite=Strict`, `Path=/auth`, host-only). The access token is held in a JavaScript closure (`src/web/session.ts`): never in `localStorage`, a readable cookie, a URL or a log. On reload the cookie gets a new one.
2. Opening a child frame calls `POST /auth/child-token {childId}`. The **child token** (JWT, 5 min) carries `sub`, `tenant`, `role`, `cid`, `scope` (child scopes ∩ role scopes). The mainframe refreshes it at 80% of its life.
3. `POST /api/rpc` accepts child tokens only (a user access token gets `401 not_a_child_token`).
4. Pattern A: the child gets an `api` whose methods close over the token. Pattern B: the child never sees a token. Mode C: nothing.

## Security model

* Passwords: bcrypt (`bcryptjs`), never logged. JWT: HS256 with a long random `JWT_SECRET` (environment, or generated into `.env` on first run), with `iss`, `aud`, `exp`, `jti`. RS256 plus a JWKS endpoint is the production choice.
* Refresh tokens: random, stored hashed, rotated on every use, revocable. Replaying a rotated token revokes the user's whole family. `/auth/refresh` and `/auth/logout` also refuse a foreign `Origin`.
* Every RPC: verify the token, take tenant, user and role **from the token** (anything in `params` is ignored), look the method up, check its scope, run with `WHERE tenant_id = ?`, and write an audit row, allowed or denied. The child frame must also still be active and enabled for the tenant.
* CORS: the mainframe allows only the child origin on `/auth/login`, `/auth/child-token` and `/api/rpc` (needed for the standalone fallback), without credentials; the rest of the mainframe allows no cross-origin callers. The child origin answers only the mainframe origin.
* Uploaded or pasted HTML is stored as given and served **only from the child origin**, with `Content-Security-Policy: frame-ancestors http://localhost:3000` and `X-Content-Type-Options: nosniff`. Never executed on the mainframe origin. The admin preview renders it with scripts disabled.
* Helmet on both servers, `Cache-Control: no-store` on auth responses, body limits (100 KB, 1 MB for uploads), rate limits (login 10 per minute per IP, `/api/rpc` 120 per minute per token), `zod` on every input.
* The mainframe CSP is the one from the spec: `default-src 'self'; frame-src http://127.0.0.1:3001 https:; connect-src 'self' http://127.0.0.1:3001; script-src 'self' 'unsafe-inline' http://127.0.0.1:3001; style-src 'self' 'unsafe-inline'` (plus `object-src 'none'`, `base-uri`, `form-action`, `frame-ancestors 'none'`). **Pattern A forces `'unsafe-inline'` and the child origin into `script-src`, because the loader runs the child's inline and external scripts in the mainframe page. This is a real cost of pattern A and a reason to prefer pattern B.**
* The platform calls use the `fetch` captured at boot inside the token closure, so an injected child that replaces `window.fetch` cannot see the `Authorization` header.

## Limitations (honest)

* **Pattern A shares the page with the child frame.** It protects the token from casual access only. A hostile child can still read and rewrite the mainframe UI (the Rogue (injected) frame draws a fake sign-in box over it), read other frames, and call the API within its scopes; and it forces the weaker CSP above. Use it only for code you wrote or reviewed.
* Mode C links cannot receive a session, and many sites refuse to be framed (a 6 second timer shows a hint and an "Open in a new tab" link).
* `localhost` plus `127.0.0.1` is a demo. Production needs two real domains and HTTPS (the refresh cookie gets `Secure` when the mainframe origin is not localhost).
* Dev passwords and a dev secret are not for production. Sign-in is local; an external identity provider (OIDC/SAML) is the production path.
* In this PoC an admin manages child frames for all tenants. There is no per-tenant admin boundary.
* The audit feed is polled every 2 seconds (and immediately after the mainframe's own calls) instead of server-sent events, as the spec allows.
* This is not penetration-tested.

## How to add your own child frame

1. Write one HTML file. Load the SDK with `<script src="/sdk.js"></script>` (relative: it resolves to the child origin) and use **one** inline `<script>`.
2. **Sandboxed (recommended):**
   ```html
   <div id="out"></div>
   <script src="/sdk.js"></script>
   <script>
     PlatformSDK.connect('my-id').then(async (api) => {
       const { user, tenant } = await api.getSession();          // identity only, never a token
       const vehicles = await api.call('vehicles.list', {});
       document.getElementById('out').textContent = `Hello ${user} @ ${tenant}: ${vehicles.length} vehicles`;
     });
   </script>
   ```
   `connect()` talks to the mainframe over `postMessage` when framed, and shows its own sign-in form when the page is opened on its own (P8). `api.multiCall([[method, params], ...])` always returns an array.
3. **Injected (trusted code only):** register `platform.apps['my-id'] = () => ({ initialize(host, state, done) { const api = PlatformSDK.fromHost(host); ...; done(); }, focus() {}, blur() {} })`, keep your CSS in a Shadow DOM and no static `<style>` (see `src/samples/notes.html` and `GEOTAB_ADDIN_GUIDE.md` section 4). Add `if (!window.platform || !window.platform.hosted) PlatformSDK.standalone('my-id').then(start)` for the standalone fallback.
4. In **Admin: child frames** click **Add child frame**: upload the file (or paste it, or give a URL), choose the mode, give it an id (the one you used above; for injected frames it must match `platform.apps[id]`), tick only the scopes it needs, and enable it for tenants. Default scopes are none.
5. Methods available: `whoami`, `vehicles.list` (`vehicles.read`), `notes.list` (`notes.read`), `notes.add {text}` (`notes.write`), `multi` (up to 20 calls).

A manifest looks like this (shown read-only in the admin UI, with an export button):

```json
{ "id": "notes", "name": "Team Notes", "description": "Shared notes for the tenant", "mode": "injected",
  "url": "http://127.0.0.1:3001/c/notes.html", "scopes": ["notes.read", "notes.write"], "version": "1.0" }
```

## Tests

`npm test` runs 68 Vitest tests (JWT verification T17, API tests for T3 to T8, T13, T15, admin, CORS, rate limits, headers and "no token in logs", and `tests/api/platform.test.ts` for users, groups, roles, access management, the App Store and reports). `npm run test:e2e` runs 31 Playwright tests in Chromium against a clean server on ports 3100 and 3101 (T1, T2, T4, T6 to T16, the attack demos, and the Proof Panel checklist).

## Layout

```
src/server/   main, bootstrap, mainframe (:3000), childOrigin (:3001), auth, rpc, platform (users, groups, roles, access, store, reports), access, audit, security, db, config, build
src/web/      mainframe UI: session (token closure), api (pattern A), loader (A), iframeHost (B and links), workspace, views/ (store, reports, people, admin, proof, ...)
src/sdk/      childSdk.ts  -> /sdk.js
src/samples/  the demo child frames
src/shared/   role and scope model, shared by server and browser
tests/        unit, api, e2e
```

Code for the two embedding modes is based on `mainframe-poc-reference/` (`a_mainframe.js`, `b_host.js`, `b_child_sdk.js`); changes from it are commented at the top of `src/web/api.ts`, `loader.ts`, `iframeHost.ts` and `src/sdk/childSdk.ts`.
