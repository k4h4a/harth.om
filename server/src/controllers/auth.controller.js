const crypto = require("crypto");
const knex = require("../db");
const { hashPassword, verifyPassword } = require("../utils/password");
const { signToken, signOAuthState, verifyOAuthState } = require("../utils/jwt");
const { AppError, asyncHandler } = require("../middleware/errorHandler");
const { SELF_REGISTER_ROLES } = require("../validators/auth.validator");
const notificationService = require("../services/notification.service");
const otpService = require("../services/otp.service");
const registrationOtpService = require("../services/registrationOtp.service");
const pendingRegistrationService = require("../services/pendingRegistration.service");
const loyaltyRepo = require("../repositories/loyalty.repository");
const googleOAuth = require("../utils/googleOAuth");

/**
 * Generate a short, unambiguous referral code.
 * 8 chars from Crockford's alphabet (no 0/O/1/I/L) to avoid mistyping.
 */
function generateReferralCode() {
  const alphabet = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
  let code = "";
  const bytes = crypto.randomBytes(8);
  for (let i = 0; i < 8; i++) code += alphabet[bytes[i] % alphabet.length];
  return code;
}

/**
 * Fields we're willing to return about a user. Never include password_hash.
 *
 * Trust-related fields are included so the client can decide whether to
 * show the verified badge / KYC reminder banners without an extra round
 * trip.
 */
const PUBLIC_USER_FIELDS = [
  "id",
  "email",
  "phone",
  "role",
  "name",
  "location",
  "governorate",
  "referral_code",
  "loyalty_points",
  "is_pro",
  "pro_expires_at",
  "is_active",
  "account_status",
  "status_reason",
  "email_verified",
  "email_verified_at",
  "identity_status",
  "identity_verified",
  "avatar_url",
  "created_at",
];

/**
 * Default account status for a new self-registered user.
 *   - renter (consumer)        → approved (only buys; nothing to review)
 *   - owner (farmer)           → pending  (must be approved before selling)
 *   - delivery (delivery agent) → pending (must be approved before accepting jobs)
 */
function defaultStatusForRole(role) {
  return role === "renter" ? "approved" : "pending";
}

const checkEmail = asyncHandler(async (req, res) => {
  const { email } = req.body;
  const row = await knex("users")
    .where({ email })
    .andWhere({ is_active: true })
    .first("id");
  res.json({ exists: !!row });
});

/**
 * Shared account-creation logic used by both the legacy immediate-signup
 * endpoint (register) and the deferred, email-verified flow
 * (registerInit/registerVerify). Returns the response payload; callers
 * decide the HTTP status.
 */
