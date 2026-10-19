import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildSelector } from "./annotation-anchors.js";
import {
  addNote,
  annotationsPath,
  createNote,
  deleteNote,
  getNote,
  listNotes,
  rebaseNotes,
  updateNote,
} from "./annotation-store.js";

const SOURCE = `# 夜雨

门口的灯灭了。她没有回头。
`;

describe("chapter annotation store", () => {
  it("creates, lists, updates and deletes notes in per-chapter JSON", async () => {
    const bookDir = await mkdtemp(join(tmpdir(), "inkos-ann-"));
    const start = SOURCE.indexOf("门口的灯灭了。");
    const selector = buildSelector(SOURCE, start, start + "门口的灯灭了。".length);
    const created = createNote({
      bookId: "demo",
      chapterNumber: 3,
      source: SOURCE,
      selector,
      comment: "  语气再冷一点  ",
    });
    expect(created.comment).toBe("语气再冷一点");
    expect(created.status).toBe("open");

    await addNote(bookDir, 3, created);
    const listed = await listNotes(bookDir, 3, SOURCE);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.id).toBe(created.id);

    const fetched = await getNote(bookDir, 3, created.id);
    expect(fetched?.comment).toBe("语气再冷一点");

    const updated = await updateNote(bookDir, 3, created.id, { comment: "改成更冷" });
    expect(updated?.comment).toBe("改成更冷");

    const raw = await readFile(annotationsPath(bookDir, 3), "utf-8");
    expect(raw).toContain("chapter-0003");
    expect(JSON.parse(raw).notes).toHaveLength(1);

    await expect(deleteNote(bookDir, 3, created.id)).resolves.toBe(true);
    await expect(listNotes(bookDir, 3, SOURCE)).resolves.toEqual([]);
  });

  it("rebases offsets after an insertion and orphans vanished quotes", () => {
    const start = SOURCE.indexOf("门口的灯灭了。");
    const note = createNote({
      bookId: "demo",
      chapterNumber: 1,
      source: SOURCE,
      selector: buildSelector(SOURCE, start, start + "门口的灯灭了。".length),
      comment: "冷",
    });
    const inserted = `序章。\n\n${SOURCE}`;
    const relocated = rebaseNotes(inserted, [note]);
    expect(relocated[0]?.status).toBe("open");
    expect(inserted.slice(relocated[0]!.selector.start, relocated[0]!.selector.end)).toBe("门口的灯灭了。");

    const gone = rebaseNotes(SOURCE.replace("门口的灯灭了。", "天亮了。"), [note]);
    expect(gone[0]?.status).toBe("orphaned");
  });
});
