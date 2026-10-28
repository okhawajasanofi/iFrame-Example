import { h, clear, badge, MODE_LABEL } from '../dom';
import { authed, type User } from '../session';
import { ASSIGNABLE_SCOPES } from '../../shared/scopes';

interface AdminChild {
  id: string; name: string; description: string; mode: 'injected' | 'sandboxed' | 'link'; url: string; scopes: string[]; version: string;
  status: 'active' | 'disabled'; tenants: Record<string, boolean>;
}
interface Tenant { id: string; name: string }

const INJECTED_WARNING = 'Runs inside the mainframe page. Only for code you wrote or reviewed.';

export function buildAdmin(user: User, onChanged: () => Promise<void>): HTMLElement {
  const root = h('section', { class: 'admin' });
  const tableHost = h('div');
  const msg = h('div', { class: 'error', role: 'alert' });
  let tenants: Tenant[] = [];

  async function load() {
    const r = await authed('GET', '/admin/children');
    if (r.status !== 200) { msg.textContent = r.body?.error?.message ?? 'Could not load child frames'; return; }
    tenants = r.body.tenants;
    renderTable(r.body.children);
  }

  async function refresh() { await load(); await onChanged(); }

  function renderTable(list: AdminChild[]) {
    clear(tableHost);
    const rows = list.map((c) => {
      const manifest = JSON.stringify({ id: c.id, name: c.name, description: c.description, mode: c.mode, url: c.url, scopes: c.scopes, version: c.version }, null, 2);
      return h('tr', { 'data-child-id': c.id, class: c.status === 'disabled' ? 'disabled' : '' },
        h('td', null, h('strong', null, c.name), h('div', { class: 'muted small' }, c.id)),
        h('td', null, badge(MODE_LABEL[c.mode], c.mode)),
        h('td', null, c.scopes.length ? c.scopes.map((s) => h('span', { class: 'chip' }, s)) : h('span', { class: 'chip none' }, 'none')),
        h('td', null, tenants.map((t) => h('label', { class: 'inline' },
          h('input', { type: 'checkbox', checked: !!c.tenants[t.id], 'aria-label': `Enable ${c.name} for ${t.name}`, on: { change: async (e: Event) => {
            const r = await authed('PUT', `/admin/children/${c.id}/tenants/${t.id}`, { enabled: (e.target as HTMLInputElement).checked });
            msg.textContent = r.status === 200 ? '' : r.body?.error?.message ?? 'Failed';
            await onChanged();
          } } }), ` ${t.name}`))),
        h('td', null, c.status),
        h('td', { class: 'actions' },
          h('button', { on: { click: () => editDialog(c) } }, 'Edit'),
          h('button', { on: { click: async () => { await authed(c.status === 'active' ? 'DELETE' : 'PATCH', `/admin/children/${c.id}`, c.status === 'active' ? undefined : { status: 'active' }); await refresh(); } } }, c.status === 'active' ? 'Disable' : 'Enable'),
          h('details', { class: 'manifest' }, h('summary', null, 'Manifest'),
            h('pre', null, manifest),
            h('button', { on: { click: () => {
              const a = h('a', { href: URL.createObjectURL(new Blob([manifest], { type: 'application/json' })), download: `${c.id}.manifest.json` });
              a.click(); URL.revokeObjectURL(a.href);
            } } }, 'Export JSON'))));
    });
    tableHost.append(h('table', { class: 'grid' },
      h('thead', null, h('tr', null, ['Child frame', 'Mode', 'Scopes', 'Enabled for', 'Status', ''].map((t) => h('th', null, t)))),
      h('tbody', null, rows)));
  }

  // ---------- add dialog ----------
  function addDialog() {
    const dlg = h('dialog', { class: 'dlg', id: 'add-dialog' });
    const name = h('input', { name: 'name', required: true, maxLength: 80, id: 'add-name' });
    const idIn = h('input', { name: 'id', placeholder: 'optional, e.g. my-report', pattern: '[a-z0-9][a-z0-9\\-]{1,40}', id: 'add-id' });
    const desc = h('input', { name: 'description', maxLength: 300 });
    const category = h('input', { name: 'category', maxLength: 40, value: 'General', id: 'add-category' });
    const publisher = h('input', { name: 'publisher', maxLength: 60, value: 'Custom', id: 'add-publisher' });
    const icon = h('input', { name: 'icon', maxLength: 8, value: '🧩', id: 'add-icon', 'aria-label': 'Icon (an emoji)' });
    const mode = h('select', { name: 'mode', id: 'add-mode' },
      h('option', { value: 'sandboxed' }, 'Sandboxed (recommended)'), h('option', { value: 'injected' }, 'Injected (trusted code only)'), h('option', { value: 'link' }, 'Link (external site)'));
    const warn = h('div', { class: 'warn-box', hidden: true, role: 'alert' }, INJECTED_WARNING);
    const source = h('select', { name: 'source', id: 'add-source' },
      h('option', { value: 'file' }, 'Upload an HTML file'), h('option', { value: 'paste' }, 'Paste HTML'), h('option', { value: 'url' }, 'URL'));
    const file = h('input', { type: 'file', accept: '.html,.htm,text/html', id: 'add-file' });
    const paste = h('textarea', { rows: 8, placeholder: '<div>…</div>', id: 'add-paste', hidden: true });
    const url = h('input', { type: 'url', placeholder: 'https://example.com/', id: 'add-url', hidden: true });
    const preview = h('iframe', { class: 'preview', title: 'Preview', hidden: true, id: 'add-preview' });
    preview.setAttribute('sandbox', ''); // preview shows the markup only: no scripts, no same-origin
    const err = h('div', { class: 'error', role: 'alert', id: 'add-error' });
    const scopeBoxes = ASSIGNABLE_SCOPES.map((s) => h('label', { class: 'inline' }, h('input', { type: 'checkbox', value: s, name: 'scope' }), ` ${s}`));
    const tenantBoxes = tenants.map((t) => h('label', { class: 'inline' }, h('input', { type: 'checkbox', value: t.id, name: 'tenant', checked: t.id === user.tenant.id }), ` ${t.name}`));
    let fileText = '';

    const sync = () => {
      warn.hidden = mode.value !== 'injected';
      if (mode.value === 'link') source.value = 'url';
      (source as HTMLSelectElement).disabled = mode.value === 'link';
      file.hidden = source.value !== 'file'; paste.hidden = source.value !== 'paste'; url.hidden = source.value !== 'url';
      const html = source.value === 'file' ? fileText : source.value === 'paste' ? paste.value : '';
      preview.hidden = !html;
      if (html) preview.srcdoc = html;
    };
    mode.addEventListener('change', sync); source.addEventListener('change', sync); paste.addEventListener('input', sync);
    file.addEventListener('change', async () => { fileText = (await file.files?.[0]?.text()) ?? ''; sync(); });

    const form = h('form', { method: 'dialog', on: { submit: async (e: Event) => {
      e.preventDefault();
      err.textContent = '';
      const body: Record<string, unknown> = {
        name: name.value, description: desc.value, mode: mode.value, category: category.value, publisher: publisher.value, icon: icon.value,
        scopes: scopeBoxes.map((l) => l.querySelector('input')!).filter((i) => i.checked).map((i) => i.value),
        tenants: tenantBoxes.map((l) => l.querySelector('input')!).filter((i) => i.checked).map((i) => i.value),
      };
      if (idIn.value) body.id = idIn.value;
      if (mode.value === 'link' || source.value === 'url') body.url = url.value;
      else body.html = source.value === 'file' ? fileText : paste.value;
      const r = await authed('POST', '/admin/children', body);
      if (r.status === 201) { dlg.close(); dlg.remove(); await refresh(); } else err.textContent = r.body?.error?.message ?? 'Failed';
    } } },
      h('h2', null, 'Add child frame'),
      h('label', null, 'Name', name), h('label', null, 'Id (injected frames register as platform.apps[id])', idIn), h('label', null, 'Description', desc),
      h('div', { class: 'row wrap' }, h('label', null, 'Category (App Store)', category), h('label', null, 'Publisher', publisher), h('label', null, 'Icon', icon)),
      h('label', null, 'Mode', mode), warn,
      h('label', null, 'Source', source), file, paste, url, preview,
      h('fieldset', null, h('legend', null, 'Scopes it may use (default: none)'), scopeBoxes),
      h('fieldset', null, h('legend', null, 'Enable for tenants'), tenantBoxes),
      err,
      h('div', { class: 'row' }, h('button', { type: 'button', on: { click: () => { dlg.close(); dlg.remove(); } } }, 'Cancel'), h('button', { type: 'submit', class: 'primary', id: 'add-save' }, 'Save')));
    dlg.append(form);
    root.append(dlg);
    dlg.showModal();
    sync();
  }

  // ---------- edit dialog ----------
  function editDialog(c: AdminChild) {
    const dlg = h('dialog', { class: 'dlg' });
    const name = h('input', { value: c.name, required: true });
    const desc = h('input', { value: c.description });
    const mode = h('select', null, (['sandboxed', 'injected', 'link'] as const).map((m) => h('option', { value: m, selected: m === c.mode }, MODE_LABEL[m])));
    const warn = h('div', { class: 'warn-box', hidden: c.mode !== 'injected' }, INJECTED_WARNING);
    mode.addEventListener('change', () => { warn.hidden = mode.value !== 'injected'; });
    const status = h('select', null, (['active', 'disabled'] as const).map((s) => h('option', { value: s, selected: s === c.status }, s)));
    const scopeBoxes = ASSIGNABLE_SCOPES.map((s) => h('label', { class: 'inline' }, h('input', { type: 'checkbox', value: s, checked: c.scopes.includes(s) }), ` ${s}`));
    const err = h('div', { class: 'error', role: 'alert' });
    dlg.append(h('form', { method: 'dialog', on: { submit: async (e: Event) => {
      e.preventDefault();
      const r = await authed('PATCH', `/admin/children/${c.id}`, {
        name: name.value, description: desc.value, mode: mode.value, status: status.value,
        scopes: scopeBoxes.map((l) => l.querySelector('input')!).filter((i) => i.checked).map((i) => i.value),
      });
      if (r.status === 200) { dlg.close(); dlg.remove(); await refresh(); } else err.textContent = r.body?.error?.message ?? 'Failed';
    } } },
      h('h2', null, `Edit ${c.name}`), h('label', null, 'Name', name), h('label', null, 'Description', desc), h('label', null, 'Mode', mode), warn, h('label', null, 'Status', status),
      h('fieldset', null, h('legend', null, 'Scopes'), scopeBoxes), err,
      h('div', { class: 'row' }, h('button', { type: 'button', on: { click: () => { dlg.close(); dlg.remove(); } } }, 'Cancel'), h('button', { type: 'submit', class: 'primary' }, 'Save'))));
    root.append(dlg);
    dlg.showModal();
  }

  root.append(
    h('div', { class: 'row between' }, h('h1', null, 'Register apps'), h('button', { class: 'primary', id: 'add-child', on: { click: addDialog } }, 'Add child frame')),
    h('p', { class: 'muted' }, 'Registering an app adds it to the App Store catalog. A tenant administrator then installs it. Uploaded or pasted HTML is stored as given and only ever served from the child origin, never run on the mainframe origin. Link frames get no session.'),
    msg, tableHost);
  load();
  return root;
}
