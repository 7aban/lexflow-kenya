import { test, expect } from '@playwright/test';

const VIEWPORTS = [360, 390, 768, 1280];

const STAFF_VIEWS = ['Dashboard', 'Communications', 'Performance', 'Matters', 'Invoices', 'Users'];

const STAFF_GROUPS = {
  Performance: 'Overview',
  Invoices: 'Finance',
  Users: 'Administration',
};

const CLIENT_VIEWS = ['My Matters'];

async function fillLoginField(locator, value) {
  await locator.click();
  await locator.fill(value);
}

async function staffLogin(page) {
  await page.goto('/');
  await page.waitForSelector('input[type="email"]');
  await fillLoginField(page.locator('input[type="email"]'), 'admin@lexflow.co.ke');
  await fillLoginField(page.locator('input[autocomplete$=" current-password"]'), 'password123');
  await page.click('button:has-text("Sign in securely")');
  await page.waitForSelector('.lf-desktop-sidebar', { timeout: 15000 });
}

async function clientLogin(page) {
  await page.goto('/');
  await page.waitForSelector('input[type="email"]');
  await page.click('button:has-text("Client Portal")');
  await page.waitForTimeout(200);
  await fillLoginField(page.locator('input[type="email"]'), 'margaret.wairimu@example.co.ke');
  await fillLoginField(page.locator('input[autocomplete$=" current-password"]'), 'password123');
  await page.click('button:has-text("Enter client portal")');
  await page.waitForSelector('.lf-desktop-sidebar', { timeout: 15000 });
}

async function seededClientLoginAvailable(request) {
  const response = await request.post('/api/auth/client-login', {
    data: {
      email: 'margaret.wairimu@example.co.ke',
      password: 'password123',
    },
  });
  if (response.ok()) return true;
  if ([401, 403, 404].includes(response.status())) return false;
  throw new Error(`Client login preflight failed with HTTP ${response.status()}`);
}

async function staffNavigate(page, view) {
  const group = STAFF_GROUPS[view];
  if (group) {
    const groupBtn = page.locator('button.lf-nav-group', { hasText: group });
    const navBtn = page.locator('button.lf-nav', { hasText: view });
    if (await navBtn.isVisible().catch(() => false)) {
      await navBtn.click();
    } else {
      await groupBtn.click();
      await navBtn.waitFor({ state: 'visible', timeout: 5000 });
      await navBtn.click();
    }
  } else {
    await page.locator('button.lf-nav', { hasText: view }).click();
  }
  await page.waitForTimeout(600);
}

async function clientNavigate(page, view) {
  await page.locator('button.lf-nav', { hasText: view }).click();
  await page.waitForTimeout(600);
}

async function openStaffMatterTasks(page) {
  await staffNavigate(page, 'Matters');
  const matterButton = page.locator('button').filter({ has: page.locator('small') }).first();
  await expect(matterButton).toBeVisible({ timeout: 15000 });
  await matterButton.click();
  await page.locator('.lf-matter-detail-workspace').waitFor({ state: 'visible', timeout: 15000 });
  const tasksTab = page.locator('.lf-matter-detail-workspace button', { hasText: /^Tasks\b/ }).first();
  await expect(tasksTab).toBeVisible({ timeout: 15000 });
  await tasksTab.click();
  const addTaskForm = page.locator('.lf-matter-detail-workspace form').filter({ hasText: 'Add task' }).first();
  await expect(addTaskForm).toBeVisible({ timeout: 15000 });
  return page.locator('.lf-matter-detail-workspace');
}

