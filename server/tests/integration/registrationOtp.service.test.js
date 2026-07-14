const { knex, resetDb } = require("../helpers/db");
const registrationOtpService = require("../../src/services/registrationOtp.service");
const pendingRegistrationService = require("../../src/services/pendingRegistration.service");
const otpCode = require("../../src/utils/otpCode");
const env = require("../../src/config/env");

beforeEach(resetDb);
afterAll(() => knex.destroy());
afterEach(() => jest.restoreAllMocks());

function mockCode(...codes) {
  const spy = jest.spyOn(otpCode, "generateNumericCode");
  codes.forEach((c) => spy.mockImplementationOnce(() => c));
  return spy;
}

async function createPending(overrides = {}) {
  return pendingRegistrationService.createPendingRegistration({
    email: overrides.email || `pending_${Date.now()}_${Math.random().toString(36).slice(2)}@test.harth`,
    phone: overrides.phone,
    password: "password123",
    name: "Registration Otp Tester",
    role: "renter",
  });
}

describe("registrationOtp.service", () => {
  test("issueRegistrationOtp stores a bcrypt hash, never the plaintext code", async () => {
    mockCode("123456");
    const pending = await createPending({ email: "hash-check@test.harth" });

    await registrationOtpService.issueRegistrationOtp({
      email: "hash-check@test.harth",
      pendingRegistrationId: pending.id,
    });

    const row = await knex("registration_verifications")
      .where({ pending_registration_id: pending.id })
      .first();
    expect(row.code_hash).not.toBe("123456");
    expect(row.code_hash.startsWith("$2")).toBe(true);
  });

  test("verifyRegistrationOtp succeeds with the right code and hard-deletes the row", async () => {
    mockCode("111111");
    const pending = await createPending({ email: "delete-check@test.harth" });
    await registrationOtpService.issueRegistrationOtp({
      email: "delete-check@test.harth",
      pendingRegistrationId: pending.id,
    });

    await registrationOtpService.verifyRegistrationOtp({
      email: "delete-check@test.harth",
      code: "111111",
      pendingRegistrationId: pending.id,
    });

    // Hard delete, not a soft "consumed_at" mark — the row must be gone.
    const row = await knex("registration_verifications")
      .where({ pending_registration_id: pending.id })
      .first();
    expect(row).toBeUndefined();

    // Replaying the same code fails since there's nothing left to match.
    await expect(
      registrationOtpService.verifyRegistrationOtp({
        email: "delete-check@test.harth",
        code: "111111",
        pendingRegistrationId: pending.id,
      }),
    ).rejects.toThrow();
  });

  test("verifyRegistrationOtp rejects a wrong code and locks out after REGISTRATION_OTP_MAX_ATTEMPTS", async () => {
    mockCode("222222");
    const pending = await createPending({ email: "lockout-check@test.harth" });
    await registrationOtpService.issueRegistrationOtp({
      email: "lockout-check@test.harth",
      pendingRegistrationId: pending.id,
    });

    const attempt = () =>
      registrationOtpService.verifyRegistrationOtp({
        email: "lockout-check@test.harth",
        code: "000000",
        pendingRegistrationId: pending.id,
      });

    for (let i = 0; i < env.REGISTRATION_OTP_MAX_ATTEMPTS - 1; i++) {
      await expect(attempt()).rejects.toThrow();
    }
    await expect(attempt()).rejects.toMatchObject({ statusCode: 429 });

    // Even the correct code fails now — attempts are exhausted.
    await expect(
      registrationOtpService.verifyRegistrationOtp({
        email: "lockout-check@test.harth",
        code: "222222",
        pendingRegistrationId: pending.id,
      }),
    ).rejects.toThrow();
  });

  test("verifyRegistrationOtp rejects an expired code", async () => {
    mockCode("333333");
    const pending = await createPending({ email: "expiry-check@test.harth" });
    await registrationOtpService.issueRegistrationOtp({
      email: "expiry-check@test.harth",
      pendingRegistrationId: pending.id,
    });
    await knex("registration_verifications")
      .where({ pending_registration_id: pending.id })
      .update({ expires_at: knex.raw("now() - interval '1 minute'") });

    await expect(
      registrationOtpService.verifyRegistrationOtp({
        email: "expiry-check@test.harth",
        code: "333333",
        pendingRegistrationId: pending.id,
      }),
    ).rejects.toThrow();
  });

  test("issuing a new code invalidates the previous live code", async () => {
    mockCode("444444", "555555");
    const pending = await createPending({ email: "reissue-check@test.harth" });
    await registrationOtpService.issueRegistrationOtp({
      email: "reissue-check@test.harth",
      pendingRegistrationId: pending.id,
    });
    await registrationOtpService.issueRegistrationOtp({
      email: "reissue-check@test.harth",
      pendingRegistrationId: pending.id,
    });

    await expect(
      registrationOtpService.verifyRegistrationOtp({
        email: "reissue-check@test.harth",
        code: "444444",
        pendingRegistrationId: pending.id,
      }),
    ).rejects.toThrow();

    await expect(
      registrationOtpService.verifyRegistrationOtp({
        email: "reissue-check@test.harth",
        code: "555555",
        pendingRegistrationId: pending.id,
      }),
    ).resolves.toBeTruthy();
  });

  test("a code issued for one pending registration cannot verify a different one", async () => {
    mockCode("666666", "777777");
    const pendingA = await createPending({ email: "scope-a@test.harth" });
    const pendingB = await createPending({ email: "scope-b@test.harth" });
    await registrationOtpService.issueRegistrationOtp({
      email: "scope-a@test.harth",
      pendingRegistrationId: pendingA.id,
    });
    await registrationOtpService.issueRegistrationOtp({
      email: "scope-b@test.harth",
      pendingRegistrationId: pendingB.id,
    });

    await expect(
      registrationOtpService.verifyRegistrationOtp({
        email: "scope-a@test.harth",
        code: "666666",
        pendingRegistrationId: pendingB.id,
      }),
    ).rejects.toThrow();
  });
});
