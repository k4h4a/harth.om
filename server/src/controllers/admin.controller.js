const adminRepo = require("../repositories/admin.repository");
const promoRepo = require("../repositories/promo.repository");
const commissionRepo = require("../repositories/commission.repository");
const settingsRepo = require("../repositories/settings.repository");
const orderRepo = require("../repositories/order.repository");
const equipmentRepo = require("../repositories/equipment.repository");
const payoutRepo = require("../repositories/payout.repository");
const auditService = require("../services/audit.service");
const notificationService = require("../services/notification.service");
const knex = require("../db");
const { AppError, asyncHandler } = require("../middleware/errorHandler");

/**
 * Admin endpoints are all gated by requireRole('admin') on the router.
 * The controller assumes req.user.role === 'admin'.
 *
 * Audit logging convention:
 *   - Every state-changing handler calls auditService.record() with a
 *     before/after diff slice. The audit service swallows its own errors,
 *     so the user's action never fails because of bookkeeping.
 *   - Read-only handlers (lists, stats, charts) don't audit — too noisy.
 */

const A = auditService.ACTIONS;

// ─── Stats / charts ───────────────────────────────────────────────────

const stats = asyncHandler(async (_req, res) => {
  const data = await adminRepo.platformStats();
  res.json({ success: true, stats: data });
});

const topOwners = asyncHandler(async (req, res) => {
  const { days = 30, limit = 10 } = req.query;
  const rows = await adminRepo.topOwners({
    days: parseInt(days, 10) || 30,
    limit: parseInt(limit, 10) || 10,
  });
  res.json({ success: true, top_owners: rows });
});

const revenueTimeseries = asyncHandler(async (req, res) => {
  const days = parseInt(req.query.days, 10) || 30;
  const rows = await adminRepo.revenueOverTime({ days });
  res.json({ success: true, series: rows });
});

const salesByMonth = asyncHandler(async (req, res) => {
  const months = parseInt(req.query.months, 10) || 12;
  const rows = await adminRepo.salesByMonth({ months });
  res.json({ success: true, series: rows });
});

const topCategories = asyncHandler(async (req, res) => {
  const days = parseInt(req.query.days, 10) || 30;
  const limit = parseInt(req.query.limit, 10) || 10;
  const rows = await adminRepo.topCategories({ days, limit });
  res.json({ success: true, categories: rows });
});

const userGrowth = asyncHandler(async (req, res) => {
  const days = parseInt(req.query.days, 10) || 30;
  const rows = await adminRepo.userGrowth({ days });
  res.json({ success: true, series: rows });
});

const ordersByGovernorate = asyncHandler(async (req, res) => {
  const days = parseInt(req.query.days, 10) || 30;
  const rows = await adminRepo.ordersByGovernorate({ days });
  res.json({ success: true, distribution: rows });
});

// ─── Users ────────────────────────────────────────────────────────────

const listUsers = asyncHandler(async (req, res) => {
  const { page, limit, role, status, search } = req.query;
  const result = await adminRepo.listUsers({ page, limit, role, status, search });
  res.json({ success: true, ...result });
});

// ─── Account approval workflow ────────────────────────────────────────

const listPendingUsers = asyncHandler(async (req, res) => {
  const { page, limit } = req.query;
  const result = await adminRepo.listPendingUsers({ page, limit });
  res.json({ success: true, ...result });
});

/**
 * PATCH /admin/users/:id/status
 * Body: { status: 'pending'|'approved'|'rejected'|'blocked'|'deleted', reason? }
 */
