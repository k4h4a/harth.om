const express = require("express");
const router = express.Router();

const auth = require("../middleware/auth");
const requireRole = require("../middleware/requireRole");
const { param, body, query } = require("express-validator");
const { validate } = require("../validators/auth.validator");
const ctrl = require("../controllers/admin.controller");

// Every admin route requires admin role. Applying once here keeps handlers tidy.
router.use(auth, requireRole("admin"));

// ─── Dashboard / reports ───────────────────────────────────────────
router.get("/stats", ctrl.stats);

router.get(
  "/reports/top-owners",
  [
    query("days").optional().isInt({ min: 1, max: 365 }).toInt(),
    query("limit").optional().isInt({ min: 1, max: 100 }).toInt(),
    validate,
  ],
  ctrl.topOwners,
);
router.get(
  "/reports/revenue-timeseries",
  [query("days").optional().isInt({ min: 1, max: 365 }).toInt(), validate],
  ctrl.revenueTimeseries,
);

// New chart-feeding reports.
// Sales-by-month — last N months of order + rental revenue, monthly buckets.
router.get(
  "/reports/sales-by-month",
  [query("months").optional().isInt({ min: 1, max: 36 }).toInt(), validate],
  ctrl.salesByMonth,
);
// Top categories — by gross revenue across paid orders.
router.get(
  "/reports/top-categories",
  [
    query("days").optional().isInt({ min: 1, max: 365 }).toInt(),
    query("limit").optional().isInt({ min: 1, max: 50 }).toInt(),
    validate,
  ],
  ctrl.topCategories,
);
// User growth — daily new signups by role.
router.get(
  "/reports/user-growth",
  [query("days").optional().isInt({ min: 1, max: 365 }).toInt(), validate],
  ctrl.userGrowth,
);
// Orders by governorate — geographic distribution.
router.get(
  "/reports/orders-by-governorate",
  [query("days").optional().isInt({ min: 1, max: 365 }).toInt(), validate],
  ctrl.ordersByGovernorate,
);

// ─── Users ─────────────────────────────────────────────────────────
router.get(
  "/users",
  [
    query("page").optional().isInt({ min: 1 }).toInt(),
    query("limit").optional().isInt({ min: 1, max: 100 }).toInt(),
    query("role")
      .optional()
      .isIn(["admin", "owner", "renter", "delivery"]),
    query("status")
      .optional()
      .isIn(["pending", "approved", "rejected", "blocked", "deleted"]),
    query("search").optional().isString().isLength({ max: 200 }),
    validate,
  ],
  ctrl.listUsers,
);

router.get(
  "/users/pending",
  [
    query("page").optional().isInt({ min: 1 }).toInt(),
    query("limit").optional().isInt({ min: 1, max: 100 }).toInt(),
    validate,
  ],
  ctrl.listPendingUsers,
);

router.get("/users/:id", [param("id").isUUID(), validate], ctrl.getUserById);

router.patch(
  "/users/:id/status",
  [
    param("id").isUUID(),
    body("status").isIn(["pending", "approved", "rejected", "blocked", "deleted"]),
    body("reason").optional({ values: "null" }).isString().isLength({ max: 1000 }),
    validate,
  ],
  ctrl.setUserStatus,
);

router.patch(
  "/users/:id/active",
  [param("id").isUUID(), body("is_active").isBoolean(), validate],
  ctrl.setUserActive,
);
router.patch(
  "/users/:id/pro",
  [
    param("id").isUUID(),
    body("is_pro").isBoolean(),
    body("expires_at").optional({ values: "null" }).isISO8601(),
    validate,
  ],
  ctrl.setUserPro,
);

// Bulk user status. Body: { user_ids: [uuid...], status, reason? }
router.post(
  "/users/bulk-status",
  [
    body("user_ids")
      .isArray({ min: 1, max: 500 })
      .withMessage("user_ids must be a 1–500 element array"),
    body("user_ids.*").isUUID().withMessage("Each user_id must be a UUID"),
    body("status").isIn(["pending", "approved", "rejected", "blocked", "deleted"]),
    body("reason").optional({ values: "null" }).isString().isLength({ max: 1000 }),
    validate,
  ],
  ctrl.bulkSetUserStatus,
);

// ─── Orders ────────────────────────────────────────────────────────
router.get(
  "/orders/:id",
  [param("id").isUUID(), validate],
  ctrl.getOrderById,
);

router.get(
  "/orders",
  [
    query("page").optional().isInt({ min: 1 }).toInt(),
    query("limit").optional().isInt({ min: 1, max: 100 }).toInt(),
    query("status")
      .optional()
      .isIn(["pending", "confirmed", "shipped", "delivered", "cancelled", "refunded"]),
    query("payment_status")
      .optional()
      .isIn(["pending", "paid", "failed", "refunded"]),
    validate,
  ],
  ctrl.listOrders,
);

