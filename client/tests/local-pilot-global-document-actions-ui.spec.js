import { expect, test } from '@playwright/test';

const admin = { id: 'USER-ADMIN', fullName: 'Explorer Admin', email: 'admin@example.com', role: 'admin', hasAvatar: false };
const advocate = { id: 'USER-ADVOCATE', fullName: 'Advocate One', email: 'advocate@example.com', role: 'advocate', hasAvatar: false };
const assistant = { id: 'USER-ASSISTANT', fullName: 'Explorer Assistant', email: 'assistant@example.com', role: 'assistant', hasAvatar: false };

const client = { id: 'CLIENT-1', name: 'Acme Holdings Limited' };
const matter = { id: 'MATTER-1', clientId: client.id, reference: 'ACM/2026/014', title: 'Acme Holdings v River Works', stage: 'Discovery' };

function documentRecord(overrides = {}) {
  return {
    id: 'DOC-1',
    displayName: 'chronology.pdf',
    name: 'chronology.pdf',
    type: 'PDF',
    mimeType: 'application/pdf',
    date: '2026-07-10',
    size: '245 KB',
    source: 'firm',
    origin: 'firm',
    visibility: 'internal',
    uploaderDisplay: 'Explorer Admin',
    archived: false,
    archivedAt: null,
    matter,
    client,
    folder: { id: 'FOLDER-EVIDENCE', name: 'Evidence', archived: false },
    folderPath: [{ id: 'FOLDER-CASE', name: 'Case Files', archived: false }, { id: 'FOLDER-EVIDENCE', name: 'Evidence', archived: false }],
    folderPathLabel: 'Case Files / Evidence',
    location: { status: 'active', folderArchived: false, pathIncomplete: false },
    ...overrides,
  };
}

function filterOptionsFor(documents) {
  const values = key => [...new Set(documents.map(document => document[key]).filter(Boolean))];
  const labels = {
    types: { pdf: 'PDF', image: 'Image' },
    sources: { firm: 'Firm', client: 'Client', generated: 'Generated' },
    origins: { firm: 'Firm upload', client: 'Client upload', generated: 'Generated' },
    visibilities: { internal: 'Internal', client: 'Client visible' },
  };
  return {
    clients: [client],
    matters: [matter],
    types: values('type').map(value => ({ value: value.toLowerCase(), label: labels.types[value.toLowerCase()] || value })),
    sources: values('source').map(value => ({ value, label: labels.sources[value] || value })),
    origins: values('origin').map(value => ({ value, label: labels.origins[value] || value })),
    visibilities: values('visibility').map(value => ({ value, label: labels.visibilities[value] || value })),
  };
}

function sortedDocuments(documents, sort) {
  const direction = sort.endsWith('_desc') ? -1 : 1;
  const key = sort.startsWith('name_') ? document => document.displayName.toLowerCase()
    : sort.startsWith('matter_') ? document => document.matter.reference.toLowerCase()
      : sort.startsWith('client_') ? document => document.client.name.toLowerCase()
        : document => document.date;
  return [...documents].sort((left, right) => direction * (key(left).localeCompare(key(right)) || left.id.localeCompare(right.id)));
}

