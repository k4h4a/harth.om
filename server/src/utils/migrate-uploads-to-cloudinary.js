/**
 * One-time migration: uploads every locally-stored file (server/uploads/)
 * referenced by the database to Cloudinary, then rewrites the DB columns
 * that hold `/uploads/<filename>` paths to point at the new Cloudinary URL.
 *
 * Why this exists: uploads used to be saved to local disk. Render's free
 * plan wipes local disk on every deploy/restart, so any equipment photo,
 * KYC document, avatar, etc. uploaded before switching to Cloudinary would
 * otherwise turn into a broken image after the first deploy. This script
 * backfills those existing references — it does not touch new uploads,
 * which already go straight to Cloudinary once CLOUDINARY_* env vars are set
 * (see src/middleware/upload.js).
 *
 * Safe to run more than once (already-migrated https:// URLs are skipped).
 * Never deletes rows or local files — only rewrites URL columns.
 *
 * Usage: node src/utils/migrate-uploads-to-cloudinary.js
 * Requires CLOUDINARY_CLOUD_NAME / CLOUDINARY_API_KEY / CLOUDINARY_API_SECRET
 * and a working DATABASE_URL (or DB_HOST/etc) to already be set — run it
 * against whichever database you want migrated (local first to verify, then
 * again after DATABASE_URL points at Neon — or migrate once locally and let
 * the pg_dump/pg_restore step in the deployment guide carry the new URLs
 * over to Neon for you).
 */

require("dotenv").config();
const fs = require("fs");
const path = require("path");

const env = require("../config/env");
const knex = require("../db");

if (!env.CLOUDINARY_CLOUD_NAME || !env.CLOUDINARY_API_KEY || !env.CLOUDINARY_API_SECRET) {
  console.error(
    "Fatal: CLOUDINARY_CLOUD_NAME / CLOUDINARY_API_KEY / CLOUDINARY_API_SECRET must all be set before running this script.",
  );
  process.exit(1);
}

const cloudinary = require("cloudinary").v2;
cloudinary.config({
  cloud_name: env.CLOUDINARY_CLOUD_NAME,
  api_key: env.CLOUDINARY_API_KEY,
  api_secret: env.CLOUDINARY_API_SECRET,
});

// filename (as it appears after /uploads/) -> new Cloudinary URL.
// Populated as we go so the same local file referenced from several rows
// (e.g. an equipment photo copied into an order snapshot) is only uploaded once.
const urlCache = new Map();
const stats = { uploaded: 0, reused: 0, missingFile: 0, rowsUpdated: 0 };

function isLocalUploadPath(value) {
  return typeof value === "string" && value.includes("/uploads/") && !/^https?:\/\//i.test(value);
}

function filenameFromPath(value) {
  return value.split("/uploads/").pop();
}

async function uploadLocalFile(filename) {
  if (urlCache.has(filename)) {
    stats.reused += 1;
    return urlCache.get(filename);
  }
  const localPath = path.join(env.UPLOAD_DIR, filename);
  if (!fs.existsSync(localPath)) {
    stats.missingFile += 1;
    console.warn(`  ! Local file not found, leaving reference unchanged: ${filename}`);
    return null;
  }
  const ext = path.extname(filename).toLowerCase();
  const resourceType = ext === ".pdf" ? "image" : "image"; // PDFs stored as viewable "image" resources too — see upload.js
  const result = await cloudinary.uploader.upload(localPath, {
    folder: "harth/uploads",
    resource_type: resourceType,
  });
  stats.uploaded += 1;
  urlCache.set(filename, result.secure_url);
  console.log(`  + uploaded ${filename} -> ${result.secure_url}`);
  return result.secure_url;
}

/** Migrate a single string column (e.g. users.avatar_url). */
async function migrateStringColumn(table, column) {
  const rows = await knex(table).select("id", column).whereNotNull(column);
  for (const row of rows) {
    const value = row[column];
    if (!isLocalUploadPath(value)) continue;
    const newUrl = await uploadLocalFile(filenameFromPath(value));
    if (!newUrl) continue;
    await knex(table).where({ id: row.id }).update({ [column]: newUrl });
    stats.rowsUpdated += 1;
  }
}

/** Migrate a jsonb array-of-URLs column (e.g. equipment.images). */
async function migrateArrayColumn(table, column) {
  const rows = await knex(table).select("id", column).whereNotNull(column);
  for (const row of rows) {
    const arr = row[column];
    if (!Array.isArray(arr) || arr.length === 0) continue;
    let changed = false;
    const next = [];
    for (const value of arr) {
      if (isLocalUploadPath(value)) {
        const newUrl = await uploadLocalFile(filenameFromPath(value));
        if (newUrl) {
          next.push(newUrl);
          changed = true;
          continue;
        }
      }
      next.push(value);
    }
    if (changed) {
      await knex(table).where({ id: row.id }).update({ [column]: JSON.stringify(next) });
      stats.rowsUpdated += 1;
    }
  }
}

async function main() {
  console.log(`Reading local uploads from: ${env.UPLOAD_DIR}`);
  console.log("Migrating string columns...");
  await migrateStringColumn("users", "avatar_url");
  await migrateStringColumn("users", "id_front_url");
  await migrateStringColumn("users", "id_back_url");
  await migrateStringColumn("users", "selfie_url");
  await migrateStringColumn("user_profiles", "avatar_url");
  await migrateStringColumn("equipment", "primary_image_url");
  await migrateStringColumn("order_items", "equipment_image_snapshot");
  await migrateStringColumn("hero_banners", "image_url");
  await migrateStringColumn("stories", "image_url");

  console.log("Migrating array columns...");
  await migrateArrayColumn("equipment", "images");
  await migrateArrayColumn("delivery_requests", "pickup_proof_images");
  await migrateArrayColumn("delivery_requests", "delivery_proof_images");

  console.log("\nDone.");
  console.log(
    `  Files uploaded to Cloudinary: ${stats.uploaded}\n` +
      `  Reused (already uploaded this run): ${stats.reused}\n` +
      `  Rows updated: ${stats.rowsUpdated}\n` +
      `  Local files referenced but not found on disk: ${stats.missingFile}`,
  );
  await knex.destroy();
}

main().catch(async (err) => {
  console.error("Migration failed:", err);
  await knex.destroy();
  process.exit(1);
});
