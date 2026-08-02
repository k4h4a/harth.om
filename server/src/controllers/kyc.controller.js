const knex = require("../db");
const { AppError, asyncHandler } = require("../middleware/errorHandler");
const notificationService = require("../services/notification.service");
const auditService = require("../services/audit.service");

/**
 * KYC (Know Your Customer) controller.
 *
 * KYC is a self-serve, optional identity verification any authenticated
 * user can complete to earn the "موثَّق" trust badge. It is not required
 * to use any marketplace capability (listing, buying, renting, or
 * delivering) — every account can do all of that without it.
 *
 * Submission flow:
 *   1. User goes to /kyc page in the SPA.
 *   2. They upload three images (front of ID, back of ID, selfie). Uploading
 *      uses the existing /uploads/image endpoint; the response gives a
 *      URL per file.
 *   3. They POST the three URLs (and optionally an updated `identity` text
 *      field) to /kyc/submit. We mark identity_status='pending' and stamp
 *      identity_submitted_at.
 *   4. The admin reviews in /admin-dashboard "موافقات الهوية", and either
 *      approves (→ identity_status='approved', identity_verified=true) or
 *      rejects (→ identity_status='rejected' + reason).
 *
 * Re-submission: a 'rejected' user can submit again. Their submission goes
 * back to 'pending'. We DON'T let a user re-submit while already 'pending'
 * to avoid spam and admin churn — they get a clear 409.
 *
 * Privacy: KYC images are served from /uploads which is publicly readable
 * by URL. URLs use crypto-random filenames so they're unguessable, but
 * production deployments should put /uploads behind a signed-URL gateway.
 * Comment kept intentionally so this doesn't get forgotten.
 */

// Public fields we return when the user (or admin) reads back the KYC state.
const KYC_FIELDS = [
  "id",
  "name",
  "email",
  "phone",
  "identity",
  "identity_status",
  "identity_verified",
  "id_front_url",
  "id_back_url",
  "selfie_url",
  "identity_submitted_at",
  "identity_reviewed_at",
  "identity_reviewed_by",
  "identity_rejection_reason",
];

/**
 * GET /kyc/me
 * Authenticated. Returns the caller's current KYC state so the frontend
 * can render the right UI (form vs "بانتظار المراجعة" vs "مُعتمَد" vs
 * "مرفوض — أعد الإرسال").
 */
const getMyKyc = asyncHandler(async (req, res) => {
  const user = await knex("users")
    .where({ id: req.user.id })
    .first(KYC_FIELDS);
  if (!user) throw new AppError("User not found", 404);
  res.json({ success: true, kyc: user });
});

/**
 * POST /kyc/submit
 * Body: { id_front_url, id_back_url, selfie_url, identity? }
 * Authenticated. Submits the three KYC images for admin review.
 *
 * The user uploads each image via /uploads/image first, then POSTs the
 * three resulting URLs here.
 */
const submitKyc = asyncHandler(async (req, res) => {
  const { id_front_url, id_back_url, selfie_url, identity = null } = req.body;

  if (!id_front_url || !id_back_url || !selfie_url) {
    throw new AppError(
      "الصور الثلاث مطلوبة (وجه البطاقة، ظهر البطاقة، الصورة الشخصية)",
      400,
    );
  }

  const user = await knex("users")
    .where({ id: req.user.id })
    .first("id", "name", "email", "identity_status");
  if (!user) throw new AppError("User not found", 404);

  // Block re-submission while a previous one is still 'pending' — wait
  // for the admin to make a call. A rejected or none state can re-submit.
  if (user.identity_status === "pending") {
    throw new AppError(
      "طلب التحقق السابق ما زال قيد المراجعة. الرجاء انتظار قرار الإدارة.",
      409,
    );
  }

  // Prevent re-submission once approved (would silently lose the verified
  // status until the admin re-approves). If a verified user wants to update
  // their docs, an admin can revoke first.
  if (user.identity_status === "approved") {
    throw new AppError(
      "هويتك معتمدة بالفعل. للتحديث تواصل مع الإدارة.",
      409,
    );
  }

  const patch = {
    id_front_url: String(id_front_url).slice(0, 500),
    id_back_url: String(id_back_url).slice(0, 500),
    selfie_url: String(selfie_url).slice(0, 500),
    identity_status: "pending",
    identity_verified: false,
    identity_submitted_at: knex.fn.now(),
    // Clear out any previous review fields so the row reflects this new
    // submission only.
    identity_reviewed_at: null,
    identity_reviewed_by: null,
    identity_rejection_reason: null,
  };
  if (identity) {
    // Permit updating the typed ID number on submit.
    patch.identity = String(identity).slice(0, 64);
  }

  const [updated] = await knex("users")
    .where({ id: user.id })
    .update(patch)
    .returning(KYC_FIELDS);

  // Tell every active admin a new KYC is pending. Fire-and-forget.
  notifyAdminsOfNewKyc(updated).catch((e) => {
    // eslint-disable-next-line no-console
    console.error("[notify admins of KYC] failed:", e.message);
  });

  res.status(201).json({ success: true, kyc: updated });
});

