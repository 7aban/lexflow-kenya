const config = require('./config');

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo';
const GOOGLE_GMAIL_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages';
const GOOGLE_CALENDAR_URL = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
const GOOGLE_SCOPES = 'openid email profile';
const GOOGLE_CONNECTED_SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/gmail.metadata',
  'https://www.googleapis.com/auth/calendar.readonly',
].join(' ');

function requireGoogleConfig() {
  if (!config.GOOGLE_CLIENT_ID) throw new Error('GOOGLE_CLIENT_ID is required for Google OAuth');
  if (!config.GOOGLE_CLIENT_SECRET) throw new Error('GOOGLE_CLIENT_SECRET is required for Google OAuth');
}

function connectedRedirectUri() {
  return `${config.BASE_URL}/api/connected-accounts/google/callback`;
}

function buildAuthorizationUrlWithOptions(state, options = {}) {
  requireGoogleConfig();
  const params = new URLSearchParams({
    client_id: config.GOOGLE_CLIENT_ID,
    redirect_uri: options.redirectUri || config.GOOGLE_REDIRECT_URI,
    response_type: 'code',
    scope: options.scope || GOOGLE_SCOPES,
    state,
    access_type: 'offline',
    prompt: options.prompt || 'select_account',
  });
  if (options.includeGrantedScopes) params.set('include_granted_scopes', 'true');
  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

function buildAuthorizationUrl(state) {
  return buildAuthorizationUrlWithOptions(state);
}

function buildConnectedAuthorizationUrl(state) {
  return buildAuthorizationUrlWithOptions(state, {
    redirectUri: connectedRedirectUri(),
    scope: GOOGLE_CONNECTED_SCOPES,
    prompt: 'consent',
    includeGrantedScopes: true,
  });
}

async function exchangeCodeForTokens(code, redirectUri = config.GOOGLE_REDIRECT_URI) {
  requireGoogleConfig();
  const params = new URLSearchParams({
    code,
    client_id: config.GOOGLE_CLIENT_ID,
    client_secret: config.GOOGLE_CLIENT_SECRET,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  });
  const res = await fetch(GOOGLE_TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params.toString() });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Google token exchange failed (${res.status}): ${body}`);
  }
  return res.json();
}

async function exchangeCode(code) {
  const data = await exchangeCodeForTokens(code);
  return data.access_token;
}

async function getUserInfo(accessToken) {
  const res = await fetch(GOOGLE_USERINFO_URL, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Google userinfo failed (${res.status}): ${body}`);
  }
  return res.json();
}

function gmailHeader(headers = [], name) {
  const header = headers.find(item => String(item?.name || '').toLowerCase() === name.toLowerCase());
  return String(header?.value || '').trim();
}

function gmailHasAttachments(part = {}) {
  if (!part || typeof part !== 'object') return false;
  if (part.filename || part.body?.attachmentId) return true;
  return Array.isArray(part.parts) && part.parts.some(gmailHasAttachments);
}

function normalizeGmailMessage(message = {}) {
  const headers = message.payload?.headers || [];
  return {
    providerMessageId: String(message.id || '').trim(),
    providerThreadId: String(message.threadId || '').trim(),
    sender: gmailHeader(headers, 'From'),
    recipientsSummary: [gmailHeader(headers, 'To'), gmailHeader(headers, 'Cc')].filter(Boolean).join('; '),
    subject: gmailHeader(headers, 'Subject'),
    snippet: String(message.snippet || '').trim(),
    receivedAt: gmailHeader(headers, 'Date') || (message.internalDate ? new Date(Number(message.internalDate)).toISOString() : ''),
    hasAttachments: gmailHasAttachments(message.payload || {}),
    labels: Array.isArray(message.labelIds) ? message.labelIds : [],
    folders: Array.isArray(message.labelIds) ? message.labelIds : [],
  };
}

