const { app } = require('../server');
const supertest = require('supertest');

describe('Health endpoint', () => {
  it('GET /health returns 200', async () => {
    const res = await supertest(app).get('/health');
    expect(res.status).toBe(200);
  });

  it('status is ok', async () => {
    const res = await supertest(app).get('/health');
    expect(res.body.status).toBe('ok');
  });

  it('service name is present', async () => {
    const res = await supertest(app).get('/health');
    expect(res.body.service).toBe('lexflow-api');
  });

  it('uptime is a number', async () => {
    const res = await supertest(app).get('/health');
    expect(typeof res.body.uptime).toBe('number');
    expect(res.body.uptime).toBeGreaterThanOrEqual(0);
  });

  it('timestamp is an ISO string', async () => {
    const res = await supertest(app).get('/health');
    expect(res.body.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('does not require auth', async () => {
    const res = await supertest(app).get('/health');
    expect(res.status).toBe(200);
  });

  it('does not expose secrets or env values', async () => {
    const res = await supertest(app).get('/health');
    const body = JSON.stringify(res.body);
    expect(body).not.toMatch(/secret/i);
    expect(body).not.toMatch(/key/i);
    expect(body).not.toMatch(/password/i);
    expect(body).not.toMatch(/token/i);
    expect(body).not.toMatch(/jwt/i);
  });

  it('does not expose user/client/matter/document counts', async () => {
    const res = await supertest(app).get('/health');
    const body = JSON.stringify(res.body);
    expect(body).not.toMatch(/users/i);
    expect(body).not.toMatch(/clients/i);
    expect(body).not.toMatch(/matters/i);
    expect(body).not.toMatch(/documents/i);
    expect(body).not.toMatch(/count/i);
    expect(body).not.toMatch(/total/i);
  });
});
