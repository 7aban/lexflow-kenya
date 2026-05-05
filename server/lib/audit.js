const { genId } = require('./utils');

module.exports = ({ run, get }) => {
  // Helper to safely get IP address
  function getIpAddress(req) {
    if (!req) return '';
    return req.headers?.['x-forwarded-for']?.split(',')[0]?.trim() ||
           req.ip ||
           req.socket?.remoteAddress ||
           '';
  }

  // Helper to safely get user agent
  function getUserAgent(req) {
    return req?.headers?.['user-agent'] || '';
  }

  // Helper to safely extract actor info
  function getActorInfo(req) {
    if (!req?.user) {
      return {
        actorUserId: '',
        actorRole: 'system',
        actorEmail: 'system@lexflow.co.ke',
      };
    }
    return {
      actorUserId: req.user.id || '',
      actorRole: req.user.role || '',
      actorEmail: req.user.email || '',
    };
  }

  // Helper to redact sensitive data from metadata
  function redactSensitive(metadata) {
    if (!metadata || typeof metadata !== 'object') return metadata;
    const sensitive = ['password', 'token', 'jwt', 'secret', 'document_text', 'message_body', 'legal_advice'];
    const redacted = { ...metadata };
    for (const key of Object.keys(redacted)) {
      if (sensitive.some(s => key.toLowerCase().includes(s))) {
        redacted[key] = '[REDACTED]';
      }
    }
    return redacted;
  }

  // Main audit event recording function
  async function recordAuditEvent(req, { action, entityType, entityId, matterId, clientId, metadata = {} }) {
    try {
      // Ensure audit_events table exists (handles test environment where initDb may not run)
      await run(`CREATE TABLE IF NOT EXISTS audit_events (
        id TEXT PRIMARY KEY,
        timestamp TEXT NOT NULL,
        actor_user_id TEXT,
        actor_role TEXT,
        actor_email TEXT,
        action TEXT NOT NULL,
        entity_type TEXT,
        entity_id TEXT,
        matter_id TEXT,
        client_id TEXT,
        ip_address TEXT,
        user_agent TEXT,
        metadata_json TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )`);
      
      const { actorUserId, actorRole, actorEmail } = getActorInfo(req);
      const ipAddress = getIpAddress(req);
      const userAgent = getUserAgent(req);
      const safeMetadata = redactSensitive(metadata);
      const metadataJson = JSON.stringify(safeMetadata);

      await run(`INSERT INTO audit_events (id, timestamp, actor_user_id, actor_role, actor_email, action, entity_type, entity_id, matter_id, client_id, ip_address, user_agent, metadata_json, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
        genId('AUD'),
        new Date().toISOString(),
        actorUserId,
        actorRole,
        actorEmail,
        action,
        entityType || '',
        entityId || '',
        matterId || '',
        clientId || '',
        ipAddress,
        userAgent,
        metadataJson,
        new Date().toISOString(),
      ]);
    } catch (err) {
      // Audit failure should not crash the main request
      // Table might not exist in test environment - that's OK
      if (!err.message?.includes('no such table')) {
        console.error('Audit logging failed:', err.message);
      }
    }
  }

  // Wrapper to use existing logAudit-style calls
  async function logAudit(req, action, entityType, entityId, summary) {
    try {
      if (!req?.user) return;
      await run(`INSERT INTO audit_logs (id, userId, userName, role, action, entityType, entityId, summary, createdAt) VALUES (?,?,?,?,?,?,?)`, [
        genId('AUD'),
        req.user.id || '',
        req.user.fullName || '',
        req.user.role || '',
        action,
        entityType || '',
        entityId || '',
        summary || '',
        new Date().toISOString(),
      ]);
    } catch (err) {
      console.error('Legacy audit logging failed:', err.message);
    }
  }

  return { recordAuditEvent, logAudit, getIpAddress, getUserAgent };
};