async function gmailJson(url, accessToken) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Google Gmail metadata failed (${res.status}): ${body}`);
  }
  return res.json();
}

async function fetchEmailMetadata({ accessToken, cursor = '', limit = 25 } = {}) {
  if (!accessToken) throw new Error('Google access token is required for email metadata sync');
  const params = new URLSearchParams({
    maxResults: String(Math.min(Math.max(Number(limit || 25), 1), 50)),
    includeSpamTrash: 'false',
  });
  if (cursor) params.set('pageToken', cursor);
  const list = await gmailJson(`${GOOGLE_GMAIL_URL}?${params.toString()}`, accessToken);
  const ids = Array.isArray(list.messages) ? list.messages.map(item => item.id).filter(Boolean) : [];
  const messages = [];
  for (const id of ids) {
    const detailParams = new URLSearchParams({ format: 'metadata' });
    ['From', 'To', 'Cc', 'Subject', 'Date'].forEach(header => detailParams.append('metadataHeaders', header));
    const detail = await gmailJson(`${GOOGLE_GMAIL_URL}/${encodeURIComponent(id)}?${detailParams.toString()}`, accessToken);
    const normalized = normalizeGmailMessage(detail);
    if (normalized.providerMessageId) messages.push(normalized);
  }
  return { messages, cursor: list.nextPageToken || '' };
}

async function fetchCalendarMetadata({ accessToken, startDate, endDate, limit = 25 } = {}) {
  if (!accessToken) throw new Error('Google access token is required for calendar metadata sync');
  const params = new URLSearchParams({
    maxResults: String(Math.min(Math.max(Number(limit || 25), 1), 50)),
    singleEvents: 'true',
    orderBy: 'startTime',
    showDeleted: 'false',
  });
  if (startDate) params.set('timeMin', new Date(startDate).toISOString());
  if (endDate) params.set('timeMax', new Date(endDate).toISOString());
  const data = await gmailJson(`${GOOGLE_CALENDAR_URL}?${params.toString()}`, accessToken);
  const events = (Array.isArray(data.items) ? data.items : []).map(event => ({
    providerEventId: String(event.id || '').trim(),
    calendarId: 'primary',
    calendarName: 'primary',
    subject: String(event.summary || '').trim(),
    startTime: event.start?.dateTime || event.start?.date || '',
    endTime: event.end?.dateTime || event.end?.date || '',
    location: String(event.location || '').trim(),
    meetingLink: String(event.hangoutLink || event.conferenceData?.entryPoints?.find(ep => ep.entryPointType === 'video')?.uri || '').trim(),
    organizer: event.organizer?.email || event.organizer?.displayName || '',
    attendeesSummary: Array.isArray(event.attendees) ? event.attendees.map(a => a.email).filter(Boolean).join('; ') : '',
    descriptionSnippet: String(event.description || '').trim().replace(/[\u0000-\u001F\u007F]/g, ' ').slice(0, 500),
    providerUpdatedAt: String(event.updated || '').trim(),
  }));
  return { events, cursor: data.nextPageToken || '' };
}

function tokenExpiry(tokens = {}) {
  const expiresIn = Number(tokens.expires_in || 0);
  return expiresIn ? new Date(Date.now() + expiresIn * 1000).toISOString() : '';
}

function connectedTokenSet(tokens = {}) {
  return {
    accessToken: tokens.access_token || '',
    refreshToken: tokens.refresh_token || '',
    tokenType: tokens.token_type || '',
    expiresAt: tokenExpiry(tokens),
    scope: tokens.scope || GOOGLE_CONNECTED_SCOPES,
  };
}

async function handleCallback(code) {
  const accessToken = await exchangeCode(code);
  const profile = await getUserInfo(accessToken);
  // Discard accessToken - do not store provider tokens
  return {
    provider: 'google',
    providerSubject: profile.sub || '',
    email: profile.email || '',
    emailVerified: profile.email_verified === true,
  };
}

async function handleConnectedCallback(code) {
  const tokens = await exchangeCodeForTokens(code, connectedRedirectUri());
  const profile = await getUserInfo(tokens.access_token);
  return {
    provider: 'google',
    providerAccountId: profile.sub || '',
    email: profile.email || '',
    displayName: profile.name || profile.email || '',
    scopes: tokens.scope || GOOGLE_CONNECTED_SCOPES,
    tokens: connectedTokenSet(tokens),
  };
}

module.exports = {
  buildAuthorizationUrl,
  buildConnectedAuthorizationUrl,
  handleCallback,
  handleConnectedCallback,
  fetchEmailMetadata,
  fetchCalendarMetadata,
  requireGoogleConfig,
  GOOGLE_CONNECTED_SCOPES,
};
