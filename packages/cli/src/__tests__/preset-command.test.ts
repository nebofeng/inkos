import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProgram } from "../program.js";

const logMock = vi.fn();
const logErrorMock = vi.fn();

vi.mock("../utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils.js")>()),
  log: (message: string) => logMock(message),
  logError: (message: string) => logErrorMock(message),
}));

describe("inkos preset", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.exitCode = undefined;
  });

  it("registers preset list/show on the program", () => {
    const program = createProgram();
    const preset = program.commands.find((command) => command.name() === "preset");
    expect(preset).toBeDefined();
    expect(preset?.commands.map((command) => command.name())).toEqual(["list", "show"]);
  });

  it("lists presets as JSON", async () => {
    const { presetCommand } = await import("../commands/preset.js");
    await presetCommand.parseAsync(["node", "preset", "list", "--json"], { from: "node" });
    expect(logErrorMock).not.toHaveBeenCalled();
    const payload = JSON.parse(logMock.mock.calls.at(-1)?.[0] as string);
    expect(payload.map((row: { id: string }) => row.id)).toEqual([
      "qidian",
      "fanqie",
      "jjwxc",
      "qimao",
      "zhihu-short",
    ]);
  });

  it("shows jinjiang as the jjwxc preset", async () => {
    const { presetCommand } = await import("../commands/preset.js");
    await presetCommand.parseAsync(["node", "preset", "show", "jinjiang", "--json"], { from: "node" });
    expect(logErrorMock).not.toHaveBeenCalled();
    const payload = JSON.parse(logMock.mock.calls.at(-1)?.[0] as string);
    expect(payload.id).toBe("jjwxc");
    expect(payload.promptBlock).toContain("晋江");
  });

  it("errors on an unknown preset id", async () => {
    const { presetCommand } = await import("../commands/preset.js");
    await presetCommand.parseAsync(["node", "preset", "show", "kindle"], { from: "node" });
    expect(process.exitCode).toBe(1);
    expect(logErrorMock.mock.calls.at(-1)?.[0]).toContain("Unknown platform preset: kindle");
  });
});