async function createUserAndRespond({
  email,
  password = null,
  passwordHash: precomputedPasswordHash = null,
  name,
  role,
  phone = null,
  identity = null,
  location = null,
  governorate = null,
  referredByCode = null,
  trx = null,
}) {
  const db = trx || knex;

  // Hard block: server-side admin creation is off limits here.
  // SELF_REGISTER_ROLES excludes 'admin', so this is a belt-and-suspenders check.
  if (role === "admin" || !SELF_REGISTER_ROLES.includes(role)) {
    throw new AppError("Role not allowed", 400);
  }

  // Resolve referrer (if any) *before* insertion so a bad code fails fast.
  let referredBy = null;
  if (referredByCode) {
    const referrer = await db("users")
      .where({ referral_code: referredByCode, is_active: true })
      .first("id");
    if (!referrer) throw new AppError("Invalid referral code", 400);
    referredBy = referrer.id;
  }

  // The deferred-registration flow (registerVerify) already has a bcrypt
  // hash from pending_registrations — hashing again would double-hash it.
  const passwordHash = precomputedPasswordHash || (await hashPassword(password));

  // Try up to 3 times in case of referral_code collision. Cheap retry.
  let inserted;
  for (let attempt = 0; attempt < 3; attempt++) {
    const referralCode = generateReferralCode();
    try {
      const rows = await db("users")
        .insert({
          email,
          phone,
          password_hash: passwordHash,
          role,
          name,
          identity,
          location: location ? JSON.stringify(location) : null,
          governorate,
          referral_code: referralCode,
          referred_by: referredBy,
          is_active: true,
          account_status: defaultStatusForRole(role),
          status_changed_at: knex.fn.now(),
          // `register()` (legacy, immediate signup) sets this true
          // unconditionally — email verification was a soft, disabled
          // feature there (see auth.routes.js comment on verify-email).
          // `registerVerify` (deferred flow) also sets it true, but here
          // it's earned: the caller already passed registrationOtpService's
          // verification before reaching this insert.
          email_verified: true,
          email_verified_at: knex.fn.now(),
        })
        .returning(PUBLIC_USER_FIELDS);
      inserted = rows[0];
      break;
    } catch (err) {
      // 23505 = unique violation. If it's on referral_code, retry. If on email/phone, bubble up.
      if (err.code === "23505" && /referral_code/.test(err.detail || err.message)) {
        continue;
      }
      if (err.code === "23505" && /email/.test(err.detail || err.message)) {
        throw new AppError("Email already registered", 409);
      }
      if (err.code === "23505" && /phone/.test(err.detail || err.message)) {
        throw new AppError("Phone already registered", 409);
      }
      throw err;
    }
  }
  if (!inserted) throw new AppError("Could not generate referral code", 500);

  // Referral bonus: award both the referrer and the new user. Synchronous
  // since it's part of the registration outcome and the user likely wants
  // to see their bonus immediately. If we're already inside a caller-
  // supplied transaction (registerVerify), reuse it instead of opening a
  // nested one; otherwise open our own.
  if (referredBy) {
    try {
      const creditBoth = async (t) => {
        await loyaltyRepo.credit({
          userId: referredBy,
          kind: "referral_bonus",
          amount: loyaltyRepo.REFERRER_BONUS,
          referredUserId: inserted.id,
          notes: `Referral bonus — ${inserted.name} joined using your code`,
          trx: t,
        });
        await loyaltyRepo.credit({
          userId: inserted.id,
          kind: "referral_bonus",
          amount: loyaltyRepo.REFERRED_BONUS,
          referredUserId: referredBy,
          notes: "Welcome bonus for joining via a referral",
          trx: t,
        });
      };
      if (trx) {
        await creditBoth(trx);
      } else {
        await knex.transaction(creditBoth);
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("[referral bonus failed]", e.message);
    }
  }

  // Email verification was removed as a feature. We still return the
  // `email_verification` block in the response so any older client code
  // doesn't crash on missing fields — but with `required: false` and
  // `already_verified: true` so any verification UI hides itself.
  //
  // NOTE: the "registered" notification is intentionally NOT fired here.
  // It inserts into notifications_log via the plain `knex` connection
  // (not `trx`), so firing it while still inside registerVerify's wrapping
  // transaction would try to reference a user_id no other connection can
  // see yet — a foreign-key violation. Callers fire notifyRegistered()
  // themselves once they know the insert has actually committed.

  const token = signToken(inserted);
  return {
    success: true,
    token,
    user: inserted,
    email_verification: {
      required: false,
      already_verified: true,
      otp_sent: false,
      reason: null,
      expires_at: null,
    },
  };
}

function notifyRegistered(user) {
  notificationService.events.registered(user.id, user.name).catch((e) => {
    // eslint-disable-next-line no-console
    console.error("[register notify failed]", e.message);
  });
}

const register = asyncHandler(async (req, res) => {
  const {
    email,
    password,
    name,
    role,
    phone = null,
    identity = null,
    location = null,
    governorate = null,
    referral_code: referredByCode = null,
  } = req.body;

  const payload = await createUserAndRespond({
    email,
    password,
    name,
    role,
    phone,
    identity,
    location,
    governorate,
    referredByCode,
  });
  notifyRegistered(payload.user);
  res.status(201).json(payload);
});

// ─── Deferred registration (email-verified) ────────────────────────────
//
// POST /auth/register/init   — validate + stash data, send email OTP
// POST /auth/register/resend — resend the OTP for a still-live pending row
// POST /auth/register/verify — check the OTP, THEN create the account
//
// No `users` row exists until /verify succeeds. POST /auth/register above
// is untouched and still creates the account immediately, kept for backward
// compatibility with any client still calling it directly.

const registerInit = asyncHandler(async (req, res) => {
  const {
    email,
    password,
    name,
    role,
    phone = null,
    identity = null,
    location = null,
    governorate = null,
    referral_code: referredByCode = null,
  } = req.body;

  if (role === "admin" || !SELF_REGISTER_ROLES.includes(role)) {
    throw new AppError("Role not allowed", 400);
  }

  const pending = await pendingRegistrationService.createPendingRegistration({
    email,
    phone,
    password,
    name,
    role,
    identity,
    location,
    governorate,
    referredByCode,
    requesterIp: req.ip,
  });

  const otpResult = await registrationOtpService.issueRegistrationOtp({
    email,
    pendingRegistrationId: pending.id,
    requesterIp: req.ip,
  });

  res.status(201).json({
    success: true,
    pending_registration_id: pending.id,
    otp_sent: otpResult.sent,
    reason: otpResult.reason,
    expires_at: otpResult.expires_at,
  });
});

const registerResend = asyncHandler(async (req, res) => {
  const { pending_registration_id: pendingRegistrationId } = req.body;

  const pending = await pendingRegistrationService.getLivePendingRegistration(
    pendingRegistrationId,
  );

  const otpResult = await registrationOtpService.issueRegistrationOtp({
    email: pending.email,
    pendingRegistrationId: pending.id,
    requesterIp: req.ip,
  });

  res.json({
    success: true,
    otp_sent: otpResult.sent,
    reason: otpResult.reason,
    expires_at: otpResult.expires_at,
  });
});

const registerVerify = asyncHandler(async (req, res) => {
  const { pending_registration_id: pendingRegistrationId, code } = req.body;

  const pending = await pendingRegistrationService.getLivePendingRegistration(
    pendingRegistrationId,
  );

  await registrationOtpService.verifyRegistrationOtp({
    email: pending.email,
    code: String(code),
    pendingRegistrationId: pending.id,
  });

  const payload = await knex.transaction(async (trx) => {
    const result = await createUserAndRespond({
      email: pending.email,
      passwordHash: pending.password_hash, // already hashed at registerInit time
      name: pending.name,
      role: pending.role,
      phone: pending.phone,
      identity: pending.identity,
      location: pending.location,
      governorate: pending.governorate,
      referredByCode: pending.referred_by_code,
      trx,
    });
    await pendingRegistrationService.consumePendingRegistration(pending.id, trx);
    return result;
  });

  // Only now that the transaction has committed is the user row visible to
  // the notification service's own (separate) connection.
  notifyRegistered(payload.user);
  res.status(201).json(payload);
});

const login = asyncHandler(async (req, res) => {
  const { email, password } = req.body;

  const user = await knex("users")
    .where({ email, is_active: true })
    .first();

  // Constant-ish error to avoid leaking which part failed. Google-only
  // accounts have no password_hash — short-circuit before bcrypt.compare,
  // which throws on a non-string hash.
  if (
    !user ||
    !user.password_hash ||
    !(await verifyPassword(password, user.password_hash))
  ) {
    throw new AppError("Invalid credentials", 401);
  }

  // Hard block for suspended/removed accounts. Pending/rejected users CAN
  // still log in — they just can't sell or accept deliveries (enforced at
  // the action endpoints via requireApprovedAccount).
  if (user.account_status === "blocked") {
    throw new AppError(
      "تم إيقاف حسابك من قِبل الإدارة. الرجاء التواصل مع الدعم.",
      403,
    );
  }
  if (user.account_status === "deleted") {
    throw new AppError("هذا الحساب لم يعد متاحاً.", 403);
  }

  // Strip password_hash from returned user
  const { password_hash: _ph, ...safeUser } = user;
  const token = signToken(safeUser);
  res.json({ success: true, token, user: safeUser });
});

// ─── Google OAuth ("Sign in with Google") ─────────────────────────────
//
// Classic server-side redirect flow: GET /auth/google sends the browser to
// Google's consent screen; Google redirects back to GET /auth/google/callback
// with a one-time code. We exchange it for tokens, verify the ID token
// ourselves (never trust the frontend), then upsert the user and hand back
// our own JWT — same shape/mechanism as the password login above.
//
// There's no server session to stash a CSRF nonce in between those two
// requests, so `state` is a signed, 10-minute JWT (see utils/jwt.js) instead
// of a stored value.

const GOOGLE_OAUTH_STATE_PURPOSE = "google_oauth";

const googleAuthStart = asyncHandler(async (req, res) => {
  if (!googleOAuth.isConfigured()) {
    throw new AppError("Google sign-in is not configured", 503);
  }
  const state = signOAuthState(GOOGLE_OAUTH_STATE_PURPOSE);
  res.redirect(googleOAuth.getAuthUrl(state));
});

/**
 * Creates the local user for a first-time Google sign-in with a fresh
 * referral code, retrying on the (rare) referral_code collision — mirrors
 * the retry loop in createUserAndRespond above.
 */
async function insertGoogleUser({ googleId, email, name, picture }) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const referralCode = generateReferralCode();
    try {
      const rows = await knex("users")
        .insert({
          email,
          password_hash: null,
          role: "renter",
          name,
          google_id: googleId,
          avatar_url: picture,
          referral_code: referralCode,
          is_active: true,
          account_status: defaultStatusForRole("renter"),
          status_changed_at: knex.fn.now(),
          // Google already verified this address; no local OTP step needed.
          email_verified: true,
          email_verified_at: knex.fn.now(),
        })
        .returning("*");
      return rows[0];
    } catch (err) {
      if (err.code === "23505" && /referral_code/.test(err.detail || err.message)) {
        continue;
      }
      throw err;
    }
  }
  throw new AppError("Could not generate referral code", 500);
}

