import { h, clear, badge, MODE_LABEL } from '../dom';
import { authed, logout, type User } from '../session';
import { on } from '../events';
import type { ChildEntry } from '../api';
import * as ws from '../workspace';
import { PLATFORM_PERMS } from '../../shared/scopes';
import { buildAdmin } from './admin';
import { buildProof } from './proof';
import { buildAbout } from './about';
import { buildDoc } from './docView';
import { buildStore } from './store';
import { buildReports } from './reports';
import { buildUsers, buildGroups, buildRoles, buildAccess } from './people';
import { DEMO_SITES } from '../demoSites';
import { confirmUninstall, type ViewCtx } from '../ui';

type ViewName = 'workspace' | 'store' | 'reports' | 'users' | 'groups' | 'roles' | 'access' | 'admin' | 'proof' | 'about' | 'owners' | 'platform';

/** The signed-in screen: top bar, navigation, and the views.
 *  The mainframe owns the COMMON features (users, groups, roles, access, reports, App Store). Child apps, opened as iframes from
 *  "My apps", bring the features that are unique to them. */
export async function showShell(root: HTMLElement, user: User, onSignedOut: () => void): Promise<void> {
  clear(root);
  const can = (perm: string) => PLATFORM_PERMS[user.role].includes(perm);
  const launcher = h('nav', { id: 'launcher', 'aria-label': 'Navigation' });
  const main = h('main', { class: 'main' });
  const toastEl = h('div', { class: 'toast', role: 'status', hidden: true });
  let toastTimer: number | undefined;
  const toast = (msg: string, action?: { label: string; run: () => void }) => {
    toastEl.replaceChildren(msg, ...(action ? [h('button', { class: 'toast-action', on: { click: () => { toastEl.hidden = true; action.run(); } } }, action.label)] : []));
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => { toastEl.hidden = true; }, action ? 9000 : 4000);
  };
  on('toast', toast);

  const top = h('header', { class: 'topbar' },
    h('strong', { class: 'brand' }, 'Mainframe PoC'),
    h('span', { class: 'spacer' }),
    h('span', { id: 'tenant-name', class: 'tenant' }, user.tenant.name),
    h('span', { id: 'user-name', class: 'user' }, user.email.split('@')[0]),
    badge(user.role, `role ${user.role}`),
    h('button', { id: 'sign-out', on: { click: async () => { ws.closeAll(); await logout(); onSignedOut(); } } }, 'Sign out'));

  let children: ChildEntry[] = [];
  const ctx: ViewCtx = {
    refreshApps: () => loadChildren(),
    openApp: (id) => { const c = children.find((x) => x.id === id); if (c) { show('workspace'); ws.openChild(c); } },
    toast,
    openStore: () => show('store'),
  };

  // ---- views. Data screens are rebuilt every time they are shown (so they are never stale); the rest are built once. ----
  const dynamic: Partial<Record<ViewName, () => HTMLElement>> = {
    store: () => buildStore(user, ctx),
    reports: () => buildReports(user, ctx),
    users: () => buildUsers(user, ctx),
    groups: () => buildGroups(user, ctx),
    roles: () => buildRoles(user, ctx),
    access: () => buildAccess(user, ctx),
  };
  const once: Partial<Record<ViewName, () => HTMLElement>> = {
    admin: () => buildAdmin(user, loadChildren),
    proof: () => buildProof(user, () => children, ws),
    owners: () => buildDoc('site-owners.md', 'owners of websites that you want to embed'),
    platform: () => buildDoc('platform-guide.md', 'developers and LLMs building iframe embedding into their own platform'),
  };
  const names: ViewName[] = ['store', 'reports', 'users', 'groups', 'roles', 'access', 'admin', 'proof', 'about', 'owners', 'platform'];
  const views = { workspace: ws.el, ...Object.fromEntries(names.map((n) => [n, h('div', { class: 'view', 'data-view': n })])) } as unknown as Record<ViewName, HTMLElement>;
  views.about.append(buildAbout());
  const built = new Set<ViewName>();
  const navButtons = new Map<ViewName, HTMLButtonElement>();

  function show(v: ViewName) {
    if (dynamic[v]) views[v].replaceChildren(dynamic[v]!());
    else if (once[v] && !built.has(v)) { built.add(v); views[v].append(once[v]!()); }
    for (const [name, el] of Object.entries(views)) el.hidden = name !== v;
    ws.setShown(v === 'workspace');
    for (const [name, b] of navButtons) b.classList.toggle('active', name === v);
  }

  const navBtn = (v: ViewName, label: string, id: string) => {
    const b = h('button', { class: 'nav-btn', id, 'data-view-name': v, on: { click: () => show(v) } }, label);
    navButtons.set(v, b);
    return b;
  };

  // ---- My apps ----
  const list = h('div', { class: 'launcher-list' });
  function renderLauncher() {
    clear(list);
    if (!children.length) list.append(h('p', { class: 'muted pad' }, can('apps.install') ? 'No apps installed yet. Open the App Store.' : 'No apps are available to you yet.'));
    for (const c of children) {
      list.append(h('div', { class: 'launch-wrap' },
        h('button', { class: `launch ${ws.isOpen(c.id) ? 'open' : ''}`, 'data-child-id': c.id, title: c.description, on: { click: () => { show('workspace'); ws.openChild(c); } } },
          h('span', { class: 'launch-name' }, h('span', null, c.icon ? `${c.icon} ` : '', c.name), badge(MODE_LABEL[c.mode], c.mode)),
          h('span', { class: 'chips' }, c.mode === 'link' ? h('span', { class: 'chip none' }, 'no session') : c.effectiveScopes.length ? c.effectiveScopes.map((s) => h('span', { class: 'chip' }, s)) : h('span', { class: 'chip none' }, 'no scopes'))),
        // admins can uninstall straight from the list; everyone else is pointed at the App Store
        can('apps.install') ? h('button', { class: 'uninstall-mini', 'data-action': 'uninstall-app', 'data-for': c.id, title: `Uninstall ${c.name}`, 'aria-label': `Uninstall ${c.name}`, on: { click: () => confirmUninstall(c, user.tenant.name, ctx) } }, 'Uninstall') : null));
    }
  }
  async function loadChildren() {
    const r = await authed('GET', '/children');
    children = r.body.children ?? [];
    // an app that is no longer available to this user (uninstalled, or restricted away) must not stay open in a tab
    for (const id of ws.openIds()) if (id !== ws.DEMO_ID && !children.some((c) => c.id === id)) ws.closeChild(id);
    renderLauncher();
  }
  on('workspace-changed', renderLauncher);

  // ---- collapsible list of websites for demoing the iframe feature (nothing opens until one is clicked) ----
  const demoList = h('div', { class: 'demo-list' });
  const renderDemo = () => {
    clear(demoList);
    for (const site of DEMO_SITES) {
      demoList.append(h('button', { class: `demo-site ${ws.currentDemoUrl() === site.url ? 'open' : ''}`, 'data-demo-url': site.url, title: site.url,
        on: { click: () => { show('workspace'); ws.showDemoSite(site); } } }, site.name));
    }
  };
  renderDemo();
  on('workspace-changed', renderDemo);
  const demoSection = h('details', { class: 'demo-sites', id: 'demo-sites' },
    h('summary', null, `Website demos (${DEMO_SITES.length})`),
    h('p', { class: 'muted small pad' }, 'Click a site to show it in an iframe. Click another to switch.'), demoList);

  // ---- navigation ----
  launcher.append(h('h3', null, 'My apps'), list, demoSection, h('h3', null, 'Platform'), navBtn('store', 'App Store', 'nav-store'));
  if (can('reports.read')) launcher.append(navBtn('reports', 'Reports', 'nav-reports'));
  if (user.role === 'admin') {
    launcher.append(h('details', { class: 'nav-group', id: 'nav-administration', open: true },
      h('summary', null, 'Administration'),
      navBtn('users', 'Users', 'nav-users'), navBtn('groups', 'Groups', 'nav-groups'), navBtn('roles', 'Roles', 'nav-roles'),
      navBtn('access', 'Access management', 'nav-access'), navBtn('admin', 'Register apps', 'nav-admin')));
  }
  launcher.append(h('h3', null, 'Help and proof'), navBtn('proof', 'Proof Panel', 'nav-proof'), navBtn('about', 'About', 'nav-about'),
    navBtn('owners', 'For website owners', 'nav-owners'), navBtn('platform', 'Build this into your platform', 'nav-platform'));

  main.append(...Object.values(views));
  root.append(top, h('div', { class: 'body' }, launcher, main), toastEl);
  await loadChildren();
  show('workspace');
}
