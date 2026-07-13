// Deliberately does NOT mock otpRateLimit — this is the one file that
// exercises the real limiter. Kept to a single test so no other request in
// this process shares (and pollutes) the in-memory rate-limit bucket.
const request = require("supertest");
const app = require("../helpers/app");
const { knex, resetDb, createTestUser } = require("../helpers/db");
const { signToken } = require("../../src/utils/jwt");

beforeEach(resetDb);
afterAll(() => knex.destroy());

describe("otpRateLimit", () => {
  test("resend is rate-limited after 3 requests within the window (max 3 per 5 minutes)", async () => {
    const id = await createTestUser({ phone: "+96899000000" });
    const token = signToken({ id, role: "renter" });

    const results = [];
    for (let i = 0; i < 4; i++) {
      const res = await request(app)
        .post("/api/v1/phone/resend-otp")
        .set("Authorization", `Bearer ${token}`);
      results.push(res.status);
    }

    expect(results.slice(0, 3)).toEqual([200, 200, 200]);
    expect(results[3]).toBe(429);
  });
});
