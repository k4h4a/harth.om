const otpCode = require("../../src/utils/otpCode");

describe("utils/otpCode", () => {
  describe("generateNumericCode", () => {
    test("returns a zero-padded numeric string of the requested length", () => {
      for (let i = 0; i < 50; i++) {
        const code = otpCode.generateNumericCode(6);
        expect(code).toMatch(/^\d{6}$/);
      }
    });

    test("supports a 4-digit length", () => {
      const code = otpCode.generateNumericCode(4);
      expect(code).toMatch(/^\d{4}$/);
    });

    test("is not deterministic across calls", () => {
      const codes = new Set(Array.from({ length: 20 }, () => otpCode.generateNumericCode(6)));
      // Astronomically unlikely to collide 20 times in a row for a 6-digit space.
      expect(codes.size).toBeGreaterThan(1);
    });
  });

  describe("hashCode / compareCode", () => {
    test("hashes never equal the plaintext code", async () => {
      const code = "123456";
      const hash = await otpCode.hashCode(code, 4);
      expect(hash).not.toBe(code);
      expect(hash.startsWith("$2")).toBe(true); // bcrypt hash prefix
    });

    test("compareCode returns true only for the matching code", async () => {
      const code = "654321";
      const hash = await otpCode.hashCode(code, 4);
      await expect(otpCode.compareCode(code, hash)).resolves.toBe(true);
      await expect(otpCode.compareCode("000000", hash)).resolves.toBe(false);
    });
  });
});
