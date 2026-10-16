'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const { EventEmitter } = require('events');
const request = require('supertest');
const { PDFDocument } = require('pdf-lib');
jest.mock('dotenv', () => ({ config: jest.fn() }), { virtual: true });
const { createFixture, samplePdf, inspectPdf } = require('./helpers/documentStudioFixture');
const { INPUT_BYTES, BODY_BYTES, byteLimit, outputByteLimit, decodeComputerFiles, createProcessingGate } = require('../lib/documentToolInputs');

jest.setTimeout(20000);
let fixture;
const tokens = {};
const file = (bytes, name = 'synthetic.pdf') => ({ name, mimeType: 'application/pdf', data: bytes.toString('base64') });
const post = (operation, body, token = fixture.token) => request(fixture.app).post(`/api/document-tools/${operation}`).set('Authorization', `Bearer ${token}`).send(body);
const localRotate = (bytes, extra = {}, token) => post('rotate-pdf', { files: [file(bytes)], degrees: 90, ...extra }, token);
const keep = (name, bytes) => { if (process.env.LEXFLOW_DS2A_EVIDENCE) fs.writeFileSync(path.join(process.env.LEXFLOW_DS2A_EVIDENCE, name), bytes); };
const encrypted = Buffer.from('JVBERi0xLjMKJeLjz9MKMSAwIG9iago8PAovUHJvZHVjZXIgPGFkNGI0NmU0YzE+Cj4+CmVuZG9iagoyIDAgb2JqCjw8Ci9UeXBlIC9QYWdlcwovQ291bnQgMQovS2lkcyBbIDQgMCBSIF0KPj4KZW5kb2JqCjMgMCBvYmoKPDwKL1R5cGUgL0NhdGFsb2cKL1BhZ2VzIDIgMCBSCj4+CmVuZG9iago0IDAgb2JqCjw8Ci9UeXBlIC9QYWdlCi9SZXNvdXJjZXMgPDwKPj4KL01lZGlhQm94IFsgMC4wIDAuMCAyMDAgMzAwIF0KL1BhcmVudCAyIDAgUgo+PgplbmRvYmoKNSAwIG9iago8PAovViAyCi9SIDMKL0xlbmd0aCAxMjgKL1AgNDI5NDk2NzI5MgovRmlsdGVyIC9TdGFuZGFyZAovTyA8NTQyMTc4Zjk2YTVhYWFmNmZlMGFmYzMzYzU1ZTFjOGQ0YTc2NDllZDY4NDU2YzRjMjdiMDc5NGRlOGM0ZTc5Yz4KL1UgPDAxYjA0YWEyNjdjYjMzYWE4NzM1ZTFmMTAwNzA3NTk0MjhiZjRlNWU0ZTc1OGE0MTY0MDA0ZTU2ZmZmYTAxMDg+Cj4+CmVuZG9iagp4cmVmCjAgNgowMDAwMDAwMDAwIDY1NTM1IGYgCjAwMDAwMDAwMTUgMDAwMDAgbiAKMDAwMDAwMDA1OSAwMDAwMCBuIAowMDAwMDAwMTE4IDAwMDAwIG4gCjAwMDAwMDAxNjcgMDAwMDAgbiAKMDAwMDAwMDI2MSAwMDAwMCBuIAp0cmFpbGVyCjw8Ci9TaXplIDYKL1Jvb3QgMyAwIFIKL0luZm8gMSAwIFIKL0lEIFsgPDYyMzE2MzY1NjYzMDMzNjYzNDY1MzczNTM3Mzc2MjY2MzMzOTM2MzE2NDY1NjQ2MTM5MzYzNDM0Mzk2NTYxMzA+IDw2MjMxNjM2NTY2MzAzMzY2MzQ2NTM3MzUzNzM3NjI2NjMzMzkzNjMxNjQ2NTY0NjEzOTM2MzQzNDM5NjU2MTMwPiBdCi9FbmNyeXB0IDUgMCBSCj4+CnN0YXJ0eHJlZgo0NzYKJSVFT0YK', 'base64');

