const knex = require("../db");

/**
 * Equipment data access. All SQL lives here so controllers stay thin.
 *
 * Design notes:
 * - list() applies the same filters to the count query as to the data query,
 *   which is the bug we're deliberately fixing from the previous version.
 * - Sorting is whitelisted to avoid SQL injection via ?sort=...
 * - Full-text search uses the GIN index created in the 003 migration.
 */

const ALLOWED_SORTS = {
  newest: { column: "created_at", direction: "desc" },
  oldest: { column: "created_at", direction: "asc" },
  price_low: { column: "daily_price", direction: "asc" },
  price_high: { column: "daily_price", direction: "desc" },
  sale_low: { column: "sale_price", direction: "asc" },
  sale_high: { column: "sale_price", direction: "desc" },
  rating: { column: "avg_rating", direction: "desc" },
};

const PUBLIC_FIELDS = [
  "id",
  "name",
  "description",
  "category",
  "status",
  "listing_type",
  "daily_price",
  "sale_price",
  "deposit_amount",
  "stock",
  "images",
  "primary_image_url",
  "specs",
  "location",
  "avg_rating",
  "ratings_count",
  "owner_id",
  "governorate",
  "approval_status",
  "rejection_reason",
  "approved_at",
  "created_at",
  "updated_at",
];

// Extra breakdown fields shown only to the listing's owner or an admin —
// never returned to buyers (PUBLIC_FIELDS stays buyer-safe).
const OWNER_FIELDS = [
  ...PUBLIC_FIELDS,
  "farmer_daily_price",
  "farmer_sale_price",
  "commission_percentage",
  "daily_commission_amount",
  "sale_commission_amount",
];

/**
 * Apply shared filters to either a data query or a count query.
 * Mutates and returns the query builder.
 */
function applyFilters(qb, filters = {}) {
  if (filters.category) qb.where("category", filters.category);
  if (filters.listing_type) {
    // "both" items appear in both sale and rent listings
    qb.where(function () {
      this.where("listing_type", filters.listing_type).orWhere("listing_type", "both");
    });
  }
  if (filters.status) qb.where("status", filters.status);
  if (filters.owner_id) qb.where("owner_id", filters.owner_id);
  if (filters.approval_status) qb.where("approval_status", filters.approval_status);
  if (filters.governorate) qb.where("governorate", filters.governorate);

  if (filters.min_price != null) {
    // For price filters we compare against whichever price is relevant
    // to the listing type the client asked for. If they didn't ask, we
    // fall back to daily_price (rental-first product).
    const col =
      filters.listing_type === "sale" ? "sale_price" : "daily_price";
    qb.where(col, ">=", filters.min_price);
  }
  if (filters.max_price != null) {
    const col =
      filters.listing_type === "sale" ? "sale_price" : "daily_price";
    qb.where(col, "<=", filters.max_price);
  }

  if (filters.min_rating != null) {
    qb.where("avg_rating", ">=", filters.min_rating);
  }

  if (filters.search) {
    // Safe parameterised full-text search. 'simple' config matches the index.
    qb.whereRaw(
      `to_tsvector('simple', coalesce(name,'') || ' ' || coalesce(description,''))
       @@ plainto_tsquery('simple', ?)`,
      [filters.search],
    );
  }

  return qb;
}

