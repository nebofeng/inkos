import { describe, expect, it } from "vitest";
import { composeRewriteBrief, countRewriteChars } from "./RewriteModal";

describe("RewriteModal helpers", () => {
  it("counts unicode characters", () => {
    expect(countRewriteChars("加快节奏")).toBe(4);
  });

  it("joins presets and free text", () => {
    expect(composeRewriteBrief("保留金手指", ["加快节奏", "心理活动"])).toBe("加快节奏 / 心理活动\n保留金手指");
    expect(composeRewriteBrief("", ["增加描写"])).toBe("增加描写");
    expect(composeRewriteBrief("  only text  ", [])).toBe("only text");
  });
});
