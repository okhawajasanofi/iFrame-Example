import { test, expect, type Page, type BrowserContext } from '@playwright/test';

const MAIN = 'http://localhost:3100';
const CHILD = 'http://127.0.0.1:3101';

async function signIn(page: Page, email: string) {
  await page.goto('/');
  await page.fill('#login-email', email);
  await page.fill('#login-password', 'Passw0rd!');
  await page.click('button[type=submit]');
  await expect(page.locator('#user-name')).toHaveText(email.split('@')[0]);
}
const launch = (page: Page, id: string) => page.click(`.launch[data-child-id="${id}"]`);
const pane = (id: string) => `[data-pane-id="${id}"]`;
const sandbox = (page: Page, id: string) => page.frameLocator(`${pane(id)} iframe`);
async function expireServerTokens(page: Page, body: object) {
  await page.request.post(`${MAIN}/dev/expire`, { data: body });
}
async function fresh(ctx: BrowserContext) { return ctx.newPage(); }

test.describe.configure({ mode: 'serial' });

test('login: wrong password is refused, demo accounts are listed', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#demo-accounts')).toContainText('alice@acme.test');
  await page.fill('#login-email', 'alice@acme.test');
  await page.fill('#login-password', 'wrong');
  await page.click('button[type=submit]');
  await expect(page.locator('#login-error')).toContainText('Wrong email or password');
});

test('T1 / P1: one login, Team Notes already knows who you are', async ({ page }) => {
  await signIn(page, 'alice@acme.test');
  await expect(page.locator('#tenant-name')).toHaveText('Acme');
  await launch(page, 'notes');
  await expect(page.locator(`${pane('notes')} #hello`)).toHaveText('Hello alice @ Acme');
  await expect(page.locator(`${pane('notes')} .banner`)).toContainText('Session: provided by mainframe');
  await expect(page.locator(`${pane('notes')} .banner .warn`)).toContainText('Only for code you wrote or reviewed');
  // no sign-in form appeared anywhere
  await expect(page.locator('input[type=password]')).toHaveCount(0);
  // writes work for an admin
  await page.fill(`${pane('notes')} #text`, 'e2e note from alice');
  await page.click(`${pane('notes')} #add`);
  await expect(page.locator(`${pane('notes')} #list li`).first()).toContainText('e2e note from alice');
});

test('the session survives a page reload (refresh cookie), and sign out ends it', async ({ page }) => {
  await signIn(page, 'bob@acme.test');
  await page.reload();
  await expect(page.locator('#user-name')).toHaveText('bob');
  await page.click('#sign-out');
  await expect(page.locator('#login-email')).toBeVisible();
  await page.reload();
  await expect(page.locator('#login-email')).toBeVisible();
});

test('T2 / P2: no token in storage, cookies, URLs or the DOM; fetch patching sees nothing', async ({ page }) => {
  const urls: string[] = [];
  page.on('request', (r) => urls.push(r.url()));
  await signIn(page, 'alice@acme.test');
  await launch(page, 'notes');
  await launch(page, 'fleet');
  await expect(sandbox(page, 'fleet').locator('#t tbody tr')).toHaveCount(6);
  const found = await page.evaluate(() => ({
    sessionType: typeof (window as any).session,
    cookie: document.cookie,
    local: JSON.stringify(Object.entries(localStorage)),
    sessionStore: JSON.stringify(Object.entries(sessionStorage)),
    jwtInDom: /eyJ[\w-]{10,}\.[\w-]{10,}\./.test(document.documentElement.outerHTML),
  }));
  expect(found.sessionType).toBe('undefined');
  expect(found.cookie).toBe(''); // the refresh cookie is HttpOnly
  expect(found.local).toBe('[]');
  expect(found.sessionStore).toBe('[]');
  expect(found.jwtInDom).toBe(false);
  expect(urls.filter((u) => /eyJ/.test(u))).toEqual([]);
});

