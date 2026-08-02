const knex = require("../db");
const { hashPassword } = require("./password");
const env = require("../config/env");

/**
 * Ensure at least one admin exists. Idempotent — safe to call on every boot.
 * The admin credentials come from env vars; defaults are fine for local dev
 * but must be overridden in production (a 32+ char JWT_SECRET is already
 * enforced by env.js, but admin password strength isn't — deploy with care).
 */
async function bootstrapAdmin() {
  const count = await knex("users").where({ is_admin: true }).count("* as c").first();
  if (parseInt(count.c, 10) > 0) {
    // eslint-disable-next-line no-console
    console.log("ℹ️  Admin already exists — skipping bootstrap.");
    return;
  }

  const passwordHash = await hashPassword(env.ADMIN_PASSWORD);

  // Generate a referral code for the admin too (the unique constraint needs one
  // if we want to keep referral_code non-null for everyone — we kept it
  // nullable in the migration, so passing null is also valid).
  await knex("users").insert({
    email: env.ADMIN_EMAIL,
    password_hash: passwordHash,
    is_admin: true,
    name: "Administrator",
    is_active: true,
    account_status: "approved",
    status_changed_at: knex.fn.now(),
  });

  // eslint-disable-next-line no-console
  console.log(`✅ Admin bootstrapped: ${env.ADMIN_EMAIL}`);
}

module.exports = bootstrapAdmin;
