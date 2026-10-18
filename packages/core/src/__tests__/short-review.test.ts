import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ReviewTransitionError,
  assertShortPublishable,
  createPendingReview,
  ensurePendingReview,
  readReview,
  transitionReview,
  writeReview,
  type ReviewFile,
} from "../shorts/review.js";

const tmpDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "inkos-short-review-"));
  tmpDirs.push(dir);
  return dir;
}

function pending(): ReviewFile {
  return createPendingReview({ title: "电梯多一层" });
}

describe("short review state machine", () => {
  it("allows pending → confirmed and confirmed → pending", () => {
    const confirmed = transitionReview(pending(), { to: "confirmed", by: "studio-user" });
    expect(confirmed.state).toBe("confirmed");
    expect(confirmed.confirmedAt).toBeTruthy();
    expect(confirmed.history?.at(-1)).toMatchObject({ from: "pending", to: "confirmed", by: "studio-user" });

    const reverted = transitionReview(confirmed, { to: "pending", by: "studio-user" });
    expect(reverted.state).toBe("pending");
    expect(reverted.confirmedAt).toBeNull();
  });

  it("allows confirmed → published only with answerUrl", () => {
    const confirmed = transitionReview(pending(), { to: "confirmed" });
    expect(() => transitionReview(confirmed, { to: "published" })).toThrow(ReviewTransitionError);
    try {
      transitionReview(confirmed, { to: "published" });
    } catch (error) {
      expect(error).toMatchObject({ name: "ReviewTransitionError", code: 409 });
    }

    const published = transitionReview(confirmed, {
      to: "published",
      answerUrl: "https://zhihu.com/answer/1",
      by: "studio-user",
    });
    expect(published.state).toBe("published");
    expect(published.answerUrl).toBe("https://zhihu.com/answer/1");
    expect(published.publishedAt).toBeTruthy();
  });

  it("rejects every illegal transition with 409 semantics", () => {
    const cases: Array<{ from: ReviewFile; to: ReviewFile["state"]; answerUrl?: string }> = [
      { from: pending(), to: "published", answerUrl: "https://zhihu.com/answer/1" },
      { from: pending(), to: "pending" },
      { from: transitionReview(pending(), { to: "confirmed" }), to: "confirmed" },
      {
        from: transitionReview(transitionReview(pending(), { to: "confirmed" }), {
          to: "published",
          answerUrl: "https://zhihu.com/answer/1",
        }),
        to: "pending",
      },
      {
        from: transitionReview(transitionReview(pending(), { to: "confirmed" }), {
          to: "published",
          answerUrl: "https://zhihu.com/answer/1",
        }),
        to: "confirmed",
      },
    ];
    for (const item of cases) {
      try {
        transitionReview(item.from, { to: item.to, answerUrl: item.answerUrl });
        expect.fail(`expected ${item.from.state} → ${item.to} to throw`);
      } catch (error) {
        expect(error).toBeInstanceOf(ReviewTransitionError);
        expect(error).toMatchObject({ code: 409 });
      }
    }
  });

  it("assertShortPublishable requires confirmed", async () => {
    expect(() => assertShortPublishable(pending())).toThrow(ReviewTransitionError);
    const confirmed = transitionReview(pending(), { to: "confirmed" });
    expect(() => assertShortPublishable(confirmed)).not.toThrow();
    const published = transitionReview(confirmed, { to: "published", answerUrl: "https://zhihu.com/answer/1" });
    expect(() => assertShortPublishable(published)).toThrow(/confirmed/);

    const dir = await makeDir();
    await expect(assertShortPublishable(dir)).rejects.toThrow(ReviewTransitionError);
    await writeReview(dir, confirmed);
    await expect(assertShortPublishable(dir)).resolves.toBeUndefined();
  });

  it("ensurePendingReview writes pending once and never overwrites a human state", async () => {
    const dir = await makeDir();
    const first = await ensurePendingReview(dir);
    expect(first.state).toBe("pending");
    expect(first.source).toBe("inkos");

    const confirmed = transitionReview(first, { to: "confirmed", by: "studio-user" });
    await writeReview(dir, confirmed);
    const again = await ensurePendingReview(dir);
    expect(again.state).toBe("confirmed");
    expect((await readReview(dir))?.state).toBe("confirmed");
  });
});
