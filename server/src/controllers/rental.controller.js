const rentalRepo = require("../repositories/rental.repository");
const notificationService = require("../services/notification.service");
const { AppError, asyncHandler } = require("../middleware/errorHandler");
const knex = require("../db");

/**
 * POST /rentals
 * Any authenticated user can request a rental (even owners can rent from others).
 */
const create = asyncHandler(async (req, res) => {
  const {
    equipment_id,
    start_date,
    end_date,
    renter_notes = null,
    payment_method = null,
    delivery_address = null,
  } = req.body;

  const { rental, days } = await rentalRepo.createRental({
    renterId: req.user.id,
    equipmentId: equipment_id,
    startDate: start_date,
    endDate: end_date,
    renterNotes: renter_notes,
    paymentMethod: payment_method,
    deliveryAddress: delivery_address,
  });

  // Notify owner — fire-and-forget.
  notificationService.events
    .rentalRequested(rental.owner_id, rental, req.user.name || "مستخدم")
    .catch((e) => console.error("[rentalRequested notify failed]", e.message));

  // Auto-create delivery request so driver can pick it up immediately.
  if (delivery_address) {
    try {
      const addr = typeof delivery_address === "string"
        ? JSON.parse(delivery_address) : delivery_address;
      const owner = await knex("users").where({ id: rental.owner_id }).first("name", "phone");
      const [deliveryRow] = await knex("delivery_requests")
        .insert({
          rental_id: rental.id,
          courier_id: null,
          status: "pending",
          pickup_address: JSON.stringify({ city: "عُمان", notes: `اتصل بالمالك: ${owner?.name || ""}` }),
          dropoff_address: JSON.stringify(addr),
          scheduled_date: rental.start_date,
          fee: 2.0,
        })
        .returning("*");
      if (deliveryRow) {
        notificationService.events
          .newDeliveryAvailable(deliveryRow, rental.tracking_number)
          .catch((e) => console.error("[rental newDeliveryAvailable failed]", e.message));
      }
    } catch (e) {
      console.error("[rental auto-delivery creation failed]", e.message);
    }
  }

  res.status(201).json({
    success: true,
    rental,
    days,
  });
});

/**
 * GET /rentals
 *
 * Scope resolution:
 *   - admin + ?scope=admin   -> all rentals
 *   - owner                  -> rentals for their equipment
 *   - renter                 -> rentals they created
 *   - ?scope=renter/owner    -> force that view (e.g. owner who also rents)
 */
const list = asyncHandler(async (req, res) => {
  const { page, limit, status, scope } = req.query;

  let resolvedScope;
  if (req.user.role === "admin" && scope === "admin") {
    resolvedScope = "admin";
  } else if (scope === "owner") {
    resolvedScope = "owner";
  } else if (scope === "renter") {
    resolvedScope = "renter";
  } else if (req.user.role === "owner") {
    resolvedScope = "owner";
  } else {
    resolvedScope = "renter";
  }

  const result = await rentalRepo.list({
    role: resolvedScope,
    userId: req.user.id,
    status,
    page,
    limit,
  });
  res.json({ success: true, scope: resolvedScope, ...result });
});

/**
 * GET /rentals/:id
 * Renter, owner of the equipment, or admin can view.
 */
const getOne = asyncHandler(async (req, res) => {
  const rental = await rentalRepo.getByIdWithDetails(req.params.id);
  if (!rental) throw new AppError("Rental not found", 404);

  const isParty =
    rental.renter_id === req.user.id || rental.owner_id === req.user.id;
  if (!isParty && req.user.role !== "admin") {
    throw new AppError("Not permitted", 403);
  }

  res.json({ success: true, rental });
});

