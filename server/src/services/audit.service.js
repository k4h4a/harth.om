/**
 * Admin audit log service.
 *
 * Single entrypoint for recording an admin action. Call sites are scattered
 * across controllers (status changes, equipment approvals, commission
 * payouts, KYC decisions, etc.) so we keep the API tiny:
 *
 *   await audit.record(req, {
 *     action: 'user_status_changed',
 *     targetType: 'user',
 *     targetId: user.id,
 *     before: { account_status: oldStatus },
 *     after:  { account_status: newStatus },
 *     notes:  reason,
 *   });
 *
 * `req` provides the actor (req.user) and forensics (ip, user-agent). If
 * the call is ever needed without an Express req (e.g. from a cron),
 * `actor` can be passed explicitly.
 *
 * Failure mode: audit writes MUST NOT fail the user's action. We catch and
 * log instead of bubbling — losing an audit row is bad but not as bad as
 * losing the action itself. Operators should monitor the error log for
 * `[audit]` patterns.
 */

const knex = require("../db");

// Curated vocabulary. Adding a new action: pick a snake_case verb that
// reads naturally with the target type. Don't overthink — duplicates that
// turn out wrong can be aliased later via a SQL view.
const ACTIONS = Object.freeze({
  // User lifecycle
  USER_STATUS_CHANGED: "user_status_changed",
  USER_PRO_TOGGLED: "user_pro_toggled",
  USER_BULK_STATUS_CHANGED: "user_bulk_status_changed",
  // Equipment moderation
  EQUIPMENT_APPROVED: "equipment_approved",
  EQUIPMENT_REJECTED: "equipment_rejected",
  EQUIPMENT_BULK_APPROVED: "equipment_bulk_approved",
  EQUIPMENT_BULK_REJECTED: "equipment_bulk_rejected",
  EQUIPMENT_BULK_HIDDEN: "equipment_bulk_hidden",
  // KYC
  KYC_APPROVED: "kyc_approved",
  KYC_REJECTED: "kyc_rejected",
  // Commerce
  PROMO_CREATED: "promo_created",
  PROMO_UPDATED: "promo_updated",
  PROMO_DELETED: "promo_deleted",
  COMMISSION_MARKED_PAID: "commission_marked_paid",
  COMMISSION_CANCELLED: "commission_cancelled",
  COMMISSION_SETTINGS_UPDATED: "commission_settings_updated",
  // Payouts
  PAYOUT_CREATED: "payout_created",
  PAYOUT_CANCELLED: "payout_cancelled",
});

/**
 * Insert an audit row. Returns the row, or null on failure.
 *
 * @param req  Express request (or null for non-HTTP contexts).
 * @param opts {action, targetType?, targetId?, before?, after?, notes?, actor?}
 */
async function record(req, opts) {
  try {
    const actor = opts.actor || (req && req.user) || null;
    const ip = (req && (req.ip || (req.headers && req.headers["x-forwarded-for"]))) || null;
    const userAgent = (req && req.headers && req.headers["user-agent"]) || null;

    const row = {
      actor_id: actor ? actor.id : null,
      actor_name: actor ? actor.name || null : null,
      actor_email: actor ? actor.email || null : null,
      action: opts.action,
      target_type: opts.targetType || null,
      target_id: opts.targetId != null ? String(opts.targetId).slice(0, 100) : null,
      before: opts.before == null ? null : JSON.stringify(opts.before),
      after: opts.after == null ? null : JSON.stringify(opts.after),
      notes: opts.notes || null,
      ip: ip ? String(ip).slice(0, 64) : null,
      user_agent: userAgent ? String(userAgent).slice(0, 500) : null,
    };

    const [inserted] = await knex("admin_audit_logs").insert(row).returning("*");
    return inserted;
  } catch (err) {
    // Log + swallow — never block the user's action because of audit
    // bookkeeping.
    // eslint-disable-next-line no-console
    console.error("[audit] failed to record action:", opts.action, err.message);
    return null;
  }
}

/**
 * Paginated list with a flexible set of filters. Used by the admin
 * "Audit Log" tab.
 */
async function list({
  page = 1,
  limit = 20,
  actorId = null,
  action = null,
  targetType = null,
  targetId = null,
  search = null,
  from = null,
  to = null,
} = {}) {
  const safeLimit = Math.min(200, Math.max(1, parseInt(limit, 10) || 20));
  const safePage = Math.max(1, parseInt(page, 10) || 1);
  const offset = (safePage - 1) * safeLimit;

  const buildWhere = (q) => {
    if (actorId) q.where("actor_id", actorId);
    if (action) q.where("action", action);
    if (targetType) q.where("target_type", targetType);
    if (targetId) q.where("target_id", targetId);
    if (from) q.where("created_at", ">=", from);
    if (to) q.where("created_at", "<=", to);
    if (search) {
      // Match on actor_name / email / notes / action with ILIKE.
      const like = `%${search}%`;
      q.where((w) => {
        w.whereILike("actor_name", like)
          .orWhereILike("actor_email", like)
          .orWhereILike("notes", like)
          .orWhereILike("action", like)
          .orWhereILike("target_id", like);
      });
    }
  };

  const dataQ = knex("admin_audit_logs")
    .orderBy("created_at", "desc")
    .limit(safeLimit)
    .offset(offset);
  buildWhere(dataQ);

  const countQ = knex("admin_audit_logs").count("* as c").first();
  buildWhere(countQ);

  const [items, countRow] = await Promise.all([dataQ, countQ]);
  const total = parseInt(countRow.c, 10);

  return {
    items,
    pagination: {
      page: safePage,
      limit: safeLimit,
      total,
      pages: Math.ceil(total / safeLimit) || 1,
    },
  };
}

/**
 * Distinct list of action codes seen in the table — drives the dropdown
 * filter on the audit-log page so admins don't have to remember the
 * vocabulary.
 */
async function distinctActions() {
  const rows = await knex("admin_audit_logs")
    .distinct("action")
    .orderBy("action", "asc");
  return rows.map((r) => r.action);
}

module.exports = {
  ACTIONS,
  record,
  list,
  distinctActions,
};
