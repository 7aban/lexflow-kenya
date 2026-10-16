import { test, expect } from '@playwright/test';
import path from 'node:path';
import pdfFixture from '../../server/test/helpers/documentStudioFixture.js';
import passwords from '../../server/lib/passwords.js';

let fixture, server;
const studio = page => page.locator('.lf-document-studio');
const panel = page => page.locator('#document-tools-panel');
const evidence = name => path.join(process.env.LEXFLOW_DS1A_EVIDENCE, name);
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const tools = [
  ['merge', 'Merge PDFs'], ['extract', 'Extract pages'], ['split', 'Reorder / Select Pages'],
  ['delete', 'Delete pages'], ['rotate', 'Rotate pages'], ['paginate', 'Add page numbers / paginate bundle'],
  ['bundle', 'Court bundle prep'], ['images', 'Images to PDF'], ['stamp', 'Sign / stamp PDF'],
  ['tenth', 'Tenth-line overlay (approximate)'],
];
const select = (page, caption) => panel(page).locator('label').filter({ has: page.locator('span').filter({ hasText: new RegExp(`^${caption}$`) }) }).locator('select');

test.beforeAll(async () => {
  process.env.CORS_ORIGINS = 'http://127.0.0.1:5187';
  fixture = await pdfFixture.createFixture();
  console.log('Disposable fixture:', fixture.databasePath, 'runtime:', process.version);
  const hash = await passwords.hashPassword('SyntheticDS1A!Password');
  for (const [id, role, clientId] of [['ds1b-advocate', 'advocate', ''], ['ds1b-client', 'client', 'DS1A_C']]) {
    await fixture.sql.run('INSERT INTO users(id,email,password,role,fullName,tokenVersion,isActive,clientId) VALUES (?,?,?,?,?,1,1,?)', [id, `${id}@example.test`, hash, role, id, clientId]);
  }
  await fixture.sql.run("UPDATE matters SET assignedTo='ds1b-advocate' WHERE id='DS1A_M'");
  await fixture.sql.run('INSERT INTO signature_assets(id,ownerType,ownerId,assetType,label,mimeType,content,size,createdBy,createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', ['DS1B_ASSET', 'firm', null, 'stamp', 'Synthetic placement stamp', 'image/png', png, png.length, fixture.user.id, new Date().toISOString()]);
  server = fixture.app.listen(5297, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
});
test.afterAll(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  await fixture?.close();
});

async function login(page, role = 'admin') {
  await page.goto('/');
  if (role === 'client') await page.getByRole('tab', { name: 'Client Portal', exact: true }).click();
  await page.locator('input[type=email]').click();
  await page.locator('input[type=email]').fill(role === 'admin' ? 'ds1a-admin@example.test' : `ds1b-${role}@example.test`);
  await page.locator('input[type=password]').click();
  await page.locator('input[type=password]').fill('SyntheticDS1A!Password');
  const response = page.waitForResponse(r => r.url().endsWith(role === 'client' ? '/api/auth/client-login' : '/api/auth/login') && r.request().method() === 'POST');
  await page.getByRole('button', { name: role === 'client' ? 'Enter client portal' : 'Sign in securely', exact: true }).click();
  expect((await response).status()).toBe(200);
  if (role !== 'client') await expect(page.getByRole('button', { name: 'Start Work', exact: true })).toBeVisible();
  const dismiss = page.getByRole('button', { name: 'Dismiss notification', exact: true });
  if (await dismiss.isVisible()) await dismiss.click();
  await page.goto('/#/staff/document-studio');
  if (role !== 'client') await expect(page.getByRole('button', { name: 'Open Merge PDFs', exact: true })).toBeVisible();
}

// Real Tab/Shift+Tab navigation; never set focus through evaluate or locator.focus.
async function tabTo(page, target, key = 'Tab') {
  for (let i = 0; i < 140; i++) {
    if (await target.evaluate(el => el === document.activeElement)) return;
    await page.keyboard.press(key);
  }
  throw new Error(`Keyboard could not reach ${await target.getAttribute('aria-label') || await target.textContent()}`);
}
async function open(page, id) {
  await tabTo(page, page.locator(`#document-tool-${id}`));
  await page.keyboard.press('Enter');
  await expect(panel(page).getByRole('heading', { level: 3 })).toBeFocused();
}
async function capture(page, info, slug) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  for (const control of await studio(page).locator('button,select,input').all()) {
    if (!await control.isVisible()) continue;
    const box = await control.boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize().width + 1);
  }
  await page.screenshot({ path: evidence(`${info.project.name}-${slug}.png`) });
}

