// Email OTP codes for the deferred-registration flow only (see
// pendingRegistration.service.js / registrationOtp.service.js). Kept
// separate from the generic `auth_otps` table (used for password_reset /
// password_change) because this one is deliberately hard-delete-on-success
// rather than soft-consumed, and always ties to a pending_registrations row
// instead of an existing user.

/**
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.schema.createTable("registration_verifications", (t) => {
    t.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    t.uuid("pending_registration_id")
      .notNullable()
      .references("id")
      .inTable("pending_registrations")
      .onDelete("CASCADE");
    t.string("email", 255).notNullable();
    t.string("code_hash", 255).notNullable();
    t.timestamp("expires_at", { useTz: true }).notNullable();
    t.integer("attempts").notNullable().defaultTo(0);
    t.string("requester_ip", 64);
    t.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());

    t.index("email");
    t.index("pending_registration_id");
    t.index("expires_at");
  });

  await knex.raw(`
    ALTER TABLE registration_verifications ADD CONSTRAINT registration_verifications_attempts_sane
    CHECK (attempts >= 0 AND attempts <= 100);
  `);
};

/**
 * @param { import("knex").Knex } knex
 */
exports.down = async function (knex) {
  await knex.schema.dropTableIfExists("registration_verifications");
};
