const jwt = require("jsonwebtoken");
const knex = require("../db");
const { verifyToken } = require("../utils/jwt");
const { AppError } = require("./errorHandler");

// Statuses that block all authenticated access. A blocked or deleted user
// cannot use the system at all (not even to browse logged in).
const BLOCKING_STATUSES = ["blocked", "deleted"];

/**
 * Require a valid JWT. Populates req.user with a fresh copy from the DB
 * so deactivation, admin-flag changes, or status changes take effect
 * immediately without requiring re-login.
 */
async function auth(req, _res, next) {
  try {
    const header = req.headers.authorization || "";
    const [scheme, token] = header.split(" ");
    if (scheme !== "Bearer" || !token) {
      return next(new AppError("Missing or malformed Authorization header", 401));
    }

    let payload;
    try {
      payload = verifyToken(token);
    } catch (e) {
      if (e instanceof jwt.TokenExpiredError) {
        return next(new AppError("Token expired", 401));
      }
      return next(new AppError("Invalid token", 401));
    }

    const user = await knex("users")
      .where({ id: payload.id, is_active: true })
      .first("id", "email", "is_admin", "name", "is_pro", "account_status");

    if (!user) return next(new AppError("User no longer exists", 401));

    // Hard block: if admin marked the account as blocked or deleted, deny.
    if (BLOCKING_STATUSES.includes(user.account_status)) {
      const msg =
        user.account_status === "blocked"
          ? "Account is suspended. Please contact support."
          : "Account has been removed.";
      return next(new AppError(msg, 403));
    }

    req.user = user;
    return next();
  } catch (err) {
    return next(err);
  }
}

/**
 * Optional auth: sets req.user if token is present and valid, otherwise passes through.
 * Blocked/deleted users are treated as logged-out for optional auth.
 */
async function optionalAuth(req, _res, next) {
  const header = req.headers.authorization || "";
  if (!header.startsWith("Bearer ")) return next();
  try {
    const token = header.slice(7);
    const payload = verifyToken(token);
    const user = await knex("users")
      .where({ id: payload.id, is_active: true })
      .first("id", "email", "is_admin", "name", "is_pro", "account_status");
    if (user && !BLOCKING_STATUSES.includes(user.account_status)) {
      req.user = user;
    }
  } catch (_e) {
    // Silently ignore — this is *optional* auth.
  }
  return next();
}

module.exports = auth;
module.exports.auth = auth;
module.exports.optionalAuth = optionalAuth;
module.exports.BLOCKING_STATUSES = BLOCKING_STATUSES;
