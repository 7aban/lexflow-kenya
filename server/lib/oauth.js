const config = require('./config');
const crypto = require('crypto');
const { signAccessToken } = require('./tokens');
const { genId } = require('./utils');

const STAFF_ROLES = new Set(['admin', 'advocate', 'assistant']);
const CONNECTED_ACCOUNT_PROVIDERS = new Set(['google', 'microsoft']);

function normalizeEmail(email) {
  return typeof email === 'string' ? email.trim() : '';
}

function oauthEmailDomain(email) {
  const atIndex = email.lastIndexOf('@');
  if (atIndex < 0 || atIndex === email.length - 1) return '';
  return email.slice(atIndex + 1).trim().toLowerCase();
}

function allowedOAuthDomains() {
  if (!Array.isArray(config.OAUTH_ALLOWED_DOMAINS)) return [];
  return config.OAUTH_ALLOWED_DOMAINS
    .map(domain => String(domain || '').trim().toLowerCase())
    .filter(Boolean);
}

function isAllowedOAuthDomain(email) {
  const domains = allowedOAuthDomains();
  if (domains.length === 0) return true;
  return domains.includes(oauthEmailDomain(email));
}

function normalizeProvider(provider) {
  const normalized = String(provider || '').trim().toLowerCase();
  return CONNECTED_ACCOUNT_PROVIDERS.has(normalized) ? normalized : '';
}

function normalizeOptionalText(value, maxLength = 500) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function normalizeScopes(scopes) {
  if (Array.isArray(scopes)) return scopes.map(scope => String(scope || '').trim()).filter(Boolean).join(' ');
  return normalizeOptionalText(scopes, 2000);
}

function connectedAccountsTokenKey() {
  if (!config.CONNECTED_ACCOUNTS_TOKEN_KEY) {
    throw new Error('CONNECTED_ACCOUNTS_TOKEN_KEY is required for connected account token encryption');
  }
  return config.CONNECTED_ACCOUNTS_TOKEN_KEY;
}

