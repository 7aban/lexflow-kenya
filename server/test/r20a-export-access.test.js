const request = require('supertest');
const sqlite3 = require('sqlite3');
const config = require('../lib/config');
const { app, dbReady } = require('../server.js');

function parseText(res, callback) {
  res.setEncoding('utf8');
  let data = '';
  res.on('data', chunk => { data += chunk; });
  res.on('end', () => callback(null, data));
}

function exportBody(res) {
  return typeof res.body === 'string' ? res.body : res.text || '';
}

function dbGet(sql, params = []) {
  const db = new sqlite3.Database(config.DATABASE_PATH);
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      db.close();
      err ? reject(err) : resolve(row);
    });
  });
}

describe('SECURITY-1A/1D export access and audit actor hardening', () => {
  let adminToken;
  let adminUserId;
  let advocateToken;
  let clientToken;
  let sarahMatterId;
  let michaelMatterId;
  let sarahInvoice;
  let michaelInvoice;

  const suffix = Date.now();
  const sarahMatterTitle = `R20a Sarah Export Matter ${suffix}`;
  const michaelMatterTitle = `R20a Michael Export Matter ${suffix}`;
  const sarahClientName = `R20a Sarah Client ${suffix}`;
  const michaelClientName = `R20a Michael Client ${suffix}`;
  const sarahAmount = 876543;
  const michaelAmount = 765432;

  async function getXls(path, token) {
    return request(app)
      .get(path)
      .set('Authorization', `Bearer ${token}`)
      .buffer(true)
      .parse(parseText);
  }

  async function createClient(name, email) {
    const res = await request(app)
      .post('/api/clients')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name, email });
    expect(res.statusCode).toBe(200);
    return res.body.id;
  }

  async function createMatter(clientId, title, assignedTo, billingRate) {
    const res = await request(app)
      .post('/api/matters')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        clientId,
        title,
        assignedTo,
        billingType: 'hourly',
        billingRate,
      });
    expect(res.statusCode).toBe(200);
    return res.body.id;
  }

  async function createInvoice(matterId, attorney, amount, marker) {
    const timeRes = await request(app)
      .post('/api/time-entries')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        matterId,
        attorney,
        date: '2026-05-10',
        hours: 1,
        activity: 'Export access test',
        description: marker,
        rate: amount,
      });
    expect(timeRes.statusCode).toBe(200);

    const invoiceRes = await request(app)
      .post('/api/invoices/generate')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ matterId });
    expect(invoiceRes.statusCode).toBe(200);
    expect(Number(invoiceRes.body.amount)).toBe(amount);
    return invoiceRes.body;
  }

  beforeAll(async () => {
    await dbReady;

    const adminRes = await request(app)
      .post('/api/auth/login')
      .send({ email: 'admin@lexflow.co.ke', password: 'password123' });
    expect(adminRes.statusCode).toBe(200);
    adminToken = adminRes.body.token;
    adminUserId = adminRes.body.user.id;

    const advocateRes = await request(app)
      .post('/api/auth/login')
      .send({ email: 'sarah.mwangi@achokilaw.co.ke', password: 'password123' });
    expect(advocateRes.statusCode).toBe(200);
    advocateToken = advocateRes.body.token;

    const clientRes = await request(app)
      .post('/api/auth/client-login')
      .send({ email: 'margaret.wairimu@example.co.ke', password: 'password123' });
    expect(clientRes.statusCode).toBe(200);
    clientToken = clientRes.body.token;

    await request(app)
      .put('/api/firm-settings')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ advocateBillingVisibility: 1 });

    const sarahClientId = await createClient(sarahClientName, `r20a.sarah.${suffix}@example.com`);
    const michaelClientId = await createClient(michaelClientName, `r20a.michael.${suffix}@example.com`);
    sarahMatterId = await createMatter(sarahClientId, sarahMatterTitle, 'Sarah Mwangi', sarahAmount);
    michaelMatterId = await createMatter(michaelClientId, michaelMatterTitle, 'Michael Oduor', michaelAmount);
    sarahInvoice = await createInvoice(sarahMatterId, 'Sarah Mwangi', sarahAmount, `R20a Sarah export time ${suffix}`);
    michaelInvoice = await createInvoice(michaelMatterId, 'Michael Oduor', michaelAmount, `R20a Michael export time ${suffix}`);
  });

  afterAll(async () => {
    if (!adminToken) return;
    await request(app)
      .put('/api/firm-settings')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ advocateBillingVisibility: 1 });
  });

  test('admin can still export itax successfully', async () => {
    const res = await getXls('/api/exports/itax.xls', adminToken);
    const body = exportBody(res);

    expect(res.statusCode).toBe(200);
    expect(body).toContain(sarahInvoice.number);
    expect(body).toContain(String(sarahAmount));
    expect(body).toContain(michaelInvoice.number);
  });

  test('admin can still export matters successfully', async () => {
    const res = await getXls('/api/exports/matters.xls', adminToken);
    const body = exportBody(res);

    expect(res.statusCode).toBe(200);
    expect(body).toContain(sarahMatterTitle);
    expect(body).toContain(String(sarahAmount));
    expect(body).toContain(michaelMatterTitle);
  });

  test('invalid export type returns 400', async () => {
    const res = await request(app)
      .get('/api/exports/payroll.xls')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid export type' });
  });

  test('client cannot access export route', async () => {
    const res = await request(app)
      .get('/api/exports/itax.xls')
      .set('Authorization', `Bearer ${clientToken}`);

    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: 'Staff access required' });
  });

  test('billing-hidden advocate cannot extract firm-wide invoice amounts through itax', async () => {
    await request(app)
      .put('/api/firm-settings')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ advocateBillingVisibility: 0 });

    const res = await getXls('/api/exports/itax.xls', advocateToken);
    const body = exportBody(res);

    expect(res.statusCode).toBe(200);
    expect(body).toContain(sarahInvoice.number);
    expect(body).not.toContain(String(sarahAmount));
    expect(body).not.toContain(michaelInvoice.number);
    expect(body).not.toContain(String(michaelAmount));
  });

  test('billing-hidden advocate cannot extract matter billing totals through matters', async () => {
    await request(app)
      .put('/api/firm-settings')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ advocateBillingVisibility: 0 });

    const res = await getXls('/api/exports/matters.xls', advocateToken);
    const body = exportBody(res);

    expect(res.statusCode).toBe(200);
    expect(body).toContain(sarahMatterTitle);
    expect(body).not.toContain(String(sarahAmount));
    expect(body).not.toContain(michaelMatterTitle);
    expect(body).not.toContain(String(michaelAmount));
  });

  test('advocate export is assignment-scoped and excludes other advocates matters and invoices', async () => {
    await request(app)
      .put('/api/firm-settings')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ advocateBillingVisibility: 1 });

    const itaxRes = await getXls('/api/exports/itax.xls', advocateToken);
    const itaxBody = exportBody(itaxRes);
    expect(itaxRes.statusCode).toBe(200);
    expect(itaxBody).toContain(sarahInvoice.number);
    expect(itaxBody).toContain(String(sarahAmount));
    expect(itaxBody).not.toContain(michaelInvoice.number);
    expect(itaxBody).not.toContain(michaelClientName);

    const mattersRes = await getXls('/api/exports/matters.xls', advocateToken);
    const mattersBody = exportBody(mattersRes);
    expect(mattersRes.statusCode).toBe(200);
    expect(mattersBody).toContain(sarahMatterTitle);
    expect(mattersBody).toContain(String(sarahAmount));
    expect(mattersBody).not.toContain(michaelMatterTitle);
    expect(mattersBody).not.toContain(michaelClientName);
  });

  test('authenticated audit action records actor_user_id from req.user.userId', async () => {
    const res = await request(app)
      .put('/api/firm-settings')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ advocateBillingVisibility: 1 });
    expect(res.statusCode).toBe(200);

    const event = await dbGet(
      "SELECT actor_user_id FROM audit_events WHERE action='firm_settings_updated' AND actor_email='admin@lexflow.co.ke' ORDER BY rowid DESC LIMIT 1",
    );
    expect(event).toBeDefined();
    expect(event.actor_user_id).toBe(adminUserId);
  });
});
