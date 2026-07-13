'use strict';

const sqlite3 = require('sqlite3').verbose();
const createAudit = require('./audit');
const {
  MAX_FOLDER_DEPTH,
  isClientUploadsFolderName,
  isVirtualFolderId,
  normalizeFolderId,
} = require('./folderHierarchy');

const FOLDER_COLUMNS = 'id,matterId,name,createdBy,createdAt,archivedAt,parentId';
const PUBLIC_FOLDER_COLUMNS = 'id,matterId,name,createdBy,createdAt,parentId';

class FolderMoveError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.name = 'FolderMoveError';
    this.statusCode = statusCode;
  }
}

function openDatabase(databasePath) {
  return new Promise((resolve, reject) => {
    const connection = new sqlite3.Database(databasePath, sqlite3.OPEN_READWRITE, error => {
      if (error) reject(error);
      else resolve(connection);
    });
  });
}

function databaseHelpers(connection) {
  return {
    run: (sql, params = []) => new Promise((resolve, reject) => {
      connection.run(sql, params, function onRun(error) {
        if (error) reject(error);
        else resolve(this);
      });
    }),
    get: (sql, params = []) => new Promise((resolve, reject) => {
      connection.get(sql, params, (error, row) => {
        if (error) reject(error);
        else resolve(row);
      });
    }),
    all: (sql, params = []) => new Promise((resolve, reject) => {
      connection.all(sql, params, (error, rows) => {
        if (error) reject(error);
        else resolve(rows);
      });
    }),
  };
}

function closeDatabase(connection) {
  return new Promise((resolve, reject) => {
    connection.close(error => (error ? reject(error) : resolve()));
  });
}

function hierarchyError(destination) {
  return new FolderMoveError(
    400,
    destination
      ? 'Destination folder must be active in the current hierarchy'
      : 'Folder must be active in the current hierarchy before it can be moved',
  );
}

function loadActiveChain(startFolder, folderById, { destination = false } = {}) {
  const chain = [];
  const visited = new Set();
  let current = startFolder;

  while (current) {
    const currentId = normalizeFolderId(current.id);
    if (!currentId || visited.has(currentId)) throw hierarchyError(destination);
    if (current.archivedAt) throw hierarchyError(destination);
    if (isClientUploadsFolderName(current.name)) {
      if (destination) throw new FolderMoveError(400, 'Client Uploads cannot contain child folders');
      throw hierarchyError(false);
    }

    visited.add(currentId);
    chain.push(current);
    if (chain.length > MAX_FOLDER_DEPTH) {
      throw new FolderMoveError(400, `Folder hierarchy cannot exceed ${MAX_FOLDER_DEPTH} levels`);
    }

    const parentId = normalizeFolderId(current.parentId);
    if (!parentId) break;
    if (isVirtualFolderId(parentId)) throw hierarchyError(destination);
    current = folderById.get(parentId);
    if (!current) throw hierarchyError(destination);
  }

  return chain;
}

function subtreeMetrics(sourceId, folders) {
  const childrenByParentId = new Map();
  for (const folder of folders) {
    const parentId = normalizeFolderId(folder.parentId);
    if (!parentId) continue;
    if (!childrenByParentId.has(parentId)) childrenByParentId.set(parentId, []);
    childrenByParentId.get(parentId).push(folder);
  }

  const visiting = new Set();
  const visited = new Set();
  const descendantIds = new Set();

  function visit(folderId) {
    if (visiting.has(folderId) || visited.has(folderId)) throw hierarchyError(false);
    visiting.add(folderId);
    visited.add(folderId);

    let count = 1;
    let height = 1;
    for (const child of childrenByParentId.get(folderId) || []) {
      const childId = normalizeFolderId(child.id);
      if (!childId) throw hierarchyError(false);
      descendantIds.add(childId);
      const childMetrics = visit(childId);
      count += childMetrics.count;
      height = Math.max(height, childMetrics.height + 1);
    }

    visiting.delete(folderId);
    return { count, height };
  }

  const metrics = visit(sourceId);
  descendantIds.delete(sourceId);
  return {
    descendantCount: metrics.count - 1,
    descendantIds,
    height: metrics.height,
  };
}

function normalizedName(name) {
  return String(name || '').trim().toLowerCase();
}

function sameParent(left, right) {
  return normalizeFolderId(left) === normalizeFolderId(right);
}

