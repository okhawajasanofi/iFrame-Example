/* PATTERN A loader (see mainframe-poc-reference/a_mainframe.js): runs a TRUSTED child frame inside this page.
 * Changes from the reference: lifecycle (focus/blur/destroy), cleanup of the scripts it added, the factory may be found
 * by "the one new registration" when an uploaded file used a different id, and a clear error if nothing registers. */
import { createApi, type ChildEntry } from './api';

interface Factory { (): { initialize: (api: any, state: any, done: () => void) => void; focus?: (api: any, state: any) => void; blur?: () => void } }

// Child frames register themselves here. `hosted` tells a child that it is inside the mainframe (otherwise it runs standalone).
const platform = ((window as any).platform = { apps: {} as Record<string, Factory>, hosted: true });

const nativeFetch = window.fetch.bind(window); // captured at boot (see session.ts)

export interface InjectedHandle { focus(): void; blur(): void; destroy(): void }

export async function openInjected(entry: ChildEntry, container: HTMLElement): Promise<InjectedHandle> {
  const html = await (await nativeFetch(entry.url)).text();
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const before = new Set(Object.keys(platform.apps));
  container.replaceChildren();
  container.insertAdjacentHTML('beforeend', doc.body.innerHTML); // markup only: scripts added this way never run
  container.querySelectorAll('script').forEach((s) => s.remove()); // the inert copies; we re-create them below
  const added: HTMLScriptElement[] = [];
  for (const old of doc.querySelectorAll('script')) { // run the scripts in order, in this page
    const el = document.createElement('script');
    if (old.getAttribute('src')) {
      el.src = new URL(old.getAttribute('src')!, entry.url).href;
      await new Promise((res) => { el.onload = res; el.onerror = res; document.body.appendChild(el); }); // wait, so the factory exists when we look
    } else {
      el.textContent = old.textContent;
      document.body.appendChild(el);
    }
    added.push(el);
  }
  let key = entry.id;
  if (!platform.apps[key]) {
    const fresh = Object.keys(platform.apps).filter((k) => !before.has(k));
    if (fresh.length === 1) key = fresh[0];
    else throw new Error(`Child frame did not register as "platform.apps['${entry.id}']"`);
  }
  const child = platform.apps[key]();
  const api = createApi(entry);
  const state = {};
  await new Promise<void>((resolve) => { child.initialize(api, state, resolve); setTimeout(resolve, 4000); }); // never hang the UI on a child that forgets done()
  return {
    focus: () => child.focus?.(api, state),
    blur: () => child.blur?.(),
    destroy: () => {
      try { child.blur?.(); } catch { /* a misbehaving child must not break closing */ }
      added.forEach((s) => s.remove());
      delete platform.apps[key];
      container.replaceChildren();
    },
  };
}
