import { test, expect } from '@playwright/test';

const user = {
  id: 'USER-ASSISTANT',
  fullName: 'Explorer Assistant',
  email: 'assistant@example.com',
  role: 'assistant',
  hasAvatar: false,
};

const clients = [
  { id: 'CLIENT-1', name: 'Acme Holdings Limited' },
  { id: 'CLIENT-2', name: 'Nairobi Community Trust' },
];

const matters = [
  { id: 'MATTER-1', clientId: 'CLIENT-1', reference: 'ACM/2026/014', title: 'Acme Holdings v River Works', stage: 'Discovery' },
  { id: 'MATTER-2', clientId: 'CLIENT-2', reference: 'NCT/2026/008', title: 'Nairobi Community Trust Advisory', stage: 'Advisory' },
];

const documents = [
  {
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
    matter: matters[0],
    client: clients[0],
    folder: { id: 'FOLDER-EVIDENCE', name: 'Evidence', archived: false },
    folderPath: [
      { id: 'FOLDER-CASE', name: 'Case Files', archived: false },
      { id: 'FOLDER-EVIDENCE', name: 'Evidence', archived: false },
    ],
    folderPathLabel: 'Case Files / Evidence',
    location: { status: 'active', folderArchived: false, pathIncomplete: false },
  },
  {
    id: 'DOC-2',
    displayName: 'client-site-photo.png',
    name: 'client-site-photo.png',
    type: 'Image',
    mimeType: 'image/png',
    date: '2026-07-09',
    size: '1.2 MB',
    source: 'client',
    origin: 'client',
    visibility: 'client',
    uploaderDisplay: 'Acme Client',
    matter: matters[0],
    client: clients[0],
    folder: null,
    folderPath: [],
    folderPathLabel: 'Uncategorised',
    location: { status: 'uncategorised', folderArchived: false, pathIncomplete: false },
  },
  {
    id: 'DOC-3',
    displayName: 'generated-opinion.pdf',
    name: 'generated-opinion.pdf',
    type: 'PDF',
    mimeType: 'application/pdf',
    date: '2026-07-08',
    size: '88 KB',
    source: 'generated',
    origin: 'generated',
    visibility: 'internal',
    uploaderDisplay: 'Advocate One',
    generation: { templateName: 'Opinion Template', generatedBy: 'Advocate One', generatedAt: '2026-07-08T12:00:00.000Z', version: 2 },
    matter: matters[1],
    client: clients[1],
    folder: { id: 'FOLDER-ARCHIVE', name: 'Prior drafts', archived: true },
    folderPath: [{ id: 'FOLDER-ARCHIVE', name: 'Prior drafts', archived: true }],
    folderPathLabel: 'Prior drafts',
    location: { status: 'archived', folderArchived: true, pathIncomplete: false },
  },
];

const firmSettings = {
  name: 'Explorer Test Firm',
  primaryColor: '#1A3628',
  accentColor: '#C5973C',
};

const tinyPdf = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF');

function documentMatches(document, url) {
  const query = (url.searchParams.get('q') || '').toLowerCase();
  const haystack = [
    document.displayName,
    document.matter?.reference,
    document.matter?.title,
    document.client?.name,
    document.folderPathLabel,
  ].join(' ').toLowerCase();
  return (!query || haystack.includes(query))
    && (!url.searchParams.get('type') || document.type.toLowerCase() === url.searchParams.get('type'))
    && (!url.searchParams.get('origin') || document.origin === url.searchParams.get('origin'))
    && (!url.searchParams.get('visibility') || document.visibility === url.searchParams.get('visibility'))
    && (!url.searchParams.get('matterId') || document.matter?.id === url.searchParams.get('matterId'))
    && (!url.searchParams.get('clientId') || document.client?.id === url.searchParams.get('clientId'));
}

async function installMockWorkspace(page) {
  const documentCalls = [];
  const unexpected = [];
  await page.addInitScript(session => {
    localStorage.setItem('lexflowSession', JSON.stringify(session));
    localStorage.setItem('lexflowToken', session.token);
  }, { token: 'phase-92-test-token', user });

  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    const json = body => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

    if (path === '/api/public/branding' || path === '/api/firm-settings' || path === '/api/firm-settings/theme') return json(firmSettings);
    if (path === '/api/auth/me') return json(user);
    if (path === '/api/dashboard') return json({});
    if (path === '/api/clients') return json(clients);
    if (path === '/api/matters') return json(matters);
    if (path === '/api/tasks' || path === '/api/invoices' || path === '/api/notifications') return json([]);

    if (method === 'GET' && path === '/api/documents') {
      documentCalls.push({ method, search: url.search, params: Object.fromEntries(url.searchParams) });
      const matching = documents.filter(document => documentMatches(document, url));
      if (url.searchParams.get('cursor') === 'cursor-page-2') {
        return json({ items: matching.slice(2), limit: 25, sort: url.searchParams.get('sort') || 'date_desc', hasMore: false, nextCursor: null });
      }
      const paginated = matching.length === documents.length;
      return json({
        items: paginated ? matching.slice(0, 2) : matching,
        limit: 25,
        sort: url.searchParams.get('sort') || 'date_desc',
        hasMore: paginated,
        nextCursor: paginated ? 'cursor-page-2' : null,
      });
    }

    if (method === 'GET' && /^\/api\/documents\/[^/]+\/download$/.test(path)) {
      documentCalls.push({ method, path });
      const id = decodeURIComponent(path.split('/')[3]);
      const document = documents.find(item => item.id === id) || documents[0];
      return route.fulfill({
        status: 200,
        headers: {
          'Content-Type': document.mimeType,
          'Content-Disposition': `attachment; filename="${document.displayName}"`,
        },
        body: document.mimeType === 'image/png' ? Buffer.from('mock-image') : tinyPdf,
      });
    }

    if (method === 'GET' && path === '/api/matters/MATTER-1') return json(matters[0]);
    if (method === 'GET' && path.startsWith('/api/matters/MATTER-1/')) return json([]);

    unexpected.push(`${method} ${path}`);
    return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: `Unexpected mocked request: ${method} ${path}` }) });
  });

  return { documentCalls, unexpected };
}

