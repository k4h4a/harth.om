const express = require("express");
const router = express.Router();

const auth = require("../middleware/auth");
const requireAdmin = require("../middleware/requireAdmin");
const ctrl = require("../controllers/loyalty.controller");
const { historyQueryValidator } = require("../validators/loyalty.validator");

router.get("/", auth, historyQueryValidator, ctrl.getMine);
// Tier introspection: per-user state + the static tier list. Both
// require auth so we don't have to think about anonymous behavior.
router.get("/me/tier", auth, ctrl.getMyTier);
router.get("/tiers", auth, ctrl.listTiers);
router.post("/sweep", auth, requireAdmin, ctrl.sweep);

module.exports = router;
