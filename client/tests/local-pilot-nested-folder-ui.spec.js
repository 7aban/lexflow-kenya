import { expect, test } from '@playwright/test';

const HARNESS_PATH = '/tests/fixtures/matter-documents-harness.html';

function createState(overrides = {}) {
  return {
    activeFolders: overrides.activeFolders ?? [
      { id: 'all', name: 'All Documents', virtual: true },
      { id: 'uncategorised', name: 'Uncategorised', virtual: true },
      { id: 'F-UPLOADS', name: 'Client Uploads', parentId: null },
      { id: 'F-ROOT', name: 'Case Files', parentId: null },
      { id: 'F-CHILD', name: '2026', parentId: 'F-ROOT' },
      { id: 'F-GRAND', name: 'Evidence', parentId: 'F-CHILD' },
      { id: 'F-OTHER', name: 'Correspondence', parentId: null },
      { id: 'F-ARCHIVED-LEAK', name: 'Inactive Parent', parentId: null, archivedAt: '2026-07-01T08:00:00.000Z' },
      { id: 'F-ORPHAN', name: 'Orphan Child', parentId: 'F-ARCHIVED-LEAK' },
      { id: 'F-MISSING', name: 'Missing Parent Child', parentId: 'F-NOT-RETURNED' },
      { id: 'F-UPLOADS-CHILD', name: 'Forbidden Upload Child', parentId: 'F-UPLOADS' },
    ],
    archivedFolders: overrides.archivedFolders ?? [
      { id: 'F-ARCHIVED', name: 'Archived Destination', parentId: null, archivedAt: '2026-07-10T08:00:00.000Z' },
    ],
    activeDocuments: overrides.activeDocuments ?? [
      { id: 'DOC-ROOT', displayName: 'Root memo.pdf', name: 'root-memo.pdf', mimeType: 'application/pdf', folderId: 'F-ROOT', folderName: 'Case Files', date: '2026-07-10', size: '10 KB', source: 'firm', clientVisible: false },
      { id: 'DOC-CHILD', displayName: 'Child chronology.docx', name: 'child-chronology.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', folderId: 'F-CHILD', folderName: '2026', date: '2026-07-10', size: '11 KB', source: 'firm', clientVisible: false },
      { id: 'DOC-GRAND', displayName: 'Grand evidence.pdf', name: 'grand-evidence.pdf', mimeType: 'application/pdf', folderId: 'F-GRAND', folderName: 'Evidence', date: '2026-07-10', size: '12 KB', source: 'firm', clientVisible: false },
      { id: 'DOC-OTHER', displayName: 'Other letter.pdf', name: 'other-letter.pdf', mimeType: 'application/pdf', folderId: 'F-OTHER', folderName: 'Correspondence', date: '2026-07-10', size: '13 KB', source: 'firm', clientVisible: false },
      { id: 'DOC-LOOSE', displayName: 'Loose note.txt', name: 'loose-note.txt', mimeType: 'text/plain', folderId: null, folderName: 'Uncategorised', date: '2026-07-10', size: '2 KB', source: 'firm', clientVisible: false },
      { id: 'DOC-ORPHAN', displayName: 'Hidden ancestor.pdf', name: 'hidden-ancestor.pdf', mimeType: 'application/pdf', folderId: 'F-ORPHAN', folderName: 'Orphan Child', date: '2026-07-10', size: '14 KB', source: 'firm', clientVisible: false },
      { id: 'DOC-INACTIVE', displayName: 'Archived target.pdf', name: 'archived-target.pdf', mimeType: 'application/pdf', folderId: 'F-ARCHIVED-LEAK', folderName: 'Inactive Parent', date: '2026-07-10', size: '15 KB', source: 'firm', clientVisible: false },
    ],
    archivedDocuments: overrides.archivedDocuments ?? [],
  };
}

