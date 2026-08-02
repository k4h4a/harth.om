const knex = require("../db");
const { AppError } = require("../middleware/errorHandler");

const PUBLIC_FIELDS = [
  "id",
  "equipment_id",
  "reviewer_id",
  "source",
  "order_id",
  "rental_id",
  "rating",
  "comment",
  "created_at",
  "updated_at",
];

/**
 * Recompute avg_rating + ratings_count for an equipment item and cache
 * them on the equipment row. Called inside the same transaction as any
 * create/update/delete so the cache is always correct.
 */
async function syncEquipmentRating(trx, equipmentId) {
  const row = await trx("reviews")
    .where({ equipment_id: equipmentId })
    .select(
      trx.raw("coalesce(avg(rating)::numeric(3,2), 0) as avg"),
      trx.raw("count(*)::int as cnt"),
    )
    .first();

  await trx("equipment")
    .where({ id: equipmentId })
    .update({
      avg_rating: row.avg,
      ratings_count: row.cnt,
    });

  return { avg: Number(row.avg), count: Number(row.cnt) };
}

/**
 * Can `reviewerId` review `equipmentId`? Returns the source/{id} they can
 * use, or null if ineligible. Ineligibility reasons: no completed
 * transaction on this equipment, or they've already reviewed all their
 * completed ones.
 *
 * A user can leave one review per completed order_item AND one per completed
 * rental on the same equipment.
 */
async function findEligibleSource(reviewerId, equipmentId) {
  // Look for a delivered order containing this equipment.
  const orderRow = await knex("orders as o")
    .join("order_items as oi", "oi.order_id", "o.id")
    .leftJoin("reviews as r", function () {
      this.on("r.order_id", "=", "o.id")
        .andOn("r.reviewer_id", "=", knex.raw("?", [reviewerId]))
        .andOn("r.equipment_id", "=", "oi.equipment_id")
        .andOn("r.source", "=", knex.raw("'order'"));
    })
    .where("o.user_id", reviewerId)
    .andWhere("o.status", "delivered")
    .andWhere("oi.equipment_id", equipmentId)
    .whereNull("r.id")
    .first("o.id as order_id");

  if (orderRow) {
    return { source: "order", orderId: orderRow.order_id };
  }

  // Or a completed rental for this equipment.
  const rentalRow = await knex("rentals as r")
    .leftJoin("reviews as rev", function () {
      this.on("rev.rental_id", "=", "r.id")
        .andOn("rev.reviewer_id", "=", knex.raw("?", [reviewerId]))
        .andOn("rev.source", "=", knex.raw("'rental'"));
    })
    .where("r.renter_id", reviewerId)
    .andWhere("r.equipment_id", equipmentId)
    .andWhere("r.status", "completed")
    .whereNull("rev.id")
    .first("r.id as rental_id");

  if (rentalRow) {
    return { source: "rental", rentalId: rentalRow.rental_id };
  }

  return null;
}

/**
 * Create a review. Enforces:
 *   - the reviewer has a matching completed transaction
 *   - they haven't already reviewed that transaction
 *   - rating is 1..5 (CHECK constraint, but we also validate)
 *
 * Re-syncs equipment.avg_rating after insert.
 */
async function create({ reviewerId, equipmentId, rating, comment = null }) {
  return knex.transaction(async (t) => {
    // Verify the equipment exists (cleaner error than FK violation)
    const eq = await t("equipment").where({ id: equipmentId }).first("id");
    if (!eq) throw new AppError("Equipment not found", 404);

    const eligible = await findEligibleSource(reviewerId, equipmentId);
    if (!eligible) {
      throw new AppError(
        "You can only review equipment you've purchased or rented (and only once per transaction)",
        403,
      );
    }

    try {
      const [row] = await t("reviews")
        .insert({
          equipment_id: equipmentId,
          reviewer_id: reviewerId,
          source: eligible.source,
          order_id: eligible.orderId || null,
          rental_id: eligible.rentalId || null,
          rating,
          comment,
        })
        .returning(PUBLIC_FIELDS);

      await syncEquipmentRating(t, equipmentId);
      return row;
    } catch (err) {
      if (err.code === "23505") {
        throw new AppError(
          "You have already reviewed this transaction",
          409,
        );
      }
      throw err;
    }
  });
}

async function update({ reviewId, reviewerId, rating, comment }) {
  return knex.transaction(async (t) => {
    const existing = await t("reviews")
      .where({ id: reviewId })
      .forUpdate()
      .first();
    if (!existing) throw new AppError("Review not found", 404);
    if (existing.reviewer_id !== reviewerId) {
      throw new AppError("Not your review", 403);
    }

    const patch = {};
    if (rating !== undefined) patch.rating = rating;
    if (comment !== undefined) patch.comment = comment;
    if (!Object.keys(patch).length) return existing;

    const [row] = await t("reviews")
      .where({ id: reviewId })
      .update(patch)
      .returning(PUBLIC_FIELDS);

    await syncEquipmentRating(t, existing.equipment_id);
    return row;
  });
}

async function remove({ reviewId, reviewerId, isAdmin }) {
  return knex.transaction(async (t) => {
    const existing = await t("reviews")
      .where({ id: reviewId })
      .forUpdate()
      .first();
    if (!existing) throw new AppError("Review not found", 404);
    if (existing.reviewer_id !== reviewerId && !isAdmin) {
      throw new AppError("Not your review", 403);
    }

    await t("reviews").where({ id: reviewId }).del();
    await syncEquipmentRating(t, existing.equipment_id);
    return true;
  });
}

/**
 * List reviews for an equipment item. Includes reviewer name.
 */
async function listForEquipment(equipmentId, { page = 1, limit = 20 } = {}) {
  const safeLimit = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
  const safePage = Math.max(1, parseInt(page, 10) || 1);
  const offset = (safePage - 1) * safeLimit;

  const [items, countRow] = await Promise.all([
    knex("reviews as r")
      .leftJoin("users as u", "u.id", "r.reviewer_id")
      .where("r.equipment_id", equipmentId)
      .select(
        "r.id",
        "r.rating",
        "r.comment",
        "r.source",
        "r.created_at",
        "r.updated_at",
        "u.id as reviewer_id",
        "u.name as reviewer_name",
      )
      .orderBy("r.created_at", "desc")
      .limit(safeLimit)
      .offset(offset),
    knex("reviews")
      .where({ equipment_id: equipmentId })
      .count("* as c")
      .first(),
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

async function getById(id) {
  return knex("reviews").where({ id }).first(PUBLIC_FIELDS);
}

module.exports = {
  create,
  update,
  remove,
  listForEquipment,
  getById,
  findEligibleSource,
  syncEquipmentRating,
  PUBLIC_FIELDS,
};
