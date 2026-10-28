// The common platform features: navigation by role, App Store, users, groups, roles, access management, reports.
// Named zz- so it runs after poc.spec.ts (the reports test relies on the activity those tests produced).
import { test, expect, type Page, type BrowserContext } from '@playwright/test';

async function signIn(page: Page, email: string, password = 'Passw0rd!') {
  await page.goto('/');
  await page.fill('#login-email', email);
  await page.fill('#login-password', password);
  await page.click('button[type=submit]');
  await expect(page.locator('#user-name')).toHaveText(email.split('@')[0]);
}
const pane = (id: string) => `[data-pane-id="${id}"]`;
const fresh = (ctx: BrowserContext) => ctx.newPage();

test.describe.configure({ mode: 'serial' });

test('navigation: the mainframe owns the common features, shown by role', async ({ browser }) => {
  const seen = async (email: string) => {
    const ctx = await browser.newContext();
    const p = await fresh(ctx);
    await signIn(p, email);
    const ids = await p.locator('#launcher .nav-btn').evaluateAll((els) => els.map((e) => e.id));
    await ctx.close();
    return ids;
  };
  expect(await seen('alice@acme.test')).toEqual(['nav-store', 'nav-reports', 'nav-users', 'nav-groups', 'nav-roles', 'nav-access', 'nav-admin', 'nav-proof', 'nav-about', 'nav-owners', 'nav-platform']);
  expect(await seen('bob@acme.test')).toEqual(['nav-store', 'nav-reports', 'nav-proof', 'nav-about', 'nav-owners', 'nav-platform']);
  expect(await seen('dave@acme.test')).toEqual(['nav-store', 'nav-proof', 'nav-about', 'nav-owners', 'nav-platform']); // a viewer: no reports, no administration
});

test('App Store: an admin installs an app, it appears in My apps as an iframe, and uninstalling removes it', async ({ page }) => {
  await signIn(page, 'carol@globex.test');
  await expect(page.locator('.launch[data-child-id="python-docs"]')).toHaveCount(0);
  await page.click('#nav-store');
  const card = page.locator('.store-card[data-app-id="python-docs"]');
  await expect(card).toContainText('Python docs');
  await card.locator('[data-action=install]').click();
  await expect(page.locator('#install-dialog')).toContainText('It gets no session');
  await page.click('#confirm-install');
  await expect(page.locator('.toast')).toContainText('Python docs installed');
  await expect(card.locator('[data-status=installed]')).toBeVisible();
  const launchBtn = page.locator('.launch[data-child-id="python-docs"]');
  await expect(launchBtn).toBeVisible();
  await card.locator('[data-action=open]').click();
  await expect(page.locator(pane('python-docs') + ' iframe')).toHaveAttribute('src', 'https://docs.python.org/3/');
  await expect(page.locator(pane('python-docs') + ' .banner')).toContainText('Session: none');
  await page.click('#nav-store');
  const card2 = page.locator('.store-card[data-app-id="python-docs"]');
  await card2.locator('[data-action=uninstall]').click();
  await page.click('#confirm-uninstall');
  await expect(launchBtn).toHaveCount(0);
  await expect(card2.locator('[data-action=install]')).toBeVisible();
});

test('App Store: a viewer can browse but not install; search and tabs filter the catalog', async ({ page }) => {
  await signIn(page, 'dave@acme.test');
  await page.click('#nav-store');
  await expect(page.locator('#store-note')).toContainText('Only an administrator can install');
  await expect(page.locator('[data-action=install]')).toHaveCount(0);
  await expect(page.locator('.store-card[data-app-id="wikipedia"]')).toContainText('Ask an admin to install');
  await page.fill('#store-search', 'wikipedia');
  await expect(page.locator('.store-card')).toHaveCount(1);
  await page.fill('#store-search', '');
  await page.click('[data-tab="installed"]');
  await expect(page.locator('.store-card[data-app-id="wikipedia"]')).toHaveCount(0);
  await expect(page.locator('.store-card[data-app-id="fleet"]')).toHaveCount(1);
  await page.click('[data-tab="available"]');
  await expect(page.locator('.store-card[data-app-id="wikipedia"]')).toHaveCount(1);
});

