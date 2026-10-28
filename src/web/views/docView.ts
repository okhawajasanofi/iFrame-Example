import { h } from '../dom';
import { renderMarkdown } from '../markdown';

/** A help page rendered from a Markdown file served by the mainframe (/docs/<file>), with Copy and Download buttons. */
export function buildDoc(file: string, audience: string): HTMLElement {
  const body = h('div', { class: 'doc-body' }, h('p', { class: 'muted' }, 'Loading…'));
  const status = h('span', { class: 'muted', role: 'status' });
  let source = '';

  const copy = h('button', { class: 'primary', 'data-action': 'copy', disabled: true, on: { click: async () => {
    try { await navigator.clipboard.writeText(source); status.textContent = 'Copied. Paste it to your LLM or colleague.'; }
    catch { status.textContent = 'Copy failed: use Download instead.'; }
  } } }, 'Copy as Markdown');
  const download = h('button', { 'data-action': 'download', disabled: true, on: { click: () => {
    const a = h('a', { href: URL.createObjectURL(new Blob([source], { type: 'text/markdown' })), download: file });
    a.click();
    URL.revokeObjectURL(a.href);
  } } }, 'Download .md');

  fetch(`/docs/${file}`, { cache: 'no-store' })
    .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`))))
    .then((text) => {
      source = text;
      body.replaceChildren(renderMarkdown(text));
      copy.disabled = false; download.disabled = false;
    })
    .catch((e) => body.replaceChildren(h('p', { class: 'error', role: 'alert' }, `Could not load ${file}: ${e.message}`)));

  return h('article', { class: 'doc' },
    h('div', { class: 'row doc-actions' }, h('span', { class: 'muted' }, `For: ${audience}`), h('span', { class: 'spacer' }), status, copy, download),
    body);
}