test('all ten named tools support keyboard entry, return focus, coherent DOM order and resume', async ({ page }, info) => {
  await login(page);
  for (const [id, name] of tools) {
    await expect(page.getByRole('button', { name: `Open ${name}`, exact: true })).toHaveCount(1);
    // The visible button label is included in its distinguishable accessible name.
    await expect(page.getByRole('button', { name: `Open ${name}`, exact: true })).toHaveText('Open');
  }
  for (const [id, name] of tools) {
    await open(page, id);
    await expect(page.locator(`#document-tool-${id}`)).toHaveAttribute('aria-current', 'step');
    await expect(page.locator(`#document-tool-${id}`)).toHaveAccessibleName(`Continue ${name}`);
    await expect(page.locator(`#document-tool-${id}`).locator('..')).toContainText('Selected');
    await page.keyboard.press('Tab');
    await expect(select(page, 'Matter')).toBeFocused();
    await tabTo(page, studio(page).getByRole('button', { name: 'Back to tools', exact: true }), 'Shift+Tab');
    await page.keyboard.press('Space');
    await expect(page.locator(`#document-tool-${id}`)).toBeFocused();
    await expect(panel(page)).toHaveCount(0);
  }
  await page.keyboard.press('Enter');
  await expect(panel(page).getByRole('heading', { level: 3 })).toBeFocused();
  await tabTo(page, page.locator('#document-tool-tenth'));
  await page.keyboard.press('Enter'); // Continue the already expanded workflow.
  await expect(panel(page).getByRole('heading', { level: 3 })).toBeFocused();
  const order = await studio(page).locator(':scope > section, :scope > div').evaluateAll(nodes => nodes.map(el => ({ text: el.innerText, y: el.getBoundingClientRect().top })));
  const workflow = order.findIndex(n => n.text.startsWith('Selected workflow'));
  const assets = order.findIndex(n => n.text.startsWith('More document tools'));
  const templates = order.findIndex(n => n.text.startsWith('Manage templates'));
  expect(workflow).toBeGreaterThan(0); expect(assets).toBeGreaterThan(workflow); expect(templates).toBeGreaterThan(assets);
  expect(order[workflow].y).toBeLessThan(order[assets].y);
  await capture(page, info, 'workflow-focus');
  const heading = panel(page).getByRole('heading', { level: 3 });
  expect(await heading.evaluate(el => getComputedStyle(el).outlineStyle)).toBe('solid');
  const box = await heading.boundingBox();
  const timer = await page.getByRole('region', { name: 'Persistent work timer' }).boundingBox();
  expect(box.y).toBeGreaterThan(timer.y + timer.height);
});

test('signature and admin stamp uploads activate by Enter/Space and reject invalid files', async ({ page }, info) => {
  await login(page);
  const manage = studio(page).getByRole('button', { name: 'Manage signing assets', exact: true });
  await tabTo(page, manage); await page.keyboard.press('Enter');
  for (const [kind, key] of [['signature', 'Enter'], ['stamp', 'Space']]) {
    const button = studio(page).getByRole('button', { name: `Upload ${kind} image`, exact: true });
    await tabTo(page, button);
    const chooser = page.waitForEvent('filechooser'); await page.keyboard.press(key);
    await (await chooser).setFiles({ name: `keyboard-${kind}.png`, mimeType: 'image/png', buffer: png });
    await expect(page.getByRole('status').filter({ hasText: kind === 'stamp' ? 'Firm stamp image uploaded.' : 'Visual signature image uploaded.' })).toHaveCount(1);
    await expect(studio(page)).toContainText(`Selected file: keyboard-${kind}.png`);
    await expect(button).toBeEnabled();
  }
  const upload = studio(page).getByRole('button', { name: 'Upload signature image', exact: true });
  for (const [name, mimeType, buffer, message] of [
    ['bad.webp', 'image/webp', Buffer.from('bad'), 'WebP cannot be embedded'],
    ['bad.txt', 'text/plain', Buffer.from('bad'), 'Only PNG and JPEG'],
    ['too-large.png', 'image/png', Buffer.alloc(512 * 1024 + 1), 'Image exceeds 512 KB'],
  ]) {
    await tabTo(page, upload); const chooser = page.waitForEvent('filechooser'); await page.keyboard.press('Enter');
    await (await chooser).setFiles({ name, mimeType, buffer });
    await expect(page.getByRole('status').filter({ hasText: message })).toHaveCount(1);
    await expect(upload).toBeFocused();
  }
  await capture(page, info, 'upload-rejection');
});

