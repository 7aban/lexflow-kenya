import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import pdfFixture from '../../server/test/helpers/documentStudioFixture.js';
import passwords from '../../server/lib/passwords.js';

let fixture, server;
const panel = page => page.locator('#document-tools-panel');
const local = page => page.getByTestId('computer-pdf-workflow');
const result = page => local(page).getByRole('region', { name: 'Completed PDF result', exact: true });
const chooser = page => local(page).locator('input[type=file]');
const select = (page, caption) => panel(page).locator('label').filter({ has: page.locator('span').filter({ hasText: new RegExp(`^${caption}$`) }) }).locator('select');
const evidence = name => path.join(process.env.LEXFLOW_DS1A_EVIDENCE, name);
const payload = (name, bytes) => ({ name, mimeType: 'application/pdf', buffer: bytes });
const identity = ({ resources, ...page }) => page;
const encrypted = Buffer.from('JVBERi0xLjMKJeLjz9MKMSAwIG9iago8PAovUHJvZHVjZXIgPGFkNGI0NmU0YzE+Cj4+CmVuZG9iagoyIDAgb2JqCjw8Ci9UeXBlIC9QYWdlcwovQ291bnQgMQovS2lkcyBbIDQgMCBSIF0KPj4KZW5kb2JqCjMgMCBvYmoKPDwKL1R5cGUgL0NhdGFsb2cKL1BhZ2VzIDIgMCBSCj4+CmVuZG9iago0IDAgb2JqCjw8Ci9UeXBlIC9QYWdlCi9SZXNvdXJjZXMgPDwKPj4KL01lZGlhQm94IFsgMC4wIDAuMCAyMDAgMzAwIF0KL1BhcmVudCAyIDAgUgo+PgplbmRvYmoKNSAwIG9iago8PAovViAyCi9SIDMKL0xlbmd0aCAxMjgKL1AgNDI5NDk2NzI5MgovRmlsdGVyIC9TdGFuZGFyZAovTyA8NTQyMTc4Zjk2YTVhYWFmNmZlMGFmYzMzYzU1ZTFjOGQ0YTc2NDllZDY4NDU2YzRjMjdiMDc5NGRlOGM0ZTc5Yz4KL1UgPDAxYjA0YWEyNjdjYjMzYWE4NzM1ZTFmMTAwNzA3NTk0MjhiZjRlNWU0ZTc1OGE0MTY0MDA0ZTU2ZmZmYTAxMDg+Cj4+CmVuZG9iagp4cmVmCjAgNgowMDAwMDAwMDAwIDY1NTM1IGYgCjAwMDAwMDAwMTUgMDAwMDAgbiAKMDAwMDAwMDA1OSAwMDAwMCBuIAowMDAwMDAwMTE4IDAwMDAwIG4gCjAwMDAwMDAxNjcgMDAwMDAgbiAKMDAwMDAwMDI2MSAwMDAwMCBuIAp0cmFpbGVyCjw8Ci9TaXplIDYKL1Jvb3QgMyAwIFIKL0luZm8gMSAwIFIKL0lEIFsgPDYyMzE2MzY1NjYzMDMzNjYzNDY1MzczNTM3Mzc2MjY2MzMzOTM2MzE2NDY1NjQ2MTM5MzYzNDM0Mzk2NTYxMzA+IDw2MjMxNjM2NTY2MzAzMzY2MzQ2NTM3MzUzNzM3NjI2NjMzMzkzNjMxNjQ2NTY0NjEzOTM2MzQzNDM5NjU2MTMwPiBdCi9FbmNyeXB0IDUgMCBSCj4+CnN0YXJ0eHJlZgo0NzYKJSVFT0YK', 'base64');

