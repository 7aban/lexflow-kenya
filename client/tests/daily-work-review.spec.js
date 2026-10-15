import { test, expect } from '@playwright/test';
import path from 'node:path';
import dailyBackend from './fixtures/daily-review-backend.cjs';

let fixture;
const review = page => page.getByRole('dialog', { name: 'Daily Work Review', exact: true });
const bar = page => page.getByRole('region', { name: 'Persistent work timer', exact: true });
const evidence = file => path.join(process.env.LEXFLOW_104B_EVIDENCE, file);
test.beforeAll(async () => { fixture = await dailyBackend(); });
test.afterAll(async () => { await fixture?.close(); });
test.beforeEach(async () => { await fixture.reset(); await fixture.seedRecorded(); });

async function login(page, client = false) {
  await page.goto('/');
  if (client) await page.getByRole('tab', { name: 'Client Portal', exact: true }).click();
  await page.locator('input[type=email]').click();
  await page.locator('input[type=email]').fill(client ? '104b-client@example.test' : '104b-a@example.test');
  await page.locator('input[type=password]').click();
  await page.locator('input[type=password]').fill('Synthetic104B!Password');
  await page.getByRole('button', { name: client ? 'Enter client portal' : 'Sign in securely', exact: true }).click();
  if (!client) await expect(bar(page).getByRole('button', { name: 'Start Work', exact: true })).toBeEnabled();
}
async function open(page) {
  await bar(page).getByRole('button', { name: 'Daily Work Review', exact: true }).click();
  await expect(review(page).getByTestId('daily-total')).toBeVisible();
  return review(page);
}
async function expectedTotals(page) {
  const response = await page.request.get(`/api/daily-work-review?date=${fixture.today()}`, { headers: { Authorization: await page.evaluate(() => `Bearer ${JSON.parse(localStorage.getItem('lexflowSession')).token}`) } });
  expect(response.status()).toBe(200);
  const data = await response.json();
  await expect(review(page).getByTestId('daily-total')).toHaveText(`${data.totals.totalHours} h`);
  return data;
}

async function inspectDialog(page, dialog, name) {
  await expect(dialog).toBeVisible();
  const bounds = await dialog.boundingBox(), viewport = page.viewportSize();
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.y).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height);
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  const controls = dialog.locator('button,input,select,textarea');
  for (const control of await controls.all()) {
    await control.scrollIntoViewIfNeeded();
    const box = await control.boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(bounds.x);
    expect(box.x + box.width).toBeLessThanOrEqual(bounds.x + bounds.width);
    expect(box.y).toBeGreaterThanOrEqual(bounds.y);
    expect(box.y + box.height).toBeLessThanOrEqual(bounds.y + bounds.height);
  }
  const size = await dialog.evaluate(element => ({ height: element.clientHeight, scroll: element.scrollHeight }));
  for (let offset = 0, shot = 1; offset < size.scroll; offset += Math.max(1, size.height - 80), shot++) {
    await dialog.evaluate((element, top) => { element.scrollTop = top; }, offset);
    await page.screenshot({ path: evidence(`${name}-${shot}.png`), fullPage: false });
  }
  await dialog.evaluate(element => { element.scrollTop = 0; });
}

test('staff review groups saved work, respects server totals and uncertainty, and opening creates no entries', async ({ page }) => {
  const before = await fixture.get('SELECT COUNT(*) n FROM time_entries');
  const mutations = [];
  page.on('request', request => { if (/\/api\/(time-entries|work-sessions)/.test(request.url()) && request.method() !== 'GET') mutations.push(request.url()); });
  await login(page); const dialog = await open(page);
  await expect(dialog.getByTestId('daily-total')).toHaveText('1.775 h');
  await expect(dialog.getByTestId('daily-billable')).toHaveText('1.275 h');
  await expect(dialog.getByTestId('daily-non-billable')).toHaveText('0.5 h');
  const confirmed = dialog.getByRole('region', { name: 'Confirmed personal work', exact: true });
  await expect(confirmed.getByRole('article')).toHaveCount(3);
  await expect(confirmed).toContainText('104b-A · Matter A — Research');
  await expect(confirmed).toContainText('104b-B · Matter B — Drafting');
  await expect(confirmed).toContainText('Linked work session');
  await expect(confirmed.getByRole('article', { name: 'Time entry daily-manual', exact: true })).toContainText('Source not established');
  const unverified = dialog.getByRole('region', { name: 'Older entries requiring attribution verification', exact: true });
  await expect(unverified.getByRole('article')).toHaveCount(2);
  await expect(unverified).toContainText('Conflicting identity evidence');
  await expect(unverified).toContainText('excluded from confirmed totals');
  await expect(dialog).not.toContainText('Other worker private work');
  await expect(dialog).not.toContainText('Inaccessible recorded work');
  await expect(dialog).not.toContainText('Private session narrative');
  await expect(dialog.getByRole('article', { name: 'Time entry daily-missing', exact: true })).toContainText('Description needs attention');
  expect(await fixture.get('SELECT COUNT(*) n FROM time_entries')).toEqual(before);
  expect(mutations).toEqual([]);
  await page.screenshot({ path: evidence('daily-review-desktop.png'), fullPage: false });
  await inspectDialog(page, dialog, 'daily-review-desktop-scroll');
});

