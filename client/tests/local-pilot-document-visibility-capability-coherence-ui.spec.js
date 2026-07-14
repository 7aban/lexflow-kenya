import { expect, test } from '@playwright/test';
import { isDocumentClientVisible, staffDocumentVisibilityLabel } from '../src/lib/documentVisibility.js';

const HARNESS_PATH = '/tests/fixtures/matter-documents-harness.html';
const MUTABLE = { clientVisibility: { mutable: true, ineligibilityReason: null } };

function staffDocument(id, overrides = {}) {
  return {
    id,
    matterId: 'MAT-VISIBILITY',
    displayName: `${id}.pdf`,
    name: `${id}.pdf`,
    mimeType: 'application/pdf',
    folderId: null,
    folderName: 'Uncategorised',
    date: '2026-07-13',
    size: '1 KB',
    source: 'firm',
    clientVisible: 0,
    visibility: 'internal',
    capabilities: MUTABLE,
    ...overrides,
  };
}

function defaultStaffDocuments() {
  return [
    staffDocument('DOC-FIRM-INTERNAL'),
    staffDocument('DOC-FIRM-VISIBLE', { clientVisible: 1, visibility: 'client' }),
    staffDocument('DOC-GENERATED', { source: 'generated' }),
    staffDocument('DOC-CLIENT-UPLOAD', {
      source: 'client',
      visibility: 'client',
      capabilities: { clientVisibility: { mutable: false, ineligibilityReason: 'client_upload' } },
    }),
    staffDocument('DOC-MESSAGE', {
      messageId: 'MSG-VISIBILITY',
      clientVisible: 0,
      visibility: 'client',
      capabilities: { clientVisibility: { mutable: false, ineligibilityReason: 'message_context' } },
    }),
    staffDocument('DOC-NOTICE', {
      noticeId: 'NOTICE-VISIBILITY',
      clientVisible: 1,
      visibility: 'client',
      capabilities: { clientVisibility: { mutable: false, ineligibilityReason: 'notice_context' } },
    }),
  ];
}

async function installMockApi(page, { activeDocuments = defaultStaffDocuments(), archivedDocuments } = {}) {
  const state = {
    activeDocuments,
    archivedDocuments: archivedDocuments ?? [staffDocument('DOC-ARCHIVED', {
      visibility: 'internal',
      capabilities: { clientVisibility: { mutable: false, ineligibilityReason: 'archived' } },
    })],
    mutations: [],
    unexpected: [],
  };
  const json = (route, body, status = 200) => route.fulfill({
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
      await json(route, []);
      return;
    }
    if (method === 'GET' && /^\/api\/matters\/[^/]+\/folders$/.test(path)) {
      await json(route, [
        { id: 'all', name: 'All Documents', virtual: true },
        { id: 'uncategorised', name: 'Uncategorised', virtual: true },
      ]);
      return;
    }
    if (method === 'GET' && /^\/api\/matters\/[^/]+\/documents$/.test(path)) {
      await json(route, url.searchParams.get('status') === 'archived' ? state.archivedDocuments : state.activeDocuments);
      return;
    }

    const documentMatch = path.match(/^\/api\/documents\/([^/]+)$/);
    if (method === 'PATCH' && documentMatch) {
      const documentId = decodeURIComponent(documentMatch[1]);
      const body = request.postDataJSON();
      state.mutations.push({ documentId, body });
      const document = state.activeDocuments.find(item => String(item.id) === documentId);
      if (!document) {
        await json(route, { error: 'Document not found' }, 404);
        return;
      }
      document.clientVisible = body.clientVisible ? 1 : 0;
      document.visibility = body.clientVisible ? 'client' : 'internal';
      await json(route, document);
      return;
    }

    state.unexpected.push(`${method} ${path}${url.search}`);
    await json(route, { error: 'Unexpected mocked request' }, 404);
  });

  return state;
}

async function mountMatterDocuments(page, props = {}) {
  await page.goto(HARNESS_PATH);
  await page.waitForFunction(() => window.__matterHarnessReady === true);
  await page.evaluate(nextProps => window.renderMatterDocuments(nextProps), {
    matterId: 'MAT-VISIBILITY',
    canManage: props.canManage ?? true,
    clientMode: props.clientMode ?? false,
    role: props.role || (props.clientMode ? 'client' : props.canManage === false ? 'assistant' : 'admin'),
  });
  await expect(page.locator('[data-document-id]').first()).toBeVisible();
}

function documentRow(page, id) {
  return page.locator(`[data-document-id="${id}"]`);
}

function folderButton(page, name) {
  return page.locator('.lf-doc-folder-button').filter({ hasText: name }).first();
}

async function expectNoPageOverflow(page) {
  const layout = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    documentWidth: document.documentElement.scrollWidth,
    bodyWidth: document.body.scrollWidth,
  }));
  expect(layout.documentWidth).toBeLessThanOrEqual(layout.clientWidth);
  expect(layout.bodyWidth).toBeLessThanOrEqual(layout.clientWidth);
}

