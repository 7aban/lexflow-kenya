const request = require('supertest');
const { app } = require('../server.js');

let adminToken;
let advocateToken;
let clientToken;
let testMatterId;
let advocateMatterId;
let clientMatterId;
let testFolderId;
let folderName;

async function findClientMatter(token) {
  const dashboardRes = await request(app)
    .get('/api/client/dashboard')
    .set('Authorization', `Bearer ${token}`);
  if (Array.isArray(dashboardRes.body?.matters) && dashboardRes.body.matters.length > 0) {
    return dashboardRes.body.matters[0].id;
  }
  const mattersRes = await request(app)
    .get('/api/matters')
    .set('Authorization', `Bearer ${token}`);
  if (Array.isArray(mattersRes.body) && mattersRes.body.length > 0) {
    return mattersRes.body[0].id;
  }
  return null;
}

beforeAll(async () => {
  const adminRes = await request(app)
    .post('/api/auth/login')
    .send({ email: 'admin@lexflow.co.ke', password: 'password123' });
  adminToken = adminRes.body.token;

  const advRes = await request(app)
    .post('/api/auth/login')
    .send({ email: 'sarah.mwangi@achokilaw.co.ke', password: 'password123' });
  advocateToken = advRes.body.token;

  const clientRes = await request(app)
    .post('/api/auth/client-login')
    .send({ email: 'margaret.wairimu@example.co.ke', password: 'password123' });
  clientToken = clientRes.body.token;

  const mattersRes = await request(app)
    .get('/api/matters')
    .set('Authorization', `Bearer ${adminToken}`);
  if (Array.isArray(mattersRes.body) && mattersRes.body.length > 0) {
    testMatterId = mattersRes.body[0].id;
  }

  advocateMatterId = await findClientMatter(advocateToken);
  clientMatterId = await findClientMatter(clientToken);
});

