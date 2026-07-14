const { knex, resetDb } = require("../helpers/db");
const pendingRegistrationService = require("../../src/services/pendingRegistration.service");

beforeEach(resetDb);
afterAll(() => knex.destroy());

const base = {
  email: "new-user@test.harth",
  phone: "+96891111111",
  password: "password123",
  name: "New User",
  role: "renter",
};

describe("pendingRegistration.service", () => {
  test("hashes the password rather than storing it in plaintext", async () => {
    const pending = await pendingRegistrationService.createPendingRegistration(base);
    const row = await knex("pending_registrations").where({ id: pending.id }).first();
    expect(row.password_hash).not.toBe(base.password);
    expect(row.password_hash.startsWith("$2")).toBe(true);
  });

  test("stores phone as optional, unverified contact info without any dedupe check on it", async () => {
    // Two different registrants sharing the same (unverified) phone number
    // must both be allowed to create pending registrations — phone is no
    // longer the identity/verification channel, email is.
    const first = await pendingRegistrationService.createPendingRegistration(base);
    const second = await pendingRegistrationService.createPendingRegistration({
      ...base,
      email: "another-user@test.harth",
    });
    expect(first.id).not.toBe(second.id);
  });

  test("allows registering with no phone at all", async () => {
    const { phone: _phone, ...noPhone } = base;
    const pending = await pendingRegistrationService.createPendingRegistration(noPhone);
    const row = await knex("pending_registrations").where({ id: pending.id }).first();
    expect(row.phone).toBeNull();
  });

  test("rejects when the email already belongs to a real user", async () => {
    await knex("users").insert({
      email: base.email,
      phone: "+96892222222",
      password_hash: "x",
      role: "renter",
      name: "X",
      referral_code: "ABCDEFGH",
      account_status: "approved",
      email_verified: true,
    });

    await expect(pendingRegistrationService.createPendingRegistration(base)).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  test("a second attempt for the same email supersedes the first pending row", async () => {
    const first = await pendingRegistrationService.createPendingRegistration(base);
    const second = await pendingRegistrationService.createPendingRegistration(base);

    const firstRow = await knex("pending_registrations").where({ id: first.id }).first();
    expect(firstRow.consumed_at).not.toBeNull();

    await expect(pendingRegistrationService.getLivePendingRegistration(first.id)).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(
      pendingRegistrationService.getLivePendingRegistration(second.id),
    ).resolves.toMatchObject({ id: second.id });
  });

  test("getLivePendingRegistration 404s for an unknown id", async () => {
    await expect(
      pendingRegistrationService.getLivePendingRegistration("00000000-0000-0000-0000-000000000000"),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  test("getLivePendingRegistration 404s once consumed", async () => {
    const pending = await pendingRegistrationService.createPendingRegistration(base);
    await pendingRegistrationService.consumePendingRegistration(pending.id);
    await expect(
      pendingRegistrationService.getLivePendingRegistration(pending.id),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});
