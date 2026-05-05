const DEFAULT_MIN_LENGTH = 12;
const DEFAULT_MAX_LENGTH = 128;

const DEFAULT_FORBIDDEN_PASSWORDS = [
  'password',
  'password123',
  'admin',
  'admin123',
  '123456',
  '12345678',
  'qwerty',
  'letmein',
  'welcome',
];

/**
 * Validate a password against the LexFlow policy.
 *
 * @param {string} password - The password to validate.
 * @param {object} [options]
 * @param {number} [options.minLength] - Minimum length (default: 12).
 * @param {number} [options.maxLength] - Maximum length (default: 128).
 * @param {boolean} [options.requireLowercase] - Require at least one lowercase letter (default: true).
 * @param {boolean} [options.requireUppercase] - Require at least one uppercase letter (default: true).
 * @param {boolean} [options.requireDigit] - Require at least one digit (default: true).
 * @param {boolean} [options.requireSymbol] - Require at least one non-alphanumeric symbol (default: true).
 * @param {string[]} [options.forbiddenPasswords] - List of disallowed passwords, case-insensitive (default: common weak list).
 * @returns {{ ok: boolean, errors: string[] }}
 */
function validatePasswordPolicy(password, options = {}) {
  const minLength = options.minLength ?? DEFAULT_MIN_LENGTH;
  const maxLength = options.maxLength ?? DEFAULT_MAX_LENGTH;
  const requireLowercase = options.requireLowercase !== false;
  const requireUppercase = options.requireUppercase !== false;
  const requireDigit = options.requireDigit !== false;
  const requireSymbol = options.requireSymbol !== false;
  const forbiddenPasswords = options.forbiddenPasswords ?? DEFAULT_FORBIDDEN_PASSWORDS;

  const errors = [];

  if (password === undefined || password === null || typeof password !== 'string') {
    errors.push('Password must be a string');
    return { ok: false, errors };
  }

  if (password.length !== password.trim().length) {
    errors.push('Password must not have leading or trailing whitespace');
  }

  if (password.trim().length === 0) {
    errors.push('Password must not be empty');
    return { ok: false, errors };
  }

  if (password.length < minLength) {
    errors.push(`Password must be at least ${minLength} characters`);
  }

  if (password.length > maxLength) {
    errors.push(`Password must not exceed ${maxLength} characters`);
  }

  if (requireLowercase && !/[a-z]/.test(password)) {
    errors.push('Password must include at least one lowercase letter');
  }

  if (requireUppercase && !/[A-Z]/.test(password)) {
    errors.push('Password must include at least one uppercase letter');
  }

  if (requireDigit && !/[0-9]/.test(password)) {
    errors.push('Password must include at least one digit');
  }

  if (requireSymbol && !/[^A-Za-z0-9]/.test(password)) {
    errors.push('Password must include at least one symbol');
  }

  const lower = password.toLowerCase();
  if (forbiddenPasswords.map(p => p.toLowerCase()).includes(lower)) {
    errors.push('Password is too common');
  }

  return { ok: errors.length === 0, errors };
}

module.exports = { validatePasswordPolicy };