async function measureOverflow(page, vw) {
  await page.setViewportSize({ width: vw, height: 900 });
  await page.waitForTimeout(400);

  return page.evaluate(() => {
    const d = document.documentElement;
    const b = document.body;
    const sw = d.scrollWidth;
    const bw = b.scrollWidth;
    const cw = d.clientWidth;
    const hasH = sw > cw;

    const over = [];
    const all = document.querySelectorAll('*');
    for (let i = 0; i < all.length && over.length < 20; i++) {
      const el = all[i];
      if (el === d || el === b) continue;
      const r = el.getBoundingClientRect();
      if (r.width > cw + 1) {
        const s = window.getComputedStyle(el);
        over.push({
          tag: el.tagName,
          id: el.id || '',
          cls: typeof el.className === 'string' ? el.className.slice(0, 100) : '',
          w: Math.round(r.width),
          ox: s.overflowX,
          pTag: el.parentElement?.tagName || '',
          pOx: el.parentElement ? window.getComputedStyle(el.parentElement).overflowX : '',
          pW: Math.round(el.parentElement?.getBoundingClientRect().width || 0),
        });
      }
    }

    const tables = document.querySelectorAll('table');
    let safeWrappers = 0;
    let totalTables = 0;
    tables.forEach((t) => {
      totalTables++;
      const p = t.parentElement;
      if (p) {
        const ps = window.getComputedStyle(p);
        if (ps.overflowX === 'auto' || ps.overflowX === 'scroll') {
          if (p.scrollWidth <= cw + 1) safeWrappers++;
        }
      }
    });

    return {
      scrollWidth: Math.round(sw),
      bodyScrollWidth: Math.round(bw),
      clientWidth: cw,
      hasHScroll: hasH,
      overflowEls: over,
      totalTables,
      safeTableWrappers: safeWrappers,
    };
  });
}

function logMatrix(title, results) {
  console.log(`\n========== ${title} ==========`);
  const h = 'Page'.padEnd(25) + VIEWPORTS.map((v) => `W=${v}`.padEnd(22)).join('');
  console.log(h);
  console.log('-'.repeat(h.length));
  for (const [page, vps] of Object.entries(results)) {
    const row = page.padEnd(25) + vps.map((r) => (r.hasHScroll ? `❌ ${r.scrollWidth}>${r.clientWidth}`.padEnd(22) : '✅ OK'.padEnd(22))).join('');
    console.log(row);
  }
  for (const [page, vps] of Object.entries(results)) {
    for (const r of vps) {
      if (r.hasHScroll) {
        console.log(`\n❌ ${page} @ ${r.viewportWidth || r.clientWidth}px: scrollWidth=${r.scrollWidth}  clientWidth=${r.clientWidth}`);
        for (const el of r.overflowEls.slice(0, 5)) {
          console.log(`   <${el.tag}${el.id ? '#' + el.id : ''}> w=${el.w} ox=${el.ox}  parent=<${el.pTag}> pox=${el.pOx}`);
        }
      }
    }
  }
  console.log('');
}

