const sqlite3 = require('sqlite3').verbose();
const config = require('../lib/config');
const { verifyAccessToken } = require('../lib/tokens');

const db = new sqlite3.Database(config.DATABASE_PATH, sqlite3.OPEN_READONLY);

function authenticate(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : req.query.token;
  if (!token) return res.status(401).json({ error: 'Authentication required' });
  try {
    const decoded = verifyAccessToken(token);
    if (!decoded || typeof decoded.userId !== 'string') {
      return res.status(401).json({ error: 'Invalid token' });
    }
    if (typeof decoded.tokenVersion !== 'number') {
      return res.status(401).json({ error: 'Session invalidated' });
    }
    db.get('SELECT id, email, role, fullName, clientId, tokenVersion FROM users WHERE id = ?', [decoded.userId], (err, user) => {
      if (err) return res.status(401).json({ error: 'Invalid token' });
      if (!user) return res.status(401).json({ error: 'Invalid token' });
      if (user.tokenVersion !== decoded.tokenVersion) {
        return res.status(401).json({ error: 'Session invalidated' });
      }
      req.user = {
        userId: user.id,
        role: user.role,
        email: user.email,
        fullName: user.fullName,
        clientId: user.clientId || '',
        tokenVersion: user.tokenVersion,
        iat: decoded.iat,
        exp: decoded.exp,
      };
      next();
    });
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired' });
    }
    if (err.name === 'JsonWebTokenError') {
      return res.status(401).json({ error: 'Invalid token' });
    }
    if (err.name === 'NotBeforeError') {
      return res.status(401).json({ error: 'Token not active' });
    }
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

const requireAdmin = (req, res, next) => req.user?.role === 'admin' ? next() : res.status(403).json({ error: 'Admin access required' });
const requireAdvocateOrAdmin = (req, res, next) => ['advocate', 'admin'].includes(req.user?.role) ? next() : res.status(403).json({ error: 'Advocate or admin access required' });
const requireStaff = (req, res, next) => req.user?.role !== 'client' ? next() : res.status(403).json({ error: 'Staff access required' });

module.exports = {
  authenticate,
  requireAdmin,
  requireAdvocateOrAdmin,
  requireStaff
};
