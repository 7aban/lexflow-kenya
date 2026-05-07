const crypto = require('crypto');
const config = require('./config');

const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes

function signState(provider) {
  if (!config.OAUTH_STATE_SECRET) {
    throw new Error('OAUTH_STATE_SECRET is required for OAuth state signing');
  }
  const nonce = crypto.randomBytes(16).toString('hex');
  const expiry = Date.now() + STATE_TTL_MS;
  const payload = `${provider}:${nonce}:${expiry}`;
  const hmac = crypto.createHmac('sha256', config.OAUTH_STATE_SECRET).update(payload).digest('hex');
  return `${payload}:${hmac}`;
}

function verifyState(state, expectedProvider) {
  if (!state) return { valid: false, error: 'Missing state parameter' };
  if (!config.OAUTH_STATE_SECRET) {
    return { valid: false, error: 'OAuth state verification not configured' };
  }
  const parts = state.split(':');
  if (parts.length !== 4) return { valid: false, error: 'Invalid state format' };
  const [provider, nonce, expiryStr, hmac] = parts;
  if (provider !== expectedProvider) return { valid: false, error: 'Provider mismatch in state' };
  const expiry = parseInt(expiryStr, 10);
  if (isNaN(expiry) || Date.now() > expiry) return { valid: false, error: 'State has expired' };
  const payload = `${provider}:${nonce}:${expiryStr}`;
  const expectedHmac = crypto.createHmac('sha256', config.OAUTH_STATE_SECRET).update(payload).digest('hex');
  if (hmac !== expectedHmac) return { valid: false, error: 'State signature verification failed' };
  return { valid: true, nonce };
}

module.exports = { signState, verifyState };
