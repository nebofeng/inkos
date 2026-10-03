import { describe, expect, it } from "vitest";
import {
  HOOK_NOTES_MAX_CHARS,
  appendChapterNote,
  applyRuntimeStateDelta,
  type RuntimeStateSnapshot,
} from "../state/state-reducer.js";
import { RuntimeStateDeltaSchema } from "../models/runtime-state.js";

function snapshot(notes: string, lastAdvancedChapter = 12): RuntimeStateSnapshot {
  return {
    manifest: {
      schemaVersion: 2,
      language: "zh",
      lastAppliedChapter: 12,
      projectionVersion: 1,
      migrationWarnings: [],
    },
    currentState: { chapter: 12, facts: [] },
    hooks: {
      hooks: [{
        hookId: "H023",
        startChapter: 12,
        type: "人物/劫引",
        status: "open",
        lastAdvancedChapter,
        expectedPayoff: "马跃的劫引解除",
        notes,
      }],
    },
    chapterSummaries: { rows: [] },
  };
}

function delta(notes: string, lastAdvancedChapter = 13) {
  return RuntimeStateDeltaSchema.parse({
    chapter: 13,
    hookOps: {
      upsert: [{
        hookId: "H023",
        startChapter: 12,
        type: "人物/劫引",
        status: "progressing",
        lastAdvancedChapter,
        expectedPayoff: "马跃的劫引解除",
        notes,
      }],
    },
  });
}

const OLD_LONG_NOTE = "外卖员马跃误喝试药摊的药水，被劫引缠上；他自己毫不知情，揣着卡乐呵呵走开，金丹劫的日子落在十七日子时。";

describe("hook note merging", () => {
  it("records the new note when the hook advanced, even if the old note was longer", () => {
    const next = applyRuntimeStateDelta({ snapshot: snapshot(OLD_LONG_NOTE), delta: delta("马跃已离场交顾晴") });
    const hook = next.hooks.hooks[0]!;
    expect(hook.status).toBe("progressing");
    expect(hook.lastAdvancedChapter).toBe(13);
    expect(hook.notes).toBe(`${OLD_LONG_NOTE}；第13章：马跃已离场交顾晴`);
  });

  it("rewrites 本章 into the concrete chapter number", () => {
    const next = applyRuntimeStateDelta({ snapshot: snapshot("旧备注"), delta: delta("本章马跃离场，本章未降金丹") });
    expect(next.hooks.hooks[0]!.notes).toBe("旧备注；第13章：马跃离场，第13章未降金丹");
  });

  it("keeps the richer-text rule when the hook did not advance", () => {
    const next = applyRuntimeStateDelta({
      snapshot: snapshot(OLD_LONG_NOTE, 13),
      delta: delta("短备注", 13),
    });
    expect(next.hooks.hooks[0]!.notes).toBe(OLD_LONG_NOTE);
  });

  it("does not duplicate a note that is already recorded", () => {
    expect(appendChapterNote("旧；第13章：已记下", "第13章：已记下", 13)).toBe("旧；第13章：已记下");
    expect(appendChapterNote("旧", "旧；第13章：模型自己累积", 13)).toBe("旧；第13章：模型自己累积");
  });

  it("caps the cell by dropping the oldest chapter entries but keeps the seed description", () => {
    let notes = "种子：马跃的劫引";
    for (let chapter = 13; chapter <= 40; chapter += 1) {
      notes = appendChapterNote(notes, `推进内容推进内容推进内容推进内容-${chapter}`, chapter);
    }
    expect(notes.length).toBeLessThanOrEqual(HOOK_NOTES_MAX_CHARS);
    expect(notes.startsWith("种子：马跃的劫引；")).toBe(true);
    expect(notes.endsWith("第40章：推进内容推进内容推进内容推进内容-40")).toBe(true);
    expect(notes).not.toContain("第13章：");
  });

  it("truncates an oversized single note", () => {
    const capped = appendChapterNote("", "很".repeat(1000), 13);
    expect(capped.length).toBe(HOOK_NOTES_MAX_CHARS);
    expect(capped.startsWith("第13章：")).toBe(true);
  });
});

describe("chapter stamping", () => {
  it("does not double-stamp notes that already start with a chapter number", () => {
    expect(appendChapterNote("旧", "第13章马跃离场", 13)).toBe("旧；第13章马跃离场");
  });
});
