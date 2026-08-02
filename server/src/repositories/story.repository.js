/**
 * Stories — ephemeral 24h posts from farmers.
 *
 * The hot read pattern is "what stories are LIVE right now, grouped by
 * farmer?" — that's what powers the strip at the top of the homepage.
 * `expires_at` is indexed and used in every public read.
 *
 * Writes (creating a story, marking a view) are simple inserts. The
 * `view_count` column on stories is a denormalized cache; we increment
 * it inside the same transaction that records the view, but only when
 * the unique partial index doesn't reject the insert (i.e. only on
 * brand-new views, not duplicates).
 */

const knex = require("../db");
const { AppError } = require("../middleware/errorHandler");

// 24 hours in ms.
const STORY_TTL_MS = 24 * 60 * 60 * 1000;

const PUBLIC_FIELDS = [
  "id",
  "author_id",
  "image_url",
  "caption",
  "equipment_id",
  "view_count",
  "expires_at",
  "created_at",
];

/**
 * Create a new story. Any authenticated user may post one.
 */
async function createStory({
  authorId,
  imageUrl,
  caption = null,
  equipmentId = null,
}) {
  // If equipment_id is provided, validate it belongs to the author —
  // we don't want a farmer spotlighting another farmer's listing.
  if (equipmentId) {
    const owns = await knex("equipment")
      .where({ id: equipmentId, owner_id: authorId })
      .first("id");
    if (!owns) {
      throw new AppError(
        "لا يمكنك ربط قصة بمعدة لا تملكها.",
        403,
      );
    }
  }

  const expiresAt = new Date(Date.now() + STORY_TTL_MS);

  const [row] = await knex("stories")
    .insert({
      author_id: authorId,
      image_url: imageUrl,
      caption,
      equipment_id: equipmentId,
      expires_at: expiresAt,
    })
    .returning(PUBLIC_FIELDS);

  return row;
}

/**
 * Delete a story (author or admin). Returns true if removed, false if
 * the row didn't exist or didn't belong to the caller.
 */
async function deleteStory({ storyId, callerId, isAdmin }) {
  const story = await knex("stories").where({ id: storyId }).first();
  if (!story) return false;

  if (!isAdmin && story.author_id !== callerId) {
    throw new AppError("Not allowed to delete this story", 403);
  }

  const count = await knex("stories").where({ id: storyId }).del();
  return count > 0;
}

/**
 * The homepage feed: live stories grouped by author. Returns one row
 * per author with a nested `stories[]` array of their currently-live
 * stories ordered oldest→newest (Instagram order).
 *
 * Limits:
 *   - max `authorLimit` distinct authors (default 30, the strip rarely
 *     shows more)
 *   - up to 8 stories per author
 *   - hides authors with zero live stories
 */
async function listLiveGrouped({ authorLimit = 30 } = {}) {
  // First grab the live stories with author info. We sort by author's
  // most-recent story descending so the FRESHEST farmers appear first.
  const stories = await knex("stories as s")
    .leftJoin("users as u", "u.id", "s.author_id")
    .where("s.expires_at", ">", knex.fn.now())
    .select(
      "s.id",
      "s.image_url",
      "s.caption",
      "s.equipment_id",
      "s.view_count",
      "s.expires_at",
      "s.created_at",
      "s.author_id",
      "u.name as author_name",
      "u.identity_verified as author_verified",
      "u.is_pro as author_is_pro",
    )
    .orderBy("s.created_at", "desc");

  if (!stories.length) return [];

  // Group by author and rank authors by most-recent story timestamp.
  const byAuthor = new Map();
  for (const s of stories) {
    if (!byAuthor.has(s.author_id)) {
      byAuthor.set(s.author_id, {
        author_id: s.author_id,
        author_name: s.author_name,
        author_verified: !!s.author_verified,
        author_is_pro: !!s.author_is_pro,
        latest_at: s.created_at,
        stories: [],
      });
    }
    const bucket = byAuthor.get(s.author_id);
    if (bucket.stories.length < 8) {
      bucket.stories.push({
        id: s.id,
        image_url: s.image_url,
        caption: s.caption,
        equipment_id: s.equipment_id,
        view_count: s.view_count,
        expires_at: s.expires_at,
        created_at: s.created_at,
      });
    }
  }

  // Convert to array, sort each author's stories ascending (oldest
  // first ≈ Instagram order), then return up to authorLimit authors.
  const out = [];
  for (const a of byAuthor.values()) {
    a.stories.sort(
      (x, y) => new Date(x.created_at) - new Date(y.created_at),
    );
    out.push(a);
  }
  out.sort((x, y) => new Date(y.latest_at) - new Date(x.latest_at));
  return out.slice(0, authorLimit);
}

/**
 * Live stories from one author — for the "view all from this farmer"
 * inline navigation in the story viewer.
 */
async function listLiveByAuthor(authorId) {
  return knex("stories")
    .where({ author_id: authorId })
    .andWhere("expires_at", ">", knex.fn.now())
    .orderBy("created_at", "asc")
    .select(PUBLIC_FIELDS);
}

/**
 * Mark a view. Idempotent — re-viewing increments nothing. Returns
 * `{ counted: true|false }` so the frontend knows whether to bump
 * its local cached count.
 */
async function recordView({ storyId, viewerId = null, anonSession = null }) {
  if (!viewerId && !anonSession) {
    throw new AppError("Either viewerId or anonSession is required", 400);
  }

  return knex.transaction(async (trx) => {
    // Make sure the story still exists and is live.
    const story = await trx("stories")
      .where({ id: storyId })
      .first("id", "expires_at");
    if (!story) throw new AppError("Story not found", 404);
    if (new Date(story.expires_at) <= new Date()) {
      // Expired — silently no-op (the story is about to vanish from
      // the public feed anyway).
      return { counted: false };
    }

    try {
      await trx("story_views").insert({
        story_id: storyId,
        viewer_id: viewerId,
        anon_session: anonSession,
      });
      // First-ever view from this viewer — bump the cache.
      await trx("stories")
        .where({ id: storyId })
        .increment("view_count", 1);
      return { counted: true };
    } catch (err) {
      if (err.code === "23505") {
        // Re-view from same viewer/session — partial unique index hit.
        // No-op for the cache.
        return { counted: false };
      }
      throw err;
    }
  });
}

/**
 * Author-only: list of viewers for a specific story (Instagram-style
 * "X people viewed this"). Public view count is always available;
 * the per-viewer breakdown is private to the author.
 */
async function listViewers(storyId, { limit = 100 } = {}) {
  const safeLimit = Math.min(500, Math.max(1, parseInt(limit, 10) || 100));
  return knex("story_views as v")
    .leftJoin("users as u", "u.id", "v.viewer_id")
    .where("v.story_id", storyId)
    .orderBy("v.created_at", "desc")
    .limit(safeLimit)
    .select(
      "v.id",
      "v.created_at",
      "v.viewer_id",
      "v.anon_session",
      "u.name as viewer_name",
    );
}

/**
 * Background sweep — physically delete stories whose expires_at has
 * passed. The public feed already filters live ones; this is purely
 * housekeeping so the table doesn't grow unbounded. Safe to run on a
 * cron schedule (e.g. hourly).
 */
async function purgeExpired() {
  const count = await knex("stories")
    .where("expires_at", "<", knex.raw("now() - interval '1 hour'"))
    .del();
  return { deleted: count };
}

module.exports = {
  STORY_TTL_MS,
  createStory,
  deleteStory,
  listLiveGrouped,
  listLiveByAuthor,
  recordView,
  listViewers,
  purgeExpired,
};
