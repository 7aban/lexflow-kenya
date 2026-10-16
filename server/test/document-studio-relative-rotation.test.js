'use strict';

const fs = require('fs');
const path = require('path');
jest.mock('dotenv', () => ({ config: jest.fn() }), { virtual: true });
const request = require('supertest');
const { createFixture, samplePdf, inspectPdf } = require('./helpers/documentStudioFixture');

jest.setTimeout(20000);
let fixture;
beforeAll(async () => { fixture = await createFixture(); });
afterAll(async () => { await fixture?.close(); });

function rotate(documentId, angle, save = false) {
  return request(fixture.app).post(`/api/document-tools/rotate-pdf${save ? '/save' : ''}`)
    .set('Authorization', `Bearer ${fixture.token}`)
    .send({ documentId, degrees: angle, ...(save ? { matterId: 'DS1A_M' } : {}) });
}

async function assertPages(bytes, source, expectedAngles) {
  const before = await inspectPdf(source);
  const after = await inspectPdf(bytes);
  expect(after.map(page => page.rotation)).toEqual(expectedAngles);
  // Includes page count, order, dimensions, graphics/text streams, and resources.
  expect(after.map(({ rotation, ...page }) => page)).toEqual(before.map(({ rotation, ...page }) => page));
}

function keepOutput(name, bytes) {
  if (process.env.LEXFLOW_DS1A_EVIDENCE) fs.writeFileSync(path.join(process.env.LEXFLOW_DS1A_EVIDENCE, name), bytes);
}

test.each([
  [90, [90, 180, 270, 0]],
  [180, [180, 270, 0, 90]],
  [270, [270, 0, 90, 180]],
])('download rotates mixed pages a further %i degrees without changing content or source', async (angle, expected) => {
  const source = fixture.sources.DS1A_MIXED;
  const before = await fixture.sql.get('SELECT COUNT(*) n FROM documents');
  const response = await rotate('DS1A_MIXED', angle);
  expect(response.status).toBe(200);
  await assertPages(response.body, source, expected);
  expect(await fixture.sql.get('SELECT COUNT(*) n FROM documents')).toEqual(before);
  expect((await fixture.sql.get('SELECT content FROM documents WHERE id=?', ['DS1A_MIXED'])).content).toEqual(source);
  keepOutput(`download-${angle}.pdf`, response.body);
  keepOutput('source-mixed.pdf', source);
});

test.each([
  [90, [90, 180, 270, 0]],
  [180, [180, 270, 0, 90]],
  [270, [270, 0, 90, 180]],
])('saved mixed-page result at %i degrees matches download semantics and preserves source', async (angle, expected) => {
  const source = fixture.sources.DS1A_MIXED;
  const response = await rotate('DS1A_MIXED', angle, true);
  expect(response.status).toBe(200);
  expect(response.body).toMatchObject({ matterId: 'DS1A_M', source: 'document_tool' });
  expect(Number(response.body.clientVisible)).toBe(0);
  const saved = await fixture.sql.get('SELECT content FROM documents WHERE id=?', [response.body.id]);
  await assertPages(saved.content, source, expected);
  expect((await fixture.sql.get('SELECT content FROM documents WHERE id=?', ['DS1A_MIXED'])).content).toEqual(source);
  keepOutput(`saved-${angle}.pdf`, saved.content);
});

test.each([
  [0, 90, 90], [90, 90, 180], [180, 90, 270], [270, 90, 0],
  [0, 180, 180], [90, 180, 270], [180, 180, 0], [270, 180, 90],
  [0, 270, 270], [90, 270, 0], [180, 270, 90], [270, 270, 180],
])('single page initially %i plus %i becomes %i', async (original, angle, expected) => {
  const id = `DS1A_${original}`;
  const response = await rotate(id, angle);
  expect(response.status).toBe(200);
  await assertPages(response.body, fixture.sources[id], [expected]);
  expect((await fixture.sql.get('SELECT content FROM documents WHERE id=?', [id])).content).toEqual(fixture.sources[id]);
});

test('four successive saved 90-degree rotations restore orientation and retain every earlier version', async () => {
  let id = 'DS1A_MIXED';
  const versions = [[id, fixture.sources[id]]];
  const expected = [[90, 180, 270, 0], [180, 270, 0, 90], [270, 0, 90, 180], [0, 90, 180, 270]];
  for (const angles of expected) {
    const response = await rotate(id, 90, true);
    expect(response.status).toBe(200);
    id = response.body.id;
    const saved = await fixture.sql.get('SELECT content FROM documents WHERE id=?', [id]);
    await assertPages(saved.content, fixture.sources.DS1A_MIXED, angles);
    versions.push([id, saved.content]);
  }
  for (const [versionId, content] of versions) expect((await fixture.sql.get('SELECT content FROM documents WHERE id=?', [versionId])).content).toEqual(content);
  keepOutput('repeated-four-times.pdf', versions[4][1]);
});

test('negative and full-turn source rotations normalize into the supported 0-359 degree range', async () => {
  const source = await samplePdf([-90, 450]);
  await fixture.insert('DS1A_NORMALIZE', source);
  const response = await rotate('DS1A_NORMALIZE', 270);
  expect(response.status).toBe(200);
  await assertPages(response.body, source, [180, 0]);
});