/**
 * Finds-or-creates the local user for a verified Google profile. Matches by
 * google_id first, then falls back to matching by email so someone who
 * already has a password account can also sign in with Google on the same
 * address without ending up with two accounts — safe because Google itself
 * already confirmed the caller controls that mailbox (email_verified).
 */
async function upsertGoogleUser({ googleId, email, name, picture }) {
  const byGoogleId = await knex("users").where({ google_id: googleId }).first();
  if (byGoogleId) return byGoogleId;

  const byEmail = await knex("users").where({ email }).first();
  if (byEmail) {
    const rows = await knex("users")
      .where({ id: byEmail.id })
      .update({
        google_id: googleId,
        avatar_url: byEmail.avatar_url || picture,
        updated_at: knex.fn.now(),
      })
      .returning("*");
    return rows[0];
  }

  return insertGoogleUser({ googleId, email, name, picture });
}

const googleAuthCallback = asyncHandler(async (req, res) => {
  const redirectWithError = (code) =>
    res.redirect(`/register.html?g_error=${encodeURIComponent(code)}`);

  // User clicked "Cancel" on Google's consent screen.
  if (req.query.error) {
    return redirectWithError("access_denied");
  }

  const { code, state } = req.query;
  if (!code || typeof code !== "string" || !state || typeof state !== "string") {
    return redirectWithError("invalid_request");
  }

  try {
    verifyOAuthState(state, GOOGLE_OAUTH_STATE_PURPOSE);
  } catch {
    return redirectWithError("invalid_state");
  }

  let profile;
  try {
    profile = await googleOAuth.getProfileFromCode(code);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("[google oauth] token exchange/verify failed:", e.message);
    return redirectWithError("verification_failed");
  }

  let user;
  try {
    user = await upsertGoogleUser(profile);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("[google oauth] user upsert failed:", e.message);
    return redirectWithError("server_error");
  }

  if (["blocked", "deleted"].includes(user.account_status)) {
    return redirectWithError("account_disabled");
  }

  const { password_hash: _ph, ...safeUser } = user;
  const token = signToken(safeUser);
  // Fragment, not query string: it's never sent to the server on the next
  // request and never appears in server logs/Referer headers, only visible
  // to the frontend JS that immediately stores it and rewrites the URL.
  res.redirect(`/register.html#g_token=${encodeURIComponent(token)}`);
});