test('advanced placement has keyboard disclosure, coordinates, presets, click and drag with unchanged stamp payload', async ({ page }, info) => {
  await login(page); await open(page, 'stamp');
  const toggle = panel(page).getByRole('button', { name: /Advanced placement/ });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  const regionId = await toggle.getAttribute('aria-controls');
  const region = page.locator(`[id="${regionId}"]`);
  await expect(region).toHaveCount(1); await expect(region).toBeHidden();
  await expect(region).toHaveAttribute('aria-labelledby', await toggle.getAttribute('id'));
  await tabTo(page, toggle); await page.keyboard.press('Enter');
  await expect(toggle).toBeFocused(); await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(region).toBeVisible();
  const x = region.getByLabel('X (pt from left)', { exact: true });
  const y = region.getByLabel('Y (pt from bottom)', { exact: true });
  const width = region.getByLabel('Width (pt)', { exact: true });
  for (const [field, value] of [[x, '60'], [y, '70'], [width, '100']]) {
    await page.keyboard.press('Tab'); await expect(field).toBeFocused();
    await page.keyboard.press('ControlOrMeta+A'); await page.keyboard.type(value);
  }
  await tabTo(page, toggle, 'Shift+Tab'); await page.keyboard.press('Space');
  await expect(toggle).toBeFocused(); await expect(toggle).toHaveAttribute('aria-expanded', 'false'); await expect(region).toBeHidden();
  await page.keyboard.press('Tab'); await expect(panel(page).getByPlaceholder('stamped-document.pdf')).toBeFocused();
  await tabTo(page, toggle, 'Shift+Tab'); await page.keyboard.press('Enter');
  await expect(x).toHaveValue('60'); await expect(y).toHaveValue('70'); await expect(width).toHaveValue('100');
  await select(page, 'Matter').selectOption('DS1A_M'); await select(page, 'PDF document').selectOption('DS1A_0');
  const assets = select(page, 'Signature / stamp asset');
  await expect(assets.locator('option:not([value=""])').first()).toBeAttached();
  await assets.selectOption('DS1B_ASSET');
  const canvas = panel(page).locator('canvas'); await expect(canvas).toBeVisible();
  await expect.poll(() => canvas.evaluate(el => el.width)).toBeGreaterThan(0);
  // Use a real preset before verifying the existing PDF-point conversion (400 x 520 page).
  const preset = panel(page).getByRole('button', { name: 'Bottom Left', exact: true });
  await tabTo(page, preset, 'Shift+Tab'); await page.keyboard.press('Enter');
  await expect(x).toHaveValue('50'); await expect(y).toHaveValue('50'); await expect(width).toHaveValue('150');
  await canvas.scrollIntoViewIfNeeded();
  const bounds = await canvas.boundingBox();
  // Locator clicks use the padding-box origin. Record the delivered event and
  // the border-box used by the existing canvas before checking PDF coordinates.
  await canvas.evaluate(el => el.addEventListener('click', event => {
    const rect = el.getBoundingClientRect();
    el.dataset.testPointer = JSON.stringify({ x: event.clientX, y: event.clientY, left: rect.left, top: rect.top, width: rect.width });
  }, { once: true }));
  await canvas.click({ position: { x: bounds.width * 0.25, y: bounds.height * 0.25 } });
  const pointer = JSON.parse(await canvas.getAttribute('data-test-pointer'));
  const roundPoint = value => Math.round(value * 10) / 10;
  const scale = pointer.width / 400;
  const expectedX = roundPoint((pointer.x - pointer.left) / scale);
  const expectedY = roundPoint(520 - (pointer.y - pointer.top) / scale - 150);
  await expect(x).toHaveValue(String(expectedX));
  await expect(y).toHaveValue(String(expectedY));
  // Confirm the intended physical quarter-canvas click, independently of the
  // preview's responsive CSS aspect ratio; exact PDF values were asserted above.
  expect(Math.abs(pointer.x - pointer.left - bounds.width * 0.25)).toBeLessThan(2);
  expect(Math.abs(pointer.y - pointer.top - bounds.height * 0.25)).toBeLessThan(2);
  await canvas.scrollIntoViewIfNeeded();
  const dragBounds = await canvas.boundingBox();
  const marker = canvas.locator('..').locator(':scope > div'); const markerBox = await marker.boundingBox();
  const start = { x: Math.floor(markerBox.x + 5), y: Math.floor(markerBox.y + 5) };
  const end = { x: Math.floor(start.x + dragBounds.width * 0.05), y: Math.floor(start.y + dragBounds.height * 0.05) };
  await page.mouse.move(start.x, start.y); await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 5 }); await page.mouse.up();
  const dragScale = dragBounds.width / 400;
  await expect(x).toHaveValue(String(roundPoint((markerBox.x - dragBounds.x + end.x - start.x) / dragScale)));
  await expect(y).toHaveValue(String(roundPoint(520 - (markerBox.y - dragBounds.y + end.y - start.y) / dragScale - 150)));
  await tabTo(page, x); await page.keyboard.press('ControlOrMeta+A'); await page.keyboard.type('60');
  await page.keyboard.press('Tab'); await page.keyboard.press('ControlOrMeta+A'); await page.keyboard.type('70');
  await page.keyboard.press('Tab'); await page.keyboard.press('ControlOrMeta+A'); await page.keyboard.type('100');
  await capture(page, info, 'advanced-coordinates');
  const submitted = page.waitForRequest(r => r.url().endsWith('/api/document-tools/stamp-pdf') && r.method() === 'POST');
  const download = page.waitForEvent('download');
  await tabTo(page, panel(page).getByRole('button', { name: 'Stamp and Download', exact: true })); await page.keyboard.press('Enter');
  expect((await submitted).postDataJSON()).toMatchObject({ documentId: 'DS1A_0', pageNumber: 1, x: 60, y: 70, width: 100 });
  await (await download).saveAs(evidence(`${info.project.name}-keyboard-stamped.pdf`));
  await expect(page.getByRole('status').filter({ hasText: 'Stamped PDF downloaded.' })).toHaveCount(1);
});

