import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../errors.js";
import { annotationsPath, sha256Source } from "../lib/annotation-store.js";
import { resetLongTasksForTests } from "../lib/long-task.js";
import { registerAnnotationRoutes } from "./annotations.js";
import { registerLongTaskRoutes } from "./long-tasks.js";
import { registerNoteReviseRoutes, type NoteReviseLlmInput } from "./note-revise.js";

const tmpDirs: string[] = [];

const CHAPTER = `# 夜雨

门口的灯灭了。她没有回头。
巷口的风还在吹。
`;

afterEach(async () => {
  resetLongTasksForTests();
  await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function seedProject(): Promise<{ root: string; bookId: string; bookDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "inkos-studio-note-revise-"));
  tmpDirs.push(root);
  const bookId = "demo";
  const bookDir = join(root, "books", bookId);
  await mkdir(join(bookDir, "chapters"), { recursive: true });
  await mkdir(join(bookDir, "story", "runtime"), { recursive: true });
  await writeFile(join(bookDir, "book.json"), JSON.stringify({
    id: bookId,
    title: "Demo",
    platform: "other",
    genre: "xuanhuan",
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  }, null, 2), "utf-8");
  await writeFile(join(bookDir, "chapters", "0001_night.md"), CHAPTER, "utf-8");
  return { root, bookId, bookDir };
}

function createApp(
  root: string,
  reviseChapter?: Parameters<typeof registerNoteReviseRoutes>[1]["reviseChapter"],
) {
  const app = new Hono();
  app.onError((error, c) => {
    if (error instanceof ApiError) {
      return c.json({ error: { code: error.code, message: error.message } }, error.status as 400);
    }
    const message = error instanceof Error ? error.message : String(error);
    return c.json({ error: { code: "INTERNAL_ERROR", message } }, 500);
  });
  registerAnnotationRoutes(app, { root });
  registerNoteReviseRoutes(app, { root, reviseChapter });
  registerLongTaskRoutes(app);
  return app;
}

async function addNote(app: Hono, bookId: string, exact: string, comment: string): Promise<string> {
  const start = CHAPTER.indexOf(exact);
  const created = await app.request(`/api/v1/books/${bookId}/chapters/1/annotations`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ start, end: start + exact.length, comment }),
  });
  expect(created.status).toBe(201);
  const body = await created.json() as { note: { id: string } };
  return body.note.id;
}

