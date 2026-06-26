const express = require("express");
const router = express.Router();

const auth = require("../middleware/auth");
const requireRole = require("../middleware/requireRole");
const ctrl = require("../controllers/rental.controller");
const {
  createRentalValidator,
  rentalIdValidator,
  approveRejectValidator,
  listQueryValidator,
  availabilityValidator,
  bookedDatesValidator,
  resolveDepositValidator,
} = require("../validators/rental.validator");

// Availability check — public (could be called by logged-out users browsing)
// Path is /equipment/:id/availability, so it's mounted on the equipment router;
// we still export it here and the caller composes it on the equipment side
// if desired. For simplicity, it's also exposed at /rentals/availability/:id.
router.get(
  "/availability/:id",
  availabilityValidator,
  ctrl.availability,
);

// Booked date ranges — public. Feeds the booking calendar so already-rented
// days can be marked off before the user picks a range.
router.get(
  "/booked-dates/:id",
  bookedDatesValidator,
  ctrl.bookedDates,
);

// Create — any authenticated user
router.post("/", auth, createRentalValidator, ctrl.create);

// List
router.get("/", auth, listQueryValidator, ctrl.list);

// Single
router.get("/:id", auth, rentalIdValidator, ctrl.getOne);

// Owner-only actions: approve / reject
router.post(
  "/:id/approve",
  auth,
  requireRole("owner", "admin"),
  approveRejectValidator,
  ctrl.approve,
);
router.post(
  "/:id/reject",
  auth,
  requireRole("owner", "admin"),
  approveRejectValidator,
  ctrl.reject,
);

// Cancel — renter OR owner can do this (controller enforces)
router.post("/:id/cancel", auth, rentalIdValidator, ctrl.cancel);

// Lifecycle transitions
router.post("/:id/start", auth, rentalIdValidator, ctrl.start);
router.post("/:id/complete", auth, rentalIdValidator, ctrl.complete);

// Deposit resolution — owner (or admin) settles the held security deposit
// after a completed rental. The renter learns about the outcome via a
// notification fired from the controller.
router.post(
  "/:id/deposit/resolve",
  auth,
  requireRole("owner", "admin"),
  resolveDepositValidator,
  ctrl.resolveDeposit,
);

module.exports = router;
