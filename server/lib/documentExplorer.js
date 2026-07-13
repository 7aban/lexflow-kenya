'use strict';

const crypto = require('crypto');
const { documentOrigin, documentUploaderDisplay, documentVisibility } = require('./documents');

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const MAX_CURSOR_LENGTH = 2048;
const MAX_FOLDER_DEPTH = 8;

const SORTS = Object.freeze({
  date_desc: { expression: "COALESCE(d.date,'')", direction: 'DESC' },
  date_asc: { expression: "COALESCE(d.date,'')", direction: 'ASC' },
  name_asc: { expression: "LOWER(COALESCE(NULLIF(d.displayName,''),d.name,''))", direction: 'ASC' },
  name_desc: { expression: "LOWER(COALESCE(NULLIF(d.displayName,''),d.name,''))", direction: 'DESC' },
  matter_asc: { expression: "LOWER(COALESCE(NULLIF(m.reference,''),m.title,''))", direction: 'ASC' },
  client_asc: { expression: "LOWER(COALESCE(c.name,''))", direction: 'ASC' },
});

const TYPE_FILTERS = new Map([
  ['pdf', 'pdf'],
  ['word', 'word'],
  ['image', 'image'],
  ['text', 'text'],
  ['file', 'file'],
]);
const STATUS_FILTERS = new Set(['active', 'archived', 'all']);
const SOURCE_FILTERS = new Set(['firm', 'client', 'generated']);
const ORIGIN_FILTERS = new Set(['firm', 'client', 'generated', 'message', 'notice']);
const VISIBILITY_FILTERS = new Set(['internal', 'client']);

const TYPE_SQL = `CASE
  WHEN LOWER(COALESCE(d.type,'')) IN ('pdf','word','image','text','file') THEN LOWER(d.type)
  ELSE 'file'
END`;
const SOURCE_SQL = `CASE
  WHEN LOWER(COALESCE(d.source,''))='client' THEN 'client'
  WHEN LOWER(COALESCE(d.source,''))='generated' THEN 'generated'
  ELSE 'firm'
END`;
const ORIGIN_SQL = `CASE
  WHEN d.messageId IS NOT NULL AND d.messageId<>'' THEN 'message'
  WHEN d.noticeId IS NOT NULL AND d.noticeId<>'' THEN 'notice'
  WHEN LOWER(COALESCE(d.source,''))='client' THEN 'client'
  WHEN LOWER(COALESCE(d.source,''))='generated' THEN 'generated'
  ELSE 'firm'
END`;

const CLIENT_VISIBILITY_SQL = `(
  LOWER(COALESCE(d.source,''))='client'
  OR COALESCE(d.clientVisible,0)=1
  OR EXISTS (
    SELECT 1
    FROM messages visibility_message
    JOIN conversations visibility_conversation ON visibility_conversation.id=visibility_message.conversationId
    WHERE visibility_message.id=d.messageId
  )
)`;

class DocumentExplorerError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'DocumentExplorerError';
    this.statusCode = statusCode;
  }
}

function normalizedText(value, { field, maxLength }) {
  const normalized = String(value || '').trim();
  if (normalized.length > maxLength) {
    throw new DocumentExplorerError(`${field} is too long`);
  }
  return normalized;
}

function normalizedEnum(value, allowed, field) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized && !allowed.has(normalized)) {
    throw new DocumentExplorerError(`Invalid ${field}`);
  }
  return normalized;
}

function parseLimit(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_LIMIT;
  if (!/^\d+$/.test(String(value))) throw new DocumentExplorerError('Invalid limit');
  return Math.min(MAX_LIMIT, Math.max(1, Number(value)));
}

function parseQuery(query = {}) {
  const status = String(query.status || 'active').trim().toLowerCase();
  if (!STATUS_FILTERS.has(status)) throw new DocumentExplorerError('Invalid status');

  const sort = String(query.sort || 'date_desc').trim().toLowerCase();
  if (!Object.hasOwn(SORTS, sort)) throw new DocumentExplorerError('Invalid sort');

  const type = normalizedEnum(query.type, new Set(TYPE_FILTERS.keys()), 'type');
  const source = normalizedEnum(query.source, SOURCE_FILTERS, 'source');
  const origin = normalizedEnum(query.origin, ORIGIN_FILTERS, 'origin');
  const visibility = normalizedEnum(query.visibility, VISIBILITY_FILTERS, 'visibility');

  return {
    q: normalizedText(query.q, { field: 'Search query', maxLength: 160 }),
    matterId: normalizedText(query.matterId, { field: 'matterId', maxLength: 180 }),
    clientId: normalizedText(query.clientId, { field: 'clientId', maxLength: 180 }),
    folderId: normalizedText(query.folderId, { field: 'folderId', maxLength: 180 }),
    type,
    source,
    origin,
    visibility,
    status,
    sort,
    limit: parseLimit(query.limit),
    cursor: normalizedText(query.cursor, { field: 'Cursor', maxLength: MAX_CURSOR_LENGTH }),
  };
}

