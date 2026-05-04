const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'lexflow-kenya-secret';

function authenticate(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : req.query.token;
  if (!token) return res.status(401).json({ error: 'Authentication required' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
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
