import { expect, test } from '@playwright/test';

const HARNESS_PATH = '/tests/fixtures/matter-documents-harness.html';

function createState(overrides = {}) {
  return {
    activeFolders: overrides.activeFolders || [
      { id: 'all', name: 'All Documents', virtual: true },
      { id: 'uncategorised', name: 'Uncategorised', virtual: true },
      { id: 'F-UPLOADS', name: '  CLIENT UPLOADS  ' },
      { id: 'F-CUSTOM', name: 'Pleadings' },
      { id: 'F-EMPTY', name: 'Empty Folder' },
    ],
    archivedFolders: overrides.archivedFolders || [
      { id: 'F-ARCH', matterId: 'MAT-1', name: 'Former Correspondence', createdBy: 'mock-user', createdAt: '2026-07-01T08:00:00.000Z', archivedAt: '2026-07-10T08:00:00.000Z' },
    ],
    activeDocuments: overrides.activeDocuments || [
      { id: 'DOC-1', displayName: 'Pleading.pdf', name: 'pleading.pdf', mimeType: 'application/pdf', folderId: 'F-CUSTOM', folderName: 'Pleadings', date: '2026-07-10', size: '12 KB', source: 'firm', clientVisible: false },
    ],
    archivedDocuments: overrides.archivedDocuments || [
      { id: 'DOC-ARCH', displayName: 'Old draft.pdf', name: 'old-draft.pdf', mimeType: 'application/pdf', folderId: 'F-ARCH', folderName: 'Former Correspondence', date: '2026-07-09', size: '8 KB', source: 'firm', clientVisible: false },
    ],
  };
}

async function installMockApi(page, options = {}) {
  const state = createState(options.state);
  const counters = {
    archivedList: 0,
    archive: 0,
    restore: 0,
    rename: 0,
    delete: 0,
  };
  const unexpected = [];
  const queuedArchivedResponses = [...(options.archivedFolderResponses || [])];

  const fulfillJson = (route, status, body) => route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });

  await page.route('**/api/**', async route => {
    const request = route.request();
    const method = request.method();
    const url = new URL(request.url());
    const path = url.pathname;

    if (method === 'GET' && path === '/api/document-templates') {
      await fulfillJson(route, 200, []);
      return;
    }

    if (method === 'GET' && /^\/api\/matters\/[^/]+\/folders$/.test(path)) {
      if (url.searchParams.get('status') === 'archived') {
        counters.archivedList += 1;
        const queued = queuedArchivedResponses.shift();
        const response = queued || { status: 200, body: state.archivedFolders, delay: options.archivedListDelay };
        if (response.delay) await new Promise(resolve => setTimeout(resolve, response.delay));
        await fulfillJson(route, response.status || 200, response.body ?? state.archivedFolders);
        return;
      }
      await fulfillJson(route, 200, state.activeFolders);
      return;
    }

    if (method === 'GET' && /^\/api\/matters\/[^/]+\/documents$/.test(path)) {
      await fulfillJson(route, 200, url.searchParams.get('status') === 'archived' ? state.archivedDocuments : state.activeDocuments);
      return;
    }

    const archiveMatch = path.match(/^\/api\/folders\/([^/]+)\/archive$/);
    if (method === 'PATCH' && archiveMatch) {
      counters.archive += 1;
      if (options.mutationDelay) await new Promise(resolve => setTimeout(resolve, options.mutationDelay));
      const folderId = decodeURIComponent(archiveMatch[1]);
      const index = state.activeFolders.findIndex(folder => String(folder.id) === folderId);
      if (index < 0) {
        await fulfillJson(route, 404, { error: 'Folder not found' });
        return;
      }
      const [folder] = state.activeFolders.splice(index, 1);
      const archived = { ...folder, matterId: 'MAT-1', createdBy: 'mock-user', createdAt: '2026-07-01T08:00:00.000Z', archivedAt: '2026-07-11T08:00:00.000Z' };
      state.archivedFolders.push(archived);
      await fulfillJson(route, 200, archived);
      return;
    }

    const restoreMatch = path.match(/^\/api\/folders\/([^/]+)\/restore$/);
    if (method === 'PATCH' && restoreMatch) {
      counters.restore += 1;
      if (options.mutationDelay) await new Promise(resolve => setTimeout(resolve, options.mutationDelay));
      const folderId = decodeURIComponent(restoreMatch[1]);
      const index = state.archivedFolders.findIndex(folder => String(folder.id) === folderId);
      if (index < 0) {
        await fulfillJson(route, 404, { error: 'Folder not found' });
        return;
      }
      const [folder] = state.archivedFolders.splice(index, 1);
      const restored = { ...folder, archivedAt: null };
      delete restored.virtual;
      state.activeFolders.push(restored);
      await fulfillJson(route, 200, restored);
      return;
    }

    const folderMatch = path.match(/^\/api\/folders\/([^/]+)$/);
    if (method === 'PATCH' && folderMatch) {
      counters.rename += 1;
      const folderId = decodeURIComponent(folderMatch[1]);
      const folder = state.activeFolders.find(item => String(item.id) === folderId);
      const payload = request.postDataJSON();
      if (!folder) {
        await fulfillJson(route, 404, { error: 'Folder not found' });
        return;
      }
      Object.assign(folder, payload);
      await fulfillJson(route, 200, folder);
      return;
    }

    if (method === 'DELETE' && folderMatch) {
      counters.delete += 1;
      const folderId = decodeURIComponent(folderMatch[1]);
      state.activeFolders = state.activeFolders.filter(folder => String(folder.id) !== folderId);
      await fulfillJson(route, 200, { ok: true });
      return;
    }

    unexpected.push(`${method} ${url.pathname}${url.search}`);
    await fulfillJson(route, 404, { error: `Unexpected mocked request: ${method} ${path}` });
  });

  return { state, counters, unexpected };
}

