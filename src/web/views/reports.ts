/* REPORTS: usage and access reports computed by the mainframe from its audit log, for the signed-in user's organization only. */
import { h, clear } from '../dom';
import { api, downloadCsv, pageHeader, when, type ViewCtx } from '../ui';
import type { User } from '../session';

export function buildReports(user: User, _ctx: ViewCtx): HTMLElement {
  const root = h('section', { class: 'reports', id: 'reports-page' });
  const body = h('div');
  const msg = h('div', { class: 'error', role: 'alert' });
  let days = 7;

  const range = h('select', { id: 'report-days', 'aria-label': 'Period', on: { change: (e: Event) => { days = Number((e.target as HTMLSelectElement).value); load(); } } },
    [[1, 'Last 24 hours'], [7, 'Last 7 days'], [30, 'Last 30 days'], [90, 'Last 90 days']].map(([v, l]) => h('option', { value: String(v), selected: v === days }, String(l))));

  const stat = (label: string, value: number | string, id: string) => h('div', { class: 'stat', 'data-stat': id }, h('div', { class: 'stat-n' }, String(value)), h('div', { class: 'muted small' }, label));

  const section = (title: string, csv: (() => void) | null, ...content: Node[]) =>
    h('div', { class: 'card' }, h('div', { class: 'row between' }, h('h2', null, title), csv ? h('button', { 'data-action': 'csv', on: { click: csv } }, 'Export CSV') : null), ...content);

  async function load() {
    msg.textContent = '';
    try {
      const r = await api('GET', `/reports/summary?days=${days}`);
      clear(body);
      const t = r.totals;
      body.append(h('div', { class: 'stats' },
        stat('App calls', t.calls, 'calls'), stat('Allowed', t.allowed, 'allowed'), stat('Denied', t.denied, 'denied'),
        stat('Active people', t.activeUsers, 'active'), stat('Installed apps', t.appsInstalled, 'apps'), stat('Groups', t.groups, 'groups')));

      const max = Math.max(1, ...r.byDay.map((d: { allowed: number; denied: number }) => d.allowed + d.denied));
      body.append(section('Calls per day', () => downloadCsv('calls-per-day.csv', [['day', 'allowed', 'denied'], ...r.byDay.map((d: any) => [d.day, d.allowed, d.denied])]),
        h('div', { class: 'bars', id: 'bars', role: 'img', 'aria-label': 'Calls per day' }, r.byDay.map((d: { day: string; allowed: number; denied: number }) =>
          h('div', { class: 'bar-col', title: `${d.day}: ${d.allowed} allowed, ${d.denied} denied` },
            h('div', { class: 'bar' }, h('div', { class: 'seg-denied', style: `height:${d.denied ? `max(3px, ${(d.denied / max) * 100}%)` : '0'}` }), h('div', { class: 'seg-allowed', style: `height:${d.allowed ? `max(3px, ${(d.allowed / max) * 100}%)` : '0'}` })),
            h('div', { class: 'muted tiny' }, d.day.slice(5)))))));

      body.append(section('Usage by app', () => downloadCsv('usage-by-app.csv', [['app', 'mode', 'opens', 'calls', 'denied', 'last used'], ...r.byApp.map((a: any) => [a.name, a.mode, a.opens, a.calls, a.denied, a.last ?? ''])]),
        h('table', { class: 'grid', id: 'report-apps' },
          h('thead', null, h('tr', null, ['App', 'Mode', 'Opened', 'API calls', 'Denied', 'Last used'].map((x) => h('th', null, x)))),
          h('tbody', null, r.byApp.map((a: any) => h('tr', { 'data-app-id': a.id }, h('td', null, `${a.icon} ${a.name}`), h('td', null, a.mode), h('td', null, String(a.opens)),
            h('td', null, a.mode === 'link' ? h('span', { class: 'muted' }, 'n/a (no session)') : String(a.calls)), h('td', null, String(a.denied)), h('td', null, when(a.last))))))));

      body.append(section('Usage by person', () => downloadCsv('usage-by-person.csv', [['user', 'role', 'calls', 'denied', 'last active'], ...r.byUser.map((u: any) => [u.email, u.role, u.calls, u.denied, u.last ?? ''])]),
        h('table', { class: 'grid', id: 'report-users' },
          h('thead', null, h('tr', null, ['Person', 'Role', 'API calls', 'Denied', 'Last active'].map((x) => h('th', null, x)))),
          h('tbody', null, r.byUser.map((u: any) => h('tr', { 'data-user': u.email }, h('td', null, u.email), h('td', null, u.role), h('td', null, String(u.calls)), h('td', null, String(u.denied)), h('td', null, when(u.last))))))));

      body.append(h('div', { class: 'cols' },
        section('Why calls were denied', () => downloadCsv('denied-reasons.csv', [['reason', 'count'], ...r.denied.map((d: any) => [d.reason, d.n])]),
          r.denied.length ? h('table', { class: 'grid', id: 'report-denied' }, h('tbody', null, r.denied.map((d: any) => h('tr', null, h('td', null, h('code', null, d.reason)), h('td', null, String(d.n)))))) : h('p', { class: 'muted' }, 'Nothing was denied in this period.')),
        section('Administration changes', () => downloadCsv('admin-changes.csv', [['time', 'who', 'action', 'detail'], ...r.adminActions.map((a: any) => [a.ts, a.email ?? '', a.method, a.reason ?? ''])]),
          r.adminActions.length ? h('table', { class: 'grid', id: 'report-admin' }, h('tbody', null, r.adminActions.map((a: any) => h('tr', null, h('td', null, when(a.ts)), h('td', null, a.email ?? ''), h('td', null, h('code', null, a.method)), h('td', null, a.reason ?? ''))))) : h('p', { class: 'muted' }, 'No changes in this period.'))));
    } catch (e) { msg.textContent = (e as Error).message; }
  }

  root.append(pageHeader('Reports', `Usage and access for ${user.tenant.name}, from the mainframe audit log.`, range), msg, body);
  load();
  return root;
}