async function notifyAdminsOfNewKyc(user) {
  const admins = await knex("users")
    .where({ is_admin: true, is_active: true })
    .select("id");
  await Promise.all(
    admins.map((a) =>
      notificationService.notify({
        userId: a.id,
        type: "system",
        title: "طلب تحقُّق هوية جديد",
        message: `قدّم ${user.name || user.email} وثائق التحقّق من الهوية وتحتاج مراجعتك.`,
        metadata: { user_id: user.id },
      }),
    ),
  );
}

// ─── Admin endpoints ──────────────────────────────────────────────────

/**
 * GET /admin/kyc/pending
 * Admin-only. Lists users with identity_status='pending', oldest first.
 */
const listPendingKyc = asyncHandler(async (req, res) => {
  const { page = 1, limit = 20 } = req.query;
  const safeLimit = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
  const safePage = Math.max(1, parseInt(page, 10) || 1);
  const offset = (safePage - 1) * safeLimit;

  const [items, countRow] = await Promise.all([
    knex("users")
      .where({ identity_status: "pending" })
      .orderBy("identity_submitted_at", "asc") // FIFO review queue
      .limit(safeLimit)
      .offset(offset)
      .select(KYC_FIELDS),
    knex("users").where({ identity_status: "pending" }).count("* as c").first(),
  ]);

  const total = parseInt(countRow.c, 10);
  res.json({
    success: true,
    items,
    pagination: {
      page: safePage,
      limit: safeLimit,
      total,
      pages: Math.ceil(total / safeLimit) || 1,
    },
  });
});

/**
 * POST /admin/kyc/:userId/approve
 * Admin-only. Marks identity_verified=true.
 */
const approveKyc = asyncHandler(async (req, res) => {
  const { userId } = req.params;

  const target = await knex("users").where({ id: userId }).first("id", "name", "email", "identity_status");
  if (!target) throw new AppError("User not found", 404);

  if (target.identity_status === "approved") {
    return res.json({
      success: true,
      already_approved: true,
      user_id: target.id,
    });
  }
  if (target.identity_status === "none") {
    throw new AppError("هذا المستخدم لم يُقدّم وثائق للتحقّق بعد.", 400);
  }

  const [updated] = await knex("users")
    .where({ id: userId })
    .update({
      identity_status: "approved",
      identity_verified: true,
      identity_reviewed_at: knex.fn.now(),
      identity_reviewed_by: req.user.id,
      identity_rejection_reason: null,
    })
    .returning(KYC_FIELDS);

  auditService.record(req, {
    action: auditService.ACTIONS.KYC_APPROVED,
    targetType: "user",
    targetId: updated.id,
    before: { identity_status: target.identity_status },
    after: { identity_status: "approved", identity_verified: true },
  });

  notificationService
    .notify({
      userId: updated.id,
      type: "system",
      title: "تمت الموافقة على هويتك",
      message:
        "تم اعتماد وثائق التحقّق الخاصة بك. ستظهر علامة التوثيق ✓ على ملفك ومعداتك.",
      metadata: { kind: "kyc_approved" },
      email: true,
    })
    .catch((e) => console.error("[approve KYC notify]", e.message));

  res.json({ success: true, kyc: updated });
});

/**
 * POST /admin/kyc/:userId/reject
 * Body: { reason? }
 * Admin-only. Rejects the submission. The user can re-submit afterwards.
 */
const rejectKyc = asyncHandler(async (req, res) => {
  const { userId } = req.params;
  const { reason = null } = req.body;

  const target = await knex("users").where({ id: userId }).first("id", "name", "email", "identity_status");
  if (!target) throw new AppError("User not found", 404);

  if (target.identity_status === "none") {
    throw new AppError("لا يوجد طلب لرفضه.", 400);
  }

  const [updated] = await knex("users")
    .where({ id: userId })
    .update({
      identity_status: "rejected",
      identity_verified: false,
      identity_reviewed_at: knex.fn.now(),
      identity_reviewed_by: req.user.id,
      identity_rejection_reason: reason || "لم يُذكر سبب",
    })
    .returning(KYC_FIELDS);

  auditService.record(req, {
    action: auditService.ACTIONS.KYC_REJECTED,
    targetType: "user",
    targetId: updated.id,
    before: { identity_status: target.identity_status },
    after: { identity_status: "rejected" },
    notes: reason,
  });

  notificationService
    .notify({
      userId: updated.id,
      type: "system",
      title: "لم تتم الموافقة على وثائق هويتك",
      message: reason
        ? `تم رفض الوثائق المُقدَّمة. السبب: ${reason}. يمكنك إعادة الإرسال بصور أوضح.`
        : "تم رفض الوثائق المُقدَّمة. يمكنك إعادة الإرسال بصور أوضح.",
      metadata: { kind: "kyc_rejected", reason: reason || null },
      email: true,
    })
    .catch((e) => console.error("[reject KYC notify]", e.message));

  res.json({ success: true, kyc: updated });
});

/**
 * GET /admin/kyc/:userId
 * Admin-only. Read a single user's KYC for the review modal.
 */
const adminGetKyc = asyncHandler(async (req, res) => {
  const user = await knex("users")
    .where({ id: req.params.userId })
    .first(KYC_FIELDS);
  if (!user) throw new AppError("User not found", 404);
  res.json({ success: true, kyc: user });
});

module.exports = {
  getMyKyc,
  submitKyc,
  listPendingKyc,
  approveKyc,
  rejectKyc,
  adminGetKyc,
};
