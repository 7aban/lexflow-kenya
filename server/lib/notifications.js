module.exports = function createNotifications({ run, get, all, genId, canAccessCommunication }) {
  async function notifyStaff(type, matterId, title, body, clientId = '') {
    // Resolve the persisted association; caller-supplied IDs alone cannot grant
    // a recipient access or relabel another client's sensitive preview.
    if (matterId) {
      const matter = await get('SELECT clientId FROM matters WHERE id=?', [matterId]);
      if (!matter || (clientId && clientId !== matter.clientId)) return;
      clientId = matter.clientId;
    }
    if (!clientId || !(await get('SELECT id FROM clients WHERE id=?', [clientId]))) return;
    const staff = await all("SELECT id, role, fullName FROM users WHERE role IN ('admin','advocate','assistant')");
    const createdAt = new Date().toISOString();
    for (const user of staff) {
      if (!(await canAccessCommunication({ user }, { matterId: matterId || '', clientId }))) continue;
      await run('INSERT INTO notifications (id,userId,type,matterId,clientId,title,body,createdAt,readAt) VALUES (?,?,?,?,?,?,?,?,?)', [
        genId('NOTIF'),
        user.id,
        type || 'client_activity',
        matterId || '',
        clientId || '',
        title || 'Client activity',
        body || '',
        createdAt,
        '',
      ]);
    }
  }
  return { notifyStaff };
};
