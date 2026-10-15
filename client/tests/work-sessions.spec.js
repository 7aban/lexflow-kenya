import { test, expect } from '@playwright/test';
import path from 'node:path';
import syntheticBackend from './fixtures/work-session-backend.cjs';

let fixture;
const bar = page => page.getByRole('region', { name: 'Persistent work timer', exact: true });
const evidence = name => path.join(process.env.LEXFLOW_104B_EVIDENCE, name);
test.beforeAll(async () => { fixture = await syntheticBackend(); });
test.afterAll(async () => { await fixture?.close(); });
test.beforeEach(async () => { await fixture.reset(); });

async function login(page, client = false) {
  await page.goto('/');
  if (client) await page.getByRole('tab', { name: 'Client Portal', exact: true }).click();
  await page.locator('input[type="email"]').click();
  await page.locator('input[type="email"]').fill(client ? '104b-client@example.test' : '104b-a@example.test');
  await page.locator('input[type="password"]').click();
  await page.locator('input[type="password"]').fill('Synthetic104B!Password');
  const response = page.waitForResponse(response => response.url().endsWith(client ? '/api/auth/client-login' : '/api/auth/login') && response.request().method() === 'POST');
  await page.getByRole('button', { name: client ? 'Enter client portal' : 'Sign in securely', exact: true }).click();
  expect((await response).status()).toBe(200);
  await expect(page.locator('.lf-desktop-sidebar')).toBeAttached();
  if (!client) await expect(bar(page).getByRole('button', { name: 'Start Work', exact: true })).toBeEnabled();
  const dismiss = page.getByRole('button', { name: 'Dismiss notification', exact: true });
  if (await dismiss.isVisible()) await dismiss.click();
}
async function navigate(page, name) {
  await page.locator('.lf-desktop-sidebar').getByRole('button', { name, exact: true }).click();
  await expect(page.getByRole('heading', { name, exact: true }).first()).toBeVisible();
}
async function compose(page, { matter = '104b-A', activity = 'Legal Research', task = '', fromMatter = false } = {}) {
  if (fromMatter) {
    await navigate(page, 'Matters');
    await page.locator('.lf-matter-detail-workspace').getByRole('button', { name: 'Start Work', exact: true }).click();
  } else await bar(page).getByRole('button', { name: 'Start Work', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Start Work', exact: true });
  await dialog.getByLabel('Matter', { exact: true }).selectOption(matter);
  await dialog.getByLabel('Activity', { exact: true }).selectOption(activity);
  await dialog.getByLabel('Task (optional)', { exact: true }).selectOption(task);
  await dialog.getByLabel('Work description (optional)', { exact: true }).fill(`${activity} synthetic work`);
  return dialog;
}
async function start(page, values) {
  const dialog = await compose(page, values);
  await dialog.getByRole('button', { name: /^(Start session|Pause current & start)$/ }).click();
  await expect(dialog).toHaveCount(0);
  await expect(bar(page).getByRole('button', { name: 'Pause work', exact: true })).toBeEnabled();
  return fixture.get("SELECT * FROM work_sessions WHERE userId='104b-a' AND status='running'");
}
async function select(page, id) {
  const selection = bar(page).getByLabel('Saved sessions', { exact: true });
  if (!await selection.isVisible()) await bar(page).getByRole('button', { name: /^Sessions/ }).click();
  await selection.selectOption(id);
}
async function pause(page) {
  await bar(page).getByRole('button', { name: 'Pause work', exact: true }).click();
  await expect(bar(page).getByRole('button', { name: 'Record Time', exact: true })).toBeEnabled();
}
async function token(page) { return page.evaluate(() => JSON.parse(localStorage.getItem('lexflowSession')).token); }

test('matter-first work survives navigation, switching, refresh, reopening and backend restart', async ({ page, browser }) => {
  await login(page);
  const tasksBefore = await fixture.get('SELECT COUNT(*) n FROM tasks');
  const a = await start(page, { fromMatter: true });
  expect(a.taskId).toBeNull();
  expect(await fixture.get('SELECT COUNT(*) n FROM tasks')).toEqual(tasksBefore);
  await fixture.run('UPDATE work_sessions SET lastConfirmedAt=? WHERE id=?', [Date.now() - 65000, a.id]);
  await navigate(page, 'Clients');
  await expect(bar(page)).toContainText('Matter A — Research');
  await pause(page);
  const pausedA = await fixture.get('SELECT * FROM work_sessions WHERE id=?', [a.id]);
  expect(pausedA.accumulatedSeconds).toBeGreaterThanOrEqual(65);
  const b = await start(page, { matter: '104b-B', activity: 'Drafting' });
  await fixture.run('UPDATE work_sessions SET lastConfirmedAt=? WHERE id=?', [Date.now() - 25000, b.id]);
  await select(page, a.id);
  await bar(page).getByRole('button', { name: 'Pause current & resume', exact: true }).click();
  await expect(bar(page).getByRole('button', { name: 'Pause work', exact: true })).toBeEnabled();
  expect((await fixture.get('SELECT * FROM work_sessions WHERE id=?', [b.id])).accumulatedSeconds).toBeGreaterThanOrEqual(25);
  expect((await fixture.get('SELECT * FROM work_sessions WHERE id=?', [a.id])).accumulatedSeconds).toBe(pausedA.accumulatedSeconds);
  await page.reload();
  await expect(bar(page)).toContainText('Matter A — Research');
  await expect(bar(page).getByTestId('work-pending')).toContainText('unsaved');
  await fixture.restart();
  await page.reload();
  await expect(bar(page).getByRole('button', { name: 'Pause work', exact: true })).toBeEnabled();
  expect((await fixture.get('SELECT accumulatedSeconds FROM work_sessions WHERE id=?', [a.id])).accumulatedSeconds).toBe(pausedA.accumulatedSeconds);
  const storageState = await page.context().storageState();
  await page.close();
  const reopened = await browser.newContext({ storageState, serviceWorkers: 'block' });
  try {
    const next = await reopened.newPage(); await next.goto('http://127.0.0.1:5184/');
    await expect(bar(next)).toContainText('Matter A — Research');
    await expect(bar(next).getByRole('button', { name: 'Pause work', exact: true })).toBeEnabled();
    await pause(next);
    const before = await fixture.get('SELECT accumulatedSeconds FROM work_sessions WHERE id=?', [a.id]);
    await next.reload();
    await expect(bar(next).getByRole('button', { name: 'Resume work', exact: true })).toBeEnabled();
    expect(await fixture.get('SELECT accumulatedSeconds FROM work_sessions WHERE id=?', [a.id])).toEqual(before);
    await next.screenshot({ path: evidence('timer-desktop.png'), fullPage: false });
  } finally { await reopened.close(); }
});

test('task entry point uses durable sessions; record response loss and retries create one entry', async ({ page, request }) => {
  await login(page); await navigate(page, 'Matters');
  await page.locator('.lf-matter-cockpit-nav').getByRole('button', { name: /^Tasks/ }).click();
  await page.getByRole('button', { name: 'Start task work', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Start Work', exact: true });
  await expect(dialog.getByLabel('Task (optional)', { exact: true })).toHaveValue('104b-task');
  await dialog.getByRole('button', { name: 'Start session', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const row = await fixture.get("SELECT * FROM work_sessions WHERE status='running'");
  expect(row.taskId).toBe('104b-task');
  await fixture.run('UPDATE work_sessions SET lastConfirmedAt=? WHERE id=?', [Date.now() - 41000, row.id]);
  await pause(page);
  const paused = await fixture.get('SELECT * FROM work_sessions WHERE id=?', [row.id]);
  let submissions = 0;
  await page.route('**/api/work-sessions/*/record', async route => {
    submissions++; const response = await route.fetch(); expect(response.status()).toBe(200); await route.abort('failed');
  }, { times: 1 });
  await bar(page).getByRole('button', { name: 'Record Time', exact: true }).click();
  const record = page.getByRole('dialog', { name: 'Record Time', exact: true });
  await expect(record.getByRole('button', { name: 'Review recording' })).toBeDisabled();
  await record.getByLabel('Work description', { exact: true }).fill('Reviewed synthetic submissions');
  await record.getByLabel('Billing class', { exact: true }).selectOption('false');
  await record.getByRole('button', { name: 'Review recording', exact: true }).click();
  const confirmation = page.getByRole('dialog', { name: 'Confirm recording', exact: true });
  await expect(confirmation).toContainText('Confirmed duration');
  await confirmation.getByRole('button', { name: 'Confirm record time', exact: true }).click({ clickCount: 2 });
  await expect(confirmation).toHaveCount(0);
  await expect(bar(page)).toContainText('response was interrupted');
  await expect(page.getByRole('cell', { name: /^Reviewed synthetic submissions/ })).toBeVisible();
  expect(submissions).toBe(1);
  const entry = await fixture.get('SELECT * FROM time_entries');
  expect(entry).toMatchObject({ taskId: '104b-task', billable: 0, description: 'Reviewed synthetic submissions', hours: paused.accumulatedSeconds / 3600 });
  expect((await fixture.get('SELECT COUNT(*) n FROM time_entries')).n).toBe(1);
  const retry = await request.post(`http://127.0.0.1:5294/api/work-sessions/${row.id}/record`, { headers: { Authorization: `Bearer ${await token(page)}` }, data: { version: paused.version, billable: false } });
  expect(retry.status()).toBe(200); expect((await retry.json()).id).toBe(entry.id);
  await page.reload();
  await expect(bar(page).getByRole('button', { name: 'Record Time', exact: true })).toHaveCount(0);
  expect((await fixture.get('SELECT COUNT(*) n FROM time_entries')).n).toBe(1);
});

test('30-second confirmation uses current server versions; suspended intervals require explicit review', async ({ page }) => {
  await page.clock.install();
  await login(page); const row = await start(page);
  const versions = [];
  page.on('request', request => { if (request.url().endsWith('/confirm')) versions.push(request.postDataJSON().version); });
  await page.clock.fastForward(30050);
  await expect.poll(async () => (await fixture.get('SELECT version FROM work_sessions WHERE id=?', [row.id])).version).toBeGreaterThan(row.version);
  const firstVersion = (await fixture.get('SELECT version FROM work_sessions WHERE id=?', [row.id])).version;
  await page.clock.fastForward(30050);
  await expect.poll(async () => (await fixture.get('SELECT version FROM work_sessions WHERE id=?', [row.id])).version).toBeGreaterThan(firstVersion);
  expect(versions[1]).toBeGreaterThan(versions[0]);
  const confirmed = (await fixture.get('SELECT accumulatedSeconds FROM work_sessions WHERE id=?', [row.id])).accumulatedSeconds;
  await fixture.run('UPDATE work_sessions SET lastConfirmedAt=? WHERE id=?', [Date.now() - 8 * 3600000, row.id]);
  await page.reload();
  await expect(bar(page)).toContainText('Review required');
  expect((await fixture.get('SELECT accumulatedSeconds FROM work_sessions WHERE id=?', [row.id])).accumulatedSeconds).toBe(confirmed);
  await expect(bar(page).getByRole('button', { name: 'Resume work', exact: true })).toHaveCount(0);
  await bar(page).getByRole('button', { name: 'Review uncertain time', exact: true }).click();
  await page.getByRole('dialog', { name: 'Review uncertain time' }).getByRole('button', { name: 'Cancel', exact: true }).click();
  expect((await fixture.get('SELECT recoveryRequired FROM work_sessions WHERE id=?', [row.id])).recoveryRequired).toBe(1);
  await bar(page).getByRole('button', { name: 'Review uncertain time', exact: true }).click();
  await page.getByRole('button', { name: 'Discard unconfirmed time', exact: true }).click();
  await expect(bar(page).getByRole('button', { name: 'Resume work', exact: true })).toBeEnabled();
  expect((await fixture.get('SELECT accumulatedSeconds FROM work_sessions WHERE id=?', [row.id])).accumulatedSeconds).toBe(confirmed);
});

test('two tabs overlap independent starts without creating a second running session', async ({ page, context }) => {
  await login(page);
  const other = await context.newPage(); await other.goto('/');
  await expect(bar(other).getByRole('button', { name: 'Start Work', exact: true })).toBeEnabled();
  const one = await compose(page), two = await compose(other, { matter: '104b-B', activity: 'Drafting' });
  let arrivals = 0, release;
  const barrier = new Promise(resolve => { release = resolve; });
  for (const tab of [page, other]) await tab.route('**/api/work-sessions', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    arrivals++; if (arrivals === 2) release();
    await barrier; await route.continue();
  });
  await Promise.all([one.getByRole('button', { name: 'Start session', exact: true }).click(), two.getByRole('button', { name: 'Start session', exact: true }).click()]);
  await expect(one).toHaveCount(0); await expect(two).toHaveCount(0);
  expect(arrivals).toBe(2);
  expect((await fixture.get("SELECT COUNT(*) n FROM work_sessions WHERE status='running'")).n).toBe(1);
  expect((await fixture.get('SELECT COUNT(*) n FROM work_sessions')).n).toBe(1);
  expect((await fixture.get('SELECT COUNT(*) n FROM time_entries')).n).toBe(0);
  await other.close();
});

test('network failure and stale versions reload state before another mutation', async ({ page, context, request }) => {
  await login(page); const row = await start(page);
  await context.setOffline(true);
  await bar(page).getByRole('button', { name: 'Pause work', exact: true }).click();
  await expect(bar(page).getByRole('alert')).toContainText('Connection');
  expect((await fixture.get('SELECT status FROM work_sessions WHERE id=?', [row.id])).status).toBe('running');
  await context.setOffline(false);
  await bar(page).getByRole('button', { name: 'Reconnect / reload', exact: true }).first().click();
  await expect(bar(page).getByRole('button', { name: 'Pause work', exact: true })).toBeEnabled();
  const auth = await token(page);
  await page.route('**/api/work-sessions/*/pause', async route => {
    const fresh = await fixture.get('SELECT version FROM work_sessions WHERE id=?', [row.id]);
    const response = await request.post(`http://127.0.0.1:5294/api/work-sessions/${row.id}/confirm`, { headers: { Authorization: `Bearer ${auth}` }, data: { version: fresh.version } });
    expect(response.status()).toBe(200); await route.continue();
  }, { times: 1 });
  await bar(page).getByRole('button', { name: 'Pause work', exact: true }).click();
  await expect(bar(page).getByRole('alert')).toContainText('Session changed');
  expect((await fixture.get('SELECT status FROM work_sessions WHERE id=?', [row.id])).status).toBe('running');
  await pause(page);
});

test('manual time entry stays available and inaccessible matter/task associations stay blocked', async ({ page, request }) => {
  await login(page); await navigate(page, 'Matters');
  await page.locator('.lf-matter-cockpit-nav').getByRole('button', { name: /^Tasks/ }).click();
  await page.getByRole('button', { name: 'Log time', exact: true }).click();
  await page.getByLabel('Hours', { exact: true }).fill('0.75');
  const form = page.locator('form').filter({ has: page.getByLabel('Hours', { exact: true }) });
  await form.getByLabel('Description', { exact: true }).fill('Separately verified manual work');
  await form.getByRole('button', { name: 'Log time', exact: true }).click();
  await expect.poll(async () => (await fixture.get('SELECT COUNT(*) n FROM time_entries')).n).toBe(1);
  expect((await fixture.get('SELECT hours FROM time_entries')).hours).toBe(0.75);
  const dialog = await compose(page);
  await expect(dialog.getByLabel('Matter', { exact: true }).locator('option')).not.toContainText(['Inaccessible matter']);
  await expect(dialog.getByLabel('Task (optional)', { exact: true }).locator('option')).not.toContainText(['Delegated inaccessible work']);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  const response = await request.post('http://127.0.0.1:5294/api/work-sessions', { headers: { Authorization: `Bearer ${await token(page)}` }, data: { matterId: '104b-hidden', taskId: '104b-delegated' } });
  expect(response.status()).toBe(403);
  expect((await fixture.get('SELECT COUNT(*) n FROM work_sessions')).n).toBe(0);
});

test('access loss, expired auth and cross-tab account changes clear session controls', async ({ page, context }) => {
  await login(page); const row = await start(page);
  // Existing authentication also accepts a token-only stored login. Identity
  // still comes from /auth/me; session timing must come from the backend.
  await page.evaluate(() => localStorage.removeItem('lexflowSession'));
  await page.reload();
  await expect(bar(page)).toContainText('Matter A — Research');
  await expect(bar(page).getByRole('button', { name: 'Pause work', exact: true })).toBeEnabled();
  await fixture.run("UPDATE matters SET assignedTo='Other Advocate' WHERE id='104b-A'");
  await page.reload();
  await expect(bar(page)).not.toContainText('Matter A — Research');
  await expect(bar(page).getByRole('button', { name: 'Pause work', exact: true })).toHaveCount(0);
  await fixture.run("UPDATE matters SET assignedTo='Timer Advocate' WHERE id='104b-A'");
  await page.reload(); await expect(bar(page)).toContainText('Matter A — Research');
  const other = await context.newPage(); await other.goto('/');
  await other.evaluate(() => { localStorage.removeItem('lexflowSession'); localStorage.removeItem('lexflowToken'); });
  await expect(bar(page)).not.toContainText('Matter A — Research');
  await other.close();
  await page.reload(); await login(page);
  await fixture.run("UPDATE users SET tokenVersion=2 WHERE id='104b-a'");
  await bar(page).getByRole('button', { name: /^Sessions/ }).click();
  await bar(page).getByRole('button', { name: 'Reconnect / reload', exact: true }).click();
  await expect(bar(page)).toHaveCount(0);
  expect((await fixture.get('SELECT accumulatedSeconds FROM work_sessions WHERE id=?', [row.id])).accumulatedSeconds).toBeGreaterThanOrEqual(0);
});

test('390px timer/start/review layout is usable and client portal has no controls', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  await start(page, { matter: '104b-B', activity: 'Drafting' });
  await expect(bar(page).getByRole('button', { name: 'Pause work', exact: true })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: evidence('timer-390.png'), fullPage: false });
  await pause(page); await bar(page).getByRole('button', { name: 'Record Time', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Record Time', exact: true })).toBeInViewport();
  const bounds = await page.getByRole('dialog', { name: 'Record Time', exact: true }).evaluate(dialog => {
    const controls = [dialog, ...dialog.querySelectorAll('button,input,select')];
    return controls.every(element => { const box = element.getBoundingClientRect(); return box.left >= 0 && box.right <= innerWidth; });
  });
  expect(bounds).toBe(true);
  await page.screenshot({ path: evidence('timer-record-390.png'), fullPage: false });
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.evaluate(() => { localStorage.removeItem('lexflowSession'); localStorage.removeItem('lexflowToken'); });
  await login(page, true);
  await expect(bar(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Open persistent work timer', exact: true })).toHaveCount(0);
});
