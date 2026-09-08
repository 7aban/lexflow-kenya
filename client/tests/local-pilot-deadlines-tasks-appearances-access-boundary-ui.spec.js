import { expect, test } from '@playwright/test';
async function mount(page, role, view = 'deadlines') {
  const state = { writes: [], errors: [] };
  page.on('pageerror', error => state.errors.push(error.message));
  const dueDate = new Date().toISOString().slice(0, 10);
  const rows = [{ id: 'sol:A1', title: 'Assigned limitation', type: 'SOL / Limitation', dueDate, status: 'Open' }, { id: 'appearance:DELEGATED', title: 'Delegated hearing', type: 'Court Date', dueDate, status: 'Open' }];
  await page.route('**/api/**', async route => {
    const req = route.request(), pathname = new URL(req.url()).pathname;
    const reply = body => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (req.method() !== 'GET') { state.writes.push({ pathname, body: req.postDataJSON() }); return reply({ id: 'NEW', ...req.postDataJSON() }); }
    if (pathname === '/api/deadlines') return reply(rows);
    if (pathname === '/api/compliance-guidance') return reply([]);
    state.errors.push(`Unexpected GET ${pathname}`); return reply([]);
  });
  await page.goto('/tests/fixtures/workflow-boundary-harness.html');
  await page.waitForFunction(() => Boolean(window.renderWorkflow));
  await page.evaluate(({ role, view }) => window.renderWorkflow({ role, view, data: { matters: [{ id: 'A1', title: 'Assigned matter' }], clients: [{ id: 'C1', name: 'Assigned client' }], tasks: [{ id: 'DELEGATED', matterId: 'B1', title: 'Delegated task', assignee: 'Advocate A', completed: false }] } }), { role, view });
  return state;
}
for (const role of ['admin', 'advocate']) test(`${role} submits the established null unlinked deadline payload`, async ({ page }) => {
  const state = await mount(page, role);
  await page.getByRole('button', { name: 'Add deadline', exact: true }).first().click();
  await page.getByLabel('Title', { exact: true }).fill('Unlinked browser deadline');
  await page.getByLabel('Due Date', { exact: true }).fill('2026-10-01');
  await expect(page.getByRole('combobox', { name: 'Matter', exact: true })).toHaveValue('');
  await page.locator('form').getByRole('button', { name: 'Add deadline', exact: true }).click();
  await expect.poll(() => state.writes.length).toBe(1);
  expect(state.writes[0]).toMatchObject({ pathname: '/api/deadlines', body: { matterId: null, clientId: null } });
  expect(state.errors).toEqual([]);
});
test('assistant reads court diary while custom deadline writes remain unavailable', async ({ page }) => {
  const state = await mount(page, 'assistant');
  await expect(page.getByText('Delegated hearing').first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add deadline', exact: true })).toHaveCount(0);
  expect(state.writes).toEqual([]); expect(state.errors).toEqual([]);
});
test('delegated task remains visible without adding its parent to matter choices', async ({ page }) => {
  const state = await mount(page, 'advocate', 'tasks');
  await expect(page.getByText('Delegated task', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '+ New task', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Matter', exact: true }).locator('option')).toHaveText(['Select matter', 'Assigned matter']);
  expect(state.errors).toEqual([]);
});