test('explicit Nairobi midnight defaults and historical selection retain saved date precision', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-10-14T20:59:59.999Z'));
  await login(page); let dialog = await open(page);
  await expect(dialog.getByLabel('Work date', { exact: true })).toHaveValue('2026-10-14');
  await page.clock.setFixedTime(new Date('2026-10-14T21:00:00Z'));
  await page.reload(); dialog = await open(page);
  await expect(dialog.getByLabel('Work date', { exact: true })).toHaveValue('2026-10-15');
  await dialog.getByLabel('Work date', { exact: true }).fill('2024-02-29');
  await expect(dialog).toContainText('Historical saved work date');
  await expect(dialog.getByTestId('daily-total')).toHaveText('0.1234567 h');
  await dialog.getByRole('button', { name: 'Refresh review', exact: true }).click();
  await expect(dialog.getByTestId('daily-total')).toHaveText('0.1234567 h');
  await expect(dialog.getByLabel('Work date', { exact: true })).toHaveValue('2024-02-29');
  await dialog.getByLabel('Work date', { exact: true }).fill('2024-02-28');
  await expect(dialog).toContainText('No confirmed personal time recorded for this day.');
  await expect(dialog.getByRole('region', { name: 'Older entries requiring attribution verification' })).toHaveCount(0);
  await inspectDialog(page, dialog, 'daily-empty-desktop');
});

test('outstanding sessions stay separate and reuse pause, resume, review and record dialogs', async ({ page }) => {
  await fixture.seedOutstanding();
  await login(page); const dialog = await open(page);
  const outstanding = dialog.getByRole('region', { name: 'Outstanding work', exact: true });
  await expect(outstanding.getByRole('article')).toHaveCount(3);
  await expect(outstanding).toContainText('Pending estimate');
  await expect(dialog.getByTestId('daily-total')).toHaveText('1.775 h');
  await inspectDialog(page, dialog, 'daily-unfinished-desktop');
  const recovery = outstanding.getByRole('article', { name: 'Outstanding session daily-recovery', exact: true });
  await expect(recovery.getByRole('button', { name: 'Resume work', exact: true })).toHaveCount(0);
  await recovery.getByRole('button', { name: 'Review uncertain time', exact: true }).click();
  await page.getByRole('dialog', { name: 'Review uncertain time', exact: true }).getByRole('button', { name: 'Cancel', exact: true }).click();
  expect((await fixture.get("SELECT recoveryRequired FROM work_sessions WHERE id='daily-recovery'")).recoveryRequired).toBe(1);
  await recovery.getByRole('button', { name: 'Review uncertain time', exact: true }).click();
  await page.getByRole('dialog', { name: 'Review uncertain time', exact: true }).getByRole('button', { name: 'Discard unconfirmed time', exact: true }).click();
  await expect(recovery.getByRole('button', { name: 'Resume work', exact: true })).toHaveCount(0); // A different session is running.
  const paused = outstanding.getByRole('article', { name: 'Outstanding session daily-paused', exact: true });
  await paused.getByRole('button', { name: 'Pause current & resume', exact: true }).click();
  await paused.getByRole('button', { name: 'Pause work', exact: true }).click();
  await paused.getByRole('button', { name: 'Record Time', exact: true }).click();
  const record = page.getByRole('dialog', { name: 'Record Time', exact: true });
  await record.getByLabel('Billing class', { exact: true }).selectOption('false');
  await record.getByRole('button', { name: 'Review recording', exact: true }).click();
  await page.getByRole('dialog', { name: 'Confirm recording', exact: true }).getByRole('button', { name: 'Confirm record time', exact: true }).click();
  await expect(paused).toHaveCount(0);
  await expect(dialog.getByRole('region', { name: 'Confirmed personal work', exact: true })).toContainText('Older paused preparation');
  await expectedTotals(page);
  expect((await fixture.get("SELECT COUNT(*) n FROM time_entries WHERE description='Older paused preparation'")).n).toBe(1);
  await dialog.getByLabel('Work date', { exact: true }).fill('2024-02-28');
  await expect(dialog).toContainText('No confirmed personal time recorded');
  await expect(outstanding.getByRole('article')).toHaveCount(2);
});