async function installWorkspace(page, user = admin) {
  const state = {
    documents: [
      documentRecord(),
      documentRecord({ id: 'DOC-CLIENT', displayName: 'client-upload.png', name: 'client-upload.png', type: 'Image', mimeType: 'image/png', date: '2026-07-09', source: 'client', origin: 'client', visibility: 'client', folder: null, folderPath: [], folderPathLabel: 'Uncategorised', location: { status: 'uncategorised', folderArchived: false, pathIncomplete: false } }),
      documentRecord({ id: 'DOC-LATER', displayName: 'witness-statement.pdf', name: 'witness-statement.pdf', date: '2026-07-08' }),
      documentRecord({ id: 'DOC-ARCHIVED', displayName: 'archived-opinion.pdf', name: 'archived-opinion.pdf', date: '2026-07-01', source: 'generated', origin: 'generated', archived: true, archivedAt: '2026-07-12T10:00:00.000Z' }),
    ],
    calls: [],
    failNextMutationFor: '',
  };

  await page.addInitScript(session => {
    localStorage.setItem('lexflowSession', JSON.stringify(session));
    localStorage.setItem('lexflowToken', session.token);
  }, { token: `${user.role}-document-actions-token`, user });

  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    let body = null;
    if (request.postData()) {
      try { body = request.postDataJSON(); } catch {}
    }
    state.calls.push({ method, path, params: Object.fromEntries(url.searchParams), body });
    const json = (responseBody, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(responseBody) });

    if (path === '/api/public/branding' || path === '/api/firm-settings' || path === '/api/firm-settings/theme') return json({ name: 'Explorer Test Firm', primaryColor: '#1A3628', accentColor: '#C5973C' });
    if (path === '/api/auth/me') return json(user);
    if (path === '/api/dashboard') return json({});
    if (path === '/api/clients') return json([client]);
    if (path === '/api/matters') return json([matter]);
    if (path === '/api/tasks' || path === '/api/invoices' || path === '/api/notifications') return json([]);

    if (method === 'GET' && path === '/api/documents') {
      const status = url.searchParams.get('status') || 'active';
      const statusDocuments = state.documents.filter(document => status === 'all' || (status === 'archived' ? document.archived : !document.archived));
      const query = (url.searchParams.get('q') || '').toLowerCase();
      const filtered = statusDocuments.filter(document => {
        const haystack = [document.displayName, document.matter.reference, document.matter.title, document.client.name, document.folderPathLabel].join(' ').toLowerCase();
        return (!query || haystack.includes(query))
          && (!url.searchParams.get('type') || document.type.toLowerCase() === url.searchParams.get('type'))
          && (!url.searchParams.get('origin') || document.origin === url.searchParams.get('origin'))
          && (!url.searchParams.get('visibility') || document.visibility === url.searchParams.get('visibility'))
          && (!url.searchParams.get('matterId') || document.matter.id === url.searchParams.get('matterId'))
          && (!url.searchParams.get('clientId') || document.client.id === url.searchParams.get('clientId'));
      });
      const sorted = sortedDocuments(filtered, url.searchParams.get('sort') || 'date_desc');
      const secondPage = url.searchParams.get('cursor') === 'CURSOR-1';
      const items = secondPage ? sorted.slice(2) : sorted.slice(0, 2);
      const hasMore = !secondPage && sorted.length > 2;
      return json({
        items,
        limit: 25,
        sort: url.searchParams.get('sort') || 'date_desc',
        status,
        hasMore,
        nextCursor: hasMore ? 'CURSOR-1' : null,
        filterOptions: filterOptionsFor(statusDocuments),
      });
    }

    const documentMatch = path.match(/^\/api\/documents\/([^/]+)(\/restore)?$/);
    if (documentMatch && method !== 'GET') {
      const documentId = decodeURIComponent(documentMatch[1]);
      const document = state.documents.find(item => item.id === documentId);
      await new Promise(resolve => setTimeout(resolve, 120));
      if (state.failNextMutationFor === documentId) {
        state.failNextMutationFor = '';
        state.documents = state.documents.filter(item => item.id !== documentId);
        return json({ error: 'Document access denied' }, 403);
      }
      if (!document) return json({ error: 'Document not found' }, 404);
      if (method === 'PATCH' && documentMatch[2] === '/restore') {
        document.archived = false;
        document.archivedAt = null;
        return json(document);
      }
      if (method === 'DELETE') {
        document.archived = true;
        document.archivedAt = '2026-07-13T12:00:00.000Z';
        return json({ id: document.id, deleted: true });
      }
      if (method === 'PATCH') {
        if (body?.displayName !== undefined) document.displayName = body.displayName;
        if (body?.clientVisible !== undefined) document.visibility = body.clientVisible ? 'client' : 'internal';
        return json(document);
      }
    }

    if (method === 'GET' && path === '/api/matters/MATTER-1') return json({ ...matter, documents: state.documents.filter(document => !document.archived), tasks: [], appearances: [], invoices: [], notes: [], timeEntries: [] });
    if (method === 'GET' && path.startsWith('/api/matters/MATTER-1/')) return json([]);
    if (method === 'GET' && ['/api/document-templates', '/api/checklist-templates', '/api/users', '/api/work-metadata-links'].some(prefix => path.startsWith(prefix))) return json([]);
    return json({ error: `Unexpected mocked request: ${method} ${path}` }, 404);
  });
  return state;
}

