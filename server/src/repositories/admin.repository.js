const knex = require("../db");

/**
 * Admin analytics. All queries are single-round-trip and scoped by optional
 * date ranges; we avoid N+1 by using SQL aggregates.
 */

/**
 * Platform-wide counters: users, equipment, orders, rentals, revenue.
 * Revenue = sum of total on paid orders + total_price on completed rentals.
 */
async function platformStats() {
  const [
    userCounts,
    equipmentCount,
    orderStats,
    rentalStats,
    commissionStats,
    recentActivity,
  ] = await Promise.all([
    knex("users")
      .select(
        knex.raw("count(*) as total"),
        knex.raw(
          "count(*) filter (where is_admin = true) as admins",
        ),
        knex.raw(
          "count(*) filter (where is_active = true) as active",
        ),
        knex.raw(
          "count(*) filter (where is_pro = true) as pro_members",
        ),
        knex.raw(
          "count(*) filter (where account_status = 'pending') as pending_accounts",
        ),
        knex.raw(
          "count(*) filter (where account_status = 'blocked') as blocked_accounts",
        ),
        // KYC review queue size — used by the admin dashboard badge.
        knex.raw(
          "count(*) filter (where identity_status = 'pending') as pending_kyc",
        ),
        knex.raw(
          "count(*) filter (where identity_verified = true) as identity_verified",
        ),
        knex.raw(
          "count(*) filter (where email_verified = true) as email_verified",
        ),
      )
      .first(),
    knex("equipment")
      .select(
        knex.raw("count(*) as total"),
        knex.raw("count(*) filter (where status = 'available') as available"),
        knex.raw("count(*) filter (where status = 'rented') as rented"),
        knex.raw("count(*) filter (where status = 'sold') as sold"),
        knex.raw(
          "count(*) filter (where listing_type in ('sale','both') and approval_status = 'approved') as for_sale",
        ),
        knex.raw(
          "count(*) filter (where listing_type in ('rent','both') and approval_status = 'approved') as for_rent",
        ),
        knex.raw(
          "count(*) filter (where approval_status = 'pending') as pending_approval",
        ),
      )
      .first(),
    knex("orders")
      .select(
        knex.raw("count(*) as total"),
        knex.raw("count(*) filter (where payment_status = 'paid') as paid"),
        knex.raw(
          "count(*) filter (where payment_status = 'pending') as pending",
        ),
        knex.raw(
          "count(*) filter (where status = 'delivered') as delivered",
        ),
        knex.raw(
          "coalesce(sum(total) filter (where payment_status = 'paid'), 0) as revenue",
        ),
      )
      .first(),
    knex("rentals")
      .select(
        knex.raw("count(*) as total"),
        knex.raw(
          "count(*) filter (where status = 'completed') as completed",
        ),
        knex.raw(
          "count(*) filter (where status = 'active') as active",
        ),
        knex.raw(
          "count(*) filter (where status = 'pending') as pending",
        ),
        knex.raw(
          "coalesce(sum(total_price) filter (where status = 'completed'), 0) as revenue",
        ),
      )
      .first(),
    knex("commission_transactions")
      .select(
        knex.raw("coalesce(sum(commission_amount), 0) as earned"),
        knex.raw(
          "coalesce(sum(commission_amount) filter (where status = 'pending'), 0) as earned_pending",
        ),
        knex.raw(
          "coalesce(sum(commission_amount) filter (where status = 'paid'), 0) as earned_paid",
        ),
      )
      .first(),
    // Last 7 days activity
    knex.raw(`
      WITH days AS (
        SELECT generate_series(
          current_date - interval '6 days',
          current_date,
          interval '1 day'
        )::date AS day
      )
      SELECT
        days.day,
        coalesce(u.cnt, 0)::int as new_users,
        coalesce(o.cnt, 0)::int as orders,
        coalesce(r.cnt, 0)::int as rentals
      FROM days
      LEFT JOIN (
        SELECT created_at::date AS d, count(*) AS cnt
        FROM users WHERE created_at >= current_date - interval '6 days'
        GROUP BY 1
      ) u ON u.d = days.day
      LEFT JOIN (
        SELECT created_at::date AS d, count(*) AS cnt
        FROM orders WHERE created_at >= current_date - interval '6 days'
        GROUP BY 1
      ) o ON o.d = days.day
      LEFT JOIN (
        SELECT created_at::date AS d, count(*) AS cnt
        FROM rentals WHERE created_at >= current_date - interval '6 days'
        GROUP BY 1
      ) r ON r.d = days.day
      ORDER BY days.day;
    `),
  ]);

  return {
    users: {
      total: Number(userCounts.total),
      admins: Number(userCounts.admins),
      active: Number(userCounts.active),
      pro_members: Number(userCounts.pro_members),
      pending_accounts: Number(userCounts.pending_accounts),
      blocked_accounts: Number(userCounts.blocked_accounts),
      pending_kyc: Number(userCounts.pending_kyc),
      identity_verified: Number(userCounts.identity_verified),
      email_verified: Number(userCounts.email_verified),
    },
    equipment: {
      total: Number(equipmentCount.total),
      available: Number(equipmentCount.available),
      rented: Number(equipmentCount.rented),
      sold: Number(equipmentCount.sold),
      for_sale: Number(equipmentCount.for_sale),
      for_rent: Number(equipmentCount.for_rent),
      pending_approval: Number(equipmentCount.pending_approval),
    },
    orders: {
      total: Number(orderStats.total),
      paid: Number(orderStats.paid),
      pending: Number(orderStats.pending),
      delivered: Number(orderStats.delivered),
      revenue: Number(orderStats.revenue),
    },
    rentals: {
      total: Number(rentalStats.total),
      completed: Number(rentalStats.completed),
      active: Number(rentalStats.active),
      pending: Number(rentalStats.pending),
      revenue: Number(rentalStats.revenue),
    },
    commissions: {
      earned: Number(commissionStats.earned),
      earned_pending: Number(commissionStats.earned_pending),
      earned_paid: Number(commissionStats.earned_paid),
    },
    last_7_days: recentActivity.rows,
  };
}

