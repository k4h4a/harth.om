/* eslint-disable no-console */
/**
 * seed.js — populate the database with realistic demo data so the user can
 * immediately see every feature working. Every account has identical
 * marketplace capabilities now (no roles) — the seeded accounts just vary
 * in what they've *done* so the demo has realistic variety:
 *
 *   - 1 admin (already created by bootstrap)
 *   - 2 accounts with equipment listings (one with 3 approved listings,
 *     one with a listing still pending admin approval)
 *   - 1 account with no listings, used as the buyer in the demo orders
 *   - 2 accounts used as couriers in the demo delivery requests
 *   - 2 orders with delivery requests (1 pending = shows in the open job
 *     board, 1 assigned = shows courier name on track page)
 *
 * Idempotent: running it twice won't duplicate — it checks emails first.
 *
 * Usage:
 *   cd server
 *   node src/utils/seed.js
 */

const path = require("path");
// Load env before anything else. seed.js lives at server/src/utils/seed.js
// so the project root's .env is two dirs up.
require("dotenv").config({ path: path.resolve(__dirname, "../../.env") });

const knex = require("../db");
const crypto = require("crypto");
const { hashPassword } = require("../utils/password");
const { generateTrackingNumber } = require("../utils/tracking");

// Local copy of the referral-code generator to avoid pulling in controller
// dependencies (which load the whole express app). Keep in sync with the
// one in auth.controller.js.
function generateReferralCode() {
  const alphabet = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
  let code = "";
  const bytes = crypto.randomBytes(8);
  for (let i = 0; i < 8; i++) code += alphabet[bytes[i] % alphabet.length];
  return code;
}

async function upsertUser({ email, password, name, phone, governorate = null, is_pro = false, label = "user" }) {
  const existing = await knex("users").where({ email }).first("id");
  if (existing) {
    console.log(`  ✓ user ${email} already exists`);
    return existing.id;
  }
  const passwordHash = await hashPassword(password);
  const [row] = await knex("users")
    .insert({
      email,
      phone,
      password_hash: passwordHash,
      name,
      governorate,
      is_pro,
      referral_code: generateReferralCode(),
      is_active: true,
      // Seeded users are approved so the demo flow works end-to-end out of
      // the box. Real signups are gated through the admin approval queue.
      account_status: "approved",
      status_changed_at: knex.fn.now(),
    })
    .returning(["id"]);
  console.log(`  + created ${label} ${email}`);
  return row.id;
}

async function upsertEquipment({ ownerId, name, category, listing_type, daily_price = null, sale_price = null, stock = 1, governorate = null, approved = true }) {
  const existing = await knex("equipment").where({ name, owner_id: ownerId }).first("id");
  if (existing) {
    console.log(`  ✓ equipment "${name}" already exists`);
    return existing.id;
  }
  const [row] = await knex("equipment")
    .insert({
      owner_id: ownerId,
      name,
      description: `وصف تجريبي للمعدة "${name}"`,
      category,
      listing_type,
      daily_price,
      sale_price,
      stock,
      status: "available",
      governorate,
      approval_status: approved ? "approved" : "pending",
      approved_at: approved ? knex.fn.now() : null,
      images: JSON.stringify([]),
      specs: JSON.stringify({}),
    })
    .returning(["id"]);
  console.log(`  + created equipment "${name}" (${approved ? "approved" : "PENDING"})`);
  return row.id;
}

async function createDemoOrder({ userId, equipmentId, salePrice, withCourier = null }) {
  // Check if this user already has an order for this equipment to keep
  // the seed idempotent.
  const existing = await knex("orders as o")
    .leftJoin("order_items as oi", "oi.order_id", "o.id")
    .where("o.user_id", userId)
    .andWhere("oi.equipment_id", equipmentId)
    .first("o.id", "o.tracking_number");
  if (existing) {
    console.log(`  ✓ order for user+equipment already exists (${existing.tracking_number})`);
    return existing.id;
  }

  return knex.transaction(async (trx) => {
    const tracking = generateTrackingNumber();
    const [order] = await trx("orders")
      .insert({
        user_id: userId,
        tracking_number: tracking,
        subtotal: salePrice,
        discount: 0,
        tax: 0,
        delivery_fee: 2.0,
        total: salePrice + 2.0,
        status: "confirmed",
        payment_status: "paid",
        paid_at: trx.fn.now(),
      })
      .returning(["id"]);

    await trx("order_items").insert({
      order_id: order.id,
      equipment_id: equipmentId,
      quantity: 1,
      unit_price: salePrice,
      line_total: salePrice,
    });

    // Create a delivery_request. If withCourier is given, pre-assign it.
    const deliveryStatus = withCourier ? "accepted" : "pending";
    await trx("delivery_requests").insert({
      order_id: order.id,
      courier_id: withCourier,
      status: deliveryStatus,
      pickup_address: JSON.stringify({ city: "muscat", street: "مزرعة المزارع" }),
      dropoff_address: JSON.stringify({ city: "muscat", street: "حي الزبون" }),
      scheduled_date: new Date().toISOString().slice(0, 10),
      fee: 2.0,
      accepted_at: withCourier ? trx.fn.now() : null,
    });

    console.log(`  + order ${tracking} created (delivery: ${deliveryStatus}${withCourier ? ", courier assigned" : ""})`);
    return order.id;
  });
}

