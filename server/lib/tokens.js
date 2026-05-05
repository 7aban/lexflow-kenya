const jwt = require('jsonwebtoken');
const config = require('./config');

function signAccessToken(user) {
  const payload = {
    userId: user.id,
    role: user.role,
    email: user.email || '',
    fullName: user.fullName || '',
    clientId: user.clientId || '',
  };
  
  const options = {
    expiresIn: config.JWT_EXPIRES_IN,
    algorithm: config.JWT_ALGORITHM,
  };
  
  if (config.JWT_ISSUER) {
    options.issuer = config.JWT_ISSUER;
  }
  
  if (config.JWT_AUDIENCE) {
    options.audience = config.JWT_AUDIENCE;
  }
  
  return jwt.sign(payload, config.JWT_SECRET, options);
}

function verifyAccessToken(token) {
  const options = {
    algorithms: [config.JWT_ALGORITHM],
  };
  
  if (config.JWT_ISSUER) {
    options.issuer = config.JWT_ISSUER;
  }
  
  if (config.JWT_AUDIENCE) {
    options.audience = config.JWT_AUDIENCE;
  }
  
  return jwt.verify(token, config.JWT_SECRET, options);
}

module.exports = {
  signAccessToken,
  verifyAccessToken,
};
