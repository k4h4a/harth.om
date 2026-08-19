const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const multer = require("multer");
const env = require("../config/env");
const { AppError } = require("./errorHandler");

// Whitelist actual image types we accept. We check the declared MIME AND the
// extension — a stricter check would sniff magic bytes, but that requires
// buffering the file first.
const ALLOWED_MIME = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);
const ALLOWED_EXT = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif"]);

const ALLOWED_MIME_PDF = new Set(["application/pdf"]);
const ALLOWED_EXT_PDF  = new Set([".pdf"]);

// Cloudinary is used when fully configured — this gives persistent storage,
// which local disk cannot on Render's free plan (filesystem resets on every
// deploy/restart). Falls back to local disk otherwise (e.g. local dev
// without Cloudinary credentials), so nothing breaks for developers who
// haven't set up a Cloudinary account.
const useCloudinary = Boolean(
  env.CLOUDINARY_CLOUD_NAME && env.CLOUDINARY_API_KEY && env.CLOUDINARY_API_SECRET,
);

/**
 * Minimal multer StorageEngine that streams the upload straight to
 * Cloudinary instead of disk. Exposes `path` as the resulting secure URL
 * (mirroring diskStorage's convention of exposing the saved location on
 * `file.path`) and `filename` as the Cloudinary public_id (needed to delete
 * the asset later, and kept analogous to diskStorage's `file.filename`).
 */
class CloudinaryStorage {
  constructor({ resourceType, folder }) {
    this.resourceType = resourceType;
    this.folder = folder;
    // Configure lazily (once) — avoids a top-level dependency on env vars
    // being set at require-time, and avoids configuring cloudinary at all
    // when it's not actually going to be used.
    this._cloudinary = require("cloudinary").v2;
    this._cloudinary.config({
      cloud_name: env.CLOUDINARY_CLOUD_NAME,
      api_key: env.CLOUDINARY_API_KEY,
      api_secret: env.CLOUDINARY_API_SECRET,
    });
  }

  _handleFile(_req, file, cb) {
    const uploadStream = this._cloudinary.uploader.upload_stream(
      { folder: this.folder, resource_type: this.resourceType },
      (err, result) => {
        if (err) return cb(err);
        cb(null, {
          path: result.secure_url,
          filename: result.public_id,
          size: result.bytes,
        });
      },
    );
    file.stream.pipe(uploadStream);
  }

  _removeFile(_req, file, cb) {
    this._cloudinary.uploader.destroy(
      file.filename,
      { resource_type: this.resourceType },
      (err) => cb(err),
    );
  }
}

function diskStorage() {
  // Ensure the upload directory exists on boot. Synchronous is fine — it runs once.
  if (!fs.existsSync(env.UPLOAD_DIR)) {
    fs.mkdirSync(env.UPLOAD_DIR, { recursive: true });
  }
  return multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, env.UPLOAD_DIR),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      // 16 bytes of random = 32 hex chars. Collision-free for our purposes.
      const id = crypto.randomBytes(16).toString("hex");
      cb(null, `${Date.now()}-${id}${ext}`);
    },
  });
}

const imageStorage = useCloudinary
  ? new CloudinaryStorage({ resourceType: "image", folder: "harth/uploads" })
  : diskStorage();

// Cloudinary needs "image" resource type for PDFs to be viewable/transformable
// (raw-type assets are served but not previewable). Falls back to the same
// disk storage as images when Cloudinary isn't configured.
const pdfStorage = useCloudinary
  ? new CloudinaryStorage({ resourceType: "image", folder: "harth/pdfs" })
  : diskStorage();

function fileFilter(_req, file, cb) {
  const ext = path.extname(file.originalname).toLowerCase();
  if (!ALLOWED_MIME.has(file.mimetype) || !ALLOWED_EXT.has(ext)) {
    return cb(new AppError("Unsupported file type", 400));
  }
  cb(null, true);
}

const upload = multer({
  storage: imageStorage,
  fileFilter,
  limits: {
    fileSize: env.UPLOAD_MAX_BYTES,
    files: 10,
  },
});

function fileFilterPDF(_req, file, cb) {
  const ext = path.extname(file.originalname).toLowerCase();
  if (!ALLOWED_MIME_PDF.has(file.mimetype) || !ALLOWED_EXT_PDF.has(ext)) {
    return cb(new AppError("Only PDF files are accepted", 400));
  }
  cb(null, true);
}

const uploadPDF = multer({
  storage: pdfStorage,
  fileFilter: fileFilterPDF,
  limits: {
    fileSize: 20 * 1024 * 1024, // 20 MB cap for datasheets
    files: 1,
  },
});

/**
 * Wrap multer so its errors come through our AppError pipeline as 400s
 * instead of 500s.
 */
function wrap(mw) {
  return (req, res, next) => {
    mw(req, res, (err) => {
      if (!err) return next();
      if (err instanceof multer.MulterError) {
        return next(new AppError(`Upload error: ${err.message}`, 400));
      }
      return next(err);
    });
  };
}

module.exports = {
  single:    (field)       => wrap(upload.single(field)),
  array:     (field, max)  => wrap(upload.array(field, max ?? 10)),
  singlePdf: (field)       => wrap(uploadPDF.single(field)),
  usingCloudinary: useCloudinary,
};
