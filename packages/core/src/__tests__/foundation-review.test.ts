import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ackFoundationReview,
  createFoundationReviewRecord,
  foundationReviewJsonPath,
  isFoundationReviewAlert,
  readFoundationReview,
  writeFoundationReview,
} from "../foundation-review/index.js";

const tmpDirs: string[] = [];

async function seedBook(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "inkos-foundation-review-"));
  tmpDirs.push(root);
  const bookDir = join(root, "books", "demo");
  await mkdir(join(bookDir, "story"), { recursive: true });
  await writeFile(join(bookDir, "book.json"), JSON.stringify({
    id: "demo",
    title: "Demo",
    platform: "other",
    genre: "xuanhuan",
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  }, null, 2), "utf-8");
  return bookDir;
}

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("foundation-review persist", () => {
  it("writes passed reviews and patches book.json", async () => {
    const bookDir = await seedBook();
    const record = createFoundationReviewRecord({
      status: "passed",
      passed: true,
      totalScore: 88,
      attempts: 1,
      overallFeedback: "可以开写。",
      dimensions: [{ name: "核心冲突", score: 90, feedback: "清楚。" }],
    });
    await writeFoundationReview(bookDir, record);

    const persisted = await readFoundationReview(bookDir);
    expect(persisted?.status).toBe("passed");
    expect(persisted?.passed).toBe(true);
    expect(persisted?.threshold).toBe(80);
    const book = JSON.parse(await readFile(join(bookDir, "book.json"), "utf-8")) as { foundationReviewStatus?: string };
    expect(book.foundationReviewStatus).toBe("passed");
    expect(isFoundationReviewAlert(persisted?.status)).toBe(false);
  });

  it("overwrites a warning with passed on successful re-review", async () => {
    const bookDir = await seedBook();
    await writeFoundationReview(bookDir, createFoundationReviewRecord({
      status: "accepted-with-warning",
      passed: false,
      totalScore: 71,
      attempts: 3,
      overallFeedback: "未过线。",
    }));
    await writeFoundationReview(bookDir, createFoundationReviewRecord({
      status: "passed",
      passed: true,
      totalScore: 86,
      attempts: 1,
      overallFeedback: "重审通过。",
    }));
    const persisted = await readFoundationReview(bookDir);
    expect(persisted?.status).toBe("passed");
    expect(persisted?.totalScore).toBe(86);
  });

  it("acks accepted-with-warning and parse-failed reviews", async () => {
    const bookDir = await seedBook();
    await writeFoundationReview(bookDir, createFoundationReviewRecord({
      status: "accepted-with-warning",
      passed: false,
      totalScore: 71,
      attempts: 3,
      overallFeedback: "未过线。",
    }));
    const acked = await ackFoundationReview(bookDir, { at: "2026-10-19T00:00:00.000Z", by: "user" });
    expect(acked?.status).toBe("acked");
    expect(acked?.userAck).toEqual({ at: "2026-10-19T00:00:00.000Z", by: "user" });
    const book = JSON.parse(await readFile(join(bookDir, "book.json"), "utf-8")) as { foundationReviewStatus?: string };
    expect(book.foundationReviewStatus).toBe("acked");

    await writeFoundationReview(bookDir, createFoundationReviewRecord({
      status: "parse-failed",
      passed: false,
      totalScore: 0,
      attempts: 1,
      overallFeedback: "missing dimensions",
    }));
    const ackedParse = await ackFoundationReview(bookDir);
    expect(ackedParse?.status).toBe("acked");
    expect(await readFile(foundationReviewJsonPath(bookDir), "utf-8")).toContain('"status": "acked"');
  });

  it("returns undefined when no review file exists", async () => {
    const bookDir = await seedBook();
    await expect(readFoundationReview(bookDir)).resolves.toBeUndefined();
    await expect(ackFoundationReview(bookDir)).resolves.toBeUndefined();
  });
});
