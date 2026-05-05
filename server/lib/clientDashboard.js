module.exports = ({ get, all, documentListColumns, clientDocumentVisibilitySql, publicDocument, publicNotice }) => {
  async function getClientDashboardData(clientId, req) {
    const client = await get('SELECT * FROM clients WHERE id=?', [clientId || '']);
    const matters = await all('SELECT m.*, c.name clientName FROM matters m LEFT JOIN clients c ON c.id=m.clientId WHERE m.clientId=? ORDER BY m.openDate DESC', [clientId || '']);
    const matterIds = matters.map(m => m.id);
    const placeholders = matterIds.map(() => '?').join(',');
    const documents = matterIds.length ? await all(`SELECT ${documentListColumns()} FROM documents d LEFT JOIN folders f ON f.id=d.folderId WHERE d.matterId IN (${placeholders}) AND ${clientDocumentVisibilitySql('d')} ORDER BY d.date DESC`, [...matterIds, clientId || '']) : [];
    const invoices = await all(`SELECT i.*, m.title matterTitle, m.reference FROM invoices i LEFT JOIN matters m ON m.id=i.matterId WHERE i.clientId=? ORDER BY i.date DESC`, [clientId || '']);
    const appearances = matterIds.length ? await all(`SELECT * FROM appearances WHERE matterId IN (${placeholders}) ORDER BY date`, matterIds) : [];
    const notices = await all("SELECT * FROM firm_notices WHERE clientId IS NULL OR clientId='' OR clientId=? ORDER BY createdAt DESC LIMIT 20", [clientId || '']);
    const noticeIds = notices.map(notice => notice.id);
    const noticeAttachments = noticeIds.length ? await all(`SELECT ${documentListColumns()} FROM documents d LEFT JOIN folders f ON f.id=d.folderId WHERE d.noticeId IN (${noticeIds.map(() => '?').join(',')}) AND COALESCE(d.clientVisible,0)=1 ORDER BY d.date DESC`, noticeIds) : [];
    const paymentProofs = await all('SELECT id,invoiceId,matterId,clientId,method,reference,amount,note,fileName,mimeType,size,createdAt FROM payment_proofs WHERE clientId=? ORDER BY createdAt DESC', [clientId || '']);
    return {
      client,
      matters,
      documents: documents.map(publicDocument),
      invoices,
      notes: [],
      appearances,
      notices: notices.map(notice => publicNotice(
        notice,
        noticeAttachments.filter(doc => doc.noticeId === notice.id).map(doc => publicDocument(doc, { client: true })),
        req,
      )),
      paymentProofs,
    };
  }

  return { getClientDashboardData };
};
