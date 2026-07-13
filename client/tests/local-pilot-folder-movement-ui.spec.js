import { expect, test } from '@playwright/test';

const HARNESS_PATH = '/tests/fixtures/matter-documents-harness.html';

function createState() {
  const depthFolders = [];
  let parentId = null;
  for (let depth = 1; depth <= 7; depth += 1) {
    const id = `F-DEPTH-${depth}`;
    depthFolders.push({ id, name: depth === 1 ? 'AAA Depth 1' : `Depth ${depth}`, parentId });
    parentId = id;
  }

  return {
    activeFolders: [
      { id: 'all', name: 'All Documents', virtual: true },
      { id: 'uncategorised', name: 'Uncategorised', virtual: true },
      { id: 'F-UPLOADS', name: 'Client Uploads', parentId: null },
      ...depthFolders,
      { id: 'F-ROOT', name: 'Case Files', parentId: null },
      { id: 'F-CHILD', name: '2026', parentId: 'F-ROOT' },
      { id: 'F-MOVE', name: 'Evidence', parentId: 'F-CHILD' },
      { id: 'F-MOVE-DESC', name: 'Exhibits', parentId: 'F-MOVE' },
      { id: 'F-OTHER', name: 'Correspondence', parentId: null },
      { id: 'F-OTHER-CHILD', name: 'Incoming', parentId: 'F-OTHER' },
      { id: 'F-ARCHIVED', name: 'Archived Destination', parentId: null, archivedAt: '2026-07-12T08:00:00.000Z' },
      { id: 'F-INACTIVE', name: 'Inactive Destination', parentId: 'F-ARCHIVED' },
    ],
    activeDocuments: [
      { id: 'DOC-EVIDENCE', displayName: 'Evidence brief.pdf', name: 'evidence-brief.pdf', mimeType: 'application/pdf', folderId: 'F-MOVE', folderName: 'Evidence', date: '2026-07-13', size: '12 KB', source: 'firm', clientVisible: false },
      { id: 'DOC-EXHIBIT', displayName: 'Exhibit A.pdf', name: 'exhibit-a.pdf', mimeType: 'application/pdf', folderId: 'F-MOVE-DESC', folderName: 'Exhibits', date: '2026-07-13', size: '8 KB', source: 'firm', clientVisible: false },
    ],
  };
}

async function installMockApi(page, options = {}) {
  const state = createState();
  const calls = {
    folderMoves: [],
    documentMutations: [],
  };
  const unexpected = [];
  const originalDocuments = structuredClone(state.activeDocuments);

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
      await fulfillJson(route, 200, state.activeFolders);
      return;
    }
    if (method === 'GET' && /^\/api\/matters\/[^/]+\/documents$/.test(path)) {
      await fulfillJson(route, 200, url.searchParams.get('status') === 'archived' ? [] : state.activeDocuments);
      return;
    }

    const moveMatch = path.match(/^\/api\/folders\/([^/]+)\/move$/);
    if (method === 'PATCH' && moveMatch) {
      const folderId = decodeURIComponent(moveMatch[1]);
      const payload = request.postDataJSON();
      calls.folderMoves.push({ folderId, payload });
      if (options.moveDelay) await new Promise(resolve => setTimeout(resolve, options.moveDelay));
      const folder = state.activeFolders.find(item => String(item.id) === folderId);
      if (!folder) {
        await fulfillJson(route, 404, { error: 'Folder not found' });
        return;
      }
      folder.parentId = payload.parentId || null;
      await fulfillJson(route, 200, {
        id: folder.id,
        matterId: 'MAT-MOVE',
        name: folder.name,
        createdBy: 'mock-user',
        createdAt: '2026-07-13T08:00:00.000Z',
        parentId: folder.parentId,
      });
      return;
    }

    if (method !== 'GET' && /^\/api\/documents\//.test(path)) {
      calls.documentMutations.push(`${method} ${path}`);
    }
    unexpected.push(`${method} ${url.pathname}${url.search}`);
    await fulfillJson(route, 404, { error: `Unexpected mocked request: ${method} ${path}` });
  });

  return { calls, originalDocuments, state, unexpected };
}

