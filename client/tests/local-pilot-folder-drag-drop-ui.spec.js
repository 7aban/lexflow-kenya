import { expect, test } from '@playwright/test';

const HARNESS_PATH = '/tests/fixtures/matter-documents-harness.html';
const FOLDER_DRAG_TYPE = 'application/x-lexflow-folder-id';
const DOCUMENT_DRAG_TYPE = 'application/x-lexflow-document-id';

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
      { id: 'F-COLLISION', name: 'Collision Branch', parentId: null },
      { id: 'F-COLLISION-EVIDENCE', name: 'Evidence', parentId: 'F-COLLISION' },
      { id: 'F-ARCHIVED', name: 'Archived Destination', parentId: null, archivedAt: '2026-07-12T08:00:00.000Z' },
      { id: 'F-INACTIVE', name: 'Inactive Destination', parentId: 'F-ARCHIVED' },
    ],
    activeDocuments: [
      { id: 'DOC-EVIDENCE', displayName: 'Evidence brief.pdf', name: 'evidence-brief.pdf', mimeType: 'application/pdf', folderId: 'F-MOVE', folderName: 'Evidence', date: '2026-07-13', size: '12 KB', source: 'firm', clientVisible: false },
      { id: 'DOC-EXHIBIT', displayName: 'Exhibit A.pdf', name: 'exhibit-a.pdf', mimeType: 'application/pdf', folderId: 'F-MOVE-DESC', folderName: 'Exhibits', date: '2026-07-13', size: '8 KB', source: 'firm', clientVisible: false },
      { id: 'DOC-OTHER', displayName: 'Incoming note.pdf', name: 'incoming-note.pdf', mimeType: 'application/pdf', folderId: 'F-OTHER-CHILD', folderName: 'Incoming', date: '2026-07-13', size: '5 KB', source: 'firm', clientVisible: false },
    ],
  };
}

async function installMockApi(page, options = {}) {
  const state = createState();
  const calls = {
    folderMoves: [],
    documentMoves: [],
  };
  const unexpected = [];
  const originalDocuments = structuredClone(state.activeDocuments);
  let remainingMoveFailures = options.failMoveCount || 0;

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

    const folderMoveMatch = path.match(/^\/api\/folders\/([^/]+)\/move$/);
    if (method === 'PATCH' && folderMoveMatch) {
      const folderId = decodeURIComponent(folderMoveMatch[1]);
      const payload = request.postDataJSON();
      calls.folderMoves.push({ folderId, payload });
      if (options.moveDelay) await new Promise(resolve => setTimeout(resolve, options.moveDelay));
      if (remainingMoveFailures > 0) {
        remainingMoveFailures -= 1;
        await fulfillJson(route, 409, { error: 'Folder hierarchy is busy; try the move again' });
        return;
      }
      const folder = state.activeFolders.find(item => String(item.id) === folderId);
      if (!folder) {
        await fulfillJson(route, 404, { error: 'Folder not found' });
        return;
      }
      folder.parentId = payload.parentId || null;
      await fulfillJson(route, 200, {
        id: folder.id,
        matterId: 'MAT-DRAG',
        name: folder.name,
        createdBy: 'mock-user',
        createdAt: '2026-07-13T08:00:00.000Z',
        parentId: folder.parentId,
      });
      return;
    }

    const documentMatch = path.match(/^\/api\/documents\/([^/]+)$/);
    if (method === 'PATCH' && documentMatch) {
      const documentId = decodeURIComponent(documentMatch[1]);
      const payload = request.postDataJSON();
      calls.documentMoves.push({ documentId, payload });
      const document = state.activeDocuments.find(item => String(item.id) === documentId);
      if (!document) {
        await fulfillJson(route, 404, { error: 'Document not found' });
        return;
      }
      document.folderId = payload.folderId || null;
      await fulfillJson(route, 200, document);
      return;
    }

    unexpected.push(`${method} ${url.pathname}${url.search}`);
    await fulfillJson(route, 404, { error: `Unexpected mocked request: ${method} ${path}` });
  });

  return { calls, originalDocuments, state, unexpected };
}

