const knex = require("../db");
const { AppError } = require("../middleware/errorHandler");

/**
 * Commission ledger.
 *
 * Rate lookup by owner tier:
 *   non-PRO owner: 10%
 *   PRO owner:      5%
 *
 * Recorded once per order_item (on order paid) or rental (on completion).
 * Operations are idempotent — the unique partial indexes on order_item_id
 * and rental_id catch double-writes and we swallow the 23505.
 */

const STANDARD_RATE = 0.10;
const PRO_RATE = 0.05;

const PUBLIC_FIELDS = [
  "id",
  "owner_id",
  "order_id",
  "rental_id",
  "order_item_id",
  "rate",
  "gross_amount",
  "commission_amount",
  "net_amount",
  "was_pro_at_time",
  "status",
  "paid_at",
  "notes",
  "created_at",
  "updated_at",
];

/**
 * Round money to 2 decimal places.
 */
function money(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

/**
 * Pick the applicable rate for an owner. Called at computation time so
 * rate changes take effect on FUTURE commissions only — existing rows
 * keep the snapshot in their `rate` column.
 */
function rateFor(user) {
  if (user?.is_pro) {
    // PRO is only valid if the expiry hasn't passed. Defensive: treat
    // null expiry as "indefinite PRO" (admin-granted).
    const exp = user.pro_expires_at ? new Date(user.pro_expires_at) : null;
    if (!exp || exp > new Date()) return PRO_RATE;
  }
  return STANDARD_RATE;
}

/**
 * Create a commission record. Idempotent — returns null if one already
 * exists for this source (caller treats it as no-op).
 *
 * `commissionAmount`, when provided, is the commission already baked into
 * the equipment's price at listing time (snapshotted onto the order_item /
 * rental at creation) — we use it as-is instead of re-deriving a rate from
 * the owner's PRO status. `rate` is then back-computed purely as a record
 * of what fraction of gross that amount was.
 */
async function recordCommission({
  ownerId,
  grossAmount,
  commissionAmount = null,
  orderId = null,
  rentalId = null,
  orderItemId = null,
  trx = null,
}) {
  if (!orderItemId && !rentalId) {
    throw new AppError("Must link to order_item_id or rental_id", 400);
  }

  const run = async (t) => {
    const owner = await t("users").where({ id: ownerId }).first("id");
    if (!owner) throw new AppError("Owner not found", 404);

    const gross = money(grossAmount);
    const commission =
      commissionAmount != null ? money(commissionAmount) : money(gross * rateFor(owner));
    const net = money(gross - commission);
    // Rate column is informational (rate of gross that commission represents);
    // keep its full 4-decimal precision rather than rounding to money().
    const rate = gross > 0 ? Math.round((commission / gross) * 10000) / 10000 : 0;

    try {
      const [row] = await t("commission_transactions")
        .insert({
          owner_id: ownerId,
          order_id: orderId,
          rental_id: rentalId,
          order_item_id: orderItemId,
          rate,
          gross_amount: gross,
          commission_amount: commission,
          net_amount: net,
          // PRO-rate discounting no longer applies — commission is baked
          // into the listing price at creation time instead.
          was_pro_at_time: false,
          status: "pending",
        })
        .returning(PUBLIC_FIELDS);
      return row;
    } catch (err) {
      if (err.code === "23505") {
        // Already recorded for this source — idempotent no-op.
        return null;
      }
      throw err;
    }
  };

  return trx ? run(trx) : knex.transaction(run);
}

/**
 * For an order that just transitioned to paid, record one commission
 * row per line item. Each line groups by its equipment's owner (we
 * don't collapse because different owners might share an order — not
 * supported today, but the schema allows it).
 */
async function recordForOrder(orderId, trx) {
  const items = await trx("order_items as oi")
    .join("equipment as e", "e.id", "oi.equipment_id")
    .where("oi.order_id", orderId)
    .select(
      "oi.id as order_item_id",
      "oi.line_total",
      "oi.commission_per_unit",
      "oi.quantity",
      "e.owner_id",
    );

  const recorded = [];
  for (const it of items) {
    const row = await recordCommission({
      ownerId: it.owner_id,
      grossAmount: Number(it.line_total),
      commissionAmount: money(Number(it.commission_per_unit) * it.quantity),
      orderId,
      orderItemId: it.order_item_id,
      trx,
    });
    if (row) recorded.push(row);
  }
  return recorded;
}

/**
 * For a rental that just completed. One commission on the total.
 */
async function recordForRental(rentalId, trx) {
  const rental = await trx("rentals")
    .where({ id: rentalId })
    .first("owner_id", "total_price", "commission_amount_snapshot");
  if (!rental) return null;
  return recordCommission({
    ownerId: rental.owner_id,
    grossAmount: Number(rental.total_price),
    commissionAmount: Number(rental.commission_amount_snapshot) || 0,
    rentalId,
    trx,
  });
}

/**
 * List commissions earned by an owner.
 */
async function listForOwner(ownerId, { page = 1, limit = 20, status = null } = {}) {
  const safeLimit = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
  const safePage = Math.max(1, parseInt(page, 10) || 1);
  const offset = (safePage - 1) * safeLimit;

  const dataQ = knex("commission_transactions")
    .where({ owner_id: ownerId })
    .select(PUBLIC_FIELDS)
    .orderBy("created_at", "desc")
    .limit(safeLimit)
    .offset(offset);

  const countQ = knex("commission_transactions")
    .where({ owner_id: ownerId })
    .count("* as c")
    .first();

  if (status) {
    dataQ.andWhere("status", status);
    countQ.andWhere("status", status);
  }

  const [items, countRow] = await Promise.all([dataQ, countQ]);
  const total = parseInt(countRow.c, 10);

  // Quick earning summary
  const summary = await knex("commission_transactions")
    .where({ owner_id: ownerId })
    .select(
      knex.raw("coalesce(sum(gross_amount), 0) as gross"),
      knex.raw("coalesce(sum(commission_amount), 0) as commission"),
      knex.raw("coalesce(sum(net_amount), 0) as net"),
      knex.raw(
        "coalesce(sum(net_amount) filter (where status = 'pending'), 0) as net_pending",
      ),
      knex.raw(
        "coalesce(sum(net_amount) filter (where status = 'paid'), 0) as net_paid",
      ),
    )
    .first();

  return {
    items,
    summary: {
      gross: Number(summary.gross) || 0,
      commission: Number(summary.commission) || 0,
      net: Number(summary.net) || 0,
      net_pending: Number(summary.net_pending) || 0,
      net_paid: Number(summary.net_paid) || 0,
    },
    pagination: {
      page: safePage,
      limit: safeLimit,
      total,
      pages: Math.ceil(total / safeLimit) || 1,
    },
  };
}

/**
 * Shared base query for admin commission reporting — joins through to the
 * equipment a commission was earned on (via either the order item or the
 * rental, exactly one of which is set) so admins can filter/report per
 * equipment, not just per owner.
 */
function baseAdminQuery() {
  return knex("commission_transactions as c")
    .leftJoin("users as u", "u.id", "c.owner_id")
    .leftJoin("order_items as oi", "oi.id", "c.order_item_id")
    .leftJoin("equipment as eo", "eo.id", "oi.equipment_id")
    .leftJoin("rentals as r", "r.id", "c.rental_id")
    .leftJoin("equipment as er", "er.id", "r.equipment_id");
}

function applyAdminFilters(q, { status, ownerId, from, to, search } = {}) {
  if (status) q.where("c.status", status);
  if (ownerId) q.where("c.owner_id", ownerId);
  if (from) q.where("c.created_at", ">=", from);
  if (to) q.where("c.created_at", "<=", to);
  if (search) {
    q.where(function () {
      this.where("u.name", "ilike", `%${search}%`).orWhere("u.email", "ilike", `%${search}%`);
    });
  }
  return q;
}

/**
 * Admin list — all commissions, paginated. Supports filtering by status,
 * owner (farmer) and a created_at date range.
 */
async function listAll({
  page = 1,
  limit = 20,
  status = null,
  ownerId = null,
  from = null,
  to = null,
  search = null,
} = {}) {
  const safeLimit = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
  const safePage = Math.max(1, parseInt(page, 10) || 1);
  const offset = (safePage - 1) * safeLimit;

  const filters = { status, ownerId, from, to, search };

  const dataQ = applyAdminFilters(baseAdminQuery(), filters)
    .select(
      "c.*",
      "u.name as owner_name",
      "u.email as owner_email",
      knex.raw("coalesce(eo.id, er.id) as equipment_id"),
      knex.raw("coalesce(eo.name, er.name) as equipment_name"),
    )
    .orderBy("c.created_at", "desc")
    .limit(safeLimit)
    .offset(offset);

  const countQ = applyAdminFilters(baseAdminQuery(), filters)
    .count("c.id as c")
    .first();

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
 * Admin export — same filters as listAll but unpaginated (capped) for CSV
 * download.
 */
async function listForExport({
  status = null,
  ownerId = null,
  from = null,
  to = null,
  search = null,
} = {}) {
  const EXPORT_CAP = 5000;
  return applyAdminFilters(baseAdminQuery(), { status, ownerId, from, to, search })
    .select(
      "c.*",
      "u.name as owner_name",
      "u.email as owner_email",
      knex.raw("coalesce(eo.id, er.id) as equipment_id"),
      knex.raw("coalesce(eo.name, er.name) as equipment_name"),
    )
    .orderBy("c.created_at", "desc")
    .limit(EXPORT_CAP);
}

/**
 * Admin: mark a commission as paid out to the owner.
 */
async function markPaid(commissionId) {
  const [row] = await knex("commission_transactions")
    .where({ id: commissionId, status: "pending" })
    .update({ status: "paid", paid_at: knex.fn.now() })
    .returning(PUBLIC_FIELDS);
  if (!row) throw new AppError("Commission not found or already paid", 404);
  return row;
}

async function markCancelled(commissionId, notes = null) {
  const patch = { status: "cancelled" };
  if (notes) patch.notes = notes;
  const [row] = await knex("commission_transactions")
    .where({ id: commissionId })
    .andWhereNot("status", "paid")
    .update(patch)
    .returning(PUBLIC_FIELDS);
  if (!row) throw new AppError("Commission not found or already paid", 404);
  return row;
}

module.exports = {
  STANDARD_RATE,
  PRO_RATE,
  rateFor,
  recordCommission,
  recordForOrder,
  recordForRental,
  listForOwner,
  listAll,
  listForExport,
  markPaid,
  markCancelled,
};
