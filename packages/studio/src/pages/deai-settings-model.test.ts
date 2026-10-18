import { describe, expect, it } from "vitest";
import {
  buildDeAIConfig,
  deAIDraftFromConfig,
  formatSkillErrors,
  prepareSkillEditorContent,
  skillOptionDisabled,
} from "./deai-settings-model";

describe("deAI settings form model", () => {
  it("prefers stored deAI over effective defaults", () => {
    const draft = deAIDraftFromConfig({
      deAI: { enabled: false, aiFlavorThreshold: 40, onFail: "pause", maxRetries: 3, skill: "custom-deai" },
      effective: { enabled: true, aiFlavorThreshold: 60, onFail: "warn", maxRetries: 1, skill: "inkos-story-deslop" },
    });
    expect(draft).toEqual({
      enabled: false,
      aiFlavorThreshold: 40,
      onFail: "pause",
      maxRetries: 3,
      skill: "custom-deai",
    });
    expect(buildDeAIConfig(draft).aiFlavorThreshold).toBe(40);
  });

  it("disables invalid skills and injects kind when editing a builtin", () => {
    expect(skillOptionDisabled({
      id: "broken",
      source: "project",
      valid: false,
      errors: [{ code: "regex", message: "invalid regex: (" }],
    })).toBe(true);
    expect(formatSkillErrors({
      id: "broken",
      source: "project",
      valid: false,
      errors: [{ code: "regex", message: "invalid regex: (" }],
    })).toContain("invalid regex");

    const content = [
      "---",
      "name: inkos-story-deslop",
      "description: cleanup",
      "---",
      "body",
      "",
    ].join("\n");
    expect(prepareSkillEditorContent(content, "builtin")).toContain("kind: deai");
    expect(prepareSkillEditorContent(content, "project")).not.toContain("kind: deai");
  });
});
