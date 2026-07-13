const express = require("express");
const router = express.Router();
const authController = require("../controllers/auth.controller");
const {
  checkEmailValidator,
  loginValidator,
  registerValidator,
  registerInitValidator,
  registerResendValidator,
  registerVerifyValidator,
  verifyEmailValidator,
  requestPasswordResetValidator,
  resetPasswordValidator,
  changePasswordValidator,
} = require("../validators/auth.validator");
const auth = require("../middleware/auth");
const { otpLimiter, resendLimiter } = require("../middleware/otpRateLimit");

// POST /api/v1/auth/check-email
router.post("/check-email", checkEmailValidator, authController.checkEmail);

// POST /api/v1/auth/register
router.post("/register", registerValidator, authController.register);

// ─── Deferred registration (phone-verified) ───────────────────────────
// No `users` row is created until /register/verify succeeds.
router.post(
  "/register/init",
  otpLimiter,
  registerInitValidator,
  authController.registerInit,
);
router.post(
  "/register/resend",
  resendLimiter,
  registerResendValidator,
  authController.registerResend,
);
router.post(
  "/register/verify",
  otpLimiter,
  registerVerifyValidator,
  authController.registerVerify,
);

// POST /api/v1/auth/login
router.post("/login", loginValidator, authController.login);

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