test('template failure stays local while document and matter failures remain explicit', async ({ page }, info) => {
  await page.route('**/api/document-templates', route => route.fulfill({ status: 503, json: { error: 'Synthetic template outage' } }));
  await login(page); await expect(studio(page)).toContainText('Templates unavailable: Synthetic template outage');
  await expect(studio(page)).toContainText('PDF tools remain available.');
  await expect(studio(page).getByText('No templates configured', { exact: true })).toHaveCount(0);
  await studio(page).getByText('Templates unavailable: Synthetic template outage PDF tools remain available.', { exact: true }).scrollIntoViewIfNeeded();
  await capture(page, info, 'template-error');
  await open(page, 'rotate'); await select(page, 'Matter').selectOption('DS1A_M'); await select(page, 'PDF document').selectOption('DS1A_MIXED');
  const download = page.waitForEvent('download');
  await panel(page).getByRole('button', { name: 'Rotate and Download', exact: true }).click(); await download;
  await expect(page.getByRole('status').filter({ hasText: 'Rotated PDF downloaded.' })).toHaveCount(1);
  let documentFailureRequests = 0;
  await page.route(/\/api\/matters\/DS1A_M\/documents(?:\?|$)/, route => {
    documentFailureRequests++;
    return route.fulfill({ status: 503, json: { error: 'Synthetic document-list outage' } });
  });
  await open(page, 'split'); await select(page, 'Matter').selectOption('DS1A_M');
  await expect(panel(page).getByRole('alert')).toHaveText('Synthetic document-list outage');
  expect(documentFailureRequests).toBeGreaterThan(0);
  await expect(panel(page).getByRole('button', { name: 'Apply and Download', exact: true })).toBeDisabled();
  await panel(page).getByRole('alert').scrollIntoViewIfNeeded();
  await capture(page, info, 'document-error');
  await page.route('**/api/matters', route => route.fulfill({ status: 503, json: { error: 'Synthetic matter outage' } }));
  await page.reload(); await expect(studio(page).getByRole('alert')).toContainText('Synthetic matter outage');
});

