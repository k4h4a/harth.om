// Deliberately does NOT mock otpRateLimit — this is the one file that
// exercises the real limiter. Kept to a single test so no other request in
// this process shares (and pollutes) the in-memory rate-limit bucket.
const request = require("supertest");
const app = require("../helpers/app");
const { knex, resetDb } = require("../helpers/db");
const pendingRegistrationService = require("../../src/services/pendingRegistration.service");

beforeEach(resetDb);
afterAll(() => knex.destroy());

describe("otpRateLimit", () => {
  test("register/resend is rate-limited after 3 requests within the window (max 3 per 5 minutes)", async () => {
    const pending = await pendingRegistrationService.createPendingRegistration({
      email: "rate-limit@test.harth",
      password: "password123",
      name: "Rate Limit Tester",
      role: "renter",
    });

    const results = [];
    for (let i = 0; i < 4; i++) {
      const res = await request(app)
        .post("/api/v1/auth/register/resend")
        .send({ pending_registration_id: pending.id });
      results.push(res.status);
    }

    expect(results.slice(0, 3)).toEqual([200, 200, 200]);
    expect(results[3]).toBe(429);
  });
});
