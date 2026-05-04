const { genId } = require('./utils');

module.exports = ({ run }) => {
  async function logClientActivity({ clientId = '', matterId = '', userId = '', action = '', summary = '', entityType = '', entityId = '' }) {
    if (!clientId && !matterId) return;
    await run('INSERT INTO client_activity (id,clientId,matterId,userId,action,summary,entityType,entityId,createdAt) VALUES (?,?,?,?,?,?,?,?,?)', [
      genId('CACT'),
      clientId || '',
      matterId || '',
      userId || '',
      action || '',
      summary || '',
      entityType || '',
      entityId || '',
      new Date().toISOString(),
    ]);
  }

  async function logAudit(req, action, entityType, entityId, summary) {
    if (!req.user) return;
    await run('INSERT INTO audit_logs (id,userId,userName,role,action,entityType,entityId,summary,createdAt) VALUES (?,?,?,?,?,?,?,?,?)', [
      genId('AUD'),
      req.user.userId || '',
      req.user.fullName || '',
      req.user.role || '',
      action,
      entityType,
      entityId || '',
      summary || '',
      new Date().toISOString(),
    ]);
  }

  return { logClientActivity, logAudit };
};
