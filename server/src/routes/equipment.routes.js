const express = require("express");
const router = express.Router();

const ctrl = require("../controllers/equipment.controller");
const auth = require("../middleware/auth");
const requireRole = require("../middleware/requireRole");
const requireApprovedAccount = require("../middleware/requireApprovedAccount");
const {
  createEquipmentValidator,
  updateEquipmentValidator,
  idParamValidator,
  listQueryValidator,
} = require("../validators/equipment.validator");

// Public (optionalAuth so admins see pending items too)
router.get("/", auth.optionalAuth, listQueryValidator, ctrl.list);

// Owner-only — MUST come before '/:id' so Express doesn't treat 'mine' as an id
router.get("/mine", auth, requireRole("owner", "admin"), ctrl.listMine);

// Public detail (optionalAuth so the owner/admin can see the commission
// breakdown; everyone else still only sees the final price).
router.get("/:id", auth.optionalAuth, idParamValidator, ctrl.getOne);

// Create (owner or admin) — owner must have an APPROVED account.
// Per spec: "لا يمكنه استخدام صلاحية البيع أو التأجير إلا بعد موافقة الأدمن".
router.post(
  "/",
  auth,
  requireRole("owner", "admin"),
  requireApprovedAccount,
  createEquipmentValidator,
  ctrl.create,
);

// Update / Delete (ownership checked inside the controller). Same approval
// gate — a farmer whose account got revoked shouldn't be able to keep
// tweaking listings.
router.patch(
  "/:id",
  auth,
  requireRole("owner", "admin"),
  requireApprovedAccount,
  updateEquipmentValidator,
  ctrl.update,
);
router.delete(
  "/:id",
  auth,
  requireRole("owner", "admin"),
  requireApprovedAccount,
  idParamValidator,
  ctrl.remove,
);

module.exports = router;
