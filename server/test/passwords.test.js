const { hashPassword, verifyPassword, PASSWORD_HASH_ROUNDS } = require('../lib/passwords');

describe('Password Helper', () => {
  test('PASSWORD_HASH_ROUNDS is 10', () => {
    expect(PASSWORD_HASH_ROUNDS).toBe(10);
  });

  test('hashPassword returns a string', async () => {
    const hash = await hashPassword('TestPassword123!');
    expect(typeof hash).toBe('string');
    expect(hash.length).toBeGreaterThan(0);
  });

  test('hashPassword does not return plaintext', async () => {
    const hash = await hashPassword('TestPassword123!');
    expect(hash).not.toBe('TestPassword123!');
    expect(hash).not.toContain('TestPassword');
  });

  test('hashPassword returns a bcrypt-looking hash', async () => {
    const hash = await hashPassword('TestPassword123!');
    expect(hash).toMatch(/^\$2[ab]?\$\d{2}\$/);
  });

  test('same password hashes differently on separate calls due to salt', async () => {
    const hash1 = await hashPassword('TestPassword123!');
    const hash2 = await hashPassword('TestPassword123!');
    expect(hash1).not.toBe(hash2);
  });

  test('verifyPassword returns true for correct password', async () => {
    const hash = await hashPassword('TestPassword123!');
    const result = await verifyPassword('TestPassword123!', hash);
    expect(result).toBe(true);
  });

  test('verifyPassword returns false for wrong password', async () => {
    const hash = await hashPassword('TestPassword123!');
    const result = await verifyPassword('WrongPassword456!', hash);
    expect(result).toBe(false);
  });

  test('verifyPassword uses correct argument order (plaintext first, hash second)', async () => {
    const hash = await hashPassword('CorrectPassword1!');
    const correct = await verifyPassword('CorrectPassword1!', hash);
    expect(correct).toBe(true);
    const swapped = await verifyPassword(hash, 'CorrectPassword1!');
    expect(swapped).toBe(false);
  });

  test('verifyPassword returns false for malformed hash', async () => {
    const result = await verifyPassword('anything', 'not-a-valid-hash');
    expect(result).toBe(false);
  });

  test('helper does not import or enforce passwordPolicy', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(path.join(__dirname, '../lib/passwords.js'), 'utf8');
    expect(source).not.toContain('passwordPolicy');
    expect(source).not.toContain('validatePasswordPolicy');
  });
});
