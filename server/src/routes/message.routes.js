const express = require("express");
const router = express.Router();

const auth = require("../middleware/auth");
const ctrl = require("../controllers/message.controller");
const {
  sendValidator,
  peerIdValidator,
  listQueryValidator,
} = require("../validators/message.validator");

router.get("/conversations", auth, listQueryValidator, ctrl.listConversations);
router.get("/unread-count", auth, ctrl.unreadCount);

router.post("/", auth, sendValidator, ctrl.send);

router.get("/with/:peerId", auth, peerIdValidator, listQueryValidator, ctrl.getConversation);
router.post("/with/:peerId/read", auth, peerIdValidator, ctrl.markRead);

module.exports = router;