const me = asyncHandler(async (req, res) => {
  // req.user is set by auth middleware. Fetch fresh to include latest fields.
  const user = await knex("users")
    .where({ id: req.user.id })
    .first(PUBLIC_USER_FIELDS);
  if (!user) throw new AppError("User not found", 404);
  res.json({ success: true, user });
});

const logout = asyncHandler(async (_req, res) => {
  // Stateless JWT: actual invalidation happens client-side by deleting the token.
  res.json({ success: true, message: "Logged out" });
});

// ─── Email verification ─────────────────────────────────────────────────
//
// Email verification was removed as a feature. The endpoints below are
// kept as no-ops so any older client (an out-of-date page still in a
// browser tab) doesn't see a 404 when it calls them — instead it gets a
// success response that tells it the email is already verified, and the
// client UI hides itself. Removing the endpoints outright would break
// those tabs; making them harmless is the safer compatibility path.

/**
 * POST /auth/verify-email/send
 * No-op since email verification was removed. Always returns
 * already_verified=true so the caller's UI moves on.
 */
const sendEmailVerificationOtp = asyncHandler(async (req, res) => {
  // Defensive: if the user record exists, make sure the column reflects
  // verified=true so any "verified" badge query is consistent. Cheap
  // single-row update; safe to no-op if the row is already true.
  if (req.user && req.user.id) {
    await knex("users")
      .where({ id: req.user.id, email_verified: false })
      .update({
        email_verified: true,
        email_verified_at: knex.fn.now(),
      });
  }
  res.json({ success: true, already_verified: true });
});

/**
 * POST /auth/verify-email
 * No-op since email verification was removed. Always returns success
 * with already_verified=true. Body (if any) is ignored.
 */
