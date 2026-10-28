/* The common administration screens: Users, Groups, Roles and Access management. These are the features every business app
 * needs, so they live in the mainframe once instead of being rebuilt inside every child app. */
import { h, clear, badge } from '../dom';
import { api, modal, pageHeader, type ViewCtx } from '../ui';
import { PLATFORM_PERMS, type Role } from '../../shared/scopes';
import type { User } from '../session';

const ROLES: Role[] = ['admin', 'user', 'viewer'];
const check = (value: string, label: string, checked: boolean, name: string) =>
  h('label', { class: 'inline' }, h('input', { type: 'checkbox', value, checked, name }), ` ${label}`);
const checked = (root: ParentNode, name: string) => [...root.querySelectorAll<HTMLInputElement>(`input[name="${name}"]:checked`)].map((i) => i.value);

// ------------------------------------------------------------------------------------------------ users
export function buildUsers(user: User, ctx: ViewCtx): HTMLElement {
  const root = h('section', { class: 'people', id: 'users-page' });
  const body = h('div');
  const msg = h('div', { class: 'error', role: 'alert' });

  async function load() {
    const r = await api('GET', '/admin/users');
    clear(body);
    body.append(h('table', { class: 'grid', id: 'users-table' },
      h('thead', null, h('tr', null, ['User', 'Role', 'Groups', 'Status', ''].map((t) => h('th', null, t)))),
      h('tbody', null, r.users.map((u: { id: string; email: string; role: Role; status: string; groups: { id: string; name: string }[] }) => {
        const self = u.id === r.self;
        const role = h('select', { 'aria-label': `Role of ${u.email}`, 'data-role-of': u.email, disabled: self, on: { change: async (e: Event) => {
          msg.textContent = '';
          try { await api('PATCH', `/admin/users/${u.id}`, { role: (e.target as HTMLSelectElement).value }); ctx.toast(`${u.email} is now ${(e.target as HTMLSelectElement).value}.`); }
          catch (x) { msg.textContent = (x as Error).message; }
          await load();
        } } }, ROLES.map((x) => h('option', { value: x, selected: x === u.role }, x)));
        return h('tr', { 'data-user': u.email, class: u.status === 'disabled' ? 'disabled' : '' },
          h('td', null, h('strong', null, u.email), self ? h('span', { class: 'muted small' }, ' (you)') : null), h('td', null, role),
          h('td', null, u.groups.length ? u.groups.map((g) => h('span', { class: 'chip' }, g.name)) : h('span', { class: 'chip none' }, 'none')),
          h('td', null, badge(u.status, u.status === 'active' ? 'allowed' : 'denied')),
          h('td', { class: 'actions' },
            h('button', { 'data-action': 'reset', on: { click: () => resetDialog(u) } }, 'Reset password'),
            h('button', { 'data-action': u.status === 'active' ? 'disable' : 'enable', disabled: self, title: self ? 'You cannot disable yourself' : '', on: { click: async () => {
              msg.textContent = '';
              try { await api('PATCH', `/admin/users/${u.id}`, { status: u.status === 'active' ? 'disabled' : 'active' }); } catch (x) { msg.textContent = (x as Error).message; }
              await load();
            } } }, u.status === 'active' ? 'Disable' : 'Enable')));
      }))));
  }

  function addDialog() {
    const email = h('input', { type: 'email', id: 'new-user-email', required: true, placeholder: `name@${user.tenant.id}.test` });
    const pw = h('input', { type: 'password', id: 'new-user-password', autocomplete: 'new-password', placeholder: 'at least 8 characters' });
    const role = h('select', { id: 'new-user-role' }, ROLES.map((r) => h('option', { value: r, selected: r === 'user' }, r)));
    modal(`Add a user to ${user.tenant.name}`, [h('label', null, 'Email', email), h('label', null, 'Initial password', pw), h('label', null, 'Role', role)],
      [{ label: 'Add user', id: 'save-user', primary: true, run: async () => { await api('POST', '/admin/users', { email: email.value, password: pw.value, role: role.value }); ctx.toast('User added.'); await load(); } }]);
  }

  function resetDialog(u: { id: string; email: string }) {
    const pw = h('input', { type: 'password', id: 'reset-password', autocomplete: 'new-password', placeholder: 'at least 8 characters' });
    modal(`Reset password for ${u.email}`, [h('p', { class: 'muted' }, 'They will be signed out everywhere.'), h('label', null, 'New password', pw)],
      [{ label: 'Reset', id: 'save-reset', primary: true, run: async () => { await api('PATCH', `/admin/users/${u.id}`, { password: pw.value }); ctx.toast('Password reset.'); } }]);
  }

  root.append(pageHeader('Users', `People in ${user.tenant.name}. Only administrators see this page.`, h('button', { class: 'primary', id: 'add-user', on: { click: addDialog } }, 'Add user')), msg, body);
  load().catch((e) => { msg.textContent = (e as Error).message; });
  return root;
}

