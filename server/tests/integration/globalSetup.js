// Runs once before the whole "integration" project. Migrates the test DB
// (knexfile.js `test` config — a real Postgres, not sqlite: the schema uses
// gen_random_uuid(), Postgres ENUMs, jsonb, partial unique indexes, and
// CHECK constraints that sqlite doesn't support).
const knexConfig = require("../../knexfile");

module.exports = async function globalSetup() {
  const knex = require("knex")(knexConfig.test);
  try {
    await knex.migrate.latest();
  } finally {
    await knex.destroy();
  }
};
