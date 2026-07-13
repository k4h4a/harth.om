// Shared test-DB helpers. `src/db` picks the `test` knexfile config
// automatically because Jest sets NODE_ENV=test.
const knex = require("../../src/db");

async function resetDb() {
  await knex.raw(`
    TRUNCATE TABLE
      phone_verifications,
      pending_registrations,
      user_activity_log,
      users
    RESTART IDENTITY CASCADE
  `);
}

let userSeq = 0;

/**
 * Insert a minimal real `users` row directly (bypassing the API) so tests
 * can satisfy phone_verifications.user_id's FK without going through the
 * whole registration flow.
 */
async function createTestUser(overrides = {}) {
  userSeq += 1;
  const [row] = await knex("users")
    .insert({
      email: overrides.email || `user${userSeq}_${Date.now()}@test.harth`,
      phone: overrides.phone !== undefined ? overrides.phone : null,
      password_hash: overrides.password_hash || "$2b$04$abcdefghijklmnopqrstuv", // unused by these tests
      role: overrides.role || "renter",
      name: overrides.name || "Test User",
      referral_code: `T${userSeq}${Date.now().toString(36)}`.slice(0, 16).toUpperCase(),
      account_status: "approved",
      status_changed_at: knex.fn.now(),
      email_verified: true,
      email_verified_at: knex.fn.now(),
      phone_verified: !!overrides.phone_verified,
    })
    .returning(["id"]);
  return row.id;
}

module.exports = { knex, resetDb, createTestUser };