test('Access management: Notes (read-only) is for Auditors only; Bob does not get it, Dave does', async ({ browser }) => {
  const bobCtx = await browser.newContext();
  const bob = await fresh(bobCtx);
  await signIn(bob, 'bob@acme.test');
  await expect(bob.locator('.launch[data-child-id="notes-ro"]')).toHaveCount(0);
  await bob.click('#nav-store');
  const c = bob.locator('.store-card[data-app-id="notes-ro"]');
  await expect(c).toContainText('Restricted');
  await expect(c.locator('[data-action=open]')).toHaveCount(0);
  await bobCtx.close();
  const daveCtx = await browser.newContext();
  const dave = await fresh(daveCtx);
  await signIn(dave, 'dave@acme.test');
  await expect(dave.locator('.launch[data-child-id="notes-ro"]')).toBeVisible();
  await daveCtx.close();
});

test('Administration: users, groups, roles and access management work together', async ({ page, browser }) => {
  await signIn(page, 'alice@acme.test');

  // Roles: the matrix
  await page.click('#nav-roles');
  const matrix = page.locator('#roles-matrix');
  await expect(matrix.locator('tr[data-key="users.manage"] td[data-on]')).toHaveText(['✔', '–', '–']);
  await expect(matrix.locator('tr[data-key="notes.write"] td[data-on]')).toHaveText(['✔', '✔', '–']);
  await expect(page.locator('.role-card[data-role="viewer"]')).toContainText('Read-only');

  // Users: add one
  await page.click('#nav-users');
  await expect(page.locator('#users-table tr[data-user="bob@acme.test"]')).toContainText('Operations');
  await expect(page.locator('#users-table tr[data-user="alice@acme.test"] select')).toBeDisabled(); // you cannot demote yourself
  await page.click('#add-user');
  await page.fill('#new-user-email', 'zed@acme.test');
  await page.fill('#new-user-password', 'a-long-password');
  await page.selectOption('#new-user-role', 'user');
  await page.click('#save-user');
  await expect(page.locator('#users-table tr[data-user="zed@acme.test"]')).toBeVisible();

  // Groups: create QA and put Zed in it
  await page.click('#nav-groups');
  await page.click('#add-group');
  await page.fill('#new-group-name', 'QA');
  await page.click('#save-group');
  const qa = page.locator('.group-card[data-group="QA"]');
  await qa.locator('[data-action=members]').click();
  await page.locator('dialog').getByLabel('zed@acme.test').check();
  await page.click('#save-members');
  await expect(qa).toContainText('zed@acme.test');

  // Access: restrict Fleet Viewer to QA
  await page.click('#nav-access');
  const row = page.locator('#access-table tr[data-app-id="fleet"]');
  await expect(row.locator('td[data-access]')).toHaveAttribute('data-access', 'everyone');
  await row.locator('[data-action=edit-access]').click();
  await page.locator('dialog').getByLabel('QA').check();
  await page.click('#save-access');
  await expect(row.locator('td[data-access]')).toHaveAttribute('data-access', 'restricted');
  await expect(row).toContainText('QA');

  // Zed (in QA) sees Fleet Viewer; Bob (not in QA) does not; the admin still does
  const zedCtx = await browser.newContext();
  const zed = await fresh(zedCtx);
  await signIn(zed, 'zed@acme.test', 'a-long-password');
  await expect(zed.locator('.launch[data-child-id="fleet"]')).toBeVisible();
  const bobCtx = await browser.newContext();
  const bob = await fresh(bobCtx);
  await signIn(bob, 'bob@acme.test');
  await expect(bob.locator('.launch[data-child-id="fleet"]')).toHaveCount(0);
  await expect(page.locator('.launch[data-child-id="fleet"]')).toBeVisible();

  // Disabling Zed ends their session at once
  await page.click('#nav-users');
  await page.locator('#users-table tr[data-user="zed@acme.test"] [data-action=disable]').click();
  await expect(page.locator('#users-table tr[data-user="zed@acme.test"]')).toContainText('disabled');
  await zed.reload();
  await expect(zed.locator('#login-email')).toBeVisible(); // the refresh cookie no longer works
  await zed.fill('#login-email', 'zed@acme.test');
  await zed.fill('#login-password', 'a-long-password');
  await zed.click('button[type=submit]');
  await expect(zed.locator('#login-error')).toContainText('This account is disabled');
  await zedCtx.close();

  // Put things back for the other tests: Fleet Viewer open to everyone again
  await page.click('#nav-access');
  await page.locator('#access-table tr[data-app-id="fleet"] [data-action=edit-access]').click();
  await page.locator('dialog').getByLabel('QA').uncheck();
  await page.click('#save-access');
  await expect(page.locator('#access-table tr[data-app-id="fleet"] td[data-access]')).toHaveAttribute('data-access', 'everyone');
  await bob.reload();
  await expect(bob.locator('.launch[data-child-id="fleet"]')).toBeVisible();
  await bobCtx.close();
});

