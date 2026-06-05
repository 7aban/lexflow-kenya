const crypto = require('crypto');
const config = require('./config');

const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const usedStateNonces = new Map();

function pruneUsedStateNonces(now = Date.now()) {
  for (const [key, expiresAt] of usedStateNonces) {
    if (now > expiresAt) usedStateNonces.delete(key);
  }
}

function consumeStateNonce(provider, nonce, expiresAt, now = Date.now()) {
  pruneUsedStateNonces(now);
  const key = `${provider}:${nonce}`;
  if (usedStateNonces.has(key)) return false;
  usedStateNonces.set(key, expiresAt);
  return true;
}

function safeEqualHex(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(Buffer.from(left), Buffer.from(right));
}

function encodeContext(context) {
  if (!context || typeof context !== 'object') return '';
  return Buffer.from(JSON.stringify(context)).toString('base64url');
}

function decodeContext(encoded) {
  if (!encoded) return {};
  try {
    const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return null;
  }
}

function signState(provider, context = null) {
  if (!config.OAUTH_STATE_SECRET) {
    throw new Error('OAUTH_STATE_SECRET is required for OAuth state signing');
  }
  const nonce = crypto.randomBytes(16).toString('hex');
  const expiry = Date.now() + STATE_TTL_MS;
  const encodedContext = encodeContext(context);
  const payload = encodedContext ? `${provider}:${nonce}:${expiry}:${encodedContext}` : `${provider}:${nonce}:${expiry}`;
  const hmac = crypto.createHmac('sha256', config.OAUTH_STATE_SECRET).update(payload).digest('hex');
  return `${payload}:${hmac}`;
}

function verifyState(state, expectedProvider) {
  if (!state) return { valid: false, error: 'Missing state parameter' };
  if (!config.OAUTH_STATE_SECRET) {
    return { valid: false, error: 'OAuth state verification not configured' };
  }
  const parts = state.split(':');
  if (parts.length !== 4 && parts.length !== 5) return { valid: false, error: 'Invalid state format' };
  const [provider, nonce, expiryStr] = parts;
  const encodedContext = parts.length === 5 ? parts[3] : '';
  const hmac = parts[parts.length - 1];
  if (provider !== expectedProvider) return { valid: false, error: 'Provider mismatch in state' };
  const expiry = parseInt(expiryStr, 10);
  const now = Date.now();
  if (isNaN(expiry) || now > expiry) return { valid: false, error: 'State has expired' };
  const context = decodeContext(encodedContext);
  if (context === null) return { valid: false, error: 'Invalid state context' };
  const payload = encodedContext ? `${provider}:${nonce}:${expiryStr}:${encodedContext}` : `${provider}:${nonce}:${expiryStr}`;
  const expectedHmac = crypto.createHmac('sha256', config.OAUTH_STATE_SECRET).update(payload).digest('hex');
  if (!safeEqualHex(hmac, expectedHmac)) return { valid: false, error: 'State signature verification failed' };
  if (!consumeStateNonce(provider, nonce, expiry, now)) return { valid: false, error: 'State has already been used' };
  return { valid: true, nonce, context };
}

module.exports = { signState, verifyState };