const setUserStatus = asyncHandler(async (req, res) => {
  const { status, reason = null } = req.body;
  if (!status) throw new AppError("status is required", 400);

  // Don't let an admin lock themselves out by mistake.
  if (req.params.id === req.user.id && ["blocked", "deleted"].includes(status)) {
    throw new AppError("Refusing to block or delete your own admin account.", 400);
  }

  // Find target first so we can sanity-check role and notify.
  const target = await knex("users").where({ id: req.params.id }).first();
  if (!target) throw new AppError("User not found", 404);

  const oldStatus = target.account_status;
  const row = await adminRepo.setUserStatus(req.params.id, {
    status,
    reason,
    changedBy: req.user.id,
  });
  if (!row) throw new AppError("User not found", 404);

  // Audit
  auditService.record(req, {
    action: A.USER_STATUS_CHANGED,
    targetType: "user",
    targetId: row.id,
    before: { account_status: oldStatus },
    after: { account_status: status },
    notes: reason,
  });

  // Notify the user about the status change.
  const messages = {
    approved: {
      title: "تم اعتماد حسابك",
      message:
        target.role === "owner"
          ? "تم تفعيل صلاحيات البيع والتأجير. يمكنك الآن إضافة معداتك ومنتجاتك."
          : target.role === "delivery"
          ? "تم تفعيل صلاحيات التوصيل. يمكنك الآن قبول طلبات التوصيل."
          : "تم اعتماد حسابك.",
    },
    rejected: {
      title: "تم رفض تفعيل صلاحيات حسابك",
      message: reason
        ? `لم تتم الموافقة على تفعيل الصلاحيات. السبب: ${reason}`
        : "لم تتم الموافقة على تفعيل صلاحيات حسابك. يمكنك التواصل مع الإدارة لإعادة المراجعة.",
    },
    blocked: {
      title: "تم إيقاف حسابك",
      message: reason
        ? `تم إيقاف حسابك. السبب: ${reason}`
        : "تم إيقاف حسابك. للاستفسار يُرجى التواصل مع الدعم.",
    },
    pending: {
      title: "حسابك أُعيد إلى المراجعة",
      message: "تمت إعادة حسابك إلى قائمة المراجعة من قِبل الإدارة.",
    },
    deleted: {
      title: "تم حذف حسابك",
      message: "تم حذف حسابك من النظام.",
    },
  };
  const note = messages[status];
  if (note) {
    notificationService
      .notify({
        userId: row.id,
        type: "system",
        title: note.title,
        message: note.message,
        metadata: { account_status: status, reason },
        email: status !== "deleted",
      })
      .catch((e) => console.error("[user status notify]", e.message));
  }

  res.json({ success: true, user: row });
});

const setUserActive = asyncHandler(async (req, res) => {
  const { is_active } = req.body;
  if (typeof is_active !== "boolean") {
    throw new AppError("is_active must be a boolean", 400);
  }
  // Snapshot before for audit.
  const before = await knex("users").where({ id: req.params.id }).first("is_active");
  const row = await adminRepo.setUserActive(req.params.id, is_active);
  if (!row) throw new AppError("User not found", 404);
  auditService.record(req, {
    action: A.USER_STATUS_CHANGED,
    targetType: "user",
    targetId: row.id,
    before: { is_active: before ? before.is_active : null },
    after: { is_active },
  });
  res.json({ success: true, user: row });
});

const setUserPro = asyncHandler(async (req, res) => {
  const { is_pro, expires_at = null } = req.body;
  if (typeof is_pro !== "boolean") {
    throw new AppError("is_pro must be a boolean", 400);
  }
  if (expires_at && isNaN(Date.parse(expires_at))) {
    throw new AppError("expires_at must be a valid ISO date", 400);
  }
  const before = await knex("users")
    .where({ id: req.params.id })
    .first("is_pro", "pro_expires_at");
  const row = await adminRepo.setUserPro(req.params.id, {
    isPro: is_pro,
    expiresAt: expires_at,
  });
  if (!row) throw new AppError("User not found", 404);
  auditService.record(req, {
    action: A.USER_PRO_TOGGLED,
    targetType: "user",
    targetId: row.id,
    before: before
      ? { is_pro: before.is_pro, pro_expires_at: before.pro_expires_at }
      : null,
    after: { is_pro, pro_expires_at: expires_at },
  });
  res.json({ success: true, user: row });
});

// ─── Bulk user operations ─────────────────────────────────────────────

/**
 * POST /admin/users/bulk-status
 * Body: { user_ids: [uuid...], status, reason? }
 *
 * Apply the same account_status to multiple users in one shot. Admin rows
 * in the input are silently skipped (returned in `skipped_admin_ids`) so
 * an operator can't accidentally lock another admin out.
 */