function escapeLike(value) {
  return String(value || '')
    .replace(/!/g, '!!')
    .replace(/%/g, '!%')
    .replace(/_/g, '!_');
}

function folderPathCte(documentAlias = 'd') {
  return `WITH RECURSIVE folder_path(id,matterId,name,parentId,archivedAt,depth) AS (
    SELECT path_folder.id,path_folder.matterId,path_folder.name,path_folder.parentId,path_folder.archivedAt,0
    FROM folders path_folder
    WHERE path_folder.id=${documentAlias}.folderId AND path_folder.matterId=${documentAlias}.matterId
    UNION ALL
    SELECT path_parent.id,path_parent.matterId,path_parent.name,path_parent.parentId,path_parent.archivedAt,folder_path.depth+1
    FROM folders path_parent
    JOIN folder_path ON path_parent.id=folder_path.parentId AND path_parent.matterId=folder_path.matterId
    WHERE folder_path.depth<${MAX_FOLDER_DEPTH}
  )`;
}

function accessibleFolderPathPredicate(role, documentAlias = 'd') {
  if (role !== 'assistant') {
    return `EXISTS (
      SELECT 1
      FROM folders scoped_folder
      WHERE scoped_folder.id=${documentAlias}.folderId AND scoped_folder.matterId=${documentAlias}.matterId
    )`;
  }
  return `EXISTS (
    ${folderPathCte(documentAlias)}
    SELECT 1
    FROM folder_path direct_path
    WHERE direct_path.depth=0
      AND NOT EXISTS (SELECT 1 FROM folder_path hidden_path WHERE hidden_path.archivedAt IS NOT NULL)
      AND EXISTS (SELECT 1 FROM folder_path root_path WHERE root_path.parentId IS NULL OR root_path.parentId='')
  )`;
}

function folderPathSearchSql(role) {
  const visibilityGuard = role === 'assistant'
    ? `AND NOT EXISTS (SELECT 1 FROM folder_path hidden_path WHERE hidden_path.archivedAt IS NOT NULL)
       AND EXISTS (SELECT 1 FROM folder_path root_path WHERE root_path.parentId IS NULL OR root_path.parentId='')`
    : '';
  return `EXISTS (
    ${folderPathCte('d')}
    SELECT 1
    FROM folder_path matching_path
    WHERE LOWER(COALESCE(matching_path.name,'')) LIKE ? ESCAPE '!'
      ${visibilityGuard}
  )`;
}

function originSql(origin) {
  return `${ORIGIN_SQL}='${origin}'`;
}

function statusSql(status) {
  if (status === 'archived') return 'd.deletedAt IS NOT NULL';
  if (status === 'all') return '1=1';
  return 'd.deletedAt IS NULL';
}

function cursorScopeFingerprint(req, filters) {
  const payload = {
    userId: req.user?.userId || req.user?.id || '',
    role: req.user?.role || '',
    advocate: req.user?.role === 'advocate' ? req.user.fullName || '' : '',
    q: filters.q,
    matterId: filters.matterId,
    clientId: filters.clientId,
    folderId: filters.folderId,
    type: filters.type,
    source: filters.source,
    origin: filters.origin,
    visibility: filters.visibility,
    status: filters.status,
    sort: filters.sort,
    limit: filters.limit,
  };
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('base64url');
}

function cursorSignature(encodedPayload, secret) {
  return crypto.createHmac('sha256', secret).update(encodedPayload).digest('base64url');
}

function encodeCursor({ sort, scope, key, id }, secret) {
  const encodedPayload = Buffer.from(JSON.stringify({ v: 1, sort, scope, key: String(key || ''), id: String(id || '') })).toString('base64url');
  return `${encodedPayload}.${cursorSignature(encodedPayload, secret)}`;
}

function decodeCursor(cursor, { sort, scope, secret }) {
  if (!cursor) return null;
  try {
    const [encodedPayload, suppliedSignature, extra] = cursor.split('.');
    if (!encodedPayload || !suppliedSignature || extra) throw new Error('Malformed cursor');
    const expected = Buffer.from(cursorSignature(encodedPayload, secret));
    const supplied = Buffer.from(suppliedSignature);
    if (expected.length !== supplied.length || !crypto.timingSafeEqual(expected, supplied)) throw new Error('Invalid signature');
    const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
    if (payload.v !== 1 || payload.sort !== sort || payload.scope !== scope) throw new Error('Cursor scope mismatch');
    if (typeof payload.key !== 'string' || typeof payload.id !== 'string' || !payload.id || payload.id.length > 180 || payload.key.length > 500) {
      throw new Error('Invalid cursor values');
    }
    return payload;
  } catch {
    throw new DocumentExplorerError('Invalid cursor');
  }
}

