import { describe, expect, it } from "vitest";
import { createProgram } from "../program.js";
import { buildAgentLLMOverride } from "../commands/config.js";

describe("config set-model", () => {
  it("exposes --service on set-model", () => {
    const program = createProgram();
    const config = program.commands.find((command) => command.name() === "config");
    const setModel = config?.commands.find((command) => command.name() === "set-model");
    const optionNames = new Set(setModel?.options.map((option) => option.long));
    expect(optionNames).toContain("--service");
  });

  it("writes object override when --service is set", () => {
    expect(buildAgentLLMOverride("gemini-2.5-flash", { service: "google" })).toEqual({
      model: "gemini-2.5-flash",
      service: "google",
    });
  });

  it("keeps string override when no routing fields are set", () => {
    expect(buildAgentLLMOverride("gpt-4o", {})).toBe("gpt-4o");
  });
});