test.beforeAll(async () => {
  process.env.CORS_ORIGINS = 'http://127.0.0.1:5187';
  fixture = await pdfFixture.createFixture();
  console.log('Synthetic DS2A2 database:', fixture.databasePath, 'Node:', process.version);
  const hash = await passwords.hashPassword('SyntheticDS1A!Password');
  for (const [id, role, clientId] of [['ds2a2-advocate', 'advocate', ''], ['ds2a2-assistant', 'assistant', ''], ['ds2a2-client', 'client', 'DS1A_C']]) {
    await fixture.sql.run('INSERT INTO users(id,email,password,role,fullName,tokenVersion,isActive,clientId) VALUES (?,?,?,?,?,1,1,?)', [id, `${id}@example.test`, hash, role, id, clientId]);
  }
  await fixture.sql.run("UPDATE matters SET assignedTo='ds2a2-advocate' WHERE id='DS1A_M'");
  await fixture.sql.run("INSERT INTO matters(id,clientId,title,assignedTo) VALUES ('DS2A2_OTHER','DS1A_C','Other authorized owner','different-advocate')");
  await fixture.sql.run("INSERT INTO matters(id,clientId,title,assignedTo) VALUES ('DS2A2_GONE','DS1A_C','Disposable destination','different-advocate')");
  server = fixture.app.listen(5297, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
});
test.afterAll(async () => { if (server) await new Promise(resolve => server.close(resolve)); await fixture?.close(); });

async function login(page, role = 'admin') {
  await page.goto('/');
  if (role === 'client') await page.getByRole('tab', { name: 'Client Portal', exact: true }).click();
  await page.locator('input[type=email]').click();
  await page.locator('input[type=email]').fill(role === 'admin' ? 'ds1a-admin@example.test' : `ds2a2-${role}@example.test`);
  await page.locator('input[type=password]').click();
  await page.locator('input[type=password]').fill('SyntheticDS1A!Password');
  const loggedIn = page.waitForResponse(r => r.url().endsWith(role === 'client' ? '/api/auth/client-login' : '/api/auth/login') && r.request().method() === 'POST');
  await page.getByRole('button', { name: role === 'client' ? 'Enter client portal' : 'Sign in securely', exact: true }).click();
  expect((await loggedIn).status()).toBe(200);
  if (role !== 'client') await expect(page.getByRole('button', { name: 'Start Work', exact: true })).toBeVisible();
  const dismiss = page.getByRole('button', { name: 'Dismiss notification', exact: true });
  if (await dismiss.isVisible()) await dismiss.click();
  await page.goto('/#/staff/document-studio');
  if (!['client', 'assistant'].includes(role)) await expect(page.getByRole('button', { name: 'Open Merge PDFs', exact: true })).toBeVisible();
}
async function open(page, operation, computer = true) {
  const name = operation === 'rotate' ? 'Rotate pages' : 'Merge PDFs';
  await page.getByRole('button', { name: new RegExp(`^(Open|Continue) ${name}$`) }).click();
  await expect(panel(page).getByRole('heading', { level: 3 })).toBeFocused();
  if (computer) await panel(page).getByRole('radio', { name: 'Choose from computer', exact: true }).check();
}
async function tabTo(page, target) {
  for (let i = 0; i < 160; i++) {
    if (await target.evaluate(el => document.activeElement === el)) return;
    await page.keyboard.press('Tab');
  }
  throw new Error('Keyboard could not reach target');
}
async function pickWithKeyboard(page, files) {
  await tabTo(page, chooser(page));
  const chosen = page.waitForEvent('filechooser');
  await page.keyboard.press('Enter');
  await (await chosen).setFiles(files);
}
async function download(page, operation, info, suffix = 'result') {
  const pending = page.waitForEvent('download');
  await local(page).getByRole('button', { name: operation === 'rotate' ? 'Rotate and Download' : 'Merge and Download', exact: true }).click();
  const item = await pending;
  const output = evidence(`${info.project.name}-${operation}-${suffix}.pdf`);
  await item.saveAs(output);
  await expect(result(page)).toBeVisible();
  return { bytes: fs.readFileSync(output), filename: item.suggestedFilename() };
}
async function repeatedDownload(page, info, suffix) {
  const pending = page.waitForEvent('download');
  await result(page).getByRole('button', { name: 'Download result', exact: true }).click();
  const output = evidence(`${info.project.name}-${suffix}.pdf`);
  await (await pending).saveAs(output);
  return fs.readFileSync(output);
}
async function capture(page, info, suffix) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  for (const control of await panel(page).locator('button,select,input').all()) {
    if (!await control.isVisible()) continue;
    const box = await control.boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize().width + 1);
  }
  if (info.project.name === 'mobile') {
    const timer = await page.getByRole('region', { name: 'Persistent work timer', exact: true }).boundingBox();
    const offset = timer.y + timer.height + 18;
    const target = /completed|destination/.test(suffix) ? result(page) : suffix === 'merge-ordering' ? local(page).getByRole('list') : panel(page);
    await target.evaluate((el, top) => window.scrollTo({ top: window.scrollY + el.getBoundingClientRect().top - top, behavior: 'instant' }), offset);
    await page.screenshot({ path: evidence(`${info.project.name}-${suffix}.png`), animations: 'disabled' });
    if (suffix === 'matter-mode') {
      await panel(page).getByRole('button', { name: 'Save to matter documents', exact: true }).evaluate(el => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
      await page.screenshot({ path: evidence('mobile-matter-mode-actions.png'), animations: 'disabled' });
    }
  } else await panel(page).screenshot({ path: evidence(`${info.project.name}-${suffix}.png`), animations: 'disabled' });
}