async function loadFolderChains(all, rows) {
  const folderIds = [...new Set(rows.map(row => String(row.folderId || '')).filter(Boolean))];
  if (!folderIds.length) return new Map();
  const placeholders = folderIds.map(() => '?').join(',');
  const folders = await all(`WITH RECURSIVE ancestors(rootId,id,matterId,name,parentId,archivedAt,depth) AS (
      SELECT folder.id,folder.id,folder.matterId,folder.name,folder.parentId,folder.archivedAt,0
      FROM folders folder
      WHERE folder.id IN (${placeholders})
      UNION ALL
      SELECT ancestors.rootId,parent.id,parent.matterId,parent.name,parent.parentId,parent.archivedAt,ancestors.depth+1
      FROM ancestors
      JOIN folders parent ON parent.id=ancestors.parentId AND parent.matterId=ancestors.matterId
      WHERE ancestors.depth<${MAX_FOLDER_DEPTH}
    )
    SELECT rootId,id,matterId,name,parentId,archivedAt,depth
    FROM ancestors
    ORDER BY rootId,depth`, folderIds);
  const byRoot = new Map();
  for (const folder of folders) {
    const key = String(folder.rootId || '');
    if (!byRoot.has(key)) byRoot.set(key, []);
    byRoot.get(key).push(folder);
  }
  return byRoot;
}

function unavailableLocation(status = 'unavailable') {
  return {
    folder: null,
    folderPath: [],
    folderPathLabel: status === 'archived_hidden' ? 'Archived location' : 'Location unavailable',
    location: {
      status,
      folderArchived: status === 'archived_hidden',
      pathIncomplete: status === 'unavailable',
    },
  };
}

function reconstructFolderLocation(row, chains, role) {
  const folderId = String(row.folderId || '');
  if (!folderId) {
    return {
      folder: null,
      folderPath: [],
      folderPathLabel: 'Uncategorised',
      location: { status: 'uncategorised', folderArchived: false, pathIncomplete: false },
    };
  }

  const chain = chains.get(folderId) || [];
  const folderById = new Map(chain.map(folder => [String(folder.id), folder]));
  const direct = folderById.get(folderId);
  if (!direct || String(direct.matterId || '') !== String(row.matterId || '')) return unavailableLocation();

  const path = [];
  const seen = new Set();
  let current = direct;
  let pathIncomplete = false;
  while (current) {
    const currentId = String(current.id || '');
    if (!currentId || seen.has(currentId) || String(current.matterId || '') !== String(row.matterId || '')) {
      pathIncomplete = true;
      break;
    }
    seen.add(currentId);
    path.push(current);
    const parentId = String(current.parentId || '');
    if (!parentId) break;
    if (path.length > MAX_FOLDER_DEPTH) {
      pathIncomplete = true;
      break;
    }
    const parent = folderById.get(parentId);
    if (!parent) {
      pathIncomplete = true;
      break;
    }
    current = parent;
  }
  path.reverse();

  const folderArchived = path.some(folder => Boolean(folder.archivedAt));
  if (role === 'assistant' && folderArchived) return unavailableLocation('archived_hidden');

  const publicPath = path.map(folder => ({
    id: String(folder.id),
    name: String(folder.name || 'Folder'),
    archived: Boolean(folder.archivedAt),
  }));
  return {
    folder: {
      id: String(direct.id),
      name: String(direct.name || 'Folder'),
      archived: Boolean(direct.archivedAt),
    },
    folderPath: publicPath,
    folderPathLabel: `${pathIncomplete ? '… / ' : ''}${publicPath.map(folder => folder.name).join(' / ')}`,
    location: {
      status: pathIncomplete ? 'unavailable' : folderArchived ? 'archived' : 'active',
      folderArchived,
      pathIncomplete,
    },
  };
}

