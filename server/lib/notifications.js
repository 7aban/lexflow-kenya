module.exports = function createNotifications({ run, all, genId }) {
  async function notifyStaff(type, matterId, title, body, clientId = '') {
    const staff = await all("SELECT id FROM users WHERE role IN ('admin','advocate','assistant')");
    const createdAt = new Date().toISOString();
    for (const user of staff) {
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
