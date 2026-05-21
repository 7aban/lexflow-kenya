import { test, expect } from '@playwright/test';

const VIEWPORTS = [360, 390, 768, 1280];

const STAFF_VIEWS = ['Dashboard', 'Communications', 'Performance', 'Matters', 'Invoices', 'Users'];

const STAFF_GROUPS = {
  Performance: 'Overview',
  Invoices: 'Finance',
  Users: 'Administration',
};

const CLIENT_VIEWS = ['My Matters'];

async function staffLogin(page) {
  await page.goto('/');
  await page.waitForSelector('input[autocomplete="email"]');
  await page.fill('input[autocomplete="email"]', 'admin@lexflow.co.ke');
  await page.fill('input[autocomplete="current-password"]', 'password123');
  await page.click('button:has-text("Sign in securely")');
  await page.waitForSelector('.lf-desktop-sidebar', { timeout: 15000 });
}

async function clientLogin(page) {
  await page.goto('/');
  await page.waitForSelector('input[autocomplete="email"]');
  await page.click('button:has-text("Client Portal")');
  await page.waitForTimeout(200);
  await page.fill('input[autocomplete="email"]', 'margaret.wairimu@example.co.ke');
  await page.fill('input[autocomplete="current-password"]', 'password123');
  await page.click('button:has-text("Enter client portal")');
  await page.waitForSelector('.lf-desktop-sidebar', { timeout: 15000 });
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

async function openStaffMatterDetail(page) {
  await staffNavigate(page, 'Matters');
  const matterButton = page.locator('button').filter({ has: page.locator('small') }).first();
  await expect(matterButton).toBeVisible({ timeout: 15000 });
  await matterButton.click();
  await page.locator('.lf-matter-detail-workspace').waitFor({ state: 'visible', timeout: 15000 });
  const workspaceTab = page.locator('button', { hasText: /^Workspace$/ });
  if (await workspaceTab.isVisible().catch(() => false)) {
    await workspaceTab.click();
  }
  const checklistPanel = page.locator('section[aria-label="Matter checklist"]');
  await expect(checklistPanel).toBeVisible({ timeout: 15000 });
  return checklistPanel;
}

async function addChecklistItemWithInternalMeta(checklistPanel) {
  const addForm = checklistPanel.locator('form').filter({ hasText: 'Add item' }).first();
  await expect(addForm).toBeVisible({ timeout: 15000 });
  await expect(addForm).toContainText('Checklist due');
  await expect(addForm).toContainText('Assignee');

  const itemTitle = `Responsive checklist internal due ${Date.now()}`;
  const textInputs = addForm.locator('input:not([type]), input[type="text"]');
  await textInputs.first().fill(itemTitle);
  const dueDateInput = addForm.locator('input[type="date"]');
  const assigneeInput = textInputs.nth(2);
  await dueDateInput.fill('2026-05-29');
  await assigneeInput.fill('Responsive QA');
  await expect(dueDateInput).toHaveValue('2026-05-29');
  await expect(assigneeInput).toHaveValue('Responsive QA');
  await addForm.getByRole('button', { name: 'Add item' }).click();

  await expect(checklistPanel).toContainText(itemTitle, { timeout: 15000 });
  await expect(checklistPanel).toContainText('Checklist due:');
  await expect(checklistPanel).toContainText('Assignee: Responsive QA');
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

  test('Staff matter detail checklist - no horizontal overflow at 360, 390, 768, 1280', async ({ page }) => {
    await staffLogin(page);
    const checklistPanel = await openStaffMatterDetail(page);
    await expect(checklistPanel).toContainText(/\d+ of \d+ complete/);
    await addChecklistItemWithInternalMeta(checklistPanel);

    const results = { 'Matter checklist': [] };
    for (const vw of VIEWPORTS) {
      const m = await measureOverflow(page, vw);
      results['Matter checklist'].push(m);
      await expect(checklistPanel).toBeVisible();
    }
    logMatrix('STAFF MATTER CHECKLIST RESPONSIVE OVERFLOW', results);
    for (let i = 0; i < VIEWPORTS.length; i++) {
      expect.soft(results['Matter checklist'][i].hasHScroll, `Matter checklist @ ${VIEWPORTS[i]}px`).toBe(false);
    }

    const firstChecklistToggle = checklistPanel.locator('input[type="checkbox"]').first();
    if (await firstChecklistToggle.isVisible().catch(() => false) && await firstChecklistToggle.isEnabled().catch(() => false)) {
      await firstChecklistToggle.click();
      await expect(checklistPanel).toBeVisible();
      const afterToggle = await measureOverflow(page, 360);
      expect.soft(afterToggle.hasHScroll, 'Matter checklist after toggle @ 360px').toBe(false);
    }
  });

  test('Invoice Register mobile cards expose all 9 column labels at 360px', async ({ page }) => {
    await staffLogin(page);
    await staffNavigate(page, 'Invoices');
    await page.setViewportSize({ width: 360, height: 900 });
    await page.waitForTimeout(400);
    const firstCard = page.locator('.lf-invoice-cards tbody tr').first();
    await expect(firstCard).toBeVisible({ timeout: 15000 });
    const labels = await firstCard.evaluate((row) =>
      Array.from(row.querySelectorAll('td')).map((td) =>
        (window.getComputedStyle(td, '::before').content || '').replace(/^["']|["']$/g, '')
      )
    );
    const expected = ['Invoice', 'Client', 'Matter', 'Amount', 'Paid', 'Balance', 'Status', 'PDF', 'Actions'];
    for (const label of expected) {
      expect(labels, `Invoice Register mobile label "${label}"`).toContain(label);
    }
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

    // Create one invitation so the table renders
    await page.fill('input[type="email"]', 'ui5e-responsive-test@example.com');
    await page.click('button:has-text("Generate Invitation")');
    await page.waitForTimeout(800);

    // 360px: thead hidden, card labels visible
    await page.setViewportSize({ width: 360, height: 900 });
    await page.waitForTimeout(400);
    const firstCard = page.locator('.lf-invitation-cards tbody tr').first();
    await expect(firstCard).toBeVisible({ timeout: 15000 });
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

    // 1280px: thead visible, no card-style leak
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.waitForTimeout(400);
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
  });

  test('Client portal — no horizontal overflow at 360, 390, 768, 1280', async ({ page }) => {
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
