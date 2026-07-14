/**
 * Email OTP engine for the deferred-registration flow only (registerInit /
 * registerResend / registerVerify in auth.controller.js).
 *
 * Mirrors otp.service.js's design (bcrypt-hashed code, attempt cap,
 * invalidate-on-reissue via utils/otpCode) but targets the standalone
 * `registration_verifications` table instead of `auth_otps`, because:
 *   - it always ties to a pending_registrations row, not an existing user.
 *   - on success the row is hard-deleted (not soft-consumed) — there is no
 *     user yet to attach an audit trail to.
 *   - its TTL (REGISTRATION_OTP_EXPIRY_MINUTES, default 5) is independent
 *     of auth_otps' 10-minute TTL for password_reset/password_change,
 *     which are untouched by this file.
 */
const knex = require("../db");
const env = require("../config/env");
const emailService = require("./email.service");
const otpCode = require("../utils/otpCode");
const { AppError } = require("../middleware/errorHandler");

const OTP_HASH_ROUNDS = 8; // same as otp.service.js — codes are short-lived
const CODE_LENGTH = 6;
const CODE_REGEX = /^\d{6}$/;

/**
 * Issue a fresh registration OTP for {email, pendingRegistrationId}.
 * Invalidates (deletes) any previous live code for the same pending
 * registration first, so only the latest code is usable.
 *
 * Returns: { sent, reason, expires_at }
 */
async function issueRegistrationOtp({ email, pendingRegistrationId, requesterIp = null }) {
  if (!email) throw new AppError("Email is required", 400);
  if (!pendingRegistrationId) throw new AppError("pendingRegistrationId is required", 400);

  const code = otpCode.generateNumericCode(CODE_LENGTH);
  const codeHash = await otpCode.hashCode(code, OTP_HASH_ROUNDS);
  const expiresAt = new Date(Date.now() + env.REGISTRATION_OTP_EXPIRY_MINUTES * 60 * 1000);

  await knex.transaction(async (trx) => {
    await trx("registration_verifications")
      .where({ pending_registration_id: pendingRegistrationId })
      .del();

    await trx("registration_verifications").insert({
      pending_registration_id: pendingRegistrationId,
      email,
      code_hash: codeHash,
      expires_at: expiresAt,
      requester_ip: requesterIp,
    });
  });

  const result = await emailService.send({
    to: email,
    subject: "رمز تأكيد التسجيل - منصة حرث",
    text:
      `رمز التحقق الخاص بك هو: ${code}\n\n` +
      `الرمز صالح لمدة ${env.REGISTRATION_OTP_EXPIRY_MINUTES} دقائق ويُستخدم مرة واحدة.\n` +
      `إذا لم تطلب هذا الرمز يمكنك تجاهل الرسالة.`,
  });

  if (
    !result.sent &&
    result.reason === "not_configured" &&
    process.env.NODE_ENV !== "production"
  ) {
    // eslint-disable-next-line no-console
    console.log(`[registration-otp][dev] code for ${email}: ${code}`);
  }

  return {
    sent: result.sent,
    reason: result.reason || null,
    expires_at: expiresAt.toISOString(),
  };
}

/**
 * Verify a registration OTP. On success, the row is DELETED (single-use,
 * no soft-consume) and the matched row's data (as it was before deletion)
 * is returned. Throws AppError on any failure.
 */
async function verifyRegistrationOtp({ email, code, pendingRegistrationId }) {
  if (!email || !code || !pendingRegistrationId) {
    throw new AppError("Missing fields", 400);
  }

  const row = await knex("registration_verifications")
    .where({ pending_registration_id: pendingRegistrationId, email })
    .andWhere("expires_at", ">", knex.fn.now())
    .orderBy("created_at", "desc")
    .first();

  if (!row) {
    throw new AppError("الرمز غير صحيح أو انتهت صلاحيته", 400);
  }

  if (row.attempts >= env.REGISTRATION_OTP_MAX_ATTEMPTS) {
    throw new AppError("تم تجاوز الحد المسموح من المحاولات. اطلب رمزاً جديداً.", 429);
  }

  const ok = await otpCode.compareCode(code, row.code_hash);
  if (!ok) {
    const newAttempts = row.attempts + 1;
    await knex("registration_verifications").where({ id: row.id }).update({
      attempts: newAttempts,
    });
    if (newAttempts >= env.REGISTRATION_OTP_MAX_ATTEMPTS) {
      throw new AppError("الرمز غير صحيح. تم استنفاد المحاولات.", 429);
    }
    const remaining = env.REGISTRATION_OTP_MAX_ATTEMPTS - newAttempts;
    throw new AppError(`الرمز غير صحيح. متبقّي ${remaining} محاولات.`, 400);
  }

  // Success — delete the row so it can never be replayed.
  await knex("registration_verifications").where({ id: row.id }).del();

  return row;
}

/**
 * Best-effort cleanup of stale rows (expired codes nobody ever completed).
 * Not wired to a scheduler — same status as otp.service.purgeOldOtps.
 */
async function purgeExpiredRegistrationVerifications({ olderThanDays = 7 } = {}) {
  return knex("registration_verifications")
    .where("created_at", "<", knex.raw(`now() - interval '${olderThanDays} days'`))
    .del();
}

module.exports = {
  issueRegistrationOtp,
  verifyRegistrationOtp,
  purgeExpiredRegistrationVerifications,
  CODE_REGEX,
};
