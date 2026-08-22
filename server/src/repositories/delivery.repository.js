const knex = require("../db");
const { AppError } = require("../middleware/errorHandler");

const PUBLIC_DELIVERY_FIELDS = [
  "id",
  "rental_id",
  "order_id",
  "courier_id",
  "status",
  "pickup_address",
  "dropoff_address",
  "scheduled_date",
  "accepted_at",
  "picked_up_at",
  "delivered_at",
  "cancelled_at",
  "fee",
  "notes",
  "pickup_proof_images",
  "delivery_proof_images",
  "created_at",
  "updated_at",
];

// Valid status transitions. Guards against skipping states (e.g. pending -> delivered).
const TRANSITIONS = {
  pending: ["accepted", "cancelled"],
  accepted: ["picked_up", "cancelled"],
  picked_up: ["in_transit", "cancelled"],
  in_transit: ["delivered", "cancelled"],
  delivered: [], // terminal
  cancelled: [], // terminal
};

/**
 * Create a new delivery request linked to either a rental or an order
 * (the DB CHECK constraint enforces exactly one).
 *
 * We don't validate the rental/order exists here with extra queries — the
 * FK constraint will reject bad IDs at insert time, and the XOR check
 * ensures we didn't somehow pass both.
 */
async function create({
  rentalId = null,
  orderId = null,
  pickupAddress,
  dropoffAddress,
  scheduledDate = null,
  fee = 0,
  notes = null,
}) {
  const [row] = await knex("delivery_requests")
    .insert({
      rental_id: rentalId,
      order_id: orderId,
      pickup_address: JSON.stringify(pickupAddress),
      dropoff_address: JSON.stringify(dropoffAddress),
      scheduled_date: scheduledDate,
      fee,
      notes,
      status: "pending",
    })
    .returning(PUBLIC_DELIVERY_FIELDS);
  return row;
}

async function getById(id) {
  return knex("delivery_requests").where({ id }).first(PUBLIC_DELIVERY_FIELDS);
}

/**
 * List deliveries with scope filtering.
 *
 *   scope = 'available'  -> status=pending, courier_id IS NULL (job board)
 *   scope = 'mine'       -> courier's own active jobs
 *   scope = 'owner'      -> deliveries tied to rentals/orders owned by caller
 *   scope = 'customer'   -> deliveries tied to rentals/orders of caller
 *   scope = 'admin'      -> all (admin only)
 */
