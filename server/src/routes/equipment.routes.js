const express = require("express");
const router = express.Router();

const ctrl = require("../controllers/equipment.controller");
const auth = require("../middleware/auth");
const {
  createEquipmentValidator,
  updateEquipmentValidator,
  idParamValidator,
  listQueryValidator,
} = require("../validators/equipment.validator");

// Public (optionalAuth so admins see pending items too)
router.get("/", auth.optionalAuth, listQueryValidator, ctrl.list);

// MUST come before '/:id' so Express doesn't treat 'mine' as an id
router.get("/mine", auth, ctrl.listMine);

// Public detail (optionalAuth so the owner/admin can see the commission
// breakdown; everyone else still only sees the final price).
router.get("/:id", auth.optionalAuth, idParamValidator, ctrl.getOne);

// Create — any authenticated user can list equipment.
router.post("/", auth, createEquipmentValidator, ctrl.create);

// Update / Delete (ownership checked inside the controller).
router.patch("/:id", auth, updateEquipmentValidator, ctrl.update);
router.delete("/:id", auth, idParamValidator, ctrl.remove);

module.exports = router;