/**
 * Top sellers/owners by gross revenue over the last N days.
 */
async function topOwners({ days = 30, limit = 10 } = {}) {
  const rows = await knex.raw(
    `
    SELECT
      u.id, u.name, u.email, u.is_pro,
      coalesce(sum(c.gross_amount), 0)::numeric(14,2) as gross,
      coalesce(sum(c.commission_amount), 0)::numeric(14,2) as platform_commission,
      coalesce(sum(c.net_amount), 0)::numeric(14,2) as net_earnings,
      count(c.id)::int as transactions
    FROM users u
    LEFT JOIN commission_transactions c
      ON c.owner_id = u.id
      AND c.created_at >= now() - make_interval(days => ?)
    GROUP BY u.id
    HAVING count(c.id) > 0
    ORDER BY gross DESC
    LIMIT ?
  `,
    [days, limit],
  );
  return rows.rows.map((r) => ({
    id: r.id,
    name: r.name,
    email: r.email,
    is_pro: r.is_pro,
    gross: Number(r.gross),
    platform_commission: Number(r.platform_commission),
    net_earnings: Number(r.net_earnings),
    transactions: Number(r.transactions),
  }));
}

/**
 * Revenue time series for charting.
 */
async function revenueOverTime({ days = 30 } = {}) {
  const rows = await knex.raw(
    `
    WITH ds AS (
      SELECT generate_series(
        current_date - make_interval(days => ?),
        current_date,
        interval '1 day'
      )::date AS d
    )
    SELECT
      ds.d,
      coalesce(o.rev, 0)::numeric(14,2) as order_revenue,
      coalesce(r.rev, 0)::numeric(14,2) as rental_revenue,
      coalesce(c.commission, 0)::numeric(14,2) as platform_commission
    FROM ds
    LEFT JOIN (
      SELECT paid_at::date as d, sum(total) as rev
      FROM orders
      WHERE payment_status = 'paid' AND paid_at IS NOT NULL
      GROUP BY 1
    ) o ON o.d = ds.d
    LEFT JOIN (
      SELECT completed_at::date as d, sum(total_price) as rev
      FROM rentals
      WHERE status = 'completed' AND completed_at IS NOT NULL
      GROUP BY 1
    ) r ON r.d = ds.d
    LEFT JOIN (
      SELECT created_at::date as d, sum(commission_amount) as commission
      FROM commission_transactions
      GROUP BY 1
    ) c ON c.d = ds.d
    ORDER BY ds.d;
  `,
    [days - 1],
  );
  return rows.rows.map((r) => ({
    date: r.d,
    order_revenue: Number(r.order_revenue),
    rental_revenue: Number(r.rental_revenue),
    platform_commission: Number(r.platform_commission),
  }));
}