test('T10 / P6: Rogue (injected) gives the honest, mixed result', async ({ page }) => {
  await signIn(page, 'alice@acme.test');
  await launch(page, 'notes');
  await launch(page, 'rogue-inj');
  await expect(page.locator(`${pane('rogue-inj')} .banner .warn`)).toBeVisible();
  await page.click(`${pane('rogue-inj')} #run`);
  const rows = page.locator(`${pane('rogue-inj')} #out tbody tr`);
  await expect(rows).toHaveCount(8);
  const table = await rows.evaluateAll((trs) => trs.map((tr) => ({ name: tr.children[0].textContent, expected: tr.getAttribute('data-expected'), actual: tr.getAttribute('data-actual') })));
  const succeeded = table.filter((r) => r.expected === 'succeed');
  const stopped = table.filter((r) => r.expected === 'stop');
  expect(succeeded.map((r) => r.actual)).toEqual(['SUCCEEDED', 'SUCCEEDED', 'SUCCEEDED', 'SUCCEEDED']);
  expect(stopped.map((r) => r.actual)).toEqual(['STOPPED', 'STOPPED', 'STOPPED', 'STOPPED']);
  expect(succeeded.map((r) => r.name)).toEqual([
    'Read the mainframe DOM (user, tenant, launcher)', "Read another open child frame's DOM",
    'Draw a fake "session expired, sign in" box over the page', 'Call vehicles.list (within its scope)',
  ]);
  expect(stopped.map((r) => r.name)).toEqual([
    'Read the token by name (typeof session)', 'Capture the Authorization header by replacing window.fetch',
    'Call notes.add (outside its scope)', "Read another tenant's data",
  ]);
  await expect(page.locator(`${pane('rogue-inj')} #out tbody tr`).nth(5)).toContainText('no header seen');
  await expect(page.locator(`${pane('rogue-inj')} #out tbody tr`).nth(6)).toContainText('scope_denied');
});

test('T14: two injected frames side by side do not collide in styles or globals', async ({ page }) => {
  await signIn(page, 'alice@acme.test');
  await launch(page, 'notes');
  await launch(page, 'rogue-inj');
  await expect(page.locator(`${pane('rogue-inj')} #run`)).toBeVisible();
  const colours = await page.evaluate(() => {
    const bg = (el: Element | null) => (el ? getComputedStyle(el).backgroundColor : null);
    const notesBtn = document.querySelector('[data-pane-id="notes"] #notes-root')!.shadowRoot!.querySelector('button');
    const rogueBtn = document.querySelector('[data-pane-id="rogue-inj"] #rogue-inj-root')!.shadowRoot!.querySelector('button');
    return { notes: bg(notesBtn), rogue: bg(rogueBtn), mainframe: bg(document.querySelector('#sign-out')), registered: Object.keys((window as any).platform.apps).sort() };
  });
  expect(colours.notes).toBe('rgb(11, 122, 83)');
  expect(colours.rogue).toBe('rgb(179, 38, 30)');
  expect(colours.mainframe).not.toBe(colours.notes);
  expect(colours.mainframe).not.toBe(colours.rogue);
  expect(colours.registered).toEqual(['notes', 'rogue-inj']);
  // closing one leaves the other working
  await page.click('.tab[data-tab-id="rogue-inj"] .tab-close');
  await expect(page.locator(`${pane('notes')} #hello`)).toHaveText('Hello alice @ Acme');
});

test('only 3 frames can be open at once', async ({ page }) => {
  await signIn(page, 'alice@acme.test');
  for (const id of ['notes', 'fleet', 'notes-ro']) await launch(page, id);
  await launch(page, 'rogue-sbx');
  await expect(page.locator('.toast')).toContainText('Close a tab first');
  await expect(page.locator('.tab')).toHaveCount(3);
});

test('T4 / P3: Alice and Carol see different fleets', async ({ page, context, browser }) => {
  await signIn(page, 'alice@acme.test');
  await launch(page, 'fleet');
  await expect(sandbox(page, 'fleet').locator('#t tbody tr')).toHaveCount(6);
  const acme = await sandbox(page, 'fleet').locator('#t tbody tr td:first-child').allTextContents();
  expect(acme).toHaveLength(6);
  expect(acme.every((n) => n.startsWith('Acme'))).toBe(true);
  await expect(sandbox(page, 'fleet').locator('#hello')).toHaveText('Hello alice @ Acme');

  const ctx2 = await browser.newContext(); // a private window: its own cookies
  const p2 = await fresh(ctx2);
  await signIn(p2, 'carol@globex.test');
  await launch(p2, 'fleet');
  await expect(sandbox(p2, 'fleet').locator('#t tbody tr')).toHaveCount(6);
  const globex = await sandbox(p2, 'fleet').locator('#t tbody tr td:first-child').allTextContents();
  expect(globex).toHaveLength(6);
  expect(globex.every((n) => n.startsWith('Globex'))).toBe(true);
  await expect(p2.locator('.launch')).toHaveCount(3); // Globex only gets frames 1, 2 and 4
  await ctx2.close();
  void context;
});