// ------------------------------------------------------------------------------------------------ groups
interface Group { id: string; name: string; description: string; members: { id: string; email: string }[] }

export function buildGroups(user: User, ctx: ViewCtx): HTMLElement {
  const root = h('section', { class: 'people', id: 'groups-page' });
  const body = h('div', { class: 'group-grid' });
  const msg = h('div', { class: 'error', role: 'alert' });
  let people: { id: string; email: string }[] = [];

  async function load() {
    const r = await api('GET', '/admin/groups');
    people = r.users;
    clear(body);
    if (!r.groups.length) body.append(h('p', { class: 'muted' }, 'No groups yet. Create one, add people, then use it under Access management.'));
    for (const g of r.groups as Group[]) {
      body.append(h('article', { class: 'card group-card', 'data-group': g.name },
        h('h3', null, g.name), h('p', { class: 'muted' }, g.description || 'No description'),
        h('div', { class: 'chips' }, g.members.length ? g.members.map((m) => h('span', { class: 'chip' }, m.email)) : h('span', { class: 'chip none' }, 'no members')),
        h('div', { class: 'row actions' },
          h('button', { 'data-action': 'members', on: { click: () => membersDialog(g) } }, 'Members'),
          h('button', { 'data-action': 'rename', on: { click: () => editDialog(g) } }, 'Edit'),
          h('button', { 'data-action': 'delete', on: { click: () => deleteDialog(g) } }, 'Delete'))));
    }
  }

  function createDialog() {
    const name = h('input', { id: 'new-group-name', required: true, maxLength: 60 });
    const desc = h('input', { id: 'new-group-desc', maxLength: 200 });
    modal('New group', [h('label', null, 'Name', name), h('label', null, 'Description', desc)],
      [{ label: 'Create', id: 'save-group', primary: true, run: async () => { await api('POST', '/admin/groups', { name: name.value, description: desc.value }); await load(); } }]);
  }
  function editDialog(g: Group) {
    const name = h('input', { value: g.name, maxLength: 60 });
    const desc = h('input', { value: g.description, maxLength: 200 });
    modal(`Edit ${g.name}`, [h('label', null, 'Name', name), h('label', null, 'Description', desc)],
      [{ label: 'Save', primary: true, run: async () => { await api('PATCH', `/admin/groups/${g.id}`, { name: name.value, description: desc.value }); await load(); } }]);
  }
  function membersDialog(g: Group) {
    const ids = new Set(g.members.map((m) => m.id));
    const list = h('div', { class: 'checklist-box' }, people.map((p) => check(p.id, p.email, ids.has(p.id), 'member')));
    modal(`Members of ${g.name}`, [list],
      [{ label: 'Save members', id: 'save-members', primary: true, run: async () => { await api('PUT', `/admin/groups/${g.id}/members`, { userIds: checked(list, 'member') }); ctx.toast('Members saved.'); await load(); await ctx.refreshApps(); } }]);
  }
  function deleteDialog(g: Group) {
    modal(`Delete ${g.name}?`, [h('p', null, 'Members stay in the organization. Any app restricted to this group is no longer restricted by it.')],
      [{ label: 'Delete', id: 'confirm-delete-group', primary: true, run: async () => { await api('DELETE', `/admin/groups/${g.id}`); await load(); await ctx.refreshApps(); } }]);
  }

  root.append(pageHeader('Groups', 'Sets of people. Use them to decide who may open which app.', h('button', { class: 'primary', id: 'add-group', on: { click: createDialog } }, 'New group')), msg, body);
  load().catch((e) => { msg.textContent = (e as Error).message; });
  return root;
}

