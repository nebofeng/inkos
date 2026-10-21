import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildExportArtifact } from "../interaction/export-artifact.js";
import { OpeningHardGateError } from "../opening-check/hard-gate.js";
import { runOpeningCheck } from "../opening-check/runner.js";
import { computePublishEligible } from "../pipeline/publish-eligibility.js";

const SIFA_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../../../../fixtures/sifa");

const SIFA_QUOTE = "斗齿第三次落下，塘埂裂开一道口";
const MA_KUO_QUOTE = "夜里铲斗再来";

const SIFA_FAIL_ITEMS = [
  { id: 1, verdict: "pass", quotes: [SIFA_QUOTE], suggestion: "" },
  { id: 2, verdict: "pass", quotes: [SIFA_QUOTE], suggestion: "" },
  { id: 3, verdict: "pass", quotes: [SIFA_QUOTE], suggestion: "" },
  { id: 4, verdict: "pass", quotes: [SIFA_QUOTE], suggestion: "" },
  { id: 5, verdict: "fail", quotes: [SIFA_QUOTE], suggestion: "必须补金手指" },
  { id: "5a", verdict: "fail", quotes: [SIFA_QUOTE], suggestion: "第1章末给出金手指，并与交不交原片的屈辱挂钩" },
  { id: "5b", verdict: "pass", quotes: [SIFA_QUOTE], suggestion: "" },
  { id: 6, verdict: "pass", quotes: ["十二万，欠谁？"], suggestion: "" },
  { id: 7, verdict: "pass", quotes: [MA_KUO_QUOTE], suggestion: "" },
  { id: 8, verdict: "fail", quotes: [SIFA_QUOTE], suggestion: "无变强回哺" },
];

const SIFA_PASS_ITEMS = SIFA_FAIL_ITEMS.map((item) => (
  item.id === "5a" || item.id === 5 || item.id === 8
    ? { ...item, verdict: "pass" as const, suggestion: "" }
    : item
));

async function seedSifaBook(): Promise<{ bookDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "inkos-sifa-"));
  const bookDir = join(root, "book");
  await mkdir(join(bookDir, "chapters"), { recursive: true });
  await mkdir(join(bookDir, "story"), { recursive: true });
  for (const n of [1, 2, 3]) {
    const body = await readFile(join(SIFA_DIR, `ch0${n}.txt`), "utf-8");
    await writeFile(join(bookDir, "chapters", `000${n}_ch.md`), `# 第${n}章\n\n${body}\n`, "utf-8");
  }
  return { bookDir };
}

function exportState(bookDir: string, hardGate?: boolean) {
  return {
    bookDir: () => bookDir,
    loadBookConfig: async () => ({
      title: "上岸司法所，我把镇霸送进去了",
      language: "zh" as const,
      openingCheck: hardGate === undefined ? undefined : { hardGate },
    }),
    loadChapterIndex: async () => ([
      { number: 1, status: "approved", wordCount: 10, publishEligible: true },
      { number: 2, status: "approved", wordCount: 10, publishEligible: true },
      { number: 3, status: "approved", wordCount: 10, publishEligible: true },
    ]),
    loadProjectConfig: async () => ({ openingCheck: { enabled: true, hardGate: true } }),
  };
}

describe("sifa opening hard gate", () => {
  it("blocks export and publishEligible when 司法所 has no gold finger", async () => {
    const { bookDir } = await seedSifaBook();
    const result = await runOpeningCheck({
      bookId: "sifa",
      bookDir,
      llm: { complete: async () => JSON.stringify({ items: SIFA_FAIL_ITEMS }) },
      binding: { service: "custom", model: "sifa-mock" },
      now: () => "2026-10-21T00:00:00.000Z",
    });

    expect(result.report.hardGate?.passed).toBe(false);
    expect(result.report.hardGate?.blocks.find((block) => block.id === "5a")?.verdict).toBe("fail");
    expect(result.report.hardGate?.blocks.find((block) => block.id === 7)?.verdict).toBe("pass");
    expect(result.report.hardGate?.reason).toContain("无金手指");
    expect(computePublishEligible({
      deslopStatus: "ok",
      detectionPassed: true,
      openingHardGatePassed: result.report.hardGate?.passed,
    })).toBe(false);

    await expect(buildExportArtifact(exportState(bookDir), "sifa", { format: "txt" }))
      .rejects.toBeInstanceOf(OpeningHardGateError);
    try {
      await buildExportArtifact(exportState(bookDir), "sifa", { format: "txt" });
    } catch (error) {
      expect(error).toBeInstanceOf(OpeningHardGateError);
      expect((error as OpeningHardGateError).message).toContain("无金手指");
    }
  });

  it("allows export after hard-gate items pass, even if item 8 still has advice", async () => {
    const { bookDir } = await seedSifaBook();
    const result = await runOpeningCheck({
      bookId: "sifa",
      bookDir,
      llm: { complete: async () => JSON.stringify({ items: SIFA_PASS_ITEMS }) },
      binding: { service: "custom", model: "sifa-mock" },
      persist: true,
    });
    expect(result.report.hardGate?.passed).toBe(true);
    const artifact = await buildExportArtifact(exportState(bookDir), "sifa", { format: "txt" });
    expect(artifact.chaptersExported).toBe(3);
  });

  it("soft gate still reports fail but does not block export", async () => {
    const { bookDir } = await seedSifaBook();
    const result = await runOpeningCheck({
      bookId: "sifa",
      bookDir,
      projectOpeningCheck: { enabled: true, hardGate: false },
      llm: { complete: async () => JSON.stringify({ items: SIFA_FAIL_ITEMS }) },
      binding: { service: "custom", model: "sifa-mock" },
    });
    expect(result.report.hardGate?.mode).toBe("soft");
    expect(result.report.hardGate?.passed).toBe(true);
    expect(result.report.hardGate?.blocks.find((block) => block.id === "5a")?.verdict).toBe("fail");
    const artifact = await buildExportArtifact(exportState(bookDir, false), "sifa", { format: "txt" });
    expect(artifact.chaptersExported).toBe(3);
  });
});
