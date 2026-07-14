const express  = require("express");
const router   = express.Router();
const auth     = require("../middleware/auth");
const upload   = require("../middleware/upload");
const ctrl     = require("../controllers/profile.controller");

router.get   ("/me",              auth, ctrl.getMe);
router.put   ("/me",              auth, ctrl.updateMe);
router.post  ("/avatar",          auth, upload.single("image"), ctrl.uploadAvatar);
router.delete("/avatar",          auth, ctrl.removeAvatar);
router.post  ("/change-password", auth, ctrl.changePassword);
router.put   ("/preferences",     auth, ctrl.updatePreferences);
router.get   ("/sessions",        auth, ctrl.getSessions);
router.delete("/sessions",        auth, ctrl.revokeAllSessions);
router.delete("/sessions/:id",    auth, ctrl.revokeSession);
router.get   ("/activity",        auth, ctrl.getActivity);
router.post  ("/2fa/toggle",      auth, ctrl.toggle2FA);
router.post  ("/export-data",     auth, ctrl.exportData);
router.post  ("/deactivate",      auth, ctrl.deactivate);
router.delete("/",                auth, ctrl.deleteAccount);

module.exports = router;
