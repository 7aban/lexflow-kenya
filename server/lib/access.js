module.exports = ({ get, all }) => {
  const matterAccessScopeSql = (req, alias = 'm') => {
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(alias)) {
      throw new Error('Invalid matter table alias');
    }
    if (req.user?.role === 'advocate') {
      return {
        sql: `${alias}.assignedTo=?`,
        params: [req.user.fullName || ''],
      };
    }
    if (req.user?.role === 'admin' || req.user?.role === 'assistant') {
      return { sql: '1=1', params: [] };
    }
    return { sql: '1=0', params: [] };
  };

  // Client access derives from matter ownership, never delegated tasks/appearances.
  // clientColumn also supports inherently client-level records such as KYC.
  const clientAccessScopeSql = (req, alias = 'c', clientColumn = 'id') => {
    if (![alias, clientColumn].every(name => /^[A-Za-z][A-Za-z0-9_]*$/.test(name))) throw new Error('Invalid client scope identifier');
    if (req.user?.role === 'admin' || req.user?.role === 'assistant') return { sql: '1=1', params: [] };
    if (req.user?.role === 'client') return { sql: `${alias}.${clientColumn}=?`, params: [req.user.clientId || ''] };
    const scope = matterAccessScopeSql(req, 'client_scope_m');
    return {
      sql: `EXISTS (SELECT 1 FROM matters client_scope_m WHERE client_scope_m.clientId=${alias}.${clientColumn} AND ${scope.sql})`,
      params: scope.params,
    };
  };

  // Apply before ordering, limiting or aggregating child records. An accessible
  // client does not authorize records from its other matters or unlinked records.
  const matterRecordAccessScopeSql = (req, alias = 'r') => {
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(alias)) throw new Error('Invalid matter record alias');
    if (req.user?.role === 'admin' || req.user?.role === 'assistant') return { sql: '1=1', params: [] };
    const scope = matterAccessScopeSql(req, 'record_scope_m');
    return {
      sql: `EXISTS (SELECT 1 FROM matters record_scope_m WHERE record_scope_m.id=${alias}.matterId AND ${scope.sql})`,
      params: scope.params,
    };
  };

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
    if (req.user?.role === 'client') {
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
    }

    if (doc.matterId) return canAccessMatter(req, doc.matterId);
    if (doc.noticeId) return canAccessNotice(req, doc.noticeId);
    if (doc.messageId) {
      const message = await get('SELECT conversationId FROM messages WHERE id=?', [doc.messageId]);
      return Boolean(message?.conversationId) && canAccessConversation(req, message.conversationId);
    }
    return false;
  };

  const canAccessClient = async (req, clientId) => {
    if (!clientId) return false;
    if (req.user?.role === 'client') return clientId === req.user.clientId;
    if (req.user?.role === 'advocate') {
      const scope = clientAccessScopeSql(req);
      return Boolean(await get(`SELECT c.id FROM clients c WHERE c.id=? AND ${scope.sql}`, [clientId, ...scope.params]));
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

  const canAccessDocumentRequest = async (req, request) => {
    if (!request) return false;
    if (req.user?.role === 'admin' || req.user?.role === 'assistant') return true;
    if (req.user?.role === 'advocate') {
      const matter = await get('SELECT id FROM matters WHERE id=? AND assignedTo=?', [request.matterId || '', req.user.fullName || '']);
      return Boolean(matter);
    }
    if (req.user?.role === 'client') {
      return request.clientId === req.user.clientId;
    }
    return false;
  };

  const isBillingVisibleFor = async (req) => {
    if (req.user?.role !== 'advocate') return true;
    const row = await get('SELECT advocateBillingVisibility FROM firm_settings LIMIT 1');
    return row ? Number(row.advocateBillingVisibility) !== 0 : true;
  };

  return {
    matterAccessScopeSql,
    clientAccessScopeSql,
    matterRecordAccessScopeSql,
    canAccessMatter,
    canAccessNotice,
    canAccessConversation,
    canAccessDocument,
    canAccessClient,
    canAccessInvoice,
    canAccessTask,
    canAccessAppearance,
    canAccessTimeEntry,
    canAccessDocumentRequest,
    isBillingVisibleFor,
  };
};