test('computer Rotate uses native keyboard picker, exact retained downloads and authorized result upload', async ({ page }, info) => {
  await login(page, 'advocate'); await open(page, 'rotate');
  await local(page).getByRole('textbox', { name: 'Output filename', exact: true }).fill('laptop / result');
  const before = await fixture.sql.get('SELECT COUNT(*) n FROM documents');
  const processed = [];
  page.on('request', req => { if (req.url().endsWith('/api/document-tools/rotate-pdf')) processed.push(req.postDataJSON()); });
  const original = Buffer.from(fixture.sources.DS1A_MIXED);
  await pickWithKeyboard(page, payload('laptop-source.pdf', original));
  await expect(chooser(page)).not.toHaveAttribute('multiple');
  await expect(select(page, 'Matter')).toHaveCount(0);
  await capture(page, info, 'computer-selection');
  const output = await download(page, 'rotate', info);
  expect(output.filename).toBe('laptop _ result.pdf');
  const actual = await pdfFixture.inspectPdf(output.bytes);
  const source = await pdfFixture.inspectPdf(original);
  expect(actual.map(p => p.rotation)).toEqual([90, 180, 270, 0]);
  expect(actual.map(({ rotation, ...p }) => p)).toEqual(source.map(({ rotation, ...p }) => p));
  await expect(result(page).getByRole('heading', { name: 'Completed PDF' })).toBeFocused();
  expect(await repeatedDownload(page, info, 'repeat-download')).toEqual(output.bytes);
  expect(processed).toHaveLength(1);
  expect(Object.keys(processed[0]).sort()).toEqual(['degrees', 'filename', 'files']);
  expect(Object.keys(processed[0].files[0]).sort()).toEqual(['data', 'mimeType', 'name']);
  expect(await fixture.sql.get('SELECT COUNT(*) n FROM documents')).toEqual(before);
  await capture(page, info, 'completed-actions');
  await result(page).getByRole('button', { name: 'Save to matter', exact: true }).click();
  await expect(select(page, 'Destination matter')).toBeFocused();
  await expect(select(page, 'Destination matter').locator('option[value="DS2A2_OTHER"]')).toHaveCount(0);
  await select(page, 'Destination matter').selectOption('DS1A_M');
  await capture(page, info, 'destination-selection');
  const pending = page.waitForResponse(r => r.url().endsWith('/api/matters/DS1A_M/documents') && r.request().method() === 'POST');
  await result(page).getByRole('button', { name: 'Save completed PDF', exact: true }).click();
  const response = await pending;
  expect(response.status()).toBe(200);
  const body = response.request().postDataJSON();
  expect(body.clientVisible).toBe(false);
  expect(body.name).toBe(output.filename);
  expect(Buffer.from(body.data.split(',').pop(), 'base64')).toEqual(output.bytes);
  const saved = await response.json();
  expect(saved).toMatchObject({ source: 'firm', clientVisible: 0, matterId: 'DS1A_M' });
  expect((await fixture.sql.get('SELECT content FROM documents WHERE id=?', [saved.id])).content).toEqual(output.bytes);
  expect((await fixture.sql.get('SELECT COUNT(*) n FROM documents')).n).toBe(before.n + 1);
  expect(processed).toHaveLength(1);
  expect(fixture.sources.DS1A_MIXED).toEqual(original);
  await expect(local(page).getByRole('status')).toContainText(`Saved ${output.filename}`);
});