test('T6 / P4: Notes (read-only) is refused in the mainframe, and the audit log shows it', async ({ page }) => {
  await signIn(page, 'alice@acme.test');
  await launch(page, 'notes-ro');
  await expect(sandbox(page, 'notes-ro').locator('#list li').first()).toBeVisible();
  await sandbox(page, 'notes-ro').locator('#add').click();
  await expect(sandbox(page, 'notes-ro').locator('#result')).toHaveText('Refused: scope_denied');
  await page.click('#nav-proof');
  const row = page.locator('#evidence tbody tr', { hasText: 'notes.add' }).first();
  await expect(row).toContainText('denied');
  await expect(row).toContainText('scope_denied');
  await expect(row).toContainText('mainframe');
});

test('T6 (server side): the same call sent straight to the server is 403 scope_denied', async ({ page }) => {
  await signIn(page, 'alice@acme.test');
  // use the Proof Panel's own direct probe: it sends a child token for a read-only frame to /api/rpc
  await page.click('#nav-proof');
  await page.click('#run-demo');
  await expect(page.locator('[data-proof="P4"]')).toHaveAttribute('data-state', 'pass');
  await expect(page.locator('[data-proof="P4"]')).toContainText('403 scope_denied');
});

test('T7 / P5: the same Team Notes is read-only for a viewer and writable for a user', async ({ page, browser }) => {
  await signIn(page, 'dave@acme.test');
  await launch(page, 'notes');
  await expect(page.locator(`${pane('notes')} #hello`)).toHaveText('Hello dave @ Acme');
  await expect(page.locator(`${pane('notes')} #role`)).toHaveText('viewer');
  await page.fill(`${pane('notes')} #text`, 'viewer should not be able to write this');
  await page.click(`${pane('notes')} #add`);
  await expect(page.locator(`${pane('notes')} #err`)).toHaveText('Refused: scope_denied');
  await expect(page.locator(`${pane('notes')} #list li`, { hasText: 'viewer should not' })).toHaveCount(0);
  await expect(page.locator('.launch[data-child-id="notes"] .chip')).toHaveText(['notes.read']);

  const ctx = await browser.newContext();
  const p = await fresh(ctx);
  await signIn(p, 'bob@acme.test');
  await launch(p, 'notes');
  await p.fill(`${pane('notes')} #text`, 'bob can write');
  await p.click(`${pane('notes')} #add`);
  await expect(p.locator(`${pane('notes')} #list li`).first()).toContainText('bob can write');
  await expect(p.locator('.launch[data-child-id="notes"] .chip')).toHaveText(['notes.read', 'notes.write']);
  await ctx.close();
});

test('T9 / P6: Rogue (sandboxed): every attack is stopped', async ({ page }) => {
  await signIn(page, 'alice@acme.test');
  await launch(page, 'rogue-sbx');
  await sandbox(page, 'rogue-sbx').locator('#run').click();
  const rows = sandbox(page, 'rogue-sbx').locator('#out tbody tr');
  await expect(rows).toHaveCount(9);
  await expect(sandbox(page, 'rogue-sbx').locator('#out tbody tr.row-fail')).toHaveCount(0);
  await expect(sandbox(page, 'rogue-sbx').locator('#out tbody tr.row-pass')).toHaveCount(9);
});

test('T16: messages from the wrong window or origin are ignored', async ({ page }) => {
  const rpcCalls: string[] = [];
  page.on('request', (r) => { if (r.url().endsWith('/api/rpc')) rpcCalls.push(r.url()); });
  await signIn(page, 'alice@acme.test');
  await launch(page, 'fleet');
  await expect(sandbox(page, 'fleet').locator('#t tbody tr')).toHaveCount(6);
  const before = rpcCalls.length;
  await page.evaluate(() => {
    // 1. from the mainframe window itself (not the child iframe)
    window.postMessage({ type: 'rpc', id: 1, method: 'vehicles.list', params: {} }, '*');
    // 2. from a different window: a throwaway same-page iframe (about:blank)
    const f = document.createElement('iframe'); f.style.display = 'none';
    f.srcdoc = '<scr' + 'ipt>top.postMessage({type:"rpc",id:2,method:"vehicles.list",params:{}},"*")</scr' + 'ipt>';
    document.body.appendChild(f);
  });
  await page.waitForTimeout(800);
  expect(rpcCalls.length).toBe(before);
});

