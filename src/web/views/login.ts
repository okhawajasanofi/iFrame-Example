import { h, clear, badge } from '../dom';
import { login, type User } from '../session';

interface DemoAccount { email: string; org: string; role: 'admin' | 'user' | 'viewer'; summary: string; can: string[]; cannot: string[]; sees: string; tryIt: string }

/** What each seeded login can do, so a person trying the demo knows what to expect. Kept in step with the seed data in src/server/db.ts. */
const DEMO: DemoAccount[] = [
  {
    email: 'alice@acme.test', org: 'Acme', role: 'admin',
    summary: 'Runs the Acme organization.',
    can: ['Install and uninstall apps (App Store)', 'Manage users, groups, roles and access', 'Register new apps', 'See Reports', 'Read AND write in apps'],
    cannot: ['See Globex people or data'],
    sees: 'Every installed app, including Notes (read-only): admins can always open every installed app.',
    tryIt: 'Open Administration > Access management, or install Wikipedia from the App Store.',
  },
  {
    email: 'bob@acme.test', org: 'Acme', role: 'user',
    summary: 'A regular Acme employee.',
    can: ['Use the installed apps (read and write notes)', 'See Reports'],
    cannot: ['Install apps or open any Administration screen', 'Open Notes (read-only): it is restricted to the Auditors group, and Bob is in Operations'],
    sees: 'Every installed app except Notes (read-only).',
    tryIt: 'Open Team Notes and add a note: it works. Then compare with Dave.',
  },
  {
    email: 'dave@acme.test', org: 'Acme', role: 'viewer',
    summary: 'A read-only Acme auditor.',
    can: ['Read in apps (notes, vehicles)', 'Open Notes (read-only): he is in the Auditors group', 'Browse the App Store'],
    cannot: ['Write: adding a note in Team Notes is refused with scope_denied', 'See Reports', 'Install apps or open Administration'],
    sees: 'Every installed app (including Notes read-only), but the same app does less for him than for Bob.',
    tryIt: 'Open Team Notes and click Add note: "Refused: scope_denied". Same app, different role.',
  },
  {
    email: 'carol@globex.test', org: 'Globex', role: 'admin',
    summary: 'Runs a DIFFERENT organization (Globex).',
    can: ['Everything an admin can, but only inside Globex', 'Install apps for Globex only'],
    cannot: ['See Acme users, groups, notes, vehicles or reports'],
    sees: 'Only the apps installed for Globex (3 to start with), with Globex vehicles and notes.',
    tryIt: 'Open Fleet Viewer: different vehicles than Alice. Install Wikipedia: Acme does not get it.',
  },
];

/** The sign-in screen. The demo-accounts panel is shown only when the server says it is not production. */
export async function showLogin(root: HTMLElement, onSuccess: (u: User) => void, notice?: string) {
  clear(root);
  const email = h('input', { name: 'email', type: 'email', autocomplete: 'username', required: true, placeholder: 'you@company.test', id: 'login-email' });
  const password = h('input', { name: 'password', type: 'password', autocomplete: 'current-password', required: true, placeholder: 'password', id: 'login-password' });
  const err = h('div', { class: 'error', role: 'alert', id: 'login-error' }, notice ?? '');
  const submit = h('button', { type: 'submit', class: 'primary' }, 'Sign in');

  const form = h('form', { class: 'card login', on: { submit: async (e: Event) => {
    e.preventDefault();
    err.textContent = '';
    submit.disabled = true;
    try {
      const u = await login(email.value, password.value);
      password.value = '';
      onSuccess(u);
    } catch (e2) {
      err.textContent = (e2 as Error).message;
    } finally { submit.disabled = false; }
  } } },
    h('h1', null, 'Mainframe PoC'),
    h('p', { class: 'muted' }, 'Sign in once. Child frames reuse this session.'),
    h('label', null, 'Email', email), h('label', null, 'Password', password), err, submit);

  const wrap = h('div', { class: 'login-wrap' }, form);
  root.append(wrap);

  const dev = await fetch('/health').then((r) => r.json()).then((j) => j.dev).catch(() => false);
  if (dev) {
    const pick = (a: DemoAccount) => { email.value = a.email; password.value = 'Passw0rd!'; password.focus(); };
    wrap.append(h('aside', { class: 'card demo', id: 'demo-accounts' },
      h('h2', null, 'Demo accounts'),
      h('p', { class: 'muted' }, 'Development only. Password for all: Passw0rd!  Click an account to fill the form, then Sign in. Sign in as each one to compare what changes.'),
      h('div', { class: 'demo-grid' }, DEMO.map((a) => h('button', { type: 'button', class: 'demo-acct', 'data-email': a.email, on: { click: () => pick(a) } },
        h('div', { class: 'demo-top' }, h('strong', null, a.email), badge(a.role, `role ${a.role}`), h('span', { class: 'chip' }, a.org)),
        h('div', { class: 'demo-summary' }, a.summary),
        h('div', { class: 'demo-list-title can' }, 'Can'),
        h('ul', { class: 'can' }, a.can.map((x) => h('li', null, x))),
        h('div', { class: 'demo-list-title cannot' }, 'Cannot'),
        h('ul', { class: 'cannot' }, a.cannot.map((x) => h('li', null, x))),
        h('div', { class: 'demo-sees' }, h('strong', null, 'Sees: '), a.sees),
        h('div', { class: 'demo-try' }, h('strong', null, 'Try: '), a.tryIt))))));
  }
}
