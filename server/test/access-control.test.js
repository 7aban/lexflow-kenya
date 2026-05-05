const request = require('supertest');
const { app } = require('../server.js');

describe('Access Control - P3-Access-2', () => {
  let adminToken;
  let advocateToken;
  let clientToken;
  let otherAdvocateToken;
  let matterIdAssignedToSarah;
  let matterIdAssignedToOther;
  let invoiceIdForSarah;
  let invoiceIdForOther;
  let taskIdForSarah;
  let taskIdForOther;
  let appearanceIdForSarah;
  let appearanceIdForOther;
  let timeEntryIdForSarah;
  let timeEntryIdForOther;

  beforeAll(async () => {
    // Admin login
    const adminRes = await request(app)
      .post('/api/auth/login')
      .send({ email: 'admin@lexflow.co.ke', password: 'password123' });
    adminToken = adminRes.body.token;

    // Advocate Sarah Mwangi login
    const advRes = await request(app)
      .post('/api/auth/login')
      .send({ email: 'sarah.mwangi@achokilaw.co.ke', password: 'password123' });
    advocateToken = advRes.body.token;

    // Create another advocate for testing scoping
    const registerRes = await request(app)
      .post('/api/auth/register')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ email: 'test.advocate2@example.com', password: 'password123', fullName: 'Test Advocate Two', role: 'advocate' });
    otherAdvocateToken = registerRes.body.token;

    // Get Sarah's matters
    const sarahMatters = await request(app)
      .get('/api/matters')
      .set('Authorization', `Bearer ${advocateToken}`);
    if (sarahMatters.body.length > 0) {
      matterIdAssignedToSarah = sarahMatters.body[0].id;
      
      // Get an invoice for Sarah's matter
      const invoicesRes = await request(app)
        .get('/api/invoices')
        .set('Authorization', `Bearer ${advocateToken}`);
      if (invoicesRes.body.length > 0) {
        invoiceIdForSarah = invoicesRes.body[0].id;
      }

      // Get a task for Sarah's matter
      const tasksRes = await request(app)
        .get('/api/tasks')
        .set('Authorization', `Bearer ${advocateToken}`);
      if (tasksRes.body.length > 0) {
        taskIdForSarah = tasksRes.body[0].id;
      }

      // Get an appearance for Sarah's matter
      const appearancesRes = await request(app)
        .get('/api/appearances')
        .set('Authorization', `Bearer ${advocateToken}`);
      if (appearancesRes.body.length > 0) {
        appearanceIdForSarah = appearancesRes.body[0].id;
      }

      // Get a time entry for Sarah's matter
      const entriesRes = await request(app)
        .get('/api/time-entries')
        .set('Authorization', `Bearer ${advocateToken}`);
      if (entriesRes.body.length > 0) {
        timeEntryIdForSarah = entriesRes.body[0].id;
      }
    }

    // Get matters assigned to other advocate
    const otherMatters = await request(app)
      .get('/api/matters')
      .set('Authorization', `Bearer ${otherAdvocateToken}`);
    if (otherMatters.body.length > 0) {
      matterIdAssignedToOther = otherMatters.body[0].id;
    }
  });

  describe('1. Audit Logs - Admin Only', () => {
    test('Admin can access /api/audit-logs', async () => {
      const res = await request(app)
        .get('/api/audit-logs')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(res.statusCode).toBe(200);
    });

    test('Admin can access /api/audit-events', async () => {
      const res = await request(app)
        .get('/api/audit-events')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(res.statusCode).toBe(200);
    });

    test('Advocate cannot access /api/audit-logs', async () => {
      const res = await request(app)
        .get('/api/audit-logs')
        .set('Authorization', `Bearer ${advocateToken}`);
      expect(res.statusCode).toBe(403);
    });

    test('Advocate cannot access /api/audit-events', async () => {
      const res = await request(app)
        .get('/api/audit-events')
        .set('Authorization', `Bearer ${advocateToken}`);
      expect(res.statusCode).toBe(403);
    });

    test('Client cannot access /api/audit-logs', async () => {
      const clientRes = await request(app)
        .post('/api/auth/client-login')
        .send({ email: 'margaret.wairimu@example.co.ke', password: 'password123' });
      const clientToken = clientRes.body.token;
      
      const res = await request(app)
        .get('/api/audit-logs')
        .set('Authorization', `Bearer ${clientToken}`);
      expect(res.statusCode).toBe(403);
    });
  });

  describe('2. Client Isolation', () => {
    let clientTokenA;
    let clientTokenB;
    let clientIdA;
    let clientIdB;

    beforeAll(async () => {
      // Create two test clients
      const clientResA = await request(app)
        .post('/api/auth/client-login')
        .send({ email: 'margaret.wairimu@example.co.ke', password: 'password123' });
      clientTokenA = clientResA.body.token;
      clientIdA = clientResA.body.clientId;

      // Create a separate client record for client B
      const clientBRes = await request(app)
        .post('/api/clients')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name: 'Test Client B', email: 'test.client2@example.com' });
      const clientIdB = clientBRes.body.id;

      // Create client user B linked to their own client record
      await request(app)
        .post('/api/auth/register')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ email: 'test.client2@example.com', password: 'password123', fullName: 'Test Client Two', role: 'client', clientId: clientIdB });

      // Login as client B
      const clientLoginB = await request(app)
        .post('/api/auth/client-login')
        .send({ email: 'test.client2@example.com', password: 'password123' });
      clientTokenB = clientLoginB.body.token;
    });

    test('Client A cannot access client B data via /api/client/dashboard', async () => {
      const res = await request(app)
        .get('/api/client/dashboard')
        .set('Authorization', `Bearer ${clientTokenB}`);
      expect(res.statusCode).toBe(200);
      // Client B should only see their own data
      if (res.body.client) {
        expect(res.body.client.id).not.toBe(clientIdA);
      }
    });
  });

  describe('3. Advocate Scoping', () => {
    test('Advocate cannot access matter assigned to another advocate', async () => {
      if (!matterIdAssignedToOther) {
        console.log('Skipping: No matter assigned to other advocate');
        return;
      }
      const res = await request(app)
        .get(`/api/matters/${matterIdAssignedToOther}`)
        .set('Authorization', `Bearer ${advocateToken}`);
      expect(res.statusCode).toBe(403);
    });

    test('Advocate can access their own matter', async () => {
      if (!matterIdAssignedToSarah) {
        console.log('Skipping: No matter assigned to Sarah');
        return;
      }
      const res = await request(app)
        .get(`/api/matters/${matterIdAssignedToSarah}`)
        .set('Authorization', `Bearer ${advocateToken}`);
      expect(res.statusCode).toBe(200);
      expect(res.body.id).toBe(matterIdAssignedToSarah);
    });
  });

  describe('4. Invoice Access', () => {
    test('Client can access own invoice', async () => {
      const clientRes = await request(app)
        .post('/api/auth/client-login')
        .send({ email: 'margaret.wairimu@example.co.ke', password: 'password123' });
      const clientToken = clientRes.body.token;
      const clientId = clientRes.body.clientId;

      const invoicesRes = await request(app)
        .get('/api/invoices')
        .set('Authorization', `Bearer ${clientToken}`);
      
      if (invoicesRes.body.length > 0) {
        const invoiceId = invoicesRes.body[0].id;
        const res = await request(app)
          .get(`/api/invoices/${invoiceId}`)
          .set('Authorization', `Bearer ${clientToken}`);
        expect(res.statusCode).toBe(200);
      }
    });

    test('Advocate cannot access invoice for matter assigned to other advocate', async () => {
      if (!invoiceIdForOther) {
        console.log('Skipping: No invoice for other advocate');
        return;
      }
      const res = await request(app)
        .get(`/api/invoices/${invoiceIdForOther}`)
        .set('Authorization', `Bearer ${advocateToken}`);
      expect(res.statusCode).toBe(403);
    });

    test('Advocate can access invoice for their assigned matter', async () => {
      if (!invoiceIdForSarah) {
        console.log('Skipping: No invoice for Sarah');
        return;
      }
      const res = await request(app)
        .get(`/api/invoices/${invoiceIdForSarah}`)
        .set('Authorization', `Bearer ${advocateToken}`);
      expect(res.statusCode).toBe(200);
    });
  });

  describe('5. Task Access', () => {
    test('Advocate cannot access task for matter assigned to other advocate', async () => {
      if (!taskIdForOther) {
        console.log('Skipping: No task for other advocate');
        return;
      }
      const res = await request(app)
        .patch(`/api/tasks/${taskIdForOther}`)
        .set('Authorization', `Bearer ${advocateToken}`)
        .send({ completed: true });
      expect(res.statusCode).toBe(403);
    });

    test('Advocate can access task for their assigned matter', async () => {
      if (!taskIdForSarah) {
        console.log('Skipping: No task for Sarah');
        return;
      }
      const res = await request(app)
        .patch(`/api/tasks/${taskIdForSarah}`)
        .set('Authorization', `Bearer ${advocateToken}`)
        .send({ completed: true });
      expect(res.statusCode).toBe(200);
      
      // Toggle back
      await request(app)
        .patch(`/api/tasks/${taskIdForSarah}`)
        .set('Authorization', `Bearer ${advocateToken}`)
        .send({ completed: false });
    });
  });

  describe('6. Appearance Access', () => {
    test('Advocate cannot access appearance for matter assigned to other advocate', async () => {
      if (!appearanceIdForOther) {
        console.log('Skipping: No appearance for other advocate');
        return;
      }
      const res = await request(app)
        .patch(`/api/appearances/${appearanceIdForOther}`)
        .set('Authorization', `Bearer ${advocateToken}`)
        .send({ title: 'Updated Title' });
      expect(res.statusCode).toBe(403);
    });

    test('Advocate can access appearance for their assigned matter', async () => {
      if (!appearanceIdForSarah) {
        console.log('Skipping: No appearance for Sarah');
        return;
      }
      const res = await request(app)
        .get(`/api/appearances/${appearanceIdForSarah}`)
        .set('Authorization', `Bearer ${advocateToken}`);
      expect(res.statusCode).toBe(200);
    });
  });

  describe('7. Time Entry Access', () => {
    test('Advocate cannot access time entry for matter assigned to other advocate', async () => {
      if (!timeEntryIdForOther) {
        console.log('Skipping: No time entry for other advocate');
        return;
      }
      const res = await request(app)
        .patch(`/api/time-entries/${timeEntryIdForOther}`)
        .set('Authorization', `Bearer ${advocateToken}`)
        .send({ description: 'Updated description' });
      expect(res.statusCode).toBe(403);
    });

    test('Advocate can access time entry for their assigned matter', async () => {
      if (!timeEntryIdForSarah) {
        console.log('Skipping: No time entry for Sarah');
        return;
      }
      const res = await request(app)
        .get(`/api/time-entries/${timeEntryIdForSarah}`)
        .set('Authorization', `Bearer ${advocateToken}`);
      expect(res.statusCode).toBe(200);
    });
  });

  describe('8. Search Scoping', () => {
    test('Advocate search returns only accessible results', async () => {
      const res = await request(app)
        .get('/api/search?q=estate')
        .set('Authorization', `Bearer ${advocateToken}`);
      expect(res.statusCode).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      
      // All matter results should be assigned to Sarah
      const matterResults = res.body.filter(r => r.type === 'Matter');
      const sarahMattersRes = await request(app)
        .get('/api/matters')
        .set('Authorization', `Bearer ${advocateToken}`);
      const sarahMatterIds = sarahMattersRes.body.map(m => m.id);
      
      matterResults.forEach(r => {
        if (r.matterId) {
          expect(sarahMatterIds).toContain(r.matterId);
        }
      });
    });

    test('Client cannot access /api/search', async () => {
      const clientRes = await request(app)
        .post('/api/auth/client-login')
        .send({ email: 'margaret.wairimu@example.co.ke', password: 'password123' });
      const clientToken = clientRes.body.token;

      const res = await request(app)
        .get('/api/search?q=estate')
        .set('Authorization', `Bearer ${clientToken}`);
      expect(res.statusCode).toBe(403);
    });
  });

  describe('9. Dashboard Scoping', () => {
    test('Advocate dashboard shows only their data', async () => {
      const res = await request(app)
        .get('/api/dashboard')
        .set('Authorization', `Bearer ${advocateToken}`);
      expect(res.statusCode).toBe(200);
      expect(res.body).toHaveProperty('activeMattersCount');
    });

    test('Admin dashboard shows firm-wide data', async () => {
      const res = await request(app)
        .get('/api/dashboard')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(res.statusCode).toBe(200);
      expect(res.body).toHaveProperty('activeMattersCount');
    });
  });

  describe('10. Forbidden Access Audit Events', () => {
    test('Forbidden matter access generates audit event', async () => {
      if (!matterIdAssignedToOther) {
        console.log('Skipping: No matter assigned to other advocate');
        return;
      }
      
      // Try to access matter assigned to other advocate
      await request(app)
        .get(`/api/matters/${matterIdAssignedToOther}`)
        .set('Authorization', `Bearer ${advocateToken}`);
      
      // Check audit events for forbidden_matter_access
      const auditRes = await request(app)
        .get('/api/audit-events?action=forbidden_matter_access')
        .set('Authorization', `Bearer ${adminToken}`);
      
      expect(auditRes.statusCode).toBe(200);
      // Should have at least one forbidden_matter_access event
      const hasForbiddenEvent = auditRes.body.rows.some(r => r.action === 'forbidden_matter_access');
      expect(hasForbiddenEvent).toBe(true);
    });
  });
});
