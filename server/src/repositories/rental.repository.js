const knex = require("../db");
const commissionRepo = require("./commission.repository");
const { AppError } = require("../middleware/errorHandler");
const { generateRentalTrackingNumber } = require("../utils/tracking");

const PUBLIC_RENTAL_FIELDS = [
  "id",
  "tracking_number",
  "equipment_id",
  "renter_id",
  "owner_id",
  "start_date",
  "end_date",
  "daily_price_snapshot",
  "total_price",
  "status",
  "payment_status",
  "renter_notes",
  "owner_response",
  "approved_at",
  "started_at",
  "completed_at",
  "cancelled_at",
  // Security deposit (snapshot at booking + lifecycle).
  "deposit_amount",
  "deposit_status",
  "deposit_kept_amount",
  "deposit_resolved_at",
  "deposit_resolved_by",
  "deposit_notes",
  "delivery_address",
  "payment_method",
  "created_at",
  "updated_at",
];

// Statuses that "block" a date range from being booked by someone else.
// Completed/cancelled/rejected rentals are historical and don't conflict.
const BLOCKING_STATUSES = ["pending", "approved", "active"];

/**
 * Count rentals that overlap [start, end] for this equipment (inclusive).
 *
 * Two ranges [a1..a2] and [b1..b2] overlap iff (a1 <= b2 AND b1 <= a2).
 * We use >= / <= (inclusive) to be conservative — same-day handovers are
 * treated as conflicts to keep logistics simple.
 *
 * Accepts an optional excludeRentalId for the case of updating an existing
 * rental (we want to ignore its own row when checking conflicts).
 */
async function countOverlapping(
  trx,
  { equipmentId, startDate, endDate, excludeRentalId = null },
) {
  const q = trx("rentals")
    .where("equipment_id", equipmentId)
    .whereIn("status", BLOCKING_STATUSES)
    .andWhere("start_date", "<=", endDate)
    .andWhere("end_date", ">=", startDate);
  if (excludeRentalId) q.andWhereNot("id", excludeRentalId);
  const row = await q.count("* as c").first();
  return parseInt(row.c, 10);
}

/**
 * Check availability for a date range on an equipment.
 * Exposed as its own function so /equipment/:id/availability can use it
 * without creating a rental.
 */
async function isAvailable({ equipmentId, startDate, endDate }) {
  const count = await countOverlapping(knex, {
    equipmentId,
    startDate,
    endDate,
  });
  return count === 0;
}

/**
 * Booked date ranges for an equipment (today onward), used to render a
 * calendar with already-rented days marked off. Only blocking statuses
 * count — completed/cancelled/rejected rentals don't occupy a date.
 */
async function getBookedRanges(equipmentId) {
  const today = new Date().toISOString().slice(0, 10);
  const rows = await knex("rentals")
    .where("equipment_id", equipmentId)
    .whereIn("status", BLOCKING_STATUSES)
    .andWhere("end_date", ">=", today)
    .orderBy("start_date", "asc")
    .select("start_date", "end_date");
  return rows;
}

/**
 * Compute number of rental days (inclusive). 1 day = same start/end date.
 */
function daysBetween(start, end) {
  const s = new Date(`${start}T00:00:00Z`).getTime();
  const e = new Date(`${end}T00:00:00Z`).getTime();
  const days = Math.round((e - s) / (1000 * 60 * 60 * 24)) + 1;
  return Math.max(days, 1);
}

/**
 * Create a rental request.
 *
 * Transaction flow:
 *   1. Lock the equipment row FOR UPDATE so concurrent bookings race safely.
 *   2. Verify listing allows rentals and is not hidden/sold.
 *   3. Verify date range is free.
 *   4. Snapshot the daily price and compute total.
 *   5. Insert the rental with status=pending.
 *
 * Note: we deliberately do NOT flip the equipment's status to 'rented' here.
 * That happens when the rental transitions to 'active'. A rental in 'pending'
 * or 'approved' state still leaves the listing browseable.
 */
