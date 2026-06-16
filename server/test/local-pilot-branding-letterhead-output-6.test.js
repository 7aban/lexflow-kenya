const request = require('supertest');
const { PDFDocument, StandardFonts } = require('pdf-lib');
const { app, dbReady } = require('../server.js');

jest.setTimeout(30000);

const DEFAULT_PRIMARY = '#1A3628';
const DEFAULT_ACCENT = '#C5973C';
const DEFAULT_BACKGROUND = '#F5F2EB';
const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';
const TINY_WEBP = 'data:image/webp;base64,UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA';

async function login(pathName, email) {
  const res = await request(app)
    .post(pathName)
    .send({ email, password: 'password123' });
  expect(res.statusCode).toBe(200);
  return res.body.token;
}

function settingsPayload(settings, overrides = {}) {
  return {
    name: settings.name || 'LexFlow Kenya',
    logo: settings.logo || '',
    letterhead: settings.letterhead || '',
    primaryColor: settings.primaryColor || DEFAULT_PRIMARY,
    accentColor: settings.accentColor || DEFAULT_ACCENT,
    websiteURL: settings.websiteURL || '',
    email: settings.email || 'accounts@lexflow.co.ke',
    phone: settings.phone || '+254 700 123456',
    address: settings.address || 'Nairobi, Kenya',
    paymentInstructions: settings.paymentInstructions || '',
    kraPin: settings.kraPin || '',
    vatNumber: settings.vatNumber || '',
    invoiceFooterNote: settings.invoiceFooterNote || '',
    defaultInvoiceDueDays: settings.defaultInvoiceDueDays || 30,
    advocateBillingVisibility: settings.advocateBillingVisibility ?? 1,
    moduleSettings: settings.moduleSettings || undefined,
    ...overrides,
  };
}

async function ensureInvoice(adminToken) {
  const suffix = Date.now();
  const client = await request(app)
    .post('/api/clients')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ name: `Letterhead Test Client ${suffix}`, email: `letterhead.${suffix}@example.com` });
  expect(client.statusCode).toBe(200);
  const matter = await request(app)
    .post('/api/matters')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ clientId: client.body.id, title: `Letterhead Test Matter ${suffix}`, assignedTo: 'Sarah Mwangi' });
  expect(matter.statusCode).toBe(200);
  const invoice = await request(app)
    .post('/api/invoices/generate')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ matterId: matter.body.id, manual: true, amount: 12345, description: 'Letterhead output test' });
  expect(invoice.statusCode).toBe(200);
  return invoice.body.id;
}

async function createTestPdf(label) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([300, 420]);
  page.drawText(label, { x: 40, y: 260, size: 14, font });
  return Buffer.from(await pdf.save());
}

async function ensureReceiptPayment(adminToken, invoiceId) {
  const payment = await request(app)
    .post(`/api/invoices/${invoiceId}/payments`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ amount: 1000, method: 'M-PESA', reference: `LH-RECEIPT-${Date.now()}`, date: '2026-06-16', note: 'Letterhead receipt mode test' });
  expect(payment.statusCode).toBe(200);
  expect(payment.body.payment?.receiptNumber).toBeTruthy();
  return payment.body.payment.id;
}

async function ensureCourtBundleFixture(adminToken) {
  const suffix = Date.now();
  const client = await request(app)
    .post('/api/clients')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ name: `Letterhead Bundle Client ${suffix}`, email: `bundle.${suffix}@example.com` });
  expect(client.statusCode).toBe(200);
  const matter = await request(app)
    .post('/api/matters')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ clientId: client.body.id, title: `Letterhead Bundle Matter ${suffix}`, assignedTo: 'Sarah Mwangi' });
  expect(matter.statusCode).toBe(200);

  const documents = [];
  for (const name of ['Pleading A', 'Pleading B']) {
    const content = await createTestPdf(`${name} ${suffix}`);
    const upload = await request(app)
      .post(`/api/matters/${matter.body.id}/documents`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: `${name}.pdf`,
        displayName: `${name}.pdf`,
        mimeType: 'application/pdf',
        data: `data:application/pdf;base64,${content.toString('base64')}`,
      });
    expect(upload.statusCode).toBe(200);
    documents.push({ id: upload.body.id, content });
  }

  return { matterId: matter.body.id, documentIds: documents.map(doc => doc.id), documents };
}

