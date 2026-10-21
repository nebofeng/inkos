import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  applyQuoteVerification,
  evidenceSupported,
  fillChecklistItems,
  findBackgroundDumpSpans,
  parseOpeningCheckResponse,
  resolveOpeningCheckEnabled,
  resolveOpeningCheckHardGate,
  evaluateOpeningHardGate,
  deriveHardGateItems,
  runOpeningCheck,
  stripPunctuation,
} from "../opening-check/index.js";

const BODY = [
  "陆鸣推开观测场的铁门，风把工牌拍在胸口。",
  "顾晴说：“你的编制还没下来。”",
  "陆鸣回：“那我先报这波红色预警。”",
  "宋长庚在门口抽烟，没说话。",
].join("\n");

async function seedBook(bodies: string[] = [BODY, BODY, BODY]): Promise<{ bookDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "inkos-opening-"));
  const bookDir = join(root, "book");
  await mkdir(join(bookDir, "chapters"), { recursive: true });
  await mkdir(join(bookDir, "story"), { recursive: true });
  for (const [index, body] of bodies.entries()) {
    const n = String(index + 1).padStart(4, "0");
    await writeFile(join(bookDir, "chapters", `${n}_ch.md`), `# 第${index + 1}章\n\n${body}\n`, "utf-8");
  }
  return { bookDir };
}

describe("opening-check JSON parse", () => {
  it("accepts fenced JSON and Chinese verdicts", () => {
    const raw = [
      "```json",
      JSON.stringify({
        items: [
          { id: 1, verdict: "通过", quotes: ["陆鸣推开观测场的铁门"], suggestion: "加情绪" },
          { id: "2", result: "fail", evidence: "顾晴说：“你的编制还没下来。”", suggestion: "开场再镜头一点" },
        ],
      }),
      "```",
    ].join("\n");
    const parsed = parseOpeningCheckResponse(raw);
    expect(parsed).toEqual([
      { id: 1, verdict: "pass", quotes: ["陆鸣推开观测场的铁门"], suggestion: "加情绪" },
      { id: 2, verdict: "fail", quotes: ["顾晴说：“你的编制还没下来。”"], suggestion: "开场再镜头一点" },
    ]);
  });

  it("tolerates surrounding prose and missing items", () => {
    const raw = '说明如下。{"items":[{"id":3,"verdict":"pass","quotes":["宋长庚在门口抽烟"],"suggestion":""}]} 完。';
    const parsed = parseOpeningCheckResponse(raw);
    const filled = fillChecklistItems(parsed);
    expect(filled.filter((item) => typeof item.id === "number")).toHaveLength(8);
    expect(filled.find((item) => item.id === "5a")?.verdict).toBe("unverified");
    expect(filled[2]?.verdict).toBe("pass");
    expect(filled[0]?.verdict).toBe("unverified");
    expect(filled[0]?.suggestion).toContain("未返回");
  });

  it("returns empty parse on garbage without throwing", () => {
    expect(parseOpeningCheckResponse("不是 JSON")).toEqual([]);
    expect(parseOpeningCheckResponse("")).toEqual([]);
  });
});

describe("opening-check quote verification", () => {
  it("accepts punctuation-stripped whole-quote hits", () => {
    expect(stripPunctuation("陆鸣，推开！")).toBe("陆鸣推开");
    expect(evidenceSupported("陆鸣，推开观测场的铁门。", BODY)).toBe(true);
  });

  it("accepts 6-char slice majority hits and rejects unrelated quotes", () => {
    expect(evidenceSupported("陆鸣推开观测场的铁门风把工牌拍在胸口顾晴说", BODY)).toBe(true);
    expect(evidenceSupported("这是完全编造的一句不存在的话啊", BODY)).toBe(false);
  });

  it("downgrades verdict to unverified when every quote misses", () => {
    const items = applyQuoteVerification(
      fillChecklistItems([
        { id: 1, verdict: "fail", quotes: ["完全没有的句子"], suggestion: "改" },
        { id: 2, verdict: "pass", quotes: ["陆鸣推开观测场的铁门"], suggestion: "" },
      ]),
      BODY,
      evidenceSupported,
    );
    expect(items[0]?.verdict).toBe("unverified");
    expect(items[0]?.quoteChecks[0]?.verified).toBe(false);
    expect(items[1]?.verdict).toBe("pass");
    expect(items[1]?.quoteChecks[0]?.verified).toBe(true);
  });
});

