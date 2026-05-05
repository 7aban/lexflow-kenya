const config = require('./config');

module.exports = function createInvitations() {
  const invitationAttempts = new Map();
  
  function appBaseUrl(req) {
    if (config.BASE_URL) return config.BASE_URL.replace(/\/$/, '');
    const host = req.get('host') || '';
    if (host.startsWith('localhost') || host.startsWith('127.0.0.1')) return 'http://localhost:5173';
    return `${req.protocol}://${host || 'localhost:5173'}`;
  }

  function invitationUrl(req, token) {
    return `${appBaseUrl(req)}/invite/${token}`;
  }

  function checkInvitationRateLimit(req, res) {
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    const now = Date.now();
    const windowMs = 15 * 60 * 1000;
    const current = invitationAttempts.get(ip) || { count: 0, resetAt: now + windowMs };
    if (current.resetAt < now) {
      current.count = 0;
      current.resetAt = now + windowMs;
    }
    current.count += 1;
    invitationAttempts.set(ip, current);
    if (current.count > 10) {
      res.status(429).json({ error: 'Too many invitation attempts. Please try again later.' });
      return false;
    }
    return true;
  }

  return { appBaseUrl, invitationUrl, checkInvitationRateLimit };
};