async function downloadDocument(adminToken, documentId) {
  const res = await request(app)
    .get(`/api/documents/${documentId}/download`)
    .set('Authorization', `Bearer ${adminToken}`);
  expect(res.statusCode).toBe(200);
  return Buffer.from(res.body);
}

describe('LOCAL-PILOT-BRANDING-LETTERHEAD-OUTPUT-6', () => {
  let adminToken;
  let clientToken;
  let originalSettings;
  let invoiceId;
  let paymentId;
  let bundleFixture;

  beforeAll(async () => {
    await dbReady;
    adminToken = await login('/api/auth/login', 'admin@lexflow.co.ke');
    clientToken = await login('/api/auth/client-login', 'margaret.wairimu@example.co.ke');
    const settings = await request(app).get('/api/firm-settings').set('Authorization', `Bearer ${adminToken}`);
    expect(settings.statusCode).toBe(200);
    originalSettings = settings.body;
    invoiceId = await ensureInvoice(adminToken);
    paymentId = await ensureReceiptPayment(adminToken, invoiceId);
    bundleFixture = await ensureCourtBundleFixture(adminToken);
  });

  afterAll(async () => {
    if (adminToken && originalSettings) {
      await request(app)
        .put('/api/firm-settings')
        .set('Authorization', `Bearer ${adminToken}`)
        .send(settingsPayload(originalSettings));
    }
  });

  test('firm letterhead saves privately in firm settings and is not exposed publicly', async () => {
    const save = await request(app)
      .put('/api/firm-settings')
      .set('Authorization', `Bearer ${adminToken}`)
      .send(settingsPayload(originalSettings, { logo: originalSettings.logo || TINY_PNG, letterhead: TINY_PNG }));
    expect(save.statusCode).toBe(200);
    expect(save.body.letterhead).toBe(TINY_PNG);
    expect(save.body.theme.letterhead).toBe(TINY_PNG);

    const privateTheme = await request(app).get('/api/firm-settings/theme').set('Authorization', `Bearer ${adminToken}`);
    expect(privateTheme.statusCode).toBe(200);
    expect(privateTheme.body.theme.letterhead).toBe(TINY_PNG);

    const publicBranding = await request(app).get('/api/public/branding');
    expect(publicBranding.statusCode).toBe(200);
    expect(publicBranding.body).not.toHaveProperty('letterhead');
    expect(publicBranding.body.theme).not.toHaveProperty('letterhead');
  });

  test('reset colours preserves logo and letterhead while restoring forest gold cream defaults', async () => {
    await request(app)
      .put('/api/firm-settings')
      .set('Authorization', `Bearer ${adminToken}`)
      .send(settingsPayload(originalSettings, { logo: TINY_PNG, letterhead: TINY_PNG }));
    await request(app)
      .put('/api/firm-settings/theme')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ source: 'manual', primaryColor: '#28503A', accentColor: '#A97824', backgroundColor: '#FFFFFF', textColor: '#1A1A18', buttonColor: '#28503A', buttonTextColor: '#FFFFFF', sidebarColor: '#28503A', sidebarTextColor: '#FFFFFF' });

    const reset = await request(app).post('/api/firm-settings/theme/reset').set('Authorization', `Bearer ${adminToken}`);
    expect(reset.statusCode).toBe(200);
    expect(reset.body.theme.primaryColor).toBe(DEFAULT_PRIMARY);
    expect(reset.body.theme.accentColor).toBe(DEFAULT_ACCENT);
    expect(reset.body.theme.backgroundColor).toBe(DEFAULT_BACKGROUND);

    const current = await request(app).get('/api/firm-settings').set('Authorization', `Bearer ${adminToken}`);
    expect(current.statusCode).toBe(200);
    expect(current.body.logo).toBe(TINY_PNG);
    expect(current.body.letterhead).toBe(TINY_PNG);
    expect(current.body.theme.primaryColor).toBe(DEFAULT_PRIMARY);
    expect(current.body.theme.accentColor).toBe(DEFAULT_ACCENT);
  });

  test('invoice PDF accepts all branding modes without changing invoice totals', async () => {
    await request(app)
      .put('/api/firm-settings')
      .set('Authorization', `Bearer ${adminToken}`)
      .send(settingsPayload(originalSettings, { logo: TINY_PNG, letterhead: TINY_PNG }));

    const before = await request(app).get(`/api/invoices/${invoiceId}`).set('Authorization', `Bearer ${adminToken}`);
    expect(before.statusCode).toBe(200);
    const moneyBefore = {
      amount: before.body.amount,
      amountPaid: before.body.amountPaid,
      balance: before.body.balance,
      status: before.body.status,
    };

    for (const mode of ['letterhead', 'simple', 'plain']) {
      const pdf = await request(app)
        .get(`/api/invoices/${invoiceId}/pdf?brandingMode=${mode}`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(pdf.statusCode).toBe(200);
      expect(pdf.headers['content-type']).toMatch(/^application\/pdf\b/);
      if (mode === 'plain') expect(pdf.headers['x-lexflow-branding-warning']).toBeUndefined();
    }

    const after = await request(app).get(`/api/invoices/${invoiceId}`).set('Authorization', `Bearer ${adminToken}`);
    expect(after.statusCode).toBe(200);
    expect({
      amount: after.body.amount,
      amountPaid: after.body.amountPaid,
      balance: after.body.balance,
      status: after.body.status,
    }).toEqual(moneyBefore);
  });

  test('payment receipt PDF accepts all branding modes without changing payment amount or status data', async () => {
    await request(app)
      .put('/api/firm-settings')
      .set('Authorization', `Bearer ${adminToken}`)
      .send(settingsPayload(originalSettings, { logo: TINY_PNG, letterhead: TINY_PNG }));

    const beforeInvoice = await request(app).get(`/api/invoices/${invoiceId}`).set('Authorization', `Bearer ${adminToken}`);
    expect(beforeInvoice.statusCode).toBe(200);
    const beforePayments = await request(app).get(`/api/invoices/${invoiceId}/payments`).set('Authorization', `Bearer ${adminToken}`);
    expect(beforePayments.statusCode).toBe(200);
    const beforePayment = beforePayments.body.payments.find(payment => payment.id === paymentId);
    expect(beforePayment).toBeTruthy();
    const beforeData = {
      amount: beforePayment.amount,
      voided: beforePayment.voided,
      receiptNumber: beforePayment.receiptNumber,
      amountPaid: beforeInvoice.body.amountPaid,
      balance: beforeInvoice.body.balance,
      status: beforeInvoice.body.status,
    };

    for (const mode of ['letterhead', 'simple', 'plain']) {
      const pdf = await request(app)
        .get(`/api/invoices/${invoiceId}/payments/${paymentId}/receipt.pdf?brandingMode=${mode}`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(pdf.statusCode).toBe(200);
      expect(pdf.headers['content-type']).toMatch(/^application\/pdf\b/);
      if (mode === 'plain') expect(pdf.headers['x-lexflow-branding-warning']).toBeUndefined();
    }

    const afterInvoice = await request(app).get(`/api/invoices/${invoiceId}`).set('Authorization', `Bearer ${adminToken}`);
    expect(afterInvoice.statusCode).toBe(200);
    const afterPayments = await request(app).get(`/api/invoices/${invoiceId}/payments`).set('Authorization', `Bearer ${adminToken}`);
    expect(afterPayments.statusCode).toBe(200);
    const afterPayment = afterPayments.body.payments.find(payment => payment.id === paymentId);
    expect(afterPayment).toBeTruthy();
    expect({
      amount: afterPayment.amount,
      voided: afterPayment.voided,
      receiptNumber: afterPayment.receiptNumber,
      amountPaid: afterInvoice.body.amountPaid,
      balance: afterInvoice.body.balance,
      status: afterInvoice.body.status,
    }).toEqual(beforeData);
  });

  test('court bundle cover accepts branding modes without altering source PDFs', async () => {
    await request(app)
      .put('/api/firm-settings')
      .set('Authorization', `Bearer ${adminToken}`)
      .send(settingsPayload(originalSettings, { logo: TINY_PNG, letterhead: TINY_PNG }));

    const beforeSources = await Promise.all(bundleFixture.documentIds.map(id => downloadDocument(adminToken, id)));

    for (const mode of ['letterhead', 'simple', 'plain']) {
      const bundle = await request(app)
        .post('/api/document-tools/court-bundle')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          matterId: bundleFixture.matterId,
          documentIds: bundleFixture.documentIds,
          filename: `letterhead-cover-${mode}.pdf`,
          includeCover: true,
          cover: { title: 'COURT BUNDLE', court: 'HIGH COURT OF KENYA', caseNumber: `LH-${mode}`, caseTitle: 'A v B', bundleTitle: 'TEST BUNDLE', date: '16 June 2026' },
          includeIndex: true,
          includeBookmarks: true,
          includeCertificate: true,
          brandingMode: mode,
        });
      expect(bundle.statusCode).toBe(200);
      expect(bundle.headers['content-type']).toMatch(/^application\/pdf\b/);
    }

    const afterSources = await Promise.all(bundleFixture.documentIds.map(id => downloadDocument(adminToken, id)));
    expect(afterSources.map(buffer => buffer.toString('base64'))).toEqual(beforeSources.map(buffer => buffer.toString('base64')));
  });

  test('letterhead fallback warnings are returned for missing or WebP-only letterhead', async () => {
    await request(app)
      .put('/api/firm-settings')
      .set('Authorization', `Bearer ${adminToken}`)
      .send(settingsPayload(originalSettings, { logo: TINY_PNG, letterhead: '' }));

    const noLetterheadInvoice = await request(app)
      .get(`/api/invoices/${invoiceId}/pdf?brandingMode=letterhead`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(noLetterheadInvoice.statusCode).toBe(200);
    expect(noLetterheadInvoice.headers['x-lexflow-branding-warning']).toMatch(/No firm letterhead is saved/);

    await request(app)
      .put('/api/firm-settings')
      .set('Authorization', `Bearer ${adminToken}`)
      .send(settingsPayload(originalSettings, { logo: TINY_PNG, letterhead: TINY_WEBP }));

    const webpInvoice = await request(app)
      .get(`/api/invoices/${invoiceId}/pdf?brandingMode=letterhead`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(webpInvoice.statusCode).toBe(200);
    expect(webpInvoice.headers['x-lexflow-branding-warning']).toMatch(/WebP letterhead/);

    const webpReceipt = await request(app)
      .get(`/api/invoices/${invoiceId}/payments/${paymentId}/receipt.pdf?brandingMode=letterhead`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(webpReceipt.statusCode).toBe(200);
    expect(webpReceipt.headers['x-lexflow-branding-warning']).toMatch(/WebP letterhead/);

    const webpBundle = await request(app)
      .post('/api/document-tools/court-bundle')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        matterId: bundleFixture.matterId,
        documentIds: bundleFixture.documentIds,
        filename: 'letterhead-webp-fallback.pdf',
        includeCover: true,
        cover: { title: 'COURT BUNDLE' },
        brandingMode: 'letterhead',
      });
    expect(webpBundle.statusCode).toBe(200);
    expect(webpBundle.headers['x-lexflow-branding-warning']).toMatch(/WebP letterhead/);
  });

  test('private invoice PDF output remains authenticated', async () => {
    const unauthenticated = await request(app).get(`/api/invoices/${invoiceId}/pdf?brandingMode=plain`);
    expect(unauthenticated.statusCode).toBe(401);

    const unauthenticatedReceipt = await request(app).get(`/api/invoices/${invoiceId}/payments/${paymentId}/receipt.pdf?brandingMode=plain`);
    expect(unauthenticatedReceipt.statusCode).toBe(401);

    const clientInvoices = await request(app).get('/api/invoices').set('Authorization', `Bearer ${clientToken}`);
    expect(clientInvoices.statusCode).toBe(200);
  });

  test('default public branding remains forest gold cream and excludes letterhead', async () => {
    await request(app).post('/api/firm-settings/theme/reset').set('Authorization', `Bearer ${adminToken}`);
    const publicBranding = await request(app).get('/api/public/branding');
    expect(publicBranding.statusCode).toBe(200);
    expect(publicBranding.body.theme.primaryColor).toBe(DEFAULT_PRIMARY);
    expect(publicBranding.body.theme.accentColor).toBe(DEFAULT_ACCENT);
    expect(publicBranding.body.theme.backgroundColor).toBe(DEFAULT_BACKGROUND);
    expect(publicBranding.body.theme).not.toHaveProperty('letterhead');
  });
});
