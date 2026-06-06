const config = require('./config');

function buildMicrosoftAuthUrl(tenantId) {
  return `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/authorize`;
}

function buildMicrosoftTokenUrl(tenantId) {
  return `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
}

const MICROSOFT_SCOPES = 'openid email profile User.Read';
const MICROSOFT_CONNECTED_SCOPES = 'openid email profile offline_access User.Read Mail.ReadBasic Calendars.ReadBasic';
const MICROSOFT_MESSAGES_URL = 'https://graph.microsoft.com/v1.0/me/messages';
const MICROSOFT_CALENDAR_URL = 'https://graph.microsoft.com/v1.0/me/calendar/events';

function requireMicrosoftConfig() {
  if (!config.MICROSOFT_CLIENT_ID) throw new Error('MICROSOFT_CLIENT_ID is required for Microsoft OAuth');
  if (!config.MICROSOFT_CLIENT_SECRET) throw new Error('MICROSOFT_CLIENT_SECRET is required for Microsoft OAuth');
}

function connectedRedirectUri() {
  return `${config.BASE_URL}/api/connected-accounts/microsoft/callback`;
}

function buildAuthorizationUrlWithOptions(state, options = {}) {
  requireMicrosoftConfig();
  const authUrl = buildMicrosoftAuthUrl(config.MICROSOFT_TENANT_ID);
  const params = new URLSearchParams({
    client_id: config.MICROSOFT_CLIENT_ID,
    redirect_uri: options.redirectUri || config.MICROSOFT_REDIRECT_URI,
    response_type: 'code',
    scope: options.scope || MICROSOFT_SCOPES,
    state,
    prompt: options.prompt || 'select_account',
  });
  return `${authUrl}?${params.toString()}`;
}

function buildAuthorizationUrl(state) {
  return buildAuthorizationUrlWithOptions(state);
}

function buildConnectedAuthorizationUrl(state) {
  return buildAuthorizationUrlWithOptions(state, {
    redirectUri: connectedRedirectUri(),
    scope: MICROSOFT_CONNECTED_SCOPES,
    prompt: 'select_account',
  });
}

async function exchangeCodeForTokens(code, redirectUri = config.MICROSOFT_REDIRECT_URI) {
  requireMicrosoftConfig();
  const tokenUrl = buildMicrosoftTokenUrl(config.MICROSOFT_TENANT_ID);
  const params = new URLSearchParams({
    code,
    client_id: config.MICROSOFT_CLIENT_ID,
    client_secret: config.MICROSOFT_CLIENT_SECRET,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  });
  const res = await fetch(tokenUrl, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params.toString() });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Microsoft token exchange failed (${res.status}): ${body}`);
  }
  return res.json();
}

async function exchangeCode(code) {
  const data = await exchangeCodeForTokens(code);
  return data.access_token;
}

async function getUserInfo(accessToken) {
  const res = await fetch('https://graph.microsoft.com/v1.0/me', { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Microsoft userinfo failed (${res.status}): ${body}`);
  }
  return res.json();
}

function graphRecipientSummary(values = []) {
  if (!Array.isArray(values)) return '';
  return values
    .map(item => item?.emailAddress?.address || item?.emailAddress?.name || '')
    .filter(Boolean)
    .join('; ');
}

function normalizeGraphMessage(message = {}) {
  return {
    providerMessageId: String(message.id || '').trim(),
    providerThreadId: String(message.conversationId || '').trim(),
    sender: message.from?.emailAddress?.address || message.from?.emailAddress?.name || '',
    recipientsSummary: graphRecipientSummary([...(message.toRecipients || []), ...(message.ccRecipients || [])]),
    subject: String(message.subject || '').trim(),
    snippet: String(message.bodyPreview || '').trim(),
    receivedAt: String(message.receivedDateTime || '').trim(),
    hasAttachments: Boolean(message.hasAttachments),
    labels: [],
    folders: [message.parentFolderId].filter(Boolean),
  };
}

async function graphJson(url, accessToken) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Microsoft Graph metadata failed (${res.status}): ${body}`);
  }
  return res.json();
}

