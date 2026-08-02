const express = require("express");
const router = express.Router();

const auth = require("../middleware/auth");
const ctrl = require("../controllers/cart.controller");
const {
  addItemValidator,
  updateItemValidator,
  cartItemIdValidator,
} = require("../validators/cart.validator");

// All cart routes require authentication. Every account can have a cart
// (even a user who lists equipment may buy from another lister).

router.get("/", auth, ctrl.get);
router.post("/items", auth, addItemValidator, ctrl.addItem);
router.patch("/items/:id", auth, updateItemValidator, ctrl.updateItem);
router.delete("/items/:id", auth, cartItemIdValidator, ctrl.removeItem);
router.delete("/", auth, ctrl.clear);

module.exports = router;
