const knex = require("../db");
const promoRepo = require("./promo.repository");
const loyaltyRepo = require("./loyalty.repository");
const commissionRepo = require("./commission.repository");
const { generateTrackingNumber } = require("../utils/tracking");
const { computeTotals, lineTotal } = require("../utils/order-calculator");
const { AppError } = require("../middleware/errorHandler");

const PUBLIC_ORDER_FIELDS = [
  "id",
  "user_id",
  "promo_code_id",
  "tracking_number",
  "subtotal",
  "discount",
  "tax",
  "shipping_fee",
  "loyalty_points_used",
  "total",
  "loyalty_points_earned",
  "status",
  "payment_status",
  "shipping_address",
  "payment_intent_id",
  "payment_method",
  "paid_at",
  "notes",
  "created_at",
  "updated_at",
];

/**
 * Core create-order operation. Runs in a transaction so cart, stock,
 * promo counter, and the order itself all commit atomically — or nothing does.
 *
 * Flow:
 *   1. Re-fetch cart items with equipment snapshots.
 *   2. Validate each item (listing_type, status, stock).
 *   3. Optionally resolve + consume promo atomically.
 *   4. Apply loyalty points (capped).
 *   5. Compute totals server-side (never trust client amounts).
 *   6. Insert order + order_items.
 *   7. Decrement stock.
 *   8. Clear the cart.
 *
 * The order starts in status=pending, payment_status=pending. Moving it
 * forward is the job of the payment webhook (Stripe) or a manual call.
 */