test('manual additions and missing-description editing use existing matter forms and refresh both tabs', async ({ page, context }) => {
  let releaseOld;
  const oldResponses = [];
  const barrier = new Promise(resolve => { releaseOld = resolve; });
  await page.route('**/api/matters/104b-A', route => {
    const delivered = (async () => { const response = await route.fetch(); await barrier; await route.fulfill({ response }); })();
    oldResponses.push(delivered); return delivered;
  });
  await login(page); let dialog = await open(page);
  const other = await context.newPage(); await other.goto('/'); await open(other);
  await dialog.getByLabel('Matter for manual time', { exact: true }).selectOption('104b-B');
  await dialog.getByRole('button', { name: 'Add Manual Time', exact: true }).click();
  const form = page.locator('#matter-section-time');
  await expect(form).toBeVisible();
  expect(oldResponses.length).toBeGreaterThan(0);
  releaseOld(); await Promise.all(oldResponses);
  await page.unroute('**/api/matters/104b-A');
  await form.getByLabel('Hours', { exact: true }).fill('0.75');
  await form.getByLabel('Description', { exact: true }).fill('Manual addition through existing workflow');
  await form.getByRole('button', { name: 'Log time', exact: true }).click();
  await expect(form).toHaveCount(0);
  dialog = await open(page);
  await expect(dialog).toContainText('Manual addition through existing workflow');
  await expect(review(other)).toContainText('Manual addition through existing workflow');
  expect((await fixture.get("SELECT performedByUserId FROM time_entries WHERE description='Manual addition through existing workflow'")).performedByUserId).toBe('104b-a');
  expect((await fixture.get("SELECT matterId FROM time_entries WHERE description='Manual addition through existing workflow'")).matterId).toBe('104b-B');
  await dialog.getByRole('article', { name: 'Time entry daily-missing', exact: true }).getByRole('button', { name: 'Open time entry editor', exact: true }).click();
  const editedRow = page.locator('.lf-time-entry-cards tbody tr').filter({ has: page.locator('input[type=date]') });
  await expect(editedRow).toHaveCount(1);
  await editedRow.getByPlaceholder('e.g. Drafting, Legal research, Court attendance', { exact: true }).fill('Verified complete work description');
  await editedRow.evaluate(element => element.scrollIntoView({ block: 'center', behavior: 'instant' }));
  await editedRow.getByRole('button', { name: 'More actions', exact: true }).click();
  await expect(editedRow.getByRole('menuitem', { name: 'Save', exact: true })).toBeInViewport();
  await page.screenshot({ path: evidence('daily-existing-editor-save.png'), fullPage: false });
  await editedRow.getByRole('menuitem', { name: 'Save', exact: true }).click();
  dialog = await open(page);
  await expect(dialog).toContainText('Verified complete work description');
  await expect(review(other)).toContainText('Verified complete work description');
  expect((await fixture.get("SELECT description FROM time_entries WHERE id='daily-missing'")).description).toBe('Verified complete work description');
  await expectedTotals(page);
  await other.close();
});