test('missing selections, invalid page order, processing status and errors announce once', async ({ page }, info) => {
  await login(page); await open(page, 'merge');
  await expect(panel(page).getByRole('status')).toHaveText('Select a matter first.');
  await expect(panel(page).getByRole('button', { name: 'Merge and Download', exact: true })).toBeDisabled();
  await select(page, 'Matter').selectOption('DS1A_M');
  await expect(panel(page).getByRole('status')).toHaveText('Select at least 2 PDF documents (up to 10).');
  const boxes = panel(page).getByRole('checkbox'); await boxes.nth(0).check(); await boxes.nth(1).check();
  const merged = page.waitForEvent('download'); await panel(page).getByRole('button', { name: 'Merge and Download', exact: true }).click(); await merged;
  await expect(page.getByRole('status').filter({ hasText: 'Merged PDF downloaded.' })).toHaveCount(1);
  await open(page, 'split'); await select(page, 'Matter').selectOption('DS1A_M'); await select(page, 'PDF document').selectOption('DS1A_MIXED');
  await panel(page).getByPlaceholder('3,1,2', { exact: true }).fill('999');
  const invalid = page.waitForResponse(r => r.url().endsWith('/api/document-tools/split-pdf') && r.request().method() === 'POST');
  await panel(page).getByRole('button', { name: 'Apply and Download', exact: true }).click();
  expect((await invalid).status()).toBe(400);
  await expect(page.getByRole('status').filter({ hasText: /page|range/i }).filter({ has: page.locator('strong') })).toHaveCount(1);
  let release;
  const hold = new Promise(resolve => { release = resolve; });
  await page.route('**/api/document-tools/split-pdf', async route => { await hold; await route.fulfill({ status: 503, json: { error: 'Synthetic processing failure' } }); });
  await panel(page).getByPlaceholder('3,1,2', { exact: true }).fill('3,1,2');
  await panel(page).getByRole('button', { name: 'Apply and Download', exact: true }).click();
  await expect(panel(page).getByRole('status')).toHaveText('Processing PDF...'); release();
  await expect(page.getByRole('status').filter({ hasText: 'Synthetic processing failure' })).toHaveCount(1);
  await expect(panel(page)).toContainText('Synthetic processing failure');
  await capture(page, info, 'processing-error');
});

test('advocate visibility and client-portal exclusion retain real backend permissions', async ({ page }) => {
  await login(page, 'advocate'); await open(page, 'stamp');
  await expect(panel(page).getByRole('button', { name: 'Save to matter documents', exact: true })).toHaveCount(0);
  await select(page, 'Matter').selectOption('DS1A_M');
  await expect(panel(page).getByRole('button', { name: 'Save to matter documents', exact: true })).toBeVisible();
  await tabTo(page, studio(page).getByRole('button', { name: 'Manage signing assets', exact: true })); await page.keyboard.press('Enter');
  await expect(studio(page).getByRole('button', { name: 'Upload signature image', exact: true })).toBeVisible();
  await expect(studio(page).getByRole('button', { name: 'Upload stamp image', exact: true })).toHaveCount(0);
  const token = await page.evaluate(() => JSON.parse(localStorage.getItem('lexflowSession')).token);
  const denied = await page.request.post('/api/signature-assets', { headers: { Authorization: `Bearer ${token}` }, data: { ownerType: 'firm', assetType: 'stamp', label: 'Denied', mimeType: 'image/png', data: 'data:image/png;base64,eA==' } });
  expect(denied.status()).toBe(403);
  await page.evaluate(() => localStorage.clear()); await page.goto('/');
  await login(page, 'client'); await expect(studio(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Open Merge PDFs', exact: true })).toHaveCount(0);
  const clientToken = await page.evaluate(() => JSON.parse(localStorage.getItem('lexflowSession')).token);
  for (const endpoint of ['/api/document-tools/rotate-pdf', '/api/document-tools/stamp-pdf', '/api/document-tools/court-bundle']) {
    const response = await page.request.post(endpoint, { headers: { Authorization: `Bearer ${clientToken}` }, data: { documentId: 'DS1A_MIXED', degrees: 90 } });
    expect(response.status()).toBe(403);
  }
});
