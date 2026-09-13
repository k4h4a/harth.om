const env = require("./config/env");
const app = require("./app");
const knex = require("./db");
const bootstrapAdmin = require("./utils/bootstrap-admin");

async function start() {
  try {
    await knex.raw("select 1");
    // eslint-disable-next-line no-console
    console.log("✅ Database connected");

    await bootstrapAdmin();

    const server = app.listen(env.PORT, () => {
      // eslint-disable-next-line no-console
      console.log(`🚀 Server running at http://localhost:${env.PORT}`);
      // eslint-disable-next-line no-console
      console.log(`   Health: http://localhost:${env.PORT}/api/v1/health`);
    });

    const shutdown = async (signal) => {
      // eslint-disable-next-line no-console
      console.log(`\n${signal} received — shutting down gracefully`);
      server.close(async () => {
        try {
          await knex.destroy();
          // eslint-disable-next-line no-console
          console.log("✅ DB pool closed");
          process.exit(0);
        } catch (e) {
          // eslint-disable-next-line no-console
          console.error("Error during shutdown:", e);
          process.exit(1);
        }
      });
      setTimeout(() => process.exit(1), 10_000).unref();
    };
    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("❌ Failed to start server:", err);
    process.exit(1);
  }
}

start();
