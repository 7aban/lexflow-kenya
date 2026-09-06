import { expect, test } from '@playwright/test';

const savedMarkers = ['SYNTHETIC-100A-BROWSER-SAVED-TWILIO', 'SYNTHETIC-100A-BROWSER-SAVED-SMTP'];
const replacements = ['SYNTHETIC-100A-BROWSER-NEW-TWILIO', 'SYNTHETIC-100A-BROWSER-NEW-SMTP'];

async function mount(page) {
  const state = {
    secrets: { twilioToken: savedMarkers[0], smtpPass: savedMarkers[1] },
    settings: {
      name: 'Settings Boundary Firm', email: 'firm@example.test', phone: '+254700000000', address: 'Test address',
      primaryColor: '#1A3628', accentColor: '#C5973C', paymentInstructions: 'Pay test account 100A.',
      letterhead: '', theme: { primaryColor: '#1A3628', accentColor: '#C5973C' }, moduleSettings: { retainerManagement: true },
      reminderSettings: { remindersEnabled: true, whatsappEnabled: true, emailEnabled: true, twilioSid: 'AC-test', smtpHost: 'smtp.example.test', smtpUser: 'test@example.test', smtpPort: '587', twilioTokenConfigured: true, smtpPassConfigured: true },
    },
    writes: [], unexpected: [], console: [], errors: [], failNext: false,
  };
  page.on('console', message => state.console.push(message.text()));
  page.on('pageerror', error => state.errors.push(error.message));
  await page.route('**/api/**', async route => {
    const req = route.request();
    const url = new URL(req.url());
    const reply = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname === '/api/notices') return reply([]);
    if (url.pathname === '/api/firm-settings/theme/presets') return reply({ presets: [] });
    if (url.pathname === '/api/firm-settings/theme') return reply({ theme: state.settings.theme });
    if (url.pathname === '/api/firm-settings') {
      if (req.method() === 'GET') return reply(state.settings);
      if (req.method() === 'PUT') {
        const payload = req.postDataJSON();
        state.writes.push(payload);
        if (state.failNext) { state.failNext = false; return reply({ error: 'Synthetic save failure' }, 400); }
        for (const key of ['twilioToken', 'smtpPass']) {
          if (payload.reminderSettings?.[key] === null) state.secrets[key] = '';
          else if (payload.reminderSettings?.[key]) state.secrets[key] = payload.reminderSettings[key];
        }
        const { twilioToken, smtpPass, ...safeReminders } = payload.reminderSettings || {};
        state.settings = { ...state.settings, ...payload, reminderSettings: { ...state.settings.reminderSettings, ...safeReminders, twilioTokenConfigured: Boolean(state.secrets.twilioToken), smtpPassConfigured: Boolean(state.secrets.smtpPass) } };
        return reply(state.settings);
      }
    }
    state.unexpected.push(`${req.method()} ${url.pathname}`);
    return reply({ error: 'Unexpected request' }, 404);
  });
  await page.goto('/tests/fixtures/firm-settings-harness.html');
  await page.waitForFunction(() => window.__settingsHarnessReady === true);
  await page.evaluate(settings => window.renderFirmSettings(settings), state.settings);
  await expect(page.getByRole('button', { name: 'Reminders & Automation', exact: true })).toBeVisible();
  return state;
}
async function openReminders(page) {
  await page.getByRole('button', { name: 'Reminders & Automation', exact: true }).click();
  await expect(page.getByLabel('Twilio Token', { exact: true })).toBeVisible();
}
async function save(page, state) {
  const count = state.writes.length;
  await page.getByRole('button', { name: 'Save automation', exact: true }).click();
  await expect.poll(() => state.writes.length).toBe(count + 1);
  await expect(page.getByLabel('Twilio Token', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('SMTP Password', { exact: true })).toHaveValue('');
}
async function assertClean(page, state) {
  expect(state.unexpected).toEqual([]);
  expect(state.errors).toEqual([]);
  const visibleAndLogs = JSON.stringify({ html: await page.content(), console: state.console, notices: await page.evaluate(() => window.__settingsNotices) });
  for (const marker of [...savedMarkers, ...replacements]) expect(visibleAndLogs.includes(marker)).toBe(false);
}

test('ordinary identity/reminder saves preserve hidden credentials and use no masks', async ({ page }) => {
  const state = await mount(page);
  await page.getByRole('button', { name: 'Save settings', exact: true }).click();
  await expect.poll(() => state.writes.length).toBe(1);
  await openReminders(page);
  await expect(page.getByText('Configured. Saved value is hidden.', { exact: true })).toHaveCount(2);
  await expect(page.getByLabel('Twilio Token', { exact: true })).toHaveValue('');
  await page.getByLabel('Twilio Token', { exact: true }).fill('discarded-draft');
  await page.getByLabel('Twilio Token', { exact: true }).fill('');
  await save(page, state);
  for (const write of state.writes) {
    expect(write.reminderSettings).not.toHaveProperty('twilioToken');
    expect(write.reminderSettings).not.toHaveProperty('smtpPass');
    expect(JSON.stringify(write)).not.toContain('********');
  }
  expect(Object.values(state.secrets)).toEqual(savedMarkers);
  await assertClean(page, state);
});

test('replacement drafts reset after save and are not resent on later saves', async ({ page }) => {
  const state = await mount(page);
  await openReminders(page);
  await page.getByLabel('Twilio Token', { exact: true }).fill(replacements[0]);
  await page.getByLabel('SMTP Password', { exact: true }).fill(replacements[1]);
  await save(page, state);
  expect(Object.values(state.secrets)).toEqual(replacements);
  await save(page, state);
  expect(state.writes[1].reminderSettings).not.toHaveProperty('twilioToken');
  expect(state.writes[1].reminderSettings).not.toHaveProperty('smtpPass');
  await assertClean(page, state);
});

test('clearing is explicit, can be undone, and updates configured indicators', async ({ page }) => {
  const state = await mount(page);
  await openReminders(page);
  await page.getByRole('button', { name: 'Clear Twilio Token', exact: true }).click();
  await expect(page.getByLabel('Twilio Token', { exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Undo clear Twilio Token', exact: true }).click();
  await save(page, state);
  expect(state.secrets.twilioToken).toBe(savedMarkers[0]);
  await page.getByRole('button', { name: 'Clear Twilio Token', exact: true }).click();
  await page.getByRole('button', { name: 'Clear SMTP Password', exact: true }).click();
  expect(Object.values(state.secrets)).toEqual(savedMarkers);
  await save(page, state);
  expect(state.writes[1].reminderSettings).toMatchObject({ twilioToken: null, smtpPass: null });
  expect(Object.values(state.secrets)).toEqual(['', '']);
  await expect(page.getByText('Not configured.', { exact: true })).toHaveCount(2);
  await assertClean(page, state);
});

test('a rejected save retains the replacement draft without displaying it in errors', async ({ page }) => {
  const state = await mount(page);
  await openReminders(page);
  state.failNext = true;
  await page.getByLabel('SMTP Password', { exact: true }).fill(replacements[1]);
  await page.getByRole('button', { name: 'Save automation', exact: true }).click();
  await expect.poll(() => state.writes.length).toBe(1);
  await expect(page.getByLabel('SMTP Password', { exact: true })).toHaveValue(replacements[1]);
  expect(state.secrets.smtpPass).toBe(savedMarkers[1]);
  await save(page, state);
  expect(state.secrets.smtpPass).toBe(replacements[1]);
  await assertClean(page, state);
});

test('billing, branding and module sections still render with safe settings', async ({ page }) => {
  const state = await mount(page);
  await page.getByRole('button', { name: 'Billing & Payment', exact: true }).click();
  await expect(page.locator('textarea').first()).toHaveValue('Pay test account 100A.');
  await page.getByRole('button', { name: 'Branding & Theme', exact: true }).click();
  await expect(page.getByText('Branding & Theme', { exact: true }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Practice Modules', exact: true }).click();
  await expect(page.getByText('Retainer Management', { exact: true })).toBeVisible();
  await assertClean(page, state);
});