const bulkSetUserStatus = asyncHandler(async (req, res) => {
  const { user_ids = [], status, reason = null } = req.body;
  if (!Array.isArray(user_ids) || !user_ids.length) {
    throw new AppError("user_ids is required and must be a non-empty array", 400);
  }
  // Don't bulk-touch the caller's own account.
  const filtered = user_ids.filter((id) => id !== req.user.id);

  const result = await adminRepo.bulkSetUserStatus(filtered, {
    status,
    reason,
    changedBy: req.user.id,
  });

  // Single audit row capturing the whole bulk action with per-user diffs
  // inside `before/after`. The audit-log UI flattens this when showing
  // details. We don't write per-row entries — that would create N rows
  // every time and bloat the table.
  auditService.record(req, {
    action: A.USER_BULK_STATUS_CHANGED,
    targetType: "user",
    targetId: null,
    before: null,
    after: { status, count: result.updated_ids.length, ids: result.updated_ids },
    notes: reason,
  });

  // Best-effort fan-out of in-app notifications. Cap to avoid hammering
  // the notification service on huge bulks.
  const notifyCap = 100;
  const toNotify = result.updated_ids.slice(0, notifyCap);
  Promise.allSettled(
    toNotify.map((uid) =>
      notificationService.notify({
        userId: uid,
        type: "system",
        title:
          status === "approved"
            ? "تم اعتماد حسابك"
            : status === "rejected"
            ? "تم رفض تفعيل صلاحيات حسابك"
            : status === "blocked"
            ? "تم إيقاف حسابك"
            : "تم تحديث حالة حسابك",
        message: reason || "تم تحديث حالة حسابك من قِبل الإدارة.",
        metadata: { account_status: status, reason, bulk: true },
        email: status !== "deleted",
      }),
    ),
  ).catch((e) => console.error("[bulk notify]", e?.message));

  res.json({
    success: true,
    updated: result.updated_ids.length,
    skipped_admin_ids: result.skipped_admin_ids,
    updated_ids: result.updated_ids,
  });
});

// ─── Rental delivery dispatch ─────────────────────────────────────────

const dispatchRental = asyncHandler(async (req, res) => {
  const rental = await knex("rentals").where({ id: req.params.id }).first();
  if (!rental) throw new AppError("Rental not found", 404);
  if (!["approved", "active"].includes(rental.status)) {
    throw new AppError("يجب أن يكون الإيجار موافقاً عليه أو نشطاً لإرساله للتوصيل", 400);
  }

  // Check if a delivery request already exists
  const existing = await knex("delivery_requests").where({ rental_id: rental.id }).first("id", "status");
  if (existing) {
    return res.json({ success: true, note: `طلب توصيل موجود مسبقاً (${existing.status})`, delivery: existing });
  }

  const addr = rental.delivery_address
    ? (typeof rental.delivery_address === "string" ? JSON.parse(rental.delivery_address) : rental.delivery_address)
    : { city: "غير محدد", notes: "تواصل مع المستأجر لتحديد العنوان" };

  const owner = await knex("users").where({ id: rental.owner_id }).first("name");
  const [delivery] = await knex("delivery_requests")
    .insert({
      rental_id: rental.id,
      courier_id: null,
      status: "pending",
      pickup_address: JSON.stringify({ city: "عُمان", notes: `اتصل بالمالك: ${owner?.name || ""}` }),
      dropoff_address: JSON.stringify(addr),
      scheduled_date: rental.start_date,
      fee: 2.0,
    })
    .returning("*");

  res.json({ success: true, delivery });
});

// ─── Orders ───────────────────────────────────────────────────────────

const getOrderById = asyncHandler(async (req, res) => {
  const order = await orderRepo.getByIdForAdmin(req.params.id);
  if (!order) throw new AppError("Order not found", 404);
  res.json({ success: true, order });
});

const listOrders = asyncHandler(async (req, res) => {
  const { page, limit, status, payment_status } = req.query;
  const result = await orderRepo.listAll({
    page,
    limit,
    status,
    paymentStatus: payment_status,
  });
  res.json({ success: true, ...result });
});

// ─── Promo Codes CRUD ─────────────────────────────────────────────────

const listPromos = asyncHandler(async (req, res) => {
  const { page, limit, active_only } = req.query;
  const result = await promoRepo.listAll({
    page,
    limit,
    activeOnly: active_only === "true" || active_only === "1",
  });
  res.json({ success: true, ...result });
});

