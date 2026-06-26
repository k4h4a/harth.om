// 038. Singleton table holding the global, admin-configurable platform
// commission percentage applied to new/edited equipment prices.

/**
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.schema.createTable("commission_settings", (t) => {
    t.smallint("id").primary();
    t.decimal("percentage", 5, 2).notNullable().defaultTo(10.0);
    t.uuid("updated_by").references("id").inTable("users").onDelete("SET NULL");
    t.timestamp("updated_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  await knex.raw(
    "ALTER TABLE commission_settings ADD CONSTRAINT commission_settings_singleton CHECK (id = 1);",
  );
  await knex.raw(
    "ALTER TABLE commission_settings ADD CONSTRAINT commission_settings_pct_range CHECK (percentage >= 0 AND percentage <= 100);",
  );

  await knex("commission_settings").insert({ id: 1, percentage: 10.0 });
};

/**
 * @param { import("knex").Knex } knex
 */
exports.down = async function (knex) {
  await knex.schema.dropTableIfExists("commission_settings");
};
