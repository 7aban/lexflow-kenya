import { expect, test } from '@playwright/test';

const admin = { id: 'USER-ADMIN', fullName: 'Explorer Admin', email: 'admin@example.com', role: 'admin', hasAvatar: false };
const advocate = { id: 'USER-ADVOCATE', fullName: 'Advocate One', email: 'advocate@example.com', role: 'advocate', hasAvatar: false };
const assistant = { id: 'USER-ASSISTANT', fullName: 'Explorer Assistant', email: 'assistant@example.com', role: 'assistant', hasAvatar: false };
const clientUser = { id: 'USER-CLIENT', fullName: 'Acme Client', email: 'client@example.com', role: 'client', clientId: 'CLIENT-1', hasAvatar: false };

const client = { id: 'CLIENT-1', name: 'Acme Holdings Limited' };
const matter = { id: 'MATTER-1', clientId: client.id, reference: 'ACM/2026/014', title: 'Acme Holdings v River Works', stage: 'Discovery' };

function documentRecord(index, overrides = {}) {
  const number = String(index).padStart(2, '0');
  return {
    id: `DOC-${number}`,
    displayName: `Document ${number}.pdf`,
    name: `Document ${number}.pdf`,
    type: 'PDF',
    mimeType: 'application/pdf',
    date: `2026-07-${String(Math.max(1, 12 - index)).padStart(2, '0')}`,
    size: '20 KB',
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

function filterOptions(documents) {
  const types = [...new Set(documents.map(document => document.type?.toLowerCase()).filter(Boolean))];
  const origins = [...new Set(documents.map(document => document.origin).filter(Boolean))];
  const visibilities = [...new Set(documents.map(document => document.visibility).filter(Boolean))];
  return {
    clients: [client],
    matters: [matter],
    types: types.map(value => ({ value, label: value === 'pdf' ? 'PDF' : value })),
    sources: [{ value: 'firm', label: 'Firm' }],
    origins: origins.map(value => ({ value, label: value === 'firm' ? 'Firm upload' : value })),
    visibilities: visibilities.map(value => ({ value, label: value === 'client' ? 'Client visible' : 'Internal' })),
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

function matchesQuery(document, url) {
  const query = (url.searchParams.get('q') || '').toLowerCase();
  const haystack = [document.displayName, document.matter.reference, document.matter.title, document.client.name, document.folderPathLabel].join(' ').toLowerCase();
  return (!query || haystack.includes(query))
    && (!url.searchParams.get('type') || document.type.toLowerCase() === url.searchParams.get('type'))
    && (!url.searchParams.get('origin') || document.origin === url.searchParams.get('origin'))
    && (!url.searchParams.get('visibility') || document.visibility === url.searchParams.get('visibility'))
    && (!url.searchParams.get('matterId') || document.matter.id === url.searchParams.get('matterId'))
    && (!url.searchParams.get('clientId') || document.client.id === url.searchParams.get('clientId'));
}

async function installWorkspace(page, options = {}) {
  const user = options.user || admin;
  const state = {
    documents: (options.documents || Array.from({ length: 8 }, (_, index) => documentRecord(index + 1))).map(document => structuredClone(document)),
    pageSize: options.pageSize || 3,
    calls: [],
    events: [],
    mutations: [],
    unexpected: [],
    outcomes: {},
    inFlight: 0,
    maxInFlight: 0,
    failNextList: false,
    injectDuplicateCursor: false,
  };

  await page.addInitScript(session => {
    localStorage.setItem('lexflowSession', JSON.stringify(session));
    localStorage.setItem('lexflowToken', session.token);
  }, { token: `${user.role}-bulk-actions-token`, user });

  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    const params = Object.fromEntries(url.searchParams);
    state.calls.push({ method, path, params });
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

    if (path === '/api/public/branding' || path === '/api/firm-settings' || path === '/api/firm-settings/theme') {
      return json({ name: 'Explorer Test Firm', primaryColor: '#1A3628', accentColor: '#C5973C' });
    }
    if (path === '/api/auth/me') return json(user);
    if (path === '/api/client/dashboard') {
      return json({ client, matters: [], documents: [], invoices: [], appearances: [], notices: [], paymentProofs: [], invoicePayments: [] });
    }
    if (path === '/api/dashboard') return json({});
    if (path === '/api/clients') return json([client]);
    if (path === '/api/matters') return json([matter]);
    if (path === '/api/tasks' || path === '/api/invoices' || path === '/api/notifications') return json([]);
    if (method === 'POST' && path === '/api/notifications/read') return json({ success: true });

    if (method === 'GET' && path === '/api/documents') {
      if (state.failNextList) {
        state.failNextList = false;
        state.events.push({ kind: 'list-error', cursor: params.cursor || '' });
        return json({ error: 'Disposable list failure' }, 503);
      }
      const status = url.searchParams.get('status') || 'active';
      const statusDocuments = state.documents.filter(document => status === 'all' || (status === 'archived' ? document.archived : !document.archived));
      const matching = statusDocuments.filter(document => matchesQuery(document, url));
      const ordered = sortedDocuments(matching, url.searchParams.get('sort') || 'date_desc');
      const offset = Number((url.searchParams.get('cursor') || 'CURSOR-0').replace('CURSOR-', '')) || 0;
      const nextOffset = offset + state.pageSize;
      let items = ordered.slice(offset, nextOffset);
      if (state.injectDuplicateCursor && offset > 0 && ordered[offset - 1]) items = [ordered[offset - 1], ...items];
      const hasMore = nextOffset < ordered.length;
      state.events.push({ kind: 'list', cursor: params.cursor || '', ids: items.map(document => document.id) });
      return json({
        items,
        limit: 25,
        sort: url.searchParams.get('sort') || 'date_desc',
        status,
        hasMore,
        nextCursor: hasMore ? `CURSOR-${nextOffset}` : null,
        filterOptions: filterOptions(statusDocuments),
      });
    }

    const documentMatch = path.match(/^\/api\/documents\/([^/]+)(\/restore)?$/);
    if (documentMatch && method === 'PATCH' && !documentMatch[2]) {
      const documentId = decodeURIComponent(documentMatch[1]);
      const body = request.postDataJSON();
      if (typeof body?.clientVisible !== 'boolean') return json({ error: 'Client visibility must be true or false' }, 400);
      const action = body.clientVisible ? 'make_client_visible' : 'make_internal';
      const outcomeQueue = state.outcomes[`${action}:${documentId}`] || state.outcomes[`visibility:${documentId}`] || state.outcomes[documentId] || [];
      const outcome = outcomeQueue.shift() || { status: 200 };
      state.inFlight += 1;
      state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
      state.mutations.push({ action, documentId, method, path, body });
      state.events.push({ kind: 'mutation-start', action, documentId });
      await new Promise(resolve => setTimeout(resolve, outcome.delay ?? 55));
      if (outcome.remove) state.documents = state.documents.filter(document => document.id !== documentId);
      state.inFlight -= 1;
      state.events.push({ kind: 'mutation-end', action, documentId, status: outcome.status || 0, network: Boolean(outcome.network) });
      if (outcome.network) return route.abort('failed');
      if (outcome.status && outcome.status !== 200) return json({ error: outcome.error || `Disposable ${outcome.status} failure` }, outcome.status);
      const document = state.documents.find(item => item.id === documentId);
      if (!document) return json({ error: 'Document not found' }, 404);
      document.visibility = body.clientVisible ? 'client' : 'internal';
      return json({ ...document, clientVisible: body.clientVisible ? 1 : 0 });
    }
    if (documentMatch && (method === 'DELETE' || (method === 'PATCH' && documentMatch[2] === '/restore'))) {
      const documentId = decodeURIComponent(documentMatch[1]);
      const action = method === 'DELETE' ? 'archive' : 'restore';
      const outcomeQueue = state.outcomes[`${action}:${documentId}`] || state.outcomes[documentId] || [];
      const outcome = outcomeQueue.shift() || { status: 200 };
      state.inFlight += 1;
      state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
      state.mutations.push({ action, documentId, method, path });
      state.events.push({ kind: 'mutation-start', action, documentId });
      await new Promise(resolve => setTimeout(resolve, outcome.delay ?? 55));
      if (outcome.remove) state.documents = state.documents.filter(document => document.id !== documentId);
      state.inFlight -= 1;
      state.events.push({ kind: 'mutation-end', action, documentId, status: outcome.status || 0, network: Boolean(outcome.network) });
      if (outcome.network) return route.abort('failed');
      if (outcome.status && outcome.status !== 200) return json({ error: outcome.error || `Disposable ${outcome.status} failure` }, outcome.status);
      const document = state.documents.find(item => item.id === documentId);
      if (!document) return json({ error: 'Document not found' }, 404);
      if (action === 'archive') {
        document.archived = true;
        document.archivedAt = '2026-07-13T12:00:00.000Z';
        return json({ id: document.id, deleted: true });
      }
      document.archived = false;
      document.archivedAt = null;
      return json(document);
    }

    if (method === 'GET' && path === '/api/matters/MATTER-1') {
      return json({ ...matter, documents: state.documents.filter(document => !document.archived), tasks: [], appearances: [], invoices: [], notes: [], timeEntries: [] });
    }
    if (method === 'GET' && path.startsWith('/api/matters/MATTER-1/')) return json([]);
    if (method === 'GET' && ['/api/document-templates', '/api/checklist-templates', '/api/users', '/api/work-metadata-links'].some(prefix => path.startsWith(prefix))) return json([]);

    state.unexpected.push(`${method} ${path}`);
    return json({ error: `Unexpected mocked request: ${method} ${path}` }, 404);
  });

  return state;
}

async function openExplorer(page, options = {}) {
  await page.setViewportSize(options.viewport || { width: 1280, height: 900 });
  const state = await installWorkspace(page, options);
  await page.goto('/#/staff/documents');
  if ((options.user || admin).role === 'client') return state;
  await expect(page.getByRole('heading', { name: 'Document register', exact: true })).toBeVisible();
  await expect(page.locator('[data-document-id]').first()).toBeVisible();
  return state;
}

test.describe('LOCAL-PILOT-GLOBAL-DOCUMENT-BULK-LIFECYCLE-95 UI', () => {
  test('selects only loaded rows, blocks Load more, clears selection across query/window changes, and supports desktop keyboard use', async ({ page }) => {
    const documents = [
      ...Array.from({ length: 7 }, (_, index) => documentRecord(index + 1)),
      documentRecord(20, { id: 'DOC-ARCHIVED', displayName: 'Archived Document.pdf', name: 'Archived Document.pdf', archived: true, archivedAt: '2026-07-10T08:00:00.000Z' }),
    ];
    const state = await openExplorer(page, { documents, pageSize: 3 });
    await expect(page.getByRole('button', { name: 'Select loaded', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Select all', exact: true })).toHaveCount(0);

    const firstCheckbox = page.getByLabel('Select Document 01.pdf');
    await firstCheckbox.focus();
    await page.keyboard.press('Space');
    await expect(firstCheckbox).toBeChecked();
    await expect(page.getByText('1 selected from 3 loaded', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Load more', exact: true })).toBeDisabled();

    await page.getByLabel('Search document metadata').fill('Document');
    await expect(firstCheckbox).not.toBeChecked();
    await expect(page.getByText('0 selected from 3 loaded', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Load more', exact: true })).toBeEnabled();

    const selectLoaded = page.getByRole('button', { name: 'Select loaded', exact: true });
    await selectLoaded.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByText('3 selected from 3 loaded', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await expect(page.getByText('0 selected from 3 loaded', { exact: true })).toBeVisible();

    await selectLoaded.click();
    await page.getByLabel('Filter by file type').selectOption('pdf');
    await expect(page.getByText('0 selected from 3 loaded', { exact: true })).toBeVisible();
    await selectLoaded.click();
    await page.getByLabel('Sort documents').selectOption('name_desc');
    await expect(page.getByText('0 selected from 3 loaded', { exact: true })).toBeVisible();
    await selectLoaded.click();
    await page.getByLabel('Include archived documents').check();
    await expect(page.getByText('0 selected from 3 loaded', { exact: true })).toBeVisible();

    await selectLoaded.click();
    state.failNextList = true;
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(page.getByText('Disposable list failure', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Try again', exact: true }).click();
    await expect(page.locator('[data-document-id]').first()).toBeVisible();
    await expect(page.getByText(/0 selected from 3 loaded/)).toBeVisible();

    await page.getByRole('button', { name: 'Load more', exact: true }).click();
    await expect(page.locator('.lf-global-documents-cards tbody tr')).toHaveCount(6);
    await expect(page.getByText('0 selected from 6 loaded', { exact: true })).toBeVisible();

    const loadedCheckbox = page.locator('.lf-global-document-select-checkbox').first();
    await loadedCheckbox.focus();
    await page.keyboard.press('Space');
    const bulkArchive = page.getByRole('button', { name: 'Bulk archive', exact: true });
    await bulkArchive.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Bulk archive loaded documents?' });
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    expect(state.mutations).toEqual([]);
    expect(state.unexpected).toEqual([]);
  });

  test('archives mixed loaded rows sequentially, continues across ordinary failures, rebuilds once without duplicates, and retries only eligible failures', async ({ page }) => {
    const documents = [
      documentRecord(1, { id: 'DOC-A', displayName: 'A-success.pdf', name: 'A-success.pdf' }),
      documentRecord(2, { id: 'DOC-B', displayName: 'B-403.pdf', name: 'B-403.pdf' }),
      documentRecord(3, { id: 'DOC-C', displayName: 'C-404.pdf', name: 'C-404.pdf' }),
      documentRecord(4, { id: 'DOC-D', displayName: 'D-409.pdf', name: 'D-409.pdf' }),
      documentRecord(5, { id: 'DOC-E', displayName: 'E-network.pdf', name: 'E-network.pdf' }),
      documentRecord(6, { id: 'DOC-F', displayName: 'F-archived.pdf', name: 'F-archived.pdf', archived: true, archivedAt: '2026-07-10T08:00:00.000Z' }),
      documentRecord(7, { id: 'DOC-G', displayName: 'G-filler.pdf', name: 'G-filler.pdf' }),
      documentRecord(8, { id: 'DOC-H', displayName: 'H-filler.pdf', name: 'H-filler.pdf' }),
    ];
    const state = await openExplorer(page, { documents, pageSize: 3 });
    state.outcomes['archive:DOC-B'] = [{ status: 403, error: 'Document access denied', remove: true }];
    state.outcomes['archive:DOC-C'] = [{ status: 404, error: 'Document not found', remove: true }];
    state.outcomes['archive:DOC-D'] = [{ status: 409, error: 'Document changed' }];
    state.outcomes['archive:DOC-E'] = [{ network: true }];

    await page.getByLabel('Filter by client').selectOption(client.id);
    await page.getByLabel('Sort documents').selectOption('name_asc');
    await page.getByLabel('Include archived documents').check();
    await page.getByRole('button', { name: 'Load more', exact: true }).click();
    await expect(page.locator('.lf-global-documents-cards tbody tr')).toHaveCount(6);
    await page.getByRole('button', { name: 'Select loaded', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Load more', exact: true })).toBeDisabled();

    await page.getByRole('button', { name: 'Bulk archive', exact: true }).click();
    let dialog = page.getByRole('dialog', { name: 'Bulk archive loaded documents?' });
    await expect(dialog).toContainText('5 eligible active documents');
    await expect(dialog).toContainText('1 ineligible archived document');
    await expect(dialog).toContainText('Requests run sequentially');
    await expect(dialog).toContainText('not transactional');

    const eventStart = state.events.length;
    state.injectDuplicateCursor = true;
    await dialog.getByRole('button', { name: 'Archive 5 documents', exact: true }).click();
    await expect(dialog.getByRole('status')).toContainText('Processing');
    await expect(page.locator('.lf-global-document-bulk-result')).toContainText('Bulk archive finished: 1 succeeded, 4 failed, 1 skipped.', { timeout: 15000 });

    expect(state.maxInFlight).toBe(1);
    expect(state.mutations.map(mutation => mutation.documentId)).toEqual(['DOC-A', 'DOC-B', 'DOC-C', 'DOC-D', 'DOC-E']);
    const operationEvents = state.events.slice(eventStart);
    const firstListIndex = operationEvents.findIndex(event => event.kind === 'list');
    const lastMutationEndIndex = operationEvents.reduce((last, event, index) => event.kind === 'mutation-end' ? index : last, -1);
    expect(firstListIndex).toBeGreaterThan(lastMutationEndIndex);
    expect(operationEvents.filter(event => event.kind === 'list' && !event.cursor)).toHaveLength(1);

    const loadedIds = await page.locator('.lf-global-documents-cards tbody tr').evaluateAll(rows => rows.map(row => row.dataset.documentId));
    expect(new Set(loadedIds).size).toBe(loadedIds.length);
    await expect(page.getByText('2 selected from 6 loaded', { exact: true })).toBeVisible();
    await expect(page.getByLabel('Select D-409.pdf')).toBeChecked();
    await expect(page.getByLabel('Select E-network.pdf')).toBeChecked();
    await expect(page.getByLabel('Filter by client')).toHaveValue(client.id);
    await expect(page.getByLabel('Sort documents')).toHaveValue('name_asc');
    await expect(page.getByLabel('Include archived documents')).toBeChecked();

    const mutationCount = state.mutations.length;
    await page.getByRole('button', { name: 'Retry failed', exact: true }).click();
    dialog = page.getByRole('dialog', { name: 'Bulk archive loaded documents?' });
    await expect(dialog).toContainText('2 eligible active documents');
    expect(state.mutations).toHaveLength(mutationCount);
    await dialog.getByRole('button', { name: 'Archive 2 documents', exact: true }).click();
    await expect(page.locator('.lf-global-document-bulk-result')).toContainText('Bulk archive finished: 2 succeeded, 0 failed, 0 skipped.', { timeout: 15000 });
    await expect(page.getByText('0 selected from 6 loaded', { exact: true })).toBeVisible();
    expect(state.mutations.slice(mutationCount).map(mutation => mutation.documentId)).toEqual(['DOC-D', 'DOC-E']);

    await page.locator('[data-document-id="DOC-D"]').getByRole('button', { name: 'Open matter', exact: true }).click();
    await expect(page).toHaveURL(/#\/staff\/matters\/MATTER-1\/documents\?folderId=FOLDER-EVIDENCE&documentId=DOC-D$/);
    expect(state.unexpected).toEqual([]);
  });

  test('restores only eligible archived rows from a mixed selection and reports exact final counts', async ({ page }) => {
    const documents = [
      documentRecord(1, { id: 'DOC-ACTIVE-1', displayName: 'Active one.pdf', name: 'Active one.pdf' }),
      documentRecord(2, { id: 'DOC-ARCHIVED', displayName: 'Archived one.pdf', name: 'Archived one.pdf', archived: true, archivedAt: '2026-07-10T08:00:00.000Z' }),
      documentRecord(3, { id: 'DOC-ACTIVE-2', displayName: 'Active two.pdf', name: 'Active two.pdf' }),
    ];
    const state = await openExplorer(page, { documents, pageSize: 10 });
    await page.getByLabel('Include archived documents').check();
    await expect(page.locator('.lf-global-documents-cards tbody tr')).toHaveCount(3);
    await page.getByRole('button', { name: 'Select loaded', exact: true }).click();
    await page.getByRole('button', { name: 'Bulk restore', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Bulk restore loaded documents?' });
    await expect(dialog).toContainText('1 eligible archived document');
    await expect(dialog).toContainText('2 ineligible active documents');
    await dialog.getByRole('button', { name: 'Restore 1 document', exact: true }).click();
    await expect(page.locator('.lf-global-document-bulk-result')).toContainText('Bulk restore finished: 1 succeeded, 0 failed, 2 skipped.');
    expect(state.mutations).toEqual([expect.objectContaining({ action: 'restore', documentId: 'DOC-ARCHIVED', method: 'PATCH', path: '/api/documents/DOC-ARCHIVED/restore' })]);
    await expect(page.getByLabel('Include archived documents')).toBeChecked();
    expect(state.unexpected).toEqual([]);
  });

  test('makes mixed loaded rows client visible sequentially, discloses client access, preserves the window, and retries only eligible failures', async ({ page }) => {
    const mutable = { clientVisibility: { mutable: true, ineligibilityReason: null } };
    const documents = [
      documentRecord(1, { id: 'DOC-A', displayName: 'A-internal.pdf', name: 'A-internal.pdf', capabilities: mutable }),
      documentRecord(2, { id: 'DOC-B', displayName: 'B-visible.pdf', name: 'B-visible.pdf', visibility: 'client', capabilities: mutable }),
      documentRecord(3, { id: 'DOC-C', displayName: 'C-client-upload.pdf', name: 'C-client-upload.pdf', source: 'client', origin: 'client', visibility: 'client', capabilities: { clientVisibility: { mutable: false, ineligibilityReason: 'client_upload' } } }),
      documentRecord(4, { id: 'DOC-D', displayName: 'D-message.pdf', name: 'D-message.pdf', origin: 'message', visibility: 'client', capabilities: { clientVisibility: { mutable: false, ineligibilityReason: 'message_context' } } }),
      documentRecord(5, { id: 'DOC-E', displayName: 'E-retry.pdf', name: 'E-retry.pdf', capabilities: mutable }),
      documentRecord(6, { id: 'DOC-F', displayName: 'F-archived.pdf', name: 'F-archived.pdf', archived: true, archivedAt: '2026-07-10T08:00:00.000Z', capabilities: { clientVisibility: { mutable: false, ineligibilityReason: 'archived' } } }),
      documentRecord(7, { id: 'DOC-G', displayName: 'G-notice.pdf', name: 'G-notice.pdf', origin: 'notice', visibility: 'client', capabilities: { clientVisibility: { mutable: false, ineligibilityReason: 'notice_context' } } }),
    ];
    const state = await openExplorer(page, { documents, pageSize: 20 });
    state.outcomes['make_client_visible:DOC-E'] = [{ status: 409, error: 'Document changed before the request' }];

    await page.getByLabel('Filter by client').selectOption(client.id);
    await page.getByLabel('Sort documents').selectOption('name_asc');
    await page.getByLabel('Include archived documents').check();
    await expect(page.locator('.lf-global-documents-cards tbody tr')).toHaveCount(7);
    await expect(page.locator('[data-document-id="DOC-C"]')).toContainText('Client uploads remain client visible.');
    await expect(page.locator('[data-document-id="DOC-D"]')).toContainText('Client access is managed by the linked conversation.');
    await expect(page.locator('[data-document-id="DOC-G"]')).toContainText('Client access is managed by the linked notice.');

    await page.getByRole('button', { name: 'Select loaded', exact: true }).click();
    await page.getByRole('button', { name: 'Bulk make client visible', exact: true }).click();
    let dialog = page.getByRole('dialog', { name: 'Bulk make client visible?' });
    await expect(dialog).toContainText('2 eligible internal documents');
    await expect(dialog).toContainText('5 ineligible or already client-visible documents');
    await expect(dialog).toContainText('Client uploads remain client visible.');
    await expect(dialog).toContainText('Client access is managed by the linked conversation.');
    await expect(dialog).toContainText('Client access is managed by the linked notice.');
    await expect(dialog).toContainText('Restore before changing client visibility.');
    await expect(dialog).toContainText('Already client visible.');
    await expect(dialog).toContainText('will become available through LexFlow’s client-facing matter document access rules');
    await expect(dialog).toContainText('Requests run sequentially through the existing per-document visibility action');

    const eventStart = state.events.length;
    await dialog.getByRole('button', { name: 'Make 2 client visible', exact: true }).click();
    await expect(dialog.getByRole('status')).toContainText('Processing');
    await expect(page.locator('.lf-global-document-bulk-result')).toContainText('Bulk make client visible finished: 1 succeeded, 1 failed, 5 skipped.', { timeout: 15000 });
    expect(state.maxInFlight).toBe(1);
    expect(state.mutations.map(mutation => mutation.documentId)).toEqual(['DOC-A', 'DOC-E']);
    expect(state.mutations.map(mutation => mutation.body)).toEqual([{ clientVisible: true }, { clientVisible: true }]);

    const operationEvents = state.events.slice(eventStart);
    const firstListIndex = operationEvents.findIndex(event => event.kind === 'list');
    const lastMutationEndIndex = operationEvents.reduce((last, event, index) => event.kind === 'mutation-end' ? index : last, -1);
    expect(firstListIndex).toBeGreaterThan(lastMutationEndIndex);
    expect(operationEvents.filter(event => event.kind === 'list')).toHaveLength(1);
    await expect(page.getByText('1 selected from 7 loaded', { exact: true })).toBeVisible();
    await expect(page.getByLabel('Select E-retry.pdf')).toBeChecked();
    await expect(page.getByLabel('Filter by client')).toHaveValue(client.id);
    await expect(page.getByLabel('Sort documents')).toHaveValue('name_asc');
    await expect(page.getByLabel('Include archived documents')).toBeChecked();

    const mutationCount = state.mutations.length;
    await page.getByRole('button', { name: 'Retry failed', exact: true }).click();
    dialog = page.getByRole('dialog', { name: 'Bulk make client visible?' });
    await expect(dialog).toContainText('1 eligible internal document');
    await dialog.getByRole('button', { name: 'Make 1 client visible', exact: true }).click();
    await expect(page.locator('.lf-global-document-bulk-result')).toContainText('Bulk make client visible finished: 1 succeeded, 0 failed, 0 skipped.', { timeout: 15000 });
    expect(state.mutations.slice(mutationCount).map(mutation => mutation.documentId)).toEqual(['DOC-E']);
    expect(state.documents.find(document => document.id === 'DOC-A').visibility).toBe('client');
    expect(state.documents.find(document => document.id === 'DOC-E').visibility).toBe('client');
    await expect(page.getByText('0 selected from 7 loaded', { exact: true })).toBeVisible();
    expect(state.unexpected).toEqual([]);
  });

  test('lets an advocate make only mutable client-visible rows internal', async ({ page }) => {
    const mutable = { clientVisibility: { mutable: true, ineligibilityReason: null } };
    const documents = [
      documentRecord(1, { id: 'DOC-A', displayName: 'A-visible.pdf', name: 'A-visible.pdf', visibility: 'client', capabilities: mutable }),
      documentRecord(2, { id: 'DOC-B', displayName: 'B-internal.pdf', name: 'B-internal.pdf', capabilities: mutable }),
      documentRecord(3, { id: 'DOC-C', displayName: 'C-client-upload.pdf', name: 'C-client-upload.pdf', source: 'client', origin: 'client', visibility: 'client', capabilities: { clientVisibility: { mutable: false, ineligibilityReason: 'client_upload' } } }),
      documentRecord(4, { id: 'DOC-D', displayName: 'D-message.pdf', name: 'D-message.pdf', origin: 'message', visibility: 'client', capabilities: { clientVisibility: { mutable: false, ineligibilityReason: 'message_context' } } }),
    ];
    const state = await openExplorer(page, { user: advocate, documents, pageSize: 10 });
    await page.getByRole('button', { name: 'Select loaded', exact: true }).click();
    await page.getByRole('button', { name: 'Bulk make internal', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Bulk make internal?' });
    await expect(dialog).toContainText('1 eligible client-visible document');
    await expect(dialog).toContainText('3 ineligible or already internal documents');
    await expect(dialog).not.toContainText('Client access disclosure');
    await dialog.getByRole('button', { name: 'Make 1 internal', exact: true }).click();
    await expect(page.locator('.lf-global-document-bulk-result')).toContainText('Bulk make internal finished: 1 succeeded, 0 failed, 3 skipped.');
    expect(state.mutations).toEqual([
      expect.objectContaining({ action: 'make_internal', documentId: 'DOC-A', method: 'PATCH', path: '/api/documents/DOC-A', body: { clientVisible: false } }),
    ]);
    expect(state.documents.find(document => document.id === 'DOC-A').visibility).toBe('internal');
    expect(state.unexpected).toEqual([]);
  });

  test('aborts remaining visibility requests on session expiry without rebuilding or automatic retry', async ({ page }) => {
    const capabilities = { clientVisibility: { mutable: true, ineligibilityReason: null } };
    const documents = [
      documentRecord(1, { id: 'DOC-A', displayName: 'A-success.pdf', name: 'A-success.pdf', capabilities }),
      documentRecord(2, { id: 'DOC-B', displayName: 'B-session.pdf', name: 'B-session.pdf', capabilities }),
      documentRecord(3, { id: 'DOC-C', displayName: 'C-never-sent.pdf', name: 'C-never-sent.pdf', capabilities }),
    ];
    const state = await openExplorer(page, { documents, pageSize: 10 });
    state.outcomes['make_client_visible:DOC-B'] = [{ status: 401, error: 'Session expired' }];
    await page.getByLabel('Sort documents').selectOption('name_asc');
    await page.getByRole('button', { name: 'Select loaded', exact: true }).click();
    await page.getByRole('button', { name: 'Bulk make client visible', exact: true }).click();
    const eventStart = state.events.length;
    await page.getByRole('dialog', { name: 'Bulk make client visible?' }).getByRole('button', { name: 'Make 3 client visible', exact: true }).click();
    await expect.poll(() => state.mutations.map(mutation => mutation.documentId)).toEqual(['DOC-A', 'DOC-B']);
    await expect(page.getByRole('button', { name: 'Sign in securely', exact: true })).toBeVisible();
    await page.waitForTimeout(150);
    expect(state.mutations.map(mutation => mutation.documentId)).toEqual(['DOC-A', 'DOC-B']);
    expect(state.events.slice(eventStart).filter(event => event.kind === 'list')).toEqual([]);
  });

  test('keeps visibility controls and disclosure usable without horizontal overflow at 390px', async ({ page }) => {
    const mutable = { clientVisibility: { mutable: true, ineligibilityReason: null } };
    const documents = [
      documentRecord(1, { id: 'DOC-A', capabilities: mutable }),
      documentRecord(2, { id: 'DOC-B', visibility: 'client', capabilities: mutable }),
      documentRecord(3, { id: 'DOC-C', source: 'client', origin: 'client', visibility: 'client', capabilities: { clientVisibility: { mutable: false, ineligibilityReason: 'client_upload' } } }),
    ];
    const state = await openExplorer(page, { user: advocate, documents, pageSize: 10, viewport: { width: 390, height: 844 } });
    await page.getByRole('button', { name: 'Select loaded', exact: true }).click();
    for (const name of ['Bulk make client visible', 'Bulk make internal', 'Bulk archive', 'Bulk restore']) {
      await expect(page.getByRole('button', { name, exact: true })).toBeVisible();
    }
    await page.getByRole('button', { name: 'Bulk make client visible', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Bulk make client visible?' });
    await expect(dialog).toContainText('Client access disclosure');
    const layout = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      documentWidth: document.documentElement.scrollWidth,
      bodyWidth: document.body.scrollWidth,
      bulkColumns: window.getComputedStyle(document.querySelector('.lf-global-documents-bulk-actions')).gridTemplateColumns,
      dialogWidth: document.querySelector('.lf-global-document-bulk-dialog')?.getBoundingClientRect().width || 0,
      dialogColumns: window.getComputedStyle(document.querySelector('.lf-global-document-bulk-dialog > div:last-child')).gridTemplateColumns,
    }));
    expect(layout.documentWidth).toBeLessThanOrEqual(layout.clientWidth);
    expect(layout.bodyWidth).toBeLessThanOrEqual(layout.clientWidth);
    expect(layout.bulkColumns.trim().split(/\s+/)).toHaveLength(1);
    expect(layout.dialogWidth).toBeLessThanOrEqual(390);
    expect(layout.dialogColumns.trim().split(/\s+/)).toHaveLength(1);
    await page.keyboard.press('Escape');
    expect(state.mutations).toEqual([]);
  });

  test('blocks a loaded selection above the 50-document execution cap explicitly', async ({ page }) => {
    const documents = Array.from({ length: 51 }, (_, index) => documentRecord(index + 1));
    const state = await openExplorer(page, { documents, pageSize: 100 });
    await page.getByRole('button', { name: 'Select loaded', exact: true }).click();
    await expect(page.getByText('51 selected from 51 loaded', { exact: true })).toBeVisible();
    await expect(page.getByRole('alert').filter({ hasText: 'Bulk actions are limited to 50 documents' }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Bulk archive', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Bulk restore', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Bulk make client visible', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Bulk make internal', exact: true })).toBeDisabled();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(state.mutations).toEqual([]);
  });

  test('aborts remaining sequential requests on session expiry without rebuilding or retrying automatically', async ({ page }) => {
    const documents = [
      documentRecord(1, { id: 'DOC-A', displayName: 'A-success.pdf', name: 'A-success.pdf' }),
      documentRecord(2, { id: 'DOC-B', displayName: 'B-session.pdf', name: 'B-session.pdf' }),
      documentRecord(3, { id: 'DOC-C', displayName: 'C-never-sent.pdf', name: 'C-never-sent.pdf' }),
      documentRecord(4, { id: 'DOC-D', displayName: 'D-never-sent.pdf', name: 'D-never-sent.pdf' }),
    ];
    const state = await openExplorer(page, { documents, pageSize: 10 });
    state.outcomes['archive:DOC-B'] = [{ status: 401, error: 'Session expired' }];
    await page.getByLabel('Sort documents').selectOption('name_asc');
    await page.getByRole('button', { name: 'Select loaded', exact: true }).click();
    await page.getByRole('button', { name: 'Bulk archive', exact: true }).click();
    const eventStart = state.events.length;
    await page.getByRole('dialog', { name: 'Bulk archive loaded documents?' }).getByRole('button', { name: 'Archive 4 documents', exact: true }).click();
    await expect.poll(() => state.mutations.map(mutation => mutation.documentId)).toEqual(['DOC-A', 'DOC-B']);
    await expect(page.getByRole('button', { name: 'Sign in securely', exact: true })).toBeVisible();
    await page.waitForTimeout(150);
    expect(state.mutations.map(mutation => mutation.documentId)).toEqual(['DOC-A', 'DOC-B']);
    expect(state.events.slice(eventStart).filter(event => event.kind === 'list')).toEqual([]);
  });

  test('gives advocates selectable 390px cards and stacked bulk controls without horizontal overflow', async ({ page }) => {
    const documents = [
      documentRecord(1),
      documentRecord(2),
      documentRecord(3, { archived: true, archivedAt: '2026-07-10T08:00:00.000Z' }),
    ];
    const state = await openExplorer(page, { user: advocate, documents, pageSize: 10, viewport: { width: 390, height: 844 } });
    await page.getByLabel('Include archived documents').check();
    const firstCard = page.locator('.lf-global-documents-cards tbody tr').first();
    await expect(firstCard).toHaveCSS('display', 'block');
    const labels = await firstCard.locator('td').evaluateAll(cells => cells.map(cell => (window.getComputedStyle(cell, '::before').content || '').replace(/^["']|["']$/g, '')));
    expect(labels).toEqual(['Select', 'Document', 'Matter', 'Client', 'Folder', 'Date', 'Origin', 'Visibility', 'Actions']);
    const selectionTarget = await firstCard.locator('.lf-global-document-selection-control').boundingBox();
    expect(selectionTarget.height).toBeGreaterThanOrEqual(44);

    await page.getByRole('button', { name: 'Select loaded', exact: true }).click();
    const layout = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      documentWidth: document.documentElement.scrollWidth,
      bodyWidth: document.body.scrollWidth,
      selectionColumns: window.getComputedStyle(document.querySelector('.lf-global-documents-selection-actions')).gridTemplateColumns,
      bulkColumns: window.getComputedStyle(document.querySelector('.lf-global-documents-bulk-actions')).gridTemplateColumns,
    }));
    expect(layout.documentWidth).toBeLessThanOrEqual(layout.clientWidth);
    expect(layout.bodyWidth).toBeLessThanOrEqual(layout.clientWidth);
    expect(layout.selectionColumns.trim().split(/\s+/)).toHaveLength(1);
    expect(layout.bulkColumns.trim().split(/\s+/)).toHaveLength(1);

    await page.getByRole('button', { name: 'Bulk archive', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Bulk archive loaded documents?' });
    const dialogLayout = await dialog.evaluate(element => ({
      width: element.querySelector('.lf-global-document-bulk-dialog')?.getBoundingClientRect().width || 0,
      buttonColumns: window.getComputedStyle(element.querySelector('.lf-global-document-bulk-dialog > div:last-child')).gridTemplateColumns,
    }));
    expect(dialogLayout.width).toBeLessThanOrEqual(390);
    expect(dialogLayout.buttonColumns.trim().split(/\s+/)).toHaveLength(1);
    await page.keyboard.press('Escape');
    expect(state.mutations).toEqual([]);
  });

  test('keeps assistants read-only with no selection or bulk controls and preserves individual read-only actions', async ({ page }) => {
    const state = await openExplorer(page, { user: assistant, documents: [documentRecord(1), documentRecord(2)], pageSize: 10 });
    await expect(page.getByText('Read only', { exact: true })).toBeVisible();
    await expect(page.locator('.lf-global-document-select-checkbox')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Select loaded', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Bulk archive', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Bulk restore', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Bulk make client visible', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Bulk make internal', exact: true })).toHaveCount(0);
    const row = page.locator('[data-document-id="DOC-01"]');
    expect(await row.getByRole('button').allTextContents()).toEqual(['Preview', 'Download', 'Open matter']);
    expect(state.mutations).toEqual([]);
  });

  test('keeps clients out of the staff Explorer even when its hash is requested', async ({ page }) => {
    const state = await openExplorer(page, { user: clientUser, documents: [documentRecord(1)], pageSize: 10 });
    await expect(page).toHaveURL(/#\/client\/dashboard$/);
    await expect(page.getByText('Client portal', { exact: true }).first()).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Document register', exact: true })).toHaveCount(0);
    expect(state.calls.filter(call => call.method === 'GET' && call.path === '/api/documents')).toEqual([]);
    expect(state.mutations).toEqual([]);
  });
});
