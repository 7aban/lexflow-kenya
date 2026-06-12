// LOCAL-PILOT-FIX-15 — Tasks workflow redesign (frontend-only phase).
// The backend task routes are intentionally UNCHANGED; this suite is a regression
// net pinning the existing behaviour the redesigned UI depends on:
// staff create (matter-linked, optional dueDate/assignee), list, mark done,
// reopen, matter linkage stability, and role access (client blocked everywhere,
// assistant create-only, advocate/admin modify/delete).
const request = require('supertest');
const { app, dbReady } = require('../server.js');

describe('LOCAL-PILOT-FIX-15 - Tasks workflow regression', () => {
  let adminToken;
  let clientToken;
  let assistantToken;
  let matterId;
  let taskId;
  let assistantTaskId;

  beforeAll(async () => {
    await dbReady;
    const adminRes = await request(app)
      .post('/api/auth/login')
      .send({ email: 'admin@lexflow.co.ke', password: 'password123' });
    adminToken = adminRes.body.token;
    expect(adminToken).toBeTruthy();

    // Client accounts must use the dedicated portal login route.
    const clientRes = await request(app)
      .post('/api/auth/client-login')
      .send({ email: 'margaret.wairimu@example.co.ke', password: 'password123' });
    clientToken = clientRes.body.token;
    expect(clientToken).toBeTruthy();

    const assistantRes = await request(app)
      .post('/api/auth/login')
      .send({ email: 'david.wanjiku@achokilaw.co.ke', password: 'password123' });
    assistantToken = assistantRes.body.token;
    expect(assistantToken).toBeTruthy();

    const matters = await request(app)
      .get('/api/matters')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(Array.isArray(matters.body)).toBe(true);
    expect(matters.body.length).toBeGreaterThan(0);
    matterId = matters.body[0].id;
  });

  afterAll(async () => {
    for (const id of [taskId, assistantTaskId]) {
      if (id) {
        await request(app)
          .delete(`/api/tasks/${id}`)
          .set('Authorization', `Bearer ${adminToken}`);
      }
    }
  });

  test('staff can create a matter-linked task with optional dueDate and assignee', async () => {
    const res = await request(app)
      .post('/api/tasks')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ matterId, title: 'FIX-15 draft witness statement', dueDate: '2026-07-01', assignee: 'Sarah Mwangi' });
    expect(res.status).toBe(200);
    expect(res.body.id).toBeTruthy();
    expect(res.body.matterId).toBe(matterId);
    expect(res.body.title).toBe('FIX-15 draft witness statement');
    expect(res.body.dueDate).toBe('2026-07-01');
    expect(res.body.assignee).toBe('Sarah Mwangi');
    expect(Number(res.body.completed)).toBe(0);
    taskId = res.body.id;
  });

  test('created task appears in the staff task list', async () => {
    const res = await request(app)
      .get('/api/tasks')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const found = res.body.find(task => task.id === taskId);
    expect(found).toBeTruthy();
    expect(found.matterId).toBe(matterId);
  });

  test('task creation works without dueDate or assignee (UI optional fields)', async () => {
    const res = await request(app)
      .post('/api/tasks')
      .set('Authorization', `Bearer ${assistantToken}`)
      .send({ matterId, title: 'FIX-15 assistant minimal task' });
    expect(res.status).toBe(200);
    expect(res.body.matterId).toBe(matterId);
    expect(res.body.dueDate).toBe('');
    expect(res.body.assignee).toBe('');
    assistantTaskId = res.body.id;
  });

  test('task can be marked done', async () => {
    const res = await request(app)
      .patch(`/api/tasks/${taskId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ completed: true });
    expect(res.status).toBe(200);
    expect(Number(res.body.completed)).toBe(1);
  });

  test('task can be reopened', async () => {
    const res = await request(app)
      .patch(`/api/tasks/${taskId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ completed: false });
    expect(res.status).toBe(200);
    expect(Number(res.body.completed)).toBe(0);
  });

  test('task stays tied to its matter through edits', async () => {
    const res = await request(app)
      .patch(`/api/tasks/${taskId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ title: 'FIX-15 draft witness statement (revised)', dueDate: '2026-07-08' });
    expect(res.status).toBe(200);
    expect(res.body.matterId).toBe(matterId);
    expect(res.body.title).toBe('FIX-15 draft witness statement (revised)');
  });

  test('client role cannot access any task route', async () => {
    const list = await request(app)
      .get('/api/tasks')
      .set('Authorization', `Bearer ${clientToken}`);
    expect(list.status).toBe(403);

    const create = await request(app)
      .post('/api/tasks')
      .set('Authorization', `Bearer ${clientToken}`)
      .send({ matterId, title: 'client should not create this' });
    expect(create.status).toBe(403);

    const patch = await request(app)
      .patch(`/api/tasks/${taskId}`)
      .set('Authorization', `Bearer ${clientToken}`)
      .send({ completed: true });
    expect(patch.status).toBe(403);

    const del = await request(app)
      .delete(`/api/tasks/${taskId}`)
      .set('Authorization', `Bearer ${clientToken}`);
    expect(del.status).toBe(403);
  });

  test('assistant can create but cannot modify or delete tasks', async () => {
    const patch = await request(app)
      .patch(`/api/tasks/${taskId}`)
      .set('Authorization', `Bearer ${assistantToken}`)
      .send({ completed: true });
    expect(patch.status).toBe(403);

    const del = await request(app)
      .delete(`/api/tasks/${taskId}`)
      .set('Authorization', `Bearer ${assistantToken}`);
    expect(del.status).toBe(403);
  });

  test('admin can delete a task and it leaves the list', async () => {
    const res = await request(app)
      .delete(`/api/tasks/${taskId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(true);

    const list = await request(app)
      .get('/api/tasks')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(list.body.find(task => task.id === taskId)).toBeFalsy();
    taskId = null;
  });
});
