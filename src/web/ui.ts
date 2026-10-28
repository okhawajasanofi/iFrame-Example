// Small shared UI helpers for the platform screens (users, groups, access, store, reports).
import { h } from './dom';
import { authed } from './session';

export interface ViewCtx {
  /** Reload "My apps" in the sidebar (after installing, uninstalling or changing access). */
  refreshApps: () => Promise<void>;
  /** Open an installed app in the workspace. */
  openApp: (id: string) => void;
  toast: (msg: string, action?: { label: string; run: () => void }) => void;
  /** Go to the App Store. */
  openStore: () => void;
}

export interface ModalAction { label: string; id?: string; primary?: boolean; run: () => Promise<string | void> | string | void }

/** A modal dialog. An action may return a string to show an error and keep the dialog open. */
export function modal(title: string, body: Node[], actions: ModalAction[], id?: string): HTMLDialogElement {
  const err = h('div', { class: 'error', role: 'alert' });
  const dlg = h('dialog', { class: 'dlg', id });
  const close = () => { dlg.close(); dlg.remove(); };
  const buttons = actions.map((a) => h('button', { type: 'button', id: a.id, class: a.primary ? 'primary' : '', on: { click: async (e: Event) => {
    const btn = e.currentTarget as HTMLButtonElement;
    btn.disabled = true; err.textContent = '';
    try { const msg = await a.run(); if (typeof msg === 'string' && msg) err.textContent = msg; else close(); }
    catch (x) { err.textContent = (x as Error).message; }
    finally { btn.disabled = false; }
  } } }, a.label));
  dlg.append(h('div', { class: 'dlg-body' }, h('h2', null, title), ...body, err,
    h('div', { class: 'row end' }, h('button', { type: 'button', class: 'cancel', on: { click: close } }, 'Cancel'), ...buttons)));
  dlg.addEventListener('cancel', () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
  return dlg;
}

/** Calls the API and throws a readable Error on failure, so callers can just await it. */
export async function api(method: string, path: string, body?: unknown): Promise<any> {
  const r = await authed(method, path, body);
  if (r.status >= 400) throw new Error(r.body?.error?.message ?? `Request failed (${r.status})`);
  return r.body;
}

/** Downloads rows as CSV. Cells that start with = + - or @ are prefixed so spreadsheets never run them as formulas. */
export function downloadCsv(filename: string, rows: (string | number | null)[][]) {
  const cell = (v: string | number | null) => {
    let s = v === null ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s) && typeof v === 'string') s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const blob = new Blob([rows.map((r) => r.map(cell).join(',')).join('\r\n')], { type: 'text/csv' });
  const a = h('a', { href: URL.createObjectURL(blob), download: filename });
  a.click();
  URL.revokeObjectURL(a.href);
}

export const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : 'never');

export function pageHeader(title: string, subtitle: string, ...actions: Node[]): HTMLElement {
  return h('div', { class: 'page-head' }, h('div', null, h('h1', null, title), h('p', { class: 'muted' }, subtitle)), h('div', { class: 'row' }, ...actions));
}

/** Confirm and uninstall an app for the tenant. Shared by the App Store and the My apps list. */
export function confirmUninstall(app: { id: string; name: string }, tenantName: string, ctx: ViewCtx, afterwards: () => Promise<void> | void = () => {}) {
  modal(`Uninstall ${app.name}?`, [
    h('p', null, `${app.name} disappears from My apps for everyone in ${tenantName}, its tab closes, any group restriction on it is cleared, and open sessions stop working.`),
    h('p', { class: 'muted' }, 'You can reinstall it any time from the App Store.')],
  [{ label: 'Uninstall', id: 'confirm-uninstall', primary: true, run: async () => {
    await api('DELETE', `/store/${app.id}/install`);
    await ctx.refreshApps(); // also closes the app's tab if it was open
    await afterwards();
    ctx.toast(`${app.name} uninstalled. You can reinstall it from the App Store.`, { label: 'Open App Store', run: ctx.openStore });
  } }], 'uninstall-dialog');
}
