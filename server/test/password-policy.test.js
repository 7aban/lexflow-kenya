const { validatePasswordPolicy } = require('../lib/passwordPolicy');

describe('Password Policy', () => {
  test('accepts a strong valid password', () => {
    const result = validatePasswordPolicy('Tr0ub4dor&X9q');
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
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
    expect(result.errors).toContain('Password must not be empty');
  });

  test('rejects whitespace-only string', () => {
    const result = validatePasswordPolicy('     ');
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('Password must not be empty');
  });

  test('rejects leading/trailing whitespace', () => {
    const result = validatePasswordPolicy('  Tr0ub4dor&X9q  ');
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('Password must not have leading or trailing whitespace');
  });

  test('rejects too-short password', () => {
    const result = validatePasswordPolicy('Ab1!');
    expect(result.ok).toBe(false);
    expect(result.errors.some(e => e.includes('at least') && e.includes('characters'))).toBe(true);
  });

  test('rejects too-long password', () => {
    const long = 'A'.repeat(129) + 'b1!';
    const result = validatePasswordPolicy(long);
    expect(result.ok).toBe(false);
    expect(result.errors.some(e => e.includes('exceed') && e.includes('characters'))).toBe(true);
  });

  test('rejects missing lowercase', () => {
    const result = validatePasswordPolicy('ABCDEFGHIJ1!');
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('Password must include at least one lowercase letter');
  });

  test('rejects missing uppercase', () => {
    const result = validatePasswordPolicy('abcdefghij1!');
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('Password must include at least one uppercase letter');
  });

  test('rejects missing digit', () => {
    const result = validatePasswordPolicy('Abcdefghij!@');
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('Password must include at least one digit');
  });

  test('rejects missing symbol', () => {
    const result = validatePasswordPolicy('Abcdefghij12');
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('Password must include at least one symbol');
  });

  test('rejects common weak passwords', () => {
    const weakPasswords = ['password', 'password123', 'admin', 'admin123', '123456', '12345678', 'qwerty', 'letmein', 'welcome'];
    for (const weak of weakPasswords) {
      const result = validatePasswordPolicy(weak);
      expect(result.ok).toBe(false);
      expect(result.errors).toContain('Password is too common');
    }
  });

  test('rejects common weak passwords case-insensitively', () => {
    const result = validatePasswordPolicy('PASSWORD');
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('Password is too common');
  });

  test('supports minLength override', () => {
    const result = validatePasswordPolicy('Ab1!', { minLength: 4, requireSymbol: false });
    expect(result.ok).toBe(true);
  });

  test('supports maxLength override', () => {
    const long = 'A'.repeat(200) + 'b1!';
    const result = validatePasswordPolicy(long, { maxLength: 50 });
    expect(result.ok).toBe(false);
    expect(result.errors.some(e => e.includes('exceed') && e.includes('50'))).toBe(true);
  });

  test('supports disabling requireLowercase', () => {
    const result = validatePasswordPolicy('ABCDEFGHIJ1!', { requireLowercase: false });
    expect(result.ok).toBe(true);
  });

  test('supports disabling requireUppercase', () => {
    const result = validatePasswordPolicy('abcdefghij1!', { requireUppercase: false });
    expect(result.ok).toBe(true);
  });

  test('supports disabling requireDigit', () => {
    const result = validatePasswordPolicy('Abcdefghij!@', { requireDigit: false });
    expect(result.ok).toBe(true);
  });

  test('supports disabling requireSymbol', () => {
    const result = validatePasswordPolicy('Abcdefghij12', { requireSymbol: false });
    expect(result.ok).toBe(true);
  });

  test('supports custom forbiddenPasswords list', () => {
    const result = validatePasswordPolicy('MySecretWord1!', { forbiddenPasswords: ['MySecretWord1!'], requireUppercase: true, requireDigit: true, requireSymbol: true, minLength: 4 });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('Password is too common');
  });

  test('result shape is always { ok, errors } for valid input', () => {
    const result = validatePasswordPolicy('Tr0ub4dor&X9q');
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

  test('errors do not include password in failure messages', () => {
    const weak = 'password123';
    const result = validatePasswordPolicy(weak);
    const errorText = result.errors.join(' ');
    expect(errorText).not.toContain(weak);
  });

  test('errors do not include password for whitespace rejection', () => {
    const result = validatePasswordPolicy('  mySecret123!  ');
    const errorText = result.errors.join(' ');
    expect(errorText).not.toContain('mySecret');
  });
});