async function mountMatterDocuments(page, props = {}) {
  if (!props.preserveViewport) await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(HARNESS_PATH);
  await page.waitForFunction(() => window.__matterHarnessReady === true);
  await page.evaluate(nextProps => window.renderMatterDocuments(nextProps), {
    matterId: props.matterId || 'MAT-DRAG',
    canManage: props.canManage ?? true,
    clientMode: props.clientMode ?? false,
  });
  await expect(page.getByRole('heading', { name: 'Folders', exact: true })).toBeVisible();
}

function treeItem(page, folderId) {
  return page.locator(`[role="treeitem"][data-folder-id="${folderId}"]`);
}

async function expandFolder(page, folderId) {
  const item = treeItem(page, folderId);
  await expect(item).toBeVisible();
  if (await item.getAttribute('aria-expanded') === 'false') {
    await item.locator('[data-tree-toggle="true"]').click();
    await expect(item).toHaveAttribute('aria-expanded', 'true');
  }
}

async function revealEvidence(page, { includeDescendant = false } = {}) {
  await expandFolder(page, 'F-ROOT');
  await expandFolder(page, 'F-CHILD');
  if (includeDescendant) await expandFolder(page, 'F-MOVE');
  await expect(treeItem(page, 'F-MOVE')).toBeVisible();
}

async function revealDepthChain(page) {
  for (let depth = 1; depth <= 6; depth += 1) {
    await expandFolder(page, `F-DEPTH-${depth}`);
  }
  await expect(treeItem(page, 'F-DEPTH-7')).toBeVisible();
}

async function beginFolderDrag(page, source) {
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  await source.dispatchEvent('dragstart', { dataTransfer });
  await expect(source).toHaveAttribute('data-folder-drag-source', 'true');
  return dataTransfer;
}

async function hoverDragTarget(target, dataTransfer) {
  await target.dispatchEvent('dragenter', { dataTransfer });
  await target.dispatchEvent('dragover', { dataTransfer });
}

async function dropFolder(source, target, dataTransfer) {
  await hoverDragTarget(target, dataTransfer);
  await target.dispatchEvent('drop', { dataTransfer });
  await source.dispatchEvent('dragend', { dataTransfer });
  await dataTransfer.dispose();
}

