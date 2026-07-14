/**
 * Holds registration data submitted before email verification completes.
 * No `users` row exists until the OTP tied to a pending registration is
 * verified — see authController.registerVerify.
 *
 * `phone` is optional, unverified contact info here (matches users.phone's
 * original, pre-verification-feature behavior) — email is the sole identity
 * check, since email is the verification channel.
 */
const knex = require("../db");
const env = require("../config/env");
const { hashPassword } = require("../utils/password");
const { AppError } = require("../middleware/errorHandler");

async function createPendingRegistration({
  email,
  phone = null,
  password,
  name,
  role,
  identity = null,
  location = null,
  governorate = null,
  referredByCode = null,
  requesterIp = null,
}) {
  const existingUser = await knex("users").where({ email }).first("id");
  if (existingUser) throw new AppError("Email already registered", 409);

  const passwordHash = await hashPassword(password);
  const expiresAt = new Date(Date.now() + env.PENDING_REGISTRATION_TTL_MINUTES * 60 * 1000);

  const inserted = await knex.transaction(async (trx) => {
    // Supersede any abandoned pending registration for the same email so
    // the live partial-unique-index doesn't reject this attempt.
    await trx("pending_registrations")
      .where({ email })
      .whereNull("consumed_at")
      .update({ consumed_at: trx.fn.now() });

    const rows = await trx("pending_registrations")
      .insert({
        email,
        phone,
        password_hash: passwordHash,
        name,
        role,
        identity,
        location: location ? JSON.stringify(location) : null,
        governorate,
        referred_by_code: referredByCode,
        requester_ip: requesterIp,
        expires_at: expiresAt,
      })
      .returning(["id", "expires_at"]);
    return rows[0];
  });

  return inserted;
}

async function getLivePendingRegistration(id) {
  const row = await knex("pending_registrations")
    .where({ id })
    .whereNull("consumed_at")
    .andWhere("expires_at", ">", knex.fn.now())
    .first();
  if (!row) throw new AppError("انتهت صلاحية طلب التسجيل. الرجاء البدء من جديد.", 404);
  return row;
}

function consumePendingRegistration(id, trx) {
  return (trx || knex)("pending_registrations")
    .where({ id })
    .update({ consumed_at: (trx || knex).fn.now() });
}

/**
 * Best-effort cleanup. Not wired to a scheduler — same status as
 * otp.service.purgeOldOtps / registrationOtp.service.purgeExpiredRegistrationVerifications.
 */
async function purgeExpiredPendingRegistrations({ olderThanHours = 24 } = {}) {
  return knex("pending_registrations")
    .where("created_at", "<", knex.raw(`now() - interval '${olderThanHours} hours'`))
    .del();
}

module.exports = {
  createPendingRegistration,
  getLivePendingRegistration,
  consumePendingRegistration,
  purgeExpiredPendingRegistrations,
};
