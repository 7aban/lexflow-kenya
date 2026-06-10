function validatePasswordPolicy(password, options = {}) {
  const errors = [];

  if (password === undefined || password === null || typeof password !== 'string') {
    errors.push('Password must be a string');
    return { ok: false, errors };
  }

  if (password.trim().length === 0) {
    errors.push('Password is required');
    return { ok: false, errors };
  }

  return { ok: true, errors: [] };
}

module.exports = { validatePasswordPolicy };
