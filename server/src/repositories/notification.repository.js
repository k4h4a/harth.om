const knex = require("../db");

const PUBLIC_FIELDS = [
  "id",
  "user_id",
  "type",
  "channel",
  "title",
  "message",
  "metadata",
  "sent",
  "sent_at",
  "send_error",
  "is_read",
  "read_at",
  "created_at",
];

/**
 * Insert a notification log row. One row per (user, channel, event) —
 * callers typically create one in_app row plus one email row plus one
 * whatsapp row for the same logical event.
 *
 * Returns the inserted row with its real ID.
 */
async function create({
  userId,
  type,
  channel,
  title,
  message,
  metadata = {},
  sent = false,
  sentAt = null,
  sendError = null,
}) {
  const [row] = await knex("notifications_log")
    .insert({
      user_id: userId,
      type,
      channel,
      title,
      message,
      metadata: JSON.stringify(metadata || {}),
      sent,
      sent_at: sentAt,
      send_error: sendError,
    })
    .returning(PUBLIC_FIELDS);
  return row;
}

/**
 * Update a previously-inserted log entry with delivery outcome.
 * Called by the notification service after the email/whatsapp provider
 * returns a result.
 */
async function markSendResult(id, { sent, sentAt = null, sendError = null }) {
  const patch = { sent };
  if (sentAt) patch.sent_at = sentAt;
  if (sendError) patch.send_error = sendError;
  const [row] = await knex("notifications_log")
    .where({ id })
    .update(patch)
    .returning(PUBLIC_FIELDS);
  return row;
}

/**
 * List in-app notifications for a user. We only surface in_app here —
 * email/whatsapp logs exist for debugging and aren't part of the user UI.
 */
async function listInApp(userId, { page = 1, limit = 20, unreadOnly = false } = {}) {
  const safeLimit = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
  const safePage = Math.max(1, parseInt(page, 10) || 1);
  const offset = (safePage - 1) * safeLimit;

  const dataQ = knex("notifications_log")
    .where({ user_id: userId, channel: "in_app" })
    .select(PUBLIC_FIELDS)
    .orderBy("created_at", "desc")
    .limit(safeLimit)
    .offset(offset);

  const countQ = knex("notifications_log")
    .where({ user_id: userId, channel: "in_app" })
    .count("* as c")
    .first();

  const unreadQ = knex("notifications_log")
    .where({ user_id: userId, channel: "in_app", is_read: false })
    .count("* as c")
    .first();

  if (unreadOnly) {
    dataQ.andWhere({ is_read: false });
    countQ.andWhere({ is_read: false });
  }

  const [items, countRow, unreadRow] = await Promise.all([dataQ, countQ, unreadQ]);
  const total = parseInt(countRow.c, 10);
  const unread = parseInt(unreadRow.c, 10);

  return {
    items,
    unread_count: unread,
    pagination: {
      page: safePage,
      limit: safeLimit,
      total,
      pages: Math.ceil(total / safeLimit) || 1,
    },
  };
}

async function unreadCount(userId) {
  const row = await knex("notifications_log")
    .where({ user_id: userId, channel: "in_app", is_read: false })
    .count("* as c")
    .first();
  return parseInt(row.c, 10);
}

/**
 * Mark a single notification as read. Returns updated row or null if not found
 * or not owned by the user.
 */
async function markRead(id, userId) {
  const [row] = await knex("notifications_log")
    .where({ id, user_id: userId })
    .andWhere("is_read", false)
    .update({ is_read: true, read_at: knex.fn.now() })
    .returning(PUBLIC_FIELDS);
  return row || null;
}

async function markAllRead(userId) {
  const count = await knex("notifications_log")
    .where({ user_id: userId, channel: "in_app", is_read: false })
    .update({ is_read: true, read_at: knex.fn.now() });
  return count;
}

module.exports = {
  create,
  markSendResult,
  listInApp,
  unreadCount,
  markRead,
  markAllRead,
  PUBLIC_FIELDS,
};
