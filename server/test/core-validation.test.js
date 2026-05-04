const request = require('supertest');
const { app } = require('../server.js');

let adminToken;
let clientToken;

beforeAll(async () => {
  const adminRes = await request(app)
    .post('/api/auth/login')
    .send({ email: 'admin@lexflow.co.ke', password: 'password123' });
  adminToken = adminRes.body.token;

  const clientRes = await request(app)
    .post('/api/auth/client-login')
    .send({ email: 'margaret.wairimu@example.co.ke', password: 'password123' });
  clientToken = clientRes.body.token;
});

describe('Client validation', () => {
  test('missing name returns 400', async () => {
    const res = await request(app)
      .post('/api/clients')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ type: 'Individual' });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('Client name is required');
  });

  test('no token returns 401', async () => {
    const res = await request(app)
      .post('/api/clients')
      .send({ name: 'Test Client' });
    expect(res.statusCode).toBe(401);
  });
});

describe('Client auth gate', () => {
  test('client token returns 403', async () => {
    const res = await request(app)
      .post('/api/clients')
      .set('Authorization', `Bearer ${clientToken}`)
      .send({ name: 'Should Not Create' });
    expect(res.statusCode).toBe(403);
  });
});

describe('Matter validation', () => {
  test('missing clientId returns 400', async () => {
    const res = await request(app)
      .post('/api/matters')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ title: 'Test Matter' });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('Client is required');
  });

  test('missing title returns 400', async () => {
    const res = await request(app)
      .post('/api/matters')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ clientId: 'CL-001' });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('Matter title is required');
  });

  test('both clientId and title missing returns 400', async () => {
    const res = await request(app)
      .post('/api/matters')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('Client is required');
  });

  test('no token returns 401', async () => {
    const res = await request(app)
      .post('/api/matters')
      .send({ clientId: 'CL-001', title: 'Test Matter' });
    expect(res.statusCode).toBe(401);
  });
});

describe('Matter auth gate', () => {
  test('client token returns 403', async () => {
    const res = await request(app)
      .post('/api/matters')
      .set('Authorization', `Bearer ${clientToken}`)
      .send({ clientId: 'CL-001', title: 'Should Not Create' });
    expect(res.statusCode).toBe(403);
  });
});

describe('Invoice generation validation', () => {
  test('missing matterId returns 400', async () => {
    const res = await request(app)
      .post('/api/invoices/generate')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('Matter ID is required');
  });

  test('no token returns 401', async () => {
    const res = await request(app)
      .post('/api/invoices/generate')
      .send({ matterId: 'M-001' });
    expect(res.statusCode).toBe(401);
  });
});
