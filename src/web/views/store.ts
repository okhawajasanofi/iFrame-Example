/* APP STORE: the catalog of every registered app. A tenant admin installs an app for the tenant; installed apps show up in
 * "My apps" in the sidebar and open as iframes (sandboxed, injected or a plain website link). */
import { h, clear, badge, MODE_LABEL } from '../dom';
import { api, confirmUninstall, modal, pageHeader, type ViewCtx } from '../ui';
import { SCOPE_LABELS } from '../../shared/scopes';
import type { User } from '../session';

interface StoreApp {
  id: string; name: string; description: string; mode: 'injected' | 'sandboxed' | 'link'; scopes: string[]; category: string; publisher: string; icon: string;
  version: string; host: string | null; installed: boolean; restricted: boolean; canOpen: boolean;
}

const MODE_TEXT = {
  sandboxed: 'Runs in a sandboxed iframe on its own origin. It never sees your password or token.',
  injected: 'Runs inside the mainframe page. Only install code you wrote or reviewed.',
  link: 'A website shown in an iframe. It gets no session and cannot see your data.',
} as const;

export function buildStore(user: User, ctx: ViewCtx): HTMLElement {
  const root = h('section', { class: 'store' });
  let apps: StoreApp[] = [];
  let canInstall = false;
  let tab: 'all' | 'installed' | 'available' = 'all';
  let query = '';
  let category = '';

  const search = h('input', { type: 'search', id: 'store-search', placeholder: 'Search apps', 'aria-label': 'Search apps', on: { input: (e: Event) => { query = (e.target as HTMLInputElement).value.toLowerCase(); paint(); } } });
  const cat = h('select', { id: 'store-category', 'aria-label': 'Category', on: { change: (e: Event) => { category = (e.target as HTMLSelectElement).value; paint(); } } });
  const tabs = h('div', { class: 'seg', role: 'tablist' });
  const grid = h('div', { class: 'store-grid', id: 'store-grid' });
  const note = h('p', { class: 'muted', id: 'store-note' });

  async function load() {
    const r = await api('GET', '/store');
    apps = r.apps; canInstall = r.canInstall;
    const cur = category;
    clear(cat);
    cat.append(h('option', { value: '' }, 'All categories'), ...[...new Set(apps.map((a) => a.category))].sort().map((c) => h('option', { value: c, selected: c === cur }, c)));
    paint();
  }

  function paint() {
    clear(tabs);
    for (const [k, label] of [['all', 'All'], ['installed', 'Installed'], ['available', 'Available']] as const) {
      const n = apps.filter((a) => k === 'all' || (k === 'installed') === a.installed).length;
      tabs.append(h('button', { class: tab === k ? 'active' : '', role: 'tab', 'data-tab': k, on: { click: () => { tab = k; paint(); } } }, `${label} (${n})`));
    }
    note.textContent = canInstall ? 'You are an administrator: you can install and uninstall apps for everyone in your organization.' : 'Only an administrator can install apps. Ask yours to install one you need.';
    const shown = apps.filter((a) => (tab === 'all' || (tab === 'installed') === a.installed) && (!category || a.category === category)
      && (!query || `${a.name} ${a.description} ${a.publisher} ${a.category}`.toLowerCase().includes(query)));
    clear(grid);
    if (!shown.length) grid.append(h('p', { class: 'muted pad' }, 'No apps match.'));
    for (const a of shown) grid.append(card(a));
  }

  function card(a: StoreApp): HTMLElement {
    const actions: HTMLElement[] = [];
    if (a.installed && a.canOpen) actions.push(h('button', { class: 'primary', 'data-action': 'open', on: { click: () => ctx.openApp(a.id) } }, 'Open'));
    if (a.installed && !a.canOpen) actions.push(h('span', { class: 'chip none' }, 'Restricted: not in an allowed group'));
    if (a.installed && canInstall) actions.push(h('button', { 'data-action': 'uninstall', on: { click: () => confirmUninstall(a, user.tenant.name, ctx, load) } }, 'Uninstall'));
    if (!a.installed && canInstall) actions.push(h('button', { class: 'primary', 'data-action': 'install', on: { click: () => confirmInstall(a) } }, 'Install'));
    if (!a.installed && !canInstall) actions.push(h('span', { class: 'chip none' }, 'Ask an admin to install'));
    return h('article', { class: `store-card ${a.installed ? 'installed' : ''}`, 'data-app-id': a.id },
      h('div', { class: 'store-head' }, h('span', { class: 'store-icon', 'aria-hidden': 'true' }, a.icon),
        h('div', null, h('h3', null, a.name), h('div', { class: 'muted small' }, `${a.publisher} · v${a.version}`))),
      h('div', { class: 'row wrap' }, badge(MODE_LABEL[a.mode], a.mode), h('span', { class: 'chip' }, a.category),
        a.installed ? h('span', { class: 'badge allowed', 'data-status': 'installed' }, 'Installed') : null, a.restricted ? h('span', { class: 'chip' }, 'Restricted by groups') : null),
      h('p', { class: 'store-desc' }, a.description),
      h('div', { class: 'row wrap actions' }, ...actions));
  }

  function permissionList(a: StoreApp): HTMLElement {
    const items = a.scopes.length ? a.scopes.map((s) => SCOPE_LABELS[s] ?? s) : [];
    return h('div', null,
      h('p', null, h('strong', null, 'What this app can do')),
      items.length ? h('ul', null, items.map((i) => h('li', null, i))) : h('p', { class: 'muted' }, a.mode === 'link' ? `Nothing: it only shows ${a.host ?? 'a website'}. It gets no session.` : 'No access to your data.'),
      h('p', { class: a.mode === 'injected' ? 'warn-box' : 'muted' }, MODE_TEXT[a.mode]),
      h('p', { class: 'muted small' }, 'Even with these permissions, each person can only use what their role allows (the app can never do more than the signed-in user).'));
  }

  function confirmInstall(a: StoreApp) {
    modal(`Install ${a.name}?`, [h('p', { class: 'muted' }, `For everyone in ${user.tenant.name}. You can restrict it to groups afterwards under Access management.`), permissionList(a)],
      [{ label: 'Install', id: 'confirm-install', primary: true, run: async () => {
        await api('POST', `/store/${a.id}/install`);
        await load(); await ctx.refreshApps(); ctx.toast(`${a.name} installed. It is now in My apps.`);
      } }], 'install-dialog');
  }

  root.append(pageHeader('App Store', 'Add apps to your organization. Each installed app opens as an iframe inside this mainframe.'), note,
    h('div', { class: 'row wrap filters' }, tabs, cat, search), grid);
  load().catch((e) => grid.replaceChildren(h('p', { class: 'error', role: 'alert' }, (e as Error).message)));
  return root;
}
