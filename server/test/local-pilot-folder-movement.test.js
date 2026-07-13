'use strict';

const request = require('supertest');
const sqlite3 = require('sqlite3');
const config = require('../lib/config');
const { app, dbReady } = require('../server.js');

jest.setTimeout(60000);

const auth = token => ({ Authorization: `Bearer ${token}` });

function withDb(operation) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(config.DATABASE_PATH);
    operation(db, (error, result) => {
      db.close(closeError => (error || closeError) ? reject(error || closeError) : resolve(result));
    });
  });
}

function dbRun(sql, params = []) {
  return withDb((db, done) => db.run(sql, params, error => done(error)));
}

function dbGet(sql, params = []) {
  return withDb((db, done) => db.get(sql, params, (error, row) => done(error, row)));
}

function dbAll(sql, params = []) {
  return withDb((db, done) => db.all(sql, params, (error, rows) => done(error, rows)));
}

describe('LOCAL-PILOT-FOLDER-MOVEMENT-90', () => {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  let adminToken;
  let assignedAdvocateToken;
  let unassignedAdvocateToken;
  let assistantToken;
  let clientToken;
  let clientId;
  let accessibleMatterId;
  let inaccessibleMatterId;

  async function login(email, password = 'password123', route = '/api/auth/login') {
    const response = await request(app).post(route).send({ email, password });
    expect(response.statusCode).toBe(200);
    return response.body.token;
  }

  async function insertFolder({
    id,
    matterId = accessibleMatterId,
    name,
    parentId = null,
    archivedAt = null,
  }) {
    await dbRun(
      'INSERT INTO folders (id,matterId,name,createdBy,createdAt,archivedAt,parentId) VALUES (?,?,?,?,?,?,?)',
      [id, matterId, name, 'folder-move-test', '2026-07-13T08:00:00.000Z', archivedAt, parentId],
    );
    return { id, matterId, name, parentId, archivedAt };
  }

  async function insertDocument({ id, folderId, matterId = accessibleMatterId }) {
    await dbRun(
      `INSERT INTO documents (id,matterId,name,displayName,mimeType,source,folderId,deletedAt,clientVisible)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [id, matterId, `${id}.pdf`, `${id}.pdf`, 'application/pdf', 'firm', folderId, null, 0],
    );
  }

  function moveFolder(folderId, parentId, token = adminToken) {
    return request(app)
      .patch(`/api/folders/${folderId}/move`)
      .set(auth(token))
      .send({ parentId });
  }

  async function auditBoundary() {
    return (await dbGet('SELECT COALESCE(MAX(rowid),0) rowid FROM audit_events')).rowid;
  }

  function movedEventsSince(rowid) {
    return dbAll(
      `SELECT rowid,action,entity_type,entity_id,matter_id,actor_role,metadata_json
       FROM audit_events WHERE rowid>? AND action='folder_moved' ORDER BY rowid`,
      [rowid],
    );
  }

  beforeAll(async () => {
    await dbReady;
    adminToken = await login('admin@lexflow.co.ke');
    assignedAdvocateToken = await login('sarah.mwangi@achokilaw.co.ke');
    unassignedAdvocateToken = await login('michael.oduor@achokilaw.co.ke');
    assistantToken = await login('david.wanjiku@achokilaw.co.ke');

    const clientEmail = `folder.move.${suffix}@example.com`;
    const client = await request(app)
      .post('/api/clients')
      .set(auth(adminToken))
      .send({ name: `Folder Move Client ${suffix}`, email: clientEmail });
    expect(client.statusCode).toBe(200);
    clientId = client.body.id;

    const registration = await request(app)
      .post('/api/auth/register')
      .set(auth(adminToken))
      .send({
        email: clientEmail,
        password: 'FolderMovement!90',
        fullName: `Folder Move Client ${suffix}`,
        role: 'client',
        clientId,
      });
    expect(registration.statusCode).toBe(200);
    clientToken = await login(clientEmail, 'FolderMovement!90', '/api/auth/client-login');

    const accessibleMatter = await request(app)
      .post('/api/matters')
      .set(auth(adminToken))
      .send({ clientId, title: `Folder Move Accessible ${suffix}`, assignedTo: 'Sarah Mwangi' });
    expect(accessibleMatter.statusCode).toBe(200);
    accessibleMatterId = accessibleMatter.body.id;

    const inaccessibleMatter = await request(app)
      .post('/api/matters')
      .set(auth(adminToken))
      .send({ clientId, title: `Folder Move Inaccessible ${suffix}`, assignedTo: 'Michael Oduor' });
    expect(inaccessibleMatter.statusCode).toBe(200);
    inaccessibleMatterId = inaccessibleMatter.body.id;
  });

  test('root-to-child, child-to-root, and branch-to-branch moves update one folder row and emit exact events', async () => {
    const rootId = `FOL-MOVE-ROOT-${suffix}`;
    const childId = `FOL-MOVE-CHILD-${suffix}`;
    const grandchildId = `FOL-MOVE-GRANDCHILD-${suffix}`;
    const destinationId = `FOL-MOVE-DESTINATION-${suffix}`;
    const otherBranchId = `FOL-MOVE-OTHER-BRANCH-${suffix}`;

    await insertFolder({ id: rootId, name: `Move Root ${suffix}` });
    await insertFolder({ id: childId, name: `Move Child ${suffix}`, parentId: rootId });
    await insertFolder({ id: grandchildId, name: `Move Grandchild ${suffix}`, parentId: childId });
    await insertFolder({ id: destinationId, name: `Destination ${suffix}` });
    await insertFolder({ id: otherBranchId, name: `Other Branch ${suffix}` });
    await insertDocument({ id: `DOC-MOVE-ROOT-${suffix}`, folderId: rootId });
    await insertDocument({ id: `DOC-MOVE-CHILD-${suffix}`, folderId: childId });
    await insertDocument({ id: `DOC-MOVE-GRANDCHILD-${suffix}`, folderId: grandchildId });

    const documentIds = [
      `DOC-MOVE-ROOT-${suffix}`,
      `DOC-MOVE-CHILD-${suffix}`,
      `DOC-MOVE-GRANDCHILD-${suffix}`,
    ];
    const documentsBefore = await dbAll(
      `SELECT id,matterId,folderId,deletedAt,clientVisible FROM documents
       WHERE id IN (${documentIds.map(() => '?').join(',')}) ORDER BY id`,
      documentIds,
    );
    const descendantsBefore = await dbAll(
      'SELECT id,parentId FROM folders WHERE id IN (?,?) ORDER BY id',
      [childId, grandchildId],
    );

    let boundary = await auditBoundary();
    const rootToChild = await moveFolder(rootId, destinationId);
    expect(rootToChild.statusCode).toBe(200);
    expect(Object.keys(rootToChild.body).sort()).toEqual(['createdAt', 'createdBy', 'id', 'matterId', 'name', 'parentId']);
    expect(rootToChild.body.parentId).toBe(destinationId);
    let events = await movedEventsSince(boundary);
    expect(events).toHaveLength(1);
    expect([events[0].action, events[0].entity_type, events[0].entity_id, events[0].matter_id]).toEqual([
      'folder_moved', 'folder', rootId, accessibleMatterId,
    ]);
    expect(JSON.parse(events[0].metadata_json)).toEqual({
      folderName: `Move Root ${suffix}`,
      matterId: accessibleMatterId,
      previousParentId: null,
      previousParentName: null,
      newParentId: destinationId,
      newParentName: `Destination ${suffix}`,
      descendantCount: 2,
    });

    boundary = await auditBoundary();
    const childToRoot = await moveFolder(rootId, null);
    expect(childToRoot.statusCode).toBe(200);
    expect(childToRoot.body.parentId).toBeNull();
    events = await movedEventsSince(boundary);
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0].metadata_json)).toEqual({
      folderName: `Move Root ${suffix}`,
      matterId: accessibleMatterId,
      previousParentId: destinationId,
      previousParentName: `Destination ${suffix}`,
      newParentId: null,
      newParentName: null,
      descendantCount: 2,
    });

    boundary = await auditBoundary();
    const branchToBranch = await moveFolder(childId, otherBranchId);
    expect(branchToBranch.statusCode).toBe(200);
    expect(branchToBranch.body.parentId).toBe(otherBranchId);
    events = await movedEventsSince(boundary);
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0].metadata_json)).toEqual({
      folderName: `Move Child ${suffix}`,
      matterId: accessibleMatterId,
      previousParentId: rootId,
      previousParentName: `Move Root ${suffix}`,
      newParentId: otherBranchId,
      newParentName: `Other Branch ${suffix}`,
      descendantCount: 1,
    });

    expect(await dbAll(
      'SELECT id,parentId FROM folders WHERE id IN (?,?) ORDER BY id',
      [childId, grandchildId],
    )).toEqual([
      { id: childId, parentId: otherBranchId },
      descendantsBefore.find(folder => folder.id === grandchildId),
    ].sort((left, right) => left.id.localeCompare(right.id)));
    expect(await dbAll(
      `SELECT id,matterId,folderId,deletedAt,clientVisible FROM documents
       WHERE id IN (${documentIds.map(() => '?').join(',')}) ORDER BY id`,
      documentIds,
    )).toEqual(documentsBefore);
  });

  test('self, descendant, cross-matter, inactive, protected, virtual, collision, and depth targets are rejected without success events', async () => {
    const sourceId = `FOL-GUARD-SOURCE-${suffix}`;
    const sourceChildId = `FOL-GUARD-SOURCE-CHILD-${suffix}`;
    const crossMatterParentId = `FOL-GUARD-CROSS-${suffix}`;
    const archivedParentId = `FOL-GUARD-ARCHIVED-${suffix}`;
    const archivedAncestorId = `FOL-GUARD-INACTIVE-ANCESTOR-${suffix}`;
    const inactiveParentId = `FOL-GUARD-INACTIVE-PARENT-${suffix}`;
    const clientUploadsId = `FOL-GUARD-UPLOADS-${suffix}`;
    const collisionParentId = `FOL-GUARD-COLLISION-PARENT-${suffix}`;
    const archivedSourceId = `FOL-GUARD-ARCHIVED-SOURCE-${suffix}`;

    await insertFolder({ id: sourceId, name: `Guarded Name ${suffix}` });
    await insertFolder({ id: sourceChildId, name: `Guard Child ${suffix}`, parentId: sourceId });
    await insertFolder({ id: crossMatterParentId, matterId: inaccessibleMatterId, name: `Cross Parent ${suffix}` });
    await insertFolder({ id: archivedParentId, name: `Archived Parent ${suffix}`, archivedAt: '2026-07-12T08:00:00.000Z' });
    await insertFolder({ id: archivedAncestorId, name: `Inactive Ancestor ${suffix}`, archivedAt: '2026-07-12T08:00:00.000Z' });
    await insertFolder({ id: inactiveParentId, name: `Inactive Parent ${suffix}`, parentId: archivedAncestorId });
    await insertFolder({ id: clientUploadsId, name: 'Client Uploads' });
    await insertFolder({ id: collisionParentId, name: `Collision Parent ${suffix}` });
    await insertFolder({ id: `FOL-GUARD-COLLISION-${suffix}`, name: `GUARDED NAME ${suffix}`, parentId: collisionParentId });
    await insertFolder({ id: archivedSourceId, name: `Archived Source ${suffix}`, archivedAt: '2026-07-12T08:00:00.000Z' });
    await insertDocument({ id: `DOC-GUARD-SOURCE-${suffix}`, folderId: sourceId });

    let depthParentId = null;
    for (let depth = 1; depth <= 7; depth += 1) {
      const id = `FOL-GUARD-DEPTH-${depth}-${suffix}`;
      await insertFolder({ id, name: `Depth ${depth} ${suffix}`, parentId: depthParentId });
      depthParentId = id;
    }

    const sourceBefore = await dbGet('SELECT id,parentId FROM folders WHERE id=?', [sourceId]);
    const documentBefore = await dbGet('SELECT id,matterId,folderId,deletedAt,clientVisible FROM documents WHERE id=?', [`DOC-GUARD-SOURCE-${suffix}`]);
    const boundary = await auditBoundary();
    const attempts = [
      [sourceId, sourceId, 'own parent'],
      [sourceId, sourceChildId, 'descendant'],
      [sourceId, crossMatterParentId, 'cross matter'],
      [sourceId, archivedParentId, 'archived'],
      [sourceId, inactiveParentId, 'effectively inactive'],
      [sourceId, clientUploadsId, 'Client Uploads'],
      [sourceId, 'all', 'virtual all'],
      [sourceId, 'uncategorised', 'virtual uncategorised'],
      [sourceId, collisionParentId, 'collision'],
      [sourceId, depthParentId, 'depth'],
      [sourceId, null, 'unchanged root'],
      [clientUploadsId, collisionParentId, 'Client Uploads source'],
      [archivedSourceId, null, 'archived source'],
    ];

    for (const [folderId, parentId, label] of attempts) {
      const response = await moveFolder(folderId, parentId);
      expect(response.statusCode).toBe(400);
      expect(response.body.error).toEqual(expect.any(String));
      expect(response.body.error.length).toBeGreaterThan(0);
      if (label === 'depth') expect(response.body.error).toContain('8 levels');
    }

    const missingParentId = await request(app)
      .patch(`/api/folders/${sourceId}/move`)
      .set(auth(adminToken))
      .send({});
    expect(missingParentId.statusCode).toBe(400);
    expect(missingParentId.body).toEqual({ error: 'parentId is required' });

    const invalidParentType = await request(app)
      .patch(`/api/folders/${sourceId}/move`)
      .set(auth(adminToken))
      .send({ parentId: { id: collisionParentId } });
    expect(invalidParentType.statusCode).toBe(400);
    expect(invalidParentType.body).toEqual({ error: 'parentId must be a folder ID or null' });

    expect(await movedEventsSince(boundary)).toEqual([]);
    expect(await dbGet('SELECT id,parentId FROM folders WHERE id=?', [sourceId])).toEqual(sourceBefore);
    expect(await dbGet(
      'SELECT id,matterId,folderId,deletedAt,clientVisible FROM documents WHERE id=?',
      [`DOC-GUARD-SOURCE-${suffix}`],
    )).toEqual(documentBefore);
    expect((await dbGet('SELECT parentId FROM folders WHERE id=?', [sourceChildId])).parentId).toBe(sourceId);
  });

  test('concurrent reciprocal moves serialize and cannot create a cycle', async () => {
    const firstId = `FOL-RACE-FIRST-${suffix}`;
    const secondId = `FOL-RACE-SECOND-${suffix}`;
    await insertFolder({ id: firstId, name: `Race First ${suffix}` });
    await insertFolder({ id: secondId, name: `Race Second ${suffix}` });

    const boundary = await auditBoundary();
    const responses = await Promise.all([
      moveFolder(firstId, secondId),
      moveFolder(secondId, firstId),
    ]);
    expect(responses.map(response => response.statusCode).sort()).toEqual([200, 400]);

    const rows = await dbAll('SELECT id,parentId FROM folders WHERE id IN (?,?) ORDER BY id', [firstId, secondId]);
    const first = rows.find(folder => folder.id === firstId);
    const second = rows.find(folder => folder.id === secondId);
    expect(first.parentId === secondId || second.parentId === firstId).toBe(true);
    expect(first.parentId === secondId && second.parentId === firstId).toBe(false);
    expect([first.parentId, second.parentId].filter(Boolean)).toHaveLength(1);

    const events = await movedEventsSince(boundary);
    expect(events).toHaveLength(1);
    expect([firstId, secondId]).toContain(events[0].entity_id);
    expect(JSON.parse(events[0].metadata_json).descendantCount).toBe(0);
  });

  test('assigned advocates may move accessible folders while other roles and inaccessible advocates cannot', async () => {
    const advocateSourceId = `FOL-PERMISSION-ADVOCATE-SOURCE-${suffix}`;
    const advocateParentId = `FOL-PERMISSION-ADVOCATE-PARENT-${suffix}`;
    const deniedSourceId = `FOL-PERMISSION-DENIED-${suffix}`;
    const inaccessibleSourceId = `FOL-PERMISSION-INACCESSIBLE-${suffix}`;
    await insertFolder({ id: advocateSourceId, name: `Advocate Source ${suffix}` });
    await insertFolder({ id: advocateParentId, name: `Advocate Parent ${suffix}` });
    await insertFolder({ id: deniedSourceId, name: `Denied Source ${suffix}` });
    await insertFolder({ id: inaccessibleSourceId, matterId: inaccessibleMatterId, name: `Inaccessible Source ${suffix}` });

    let boundary = await auditBoundary();
    const allowed = await moveFolder(advocateSourceId, advocateParentId, assignedAdvocateToken);
    expect(allowed.statusCode).toBe(200);
    let events = await movedEventsSince(boundary);
    expect(events).toHaveLength(1);
    expect(events[0].actor_role).toBe('advocate');

    boundary = await auditBoundary();
    for (const [token, folderId, parentId] of [
      [assistantToken, deniedSourceId, advocateParentId],
      [clientToken, deniedSourceId, advocateParentId],
      [unassignedAdvocateToken, deniedSourceId, advocateParentId],
      [assignedAdvocateToken, inaccessibleSourceId, null],
    ]) {
      const denied = await moveFolder(folderId, parentId, token);
      expect(denied.statusCode).toBe(403);
    }
    expect(await movedEventsSince(boundary)).toEqual([]);
    expect((await dbGet('SELECT parentId FROM folders WHERE id=?', [deniedSourceId])).parentId).toBeNull();
    expect((await dbGet('SELECT parentId FROM folders WHERE id=?', [inaccessibleSourceId])).parentId).toBeNull();
  });
});
