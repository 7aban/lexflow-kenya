'use strict';

const MAX_FOLDER_DEPTH = 8;
const VIRTUAL_FOLDER_IDS = new Set(['all', 'uncategorised']);
const FOLDER_HIERARCHY_COLUMNS = 'id,matterId,name,parentId,archivedAt';

function normalizeFolderId(value) {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim();
  return normalized || null;
}

function isVirtualFolderId(value) {
  const normalized = normalizeFolderId(value);
  return normalized ? VIRTUAL_FOLDER_IDS.has(normalized.toLowerCase()) : false;
}

function isClientUploadsFolderName(name) {
  return String(name || '').trim().toLowerCase() === 'client uploads';
}

function createFolderHierarchy({ get }) {
  if (typeof get !== 'function') throw new TypeError('get is required');

  async function folderById(folderId, matterId = null) {
    if (matterId === null) {
      return get(`SELECT ${FOLDER_HIERARCHY_COLUMNS} FROM folders WHERE id=?`, [folderId]);
    }
    return get(`SELECT ${FOLDER_HIERARCHY_COLUMNS} FROM folders WHERE id=? AND matterId=?`, [folderId, matterId]);
  }

  async function loadChain(startFolder, matterId) {
    const chain = [];
    const visited = new Set();
    let current = startFolder;

    while (current) {
      const currentId = normalizeFolderId(current.id);
      if (!currentId || isVirtualFolderId(currentId) || current.matterId !== matterId || visited.has(currentId)) {
        return { ok: false, reason: 'unavailable' };
      }
      visited.add(currentId);
      chain.push(current);
      if (chain.length > MAX_FOLDER_DEPTH) return { ok: false, reason: 'max_depth' };

      const parentId = normalizeFolderId(current.parentId);
      if (!parentId) break;
      if (isVirtualFolderId(parentId)) return { ok: false, reason: 'unavailable' };

      current = await folderById(parentId);
      if (!current) return { ok: false, reason: 'unavailable' };
    }

    return { ok: true, chain };
  }

  async function validateParent(matterId, rawParentId) {
    const parentId = normalizeFolderId(rawParentId);
    if (!parentId) return { ok: true, parentId: null, depth: 1, chain: [] };
    if (isVirtualFolderId(parentId)) return { ok: false, reason: 'unavailable' };

    const parent = await folderById(parentId, matterId);
    if (!parent) return { ok: false, reason: 'unavailable' };

    const result = await loadChain(parent, matterId);
    if (!result.ok) return result;
    if (result.chain.some(folder => folder.archivedAt)) return { ok: false, reason: 'unavailable' };
    if (result.chain.some(folder => isClientUploadsFolderName(folder.name))) return { ok: false, reason: 'protected_parent' };
    if (result.chain.length >= MAX_FOLDER_DEPTH) return { ok: false, reason: 'max_depth' };

    return {
      ok: true,
      parentId,
      parent,
      depth: result.chain.length + 1,
      chain: result.chain,
    };
  }

  async function activeDestination(matterId, rawFolderId) {
    const folderId = normalizeFolderId(rawFolderId);
    if (!folderId || isVirtualFolderId(folderId)) return null;

    const folder = await folderById(folderId, matterId);
    if (!folder) return null;

    const result = await loadChain(folder, matterId);
    if (!result.ok || result.chain.some(item => item.archivedAt)) return null;
    if (result.chain.length > 1 && result.chain.some(item => isClientUploadsFolderName(item.name))) return null;
    return folder;
  }

  async function canRestore(folder) {
    const parentId = normalizeFolderId(folder?.parentId);
    if (!parentId) return true;
    if (isVirtualFolderId(parentId)) return false;

    const parent = await folderById(parentId, folder.matterId);
    if (!parent) return false;

    const result = await loadChain(parent, folder.matterId);
    if (!result.ok || result.chain.some(item => item.archivedAt)) return false;
    return !result.chain.some(item => isClientUploadsFolderName(item.name));
  }

  return {
    activeDestination,
    canRestore,
    validateParent,
  };
}

module.exports = {
  MAX_FOLDER_DEPTH,
  createFolderHierarchy,
  isClientUploadsFolderName,
  isVirtualFolderId,
  normalizeFolderId,
};
