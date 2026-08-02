const express = require("express");
const router = express.Router();

const auth = require("../middleware/auth");
const { optionalAuth } = require("../middleware/auth");
const ctrl = require("../controllers/story.controller");
const {
  createStoryValidator,
  storyIdValidator,
  authorIdValidator,
} = require("../validators/story.validator");

// ─── Public reads ──────────────────────────────────────────────────
// Anonymous-friendly. The homepage strip works for logged-out browsers.
router.get("/", ctrl.listLive);
router.get("/by-author/:authorId", authorIdValidator, ctrl.listByAuthor);

// View tracking accepts both authenticated and anonymous calls. We use
// optionalAuth so authenticated views are deduped per-user, anonymous
// ones per `x-anon-session` header.
router.post("/:id/view", optionalAuth, storyIdValidator, ctrl.recordView);

// ─── Authenticated writes ──────────────────────────────────────────
// Any authenticated user can publish a story.
router.post("/", auth, createStoryValidator, ctrl.createStory);
router.delete("/:id", auth, storyIdValidator, ctrl.deleteStory);

// Author-only viewer breakdown.
router.get("/:id/viewers", auth, storyIdValidator, ctrl.listViewers);

module.exports = router;