function encryptConnectedToken(value) {
  if (!value) return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', connectedAccountsTokenKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64url')}:${tag.toString('base64url')}:${ciphertext.toString('base64url')}`;
}

function publicConnectedAccount(row = {}) {
  return {
    id: row.id,
    provider: row.provider,
    providerAccountId: row.providerAccountId || '',
    email: row.email || '',
    displayName: row.displayName || '',
    scopes: row.scopes || '',
    status: row.status || 'connected',
    connectedAt: row.connectedAt || '',
    disconnectedAt: row.disconnectedAt || '',
    lastSyncAt: row.lastSyncAt || '',
    lastError: row.lastError || '',
    createdAt: row.createdAt || '',
    updatedAt: row.updatedAt || '',
  };
}

function createOAuth({ run, get, all }) {
  async function validateExistingStaffUser(email) {
    const user = await get('SELECT id, email, fullName, role, tokenVersion, COALESCE(isActive,1) isActive FROM users WHERE lower(email)=lower(?)', [email]);
    if (!user) {
      return { ok: false, error: 'unknown_user', message: 'This email is not registered. Contact your firm administrator.' };
    }
    if (user.isActive === 0) {
      return { ok: false, error: 'inactive_account', message: 'Invalid email or password', user };
    }
    if (user.role === 'client') {
      return { ok: false, error: 'client_rejected', message: 'OAuth is for staff only. Use the Client Portal login.' };
    }
    if (!STAFF_ROLES.has(user.role)) {
      return { ok: false, error: 'invalid_role', message: 'This account does not have a valid staff role.' };
    }
    return { ok: true, user };
  }

  async function linkOAuthAccount({ user, provider, providerSubject, email, emailVerified, now }) {
    if (!providerSubject) {
      return { ok: false, error: 'missing_provider_subject', message: 'OAuth provider did not return an account identifier.' };
    }

    const existingBySubject = await get(
      'SELECT id, userId, revokedAt FROM oauth_accounts WHERE provider=? AND providerSubject=?',
      [provider, providerSubject],
    );
    if (existingBySubject && existingBySubject.userId !== user.id) {
      return { ok: false, error: 'oauth_link_conflict', message: 'This OAuth account is linked to a different user.' };
    }
    if (existingBySubject?.revokedAt) {
      return { ok: false, error: 'revoked', message: 'This OAuth account was revoked. Contact your administrator.' };
    }

    const existingForUser = existingBySubject || await get(
      'SELECT id, providerSubject, revokedAt FROM oauth_accounts WHERE userId=? AND provider=?',
      [user.id, provider],
    );
    if (existingForUser) {
      if (existingForUser.revokedAt) {
        return { ok: false, error: 'revoked', message: 'This OAuth account was revoked. Contact your administrator.' };
      }
      if (existingForUser.providerSubject && existingForUser.providerSubject !== providerSubject) {
        return { ok: false, error: 'oauth_link_conflict', message: 'This staff account is linked to a different OAuth account.' };
      }
      await run(
        'UPDATE oauth_accounts SET email=?, emailVerified=?, lastLoginAt=?, updatedAt=? WHERE id=?',
        [email, emailVerified ? 1 : 0, now, now, existingForUser.id],
      );
      return { ok: true };
    }

    const acctId = genId('OA');
    await run(
      'INSERT INTO oauth_accounts (id,userId,provider,providerSubject,email,emailVerified,revokedAt,createdAt,updatedAt,lastLoginAt) VALUES (?,?,?,?,?,?,?,?,?,?)',
      [acctId, user.id, provider, providerSubject, email, emailVerified ? 1 : 0, null, now, now, now],
    );
    return { ok: true };
  }

  async function completeOAuthLogin({ provider, providerSubject, email, emailVerified }) {
    const normalizedEmail = normalizeEmail(email);
    if (!normalizedEmail) {
      return { ok: false, error: 'no_email', message: 'OAuth provider did not return an email address.' };
    }
    if (!isAllowedOAuthDomain(normalizedEmail)) {
      return { ok: false, error: 'domain_not_allowed', message: 'This email domain is not allowed for staff OAuth.' };
    }
    // `false` is a provider-confirmed negative. `null` means the provider did
    // not expose a direct verified-email claim, so provider-specific policy can
    // stay explicit without overclaiming verification.
    if (config.OAUTH_REQUIRE_VERIFIED_EMAIL && emailVerified === false) {
      return { ok: false, error: 'email_not_verified', message: 'Your email is not verified with the provider.' };
    }
    const staffResult = await validateExistingStaffUser(normalizedEmail);
    if (!staffResult.ok) return staffResult;

    const user = staffResult.user;
    const now = new Date().toISOString();

    try {
      const linkResult = await linkOAuthAccount({ user, provider, providerSubject, email: normalizedEmail, emailVerified, now });
      if (!linkResult.ok) return linkResult;
    } catch (err) {
      return { ok: false, error: 'oauth_link_failed', message: 'OAuth account could not be linked. Contact your administrator.' };
    }

    const token = signAccessToken({ id: user.id, role: user.role, email: user.email, fullName: user.fullName, clientId: '', tokenVersion: user.tokenVersion });

    return {
      ok: true,
      token,
      user: { id: user.id, email: user.email, fullName: user.fullName, role: user.role, clientId: '' },
    };
  }

  async function unlinkOAuthAccount(userId, provider) {
    const now = new Date().toISOString();
    const existing = await get('SELECT id FROM oauth_accounts WHERE userId=? AND provider=? AND revokedAt IS NULL', [userId, provider]);
    if (!existing) return { ok: false, error: 'not_linked', message: 'Provider not linked to this account.' };
    await run('UPDATE oauth_accounts SET revokedAt=?, updatedAt=? WHERE id=?', [now, now, existing.id]);
    return { ok: true, provider };
  }

  async function getLinkedAccounts(userId) {
    return await all('SELECT id, provider, email, emailVerified, revokedAt, createdAt, lastLoginAt FROM oauth_accounts WHERE userId=? ORDER BY createdAt', [userId]);
  }

  async function getConnectedAccounts(userId) {
    const rows = await all(
      `SELECT id, provider, providerAccountId, email, displayName, scopes, status, connectedAt, disconnectedAt, lastSyncAt, lastError, createdAt, updatedAt
       FROM connected_accounts
       WHERE userId=?
       ORDER BY connectedAt DESC, createdAt DESC`,
      [userId],
    );
    return rows.map(publicConnectedAccount);
  }

  async function upsertConnectedAccount({ userId, provider, providerAccountId, email, displayName, scopes, tokens = {} }) {
    const normalizedProvider = normalizeProvider(provider);
    if (!normalizedProvider) {
      return { ok: false, error: 'unsupported_provider', message: 'Unsupported connected account provider.' };
    }

    const normalizedAccountId = normalizeOptionalText(providerAccountId, 255);
    const normalizedEmail = normalizeEmail(email);
    if (!normalizedAccountId) {
      return { ok: false, error: 'missing_provider_account', message: 'Provider did not return an account id.' };
    }
    if (!normalizedEmail) {
      return { ok: false, error: 'missing_email', message: 'Provider did not return an email address.' };
    }

    const scopesText = normalizeScopes(scopes || tokens.scope);
    const now = new Date().toISOString();
    const encryptedAccessToken = encryptConnectedToken(tokens.accessToken || tokens.access_token || '');
    const encryptedRefreshToken = encryptConnectedToken(tokens.refreshToken || tokens.refresh_token || '');
    const tokenType = normalizeOptionalText(tokens.tokenType || tokens.token_type, 80);
    const expiresAt = normalizeOptionalText(tokens.expiresAt || tokens.expires_at, 80);
    const tokenScope = normalizeScopes(tokens.scope || scopesText);

    await run('BEGIN TRANSACTION');
    try {
      let account = await get(
        'SELECT id FROM connected_accounts WHERE userId=? AND provider=? AND providerAccountId=?',
        [userId, normalizedProvider, normalizedAccountId],
      );
      let accountId = account?.id;
      if (accountId) {
        await run(
          `UPDATE connected_accounts
           SET email=?, displayName=?, scopes=?, status='connected', connectedAt=?, disconnectedAt=NULL, lastError='', updatedAt=?
           WHERE id=?`,
          [normalizedEmail, normalizeOptionalText(displayName, 255), scopesText, now, now, accountId],
        );
      } else {
        accountId = genId('CA');
        await run(
          `INSERT INTO connected_accounts
           (id,userId,provider,providerAccountId,email,displayName,scopes,status,connectedAt,disconnectedAt,lastSyncAt,lastError,createdAt,updatedAt)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [accountId, userId, normalizedProvider, normalizedAccountId, normalizedEmail, normalizeOptionalText(displayName, 255), scopesText, 'connected', now, null, null, '', now, now],
        );
      }

      const tokenRow = await get('SELECT id FROM connected_account_tokens WHERE connectedAccountId=?', [accountId]);
      if (tokenRow) {
        await run(
          `UPDATE connected_account_tokens
           SET accessTokenEncrypted=?, refreshTokenEncrypted=?, tokenType=?, expiresAt=?, scope=?, updatedAt=?
           WHERE id=?`,
          [encryptedAccessToken, encryptedRefreshToken, tokenType, expiresAt, tokenScope, now, tokenRow.id],
        );
      } else {
        await run(
          `INSERT INTO connected_account_tokens
           (id,connectedAccountId,accessTokenEncrypted,refreshTokenEncrypted,tokenType,expiresAt,scope,createdAt,updatedAt)
           VALUES (?,?,?,?,?,?,?,?,?)`,
          [genId('CAT'), accountId, encryptedAccessToken, encryptedRefreshToken, tokenType, expiresAt, tokenScope, now, now],
        );
      }

      await run('COMMIT');
      const saved = await get(
        `SELECT id, provider, providerAccountId, email, displayName, scopes, status, connectedAt, disconnectedAt, lastSyncAt, lastError, createdAt, updatedAt
         FROM connected_accounts WHERE id=?`,
        [accountId],
      );
      return { ok: true, account: publicConnectedAccount(saved) };
    } catch (err) {
      await run('ROLLBACK').catch(() => {});
      return { ok: false, error: 'connected_account_store_failed', message: 'Connected account could not be stored.' };
    }
  }

  async function disconnectConnectedAccount(userId, connectedAccountId) {
    const existing = await get('SELECT id, userId, status FROM connected_accounts WHERE id=?', [connectedAccountId]);
    if (!existing || existing.userId !== userId) {
      return { ok: false, error: 'not_found', message: 'Connected account not found.' };
    }
    const now = new Date().toISOString();
    if (existing.status !== 'disconnected') {
      await run(
        "UPDATE connected_accounts SET status='disconnected', disconnectedAt=?, updatedAt=? WHERE id=?",
        [now, now, connectedAccountId],
      );
    }
    const updated = await get(
      `SELECT id, provider, providerAccountId, email, displayName, scopes, status, connectedAt, disconnectedAt, lastSyncAt, lastError, createdAt, updatedAt
       FROM connected_accounts WHERE id=?`,
      [connectedAccountId],
    );
    return { ok: true, account: publicConnectedAccount(updated) };
  }

  return {
    validateExistingStaffUser,
    completeOAuthLogin,
    unlinkOAuthAccount,
    getLinkedAccounts,
    getConnectedAccounts,
    upsertConnectedAccount,
    disconnectConnectedAccount,
  };
}

module.exports = createOAuth;
