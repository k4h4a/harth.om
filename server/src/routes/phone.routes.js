const express = require("express");
const router = express.Router();
const phoneController = require("../controllers/phone.controller");
const { verifyOtpValidator } = require("../validators/phone.validator");
const auth = require("../middleware/auth");
const { otpLimiter, resendLimiter } = require("../middleware/otpRateLimit");

// All routes here verify the phone number already on the authenticated
// user's account. To change to a different number, see
// /api/v1/profile/phone/request-change and /change.

// POST /api/v1/phone/send-otp
router.post("/send-otp", otpLimiter, auth, phoneController.sendOtp);

// POST /api/v1/phone/resend-otp
router.post("/resend-otp", resendLimiter, auth, phoneController.resendOtp);

// POST /api/v1/phone/verify-otp
router.post("/verify-otp", otpLimiter, auth, verifyOtpValidator, phoneController.verifyOtp);

// GET /api/v1/phone/status
router.get("/status", auth, phoneController.status);

module.exports = router;