/**
 * Sales by month — paid order revenue + completed rental revenue,
 * grouped by calendar month for the last N months. Powers the bar/line
 * chart on the admin overview ("المبيعات حسب الشهر").
 *
 * Returns oldest → newest so a chart library can render it without
 * resorting. We always return exactly `months` rows even if some months
 * have no sales (gaps look broken on a chart) by left-joining against a
 * generated month series.
 */
async function salesByMonth({ months = 12 } = {}) {
  const safeMonths = Math.min(36, Math.max(1, parseInt(months, 10) || 12));
  const rows = await knex.raw(
    `
    WITH ms AS (
      SELECT generate_series(
        date_trunc('month', current_date) - make_interval(months => ?),
        date_trunc('month', current_date),
        interval '1 month'
      )::date AS m
    )
    SELECT
      to_char(ms.m, 'YYYY-MM')                    AS month,
      coalesce(o.rev, 0)::numeric(14,2)           AS order_revenue,
      coalesce(o.cnt, 0)::int                     AS order_count,
      coalesce(r.rev, 0)::numeric(14,2)           AS rental_revenue,
      coalesce(r.cnt, 0)::int                     AS rental_count,
      (coalesce(o.rev, 0) + coalesce(r.rev, 0))::numeric(14,2)
                                                  AS total_revenue
    FROM ms
    LEFT JOIN (
      SELECT date_trunc('month', paid_at)::date AS m,
             sum(total) AS rev,
             count(*) AS cnt
      FROM orders
      WHERE payment_status = 'paid' AND paid_at IS NOT NULL
      GROUP BY 1
    ) o ON o.m = ms.m
    LEFT JOIN (
      SELECT date_trunc('month', completed_at)::date AS m,
             sum(total_price) AS rev,
             count(*) AS cnt
      FROM rentals
      WHERE status = 'completed' AND completed_at IS NOT NULL
      GROUP BY 1
    ) r ON r.m = ms.m
    ORDER BY ms.m;
    `,
    [safeMonths - 1],
  );
  return rows.rows.map((r) => ({
    month: r.month,
    order_revenue: Number(r.order_revenue),
    order_count: Number(r.order_count),
    rental_revenue: Number(r.rental_revenue),
    rental_count: Number(r.rental_count),
    total_revenue: Number(r.total_revenue),
  }));
}

/**
 * Top equipment categories by units sold (order_items.quantity) and gross
 * revenue (line_total) over the last N days. Powers the doughnut/pie
 * "أعلى الفئات".
 *
 * We use a fixed list of categories from the equipment_category enum so
 * a category with zero sales still appears in the result (with 0 values),
 * which keeps the chart legend stable across refreshes. If the enum gets
 * a new value, the SELECT below picks it up automatically — no code
 * change.
 */
async function topCategories({ days = 30, limit = 10 } = {}) {
  const safeDays = Math.min(365, Math.max(1, parseInt(days, 10) || 30));
  const safeLimit = Math.min(50, Math.max(1, parseInt(limit, 10) || 10));
  const rows = await knex.raw(
    `
    SELECT
      e.category,
      coalesce(sum(oi.line_total), 0)::numeric(14,2) AS gross_revenue,
      coalesce(sum(oi.quantity), 0)::int             AS units_sold,
      count(distinct e.id)::int                      AS distinct_listings
    FROM equipment e
    LEFT JOIN order_items oi ON oi.equipment_id = e.id
    LEFT JOIN orders o ON o.id = oi.order_id
      AND o.payment_status = 'paid'
      AND o.paid_at >= now() - make_interval(days => ?)
    GROUP BY e.category
    ORDER BY gross_revenue DESC, units_sold DESC
    LIMIT ?;
    `,
    [safeDays, safeLimit],
  );
  return rows.rows.map((r) => ({
    category: r.category,
    gross_revenue: Number(r.gross_revenue),
    units_sold: Number(r.units_sold),
    distinct_listings: Number(r.distinct_listings),
  }));
}

