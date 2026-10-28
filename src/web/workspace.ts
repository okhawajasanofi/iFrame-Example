/* The tabbed workspace: up to 3 child frames open at once. Frames keep running while another tab or view is shown. */
import { h, badge, MODE_LABEL, clear } from './dom';
import { emit } from './events';
import { prepareChild, dropChild } from './session';
import { openInjected, type InjectedHandle } from './loader';
import { embedSandboxed, embedLink, type FrameHandle } from './iframeHost';
import type { ChildEntry } from './api';

export const MAX_OPEN = 3;

interface Open { entry: ChildEntry; pane: HTMLElement; destroy: () => void; focus: () => void; blur: () => void }

const frames = new Map<string, Open>();
let activeId: string | null = null;
let shown = true; // false while Admin / Proof Panel / About is on screen

export const el = h('div', { class: 'workspace' });
const tabbar = h('div', { class: 'tabbar', role: 'tablist' });
const panes = h('div', { class: 'panes' });
const empty = h('div', { class: 'empty' }, h('h2', null, 'Pick a child frame'), h('p', null, 'Choose one from the launcher on the left. You can keep up to 3 open at once.'));
el.append(tabbar, panes, empty);

export const openIds = () => [...frames.keys()];
export const active = () => (activeId ? frames.get(activeId)?.entry ?? null : null);
export const isOpen = (id: string) => frames.has(id);

function render() {
  clear(tabbar);
  for (const [id, f] of frames) {
    tabbar.append(
      h('div', { class: `tab ${id === activeId ? 'active' : ''}`, role: 'tab', 'data-tab-id': id },
        h('button', { class: 'tab-title', on: { click: () => activate(id) } }, f.entry.name),
        h('button', { class: 'tab-close', title: `Close ${f.entry.name}`, 'aria-label': `Close ${f.entry.name}`, on: { click: () => closeChild(id) } }, '×')),
    );
  }
  empty.hidden = frames.size > 0;
  for (const [id, f] of frames) f.pane.hidden = id !== activeId || !shown;
  emit('workspace-changed');
}

export function activate(id: string) {
  if (!frames.has(id)) return;
  if (activeId && activeId !== id) frames.get(activeId)?.blur();
  activeId = id;
  frames.get(id)!.focus();
  render();
}

/** Tells the workspace whether it is currently on screen (so a hidden injected frame gets blur(), a shown one focus()). */
export function setShown(v: boolean) {
  if (shown === v) return;
  shown = v;
  const f = activeId ? frames.get(activeId) : null;
  v ? f?.focus() : f?.blur();
  render();
}

function banner(entry: ChildEntry): HTMLElement {
  const origin = new URL(entry.url, location.href).origin;
  const session = entry.mode === 'link' ? 'Session: none' : 'Session: provided by mainframe';
  return h('div', { class: `banner ${entry.mode}` },
    badge(MODE_LABEL[entry.mode], entry.mode),
    h('span', null, `Runs from ${origin}`),
    h('span', { class: entry.mode === 'link' ? 'no-session' : 'has-session' }, session),
    entry.mode === 'injected' ? h('span', { class: 'warn' }, 'Runs inside the mainframe page. Only for code you wrote or reviewed.') : null,
    entry.mode === 'link' ? h('span', { class: 'note' }, 'External site. It cannot see your session. Some sites refuse to be framed.') : null,
    entry.mode === 'link' ? h('a', { class: 'open-new', href: entry.url, target: '_blank', rel: 'noopener noreferrer' }, 'Open in a new tab') : null,
  );
}

export async function openChild(entry: ChildEntry): Promise<void> {
  if (frames.has(entry.id)) return activate(entry.id);
  if (frames.size >= MAX_OPEN) { emit('toast', `Close a tab first: ${MAX_OPEN} child frames can be open at once.`); return; }

  const body = h('div', { class: 'pane-body' });
  const pane = h('section', { class: 'pane', 'data-pane-id': entry.id, 'aria-label': entry.name }, banner(entry), body);
  panes.append(pane);

  const f: Open = { entry, pane, destroy: () => {}, focus: () => {}, blur: () => {} };
  frames.set(entry.id, f);
  activate(entry.id);

  try {
    if (entry.mode === 'injected') {
      body.append(h('p', { class: 'loading' }, 'Loading…'));
      await prepareChild(entry.id);
      const host = h('div', { class: 'injected-host' });
      const h0 = await openInjectedInto(entry, host, body);
      f.destroy = h0.destroy; f.focus = h0.focus; f.blur = h0.blur;
    } else if (entry.mode === 'sandboxed') {
      await prepareChild(entry.id);
      const handle: FrameHandle = embedSandboxed(entry, body);
      f.destroy = handle.destroy;
    } else {
      f.destroy = mountLink(entry, body).destroy;
    }
  } catch (e) {
    body.replaceChildren(h('p', { class: 'error', role: 'alert' }, `Could not open ${entry.name}: ${(e as Error).message}`));
  }
  render();
}

/** Mode C: a website in a sandboxed iframe, plus the "may be blocking embedding" hint if it never finishes loading. */
function mountLink(entry: ChildEntry, body: HTMLElement): FrameHandle {
  const slow = h('div', { class: 'slow', hidden: true },
    'This site may be blocking embedding (X-Frame-Options or CSP). ',
    h('a', { href: entry.url, target: '_blank', rel: 'noopener noreferrer' }, 'Open in a new tab'), '.');
  const handle = embedLink(entry, body, () => { slow.hidden = false; });
  body.append(slow);
  return handle;
}

// ---- website demo: ONE tab whose iframe switches when another site is picked ----
export const DEMO_ID = 'demo-site';
let demoUrl: string | null = null;
export const currentDemoUrl = () => demoUrl;

export async function showDemoSite(site: { name: string; url: string }): Promise<void> {
  const entry: ChildEntry = { id: DEMO_ID, name: `Demo: ${site.name}`, description: site.url, mode: 'link', url: site.url, scopes: [], effectiveScopes: [], version: '1.0' };
  const f = frames.get(DEMO_ID);
  if (!f) {
    demoUrl = site.url;
    await openChild(entry);
    if (!frames.has(DEMO_ID)) demoUrl = null; // refused (too many tabs open)
    return;
  }
  f.destroy(); // drop the previous site's iframe and timer
  const body = h('div', { class: 'pane-body' });
  f.pane.replaceChildren(banner(entry), body);
  f.pane.setAttribute('aria-label', entry.name);
  f.destroy = mountLink(entry, body).destroy;
  f.entry = entry;
  demoUrl = site.url;
  activate(DEMO_ID);
  render();
}

async function openInjectedInto(entry: ChildEntry, host: HTMLElement, body: HTMLElement): Promise<InjectedHandle> {
  body.replaceChildren(host);
  return openInjected(entry, host);
}

export function closeChild(id: string) {
  const f = frames.get(id);
  if (!f) return;
  f.blur();
  f.destroy(); // removes message listeners and scripts
  f.pane.remove();
  frames.delete(id);
  if (id === DEMO_ID) demoUrl = null;
  dropChild(id);
  if (activeId === id) {
    activeId = [...frames.keys()].pop() ?? null;
    if (activeId) frames.get(activeId)!.focus();
  }
  render();
}

export function closeAll() {
  for (const id of [...frames.keys()]) closeChild(id);
}
