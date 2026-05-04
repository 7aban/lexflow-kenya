const { authenticate, requireAdmin, requireAdvocateOrAdmin, requireStaff } = require('./auth');

module.exports = {
  authenticate,
  requireAdmin,
  requireAdvocateOrAdmin,
  requireStaff
};
