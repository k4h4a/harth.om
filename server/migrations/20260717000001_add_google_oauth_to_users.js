// Add Google OAuth support: google_id + avatar_url, and relax password_hash
// to nullable since Google-only accounts never set a local password.

/**
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.schema.alterTable("users", (t) => {
    t.string("google_id", 255).unique();
    t.string("avatar_url", 500);
  });
  await knex.raw(`ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;`);
};

/**
 * @param { import("knex").Knex } knex
 */
exports.down = async function (knex) {
  await knex.raw(`ALTER TABLE users ALTER COLUMN password_hash SET NOT NULL;`);
  await knex.schema.alterTable("users", (t) => {
    t.dropColumn("google_id");
    t.dropColumn("avatar_url");
  });
};
