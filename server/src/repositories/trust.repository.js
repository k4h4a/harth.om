/**
 * Trust badges & owner reputation.
 *
 * The "Trust" section on a farmer's card answers the buyer's question: "is
 * this seller real and reliable?". All the inputs come from data we already
 * collect, so adding badges is purely a matter of summarising it well.
 *
 * Badges (boolean signals):
 *   - verified           : identity_verified AND account_status='approved'.
 *                          The flagship "موثَّق" badge. (Email verification
 *                          was removed as a feature; KYC + admin approval
 *                          alone now decide this badge.)
 *   - top_seller         : at least TOP_SELLER_MIN_TX completed transactions
 *                          AND avg_rating >= TOP_SELLER_MIN_RATING.
 *   - fast_shipping      : >=FAST_SHIP_MIN_DELIVERIES delivered orders linked
 *                          to this owner AND avg accepted→delivered time is
 *                          under FAST_SHIP_MAX_HOURS.
 *   - quick_responder    : avg time owner takes to approve/reject a rental
 *                          request is under QUICK_RESP_MAX_HOURS, AND has at
 *                          least QUICK_RESP_MIN_RESPONSES samples.
 *   - is_pro             : the platform PRO subscription.
 *
 * Stats (numbers, also returned so the UI can show "12 طلب · 95% إكمال"
 * style detail under the badges):
 *   - completed_transactions   : count of delivered orders + completed rentals
 *                                attributable to this owner.
 *   - completion_rate          : delivered / (delivered + cancelled). Excludes
 *                                in-flight orders.
 *   - avg_rating               : equipment-weighted owner-level average,
 *                                computed as sum(rating*ratings_count) /
 *                                sum(ratings_count) over their listings.
 *   - ratings_count            : sum of ratings_count across their listings.
 *   - avg_response_hours       : avg time between rental request creation
 *                                and the owner's first approve/reject. null
 *                                if there's no data.
 *
 * Performance:
 *   The single-owner query uses a CTE that fans out to the four data sources
 *   in parallel and aggregates them in one round trip. The bulk version
 *   (computeForOwners(ids)) runs once per owner — for the equipment list,
 *   which can have 20 distinct owners on a page, that's still 20 cheap
 *   indexed queries. If this ever becomes a hot path we can rewrite as a
 *   single GROUP BY across all ids; for now correctness > micro-optimisation.
 */

const knex = require("../db");

// Tunable thresholds. Kept here so they can be moved to env vars later
// without changing call sites.
const TOP_SELLER_MIN_TX = 5;
const TOP_SELLER_MIN_RATING = 4.0;
const FAST_SHIP_MIN_DELIVERIES = 3;
const FAST_SHIP_MAX_HOURS = 48;
const QUICK_RESP_MIN_RESPONSES = 3;
const QUICK_RESP_MAX_HOURS = 12;

/**
 * Compute trust badges + stats for a single owner. Returns:
 *   {
 *     id, name, is_pro,
 *     email_verified, identity_verified, account_status,
 *     stats: { ... },
 *     badges: { verified, top_seller, fast_shipping, quick_responder, is_pro },
 *   }
 *
 * Returns null if the user doesn't exist.
 */