// ─── Promo codes ───────────────────────────────────────────────────
router.get(
  "/promos",
  [
    query("page").optional().isInt({ min: 1 }).toInt(),
    query("limit").optional().isInt({ min: 1, max: 100 }).toInt(),
    query("active_only").optional().isIn(["true", "false", "0", "1"]),
    validate,
  ],
  ctrl.listPromos,
);
router.post(
  "/promos",
  [
    body("code").isString().trim().isLength({ min: 1, max: 32 }),
    body("type").isIn(["percentage", "fixed"]),
    body("value").isFloat({ min: 0 }).toFloat(),
    body("min_order_total").optional({ values: "null" }).isFloat({ min: 0 }).toFloat(),
    body("max_discount").optional({ values: "null" }).isFloat({ min: 0 }).toFloat(),
    body("max_uses").optional({ values: "null" }).isInt({ min: 1 }).toInt(),
    body("expiry_date").optional({ values: "null" }).isISO8601(),
    body("is_active").optional().isBoolean(),
    validate,
  ],
  ctrl.createPromo,
);
router.patch(
  "/promos/:id",
  [
    param("id").isUUID(),
    body("code").optional().isString().trim().isLength({ min: 1, max: 32 }),
    body("type").optional().isIn(["percentage", "fixed"]),
    body("value").optional().isFloat({ min: 0 }).toFloat(),
    body("min_order_total").optional({ values: "null" }).isFloat({ min: 0 }).toFloat(),
    body("max_discount").optional({ values: "null" }).isFloat({ min: 0 }).toFloat(),
    body("max_uses").optional({ values: "null" }).isInt({ min: 1 }).toInt(),
    body("expiry_date").optional({ values: "null" }).isISO8601(),
    body("is_active").optional().isBoolean(),
    validate,
  ],
  ctrl.updatePromo,
);
router.delete("/promos/:id", [param("id").isUUID(), validate], ctrl.deletePromo);

// ─── Commission settings (global rate) ──────────────────────────────
router.get("/settings/commission", ctrl.getCommissionSettings);
router.patch(
  "/settings/commission",
  [body("percentage").isFloat({ min: 0, max: 100 }), validate],
  ctrl.updateCommissionSettings,
);

// ─── Commissions ───────────────────────────────────────────────────
const commissionFilterValidators = [
  query("status").optional().isIn(["pending", "paid", "cancelled"]),
  query("owner_id").optional().isUUID(),
  query("from").optional().isISO8601(),
  query("to").optional().isISO8601(),
  query("search").optional().isString().isLength({ max: 200 }),
];
router.get(
  "/commissions",
  [
    query("page").optional().isInt({ min: 1 }).toInt(),
    query("limit").optional().isInt({ min: 1, max: 100 }).toInt(),
    ...commissionFilterValidators,
    validate,
  ],
  ctrl.listCommissions,
);
router.get(
  "/commissions/export",
  [...commissionFilterValidators, validate],
  ctrl.exportCommissions,
);
router.post(
  "/commissions/:id/pay",
  [param("id").isUUID(), validate],
  ctrl.markCommissionPaid,
);
router.post(
  "/commissions/:id/cancel",
  [
    param("id").isUUID(),
    body("notes").optional({ values: "null" }).isString().isLength({ max: 2000 }),
    validate,
  ],
  ctrl.cancelCommission,
);

// ─── Rental delivery dispatch (admin manually creates delivery request) ───
router.post(
  "/rentals/:id/dispatch",
  [param("id").isUUID(), validate],
  ctrl.dispatchRental,
);

// ─── Equipment approval workflow ───────────────────────────────────
router.get(
  "/equipment/pending",
  [
    query("page").optional().isInt({ min: 1 }).toInt(),
    query("limit").optional().isInt({ min: 1, max: 100 }).toInt(),
    validate,
  ],
  ctrl.listPendingEquipment,
);
router.post(
  "/equipment/:id/approve",
  [param("id").isUUID(), validate],
  ctrl.approveEquipment,
);
router.post(
  "/equipment/:id/reject",
  [
    param("id").isUUID(),
    body("reason").optional({ values: "null" }).isString().isLength({ max: 500 }),
    validate,
  ],
  ctrl.rejectEquipment,
);

// Admin force-delete — bypasses FK restrictions by nullifying references first.
router.delete("/equipment/:id", [param("id").isUUID(), validate], ctrl.forceDeleteEquipment);

// Bulk equipment moderation. Body: { equipment_ids: [...], action, reason? }
router.post(
  "/equipment/bulk-action",
  [
    body("equipment_ids")
      .isArray({ min: 1, max: 500 })
      .withMessage("equipment_ids must be a 1–500 element array"),
    body("equipment_ids.*").isUUID().withMessage("Each equipment_id must be a UUID"),
    body("action").isIn(["approve", "reject", "hide", "show"]),
    body("reason").optional({ values: "null" }).isString().isLength({ max: 500 }),
    validate,
  ],
  ctrl.bulkEquipmentAction,
);