async function mountMatterDocuments(page, props = {}) {
  await page.goto(HARNESS_PATH);
  await page.waitForFunction(() => window.__matterHarnessReady === true);
  await page.evaluate(nextProps => window.renderMatterDocuments(nextProps), {
    matterId: props.matterId || 'MAT-1',
    canManage: props.canManage ?? true,
    clientMode: props.clientMode ?? false,
  });
  await expect(page.getByRole('heading', { name: 'Folders', exact: true })).toBeVisible();
}

function folderButton(page, name) {
  return page.locator('.lf-doc-folder-button').filter({ hasText: name }).first();
}

function selectedFolderActions(page) {
  return page.getByText('Selected folder actions', { exact: true }).locator('..');
}

test.describe('LOCAL-PILOT-FOLDER-ARCHIVE-RESTORE-UI-87', () => {
  test('archives once after confirmation, keeps documents active, and restores without changing selection', async ({ page }) => {
    const { counters, unexpected } = await installMockApi(page, { mutationDelay: 120, archivedListDelay: 100 });
    await mountMatterDocuments(page);
    await expect(page.getByText('Pleading.pdf', { exact: true })).toBeVisible();

    const archivedDetails = page.locator('details.lf-doc-archived-folders');
    const archiveAction = page.locator('.lf-doc-folder-archive-action');
    await expect(archivedDetails).not.toHaveAttribute('open', '');
    expect(counters.archivedList).toBe(0);

    for (const name of ['All Documents', 'Uncategorised', 'CLIENT UPLOADS', 'Archived documents']) {
      await folderButton(page, name).click();
      await expect(archiveAction).toHaveCount(0);
    }
    expect(counters.archivedList).toBe(0);

    await page.getByRole('button', { name: 'More actions' }).first().click();
    await expect(page.getByRole('menuitem', { name: 'Restore', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');

    await folderButton(page, 'Pleadings').click();
    await expect(archiveAction).toBeVisible();
    await expect(selectedFolderActions(page).getByRole('button', { name: 'Delete', exact: true })).toBeDisabled();

    await archiveAction.click();
    const archiveDialog = page.getByRole('dialog');
    await expect(archiveDialog.getByRole('heading', { name: 'Archive folder', exact: true })).toBeVisible();
    await expect(archiveDialog).toContainText('will not be archived, moved, or deleted');
    await archiveDialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    expect(counters.archive).toBe(0);

    await page.getByRole('checkbox', { name: 'Select Pleading.pdf' }).check();
    await expect(page.getByText('1 selected', { exact: true })).toBeVisible();
    await selectedFolderActions(page).getByRole('button', { name: 'Rename', exact: true }).click();
    await expect(page.getByLabel('Folder name')).toBeVisible();
    await archiveAction.click();
    await page.getByRole('dialog').getByRole('button', { name: 'Confirm', exact: true }).dblclick();

    await expect.poll(() => counters.archive).toBe(1);
    await expect(folderButton(page, 'Pleadings')).toHaveCount(0);
    await expect(folderButton(page, 'All Documents')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByText('0 selected', { exact: true })).toBeVisible();
    await expect(page.getByLabel('Folder name')).toHaveCount(0);
    await expect(page.getByText('Pleading.pdf', { exact: true })).toBeVisible();
    await expect(page.getByText('Pleadings', { exact: true })).toBeVisible();
    expect(counters.archivedList).toBe(0);

    await archivedDetails.locator('summary').click();
    await expect(page.getByText('Loading archived folders…', { exact: true })).toBeVisible();
    const archivedPleadings = page.locator('[data-archived-folder-id="F-CUSTOM"]');
    await expect(archivedPleadings).toContainText('Pleadings');
    await expect(archivedPleadings).toContainText('Archived');
    await expect(archivedPleadings).toContainText('1 active document');
    await expect(page.locator('[data-archived-folder-id="F-ARCH"]')).toContainText('0 active documents');
    expect(counters.archivedList).toBe(1);

    const destinationValues = await page.locator('select option').evaluateAll(options => options.map(option => option.value));
    expect(destinationValues).not.toContain('F-CUSTOM');
    expect(destinationValues).not.toContain('F-ARCH');
    await expect(archivedPleadings.locator('select')).toHaveCount(0);
    await expect(archivedPleadings.locator('[data-document-drop-target]')).toHaveCount(0);
    await expect(archivedPleadings.locator('[aria-pressed]')).toHaveCount(0);

    await archivedDetails.locator('summary').click();
    await archivedDetails.locator('summary').click();
    await page.waitForTimeout(80);
    expect(counters.archivedList).toBe(1);

    await folderButton(page, 'Uncategorised').click();
    await archivedPleadings.getByRole('button', { name: 'Restore', exact: true }).click();
    await expect.poll(() => counters.restore).toBe(1);
    await expect(archivedPleadings).toHaveCount(0);
    await expect(folderButton(page, 'Pleadings')).toBeVisible();
    await expect(folderButton(page, 'Uncategorised')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByText('Pleading.pdf', { exact: true })).toHaveCount(0);
    await expect.poll(() => counters.archivedList).toBe(2);

    await folderButton(page, 'All Documents').click();
    await expect(page.getByText('Pleading.pdf', { exact: true })).toBeVisible();
    await expect(page.getByLabel('Search documents in the current view')).toBeVisible();
    await expect(page.locator('input[type="file"]')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Select visible', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Internal', exact: true })).toBeVisible();
    await expect(page.locator('[data-document-draggable="true"]')).toHaveCount(1);

    await page.getByRole('checkbox', { name: 'Select Pleading.pdf' }).check();
    await expect(page.getByLabel('Move selected to')).toBeVisible();
    await expect(page.getByLabel('Move selected to').locator('option[value="F-CUSTOM"]')).toHaveCount(1);
    await page.getByRole('button', { name: 'More actions' }).first().click();
    for (const action of ['Preview', 'Download', 'Rename', 'Archive']) {
      await expect(page.getByRole('menuitem', { name: action, exact: true })).toBeVisible();
    }

    expect(unexpected).toEqual([]);
  });

  test('isolates archived-list loading, failure, Retry, and empty states', async ({ page }) => {
    const { counters, unexpected } = await installMockApi(page, {
      state: { archivedFolders: [] },
      archivedFolderResponses: [
        { status: 500, body: { error: 'Archived list unavailable' }, delay: 100 },
        { status: 200, body: [], delay: 60 },
      ],
    });
    await mountMatterDocuments(page, { matterId: 'MAT-ERROR' });

    const details = page.locator('details.lf-doc-archived-folders');
    await expect(details).not.toHaveAttribute('open', '');
    expect(counters.archivedList).toBe(0);
    await details.locator('summary').click();
    await expect(page.getByText('Loading archived folders…', { exact: true })).toBeVisible();
    await expect(details.getByRole('alert')).toContainText('Archived list unavailable');
    await expect(page.getByText('Pleading.pdf', { exact: true })).toBeVisible();
    expect(counters.archivedList).toBe(1);

    await details.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect(page.getByText('No archived folders.', { exact: true })).toBeVisible();
    expect(counters.archivedList).toBe(2);
    await details.locator('summary').click();
    await details.locator('summary').click();
    await page.waitForTimeout(80);
    expect(counters.archivedList).toBe(2);
    expect(unexpected).toEqual([]);
  });

  test('does not expose controls or request archived folders for assistants or clients', async ({ page }) => {
    const { counters, unexpected } = await installMockApi(page);
    await mountMatterDocuments(page, { matterId: 'MAT-ASSISTANT', canManage: false, clientMode: false });
    await expect(page.getByText('Pleading.pdf', { exact: true })).toBeVisible();
    await folderButton(page, 'Pleadings').click();
    await expect(page.locator('details.lf-doc-archived-folders')).toHaveCount(0);
    await expect(page.locator('.lf-doc-folder-archive-action')).toHaveCount(0);
    expect(counters.archivedList).toBe(0);

    await page.evaluate(() => window.renderMatterDocuments({ matterId: 'MAT-CLIENT', canManage: false, clientMode: true }));
    await expect(page.getByText('Pleading.pdf', { exact: true })).toBeVisible();
    await folderButton(page, 'Pleadings').click();
    await expect(page.locator('details.lf-doc-archived-folders')).toHaveCount(0);
    await expect(page.locator('.lf-doc-folder-archive-action')).toHaveCount(0);
    await page.waitForTimeout(80);
    expect(counters.archivedList).toBe(0);
    expect(unexpected).toEqual([]);
  });

  test('keeps archived rows and lifecycle controls usable without 390px overflow', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 900 });
    const longName = 'Long archived correspondence folder name that wraps safely';
    const { unexpected } = await installMockApi(page, {
      state: {
        archivedFolders: [
          { id: 'F-LONG', matterId: 'MAT-MOBILE', name: longName, createdBy: 'mock-user', createdAt: '2026-07-01T08:00:00.000Z', archivedAt: '2026-07-10T08:00:00.000Z' },
        ],
      },
    });
    await mountMatterDocuments(page, { matterId: 'MAT-MOBILE' });

    const details = page.locator('details.lf-doc-archived-folders');
    await expect(details).not.toHaveAttribute('open', '');
    await folderButton(page, 'Pleadings').click();
    const archiveAction = page.locator('.lf-doc-folder-archive-action');
    await expect(archiveAction).toBeVisible();
    expect((await archiveAction.boundingBox()).height).toBeGreaterThanOrEqual(44);
    await archiveAction.click();
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();

    await details.locator('summary').click();
    const archivedRow = page.locator('[data-archived-folder-id="F-LONG"]');
    await expect(archivedRow).toContainText(longName);
    const restoreAction = archivedRow.getByRole('button', { name: 'Restore', exact: true });
    expect((await restoreAction.boundingBox()).height).toBeGreaterThanOrEqual(44);

    await page.getByRole('checkbox', { name: 'Select Pleading.pdf' }).check();
    await expect(page.getByRole('button', { name: 'Move selected', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'More actions' }).first()).toBeVisible();
    await expect(page.locator('[data-document-draggable="true"]')).toHaveCount(0);

    const layout = await page.evaluate(() => {
      const row = document.querySelector('[data-archived-folder-id="F-LONG"]');
      const rect = row.getBoundingClientRect();
      return {
        clientWidth: document.documentElement.clientWidth,
        documentWidth: document.documentElement.scrollWidth,
        bodyWidth: document.body.scrollWidth,
        rowLeft: rect.left,
        rowRight: rect.right,
      };
    });
    expect(layout.documentWidth).toBeLessThanOrEqual(layout.clientWidth);
    expect(layout.bodyWidth).toBeLessThanOrEqual(layout.clientWidth);
    expect(layout.rowLeft).toBeGreaterThanOrEqual(0);
    expect(layout.rowRight).toBeLessThanOrEqual(layout.clientWidth);
    expect(unexpected).toEqual([]);
  });

  test('preserves existing rename and hard-delete behavior for active custom folders', async ({ page }) => {
    const { counters, unexpected } = await installMockApi(page);
    await mountMatterDocuments(page);
    await folderButton(page, 'Empty Folder').click();

    const actions = selectedFolderActions(page);
    await actions.getByRole('button', { name: 'Rename', exact: true }).click();
    await page.getByLabel('Folder name').fill('Renamed Empty Folder');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(folderButton(page, 'Renamed Empty Folder')).toBeVisible();
    expect(counters.rename).toBe(1);

    await folderButton(page, 'Renamed Empty Folder').click();
    await actions.getByRole('button', { name: 'Delete', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Confirm', exact: true }).click();
    await expect(folderButton(page, 'Renamed Empty Folder')).toHaveCount(0);
    expect(counters.delete).toBe(1);
    expect(counters.archive).toBe(0);
    expect(unexpected).toEqual([]);
  });
});