describe("opening-check background dump", () => {
  it("flags consecutive no-dialogue narrative over 300 chars", () => {
    const dump = "澜城的天劫气象台成立于某年某月，专门负责把云图画成公文。".repeat(12);
    const dialogue = "顾晴说：“别念了。”";
    const spans = findBackgroundDumpSpans([
      { number: 1, body: `${dump}\n${dialogue}\n他又点头。` },
    ]);
    expect(spans.length).toBe(1);
    expect(spans[0]?.chapterNumber).toBe(1);
    expect(spans[0]!.charCount).toBeGreaterThan(300);
  });

  it("does not flag dialogue-broken short narrative", () => {
    const spans = findBackgroundDumpSpans([{ number: 1, body: BODY }]);
    expect(spans).toEqual([]);
  });
});

describe("opening-check enabled flag", () => {
  it("lets book override project, defaulting to enabled", () => {
    expect(resolveOpeningCheckEnabled()).toBe(true);
    expect(resolveOpeningCheckEnabled({ enabled: true }, { enabled: false })).toBe(false);
    expect(resolveOpeningCheckEnabled({ enabled: false }, { enabled: true })).toBe(true);
    expect(resolveOpeningCheckEnabled({ enabled: false })).toBe(false);
  });

  it("lets book override hardGate, defaulting to on", () => {
    expect(resolveOpeningCheckHardGate()).toBe(true);
    expect(resolveOpeningCheckHardGate({ hardGate: true }, { hardGate: false })).toBe(false);
    expect(resolveOpeningCheckHardGate({ hardGate: false }, { hardGate: true })).toBe(true);
  });
});

describe("opening hard gate", () => {
  it("splits gold-finger vs 500-word hook", () => {
    const items = deriveHardGateItems(fillChecklistItems([
      { id: "5a", verdict: "pass", quotes: ["陆鸣推开观测场的铁门"], suggestion: "" },
      { id: "5b", verdict: "fail", quotes: ["陆鸣推开观测场的铁门"], suggestion: "黄金500字内给钩" },
      { id: 7, verdict: "pass", quotes: ["顾晴说：“你的编制还没下来。”"], suggestion: "" },
    ]));
    const evaluation = evaluateOpeningHardGate({ items }, { enabled: true, hardGate: true });
    expect(items.find((item) => item.id === 5)?.verdict).toBe("fail");
    expect(evaluation.passed).toBe(false);
    expect(evaluation.blocks.find((block) => block.id === "5a")?.verdict).toBe("pass");
    expect(evaluation.blocks.find((block) => block.id === "5b")?.verdict).toBe("fail");
    expect(evaluation.reason).toContain("黄金500字内无钩");
  });

  it("soft gate reports fail but does not block", () => {
    const items = fillChecklistItems([
      { id: "5a", verdict: "fail", quotes: ["陆鸣推开观测场的铁门"], suggestion: "补金手指" },
      { id: "5b", verdict: "pass", quotes: ["陆鸣推开观测场的铁门"], suggestion: "" },
      { id: 7, verdict: "pass", quotes: ["顾晴说：“你的编制还没下来。”"], suggestion: "" },
    ]);
    const evaluation = evaluateOpeningHardGate({ items }, { enabled: true, hardGate: false });
    expect(evaluation.mode).toBe("soft");
    expect(evaluation.passed).toBe(true);
    expect(evaluation.blocks.find((block) => block.id === "5a")?.verdict).toBe("fail");
  });
});