async function list({
  scope,
  userId,
  status = null,
  orderId = null,
  page = 1,
  limit = 20,
} = {}) {
  const safeLimit = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
  const safePage = Math.max(1, parseInt(page, 10) || 1);
  const offset = (safePage - 1) * safeLimit;

  // Include courier name/phone so frontends (track.html, admin dashboard)
  // can display them without a second round-trip. LEFT JOIN so unclaimed
  // rows still return.
  const dataQ = knex("delivery_requests as d")
    .leftJoin("users as cu", "cu.id", "d.courier_id")
    .select(
      "d.*",
      "cu.name as courier_name",
      "cu.phone as courier_phone",
    );
  const countQ = knex("delivery_requests as d").count("* as c").first();

  for (const q of [dataQ, countQ]) {
    if (scope === "available") {
      q.where("d.status", "pending").whereNull("d.courier_id");
    } else if (scope === "mine") {
      q.where("d.courier_id", userId);
    } else if (scope === "owner") {
      q.leftJoin("rentals as r", "r.id", "d.rental_id")
        .leftJoin("orders as o", "o.id", "d.order_id")
        .leftJoin("order_items as oi", "oi.order_id", "o.id")
        .leftJoin("equipment as e", "e.id", "oi.equipment_id")
        .where((w) => {
          w.where("r.owner_id", userId).orWhere("e.owner_id", userId);
        })
        .groupBy("d.id", "cu.name", "cu.phone");
    } else if (scope === "customer") {
      q.leftJoin("rentals as r", "r.id", "d.rental_id")
        .leftJoin("orders as o", "o.id", "d.order_id")
        .where((w) => {
          w.where("r.renter_id", userId).orWhere("o.user_id", userId);
        });
    }
    // 'admin' gets no scope filter
    if (status) q.where("d.status", status);
    if (orderId) q.where("d.order_id", orderId);
  }

  dataQ.orderBy("d.created_at", "desc").limit(safeLimit).offset(offset);

  const [items, countRow] = await Promise.all([dataQ, countQ]);
  // COUNT on a grouped query returns a row per group; if scope='owner' we
  // need a different approach. Recompute total as length of data as a
  // safe fallback when grouping.
  let total;
  if (scope === "owner") {
    // Re-run without limit/offset to get accurate count
    const ids = await knex("delivery_requests as d")
      .leftJoin("rentals as r", "r.id", "d.rental_id")
      .leftJoin("orders as o", "o.id", "d.order_id")
      .leftJoin("order_items as oi", "oi.order_id", "o.id")
      .leftJoin("equipment as e", "e.id", "oi.equipment_id")
      .where((w) => {
        w.where("r.owner_id", userId).orWhere("e.owner_id", userId);
      })
      .modify((q) => {
        if (status) q.where("d.status", status);
      })
      .countDistinct("d.id as c")
      .first();
    total = parseInt(ids.c, 10);
  } else {
    total = parseInt(countRow.c, 10);
  }

  // ── Enrich courier-facing scopes with order/rental meta ──────────────
  if (["available", "mine"].includes(scope) && items.length) {
    const orderIds  = [...new Set(items.map((d) => d.order_id).filter(Boolean))];
    const rentalIds = [...new Set(items.map((d) => d.rental_id).filter(Boolean))];

    if (orderIds.length) {
      const orderRows = await knex("orders as o")
        .whereIn("o.id", orderIds)
        .select("o.id", "o.tracking_number", "o.total", "o.payment_method");

      const itemRows = await knex("order_items as oi")
        .join("equipment as e", "e.id", "oi.equipment_id")
        .whereIn("oi.order_id", orderIds)
        .select("oi.order_id", "oi.equipment_name_snapshot", "oi.quantity")
        .orderBy("oi.created_at");

      const orderMap = {};
      for (const o of orderRows) orderMap[o.id] = { ...o, items: [] };
      for (const it of itemRows) {
        if (orderMap[it.order_id]) orderMap[it.order_id].items.push(it);
      }
      for (const d of items) {
        if (d.order_id && orderMap[d.order_id]) d.order_meta = orderMap[d.order_id];
      }
    }

    if (rentalIds.length) {
      const rentalRows = await knex("rentals as r")
        .leftJoin("equipment as e", "e.id", "r.equipment_id")
        .whereIn("r.id", rentalIds)
        .select(
          "r.id",
          "r.tracking_number",
          "r.total_price",
          "r.deposit_amount",
          "r.payment_method",
          "r.start_date",
          "r.end_date",
          "e.name as equipment_name",
          "e.primary_image_url as equipment_image",
        );

      const rentalMap = {};
      for (const r of rentalRows) rentalMap[r.id] = r;
      for (const d of items) {
        if (d.rental_id && rentalMap[d.rental_id]) d.rental_meta = rentalMap[d.rental_id];
      }
    }
  }

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
 * Atomic accept: a pending delivery with no courier becomes accepted by this courier.
 *
 * The WHERE clause ensures only ONE courier wins if two hit 'accept' at the
 * same moment. The other gets 0 rows affected and an error.
 */
async function accept({ deliveryId, courierId }) {
  return knex.transaction(async (trx) => {
    const d = await trx("delivery_requests").where({ id: deliveryId }).forUpdate().first();
    if (!d) throw new AppError("Delivery not found", 404);

    // Block self-dealing: a party to the underlying order/rental (buyer,
    // seller, renter, or owner) must never be able to accept it as the
    // courier too — otherwise they can "deliver" it to themselves and
    // self-certify photo/GPS proof that never happened, auto-completing
    // their own order/rental with no real handoff.
    let partyIds = [];
    if (d.rental_id) {
      const rental = await trx("rentals")
        .where({ id: d.rental_id })
        .first("renter_id", "owner_id");
      if (rental) partyIds = [rental.renter_id, rental.owner_id];
    } else if (d.order_id) {
      const order = await trx("orders").where({ id: d.order_id }).first("user_id");
      const sellerIds = await trx("order_items as oi")
        .join("equipment as e", "e.id", "oi.equipment_id")
        .where("oi.order_id", d.order_id)
        .pluck("e.owner_id");
      partyIds = [order?.user_id, ...sellerIds];
    }
    if (partyIds.filter(Boolean).includes(courierId)) {
      throw new AppError("You cannot deliver your own order or rental", 403);
    }

    const [updated] = await trx("delivery_requests")
      .where({ id: deliveryId, status: "pending", courier_id: null })
      .update({
        courier_id: courierId,
        status: "accepted",
        accepted_at: trx.fn.now(),
      })
      .returning(PUBLIC_DELIVERY_FIELDS);
    if (!updated) {
      throw new AppError(
        "This delivery is no longer available (already taken or not pending)",
        409,
      );
    }
    return updated;
  });
}

/**
 * Transition a delivery to a new status.
 * Enforces the allowed transitions and courier identity.
 */
async function transition({ deliveryId, courierId, to, notes = null, proofImages = [], proofLocation = null }) {
  return knex.transaction(async (trx) => {
    const d = await trx("delivery_requests")
      .where({ id: deliveryId })
      .forUpdate()
      .first();
    if (!d) throw new AppError("Delivery not found", 404);
    if (d.courier_id !== courierId) {
      throw new AppError("This delivery is not assigned to you", 403);
    }
    const allowed = TRANSITIONS[d.status] || [];
    if (!allowed.includes(to)) {
      throw new AppError(
        `Cannot transition from '${d.status}' to '${to}'`,
        400,
      );
    }

    const patch = { status: to };
    if (notes !== null) patch.notes = notes;
    if (to === "picked_up") patch.picked_up_at = trx.fn.now();
    if (to === "delivered") patch.delivered_at = trx.fn.now();
    if (to === "cancelled") patch.cancelled_at = trx.fn.now();

    // Courier proof-of-work uploads. We store arrays of URLs as JSONB so
    // multiple photos per stage are possible. Empty array is the default
    // and also what you get when the courier confirms with no attachments.
    if (to === "picked_up") {
      if (Array.isArray(proofImages) && proofImages.length) {
        patch.pickup_proof_images = JSON.stringify(proofImages);
      }
      if (proofLocation) patch.pickup_proof_location = JSON.stringify(proofLocation);
    }
    if (to === "delivered") {
      if (Array.isArray(proofImages) && proofImages.length) {
        patch.delivery_proof_images = JSON.stringify(proofImages);
      }
      if (proofLocation) patch.delivery_proof_location = JSON.stringify(proofLocation);
    }

    const [updated] = await trx("delivery_requests")
      .where({ id: deliveryId })
      .update(patch)
      .returning(PUBLIC_DELIVERY_FIELDS);

    // Side effect: when a rental's delivery reaches 'delivered', auto-start
    // the rental so the owner doesn't have to do it manually.
    if (to === "delivered" && d.rental_id) {
      const rental = await trx("rentals")
        .where({ id: d.rental_id })
        .forUpdate()
        .first();
      if (rental && rental.status === "approved") {
        await trx("rentals")
          .where({ id: d.rental_id })
          .update({ status: "active", started_at: trx.fn.now() });
        await trx("equipment")
          .where({ id: rental.equipment_id })
          .update({ status: "rented" });
      }
    }

    // Side effect: when an order's delivery reaches 'delivered', bump the
    // order to 'delivered' too.
    if (to === "delivered" && d.order_id) {
      await trx("orders")
        .where({ id: d.order_id })
        .andWhereNot("status", "delivered")
        .update({ status: "delivered" });
    }

    return updated;
  });
}

/**
 * Convenience wrappers — all route through transition() for consistency.
 */
const pickup        = (args) => transition({ ...args, to: "picked_up" });
const inTransit     = (args) => transition({ ...args, to: "in_transit" });
const markDelivered = (args) => transition({ ...args, to: "delivered" });
const cancelByCourier = (args) => transition({ ...args, to: "cancelled" });

module.exports = {
  create,
  getById,
  list,
  accept,
  transition,
  pickup,
  inTransit,
  markDelivered,
  cancelByCourier,
  TRANSITIONS,
  PUBLIC_DELIVERY_FIELDS,
};
