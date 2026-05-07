const config = require('./config');

function buildMicrosoftAuthUrl(tenantId) {
  return `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/authorize`;
}

function buildMicrosoftTokenUrl(tenantId) {
  return `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
}

const MICROSOFT_SCOPES = 'openid email profile User.Read';

function requireMicrosoftConfig() {
  if (!config.MICROSOFT_CLIENT_ID) throw new Error('MICROSOFT_CLIENT_ID is required for Microsoft OAuth');
  if (!config.MICROSOFT_CLIENT_SECRET) throw new Error('MICROSOFT_CLIENT_SECRET is required for Microsoft OAuth');
}

function buildAuthorizationUrl(state) {
  requireMicrosoftConfig();
  const authUrl = buildMicrosoftAuthUrl(config.MICROSOFT_TENANT_ID);
  const params = new URLSearchParams({
    client_id: config.MICROSOFT_CLIENT_ID,
    redirect_uri: config.MICROSOFT_REDIRECT_URI,
    response_type: 'code',
    scope: MICROSOFT_SCOPES,
    state,
    prompt: 'select_account',
  });
  return `${authUrl}?${params.toString()}`;
}

async function exchangeCode(code) {
  requireMicrosoftConfig();
  const tokenUrl = buildMicrosoftTokenUrl(config.MICROSOFT_TENANT_ID);
  const params = new URLSearchParams({
    code,
    client_id: config.MICROSOFT_CLIENT_ID,
    client_secret: config.MICROSOFT_CLIENT_SECRET,
    redirect_uri: config.MICROSOFT_REDIRECT_URI,
    grant_type: 'authorization_code',
  });
  const res = await fetch(tokenUrl, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params.toString() });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Microsoft token exchange failed (${res.status}): ${body}`);
  }
  const data = await res.json();
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

async function handleCallback(code) {
  const accessToken = await exchangeCode(code);
  const profile = await getUserInfo(accessToken);
  // Discard accessToken - do not store provider tokens
  const mail = profile.mail || profile.userPrincipalName || '';
  const emailVerified = !!mail && !mail.startsWith('#EXT#');
  return {
    provider: 'microsoft',
    providerSubject: profile.id || '',
    email: mail,
    emailVerified,
  };
}

module.exports = { buildAuthorizationUrl, handleCallback, requireMicrosoftConfig };
