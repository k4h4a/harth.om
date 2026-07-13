// Nothing to tear down globally — each test file closes its own knex
// connection (see tests/helpers/db.js). Present so jest.config.js has a
// symmetric hook to extend later (e.g. dropping the test DB in CI).
module.exports = async function globalTeardown() {};
