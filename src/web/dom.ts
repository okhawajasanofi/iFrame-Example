// Tiny DOM helpers. No framework: the UI is small and the point of the demo is elsewhere.
type Child = Node | string | null | undefined | false;
type Props = Record<string, unknown> & { class?: string; on?: Record<string, (e: Event) => void> };

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props | null = null, ...kids: (Child | Child[])[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = String(v);
    else if (k === 'on') for (const [ev, fn] of Object.entries(v as Record<string, (e: Event) => void>)) el.addEventListener(ev, fn);
    else if (k in el && k !== 'list') (el as any)[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid);
  return el;
}

export const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T | null;

export const clear = (el: Element) => el.replaceChildren();

/** Local time for the UI (the database stores UTC). */
export const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString();

export const MODE_LABEL = { injected: 'Injected', sandboxed: 'Sandboxed', link: 'Link' } as const;

export function badge(text: string, kind = ''): HTMLElement {
  return h('span', { class: `badge ${kind}` }, text);
}
