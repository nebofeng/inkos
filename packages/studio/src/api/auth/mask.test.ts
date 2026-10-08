import { describe, expect, it } from "vitest";
import { isMaskedSecret, maskNullableSecret, maskSecret, resolveMaskedSecret } from "./mask.js";

describe("api key masking", () => {
  it("shows only the last 4 characters", () => {
    expect(maskSecret("sk-fake-0000-abcd")).toBe("****abcd");
    expect(maskSecret("sk-fake-0000-abcd")).not.toContain("fake");
  });

  it("reveals nothing for short or empty keys", () => {
    expect(maskSecret("")).toBe("");
    expect(maskSecret(undefined)).toBe("");
    expect(maskSecret("short12")).toBe("****");
    expect(maskNullableSecret("")).toBeNull();
    expect(maskNullableSecret("sk-fake-0000-wxyz")).toBe("****wxyz");
  });

  it("recognises masks but not real keys", () => {
    expect(isMaskedSecret("****abcd")).toBe(true);
    expect(isMaskedSecret("****")).toBe(true);
    expect(isMaskedSecret(" ****abcd ")).toBe(true);
    expect(isMaskedSecret("sk-****abcd")).toBe(false);
    expect(isMaskedSecret("****abcdef")).toBe(false);
    expect(isMaskedSecret("********")).toBe(false);
    expect(isMaskedSecret(null)).toBe(false);
  });

  it("a masked value resolves to the stored key; a new value wins", () => {
    const stored = "sk-fake-stored-key-9876";
    expect(resolveMaskedSecret(maskSecret(stored), stored)).toEqual({ kind: "stored", value: stored });
    expect(resolveMaskedSecret("sk-fake-new-key-1111", stored)).toEqual({ kind: "value", value: "sk-fake-new-key-1111" });
    expect(resolveMaskedSecret("  ", stored)).toEqual({ kind: "value", value: "" });
  });

  it("a mask that does not match the stored key is not silently accepted", () => {
    expect(resolveMaskedSecret("****9876", undefined)).toEqual({ kind: "missing-stored" });
    expect(resolveMaskedSecret("****0000", "sk-fake-stored-key-9876")).toEqual({ kind: "missing-stored" });
  });
});