describe("runOpeningCheck", () => {
  it("skips without calling LLM when disabled", async () => {
    const { bookDir } = await seedBook();
    const llm = { complete: vi.fn(async () => "") };
    const result = await runOpeningCheck({
      bookId: "demo",
      bookDir,
      projectOpeningCheck: { enabled: false },
      llm,
      binding: { service: "custom", model: "stub" },
      persist: false,
    });
    expect(result.skipped).toBe(true);
    expect(result.skipReason).toContain("openingCheck.enabled=false");
    expect(llm.complete).not.toHaveBeenCalled();
  });

  it("verifies quotes, injects background fail, and writes report files", async () => {
    const dump = "这座城把天劫写成公务，把飞升写成报备，把人写成表格上的编号。".repeat(14);
    const { bookDir } = await seedBook([
      dump,
      "顾晴说：“编制呢？”\n陆鸣回：“还在流标。”",
      "宋长庚说：“你们别吵。”",
    ]);
    const llm = {
      complete: vi.fn(async () => JSON.stringify({
        items: [
          { id: 1, verdict: "pass", quotes: ["完全编造的引文"], suggestion: "" },
          { id: 2, verdict: "fail", quotes: ["顾晴说：“编制呢？”"], suggestion: "开场加镜头" },
          { id: 3, verdict: "pass", quotes: ["宋长庚说：“你们别吵。”"], suggestion: "" },
          { id: 4, verdict: "pass", quotes: ["陆鸣回：“还在流标。”"], suggestion: "" },
          { id: 5, verdict: "fail", quotes: ["不存在的金手指"], suggestion: "500字内给钩子" },
          { id: 6, verdict: "pass", quotes: ["顾晴说：“编制呢？”"], suggestion: "" },
          { id: 7, verdict: "fail", quotes: ["也不存在的boss"], suggestion: "补小boss" },
          { id: 8, verdict: "pass", quotes: ["宋长庚说：“你们别吵。”"], suggestion: "" },
        ],
      })),
    };

    const result = await runOpeningCheck({
      bookId: "demo",
      bookDir,
      llm,
      binding: { service: "custom", model: "stub-model" },
      now: () => "2026-10-18T00:00:00.000Z",
    });

    expect(result.skipped).toBe(false);
    expect(llm.complete).toHaveBeenCalledOnce();
    const item1 = result.report.items.find((item) => item.id === 1);
    expect(item1?.verdict).toBe("fail");
    expect(item1?.quoteChecks[0]?.verified).toBe(false);
    expect(item1?.backgroundSpans?.length).toBe(1);
    expect(result.report.items.find((item) => item.id === 2)?.verdict).toBe("fail");
    expect(result.report.items.find((item) => item.id === 5)?.verdict).toBe("unverified");
    expect(result.report.binding).toEqual({ service: "custom", model: "stub-model" });

    const json = JSON.parse(await readFile(join(bookDir, "story", "opening-check.json"), "utf-8"));
    expect(json.bookId).toBe("demo");
    expect(json.chapters).toEqual([1, 2, 3]);
    const md = await readFile(join(bookDir, "story", "opening-check.md"), "utf-8");
    expect(md).toContain("开篇检查");
    expect(md).toContain("未核验");
    expect(md).toContain("连续无对话叙述");
  });

  it("reviews fewer than three chapters when that is all the book has", async () => {
    const { bookDir } = await seedBook([BODY]);
    const result = await runOpeningCheck({
      bookId: "demo",
      bookDir,
      llm: {
        complete: async () => JSON.stringify({
          items: OPENING_PASS_ITEMS,
        }),
      },
      binding: { service: "moonshot", model: "kimi" },
      persist: false,
    });
    expect(result.report.chapters).toEqual([1]);
    expect(result.report.items.every((item) => item.verdict === "pass")).toBe(true);
  });
});

const OPENING_PASS_ITEMS = [1, 2, 3, 4, 5, "5a", "5b", 6, 7, 8].map((id) => ({
  id,
  verdict: "pass",
  quotes: ["陆鸣推开观测场的铁门"],
  suggestion: "",
}));
