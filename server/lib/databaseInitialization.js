'use strict';

const sqlite3 = require('sqlite3').verbose();

// Never include SQLite's raw message: it can contain paths, SQL or record values.
function initializationError(error) {
  const reasons = {
    SQLITE_CANTOPEN: 'Cannot open configured database. Check the path and parent directory permissions.',
    SQLITE_READONLY: 'Configured database is not writable. Check file and directory permissions.',
    SQLITE_PERM: 'Configured database access denied. Check file and directory permissions.',
    SQLITE_NOTADB: 'Configured file is not a valid SQLite database.',
    SQLITE_CORRUPT: 'Configured SQLite database is corrupt.',
    SQLITE_BUSY: 'Configured database is busy. Close competing database operations.',
    SQLITE_LOCKED: 'Configured database is locked. Close competing database operations.',
  };
  const code = Object.hasOwn(reasons, error?.code) ? error.code : 'DATABASE_INIT_FAILED';
  const safe = new Error(reasons[code] || 'Configured database initialization failed. Check database and startup configuration.');
  safe.code = code;
  return safe;
}

function openDatabase(databasePath, { readOnly = false } = {}) {
  let db;
  const opened = new Promise((resolve, reject) => {
    const mode = readOnly ? sqlite3.OPEN_READONLY : sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE;
    db = new sqlite3.Database(databasePath, mode, error => {
      if (error) reject(initializationError(error));
      else resolve();
    });
  });
  return { db, opened };
}

module.exports = { openDatabase, initializationError };
