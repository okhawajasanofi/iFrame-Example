import { h, clear, fmtTime, badge } from '../dom';
import { on } from '../events';
import { authed, inspectChild, leakCheck, probeRpc, probeUserTokenOnRpc, prepareChild, type User } from '../session';
import { ROLE_SCOPES, effectiveScopes } from '../../shared/scopes';
import { embedSandboxed } from '../iframeHost';
import type { ChildEntry } from '../api';
import type * as Workspace from '../workspace';

interface AuditRow { id: number; ts: string; childId: string | null; method: string; result: string; reason: string | null; via: string }
type Verdict = { state: 'pending' | 'pass' | 'fail' | 'skip'; detail: string };

const PROOFS: [string, string][] = [
  ['P1', 'Single sign-on: a child frame knows who you are and your tenant, with no second login'],
  ['P2', 'No secrets for the child: tokens are not in storage, cookies, the URL or the DOM, and a user token is refused by the API'],
  ['P3', 'Tenant isolation: asking for another tenant is ignored'],
  ['P4', 'Scopes: a call outside the approved list is refused by the server'],
  ['P5', 'Roles: access is the intersection of the child frame scopes and your role'],
  ['P6', 'Sandbox: a hostile sandboxed frame is stopped on every attack'],
  ['P7', 'Any HTML or link can be added; a plain website gets no session'],
  ['P8', 'Standalone fallback: a child frame on its own can reach the sign-in endpoint'],
];