async function computeForOwner(ownerId) {
  if (!ownerId) return null;

  const user = await knex("users")
    .where({ id: ownerId })
    .first(
      "id",
      "name",
      "is_pro",
      "email_verified",
      "identity_verified",
      "account_status",
      "created_at",
    );
  if (!user) return null;

  // Run the four aggregate queries in parallel.
  const [equipAgg, ordersAgg, rentalAgg, respAgg, deliveryAgg] = await Promise.all([
    // Owner-level avg_rating, weighted by ratings_count across all their
    // listings. coalesce + nullif so we don't divide by zero.
    knex("equipment")
      .where({ owner_id: ownerId })
      .select(
        knex.raw(
          "coalesce(sum(avg_rating * ratings_count) / nullif(sum(ratings_count), 0), 0)::numeric(3,2) as avg_rating",
        ),
        knex.raw("coalesce(sum(ratings_count), 0)::int as ratings_count"),
        knex.raw("count(*)::int as listings_count"),
      )
      .first(),

    // Order-side: count delivered vs cancelled order_items for THIS owner.
    // We hit order_items so the join goes through equipment->owner_id.
    knex.raw(
      `
      SELECT
        coalesce(sum(case when o.status = 'delivered' then 1 else 0 end), 0)::int as delivered,
        coalesce(sum(case when o.status = 'cancelled' then 1 else 0 end), 0)::int as cancelled
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      JOIN equipment e ON e.id = oi.equipment_id
      WHERE e.owner_id = ?
      `,
      [ownerId],
    ),

    // Rental side: completed/cancelled by THIS owner.
    knex("rentals")
      .where({ owner_id: ownerId })
      .select(
        knex.raw(
          "coalesce(sum(case when status = 'completed' then 1 else 0 end), 0)::int as completed",
        ),
        knex.raw(
          "coalesce(sum(case when status in ('cancelled','rejected') then 1 else 0 end), 0)::int as cancelled",
        ),
      )
      .first(),

    // Avg response time: time between rental creation and owner's first
    // approve/reject. We approximate "owner's first response" with
    // approved_at / cancelled_at on the rental itself when status went
    // pending → approved/rejected/cancelled by the owner.
    knex.raw(
      `
      SELECT
        avg(extract(epoch from coalesce(approved_at, cancelled_at) - created_at) / 3600)::numeric(8,2) as avg_hours,
        count(coalesce(approved_at, cancelled_at))::int as responses
      FROM rentals
      WHERE owner_id = ?
        AND status IN ('approved','active','completed','rejected')
      `,
      [ownerId],
    ),

    // Avg delivery time on order_items belonging to this owner: time between
    // accepted_at and delivered_at on linked delivery_requests.
    knex.raw(
      `
      SELECT
        avg(extract(epoch from d.delivered_at - d.accepted_at) / 3600)::numeric(8,2) as avg_hours,
        count(*)::int as deliveries
      FROM delivery_requests d
      JOIN orders o ON o.id = d.order_id
      JOIN order_items oi ON oi.order_id = o.id
      JOIN equipment e ON e.id = oi.equipment_id
      WHERE e.owner_id = ?
        AND d.status = 'delivered'
        AND d.delivered_at IS NOT NULL
        AND d.accepted_at IS NOT NULL
      `,
      [ownerId],
    ),
  ]);

  const ordersRow = ordersAgg.rows && ordersAgg.rows[0] ? ordersAgg.rows[0] : { delivered: 0, cancelled: 0 };
  const respRow = respAgg.rows && respAgg.rows[0] ? respAgg.rows[0] : { avg_hours: null, responses: 0 };
  const delivRow = deliveryAgg.rows && deliveryAgg.rows[0] ? deliveryAgg.rows[0] : { avg_hours: null, deliveries: 0 };

  const completedTransactions =
    Number(ordersRow.delivered) + Number(rentalAgg.completed);
  const cancelledTransactions =
    Number(ordersRow.cancelled) + Number(rentalAgg.cancelled);
  const totalTransactions = completedTransactions + cancelledTransactions;

  const completionRate =
    totalTransactions === 0
      ? null
      : Math.round((completedTransactions / totalTransactions) * 100);

  const avgRating = Number(equipAgg?.avg_rating) || 0;
  const ratingsCount = Number(equipAgg?.ratings_count) || 0;
  const listingsCount = Number(equipAgg?.listings_count) || 0;

  const avgResponseHours =
    respRow.avg_hours == null ? null : Number(respRow.avg_hours);
  const responsesSamples = Number(respRow.responses) || 0;

  const avgDeliveryHours =
    delivRow.avg_hours == null ? null : Number(delivRow.avg_hours);
  const deliveriesCount = Number(delivRow.deliveries) || 0;

  const stats = {
    listings_count: listingsCount,
    completed_transactions: completedTransactions,
    cancelled_transactions: cancelledTransactions,
    completion_rate: completionRate,
    avg_rating: avgRating,
    ratings_count: ratingsCount,
    avg_response_hours: avgResponseHours,
    responses_count: responsesSamples,
    avg_delivery_hours: avgDeliveryHours,
    deliveries_count: deliveriesCount,
    member_since: user.created_at,
  };

  // Email verification was removed as a feature, so the verified badge
  // depends only on KYC + admin approval now. We still surface the
  // (now always true for new accounts) email_verified flag in the
  // response shape below so older clients keep parsing successfully.
  const verified =
    !!user.identity_verified &&
    user.account_status === "approved";

  const topSeller =
    completedTransactions >= TOP_SELLER_MIN_TX &&
    avgRating >= TOP_SELLER_MIN_RATING;

  const fastShipping =
    deliveriesCount >= FAST_SHIP_MIN_DELIVERIES &&
    avgDeliveryHours != null &&
    avgDeliveryHours <= FAST_SHIP_MAX_HOURS;

  const quickResponder =
    responsesSamples >= QUICK_RESP_MIN_RESPONSES &&
    avgResponseHours != null &&
    avgResponseHours <= QUICK_RESP_MAX_HOURS;

  const badges = {
    verified,
    top_seller: topSeller,
    fast_shipping: fastShipping,
    quick_responder: quickResponder,
    is_pro: !!user.is_pro,
  };

  return {
    id: user.id,
    name: user.name,
    is_pro: !!user.is_pro,
    email_verified: !!user.email_verified,
    identity_verified: !!user.identity_verified,
    account_status: user.account_status,
    stats,
    badges,
  };
}