test('computer Merge reorders with the keyboard and downloads correct pages without insertion', async ({ page }, info) => {
  await login(page); await open(page, 'merge');
  const sources = [fixture.sources.DS1A_0, fixture.sources.DS1A_90, fixture.sources.DS1A_270];
  const before = await fixture.sql.get('SELECT COUNT(*) n FROM documents');
  await pickWithKeyboard(page, sources.map((bytes, i) => payload(`computer-${i + 1}.pdf`, bytes)));
  await tabTo(page, local(page).getByRole('button', { name: 'Move PDF 3 up', exact: true })); await page.keyboard.press('Space');
  await tabTo(page, local(page).getByRole('button', { name: 'Move PDF 2 up', exact: true })); await page.keyboard.press('Enter');
  const rows = local(page).getByRole('list', { name: 'Selected computer PDFs' }).getByRole('listitem');
  await expect(rows.nth(0)).toContainText('computer-3.pdf');
  await expect(rows.nth(1)).toContainText('computer-1.pdf');
  await capture(page, info, 'merge-ordering');
  const output = await download(page, 'merge', info);
  const expected = (await Promise.all([sources[2], sources[0], sources[1]].map(pdfFixture.inspectPdf))).flat();
  expect((await pdfFixture.inspectPdf(output.bytes)).map(identity)).toEqual(expected.map(identity));
  expect(await repeatedDownload(page, info, 'merge-repeat')).toEqual(output.bytes);
  expect(await fixture.sql.get('SELECT COUNT(*) n FROM documents')).toEqual(before);
  await tabTo(page, local(page).getByRole('button', { name: 'Move PDF 1 down', exact: true })); await page.keyboard.press('Enter');
  await expect(result(page)).toHaveCount(0);
});

test('file preflight and backend rejections never leave a completed result', async ({ page }) => {
  await login(page); await open(page, 'merge');
  const good = payload('valid.pdf', fixture.sources.DS1A_0);
  await chooser(page).setInputFiles([good]);
  await expect(local(page).getByRole('button', { name: 'Merge and Download', exact: true })).toBeDisabled();
  await chooser(page).setInputFiles(Array.from({ length: 11 }, (_, i) => ({ ...good, name: `${i}.pdf` })));
  await expect(local(page).getByRole('alert')).toContainText('no more than 10');
  await chooser(page).setInputFiles(Array.from({ length: 10 }, (_, i) => ({ ...good, name: `${i}.pdf` })));
  await expect(local(page).getByRole('button', { name: 'Merge and Download', exact: true })).toBeEnabled();
  await open(page, 'rotate');
  await chooser(page).setInputFiles({ name: 'wrong.txt', mimeType: 'text/plain', buffer: Buffer.from('synthetic') });
  await expect(local(page).getByRole('alert')).toContainText('PDF files only');
  await chooser(page).setInputFiles(payload('oversized.pdf', Buffer.alloc(20 * 1024 * 1024 + 1)));
  await expect(local(page).getByRole('alert')).toContainText('20 MiB');
  for (const [name, bytes] of [['malformed.pdf', Buffer.from('synthetic-private-marker')], ['encrypted.pdf', encrypted]]) {
    await chooser(page).setInputFiles(payload(name, bytes));
    const pending = page.waitForResponse(r => r.url().endsWith('/api/document-tools/rotate-pdf'));
    await local(page).getByRole('button', { name: 'Rotate and Download', exact: true }).click();
    expect((await pending).status()).toBe(400);
    await expect(local(page).getByRole('alert')).toContainText(/corrupt|encrypted/);
    await expect(result(page)).toHaveCount(0);
    await expect(local(page)).not.toContainText('synthetic-private-marker');
  }
});

