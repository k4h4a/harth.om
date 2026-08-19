const { AppError, asyncHandler } = require("../middleware/errorHandler");
const { resolveFileUrl } = require("../utils/file-url");

/**
 * POST /uploads/image
 * Accepts a single image (field name: "image"). Returns the saved URL.
 */
const uploadSingle = asyncHandler(async (req, res) => {
  if (!req.file) throw new AppError("No file uploaded", 400);
  res.status(201).json({
    success: true,
    url: resolveFileUrl(req.file),
    filename: req.file.filename,
    size: req.file.size,
    mimetype: req.file.mimetype,
  });
});

/**
 * POST /uploads/images
 * Accepts up to 10 images (field name: "images"). Returns an array.
 */
const uploadMultiple = asyncHandler(async (req, res) => {
  if (!req.files || !req.files.length) {
    throw new AppError("No files uploaded", 400);
  }
  const files = req.files.map((f) => ({
    url: resolveFileUrl(f),
    filename: f.filename,
    size: f.size,
    mimetype: f.mimetype,
  }));
  res.status(201).json({ success: true, files });
});

/**
 * POST /uploads/pdf
 * Accepts a single PDF file (field name: "pdf"). Returns the saved URL.
 * Used by equipment owners to attach manufacturer datasheets / manuals.
 */
const uploadPdf = asyncHandler(async (req, res) => {
  if (!req.file) throw new AppError("No PDF file uploaded", 400);
  res.status(201).json({
    success: true,
    url: resolveFileUrl(req.file),
    filename: req.file.filename,
    size: req.file.size,
    mimetype: req.file.mimetype,
  });
});

module.exports = { uploadSingle, uploadMultiple, uploadPdf };