test.describe('LOCAL-PILOT-DOCUMENT-VISIBILITY-CAPABILITY-COHERENCE-98 UI', () => {
  test('shows mutable controls and accurate context-managed and archived statuses on desktop', async ({ page }) => {
    expect(isDocumentClientVisible({ clientVisible: 0, visibility: 'client' })).toBe(true);
    expect(staffDocumentVisibilityLabel({ clientVisible: 0, visibility: 'client' })).toBe('Client-visible');
    await page.setViewportSize({ width: 1280, height: 900 });
    const state = await installMockApi(page);
    await mountMatterDocuments(page, { canManage: true, role: 'admin' });

    const internalRow = documentRow(page, 'DOC-FIRM-INTERNAL');
    const visibleRow = documentRow(page, 'DOC-FIRM-VISIBLE');
    await expect(internalRow.getByRole('button', { name: 'Internal', exact: true })).toBeVisible();
    await expect(visibleRow.getByRole('button', { name: 'Shared', exact: true })).toBeVisible();

    const clientUploadRow = documentRow(page, 'DOC-CLIENT-UPLOAD');
    await expect(clientUploadRow.locator('[data-client-visibility="client"]')).toContainText('Client visible');
    await expect(clientUploadRow).toContainText('Client uploads remain available to the client.');

    const messageRow = documentRow(page, 'DOC-MESSAGE');
    await expect(messageRow.locator('[data-client-visibility="client"]')).toContainText('Client visible');
    await expect(messageRow).toContainText('Client access is managed by the linked conversation.');
    await expect(messageRow.getByRole('button', { name: /^(Shared|Internal)$/ })).toHaveCount(0);

    const noticeRow = documentRow(page, 'DOC-NOTICE');
    await expect(noticeRow.locator('[data-client-visibility="client"]')).toContainText('Client visible');
    await expect(noticeRow).toContainText('Client access is managed by the linked notice.');
    await expect(noticeRow.getByRole('button', { name: /^(Shared|Internal)$/ })).toHaveCount(0);

    await internalRow.getByRole('button', { name: 'Internal', exact: true }).click();
    await expect.poll(() => state.mutations).toEqual([
      { documentId: 'DOC-FIRM-INTERNAL', body: { clientVisible: true } },
    ]);
    await expect(documentRow(page, 'DOC-FIRM-INTERNAL').getByRole('button', { name: 'Shared', exact: true })).toBeVisible();

    await folderButton(page, 'Archived documents').click();
    const archivedRow = documentRow(page, 'DOC-ARCHIVED');
    await expect(archivedRow.locator('[data-client-visibility="internal"]')).toContainText('Internal');
    await expect(archivedRow).toContainText('Restore this document before changing client access.');
    await expect(archivedRow.getByRole('button', { name: /^(Shared|Internal)$/ })).toHaveCount(0);
    await expect(archivedRow.getByRole('button', { name: 'More actions' })).toBeVisible();

    await expectNoPageOverflow(page);
    expect(state.unexpected).toEqual([]);
  });

  test('keeps assistants read-only while showing effective status and reasons at 390px', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const state = await installMockApi(page);
    await mountMatterDocuments(page, { canManage: false, clientMode: false, role: 'assistant' });

    const firmRow = documentRow(page, 'DOC-FIRM-INTERNAL');
    await expect(firmRow.locator('[data-client-visibility="internal"]')).toContainText('Internal');
    await expect(firmRow).toContainText('Read only for your role.');
    await expect(firmRow.getByRole('button', { name: /^(Shared|Internal)$/ })).toHaveCount(0);

    const messageRow = documentRow(page, 'DOC-MESSAGE');
    await expect(messageRow.locator('[data-client-visibility="client"]')).toContainText('Client visible');
    await expect(messageRow).toContainText('Client access is managed by the linked conversation.');
    await expect(page.getByRole('checkbox', { name: /Select/ })).toHaveCount(0);
    await expect(page.getByRole('combobox', { name: /Move/ })).toHaveCount(0);
    await expect(messageRow.getByRole('button', { name: 'Preview', exact: true })).toBeVisible();
    await expect(messageRow.getByRole('button', { name: 'Download', exact: true })).toBeVisible();

    const accessCell = messageRow.locator('td[data-label="Client Access"]');
    await expect(accessCell).toBeVisible();
    await expect(accessCell).toHaveCSS('display', 'flex');
    await expectNoPageOverflow(page);
    expect(state.mutations).toEqual([]);
    expect(state.unexpected).toEqual([]);
  });

  test('leaves the 390px client document experience unchanged', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const clientDocuments = [
      staffDocument('DOC-CLIENT-OWN', { source: 'client', clientVisible: 0, visibility: undefined, capabilities: undefined }),
      staffDocument('DOC-CLIENT-MESSAGE', { messageId: 'MSG-CLIENT', clientVisible: 0, visibility: undefined, capabilities: undefined }),
    ];
    const state = await installMockApi(page, { activeDocuments: clientDocuments, archivedDocuments: [] });
    await mountMatterDocuments(page, { canManage: false, clientMode: true, role: 'client' });

    await expect(page.locator('th', { hasText: 'Client Access' })).toHaveCount(0);
    await expect(page.locator('[data-client-visibility]')).toHaveCount(0);
    await expect(page.getByText(/Client access is managed|Read only for your role/)).toHaveCount(0);
    await expect(documentRow(page, 'DOC-CLIENT-OWN').getByRole('button', { name: 'Preview', exact: true })).toBeVisible();
    await expect(documentRow(page, 'DOC-CLIENT-OWN').getByRole('button', { name: 'Download', exact: true })).toBeVisible();
    await expectNoPageOverflow(page);
    expect(state.mutations).toEqual([]);
    expect(state.unexpected).toEqual([]);
  });
});
