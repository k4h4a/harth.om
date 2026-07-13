/**
 * One-time-password (OTP) service.
 *
 * Used for:
 *   - email verification at registration
 *   - password reset (forgot password)
 *   - password change (logged-in user)
 *
 * Design notes:
 *
 *  - Codes are 6 digits, generated from crypto.randomInt() so they're not
 *    biased the way `Math.floor(Math.random()*1e6)` would be.
 *  - We never store the plain code — only a bcrypt hash. A DB leak doesn't
 *    expose live codes.
 *  - Each code is valid for OTP_TTL_MS (10 minutes) and is invalidated after
 *    OTP_MAX_ATTEMPTS (5) wrong attempts on the same row, after a successful
 *    verification, or by a newer code being issued for the same {email,
 *    purpose}.
 *  - Issuing a new code automatically invalidates older un-consumed codes
 *    for the same {email, purpose}. This prevents an attacker who races the
 *    user from juggling multiple live codes.
 *  - Email delivery happens via the existing email.service. If SMTP isn't
 *    configured, send() returns sent:false and we surface that as a 503 so
 *    the user knows to reach out instead of being stuck in a loop.
 *  - SMS is wired through twilio's sendSms(); we don't use it yet for OTPs
 *    but the call site is ready when phone-based OTPs go live (Twilio /
 *    a local Omani provider).
 */

const knex = require("../db");
const emailService = require("./email.service");
const { AppError } = require("../middleware/errorHandler");
const otpCode = require("../utils/otpCode");

const OTP_TTL_MS = 10 * 60 * 1000;       // 10 minutes
const OTP_MAX_ATTEMPTS = 5;
const OTP_HASH_ROUNDS = 8;               // a bit lighter than passwords; codes are short-lived
const OTP_LENGTH = 6;

/**
 * Generate a numeric code of length OTP_LENGTH.
 */
function generateCode() {
  return otpCode.generateNumericCode(OTP_LENGTH);
}

/**
 * Issue a fresh OTP for {email, purpose}, optionally tied to a user_id.
 *
 * Side effects:
 *   - Marks all previous un-consumed codes for the same {email, purpose}
 *     as consumed (they can no longer be used).
 *   - Inserts a new row with a bcrypt-hashed code.
 *   - Sends the code to the user's email.
 *
 * Returns: { id, expires_at, sent }
 *   - sent=true        : email actually went out
 *   - sent=false, reason='not_configured' : SMTP not configured (dev mode)
 *
 * In NODE_ENV !== 'production' we ALSO log the code to the console so a
 * developer running without SMTP can complete the flow. We never log codes
 * in production.
 */
async function issueOtp({
  email,
  userId = null,
  purpose,
  requesterIp = null,
  subject = null,
  bodyTemplate = null,
}) {
  if (!email) throw new AppError("Email is required", 400);
  if (!["email_verification", "password_reset", "password_change"].includes(purpose)) {
    throw new AppError(`Unknown OTP purpose: ${purpose}`, 400);
  }

  const code = generateCode();
  const codeHash = await otpCode.hashCode(code, OTP_HASH_ROUNDS);
  const expiresAt = new Date(Date.now() + OTP_TTL_MS);

  await knex.transaction(async (trx) => {
    // Invalidate any older live codes for the same {email, purpose}. If the
    // attacker is racing the legit user, only the latest code is acceptable.
    await trx("auth_otps")
      .where({ email, purpose })
      .whereNull("consumed_at")
      .update({ consumed_at: trx.fn.now() });

    await trx("auth_otps").insert({
      email,
      user_id: userId,
      purpose,
      code_hash: codeHash,
      expires_at: expiresAt,
      requester_ip: requesterIp,
    });
  });

  // Build the message. Callers can pass a custom template; otherwise we
  // pick reasonable Arabic defaults. We deliberately keep the message
  // short — long bodies trip spam filters.
  const defaults = {
    email_verification: {
      subject: "رمز تأكيد البريد - منصة حرث",
      body:
        `رمز التحقق الخاص بك هو: ${code}\n\n` +
        `الرمز صالح لمدة 10 دقائق ويُستخدم مرة واحدة.\n` +
        `إذا لم تطلب هذا الرمز يمكنك تجاهل الرسالة.`,
    },
    password_reset: {
      subject: "إعادة تعيين كلمة المرور - منصة حرث",
      body:
        `رمز إعادة تعيين كلمة المرور: ${code}\n\n` +
        `الرمز صالح لمدة 10 دقائق ويُستخدم مرة واحدة.\n` +
        `إذا لم تطلب هذا الرمز فحسابك آمن — يمكنك تجاهل الرسالة.`,
    },
    password_change: {
      subject: "تأكيد تغيير كلمة المرور - منصة حرث",
      body:
        `لتأكيد تغيير كلمة المرور أدخل الرمز: ${code}\n\n` +
        `الرمز صالح لمدة 10 دقائق ويُستخدم مرة واحدة.`,
    },
  };

  const finalSubject = subject || defaults[purpose].subject;
  const finalBody =
    bodyTemplate ? bodyTemplate.replace("{{code}}", code) : defaults[purpose].body;

  const result = await emailService.send({
    to: email,
    subject: finalSubject,
    text: finalBody,
  });

  // Dev convenience: surface the code in the server log when SMTP isn't
  // configured. Production never sees this branch (SMTP is required).
  if (
    !result.sent &&
    result.reason === "not_configured" &&
    process.env.NODE_ENV !== "production"
  ) {
    // eslint-disable-next-line no-console
    console.log(`[otp][dev] ${purpose} code for ${email}: ${code}`);
  }

  return {
    sent: result.sent,
    reason: result.reason || null,
    expires_at: expiresAt.toISOString(),
  };
}