async function openExplorer(page, viewport) {
  await page.setViewportSize(viewport);
  const state = await installMockWorkspace(page);
  await page.goto('/#/staff/documents');
  await expect(page.getByRole('heading', { name: 'Documents', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Document register', exact: true })).toBeVisible();
  await expect(page.locator('[data-document-id="DOC-1"]')).toBeVisible();
  return state;
}

test.describe('LOCAL-PILOT-GLOBAL-DOCUMENTS-EXPLORER-92 UI', () => {
  test('desktop table supports read-only search, filters, cursor loading, preview, download, and matter navigation', async ({ page }) => {
    const { documentCalls, unexpected } = await openExplorer(page, { width: 1280, height: 900 });
    const table = page.locator('.lf-global-documents-cards table');
    await expect(table).toBeVisible();
    await expect(table.locator('thead')).toBeVisible();
    await expect(table.locator('tbody tr')).toHaveCount(2);
    await expect(page.locator('[data-document-id="DOC-1"]')).toContainText('Case Files / Evidence');
    await expect(page.getByText('Read only', { exact: true })).toBeVisible();

    await page.locator('[data-document-id="DOC-1"]').getByRole('button', { name: 'Preview', exact: true }).click();
    const preview = page.getByRole('dialog', { name: 'chronology.pdf' });
    await expect(preview).toBeVisible();
    await expect(preview.locator('iframe[title="Preview of chronology.pdf"]')).toBeVisible();
    await preview.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(preview).toHaveCount(0);

    const download = page.waitForEvent('download');
    await page.locator('[data-document-id="DOC-1"]').getByRole('button', { name: 'Download', exact: true }).click();
    expect((await download).suggestedFilename()).toBe('chronology.pdf');

    await page.getByRole('button', { name: 'Load more', exact: true }).click();
    await expect(table.locator('tbody tr')).toHaveCount(3);
    expect(documentCalls.some(call => call.params?.cursor === 'cursor-page-2')).toBe(true);

    await page.getByLabel('Search document metadata').fill('chronology');
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await expect(table.locator('tbody tr')).toHaveCount(1);
    expect(documentCalls.some(call => call.params?.q === 'chronology')).toBe(true);

    await page.getByRole('button', { name: 'Clear', exact: true }).click();
    await expect(table.locator('tbody tr')).toHaveCount(2);
    await page.getByLabel('Filter by origin').selectOption('client');
    await expect(table.locator('tbody tr')).toHaveCount(1);
    await expect(page.locator('[data-document-id="DOC-2"]')).toBeVisible();
    expect(documentCalls.some(call => call.params?.origin === 'client')).toBe(true);

    await page.getByRole('button', { name: 'Clear', exact: true }).click();
    await expect(page.locator('[data-document-id="DOC-1"]')).toBeVisible();
    expect(unexpected).toEqual([]);
    expect(documentCalls.every(call => call.method === 'GET')).toBe(true);

    await page.locator('[data-document-id="DOC-1"]').getByRole('button', { name: 'Open matter', exact: true }).click();
    await expect(page).toHaveURL(/#\/staff\/matters\/MATTER-1\/documents$/);
  });

  test('390px renders accessible document cards without horizontal overflow', async ({ page }) => {
    const { unexpected } = await openExplorer(page, { width: 390, height: 844 });
    const cards = page.locator('.lf-global-documents-cards');
    const firstCard = cards.locator('tbody tr').first();
    await expect(firstCard).toBeVisible();
    await expect(cards.locator('thead')).toBeHidden();
    await expect(firstCard).toHaveCSS('display', 'block');

    const labels = await firstCard.locator('td').evaluateAll(cells => cells.map(cell =>
      (window.getComputedStyle(cell, '::before').content || '').replace(/^["']|["']$/g, '')
    ));
    expect(labels).toEqual(['Document', 'Matter', 'Client', 'Folder', 'Date', 'Origin', 'Visibility', 'Actions']);
    await expect(firstCard.getByRole('button', { name: 'Preview', exact: true })).toBeVisible();
    await expect(firstCard.getByRole('button', { name: 'Download', exact: true })).toBeVisible();
    await expect(firstCard.getByRole('button', { name: 'Open matter', exact: true })).toBeVisible();

    const layout = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      filterColumns: window.getComputedStyle(document.querySelector('.lf-global-documents-filter-grid')).gridTemplateColumns,
    }));
    expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth);
    expect(layout.filterColumns.trim().split(/\s+/)).toHaveLength(1);

    await page.getByRole('button', { name: 'Open navigation menu' }).click();
    await expect(page.getByLabel('Mobile navigation').getByRole('button', { name: 'Documents', exact: true })).toBeVisible();
    expect(unexpected).toEqual([]);
  });
});
