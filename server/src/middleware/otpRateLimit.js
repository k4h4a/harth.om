// Rate limits shared by every OTP-issuing route (email OTPs in
// auth.routes.js, phone OTPs in auth.routes.js's register/* and
// phone.routes.js / profile.routes.js). Extracted from auth.routes.js so
// new route files can reuse the same limiter instances instead of each
// defining their own.
const rateLimit = require("express-rate-limit");

// The point is to prevent a single email/phone/IP from triggering hundreds
// of OTP sends in a row (cost + spam-filter risk). Verifying codes is also
// limited so brute-forcing the code space is impractical even with the
// per-row attempt cap as an additional layer of defence.
const otpLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 6,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: 429, message: "Too many OTP requests" } },
});

// Stricter limit specifically for "resend" actions, which are the easiest
// path to spamming someone's phone with SMS.
const resendLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: 429, message: "Too many resend requests" } },
});

module.exports = { otpLimiter, resendLimiter };
