jest.mock("../../src/middleware/otpRateLimit", () => ({
  otpLimiter: (req, res, next) => next(),
  resendLimiter: (req, res, next) => next(),
}));

const bcrypt = require("bcrypt");
const request = require("supertest");
const app = require("../helpers/app");
const { knex, resetDb, createTestUser } = require("../helpers/db");
const { signToken } = require("../../src/utils/jwt");
const otpCode = require("../../src/utils/otpCode");

beforeEach(resetDb);
afterAll(() => knex.destroy());
afterEach(() => jest.restoreAllMocks());

const CURRENT_PASSWORD = "correct-horse-battery";

async function authedOwner(overrides) {
  const passwordHash = await bcrypt.hash(CURRENT_PASSWORD, 4);
  const id = await createTestUser({ ...overrides, password_hash: passwordHash });
  const token = signToken({ id, role: "renter" });
  return { id, token };
}

describe("POST /profile/phone/request-change", () => {
  test("rejects a wrong current password with 401", async () => {
    const { token } = await authedOwner({ phone: "+96811111111" });
    const res = await request(app)
      .post("/api/v1/profile/phone/request-change")
      .set("Authorization", `Bearer ${token}`)
      .send({ new_phone: "+96822222222", current_password: "wrong-password" });
    expect(res.status).toBe(401);
  });

  test("rejects a phone number already used by another user with 409", async () => {
    await createTestUser({ phone: "+96833333333" });
    const { token } = await authedOwner({ phone: "+96811111111" });

    const res = await request(app)
      .post("/api/v1/profile/phone/request-change")
      .set("Authorization", `Bearer ${token}`)
      .send({ new_phone: "+96833333333", current_password: CURRENT_PASSWORD });
    expect(res.status).toBe(409);
  });

  test("sends an OTP when the password is correct and the number is free", async () => {
    const { token } = await authedOwner({ phone: "+96811111111" });
    const res = await request(app)
      .post("/api/v1/profile/phone/request-change")
      .set("Authorization", `Bearer ${token}`)
      .send({ new_phone: "+96844444444", current_password: CURRENT_PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

describe("POST /profile/phone/change", () => {
  test("full success path updates users.phone and marks it verified", async () => {
    jest.spyOn(otpCode, "generateNumericCode").mockReturnValue("999999");
    const { id, token } = await authedOwner({ phone: "+96811111111" });

    await request(app)
      .post("/api/v1/profile/phone/request-change")
      .set("Authorization", `Bearer ${token}`)
      .send({ new_phone: "+96855555555", current_password: CURRENT_PASSWORD });

    const res = await request(app)
      .post("/api/v1/profile/phone/change")
      .set("Authorization", `Bearer ${token}`)
      .send({ new_phone: "+96855555555", current_password: CURRENT_PASSWORD, code: "999999" });

    expect(res.status).toBe(200);
    const user = await knex("users").where({ id }).first();
    expect(user.phone).toBe("+96855555555");
    expect(user.phone_verified).toBe(true);
  });

  test("wrong OTP code is rejected and the phone is left unchanged", async () => {
    jest.spyOn(otpCode, "generateNumericCode").mockReturnValue("111222");
    const { id, token } = await authedOwner({ phone: "+96811111111" });

    await request(app)
      .post("/api/v1/profile/phone/request-change")
      .set("Authorization", `Bearer ${token}`)
      .send({ new_phone: "+96866666666", current_password: CURRENT_PASSWORD });

    const res = await request(app)
      .post("/api/v1/profile/phone/change")
      .set("Authorization", `Bearer ${token}`)
      .send({ new_phone: "+96866666666", current_password: CURRENT_PASSWORD, code: "000000" });

    expect(res.status).toBe(400);
    const user = await knex("users").where({ id }).first();
    expect(user.phone).toBe("+96811111111");
  });
});
