const knex = require("../db");
const deliveryRepo = require("../repositories/delivery.repository");
const notificationService = require("../services/notification.service");
const { AppError, asyncHandler } = require("../middleware/errorHandler");

/**
 * Resolve the "customer" for a delivery (the person the courier is
 * delivering TO). For a rental that's the renter; for an order that's
 * the order owner. Returns null if nothing matches.
 */
async function resolveCustomerId(delivery) {
  if (delivery.rental_id) {
    const r = await knex("rentals")
      .where({ id: delivery.rental_id })
      .first("renter_id");
    return r?.renter_id || null;
  }
  if (delivery.order_id) {
    const o = await knex("orders")
      .where({ id: delivery.order_id })
      .first("user_id");
    return o?.user_id || null;
  }
  return null;
}

/**
 * POST /deliveries
 * Create a delivery request. Caller must be the owner of the linked
 * rental's equipment or the order's seller, OR an admin.
 *
 * For now we allow the creator to be the customer too (renter/buyer)
 * because it's often the customer who initiates delivery. We just verify
 * the linkage exists and the caller is a party to it.
 */
const create = asyncHandler(async (req, res) => {
  const {
    rental_id = null,
    order_id = null,
    pickup_address,
    dropoff_address,
    scheduled_date = null,
    fee = 0,
    notes = null,
  } = req.body;

  // Verify the caller is a party to the linked rental/order
  if (rental_id) {
    const rental = await knex("rentals").where({ id: rental_id }).first();
    if (!rental) throw new AppError("Rental not found", 404);
    const isParty =
      rental.renter_id === req.user.id || rental.owner_id === req.user.id;
    if (!isParty && !req.user.is_admin) {
      throw new AppError("Not permitted for this rental", 403);
    }
  } else {
    const order = await knex("orders").where({ id: order_id }).first();
    if (!order) throw new AppError("Order not found", 404);
    if (order.user_id !== req.user.id && !req.user.is_admin) {
      // Sellers are reachable via order_items.equipment.owner_id; we allow
      // buyer + admin to initiate for simplicity. Sellers can always coordinate
      // via the chat feature in a later phase.
      throw new AppError("Not permitted for this order", 403);
    }
  }

  const delivery = await deliveryRepo.create({
    rentalId: rental_id,
    orderId: order_id,
    pickupAddress: pickup_address,
    dropoffAddress: dropoff_address,
    scheduledDate: scheduled_date,
    fee,
    notes,
  });

  res.status(201).json({ success: true, delivery });
});

/**
 * GET /deliveries
 * Courier job board + scoped views. There's no more role distinction —
 * the caller always passes an explicit `scope`; we default to `customer`
 * (deliveries tied to things the caller bought/rented) when omitted.
 */
const list = asyncHandler(async (req, res) => {
  let { scope, status, order_id, page, limit } = req.query;

  if (!scope) scope = "customer";

  // Authorization: only admins can ask for 'admin' scope.
  if (scope === "admin" && !req.user.is_admin) {
    throw new AppError("Admin scope requires admin privileges", 403);
  }
  // The open job board ('available' = pending & unclaimed) is visible to
  // any authenticated user — anyone can accept an unclaimed delivery job.

  const result = await deliveryRepo.list({
    scope,
    userId: req.user.id,
    status,
    orderId: order_id || null,
    page,
    limit,
  });
  res.json({ success: true, scope, ...result });
});

/**
 * GET /deliveries/:id
 * Parties to the delivery + admin. We check by walking the linkage.
 */
