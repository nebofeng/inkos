import { describe, expect, it } from "vitest";
import { buildSelector } from "./annotation-anchors.js";
import { createNote } from "./annotation-store.js";
import {
  applyAcceptedPatches,
  matchPatchesToNotes,
  notesToAuditIssues,
  overlappingPatchIds,
} from "./note-revise.js";

const SOURCE = `# 夜雨

门口的灯灭了。她没有回头。
巷口的风还在吹。
`;

function noteAt(exact: string, comment: string) {
  const start = SOURCE.indexOf(exact);
  return createNote({
    bookId: "demo",
    chapterNumber: 1,
    source: SOURCE,
    selector: buildSelector(SOURCE, start, start + exact.length),
    comment,
  });
}

describe("note-revise matching", () => {
  it("maps TARGET_TEXT back to annotationId and keeps unmatched leftovers", () => {
    const a = noteAt("门口的灯灭了。", "语气再冷");
    const b = noteAt("巷口的风还在吹。", "加一点声音");
    const { patches, unmatched } = matchPatchesToNotes(SOURCE, [a, b], [
      { targetText: "门口的灯灭了。", replacementText: "门口的灯早就灭了。" },
    ]);
    expect(patches).toEqual([
      {
        noteId: a.id,
        targetText: "门口的灯灭了。",
        replacementText: "门口的灯早就灭了。",
        start: SOURCE.indexOf("门口的灯灭了。"),
        end: SOURCE.indexOf("门口的灯灭了。") + "门口的灯灭了。".length,
      },
    ]);
    expect(unmatched).toEqual([
      { noteId: b.id, targetText: "巷口的风还在吹。", reason: "no-patch" },
    ]);
  });

  it("matches when TARGET_TEXT contains the note exact sentence", () => {
    const a = noteAt("她没有回头。", "再决绝一点");
    const targetText = "门口的灯灭了。她没有回头。";
    const { patches, unmatched } = matchPatchesToNotes(SOURCE, [a], [
      { targetText, replacementText: "门口的灯灭了。她连肩都没转。" },
    ]);
    expect(unmatched).toEqual([]);
    expect(patches[0]?.noteId).toBe(a.id);
    expect(SOURCE.slice(patches[0]!.start, patches[0]!.end)).toBe(targetText);
  });

  it("builds one local issue per note plus the batch constraint", () => {
    const a = noteAt("门口的灯灭了。", "冷");
    const issues = notesToAuditIssues([a]);
    expect(issues[0]?.category).toBe("annotation-batch");
    expect(issues[1]?.description).toContain(a.id);
    expect(issues[1]?.description).toContain("门口的灯灭了。");
  });
});

describe("note-revise apply", () => {
  it("applies from back to front so earlier offsets stay valid", () => {
    const first = "门口的灯灭了。";
    const second = "巷口的风还在吹。";
    const patches = [
      {
        noteId: "a",
        targetText: first,
        replacementText: "门口的灯早就灭了。",
        start: SOURCE.indexOf(first),
        end: SOURCE.indexOf(first) + first.length,
      },
      {
        noteId: "b",
        targetText: second,
        replacementText: "巷口忽然响起脚步。",
        start: SOURCE.indexOf(second),
        end: SOURCE.indexOf(second) + second.length,
      },
    ];
    const { next, applied } = applyAcceptedPatches(SOURCE, patches);
    expect(applied).toHaveLength(2);
    expect(next).toContain("门口的灯早就灭了。");
    expect(next).toContain("巷口忽然响起脚步。");
    expect(next).toContain("她没有回头。");
  });

  it("flags overlapping accepted patches", () => {
    const ids = overlappingPatchIds([
      { noteId: "a", targetText: "ab", replacementText: "x", start: 0, end: 4 },
      { noteId: "b", targetText: "cd", replacementText: "y", start: 2, end: 6 },
    ]);
    expect(ids).toEqual(["a", "b"]);
  });
});
