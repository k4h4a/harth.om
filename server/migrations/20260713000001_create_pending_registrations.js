// Deferred (strict) registration: no `users` row is created until the
// registrant's phone is verified via OTP. This table holds the submitted
// registration data (password already hashed) until that happens.

/**
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.schema.createTable("pending_registrations", (t) => {
    t.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    t.string("email", 255).notNullable();
    t.string("phone", 32).notNullable();
    t.string("password_hash", 255).notNullable();
    t.string("name", 200).notNullable();
    t.specificType("role", "user_role").notNullable();
    t.string("identity", 64);
    t.jsonb("location");
    t.string("governorate", 32);
    t.string("referred_by_code", 16);
    t.string("requester_ip", 64);
    t.timestamp("expires_at", { useTz: true }).notNullable();
    t.timestamp("consumed_at", { useTz: true });
    t.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());

    t.index("email");
    t.index("phone");
    t.index("expires_at");
  });

  // Only one *live* (unconsumed) pending registration per phone/email at a
  // time, so retries update the same lineage instead of piling up rows, and
  // two concurrent registration attempts for the same phone can't both stay
  // pending forever.
  await knex.raw(`
    CREATE UNIQUE INDEX pending_registrations_live_phone_idx
      ON pending_registrations(phone) WHERE consumed_at IS NULL;
  `);
  await knex.raw(`
    CREATE UNIQUE INDEX pending_registrations_live_email_idx
      ON pending_registrations(email) WHERE consumed_at IS NULL;
  `);
};

/**
 * @param { import("knex").Knex } knex
 */
exports.down = async function (knex) {
  await knex.schema.dropTableIfExists("pending_registrations");
};
