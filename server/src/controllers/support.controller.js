const knex = require("../db");
const repo = require("../repositories/support.repository");
const { AppError, asyncHandler } = require("../middleware/errorHandler");

const VALID_CATEGORIES = ["technical", "financial", "account", "orders", "suggestion", "complaint"];
const VALID_PRIORITIES = ["low", "medium", "high", "urgent"];
const VALID_STATUSES   = ["open", "in_progress", "resolved", "closed"];

// POST /support/tickets
const createTicket = asyncHandler(async (req, res) => {
  const { category, priority = "medium", subject, body, attachments, guest_name, guest_email } = req.body;

  if (!VALID_CATEGORIES.includes(category)) throw new AppError("Invalid category", 400);
  if (!VALID_PRIORITIES.includes(priority))  throw new AppError("Invalid priority", 400);
  if (!subject?.trim()) throw new AppError("Subject is required", 400);
  if (!body?.trim())    throw new AppError("Message body is required", 400);

  const userId = req.user?.id || null;
  if (!userId && !guest_email) throw new AppError("Email is required for guest tickets", 400);

  const ticket = await repo.createTicket({
    userId,
    guestName: guest_name,
    guestEmail: guest_email,
    category,
    priority,
    subject: subject.trim(),
    body: body.trim(),
    attachments: Array.isArray(attachments) ? attachments : [],
  });

  res.status(201).json({ success: true, ticket });
});

// GET /support/tickets/mine
const getMyTickets = asyncHandler(async (req, res) => {
  if (!req.user) throw new AppError("Authentication required", 401);
  const { status, page = 1, limit = 20 } = req.query;
  if (status && !VALID_STATUSES.includes(status)) throw new AppError("Invalid status", 400);

  const [tickets, total] = await Promise.all([
    repo.getMyTickets(req.user.id, { status, page: Number(page), limit: Number(limit) }),
    repo.countMyTickets(req.user.id, status),
  ]);
  res.json({ success: true, tickets, total });
});

// GET /support/tickets/:id
const getTicket = asyncHandler(async (req, res) => {
  const ticket = await repo.getTicketById(req.params.id);
  if (!ticket) throw new AppError("Ticket not found", 404);

  // Ownership: owner or admin
  const isAdmin = !!req.user?.is_admin;
  const isOwner = req.user?.id && ticket.user_id === req.user.id;
  if (!isAdmin && !isOwner) throw new AppError("Forbidden", 403);

  const messages = await repo.getTicketMessages(ticket.id);
  res.json({ success: true, ticket: { ...ticket, messages } });
});

// POST /support/tickets/:id/messages
const replyTicket = asyncHandler(async (req, res) => {
  const ticket = await repo.getTicketById(req.params.id);
  if (!ticket) throw new AppError("Ticket not found", 404);
  if (["closed"].includes(ticket.status)) throw new AppError("This ticket is closed. Please reopen it first.", 400);

  const isAdmin = !!req.user?.is_admin;
  const isOwner = req.user?.id && ticket.user_id === req.user.id;
  if (!isAdmin && !isOwner) throw new AppError("Forbidden", 403);

  const { body, attachments } = req.body;
  if (!body?.trim()) throw new AppError("Message is required", 400);

  const senderType = isAdmin ? "agent" : "user";
  const msg = await repo.addMessage({
    ticketId: ticket.id,
    senderId: req.user?.id,
    senderType,
    body: body.trim(),
    attachments: Array.isArray(attachments) ? attachments : [],
  });
  res.status(201).json({ success: true, message: msg });
});

// POST /support/tickets/:id/reopen
const reopenTicket = asyncHandler(async (req, res) => {
  const ticket = await repo.getTicketById(req.params.id);
  if (!ticket) throw new AppError("Ticket not found", 404);
  if (ticket.user_id !== req.user.id) throw new AppError("Forbidden", 403);
  if (!["resolved", "closed"].includes(ticket.status)) throw new AppError("Only resolved/closed tickets can be reopened", 400);

  const updated = await repo.updateStatus(ticket.id, "open");
  await repo.addMessage({ ticketId: ticket.id, senderId: req.user.id, senderType: "system", body: "تم إعادة فتح التذكرة من قبل المستخدم." });
  res.json({ success: true, ticket: updated });
});

// POST /support/tickets/:id/rate
const rateTicket = asyncHandler(async (req, res) => {
  const { score, comment } = req.body;
  if (!score || score < 1 || score > 5) throw new AppError("Score must be 1–5", 400);

  const ticket = await repo.getTicketById(req.params.id);
  if (!ticket) throw new AppError("Ticket not found", 404);
  if (ticket.user_id !== req.user.id) throw new AppError("Forbidden", 403);
  if (!["resolved", "closed"].includes(ticket.status)) throw new AppError("Can only rate resolved tickets", 400);

  const updated = await repo.rateTicket(req.params.id, req.user.id, { score: Number(score), comment });
  res.json({ success: true, ticket: updated });
});

// ── Admin endpoints ─────────────────────────────────────────────────────────

// GET /support/admin/tickets
const adminListTickets = asyncHandler(async (req, res) => {
  if (!req.user.is_admin) throw new AppError("Forbidden", 403);
  const { status, category, priority, page = 1, limit = 30 } = req.query;
  console.log("[adminListTickets] START", { status, category, priority, page, limit });
  const tickets = await repo.getAllTickets({ status, category, priority, page: Number(page), limit: Number(limit) });
  console.log("[adminListTickets] DONE, count=", Array.isArray(tickets) ? tickets.length : typeof tickets);
  res.json({ success: true, tickets });
});

// GET /support/admin/stats
const adminStats = asyncHandler(async (req, res) => {
  if (!req.user.is_admin) throw new AppError("Forbidden", 403);
  const stats = await repo.getStats();
  res.json({ success: true, stats });
});

// PATCH /support/admin/tickets/:id/status
const adminUpdateStatus = asyncHandler(async (req, res) => {
  if (!req.user.is_admin) throw new AppError("Forbidden", 403);
  const { status } = req.body;
  if (!VALID_STATUSES.includes(status)) throw new AppError("Invalid status", 400);
  const ticket = await repo.updateStatus(req.params.id, status);
  if (!ticket) throw new AppError("Ticket not found", 404);
  res.json({ success: true, ticket });
});

// PATCH /support/admin/tickets/:id/assign
const adminAssign = asyncHandler(async (req, res) => {
  if (!req.user.is_admin) throw new AppError("Forbidden", 403);
  const { agent_id } = req.body;
  if (!agent_id) throw new AppError("agent_id is required", 400);
  const ticket = await repo.assignTicket(req.params.id, agent_id);
  if (!ticket) throw new AppError("Ticket not found", 404);
  res.json({ success: true, ticket });
});

module.exports = { createTicket, getMyTickets, getTicket, replyTicket, reopenTicket, rateTicket, adminListTickets, adminStats, adminUpdateStatus, adminAssign };