beforeAll(async () => {
  fixture = await createFixture();
  const { signAccessToken } = require('../lib/tokens');
  for (const [id, role] of [['computer-advocate', 'advocate'], ['computer-other', 'advocate'], ['computer-assistant', 'assistant'], ['computer-client', 'client']]) {
    const user = { id, role, fullName: id, clientId: role === 'client' ? 'DS1A_C' : '', tokenVersion: 1 };
    await fixture.sql.run('INSERT INTO users(id,email,fullName,role,clientId,tokenVersion) VALUES (?,?,?,?,?,1)', [id, `${id}@example.test`, id, role, user.clientId]);
    tokens[id] = signAccessToken(user);
  }
  await fixture.sql.run("UPDATE matters SET assignedTo='computer-advocate' WHERE id='DS1A_M'");
});
afterAll(async () => { await fixture?.close(); });
afterEach(() => jest.restoreAllMocks());

async function preservedRotation(bytes, original, rotations) {
  const before = await inspectPdf(original);
  const after = await inspectPdf(bytes);
  expect(after.map(p => p.rotation)).toEqual(rotations);
  expect(after.map(({ rotation, ...rest }) => rest)).toEqual(before.map(({ rotation, ...rest }) => rest));
}

test('computer rotation needs no matter, adds to existing rotations and preserves original bytes', async () => {
  const source = fixture.sources.DS1A_MIXED;
  const before = Buffer.from(source);
  const count = await fixture.sql.get('SELECT COUNT(*) n FROM documents');
  const response = await localRotate(source, { filename: '../../unsafe"\r\nname' });
  expect(response.status).toBe(200);
  expect(response.headers['content-type']).toMatch(/^application\/pdf/);
  expect(response.headers['cache-control']).toBe('no-store');
  expect(response.headers['content-disposition']).toBe('attachment; filename=".._.._unsafe___name.pdf"');
  await preservedRotation(response.body, source, [90, 180, 270, 0]);
  expect(source).toEqual(before);
  expect(await fixture.sql.get('SELECT COUNT(*) n FROM documents')).toEqual(count);
  keep('computer-source.pdf', source);
  keep('computer-rotated.pdf', response.body);
});

test.each([['computer-advocate'], ['computer-other'], ['computer-assistant']])('%s can process own submitted bytes without matter permissions', async id => {
  const response = await localRotate(fixture.sources.DS1A_90, {}, tokens[id]);
  expect(response.status).toBe(200);
  await preservedRotation(response.body, fixture.sources.DS1A_90, [180]);
});

test('merge preserves supplied order, repeated source selections and every page content', async () => {
  const sources = [fixture.sources.DS1A_270, fixture.sources.DS1A_MIXED, fixture.sources.DS1A_0];
  const response = await post('merge-pdfs', { files: sources.map((bytes, i) => file(bytes, `source-${i}.pdf`)), filename: 'computer-merge.pdf' });
  expect(response.status).toBe(200);
  expect(response.headers['content-disposition']).toBe('attachment; filename="computer-merge.pdf"');
  const expected = (await Promise.all(sources.map(inspectPdf))).flat();
  const actual = await inspectPdf(response.body);
  expect(actual.map(({ resources, ...rest }) => rest)).toEqual(expected.map(({ resources, ...rest }) => rest));
  const repeated = await post('merge-pdfs', { files: [file(sources[0]), file(sources[0])] });
  expect((await inspectPdf(repeated.body)).map(p => p.rotation)).toEqual([270, 270]);
  keep('computer-merged.pdf', response.body);
});

test('PDF data URL is supported and missing inputs retain controlled errors', async () => {
  const input = file(fixture.sources.DS1A_0);
  input.data = `data:application/pdf;base64,${input.data}`;
  expect((await post('rotate-pdf', { files: [input], degrees: 180 })).status).toBe(200);
  for (const route of ['rotate-pdf', 'merge-pdfs']) expect((await post(route, {})).status).toBe(400);
});