test('T11 / P7: admin uploads an HTML file and adds a link; both appear and the link shows no session', async ({ page }) => {
  await signIn(page, 'alice@acme.test');
  await page.click('#nav-admin');
  await page.click('#add-child');
  await page.fill('#add-name', 'Mini Report');
  await page.fill('#add-id', 'mini-report');
  await page.selectOption('#add-mode', 'sandboxed');
  await page.setInputFiles('#add-file', {
    name: 'mini.html', mimeType: 'text/html',
    buffer: Buffer.from('<!doctype html><meta charset="utf-8"><h1 id="out">loading</h1><script src="/sdk.js"></script><script>PlatformSDK.connect("mini-report").then(function(a){return a.call("vehicles.list",{})}).then(function(v){document.getElementById("out").textContent="Vehicles: "+v.length})</script>'),
  });
  await expect(page.locator('#add-preview')).toBeVisible();
  await page.check('input[name=scope][value="vehicles.read"]');
  await page.click('#add-save');
  await expect(page.locator('#add-dialog')).toHaveCount(0);
  await expect(page.locator('tr[data-child-id="mini-report"]')).toContainText('vehicles.read');
  await expect(page.locator('tr[data-child-id="mini-report"] pre')).toContainText('"version": "1.0"');

  await page.click('#add-child');
  await page.fill('#add-name', 'Demo link');
  await page.fill('#add-id', 'demo-link');
  await page.selectOption('#add-mode', 'link');
  await page.fill('#add-url', `${CHILD}/c/fleet.html`); // any URL that allows framing
  await page.click('#add-save');
  await expect(page.locator('tr[data-child-id="demo-link"]')).toBeVisible();

  await launch(page, 'mini-report');
  await expect(sandbox(page, 'mini-report').locator('#out')).toHaveText('Vehicles: 6');
  await launch(page, 'demo-link');
  await expect(page.locator(`${pane('demo-link')} .banner`)).toContainText('Session: none');
  await expect(page.locator(`${pane('demo-link')} .banner`)).toContainText('External site. It cannot see your session.');
  await expect(page.locator(`.launch[data-child-id="demo-link"] .chip`)).toHaveText('no session');
  expect(await page.locator(`${pane('demo-link')} iframe`).getAttribute('sandbox')).not.toContain('allow-same-origin');
  // the link's page got no session: it falls back to its own sign-in form after 3 s
  await expect(page.frameLocator(`${pane('demo-link')} iframe`).locator('[data-platform-standalone]')).toBeAttached({ timeout: 10_000 });
});

test('T12 / P8: opening a child frame URL directly shows standalone sign-in', async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await fresh(ctx);
  await page.goto(`${CHILD}/c/fleet.html`);
  const form = page.locator('form').filter({ hasText: 'Sign in' });
  await expect(form).toBeVisible();
  await form.locator('input[name=email]').fill('carol@globex.test');
  await form.locator('input[name=password]').fill('Passw0rd!');
  await form.locator('button[type=submit]').click();
  await expect(page.locator('.badge')).toHaveText('Standalone: signed in directly');
  await expect(page.locator('#hello')).toHaveText('Hello carol @ Globex');
  await expect(page.locator('#t tbody tr')).toHaveCount(6);
  const names = await page.locator('#t tbody tr td:first-child').allTextContents();
  expect(names).toHaveLength(6);
  expect(names.every((n) => n.startsWith('Globex'))).toBe(true);
  // it never touched the mainframe cookie jar: this origin holds no cookies
  expect(await page.evaluate(() => document.cookie)).toBe('');
  // the injected Team Notes file works standalone too
  await page.goto(`${CHILD}/c/notes.html`);
  await page.locator('form').filter({ hasText: 'Sign in' }).locator('input[name=email]').fill('bob@acme.test');
  await page.locator('form').filter({ hasText: 'Sign in' }).locator('input[name=password]').fill('Passw0rd!');
  await page.locator('form').filter({ hasText: 'Sign in' }).locator('button[type=submit]').click();
  await expect(page.locator('#hello')).toHaveText('Hello bob @ Acme');
  await ctx.close();
});

