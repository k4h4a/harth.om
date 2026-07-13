// Rate limiting has its own dedicated test (otpRateLimit.test.js) — mocked
// out here so this file's many sequential requests (all from the same IP,
// sharing the limiter's in-memory bucket) don't spuriously 429 into each
// other and obscure the actual behavior under test.
jest.mock("../../src/middleware/otpRateLimit", () => ({
  otpLimiter: (req, res, next) => next(),
  resendLimiter: (req, res, next) => next(),
}));

const request = require("supertest");
const app = require("../helpers/app");
const { knex, resetDb } = require("../helpers/db");
const otpCode = require("../../src/utils/otpCode");

beforeEach(resetDb);
afterAll(() => knex.destroy());
afterEach(() => jest.restoreAllMocks());

function mockCode(code) {
  jest.spyOn(otpCode, "generateNumericCode").mockReturnValue(code);
}

const registrant = {
  email: "flow@test.harth",
  password: "password123",
  name: "Flow Tester",
  role: "renter",
  phone: "+96893333333",
};

describe("deferred registration flow (POST /auth/register/init|verify|resend)", () => {
  test("init does not create a users row", async () => {
    mockCode("123456");
    const res = await request(app).post("/api/v1/auth/register/init").send(registrant);

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.pending_registration_id).toBeTruthy();

    const user = await knex("users").where({ email: registrant.email }).first();
    expect(user).toBeUndefined();
  });

  test("verify with the wrong code fails and still creates no account", async () => {
    mockCode("123456");
    const init = await request(app).post("/api/v1/auth/register/init").send(registrant);

    const res = await request(app).post("/api/v1/auth/register/verify").send({
      pending_registration_id: init.body.pending_registration_id,
      code: "000000",
    });

    expect(res.status).toBe(400);
    const user = await knex("users").where({ email: registrant.email }).first();
    expect(user).toBeUndefined();
  });

  test("verify with the correct code creates the account, phone_verified=true, and returns a token", async () => {
    mockCode("654321");
    const init = await request(app).post("/api/v1/auth/register/init").send(registrant);

    const res = await request(app).post("/api/v1/auth/register/verify").send({
      pending_registration_id: init.body.pending_registration_id,
      code: "654321",
    });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.token).toBeTruthy();
    expect(res.body.user.phone_verified).toBe(true);

    const user = await knex("users").where({ email: registrant.email }).first();
    expect(user).toBeTruthy();
    expect(user.phone).toBe(registrant.phone);

    const pending = await knex("pending_registrations")
      .where({ id: init.body.pending_registration_id })
      .first();
    expect(pending.consumed_at).not.toBeNull();
  });

  test("a duplicate init for a phone that's already a real user is rejected with 409", async () => {
    mockCode("111111");
    const init = await request(app).post("/api/v1/auth/register/init").send(registrant);
    await request(app).post("/api/v1/auth/register/verify").send({
      pending_registration_id: init.body.pending_registration_id,
      code: "111111",
    });

    const res = await request(app).post("/api/v1/auth/register/init").send({
      ...registrant,
      email: "another@test.harth",
    });
    expect(res.status).toBe(409);
  });

  test("resend reissues a working code for the same pending registration", async () => {
    mockCode("222222");
    const init = await request(app).post("/api/v1/auth/register/init").send(registrant);

    mockCode("333333");
    const resend = await request(app)
      .post("/api/v1/auth/register/resend")
      .send({ pending_registration_id: init.body.pending_registration_id });
    expect(resend.status).toBe(200);

    // The old code no longer works...
    const stale = await request(app).post("/api/v1/auth/register/verify").send({
      pending_registration_id: init.body.pending_registration_id,
      code: "222222",
    });
    expect(stale.status).toBe(400);

    // ...but the new one does.
    const fresh = await request(app).post("/api/v1/auth/register/verify").send({
      pending_registration_id: init.body.pending_registration_id,
      code: "333333",
    });
    expect(fresh.status).toBe(201);
  });

  test("validation rejects init without a phone number", async () => {
    const res = await request(app)
      .post("/api/v1/auth/register/init")
      .send({ ...registrant, phone: undefined });
    expect(res.status).toBe(400);
  });
});
