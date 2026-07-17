const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const env = require("../config/env");

/**
 * Sign a JWT for a user. We only put identifiers in the payload — never PII.
 */
function signToken(user) {
  return jwt.sign(
    { id: user.id, role: user.role },
    env.JWT_SECRET,
    { expiresIn: env.JWT_EXPIRES_IN },
  );
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

module.exports = { signToken, verifyToken, signOAuthState, verifyOAuthState };