describe('1. Document upload accepts folderId', () => {
  test('1.1 Upload without folderId falls back to uncategorised', async () => {
    if (!testMatterId) return;
    const res = await request(app)
      .post(`/api/matters/${testMatterId}/documents`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'test-no-folder.pdf',
        mimeType: 'application/pdf',
        data: 'data:application/pdf;base64,JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCA2MTIgNzkyXSA+PgplbmRvYmoKeHJlZgowIDQKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMDA5IDAwMDAwIG4gCjAwMDAwMDAwNjUgMDAwMDAgbiAKMDAwMDAwMDEyMCAwMDAwMCBuIAp0cmFpbGVyCjw8IC9TaXplIDQgL1Jvb3QgMSAwIFIgPj4Kc3RhcnR4cmVmCjE4NgolJUVPRA==',
      });
    expect(res.statusCode).toBe(200);
    expect(res.body.folderId).toBeFalsy();
  });

  test('1.2 Create folder then upload to it', async () => {
    if (!testMatterId) return;
    folderName = `Test Folder Pilot ${Date.now()}`;
    const folderRes = await request(app)
      .post(`/api/matters/${testMatterId}/folders`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: folderName });
    expect(folderRes.statusCode).toBe(200);
    expect(folderRes.body.id).toBeDefined();
    testFolderId = folderRes.body.id;

    const res = await request(app)
      .post(`/api/matters/${testMatterId}/documents`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'test-foldered.pdf',
        mimeType: 'application/pdf',
        data: 'data:application/pdf;base64,JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCA2MTIgNzkyXSA+PgplbmRvYmoKeHJlZgowIDQKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMDA5IDAwMDAwIG4gCjAwMDAwMDAwNjUgMDAwMDAgbiAKMDAwMDAwMDEyMCAwMDAwMCBuIAp0cmFpbGVyCjw8IC9TaXplIDQgL1Jvb3QgMSAwIFIgPj4Kc3RhcnR4cmVmCjE4NgolJUVPRA==',
        folderId: testFolderId,
      });
    expect(res.statusCode).toBe(200);
    expect(res.body.folderId).toBe(testFolderId);
  });

  test('1.3 Uploaded document returns stored folderId', async () => {
    if (!testMatterId) return;
    const docsRes = await request(app)
      .get(`/api/matters/${testMatterId}/documents?folderId=${testFolderId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(docsRes.statusCode).toBe(200);
    expect(Array.isArray(docsRes.body)).toBe(true);
    const found = docsRes.body.find(d => d.folderId === testFolderId);
    expect(found).toBeDefined();
    expect(found.folderName).toBe(folderName);
  });

  test('1.4 Upload with non-existent folderId returns error', async () => {
    if (!testMatterId) return;
    const res = await request(app)
      .post(`/api/matters/${testMatterId}/documents`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'test-bad-folder.pdf',
        mimeType: 'application/pdf',
        data: 'data:application/pdf;base64,JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCA2MTIgNzkyXSA+PgplbmRvYmoKeHJlZgowIDQKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMDA5IDAwMDAwIG4gCjAwMDAwMDAwNjUgMDAwMDAgbiAKMDAwMDAwMDEyMCAwMDAwMCBuIAp0cmFpbGVyCjw8IC9TaXplIDQgL1Jvb3QgMSAwIFIgPj4Kc3RhcnR4cmVmCjE4NgolJUVPRA==',
        folderId: 'FOL-nonexistent',
      });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('Folder not found for this matter');
  });

  test('1.5 Advocate can upload with folderId', async () => {
    if (!advocateMatterId) return;
    const advFolderName = `Advocate Folder ${Date.now()}`;
    const advFolderRes = await request(app)
      .post(`/api/matters/${advocateMatterId}/folders`)
      .set('Authorization', `Bearer ${advocateToken}`)
      .send({ name: advFolderName });
    const advFolderId = advFolderRes.statusCode === 200 ? advFolderRes.body.id : testFolderId;
    if (!advFolderId) return;
    const res = await request(app)
      .post(`/api/matters/${advocateMatterId}/documents`)
      .set('Authorization', `Bearer ${advocateToken}`)
      .send({
        name: 'advocate-upload.pdf',
        mimeType: 'application/pdf',
        data: 'data:application/pdf;base64,JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCA2MTIgNzkyXSA+PgplbmRvYmoKeHJlZgowIDQKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMDA5IDAwMDAwIG4gCjAwMDAwMDAwNjUgMDAwMDAgbiAKMDAwMDAwMDEyMCAwMDAwMCBuIAp0cmFpbGVyCjw8IC9TaXplIDQgL1Jvb3QgMSAwIFIgPj4Kc3RhcnR4cmVmCjE4NgolJUVPRA==',
        folderId: advFolderId,
      });
    expect(res.statusCode).toBe(200);
    expect(res.body.folderId).toBe(advFolderId);
  });
});

describe('2. Client visibility rules unchanged for foldered documents', () => {
  test('2.1 Internal documents (clientVisible=0) hidden from client', async () => {
    if (!testMatterId) return;
    const docsRes = await request(app)
      .get(`/api/matters/${testMatterId}/documents?folderId=${testFolderId}`)
      .set('Authorization', `Bearer ${clientToken}`);
    const docs = Array.isArray(docsRes.body) ? docsRes.body : [];
    const internal = docs.filter(d => d.clientVisible === false || d.clientVisible === 0);
    expect(internal.length).toBe(0);
  });

  test('2.2 Client-uploaded document always client-visible', async () => {
    if (!clientMatterId) return;
    const res = await request(app)
      .post(`/api/matters/${clientMatterId}/documents`)
      .set('Authorization', `Bearer ${clientToken}`)
      .send({
        name: 'client-test.pdf',
        mimeType: 'application/pdf',
        data: 'data:application/pdf;base64,JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCA2MTIgNzkyXSA+PgplbmRvYmoKeHJlZgowIDQKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMDA5IDAwMDAwIG4gCjAwMDAwMDAwNjUgMDAwMDAgbiAKMDAwMDAwMDEyMCAwMDAwMCBuIAp0cmFpbGVyCjw8IC9TaXplIDQgL1Jvb3QgMSAwIFIgPj4Kc3RhcnR4cmVmCjE4NgolJUVPRA==',
      });
    expect(res.statusCode).toBe(200);
    expect(res.body.source).toBe('client');

    const docsRes = await request(app)
      .get(`/api/matters/${clientMatterId}/documents`)
      .set('Authorization', `Bearer ${clientToken}`);
    const docs = Array.isArray(docsRes.body) ? docsRes.body : [];
    const found = docs.find(d => d.id === res.body.id);
    expect(found).toBeDefined();
  });
});

describe('3. Document download access unchanged', () => {
  test('3.1 Advocate can download own matter document', async () => {
    if (!testMatterId) return;
    const docsRes = await request(app)
      .get(`/api/matters/${testMatterId}/documents`)
      .set('Authorization', `Bearer ${advocateToken}`);
    const docs = Array.isArray(docsRes.body) ? docsRes.body : [];
    if (docs.length === 0) return;
    const testDocId = docs[0].id;
    const downloadRes = await request(app)
      .get(`/api/documents/${testDocId}/download`)
      .set('Authorization', `Bearer ${advocateToken}`);
    expect(downloadRes.statusCode).toBe(200);
  });
});

describe('4. Document list/filter behavior unchanged', () => {
  test('4.1 Filter by folder returns only that folder documents', async () => {
    if (!testMatterId) return;
    const res = await request(app)
      .get(`/api/matters/${testMatterId}/documents?folderId=${testFolderId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    res.body.forEach(d => {
      expect(d.folderId).toBe(testFolderId);
    });
  });

  test('4.2 Filter uncategorised returns documents without folder', async () => {
    if (!testMatterId) return;
    const res = await request(app)
      .get(`/api/matters/${testMatterId}/documents?folderId=uncategorised`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    res.body.forEach(d => {
      expect(d.folderId === null || d.folderId === '' || d.folderId === undefined).toBe(true);
    });
  });
});

describe('5. Appearance create/update access remains unchanged', () => {
  test('5.1 Client cannot create appearance', async () => {
    const res = await request(app)
      .post('/api/appearances')
      .set('Authorization', `Bearer ${clientToken}`)
      .send({ title: 'Test Court Date', date: '2026-12-01', matterId: testMatterId });
    expect(res.statusCode).toBe(403);
  });

  test('5.2 Advocate can create appearance', async () => {
    if (!testMatterId) return;
    const res = await request(app)
      .post('/api/appearances')
      .set('Authorization', `Bearer ${advocateToken}`)
      .send({ title: 'Pilot Test Appearance', date: '2026-12-15', matterId: testMatterId });
    expect(res.statusCode === 200 || res.statusCode === 201).toBe(true);
    expect(res.body.id).toBeDefined();
  });

  test('5.3 Assistant cannot create appearance', async () => {
    const assistantRes = await request(app)
      .post('/api/auth/login')
      .send({ email: 'james.kamau@achokilaw.co.ke', password: 'password123' });
    if (assistantRes.statusCode !== 200) return;
    const assistantToken = assistantRes.body.token;
    const res = await request(app)
      .post('/api/appearances')
      .set('Authorization', `Bearer ${assistantToken}`)
      .send({ title: 'Assistant Test', date: '2026-12-20', matterId: testMatterId });
    expect(res.statusCode).toBe(403);
  });
});

describe('6. Client court-date exposure remains unchanged', () => {
  test('6.1 Client can see own appearances via client dashboard', async () => {
    const res = await request(app)
      .get('/api/client/dashboard')
      .set('Authorization', `Bearer ${clientToken}`);
    expect(res.statusCode).toBe(200);
    if (Array.isArray(res.body.appearances)) {
      res.body.appearances.forEach(appearance => {
        expect(appearance).not.toHaveProperty('outcome');
        expect(appearance).not.toHaveProperty('attendanceStatus');
        expect(appearance).not.toHaveProperty('prepItems');
      });
    }
  });

  test('6.2 Client cannot access staff appearance list', async () => {
    const res = await request(app)
      .get('/api/appearances')
      .set('Authorization', `Bearer ${clientToken}`);
    expect(res.statusCode).toBe(403);
  });
});

describe('7. Dashboard billing endpoint not broken by label fix', () => {
  test('7.1 Dashboard returns monthRevenue as number', async () => {
    const res = await request(app)
      .get('/api/dashboard')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.statusCode).toBe(200);
    expect(typeof res.body.monthRevenue).toBe('number');
  });

  test('7.2 Advocate dashboard returns monthRevenue', async () => {
    const res = await request(app)
      .get('/api/dashboard')
      .set('Authorization', `Bearer ${advocateToken}`);
    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty('monthRevenue');
    expect(typeof res.body.monthRevenue).toBe('number');
  });
});

afterAll(async () => {
  if (testFolderId) {
    await request(app)
      .delete(`/api/folders/${testFolderId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .catch(() => {});
  }
});