test('busy and network failures allow deliberate retry without duplicate processing', async ({ page }, info) => {
  await login(page); await open(page, 'rotate');
  await chooser(page).setInputFiles(payload('retry.pdf', fixture.sources.DS1A_0));
  let calls = 0;
  await page.route('**/api/document-tools/rotate-pdf', async route => {
    calls++;
    if (calls === 1) await route.fulfill({ status: 429, json: { error: 'Busy', code: 'computer_pdf_busy' } });
    else await route.continue();
  });
  await local(page).getByRole('button', { name: 'Rotate and Download', exact: true }).click();
  await expect(local(page).getByRole('alert')).toContainText('Another PDF operation is running');
  await page.waitForTimeout(150); expect(calls).toBe(1);
  await download(page, 'rotate', info, 'retry'); expect(calls).toBe(2);
  await select(page, 'Rotation').selectOption('180');
  await page.unroute('**/api/document-tools/rotate-pdf');
  await page.route('**/api/document-tools/rotate-pdf', route => route.abort('failed'));
  await local(page).getByRole('button', { name: 'Rotate and Download', exact: true }).click();
  await expect(local(page).getByRole('alert')).toContainText(/fetch|network/i);
  await expect(result(page)).toHaveCount(0);
});

test('older responses cannot overwrite a new selection; source, options and leaving clear results', async ({ page }, info) => {
  await login(page); await open(page, 'rotate');
  let release, started;
  const hold = new Promise(resolve => { release = resolve; });
  const firstStarted = new Promise(resolve => { started = resolve; });
  let calls = 0, downloads = 0;
  page.on('download', () => downloads++);
  await page.route('**/api/document-tools/rotate-pdf', async route => {
    if (++calls !== 1) { await route.continue(); return; }
    const response = await route.fetch(); started(); await hold;
    await route.fulfill({ response }).catch(() => {}); // Aborted old request.
  });
  await chooser(page).setInputFiles(payload('old.pdf', fixture.sources.DS1A_0));
  await local(page).getByRole('button', { name: 'Rotate and Download', exact: true }).click();
  await firstStarted;
  await chooser(page).setInputFiles(payload('new.pdf', fixture.sources.DS1A_90));
  const output = await download(page, 'rotate', info, 'new-selection');
  release(); await page.waitForTimeout(100);
  expect(downloads).toBe(1);
  expect((await pdfFixture.inspectPdf(output.bytes)).map(p => p.rotation)).toEqual([180]);
  await select(page, 'Rotation').selectOption('180'); await expect(result(page)).toHaveCount(0);
  await download(page, 'rotate', info, 'changed-angle');
  await local(page).getByRole('textbox', { name: 'Output filename', exact: true }).fill('new-name.pdf'); await expect(result(page)).toHaveCount(0);
  await download(page, 'rotate', info, 'changed-name');
  await local(page).getByRole('button', { name: 'Remove PDF 1', exact: true }).click(); await expect(result(page)).toHaveCount(0);
  await expect(chooser(page)).toBeFocused();
  await chooser(page).setInputFiles(payload('new.pdf', fixture.sources.DS1A_90));
  await download(page, 'rotate', info, 'before-clear');
  await local(page).getByRole('button', { name: 'Clear selection', exact: true }).click(); await expect(result(page)).toHaveCount(0);
  await chooser(page).setInputFiles(payload('new.pdf', fixture.sources.DS1A_90));
  await panel(page).getByRole('radio', { name: 'Choose from matter', exact: true }).check();
  await expect(local(page)).toHaveCount(0); await expect(select(page, 'Matter')).toHaveValue('');
  await panel(page).getByRole('radio', { name: 'Choose from computer', exact: true }).check();
  await expect(local(page)).toContainText('0/1 selected');
  await chooser(page).setInputFiles(payload('new.pdf', fixture.sources.DS1A_90));
  await page.getByRole('button', { name: 'Back to tools', exact: true }).click();
  await expect(local(page)).toHaveCount(0);
  await page.getByRole('button', { name: 'Continue Rotate pages', exact: true }).click();
  await expect(local(page)).toContainText('0/1 selected');
});

