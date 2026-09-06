import { expect, test } from '@playwright/test';

async function mount(page, role, view) {
  const clients = [{ id: 'shared', name: 'Shared Client', type: 'Individual', status: 'Active' }, { id: 'second', name: 'Second Client', type: 'Company' }];
  const matter = { id: 'A1', clientId: 'shared', clientName: 'Shared Client', title: 'Assigned matter', reference: '100B-A1', assignedTo: 'Advocate A', stage: 'Intake', priority: 'Medium', billingType: 'hourly', tasks: [], appearances: [], documents: [], invoices: [], notes: [], deadlines: [], timeEntries: [], checklist: [] };
  const data = { clients, matters: [matter], appearances: [], tasks: [], invoices: [], firmSettings: { name: 'Boundary Firm', moduleSettings: {} } };
  const state = { writes: [], requests: [], unexpected: [], errors: [] };
  page.on('pageerror', error => state.errors.push(error.message));
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    state.requests.push(`${request.method()} ${url.pathname}`);
    const reply = body => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname === '/api/firm-settings') return reply(data.firmSettings);
    if (url.pathname === '/api/auth/users') return reply(['A', 'B'].map(letter => ({ id: letter, fullName: `Advocate ${letter}`, role: 'advocate', isActive: 1 })));
    if (['/api/checklist-templates', '/api/matters/A1/suggestions', '/api/matters/A1/work-metadata-links'].includes(url.pathname)) return reply([]);
    if (request.method() === 'POST' && url.pathname === '/api/clients') {
      const body = request.postDataJSON(); state.writes.push({ url: url.pathname, body });
      return reply({ id: 'intake', ...body });
    }
    if (url.pathname === '/api/matters/A1/reassign' && request.method() === 'PATCH') {
      const body = request.postDataJSON(); state.writes.push({ url: url.pathname, body });
      Object.assign(matter, body); return reply(matter);
    }
    if (url.pathname === '/api/matters/A1') {
      if (request.method() === 'PATCH') { const body = request.postDataJSON(); state.writes.push({ url: url.pathname, body }); Object.assign(matter, body); }
      return reply(matter);
    }
    state.unexpected.push(`${request.method()} ${url.pathname}`);
    return route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"Unexpected request"}' });
  });
  await page.goto('/tests/fixtures/client-matter-boundary-harness.html');
  await page.waitForFunction(() => window.__boundaryHarnessReady);
  await page.evaluate(args => window.renderBoundary(args), { role, view, data });
  await expect(page.getByText(view === 'clients' ? 'Client directory' : 'Assigned matter', { exact: true }).first()).toBeVisible();
  return state;
}
function clean(state) { expect(state.unexpected).toEqual([]); expect(state.errors).toEqual([]); }

test('advocate client intake explains the admin handoff without requesting an inaccessible snapshot', async ({ page }) => {
  const state = await mount(page, 'advocate', 'clients');
  await page.locator('#client-shared').getByRole('button', { name: 'More actions', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: 'Edit', exact: true })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Delete', exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '+ New client', exact: true }).click();
  await page.getByLabel('Name', { exact: true }).fill('New intake client');
  await page.getByRole('button', { name: 'Create client', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Ask an admin to create and assign the first matter');
  expect(state.writes).toHaveLength(1);
  expect(state.requests.some(url => url.includes('/clients/intake/snapshot'))).toBe(false);
  await expect(page.getByRole('button', { name: /Start KYC|Start retainer/ })).toHaveCount(0);
  clean(state);
});
test('admin retains client deletion controls and assistant remains read only in the directory', async ({ page }) => {
  let state = await mount(page, 'admin', 'clients');
  for (const id of ['shared', 'second']) {
    await page.locator(`#client-${id}`).getByRole('button', { name: 'More actions', exact: true }).click();
    await expect(page.getByRole('menuitem', { name: 'Delete', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
  }
  clean(state);
  state = await mount(page, 'assistant', 'clients');
  await expect(page.getByRole('button', { name: /^(More actions|\+ New client)$/ })).toHaveCount(0);
  clean(state);
});
test('advocate matter edit locks both associations while saving ordinary profile changes', async ({ page }) => {
  const state = await mount(page, 'advocate', 'matters');
  await page.getByRole('button', { name: 'More actions', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Edit', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Client', exact: true })).toBeDisabled();
  await expect(page.getByRole('textbox', { name: /^Advocate/ })).toBeDisabled();
  await page.getByRole('textbox', { name: 'Title', exact: true }).fill('Updated own matter');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect.poll(() => state.writes.length).toBe(1);
  expect(state.writes[0]).toMatchObject({ url: '/api/matters/A1', body: { clientId: 'shared', assignedTo: 'Advocate A', title: 'Updated own matter' } });
  await expect(page.getByRole('button', { name: 'Reassign', exact: true })).toHaveCount(0);
  clean(state);
});
test('admin matter edit permits client reassociation and uses the dedicated advocate reassignment control', async ({ page }) => {
  const state = await mount(page, 'admin', 'matters');
  await page.getByRole('button', { name: 'More actions', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Edit', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Client', exact: true })).toBeEnabled();
  await expect(page.getByRole('textbox', { name: /^Advocate/ })).toBeDisabled();
  await page.getByRole('combobox', { name: 'Client', exact: true }).selectOption('second');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect.poll(() => state.writes.length).toBe(1);
  expect(state.writes[0].body).toMatchObject({ clientId: 'second', assignedTo: 'Advocate A' });
  await page.locator('.lf-admin-reassign-control select').selectOption('Advocate B');
  await page.getByRole('button', { name: 'Reassign', exact: true }).click();
  await expect.poll(() => state.writes.length).toBe(2);
  expect(state.writes[1]).toEqual({ url: '/api/matters/A1/reassign', body: { assignedTo: 'Advocate B' } });
  clean(state);
});
