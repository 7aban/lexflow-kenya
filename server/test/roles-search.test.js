const request = require('supertest');
const { app } = require('../server.js');

describe('Role and Search Scoping', () => {
  let advocateToken;
  let adminToken;
  let clientToken;

  // Get tokens before tests
  beforeAll(async () => {
    // Advocate login
    const advRes = await request(app)
      .post('/api/auth/login')
      .send({ email: 'sarah.mwangi@achokilaw.co.ke', password: 'password123' });
    advocateToken = advRes.body.token;

    // Admin login
    const adminRes = await request(app)
      .post('/api/auth/login')
      .send({ email: 'admin@lexflow.co.ke', password: 'password123' });
    adminToken = adminRes.body.token;

    // Client login (use first seeded client)
    const clientRes = await request(app)
      .post('/api/auth/client-login')
      .send({ email: 'margaret.wairimu@example.co.ke', password: 'password123' });
    clientToken = clientRes.body.token;
  });

  test('A. Advocate login succeeds', () => {
    expect(advocateToken).toBeDefined();
    // Verify by making an authenticated request
    return request(app)
      .get('/api/matters')
      .set('Authorization', `Bearer ${advocateToken}`)
      .expect(200);
  });

  test('B. Advocate GET /api/matters returns only assigned matters', async () => {
    const res = await request(app)
      .get('/api/matters')
      .set('Authorization', `Bearer ${advocateToken}`);
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
    // All matters should be assigned to Sarah Mwangi
    res.body.forEach(matter => {
      expect(matter.assignedTo).toBe('Sarah Mwangi');
    });
  });

  test('C. Admin GET /api/matters returns broader matter list', async () => {
    const res = await request(app)
      .get('/api/matters')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    // Admin should see more matters than Sarah
    const adminCount = res.body.length;
    
    const advRes = await request(app)
      .get('/api/matters')
      .set('Authorization', `Bearer ${advocateToken}`);
    const advCount = advRes.body.length;
    
    expect(adminCount).toBeGreaterThan(advCount);
  });

  test('D. Client token cannot access /api/search', async () => {
    const res = await request(app)
      .get('/api/search?q=estate')
      .set('Authorization', `Bearer ${clientToken}`);
    expect(res.statusCode).toBe(403);
  });

  test('E. Advocate GET /api/search is accessible and scoped', async () => {
    const res = await request(app)
      .get('/api/search?q=estate')
      .set('Authorization', `Bearer ${advocateToken}`);
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    
    // Get Sarah's matters for comparison
    const mattersRes = await request(app)
      .get('/api/matters')
      .set('Authorization', `Bearer ${advocateToken}`);
    const sarahMatterIds = mattersRes.body.map(m => m.id);
    
    // Check that Matter results are within Sarah's assigned matters
    const matterResults = res.body.filter(r => r.type === 'Matter');
    matterResults.forEach(r => {
      if (r.matterId) {
        expect(sarahMatterIds).toContain(r.matterId);
      }
    });
  });
});