test.each([
  ['missing files', { files: null }], ['empty files', { files: [] }],
  ['wrong cardinality', { files: [{}, {}] }], ['null file', { files: [null] }],
  ['unsupported MIME', { files: [{ name: 'image.png', mimeType: 'image/png', data: 'AAAA' }] }],
  ['missing name', { files: [{ mimeType: 'application/pdf', data: 'AAAA' }] }],
  ['long name', { files: [{ name: 'x'.repeat(181), mimeType: 'application/pdf', data: 'AAAA' }] }],
  ['extra file metadata', { files: [{ name: 'x.pdf', mimeType: 'application/pdf', data: 'AAAA', path: '../x' }] }],
  ['mixed single ID', { documentId: null }], ['mixed array IDs', { documentIds: [] }],
  ['extra request metadata', { matterId: 'DS1A_M' }], ['invalid angle', { degrees: 45 }],
  ['invalid filename', { filename: {} }],
])('rejects %s', async (_name, extra) => {
  const response = await localRotate(fixture.sources.DS1A_0, extra);
  expect(response.status).toBe(400);
  expect(typeof response.body.error).toBe('string');
  expect(JSON.stringify(response.body)).not.toContain(fixture.sources.DS1A_0.toString('base64'));
});

test.each(['', 'Zg=', 'Zg===', 'Zh==', 'Zm9=', 'AA A=', '!!!!', 'data:text/plain;base64,AAAA', 'data:application/pdf,AAAA'])('rejects invalid base64 case %#', async data => {
  const response = await post('rotate-pdf', { files: [{ name: 'x.pdf', mimeType: 'application/pdf', data }], degrees: 90 });
  expect(response.status).toBe(400);
});

test('rejects malformed, empty-page and genuinely encrypted PDFs without leaking input', async () => {
  const empty = Buffer.from(await (await PDFDocument.create()).save({ addDefaultPage: false }));
  for (const bytes of [Buffer.from('private-marker-not-a-pdf'), Buffer.from('%PDF-1.7\nprivate-marker\n%%EOF\n'), encrypted, empty]) {
    const response = await localRotate(bytes);
    expect(response.status).toBe(400);
    expect(JSON.stringify(response.body)).not.toMatch(/private-marker|synthetic-password|%PDF|stack/);
  }
});

test('merge rejects too few/many files, mixed IDs and an invalid member', async () => {
  const input = file(fixture.sources.DS1A_0);
  for (const files of [[], [input], Array(11).fill(input), [input, { ...input, data: 'AAAA' }]]) {
    expect((await post('merge-pdfs', { files })).status).toBe(400);
  }
  expect((await post('merge-pdfs', { files: [input, input], documentIds: ['DS1A_0', 'DS1A_90'] })).status).toBe(400);
  expect((await post('merge-pdfs', { files: Array(10).fill(input) })).status).toBe(200);
});

function paddedPdf(targetBytes) {
  const source = fixture.sources.DS1A_0;
  const end = source.lastIndexOf('%%EOF');
  const prefix = source.subarray(0, end);
  return Buffer.concat([prefix, Buffer.from('%'), Buffer.alloc(targetBytes - prefix.length - 8, 120), Buffer.from('\n%%EOF\n')]);
}

test('authenticated PDF JSON larger than 1 MiB succeeds; unrelated routes retain their limit', async () => {
  const source = paddedPdf(1100 * 1024);
  const response = await localRotate(source);
  expect(response.status).toBe(200);
  await preservedRotation(response.body, source, [90]);
  const unrelated = await request(fixture.app).post('/api/document-tools/extract-pdf-pages').set('Authorization', `Bearer ${fixture.token}`).send({ padding: 'x'.repeat(1100 * 1024) });
  expect(unrelated.status).toBe(413);
});

test('decoded aggregate and encoded request bodies have separate bounded limits', async () => {
  const oversized = paddedPdf(INPUT_BYTES + 1);
  const decoded = await localRotate(oversized);
  expect(decoded.status).toBe(413);
  expect(decoded.body.code).toBe('computer_pdf_input_too_large');
  const encoded = await post('rotate-pdf', { padding: 'x'.repeat(BODY_BYTES + 1) });
  expect(encoded.status).toBe(413);
  expect(encoded.body).toEqual({ error: 'Request body is too large.', code: 'payload_too_large' });
  expect((await localRotate(fixture.sources.DS1A_0)).status).toBe(200);
});

