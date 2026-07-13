// Phone verification for already-authenticated users (verifying the phone
// number captured at registration). For changing to a *different* phone
// number, see profile.controller.js's requestPhoneChange/changePhone.
//
// req.user (set by middleware/auth.js) doesn't carry phone/phone_verified,
// so each handler re-fetches those columns fresh rather than widening the
// auth middleware's column list for every authenticated route.
const knex = require("../db");
const { AppError, asyncHandler } = require("../middleware/errorHandler");
const phoneOtpService = require("../services/phoneOtp.service");
const profileRepo = require("../repositories/profile.repository");

async function getPhoneFields(userId) {
  const user = await knex("users")
    .where({ id: userId })
    .first("phone", "phone_verified");
  if (!user) throw new AppError("User not found", 404);
  return user;
}

async function issueAccountVerificationOtp(req, res) {
  const user = await getPhoneFields(req.user.id);
  if (!user.phone) throw new AppError("لا يوجد رقم هاتف مرتبط بالحساب", 404);
  if (user.phone_verified) throw new AppError("رقم الهاتف موثّق بالفعل", 409);

  const result = await phoneOtpService.issuePhoneOtp({
    phoneNumber: user.phone,
    purpose: "account_verification",
    userId: req.user.id,
    requesterIp: req.ip,
  });
  res.json({
    success: true,
    otp_sent: result.sent,
    otp_length: result.otp_length,
    reason: result.reason,
    expires_at: result.expires_at,
  });
}

// POST /phone/send-otp
const sendOtp = asyncHandler(issueAccountVerificationOtp);

// POST /phone/resend-otp
const resendOtp = asyncHandler(issueAccountVerificationOtp);

// POST /phone/verify-otp
const verifyOtp = asyncHandler(async (req, res) => {
  const { code } = req.body;
  const user = await getPhoneFields(req.user.id);
  if (!user.phone) throw new AppError("لا يوجد رقم هاتف مرتبط بالحساب", 404);

  await phoneOtpService.verifyPhoneOtp({
    phoneNumber: user.phone,
    code: String(code),
    purpose: "account_verification",
    userId: req.user.id,
  });

  await knex("users")
    .where({ id: req.user.id })
    .update({ phone_verified: true, phone_verified_at: knex.fn.now() });
  await profileRepo.logActivity(req.user.id, {
    action: "phone_verified",
    description: "تم توثيق رقم الهاتف",
    ip: req.ip,
    risk: "low",
  });

  res.json({ success: true, message: "تم توثيق رقم الهاتف بنجاح." });
});

// GET /phone/status
const status = asyncHandler(async (req, res) => {
  const user = await knex("users")
    .where({ id: req.user.id })
    .first("phone", "phone_verified", "phone_verified_at");
  if (!user) throw new AppError("User not found", 404);
  res.json({ success: true, ...user });
});

module.exports = { sendOtp, resendOtp, verifyOtp, status };
