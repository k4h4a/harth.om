const { AppError } = require("./errorHandler");

/**
 * Gate routes to admins only. Usage: router.post('/', auth, requireAdmin, handler).
 * Must run *after* the `auth` middleware so req.user exists.
 */
function requireAdmin(req, _res, next) {
  if (!req.user) return next(new AppError("Not authenticated", 401));
  if (!req.user.is_admin) {
    return next(new AppError("Admin access required", 403));
  }
  return next();
}

module.exports = requireAdmin;
