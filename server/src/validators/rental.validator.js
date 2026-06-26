const { body, param, query } = require("express-validator");
const { validate } = require("./auth.validator");

// ISO date format: YYYY-MM-DD
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Ensure start_date is today or later (no retroactive bookings).
 * Done client-side too, but enforced here as the authoritative check.
 */
function notInPast(value) {
  if (!ISO_DATE.test(value)) throw new Error("Date must be YYYY-MM-DD");
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const d = new Date(`${value}T00:00:00Z`);
  if (d < today) throw new Error("Date cannot be in the past");
  return true;
}

function endAfterStart(value, { req }) {
  const start = req.body.start_date;
  if (!start || !ISO_DATE.test(start)) return true; // already handled
  if (!ISO_DATE.test(value)) throw new Error("Date must be YYYY-MM-DD");
  if (new Date(`${value}T00:00:00Z`) < new Date(`${start}T00:00:00Z`)) {
    throw new Error("end_date must be on or after start_date");
  }
  return true;
}

const createRentalValidator = [
  body("equipment_id").isUUID().withMessage("Invalid equipment_id"),
  body("start_date").custom(notInPast),
  body("end_date").custom(endAfterStart),
  body("renter_notes")
    .optional({ values: "falsy" })
    .isString()
    .isLength({ max: 2000 }),
  body("payment_method")
    .optional({ values: "falsy" })
    .isIn(["card", "cash_on_delivery"])
    .withMessage("payment_method must be 'card' or 'cash_on_delivery'"),
  body("delivery_address")
    .optional({ values: "null" })
    .isObject()
    .withMessage("delivery_address must be an object"),
  validate,
];

const rentalIdValidator = [
  param("id").isUUID().withMessage("Invalid rental id"),
  validate,
];

const approveRejectValidator = [
  param("id").isUUID().withMessage("Invalid rental id"),
  body("response_note")
    .optional({ values: "null" })
    .isString()
    .isLength({ max: 2000 }),
  validate,
];

const listQueryValidator = [
  query("page").optional().isInt({ min: 1 }).toInt(),
  query("limit").optional().isInt({ min: 1, max: 100 }).toInt(),
  query("status")
    .optional()
    .isIn(["pending", "approved", "active", "completed", "cancelled", "rejected"]),
  query("scope").optional().isIn(["renter", "owner", "admin"]),
  validate,
];

const availabilityValidator = [
  param("id").isUUID().withMessage("Invalid equipment id"),
  query("start_date")
    .matches(ISO_DATE)
    .withMessage("start_date required (YYYY-MM-DD)"),
  query("end_date")
    .matches(ISO_DATE)
    .withMessage("end_date required (YYYY-MM-DD)"),
  validate,
];

const bookedDatesValidator = [
  param("id").isUUID().withMessage("Invalid equipment id"),
  validate,
];

const resolveDepositValidator = [
  param("id").isUUID().withMessage("Invalid rental id"),
  body("resolution")
    .isIn(["refunded", "partial", "forfeited"])
    .withMessage("resolution must be 'refunded', 'partial', or 'forfeited'"),
  body("kept_amount")
    .optional({ values: "null" })
    .isFloat({ min: 0 })
    .toFloat(),
  body("notes")
    .optional({ values: "null" })
    .isString()
    .isLength({ max: 2000 }),
  validate,
];

module.exports = {
  createRentalValidator,
  rentalIdValidator,
  approveRejectValidator,
  listQueryValidator,
  availabilityValidator,
  bookedDatesValidator,
  resolveDepositValidator,
};