async function fetchEmailMetadata({ accessToken, cursor = '', limit = 25 } = {}) {
  if (!accessToken) throw new Error('Microsoft access token is required for email metadata sync');
  const url = cursor || `${MICROSOFT_MESSAGES_URL}?${new URLSearchParams({
    $top: String(Math.min(Math.max(Number(limit || 25), 1), 50)),
    $select: 'id,conversationId,from,toRecipients,ccRecipients,subject,bodyPreview,receivedDateTime,hasAttachments,parentFolderId',
    $orderby: 'receivedDateTime desc',
  }).toString()}`;
  const data = await graphJson(url, accessToken);
  const messages = (Array.isArray(data.value) ? data.value : [])
    .map(normalizeGraphMessage)
    .filter(message => message.providerMessageId);
  return { messages, cursor: data['@odata.nextLink'] || '' };
}

function graphAttendeesSummary(attendees = []) {
  if (!Array.isArray(attendees)) return '';
  return attendees.map(a => a.emailAddress?.address || '').filter(Boolean).join('; ');
}

async function fetchCalendarMetadata({ accessToken, startDate, endDate, limit = 25 } = {}) {
  if (!accessToken) throw new Error('Microsoft access token is required for calendar metadata sync');
  const params = new URLSearchParams({
    $top: String(Math.min(Math.max(Number(limit || 25), 1), 50)),
    $select: 'id,subject,start,end,location,bodyPreview,onlineMeeting,organizer,attendees,lastModifiedDateTime',
    $orderby: 'start/dateTime desc',
  });
  if (startDate) params.set('startDateTime', new Date(startDate).toISOString());
  if (endDate) params.set('endDateTime', new Date(endDate).toISOString());
  const url = `${MICROSOFT_CALENDAR_URL}?${params.toString()}`;
  const data = await graphJson(url, accessToken);
  const events = (Array.isArray(data.value) ? data.value : []).map(event => ({
    providerEventId: String(event.id || '').trim(),
    calendarId: 'primary',
    calendarName: 'Calendar',
    subject: String(event.subject || '').trim(),
    startTime: event.start?.dateTime || event.start?.date || '',
    endTime: event.end?.dateTime || event.end?.date || '',
    location: event.location?.displayName || '',
    meetingLink: String(event.onlineMeeting?.joinUrl || event.onlineMeeting?.conferenceId || '').trim(),
    organizer: event.organizer?.emailAddress?.name || event.organizer?.emailAddress?.address || '',
    attendeesSummary: graphAttendeesSummary(event.attendees),
    descriptionSnippet: String(event.bodyPreview || '').trim().replace(/[\u0000-\u001F\u007F]/g, ' ').slice(0, 500),
    providerUpdatedAt: String(event.lastModifiedDateTime || '').trim(),
  }));
  return { events, cursor: data['@odata.nextLink'] || '' };
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
    scope: tokens.scope || MICROSOFT_CONNECTED_SCOPES,
  };
}

async function handleCallback(code) {
  const accessToken = await exchangeCode(code);
  const profile = await getUserInfo(accessToken);
  // Discard accessToken - do not store provider tokens
  const mail = String(profile.mail || profile.userPrincipalName || '').trim();
  return {
    provider: 'microsoft',
    providerSubject: profile.id || '',
    email: mail,
    // Microsoft Graph /me does not expose a direct verified-email boolean.
    // Keep the value unknown instead of treating presence of mail/UPN as proof.
    emailVerified: null,
  };
}

async function handleConnectedCallback(code) {
  const tokens = await exchangeCodeForTokens(code, connectedRedirectUri());
  const profile = await getUserInfo(tokens.access_token);
  const mail = String(profile.mail || profile.userPrincipalName || '').trim();
  return {
    provider: 'microsoft',
    providerAccountId: profile.id || '',
    email: mail,
    displayName: profile.displayName || mail,
    scopes: tokens.scope || MICROSOFT_CONNECTED_SCOPES,
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
  requireMicrosoftConfig,
  MICROSOFT_CONNECTED_SCOPES,
};
