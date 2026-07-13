import { expect, test } from '@playwright/test';

const admin = {
  id: 'USER-ADMIN',
  fullName: 'Explorer Admin',
  email: 'admin@example.com',
  role: 'admin',
  hasAvatar: false,
};

const scopedClients = [
  { id: 'CLIENT-1', name: 'Acme Holdings Limited' },
  { id: 'CLIENT-2', name: 'Nairobi Community Trust' },
];
const hiddenClient = { id: 'CLIENT-HIDDEN', name: 'Hidden Metadata Client' };
const scopedMatters = [
  { id: 'MATTER-1', clientId: 'CLIENT-1', reference: 'ACM/2026/014', title: 'Acme Holdings v River Works', stage: 'Discovery' },
  { id: 'MATTER-2', clientId: 'CLIENT-2', reference: 'NCT/2026/008', title: 'Nairobi Community Trust Advisory', stage: 'Advisory' },
];
const hiddenMatter = { id: 'MATTER-HIDDEN', clientId: hiddenClient.id, reference: 'HIDDEN/001', title: 'Hidden Metadata Matter' };

const activeDocuments = [
  {
    id: 'DOC-1', displayName: 'chronology.pdf', name: 'chronology.pdf', type: 'PDF', mimeType: 'application/pdf', date: '2026-07-10', size: '245 KB', source: 'firm', origin: 'firm', visibility: 'internal', uploaderDisplay: 'Explorer Admin', archived: false, archivedAt: null,
    matter: scopedMatters[0], client: scopedClients[0],
    folder: { id: 'FOLDER-EVIDENCE', name: 'Evidence', archived: false },
    folderPath: [{ id: 'FOLDER-CASE', name: 'Case Files', archived: false }, { id: 'FOLDER-EVIDENCE', name: 'Evidence', archived: false }],
    folderPathLabel: 'Case Files / Evidence', location: { status: 'active', folderArchived: false, pathIncomplete: false },
  },
  {
    id: 'DOC-2', displayName: 'client-site-photo.png', name: 'client-site-photo.png', type: 'Image', mimeType: 'image/png', date: '2026-07-09', size: '1.2 MB', source: 'client', origin: 'client', visibility: 'client', uploaderDisplay: 'Acme Client', archived: false, archivedAt: null,
    matter: scopedMatters[1], client: scopedClients[1], folder: null, folderPath: [], folderPathLabel: 'Uncategorised', location: { status: 'uncategorised', folderArchived: false, pathIncomplete: false },
  },
  {
    id: 'DOC-3', displayName: 'message-note.docx', name: 'message-note.docx', type: 'Word', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', date: '2026-07-08', size: '32 KB', source: 'firm', origin: 'message', visibility: 'client', uploaderDisplay: 'Advocate One', archived: false, archivedAt: null,
    matter: scopedMatters[0], client: scopedClients[0], folder: null, folderPath: [], folderPathLabel: 'Uncategorised', location: { status: 'uncategorised', folderArchived: false, pathIncomplete: false },
  },
];

const archivedDocument = {
  id: 'DOC-ARCHIVED', displayName: 'archived-opinion.pdf', name: 'archived-opinion.pdf', type: 'PDF', mimeType: 'application/pdf', date: '2026-06-30', size: '88 KB', source: 'generated', origin: 'generated', visibility: 'internal', uploaderDisplay: 'Explorer Admin', archived: true, archivedAt: '2026-07-12T10:00:00.000Z',
  matter: scopedMatters[0], client: scopedClients[0],
  folder: { id: 'FOLDER-EVIDENCE', name: 'Evidence', archived: false },
  folderPath: [{ id: 'FOLDER-CASE', name: 'Case Files', archived: false }, { id: 'FOLDER-EVIDENCE', name: 'Evidence', archived: false }],
  folderPathLabel: 'Case Files / Evidence', location: { status: 'active', folderArchived: false, pathIncomplete: false },
};

function option(value, labels) {
  return { value, label: labels[value] };
}

