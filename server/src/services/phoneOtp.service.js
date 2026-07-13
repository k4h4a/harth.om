/**
 * Phone OTP verification engine.
 *
 * Mirrors otp.service.js (same bcrypt-hash / attempt-cap / single-use /
 * invalidate-on-reissue design, via the shared utils/otpCode helpers) but
 * targets the standalone `phone_verifications` table instead of
 * `auth_otps`, and delivers over SMS instead of email. Kept separate
 * because phone verification needs to work *before* a user account exists
 * (registration), a case the email-OTP table isn't shaped for — see the
 * migration comment in 20260713000002_add_phone_verification.js.
 *
 * `purpose` is one of: registration | account_verification | phone_change.
 */
const knex = require("../db");
const env = require("../config/env");
const whatsappService = require("./whatsapp.service");
const otpCode = require("../utils/otpCode");
const { AppError } = require("../middleware/errorHandler");

const OTP_HASH_ROUNDS = 8; // same as otp.service.js — codes are short-lived
const PURPOSES = ["registration", "account_verification", "phone_change"];

// Single source of truth for the code shape — validators and the frontend
// both derive from this instead of hardcoding a digit count.
const CODE_REGEX = new RegExp(`^\\d{${env.PHONE_OTP_LENGTH}}$`);

function assertContext({ userId, pendingRegistrationId }) {
  if (!userId && !pendingRegistrationId) {
    throw new AppError("Missing userId or pendingRegistrationId", 400);
  }
}

/**
 * Issue a fresh phone OTP. Invalidates any previously-live code for the
 * same {phone_number, purpose} first, so only the latest code is usable.
 *
 * Returns: { sent, reason, expires_at, otp_length }
 */
async function issuePhoneOtp({
  phoneNumber,
  purpose,
  userId = null,
  pendingRegistrationId = null,
  requesterIp = null,
}) {
  if (!phoneNumber) throw new AppError("Phone number is required", 400);
  if (!PURPOSES.includes(purpose)) {
    throw new AppError(`Unknown phone OTP purpose: ${purpose}`, 400);
  }
  assertContext({ userId, pendingRegistrationId });

  const code = otpCode.generateNumericCode(env.PHONE_OTP_LENGTH);
  const codeHash = await otpCode.hashCode(code, OTP_HASH_ROUNDS);
  const expiresAt = new Date(Date.now() + env.PHONE_OTP_EXPIRY_MINUTES * 60 * 1000);

  await knex.transaction(async (trx) => {
    await trx("phone_verifications")
      .where({ phone_number: phoneNumber, purpose })
      .whereNull("consumed_at")
      .update({ consumed_at: trx.fn.now() });

    await trx("phone_verifications").insert({
      phone_number: phoneNumber,
      purpose,
      user_id: userId,
      pending_registration_id: pendingRegistrationId,
      code_hash: codeHash,
      expires_at: expiresAt,
      requester_ip: requesterIp,
    });
  });

  const body =
    `رمز التحقق الخاص بك هو: ${code}\n` +
    `الرمز صالح لمدة ${env.PHONE_OTP_EXPIRY_MINUTES} دقائق ويُستخدم مرة واحدة.`;
  const result = await whatsappService.sendSms({ to: phoneNumber, body });

  if (
    !result.sent &&
    result.reason === "not_configured" &&
    process.env.NODE_ENV !== "production"
  ) {
    // eslint-disable-next-line no-console
    console.log(`[phone-otp][dev] ${purpose} code for ${phoneNumber}: ${code}`);
  }

  return {
    sent: result.sent,
    reason: result.reason || null,
    expires_at: expiresAt.toISOString(),
    otp_length: env.PHONE_OTP_LENGTH,
  };
}

/**
 * Verify a phone OTP. Returns the matched row on success, throws AppError
 * otherwise. Scoped by {phone_number, purpose, userId|pendingRegistrationId}
 * so a code issued in one context (e.g. one pending registration) can't be
 * replayed against another.
 */
async function verifyPhoneOtp({
  phoneNumber,
  code,
  purpose,
  userId = null,
  pendingRegistrationId = null,
}) {
  if (!phoneNumber || !code || !purpose) {
    throw new AppError("Missing fields", 400);
  }
  assertContext({ userId, pendingRegistrationId });

  const query = knex("phone_verifications")
    .where({ phone_number: phoneNumber, purpose })
    .whereNull("consumed_at")
    .andWhere("expires_at", ">", knex.fn.now());
  if (userId) query.andWhere({ user_id: userId });
  if (pendingRegistrationId) query.andWhere({ pending_registration_id: pendingRegistrationId });

  const row = await query.orderBy("created_at", "desc").first();

  if (!row) {
    throw new AppError("الرمز غير صحيح أو انتهت صلاحيته", 400);
  }

  if (row.attempts >= env.PHONE_OTP_MAX_ATTEMPTS) {
    await knex("phone_verifications")
      .where({ id: row.id })
      .update({ consumed_at: knex.fn.now() });
    throw new AppError("تم تجاوز الحد المسموح من المحاولات. اطلب رمزاً جديداً.", 429);
  }

  const ok = await otpCode.compareCode(code, row.code_hash);
  if (!ok) {
    const newAttempts = row.attempts + 1;
    if (newAttempts >= env.PHONE_OTP_MAX_ATTEMPTS) {
      await knex("phone_verifications").where({ id: row.id }).update({
        attempts: newAttempts,
        consumed_at: knex.fn.now(),
      });
      throw new AppError("الرمز غير صحيح. تم استنفاد المحاولات.", 429);
    }
    await knex("phone_verifications").where({ id: row.id }).update({
      attempts: newAttempts,
    });
    const remaining = env.PHONE_OTP_MAX_ATTEMPTS - newAttempts;
    throw new AppError(`الرمز غير صحيح. متبقّي ${remaining} محاولات.`, 400);
  }

  await knex("phone_verifications")
    .where({ id: row.id })
    .update({ consumed_at: knex.fn.now(), verified_at: knex.fn.now() });

  return row;
}

/**
 * Best-effort cleanup of old rows. Not wired to a scheduler — matches the
 * same (currently unused) status as otp.service.purgeOldOtps.
 */
async function purgeExpiredPhoneVerifications({ olderThanDays = 7 } = {}) {
  return knex("phone_verifications")
    .where("created_at", "<", knex.raw(`now() - interval '${olderThanDays} days'`))
    .del();
}

module.exports = {
  issuePhoneOtp,
  verifyPhoneOtp,
  purgeExpiredPhoneVerifications,
  CODE_REGEX,
  PURPOSES,
};