async function createRental({
  renterId,
  equipmentId,
  startDate,
  endDate,
  renterNotes = null,
  paymentMethod = null,
  deliveryAddress = null,
}) {
  return knex.transaction(async (trx) => {
    const eq = await trx("equipment")
      .where({ id: equipmentId })
      .forUpdate()
      .first();
    if (!eq) throw new AppError("Equipment not found", 404);
    if (!["rent", "both"].includes(eq.listing_type)) {
      throw new AppError("This equipment is not available for rent", 400);
    }
    if (!["available", "rented"].includes(eq.status)) {
      // 'rented' is fine — other customers may have booked non-overlapping
      // dates. 'maintenance' / 'sold' / 'hidden' aren't.
      throw new AppError(`This equipment is currently ${eq.status}`, 400);
    }
    if (eq.daily_price == null) {
      throw new AppError("This equipment has no rental price set", 400);
    }
    if (eq.owner_id === renterId) {
      throw new AppError("You cannot rent your own listing", 400);
    }

    // Availability check inside the same transaction / lock
    const conflicts = await countOverlapping(trx, {
      equipmentId,
      startDate,
      endDate,
    });
    if (conflicts > 0) {
      throw new AppError(
        "This equipment is not available for the selected dates",
        409,
      );
    }

    const days = daysBetween(startDate, endDate);
    const dailyPrice = Number(eq.daily_price);
    const total =
      Math.round((dailyPrice * days + Number.EPSILON) * 100) / 100;
    const commissionAmountSnapshot =
      Math.round(
        ((Number(eq.daily_commission_amount) || 0) * days + Number.EPSILON) * 100,
      ) / 100;

    // Snapshot the security deposit at booking time. Listing-side updates
    // to deposit_amount don't retroactively change existing rentals.
    // 'none' status (the default) means no deposit applies; once we move
    // to actually holding funds, the start() transition will flip this to
    // 'held'. For now it stays 'none' until an explicit
    // markDepositHeld()/refund/forfeit transition.
    const rawDeposit =
      eq.deposit_amount == null ? 0 : Number(eq.deposit_amount);
    const depositSnapshot =
      Math.round((rawDeposit + Number.EPSILON) * 100) / 100;

    let trackingNumber;
    for (let attempt = 0; attempt < 3; attempt++) {
      trackingNumber = generateRentalTrackingNumber();
      const exists = await trx("rentals").where({ tracking_number: trackingNumber }).first("id");
      if (!exists) break;
    }

    const [rental] = await trx("rentals")
      .insert({
        tracking_number: trackingNumber,
        equipment_id: equipmentId,
        renter_id: renterId,
        owner_id: eq.owner_id,
        start_date: startDate,
        end_date: endDate,
        daily_price_snapshot: dailyPrice,
        total_price: total,
        commission_amount_snapshot: commissionAmountSnapshot,
        status: "approved",
        payment_status: "pending",
        approved_at: trx.fn.now(),
        renter_notes: renterNotes,
        payment_method: paymentMethod,
        delivery_address: deliveryAddress ? JSON.stringify(deliveryAddress) : null,
        deposit_amount: depositSnapshot,
        deposit_status: "none",
      })
      .returning(PUBLIC_RENTAL_FIELDS);

    return { rental, days };
  });
}

async function getById(id) {
  return knex("rentals").where({ id }).first(PUBLIC_RENTAL_FIELDS);
}

async function getByTracking(trackingNumber) {
  const rental = await knex("rentals as r")
    .leftJoin("equipment as e", "e.id", "r.equipment_id")
    .where("r.tracking_number", trackingNumber)
    .first(
      "r.*",
      "e.name as equipment_name",
      "e.primary_image_url as equipment_image",
      "e.category as equipment_category",
    );
  return rental || null;
}

/**
 * Full detail including equipment snapshot for display.
 */
