import { expect, test } from '@playwright/test';

async function mount(page, role) {
 const clients = [{ id: 'shared', name: 'Shared Client' }];
 const matters = [{ id: 'A1', clientId: 'shared', title: 'Assigned matter', reference: '100C-A1' }];
 const conversation = { id: 'CA', matterId: 'A1', clientId: 'shared', subject: 'Assigned conversation', clientName: 'Shared Client', matterTitle: 'Assigned matter', reference: '100C-A1', status: 'open', createdAt: '2026-01-01', lastMessageAt: '2026-01-02', lastMessageSenderRole: 'client', messageCount: 1, unreadCount: 1, clientUnreadCount: 1, staffUnreadCount: 1, isUnread: true };
 const rows = [conversation];
 const messages = { CA: [{ id: 'MSG-A', conversationId: 'CA', senderRole: 'admin', senderName: 'Firm Team', senderHasAvatar: false, body: 'Authorized message', createdAt: '2026-01-02', attachments: [{ id: 'DOC-A', name: 'authorized.pdf', mimeType: 'application/pdf' }] }] };
 const state = { writes: [], unexpected: [], errors: [], downloads: 0 };
 page.on('pageerror', error => state.errors.push(error.message));
 await page.route('**/api/**', async route => {
  const req = route.request(), url = new URL(req.url());
  const reply = body => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  if (url.pathname === '/api/clients/shared/activity') return reply([]);
  if (url.pathname === '/api/documents/DOC-A/download') { state.downloads++; return route.fulfill({ status: 200, contentType: 'application/pdf', body: Buffer.from('Synthetic PDF fixture') }); }
  if (url.pathname === '/api/conversations') {
   if (req.method() === 'GET') return reply(rows);
   const body = req.postDataJSON(); state.writes.push({ url: url.pathname, body });
   const row = { ...conversation, ...body, id: 'NEW', matterId: body.matterId || '', messageCount: 0, unreadCount: 0, isUnread: false };
   rows.unshift(row); messages.NEW = []; return reply(row);
  }
  const match = url.pathname.match(/^\/api\/conversations\/(CA|NEW)\/(messages|read|status)$/);
  if (match) {
   const [, id, action] = match, row = rows.find(item => item.id === id);
   if (req.method() === 'GET') return reply(messages[id]);
   const body = req.postDataJSON(); state.writes.push({ url: url.pathname, body });
   if (action === 'read') { Object.assign(row, { unreadCount: 0, clientUnreadCount: 0, staffUnreadCount: 0, isUnread: false }); return reply(row); }
   if (action === 'status') { row.status = body.status; return reply(row); }
   const saved = { id: `MSG-${state.writes.length}`, conversationId: id, body: body.body, senderRole: role, senderName: 'Current User', createdAt: '2026-01-03', attachments: [] };
   messages[id].push(saved); row.messageCount = messages[id].length; return reply(saved);
  }
  state.unexpected.push(`${req.method()} ${url.pathname}`);
  return route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"Unexpected request"}' });
 });
 await page.goto('/tests/fixtures/communications-boundary-harness.html');
 await page.waitForFunction(() => window.__communicationsHarnessReady);
 await page.evaluate(args => window.renderCommunications(args), { role, clients, matters });
 return state;
}
async function clean(page, state) {
 expect(state.unexpected).toEqual([]); expect(state.errors).toEqual([]);
 const notices = await page.evaluate(() => window.__communicationsNotices);
 expect(notices.filter(notice => notice.type === 'danger')).toEqual([]);
}
for (const role of ['admin', 'assistant', 'advocate']) {
 test(`${role} inbox preserves read, attachment download, reply, triage and general intake`, async ({ page }) => {
  const state = await mount(page, role);
  await expect(page.getByText('Authorized message', { exact: true })).toBeVisible();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'authorized.pdf', exact: true }).click();
  expect((await download).suggestedFilename()).toBe('authorized.pdf');
  expect(state.downloads).toBe(1);
  await page.getByRole('button', { name: 'Mark read', exact: true }).click();
  await expect.poll(() => state.writes.some(write => write.url === '/api/conversations/CA/read')).toBe(true);
  await page.getByRole('button', { name: 'pending', exact: true }).click();
  await expect.poll(() => state.writes.some(write => write.url.endsWith('/status') && write.body.status === 'pending')).toBe(true);
  await page.getByRole('button', { name: 'Reply', exact: true }).click();
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill(`${role} reply`);
  await page.getByLabel('Attachment', { exact: true }).setInputFiles({ name: 'reply.pdf', mimeType: 'application/pdf', buffer: Buffer.from('Synthetic reply attachment') });
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByText(`${role} reply`, { exact: true })).toBeVisible();
  expect(state.writes.find(write => write.url.endsWith('/messages')).body.attachments).toHaveLength(1);
  await page.getByRole('button', { name: 'Start conversation', exact: true }).click();
  await page.getByRole('combobox', { name: 'Client', exact: true }).selectOption('shared');
  await page.getByRole('textbox', { name: 'Subject', exact: true }).fill('General enquiry');
  await page.getByRole('button', { name: 'Open thread', exact: true }).click();
  await expect.poll(() => state.writes.some(write => write.url === '/api/conversations' && write.body.clientId === 'shared' && write.body.matterId === '')).toBe(true);
  await expect(page.getByRole('heading', { name: 'General enquiry', exact: true })).toBeVisible();
  await clean(page, state);
 });
}
test('client portal retains own thread, mark-read, attachment download and message sending', async ({ page }) => {
 const state = await mount(page, 'client');
 await page.getByRole('button', { name: /^Message Firm/ }).click();
 await expect(page.getByText('Authorized message', { exact: true })).toBeVisible();
 await expect.poll(() => state.writes.some(write => write.url.endsWith('/read'))).toBe(true);
 const download = page.waitForEvent('download');
 await page.getByRole('button', { name: 'authorized.pdf', exact: true }).click();
 expect((await download).suggestedFilename()).toBe('authorized.pdf');
 await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Portal reply');
 await page.getByRole('button', { name: 'Send message', exact: true }).click();
 await expect(page.getByText('Portal reply', { exact: true })).toBeVisible();
 expect(state.writes.some(write => write.url.endsWith('/status'))).toBe(false);
 await clean(page, state);
});
