const express = require("express");
const router = express.Router();

const auth = require("../middleware/auth");
const ctrl = require("../controllers/delivery.controller");
const {
  createDeliveryValidator,
  deliveryIdValidator,
  transitionValidator,
  listQueryValidator,
} = require("../validators/delivery.validator");

// Anyone authenticated can list deliveries they have a role in (scope-filtered)
router.get("/", auth, listQueryValidator, ctrl.list);

// Create a delivery request — party to the rental/order
router.post("/", auth, createDeliveryValidator, ctrl.create);

// Single delivery
router.get("/:id", auth, deliveryIdValidator, ctrl.getOne);

// Courier state transitions. Any authenticated user may accept an unclaimed
// job; the repository's atomic `WHERE courier_id IS NULL` update enforces
// first-come-first-served. Subsequent transitions require the caller to be
// the assigned courier_id — enforced at the repository/controller level.
router.post("/:id/accept", auth, deliveryIdValidator, ctrl.accept);
router.post("/:id/pickup", auth, transitionValidator, ctrl.pickup);
router.post("/:id/in-transit", auth, transitionValidator, ctrl.inTransit);
router.post("/:id/delivered", auth, transitionValidator, ctrl.markDelivered);
router.post("/:id/cancel", auth, transitionValidator, ctrl.cancel);

module.exports = router;