test('authorization precedes large-body acceptance, including case/trailing-slash route aliases', async () => {
  const server = fixture.app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  // Send headers advertising an oversized body, but withhold the body. A parser
  // placed before authorization would wait for bytes instead of responding.
  const denied = (route, token) => new Promise((resolve, reject) => {
    const client = http.request({ host: '127.0.0.1', port: server.address().port, path: route, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': BODY_BYTES + 1, ...(token ? { Authorization: `Bearer ${token}` } : {}) } }, response => {
      response.resume();
      response.once('end', () => { client.destroy(); resolve(response.statusCode); });
    });
    client.on('error', reject);
    client.setTimeout(2000, () => client.destroy(new Error('Authorization waited for body')));
    client.flushHeaders();
  });
  try {
    expect(await denied('/api/document-tools/rotate-pdf')).toBe(401);
    for (const route of ['/api/document-tools/merge-pdfs', '/API/DOCUMENT-TOOLS/ROTATE-PDF/']) expect(await denied(route, tokens['computer-client'])).toBe(403);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  const invalidJson = await request(fixture.app).post('/api/document-tools/rotate-pdf').set('Authorization', `Bearer ${fixture.token}`).set('Content-Type', 'application/json').send('{"files":private-marker');
  expect(invalidJson.status).toBe(400);
  expect(invalidJson.body).toEqual({ error: 'Invalid PDF processing JSON request.', code: 'invalid_pdf_request' });
});

test('direct output limit rejects oversized generation and releases capacity', async () => {
  const save = jest.spyOn(PDFDocument.prototype, 'save').mockResolvedValueOnce(new Uint8Array(25 * 1024 * 1024 + 1));
  const response = await localRotate(fixture.sources.DS1A_0);
  expect(response.status).toBe(413);
  expect(response.body.code).toBe('computer_pdf_output_too_large');
  save.mockRestore();
  expect((await localRotate(fixture.sources.DS1A_0)).status).toBe(200);
});

test.each([[90], '90', {}, true, null])('direct angle must be a supported number: %#', async degrees => {
  expect((await localRotate(fixture.sources.DS1A_0, { degrees })).status).toBe(400);
});

test.each(['large', 'chunked'])('%s body admission is bounded before parsing and releases after abort', async mode => {
  const server = fixture.app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const client = http.request({ host: '127.0.0.1', port: server.address().port, path: '/api/document-tools/rotate-pdf', method: 'POST', headers: {
    Authorization: `Bearer ${fixture.token}`, 'Content-Type': 'application/json',
    ...(mode === 'large' ? { 'Content-Length': 2 * 1024 * 1024 } : { 'Transfer-Encoding': 'chunked' }),
  } });
  client.on('error', () => {});
  client.write('{"files":['); // Deliberately leave the first upload incomplete.
  try {
    let response;
    for (let i = 0; i < 30; i++) {
      response = await localRotate(fixture.sources.DS1A_0);
      if (response.status === 429) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(response.status).toBe(429);
    expect(response.body.code).toBe('computer_pdf_busy');
    expect((await post('rotate-pdf', { documentId: 'DS1A_0', degrees: 90 })).status).toBe(200);
    client.destroy();
    for (let i = 0; i < 30; i++) {
      response = await localRotate(fixture.sources.DS1A_0);
      if (response.status !== 429) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(response.status).toBe(200);
  } finally { client.destroy(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('only one direct operation runs; stored mode proceeds, and users never share results', async () => {
  const original = PDFDocument.load;
  let unblock, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const barrier = new Promise(resolve => { unblock = resolve; });
  jest.spyOn(PDFDocument, 'load').mockImplementationOnce(async (...args) => { entered(); await barrier; return original.apply(PDFDocument, args); });
  const pending = localRotate(fixture.sources.DS1A_90, {}, tokens['computer-advocate']).then(response => response);
  await started;
  try {
    const busy = await localRotate(fixture.sources.DS1A_270, {}, tokens['computer-other']);
    expect(busy.status).toBe(429);
    expect(busy.headers['retry-after']).toBe('1');
    expect(busy.body.code).toBe('computer_pdf_busy');
    expect((await post('rotate-pdf', { documentId: 'DS1A_0', degrees: 90 })).status).toBe(200);
  } finally { unblock(); }
  const first = await pending;
  await preservedRotation(first.body, fixture.sources.DS1A_90, [180]);
  const second = await localRotate(fixture.sources.DS1A_270, {}, tokens['computer-other']);
  await preservedRotation(second.body, fixture.sources.DS1A_270, [0]);
});

test('disconnect while PDF processing is held does not release capacity early', async () => {
  const server = fixture.app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const original = PDFDocument.load;
  let unblock, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const barrier = new Promise(resolve => { unblock = resolve; });
  jest.spyOn(PDFDocument, 'load').mockImplementationOnce(async (...args) => { entered(); await barrier; return original.apply(PDFDocument, args); });
  const payload = JSON.stringify({ files: [file(fixture.sources.DS1A_90)], degrees: 90 });
  const client = http.request({ host: '127.0.0.1', port: server.address().port, path: '/api/document-tools/rotate-pdf', method: 'POST', headers: { Authorization: `Bearer ${fixture.token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } });
  client.on('error', () => {});
  client.end(payload);
  await started;
  try {
    client.destroy();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect((await localRotate(fixture.sources.DS1A_0)).status).toBe(429);
  } finally { unblock(); }
  // A finishing stored request yields through the same SQLite audit connection.
  await post('rotate-pdf', { documentId: 'DS1A_0', degrees: 90 });
  let response;
  for (let i = 0; i < 30; i++) {
    response = await localRotate(fixture.sources.DS1A_0);
    if (response.status !== 429) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  expect(response.status).toBe(200);
  await new Promise(resolve => server.close(resolve));
});

test('admission gate releases abandoned parsing but retains running work until finally', () => {
  const gate = createProcessingGate();
  const req = new EventEmitter(), res = new EventEmitter();
  const lease = gate.acquire(req, res);
  expect(gate.acquire(req, res)).toBe(lease);
  expect(gate.acquire(new EventEmitter(), new EventEmitter())).toBeNull();
  req.emit('aborted');
  const secondReq = new EventEmitter(), secondRes = new EventEmitter();
  const second = gate.acquire(secondReq, secondRes);
  expect(second.start()).toBe(true);
  secondReq.emit('aborted'); secondRes.emit('close'); secondRes.emit('finish');
  expect(gate.acquire(new EventEmitter(), new EventEmitter())).toBeNull();
  second.finish(); second.finish();
  expect(gate.acquire(new EventEmitter(), new EventEmitter())).not.toBeNull();
});

test('supported output ceiling accounts for both configured upload bounds', () => {
  expect(byteLimit('34mb')).toBe(34 * 1024 * 1024);
  expect(outputByteLimit(25, '34mb')).toBe(25 * 1024 * 1024);
  expect(outputByteLimit(5, '34mb')).toBe(5 * 1024 * 1024);
  expect(outputByteLimit(25, '1mb')).toBe(Math.floor((1024 * 1024 - 8192) / 4) * 3);
  expect(outputByteLimit(25, '1kb')).toBe(0);
});

test('direct processing writes only audit rows, no documents, tables or working files', async () => {
  const snapshot = async () => {
    const tables = await fixture.sql.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT IN ('audit_events','audit_logs') ORDER BY name");
    const result = {};
    for (const { name } of tables) result[name] = (await fixture.sql.get(`SELECT COUNT(*) n FROM "${name}"`)).n;
    return result;
  };
  const before = await snapshot();
  const writes = [jest.spyOn(fs, 'writeFileSync'), jest.spyOn(fs, 'writeFile'), jest.spyOn(fs.promises, 'writeFile'), jest.spyOn(fs, 'mkdtempSync'), jest.spyOn(fs.promises, 'mkdtemp')];
  expect((await localRotate(fixture.sources.DS1A_0)).status).toBe(200);
  expect((await post('merge-pdfs', { files: [file(fixture.sources.DS1A_0), file(fixture.sources.DS1A_90)] })).status).toBe(200);
  for (const spy of writes) expect(spy).not.toHaveBeenCalled();
  expect(await snapshot()).toEqual(before);
  const events = await fixture.sql.all("SELECT * FROM audit_events WHERE json_extract(metadata_json,'$.source')='computer'");
  expect(events.length).toBeGreaterThan(0);
  for (const event of events) {
    expect(event.entity_id).toBe(''); expect(event.matter_id).toBe(''); expect(event.client_id).toBe('');
    expect(event.metadata_json).not.toMatch(/%PDF|base64|synthetic-password|private-marker|sourceDocumentId/);
    const metadata = JSON.parse(event.metadata_json);
    expect(metadata.inputBytes).toBeLessThanOrEqual(INPUT_BYTES);
    expect(['processed', 'rejected', 'failed']).toContain(metadata.outcome);
  }
});

test('existing stored merge/save, source permissions, internal defaults and audit remain', async () => {
  const body = { documentIds: ['DS1A_90', 'DS1A_270'], filename: 'stored.pdf' };
  const downloaded = await post('merge-pdfs', body);
  expect(downloaded.status).toBe(200);
  expect((await inspectPdf(downloaded.body)).map(p => p.rotation)).toEqual([90, 270]);
  const saved = await post('merge-pdfs/save', { ...body, matterId: 'DS1A_M' });
  expect(saved.status).toBe(200);
  expect(saved.body).toMatchObject({ source: 'document_tool', clientVisible: 0, matterId: 'DS1A_M' });
  const content = (await fixture.sql.get('SELECT content FROM documents WHERE id=?', [saved.body.id])).content;
  expect((await inspectPdf(content)).map(p => p.rotation)).toEqual([90, 270]);
  expect((await post('merge-pdfs', body, tokens['computer-other'])).status).toBe(403);
  expect((await post('rotate-pdf', { documentId: 'DS1A_0', degrees: 90 }, tokens['computer-other'])).status).toBe(403);
  expect((await post('merge-pdfs/save', { ...body, matterId: 'DS1A_M' }, tokens['computer-assistant'])).status).toBe(403);
  for (const [id, original] of Object.entries(fixture.sources)) expect((await fixture.sql.get('SELECT content FROM documents WHERE id=?', [id])).content).toEqual(original);
  expect((await fixture.sql.get("SELECT COUNT(*) n FROM audit_events WHERE action='document_tool_merge_pdf_saved'")).n).toBeGreaterThan(0);
});

test('existing upload rejects absent/unauthorized destinations, preserves folders and exact bytes', async () => {
  const body = { ...file(fixture.sources.DS1A_0), displayName: 'Saved result.pdf' };
  const upload = (matter, token = fixture.token, extra = {}) => request(fixture.app).post(`/api/matters/${matter}/documents`).set('Authorization', `Bearer ${token}`).send({ ...body, ...extra });
  expect((await upload('missing-matter')).status).toBe(404);
  expect((await upload('DS1A_M', tokens['computer-other'])).status).toBe(403);
  expect((await upload('DS1A_M', tokens['computer-assistant'])).status).toBe(403);
  expect((await upload('DS1A_M', fixture.token, { folderId: 'missing-folder' })).status).toBe(400);
  const response = await upload('DS1A_M', tokens['computer-advocate']);
  expect(response.status).toBe(200);
  expect(response.body).toMatchObject({ matterId: 'DS1A_M', source: 'firm', clientVisible: 0, displayName: 'Saved result.pdf' });
  expect(response.body).not.toHaveProperty('content');
  expect((await fixture.sql.get('SELECT content FROM documents WHERE id=?', [response.body.id])).content).toEqual(fixture.sources.DS1A_0);
  expect((await fixture.sql.get("SELECT COUNT(*) n FROM audit_events WHERE action='document_uploaded' AND entity_id=?", [response.body.id])).n).toBe(1);
});
