const bcrypt = require('bcryptjs');

const PASSWORD_HASH_ROUNDS = 10;

async function hashPassword(password) {
  return bcrypt.hash(password, PASSWORD_HASH_ROUNDS);
}

async function verifyPassword(password, passwordHash) {
  try {
    return bcrypt.compare(password, passwordHash);
  } catch (err) {
    return false;
  }
}

module.exports = {
  hashPassword,
  verifyPassword,
  PASSWORD_HASH_ROUNDS,
};