test('rapid date changes reject delayed earlier responses and reopening reloads saved work', async ({ page }) => {
  await login(page); const dialog = await open(page);
  let arrived, release, delivered;
  const arrival = new Promise(resolve => { arrived = resolve; });
  const barrier = new Promise(resolve => { release = resolve; });
  const delivery = new Promise(resolve => { delivered = resolve; });
  await page.route('**/api/daily-work-review?date=2024-02-29', async route => {
    const response = await route.fetch(); arrived(); await barrier;
    try { await route.fulfill({ response }); } finally { delivered(); }
  }, { times: 1 });
  await dialog.getByLabel('Work date', { exact: true }).fill('2024-02-29');
  await arrival;
  await dialog.getByLabel('Work date', { exact: true }).fill('2024-02-28');
  await expect(dialog).toContainText('No confirmed personal time recorded for this day.');
  release(); await delivery;
  await expect(dialog).not.toContainText('Historical saved work date');
  await expect(dialog.getByTestId('daily-total')).toHaveText('0 h');
  await page.reload(); await open(page);
  await expect(review(page).getByTestId('daily-total')).toHaveText('1.775 h');
});

test('offline, access loss and cross-tab account replacement clear previously displayed records', async ({ page, context, request }) => {
  await login(page); const dialog = await open(page);
  await context.setOffline(true);
  await expect(dialog).toContainText('Offline.');
  await expect(dialog.getByTestId('daily-total')).toHaveCount(0);
  await context.setOffline(false);
  await expect(dialog.getByTestId('daily-total')).toHaveText('1.775 h');
  await fixture.run("UPDATE matters SET assignedTo='Other Advocate' WHERE id='104b-A'");
  await dialog.getByRole('button', { name: 'Refresh review', exact: true }).click();
  await expect(dialog.getByTestId('daily-total')).toHaveText('0.5 h');
  await expect(dialog).not.toContainText('Stably attributed manual drafting');
  const response = await request.post('http://127.0.0.1:5294/api/auth/login', { data: { email: '104b-b@example.test', password: 'Synthetic104B!Password' } });
  expect(response.status()).toBe(200);
  const replacement = await response.json();
  const other = await context.newPage(); await other.goto('/');
  await other.evaluate(session => { localStorage.setItem('lexflowSession', JSON.stringify(session)); localStorage.setItem('lexflowToken', session.token); }, replacement);
  await expect(dialog).toContainText('Account changed.');
  await expect(dialog.getByTestId('daily-total')).toHaveCount(0);
  await expect(dialog).not.toContainText('Description needs attention');
  await other.close();
});

test('expired authentication removes the review and requires login', async ({ page }) => {
  await login(page); const dialog = await open(page);
  await fixture.run("UPDATE users SET tokenVersion=2 WHERE id='104b-a'");
  await dialog.getByRole('button', { name: 'Refresh review', exact: true }).click();
  await expect(review(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Sign in securely', exact: true })).toBeVisible();
});

test('390px review is readable and usable; client portal exposes no review entry point', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await fixture.seedOutstanding();
  await login(page); const dialog = await open(page);
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  expect(await dialog.evaluate(element => [...element.querySelectorAll('button,input,select')].every(control => { const box = control.getBoundingClientRect(); return box.left >= 0 && box.right <= innerWidth; }))).toBe(true);
  await page.screenshot({ path: evidence('daily-review-390.png'), fullPage: false });
  await inspectDialog(page, dialog, 'daily-review-390-scroll');
  await dialog.getByRole('button', { name: 'Review uncertain time', exact: true }).click();
  const uncertain = page.getByRole('dialog', { name: 'Review uncertain time', exact: true });
  await inspectDialog(page, uncertain, 'daily-interruption-390');
  await uncertain.getByRole('button', { name: 'Cancel', exact: true }).click();
  await dialog.getByRole('article', { name: 'Outstanding session daily-paused', exact: true }).getByRole('button', { name: 'Record Time', exact: true }).click();
  const recording = page.getByRole('dialog', { name: 'Record Time', exact: true });
  await inspectDialog(page, recording, 'daily-record-390');
  await recording.getByRole('button', { name: 'Cancel', exact: true }).click();
  await dialog.getByLabel('Matter for manual time', { exact: true }).selectOption('104b-A');
  await dialog.getByRole('button', { name: 'Add Manual Time', exact: true }).click();
  await expect(page.locator('#matter-section-time')).toBeVisible();
  await page.evaluate(() => { localStorage.removeItem('lexflowSession'); localStorage.removeItem('lexflowToken'); });
  await login(page, true);
  await expect(page.getByRole('button', { name: 'Daily Work Review', exact: true })).toHaveCount(0);
  await expect(review(page)).toHaveCount(0);
});