async function getByIdWithDetails(id) {
  const rental = await knex("rentals as r")
    .leftJoin("equipment as e", "e.id", "r.equipment_id")
    .leftJoin("users as ru", "ru.id", "r.renter_id")
    .leftJoin("users as ou", "ou.id", "r.owner_id")
    .where("r.id", id)
    .first(
      "r.*",
      "e.name as equipment_name",
      "e.primary_image_url as equipment_image",
      "e.category as equipment_category",
      "ru.name as renter_name",
      "ru.email as renter_email",
      "ou.name as owner_name",
      "ou.email as owner_email",
    );
  return rental || null;
}

/**
 * List rentals with optional role-scoping.
 * role: 'renter' | 'owner' | 'admin'
 */
async function list({
  role,
  userId,
  status = null,
  page = 1,
  limit = 20,
} = {}) {
  const safeLimit = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
  const safePage = Math.max(1, parseInt(page, 10) || 1);
  const offset = (safePage - 1) * safeLimit;

  const dataQ = knex("rentals as r")
    .leftJoin("equipment as e", "e.id", "r.equipment_id")
    .select(
      "r.*",
      "e.name as equipment_name",
      "e.primary_image_url as equipment_image",
    );
  const countQ = knex("rentals").count("* as c").first();

  for (const q of [dataQ, countQ]) {
    if (role === "renter") {
      q.where(q === dataQ ? "r.renter_id" : "renter_id", userId);
    } else if (role === "owner") {
      q.where(q === dataQ ? "r.owner_id" : "owner_id", userId);
    }
    // 'admin' sees everything
    if (status) q.where(q === dataQ ? "r.status" : "status", status);
  }

  dataQ.orderBy("r.created_at", "desc").limit(safeLimit).offset(offset);

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
 * Owner approves a rental: pending -> approved.
 */
async function approve({ rentalId, ownerId, responseNote = null }) {
  return knex.transaction(async (trx) => {
    const rental = await trx("rentals")
      .where({ id: rentalId })
      .forUpdate()
      .first();
    if (!rental) throw new AppError("Rental not found", 404);
    if (rental.owner_id !== ownerId) {
      throw new AppError("You do not own this rental's equipment", 403);
    }
    if (rental.status !== "pending") {
      throw new AppError(
        `Cannot approve a rental in '${rental.status}' state`,
        400,
      );
    }

    // Double-check availability in case a parallel request slipped through.
    const conflicts = await countOverlapping(trx, {
      equipmentId: rental.equipment_id,
      startDate: rental.start_date,
      endDate: rental.end_date,
      excludeRentalId: rental.id,
    });
    // Only approved/active rentals count as confirmed conflicts.
    // We still have other pending requests; owner chooses which to approve.
    const hardConflicts = await trx("rentals")
      .where("equipment_id", rental.equipment_id)
      .whereIn("status", ["approved", "active"])
      .andWhere("start_date", "<=", rental.end_date)
      .andWhere("end_date", ">=", rental.start_date)
      .andWhereNot("id", rental.id)
      .count("* as c")
      .first();
    if (parseInt(hardConflicts.c, 10) > 0) {
      throw new AppError(
        "Another rental has already been approved for overlapping dates",
        409,
      );
    }
    void conflicts;

    const [updated] = await trx("rentals")
      .where({ id: rentalId })
      .update({
        status: "approved",
        owner_response: responseNote,
        approved_at: trx.fn.now(),
      })
      .returning(PUBLIC_RENTAL_FIELDS);

    return updated;
  });
}

/**
 * Owner rejects a rental: pending -> rejected.
 */
async function reject({ rentalId, ownerId, responseNote = null }) {
  const rental = await getById(rentalId);
  if (!rental) throw new AppError("Rental not found", 404);
  if (rental.owner_id !== ownerId) {
    throw new AppError("You do not own this rental's equipment", 403);
  }
  if (rental.status !== "pending") {
    throw new AppError(
      `Cannot reject a rental in '${rental.status}' state`,
      400,
    );
  }

  const [updated] = await knex("rentals")
    .where({ id: rentalId })
    .update({
      status: "rejected",
      owner_response: responseNote,
      cancelled_at: knex.fn.now(),
    })
    .returning(PUBLIC_RENTAL_FIELDS);
  return updated;
}

/**
 * Renter cancels their own rental: pending/approved -> cancelled.
 */
async function cancel({ rentalId, userId }) {
  return knex.transaction(async (trx) => {
    const rental = await trx("rentals")
      .where({ id: rentalId })
      .forUpdate()
      .first();
    if (!rental) throw new AppError("Rental not found", 404);

    // Renter or the owner can cancel (owner cancelling after approving
    // is a legitimate "change of plans" — we allow it).
    if (rental.renter_id !== userId && rental.owner_id !== userId) {
      throw new AppError("Not your rental", 403);
    }
    if (!["pending", "approved"].includes(rental.status)) {
      throw new AppError(
        `Cannot cancel a rental in '${rental.status}' state`,
        400,
      );
    }

    const [updated] = await trx("rentals")
      .where({ id: rentalId })
      .update({
        status: "cancelled",
        cancelled_at: trx.fn.now(),
      })
      .returning(PUBLIC_RENTAL_FIELDS);

    // If this rental was 'active' on the equipment (it wasn't, because we
    // guarded above), we'd need to flip the equipment back to 'available'.
    return updated;
  });
}

/**
 * Mark as started (rental begins). approved -> active.
 * Also flips the equipment to status 'rented' as a UX signal.
 * Typically triggered when the delivery is marked 'delivered', but an
 * owner can also call this manually.
 */
async function start({ rentalId, callerId, callerRole }) {
  return knex.transaction(async (trx) => {
    const rental = await trx("rentals")
      .where({ id: rentalId })
      .forUpdate()
      .first();
    if (!rental) throw new AppError("Rental not found", 404);

    const isParty =
      rental.owner_id === callerId || rental.renter_id === callerId;
    if (!isParty && callerRole !== "admin") {
      throw new AppError("Not permitted", 403);
    }
    if (rental.status !== "approved") {
      throw new AppError(
        `Cannot start a rental in '${rental.status}' state`,
        400,
      );
    }

    const updatePatch = {
      status: "active",
      started_at: trx.fn.now(),
    };
    // If a deposit was agreed at booking time, it's now "held" — the renter
    // has paid (or owes) the deposit and we'll either refund or forfeit it
    // on completion. We leave 'none' alone for zero-deposit rentals.
    if (
      Number(rental.deposit_amount) > 0 &&
      rental.deposit_status === "none"
    ) {
      updatePatch.deposit_status = "held";
    }

    const [updated] = await trx("rentals")
      .where({ id: rentalId })
      .update(updatePatch)
      .returning(PUBLIC_RENTAL_FIELDS);

    // Mark equipment 'rented' while this active rental is ongoing.
    await trx("equipment")
      .where({ id: rental.equipment_id })
      .update({ status: "rented" });

    return updated;
  });
}

/**
 * Complete a rental. active -> completed. Equipment goes back to 'available'.
 */
async function complete({ rentalId, callerId, callerRole }) {
  return knex.transaction(async (trx) => {
    const rental = await trx("rentals")
      .where({ id: rentalId })
      .forUpdate()
      .first();
    if (!rental) throw new AppError("Rental not found", 404);

    const isParty =
      rental.owner_id === callerId || rental.renter_id === callerId;
    if (!isParty && callerRole !== "admin") {
      throw new AppError("Not permitted", 403);
    }
    if (rental.status !== "active") {
      throw new AppError(
        `Cannot complete a rental in '${rental.status}' state`,
        400,
      );
    }

    const [updated] = await trx("rentals")
      .where({ id: rentalId })
      .update({
        status: "completed",
        completed_at: trx.fn.now(),
      })
      .returning(PUBLIC_RENTAL_FIELDS);

    // Record platform commission on this completed rental. Idempotent via
    // the unique partial index on rental_id.
    await commissionRepo.recordForRental(rentalId, trx);

    // Only flip equipment back to available if no OTHER active rental exists.
    const otherActive = await trx("rentals")
      .where("equipment_id", rental.equipment_id)
      .andWhere("status", "active")
      .andWhereNot("id", rentalId)
      .count("* as c")
      .first();
    if (parseInt(otherActive.c, 10) === 0) {
      await trx("equipment")
        .where({ id: rental.equipment_id })
        .update({ status: "available" });
    }

    return updated;
  });
}

/**
 * Resolve the security deposit on a completed rental.
 *
 * Possible resolutions:
 *   - refunded   : keep nothing → keptAmount must be 0.
 *   - partial    : keep some → 0 < keptAmount < deposit_amount.
 *   - forfeited  : keep everything → keptAmount must equal deposit_amount.
 *
 * Authorization:
 *   - The owner of the rented equipment can resolve.
 *   - An admin can also resolve (for dispute moderation).
 *
 * Pre-conditions:
 *   - rental.status must be 'completed' (deposit can only be settled on
 *     a returned rental — anything else is premature).
 *   - rental.deposit_status must be 'held' (we don't allow re-resolving a
 *     deposit; a wrong call would have to be reversed by an admin SQL
 *     update with audit notes).
 *
 * Returns the updated rental row.
 */
async function resolveDeposit({
  rentalId,
  callerId,
  callerRole,
  resolution,        // 'refunded' | 'partial' | 'forfeited'
  keptAmount = 0,
  notes = null,
}) {
  return knex.transaction(async (trx) => {
    const rental = await trx("rentals")
      .where({ id: rentalId })
      .forUpdate()
      .first();
    if (!rental) throw new AppError("Rental not found", 404);

    const isOwner = rental.owner_id === callerId;
    const isAdmin = callerRole === "admin";
    if (!isOwner && !isAdmin) {
      throw new AppError("Not permitted to resolve this deposit", 403);
    }

    if (rental.status !== "completed") {
      throw new AppError(
        "لا يمكن تسوية التأمين قبل اكتمال الإيجار",
        400,
      );
    }
    if (rental.deposit_status !== "held") {
      throw new AppError(
        `لا يمكن تسوية تأمين بحالة '${rental.deposit_status}'.`,
        400,
      );
    }

    const deposit = Number(rental.deposit_amount);
    let kept;
    if (resolution === "refunded") {
      kept = 0;
    } else if (resolution === "forfeited") {
      kept = deposit;
    } else if (resolution === "partial") {
      kept = Math.round((Number(keptAmount) + Number.EPSILON) * 100) / 100;
      if (!(kept > 0 && kept < deposit)) {
        throw new AppError(
          "في الحجز الجزئي يجب أن يكون المبلغ المُحتجَز أكبر من صفر وأقل من إجمالي التأمين",
          400,
        );
      }
    } else {
      throw new AppError(
        "resolution must be 'refunded', 'partial', or 'forfeited'",
        400,
      );
    }

    const [updated] = await trx("rentals")
      .where({ id: rentalId })
      .update({
        deposit_status: resolution,
        deposit_kept_amount: kept,
        deposit_resolved_at: trx.fn.now(),
        deposit_resolved_by: callerId,
        deposit_notes: notes,
      })
      .returning(PUBLIC_RENTAL_FIELDS);

    return updated;
  });
}

module.exports = {
  createRental,
  isAvailable,
  countOverlapping,
  getBookedRanges,
  daysBetween,
  getById,
  getByTracking,
  getByIdWithDetails,
  list,
  approve,
  reject,
  cancel,
  start,
  complete,
  resolveDeposit,
  PUBLIC_RENTAL_FIELDS,
};
