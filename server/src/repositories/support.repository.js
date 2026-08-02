const knex = require("../db");

const SLA_HOURS = { low: 72, medium: 24, high: 8, urgent: 2 };

async function nextTicketNumber() {
  const row = await knex("support_tickets").count("id as c").first();
  const n = Number(row.c) + 1;
  const year = new Date().getFullYear();
  return `TKT-${year}-${String(n).padStart(5, "0")}`;
}

async function createTicket({ userId, guestName, guestEmail, category, priority, subject, body, attachments = [] }) {
  return knex.transaction(async (trx) => {
    const ticketNumber = await nextTicketNumber();
    const slaHours = SLA_HOURS[priority] || 24;
    const slaDueAt = new Date(Date.now() + slaHours * 3600 * 1000);

    const [ticket] = await trx("support_tickets")
      .insert({
        ticket_number: ticketNumber,
        user_id: userId || null,
        guest_name: guestName || null,
        guest_email: guestEmail || null,
        category,
        priority,
        subject,
        status: "open",
        sla_hours: slaHours,
        sla_due_at: slaDueAt,
      })
      .returning("*");

    await trx("support_messages").insert({
      ticket_id: ticket.id,
      sender_id: userId || null,
      sender_type: "user",
      body,
      attachments: JSON.stringify(attachments),
    });

    // Auto system message
    await trx("support_messages").insert({
      ticket_id: ticket.id,
      sender_id: null,
      sender_type: "system",
      body: `تم استلام تذكرتك رقم ${ticketNumber}. سيتواصل معك فريق الدعم خلال ${slaHours} ساعة.`,
      attachments: JSON.stringify([]),
    });

    return ticket;
  });
}

async function getMyTickets(userId, { status, page = 1, limit = 20 } = {}) {
  const q = knex("support_tickets")
    .where("user_id", userId)
    .orderBy("updated_at", "desc")
    .limit(limit)
    .offset((page - 1) * limit);
  if (status) q.where("status", status);
  return q;
}

async function countMyTickets(userId, status) {
  const q = knex("support_tickets").where("user_id", userId).count("id as c").first();
  if (status) q.where("status", status);
  const row = await q;
  return Number(row.c);
}

async function getTicketById(id) {
  return knex("support_tickets").where({ id }).first();
}

async function getTicketMessages(ticketId) {
  return knex("support_messages")
    .where({ ticket_id: ticketId, is_internal: false })
    .leftJoin("users", "users.id", "support_messages.sender_id")
    .select(
      "support_messages.id",
      "support_messages.sender_type",
      "support_messages.body",
      "support_messages.attachments",
      "support_messages.created_at",
      "users.name as sender_name"
    )
    .orderBy("support_messages.created_at", "asc");
}

async function addMessage({ ticketId, senderId, senderType, body, attachments = [] }) {
  return knex.transaction(async (trx) => {
    const [msg] = await trx("support_messages")
      .insert({
        ticket_id: ticketId,
        sender_id: senderId || null,
        sender_type: senderType,
        body,
        attachments: JSON.stringify(attachments),
      })
      .returning("*");

    const statusUpdate = { updated_at: knex.fn.now() };
    if (senderType === "agent") statusUpdate.status = "in_progress";
    await trx("support_tickets").where({ id: ticketId }).update(statusUpdate);

    return msg;
  });
}

async function updateStatus(id, status, extra = {}) {
  const update = { status, updated_at: knex.fn.now(), ...extra };
  if (status === "resolved") update.resolved_at = knex.fn.now();
  if (status === "closed") update.closed_at = knex.fn.now();
  const [ticket] = await knex("support_tickets").where({ id }).update(update).returning("*");
  return ticket;
}

async function rateTicket(id, userId, { score, comment }) {
  const [updated] = await knex("support_tickets")
    .where({ id, user_id: userId })
    .update({ csat_score: score, csat_comment: comment || null, status: "closed", closed_at: knex.fn.now(), updated_at: knex.fn.now() })
    .returning("*");
  return updated || null;
}

// ── Admin ──────────────────────────────────────────────────────────────────
async function getAllTickets({ status, category, priority, page = 1, limit = 30 } = {}) {
  const q = knex("support_tickets")
    .leftJoin("users as u", "u.id", "support_tickets.user_id")
    .leftJoin("users as a", "a.id", "support_tickets.assigned_to")
    .select(
      "support_tickets.*",
      "u.name as user_name",
      "u.email as user_email",
      "a.name as agent_name"
    )
    .orderBy("support_tickets.updated_at", "desc")
    .limit(limit)
    .offset((page - 1) * limit);
  if (status) q.where("support_tickets.status", status);
  if (category) q.where("support_tickets.category", category);
  if (priority) q.where("support_tickets.priority", priority);
  return q;
}

async function getStats() {
  const [totals] = await knex("support_tickets").select(
    knex.raw("count(*)::int as total"),
    knex.raw("count(*) filter (where status = 'open')::int as open_count"),
    knex.raw("count(*) filter (where status = 'in_progress')::int as in_progress_count"),
    knex.raw("count(*) filter (where status = 'resolved')::int as resolved_count"),
    knex.raw("count(*) filter (where status = 'closed')::int as closed_count"),
    knex.raw("count(*) filter (where sla_due_at < now() and status not in ('resolved','closed'))::int as overdue_count"),
    knex.raw("round(avg(csat_score) filter (where csat_score is not null), 1)::float as avg_csat")
  );

  const byCategory = await knex("support_tickets")
    .select("category")
    .count("id as c")
    .groupBy("category")
    .orderBy("c", "desc");

  const byPriority = await knex("support_tickets")
    .select("priority")
    .count("id as c")
    .groupBy("priority");

  return { ...totals, by_category: byCategory, by_priority: byPriority };
}

async function assignTicket(id, agentId) {
  const [ticket] = await knex("support_tickets")
    .where({ id })
    .update({ assigned_to: agentId, status: "in_progress", updated_at: knex.fn.now() })
    .returning("*");
  return ticket;
}

module.exports = {
  createTicket,
  getMyTickets,
  countMyTickets,
  getTicketById,
  getTicketMessages,
  addMessage,
  updateStatus,
  rateTicket,
  getAllTickets,
  getStats,
  assignTicket,
};