const getOne = asyncHandler(async (req, res) => {
  const delivery = await deliveryRepo.getById(req.params.id);
  if (!delivery) throw new AppError("Delivery not found", 404);

  if (req.user.is_admin) {
    return res.json({ success: true, delivery });
  }
  if (delivery.courier_id === req.user.id) {
    return res.json({ success: true, delivery });
  }

  // Check rental/order linkage
  let authorized = false;
  if (delivery.rental_id) {
    const r = await knex("rentals").where({ id: delivery.rental_id }).first();
    authorized =
      r && (r.renter_id === req.user.id || r.owner_id === req.user.id);
  } else if (delivery.order_id) {
    const o = await knex("orders").where({ id: delivery.order_id }).first();
    authorized = o && o.user_id === req.user.id;
    if (!authorized) {
      // Check if caller is a seller on any line item
      const seller = await knex("order_items as oi")
        .join("equipment as e", "e.id", "oi.equipment_id")
        .where("oi.order_id", delivery.order_id)
        .andWhere("e.owner_id", req.user.id)
        .first();
      authorized = !!seller;
    }
  }

  if (!authorized) throw new AppError("Not permitted", 403);
  res.json({ success: true, delivery });
});

/**
 * POST /deliveries/:id/accept — courier claims a pending job.
 */
const accept = asyncHandler(async (req, res) => {
  const delivery = await deliveryRepo.accept({
    deliveryId: req.params.id,
    courierId: req.user.id,
  });

  // Notify the customer that a courier has been assigned. Fire-and-forget.
  const customerId = await resolveCustomerId(delivery);
  if (customerId) {
    notificationService.events
      .deliveryAssigned(customerId, delivery)
      .catch((e) => {
        // eslint-disable-next-line no-console
        console.error("[deliveryAssigned notify failed]", e.message);
      });
  }

  res.json({ success: true, delivery });
});

const pickup = asyncHandler(async (req, res) => {
  const location = req.body.proof_location || null;
  if (location?.client_ts) {
    const diff = Math.abs(Date.now() - new Date(location.client_ts).getTime());
    if (diff > 5 * 60 * 1000) {
      return res.status(400).json({ success: false, error: { message: "صورة التأكيد قديمة — يجب التقاط صورة جديدة" } });
    }
  }
  const delivery = await deliveryRepo.pickup({
    deliveryId: req.params.id,
    courierId: req.user.id,
    notes: req.body.notes ?? null,
    proofImages: Array.isArray(req.body.proof_images) ? req.body.proof_images : [],
    proofLocation: location,
  });
  res.json({ success: true, delivery });
});

const inTransit = asyncHandler(async (req, res) => {
  const delivery = await deliveryRepo.inTransit({
    deliveryId: req.params.id,
    courierId: req.user.id,
    notes: req.body.notes ?? null,
  });
  res.json({ success: true, delivery });
});

const markDelivered = asyncHandler(async (req, res) => {
  const location = req.body.proof_location || null;
  if (location?.client_ts) {
    const diff = Math.abs(Date.now() - new Date(location.client_ts).getTime());
    if (diff > 5 * 60 * 1000) {
      return res.status(400).json({ success: false, error: { message: "صورة التأكيد قديمة — يجب التقاط صورة جديدة" } });
    }
  }
  const delivery = await deliveryRepo.markDelivered({
    deliveryId: req.params.id,
    courierId: req.user.id,
    notes: req.body.notes ?? null,
    proofImages: Array.isArray(req.body.proof_images) ? req.body.proof_images : [],
    proofLocation: location,
  });

  // Notify the customer that their item has arrived.
  const customerId = await resolveCustomerId(delivery);
  if (customerId) {
    notificationService.events
      .deliveryDelivered(customerId, delivery)
      .catch((e) => {
        // eslint-disable-next-line no-console
        console.error("[deliveryDelivered notify failed]", e.message);
      });
  }

  res.json({ success: true, delivery });
});

const cancel = asyncHandler(async (req, res) => {
  const delivery = await deliveryRepo.cancelByCourier({
    deliveryId: req.params.id,
    courierId: req.user.id,
    notes: req.body.notes ?? null,
  });
  res.json({ success: true, delivery });
});

module.exports = {
  create,
  list,
  getOne,
  accept,
  pickup,
  inTransit,
  markDelivered,
  cancel,
};
