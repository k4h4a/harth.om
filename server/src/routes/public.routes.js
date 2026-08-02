const express = require("express");
const router = express.Router();
const knex = require("../db");
const { asyncHandler } = require("../middleware/errorHandler");

/**
 * GET /api/v1/public/stats
 *
 * Public-facing platform metrics for the landing page. Returns only
 * non-sensitive aggregate numbers — never user-level data. Cached for
 * 5 minutes to keep the homepage fast even under load.
 *
 * Override values via env vars (useful when launching with little real
 * data, or to display marketing-friendly minimums):
 *   STATS_OVERRIDE_EQUIPMENT     — replaces equipment_available
 *   STATS_OVERRIDE_FARMERS       — replaces farmers_active
 *   STATS_OVERRIDE_ORDERS        — replaces orders_completed
 *   STATS_OVERRIDE_REGIONS       — replaces regions_served
 *   STATS_MIN_EQUIPMENT          — floor (use real value if higher)
 *   STATS_MIN_FARMERS            — floor
 *   STATS_MIN_ORDERS             — floor
 */

let cache = null;
let cacheExpiresAt = 0;
const CACHE_MS = 5 * 60 * 1000; // 5 minutes

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

async function computeStats() {
  // Run all aggregate queries in parallel for speed.
  const [equipRow, farmersRow, ordersRow, regionsRow] = await Promise.all([
    // Available, approved, in-stock equipment.
    knex("equipment")
      .where({ is_approved: true, is_hidden: false })
      .where("stock", ">", 0)
      .count("* as c")
      .first(),
    // "Active farmers" = distinct users with at least one live (approved,
    // visible) equipment listing. There's no seller/owner role anymore, so
    // this is activity-based rather than role-based.
    knex("equipment")
      .where({ approval_status: "approved" })
      .whereNot({ status: "hidden" })
      .countDistinct({ c: "owner_id" })
      .first(),
    // Completed (delivered / paid) orders.
    knex("orders")
      .whereIn("status", ["paid", "delivered", "completed"])
      .count("* as c")
      .first(),
    // Distinct governorates with at least one approved listing.
    knex("equipment")
      .where({ is_approved: true, is_hidden: false })
      .whereNotNull("location")
      .countDistinct({ c: knex.raw("location->>'governorate'") })
      .first(),
  ]);

  // Apply env-var overrides and floors. Override always wins; floor only
  // bumps the value up if the real number is below it.
  const override = {
    equipment: num(process.env.STATS_OVERRIDE_EQUIPMENT),
    farmers:   num(process.env.STATS_OVERRIDE_FARMERS),
    orders:    num(process.env.STATS_OVERRIDE_ORDERS),
    regions:   num(process.env.STATS_OVERRIDE_REGIONS),
  };
  const floor = {
    equipment: num(process.env.STATS_MIN_EQUIPMENT) ?? 0,
    farmers:   num(process.env.STATS_MIN_FARMERS)   ?? 0,
    orders:    num(process.env.STATS_MIN_ORDERS)    ?? 0,
  };

  const apply = (real, key) => {
    if (override[key] != null) return override[key];
    const f = floor[key] != null ? floor[key] : 0;
    return Math.max(Number(real) || 0, f);
  };

  return {
    equipment_available: apply(equipRow?.c, "equipment"),
    farmers_active:      apply(farmersRow?.c, "farmers"),
    orders_completed:    apply(ordersRow?.c, "orders"),
    // Regions served: the platform covers 11 Omani governorates total;
    // override is allowed but the floor is the count we actually serve.
    regions_served:      override.regions != null
      ? override.regions
      : Math.max(Number(regionsRow?.c) || 0, 0),
  };
}

router.get(
  "/stats",
  asyncHandler(async (_req, res) => {
    const now = Date.now();
    if (!cache || now > cacheExpiresAt) {
      try {
        cache = await computeStats();
        cacheExpiresAt = now + CACHE_MS;
      } catch (e) {
        // If DB is having a bad day, serve a graceful fallback rather
        // than 500ing the homepage. Use env-var overrides if present,
        // otherwise zeros.
        cache = {
          equipment_available: num(process.env.STATS_OVERRIDE_EQUIPMENT) ?? 0,
          farmers_active:      num(process.env.STATS_OVERRIDE_FARMERS)   ?? 0,
          orders_completed:    num(process.env.STATS_OVERRIDE_ORDERS)    ?? 0,
          regions_served:      num(process.env.STATS_OVERRIDE_REGIONS)   ?? 11,
        };
        cacheExpiresAt = now + 30_000; // shorter retry window on failure
        console.error("[/public/stats] fallback:", e.message);
      }
    }

    // Tell HTTP caches/CDNs they can hold this for 5 minutes too.
    res.set("Cache-Control", "public, max-age=300");
    res.json({ success: true, stats: cache, cached_until: new Date(cacheExpiresAt).toISOString() });
  }),
);

/**
 * GET /api/v1/public/farmers/:id/trust
 *
 * Public — anyone (logged in or not) can read a farmer's trust profile.
 * This is what powers the badges on the equipment cards as well as the
 * (future) farmer profile page. Renters and delivery agents also have
 * trust profiles, but the URL says "farmers" because the buyer-facing
 * use case is "is this farmer reliable".
 *
 * Returns 404 only if the user doesn't exist OR has no marketplace activity
 * (no listings and no deliveries) — we don't expose trust profiles for
 * accounts with nothing to show since there's no public page for them.
 */
const trustRepo = require("../repositories/trust.repository");

router.get(
  "/farmers/:id/trust",
  asyncHandler(async (req, res) => {
    const profile = await trustRepo.computeForOwner(req.params.id);
    if (!profile) {
      return res.status(404).json({
        error: { code: 404, message: "Farmer not found" },
      });
    }
    // Only expose trust profiles for accounts with actual marketplace
    // activity (listings or deliveries). A consumer with neither isn't
    // public.
    if (
      profile.stats.listings_count === 0 &&
      profile.stats.deliveries_count === 0
    ) {
      return res.status(404).json({
        error: { code: 404, message: "Farmer not found" },
      });
    }
    // Trust data changes slowly. Let CDNs cache for a minute.
    res.set("Cache-Control", "public, max-age=60");
    res.json({ success: true, trust: profile });
  }),
);

/**
 * GET /api/v1/public/banners
 *
 * Public — anyone (logged in or not) can read live promotional banners
 * for the homepage / tools page. Powered by `hero_banners` + the same
 * 60s CDN cache as the trust profile.
 *
 * Optional ?placement= filter so the homepage only fetches its own
 * placements without paging through banners destined for other pages.
 */
const bannerCtrl = require("../controllers/banner.controller");
router.get("/banners", bannerCtrl.listLive);

module.exports = router;
