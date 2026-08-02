const express = require("express");
const router = express.Router();

const auth = require("../middleware/auth");
const { query } = require("express-validator");
const { validate } = require("../validators/auth.validator");
const ctrl = require("../controllers/commission.controller");

router.get(
  "/mine",
  auth,
  [
    query("page").optional().isInt({ min: 1 }).toInt(),
    query("limit").optional().isInt({ min: 1, max: 100 }).toInt(),
    query("status").optional().isIn(["pending", "paid", "cancelled"]),
    validate,
  ],
  ctrl.listMine,
);

module.exports = router;