/**
 * User growth: new signups per day for the last N days. There's no more
 * role breakdown (every account has identical capabilities), so this is
 * just a total-per-day count. Always returns one row per day (with
 * zeroes) so the line is continuous.
 */
async function userGrowth({ days = 30 } = {}) {
  const safeDays = Math.min(365, Math.max(1, parseInt(days, 10) || 30));
  const rows = await knex.raw(
    `
    WITH ds AS (
      SELECT generate_series(
        current_date - make_interval(days => ?),
        current_date,
        interval '1 day'
      )::date AS d
    )
    SELECT
      ds.d AS date,
      coalesce(u.total, 0)::int AS total
    FROM ds
    LEFT JOIN (
      SELECT
        created_at::date AS d,
        count(*) AS total
      FROM users
      WHERE account_status <> 'deleted'
      GROUP BY 1
    ) u ON u.d = ds.d
    ORDER BY ds.d;
    `,
    [safeDays - 1],
  );
  return rows.rows.map((r) => ({
    date: r.date,
    total: Number(r.total),
  }));
}

/**
 * Order distribution by governorate over the last N days. We look at the
 * delivering user's governorate — falling back to the equipment owner's
 * if the buyer hasn't set one. Powers the geographic chart
 * "توزيع الطلبات على المحافظات".
 *
 * Returns ALL governorates from the enum (with 0 rows if no orders) so
 * the chart legend is stable — same rationale as topCategories.
 */
async function ordersByGovernorate({ days = 30 } = {}) {
  const safeDays = Math.min(365, Math.max(1, parseInt(days, 10) || 30));
  const rows = await knex.raw(
    `
    WITH gov_orders AS (
      SELECT
        coalesce(buyer.governorate, owner.governorate) AS gov,
        o.total
      FROM orders o
      JOIN users buyer ON buyer.id = o.user_id
      JOIN order_items oi ON oi.order_id = o.id
      JOIN equipment e ON e.id = oi.equipment_id
      JOIN users owner ON owner.id = e.owner_id
      WHERE o.payment_status = 'paid'
        AND o.paid_at >= now() - make_interval(days => ?)
    )
    SELECT
      gov AS governorate,
      count(*)::int                  AS order_count,
      coalesce(sum(total), 0)::numeric(14,2) AS gross_revenue
    FROM gov_orders
    WHERE gov IS NOT NULL
    GROUP BY gov
    ORDER BY order_count DESC;
    `,
    [safeDays],
  );
  return rows.rows.map((r) => ({
    governorate: r.governorate,
    order_count: Number(r.order_count),
    gross_revenue: Number(r.gross_revenue),
  }));
}

/**
 * Admin list of users with optional filters.
 */