async function list({
  page = 1,
  limit = 20,
  filters = {},
  sort = "newest",
  includeHidden = false,
  fields = PUBLIC_FIELDS,
} = {}) {
  const safePage = Math.max(1, parseInt(page, 10) || 1);
  const safeLimit = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
  const offset = (safePage - 1) * safeLimit;

  const { column, direction } = ALLOWED_SORTS[sort] || ALLOWED_SORTS.newest;

  // Public list hides 'hidden' and 'maintenance' by default.
  const baseFilters = { ...filters };
  if (!includeHidden && !baseFilters.status) {
    // caller asked for default view: show only available + rented (rented is
    // still browseable; the UI shows it disabled).
    baseFilters._publicVisibility = true;
  }

  const dataQuery = knex("equipment").select(fields);
  const countQuery = knex("equipment").count("* as count").first();

  for (const qb of [dataQuery, countQuery]) {
    applyFilters(qb, baseFilters);
    if (baseFilters._publicVisibility) {
      qb.whereIn("status", ["available", "rented"]);
      if (!baseFilters.approval_status) {
        qb.where("approval_status", "approved");
      }
    }
  }

  dataQuery.orderBy(column, direction).limit(safeLimit).offset(offset);

  const [items, countRow] = await Promise.all([dataQuery, countQuery]);
  const total = parseInt(countRow?.count ?? 0, 10);

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

async function getById(id) {
  return knex("equipment").where({ id }).first(PUBLIC_FIELDS);
}

/**
 * Just the commission breakdown columns — merged onto a public getById()
 * result by the controller when the requester is the owner/admin.
 */
async function getOwnerFieldsById(id) {
  return knex("equipment")
    .where({ id })
    .first(
      "farmer_daily_price",
      "farmer_sale_price",
      "commission_percentage",
      "daily_commission_amount",
      "sale_commission_amount",
    );
}

async function create(data) {
  const [row] = await knex("equipment").insert(data).returning(OWNER_FIELDS);
  return row;
}

async function update(id, data) {
  const [row] = await knex("equipment")
    .where({ id })
    .update(data)
    .returning(OWNER_FIELDS);
  return row;
}

async function remove(id) {
  return knex("equipment").where({ id }).del();
}

async function listByOwner(ownerId, { page = 1, limit = 20 } = {}) {
  return list({
    page,
    limit,
    filters: { owner_id: ownerId },
    includeHidden: true,
    fields: OWNER_FIELDS,
  });
}

/**
 * Does this equipment belong to this owner? Used for authorization checks
 * in controllers before allowing update/delete.
 */
async function isOwnedBy(equipmentId, ownerId) {
  const row = await knex("equipment")
    .where({ id: equipmentId })
    .first("owner_id");
  return !!row && row.owner_id === ownerId;
}

/**
 * Admin approves a pending listing. Idempotent on repeat.
 */
async function approve(equipmentId, adminId) {
  const [row] = await knex("equipment")
    .where({ id: equipmentId })
    .update({
      approval_status: "approved",
      approved_at: knex.fn.now(),
      approved_by: adminId,
      rejection_reason: null,
    })
    .returning(PUBLIC_FIELDS);
  return row || null;
}

async function reject(equipmentId, adminId, reason) {
  const [row] = await knex("equipment")
    .where({ id: equipmentId })
    .update({
      approval_status: "rejected",
      approved_at: knex.fn.now(),
      approved_by: adminId,
      rejection_reason: reason || "لم يُذكر سبب",
    })
    .returning(PUBLIC_FIELDS);
  return row || null;
}

/**
 * Admin view of pending listings, with owner info joined.
 */
async function listPending({ page = 1, limit = 20 } = {}) {
  const safeLimit = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
  const safePage = Math.max(1, parseInt(page, 10) || 1);
  const offset = (safePage - 1) * safeLimit;

  const dataQ = knex("equipment as e")
    .leftJoin("users as u", "u.id", "e.owner_id")
    .where("e.approval_status", "pending")
    .select(
      "e.*",
      "u.name as owner_name",
      "u.email as owner_email",
      "u.phone as owner_phone",
    )
    .orderBy("e.created_at", "asc")
    .limit(safeLimit)
    .offset(offset);

  const countQ = knex("equipment")
    .where("approval_status", "pending")
    .count("* as c")
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

async function pendingCount() {
  const row = await knex("equipment")
    .where("approval_status", "pending")
    .count("* as c")
    .first();
  return parseInt(row.c, 10);
}

module.exports = {
  list,
  getById,
  getOwnerFieldsById,
  create,
  update,
  remove,
  listByOwner,
  isOwnedBy,
  approve,
  reject,
  listPending,
  pendingCount,
  PUBLIC_FIELDS,
  OWNER_FIELDS,
  ALLOWED_SORTS,
};
