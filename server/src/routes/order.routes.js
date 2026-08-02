const express = require("express");
const router = express.Router();

const auth = require("../middleware/auth");
const requireAdmin = require("../middleware/requireAdmin");
const ctrl = require("../controllers/order.controller");
const invoiceCtrl = require("../controllers/invoice.controller");
const {
  createOrderValidator,
  orderIdValidator,
  trackingValidator,
  listQueryValidator,
} = require("../validators/order.validator");

// Public tracking — anyone with the number can check status.
router.get("/track/:tracking", trackingValidator, ctrl.track);

// Admin-only list must come before `/:id` to avoid param capture.
router.get("/all", auth, requireAdmin, listQueryValidator, ctrl.listAll);

// Caller's own orders
router.get("/mine", auth, listQueryValidator, ctrl.listMine);

// Create order
router.post("/", auth, createOrderValidator, ctrl.create);

// Single order (caller's own — admin uses /all)
router.get("/:id", auth, orderIdValidator, ctrl.getOne);

// Invoice PDF — owner of the order OR admin. The '.pdf' suffix in the path
// is cosmetic (it's served inline); auth is handled inside the controller.
router.get("/:id/invoice.pdf", auth, orderIdValidator, invoiceCtrl.orderInvoice);

module.exports = router;
