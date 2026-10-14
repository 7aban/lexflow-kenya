const { createAuthenticate, requireAdmin, requireAdvocateOrAdmin, requireStaff } = require('./auth');

module.exports = {
  createAuthenticate,
  requireAdmin,
  requireAdvocateOrAdmin,
  requireStaff
};