function filterOptionsFor(documents) {
  const clientIds = new Set(documents.map(document => document.client?.id).filter(Boolean));
  const matterIds = new Set(documents.map(document => document.matter?.id).filter(Boolean));
  const types = [...new Set(documents.map(document => document.type.toLowerCase()))];
  const sources = [...new Set(documents.map(document => document.source))];
  const origins = [...new Set(documents.map(document => document.origin))];
  const visibilities = [...new Set(documents.map(document => document.visibility))];
  const typeLabels = { pdf: 'PDF', word: 'Word', image: 'Image', text: 'Text', file: 'Other file' };
  const sourceLabels = { firm: 'Firm', client: 'Client', generated: 'Generated' };
  const originLabels = { firm: 'Firm upload', client: 'Client upload', generated: 'Generated', message: 'Message attachment', notice: 'Notice attachment' };
  const visibilityLabels = { internal: 'Internal', client: 'Client visible' };
  return {
    clients: scopedClients.filter(client => clientIds.has(client.id)),
    matters: scopedMatters.filter(matter => matterIds.has(matter.id)),
    types: types.map(value => option(value, typeLabels)),
    sources: sources.map(value => option(value, sourceLabels)),
    origins: origins.map(value => option(value, originLabels)),
    visibilities: visibilities.map(value => option(value, visibilityLabels)),
  };
}

function matchingDocuments(url) {
  const status = url.searchParams.get('status') || 'active';
  const statusDocuments = status === 'all' ? [...activeDocuments, archivedDocument] : status === 'archived' ? [archivedDocument] : activeDocuments;
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
  const sort = url.searchParams.get('sort') || 'date_desc';
  const direction = sort.endsWith('_desc') ? -1 : 1;
  const key = sort.startsWith('name_') ? document => document.displayName.toLowerCase()
    : sort.startsWith('matter_') ? document => (document.matter.reference || document.matter.title).toLowerCase()
      : sort.startsWith('client_') ? document => document.client.name.toLowerCase()
        : document => document.date;
  filtered.sort((left, right) => direction * (key(left).localeCompare(key(right)) || left.id.localeCompare(right.id)));
  return { status, statusDocuments, filtered };
}

async function installWorkspace(page) {
  const calls = [];
  await page.addInitScript(session => {
    localStorage.setItem('lexflowSession', JSON.stringify(session));
    localStorage.setItem('lexflowToken', session.token);
  }, { token: 'phase-2-admin-token', user: admin });

  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    calls.push({ method, path, params: Object.fromEntries(url.searchParams) });
    const json = body => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

    if (path === '/api/public/branding' || path === '/api/firm-settings' || path === '/api/firm-settings/theme') return json({ name: 'Explorer Test Firm', primaryColor: '#1A3628', accentColor: '#C5973C' });
    if (path === '/api/auth/me') return json(admin);
    if (path === '/api/dashboard') return json({});
    if (path === '/api/clients') return json([...scopedClients, hiddenClient]);
    if (path === '/api/matters') return json([...scopedMatters, hiddenMatter]);
    if (path === '/api/tasks' || path === '/api/invoices' || path === '/api/notifications') return json([]);
    if (method === 'GET' && path === '/api/documents') {
      const { status, statusDocuments, filtered } = matchingDocuments(url);
      return json({ items: filtered, limit: 25, sort: url.searchParams.get('sort') || 'date_desc', status, hasMore: false, nextCursor: null, filterOptions: filterOptionsFor(statusDocuments) });
    }
    if (method === 'GET' && path === '/api/matters/MATTER-1') return json({ ...scopedMatters[0], documents: activeDocuments.filter(document => document.matter.id === 'MATTER-1'), tasks: [], appearances: [], invoices: [], notes: [], timeEntries: [] });
    if (method === 'GET' && path.startsWith('/api/matters/MATTER-1/')) return json([]);
    if (method === 'GET' && ['/api/document-templates', '/api/checklist-templates', '/api/users', '/api/work-metadata-links'].some(prefix => path.startsWith(prefix))) return json([]);
    return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: `Unexpected mocked request: ${method} ${path}` }) });
  });
  return calls;
}

async function openExplorer(page, viewport) {
  await page.setViewportSize(viewport);
  const calls = await installWorkspace(page);
  await page.goto('/#/staff/documents');
  await expect(page.getByRole('heading', { name: 'Document register', exact: true })).toBeVisible();
  await expect(page.locator('[data-document-id="DOC-1"]')).toBeVisible();
  return calls;
}

