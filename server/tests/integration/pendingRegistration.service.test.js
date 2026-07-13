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

  test("rejects when the phone already belongs to a real user", async () => {
    await knex("users").insert({
      email: "someone-else@test.harth",
      phone: base.phone,
      password_hash: "x",
      role: "renter",
      name: "X",
      referral_code: "IJKLMNOP",
      account_status: "approved",
      email_verified: true,
    });

    await expect(pendingRegistrationService.createPendingRegistration(base)).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  test("a second attempt for the same phone supersedes the first pending row", async () => {
    const first = await pendingRegistrationService.createPendingRegistration(base);
    const second = await pendingRegistrationService.createPendingRegistration({
      ...base,
      email: "second@test.harth",
    });

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
