const express = require("express");
const router = express.Router();
const authController = require("../controllers/auth.controller");
const {
  checkEmailValidator,
  loginValidator,
  verifyEmailValidator,
  requestPasswordResetValidator,
  resetPasswordValidator,
  changePasswordValidator,
} = require("../validators/auth.validator");
const auth = require("../middleware/auth");
const { otpLimiter } = require("../middleware/otpRateLimit");

// POST /api/v1/auth/check-email
router.post("/check-email", checkEmailValidator, authController.checkEmail);

// Self-service email/password registration removed — accounts can only be
// created via "Sign in with Google" (see /google, /google/callback below).
// Email/password below only logs into an account that already exists.
// (authController.register/registerInit/registerResend/registerVerify and
// their validators are kept, unrouted, in case this ever needs reverting.)

// POST /api/v1/auth/login
router.post("/login", loginValidator, authController.login);

// ─── Google OAuth ("Sign in with Google") ──────────────────────────────
// GET /api/v1/auth/google - redirect to Google's consent screen
router.get("/google", authController.googleAuthStart);
// GET /api/v1/auth/google/callback - Google redirects back here with ?code
router.get("/google/callback", authController.googleAuthCallback);

// GET /api/v1/auth/me - protected
router.get("/me", auth, authController.me);

// POST /api/v1/auth/logout - protected (client-side)
router.post("/logout", auth, authController.logout);

// ─── Email verification ────────────────────────────────────────────────
// POST /auth/verify-email/send - resend the verification OTP (authenticated)
router.post(
  "/verify-email/send",
  otpLimiter,
  auth,
  authController.sendEmailVerificationOtp,
);
// POST /auth/verify-email - submit the OTP and flip email_verified=true
router.post(
  "/verify-email",
  otpLimiter,
  auth,
  verifyEmailValidator,
  authController.verifyEmail,
);

// Password reset via email removed — feature disabled.

// ─── Password change (authenticated) ──────────────────────────────────
// POST /auth/password/request-change - send change-confirmation OTP
router.post(
  "/password/request-change",
  otpLimiter,
  auth,
  authController.requestPasswordChange,
);
// POST /auth/password/change - verify OTP + current pw + set new pw
router.post(
  "/password/change",
  otpLimiter,
  auth,
  changePasswordValidator,
  authController.changePassword,
);

module.exports = router;