test('Reports: totals, usage per app and person, denied reasons and CSV export', async ({ page }) => {
  await signIn(page, 'alice@acme.test');
  await page.click('#nav-reports');
  await expect(page.locator('[data-stat="calls"] .stat-n')).not.toHaveText('0');
  await expect(page.locator('[data-stat="denied"] .stat-n')).not.toHaveText('0'); // earlier tests produced refusals
  expect(Number(await page.locator('[data-stat="apps"] .stat-n').textContent())).toBeGreaterThanOrEqual(6); // the 6 seeded apps plus any added by earlier tests
  await expect(page.locator('#report-apps tr[data-app-id="notes"]')).toContainText('Team Notes');
  await expect(page.locator('#report-apps tr[data-app-id="website"]')).toContainText('n/a (no session)');
  await expect(page.locator('#report-users tr[data-user="bob@acme.test"]')).toBeVisible();
  await expect(page.locator('#report-denied')).toContainText('scope_denied');
  await expect(page.locator('#report-admin')).toContainText('user.create');
  const people = await page.locator('#report-users tr[data-user]').evaluateAll((r) => r.map((x) => x.getAttribute('data-user')));
  expect(people).not.toContain('carol@globex.test'); // only your own organization
  await expect(page.locator('#bars .bar-col')).toHaveCount(7);
  await page.selectOption('#report-days', '30');
  await expect(page.locator('#bars .bar-col')).toHaveCount(30);
  const dl = page.waitForEvent('download');
  await page.locator('#report-users').locator('xpath=ancestor::div[contains(@class,"card")]').locator('[data-action=csv]').click();
  expect((await dl).suggestedFilename()).toBe('usage-by-person.csv');
});

test('uninstall from My apps closes its tab, and it can be reinstalled from the App Store', async ({ page, browser }) => {
  await signIn(page, 'alice@acme.test');
  // install Wikipedia, open it
  await page.click('#nav-store');
  await page.locator('.store-card[data-app-id="wikipedia"] [data-action=install]').click();
  await page.click('#confirm-install');
  const entry = page.locator('.launch[data-child-id="wikipedia"]');
  await expect(entry).toBeVisible();
  await entry.click();
  await expect(page.locator(pane('wikipedia') + ' iframe')).toHaveAttribute('src', 'https://www.wikipedia.org');
  await expect(page.locator('.tab')).toHaveCount(1);

  // uninstall straight from the My apps list
  await page.locator('[data-action="uninstall-app"][data-for="wikipedia"]').click();
  await expect(page.locator('#uninstall-dialog')).toContainText('You can reinstall it any time from the App Store');
  await page.click('#confirm-uninstall');
  await expect(entry).toHaveCount(0);
  await expect(page.locator('.tab')).toHaveCount(0); // its tab closed
  await expect(page.locator(pane('wikipedia'))).toHaveCount(0);
  await expect(page.locator('.toast')).toContainText('uninstalled');

  // the toast leads straight back to the store, where it can be installed again
  await page.locator('.toast-action').click();
  const card = page.locator('.store-card[data-app-id="wikipedia"]');
  await expect(card.locator('[data-action=install]')).toBeVisible();
  await card.locator('[data-action=install]').click();
  await page.click('#confirm-install');
  await expect(page.locator('.launch[data-child-id="wikipedia"]')).toBeVisible();
  await card.locator('[data-action=open]').click();
  await expect(page.locator(pane('wikipedia') + ' iframe')).toHaveAttribute('src', 'https://www.wikipedia.org');

  // uninstalling from the store closes an open tab too
  await page.click('#nav-store');
  await card.locator('[data-action=uninstall]').click();
  await page.click('#confirm-uninstall');
  await expect(page.locator('.tab')).toHaveCount(0);
  await expect(card.locator('[data-action=install]')).toBeVisible();

  // a regular user has no uninstall button
  const ctx = await browser.newContext();
  const bob = await ctx.newPage();
  await signIn(bob, 'bob@acme.test');
  await expect(bob.locator('.launch').first()).toBeVisible();
  await expect(bob.locator('[data-action="uninstall-app"]')).toHaveCount(0);
  await ctx.close();
});
