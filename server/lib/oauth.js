const config = require('./config');
const { signAccessToken } = require('./tokens');
const { genId } = require('./utils');

const STAFF_ROLES = new Set(['admin', 'advocate', 'assistant']);

function createOAuth({ run, get, all }) {
  async function validateExistingStaffUser(email) {
    const user = await get('SELECT id, email, fullName, role, tokenVersion FROM users WHERE lower(email)=lower(?)', [email]);
    if (!user) {
      return { ok: false, error: 'unknown_user', message: 'This email is not registered. Contact your firm administrator.' };
    }
    if (user.role === 'client') {
      return { ok: false, error: 'client_rejected', message: 'OAuth is for staff only. Use the Client Portal login.' };
    }
    if (!STAFF_ROLES.has(user.role)) {
      return { ok: false, error: 'invalid_role', message: 'This account does not have a valid staff role.' };
    }
    return { ok: true, user };
  }

  async function completeOAuthLogin({ provider, providerSubject, email, emailVerified }) {
    if (!email) {
      return { ok: false, error: 'no_email', message: 'OAuth provider did not return an email address.' };
    }
    if (config.OAUTH_REQUIRE_VERIFIED_EMAIL && emailVerified === false) {
      return { ok: false, error: 'email_not_verified', message: 'Your email is not verified with the provider.' };
    }
    const staffResult = await validateExistingStaffUser(email);
    if (!staffResult.ok) return staffResult;

    const user = staffResult.user;
    const now = new Date().toISOString();

    try {
      const existing = await get('SELECT id, revokedAt FROM oauth_accounts WHERE userId=? AND provider=?', [user.id, provider]);
      if (existing) {
        if (existing.revokedAt) {
          return { ok: false, error: 'revoked', message: 'This OAuth account was revoked. Contact your administrator.' };
        }
        await run('UPDATE oauth_accounts SET email=?, emailVerified=?, lastLoginAt=?, updatedAt=? WHERE id=?', [email, emailVerified ? 1 : 0, now, now, existing.id]);
      } else {
        const acctId = genId('OA');
        await run('INSERT INTO oauth_accounts (id,userId,provider,providerSubject,email,emailVerified,revokedAt,createdAt,updatedAt,lastLoginAt) VALUES (?,?,?,?,?,?,?,?,?,?)', [acctId, user.id, provider, providerSubject, email, emailVerified ? 1 : 0, null, now, now, now]);
      }
    } catch (err) {
      console.error('OAuth account link failed (non-fatal):', err.message);
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
