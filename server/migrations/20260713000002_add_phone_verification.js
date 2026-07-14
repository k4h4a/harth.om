// Phone OTP verification. Kept as its own table (not merged into the
// existing generic `auth_otps` ledger) because:
//   - deferred registration needs rows with no `user_id` at all, tied only
//     to a `pending_registrations` row — a case `auth_otps` never supports.
//   - `auth_otps.purpose` is a Postgres ENUM; adding a value means an
//     `ALTER TYPE` outside the migration's transaction. `purpose` here is a
//     plain varchar so future purposes (e.g. new-device login) are free.
//
// SUPERSEDED — do not edit. The phone-OTP feature this migration supported
// was replaced by email OTP (see 20260714000001_convert_phone_otp_to_email_otp.js,
// which drops everything created here). This file must stay exactly as it
// was originally deployed: some environments already ran it, and Knex
// refuses to `migrate:latest` if a recorded migration's file goes missing.

/**
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.schema.alterTable("users", (t) => {
    t.boolean("phone_verified").notNullable().defaultTo(false);
    t.timestamp("phone_verified_at", { useTz: true });
    t.index("phone_verified");
  });
  // No backfill to true — unlike email_verified, existing phone numbers
  // were never actually proven to belong to their account.

  await knex.schema.createTable("phone_verifications", (t) => {
    t.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    t.uuid("user_id").references("id").inTable("users").onDelete("CASCADE");
    t.uuid("pending_registration_id")
      .references("id")
      .inTable("pending_registrations")
      .onDelete("CASCADE");
    t.string("phone_number", 32).notNullable();
    // 'registration' | 'account_verification' | 'phone_change'
    t.string("purpose", 32).notNullable();
    t.string("code_hash", 255).notNullable();
    t.timestamp("expires_at", { useTz: true }).notNullable();
    t.integer("attempts").notNullable().defaultTo(0);
    t.timestamp("consumed_at", { useTz: true });
    t.timestamp("verified_at", { useTz: true });
    t.string("requester_ip", 64);
    t.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());

    t.index(["phone_number", "purpose"]);
    t.index(["user_id", "purpose"]);
    t.index("pending_registration_id");
    t.index("expires_at");
  });

  await knex.raw(`
    ALTER TABLE phone_verifications ADD CONSTRAINT phone_verifications_attempts_sane
    CHECK (attempts >= 0 AND attempts <= 100);
  `);
};

/**
 * @param { import("knex").Knex } knex
 */
exports.down = async function (knex) {
  await knex.schema.dropTableIfExists("phone_verifications");
  await knex.schema.alterTable("users", (t) => {
    t.dropColumn("phone_verified_at");
    t.dropColumn("phone_verified");
  });
};