const createPromo = asyncHandler(async (req, res) => {
  const {
    code,
    type,
    value,
    min_order_total = null,
    max_discount = null,
    max_uses = null,
    expiry_date = null,
    is_active = true,
  } = req.body;

  const row = await promoRepo.create({
    code: String(code).trim(),
    type,
    value: Number(value),
    min_order_total: min_order_total != null ? Number(min_order_total) : null,
    max_discount: max_discount != null ? Number(max_discount) : null,
    max_uses: max_uses != null ? parseInt(max_uses, 10) : null,
    expiry_date: expiry_date || null,
    is_active,
  });

  auditService.record(req, {
    action: A.PROMO_CREATED,
    targetType: "promo",
    targetId: row.id,
    after: { code: row.code, type: row.type, value: row.value },
  });

  res.status(201).json({ success: true, promo: row });
});

const updatePromo = asyncHandler(async (req, res) => {
  const patch = {};
  const allowed = [
    "code",
    "type",
    "value",
    "min_order_total",
    "max_discount",
    "max_uses",
    "expiry_date",
    "is_active",
  ];
  for (const k of allowed) {
    if (req.body[k] !== undefined) patch[k] = req.body[k];
  }
  const before = await knex("promo_codes").where({ id: req.params.id }).first();
  const row = await promoRepo.update(req.params.id, patch);
  if (!row) throw new AppError("Promo not found", 404);
  auditService.record(req, {
    action: A.PROMO_UPDATED,
    targetType: "promo",
    targetId: row.id,
    before: before ? { ...patch, _: undefined, code: before.code, value: before.value } : null,
    after: patch,
  });
  res.json({ success: true, promo: row });
});

const deletePromo = asyncHandler(async (req, res) => {
  const before = await knex("promo_codes").where({ id: req.params.id }).first("id", "code");
  const ok = await promoRepo.remove(req.params.id);
  if (!ok) throw new AppError("Promo not found", 404);
  auditService.record(req, {
    action: A.PROMO_DELETED,
    targetType: "promo",
    targetId: req.params.id,
    before: before ? { code: before.code } : null,
  });
  res.json({ success: true });
});

// ─── Commissions (admin view) ────────────────────────────────────────

const listCommissions = asyncHandler(async (req, res) => {
  const { page, limit, status, owner_id, from, to, search } = req.query;
  const result = await commissionRepo.listAll({
    page,
    limit,
    status,
    ownerId: owner_id,
    from,
    to,
    search,
  });
  res.json({ success: true, ...result });
});

/**
 * GET /admin/commissions/export — CSV download, same filters as listCommissions
 * but unpaginated (capped server-side in the repository).
 */
