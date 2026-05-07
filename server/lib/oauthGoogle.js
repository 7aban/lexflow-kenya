const config = require('./config');

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo';
const GOOGLE_SCOPES = 'openid email profile';

function requireGoogleConfig() {
  if (!config.GOOGLE_CLIENT_ID) throw new Error('GOOGLE_CLIENT_ID is required for Google OAuth');
  if (!config.GOOGLE_CLIENT_SECRET) throw new Error('GOOGLE_CLIENT_SECRET is required for Google OAuth');
}

function buildAuthorizationUrl(state) {
  requireGoogleConfig();
  const params = new URLSearchParams({
    client_id: config.GOOGLE_CLIENT_ID,
    redirect_uri: config.GOOGLE_REDIRECT_URI,
    response_type: 'code',
    scope: GOOGLE_SCOPES,
    state,
    access_type: 'offline',
    prompt: 'select_account',
  });
  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

async function exchangeCode(code) {
  requireGoogleConfig();
  const params = new URLSearchParams({
    code,
    client_id: config.GOOGLE_CLIENT_ID,
    client_secret: config.GOOGLE_CLIENT_SECRET,
    redirect_uri: config.GOOGLE_REDIRECT_URI,
    grant_type: 'authorization_code',
  });
  const res = await fetch(GOOGLE_TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params.toString() });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Google token exchange failed (${res.status}): ${body}`);
  }
  const data = await res.json();
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

module.exports = { buildAuthorizationUrl, handleCallback, requireGoogleConfig };