async function openExplorer(page, user = admin, viewport = { width: 1280, height: 900 }) {
  await page.setViewportSize(viewport);
  const state = await installWorkspace(page, user);
  await page.goto('/#/staff/documents');
  await expect(page.getByRole('heading', { name: 'Document register', exact: true })).toBeVisible();
  await expect(page.locator('[data-document-id="DOC-1"]')).toBeVisible();
  return state;
}

test.describe('LOCAL-PILOT-GLOBAL-DOCUMENT-ACTIONS-94 UI', () => {
  test('renames, changes visibility, confirms archive, restores, and preserves the loaded query window and navigation', async ({ page }) => {
    const state = await openExplorer(page);
    await expect(page.getByText('Controlled actions', { exact: true })).toBeVisible();

    await page.getByLabel('Search document metadata').fill('Acme');
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await page.getByLabel('Filter by client').selectOption(client.id);
    await page.getByLabel('Sort documents').selectOption('name_asc');
    await page.getByLabel('Include archived documents').check();
    await page.getByRole('button', { name: 'Load more', exact: true }).click();
    await expect(page.locator('[data-document-id="DOC-LATER"]')).toBeVisible();

    let row = page.locator('[data-document-id="DOC-1"]');
    await row.getByRole('button', { name: 'Rename', exact: true }).click();
    const renameDialog = page.getByRole('dialog', { name: 'Rename document' });
    await renameDialog.getByLabel('Document name').fill('   ');
    await renameDialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(renameDialog.getByRole('alert')).toHaveText('Document name is required.');
    await renameDialog.getByLabel('Document name').fill(`${'a'.repeat(177)}.pdf`);
    await renameDialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(renameDialog.getByRole('alert')).toHaveText('Document name must be 180 characters or fewer.');
    await renameDialog.getByLabel('Document name').fill('chronology-renamed.pdf');
    await renameDialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(renameDialog.getByRole('button', { name: 'Saving…', exact: true })).toBeDisabled();
    await expect(renameDialog).toHaveCount(0);
    row = page.locator('[data-document-id="DOC-1"]');
    await expect(row).toContainText('chronology-renamed.pdf');
    await expect(page.getByText('Document renamed.', { exact: true }).first()).toBeVisible();

    await row.getByRole('button', { name: 'Make client visible', exact: true }).click();
    await expect(row.getByRole('button', { name: 'Updating…', exact: true })).toBeDisabled();
    await expect(row.getByText('Client visible', { exact: true })).toBeVisible();

    const deletesBeforeConfirmation = state.calls.filter(call => call.method === 'DELETE' && call.path === '/api/documents/DOC-1').length;
    await row.getByRole('button', { name: 'Archive', exact: true }).click();
    const archiveDialog = page.getByRole('dialog', { name: 'Archive document?' });
    await expect(archiveDialog).toBeVisible();
    expect(state.calls.filter(call => call.method === 'DELETE' && call.path === '/api/documents/DOC-1')).toHaveLength(deletesBeforeConfirmation);
    await archiveDialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    expect(state.calls.filter(call => call.method === 'DELETE' && call.path === '/api/documents/DOC-1')).toHaveLength(deletesBeforeConfirmation);

    await row.getByRole('button', { name: 'Archive', exact: true }).click();
    await page.getByRole('dialog', { name: 'Archive document?' }).getByRole('button', { name: 'Archive', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Archive document?' }).getByRole('button', { name: 'Archiving…', exact: true })).toBeDisabled();
    await expect(page.getByRole('dialog', { name: 'Archive document?' })).toHaveCount(0);
    row = page.locator('[data-document-id="DOC-1"]');
    await expect(row.getByText('Archived', { exact: true })).toBeVisible();
    await expect(row.getByRole('button', { name: 'Preview', exact: true })).toBeDisabled();
    await expect(row.getByRole('button', { name: 'Download', exact: true })).toBeDisabled();
    await expect(row.getByRole('button', { name: 'Rename', exact: true })).toHaveCount(0);

    await row.getByRole('button', { name: 'Restore', exact: true }).click();
    await expect(row.getByRole('button', { name: 'Restoring…', exact: true })).toBeDisabled();
    await expect(row.getByText('Archived', { exact: true })).toHaveCount(0);
    await expect(row.getByRole('button', { name: 'Rename', exact: true })).toBeVisible();

    await expect(page.getByLabel('Search document metadata')).toHaveValue('Acme');
    await expect(page.getByLabel('Filter by client')).toHaveValue(client.id);
    await expect(page.getByLabel('Sort documents')).toHaveValue('name_asc');
    await expect(page.getByLabel('Include archived documents')).toBeChecked();

    const mutationIndex = state.calls.findIndex(call => call.method === 'PATCH' && call.path === '/api/documents/DOC-1' && call.body?.displayName);
    const refreshCalls = state.calls.slice(mutationIndex + 1).filter(call => call.method === 'GET' && call.path === '/api/documents');
    expect(refreshCalls.some(call => call.params.q === 'Acme' && call.params.clientId === client.id && call.params.sort === 'name_asc' && call.params.status === 'all')).toBe(true);
    expect(refreshCalls.some(call => call.params.cursor === 'CURSOR-1')).toBe(true);

    await row.getByRole('button', { name: 'Open matter', exact: true }).click();
    await expect(page).toHaveURL(/#\/staff\/matters\/MATTER-1\/documents\?folderId=FOLDER-EVIDENCE&documentId=DOC-1$/);
  });

  test('fails a stale or inaccessible mutation safely, refreshes the row away, and preserves filters', async ({ page }) => {
    const state = await openExplorer(page);
    await page.getByLabel('Filter by client').selectOption(client.id);
    await page.getByLabel('Sort documents').selectOption('name_desc');
    state.failNextMutationFor = 'DOC-1';

    const row = page.locator('[data-document-id="DOC-1"]');
    await row.getByRole('button', { name: 'Make client visible', exact: true }).click();
    await expect(row.getByRole('button', { name: 'Updating…', exact: true })).toBeDisabled();
    await expect(page.getByRole('alert').filter({ hasText: 'This document is no longer available for that action.' }).first()).toBeVisible();
    await expect(row).toHaveCount(0);
    await expect(page.getByLabel('Filter by client')).toHaveValue(client.id);
    await expect(page.getByLabel('Sort documents')).toHaveValue('name_desc');
    expect(await page.locator('body').innerText()).not.toContain('Hidden Metadata');
  });

  test('gives assigned advocates the controlled actions with a usable 390px layout', async ({ page }) => {
    await openExplorer(page, advocate, { width: 390, height: 844 });
    const row = page.locator('[data-document-id="DOC-1"]');
    await expect(row.getByRole('button', { name: 'Rename', exact: true })).toBeVisible();
    await expect(row.getByRole('button', { name: 'Make client visible', exact: true })).toBeVisible();
    await expect(row.getByRole('button', { name: 'Archive', exact: true })).toBeVisible();
    await expect(page.locator('[data-document-id="DOC-CLIENT"]').getByRole('button', { name: /Make client visible|Make internal/ })).toHaveCount(0);

    await row.getByRole('button', { name: 'Archive', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Archive document?' });
    await expect(dialog).toBeVisible();
    const layout = await page.evaluate(() => {
      const modal = document.querySelector('.lf-global-document-action-dialog');
      return {
        clientWidth: document.documentElement.clientWidth,
        documentWidth: document.documentElement.scrollWidth,
        bodyWidth: document.body.scrollWidth,
        modalWidth: modal?.getBoundingClientRect().width || 0,
      };
    });
    expect(layout.documentWidth).toBeLessThanOrEqual(layout.clientWidth);
    expect(layout.bodyWidth).toBeLessThanOrEqual(layout.clientWidth);
    expect(layout.modalWidth).toBeLessThanOrEqual(layout.clientWidth);
  });

  test('keeps assistants read-only with only Preview, Download, and Open matter', async ({ page }) => {
    const state = await openExplorer(page, assistant, { width: 390, height: 844 });
    await expect(page.getByText('Read only', { exact: true })).toBeVisible();
    await expect(page.getByLabel('Include archived documents')).toHaveCount(0);
    const row = page.locator('[data-document-id="DOC-1"]');
    expect(await row.getByRole('button').allTextContents()).toEqual(['Preview', 'Download', 'Open matter']);
    await expect(page.getByRole('button', { name: 'Rename', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Archive', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Make client visible|Make internal/ })).toHaveCount(0);
    expect(state.calls.filter(call => call.method !== 'GET')).toEqual([]);
  });
});
