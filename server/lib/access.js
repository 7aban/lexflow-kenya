module.exports = ({ get }) => {
  const canAccessMatter = async (req, matterId) => {
    if (req.user?.role !== 'client') return true;
    const matter = await get('SELECT id FROM matters WHERE id=? AND clientId=?', [matterId, req.user.clientId || '']);
    return Boolean(matter);
  };

  const canAccessNotice = async (req, noticeId) => {
    if (!noticeId) return false;
    if (req.user?.role !== 'client') return true;
    const notice = await get("SELECT id FROM firm_notices WHERE id=? AND (clientId IS NULL OR clientId='' OR clientId=?)", [noticeId, req.user.clientId || '']);
    return Boolean(notice);
  };

  const canAccessConversation = async (req, conversationId) => {
    if (!conversationId) return false;
    if (req.user?.role !== 'client') return true;
    const conversation = await get('SELECT id FROM conversations WHERE id=? AND clientId=?', [conversationId, req.user.clientId || '']);
    return Boolean(conversation);
  };

  const canAccessDocument = async (req, doc) => {
    if (!doc) return false;
    if (req.user?.role !== 'client') return true;
    if (doc.noticeId) return Number(doc.clientVisible || 0) === 1 && (await canAccessNotice(req, doc.noticeId));
    if (doc.messageId) {
      const thread = await get(`SELECT conv.id
        FROM messages msg
        JOIN conversations conv ON conv.id=msg.conversationId
        WHERE msg.id=? AND conv.clientId=?`, [doc.messageId, req.user.clientId || '']);
      if (thread) return true;
    }
    if (!doc.matterId || !(await canAccessMatter(req, doc.matterId))) return false;
    return doc.source === 'client' || Number(doc.clientVisible || 0) === 1;
  };

  return {
    canAccessMatter,
    canAccessNotice,
    canAccessConversation,
    canAccessDocument,
  };
};
