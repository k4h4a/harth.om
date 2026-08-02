// Remove the role-based permission system. Every account now has identical
// marketplace capabilities (list, buy, sell, deliver); `admin` is no longer a
// marketplace "role" but a plain operational flag. `account_status` stops
// being a role-driven approval gate — new accounts are active immediately;
// it remains only as a manual moderation tool (block/reject a specific
// account after the fact).

/**
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.schema.alterTable("users", (t) => {
    t.boolean("is_admin").notNullable().defaultTo(false);
  });
  await knex("users").where({ role: "admin" }).update({ is_admin: true });
  await knex.schema.alterTable("users", (t) => {
    t.index("is_admin");
  });

  // account_status already defaults to 'approved' at the DB level; only the
  // application layer was overriding it to 'pending' for owner/delivery
  // signups. Backfill any accounts still stuck in that role-driven pending
  // state to 'approved' — moderation-driven pending/rejected/blocked/deleted
  // rows are untouched.
  await knex("users")
    .where({ account_status: "pending" })
    .update({ account_status: "approved", status_changed_at: knex.fn.now() });

  await knex.schema.alterTable("users", (t) => {
    t.dropIndex(["account_status", "role"], "users_account_status_role_index");
    t.dropIndex("role", "users_role_index");
  });

  await knex.schema.alterTable("users", (t) => {
    t.dropColumn("role");
  });
  await knex.schema.alterTable("pending_registrations", (t) => {
    t.dropColumn("role");
  });

  await knex.raw(`DROP TYPE IF EXISTS user_role;`);
};

/**
 * @param { import("knex").Knex } knex
 */
exports.down = async function (knex) {
  await knex.raw(
    `CREATE TYPE user_role AS ENUM ('admin', 'owner', 'renter', 'delivery');`,
  );

  await knex.schema.alterTable("users", (t) => {
    t.specificType("role", "user_role").notNullable().defaultTo("renter");
  });
  // Lossy: the owner/renter/delivery distinction no longer exists by the
  // time this would ever roll back, so every non-admin becomes 'renter'.
  await knex("users").where({ is_admin: true }).update({ role: "admin" });

  await knex.schema.alterTable("users", (t) => {
    t.index("role", "users_role_index");
    t.index(["account_status", "role"], "users_account_status_role_index");
  });

  await knex.schema.alterTable("users", (t) => {
    t.dropIndex("is_admin");
    t.dropColumn("is_admin");
  });

  await knex.schema.alterTable("pending_registrations", (t) => {
    t.specificType("role", "user_role").notNullable().defaultTo("renter");
  });
};
