/**
 * Numeric OTP code generation + hashing. Shared by every OTP engine in the
 * app (otp.service.js for password reset/change, registrationOtp.service.js
 * for account registration) so the crypto/bcrypt details live in exactly
 * one place.
 */
const crypto = require("crypto");
const bcrypt = require("bcrypt");

/**
 * Generate a numeric code of the given length using crypto.randomInt for
 * unbiased uniform distribution (unlike Math.random()-based approaches).
 */
function generateNumericCode(length) {
  const max = 10 ** length;
  const n = crypto.randomInt(0, max);
  return String(n).padStart(length, "0");
}

function hashCode(code, rounds) {
  return bcrypt.hash(code, rounds);
}

function compareCode(code, hash) {
  return bcrypt.compare(code, hash);
}

module.exports = { generateNumericCode, hashCode, compareCode };
