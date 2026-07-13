const { knex, resetDb, createTestUser } = require("../helpers/db");
const phoneOtpService = require("../../src/services/phoneOtp.service");
const otpCode = require("../../src/utils/otpCode");
const env = require("../../src/config/env");

beforeEach(resetDb);
afterAll(() => knex.destroy());

function mockCode(...codes) {
  const spy = jest.spyOn(otpCode, "generateNumericCode");
  codes.forEach((c) => spy.mockImplementationOnce(() => c));
  return spy;
}

afterEach(() => jest.restoreAllMocks());

describe("phoneOtp.service", () => {
  test("issuePhoneOtp stores a bcrypt hash, never the plaintext code", async () => {
    mockCode("123456");
    const userId = await createTestUser();

    const result = await phoneOtpService.issuePhoneOtp({
      phoneNumber: "+96899999999",
      purpose: "account_verification",
      userId,
    });

    expect(result.otp_length).toBe(env.PHONE_OTP_LENGTH);
    const row = await knex("phone_verifications").where({ user_id: userId }).first();
    expect(row.code_hash).not.toBe("123456");
    expect(row.code_hash.startsWith("$2")).toBe(true);
  });

  test("verifyPhoneOtp succeeds with the right code and consumes it (single use)", async () => {
    mockCode("111111");
    const userId = await createTestUser();
    await phoneOtpService.issuePhoneOtp({
      phoneNumber: "+96899999999",
      purpose: "account_verification",
      userId,
    });

    await phoneOtpService.verifyPhoneOtp({
      phoneNumber: "+96899999999",
      code: "111111",
      purpose: "account_verification",
      userId,
    });

    const row = await knex("phone_verifications").where({ user_id: userId }).first();
    expect(row.consumed_at).not.toBeNull();
    expect(row.verified_at).not.toBeNull();

    // Replaying the same code must fail — it's already consumed.
    await expect(
      phoneOtpService.verifyPhoneOtp({
        phoneNumber: "+96899999999",
        code: "111111",
        purpose: "account_verification",
        userId,
      }),
    ).rejects.toThrow();
  });

  test("verifyPhoneOtp rejects a wrong code and locks out after PHONE_OTP_MAX_ATTEMPTS", async () => {
    mockCode("222222");
    const userId = await createTestUser();
    await phoneOtpService.issuePhoneOtp({
      phoneNumber: "+96899999999",
      purpose: "account_verification",
      userId,
    });

    const attempt = () =>
      phoneOtpService.verifyPhoneOtp({
        phoneNumber: "+96899999999",
        code: "000000",
        purpose: "account_verification",
        userId,
      });

    for (let i = 0; i < env.PHONE_OTP_MAX_ATTEMPTS - 1; i++) {
      await expect(attempt()).rejects.toThrow();
    }
    // The attempt that pushes attempts over the cap gets a 429 lockout.
    await expect(attempt()).rejects.toMatchObject({ statusCode: 429 });

    // Even the correct code fails now — the row is consumed.
    await expect(
      phoneOtpService.verifyPhoneOtp({
        phoneNumber: "+96899999999",
        code: "222222",
        purpose: "account_verification",
        userId,
      }),
    ).rejects.toThrow();
  });

  test("verifyPhoneOtp rejects an expired code", async () => {
    mockCode("333333");
    const userId = await createTestUser();
    await phoneOtpService.issuePhoneOtp({
      phoneNumber: "+96899999999",
      purpose: "account_verification",
      userId,
    });
    await knex("phone_verifications")
      .where({ user_id: userId })
      .update({ expires_at: knex.raw("now() - interval '1 minute'") });

    await expect(
      phoneOtpService.verifyPhoneOtp({
        phoneNumber: "+96899999999",
        code: "333333",
        purpose: "account_verification",
        userId,
      }),
    ).rejects.toThrow();
  });

  test("issuing a new code invalidates the previous live code for the same context", async () => {
    mockCode("444444", "555555");
    const userId = await createTestUser();
    await phoneOtpService.issuePhoneOtp({
      phoneNumber: "+96899999999",
      purpose: "account_verification",
      userId,
    });
    await phoneOtpService.issuePhoneOtp({
      phoneNumber: "+96899999999",
      purpose: "account_verification",
      userId,
    });

    await expect(
      phoneOtpService.verifyPhoneOtp({
        phoneNumber: "+96899999999",
        code: "444444",
        purpose: "account_verification",
        userId,
      }),
    ).rejects.toThrow();

    await expect(
      phoneOtpService.verifyPhoneOtp({
        phoneNumber: "+96899999999",
        code: "555555",
        purpose: "account_verification",
        userId,
      }),
    ).resolves.toBeTruthy();
  });

  test("a code issued for one purpose cannot verify another purpose on the same phone", async () => {
    mockCode("666666");
    const userId = await createTestUser();
    await phoneOtpService.issuePhoneOtp({
      phoneNumber: "+96899999999",
      purpose: "account_verification",
      userId,
    });

    await expect(
      phoneOtpService.verifyPhoneOtp({
        phoneNumber: "+96899999999",
        code: "666666",
        purpose: "phone_change",
        userId,
      }),
    ).rejects.toThrow();
  });
});
