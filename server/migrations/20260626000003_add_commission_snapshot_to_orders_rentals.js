// 039. Snapshot the platform commission baked into a listing's price at the
// moment an order/rental is created, so settlement (markPaid / completed)
// never has to re-derive it later — mirrors how price_per_unit /
// daily_price_snapshot already freeze the price at creation time.

/**
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.schema.alterTable("order_items", (t) => {
    t.decimal("commission_per_unit", 12, 2).notNullable().defaultTo(0);
  });
  await knex.schema.alterTable("rentals", (t) => {
    t.decimal("commission_amount_snapshot", 12, 2).notNullable().defaultTo(0);
  });
};

/**
 * @param { import("knex").Knex } knex
 */
exports.down = async function (knex) {
  await knex.schema.alterTable("order_items", (t) => {
    t.dropColumn("commission_per_unit");
  });
  await knex.schema.alterTable("rentals", (t) => {
    t.dropColumn("commission_amount_snapshot");
  });
};
