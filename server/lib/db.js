module.exports = (db) => {
  // Enable WAL mode for better concurrent access
  db.run('PRAGMA journal_mode=WAL');
  // Set busy timeout to 5000ms to handle concurrent access
  db.run('PRAGMA busy_timeout=5000');

  return {
    run: (sql, params = []) => new Promise((resolve, reject) => db.run(sql, params, function onRun(err) { err ? reject(err) : resolve(this); })),
    get: (sql, params = []) => new Promise((resolve, reject) => db.get(sql, params, (err, row) => err ? reject(err) : resolve(row))),
    all: (sql, params = []) => new Promise((resolve, reject) => db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows))),
  };
};
