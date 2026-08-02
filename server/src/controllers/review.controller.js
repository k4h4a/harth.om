const reviewRepo = require("../repositories/review.repository");
const { AppError, asyncHandler } = require("../middleware/errorHandler");

/**
 * POST /reviews
 */
const create = asyncHandler(async (req, res) => {
  const { equipment_id, rating, comment = null } = req.body;
  const review = await reviewRepo.create({
    reviewerId: req.user.id,
    equipmentId: equipment_id,
    rating,
    comment,
  });
  res.status(201).json({ success: true, review });
});

/**
 * PATCH /reviews/:id — only the reviewer can update their own review.
 */
const update = asyncHandler(async (req, res) => {
  const { rating, comment } = req.body;
  const review = await reviewRepo.update({
    reviewId: req.params.id,
    reviewerId: req.user.id,
    rating,
    comment,
  });
  res.json({ success: true, review });
});

/**
 * DELETE /reviews/:id — reviewer or admin.
 */
const remove = asyncHandler(async (req, res) => {
  await reviewRepo.remove({
    reviewId: req.params.id,
    reviewerId: req.user.id,
    isAdmin: !!req.user.is_admin,
  });
  res.json({ success: true });
});

/**
 * GET /equipment/:equipmentId/reviews — public.
 */
const listForEquipment = asyncHandler(async (req, res) => {
  const { page, limit } = req.query;
  const result = await reviewRepo.listForEquipment(req.params.equipmentId, {
    page,
    limit,
  });
  res.json({ success: true, ...result });
});

/**
 * GET /reviews/can-review/:equipmentId — helper so UI can show/hide
 * the "write review" CTA without trying and failing.
 */
const canReview = asyncHandler(async (req, res) => {
  const eligible = await reviewRepo.findEligibleSource(
    req.user.id,
    req.params.equipmentId,
  );
  res.json({
    success: true,
    eligible: !!eligible,
    source: eligible || null,
  });
});

module.exports = { create, update, remove, listForEquipment, canReview };