function publicExplorerDocument(row, location) {
  const displayName = String(row.displayName || row.name || 'Document');
  const uploader = documentUploaderDisplay(row);
  const generated = String(row.source || '').toLowerCase() === 'generated'
    || row.templateName
    || row.generatedAt;
  return {
    id: String(row.id),
    displayName,
    name: String(row.name || displayName),
    type: String(row.type || 'File'),
    mimeType: String(row.mimeType || 'application/octet-stream'),
    date: String(row.date || ''),
    size: String(row.size || ''),
    source: String(row.explorerSource || row.source || 'firm').toLowerCase() || 'firm',
    origin: documentOrigin(row),
    visibility: documentVisibility(row),
    uploaderDisplay: uploader,
    generatedAt: String(row.generatedAt || ''),
    generation: generated ? {
      templateName: String(row.templateName || ''),
      generatedBy: uploader,
      generatedAt: String(row.generatedAt || ''),
      version: Number(row.version || 1),
    } : null,
    archived: Boolean(row.deletedAt),
    archivedAt: row.deletedAt ? String(row.deletedAt) : null,
    matter: {
      id: String(row.matterId),
      reference: String(row.matterReference || ''),
      title: String(row.matterTitle || ''),
      stage: String(row.matterStage || ''),
    },
    client: row.matterClientId ? {
      id: String(row.matterClientId),
      name: String(row.clientName || ''),
    } : null,
    ...location,
  };
}

const FILTER_OPTION_LABELS = Object.freeze({
  types: Object.freeze({ pdf: 'PDF', word: 'Word', image: 'Image', text: 'Text', file: 'Other file' }),
  sources: Object.freeze({ firm: 'Firm', client: 'Client', generated: 'Generated' }),
  origins: Object.freeze({ firm: 'Firm upload', client: 'Client upload', generated: 'Generated', message: 'Message attachment', notice: 'Notice attachment' }),
  visibilities: Object.freeze({ internal: 'Internal', client: 'Client visible' }),
});

function orderedValueOptions(values, labels) {
  const available = new Set(values.map(value => String(value || '')).filter(Boolean));
  return Object.entries(labels)
    .filter(([value]) => available.has(value))
    .map(([value, label]) => ({ value, label }));
}

async function loadFilterOptions(all, access, status) {
  const where = [statusSql(status), "d.matterId IS NOT NULL", "d.matterId<>''", access.sql];
  const joinedScope = `FROM documents d
    INNER JOIN matters m ON m.id=d.matterId
    LEFT JOIN clients c ON c.id=m.clientId
    WHERE ${where.join('\n AND ')}`;
  const params = [...access.params];
  const [matterRows, clientRows, dimensionRows] = await Promise.all([
    all(`SELECT DISTINCT m.id,m.reference,m.title,m.clientId
      ${joinedScope}
      ORDER BY LOWER(COALESCE(NULLIF(m.reference,''),m.title,'')),m.id`, params),
    all(`SELECT DISTINCT c.id,c.name
      ${joinedScope}
      AND c.id IS NOT NULL AND c.id<>''
      ORDER BY LOWER(COALESCE(c.name,'')),c.id`, params),
    all(`SELECT DISTINCT
        ${TYPE_SQL} typeValue,
        ${SOURCE_SQL} sourceValue,
        ${ORIGIN_SQL} originValue,
        CASE WHEN ${CLIENT_VISIBILITY_SQL} THEN 'client' ELSE 'internal' END visibilityValue
      ${joinedScope}`, params),
  ]);

  return {
    clients: clientRows.map(row => ({
      id: String(row.id),
      name: String(row.name || ''),
    })),
    matters: matterRows.map(row => ({
      id: String(row.id),
      reference: String(row.reference || ''),
      title: String(row.title || ''),
      clientId: String(row.clientId || ''),
    })),
    types: orderedValueOptions(dimensionRows.map(row => row.typeValue), FILTER_OPTION_LABELS.types),
    sources: orderedValueOptions(dimensionRows.map(row => row.sourceValue), FILTER_OPTION_LABELS.sources),
    origins: orderedValueOptions(dimensionRows.map(row => row.originValue), FILTER_OPTION_LABELS.origins),
    visibilities: orderedValueOptions(dimensionRows.map(row => row.visibilityValue), FILTER_OPTION_LABELS.visibilities),
  };
}

