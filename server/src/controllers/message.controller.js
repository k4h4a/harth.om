const knex = require("../db");
const messageRepo = require("../repositories/message.repository");
const notificationService = require("../services/notification.service");
const { AppError, asyncHandler } = require("../middleware/errorHandler");

/**
 * POST /messages
 * Send a direct message. Recipients pick it up via GET /messages/with/:peerId.
 */
const send = asyncHandler(async (req, res) => {
  const { recipient_id, body, attachment_url = null } = req.body;

  if (recipient_id === req.user.id) {
    throw new AppError("Cannot message yourself", 400);
  }

  // Verify the recipient exists & is active. Without this we'd just insert
  // a row that nobody could read.
  const recipient = await knex("users")
    .where({ id: recipient_id, is_active: true })
    .first("id", "name");
  if (!recipient) throw new AppError("Recipient not found", 404);

  const message = await messageRepo.send({
    senderId: req.user.id,
    recipientId: recipient_id,
    body,
    attachmentUrl: attachment_url,
  });

  // Also create an in-app notification for the recipient so it shows up in
  // the bell even if they don't have chat open right now.
  const preview = message.body.length > 80
    ? message.body.slice(0, 77) + "..."
    : message.body;
  // Fire-and-forget — don't block the response on it.
  notificationService.events
    .newMessage(recipient_id, req.user.id, req.user.name || "مستخدم", preview)
    .catch((e) => {
      // eslint-disable-next-line no-console
      console.error("[message notify failed]", e.message);
    });

  res.status(201).json({ success: true, message });
});

/**
 * GET /messages/conversations
 * Inbox-style list of the caller's conversations.
 */
const listConversations = asyncHandler(async (req, res) => {
  const conversations = await messageRepo.listConversations(req.user.id, {
    limit: req.query.limit,
  });
  res.json({ success: true, conversations });
});

/**
 * GET /messages/with/:peerId
 * Full history with one peer, paginated.
 */
const getConversation = asyncHandler(async (req, res) => {
  const { page, limit } = req.query;
  const result = await messageRepo.getConversation(req.user.id, req.params.peerId, {
    page,
    limit,
  });
  res.json({ success: true, ...result });
});

/**
 * POST /messages/with/:peerId/read
 * Mark all messages from this peer as read.
 */
const markRead = asyncHandler(async (req, res) => {
  const updated = await messageRepo.markConversationRead({
    readerId: req.user.id,
    peerId: req.params.peerId,
  });

  res.json({ success: true, marked: updated.length });
});

const unreadCount = asyncHandler(async (req, res) => {
  const count = await messageRepo.unreadCount(req.user.id);
  res.json({ success: true, unread_count: count });
});

module.exports = {
  send,
  listConversations,
  getConversation,
  markRead,
  unreadCount,
};