test.describe('LOCAL-PILOT-GLOBAL-DOCUMENTS-EXPLORER-PHASE-2-93 UI', () => {
  test('uses scoped options, applies every filter and stable sort, opts into archived rows, and carries precise navigation', async ({ page }) => {
    const calls = await openExplorer(page, { width: 1280, height: 900 });

    const clientLabels = await page.getByLabel('Filter by client').locator('option').allTextContents();
    const matterLabels = await page.getByLabel('Filter by matter').locator('option').allTextContents();
    expect(clientLabels).toEqual(['All accessible clients', 'Acme Holdings Limited', 'Nairobi Community Trust']);
    expect(matterLabels.join('\n')).toContain('ACM/2026/014');
    expect(matterLabels.join('\n')).toContain('NCT/2026/008');
    expect(clientLabels.join('\n')).not.toContain('Hidden Metadata');
    expect(matterLabels.join('\n')).not.toContain('Hidden Metadata');

    await page.getByLabel('Filter by client').selectOption('CLIENT-1');
    await expect(page.locator('[data-document-id="DOC-1"]')).toBeVisible();
    await expect(page.locator('[data-document-id="DOC-3"]')).toBeVisible();
    await expect(page.locator('[data-document-id="DOC-2"]')).toHaveCount(0);
    expect(await page.getByLabel('Filter by matter').locator('option').allTextContents()).toEqual(['All accessible matters', 'ACM/2026/014']);

    await page.getByRole('button', { name: 'Clear', exact: true }).click();
    await page.getByLabel('Filter by matter').selectOption('MATTER-2');
    await expect(page.locator('[data-document-id="DOC-2"]')).toBeVisible();
    await expect(page.locator('[data-document-id="DOC-1"]')).toHaveCount(0);

    await page.getByRole('button', { name: 'Clear', exact: true }).click();
    await page.getByLabel('Filter by file type').selectOption('image');
    await expect(page.locator('[data-document-id="DOC-2"]')).toBeVisible();

    await page.getByRole('button', { name: 'Clear', exact: true }).click();
    await page.getByLabel('Filter by origin').selectOption('message');
    await expect(page.locator('[data-document-id="DOC-3"]')).toBeVisible();

    await page.getByRole('button', { name: 'Clear', exact: true }).click();
    await page.getByLabel('Filter by visibility').selectOption('internal');
    await expect(page.locator('[data-document-id="DOC-1"]')).toBeVisible();
    await expect(page.locator('[data-document-id="DOC-2"]')).toHaveCount(0);

    await page.getByRole('button', { name: 'Clear', exact: true }).click();
    await page.getByLabel('Sort documents').selectOption('name_desc');
    await expect.poll(async () => page.locator('.lf-global-documents-cards tbody tr').evaluateAll(rows => rows.map(row => row.dataset.documentId))).toEqual(['DOC-3', 'DOC-2', 'DOC-1']);
    expect(calls.some(call => call.path === '/api/documents' && call.params.sort === 'name_desc')).toBe(true);

    await page.getByLabel('Include archived documents').check();
    const archivedRow = page.locator('[data-document-id="DOC-ARCHIVED"]');
    await expect(archivedRow).toBeVisible();
    await expect(archivedRow.getByText('Archived', { exact: true })).toBeVisible();
    await expect(archivedRow.getByRole('button', { name: 'Preview', exact: true })).toBeDisabled();
    await expect(archivedRow.getByRole('button', { name: 'Download', exact: true })).toBeDisabled();
    expect(calls.some(call => call.path === '/api/documents' && call.params.status === 'all')).toBe(true);

    const activeRow = page.locator('[data-document-id="DOC-1"]');
    await activeRow.getByRole('button', { name: 'Open matter', exact: true }).click();
    await expect(page).toHaveURL(/#\/staff\/matters\/MATTER-1\/documents\?folderId=FOLDER-EVIDENCE&documentId=DOC-1$/);
    expect(calls.filter(call => call.method !== 'GET' && /^\/api\/(documents|matters)(?:\/|$)/.test(call.path))).toEqual([]);
  });

  test('keeps the archived opt-in and read-only cards usable at 390px without overflow', async ({ page }) => {
    const calls = await openExplorer(page, { width: 390, height: 844 });
    await page.getByLabel('Include archived documents').check();
    const archivedRow = page.locator('[data-document-id="DOC-ARCHIVED"]');
    await expect(archivedRow).toBeVisible();
    await expect(archivedRow).toHaveCSS('display', 'block');
    await expect(archivedRow.getByRole('button', { name: 'Preview', exact: true })).toBeDisabled();
    await expect(archivedRow.getByRole('button', { name: 'Download', exact: true })).toBeDisabled();

    const layout = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      documentWidth: document.documentElement.scrollWidth,
      bodyWidth: document.body.scrollWidth,
      filterColumns: window.getComputedStyle(document.querySelector('.lf-global-documents-filter-grid')).gridTemplateColumns,
    }));
    expect(layout.documentWidth).toBeLessThanOrEqual(layout.clientWidth);
    expect(layout.bodyWidth).toBeLessThanOrEqual(layout.clientWidth);
    expect(layout.filterColumns.trim().split(/\s+/)).toHaveLength(1);
    expect(calls.filter(call => call.method !== 'GET')).toEqual([]);
  });
});