const exportCommissions = asyncHandler(async (req, res) => {
  const { status, owner_id, from, to, search } = req.query;
  const rows = await commissionRepo.listForExport({
    status,
    ownerId: owner_id,
    from,
    to,
    search,
  });

  const escapeCsv = (v) => {
    if (v == null) return "";
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  const header = [
    "date",
    "owner_name",
    "owner_email",
    "equipment_name",
    "gross_amount",
    "rate",
    "commission_amount",
    "net_amount",
    "status",
  ];
  const lines = [header.join(",")];
  for (const r of rows) {
    lines.push(
      [
        r.created_at,
        r.owner_name,
        r.owner_email,
        r.equipment_name,
        r.gross_amount,
        r.rate,
        r.commission_amount,
        r.net_amount,
        r.status,
      ]
        .map(escapeCsv)
        .join(","),
    );
  }

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="commissions-${Date.now()}.csv"`,
  );
  res.send(lines.join("\n"));
});

// ─── Commission settings (global rate) ──────────────────────────────

const getCommissionSettings = asyncHandler(async (req, res) => {
  const settings = await settingsRepo.getCommissionSettings();
  res.json({ success: true, settings });
});

const updateCommissionSettings = asyncHandler(async (req, res) => {
  const before = await settingsRepo.getCommissionSettings();
  const row = await settingsRepo.setCommissionPercentage(req.body.percentage, req.user.id);
  auditService.record(req, {
    action: A.COMMISSION_SETTINGS_UPDATED,
    targetType: "commission_settings",
    targetId: "1",
    before: { percentage: before.percentage },
    after: { percentage: row.percentage },
  });
  res.json({ success: true, settings: row });
});

const markCommissionPaid = asyncHandler(async (req, res) => {
  const row = await commissionRepo.markPaid(req.params.id);
  auditService.record(req, {
    action: A.COMMISSION_MARKED_PAID,
    targetType: "commission",
    targetId: row.id,
    after: { status: "paid", paid_at: row.paid_at },
  });
  res.json({ success: true, commission: row });
});

const cancelCommission = asyncHandler(async (req, res) => {
  const row = await commissionRepo.markCancelled(req.params.id, req.body.notes);
  auditService.record(req, {
    action: A.COMMISSION_CANCELLED,
    targetType: "commission",
    targetId: row.id,
    notes: req.body.notes,
    after: { status: "cancelled" },
  });
  res.json({ success: true, commission: row });
});

// ─── Equipment approval workflow ────────────────────────────────────

const listPendingEquipment = asyncHandler(async (req, res) => {
  const { page, limit } = req.query;
  const result = await equipmentRepo.listPending({ page, limit });
  res.json({ success: true, ...result });
});

const approveEquipment = asyncHandler(async (req, res) => {
  const before = await knex("equipment")
    .where({ id: req.params.id })
    .first("approval_status");
  const row = await equipmentRepo.approve(req.params.id, req.user.id);
  if (!row) throw new AppError("Equipment not found", 404);

  auditService.record(req, {
    action: A.EQUIPMENT_APPROVED,
    targetType: "equipment",
    targetId: row.id,
    before: before ? { approval_status: before.approval_status } : null,
    after: { approval_status: "approved" },
  });

  notificationService
    .notify({
      userId: row.owner_id,
      type: "system",
      title: "تمت الموافقة على معدتك",
      message: `تم اعتماد معدتك "${row.name}" وأصبحت متاحة للعرض.`,
      metadata: { equipment_id: row.id },
      email: true,
    })
    .catch((e) => console.error("[approve equipment notify]", e.message));

  res.json({ success: true, equipment: row });
});

const rejectEquipment = asyncHandler(async (req, res) => {
  const before = await knex("equipment")
    .where({ id: req.params.id })
    .first("approval_status");
  const row = await equipmentRepo.reject(req.params.id, req.user.id, req.body.reason);
  if (!row) throw new AppError("Equipment not found", 404);

  auditService.record(req, {
    action: A.EQUIPMENT_REJECTED,
    targetType: "equipment",
    targetId: row.id,
    before: before ? { approval_status: before.approval_status } : null,
    after: { approval_status: "rejected" },
    notes: req.body.reason,
  });

  notificationService
    .notify({
      userId: row.owner_id,
      type: "system",
      title: "رُفضت معدتك",
      message: `تم رفض معدتك "${row.name}". السبب: ${row.rejection_reason}`,
      metadata: { equipment_id: row.id },
      email: true,
    })
    .catch((e) => console.error("[reject equipment notify]", e.message));

  res.json({ success: true, equipment: row });
});

/**
 * POST /admin/equipment/bulk-action
 * Body: { equipment_ids: [uuid...], action: 'approve'|'reject'|'hide'|'show', reason? }
 *
 * Apply the same moderation action to multiple equipment listings.
 *   - approve  → approval_status = 'approved'
 *   - reject   → approval_status = 'rejected' (reason recommended)
 *   - hide     → status          = 'hidden'
 *   - show     → status          = 'available'
 */
const bulkEquipmentAction = asyncHandler(async (req, res) => {
  const { equipment_ids = [], action, reason = null } = req.body;
  if (!Array.isArray(equipment_ids) || !equipment_ids.length) {
    throw new AppError("equipment_ids is required and must be a non-empty array", 400);
  }

  const patches = {
    approve: { approval_status: "approved" },
    reject: {
      approval_status: "rejected",
      rejection_reason: reason || "Bulk rejection",
    },
    hide: { status: "hidden" },
    show: { status: "available" },
  };
  if (!patches[action]) {
    throw new AppError(
      `Unknown bulk action '${action}'. Allowed: approve, reject, hide, show.`,
      400,
    );
  }

  const result = await adminRepo.bulkUpdateEquipment(equipment_ids, patches[action], {
    reviewedBy: req.user.id,
  });

  const auditAction =
    action === "approve"
      ? A.EQUIPMENT_BULK_APPROVED
      : action === "reject"
      ? A.EQUIPMENT_BULK_REJECTED
      : A.EQUIPMENT_BULK_HIDDEN;

  auditService.record(req, {
    action: auditAction,
    targetType: "equipment",
    targetId: null,
    after: {
      action,
      count: result.updated_ids.length,
      ids: result.updated_ids,
    },
    notes: reason,
  });

  // Owner notifications for approvals/rejections — fire-and-forget. Skip
  // for hide/show since those are usually invisible to the owner.
  if (action === "approve" || action === "reject") {
    const items = await knex("equipment")
      .whereIn("id", result.updated_ids)
      .select("id", "name", "owner_id");
    Promise.allSettled(
      items.slice(0, 200).map((eq) =>
        notificationService.notify({
          userId: eq.owner_id,
          type: "system",
          title:
            action === "approve"
              ? "تمت الموافقة على معدتك"
              : "رُفضت معدتك",
          message:
            action === "approve"
              ? `تم اعتماد معدتك "${eq.name}".`
              : `تم رفض معدتك "${eq.name}".${reason ? " السبب: " + reason : ""}`,
          metadata: { equipment_id: eq.id, bulk: true },
          email: true,
        }),
      ),
    ).catch((e) => console.error("[bulk equip notify]", e?.message));
  }

  res.json({
    success: true,
    updated: result.updated_ids.length,
    updated_ids: result.updated_ids,
  });
});

// ─── Deliveries admin view ──────────────────────────────────────────

const listDeliveries = asyncHandler(async (req, res) => {
  const { page = 1, limit = 20, status } = req.query;
  const safeLimit = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
  const safePage = Math.max(1, parseInt(page, 10) || 1);
  const offset = (safePage - 1) * safeLimit;

  const dataQ = knex("delivery_requests as d")
    .leftJoin("users as c", "c.id", "d.courier_id")
    .leftJoin("orders as o", "o.id", "d.order_id")
    .leftJoin("rentals as r", "r.id", "d.rental_id")
    .leftJoin("users as cust1", "cust1.id", "o.user_id")
    .leftJoin("users as cust2", "cust2.id", "r.renter_id")
    .select(
      "d.*",
      "c.name as courier_name",
      "c.phone as courier_phone",
      "c.email as courier_email",
      "o.tracking_number as order_tracking",
      knex.raw("coalesce(cust1.name, cust2.name) as customer_name"),
      knex.raw("coalesce(cust1.phone, cust2.phone) as customer_phone"),
    )
    .orderBy("d.created_at", "desc")
    .limit(safeLimit)
    .offset(offset);

  const countQ = knex("delivery_requests").count("* as c").first();
  if (status) {
    dataQ.where("d.status", status);
    countQ.where("status", status);
  }

  const [items, countRow] = await Promise.all([dataQ, countQ]);
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

// ─── Audit log ────────────────────────────────────────────────────────

const listAudit = asyncHandler(async (req, res) => {
  const {
    page,
    limit,
    actor_id,
    action,
    target_type,
    target_id,
    search,
    from,
    to,
  } = req.query;
  const result = await auditService.list({
    page,
    limit,
    actorId: actor_id,
    action,
    targetType: target_type,
    targetId: target_id,
    search,
    from,
    to,
  });
  res.json({ success: true, ...result });
});

const auditActions = asyncHandler(async (_req, res) => {
  const actions = await auditService.distinctActions();
  res.json({ success: true, actions });
});

// ─── Payouts ──────────────────────────────────────────────────────────

const listOwnerBalances = asyncHandler(async (req, res) => {
  const { page, limit, only_pending, search } = req.query;
  const result = await payoutRepo.listOwnerBalances({
    page,
    limit,
    onlyPending: only_pending === "true" || only_pending === "1",
    search,
  });
  res.json({ success: true, ...result });
});

const getOwnerPendingDetail = asyncHandler(async (req, res) => {
  const detail = await payoutRepo.getOwnerPendingDetail(req.params.ownerId);
  res.json({ success: true, ...detail });
});

const createPayout = asyncHandler(async (req, res) => {
  const {
    method = "bank_transfer",
    reference = null,
    notes = null,
    commission_ids = null,
  } = req.body;
  const ownerId = req.params.ownerId;

  const result = await payoutRepo.createPayout({
    ownerId,
    adminId: req.user.id,
    method,
    reference,
    notes,
    commissionIds: commission_ids,
  });

  auditService.record(req, {
    action: A.PAYOUT_CREATED,
    targetType: "payout_batch",
    targetId: result.batch.id,
    after: {
      owner_id: ownerId,
      total_amount: result.total_amount,
      transaction_count: result.items_count,
      method,
      reference,
    },
    notes,
  });

  // Tell the farmer their money is on the way.
  notificationService
    .notify({
      userId: ownerId,
      type: "system",
      title: "تم صرف مستحقّاتك",
      message: `تم تحويل مبلغ ${result.total_amount} ر.ع لك (${result.items_count} عملية). ${
        reference ? "المرجع: " + reference : ""
      }`,
      metadata: {
        payout_id: result.batch.id,
        amount: result.total_amount,
        method,
        reference,
      },
      email: true,
    })
    .catch((e) => console.error("[payout notify]", e.message));

  res.status(201).json({ success: true, ...result });
});

const listPayouts = asyncHandler(async (req, res) => {
  const { page, limit, owner_id, status, from, to } = req.query;
  const result = await payoutRepo.listPayouts({
    page,
    limit,
    ownerId: owner_id,
    status,
    from,
    to,
  });
  res.json({ success: true, ...result });
});

const cancelPayout = asyncHandler(async (req, res) => {
  const { notes = null } = req.body;
  const row = await payoutRepo.cancelPayout(req.params.batchId, {
    adminId: req.user.id,
    notes,
  });
  auditService.record(req, {
    action: A.PAYOUT_CANCELLED,
    targetType: "payout_batch",
    targetId: row.id,
    notes,
    after: { status: "cancelled" },
  });
  res.json({ success: true, batch: row });
});

const getUserById = asyncHandler(async (req, res) => {
  const user = await knex("users")
    .where({ id: req.params.id })
    .first(
      "id", "name", "email", "phone", "role", "account_status",
      "identity_status", "identity_verified",
      "id_front_url", "id_back_url", "selfie_url", "identity",
      "is_pro", "created_at"
    );
  if (!user) throw new AppError("User not found", 404);
  res.json({ success: true, user });
});

const forceDeleteEquipment = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const existing = await equipmentRepo.getById(id);
  if (!existing) throw new AppError("Equipment not found", 404);

  await knex.transaction(async (trx) => {
    await trx("order_items").where({ equipment_id: id }).update({ equipment_id: null });
    await trx("rentals").where({ equipment_id: id }).update({ equipment_id: null });
    await trx("wishlists").where({ equipment_id: id }).delete();
    await trx("cart_items").where({ equipment_id: id }).delete();
    await trx("equipment").where({ id }).delete();
  });

  await auditService.record({
    actorId: req.user.id,
    action: "EQUIPMENT_FORCE_DELETED",
    targetType: "equipment",
    targetId: id,
    after: { name: existing.name },
  });

  res.json({ success: true });
});

module.exports = {
  // Stats / charts
  stats,
  topOwners,
  revenueTimeseries,
  salesByMonth,
  topCategories,
  userGrowth,
  ordersByGovernorate,
  // Users
  listUsers,
  listPendingUsers,
  getUserById,
  setUserStatus,
  setUserActive,
  setUserPro,
  bulkSetUserStatus,
  // Orders / promos / commissions
  dispatchRental,
  getOrderById,
  listOrders,
  listPromos,
  createPromo,
  updatePromo,
  deletePromo,
  listCommissions,
  exportCommissions,
  markCommissionPaid,
  cancelCommission,
  getCommissionSettings,
  updateCommissionSettings,
  // Equipment
  listPendingEquipment,
  approveEquipment,
  rejectEquipment,
  bulkEquipmentAction,
  forceDeleteEquipment,
  // Deliveries
  listDeliveries,
  // Audit
  listAudit,
  auditActions,
  // Payouts
  listOwnerBalances,
  getOwnerPendingDetail,
  createPayout,
  listPayouts,
  cancelPayout,
};
