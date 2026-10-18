import { describe, expect, it } from "vitest";
import { hashPassword, isPasswordHash, parsePasswordHash, verifyPassword } from "./password.js";

const FAST = { N: 1024, r: 8, p: 1 } as const;

describe("studio auth password hashing", () => {
  it("produces a $-free scrypt hash that verifies only the right password", async () => {
    const hash = await hashPassword("fake-test-password-1", FAST);
    expect(hash).toMatch(/^scrypt:1024:8:1:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/);
    expect(hash).not.toContain("$");
    expect(hash).not.toContain("fake-test-password-1");
    await expect(verifyPassword("fake-test-password-1", hash)).resolves.toBe(true);
    await expect(verifyPassword("fake-test-password-2", hash)).resolves.toBe(false);
    await expect(verifyPassword("", hash)).resolves.toBe(false);
  });

  it("uses a random salt per hash", async () => {
    const a = await hashPassword("same-password", FAST);
    const b = await hashPassword("same-password", FAST);
    expect(a).not.toBe(b);
  });

  it("default parameters are scrypt N=32768 r=8 p=1", async () => {
    const hash = await hashPassword("fake-default-params");
    expect(parsePasswordHash(hash)).toMatchObject({ N: 32768, r: 8, p: 1 });
    await expect(verifyPassword("fake-default-params", hash)).resolves.toBe(true);
  });

  it("rejects plaintext and malformed hashes without throwing", async () => {
    for (const bad of [
      "",
      "plaintext-password",
      "scrypt:1024:8:1:abc",
      "scrypt:1000:8:1:c2FsdHNhbHQ:aGFzaGhhc2hoYXNoaGFzaA", // N not a power of two
      "scrypt:4194304:8:1:c2FsdHNhbHQ:aGFzaGhhc2hoYXNoaGFzaA", // N too large
      "scrypt:1024:8:1:c2Fs$dA:aGFzaA",
      "$scrypt$ln=15,r=8,p=1$c2FsdA$aGFzaA",
    ]) {
      expect(isPasswordHash(bad)).toBe(false);
      await expect(verifyPassword("anything", bad)).resolves.toBe(false);
    }
  });

  it("refuses to hash an empty password", async () => {
    await expect(hashPassword("", FAST)).rejects.toThrow();
  });
});
