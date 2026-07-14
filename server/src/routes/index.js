const express = require("express");
const router = express.Router();
const knex = require("../db");
const { asyncHandler } = require("../middleware/errorHandler");

router.get(
  "/health",
  asyncHandler(async (_req, res) => {
    let db = "unknown";
    try {
      await knex.raw("select 1");
      db = "connected";
    } catch (_e) {
      db = "down";
    }
    res.json({
      status: "ok",
      db,
      uptime: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    });
  }),
);

router.use("/auth", require("./auth.routes"));
router.use("/public", require("./public.routes"));
router.use("/equipment", require("./equipment.routes"));
router.use("/uploads", require("./uploads.routes"));
router.use("/kyc", require("./kyc.routes"));
router.use("/cart", require("./cart.routes"));
router.use("/promos", require("./promo.routes"));
router.use("/orders", require("./order.routes"));
router.use("/rentals", require("./rental.routes"));
router.use("/deliveries", require("./delivery.routes"));
router.use("/notifications", require("./notification.routes"));
router.use("/messages", require("./message.routes"));
router.use("/reviews", require("./review.routes"));
router.use("/wishlist", require("./wishlist.routes"));
router.use("/loyalty", require("./loyalty.routes"));
router.use("/stories", require("./story.routes"));
router.use("/commissions", require("./commission.routes"));
router.use("/admin",   require("./admin.routes"));
router.use("/support", require("./support.routes"));
router.use("/profile", require("./profile.routes"));

// /payments/webhook is mounted in app.js with raw body parsing.

module.exports = router;