const verifyEmail = asyncHandler(async (req, res) => {
  let updated = null;
  if (req.user && req.user.id) {
    const rows = await knex("users")
      .where({ id: req.user.id })
      .update({
        email_verified: true,
        email_verified_at: knex.fn.now(),
      })
      .returning(PUBLIC_USER_FIELDS);
    updated = rows[0] || null;
  }
  res.json({ success: true, already_verified: true, user: updated });
});

// ─── Password reset (forgot password — anonymous) ─────────────────────

/**
 * POST /auth/password/request-reset
 * Body: { email }
 * Anonymous endpoint. Always responds the same way regardless of whether
 * the email exists in the DB so we don't leak account presence.
 */
const requestPasswordReset = asyncHandler(async (req, res) => {
  const { email } = req.body;
  const user = await knex("users")
    .where({ email, is_active: true })
    .first("id", "email", "account_status");

  // Refuse to recover blocked/deleted accounts. Don't leak that fact —
  // respond with the same shape regardless.
  if (user && !["blocked", "deleted"].includes(user.account_status)) {
    try {
      await otpService.issueOtp({
        email: user.email,
        userId: user.id,
        purpose: "password_reset",
        requesterIp: req.ip,
      });
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("[password reset] OTP issue failed:", e.message);
    }
  }

  res.json({
    success: true,
    message:
      "إذا كان البريد مسجَّلاً، فقد أرسلنا رمز إعادة تعيين كلمة المرور إليه.",
  });
});

/**
 * POST /auth/password/reset
 * Body: { email, code, new_password }
 * Anonymous. Verifies the OTP and sets a new password.
 */
const resetPassword = asyncHandler(async (req, res) => {
  const { email, code, new_password } = req.body;

  const user = await knex("users")
    .where({ email, is_active: true })
    .first("id", "email", "account_status");

  // Constant-ish error so we don't leak existence.
  if (!user) {
    throw new AppError("الرمز غير صحيح أو انتهت صلاحيته", 400);
  }
  if (["blocked", "deleted"].includes(user.account_status)) {
    throw new AppError("هذا الحساب لم يعد متاحاً.", 403);
  }

  await otpService.verifyOtp({
    email: user.email,
    code: String(code),
    purpose: "password_reset",
  });

  const newHash = await hashPassword(new_password);
  await knex("users")
    .where({ id: user.id })
    .update({ password_hash: newHash, updated_at: knex.fn.now() });

  res.json({
    success: true,
    message: "تم تحديث كلمة المرور بنجاح. يمكنك تسجيل الدخول الآن.",
  });
});

// ─── Password change (logged-in user) ─────────────────────────────────

/**
 * POST /auth/password/request-change
 * Authenticated. Sends an OTP to confirm the password change.
 */
const requestPasswordChange = asyncHandler(async (req, res) => {
  const user = await knex("users")
    .where({ id: req.user.id })
    .first("id", "email");
  if (!user) throw new AppError("User not found", 404);

  const result = await otpService.issueOtp({
    email: user.email,
    userId: user.id,
    purpose: "password_change",
    requesterIp: req.ip,
  });
  res.json({
    success: true,
    otp_sent: result.sent,
    reason: result.reason,
    expires_at: result.expires_at,
  });
});

/**
 * POST /auth/password/change
 * Body: { current_password, new_password, code }
 * Authenticated. Requires BOTH the current password AND the OTP — losing
 * one of them shouldn't let someone change the password.
 */
const changePassword = asyncHandler(async (req, res) => {
  const { current_password, new_password, code } = req.body;

  const user = await knex("users")
    .where({ id: req.user.id })
    .first("id", "email", "password_hash");
  if (!user) throw new AppError("User not found", 404);

  const ok = await verifyPassword(current_password, user.password_hash);
  if (!ok) throw new AppError("كلمة المرور الحالية غير صحيحة", 401);

  await otpService.verifyOtp({
    email: user.email,
    code: String(code),
    purpose: "password_change",
  });

  const newHash = await hashPassword(new_password);
  await knex("users")
    .where({ id: user.id })
    .update({ password_hash: newHash, updated_at: knex.fn.now() });

  res.json({ success: true, message: "تم تحديث كلمة المرور بنجاح." });
});

module.exports = {
  checkEmail,
  register,
  login,
  googleAuthStart,
  googleAuthCallback,
  me,
  logout,
  // Deferred (phone-verified) registration
  registerInit,
  registerResend,
  registerVerify,
  // OTP / verification flows
  sendEmailVerificationOtp,
  verifyEmail,
  requestPasswordReset,
  resetPassword,
  requestPasswordChange,
  changePassword,
};