async function installMockApi(page, overrides = {}) {
  const state = createState(overrides);
  const calls = {
    folderCreates: [],
    documentCreates: [],
    documentUpdates: [],
    downloads: [],
    archivedFolderLists: 0,
    archivedDocumentLists: 0,
  };
  const unexpected = [];

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
        calls.archivedFolderLists += 1;
        await fulfillJson(route, 200, state.archivedFolders);
        return;
      }
      await fulfillJson(route, 200, state.activeFolders);
      return;
    }

    if (method === 'POST' && /^\/api\/matters\/[^/]+\/folders$/.test(path)) {
      const payload = request.postDataJSON();
      calls.folderCreates.push(payload);
      const folder = {
        id: `F-NEW-${calls.folderCreates.length}`,
        matterId: 'MAT-NESTED',
        name: payload.name,
        parentId: payload.parentId || null,
      };
      state.activeFolders.push(folder);
      await fulfillJson(route, 200, folder);
      return;
    }

    if (method === 'GET' && /^\/api\/matters\/[^/]+\/documents$/.test(path)) {
      if (url.searchParams.get('status') === 'archived') calls.archivedDocumentLists += 1;
      await fulfillJson(route, 200, url.searchParams.get('status') === 'archived' ? state.archivedDocuments : state.activeDocuments);
      return;
    }

    if (method === 'POST' && /^\/api\/matters\/[^/]+\/documents$/.test(path)) {
      const payload = request.postDataJSON();
      calls.documentCreates.push(payload);
      const folderId = payload.folderId || 'F-UPLOADS';
      const folder = state.activeFolders.find(item => String(item.id) === String(folderId));
      state.activeDocuments.push({
        id: `DOC-UPLOAD-${calls.documentCreates.length}`,
        displayName: payload.name,
        name: payload.name,
        mimeType: payload.mimeType,
        folderId,
        folderName: folder?.name || 'Uncategorised',
        date: '2026-07-13',
        size: '1 KB',
        source: payload.folderId ? 'firm' : 'client',
        clientVisible: false,
      });
      await fulfillJson(route, 200, state.activeDocuments.at(-1));
      return;
    }

    const documentMatch = path.match(/^\/api\/documents\/([^/]+)$/);
    if (method === 'PATCH' && documentMatch) {
      const documentId = decodeURIComponent(documentMatch[1]);
      const payload = request.postDataJSON();
      calls.documentUpdates.push({ documentId, payload });
      const document = state.activeDocuments.find(item => String(item.id) === documentId);
      if (!document) {
        await fulfillJson(route, 404, { error: 'Document not found' });
        return;
      }
      Object.assign(document, payload);
      if (Object.hasOwn(payload, 'folderId')) {
        const folder = state.activeFolders.find(item => String(item.id) === String(payload.folderId));
        document.folderName = payload.folderId === 'uncategorised' ? 'Uncategorised' : (folder?.name || document.folderName);
      }
      await fulfillJson(route, 200, document);
      return;
    }

    const downloadMatch = path.match(/^\/api\/documents\/([^/]+)\/download$/);
    if (method === 'GET' && downloadMatch) {
      calls.downloads.push(decodeURIComponent(downloadMatch[1]));
      await route.fulfill({
        status: 200,
        contentType: 'application/pdf',
        headers: { 'Content-Disposition': 'attachment; filename="mock.pdf"' },
        body: '%PDF-1.4\n% mocked disposable content\n',
      });
      return;
    }

    unexpected.push(`${method} ${path}${url.search}`);
    await fulfillJson(route, 404, { error: `Unexpected mocked request: ${method} ${path}` });
  });

  return { state, calls, unexpected };
}

async function mountMatterDocuments(page, props = {}) {
  await page.goto(HARNESS_PATH);
  await page.waitForFunction(() => window.__matterHarnessReady === true);
  await page.evaluate(nextProps => window.renderMatterDocuments(nextProps), {
    matterId: props.matterId || 'MAT-NESTED',
    canManage: props.canManage ?? true,
    clientMode: props.clientMode ?? false,
    focusTarget: props.focusTarget ?? null,
  });
  await expect(page.getByRole('heading', { name: 'Folders', exact: true })).toBeVisible();
}