test.describe('LOCAL-PILOT-FOLDER-DRAG-DROP-91', () => {
  test('moves a root branch into a child with source, eligible, active, and pending states', async ({ page }) => {
    const { calls, originalDocuments, state, unexpected } = await installMockApi(page, { moveDelay: 180 });
    await mountMatterDocuments(page);
    const source = treeItem(page, 'F-OTHER');
    const destination = treeItem(page, 'F-ROOT');
    await expect(source).toHaveAttribute('data-folder-draggable', 'true');

    const dataTransfer = await beginFolderDrag(page, source);
    expect(await dataTransfer.evaluate(transfer => Array.from(transfer.types))).toEqual([FOLDER_DRAG_TYPE]);
    await expect(destination).toHaveAttribute('data-folder-drop-state', 'eligible');
    await hoverDragTarget(destination, dataTransfer);
    await expect(destination).toHaveAttribute('data-folder-drop-active', 'eligible');
    await destination.dispatchEvent('drop', { dataTransfer });
    await expect(source).toHaveAttribute('data-folder-move-pending', 'true');
    await source.dispatchEvent('dragend', { dataTransfer });
    await dataTransfer.dispose();

    await expect.poll(() => calls.folderMoves).toEqual([
      { folderId: 'F-OTHER', payload: { parentId: 'F-ROOT' } },
    ]);
    await expect(page.locator('[role="treeitem"][data-folder-path="Case Files / Correspondence"]')).toBeVisible();
    await expect(treeItem(page, 'F-OTHER')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('navigation', { name: 'Folder breadcrumb' })).toContainText('All Documents/Case Files/Correspondence');
    expect(state.activeFolders.find(folder => folder.id === 'F-OTHER-CHILD').parentId).toBe('F-OTHER');
    expect(state.activeDocuments).toEqual(originalDocuments);
    expect(calls.documentMoves).toEqual([]);
    expect(unexpected).toEqual([]);
  });

  test('moves a child branch to the root drop area and keeps descendants and documents linked', async ({ page }) => {
    const { calls, originalDocuments, state, unexpected } = await installMockApi(page);
    await mountMatterDocuments(page);
    await revealEvidence(page);
    const source = treeItem(page, 'F-MOVE');
    const rootTarget = page.locator('[data-folder-root-drop-zone="true"]');
    const dataTransfer = await beginFolderDrag(page, source);
    await expect(rootTarget).toHaveAttribute('data-folder-drop-state', 'eligible');
    await dropFolder(source, rootTarget, dataTransfer);

    await expect.poll(() => calls.folderMoves).toEqual([
      { folderId: 'F-MOVE', payload: { parentId: null } },
    ]);
    await expect(page.locator('[role="treeitem"][data-folder-path="Evidence"]')).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Folder breadcrumb' })).toContainText('All Documents/Evidence');
    expect(state.activeFolders.find(folder => folder.id === 'F-MOVE-DESC').parentId).toBe('F-MOVE');
    expect(state.activeDocuments).toEqual(originalDocuments);
    expect(calls.documentMoves).toEqual([]);
    expect(unexpected).toEqual([]);
  });

  test('expands a branch while dragging and completes a branch-to-branch move', async ({ page }) => {
    const { calls, originalDocuments, state, unexpected } = await installMockApi(page);
    await mountMatterDocuments(page);
    await revealEvidence(page);
    const source = treeItem(page, 'F-MOVE');
    const collapsedBranch = treeItem(page, 'F-OTHER');
    await expect(collapsedBranch).toHaveAttribute('aria-expanded', 'false');

    const dataTransfer = await beginFolderDrag(page, source);
    await hoverDragTarget(collapsedBranch, dataTransfer);
    await expect(collapsedBranch).toHaveAttribute('data-folder-drop-active', 'eligible');
    await expect(treeItem(page, 'F-OTHER-CHILD')).toBeVisible({ timeout: 2500 });
    const destination = treeItem(page, 'F-OTHER-CHILD');
    await dropFolder(source, destination, dataTransfer);

    await expect.poll(() => calls.folderMoves).toEqual([
      { folderId: 'F-MOVE', payload: { parentId: 'F-OTHER-CHILD' } },
    ]);
    await expect(page.locator('[role="treeitem"][data-folder-path="Correspondence / Incoming / Evidence"]')).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Folder breadcrumb' })).toContainText('All Documents/Correspondence/Incoming/Evidence');
    expect(state.activeFolders.find(folder => folder.id === 'F-MOVE-DESC').parentId).toBe('F-MOVE');
    expect(state.activeDocuments).toEqual(originalDocuments);
    expect(calls.documentMoves).toEqual([]);
    expect(unexpected).toEqual([]);
  });

  test('marks self, descendant, protected, virtual, collision, and depth targets invalid while excluding inactive folders', async ({ page }) => {
    const { calls, unexpected } = await installMockApi(page);
    await mountMatterDocuments(page);
    await revealEvidence(page, { includeDescendant: true });
    await revealDepthChain(page);
    const source = treeItem(page, 'F-MOVE');
    const dataTransfer = await beginFolderDrag(page, source);

    await expect(source).toHaveAttribute('data-folder-drop-state', 'invalid');
    await expect(treeItem(page, 'F-MOVE-DESC')).toHaveAttribute('data-folder-drop-state', 'invalid');
    await expect(treeItem(page, 'F-UPLOADS')).toHaveAttribute('data-folder-drop-state', 'invalid');
    await expect(treeItem(page, 'F-CHILD')).toHaveAttribute('data-folder-drop-state', 'noop');
    await expect(treeItem(page, 'F-COLLISION')).toHaveAttribute('data-folder-drop-state', 'invalid');
    await expect(treeItem(page, 'F-DEPTH-7')).toHaveAttribute('data-folder-drop-state', 'invalid');
    await expect(treeItem(page, 'F-DEPTH-6')).toHaveAttribute('data-folder-drop-state', 'eligible');
    await expect(page.locator('[data-folder-kind="virtual"]').filter({ hasText: 'Uncategorised' })).toHaveAttribute('data-folder-drop-state', 'invalid');
    await expect(page.locator('[data-folder-root-drop-zone="true"]')).toHaveAttribute('data-folder-drop-state', 'eligible');
    await expect(treeItem(page, 'F-ARCHIVED')).toHaveCount(0);
    await expect(treeItem(page, 'F-INACTIVE')).toHaveCount(0);

    await dropFolder(source, source, dataTransfer);
    await expect(page.locator('.lf-doc-folder-drag-feedback[role="alert"]')).toContainText('cannot be moved into itself');
    expect(calls.folderMoves).toEqual([]);
    expect(calls.documentMoves).toEqual([]);
    expect(unexpected).toEqual([]);
  });

  test('treats same-parent drops as no-ops and keeps folder and document payloads isolated', async ({ page }) => {
    const { calls, unexpected } = await installMockApi(page);
    await mountMatterDocuments(page);
    await revealEvidence(page);
    const source = treeItem(page, 'F-MOVE');
    const currentParent = treeItem(page, 'F-CHILD');
    let dataTransfer = await beginFolderDrag(page, source);
    await expect(currentParent).toHaveAttribute('data-folder-drop-state', 'noop');
    await dropFolder(source, currentParent, dataTransfer);
    await expect(page.locator('.lf-doc-folder-drag-feedback')).toContainText('no move was needed');
    expect(calls.folderMoves).toEqual([]);

    const documentRow = page.locator('[data-document-id="DOC-OTHER"]');
    await expect(documentRow).toHaveAttribute('data-document-draggable', 'true');
    await documentRow.dragTo(treeItem(page, 'F-ROOT'));
    await expect.poll(() => calls.documentMoves).toEqual([
      { documentId: 'DOC-OTHER', payload: { folderId: 'F-ROOT' } },
    ]);
    expect(calls.folderMoves).toEqual([]);

    dataTransfer = await beginFolderDrag(page, source);
    await dataTransfer.evaluate((transfer, documentDragType) => transfer.setData(documentDragType, 'DOC-EVIDENCE'), DOCUMENT_DRAG_TYPE);
    await dropFolder(source, treeItem(page, 'F-OTHER'), dataTransfer);
    await expect(page.locator('.lf-doc-folder-drag-feedback[role="alert"]')).toContainText('cannot be mixed');
    expect(calls.folderMoves).toEqual([]);
    expect(calls.documentMoves).toHaveLength(1);
    expect(unexpected).toEqual([]);
  });

  test('recovers from a failed move with stable hierarchy and supports a successful retry', async ({ page }) => {
    const { calls, state, unexpected } = await installMockApi(page, { failMoveCount: 1 });
    await mountMatterDocuments(page);
    await revealEvidence(page);
    const source = treeItem(page, 'F-MOVE');
    const destination = treeItem(page, 'F-OTHER');
    let dataTransfer = await beginFolderDrag(page, source);
    await dropFolder(source, destination, dataTransfer);

    await expect(page.locator('.lf-doc-folder-drag-feedback[role="alert"]')).toContainText('Folder hierarchy is busy');
    await expect(page.locator('[role="treeitem"][data-folder-path="Case Files / 2026 / Evidence"]')).toBeVisible();
    await expect(treeItem(page, 'F-MOVE')).toHaveAttribute('data-folder-draggable', 'true');
    await expect(treeItem(page, 'F-MOVE')).not.toHaveAttribute('data-folder-move-pending', 'true');
    expect(state.activeFolders.find(folder => folder.id === 'F-MOVE').parentId).toBe('F-CHILD');

    dataTransfer = await beginFolderDrag(page, treeItem(page, 'F-MOVE'));
    await dropFolder(treeItem(page, 'F-MOVE'), destination, dataTransfer);
    await expect.poll(() => calls.folderMoves).toEqual([
      { folderId: 'F-MOVE', payload: { parentId: 'F-OTHER' } },
      { folderId: 'F-MOVE', payload: { parentId: 'F-OTHER' } },
    ]);
    await expect(page.locator('[role="treeitem"][data-folder-path="Correspondence / Evidence"]')).toBeVisible();
    expect(unexpected).toEqual([]);
  });

  test('does not expose folder dragging to unauthorized staff or clients', async ({ page }) => {
    const { calls, unexpected } = await installMockApi(page);
    await mountMatterDocuments(page, { canManage: false, clientMode: false });
    await expect(treeItem(page, 'F-ROOT')).not.toHaveAttribute('data-folder-draggable', 'true');
    await expect(page.locator('[data-folder-root-drop-zone="true"]')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Move Folder', exact: true })).toHaveCount(0);

    await page.evaluate(() => window.renderMatterDocuments({ matterId: 'MAT-CLIENT-DRAG', canManage: false, clientMode: true }));
    await expect(page.getByRole('heading', { name: 'Folders', exact: true })).toBeVisible();
    await expect(treeItem(page, 'F-ROOT')).not.toHaveAttribute('data-folder-draggable', 'true');
    await expect(page.locator('[data-folder-root-drop-zone="true"]')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Move Folder', exact: true })).toHaveCount(0);
    expect(calls.folderMoves).toEqual([]);
    expect(calls.documentMoves).toEqual([]);
    expect(unexpected).toEqual([]);
  });

  test('disables drag at 390px while keeping the explicit Move Folder dialog usable', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 900 });
    const { calls, unexpected } = await installMockApi(page);
    await mountMatterDocuments(page, { matterId: 'MAT-MOBILE-DRAG', preserveViewport: true });
    await expect(page.locator('[data-folder-root-drop-zone="true"]')).toHaveCount(0);
    await expect(page.locator('[data-folder-draggable="true"]')).toHaveCount(0);

    await page.getByRole('button', { name: 'Open Case Files', exact: true }).click();
    await page.getByRole('button', { name: 'Open 2026', exact: true }).click();
    await page.locator('.lf-doc-mobile-folder-row[data-folder-path="Case Files / 2026 / Evidence"] .lf-doc-folder-button').click();
    const moveAction = page.getByRole('button', { name: 'Move Folder', exact: true });
    await expect(moveAction).toBeVisible();
    await moveAction.click();
    const dialog = page.getByRole('dialog', { name: 'Move Folder' });
    const destination = dialog.getByLabel('Destination');
    await expect(destination).toBeFocused();
    await expect(destination.locator('option[value="F-COLLISION"]')).toHaveCount(0);
    await expect(destination.locator('option[value="F-DEPTH-7"]')).toHaveCount(0);
    await expect(destination.locator('option[value="F-ARCHIVED"]')).toHaveCount(0);
    await destination.selectOption('');
    await dialog.getByRole('button', { name: 'Move Folder', exact: true }).click();

    await expect.poll(() => calls.folderMoves).toEqual([
      { folderId: 'F-MOVE', payload: { parentId: null } },
    ]);
    await expect(dialog).toHaveCount(0);
    await expect(page.locator('.lf-doc-mobile-folder-row[data-folder-path="Evidence"]')).toBeVisible();
    expect(unexpected).toEqual([]);
  });

  test('disables native folder dragging for coarse pointers while retaining the dialog fallback', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, get: () => 1 });
    });
    const { calls, unexpected } = await installMockApi(page);
    await mountMatterDocuments(page);
    await expect(page.locator('[data-folder-draggable="true"]')).toHaveCount(0);
    await expect(page.locator('[data-folder-root-drop-zone="true"]')).toHaveCount(0);
    await expandFolder(page, 'F-ROOT');
    await treeItem(page, 'F-CHILD').click();
    await expect(page.getByRole('button', { name: 'Move Folder', exact: true })).toBeVisible();
    expect(calls.folderMoves).toEqual([]);
    expect(unexpected).toEqual([]);
  });
});
