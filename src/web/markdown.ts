/* A small, safe Markdown renderer for the two help pages. It builds DOM nodes (never innerHTML), so document text can
 * never inject markup. Supports: headings, paragraphs, bullet and numbered lists (nested by indentation), tables,
 * fenced code blocks, **bold**, `code`, and [links](http...) (http/https only, opened in a new tab with noopener). */
import { h } from './dom';

function inline(text: string): (Node | string)[] {
  const out: (Node | string)[] = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\[[^\]]+\]\((?:https?:\/\/)[^)\s]+\))/g;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const t = m[0];
    if (t.startsWith('`')) out.push(h('code', null, t.slice(1, -1)));
    else if (t.startsWith('**')) out.push(h('strong', null, ...inline(t.slice(2, -2))));
    else {
      const [, label, href] = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(t)!;
      out.push(h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, label));
    }
    last = m.index + t.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const cells = (line: string) => line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
const isTableSep = (l: string) => /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(l);
const listMatch = (l: string) => /^(\s*)([-*]|\d+\.)\s+(.*)$/.exec(l);

function renderList(lines: string[], start: number): [HTMLElement, number] {
  const first = listMatch(lines[start])!;
  const indent = first[1].length;
  const ordered = /\d/.test(first[2]);
  const list = h(ordered ? 'ol' : 'ul');
  let i = start;
  while (i < lines.length) {
    const m = listMatch(lines[i]);
    if (!m || m[1].length < indent) break;
    if (m[1].length > indent) {
      const [sub, next] = renderList(lines, i);
      (list.lastElementChild ?? list).append(sub);
      i = next;
      continue;
    }
    list.append(h('li', null, ...inline(m[3])));
    i++;
  }
  return [list, i];
}

export function renderMarkdown(src: string): HTMLElement {
  const root = h('div', { class: 'md' });
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }

    const fence = /^```(\w*)\s*$/.exec(line);
    if (fence) {
      const body: string[] = [];
      for (i++; i < lines.length && !/^```\s*$/.test(lines[i]); i++) body.push(lines[i]);
      i++;
      root.append(h('pre', { class: 'code', 'data-lang': fence[1] }, h('code', null, body.join('\n'))));
      continue;
    }
    const head = /^(#{1,4})\s+(.*)$/.exec(line);
    if (head) { root.append(h(`h${head[1].length}` as 'h1', null, ...inline(head[2]))); i++; continue; }

    if (line.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const header = cells(line);
      const rows: string[][] = [];
      for (i += 2; i < lines.length && lines[i].includes('|') && lines[i].trim(); i++) rows.push(cells(lines[i]));
      root.append(h('div', { class: 'table-wrap' }, h('table', { class: 'grid' },
        h('thead', null, h('tr', null, header.map((c) => h('th', null, ...inline(c))))),
        h('tbody', null, rows.map((r) => h('tr', null, r.map((c) => h('td', null, ...inline(c)))))))));
      continue;
    }
    if (listMatch(line)) { const [list, next] = renderList(lines, i); root.append(list); i = next; continue; }

    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|```)/.test(lines[i]) && !listMatch(lines[i]) && !(lines[i].includes('|') && isTableSep(lines[i + 1] ?? ''))) para.push(lines[i++]);
    root.append(h('p', null, ...inline(para.join(' '))));
  }
  return root;
}