/**
 * Verify an OTP. Returns the matched row on success, throws AppError otherwise.
 *
 * Looks up the most recent un-consumed, un-expired row for {email, purpose}
 * and bcrypt-compares. Wrong attempts increment `attempts`; once
 * OTP_MAX_ATTEMPTS is hit we mark the row consumed regardless.
 *
 * The caller is responsible for the action that follows verification
 * (flipping email_verified, resetting password, etc).
 */
async function verifyOtp({ email, code, purpose }) {
  if (!email || !code || !purpose) {
    throw new AppError("Missing fields", 400);
  }

  // Look at the most recent live row only. Earlier rows for the same
  // {email, purpose} have been auto-consumed by issueOtp.
  const row = await knex("auth_otps")
    .where({ email, purpose })
    .whereNull("consumed_at")
    .andWhere("expires_at", ">", knex.fn.now())
    .orderBy("created_at", "desc")
    .first();

  if (!row) {
    throw new AppError("الرمز غير صحيح أو انتهت صلاحيته", 400);
  }

  // attempts cap — defensive double-check against the schema's CHECK
  if (row.attempts >= OTP_MAX_ATTEMPTS) {
    await knex("auth_otps")
      .where({ id: row.id })
      .update({ consumed_at: knex.fn.now() });
    throw new AppError("تم تجاوز الحد المسموح من المحاولات. اطلب رمزاً جديداً.", 429);
  }

  const ok = await otpCode.compareCode(code, row.code_hash);
  if (!ok) {
    // Record the wrong attempt. If this push us over the cap, mark consumed.
    const newAttempts = row.attempts + 1;
    if (newAttempts >= OTP_MAX_ATTEMPTS) {
      await knex("auth_otps").where({ id: row.id }).update({
        attempts: newAttempts,
        consumed_at: knex.fn.now(),
      });
      throw new AppError("الرمز غير صحيح. تم استنفاد المحاولات.", 429);
    }
    await knex("auth_otps").where({ id: row.id }).update({
      attempts: newAttempts,
    });
    const remaining = OTP_MAX_ATTEMPTS - newAttempts;
    throw new AppError(`الرمز غير صحيح. متبقّي ${remaining} محاولات.`, 400);
  }

  // Success — consume the row so it can't be replayed.
  await knex("auth_otps")
    .where({ id: row.id })
    .update({ consumed_at: knex.fn.now() });

  return row;
}

/**
 * Best-effort cleanup of expired/consumed rows. Safe to call from a cron;
 * if it errors, the next call gets it. Not strictly required since the
 * lookup query already filters on expires_at.
 */
async function purgeOldOtps({ olderThanDays = 7 } = {}) {
  return knex("auth_otps")
    .where("created_at", "<", knex.raw(`now() - interval '${olderThanDays} days'`))
    .del();
}

module.exports = {
  issueOtp,
  verifyOtp,
  purgeOldOtps,
  generateCode,        // exported for tests
  OTP_TTL_MS,
  OTP_MAX_ATTEMPTS,
  OTP_LENGTH,
};
