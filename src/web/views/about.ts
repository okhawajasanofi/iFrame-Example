import { h } from '../dom';

const DIAGRAM = ` Browser (user)
 +------------------------------ localhost:3000 (mainframe page) ------------------------------+
 |  Login --> access token (memory only) --> createApi() closure                               |
 |                                                                                             |
 |  Mode A "injected":  loader fetches child HTML from :3001, runs its scripts IN this page    |
 |       child --api.call()--> closure --> POST /api/rpc   (child token in Authorization)      |
 |                                                                                             |
 |  Mode B "sandboxed": <iframe src=127.0.0.1:3001/...>  <--postMessage-->  mainframe host     |
 |       child --rpc msg--> host checks origin + source + scope --> POST /api/rpc              |
 |                                                                                             |
 |  Mode C "link": <iframe src=https://other.site>   (no SDK, no session)                      |
 +---------------------------------------------------------------------------------------------+
        |  POST /auth/*, /api/rpc, /admin/*, GET /audit
        v
   Express (:3000, localhost)     --> SQLite (users, tenants, child frames, data, audit log)
   Express (:3001, 127.0.0.1)     --> child-frame HTML + /sdk.js   (CORS for :3000 only)`;

export function buildAbout(): HTMLElement {
  return h('article', { class: 'about' },
    h('h1', null, 'About this proof of concept'),
    h('p', null, 'A main app (the mainframe) signs you in once and hosts other apps (child frames). Child frames get your identity and access from the mainframe session, with no second login, and without ever holding a secret.'),
    h('h2', null, 'Architecture'),
    h('p', null, 'Two host names on one machine, on purpose: localhost and 127.0.0.1 are different origins and different cookie jars, so the mainframe cookies can never reach the child origin. (Cookies are not isolated by port, so two ports on one host would not prove that.)'),
    h('pre', { class: 'diagram' }, DIAGRAM),
    h('h2', null, 'Token model'),
    h('ol', null,
      h('li', null, 'Login returns a user access token (10 minutes) in the response body and sets an HttpOnly, SameSite=Strict refresh cookie scoped to /auth. The access token lives in a JavaScript closure only: not in localStorage, not in a script-readable cookie, not in a URL, not in a log.'),
      h('li', null, 'Opening a child frame asks the server for a child token (5 minutes) with claims sub, tenant, role, cid and scope. scope is the intersection of what the child frame was approved for and what the user role allows.'),
      h('li', null, 'Every call to /api/rpc uses a child token. A user access token is refused there. The child frame itself never receives either token.'),
      h('li', null, 'Pattern A (injected): the frame gets an api object whose methods close over the token. Pattern B (sandboxed): the frame only sends postMessage requests and the mainframe makes the call.'),
      h('li', null, 'Mode C (link): no token, and no message is honoured.')),
    h('h2', null, 'Honest limitations'),
    h('ul', { class: 'limits' },
      h('li', null, 'Pattern A shares the page with the child frame. It protects the token from casual access only. A hostile child can still rewrite the mainframe UI (for example draw a fake sign-in box), and pattern A forces a weaker Content-Security-Policy (unsafe-inline, plus the child origin in script-src). Use it only for code you wrote or reviewed. The Rogue (injected) frame demonstrates this.'),
      h('li', null, 'Links cannot receive a session, and many sites refuse to be framed.'),
      h('li', null, 'Localhost with two host names is a demo. Production needs two real domains and HTTPS.'),
      h('li', null, 'Dev passwords and a dev secret are not for production. HS256 is used here; RS256 with a JWKS endpoint is the production choice, and an external identity provider the production path for sign-in.'),
      h('li', null, 'This has not been penetration-tested.')));
}
