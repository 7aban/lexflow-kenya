'use strict';

// Disposable child process: the parent supplies only a synthetic DATABASE_PATH.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const sqlite3 = require('sqlite3');
const jwt = require('jsonwebtoken');
const connections = [];
if (process.env.INIT_WORKER_FAILURE) {
  const initialization = require('../../lib/databaseInitialization');
  const originalOpen = initialization.openDatabase;
  initialization.openDatabase = (databasePath, options = {}) => {
    assert.equal(databasePath, process.env.DATABASE_PATH);
    // Exercise failure after main initialization, before auth has opened.
    const target = options.readOnly && process.env.INIT_WORKER_FAILURE === 'auth-open'
      ? path.join(path.dirname(databasePath), 'missing-auth-parent', 'auth.db')
      : databasePath;
    const connection = originalOpen(target, options);
    const state = { opened: false, closes: 0 };
    connections.push(state);
    connection.opened.then(() => { state.opened = true; }, () => {});
    const originalClose = connection.db.close;
    connection.db.close = function (...args) {
      state.closes++;
      return originalClose.apply(this, args);
    };
    return connection;
  };
}
const { app, dbReady, config } = require('../../server');
let stage = 'startup';

async function main() {
  const listener = app.listen(0, '127.0.0.1');
  await new Promise(resolve => listener.once('listening', resolve));
  const port = listener.address().port;
  const base = `http://127.0.0.1:${port}`;
  const api = async (route, { token, body } = {}) => {
    const response = await fetch(`${base}${route}`, {
      method: body ? 'POST' : 'GET',
      headers: { Connection: 'close', ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(15000),
    });
    return { status: response.status, body: await response.json() };
  };
  try {
    if (process.env.INIT_WORKER_FAILURE) {
      const expectedCode = process.env.INIT_WORKER_FAILURE === 'true' ? 'SQLITE_NOTADB' : 'SQLITE_CANTOPEN';
      await assert.rejects(dbReady, error => error.code === expectedCode);
      assert.equal(connections.length, process.env.INIT_WORKER_FAILURE === 'auth-open' ? 2 : 1);
      for (const connection of connections) assert.equal(connection.closes, connection.opened ? 1 : 0);
      for (const route of ['/health', '/api/auth/me']) {
        assert.deepEqual(await api(route), { status: 503, body: { error: 'Database unavailable' } });
      }
      console.log('FAILED_READINESS_REJECTED_AND_HTTP_503');
      console.log('ONLY_OPENED_CONNECTIONS_CLOSED');
      return;
    }
    // Request health immediately, without awaiting dbReady first.
    const health = await api('/health');
    assert.equal(health.status, 200);
    assert.equal(health.body.status, 'ok');
    await dbReady;
    assert.equal(fs.existsSync(config.DATABASE_PATH), true);
    const credentials = { email: config.SEED_ADMIN_EMAIL, password: config.SEED_ADMIN_PASSWORD };
    stage = 'login';
    const login = await api('/api/auth/login', { body: credentials });
    assert.equal(login.status, 200);
    assert.equal(typeof login.body.token, 'string');
    assert.equal(login.body.user.role, 'admin');
    assert.equal((await api('/api/auth/me', { token: login.body.token })).status, 200);
    assert.equal((await api('/api/auth/me')).status, 401);
    assert.equal((await api('/api/auth/login', { body: { ...credentials, password: 'incorrect-synthetic-password' } })).status, 401);
    assert.equal((await api('/api/auth/client-login', { body: credentials })).status, 401);
    const decoded = jwt.decode(login.body.token);
    stage = 'token-checks';
    const payload = { userId: decoded.userId, tokenVersion: decoded.tokenVersion };
    for (const token of [
      'malformed',
      jwt.sign(payload, 'incorrect-synthetic-signing-secret', { expiresIn: '1h' }),
      jwt.sign(payload, config.JWT_SECRET, { expiresIn: '-1h' }),
      jwt.sign({ userId: decoded.userId }, config.JWT_SECRET, { expiresIn: '1h' }),
      jwt.sign({ ...payload, tokenVersion: 99 }, config.JWT_SECRET, { expiresIn: '1h' }),
      jwt.sign({ ...payload, userId: 'synthetic-deleted-user' }, config.JWT_SECRET, { expiresIn: '1h' }),
    ]) assert.equal((await api('/api/auth/me', { token })).status, 401);

    // Existing databases must retain both credentials and unrelated records.
    stage = 'record-preservation';
    const db = await new Promise((resolve, reject) => {
      const connection = new sqlite3.Database(config.DATABASE_PATH, error => error ? reject(error) : resolve(connection));
    });
    try {
      const run = sql => new Promise((resolve, reject) => db.run(sql, error => error ? reject(error) : resolve()));
      const get = sql => new Promise((resolve, reject) => db.get(sql, (error, row) => error ? reject(error) : resolve(row)));
      if (process.env.INIT_WORKER_EXISTING === 'true') {
        assert.deepEqual(await get('SELECT value FROM initialization_sentinel'), { value: 'synthetic-preserved-record' });
        assert.equal((await get('SELECT COUNT(*) AS count FROM users')).count, 1);
      } else {
        await run('CREATE TABLE initialization_sentinel (value TEXT)');
        await run("INSERT INTO initialization_sentinel VALUES ('synthetic-preserved-record')");
      }
      // Auth must use the database role, even if a signed token claims another role.
      stage = 'role-and-session';
      await run("UPDATE users SET role='assistant'");
      const denied = await api('/api/auth/register', { token: login.body.token, body: { email: 'blocked@example.test', password: 'synthetic-password', fullName: 'Blocked', role: 'admin' } });
      assert.equal(denied.status, 403);
      await run("UPDATE users SET role='admin'");
      await run('UPDATE users SET tokenVersion=tokenVersion+1');
      assert.equal((await api('/api/auth/me', { token: login.body.token })).status, 401);
      const renewed = await api('/api/auth/login', { body: credentials });
      assert.equal(renewed.status, 200);
      assert.equal((await api('/api/auth/me', { token: renewed.body.token })).status, 200);
    } finally {
      await new Promise((resolve, reject) => db.close(error => error ? reject(error) : resolve()));
    }
    console.log(`INITIALIZATION_AUTH_OK PORT=${port}`);
  } finally {
    const closed = new Promise(resolve => listener.close(resolve));
    listener.closeAllConnections();
    await closed;
    // Prove this disposable listener's port was released.
    const net = require('node:net');
    const probe = net.createServer();
    await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(port, '127.0.0.1', resolve); });
    await new Promise(resolve => probe.close(resolve));
    console.log('PORT_RELEASED');
  }
}

main().then(() => process.exit(0), () => {
  // Assertion output may contain tokens; keep the child failure message sanitized.
  console.error(`Synthetic initialization/authentication assertion failed at ${stage}`);
  process.exit(1);
});