function createFolderMovement({ databasePath }) {
  if (!databasePath) throw new TypeError('databasePath is required');

  async function moveFolder({ folderId: rawFolderId, parentId: rawParentId, req }) {
    const folderId = normalizeFolderId(rawFolderId);
    const parentId = normalizeFolderId(rawParentId);
    let connection;
    let transactionOpen = false;

    try {
      connection = await openDatabase(databasePath);
      const { run, get, all } = databaseHelpers(connection);
      await run('PRAGMA busy_timeout=5000');
      await run('BEGIN IMMEDIATE');
      transactionOpen = true;

      const source = await get(`SELECT ${FOLDER_COLUMNS} FROM folders WHERE id=?`, [folderId]);
      if (!source) throw new FolderMoveError(404, 'Folder not found');
      if (source.archivedAt) throw new FolderMoveError(400, 'Archived folders cannot be moved');
      if (isClientUploadsFolderName(source.name)) {
        throw new FolderMoveError(400, 'System folders cannot be moved');
      }
      if (parentId && isVirtualFolderId(parentId)) {
        throw new FolderMoveError(400, 'Virtual folders cannot be used as parents');
      }
      if (parentId === folderId) {
        throw new FolderMoveError(400, 'A folder cannot be its own parent');
      }

      const folders = await all(`SELECT ${FOLDER_COLUMNS} FROM folders WHERE matterId=?`, [source.matterId]);
      const folderById = new Map(folders.map(folder => [normalizeFolderId(folder.id), folder]));
      loadActiveChain(source, folderById);

      const destination = parentId ? folderById.get(parentId) : null;
      if (parentId && !destination) {
        throw new FolderMoveError(400, 'Parent folder not found for this matter');
      }

      const destinationChain = destination
        ? loadActiveChain(destination, folderById, { destination: true })
        : [];
      if (destinationChain.some(folder => normalizeFolderId(folder.id) === folderId)) {
        throw new FolderMoveError(400, 'A folder cannot be moved beneath one of its descendants');
      }
      if (sameParent(source.parentId, parentId)) {
        throw new FolderMoveError(400, 'Folder is already in this location');
      }

      const subtree = subtreeMetrics(folderId, folders);
      if (destinationChain.length + subtree.height > MAX_FOLDER_DEPTH) {
        throw new FolderMoveError(400, `Folder hierarchy cannot exceed ${MAX_FOLDER_DEPTH} levels`);
      }

      const collision = folders.find(folder => (
        normalizeFolderId(folder.id) !== folderId
        && sameParent(folder.parentId, parentId)
        && normalizedName(folder.name) === normalizedName(source.name)
      ));
      if (collision) throw new FolderMoveError(400, 'Folder already exists in the destination');

      const previousParentId = normalizeFolderId(source.parentId);
      const previousParent = previousParentId ? folderById.get(previousParentId) : null;
      const update = await run('UPDATE folders SET parentId=? WHERE id=? AND matterId=?', [parentId, folderId, source.matterId]);
      if (update.changes !== 1) throw new FolderMoveError(409, 'Folder changed before it could be moved');

      const movedFolder = await get(`SELECT ${PUBLIC_FOLDER_COLUMNS} FROM folders WHERE id=?`, [folderId]);
      const { recordAuditEvent } = createAudit({ run, get });
      await recordAuditEvent(req, {
        action: 'folder_moved',
        entityType: 'folder',
        entityId: folderId,
        matterId: source.matterId,
        metadata: {
          folderName: source.name,
          matterId: source.matterId,
          previousParentId: previousParentId || null,
          previousParentName: previousParent?.name || null,
          newParentId: parentId || null,
          newParentName: destination?.name || null,
          descendantCount: subtree.descendantCount,
        },
      }, { throwOnError: true });

      await run('COMMIT');
      transactionOpen = false;
      return movedFolder;
    } catch (error) {
      if (transactionOpen && connection) {
        const { run } = databaseHelpers(connection);
        await run('ROLLBACK').catch(() => {});
        transactionOpen = false;
      }
      if (error instanceof FolderMoveError) throw error;
      if (error?.code === 'SQLITE_BUSY' || /database is locked/i.test(String(error?.message || ''))) {
        throw new FolderMoveError(409, 'Folder hierarchy is busy; try the move again');
      }
      throw error;
    } finally {
      if (connection) await closeDatabase(connection).catch(() => {});
    }
  }

  return { moveFolder };
}

module.exports = {
  FolderMoveError,
  createFolderMovement,
};