test('standalone sign-in refuses a tenant that cannot open the child frame', async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await fresh(ctx);
  await page.goto(`${CHILD}/c/notes-ro.html`);
  const form = page.locator('form').filter({ hasText: 'Sign in' });
  await form.locator('input[name=email]').fill('carol@globex.test'); // Globex has no Notes (read-only)
  await form.locator('input[name=password]').fill('Passw0rd!');
  await form.locator('button[type=submit]').click();
  await expect(form.locator('.err')).toContainText('cannot open this child frame');
  await ctx.close();
});

test('Proof Panel: token inspector shows decoded claims and a countdown, never the raw token', async ({ page }) => {
  await signIn(page, 'bob@acme.test');
  await launch(page, 'fleet');
  await expect(sandbox(page, 'fleet').locator('#t tbody tr')).toHaveCount(6);
  await page.click('#nav-proof');
  const claims = page.locator('#claims');
  await expect(claims).toContainText('"cid": "fleet"');
  await expect(claims).toContainText('"role": "user"');
  await expect(claims).toContainText('"tenant": "acme"');
  await expect(claims).toContainText('"vehicles.read"');
  await expect(page.locator('#countdown')).toContainText(/Expires in \d+ s/);
  expect(await page.locator('#claims').textContent()).not.toMatch(/eyJ/);
  // live evidence shows the call, allowed, via rpc
  await expect(page.locator('#evidence tbody tr', { hasText: 'vehicles.list' }).first()).toContainText('allowed');
});

test('Proof Panel: "Run the attack demo" turns P1 to P8 green for an admin', async ({ page }) => {
  await signIn(page, 'alice@acme.test');
  await page.click('#nav-proof');
  await page.click('#run-demo');
  for (const p of ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8']) {
    await expect(page.locator(`[data-proof="${p}"]`), p).toHaveAttribute('data-state', 'pass', { timeout: 30_000 });
  }
  // the demo's hidden frame is gone again
  await expect(page.locator('.hidden-frame')).toHaveCount(0);
  // and the evidence table records the denied attempts
  await expect(page.locator('#evidence tbody tr[data-result="denied"]').first()).toBeVisible();
});

test('Proof Panel: viewer role is shown as a pass for P5 with a server-side refusal', async ({ page }) => {
  await signIn(page, 'dave@acme.test');
  await page.click('#nav-proof');
  await page.click('#run-demo');
  await expect(page.locator('[data-proof="P5"]')).toHaveAttribute('data-state', 'pass', { timeout: 30_000 });
  await expect(page.locator('[data-proof="P5"]')).toContainText('403 scope_denied');
});

test('help pages: For website owners and Build this into your platform render, copy and download', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await signIn(page, 'bob@acme.test');
  await page.click('#nav-owners');
  const owners = page.locator('[data-view="owners"]');
  await expect(owners.locator('h1')).toHaveText('What a site owner must do to allow iframing');
  await expect(owners.locator('table').first()).toContainText('frame-ancestors');
  await expect(owners.locator('pre.code').first()).toContainText('headers()');
  await expect(owners.locator('h2')).toHaveCount(8);
  await owners.locator('[data-action=copy]').click();
  await expect(owners.locator('[role=status]')).toContainText('Copied');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('# What a site owner must do to allow iframing');
  await page.click('#nav-platform');
  const plat = page.locator('[data-view="platform"]');
  await expect(plat.locator('h1')).toContainText('adding "embed a website in an iframe"');
  await expect(plat.locator('pre.code', { hasText: 'embedWebsite' })).toBeVisible();
  const dl = page.waitForEvent('download');
  await plat.locator('[data-action=download]').click();
  expect((await dl).suggestedFilename()).toBe('platform-guide.md');
  // no raw markdown syntax leaks into the page
  expect(await plat.locator('.md').innerText()).not.toMatch(/^#{1,4} /m);
});

test('link frames always offer Open in a new tab', async ({ page }) => {
  await signIn(page, 'alice@acme.test');
  await launch(page, 'website');
  const a = page.locator(`${pane('website')} .banner a.open-new`);
  await expect(a).toHaveAttribute('href', 'https://example.com/');
  await expect(a).toHaveAttribute('target', '_blank');
  expect(await page.locator(`${pane('website')} iframe`).getAttribute('sandbox')).toBe('allow-scripts allow-forms allow-popups');
});