async function main() {
  console.log("Seeding demo data...\n");

  console.log("— Users —");
  const farmer1Id = await upsertUser({
    email: "farmer1@harth.com",
    password: "farmer123",
    label: "user (with listings)",
    name: "سالم المزارع",
    phone: "+96899000001",
    governorate: "muscat",
    is_pro: true,
  });
  const farmer2Id = await upsertUser({
    email: "farmer2@harth.com",
    password: "farmer123",
    label: "user (with a pending listing)",
    name: "أحمد الزارع",
    phone: "+96899000002",
    governorate: "dhofar",
  });
  const renterId = await upsertUser({
    email: "renter@harth.com",
    password: "renter123",
    label: "user (buyer, no listings)",
    name: "خالد المستهلك",
    phone: "+96899000003",
    governorate: "muscat",
  });
  const courier1Id = await upsertUser({
    email: "courier1@harth.com",
    password: "courier123",
    label: "user (courier demo)",
    name: "يوسف المندوب",
    phone: "+96899000004",
    governorate: "muscat",
  });
  const courier2Id = await upsertUser({
    email: "courier2@harth.com",
    password: "courier123",
    label: "user (courier demo)",
    name: "ماجد السائق",
    phone: "+96899000005",
    governorate: "muscat",
  });

  console.log("\n— Equipment —");
  const tractorId = await upsertEquipment({
    ownerId: farmer1Id,
    name: "جرار زراعي حديث",
    category: "tractor",
    listing_type: "both",
    daily_price: 25,
    sale_price: 4500,
    stock: 1,
    governorate: "muscat",
    approved: true,
  });
  await upsertEquipment({
    ownerId: farmer1Id,
    name: "مرشة مبيدات 20 لتر",
    category: "sprayer",
    listing_type: "sale",
    sale_price: 80,
    stock: 15,
    governorate: "muscat",
    approved: true,
  });
  await upsertEquipment({
    ownerId: farmer1Id,
    name: "حصادة قمح",
    category: "harvester",
    listing_type: "rent",
    daily_price: 60,
    stock: 1,
    governorate: "dakhiliyah",
    approved: true,
  });
  await upsertEquipment({
    ownerId: farmer2Id,
    name: "آلة ري بالتنقيط",
    category: "other",
    listing_type: "sale",
    sale_price: 300,
    stock: 5,
    governorate: "dhofar",
    approved: false, // PENDING — admin can approve from dashboard
  });

  console.log("\n— Orders + deliveries —");
  // Order 1: courier not yet assigned (will show in courier's "available" tab)
  await createDemoOrder({
    userId: renterId,
    equipmentId: tractorId,
    salePrice: 4500,
    withCourier: null,
  });
  // Order 2: courier1 already accepted (will show as "assigned" on track page)
  await createDemoOrder({
    userId: renterId,
    equipmentId: tractorId,
    salePrice: 4500,
    withCourier: courier1Id,
  });

  console.log("\n✅ Done. Credentials:");
  console.log("   admin    : admin@harth.com / admin123");
  console.log("   farmer   : farmer1@harth.com / farmer123  (مزارع مع معدات معتمدة)");
  console.log("   farmer   : farmer2@harth.com / farmer123  (مزارع مع معدة تحتاج موافقة)");
  console.log("   renter   : renter@harth.com / renter123");
  console.log("   courier  : courier1@harth.com / courier123");
  console.log("   courier  : courier2@harth.com / courier123");

  await knex.destroy();
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