test.describe('Responsive Overflow Verification', () => {
  test('Login credentials reset across mode switches, staff logout and Back navigation', async ({ page }) => {
    await page.goto('/');
    const email = page.locator('input[type="email"]');
    const password = page.locator('input[autocomplete$=" current-password"]');

    await fillLoginField(email, 'staff-draft@example.com');
    await fillLoginField(password, 'staff-draft-password');
    await page.getByRole('button', { name: 'Show password' }).click();
    await expect(password).toHaveAttribute('type', 'text');
    await page.route('**/api/auth/login', route => route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Test login error' }),
    }));
    await page.getByRole('button', { name: 'Sign in securely' }).click();
    await expect(page.getByText('Test login error')).toBeVisible();
    await page.unroute('**/api/auth/login');

    await page.getByRole('tab', { name: 'Client Portal' }).click();
    await expect(email).toHaveValue('');
    await expect(password).toHaveValue('');
    await expect(password).toHaveAttribute('type', 'password');
    await expect(page.getByText('Test login error')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeHidden();
    await expect(page.getByRole('button', { name: 'Continue with Microsoft' })).toBeHidden();

    await fillLoginField(email, 'client-draft@example.com');
    await fillLoginField(password, 'client-draft-password');
    await page.getByRole('button', { name: 'Show password' }).click();
    await page.getByRole('tab', { name: 'Staff Login' }).click();
    await expect(email).toHaveValue('');
    await expect(password).toHaveValue('');
    await expect(password).toHaveAttribute('type', 'password');

    await fillLoginField(email, 'admin@lexflow.co.ke');
    await fillLoginField(password, 'password123');
    await page.getByRole('button', { name: 'Sign in securely' }).click();
    await page.waitForSelector('.lf-desktop-sidebar', { timeout: 15000 });
    await page.getByRole('button', { name: 'Account menu' }).click();
    await page.locator('button:visible', { hasText: /^Exit$/ }).first().click();

    await expect(email).toHaveValue('');
    await expect(password).toHaveValue('');
    await expect(password).toHaveAttribute('type', 'password');
    await page.goBack();
    await expect(page.locator('.lf-desktop-sidebar')).toHaveCount(0);
    await page.goForward();
    await expect(email).toHaveValue('');
    await expect(password).toHaveValue('');
  });

  test('Client portal exit returns an empty login form', async ({ page, request }) => {
    test.skip(!await seededClientLoginAvailable(request), 'Current local pilot has no seeded client portal login.');
    await clientLogin(page);
    await page.locator('button:visible', { hasText: /^Exit$/ }).first().click();
    await expect(page.locator('input[type="email"]')).toHaveValue('');
    await expect(page.locator('input[autocomplete$=" current-password"]')).toHaveValue('');
    await expect(page.locator('input[autocomplete$=" current-password"]')).toHaveAttribute('type', 'password');
  });

  for (const view of STAFF_VIEWS) {
    test(`Staff portal ${view} — no horizontal overflow at 360, 390, 768, 1280`, async ({ page }) => {
      await staffLogin(page);
      await staffNavigate(page, view);
      const results = { [view]: [] };
      for (const vw of VIEWPORTS) {
        const m = await measureOverflow(page, vw);
        results[view].push(m);
      }
      logMatrix(`STAFF RESPONSIVE OVERFLOW — ${view}`, results);
      for (let i = 0; i < VIEWPORTS.length; i++) {
        expect.soft(results[view][i].hasHScroll, `${view} @ ${VIEWPORTS[i]}px`).toBe(false);
      }
    });
  }

  test('Staff matter detail tasks - no horizontal overflow at 360, 390, 768, 1280', async ({ page }) => {
    await staffLogin(page);
    const matterWorkspace = await openStaffMatterTasks(page);
    await expect(matterWorkspace).toContainText('Open tasks', { timeout: 15000 });

    const results = { 'Matter tasks': [] };
    for (const vw of VIEWPORTS) {
      const m = await measureOverflow(page, vw);
      results['Matter tasks'].push(m);
      await expect(matterWorkspace).toBeVisible();
    }
    logMatrix('STAFF MATTER TASKS RESPONSIVE OVERFLOW', results);
    for (let i = 0; i < VIEWPORTS.length; i++) {
      expect.soft(results['Matter tasks'][i].hasHScroll, `Matter tasks @ ${VIEWPORTS[i]}px`).toBe(false);
    }
  });

  test('Invoice Register mobile cards or empty state render at 360px', async ({ page }) => {
    await staffLogin(page);
    await staffNavigate(page, 'Invoices');
    await page.setViewportSize({ width: 360, height: 900 });
    await page.waitForTimeout(400);
    const firstCard = page.locator('.lf-invoice-cards tbody tr').first();
    if (await firstCard.isVisible().catch(() => false)) {
      const labels = await firstCard.evaluate((row) =>
        Array.from(row.querySelectorAll('td')).map((td) =>
          (window.getComputedStyle(td, '::before').content || '').replace(/^["']|["']$/g, '')
        )
      );
      const expected = ['Invoice', 'Client', 'Matter', 'Amount', 'Paid', 'Balance', 'Status', 'PDF', 'Actions'];
      for (const label of expected) {
        expect(labels, `Invoice Register mobile label "${label}"`).toContain(label);
      }
    } else {
      await expect(page.getByText(/No invoices (yet|match this filter)\./)).toBeVisible({ timeout: 15000 });
    }
    const m = await measureOverflow(page, 360);
    expect.soft(m.hasHScroll, 'Invoice Register mobile state @ 360px').toBe(false);
  });

  test('Invitations mobile cards — thead hidden and labels at 360px; desktop intact at 1280px', async ({ page }) => {
    await staffLogin(page);
    const groupBtn = page.locator('button.lf-nav-group', { hasText: 'Relationships' });
    const navBtn = page.locator('button.lf-nav', { hasText: 'Invitations' });
    if (!await navBtn.isVisible().catch(() => false)) {
      await groupBtn.click();
      await navBtn.waitFor({ state: 'visible', timeout: 5000 });
    }
    await navBtn.click();
    await page.waitForTimeout(600);

    await page.setViewportSize({ width: 360, height: 900 });
    await page.waitForTimeout(400);
    const firstCard = page.locator('.lf-invitation-cards tbody tr').first();
    if (await firstCard.isVisible().catch(() => false)) {
      const theadVisible360 = await page.evaluate(() => {
        const thead = document.querySelector('.lf-invitation-cards thead');
        if (!thead) return false;
        return window.getComputedStyle(thead).display !== 'none';
      });
      expect(theadVisible360, 'Invitations thead should be hidden at 360px').toBe(false);
      const labels = await firstCard.evaluate((row) =>
        Array.from(row.querySelectorAll('td')).map((td) =>
          (window.getComputedStyle(td, '::before').content || '').replace(/^["']|["']$/g, '')
        )
      );
      const expectedLabels = ['Email', 'Client', 'Status', 'Created', 'Expires', 'Link'];
      for (const label of expectedLabels) {
        expect(labels, `Invitations mobile label "${label}"`).toContain(label);
      }
    } else {
      await expect(page.getByText(/No invitations yet/).first()).toBeVisible({ timeout: 15000 });
    }

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.waitForTimeout(400);
    if (await firstCard.isVisible().catch(() => false)) {
      const theadVisible1280 = await page.evaluate(() => {
        const thead = document.querySelector('.lf-invitation-cards thead');
        if (!thead) return false;
        return window.getComputedStyle(thead).display !== 'none';
      });
      expect(theadVisible1280, 'Invitations thead should be visible at 1280px').toBe(true);
      const rowDisplay1280 = await page.evaluate(() => {
        const tr = document.querySelector('.lf-invitation-cards tbody tr');
        if (!tr) return 'table-row';
        return window.getComputedStyle(tr).display;
      });
      expect(rowDisplay1280, 'Invitations table row should not be block (card) at 1280px').not.toBe('block');
    } else {
      await expect(page.getByText(/No invitations yet/).first()).toBeVisible({ timeout: 15000 });
    }
  });

  test('Client portal — no horizontal overflow at 360, 390, 768, 1280', async ({ page, request }) => {
    test.skip(!await seededClientLoginAvailable(request), 'Current local pilot has no seeded client portal login.');
    await clientLogin(page);
    const results = {};
    for (const view of CLIENT_VIEWS) {
      await clientNavigate(page, view);
      results[view] = [];
      for (const vw of VIEWPORTS) {
        const m = await measureOverflow(page, vw);
        results[view].push(m);
      }
    }
    logMatrix('CLIENT RESPONSIVE OVERFLOW', results);
    for (const view of CLIENT_VIEWS) {
      for (let i = 0; i < VIEWPORTS.length; i++) {
        expect.soft(results[view][i].hasHScroll, `${view} @ ${VIEWPORTS[i]}px`).toBe(false);
      }
    }
  });
});