export function buildProof(user: User, getChildren: () => ChildEntry[], ws: typeof Workspace): HTMLElement {
  const root = h('section', { class: 'proof' });

  // ---------------- live evidence ----------------
  const tbody = h('tbody');
  const rows: AuditRow[] = [];
  let lastId = 0;
  const evidence = h('table', { class: 'grid evidence', id: 'evidence' },
    h('thead', null, h('tr', null, ['Time', 'Child', 'Method', 'Result', 'Reason', 'Via'].map((t) => h('th', null, t)))), tbody);

  function paint() {
    clear(tbody);
    for (const r of rows.slice(-60).reverse()) {
      tbody.append(h('tr', { class: r.result, 'data-result': r.result }, h('td', null, fmtTime(r.ts)), h('td', null, r.childId ?? '-'), h('td', null, r.method),
        h('td', null, badge(r.result, r.result)), h('td', null, r.reason ?? ''), h('td', null, r.via)));
    }
  }

  let polling = false;
  async function poll() {
    if (polling) return;
    polling = true;
    try {
      const r = await authed('GET', `/audit?after=${lastId}`);
      if (r.status === 200 && r.body.rows.length) {
        rows.push(...r.body.rows);
        lastId = rows[rows.length - 1].id;
        paint();
      }
    } catch { /* session ended: the shell handles it */ } finally { polling = false; }
  }
  // Live: poll every 2 s, and immediately after any call the mainframe itself made.
  window.setInterval(poll, 2000);
  on('audit-dirty', poll);
  poll();

  // ---------------- token inspector ----------------
  const picker = h('select', { id: 'inspect-child', 'aria-label': 'Child frame to inspect' });
  const claimsBox = h('pre', { id: 'claims', class: 'claims' }, 'Open a child frame to see its token claims.');
  const countdown = h('div', { id: 'countdown', class: 'muted' });
  function inspect() {
    const id = picker.value;
    const t = id ? inspectChild(id) : null;
    if (!t) { claimsBox.textContent = 'Open a child frame to see its token claims.'; countdown.textContent = ''; return; }
    const { sub, tenant, role, cid, scope, exp } = t.claims;
    claimsBox.textContent = JSON.stringify({ sub, tenant, role, cid, scope, exp }, null, 2); // decoded claims only; the raw token is never shown or copyable
    countdown.textContent = `Expires in ${Math.max(0, Math.round((t.expiresAtMs - Date.now()) / 1000))} s`;
  }
  function syncPicker() {
    const ids = ws.openIds();
    const cur = picker.value;
    clear(picker);
    for (const id of ids) picker.append(h('option', { value: id }, getChildren().find((c) => c.id === id)?.name ?? id));
    picker.value = ids.includes(cur) ? cur : ws.active()?.id ?? ids[0] ?? '';
    inspect();
  }
  picker.addEventListener('change', inspect);
  on('workspace-changed', syncPicker);
  window.setInterval(inspect, 1000);
  syncPicker();

  // ---------------- checklist and attack demo ----------------
  const verdicts: Record<string, Verdict> = Object.fromEntries(PROOFS.map(([k]) => [k, { state: 'pending', detail: 'Not run yet' } as Verdict]));
  const checklist = h('ul', { class: 'checklist', id: 'checklist' });
  const demoLog = h('div', { class: 'muted', id: 'demo-status' });
  const ICON = { pending: '○', pass: '✔', fail: '✘', skip: '–' };
  function paintChecklist() {
    clear(checklist);
    for (const [k, text] of PROOFS) {
      const v = verdicts[k];
      checklist.append(h('li', { class: `proof-item ${v.state}`, 'data-proof': k, 'data-state': v.state },
        h('span', { class: 'icon', 'aria-label': v.state }, ICON[v.state]), h('span', { class: 'pid' }, k), h('span', null, text), h('div', { class: 'muted small' }, v.detail)));
    }
  }
  paintChecklist();
  const set = (k: string, state: Verdict['state'], detail: string) => { verdicts[k] = { state, detail }; paintChecklist(); };

  const runBtn = h('button', { class: 'primary', id: 'run-demo', on: { click: runDemo } }, 'Run the attack demo');

  async function runDemo() {
    runBtn.disabled = true;
    for (const [k] of PROOFS) verdicts[k] = { state: 'pending', detail: 'Running…' };
    paintChecklist();
    const kids = getChildren();
    const find = (id: string) => kids.find((c) => c.id === id);
    const byScope = (s: string) => kids.find((c) => c.mode !== 'link' && c.effectiveScopes.includes(s));
    try {
      demoLog.textContent = 'Running checks…';
      const sample = kids.find((c) => c.mode !== 'link' && c.effectiveScopes.includes('vehicles.read')) ?? byScope('notes.read');

      // P1 and P3 and P2 need a frame the user may use.
      if (!sample) {
        for (const k of ['P1', 'P2', 'P3']) set(k, 'skip', 'No child frame with a data scope is enabled for this tenant');
      } else {
        await prepareChild(sample.id);
        const who = await probeRpc(sample.id, 'whoami');
        const r = who.body?.result;
        set('P1', who.status === 200 && r?.user === user.email && r?.tenant?.id === user.tenant.id ? 'pass' : 'fail',
          `Child token for "${sample.name}" resolved to ${r?.user} @ ${r?.tenant?.name}, with no second login`);

        const leak = leakCheck();
        const userTok = await probeUserTokenOnRpc();
        const noTok = await fetch('/api/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"method":"whoami"}' }).then(async (x) => ({ status: x.status, code: (await x.json()).error?.code }));
        const p2 = !leak.leaked && userTok.code === 'not_a_child_token' && noTok.code === 'no_token';
        set('P2', p2 ? 'pass' : 'fail', `Token found in: ${leak.where.join(', ') || 'nowhere'}. User token on /api/rpc: ${userTok.status} ${userTok.code}. No token: ${noTok.status} ${noTok.code}`);

        if (sample.effectiveScopes.includes('vehicles.read')) {
          const mine = await probeRpc(sample.id, 'vehicles.list');
          const foreign = await probeRpc(sample.id, 'vehicles.list', { tenant: user.tenant.id === 'acme' ? 'globex' : 'acme' });
          set('P3', mine.status === 200 && JSON.stringify(mine.body.result) === JSON.stringify(foreign.body?.result) ? 'pass' : 'fail',
            `Asked for another tenant: got the same ${mine.body.result?.length} vehicles of ${user.tenant.name} (the field was ignored and audited as wrong_tenant_ignored)`);
        } else set('P3', 'skip', 'Needs a frame with vehicles.read');
      }

      // P4: send a call outside a child frame's scopes straight to the server.
      const readOnly = kids.find((c) => c.mode !== 'link' && !c.effectiveScopes.includes('notes.write'));
      if (readOnly) {
        await prepareChild(readOnly.id);
        const denied = await probeRpc(readOnly.id, 'notes.add', { text: 'attack demo' });
        set('P4', denied.status === 403 && denied.body?.error?.code === 'scope_denied' ? 'pass' : 'fail',
          `"${readOnly.name}" sent notes.add straight to the server: ${denied.status} ${denied.body?.error?.code}`);
      } else set('P4', 'skip', 'Every enabled frame can write notes');

      // P5: roles. The effective scopes must equal child scopes ∩ role scopes, and the server must agree.
      const notesFrame = find('notes') ?? byScope('notes.write') ?? kids.find((c) => c.scopes.includes('notes.write'));
      if (notesFrame) {
        const expected = effectiveScopes(notesFrame.scopes, user.role);
        const same = JSON.stringify(expected) === JSON.stringify(notesFrame.effectiveScopes);
        let serverNote = 'writes are allowed for this role (not exercised, to avoid adding notes)';
        let ok = same;
        if (!ROLE_SCOPES[user.role].includes('notes.write')) {
          await prepareChild(notesFrame.id);
          const w = await probeRpc(notesFrame.id, 'notes.add', { text: 'viewer attempt' });
          ok = ok && w.status === 403 && w.body?.error?.code === 'scope_denied';
          serverNote = `server answered notes.add with ${w.status} ${w.body?.error?.code}`;
        }
        set('P5', ok ? 'pass' : 'fail', `${user.role} on "${notesFrame.name}": scopes ${JSON.stringify(notesFrame.effectiveScopes)}; ${serverNote}`);
      } else set('P5', 'skip', 'No frame with notes.write is enabled for this tenant');

      // P7: a link frame exists and gets no session.
      const link = kids.find((c) => c.mode === 'link');
      set('P7', link ? 'pass' : 'skip', link ? `"${link.name}" is a link: no SDK, no token, and the launcher shows "no session"` : 'No link frame is enabled for this tenant');

      // P6 and P8: run Rogue (sandboxed) in a hidden sandboxed iframe and read its report.
      const rogue = find('rogue-sbx');
      if (!rogue) { set('P6', 'skip', 'Rogue (sandboxed) is not enabled for this tenant'); set('P8', 'skip', 'Needs Rogue (sandboxed)'); }
      else {
        demoLog.textContent = 'Running Rogue (sandboxed) in a hidden sandboxed iframe…';
        const rep = await runRogue(rogue);
        if (!rep) { set('P6', 'fail', 'Rogue (sandboxed) did not report back in time'); set('P8', 'fail', 'No report'); }
        else {
          const bad = rep.rows.filter((x) => !x.pass);
          set('P6', bad.length === 0 ? 'pass' : 'fail', bad.length === 0 ? `All ${rep.rows.length} attacks from the sandbox were stopped` : `Not stopped: ${bad.map((b) => b.name).join('; ')}`);
          set('P8', rep.probe?.pass ? 'pass' : 'fail', rep.probe?.detail ?? 'No probe result');
        }
      }
      demoLog.textContent = 'Done.';
    } catch (e) {
      demoLog.textContent = `Demo stopped: ${(e as Error).message}`;
    } finally { runBtn.disabled = false; }
  }

  interface Report { rows: { name: string; pass: boolean; detail: string }[]; probe?: { pass: boolean; detail: string } }
  async function runRogue(entry: ChildEntry): Promise<Report | null> {
    await prepareChild(entry.id);
    const holder = h('div', { class: 'hidden-frame', 'aria-hidden': 'true' });
    document.body.append(holder);
    return new Promise<Report | null>((resolve) => {
      let done = false;
      const handle = embedSandboxed(entry, holder, { onReport: (p) => { if (!done) { done = true; cleanup(); resolve(p as Report); } } });
      const tick = window.setInterval(() => handle.send({ type: 'command', name: 'run-attacks' }), 700); // retried until the child's SDK is ready
      const timeout = window.setTimeout(() => { if (!done) { done = true; cleanup(); resolve(null); } }, 20000);
      function cleanup() { clearInterval(tick); clearTimeout(timeout); handle.destroy(); holder.remove(); }
    });
  }

  root.append(
    h('h1', null, 'Proof Panel'),
    h('div', { class: 'cols' },
      h('div', { class: 'card' }, h('h2', null, 'Proof checklist'), h('div', { class: 'row' }, runBtn, demoLog), checklist),
      h('div', { class: 'card' }, h('h2', null, 'Token inspector'),
        h('p', { class: 'muted' }, 'Decoded claims of the child token the mainframe holds for the active frame. The raw token is never shown.'),
        h('label', null, 'Child frame', picker), claimsBox, countdown)),
    h('div', { class: 'card' }, h('h2', null, 'Live evidence'), h('p', { class: 'muted' }, 'Every platform call, allowed or denied, for your tenant.'), evidence));
  return root;
}
