import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { ApiError } from "../errors.js";
import { annotationsPath } from "../lib/annotation-store.js";
import { registerAnnotationRoutes } from "./annotations.js";

const tmpDirs: string[] = [];

const CHAPTER = `# 夜雨

门口的灯灭了。她没有回头。
`;

async function seedProject(): Promise<{ root: string; bookId: string; bookDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "inkos-studio-ann-"));
  tmpDirs.push(root);
  const bookId = "demo";
  const bookDir = join(root, "books", bookId);
  await mkdir(join(bookDir, "chapters"), { recursive: true });
  await writeFile(join(bookDir, "book.json"), JSON.stringify({
    id: bookId,
    title: "Demo",
    platform: "other",
    genre: "xuanhuan",
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  }, null, 2), "utf-8");
  await writeFile(join(bookDir, "chapters", "0001-night.md"), CHAPTER, "utf-8");
  return { root, bookId, bookDir };
}

function createApp(root: string) {
  const app = new Hono();
  app.onError((error, c) => {
    if (error instanceof ApiError) {
      return c.json({ error: { code: error.code, message: error.message } }, error.status as 400);
    }
    const message = error instanceof Error ? error.message : String(error);
    return c.json({ error: { code: "INTERNAL_ERROR", message } }, 500);
  });
  registerAnnotationRoutes(app, { root });
  return app;
}

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("annotation CRUD routes", () => {
  it("lists empty notes then creates, reads, patches and deletes", async () => {
    const { root, bookId, bookDir } = await seedProject();
    const app = createApp(root);
    const empty = await app.request(`/api/v1/books/${bookId}/chapters/1/annotations`);
    expect(empty.status).toBe(200);
    await expect(empty.json()).resolves.toMatchObject({ chapterNumber: 1, notes: [] });

    const start = CHAPTER.indexOf("门口的灯灭了。");
    const created = await app.request(`/api/v1/books/${bookId}/chapters/1/annotations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ start, end: start + "门口的灯灭了。".length, comment: "语气再冷" }),
    });
    expect(created.status).toBe(201);
    const createdBody = await created.json() as { note: { id: string; selector: { exact: string }; status: string } };
    expect(createdBody.note.selector.exact).toBe("门口的灯灭了。");
    expect(createdBody.note.status).toBe("open");
    const noteId = createdBody.note.id;

    const raw = await readFile(annotationsPath(bookDir, 1), "utf-8");
    expect(raw).toContain(noteId);

    const got = await app.request(`/api/v1/books/${bookId}/chapters/1/annotations/${noteId}`);
    expect(got.status).toBe(200);

    const patched = await app.request(`/api/v1/books/${bookId}/chapters/1/annotations/${noteId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "rejected" }),
    });
    expect(patched.status).toBe(200);
    const patchedBody = await patched.json() as { note: { status: string } };
    expect(patchedBody.note.status).toBe("rejected");

    const deleted = await app.request(`/api/v1/books/${bookId}/chapters/1/annotations/${noteId}`, {
      method: "DELETE",
    });
    expect(deleted.status).toBe(200);
    const missing = await app.request(`/api/v1/books/${bookId}/chapters/1/annotations/${noteId}`);
    expect(missing.status).toBe(404);
  });

  it("rejects invalid ranges and unknown books", async () => {
    const { root, bookId } = await seedProject();
    const app = createApp(root);
    const bad = await app.request(`/api/v1/books/${bookId}/chapters/1/annotations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ start: 4, end: 2, comment: "x" }),
    });
    expect(bad.status).toBe(400);
    const missingBook = await app.request("/api/v1/books/nope/chapters/1/annotations");
    expect(missingBook.status).toBe(404);
  });
});
