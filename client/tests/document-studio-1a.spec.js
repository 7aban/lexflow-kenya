import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import pdfFixture from '../../server/test/helpers/documentStudioFixture.js';

let fixture, server;
const evidence = name => path.join(process.env.LEXFLOW_DS1A_EVIDENCE, name);
const panel = page => page.locator('#document-tools-panel');
// A wrapping label includes its select options in getByLabel's text matching.
// Target the label's own caption, then its select; do not bypass product controls.
const select = (page, caption) => panel(page).locator('label').filter({ has: page.locator('span').filter({ hasText: new RegExp(`^${caption}$`) }) }).locator('select');

test.beforeAll(async () => {
  process.env.CORS_ORIGINS = 'http://127.0.0.1:5187';
  fixture = await pdfFixture.createFixture();
  server = fixture.app.listen(5297, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
});
test.afterAll(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  await fixture?.close();
});

async function login(page) {
  await page.goto('/');
  await page.locator('input[type=email]').click();
  await page.locator('input[type=email]').fill('ds1a-admin@example.test');
  await page.locator('input[type=password]').click();
  await page.locator('input[type=password]').fill('SyntheticDS1A!Password');
  await page.getByRole('button', { name: 'Sign in securely', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Start Work', exact: true })).toBeVisible();
  await page.goto('/#/staff/document-studio');
  await expect(page.getByRole('button', { name: 'Open Merge PDFs', exact: true })).toBeVisible();
}

async function openTool(page, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  await page.getByRole('button', { name: new RegExp(`^(Open|Continue) ${escaped}$`) }).click();
  await expect(panel(page)).toBeVisible();
}

async function capture(page, name) {
  await panel(page).scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const viewport = page.viewportSize();
  const controls = panel(page).locator('button,select,input');
  for (const control of await controls.all()) {
    if (!await control.isVisible()) continue;
    const box = await control.boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
  }
  await page.screenshot({ path: evidence(`${name}.png`), fullPage: false });
  await panel(page).screenshot({ path: evidence(`${name}-panel.png`) });
}

test('relative rotation submits the existing contract and downloads and saves correct PDF pages', async ({ page }, info) => {
  await login(page);
  await openTool(page, 'Rotate pages');
  await expect(panel(page)).toContainText('Rotates every page by the selected angle from its current orientation.');
  const originalLocatorCount = await panel(page).getByLabel('Matter', { exact: true }).count();
  console.log('Matter locator diagnosis:', JSON.stringify({ originalLocatorCount, wrappingLabels: await panel(page).locator('label').allTextContents() }));
  await select(page, 'Matter').selectOption('DS1A_M');
  await select(page, 'PDF document').selectOption('DS1A_MIXED');
  await select(page, 'Rotation').selectOption('90');
  await capture(page, `${info.project.name}-rotate`);
  const submitted = page.waitForRequest(r => r.url().endsWith('/api/document-tools/rotate-pdf') && r.method() === 'POST');
  const downloaded = page.waitForEvent('download');
  await panel(page).getByRole('button', { name: 'Rotate and Download', exact: true }).click();
  expect((await submitted).postDataJSON()).toMatchObject({ documentId: 'DS1A_MIXED', degrees: 90 });
  const download = await downloaded;
  expect(download.suggestedFilename()).toBe('rotated-document.pdf');
  const output = evidence(`${info.project.name}-browser-rotation.pdf`);
  await download.saveAs(output);
  const pages = await pdfFixture.inspectPdf(fs.readFileSync(output));
  expect(pages.map(p => p.rotation)).toEqual([90, 180, 270, 0]);
  const original = await pdfFixture.inspectPdf(fixture.sources.DS1A_MIXED);
  expect(pages.map(({ rotation, ...p }) => p)).toEqual(original.map(({ rotation, ...p }) => p));
  await expect(panel(page)).toContainText('Rotated PDF downloaded.');
  const savedResponse = page.waitForResponse(r => r.url().endsWith('/api/document-tools/rotate-pdf/save') && r.request().method() === 'POST');
  await panel(page).getByRole('button', { name: 'Save to matter documents', exact: true }).click();
  const response = await savedResponse;
  expect(response.status()).toBe(200);
  const saved = await response.json();
  const row = await fixture.sql.get('SELECT content,clientVisible FROM documents WHERE id=?', [saved.id]);
  expect((await pdfFixture.inspectPdf(row.content)).map(p => p.rotation)).toEqual([90, 180, 270, 0]);
  expect(Number(row.clientVisible)).toBe(0);
  expect((await fixture.sql.get("SELECT content FROM documents WHERE id='DS1A_MIXED'")).content).toEqual(fixture.sources.DS1A_MIXED);
  await expect(panel(page)).toContainText('Saved to matter documents.');
});

test('accurate descriptions retain reorder, overlay, court bundle and stamp navigation', async ({ page }, info) => {
  await login(page);
  await openTool(page, 'Reorder / Select Pages');
  await expect(panel(page)).toContainText('Creates one output PDF with the selected pages in the specified order.');
  await expect(panel(page)).toContainText('Creates one PDF, not separate files.');
  await select(page, 'Matter').selectOption('DS1A_M');
  await select(page, 'PDF document').selectOption('DS1A_MIXED');
  await panel(page).getByPlaceholder('3,1,2', { exact: true }).fill('3,1,2');
  const downloaded = page.waitForEvent('download');
  await panel(page).getByRole('button', { name: 'Apply and Download', exact: true }).click();
  const output = evidence(`${info.project.name}-reordered.pdf`);
  await (await downloaded).saveAs(output);
  const source = await pdfFixture.inspectPdf(fixture.sources.DS1A_MIXED);
  // copyPages may renumber resource references; compare content and page identity.
  const pageIdentity = ({ resources, ...p }) => p;
  expect((await pdfFixture.inspectPdf(fs.readFileSync(output))).map(pageIdentity)).toEqual([source[2], source[0], source[1]].map(pageIdentity));
  await capture(page, `${info.project.name}-reorder`);
  await openTool(page, 'Tenth-line overlay (approximate)');
  for (const text of ['does not detect actual text lines', 'page margins and line spacing', 'scanned PDFs and irregular layouts may not align', 'Inspect the generated PDF before relying on it for court filing', 'does not check court formatting rules']) await expect(panel(page)).toContainText(text);
  await expect(page.getByText('Tenth-lining / appellate formatting', { exact: true })).toHaveCount(0);
  await capture(page, `${info.project.name}-overlay`);
  await openTool(page, 'Court bundle prep');
  await expect(panel(page).getByRole('button', { name: 'Bundle and Download', exact: true })).toBeVisible();
  await openTool(page, 'Sign / stamp PDF');
  await expect(panel(page).getByRole('button', { name: 'Stamp and Download', exact: true })).toBeVisible();
  await openTool(page, 'Merge PDFs');
  await expect(panel(page).getByRole('button', { name: 'Merge and Download', exact: true })).toBeVisible();
});

test('mobile description screenshots below the fixed work timer', async ({ page }, info) => {
  test.skip(info.project.name !== 'mobile', 'Supplementary mobile visual inspection');
  await login(page);
  for (const [name, slug] of [['Rotate pages', 'rotate'], ['Reorder / Select Pages', 'reorder'], ['Tenth-line overlay (approximate)', 'overlay']]) {
    await openTool(page, name);
    // Let the existing delayed smooth navigation finish before adjusting the view.
    await page.waitForTimeout(700);
    const toastClose = page.getByRole('button', { name: 'Dismiss notification', exact: true });
    if (await toastClose.isVisible()) await toastClose.click();
    const bar = await page.getByRole('region', { name: 'Persistent work timer', exact: true }).boundingBox();
    const top = bar.y + bar.height + 20;
    await panel(page).evaluate((element, offset) => window.scrollTo({ top: window.scrollY + element.getBoundingClientRect().top - offset, behavior: 'instant' }), top);
    const bounds = await panel(page).boundingBox();
    expect(bounds.y).toBeGreaterThanOrEqual(bar.y + bar.height);
    await page.screenshot({ path: evidence(`mobile-${slug}-description.png`), fullPage: false });
  }
});