async function listUsers({ page = 1, limit = 20, status = null, search = null } = {}) {
  const safeLimit = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
  const safePage = Math.max(1, parseInt(page, 10) || 1);
  const offset = (safePage - 1) * safeLimit;

  const PUBLIC_FIELDS = [
    "id",
    "email",
    "phone",
    "is_admin",
    "name",
    "is_active",
    "is_pro",
    "pro_expires_at",
    "loyalty_points",
    "account_status",
    "status_reason",
    "status_changed_at",
    "created_at",
  ];

  const dataQ = knex("users")
    .select(PUBLIC_FIELDS)
    .orderBy("created_at", "desc")
    .limit(safeLimit)
    .offset(offset);
  const countQ = knex("users").count("* as c").first();

  for (const q of [dataQ, countQ]) {
    if (status) q.where("account_status", status);
    // By default, hide soft-deleted users from generic listings.
    if (status !== "deleted") q.whereNot("account_status", "deleted");
    if (search) {
      q.where((w) => {
        w.whereILike("name", `%${search}%`).orWhereILike("email", `%${search}%`);
      });
    }
  }

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
 * List accounts pending review. Used by the admin "موافقات الحسابات" tab.
 * Pending is no longer role-driven — any account can be placed in
 * 'pending' state by an admin, so this just filters on account_status.
 */
async function listPendingUsers({ page = 1, limit = 20 } = {}) {
  const safeLimit = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
  const safePage = Math.max(1, parseInt(page, 10) || 1);
  const offset = (safePage - 1) * safeLimit;

  const PUBLIC_FIELDS = [
    "id",
    "email",
    "phone",
    "is_admin",
    "name",
    "identity",
    "governorate",
    "account_status",
    "created_at",
  ];

  const [items, countRow] = await Promise.all([
    knex("users")
      .where({ account_status: "pending" })
      .select(PUBLIC_FIELDS)
      .orderBy("created_at", "asc") // oldest first → review queue
      .limit(safeLimit)
      .offset(offset),
    knex("users").where({ account_status: "pending" }).count("* as c").first(),
  ]);

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
 * Set account_status. Validates the target status, writes audit columns, and
 * keeps `is_active` in sync so legacy code paths that still check is_active
 * continue to behave correctly:
 *   - blocked / deleted   → is_active = false  (legacy "off")
 *   - approved / pending / rejected → is_active = true (legacy "on")
 */
async function setUserStatus(userId, { status, reason = null, changedBy = null }) {
  const allowed = ["pending", "approved", "rejected", "blocked", "deleted"];
  if (!allowed.includes(status)) {
    const err = new Error(`Invalid status '${status}'`);
    err.status = 400;
    throw err;
  }

  const isActive = !["blocked", "deleted"].includes(status);

  const [row] = await knex("users")
    .where({ id: userId })
    .update({
      account_status: status,
      status_reason: reason,
      status_changed_at: knex.fn.now(),
      status_changed_by: changedBy,
      is_active: isActive,
    })
    .returning([
      "id",
      "email",
      "name",
      "is_admin",
      "is_active",
      "is_pro",
      "pro_expires_at",
      "account_status",
      "status_reason",
      "status_changed_at",
    ]);
  return row || null;
}

async function setUserActive(userId, isActive) {
  const [row] = await knex("users")
    .where({ id: userId })
    .update({ is_active: isActive })
    .returning([
      "id",
      "email",
      "name",
      "is_admin",
      "is_active",
      "is_pro",
      "pro_expires_at",
    ]);
  return row || null;
}

async function setUserPro(userId, { isPro, expiresAt = null }) {
  const [row] = await knex("users")
    .where({ id: userId })
    .update({ is_pro: isPro, pro_expires_at: expiresAt })
    .returning([
      "id",
      "email",
      "name",
      "is_admin",
      "is_active",
      "is_pro",
      "pro_expires_at",
    ]);
  return row || null;
}

/**
 * Bulk-set the same status on a list of users.
 *
 * Refuses to touch any 'admin' rows even if their ids are in the input —
 * lowering an admin's status from a bulk action is too risky to do without
 * an explicit single-user call. We return a summary so the controller can
 * tell the operator "5 of 7 updated; 2 skipped (admins)".
 *
 * Returns: { updated_ids, skipped_admin_ids, before_after: [{id, before, after}] }
 *   - before_after lets the audit-log layer record per-user diffs without a
 *     second SELECT.
 */
async function bulkSetUserStatus(userIds, { status, reason = null, changedBy = null }) {
  const allowed = ["pending", "approved", "rejected", "blocked", "deleted"];
  if (!allowed.includes(status)) {
    const err = new Error(`Invalid status '${status}'`);
    err.status = 400;
    throw err;
  }
  if (!Array.isArray(userIds) || !userIds.length) {
    return { updated_ids: [], skipped_admin_ids: [], before_after: [] };
  }
  // Cap to a reasonable size — protects the DB from a typo-driven flood.
  if (userIds.length > 500) {
    const err = new Error("Bulk size limit (500) exceeded");
    err.status = 400;
    throw err;
  }

  const isActive = !["blocked", "deleted"].includes(status);

  return knex.transaction(async (trx) => {
    // 1. Snapshot current state of the targets (filtered to non-admin).
    const targets = await trx("users")
      .whereIn("id", userIds)
      .select("id", "is_admin", "account_status");
    const skipped = targets.filter((u) => u.is_admin === true).map((u) => u.id);
    const updatable = targets.filter((u) => u.is_admin !== true);
    const updatableIds = updatable.map((u) => u.id);

    if (!updatableIds.length) {
      return { updated_ids: [], skipped_admin_ids: skipped, before_after: [] };
    }

    // 2. Apply the patch.
    await trx("users")
      .whereIn("id", updatableIds)
      .update({
        account_status: status,
        status_reason: reason,
        status_changed_at: trx.fn.now(),
        status_changed_by: changedBy,
        is_active: isActive,
      });

    // 3. Build the before/after diff for the audit layer.
    const beforeAfter = updatable.map((u) => ({
      id: u.id,
      before: { account_status: u.account_status },
      after: { account_status: status },
    }));

    return {
      updated_ids: updatableIds,
      skipped_admin_ids: skipped,
      before_after: beforeAfter,
    };
  });
}

/**
 * Bulk-update equipment status (e.g. hide a batch of suspicious listings)
 * or approval state. Returns the list of ids actually updated.
 *
 * `patch` is a small whitelist:
 *   - status            : 'available' | 'rented' | 'maintenance' | 'hidden' | etc
 *   - approval_status   : 'pending' | 'approved' | 'rejected'
 *   - rejection_reason  : free text (only meaningful with approval_status='rejected')
 *
 * Validation belongs to the route layer; this just executes.
 */
async function bulkUpdateEquipment(equipmentIds, patch, { reviewedBy = null } = {}) {
  if (!Array.isArray(equipmentIds) || !equipmentIds.length) {
    return { updated_ids: [], before_after: [] };
  }
  if (equipmentIds.length > 500) {
    const err = new Error("Bulk size limit (500) exceeded");
    err.status = 400;
    throw err;
  }

  return knex.transaction(async (trx) => {
    // Snapshot for audit.
    const snapshotFields = ["id", "status", "approval_status"];
    const before = await trx("equipment")
      .whereIn("id", equipmentIds)
      .select(snapshotFields);
    if (!before.length) return { updated_ids: [], before_after: [] };

    // Build the actual patch — only the fields the caller specified, plus
    // approval-side audit columns when an approval_status transition is
    // happening.
    const dbPatch = {};
    if (patch.status !== undefined) dbPatch.status = patch.status;
    if (patch.approval_status !== undefined) {
      dbPatch.approval_status = patch.approval_status;
      if (patch.approval_status === "approved") {
        dbPatch.approved_at = trx.fn.now();
        dbPatch.approved_by = reviewedBy;
        dbPatch.rejection_reason = null;
      } else if (patch.approval_status === "rejected") {
        dbPatch.rejection_reason = patch.rejection_reason || "Bulk rejection";
        dbPatch.approved_by = reviewedBy;
        dbPatch.approved_at = null;
      }
    }

    if (!Object.keys(dbPatch).length) {
      // Nothing meaningful to change.
      return { updated_ids: [], before_after: [] };
    }

    const ids = before.map((r) => r.id);
    await trx("equipment").whereIn("id", ids).update(dbPatch);

    const beforeAfter = before.map((row) => ({
      id: row.id,
      before: { status: row.status, approval_status: row.approval_status },
      after: { ...dbPatch },
    }));

    return { updated_ids: ids, before_after: beforeAfter };
  });
}

module.exports = {
  platformStats,
  topOwners,
  revenueOverTime,
  salesByMonth,
  topCategories,
  userGrowth,
  ordersByGovernorate,
  listUsers,
  listPendingUsers,
  setUserStatus,
  setUserActive,
  setUserPro,
  bulkSetUserStatus,
  bulkUpdateEquipment,
};
