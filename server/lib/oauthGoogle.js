const config = require('./config');

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo';
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
  requireGoogleConfig,
  GOOGLE_CONNECTED_SCOPES,
};