function createDocumentExplorer({ all, matterAccessScopeSql, cursorSecret }) {
  if (typeof all !== 'function' || typeof matterAccessScopeSql !== 'function') {
    throw new Error('Document Explorer requires database and access helpers');
  }
  const secret = String(cursorSecret || '');
  if (!secret) throw new Error('Document Explorer cursor secret is required');

  return {
    async list(req, rawQuery = {}) {
      const filters = parseQuery(rawQuery);
      if (filters.status !== 'active' && !['admin', 'advocate'].includes(req.user?.role)) {
        throw new DocumentExplorerError('Archived document access denied', 403);
      }
      const access = matterAccessScopeSql(req, 'm');
      const sort = SORTS[filters.sort];
      const scope = cursorScopeFingerprint(req, filters);
      const cursor = decodeCursor(filters.cursor, { sort: filters.sort, scope, secret });
      const where = [statusSql(filters.status), "d.matterId IS NOT NULL", "d.matterId<>''", access.sql];
      const params = [...access.params];

      if (filters.matterId) {
        where.push('d.matterId=?');
        params.push(filters.matterId);
      }
      if (filters.clientId) {
        where.push('m.clientId=?');
        params.push(filters.clientId);
      }
      if (filters.folderId && filters.folderId !== 'all') {
        if (filters.folderId === 'uncategorised') {
          where.push("(d.folderId IS NULL OR d.folderId='')");
        } else {
          where.push(`d.folderId=? AND ${accessibleFolderPathPredicate(req.user?.role, 'd')}`);
          params.push(filters.folderId);
        }
      }
      if (filters.type) {
        where.push(`${TYPE_SQL}=?`);
        params.push(TYPE_FILTERS.get(filters.type));
      }
      if (filters.source) {
        where.push(`${SOURCE_SQL}=?`);
        params.push(filters.source);
      }
      if (filters.origin) where.push(originSql(filters.origin));
      if (filters.visibility) where.push(filters.visibility === 'client' ? CLIENT_VISIBILITY_SQL : `NOT ${CLIENT_VISIBILITY_SQL}`);

      if (filters.q) {
        const pattern = `%${escapeLike(filters.q.toLowerCase())}%`;
        where.push(`(
          LOWER(COALESCE(NULLIF(d.displayName,''),d.name,'')) LIKE ? ESCAPE '!'
          OR LOWER(COALESCE(d.name,'')) LIKE ? ESCAPE '!'
          OR LOWER(COALESCE(m.reference,'')) LIKE ? ESCAPE '!'
          OR LOWER(COALESCE(m.title,'')) LIKE ? ESCAPE '!'
          OR LOWER(COALESCE(c.name,'')) LIKE ? ESCAPE '!'
          OR ${folderPathSearchSql(req.user?.role)}
        )`);
        params.push(pattern, pattern, pattern, pattern, pattern, pattern);
      }

      if (cursor) {
        const comparison = sort.direction === 'ASC' ? '>' : '<';
        where.push(`(${sort.expression} ${comparison} ? OR (${sort.expression}=? AND d.id ${comparison} ?))`);
        params.push(cursor.key, cursor.key, cursor.id);
      }

      const [rows, filterOptions] = await Promise.all([all(`SELECT
          d.id,d.matterId,d.name,d.displayName,d.type,d.mimeType,d.date,d.size,d.source,d.folderId,
          d.messageId,d.noticeId,d.clientVisible,d.templateName,d.generatedBy,d.generatedAt,d.version,
          d.deletedAt,${SOURCE_SQL} explorerSource,
          m.reference matterReference,m.title matterTitle,m.stage matterStage,m.clientId matterClientId,
          c.name clientName,u.fullName uploaderUserName,
          CASE WHEN EXISTS (
            SELECT 1
            FROM messages response_message
            JOIN conversations response_conversation ON response_conversation.id=response_message.conversationId
            WHERE response_message.id=d.messageId
          ) THEN 1 ELSE 0 END messageClientVisible,
          ${sort.expression} sortKey
        FROM documents d
        INNER JOIN matters m ON m.id=d.matterId
        LEFT JOIN clients c ON c.id=m.clientId
        LEFT JOIN users u ON u.id=d.uploadedBy
        WHERE ${where.join('\n AND ')}
        ORDER BY ${sort.expression} ${sort.direction},d.id ${sort.direction}
        LIMIT ?`, [...params, filters.limit + 1]), loadFilterOptions(all, access, filters.status)]);

      const hasMore = rows.length > filters.limit;
      const pageRows = hasMore ? rows.slice(0, filters.limit) : rows;
      const chains = await loadFolderChains(all, pageRows);
      const items = pageRows.map(row => publicExplorerDocument(
        row,
        reconstructFolderLocation(row, chains, req.user?.role),
      ));
      const lastRow = pageRows.at(-1);
      const nextCursor = hasMore && lastRow
        ? encodeCursor({ sort: filters.sort, scope, key: lastRow.sortKey, id: lastRow.id }, secret)
        : null;

      return {
        items,
        limit: filters.limit,
        sort: filters.sort,
        status: filters.status,
        hasMore,
        nextCursor,
        filterOptions,
      };
    },
  };
}

module.exports = {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  SORTS,
  DocumentExplorerError,
  createDocumentExplorer,
};