async function mountMatterDocuments(page, props = {}) {
  await page.goto(HARNESS_PATH);
  await page.waitForFunction(() => window.__matterHarnessReady === true);
  await page.evaluate(nextProps => window.renderMatterDocuments(nextProps), {
    matterId: props.matterId || 'MAT-MOVE',
    canManage: props.canManage ?? true,
    clientMode: props.clientMode ?? false,
  });
  await expect(page.getByRole('heading', { name: 'Folders', exact: true })).toBeVisible();
}

async function selectEvidenceWithDesktopKeyboard(page) {
  const root = page.locator('[role="treeitem"][data-folder-id="F-ROOT"]');
  await root.focus();
  await page.keyboard.press('ArrowRight');
  const child = page.locator('[role="treeitem"][data-folder-id="F-CHILD"]');
  await expect(child).toBeVisible();
  await child.focus();
  await page.keyboard.press('ArrowRight');
  const evidence = page.locator('[role="treeitem"][data-folder-id="F-MOVE"]');
  await expect(evidence).toBeVisible();
  await evidence.focus();
  await page.keyboard.press('Enter');
  await expect(evidence).toHaveAttribute('aria-selected', 'true');
  return evidence;
}

test.describe('LOCAL-PILOT-FOLDER-MOVEMENT-UI-90', () => {
  test('offers safe full-path destinations and completes a branch move entirely from the keyboard', async ({ page }) => {
    const { calls, originalDocuments, state, unexpected } = await installMockApi(page, { moveDelay: 80 });
    await mountMatterDocuments(page);
    const evidence = await selectEvidenceWithDesktopKeyboard(page);
    await expect(evidence).not.toHaveAttribute('draggable', 'true');

    const moveAction = page.getByRole('button', { name: 'Move Folder', exact: true });
    await moveAction.focus();
    await page.keyboard.press('Enter');

    const dialog = page.getByRole('dialog', { name: 'Move Folder' });
    await expect(dialog).toBeVisible();
    const destination = dialog.getByLabel('Destination');
    await expect(destination).toBeFocused();
    await expect(dialog).toContainText('Its 1 descendant folder');
    await expect(dialog).toContainText('all document records keep their existing links');

    const options = await destination.locator('option').evaluateAll(optionNodes => optionNodes.map(option => ({
      value: option.value,
      label: option.textContent,
      disabled: option.disabled,
    })));
    expect(options).toContainEqual({ value: '', label: 'Root (top level)', disabled: false });
    expect(options).toContainEqual({ value: 'F-OTHER', label: 'Correspondence', disabled: false });
    expect(options).toContainEqual({ value: 'F-OTHER-CHILD', label: 'Correspondence / Incoming', disabled: false });
    expect(options).toContainEqual({ value: 'F-CHILD', label: 'Case Files / 2026', disabled: true });
    expect(options.map(option => option.value)).not.toContain('F-MOVE');
    expect(options.map(option => option.value)).not.toContain('F-MOVE-DESC');
    expect(options.map(option => option.value)).not.toContain('F-UPLOADS');
    expect(options.map(option => option.value)).not.toContain('F-ARCHIVED');
    expect(options.map(option => option.value)).not.toContain('F-INACTIVE');
    expect(options.map(option => option.value)).not.toContain('F-DEPTH-7');
    expect(options.map(option => option.value)).toContain('F-DEPTH-6');

    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(moveAction).toBeFocused();
    await page.keyboard.press('Enter');
    const reopenedDialog = page.getByRole('dialog', { name: 'Move Folder' });
    const reopenedDestination = reopenedDialog.getByLabel('Destination');
    await expect(reopenedDestination).toBeFocused();
    await page.keyboard.press('End');
    await expect(reopenedDestination).toHaveValue('F-OTHER-CHILD');
    await page.keyboard.press('Tab');
    await expect(reopenedDialog.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
    await page.keyboard.press('Tab');
    const confirmMove = reopenedDialog.getByRole('button', { name: 'Move Folder', exact: true });
    await expect(confirmMove).toBeFocused();
    await page.keyboard.press('Enter');

    await expect.poll(() => calls.folderMoves).toEqual([
      { folderId: 'F-MOVE', payload: { parentId: 'F-OTHER-CHILD' } },
    ]);
    await expect(reopenedDialog).toHaveCount(0);
    await expect(page.locator('[role="treeitem"][data-folder-path="Correspondence / Incoming / Evidence"]')).toBeVisible();
    await expect(page.locator('[role="treeitem"][data-folder-id="F-MOVE"]')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('navigation', { name: 'Folder breadcrumb' })).toContainText('All Documents/Correspondence/Incoming/Evidence');
    expect(state.activeFolders.find(folder => folder.id === 'F-MOVE-DESC').parentId).toBe('F-MOVE');
    expect(state.activeDocuments).toEqual(originalDocuments);
    expect(calls.documentMutations).toEqual([]);
    expect(unexpected).toEqual([]);
  });

  test('does not expose Move Folder to unauthorized staff or clients', async ({ page }) => {
    const { calls, unexpected } = await installMockApi(page);
    await mountMatterDocuments(page, { canManage: false, clientMode: false });
    await expect(page.getByRole('button', { name: 'Move Folder', exact: true })).toHaveCount(0);

    await page.evaluate(() => window.renderMatterDocuments({ matterId: 'MAT-CLIENT-MOVE', canManage: false, clientMode: true }));
    await expect(page.getByRole('heading', { name: 'Folders', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Move Folder', exact: true })).toHaveCount(0);
    expect(calls.folderMoves).toEqual([]);
    expect(unexpected).toEqual([]);
  });

  test('keeps the dialog and refreshed drill-down usable without overflow at 390px', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 900 });
    const { calls, originalDocuments, state, unexpected } = await installMockApi(page);
    await mountMatterDocuments(page, { matterId: 'MAT-MOBILE-MOVE' });

    await page.getByRole('button', { name: 'Open Case Files', exact: true }).click();
    await page.getByRole('button', { name: 'Open 2026', exact: true }).click();
    await page.locator('.lf-doc-mobile-folder-row[data-folder-path="Case Files / 2026 / Evidence"] .lf-doc-folder-button').click();
    const moveAction = page.getByRole('button', { name: 'Move Folder', exact: true });
    expect((await moveAction.boundingBox()).height).toBeGreaterThanOrEqual(44);
    await moveAction.click();

    const dialog = page.getByRole('dialog', { name: 'Move Folder' });
    const destination = dialog.getByLabel('Destination');
    expect((await destination.boundingBox()).height).toBeGreaterThanOrEqual(44);
    await destination.selectOption('');
    const confirmMove = dialog.getByRole('button', { name: 'Move Folder', exact: true });
    expect((await confirmMove.boundingBox()).height).toBeGreaterThanOrEqual(44);

    const dialogBounds = await dialog.locator('form').boundingBox();
    expect(dialogBounds.x).toBeGreaterThanOrEqual(0);
    expect(dialogBounds.x + dialogBounds.width).toBeLessThanOrEqual(390);
    await confirmMove.click();

    await expect.poll(() => calls.folderMoves).toEqual([
      { folderId: 'F-MOVE', payload: { parentId: null } },
    ]);
    await expect(dialog).toHaveCount(0);
    await expect(page.locator('.lf-doc-mobile-folder-row[data-folder-path="Evidence"]')).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Folder browser location' })).toContainText('Root');
    await expect(page.getByRole('navigation', { name: 'Folder breadcrumb' })).toContainText('All Documents/Evidence');

    const layout = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      documentWidth: document.documentElement.scrollWidth,
      bodyWidth: document.body.scrollWidth,
      browserWidth: document.querySelector('.lf-doc-mobile-browser')?.getBoundingClientRect().width || 0,
    }));
    expect(layout.documentWidth).toBeLessThanOrEqual(layout.clientWidth);
    expect(layout.bodyWidth).toBeLessThanOrEqual(layout.clientWidth);
    expect(layout.browserWidth).toBeLessThanOrEqual(layout.clientWidth);
    expect(state.activeFolders.find(folder => folder.id === 'F-MOVE-DESC').parentId).toBe('F-MOVE');
    expect(state.activeDocuments).toEqual(originalDocuments);
    expect(calls.documentMutations).toEqual([]);
    expect(unexpected).toEqual([]);
  });
});