test('save authorization loss and rejected destinations retain the exact downloadable result', async ({ page }, info) => {
  await login(page, 'advocate'); await open(page, 'rotate');
  await chooser(page).setInputFiles(payload('save-source.pdf', fixture.sources.DS1A_0));
  const output = await download(page, 'rotate', info, 'save-failure');
  await result(page).getByRole('button', { name: 'Save to matter', exact: true }).click();
  await select(page, 'Destination matter').selectOption('DS1A_M');
  await fixture.sql.run("UPDATE matters SET assignedTo='different-advocate' WHERE id='DS1A_M'");
  try {
    const denied = page.waitForResponse(r => r.url().endsWith('/api/matters/DS1A_M/documents') && r.request().method() === 'POST');
    await result(page).getByRole('button', { name: 'Save completed PDF', exact: true }).click();
    expect((await denied).status()).toBe(403);
    await expect(local(page).getByRole('alert')).toContainText('Matter access denied');
    await expect(local(page).getByRole('status')).not.toContainText('Saved ');
    expect(await repeatedDownload(page, info, 'after-save-denied')).toEqual(output.bytes);
  } finally { await fixture.sql.run("UPDATE matters SET assignedTo='ds2a2-advocate' WHERE id='DS1A_M'"); }
  await page.route('**/api/matters/DS1A_M/documents', route => route.fulfill({ status: 404, json: { error: 'Matter not found' } }));
  await result(page).getByRole('button', { name: 'Save completed PDF', exact: true }).click();
  await expect(local(page).getByRole('alert')).toContainText('Matter not found');
  await expect(result(page)).toBeVisible();
});

test('assistant has no save privilege and client portal excludes computer processing', async ({ page }) => {
  await login(page, 'assistant');
  await expect(page.getByRole('button', { name: 'Open Merge PDFs', exact: true })).toHaveCount(0);
  await expect(local(page)).toHaveCount(0);
  const token = await page.evaluate(() => JSON.parse(localStorage.getItem('lexflowSession')).token);
  const processed = await page.request.post('/api/document-tools/rotate-pdf', { headers: { Authorization: `Bearer ${token}` }, data: { files: [{ name: 'assistant.pdf', mimeType: 'application/pdf', data: fixture.sources.DS1A_0.toString('base64') }], degrees: 90 } });
  expect(processed.status()).toBe(200);
  expect((await pdfFixture.inspectPdf(await processed.body())).map(p => p.rotation)).toEqual([90]);
  expect((await page.request.post('/api/matters/DS1A_M/documents', { headers: { Authorization: `Bearer ${token}` }, data: { name: 'denied.pdf', mimeType: 'application/pdf', data: fixture.sources.DS1A_0.toString('base64') } })).status()).toBe(403);
  await page.evaluate(() => localStorage.clear()); await page.reload(); await login(page, 'client');
  await expect(page.getByTestId('computer-pdf-workflow')).toHaveCount(0);
  await expect(page.getByRole('radio', { name: 'Choose from computer', exact: true })).toHaveCount(0);
  const clientToken = await page.evaluate(() => JSON.parse(localStorage.getItem('lexflowSession')).token);
  expect((await page.request.post('/api/document-tools/rotate-pdf', { headers: { Authorization: `Bearer ${clientToken}` }, data: { files: [{ name: 'denied.pdf', mimeType: 'application/pdf', data: fixture.sources.DS1A_0.toString('base64') }], degrees: 90 } })).status()).toBe(403);
});