function treeItem(page, folderId) {
  return page.locator(`[role="treeitem"][data-folder-id="${folderId}"]`);
}

function virtualFolderButton(page, name) {
  return page.locator('.lf-doc-folder-button[data-folder-kind="virtual"]').filter({ hasText: name }).first();
}

test.describe('LOCAL-PILOT-NESTED-FOLDER-UI-89', () => {
  test('renders a protected active hierarchy, filters direct documents, keeps All Documents complete, and labels every destination by full path', async ({ page }) => {
    const { unexpected } = await installMockApi(page);
    await mountMatterDocuments(page);

    const tree = page.getByRole('tree', { name: 'Matter folders' });
    await expect(tree).toBeVisible();
    await expect(treeItem(page, 'F-UPLOADS')).toBeVisible();
    await expect(treeItem(page, 'F-ROOT')).toHaveAttribute('aria-level', '1');
    await expect(treeItem(page, 'F-OTHER')).toBeVisible();
    await expect(treeItem(page, 'F-CHILD')).toHaveCount(0);
    await expect(tree.getByText('All Documents', { exact: true })).toHaveCount(0);

    for (const unavailableId of ['F-ARCHIVED-LEAK', 'F-ORPHAN', 'F-MISSING', 'F-UPLOADS-CHILD']) {
      await expect(treeItem(page, unavailableId)).toHaveCount(0);
    }

    await treeItem(page, 'F-ROOT').locator('[data-tree-toggle="true"]').click();
    await expect(treeItem(page, 'F-ROOT')).toHaveAttribute('aria-expanded', 'true');
    await expect(treeItem(page, 'F-CHILD')).toHaveAttribute('aria-level', '2');
    await expect(treeItem(page, 'F-GRAND')).toHaveCount(0);
    await treeItem(page, 'F-CHILD').locator('[data-tree-toggle="true"]').click();
    await expect(treeItem(page, 'F-GRAND')).toHaveAttribute('aria-level', '3');

    await treeItem(page, 'F-GRAND').click();
    await expect(treeItem(page, 'F-GRAND')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByText('Grand evidence.pdf', { exact: true })).toBeVisible();
    for (const otherDocument of ['Root memo.pdf', 'Child chronology.docx', 'Other letter.pdf', 'Loose note.txt', 'Hidden ancestor.pdf', 'Archived target.pdf']) {
      await expect(page.getByText(otherDocument, { exact: true })).toHaveCount(0);
    }

    const breadcrumb = page.getByRole('navigation', { name: 'Folder breadcrumb' });
    await expect(breadcrumb.getByRole('button', { name: 'All Documents', exact: true })).toBeVisible();
    await expect(breadcrumb.getByRole('button', { name: 'Case Files', exact: true })).toBeVisible();
    await expect(breadcrumb.getByRole('button', { name: '2026', exact: true })).toBeVisible();
    await expect(breadcrumb.locator('[aria-current="page"]')).toHaveText('Evidence');
    await expect(page.locator('#matter-document-upload-status')).toContainText('Destination: Case Files / 2026 / Evidence');

    await virtualFolderButton(page, 'All Documents').click();
    for (const documentName of ['Root memo.pdf', 'Child chronology.docx', 'Grand evidence.pdf', 'Other letter.pdf', 'Loose note.txt', 'Hidden ancestor.pdf', 'Archived target.pdf']) {
      await expect(page.getByText(documentName, { exact: true })).toBeVisible();
    }

    const destination = page.getByLabel('Move Grand evidence.pdf to folder');
    const optionLabels = await destination.locator('option').allTextContents();
    expect(optionLabels).toContain('Case Files');
    expect(optionLabels).toContain('Case Files / 2026');
    expect(optionLabels).toContain('Case Files / 2026 / Evidence');
    expect(optionLabels).toContain('Client Uploads');
    for (const excludedLabel of ['Inactive Parent', 'Orphan Child', 'Missing Parent Child', 'Forbidden Upload Child', 'Archived Destination']) {
      expect(optionLabels.join('\n')).not.toContain(excludedLabel);
    }

    const createInValues = await page.getByLabel('Create in').locator('option').evaluateAll(options => options.map(option => option.value));
    expect(createInValues).not.toContain('all');
    expect(createInValues).not.toContain('uncategorised');
    expect(createInValues).not.toContain('archived');
    expect(createInValues).not.toContain('F-UPLOADS');
    expect(unexpected).toEqual([]);
  });

  test('creates root, child, and grandchild folders and supports selected ancestry plus desktop tree keyboard controls', async ({ page }) => {
    const { calls, unexpected } = await installMockApi(page, {
      activeFolders: [
        { id: 'all', name: 'All Documents', virtual: true },
        { id: 'uncategorised', name: 'Uncategorised', virtual: true },
        { id: 'F-UPLOADS', name: 'Client Uploads', parentId: null },
      ],
      activeDocuments: [],
    });
    await mountMatterDocuments(page);

    const nameInput = page.getByLabel('Name for new folder');
    const parentSelect = page.getByLabel('Create in');
    const createButton = page.getByRole('button', { name: '+ New Folder', exact: true });

    await nameInput.fill('Root Project');
    await createButton.click();
    await expect.poll(() => calls.folderCreates.length).toBe(1);
    expect(calls.folderCreates[0]).toEqual({ name: 'Root Project', parentId: null });
    await expect(treeItem(page, 'F-NEW-1')).toHaveAttribute('aria-selected', 'true');
    await expect(parentSelect).toHaveValue('F-NEW-1');

    await nameInput.fill('Child 2026');
    await createButton.click();
    await expect.poll(() => calls.folderCreates.length).toBe(2);
    expect(calls.folderCreates[1]).toEqual({ name: 'Child 2026', parentId: 'F-NEW-1' });
    await expect(treeItem(page, 'F-NEW-1')).toHaveAttribute('aria-expanded', 'true');
    await expect(treeItem(page, 'F-NEW-2')).toHaveAttribute('aria-level', '2');
    await expect(parentSelect).toHaveValue('F-NEW-2');

    await nameInput.fill('Grand Pleadings');
    await createButton.click();
    await expect.poll(() => calls.folderCreates.length).toBe(3);
    expect(calls.folderCreates[2]).toEqual({ name: 'Grand Pleadings', parentId: 'F-NEW-2' });
    await expect(treeItem(page, 'F-NEW-1')).toHaveAttribute('aria-expanded', 'true');
    await expect(treeItem(page, 'F-NEW-2')).toHaveAttribute('aria-expanded', 'true');
    await expect(treeItem(page, 'F-NEW-3')).toHaveAttribute('aria-level', '3');
    await expect(treeItem(page, 'F-NEW-3')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('navigation', { name: 'Folder breadcrumb' })).toContainText('Root Project/Child 2026/Grand Pleadings');

    const parentLabels = await parentSelect.locator('option').allTextContents();
    expect(parentLabels).toContain('Root Project');
    expect(parentLabels).toContain('Root Project / Child 2026');
    expect(parentLabels).toContain('Root Project / Child 2026 / Grand Pleadings');
    expect(await parentSelect.locator('option[value="F-UPLOADS"]').count()).toBe(0);

    const root = treeItem(page, 'F-NEW-1');
    await root.focus();
    await root.press('ArrowLeft');
    await expect(root).toHaveAttribute('aria-expanded', 'false');
    await expect(root).toHaveAttribute('aria-selected', 'true');
    await expect(treeItem(page, 'F-NEW-2')).toHaveCount(0);

    await root.press('ArrowRight');
    await expect(root).toHaveAttribute('aria-expanded', 'true');
    await root.focus();
    await root.press('ArrowRight');
    const child = treeItem(page, 'F-NEW-2');
    await expect(child).toBeFocused();
    await child.press('Enter');
    await expect(child).toHaveAttribute('aria-selected', 'true');
    await child.press('ArrowLeft');
    await expect(child).toHaveAttribute('aria-expanded', 'false');
    await expect(treeItem(page, 'F-NEW-3')).toHaveCount(0);
    await child.press('ArrowRight');
    await expect(child).toHaveAttribute('aria-expanded', 'true');
    await child.focus();
    await child.press('ArrowRight');
    const grandchild = treeItem(page, 'F-NEW-3');
    await expect(grandchild).toBeFocused();
    await grandchild.press(' ');
    await expect(grandchild).toHaveAttribute('aria-selected', 'true');
    await grandchild.press('Home');
    await expect(treeItem(page, 'F-UPLOADS')).toBeFocused();
    expect(unexpected).toEqual([]);
  });

  test('preserves search, upload, preview, download, visibility, single move, bulk move, and document drag/drop', async ({ page }) => {
    const { calls, unexpected } = await installMockApi(page);
    await mountMatterDocuments(page);

    const search = page.getByLabel('Search documents in the current view');
    await search.fill('Grand evidence');
    await expect(page.getByText('Grand evidence.pdf', { exact: true })).toBeVisible();
    await expect(page.getByText('Root memo.pdf', { exact: true })).toHaveCount(0);
    await search.fill('');

    const rootRow = page.locator('[data-document-id="DOC-ROOT"]');
    await rootRow.getByRole('button', { name: 'More actions' }).click();
    for (const action of ['Preview', 'Download', 'Rename', 'Archive']) {
      await expect(page.getByRole('menuitem', { name: action, exact: true })).toBeVisible();
    }
    await page.getByRole('menuitem', { name: 'Preview', exact: true }).click();
    const preview = page.getByRole('dialog', { name: 'Root memo.pdf' });
    await expect(preview).toBeVisible();
    await expect(preview.locator('iframe')).toBeVisible();
    await preview.getByRole('button', { name: 'Close', exact: true }).click();

    await rootRow.getByRole('button', { name: 'More actions' }).click();
    const downloadEvent = page.waitForEvent('download');
    await page.getByRole('menuitem', { name: 'Download', exact: true }).click();
    await downloadEvent;
    expect(calls.downloads).toContain('DOC-ROOT');

    await page.locator('[data-document-id="DOC-ROOT"]').getByRole('button', { name: 'Internal', exact: true }).click();
    await expect.poll(() => calls.documentUpdates.some(call => call.documentId === 'DOC-ROOT' && call.payload.clientVisible === true)).toBe(true);

    await page.locator('input[type="file"]').setInputFiles({
      name: 'uploaded-proof.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('%PDF mocked upload'),
    });
    await expect.poll(() => calls.documentCreates.length).toBe(1);
    expect(calls.documentCreates[0].folderId).toBe('uncategorised');
    await expect(page.getByText('uploaded-proof.pdf', { exact: true })).toBeVisible();

    const singleMove = page.getByLabel('Move Grand evidence.pdf to folder');
    await expect(singleMove.locator('option[value="F-GRAND"]')).toHaveText('Case Files / 2026 / Evidence');
    await singleMove.selectOption('F-OTHER');
    await expect.poll(() => calls.documentUpdates.some(call => call.documentId === 'DOC-GRAND' && call.payload.folderId === 'F-OTHER')).toBe(true);

    await page.getByLabel('Select Root memo.pdf').check();
    await page.getByLabel('Select Child chronology.docx').check();
    const bulkDestination = page.getByLabel('Move selected to');
    await expect(bulkDestination.locator('option[value="F-GRAND"]')).toHaveText('Case Files / 2026 / Evidence');
    await bulkDestination.selectOption('F-GRAND');
    await page.getByRole('button', { name: 'Move selected', exact: true }).click();
    await expect(page.getByText(/Move to Case Files \/ 2026 \/ Evidence: 2 moved/)).toBeVisible();

    const draggableRow = page.locator('[data-document-id="DOC-OTHER"]');
    await expect(draggableRow).toHaveAttribute('data-document-draggable', 'true');
    await draggableRow.dragTo(treeItem(page, 'F-ROOT'));
    await expect.poll(() => calls.documentUpdates.some(call => call.documentId === 'DOC-OTHER' && call.payload.folderId === 'F-ROOT')).toBe(true);
    expect(unexpected).toEqual([]);
  });

  test('keeps assistant and client modes read-only for hierarchy management', async ({ page }) => {
    const { calls, unexpected } = await installMockApi(page);
    await mountMatterDocuments(page, { matterId: 'MAT-ASSISTANT', canManage: false, clientMode: false });

    await expect(page.getByRole('tree', { name: 'Matter folders' })).toBeVisible();
    await expect(page.getByLabel('Name for new folder')).toHaveCount(0);
    await expect(page.getByLabel('Create in')).toHaveCount(0);
    await expect(page.getByText('Selected folder actions', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Select visible', exact: true })).toHaveCount(0);
    await expect(page.locator('input[type="file"]')).toHaveCount(0);
    await expect(page.locator('select[aria-label^="Move "]')).toHaveCount(0);

    await page.evaluate(() => window.renderMatterDocuments({ matterId: 'MAT-CLIENT', canManage: false, clientMode: true }));
    await expect(page.getByRole('heading', { name: 'Folders', exact: true })).toBeVisible();
    await expect(page.getByLabel('Name for new folder')).toHaveCount(0);
    await expect(page.getByText('Selected folder actions', { exact: true })).toHaveCount(0);
    await expect(page.locator('details.lf-doc-archived-folders')).toHaveCount(0);
    await expect(virtualFolderButton(page, 'Uncategorised')).toHaveCount(0);
    await expect(page.getByText('Upload to Client Uploads', { exact: true })).toBeVisible();
    await expect(page.locator('select[aria-label^="Move "]')).toHaveCount(0);
    expect(calls.archivedFolderLists).toBe(0);
    expect(calls.archivedDocumentLists).toBe(0);
    expect(unexpected).toEqual([]);
  });

  test('PHASE-2 focuses active folder ancestry and safely falls back for stale, archived, or inaccessible targets', async ({ page }) => {
    const { unexpected } = await installMockApi(page, {
      archivedDocuments: [
        { id: 'DOC-ARCHIVED', displayName: 'Archived pleading.pdf', name: 'archived-pleading.pdf', mimeType: 'application/pdf', folderId: 'F-GRAND', folderName: 'Evidence', date: '2026-07-01', size: '9 KB', source: 'firm', deletedAt: '2026-07-12T10:00:00.000Z' },
      ],
    });
    await mountMatterDocuments(page, {
      focusTarget: { folderId: 'F-GRAND', documentId: 'DOC-GRAND', ts: 1 },
    });

    await expect(treeItem(page, 'F-ROOT')).toHaveAttribute('aria-expanded', 'true');
    await expect(treeItem(page, 'F-CHILD')).toHaveAttribute('aria-expanded', 'true');
    await expect(treeItem(page, 'F-GRAND')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('[data-document-id="DOC-GRAND"]')).toHaveAttribute('data-document-focused', 'true');
    await expect(page.locator('[data-document-focus-status="focused"]')).toContainText('Focused Grand evidence.pdf in Case Files / 2026 / Evidence.');
    await expect(page.getByText('Other letter.pdf', { exact: true })).toHaveCount(0);

    await page.evaluate(() => window.renderMatterDocuments({
      matterId: 'MAT-NESTED',
      canManage: true,
      clientMode: false,
      focusTarget: { folderId: 'F-OTHER', documentId: 'DOC-GRAND', ts: 2 },
    }));
    await expect(virtualFolderButton(page, 'All Documents')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('[data-document-focus-status="fallback"]')).toContainText('archived, unavailable, or stale');
    await expect(page.locator('[data-document-id="DOC-GRAND"]')).toHaveAttribute('data-document-focused', 'true');
    await expect(page.getByText('Other letter.pdf', { exact: true })).toBeVisible();

    await page.evaluate(() => window.renderMatterDocuments({
      matterId: 'MAT-NESTED',
      canManage: true,
      clientMode: false,
      focusTarget: { folderId: 'F-GRAND', documentId: 'DOC-ARCHIVED', ts: 3 },
    }));
    await expect(virtualFolderButton(page, 'All Documents')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('[data-document-focus-status="fallback"]')).toContainText('requested document is archived');
    await expect(page.locator('[data-document-focused="true"]')).toHaveCount(0);

    await page.evaluate(() => window.renderMatterDocuments({
      matterId: 'MAT-NESTED',
      canManage: true,
      clientMode: false,
      focusTarget: { folderId: 'F-NOT-RETURNED', documentId: 'DOC-NOT-ACCESSIBLE', ts: 4 },
    }));
    await expect(virtualFolderButton(page, 'All Documents')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('[data-document-focus-status="fallback"]')).toContainText('unavailable or no longer accessible');
    await expect(treeItem(page, 'F-ARCHIVED-LEAK')).toHaveCount(0);
    expect(unexpected).toEqual([]);
  });

  test('provides a 390px drill-down with ancestry breadcrumbs and no horizontal overflow', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 900 });
    const { unexpected } = await installMockApi(page);
    await mountMatterDocuments(page, { matterId: 'MAT-MOBILE' });

    await expect(page.locator('.lf-doc-mobile-browser')).toBeVisible();
    await expect(page.getByRole('tree', { name: 'Matter folders' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Open Case Files', exact: true })).toBeVisible();
    await expect(page.locator('.lf-doc-mobile-folder-row[data-folder-path="Case Files / 2026"]')).toHaveCount(0);

    const openRoot = page.getByRole('button', { name: 'Open Case Files', exact: true });
    expect((await openRoot.boundingBox()).height).toBeGreaterThanOrEqual(44);
    await openRoot.click();
    await expect(page.locator('.lf-doc-mobile-folder-row[data-folder-path="Case Files / 2026"]')).toBeVisible();
    await page.getByRole('button', { name: 'Open 2026', exact: true }).click();
    const grandchildRow = page.locator('.lf-doc-mobile-folder-row[data-folder-path="Case Files / 2026 / Evidence"]');
    await expect(grandchildRow).toBeVisible();
    await grandchildRow.locator('.lf-doc-folder-button').click();

    await expect(grandchildRow.locator('.lf-doc-folder-button')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('navigation', { name: 'Folder breadcrumb' })).toContainText('All Documents/Case Files/2026/Evidence');
    await expect(page.locator('#matter-document-upload-status')).toContainText('Case Files / 2026 / Evidence');
    await expect(page.getByText('Grand evidence.pdf', { exact: true })).toBeVisible();

    const back = page.getByRole('button', { name: '← Back', exact: true });
    expect((await back.boundingBox()).height).toBeGreaterThanOrEqual(44);
    await back.click();
    await expect(page.locator('.lf-doc-mobile-folder-row[data-folder-path="Case Files / 2026"]')).toBeVisible();

    const layout = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      documentWidth: document.documentElement.scrollWidth,
      bodyWidth: document.body.scrollWidth,
      browserWidth: document.querySelector('.lf-doc-mobile-browser')?.getBoundingClientRect().width || 0,
    }));
    expect(layout.documentWidth).toBeLessThanOrEqual(layout.clientWidth);
    expect(layout.bodyWidth).toBeLessThanOrEqual(layout.clientWidth);
    expect(layout.browserWidth).toBeLessThanOrEqual(layout.clientWidth);
    expect(unexpected).toEqual([]);
  });
});
