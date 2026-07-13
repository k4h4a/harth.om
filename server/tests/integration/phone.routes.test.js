// Rate limiting is covered separately in otpRateLimit.test.js — mocked out
// here so this file's sequential requests don't share a throttling bucket.
jest.mock("../../src/middleware/otpRateLimit", () => ({
  otpLimiter: (req, res, next) => next(),
  resendLimiter: (req, res, next) => next(),
}));

const request = require("supertest");
const app = require("../helpers/app");
const { knex, resetDb, createTestUser } = require("../helpers/db");
const { signToken } = require("../../src/utils/jwt");
const otpCode = require("../../src/utils/otpCode");

beforeEach(resetDb);
afterAll(() => knex.destroy());
afterEach(() => jest.restoreAllMocks());

async function authedUser(overrides) {
  const id = await createTestUser(overrides);
  const token = signToken({ id, role: overrides?.role || "renter" });
  return { id, token };
}

describe("phone routes (verifying the account's own phone)", () => {
  test("GET /phone/status reflects the current verification state", async () => {
    const { token } = await authedUser({ phone: "+96895555555" });
    const res = await request(app).get("/api/v1/phone/status").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.phone).toBe("+96895555555");
    expect(res.body.phone_verified).toBe(false);
  });

  test("send-otp 404s when the account has no phone on file", async () => {
    const { token } = await authedUser({ phone: null });
    const res = await request(app).post("/api/v1/phone/send-otp").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
  });

  test("send-otp 409s when the phone is already verified", async () => {
    const { token } = await authedUser({ phone: "+96896666666", phone_verified: true });
    const res = await request(app).post("/api/v1/phone/send-otp").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(409);
  });

  test("verify-otp with the correct code flips phone_verified to true", async () => {
    jest.spyOn(otpCode, "generateNumericCode").mockReturnValue("777777");
    const { id, token } = await authedUser({ phone: "+96897777777" });

    const sent = await request(app).post("/api/v1/phone/send-otp").set("Authorization", `Bearer ${token}`);
    expect(sent.status).toBe(200);

    const verified = await request(app)
      .post("/api/v1/phone/verify-otp")
      .set("Authorization", `Bearer ${token}`)
      .send({ code: "777777" });
    expect(verified.status).toBe(200);

    const user = await knex("users").where({ id }).first();
    expect(user.phone_verified).toBe(true);
  });

  test("verify-otp with a wrong code fails and leaves phone_verified false", async () => {
    jest.spyOn(otpCode, "generateNumericCode").mockReturnValue("888888");
    const { id, token } = await authedUser({ phone: "+96898888888" });
    await request(app).post("/api/v1/phone/send-otp").set("Authorization", `Bearer ${token}`);

    const res = await request(app)
      .post("/api/v1/phone/verify-otp")
      .set("Authorization", `Bearer ${token}`)
      .send({ code: "000000" });
    expect(res.status).toBe(400);

    const user = await knex("users").where({ id }).first();
    expect(user.phone_verified).toBe(false);
  });

  test("routes require authentication", async () => {
    const res = await request(app).get("/api/v1/phone/status");
    expect(res.status).toBe(401);
  });
});
