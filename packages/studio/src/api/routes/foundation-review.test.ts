import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { createFoundationReviewRecord, writeFoundationReview } from "@actalk/inkos-core";
import { ApiError } from "../errors.js";
import { registerFoundationReviewRoutes } from "./foundation-review.js";

const tmpDirs: string[] = [];

async function seedProject(): Promise<{ root: string; bookId: string; bookDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "inkos-studio-foundation-review-"));
  tmpDirs.push(root);
  const bookId = "demo";
  const bookDir = join(root, "books", bookId);
  await mkdir(join(bookDir, "story"), { recursive: true });
  await writeFile(join(root, "inkos.json"), JSON.stringify({
    name: "demo",
    version: "0.1.0",
    language: "zh",
  }, null, 2), "utf-8");
  await writeFile(join(bookDir, "book.json"), JSON.stringify({
    id: bookId,
    title: "Demo",
    platform: "other",
    genre: "xuanhuan",
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  }, null, 2), "utf-8");
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
  registerFoundationReviewRoutes(app, { root });
  return app;
}

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("foundation-review routes", () => {
  it("returns null when the book has no review file", async () => {
    const { root, bookId } = await seedProject();
    const res = await createApp(root).request(`/api/v1/books/${bookId}/foundation-review`);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ review: null });
  });

  it("returns persisted review status", async () => {
    const { root, bookId, bookDir } = await seedProject();
    await writeFoundationReview(bookDir, createFoundationReviewRecord({
      status: "accepted-with-warning",
      passed: false,
      totalScore: 71,
      threshold: 80,
      attempts: 3,
      overallFeedback: "未过线。",
      dimensions: [{ name: "核心冲突", score: 62, feedback: "偏散。" }],
    }));
    const res = await createApp(root).request(`/api/v1/books/${bookId}/foundation-review`);
    expect(res.status).toBe(200);
    const body = await res.json() as { review: { status: string; totalScore: number; threshold: number } };
    expect(body.review.status).toBe("accepted-with-warning");
    expect(body.review.totalScore).toBe(71);
    expect(body.review.threshold).toBe(80);
  });

  it("acks a warning review", async () => {
    const { root, bookId, bookDir } = await seedProject();
    await writeFoundationReview(bookDir, createFoundationReviewRecord({
      status: "accepted-with-warning",
      passed: false,
      totalScore: 71,
      attempts: 3,
      overallFeedback: "未过线。",
    }));
    const res = await createApp(root).request(`/api/v1/books/${bookId}/foundation-review/ack`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ by: "studio" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { review: { status: string; userAck: { by?: string } | null } };
    expect(body.review.status).toBe("acked");
    expect(body.review.userAck?.by).toBe("studio");

    const reread = await createApp(root).request(`/api/v1/books/${bookId}/foundation-review`);
    const again = await reread.json() as { review: { status: string } };
    expect(again.review.status).toBe("acked");
  });

  it("returns 404 when acking a missing review", async () => {
    const { root, bookId } = await seedProject();
    const res = await createApp(root).request(`/api/v1/books/${bookId}/foundation-review/ack`, {
      method: "POST",
    });
    expect(res.status).toBe(404);
  });
});
