const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const server = path.resolve(__dirname, '../../../server');
const sqlite3 = require(path.join(server, 'node_modules/sqlite3'));
const createDb = require(path.join(server, 'lib/db'));
const { hashPassword } = require(path.join(server, 'lib/passwords'));

module.exports = async function syntheticBackend() {
  if (process.version !== 'v22.22.2' || !process.env.LEXFLOW_104B_WORK) throw new Error('Isolated Node 22 fixture required');
  const dir = fs.mkdtempSync(path.join(process.env.LEXFLOW_104B_WORK, 'synthetic-104b-'));
  const databasePath = path.join(dir, 'synthetic.db');
  let child, db;
  const env = { ...process.env, NODE_ENV: 'test', DATABASE_PATH: databasePath, JWT_SECRET: 'synthetic-browser-104b-key', LEXFLOW_DISABLE_RATE_LIMIT: 'true', CORS_ORIGINS: 'http://127.0.0.1:5184' };
  async function boot() {
    const code = `const {app,dbReady}=require(${JSON.stringify(path.join(server, 'server'))});dbReady.then(()=>app.listen(5294,'127.0.0.1',()=>process.send('ready'))).catch(e=>{console.error(e.code);process.exit(1)});`;
    child = spawn(process.execPath, ['-e', code], { env, cwd: server, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
    let output = '';
    child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Synthetic backend startup failed: ${output}`)), 15000);
      child.once('message', () => { clearTimeout(timeout); resolve(); });
      child.once('error', e => { clearTimeout(timeout); reject(e); });
      child.once('exit', code => { clearTimeout(timeout); reject(new Error(`Synthetic backend exited ${code}: ${output}`)); });
    });
  }
  async function stop() {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise(resolve => child.once('exit', resolve)); child.kill(); await exited;
  }
  await boot();
  db = new sqlite3.Database(databasePath);
  const sql = createDb(db);
  const password = await hashPassword('Synthetic104B!Password');
  for (const [id, role, fullName, clientId] of [['104b-a','advocate','Timer Advocate',''],['104b-b','advocate','Other Advocate',''],['104b-client','client','Timer Client','104b-client']]) {
    await sql.run('INSERT INTO users(id,email,password,role,fullName,tokenVersion,isActive,clientId) VALUES (?,?,?,?,?,1,1,?)', [id, `${id}@example.test`, password, role, fullName, clientId]);
  }
  await sql.run("INSERT INTO clients(id,name,email,status) VALUES ('104b-client','Synthetic Timer Client','104b-client@example.test','Active')");
  for (const [id, title, assignedTo] of [['104b-A','Matter A — Research','Timer Advocate'],['104b-B','Matter B — Drafting','Timer Advocate'],['104b-hidden','Inaccessible matter','Other Advocate']]) {
    await sql.run('INSERT INTO matters(id,clientId,title,reference,assignedTo,stage,billingType,billingRate) VALUES (?,\'104b-client\',?,?,?,\'Intake\',\'hourly\',7500)', [id, title, id, assignedTo]);
  }
  await sql.run("INSERT INTO tasks(id,matterId,title,assignee,completed) VALUES ('104b-task','104b-A','Prepare synthetic submissions','Timer Advocate',0)");
  await sql.run("INSERT INTO tasks(id,matterId,title,assignee,completed) VALUES ('104b-delegated','104b-hidden','Delegated inaccessible work','Timer Advocate',0)");
  await sql.run("INSERT OR REPLACE INTO firm_settings(id,name,advocateBillingVisibility) VALUES ('default','LexFlow Synthetic Practice',1)");
  return { ...sql, databasePath,
    async reset() {
      await sql.run('DELETE FROM work_sessions'); await sql.run('DELETE FROM time_entries');
      await sql.run("UPDATE matters SET assignedTo='Timer Advocate' WHERE id IN ('104b-A','104b-B')");
      await sql.run("UPDATE users SET tokenVersion=1 WHERE id='104b-a'");
    },
    async restart() { await stop(); await boot(); },
    async close() { await stop(); await new Promise((resolve, reject) => db.close(e => e ? reject(e) : resolve())); },
  };
};
