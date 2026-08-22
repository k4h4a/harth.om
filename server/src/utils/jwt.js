const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const env = require("../config/env");

/**
 * Sign a JWT for a user. We only put identifiers in the payload — never PII.
 *
 * Each token gets a random `jti`. That's what makes session revocation
 * possible at all: the token itself is stateless and can't be "deleted",
 * but middleware/auth.js requires the jti to match a live row in
 * user_sessions on every request, so revoking that row (logout, "log out
 * all devices", password change) makes the still-technically-valid JWT
 * stop working immediately. Returns { token, jti } — callers must persist
 * the jti via profile.repository.js's createSession() for the token to
 * actually work past the first request.
 */
function signToken(user) {
  const jti = crypto.randomBytes(16).toString("hex");
  const token = jwt.sign(
    { id: user.id, is_admin: user.is_admin, jti },
    env.JWT_SECRET,
    { expiresIn: env.JWT_EXPIRES_IN },
  );
  return { token, jti };
}

/**
 * Hash a jti before storing/looking it up in user_sessions.token_hash.
 * The jti isn't secret on its own (it's inside the JWT payload, which is
 * base64 not encrypted), but hashing keeps the DB from holding a literal
 * copy of the session identifier and matches the column's existing name.
 */
function hashJti(jti) {
  return crypto.createHash("sha256").update(jti).digest("hex");
}

/**
 * Verify a token. Throws jsonwebtoken errors on failure; caller should catch.
 */
function verifyToken(token) {
  return jwt.verify(token, env.JWT_SECRET);
}

// ─── OAuth "state" param (CSRF protection) ───────────────────────────────
//
// Signed + time-boxed instead of stored server-side: a redirect-based OAuth
// flow has no session to stash a nonce in, so we make the state itself
// self-verifying. Anyone without JWT_SECRET can't forge one, and it expires
// long before a real login round-trip would take.

/**
 * Sign a short-lived state token to hand to an OAuth provider (e.g. Google)
 * and expect back unmodified on its callback.
 */
function signOAuthState(purpose) {
  return jwt.sign(
    { purpose, nonce: crypto.randomBytes(8).toString("hex") },
    env.JWT_SECRET,
    { expiresIn: "10m" },
  );
}

/**
 * Verify an OAuth state token round-tripped from the provider. Throws if
 * it's missing, expired, tampered with, or was issued for a different flow.
 */
function verifyOAuthState(state, purpose) {
  const decoded = jwt.verify(state, env.JWT_SECRET);
  if (decoded.purpose !== purpose) {
    throw new Error("OAuth state purpose mismatch");
  }
  return decoded;
}

module.exports = { signToken, verifyToken, hashJti, signOAuthState, verifyOAuthState };