async function createOrderFromCart({
  userId,
  shippingAddress,
  paymentMethod = "card",
  promoCode = null,
  loyaltyPointsRequested = 0,
  shippingFee = 0,
  notes = null,
}) {
  return knex.transaction(async (trx) => {
    // Find the cart
    const cart = await trx("carts").where({ user_id: userId }).first();
    if (!cart) throw new AppError("Cart is empty", 400);

    // Join with equipment, LOCKED FOR UPDATE so concurrent orders can't
    // oversell the same stock. We lock the equipment rows, not cart rows.
    const rawItems = await trx("cart_items as ci")
      .join("equipment as e", "e.id", "ci.equipment_id")
      .where("ci.cart_id", cart.id)
      .forUpdate()
      .select(
        "ci.id as cart_item_id",
        "ci.quantity",
        "e.id as equipment_id",
        "e.name",
        "e.sale_price",
        "e.sale_commission_amount",
        "e.listing_type",
        "e.status",
        "e.stock",
        "e.primary_image_url",
        "e.owner_id",
      );

    if (!rawItems.length) throw new AppError("Cart is empty", 400);

    // Validate each item and build the order-line payload.
    const itemsForOrder = [];
    for (const it of rawItems) {
      if (!["sale", "both"].includes(it.listing_type)) {
        throw new AppError(
          `'${it.name}' is not available for purchase`,
          400,
        );
      }
      if (it.status !== "available") {
        throw new AppError(
          `'${it.name}' is currently ${it.status}`,
          400,
        );
      }
      if (it.stock != null && it.quantity > it.stock) {
        throw new AppError(
          `'${it.name}' only has ${it.stock} in stock`,
          400,
        );
      }
      if (it.owner_id === userId) {
        throw new AppError("You cannot purchase your own listing", 400);
      }
      if (it.sale_price == null) {
        throw new AppError(`'${it.name}' has no sale price`, 400);
      }

      itemsForOrder.push({
        equipment_id: it.equipment_id,
        name_snapshot: it.name,
        image_snapshot: it.primary_image_url,
        quantity: it.quantity,
        price_per_unit: Number(it.sale_price),
        commission_per_unit: Number(it.sale_commission_amount) || 0,
      });
    }

    // Resolve the promo (still inside the transaction)
    let promo = null;
    let promoConsumed = false;
    if (promoCode) {
      promo = await promoRepo.findValidByCode(promoCode, trx);
      if (!promo) throw new AppError("Invalid or expired promo code", 400);
    }

    // Load user's loyalty balance atomically
    const user = await trx("users")
      .where({ id: userId })
      .forUpdate()
      .first("loyalty_points");
    if (!user) throw new AppError("User not found", 404);

    // Server-authoritative totals
    const totals = computeTotals({
      items: itemsForOrder.map((i) => ({
        price_per_unit: i.price_per_unit,
        quantity: i.quantity,
      })),
      promo,
      shippingFee,
      loyaltyPointsRequested,
      userLoyaltyBalance: Number(user.loyalty_points),
    });

    if (promo) {
      // Enforce min_order_total here since computeDiscount quietly returns 0
      // when unmet, and we want to reject the code explicitly.
      if (
        promo.min_order_total != null &&
        totals.subtotal < Number(promo.min_order_total)
      ) {
        throw new AppError(
          `Minimum order of ${promo.min_order_total} required for this code`,
          400,
        );
      }
      const ok = await promoRepo.consumeUse(promo.id, trx);
      if (!ok) throw new AppError("Promo code has been exhausted", 400);
      promoConsumed = true;
    }

    // Try up to 3 times in case of tracking_number collision (unlikely).
    let order;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const rows = await trx("orders")
          .insert({
            user_id: userId,
            promo_code_id: promo ? promo.id : null,
            tracking_number: generateTrackingNumber(),
            subtotal: totals.subtotal,
            discount: totals.discount,
            tax: totals.tax,
            shipping_fee: totals.shipping_fee,
            loyalty_points_used: totals.loyalty_points_used,
            total: totals.total,
            loyalty_points_earned: totals.loyalty_points_earned,
            status: "pending",
            payment_status: "pending",
            shipping_address: JSON.stringify(shippingAddress),
            payment_method: paymentMethod,
            notes,
          })
          .returning(PUBLIC_ORDER_FIELDS);
        order = rows[0];
        break;
      } catch (err) {
        if (err.code === "23505" && /tracking_number/.test(err.detail || err.message)) {
          continue;
        }
        // If we consumed a promo and now the order insert failed for another reason,
        // the transaction rollback will undo the promo use automatically.
        throw err;
      }
    }
    if (!order) throw new AppError("Could not generate tracking number", 500);

    // Insert order_items
    const itemRows = itemsForOrder.map((i) => ({
      order_id: order.id,
      equipment_id: i.equipment_id,
      equipment_name_snapshot: i.name_snapshot,
      equipment_image_snapshot: i.image_snapshot,
      quantity: i.quantity,
      price_per_unit: i.price_per_unit,
      line_total: lineTotal(i.price_per_unit, i.quantity),
      commission_per_unit: i.commission_per_unit,
    }));
    await trx("order_items").insert(itemRows);

    // Decrement stock for each equipment (only where stock is tracked)
    for (const i of itemsForOrder) {
      await trx("equipment")
        .where({ id: i.equipment_id })
        .andWhere("stock", ">=", i.quantity)
        .decrement("stock", i.quantity);
    }

    // Deduct loyalty points via the ledger (FIFO). This replaces the raw
    // column decrement so the loyalty_transactions log stays authoritative.
    if (totals.loyalty_points_used > 0) {
      await loyaltyRepo.debit({
        userId,
        kind: "spend",
        amount: Math.round(totals.loyalty_points_used),
        orderId: order.id,
        notes: `Spent on order ${order.tracking_number}`,
        trx,
      });
    }

    // Empty the cart
    await trx("cart_items").where({ cart_id: cart.id }).del();

    return { order, items: itemRows, promoConsumed };
  });
}

/**
 * List the caller's own orders.
 */