test('website demos: collapsed list, nothing open by default, one tab that switches between sites', async ({ page }) => {
  const csp: string[] = [];
  page.on('console', (m) => { if (/Content Security Policy/i.test(m.text())) csp.push(m.text()); });
  await signIn(page, 'bob@acme.test');
  await expect(page.locator('.tab')).toHaveCount(0); // by default no child frame
  const details = page.locator('#demo-sites');
  expect(await details.getAttribute('open')).toBeNull(); // collapsed
  await details.locator('summary').click();
  await expect(details.locator('.demo-site')).toHaveCount(19);

  await details.locator('.demo-site', { hasText: 'Example Domain (org)' }).click();
  await expect(page.locator('.tab')).toHaveCount(1);
  await expect(page.locator('.tab.active')).toContainText('Demo: Example Domain (org)');
  await expect(page.locator(pane('demo-site') + ' iframe')).toHaveAttribute('src', 'https://example.org');
  await expect(page.locator(pane('demo-site') + ' .banner')).toContainText('Session: none');

  await details.locator('.demo-site', { hasText: 'Wikipedia home' }).click();
  await expect(page.locator('.tab')).toHaveCount(1); // same tab, new site
  await expect(page.locator('.tab.active')).toContainText('Demo: Wikipedia home');
  await expect(page.locator(pane('demo-site') + ' iframe')).toHaveCount(1);
  await expect(page.locator(pane('demo-site') + ' iframe')).toHaveAttribute('src', 'https://www.wikipedia.org');
  await expect(page.locator(pane('demo-site') + ' .banner')).toContainText('https://www.wikipedia.org');
  await expect(details.locator('.demo-site.open')).toHaveText('Wikipedia home');
  expect(await page.locator(pane('demo-site') + ' iframe').getAttribute('sandbox')).not.toContain('allow-same-origin');

  // the plain-http page is allowed by the platform CSP too
  await details.locator('.demo-site', { hasText: 'Original WWW project page' }).click();
  await expect(page.locator(pane('demo-site') + ' iframe')).toHaveAttribute('src', 'http://info.cern.ch/hypertext/WWW/TheProject.html');
  await page.waitForTimeout(500);
  expect(csp).toEqual([]);

  // it coexists with a real child frame, and closing the tab clears the highlight
  await launch(page, 'fleet');
  await expect(page.locator('.tab')).toHaveCount(2);
  await page.click('.tab[data-tab-id="demo-site"] .tab-close');
  await expect(page.locator('.tab')).toHaveCount(1);
  await expect(details.locator('.demo-site.open')).toHaveCount(0);
});

test('non-admins have no Admin entry', async ({ page }) => {
  await signIn(page, 'bob@acme.test');
  await expect(page.locator('#nav-admin')).toHaveCount(0);
  await page.click('#nav-about');
  await expect(page.locator('.about')).toContainText('Token model');
  await expect(page.locator('.about .diagram')).toContainText('localhost:3000');
});

test('T13: an expired child token is refreshed once and the call succeeds', async ({ page }) => {
  await signIn(page, 'alice@acme.test');
  await launch(page, 'notes');
  await expect(page.locator(`${pane('notes')} #hello`)).toHaveText('Hello alice @ Acme');
  await expireServerTokens(page, { childTokens: true });
  await page.fill(`${pane('notes')} #text`, 'written after the token expired');
  await page.click(`${pane('notes')} #add`);
  await expect(page.locator(`${pane('notes')} #list li`).first()).toContainText('written after the token expired');
  await expect(page.locator(`${pane('notes')} #err`)).toHaveText('');
  await page.click('#nav-proof');
  await expect(page.locator('#evidence tbody tr', { hasText: 'expired' }).first()).toContainText('denied');
});

test('T13: if the refresh fails too, the user sees "Session expired" and is sent to sign in', async ({ page }) => {
  await signIn(page, 'alice@acme.test');
  await launch(page, 'notes');
  await expect(page.locator(`${pane('notes')} #hello`)).toHaveText('Hello alice @ Acme');
  await expireServerTokens(page, { childTokens: true, accessTokens: true, revokeRefresh: true });
  await page.fill(`${pane('notes')} #text`, 'this should fail');
  await page.click(`${pane('notes')} #add`);
  await expect(page.locator('#login-error')).toHaveText('Session expired, sign in again');
  await expect(page.locator('#login-email')).toBeVisible();
  // signing in again works, and nothing from the old session is left
  await signIn(page, 'alice@acme.test');
  await expect(page.locator('.tab')).toHaveCount(0);
});