// ------------------------------------------------------------------------------------------------ roles
export function buildRoles(_user: User, _ctx: ViewCtx): HTMLElement {
  const root = h('section', { class: 'people', id: 'roles-page' });
  const body = h('div');
  api('GET', '/admin/roles').then((r) => {
    const roles = r.roles as { role: Role; description: string; scopes: string[]; platformPerms: string[]; users: number }[];
    const yes = h('span', { class: 'yes', 'aria-label': 'allowed' }, '✔');
    const cell = (on: boolean) => h('td', { class: 'center', 'data-on': String(on) }, on ? yes.cloneNode(true) : h('span', { class: 'muted', 'aria-label': 'not allowed' }, '–'));
    const rows = (title: string, keys: string[], labels: Record<string, string>, field: 'scopes' | 'platformPerms') => [
      h('tr', { class: 'group-row' }, h('th', { colSpan: roles.length + 1 }, title)),
      ...keys.map((k) => h('tr', { 'data-key': k }, h('td', null, h('code', null, k), h('div', { class: 'muted small' }, labels[k] ?? '')), roles.map((x) => cell(x[field].includes(k))))),
    ];
    body.append(
      h('div', { class: 'row wrap' }, roles.map((x) => h('article', { class: 'card role-card', 'data-role': x.role }, badge(x.role, `role ${x.role}`), h('p', null, x.description), h('p', { class: 'muted small' }, `${x.users} user(s) in your organization`)))),
      h('div', { class: 'table-wrap' }, h('table', { class: 'grid', id: 'roles-matrix' },
        h('thead', null, h('tr', null, h('th', null, 'Permission'), roles.map((x) => h('th', { class: 'center' }, x.role)))),
        h('tbody', null,
          rows('In the mainframe (administration screens)', Object.keys(r.permLabels), r.permLabels, 'platformPerms'),
          rows('In apps (what an app may do on behalf of the user)', ['vehicles.read', 'notes.read', 'notes.write'], r.scopeLabels, 'scopes')))),
      h('p', { class: 'muted' }, 'Roles are built in. An app is only ever allowed what BOTH the app was approved for and the user role allows (the intersection), and the server enforces it on every call.'));
  }).catch((e) => body.replaceChildren(h('p', { class: 'error', role: 'alert' }, (e as Error).message)));
  root.append(pageHeader('Roles', 'What each role may do. The same app behaves differently for an admin, a user and a viewer.'), body);
  void PLATFORM_PERMS;
  return root;
}

// ------------------------------------------------------------------------------------------------ access management
export function buildAccess(_user: User, ctx: ViewCtx): HTMLElement {
  const root = h('section', { class: 'people', id: 'access-page' });
  const body = h('div');
  const msg = h('div', { class: 'error', role: 'alert' });

  async function load() {
    const r = await api('GET', '/admin/access');
    const groups = r.groups as { id: string; name: string }[];
    clear(body);
    body.append(h('table', { class: 'grid', id: 'access-table' },
      h('thead', null, h('tr', null, ['App', 'Who may open it', ''].map((t) => h('th', null, t)))),
      h('tbody', null, (r.apps as { id: string; name: string; icon: string; groupIds: string[] }[]).map((a) => h('tr', { 'data-app-id': a.id },
        h('td', null, `${a.icon} `, h('strong', null, a.name)),
        h('td', { 'data-access': a.groupIds.length ? 'restricted' : 'everyone' }, a.groupIds.length
          ? [h('span', { class: 'muted' }, 'Only: '), ...a.groupIds.map((id) => h('span', { class: 'chip' }, groups.find((g) => g.id === id)?.name ?? id)), h('span', { class: 'muted small' }, ' (and administrators)')]
          : h('span', null, 'Everyone in the organization')),
        h('td', { class: 'actions' }, h('button', { 'data-action': 'edit-access', on: { click: () => editDialog(a, groups) } }, 'Change')))))));
  }

  function editDialog(a: { id: string; name: string; groupIds: string[] }, groups: { id: string; name: string }[]) {
    const list = h('div', { class: 'checklist-box' }, groups.length ? groups.map((g) => check(g.id, g.name, a.groupIds.includes(g.id), 'grp')) : h('p', { class: 'muted' }, 'No groups yet. Create one under Groups first.'));
    modal(`Who may open ${a.name}?`, [h('p', { class: 'muted' }, 'Tick no groups to let everyone in. With groups ticked, only their members (and administrators) can open it. This applies immediately, even to people who already have it open.'), list],
      [{ label: 'Save', id: 'save-access', primary: true, run: async () => { await api('PUT', `/admin/access/${a.id}`, { groupIds: checked(list, 'grp') }); ctx.toast('Access updated.'); await load(); await ctx.refreshApps(); } }]);
  }

  root.append(pageHeader('Access management', 'Choose which groups may open each installed app. Install more apps from the App Store.'), msg, body);
  load().catch((e) => { msg.textContent = (e as Error).message; });
  return root;
}