describe("note-revise routes", () => {
  it("returns per-note patches without writing the chapter", async () => {
    const { root, bookId, bookDir } = await seedProject();
    const original = await readFile(join(bookDir, "chapters", "0001_night.md"), "utf-8");
    const noteId = await addNote(createApp(root), bookId, "门口的灯灭了。", "语气再冷");
    const reviseChapter = vi.fn(async (_input: NoteReviseLlmInput) => ({
      patches: [{ targetText: "门口的灯灭了。", replacementText: "门口的灯早就灭了。" }],
    }));
    const app = createApp(root, reviseChapter);

    const res = await app.request(`/api/v1/books/${bookId}/chapters/1/note-revise`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ noteIds: [noteId], baseHash: sha256Source(CHAPTER), taskId: "rev-1" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as {
      patches: Array<{ noteId: string; replacementText: string }>;
      estimateMs: number;
      taskId: string;
      unmatched: unknown[];
    };
    expect(body.taskId).toBe("rev-1");
    expect(body.estimateMs).toBeGreaterThan(0);
    expect(body.patches).toEqual([expect.objectContaining({
      noteId,
      replacementText: "门口的灯早就灭了。",
    })]);
    expect(body.unmatched).toEqual([]);
    expect(await readFile(join(bookDir, "chapters", "0001_night.md"), "utf-8")).toBe(original);
    const stored = JSON.parse(await readFile(annotationsPath(bookDir, 1), "utf-8")) as {
      notes: Array<{ id: string; status: string; suggestion?: { replacementText: string } }>;
    };
    expect(stored.notes[0]?.status).toBe("suggested");
    expect(stored.notes[0]?.suggestion?.replacementText).toBe("门口的灯早就灭了。");
    expect(reviseChapter).toHaveBeenCalledTimes(1);
    const issues = reviseChapter.mock.calls[0]?.[0]?.issues ?? [];
    expect(issues[0]?.description).toContain("每条备注至少一个 PATCH");
  });

  it("returns 409 when baseHash does not match", async () => {
    const { root, bookId } = await seedProject();
    const app = createApp(root, async () => ({ patches: [] }));
    const res = await app.request(`/api/v1/books/${bookId}/chapters/1/note-revise`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ noteIds: ["x"], baseHash: "deadbeef" }),
    });
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ error: { code: "CHAPTER_HASH_MISMATCH" } });
  });

  it("applies only accepted patches, archives a version, and leaves rejected text on disk", async () => {
    const { root, bookId, bookDir } = await seedProject();
    const setup = createApp(root);
    const coldId = await addNote(setup, bookId, "门口的灯灭了。", "冷");
    const windId = await addNote(setup, bookId, "巷口的风还在吹。", "加声音");
    const app = createApp(root, async () => ({
      patches: [
        { targetText: "门口的灯灭了。", replacementText: "门口的灯早就灭了。" },
        { targetText: "巷口的风还在吹。", replacementText: "巷口忽然响起脚步。" },
      ],
    }));
    const revised = await app.request(`/api/v1/books/${bookId}/chapters/1/note-revise`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ noteIds: [coldId, windId], baseHash: sha256Source(CHAPTER) }),
    });
    expect(revised.status).toBe(200);

    const applied = await app.request(`/api/v1/books/${bookId}/chapters/1/note-revise/apply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ acceptIds: [coldId], baseHash: sha256Source(CHAPTER) }),
    });
    expect(applied.status).toBe(200);
    const applyBody = await applied.json() as { ok: boolean; appliedIds: string[]; versionId: string };
    expect(applyBody.appliedIds).toEqual([coldId]);
    expect(applyBody.versionId).toContain("_revision_");

    const disk = await readFile(join(bookDir, "chapters", "0001_night.md"), "utf-8");
    expect(disk).toContain("门口的灯早就灭了。");
    expect(disk).toContain("巷口的风还在吹。");
    expect(disk).not.toContain("巷口忽然响起脚步。");

    const stored = JSON.parse(await readFile(annotationsPath(bookDir, 1), "utf-8")) as {
      notes: Array<{ id: string; status: string }>;
    };
    expect(stored.notes.find((note) => note.id === coldId)?.status).toBe("accepted");
    expect(stored.notes.find((note) => note.id === windId)?.status).toBe("suggested");
  });

  it("cancels an in-flight note-revise via the long-task cancel route", async () => {
    const { root, bookId } = await seedProject();
    const noteId = await addNote(createApp(root), bookId, "门口的灯灭了。", "冷");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const seen: AbortSignal[] = [];
    const app = createApp(root, async (input) => {
      seen.push(input.signal!);
      await new Promise<never>((_resolve, reject) => {
        const fail = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        input.signal?.addEventListener("abort", fail, { once: true });
        void gate.then(() => {
          if (input.signal?.aborted) fail();
        });
      });
      return { patches: [] };
    });

    const pending = app.request(`/api/v1/books/${bookId}/chapters/1/note-revise`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        noteIds: [noteId],
        baseHash: sha256Source(CHAPTER),
        taskId: "cancel-me",
      }),
    });
    await vi.waitFor(() => {
      expect(seen.length).toBe(1);
    });
    const cancelled = await app.request("/api/v1/long-tasks/cancel-me/cancel", { method: "POST" });
    expect(cancelled.status).toBe(200);
    release();
    const res = await pending;
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ error: { code: "TASK_CANCELLED" } });
    expect(seen[0]?.aborted).toBe(true);
  });
});
