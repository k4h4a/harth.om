// Knex CLI reads this file directly. We load .env here ourselves because the
// CLI might run before src/config/env.js gets a chance to.
require("dotenv").config();

const common = {
  client: "pg",
  pool: { min: 2, max: 10 },
  migrations: {
    tableName: "knex_migrations",
    directory: "./migrations",
    extension: "js",
  },
};

/** @type { Object.<string, import("knex").Knex.Config> } */
module.exports = {
  development: {
    ...common,
    connection: {
      host: process.env.DB_HOST,
      port: parseInt(process.env.DB_PORT, 10) || 5432,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
    },
  },

  test: {
    ...common,
    connection: {
      host: process.env.DB_HOST,
      port: parseInt(process.env.DB_PORT, 10) || 5432,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME_TEST || `${process.env.DB_NAME}_test`,
    },
  },

  production: {
    ...common,
    connection: process.env.DATABASE_URL || {
      host: process.env.DB_HOST,
      port: parseInt(process.env.DB_PORT, 10) || 5432,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      ssl:
        process.env.DB_SSL === "true" ? { rejectUnauthorized: false } : false,
    },
    development: {
      ...common,
      connection: {
        host: process.env.DB_HOST,
        port: parseInt(process.env.DB_PORT, 10) || 5432,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
        ssl:
          process.env.DB_SSL === "true" ? { rejectUnauthorized: false } : false,
      },
    },
  },
};
