// Converts account verification from phone OTP (SMS/Twilio) to email OTP.
// Undoes everything 20260713000002_add_phone_verification.js created, and
// relaxes the phone constraints from 20260713000001_create_pending_registrations.js
// (phone is now optional, unverified contact info — email is the sole
// verification channel; see registrationOtp.service.js).
//
// Every statement here is written to be a no-op on environments that never
// ran the original phone-OTP migrations (phone was already nullable, the
// phone_verifications table/columns never existed) — so this is safe to
// run on both fresh databases and ones that had the phone-OTP feature
// deployed to them.

/**
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.schema.alterTable("pending_registrations", (t) => {
    t.string("phone", 32).nullable().alter();
  });
  await knex.raw(`DROP INDEX IF EXISTS pending_registrations_live_phone_idx;`);

  await knex.schema.dropTableIfExists("phone_verifications");
  await knex.raw(`ALTER TABLE users DROP COLUMN IF EXISTS phone_verified_at;`);
  await knex.raw(`ALTER TABLE users DROP COLUMN IF EXISTS phone_verified;`);
};

/**
 * @param { import("knex").Knex } knex
 */
exports.down = async function (knex) {
  await knex.schema.alterTable("users", (t) => {
    t.boolean("phone_verified").notNullable().defaultTo(false);
    t.timestamp("phone_verified_at", { useTz: true });
  });

  await knex.schema.createTable("phone_verifications", (t) => {
    t.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    t.uuid("user_id").references("id").inTable("users").onDelete("CASCADE");
    t.uuid("pending_registration_id")
      .references("id")
      .inTable("pending_registrations")
      .onDelete("CASCADE");
    t.string("phone_number", 32).notNullable();
    t.string("purpose", 32).notNullable();
    t.string("code_hash", 255).notNullable();
    t.timestamp("expires_at", { useTz: true }).notNullable();
    t.integer("attempts").notNullable().defaultTo(0);
    t.timestamp("consumed_at", { useTz: true });
    t.timestamp("verified_at", { useTz: true });
    t.string("requester_ip", 64);
    t.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  // NOTE: re-adding NOT NULL on pending_registrations.phone will fail if any
  // row created under the email-OTP flow has a null phone — expected and
  // acceptable, this direction isn't meant to be run against live data.
  await knex.schema.alterTable("pending_registrations", (t) => {
    t.string("phone", 32).notNullable().alter();
  });
};
