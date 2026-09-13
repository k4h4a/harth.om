const knex = require("../db");

const PUBLIC_FIELDS = [
  "id",
  "sender_id",
  "recipient_id",
  "body",
  "attachment_url",
  "is_read",
  "read_at",
  "created_at",
];

/**
 * Canonicalize a pair of user ids into (pair_a, pair_b) with pair_a < pair_b.
 * Matches the CHECK constraint in the migration.
 */
function pair(a, b) {
  return a < b ? { pair_a: a, pair_b: b } : { pair_a: b, pair_b: a };
}

/**
 * Send a direct message. Returns the inserted row.
 * Throws AppError conditions bubble via CHECK constraints (empty body, self-send).
 */
async function send({ senderId, recipientId, body, attachmentUrl = null }) {
  const p = pair(senderId, recipientId);
  const [row] = await knex("messages")
    .insert({
      sender_id: senderId,
      recipient_id: recipientId,
      body: body.trim(),
      attachment_url: attachmentUrl,
      ...p,
    })
    .returning(PUBLIC_FIELDS);
  return row;
}

/**
 * Get the message history between two users, paginated (newest first).
 */
async function getConversation(
  userAId,
  userBId,
  { page = 1, limit = 50 } = {},
) {
  const safeLimit = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));
  const safePage = Math.max(1, parseInt(page, 10) || 1);
  const offset = (safePage - 1) * safeLimit;
  const p = pair(userAId, userBId);

  const dataQ = knex("messages")
    .where({ pair_a: p.pair_a, pair_b: p.pair_b })
    .select(PUBLIC_FIELDS)
    .orderBy("created_at", "desc")
    .limit(safeLimit)
    .offset(offset);

  const countQ = knex("messages")
    .where({ pair_a: p.pair_a, pair_b: p.pair_b })
    .count("* as c")
    .first();

  const [items, countRow] = await Promise.all([dataQ, countQ]);
  const total = parseInt(countRow.c, 10);

  return {
    items,
    pagination: {
      page: safePage,
      limit: safeLimit,
      total,
      pages: Math.ceil(total / safeLimit) || 1,
    },
  };
}

/**
 * List all recent conversations for a user, one row per peer with the
 * latest message. Useful for an "inbox" view.
 *
 * We emulate DISTINCT ON by doing it in two steps:
 *   1. Latest message id per pair.
 *   2. Join back to fetch full data + the peer's user info.
 */
async function listConversations(userId, { limit = 50 } = {}) {
  const safeLimit = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));

  // Find the latest message id per conversation the user is in.
  const latest = await knex("messages")
    .where({ pair_a: userId })
    .orWhere({ pair_b: userId })
    .select(
      "pair_a",
      "pair_b",
      knex.raw("max(created_at) as last_at"),
      knex.raw("max(id::text) as last_id"),
    )
    .groupBy("pair_a", "pair_b")
    .orderBy("last_at", "desc")
    .limit(safeLimit);

  if (!latest.length) return [];

  const ids = latest.map((r) => r.last_id);
  const messages = await knex("messages").whereIn("id", ids).select(PUBLIC_FIELDS);
  const byId = new Map(messages.map((m) => [m.id, m]));

  // Figure out the peer for each conversation + unread counts in one go.
  const conversations = [];
  for (const r of latest) {
    const peerId = r.pair_a === userId ? r.pair_b : r.pair_a;
    const lastMsg = byId.get(r.last_id);
    if (!lastMsg) continue;

    const unreadRow = await knex("messages")
      .where({ pair_a: r.pair_a, pair_b: r.pair_b, recipient_id: userId, is_read: false })
      .count("* as c")
      .first();
    const peer = await knex("users")
      .where({ id: peerId })
      .first("id", "name", "email");

    conversations.push({
      peer,
      last_message: lastMsg,
      unread_count: parseInt(unreadRow.c, 10),
    });
  }

  return conversations;
}

/**
 * Mark every message in a conversation as read (for the caller-recipient).
 * Returns the array of message ids newly marked.
 */
async function markConversationRead({ readerId, peerId }) {
  const p = pair(readerId, peerId);
  const updated = await knex("messages")
    .where({ pair_a: p.pair_a, pair_b: p.pair_b, recipient_id: readerId, is_read: false })
    .update({ is_read: true, read_at: knex.fn.now() })
    .returning(["id", "sender_id"]);
  return updated;
}

async function unreadCount(userId) {
  const row = await knex("messages")
    .where({ recipient_id: userId, is_read: false })
    .count("* as c")
    .first();
  return parseInt(row.c, 10);
}

module.exports = {
  send,
  getConversation,
  listConversations,
  markConversationRead,
  unreadCount,
  PUBLIC_FIELDS,
};
