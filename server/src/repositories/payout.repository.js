/**
 * Payouts — bookkeeping for paying farmers their net earnings.
 *
 * Lifecycle:
 *   commission_transactions (status='pending') → payout_batch (status='paid')
 *
 * The batch atomically:
 *   1. Inserts a payout_batches row with the rolled-up totals.
 *   2. Inserts payout_batch_items rows, one per commission.
 *   3. Flips each linked commission to status='paid' with paid_at=now().
 *
 * If any step fails, the whole thing rolls back — no half-paid batches.
 */

const knex = require("../db");
const { AppError } = require("../middleware/errorHandler");

const PAYOUT_FIELDS = [
  "id",
  "owner_id",
  "total_amount",
  "transaction_count",
  "method",
  "reference",
  "status",
  "notes",
  "paid_by_admin_id",
  "paid_at",
  "created_at",
  "updated_at",
];

const ALLOWED_METHODS = ["bank_transfer", "cash", "wallet", "other"];

function money(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

/**
 * One row per owner: their pending balance + last paid balance + last
 * paid timestamp. Powers the "Payouts" tab — the operator can scan the
 * list, see who has money to receive, and click "Pay Now".
 *
 * Filters:
 *   only_pending=true → hide owners whose pending balance is 0
 */
async function listOwnerBalances({
  page = 1,
  limit = 20,
  onlyPending = false,
  search = null,
} = {}) {
  const safeLimit = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
  const safePage = Math.max(1, parseInt(page, 10) || 1);
  const offset = (safePage - 1) * safeLimit;

  // Base subquery: per-owner aggregates over commission_transactions.
  // We do this in raw SQL because expressing FILTER/COALESCE/MAX-with-condition
  // tidily in Knex's chainable form is more pain than it's worth.
  // Pagination + search are layered on at the outer query.
  //
  // There's no more "owner" role — any user can list equipment. We use an
  // INNER JOIN against commission_transactions (rather than LEFT JOIN) so
  // this stays scoped to users with actual commission activity, instead of
  // returning every user on the platform.
  const baseSql = `
    SELECT
      u.id            AS owner_id,
      u.name          AS owner_name,
      u.email         AS owner_email,
      u.phone         AS owner_phone,
      u.is_pro        AS is_pro,
      u.governorate   AS governorate,
      coalesce(sum(c.net_amount) filter (where c.status = 'pending'), 0)::numeric(14,2)  AS pending_balance,
      coalesce(sum(c.net_amount) filter (where c.status = 'paid'),    0)::numeric(14,2)  AS paid_lifetime,
      coalesce(sum(c.gross_amount), 0)::numeric(14,2)                                    AS gross_lifetime,
      count(c.id) filter (where c.status = 'pending')::int                               AS pending_count,
      count(c.id)::int                                                                   AS total_count,
      max(c.paid_at)                                                                     AS last_paid_at
    FROM users u
    INNER JOIN commission_transactions c ON c.owner_id = u.id
    WHERE u.account_status <> 'deleted'
      ${search ? `AND (u.name ILIKE ? OR u.email ILIKE ?)` : ""}
    GROUP BY u.id
    ${onlyPending ? `HAVING coalesce(sum(c.net_amount) filter (where c.status = 'pending'), 0) > 0` : ""}
  `;

  const orderSql = `ORDER BY pending_balance DESC, owner_name ASC`;

  // Search params used twice if present.
  const searchParams = search ? [`%${search}%`, `%${search}%`] : [];

  const dataRows = await knex.raw(
    `${baseSql} ${orderSql} LIMIT ? OFFSET ?`,
    [...searchParams, safeLimit, offset],
  );
  const countRows = await knex.raw(
    `SELECT count(*)::int AS c FROM (${baseSql}) sub`,
    searchParams,
  );

  const items = dataRows.rows.map((r) => ({
    owner_id: r.owner_id,
    owner_name: r.owner_name,
    owner_email: r.owner_email,
    owner_phone: r.owner_phone,
    is_pro: r.is_pro,
    governorate: r.governorate,
    pending_balance: Number(r.pending_balance),
    paid_lifetime: Number(r.paid_lifetime),
    gross_lifetime: Number(r.gross_lifetime),
    pending_count: Number(r.pending_count),
    total_count: Number(r.total_count),
    last_paid_at: r.last_paid_at,
  }));

  const total = Number((countRows.rows[0] && countRows.rows[0].c) || 0);

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
 * One owner's full pending-commission breakdown — used when the operator
 * clicks an owner row to see exactly what's about to be paid out. Returns
 * { owner: {...}, pending: [...], pending_total }.
 */
async function getOwnerPendingDetail(ownerId) {
  const owner = await knex("users")
    .where({ id: ownerId })
    .first("id", "name", "email", "phone", "governorate", "is_pro");
  if (!owner) throw new AppError("Owner not found", 404);

  const pending = await knex("commission_transactions as c")
    .leftJoin("orders as o", "o.id", "c.order_id")
    .leftJoin("rentals as r", "r.id", "c.rental_id")
    .where({ "c.owner_id": ownerId, "c.status": "pending" })
    .select(
      "c.id",
      "c.gross_amount",
      "c.commission_amount",
      "c.net_amount",
      "c.rate",
      "c.created_at",
      "c.order_id",
      "c.rental_id",
      "o.tracking_number",
      "r.start_date",
      "r.end_date",
    )
    .orderBy("c.created_at", "asc");

  const total = pending.reduce((s, p) => s + Number(p.net_amount), 0);

  return {
    owner,
    pending: pending.map((p) => ({
      id: p.id,
      gross_amount: Number(p.gross_amount),
      commission_amount: Number(p.commission_amount),
      net_amount: Number(p.net_amount),
      rate: Number(p.rate),
      created_at: p.created_at,
      order_id: p.order_id,
      rental_id: p.rental_id,
      order_tracking: p.tracking_number,
      rental_period:
        p.start_date && p.end_date
          ? { start: p.start_date, end: p.end_date }
          : null,
    })),
    pending_total: money(total),
  };
}

/**
 * Create a payout batch for the given owner.
 *
 * If `commissionIds` is provided, only those rows are paid (must all be
 * pending and belong to the owner). Otherwise we sweep ALL their pending
 * commissions into a single batch.
 *
 * Atomic: any failure rolls back the batch + line items, and the
 * commissions stay pending.
 *
 * Returns { batch, items_count, total_amount }.
 */
async function createPayout({
  ownerId,
  adminId,
  method = "bank_transfer",
  reference = null,
  notes = null,
  commissionIds = null,
}) {
  if (!ALLOWED_METHODS.includes(method)) {
    throw new AppError(`Invalid payout method '${method}'`, 400);
  }
  if (!adminId) throw new AppError("adminId is required", 400);

  return knex.transaction(async (trx) => {
    // Lock the candidate commissions so a concurrent payout attempt
    // can't double-spend the same row.
    const q = trx("commission_transactions")
      .where({ owner_id: ownerId, status: "pending" })
      .forUpdate();
    if (commissionIds && commissionIds.length) {
      q.whereIn("id", commissionIds);
    }

    const candidates = await q.select(
      "id",
      "net_amount",
      "owner_id",
      "status",
    );

    if (commissionIds && candidates.length !== commissionIds.length) {
      throw new AppError(
        "Some selected commissions are not pending or don't belong to this owner",
        409,
      );
    }
    if (!candidates.length) {
      throw new AppError("لا يوجد رصيد معلَّق لهذا المالك للصرف", 400);
    }

    const totalAmount = money(
      candidates.reduce((s, c) => s + Number(c.net_amount), 0),
    );

    const [batch] = await trx("payout_batches")
      .insert({
        owner_id: ownerId,
        total_amount: totalAmount,
        transaction_count: candidates.length,
        method,
        reference: reference || null,
        notes: notes || null,
        paid_by_admin_id: adminId,
      })
      .returning(PAYOUT_FIELDS);

    // Line items.
    await trx("payout_batch_items").insert(
      candidates.map((c) => ({
        batch_id: batch.id,
        commission_id: c.id,
        net_amount: c.net_amount,
      })),
    );

    // Flip commissions → paid.
    await trx("commission_transactions")
      .whereIn(
        "id",
        candidates.map((c) => c.id),
      )
      .update({ status: "paid", paid_at: trx.fn.now() });

    return {
      batch,
      items_count: candidates.length,
      total_amount: totalAmount,
    };
  });
}

/**
 * List historical payout batches with filters. Used by the "تاريخ
 * المدفوعات" sub-tab.
 */
async function listPayouts({
  page = 1,
  limit = 20,
  ownerId = null,
  status = null,
  from = null,
  to = null,
} = {}) {
  const safeLimit = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
  const safePage = Math.max(1, parseInt(page, 10) || 1);
  const offset = (safePage - 1) * safeLimit;

  const buildWhere = (q) => {
    if (ownerId) q.where("p.owner_id", ownerId);
    if (status) q.where("p.status", status);
    if (from) q.where("p.paid_at", ">=", from);
    if (to) q.where("p.paid_at", "<=", to);
  };

  const dataQ = knex("payout_batches as p")
    .leftJoin("users as u", "u.id", "p.owner_id")
    .leftJoin("users as a", "a.id", "p.paid_by_admin_id")
    .select(
      "p.*",
      "u.name as owner_name",
      "u.email as owner_email",
      "a.name as admin_name",
    )
    .orderBy("p.paid_at", "desc")
    .limit(safeLimit)
    .offset(offset);
  buildWhere(dataQ);

  const countQ = knex("payout_batches as p").count("* as c").first();
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
 * Cancel a paid batch — used when a transfer bounces or was sent in
 * error. Reverts each linked commission back to pending so it can be
 * paid out again.
 */
async function cancelPayout(batchId, { adminId, notes = null } = {}) {
  return knex.transaction(async (trx) => {
    const batch = await trx("payout_batches").where({ id: batchId }).forUpdate().first();
    if (!batch) throw new AppError("Payout batch not found", 404);
    if (batch.status === "cancelled") {
      throw new AppError("Payout batch is already cancelled", 409);
    }

    // Revert linked commissions.
    const itemRows = await trx("payout_batch_items")
      .where({ batch_id: batchId })
      .select("commission_id");
    const ids = itemRows.map((r) => r.commission_id);
    if (ids.length) {
      await trx("commission_transactions")
        .whereIn("id", ids)
        .update({ status: "pending", paid_at: null });
    }

    const [updated] = await trx("payout_batches")
      .where({ id: batchId })
      .update({
        status: "cancelled",
        notes: notes
          ? batch.notes
            ? batch.notes + "\n\n[CANCELLED] " + notes
            : "[CANCELLED] " + notes
          : batch.notes,
      })
      .returning(PAYOUT_FIELDS);

    return updated;
  });
}

module.exports = {
  ALLOWED_METHODS,
  listOwnerBalances,
  getOwnerPendingDetail,
  createPayout,
  listPayouts,
  cancelPayout,
};
