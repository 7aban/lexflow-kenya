const config = require('./config');
const { signAccessToken } = require('./tokens');
const { genId } = require('./utils');

const STAFF_ROLES = new Set(['admin', 'advocate', 'assistant']);

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

  return { validateExistingStaffUser, completeOAuthLogin, unlinkOAuthAccount, getLinkedAccounts };
}

module.exports = createOAuth;