/**
 * Compute trust profiles for a list of owner ids in one go. Returns a Map
 * keyed by owner id. Used by the equipment list to attach a small `trust`
 * blob to each card.
 *
 * NB: under the hood this is a per-owner loop so it's O(N * 5_queries).
 * For typical pages (20 cards, often <10 distinct owners) that's fine.
 * Aggregating once across all owners is possible but the GROUP BY across
 * 5 different sources gets ugly; revisit only if profiling shows a problem.
 */
async function computeForOwners(ownerIds = []) {
  const unique = Array.from(new Set(ownerIds.filter(Boolean)));
  if (!unique.length) return new Map();
  const profiles = await Promise.all(unique.map((id) => computeForOwner(id)));
  const map = new Map();
  for (const p of profiles) {
    if (p) map.set(p.id, p);
  }
  return map;
}

/**
 * Compact form: just the badges + a few top-line stats. Used inline on
 * equipment cards where we don't want to ship the full payload. Rendering
 * is a tradeoff between density and clarity — we ship enough that the UI
 * can show "✓ موثّق · ⭐ 4.8 · 12 طلب · يردّ خلال 3 ساعات" without a
 * second round trip.
 */
function compact(profile) {
  if (!profile) return null;
  return {
    id: profile.id,
    name: profile.name,
    is_pro: profile.is_pro,
    badges: profile.badges,
    avg_rating: profile.stats.avg_rating,
    ratings_count: profile.stats.ratings_count,
    completed_transactions: profile.stats.completed_transactions,
    completion_rate: profile.stats.completion_rate,
    avg_response_hours: profile.stats.avg_response_hours,
  };
}

module.exports = {
  computeForOwner,
  computeForOwners,
  compact,
  // Exported for tests / admin tweaks
  TOP_SELLER_MIN_TX,
  TOP_SELLER_MIN_RATING,
  FAST_SHIP_MIN_DELIVERIES,
  FAST_SHIP_MAX_HOURS,
  QUICK_RESP_MIN_RESPONSES,
  QUICK_RESP_MAX_HOURS,
};
