const CLIENT_VISIBILITY_REASON_LABELS = Object.freeze({
  archived: 'Restore this document before changing client access.',
  message_context: 'Client access is managed by the linked conversation.',
  notice_context: 'Client access is managed by the linked notice.',
  client_upload: 'Client uploads remain available to the client.',
  outside_matter_context: 'Client access is managed outside matter documents.',
  context_managed: 'Client access is managed by another document context.',
});

export function effectiveDocumentVisibility(document = {}) {
  const effective = String(document.visibility || '').trim().toLowerCase();
  if (effective === 'client' || effective === 'internal') return effective;
  const origin = String(document.origin || '').trim().toLowerCase();
  if (String(document.source || '').trim().toLowerCase() === 'client'
    || origin === 'client'
    || document.clientVisible === true
    || Number(document.clientVisible || 0) === 1
    || Boolean(document.messageId)
    || origin === 'message') {
    return 'client';
  }
  return 'internal';
}

export function isDocumentClientVisible(document = {}) {
  return effectiveDocumentVisibility(document) === 'client';
}

export function documentClientVisibilityCapability(document = {}, { archived = false } = {}) {
  if (archived || document.archived || document.deletedAt) {
    return { mutable: false, ineligibilityReason: 'archived' };
  }
  const serverCapability = document?.capabilities?.clientVisibility;
  if (typeof serverCapability?.mutable === 'boolean') {
    return {
      mutable: serverCapability.mutable,
      ineligibilityReason: serverCapability.mutable
        ? null
        : String(serverCapability.ineligibilityReason || 'context_managed'),
    };
  }

  // Compatibility for disposable UI fixtures and responses cached before the
  // capability projection. The server endpoint remains authoritative.
  const origin = String(document.origin || '').trim().toLowerCase();
  if (document.messageId || origin === 'message') {
    return { mutable: false, ineligibilityReason: 'message_context' };
  }
  if (document.noticeId || origin === 'notice') {
    return { mutable: false, ineligibilityReason: 'notice_context' };
  }
  if (String(document.source || '').trim().toLowerCase() === 'client' || origin === 'client') {
    return { mutable: false, ineligibilityReason: 'client_upload' };
  }
  return { mutable: true, ineligibilityReason: null };
}

export function documentClientVisibilityReason(document = {}, options = {}) {
  const reason = documentClientVisibilityCapability(document, options).ineligibilityReason;
  return reason ? CLIENT_VISIBILITY_REASON_LABELS[reason] || CLIENT_VISIBILITY_REASON_LABELS.context_managed : '';
}

export function staffDocumentVisibilityLabel(document = {}) {
  return isDocumentClientVisible(document) ? 'Client-visible' : 'Staff-only';
}