// ─── Deliveries (admin view) ───────────────────────────────────────
router.get(
  "/deliveries",
  [
    query("page").optional().isInt({ min: 1 }).toInt(),
    query("limit").optional().isInt({ min: 1, max: 100 }).toInt(),
    query("status")
      .optional()
      .isIn(["pending", "accepted", "picked_up", "in_transit", "delivered", "cancelled"]),
    validate,
  ],
  ctrl.listDeliveries,
);

// ─── Audit log ─────────────────────────────────────────────────────
// Listing is paginated and filterable; the actions endpoint feeds the
// dropdown filter on the audit-log UI.
router.get(
  "/audit",
  [
    query("page").optional().isInt({ min: 1 }).toInt(),
    query("limit").optional().isInt({ min: 1, max: 200 }).toInt(),
    query("actor_id").optional().isUUID(),
    query("action").optional().isString().isLength({ max: 80 }),
    query("target_type").optional().isString().isLength({ max: 60 }),
    query("target_id").optional().isString().isLength({ max: 100 }),
    query("search").optional().isString().isLength({ max: 200 }),
    query("from").optional().isISO8601(),
    query("to").optional().isISO8601(),
    validate,
  ],
  ctrl.listAudit,
);
router.get("/audit/actions", ctrl.auditActions);

// ─── Payouts ───────────────────────────────────────────────────────
// Per-owner balances (the "who has money to receive" list).
router.get(
  "/payouts/balances",
  [
    query("page").optional().isInt({ min: 1 }).toInt(),
    query("limit").optional().isInt({ min: 1, max: 100 }).toInt(),
    query("only_pending").optional().isIn(["true", "false", "0", "1"]),
    query("search").optional().isString().isLength({ max: 200 }),
    validate,
  ],
  ctrl.listOwnerBalances,
);

// Per-owner pending detail (powers the "ماذا سيُصرف؟" preview before Pay Now).
router.get(
  "/payouts/owner/:ownerId/pending",
  [param("ownerId").isUUID(), validate],
  ctrl.getOwnerPendingDetail,
);

// Pay Now → creates a payout batch and flips the linked commissions to paid.
router.post(
  "/payouts/owner/:ownerId/pay",
  [
    param("ownerId").isUUID(),
    body("method")
      .optional()
      .isIn(["bank_transfer", "cash", "wallet", "other"]),
    body("reference")
      .optional({ values: "null" })
      .isString()
      .isLength({ max: 200 }),
    body("notes")
      .optional({ values: "null" })
      .isString()
      .isLength({ max: 2000 }),
    body("commission_ids")
      .optional({ values: "null" })
      .isArray({ max: 500 }),
    body("commission_ids.*").optional().isUUID(),
    validate,
  ],
  ctrl.createPayout,
);

// Historical payouts list.
router.get(
  "/payouts",
  [
    query("page").optional().isInt({ min: 1 }).toInt(),
    query("limit").optional().isInt({ min: 1, max: 100 }).toInt(),
    query("owner_id").optional().isUUID(),
    query("status").optional().isIn(["paid", "cancelled"]),
    query("from").optional().isISO8601(),
    query("to").optional().isISO8601(),
    validate,
  ],
  ctrl.listPayouts,
);

router.post(
  "/payouts/:batchId/cancel",
  [
    param("batchId").isUUID(),
    body("notes")
      .optional({ values: "null" })
      .isString()
      .isLength({ max: 2000 }),
    validate,
  ],
  ctrl.cancelPayout,
);

// ─── KYC (identity-verification) workflow ──────────────────────────
const kycCtrl = require("../controllers/kyc.controller");
const {
  kycListValidator,
  kycUserParamValidator,
  kycRejectValidator,
} = require("../validators/kyc.validator");

router.get("/kyc/pending", kycListValidator, kycCtrl.listPendingKyc);
router.get("/kyc/:userId", kycUserParamValidator, kycCtrl.adminGetKyc);
router.post("/kyc/:userId/approve", kycUserParamValidator, kycCtrl.approveKyc);
router.post("/kyc/:userId/reject", kycRejectValidator, kycCtrl.rejectKyc);

// ─── Hero banners (homepage / tools-page promos) ──────────────────
// Admin-only CRUD; the public read lives at /public/banners.
const bannerCtrl = require("../controllers/banner.controller");
const {
  createBannerValidator,
  updateBannerValidator,
  bannerIdValidator,
  bannerListValidator,
} = require("../validators/banner.validator");

router.get("/banners", bannerListValidator, bannerCtrl.listAll);
router.get("/banners/:id", bannerIdValidator, bannerCtrl.getOne);
router.post("/banners", createBannerValidator, bannerCtrl.create);
router.patch("/banners/:id", updateBannerValidator, bannerCtrl.update);
router.delete("/banners/:id", bannerIdValidator, bannerCtrl.remove);

module.exports = router;