test('expired authentication clears completed files and results before the next login', async ({ page }, info) => {
  await login(page); await open(page, 'rotate');
  await chooser(page).setInputFiles(payload('expire.pdf', fixture.sources.DS1A_0)); await download(page, 'rotate', info, 'expire');
  await result(page).getByRole('button', { name: 'Save to matter', exact: true }).click(); await select(page, 'Destination matter').selectOption('DS1A_M');
  await page.route('**/api/matters/DS1A_M/documents', route => route.fulfill({ status: 401, json: { error: 'Session invalidated' } }));
  await result(page).getByRole('button', { name: 'Save completed PDF', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sign in securely', exact: true })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('lexflowSession'))).toBeNull();
  await page.unroute('**/api/matters/DS1A_M/documents'); await login(page); await open(page, 'rotate');
  await expect(local(page)).toContainText('0/1 selected'); await expect(result(page)).toHaveCount(0);
});

test('matter Rotate and Merge retain stored IDs, download and dedicated save endpoints', async ({ page }, info) => {
  await login(page); await open(page, 'rotate', false);
  await expect(panel(page).getByRole('radio', { name: 'Choose from matter', exact: true })).toBeChecked();
  await select(page, 'Matter').selectOption('DS1A_M'); await select(page, 'PDF document').selectOption('DS1A_MIXED');
  await capture(page, info, 'matter-mode');
  const downloaded = page.waitForEvent('download'); await panel(page).getByRole('button', { name: 'Rotate and Download', exact: true }).click();
  const outputPath = evidence(`${info.project.name}-stored-rotate.pdf`); await (await downloaded).saveAs(outputPath);
  expect((await pdfFixture.inspectPdf(fs.readFileSync(outputPath))).map(p => p.rotation)).toEqual([90, 180, 270, 0]);
  const rotatedSave = page.waitForResponse(r => r.url().endsWith('/api/document-tools/rotate-pdf/save'));
  await panel(page).getByRole('button', { name: 'Save to matter documents', exact: true }).click();
  const savedRotate = await rotatedSave; expect(savedRotate.status()).toBe(200); expect(savedRotate.request().postDataJSON()).not.toHaveProperty('files');
  await open(page, 'merge', false); await select(page, 'Matter').selectOption('DS1A_M');
  for (const name of ['DS1A_0.pdf', 'DS1A_90.pdf']) await panel(page).locator('label').filter({ hasText: name }).getByRole('checkbox').check();
  const mergeResponse = page.waitForResponse(r => r.url().endsWith('/api/document-tools/merge-pdfs'));
  const mergedDownload = page.waitForEvent('download'); await panel(page).getByRole('button', { name: 'Merge and Download', exact: true }).click();
  const merged = await mergeResponse; expect(merged.request().postDataJSON()).toMatchObject({ documentIds: ['DS1A_0', 'DS1A_90'] });
  expect(merged.request().postDataJSON()).not.toHaveProperty('files'); await mergedDownload;
  const mergeSave = page.waitForResponse(r => r.url().endsWith('/api/document-tools/merge-pdfs/save'));
  await panel(page).getByRole('button', { name: 'Save to matter documents', exact: true }).click();
  const savedMerge = await mergeSave; expect(savedMerge.status()).toBe(200);
  expect(await savedMerge.json()).toMatchObject({ source: 'document_tool', clientVisible: 0 });
});