const approve = asyncHandler(async (req, res) => {
  const rental = await rentalRepo.approve({
    rentalId: req.params.id,
    ownerId: req.user.id,
    responseNote: req.body.response_note || null,
  });

  // Notify the renter.
  notificationService.events.rentalApproved(rental.renter_id, rental).catch((e) => {
    // eslint-disable-next-line no-console
    console.error("[rentalApproved notify failed]", e.message);
  });

  // Auto-create a delivery request if the renter provided a delivery address
  if (rental.delivery_address) {
    try {
      const addr = typeof rental.delivery_address === "string"
        ? JSON.parse(rental.delivery_address) : rental.delivery_address;

      // Fetch owner address as pickup point
      const owner = await knex("users").where({ id: rental.owner_id }).first("name", "phone");
      const eq = await knex("equipment").where({ id: rental.equipment_id }).first("name");

      const [deliveryRow] = await knex("delivery_requests")
        .insert({
          rental_id: rental.id,
          courier_id: null,
          status: "pending",
          pickup_address: JSON.stringify({ city: "عُمان", notes: `اتصل بالمالك: ${owner?.name || ""}` }),
          dropoff_address: JSON.stringify(addr),
          scheduled_date: rental.start_date,
          fee: 2.0,
        })
        .returning("*");

      if (deliveryRow) {
        notificationService.events
          .newDeliveryAvailable(deliveryRow, rental.tracking_number)
          .catch((e) => {
            // eslint-disable-next-line no-console
            console.error("[rental newDeliveryAvailable failed]", e.message);
          });
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("[rental delivery creation failed]", e.message);
    }
  }

  res.json({ success: true, rental });
});

const reject = asyncHandler(async (req, res) => {
  const rental = await rentalRepo.reject({
    rentalId: req.params.id,
    ownerId: req.user.id,
    responseNote: req.body.response_note || null,
  });
  notificationService.events
    .rentalRejected(rental.renter_id, rental, req.body.response_note || null)
    .catch((e) => {
      // eslint-disable-next-line no-console
      console.error("[rentalRejected notify failed]", e.message);
    });
  res.json({ success: true, rental });
});

const cancel = asyncHandler(async (req, res) => {
  const rental = await rentalRepo.cancel({
    rentalId: req.params.id,
    userId: req.user.id,
  });
  res.json({ success: true, rental });
});

const start = asyncHandler(async (req, res) => {
  const rental = await rentalRepo.start({
    rentalId: req.params.id,
    callerId: req.user.id,
    callerRole: req.user.role,
  });
  res.json({ success: true, rental });
});

const complete = asyncHandler(async (req, res) => {
  const rental = await rentalRepo.complete({
    rentalId: req.params.id,
    callerId: req.user.id,
    callerRole: req.user.role,
  });
  res.json({ success: true, rental });
});

/**
 * POST /rentals/:id/deposit/resolve
 * Body: { resolution: 'refunded'|'partial'|'forfeited', kept_amount?, notes? }
 *
 * Owner (or admin) settles the security deposit on a completed rental.
 *
 * - 'refunded'  : equipment returned in good shape → renter gets full deposit.
 * - 'partial'   : minor damage / cleaning fee → owner keeps `kept_amount`.
 * - 'forfeited' : major damage or non-return → owner keeps the full deposit.
 *
 * Notifies the renter regardless of outcome so they aren't surprised.
 */
const resolveDeposit = asyncHandler(async (req, res) => {
  const { resolution, kept_amount = 0, notes = null } = req.body;

  const rental = await rentalRepo.resolveDeposit({
    rentalId: req.params.id,
    callerId: req.user.id,
    callerRole: req.user.role,
    resolution,
    keptAmount: kept_amount,
    notes,
  });

  // Notify the renter — fire-and-forget.
  const titles = {
    refunded: "تم استرداد التأمين بالكامل",
    partial: "تم استرداد جزء من التأمين",
    forfeited: "تم احتجاز التأمين",
  };
  const messages = {
    refunded: `تمت إعادة كامل مبلغ التأمين (${rental.deposit_amount} ر.ع).`,
    partial: `تم احتجاز ${rental.deposit_kept_amount} ر.ع من أصل ${rental.deposit_amount} ر.ع. سيُعاد الباقي.${notes ? " السبب: " + notes : ""}`,
    forfeited: `تم احتجاز كامل مبلغ التأمين (${rental.deposit_amount} ر.ع).${notes ? " السبب: " + notes : ""}`,
  };
  notificationService
    .notify({
      userId: rental.renter_id,
      type: "rental",
      title: titles[resolution] || "تسوية التأمين",
      message: messages[resolution] || "تمت تسوية التأمين على إيجارك.",
      metadata: {
        rental_id: rental.id,
        deposit_status: resolution,
        deposit_amount: rental.deposit_amount,
        deposit_kept_amount: rental.deposit_kept_amount,
      },
      email: true,
    })
    .catch((e) => console.error("[deposit notify failed]", e.message));

  res.json({ success: true, rental });
});

/**
 * GET /equipment/:id/availability?start_date=&end_date=
 * Public. Quick check before committing to a rental request.
 */
const availability = asyncHandler(async (req, res) => {
  const { start_date, end_date } = req.query;
  const available = await rentalRepo.isAvailable({
    equipmentId: req.params.id,
    startDate: start_date,
    endDate: end_date,
  });
  const days = rentalRepo.daysBetween(start_date, end_date);
  res.json({ success: true, available, days });
});

/**
 * GET /rentals/booked-dates/:id
 * Public. Returns the booked date ranges for an equipment so the booking
 * calendar can mark rented days off (and block them from selection).
 */
const bookedDates = asyncHandler(async (req, res) => {
  const ranges = await rentalRepo.getBookedRanges(req.params.id);
  res.json({ success: true, ranges });
});

module.exports = {
  create,
  list,
  getOne,
  approve,
  reject,
  cancel,
  start,
  complete,
  resolveDeposit,
  availability,
  bookedDates,
};
