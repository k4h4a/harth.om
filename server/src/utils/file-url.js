const env = require("../config/env");

/**
 * Resolve the public URL for an uploaded file, regardless of which storage
 * backend handled it. Cloudinary storage sets `file.path` to the final
 * https:// URL already; local diskStorage sets `file.path` to a filesystem
 * path, so we build the `/uploads/<filename>` URL served by app.js instead.
 */
function resolveFileUrl(file) {
  if (file.path && /^https?:\/\//i.test(file.path)) return file.path;
  const base = env.PUBLIC_BASE_URL
    ? env.PUBLIC_BASE_URL.replace(/\/+$/, "")
    : "";
  return `${base}/uploads/${file.filename}`;
}

module.exports = { resolveFileUrl };
