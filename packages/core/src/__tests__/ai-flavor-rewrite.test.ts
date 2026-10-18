import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  assertUnflaggedParagraphsUnchanged,
  buildLocalRewritePrompt,
  extractGlossaryFromBookDir,
  glossaryTermsMissing,
  mergeParagraphs,
  parseLocalRewrite,
  rewriteFlaggedParagraphs,
  splitParagraphs,
} from "../ai-flavor/index.js";

const ORIGINAL = [
  "他随即伫立在原地，眼眸宛如古井。",
  "",
  "「你到底想怎样？」她问。",
  "",
  "这一刻他知道命运齿轮已经咬合，无论前方如何，他都会一往无前。嘴角勾起一抹冷笑。",
  "",
  "短。",
  "",
].join("\n");

describe("deai local parse/merge", () => {
  it("parses [P#] lines and ignores non-targets", () => {
    const parsed = parseLocalRewrite(
      [
        "说明文字",
        "[P1] 他站着没动。",
        "[P3] 他没再说那些空话。",
        "[P9] 越界应丢弃",
        "[P2] 不该改的对话",
      ].join("\n"),
      [0, 2],
    );
    expect([...parsed.entries()]).toEqual([
      [0, "他站着没动。"],
      [2, "他没再说那些空话。"],
    ]);
  });

  it("merges by paragraph index and keeps blank lines", () => {
    const merged = mergeParagraphs(ORIGINAL, new Map([[0, "他站着没动。"]]));
    expect(merged.split("\n")[0]).toBe("他站着没动。");
    expect(merged.split("\n")[2]).toBe("「你到底想怎样？」她问。");
    expect(merged).toContain("\n\n");
  });
});

describe("rewriteFlaggedParagraphs", () => {
  it("keeps unflagged paragraphs byte-identical", async () => {
    const result = await rewriteFlaggedParagraphs({
      text: ORIGINAL,
      llm: {
        complete: async () => "[P1] 他站着没动，手还插在口袋里。\n[P3] 他没再讲命运，只把刀收回鞘。",
      },
    });
    expect(result.flaggedParagraphs).toEqual([0, 2]);
    expect(result.changedIndices).toEqual([0, 2]);
    assertUnflaggedParagraphsUnchanged(ORIGINAL, result.merged, result.flaggedParagraphs);
    const after = splitParagraphs(result.merged);
    expect(after[1]).toBe("「你到底想怎样？」她问。");
    expect(after[3]).toBe("短。");
    expect(result.after.score).toBeLessThanOrEqual(result.before.score);
  });

  it("keeps original when the model omits a flagged paragraph", async () => {
    const result = await rewriteFlaggedParagraphs({
      text: ORIGINAL,
      llm: { complete: async () => "[P1] 他站着没动。" },
    });
    expect(result.changedIndices).toEqual([0]);
    expect(result.skippedIndices).toEqual([2]);
    expect(splitParagraphs(result.merged)[2]).toBe(splitParagraphs(ORIGINAL)[2]);
  });

  it("reverts a paragraph when a glossary term disappears", async () => {
    const result = await rewriteFlaggedParagraphs({
      text: ORIGINAL,
      glossary: ["陆鸣"],
      llm: {
        complete: async () => "[P1] 陆鸣还站着。\n[P3] 那人把刀收回鞘。",
      },
    });
    // Original flagged paragraphs do not contain 陆鸣, so no revert from that term.
    const withName = ORIGINAL.replace("他随即伫立在原地，眼眸宛如古井。", "陆鸣随即伫立在原地，眼眸宛如古井。");
    const named = await rewriteFlaggedParagraphs({
      text: withName,
      glossary: ["陆鸣"],
      llm: {
        complete: async () => "[P1] 那人还站着。\n[P3] 他把刀收回鞘。",
      },
    });
    expect(named.revertedIndices).toContain(0);
    expect(splitParagraphs(named.merged)[0]).toContain("陆鸣");
    expect(result.revertedIndices).toEqual([]);
  });

  it("returns original text when nothing is flagged", async () => {
    const llm = { complete: vi.fn(async () => "[P1] x") };
    const text = "「走。」她说。\n他点头。";
    const result = await rewriteFlaggedParagraphs({ text, llm });
    expect(llm.complete).not.toHaveBeenCalled();
    expect(result.merged).toBe(text);
    expect(result.changedIndices).toEqual([]);
  });

  it("keeps original on LLM failure", async () => {
    const result = await rewriteFlaggedParagraphs({
      text: ORIGINAL,
      llm: {
        complete: async () => {
          throw new Error("boom");
        },
      },
    });
    expect(result.merged).toBe(ORIGINAL);
    expect(result.changedIndices).toEqual([]);
    expect(result.skippedIndices).toEqual(result.flaggedParagraphs);
  });
});

describe("glossary extraction", () => {
  it("pulls names from roles and character_matrix, capped at 80", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-gloss-"));
    const bookDir = join(root, "book");
    await mkdir(join(bookDir, "story", "roles", "主要角色"), { recursive: true });
    await writeFile(join(bookDir, "story", "roles", "主要角色", "陆鸣.md"), "## 核心标签\n预报员\n", "utf-8");
    await writeFile(join(bookDir, "story", "roles", "主要角色", "顾晴.md"), "剑修\n", "utf-8");
    await writeFile(
      join(bookDir, "story", "character_matrix.md"),
      "## 宋长庚\n- **关系**: 九九(契约) | 王秀兰(房东)\n",
      "utf-8",
    );
    await writeFile(join(bookDir, "story", "story_bible.md"), "他在【澜城】报备。\n", "utf-8");
    const names = await extractGlossaryFromBookDir(bookDir);
    expect(names).toEqual(expect.arrayContaining(["陆鸣", "顾晴", "宋长庚", "九九", "王秀兰", "澜城"]));
    expect(names).not.toContain("核心标签");
    expect(names.length).toBeLessThanOrEqual(80);
  });

  it("detects missing glossary terms", () => {
    expect(glossaryTermsMissing("陆鸣去了澜城", "那人出了城", ["陆鸣", "澜城"])).toEqual(["陆鸣", "澜城"]);
    expect(glossaryTermsMissing("陆鸣去了澜城", "陆鸣还在澜城", ["陆鸣", "澜城"])).toEqual([]);
  });
});

describe("local rewrite prompt", () => {
  it("numbers flagged paragraphs and marks neighbors read-only", () => {
    const prompt = buildLocalRewritePrompt(
      ["改成大白话"],
      ["A段书面词宛如伫立", "B对话", "C段他知道命运"],
      [0, 2],
      ["陆鸣"],
    );
    expect(prompt).toContain("[P1] A段书面词宛如伫立");
    expect(prompt).toContain("[P3] C段他知道命运");
    expect(prompt).toContain("P2：B对话");
    expect(prompt).toContain("陆鸣");
    expect(prompt).not.toContain("[P2] B对话");
  });
});
