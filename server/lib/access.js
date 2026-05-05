module.exports = ({ get, all }) => {
  const canAccessMatter = async (req, matterId) => {
    if (!matterId) return false;
    if (req.user?.role === 'client') {
      const matter = await get('SELECT id FROM matters WHERE id=? AND clientId=?', [matterId, req.user.clientId || '']);
      return Boolean(matter);
    }
    if (req.user?.role === 'advocate') {
      const matter = await get('SELECT id FROM matters WHERE id=? AND assignedTo=?', [matterId, req.user.fullName || '']);
      return Boolean(matter);
    }
    return true; // admin/assistant
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

  const canAccessClient = async (req, clientId) => {
    if (!clientId) return false;
    if (req.user?.role === 'client') return clientId === req.user.clientId;
    if (req.user?.role === 'advocate') {
      const matter = await get('SELECT id FROM matters WHERE clientId=? AND assignedTo=?', [clientId, req.user.fullName || '']);
      return Boolean(matter);
    }
    return true; // admin/assistant
  };

  const canAccessInvoice = async (req, invoiceId) => {
    if (!invoiceId) return false;
    if (req.user?.role === 'client') {
      const invoice = await get('SELECT id FROM invoices WHERE id=? AND clientId=?', [invoiceId, req.user.clientId || '']);
      return Boolean(invoice);
    }
    if (req.user?.role === 'advocate') {
      const invoice = await get(`SELECT i.id FROM invoices i
        JOIN matters m ON m.id=i.matterId
        WHERE i.id=? AND m.assignedTo=?`, [invoiceId, req.user.fullName || '']);
      return Boolean(invoice);
    }
    return true; // admin/assistant
  };

  const canAccessTask = async (req, taskId) => {
    if (!taskId) return false;
    if (req.user?.role === 'client') return false; // clients don't access tasks directly
    if (req.user?.role === 'advocate') {
      const task = await get(`SELECT t.id FROM tasks t
        JOIN matters m ON m.id=t.matterId
        WHERE t.id=? AND (t.assignee=? OR m.assignedTo=?)`, [taskId, req.user.fullName || '', req.user.fullName || '']);
      return Boolean(task);
    }
    return true; // admin/assistant
  };

  const canAccessAppearance = async (req, appearanceId) => {
    if (!appearanceId) return false;
    if (req.user?.role === 'client') return false; // clients don't access appearances directly
    if (req.user?.role === 'advocate') {
      const appearance = await get(`SELECT a.id FROM appearances a
        JOIN matters m ON m.id=a.matterId
        WHERE a.id=? AND (a.attorney=? OR m.assignedTo=?)`, [appearanceId, req.user.fullName || '', req.user.fullName || '']);
      return Boolean(appearance);
    }
    return true; // admin/assistant
  };

  const canAccessTimeEntry = async (req, entryId) => {
    if (!entryId) return false;
    if (req.user?.role === 'client') return false; // clients don't access time entries
    if (req.user?.role === 'advocate') {
      const entry = await get(`SELECT te.id FROM time_entries te
        JOIN matters m ON m.id=te.matterId
        WHERE te.id=? AND (te.attorney=? OR m.assignedTo=?)`, [entryId, req.user.fullName || '', req.user.fullName || '']);
      return Boolean(entry);
    }
    return true; // admin/assistant
  };

  const scopeMattersQuery = (user) => {
    if (user?.role === 'advocate') {
      return `assignedTo='${user.fullName || ''}'`;
    }
    return ''; // admin/assistant - no scoping
  };

  const scopeClientsQuery = (user) => {
    if (user?.role === 'advocate') {
      return `id IN (SELECT clientId FROM matters WHERE assignedTo='${user.fullName || ''}')`;
    }
    return ''; // admin/assistant - no scoping
  };

  return {
    canAccessMatter,
    canAccessNotice,
    canAccessConversation,
    canAccessDocument,
    canAccessClient,
    canAccessInvoice,
    canAccessTask,
    canAccessAppearance,
    canAccessTimeEntry,
    scopeMattersQuery,
    scopeClientsQuery,
  };
};