async function listByUser(userId, { page = 1, limit = 20 } = {}) {
  const safeLimit = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
  const safePage = Math.max(1, parseInt(page, 10) || 1);
  const offset = (safePage - 1) * safeLimit;

  const [items, countRow] = await Promise.all([
    knex("orders")
      .where({ user_id: userId })
      .select(PUBLIC_ORDER_FIELDS)
      .orderBy("created_at", "desc")
      .limit(safeLimit)
      .offset(offset),
    knex("orders").where({ user_id: userId }).count("* as c").first(),
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

async function getByIdForUser(orderId, userId) {
  const order = await knex("orders")
    .where({ id: orderId, user_id: userId })
    .first(PUBLIC_ORDER_FIELDS);
  if (!order) return null;
  const items = await knex("order_items")
    .where({ order_id: order.id })
    .select("*");
  return { ...order, items };
}

async function getByTracking(trackingNumber) {
  // Public-ish — does not require auth. We only expose a small subset
  // of fields to avoid leaking buyer info.
  const order = await knex("orders")
    .where({ tracking_number: trackingNumber })
    .first(
      "id",
      "tracking_number",
      "status",
      "payment_status",
      "total",
      "created_at",
      "paid_at",
    );
  return order || null;
}

/**
 * Admin-scoped list. Pagination + basic filters.
 */
async function listAll({ page = 1, limit = 20, status = null, paymentStatus = null } = {}) {
  const safeLimit = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
  const safePage = Math.max(1, parseInt(page, 10) || 1);
  const offset = (safePage - 1) * safeLimit;

  const dataQ = knex("orders").select(PUBLIC_ORDER_FIELDS);
  const countQ = knex("orders").count("* as c").first();
  for (const q of [dataQ, countQ]) {
    if (status) q.where("status", status);
    if (paymentStatus) q.where("payment_status", paymentStatus);
  }
  dataQ.orderBy("created_at", "desc").limit(safeLimit).offset(offset);

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
 * Mark an order paid. Idempotent — calling twice is a no-op on the second call.
 * Credits loyalty points earned and updates status.
 */
async function markPaid(orderId, { paymentIntentId = null } = {}) {
  return knex.transaction(async (trx) => {
    const order = await trx("orders")
      .where({ id: orderId })
      .forUpdate()
      .first();
    if (!order) throw new AppError("Order not found", 404);
    if (order.payment_status === "paid") return order; // idempotent

    await trx("orders")
      .where({ id: orderId })
      .update({
        payment_status: "paid",
        status: order.status === "pending" ? "confirmed" : order.status,
        paid_at: trx.fn.now(),
        payment_intent_id: paymentIntentId || order.payment_intent_id,
      });

    // Credit loyalty points earned via the ledger (so expiry + history work).
    if (order.loyalty_points_earned > 0) {
      await loyaltyRepo.credit({
        userId: order.user_id,
        kind: "earn",
        amount: order.loyalty_points_earned,
        orderId: order.id,
        notes: `Earned on order ${order.tracking_number}`,
        trx,
      });
    }

    // Record platform commission on each line item. Idempotent — a re-run
    // of markPaid returns early above, but the unique indexes are the
    // ultimate safety net.
    await commissionRepo.recordForOrder(order.id, trx);

    // ─── Create the delivery request so couriers can see the job ───
    // This is THE moment a courier is needed: payment cleared, order is
    // confirmed. We create one delivery_request per order with status
    // 'pending' and no courier_id — couriers see it in their "available"
    // tab. The pickup address is the seller's location (we use the first
    // item's owner location), and dropoff is the customer's shipping_address.
    //
    // Idempotent: we check first to handle webhook retries.
    const existingDelivery = await trx("delivery_requests")
      .where({ order_id: order.id })
      .first("id");

    if (!existingDelivery) {
      // Find the seller (owner) of the first item to use as pickup point.
      // For multi-seller orders we use the first; a future improvement is
      // to split into multiple delivery_requests per seller.
      const firstItem = await trx("order_items as oi")
        .leftJoin("equipment as e", "e.id", "oi.equipment_id")
        .leftJoin("users as u", "u.id", "e.owner_id")
        .where("oi.order_id", order.id)
        .first(
          "u.location as owner_location",
          "u.governorate as owner_governorate",
          "u.name as owner_name",
        );

      // Compose pickup address from owner profile if we have it; fall back
      // to a generic placeholder so the courier still has something to act on.
      const pickupAddress = firstItem && firstItem.owner_location
        ? (typeof firstItem.owner_location === "string"
            ? JSON.parse(firstItem.owner_location)
            : firstItem.owner_location)
        : {
            city: firstItem?.owner_governorate || "muscat",
            note: `استلام من البائع ${firstItem?.owner_name || ""}`.trim(),
          };

      const dropoffAddress = typeof order.shipping_address === "string"
        ? JSON.parse(order.shipping_address)
        : order.shipping_address || { city: "muscat" };

      await trx("delivery_requests").insert({
        order_id: order.id,
        courier_id: null,
        status: "pending",
        pickup_address: JSON.stringify(pickupAddress),
        dropoff_address: JSON.stringify(dropoffAddress),
        scheduled_date: new Date().toISOString().slice(0, 10),
        fee: order.shipping_fee || 2.0,
      });
    }

    return trx("orders").where({ id: orderId }).first(PUBLIC_ORDER_FIELDS);
  });
}

/**
 * Mark an order failed. Restores stock, releases promo use, refunds loyalty points.
 */
async function markFailed(orderId) {
  return knex.transaction(async (trx) => {
    const order = await trx("orders")
      .where({ id: orderId })
      .forUpdate()
      .first();
    if (!order) return null;
    if (order.payment_status === "failed") return order; // idempotent

    // Restore stock
    const items = await trx("order_items").where({ order_id: orderId });
    for (const it of items) {
      await trx("equipment")
        .where({ id: it.equipment_id })
        .increment("stock", it.quantity);
    }

    // Release promo use
    if (order.promo_code_id) {
      await promoRepo.releaseUse(order.promo_code_id, trx);
    }

    // Refund loyalty points used — a fresh credit (with a new 1-year
    // expiry) rather than trying to restore the original FIFO rows.
    // Simpler bookkeeping and the user doesn't lose points retroactively.
    if (order.loyalty_points_used > 0) {
      await loyaltyRepo.credit({
        userId: order.user_id,
        kind: "admin_adjust",
        amount: Math.round(order.loyalty_points_used),
        orderId: order.id,
        notes: `Refund for failed order ${order.tracking_number}`,
        trx,
      });
    }

    await trx("orders").where({ id: orderId }).update({
      payment_status: "failed",
      status: "cancelled",
    });

    return trx("orders").where({ id: orderId }).first(PUBLIC_ORDER_FIELDS);
  });
}

async function setPaymentIntent(orderId, paymentIntentId) {
  const [row] = await knex("orders")
    .where({ id: orderId })
    .update({ payment_intent_id: paymentIntentId })
    .returning(PUBLIC_ORDER_FIELDS);
  return row;
}

async function findByPaymentIntent(paymentIntentId) {
  return knex("orders")
    .where({ payment_intent_id: paymentIntentId })
    .first();
}

async function getByIdForAdmin(orderId) {
  const order = await knex("orders as o")
    .leftJoin("users as u", "u.id", "o.user_id")
    .where("o.id", orderId)
    .first(
      "o.*",
      "u.name as buyer_name",
      "u.email as buyer_email",
      "u.phone as buyer_phone",
    );
  if (!order) return null;
  const [items, delivery] = await Promise.all([
    knex("order_items as oi")
      .leftJoin("equipment as e", "e.id", "oi.equipment_id")
      .where("oi.order_id", orderId)
      .select("oi.*", "e.name as equipment_name", "e.primary_image_url as image_url"),
    knex("delivery_requests").where({ order_id: orderId }).first(),
  ]);
  return { ...order, items: items || [], delivery: delivery || null };
}

module.exports = {
  createOrderFromCart,
  listByUser,
  getByIdForUser,
  getByTracking,
  getByIdForAdmin,
  listAll,
  markPaid,
  markFailed,
  setPaymentIntent,
  findByPaymentIntent,
  PUBLIC_ORDER_FIELDS,
};
