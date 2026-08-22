const jwt = require("jsonwebtoken");
const knex = require("../db");
const { verifyToken, hashJti } = require("../utils/jwt");
const profileRepo = require("../repositories/profile.repository");
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

    // The token's signature/expiry being valid isn't enough on its own —
    // it also has to correspond to a session row that hasn't been revoked
    // (logout, "log out of all devices", password change). Without this
    // check, none of those actions could ever actually invalidate a token
    // that's still within its 7-day expiry.
    const tokenHash = hashJti(payload.jti || "");
    const session = payload.jti
      ? await profileRepo.findSessionByHash(payload.id, tokenHash)
      : null;
    if (!session) {
      return next(new AppError("Session expired or revoked, please log in again", 401));
    }
    profileRepo.touchSession(tokenHash).catch((e) => {
      // eslint-disable-next-line no-console
      console.error("[session touch failed]", e.message);
    });

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
    req.sessionTokenHash = tokenHash;
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
    if (!payload.jti) return next(); // pre-session-tracking token — treat as logged out
    const tokenHash = hashJti(payload.jti);
    const session = await profileRepo.findSessionByHash(payload.id, tokenHash);
    if (!session) return next(); // revoked — treat as logged out, not an error

    const user = await knex("users")
      .where({ id: payload.id, is_active: true })
      .first("id", "email", "is_admin", "name", "is_pro", "account_status");
    if (user && !BLOCKING_STATUSES.includes(user.account_status)) {
      req.user = user;
      req.sessionTokenHash = tokenHash;
      profileRepo.touchSession(tokenHash).catch(() => {});
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
