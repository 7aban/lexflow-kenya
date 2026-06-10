const { validatePasswordPolicy } = require('../lib/passwordPolicy');

describe('Password Policy', () => {
  test('accepts any non-empty password', () => {
    const result = validatePasswordPolicy('laban');
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test('accepts single character', () => {
    const result = validatePasswordPolicy('x');
    expect(result.ok).toBe(true);
  });

  test('accepts letters-only password', () => {
    const result = validatePasswordPolicy('abcdef');
    expect(result.ok).toBe(true);
  });

  test('accepts numbers-only password', () => {
    const result = validatePasswordPolicy('12345');
    expect(result.ok).toBe(true);
  });

  test('accepts generated-looking password with symbols', () => {
    const result = validatePasswordPolicy('Tr0ub4dor&X9q');
    expect(result.ok).toBe(true);
  });

  test('accepts common password that was previously rejected', () => {
    const result = validatePasswordPolicy('password');
    expect(result.ok).toBe(true);
  });

  test('rejects missing password (undefined)', () => {
    const result = validatePasswordPolicy(undefined);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('Password must be a string');
  });

  test('rejects null password', () => {
    const result = validatePasswordPolicy(null);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('Password must be a string');
  });

  test('rejects non-string password (number)', () => {
    const result = validatePasswordPolicy(12345);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('Password must be a string');
  });

  test('rejects non-string password (object)', () => {
    const result = validatePasswordPolicy({});
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('Password must be a string');
  });

  test('rejects empty string', () => {
    const result = validatePasswordPolicy('');
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('Password is required');
  });

  test('rejects whitespace-only string', () => {
    const result = validatePasswordPolicy('     ');
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('Password is required');
  });

  test('accepts leading/trailing whitespace', () => {
    const result = validatePasswordPolicy('  laban  ');
    expect(result.ok).toBe(true);
  });

  test('does not have a minimum length requirement beyond non-empty', () => {
    const result = validatePasswordPolicy('a');
    expect(result.ok).toBe(true);
  });

  test('does not require lowercase', () => {
    const result = validatePasswordPolicy('ABCDEFGHIJ1!');
    expect(result.ok).toBe(true);
  });

  test('does not require uppercase', () => {
    const result = validatePasswordPolicy('abcdefghij1!');
    expect(result.ok).toBe(true);
  });

  test('does not require digit', () => {
    const result = validatePasswordPolicy('Abcdefghij!@');
    expect(result.ok).toBe(true);
  });

  test('does not require symbol', () => {
    const result = validatePasswordPolicy('Abcdefghij12');
    expect(result.ok).toBe(true);
  });

  test('does not reject common passwords', () => {
    const weakPasswords = ['password', 'password123', 'admin', 'admin123', '123456', '12345678', 'qwerty', 'letmein', 'welcome'];
    for (const weak of weakPasswords) {
      const result = validatePasswordPolicy(weak);
      expect(result.ok).toBe(true);
    }
  });

  test('options are accepted but do not affect the simple policy', () => {
    const result = validatePasswordPolicy('laban', { minLength: 12, requireSymbol: true, requireUppercase: true, requireDigit: true });
    expect(result.ok).toBe(true);
  });

  test('result shape is always { ok, errors } for valid input', () => {
    const result = validatePasswordPolicy('laban');
    expect(result).toHaveProperty('ok');
    expect(result).toHaveProperty('errors');
    expect(Array.isArray(result.errors)).toBe(true);
    expect(typeof result.ok).toBe('boolean');
  });

  test('result shape is { ok, errors } for invalid input', () => {
    const result = validatePasswordPolicy('');
    expect(result).toHaveProperty('ok');
    expect(result).toHaveProperty('errors');
    expect(Array.isArray(result.errors)).toBe(true);
    expect(result.ok).toBe(false);
  });

  test('result shape is { ok, errors } for non-string input', () => {
    const result = validatePasswordPolicy(42);
    expect(result).toHaveProperty('ok');
    expect(result).toHaveProperty('errors');
    expect(Array.isArray(result.errors)).toBe(true);
    expect(result.ok).toBe(false);
  });

  test('errors do not include the actual password value', () => {
    const testPassword = 'SuperSecret!123';
    const result = validatePasswordPolicy(testPassword);
    const errorText = result.errors.join(' ');
    expect(errorText).not.toContain('SuperSecret');
    expect(errorText).not.toContain(testPassword);
  });
});
