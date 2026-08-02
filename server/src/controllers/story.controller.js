const storyRepo = require("../repositories/story.repository");
const { AppError, asyncHandler } = require("../middleware/errorHandler");

/**
 * GET /stories
 * Public — anonymous users can browse the homepage stories strip.
 *
 * The endpoint always returns a small payload (≤30 authors × ≤8
 * stories), and we set a short cache-control so a CDN can hold it
 * for a minute. Stories change in 24-hour cycles so 60s is fine.
 */
const listLive = asyncHandler(async (_req, res) => {
  const groups = await storyRepo.listLiveGrouped({ authorLimit: 30 });
  res.set("Cache-Control", "public, max-age=60");
  res.json({ success: true, groups });
});

/**
 * GET /stories/by-author/:authorId
 * Public — all live stories from one author.
 */
const listByAuthor = asyncHandler(async (req, res) => {
  const items = await storyRepo.listLiveByAuthor(req.params.authorId);
  res.json({ success: true, items });
});

/**
 * POST /stories
 * Authenticated, owners + admins only (route-layer gate).
 * Body: { image_url, caption?, equipment_id? }
 */
const createStory = asyncHandler(async (req, res) => {
  const { image_url, caption = null, equipment_id = null } = req.body;
  if (!image_url) throw new AppError("image_url is required", 400);

  const story = await storyRepo.createStory({
    authorId: req.user.id,
    imageUrl: String(image_url).slice(0, 500),
    caption: caption ? String(caption).slice(0, 280) : null,
    equipmentId: equipment_id || null,
  });
  res.status(201).json({ success: true, story });
});

/**
 * DELETE /stories/:id
 * Author or admin.
 */
const deleteStory = asyncHandler(async (req, res) => {
  const ok = await storyRepo.deleteStory({
    storyId: req.params.id,
    callerId: req.user.id,
    isAdmin: !!req.user.is_admin,
  });
  if (!ok) throw new AppError("Story not found", 404);
  res.json({ success: true });
});

/**
 * POST /stories/:id/view
 * Mark a view. Both authenticated and anonymous viewers can call this.
 * For anonymous viewers, the client supplies an `x-anon-session` header
 * (any stable per-browser id); we use that to dedupe re-views.
 */
const recordView = asyncHandler(async (req, res) => {
  const viewerId = req.user ? req.user.id : null;
  const anonSession = viewerId
    ? null
    : (req.headers["x-anon-session"] || "").slice(0, 64) || null;

  // We need at least one identity for the unique-index dedupe.
  if (!viewerId && !anonSession) {
    // Silently no-op rather than 400 — the public feed shouldn't fail
    // because the client forgot to send a header. Just don't count.
    return res.json({ success: true, counted: false });
  }

  const result = await storyRepo.recordView({
    storyId: req.params.id,
    viewerId,
    anonSession,
  });
  res.json({ success: true, ...result });
});

/**
 * GET /stories/:id/viewers
 * Author or admin only — viewer list for one of their own stories.
 */
const listViewers = asyncHandler(async (req, res) => {
  const knex = require("../db");
  const story = await knex("stories")
    .where({ id: req.params.id })
    .first("author_id");
  if (!story) throw new AppError("Story not found", 404);
  const isAdmin = !!req.user.is_admin;
  if (!isAdmin && story.author_id !== req.user.id) {
    throw new AppError("Not allowed", 403);
  }
  const viewers = await storyRepo.listViewers(req.params.id);
  res.json({ success: true, viewers });
});

module.exports = {
  listLive,
  listByAuthor,
  createStory,
  deleteStory,
  recordView,
  listViewers,
};
