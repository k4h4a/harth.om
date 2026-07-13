// Two projects, kept separate on purpose:
//   - unit: pure functions only (crypto/hashing). No DB, runs anywhere.
//   - integration: hits a real Postgres test DB (see knexfile.js `test`
//     config / DB_NAME_TEST). Requires the DB to exist; migrations run
//     once via globalSetup before the suite and the connection closes in
//     globalTeardown.
module.exports = {
  projects: [
    {
      displayName: "unit",
      testEnvironment: "node",
      testMatch: ["<rootDir>/tests/unit/**/*.test.js"],
    },
    {
      displayName: "integration",
      testEnvironment: "node",
      testMatch: ["<rootDir>/tests/integration/**/*.test.js"],
      globalSetup: "<rootDir>/tests/integration/globalSetup.js",
      globalTeardown: "<rootDir>/tests/integration/globalTeardown.js",
    },
  ],
};
