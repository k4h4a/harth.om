// 037. Platform commission baked into equipment pricing. The farmer's typed
// price becomes the base; daily_price/sale_price become the FINAL,
// buyer-facing price (base + commission). Existing rows are backfilled with
// 0 commission so current listings/prices don't change until next edit.

/**
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.schema.alterTable("equipment", (t) => {
    t.decimal("farmer_daily_price", 12, 2);
    t.decimal("farmer_sale_price", 12, 2);
    t.decimal("commission_percentage", 5, 2).notNullable().defaultTo(10.0);
    t.decimal("daily_commission_amount", 12, 2).notNullable().defaultTo(0);
    t.decimal("sale_commission_amount", 12, 2).notNullable().defaultTo(0);
  });

  await knex("equipment").update({
    farmer_daily_price: knex.raw("daily_price"),
    farmer_sale_price: knex.raw("sale_price"),
  });

  await knex.raw(`
    ALTER TABLE equipment ADD CONSTRAINT equipment_commission_nonneg CHECK (
      (farmer_daily_price IS NULL OR farmer_daily_price >= 0)
      AND (farmer_sale_price IS NULL OR farmer_sale_price >= 0)
      AND commission_percentage >= 0
      AND daily_commission_amount >= 0
      AND sale_commission_amount >= 0
    );
  `);
};

/**
 * @param { import("knex").Knex } knex
 */
exports.down = async function (knex) {
  await knex.raw(
    "ALTER TABLE equipment DROP CONSTRAINT IF EXISTS equipment_commission_nonneg;",
  );
  await knex.schema.alterTable("equipment", (t) => {
    t.dropColumn("farmer_daily_price");
    t.dropColumn("farmer_sale_price");
    t.dropColumn("commission_percentage");
    t.dropColumn("daily_commission_amount");
    t.dropColumn("sale_commission_amount");
  });
};
