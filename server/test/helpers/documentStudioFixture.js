const fs = require('fs');
const os = require('os');
const path = require('path');
const { PDFDocument, PDFArray, StandardFonts, degrees, rgb } = require('pdf-lib');

async function samplePdf(rotations) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  rotations.forEach((rotation, index) => {
    const page = pdf.addPage([400 + index * 20, 520 + index * 20]);
    page.setRotation(degrees(rotation));
    page.drawRectangle({ x: 20, y: 20, width: page.getWidth() - 40, height: page.getHeight() - 40, borderWidth: 2, borderColor: rgb(0, 0.3, 0.2) });
    page.drawText(`PAGE ${index + 1} / ORIGINAL ${rotation}`, { x: 40, y: page.getHeight() - 60, size: 16, font });
    page.drawText('TOP - synthetic document', { x: 40, y: page.getHeight() - 90, size: 12, font });
    page.drawText('BOTTOM - content must remain', { x: 40, y: 45, size: 12, font });
  });
  return Buffer.from(await pdf.save());
}

async function inspectPdf(bytes) {
  const pdf = await PDFDocument.load(bytes);
  return pdf.getPages().map(page => {
    const contents = page.node.Contents();
    const streams = contents instanceof PDFArray ? contents.asArray().map(ref => pdf.context.lookup(ref)) : [contents];
    return {
      rotation: page.getRotation().angle,
      size: page.getSize(),
      // Exact encoded content streams identify both the text/graphics and page order.
      contents: streams.map(stream => Buffer.from(stream.getContents()).toString('base64')),
      resources: page.node.Resources().toString(),
    };
  });
}

async function createFixture() {
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lexflow-ds1a-')), 'synthetic.db');
  process.env.JWT_SECRET = 'synthetic-ds1a-pdf-key';
  process.env.SEED_ADMIN_EMAIL = 'ds1a-admin@example.test';
  process.env.SEED_ADMIN_PASSWORD = 'SyntheticDS1A!Password';
  const { app, dbReady } = require('../../server');
  await dbReady;
  const sqlite3 = require('sqlite3');
  const db = new sqlite3.Database(process.env.DATABASE_PATH);
  const sql = require('../../lib/db')(db);
  const request = require('supertest');
  const login = await request(app).post('/api/auth/login').send({ email: process.env.SEED_ADMIN_EMAIL, password: process.env.SEED_ADMIN_PASSWORD });
  if (login.status !== 200) throw new Error(`Synthetic login failed: ${login.status}`);
  await sql.run("INSERT INTO clients(id,name) VALUES ('DS1A_C','Synthetic DS1A client')");
  await sql.run("INSERT INTO matters(id,clientId,reference,title,assignedTo) VALUES ('DS1A_M','DS1A_C','DS1A','Synthetic PDF correctness',?)", [login.body.user.fullName]);
  const sources = {};
  async function insert(id, content) {
    await sql.run('INSERT INTO documents(id,matterId,name,displayName,type,mimeType,date,size,content,source,clientVisible,uploadedBy) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)', [id, 'DS1A_M', `${id}.pdf`, `${id}.pdf`, 'PDF', 'application/pdf', '2026-10-16', `${content.length} bytes`, content, 'firm', 0, login.body.user.id]);
    return id;
  }
  for (const [id, rotations] of [['DS1A_MIXED', [0, 90, 180, 270]], ...[0, 90, 180, 270].map(angle => [`DS1A_${angle}`, [angle]])]) {
    sources[id] = await samplePdf(rotations);
    await insert(id, sources[id]);
  }
  return { app, sql, sources, insert, token: login.body.token, user: login.body.user, databasePath: process.env.DATABASE_PATH, close: () => new Promise((resolve, reject) => db.close(e => e ? reject(e) : resolve())) };
}

module.exports = { createFixture, samplePdf, inspectPdf };
