const BLOCKED_PATH_PARTS = new Set(['__proto__', 'prototype', 'constructor']);
const TOKEN_PATTERN = /{{\s*([^{}]+?)\s*}}/g;

function text(value) {
  return value === undefined || value === null ? '' : String(value);
}

function uniqueInOrder(values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    if (!seen.has(value)) {
      seen.add(value);
      result.push(value);
    }
  }
  return result;
}

function listTemplateTokens(bodyMarkup) {
  const tokens = [];
  const source = text(bodyMarkup);
  for (const match of source.matchAll(TOKEN_PATTERN)) {
    const token = String(match[1] || '').trim();
    if (token) tokens.push(token);
  }
  return uniqueInOrder(tokens);
}

function buildTemplateMergeContext({ firm = {}, matter = {}, client = {}, user = {}, today = '' } = {}) {
  return {
    firm: {
      name: text(firm.name),
      address: text(firm.address),
      email: text(firm.email),
      phone: text(firm.phone),
      websiteURL: text(firm.websiteURL),
    },
    matter: {
      title: text(matter.title),
      reference: text(matter.reference),
      caseNo: text(matter.caseNo),
      court: text(matter.court),
      practiceArea: text(matter.practiceArea),
      stage: text(matter.stage),
      assignedAdvocate: text(matter.assignedAdvocate || matter.assignedTo),
    },
    client: {
      name: text(client.name),
      email: text(client.email),
      phone: text(client.phone),
    },
    today: text(today),
    user: {
      fullName: text(user.fullName || user.name),
      role: text(user.role),
    },
  };
}

function resolveToken(token, context) {
  const parts = String(token || '').split('.');
  if (!parts.length || parts.some(part => !part || BLOCKED_PATH_PARTS.has(part))) {
    return { resolved: false, value: '' };
  }

  let current = context;
  for (const part of parts) {
    if (!current || !Object.prototype.hasOwnProperty.call(current, part)) {
      return { resolved: false, value: '' };
    }
    current = current[part];
  }

  if (current === undefined || current === null) return { resolved: false, value: '' };
  return { resolved: true, value: text(current) };
}

function mergeTemplateMarkup(bodyMarkup, context = {}) {
  const source = text(bodyMarkup);
  const tokens = listTemplateTokens(source);
  const unresolved = [];
  const preview = source.replace(TOKEN_PATTERN, (match, rawToken) => {
    const token = String(rawToken || '').trim();
    const resolved = resolveToken(token, context);
    if (!resolved.resolved) {
      unresolved.push(token);
      return match;
    }
    return resolved.value;
  });

  return {
    preview,
    tokens,
    unresolvedTokens: uniqueInOrder(unresolved),
  };
}

module.exports = {
  buildTemplateMergeContext,
  listTemplateTokens,
  mergeTemplateMarkup,
};
