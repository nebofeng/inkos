import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPendingReview, writeReview } from "@actalk/inkos-core";
import { ApiError } from "../errors.js";
import { resetLongTasksForTests } from "../lib/long-task.js";
import { registerLongTaskRoutes } from "./long-tasks.js";
import { registerShortsRoutes } from "./shorts.js";

const tmpDirs: string[] = [];

async function seedProject(): Promise<{ root: string; id: string; dir: string }> {
  const root = await mkdtemp(join(tmpdir(), "inkos-studio-shorts-"));
  tmpDirs.push(root);
  const id = "traitor";
  const dir = join(root, "shorts", id);
  await mkdir(join(dir, "final"), { recursive: true });
  await writeFile(join(dir, "final", "zhihu-answer.md"), "大家都骂我是叛徒\n\n正文。", "utf-8");
  await writeFile(join(dir, "final", "full.md"), "大家都骂我是叛徒\n\n正文。", "utf-8");
  await writeFile(join(dir, "status.json"), JSON.stringify({
    version: 1, kind: "short-fiction", id, status: "complete", stage: "imported",
    artifacts: ["final/zhihu-answer.md"], observations: [], updatedAt: "2026-10-14T00:00:00.000Z",
  }, null, 2), "utf-8");
  await writeReview(dir, createPendingReview({
    source: "import",
    platform: "zhihu",
    batch: "2026-10-13",
    title: "大家都骂我是叛徒",
    titleRequiredPrefix: "大家都骂我是叛徒",
    finalPath: "final/zhihu-answer.md",
  }));
  return { root, id, dir };
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
  registerShortsRoutes(app, { root });
  return app;
}

afterEach(async () => {
  resetLongTasksForTests();
  await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("shorts API", () => {
  it("lists shorts", async () => {
    const { root, id } = await seedProject();
    const res = await createApp(root).request("/api/v1/shorts");
    expect(res.status).toBe(200);
    const body = await res.json() as { shorts: Array<{ id: string; reviewState: string }> };
    expect(body.shorts).toHaveLength(1);
    expect(body.shorts[0]?.id).toBe(id);
    expect(body.shorts[0]?.reviewState).toBe("pending");
  });

  it("returns short detail", async () => {
    const { root, id } = await seedProject();
    const res = await createApp(root).request(`/api/v1/shorts/${id}`);
    expect(res.status).toBe(200);
    const body = await res.json() as { short: { markdown: string; title: string } };
    expect(body.short.title).toContain("叛徒");
    expect(body.short.markdown).toContain("大家都骂我是叛徒");
  });

  it("edits final markdown and keeps pending", async () => {
    const { root, id, dir } = await seedProject();
    const res = await createApp(root).request(`/api/v1/shorts/${id}/final`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ markdown: "大家都骂我是叛徒\n\n改过的正文。" }),
    });
    expect(res.status).toBe(200);
    const saved = await readFile(join(dir, "final", "zhihu-answer.md"), "utf-8");
    expect(saved).toContain("改过的正文");
    const historyDir = join(dir, "final", "history");
    const { readdir } = await import("node:fs/promises");
    const files = await readdir(historyDir);
    expect(files.some((name) => name.endsWith(".md"))).toBe(true);
  });

  it("confirms then publishes with answerUrl; pending→published is 409", async () => {
    const { root, id } = await seedProject();
    const app = createApp(root);
    const skip = await app.request(`/api/v1/shorts/${id}/review`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to: "published", answerUrl: "https://www.zhihu.com/question/1/answer/2" }),
    });
    expect(skip.status).toBe(409);

    const confirmed = await app.request(`/api/v1/shorts/${id}/review`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to: "confirmed" }),
    });
    expect(confirmed.status).toBe(200);
    expect((await confirmed.json() as { review: { state: string } }).review.state).toBe("confirmed");

    const missingUrl = await app.request(`/api/v1/shorts/${id}/review`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to: "published" }),
    });
    expect(missingUrl.status).toBe(409);

    const published = await app.request(`/api/v1/shorts/${id}/review`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to: "published", answerUrl: "https://www.zhihu.com/question/1/answer/2" }),
    });
    expect(published.status).toBe(200);
    expect((await published.json() as { review: { state: string } }).review.state).toBe("published");

    const edit = await app.request(`/api/v1/shorts/${id}/final`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ markdown: "不能改" }),
    });
    expect(edit.status).toBe(409);
  });

  it("editing a confirmed final returns it to pending", async () => {
    const { root, id, dir } = await seedProject();
    const app = createApp(root);
    await app.request(`/api/v1/shorts/${id}/review`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to: "confirmed" }),
    });
    const res = await app.request(`/api/v1/shorts/${id}/final`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ markdown: "大家都骂我是叛徒\n\n又改了一刀。" }),
    });
    expect(res.status).toBe(200);
    const review = JSON.parse(await readFile(join(dir, "review.json"), "utf-8"));
    expect(review.state).toBe("pending");
  });
});
describe("shorts API fanqie-short", () => {
  it("lists and details a fanqie-short final path", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-studio-fanqie-"));
    tmpDirs.push(root);
    const id = "hook-smash";
    const dir = join(root, "shorts", id);
    await mkdir(join(dir, "final"), { recursive: true });
    await writeFile(join(dir, "final", "fanqie-short.md"), "钩子先砸下来。\n\n正文。", "utf-8");
    await writeFile(join(dir, "final", "full.md"), "钩子先砸下来。\n\n正文。", "utf-8");
    await writeFile(join(dir, "status.json"), JSON.stringify({
      version: 1, kind: "short-fiction", id, status: "complete", stage: "imported",
      artifacts: ["final/fanqie-short.md"], observations: [], updatedAt: "2026-10-14T00:00:00.000Z",
    }, null, 2), "utf-8");
    await writeReview(dir, createPendingReview({
      source: "inkos",
      platform: "fanqie",
      title: "钩子先砸下来。",
      finalPath: "final/fanqie-short.md",
    }));

    const app = createApp(root);
    const list = await app.request("/api/v1/shorts");
    expect(list.status).toBe(200);
    const listed = await list.json() as { shorts: Array<{ id: string; platform?: string; finalPath: string }> };
    expect(listed.shorts[0]?.id).toBe(id);
    expect(listed.shorts[0]?.platform).toBe("fanqie");
    expect(listed.shorts[0]?.finalPath).toBe("final/fanqie-short.md");

    const detail = await app.request(`/api/v1/shorts/${id}`);
    expect(detail.status).toBe(200);
    const body = await detail.json() as { short: { markdown: string; finalPath: string } };
    expect(body.short.finalPath).toBe("final/fanqie-short.md");
    expect(body.short.markdown).toContain("钩子先砸下来");
  });
});

describe("shorts API assist", () => {
  it("rejects assist request without instruction", async () => {
    const { root, id } = await seedProject();
    const app = createApp(root);
    const res = await app.request(`/api/v1/shorts/${id}/assist`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ instruction: "   " }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe("MISSING_INSTRUCTION");
  });

  it("returns 404 for nonexistent short", async () => {
    const { root } = await seedProject();
    const app = createApp(root);
    const res = await app.request("/api/v1/shorts/nonexistent/assist", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ instruction: "改写第一句" }),
    });
    expect(res.status).toBe(404);
  });

  it("returns candidate markdown without modifying disk file", async () => {
    const { root, id, dir } = await seedProject();
    const originalFile = await readFile(join(dir, "final", "zhihu-answer.md"), "utf-8");

    const app = new Hono();
    registerShortsRoutes(app, {
      root,
      complete: async () => ({
        content: "这是改写说明。\n\n```markdown\n大家都骂我是叛徒\n\n【改写后】林中的冷箭骤然而至。\n```\n\n请确认是否应用。",
        usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
      }),
    });

    const res = await app.request(`/api/v1/shorts/${id}/assist`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        instruction: "增强动作张力",
        action: "rewrite",
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { reply: string; candidateMarkdown?: string };
    expect(body.reply).toContain("这是改写说明");
    expect(body.candidateMarkdown).toContain("【改写后】林中的冷箭骤然而至");

    // CRITICAL: Disk file must remain COMPLETELY untouched
    const diskContentAfter = await readFile(join(dir, "final", "zhihu-answer.md"), "utf-8");
    expect(diskContentAfter).toBe(originalFile);
  });

  it("returns chat reply without candidateMarkdown for conversational question", async () => {
    const { root, id, dir } = await seedProject();
    const originalFile = await readFile(join(dir, "final", "zhihu-answer.md"), "utf-8");

    const app = new Hono();
    registerShortsRoutes(app, {
      root,
      complete: async () => ({
        content: "这篇小说的核心冲突是信任危机与身份自证。",
        usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
      }),
    });

    const res = await app.request(`/api/v1/shorts/${id}/assist`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        instruction: "这篇小说的核心冲突是什么？",
        action: "chat",
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { reply: string; candidateMarkdown?: string };
    expect(body.reply).toBe("这篇小说的核心冲突是信任危机与身份自证。");
    expect(body.candidateMarkdown).toBeUndefined();

    // Disk remains untouched
    const diskContentAfter = await readFile(join(dir, "final", "zhihu-answer.md"), "utf-8");
    expect(diskContentAfter).toBe(originalFile);
  });
});

describe("shorts assist cancellation and estimate", () => {
  it("returns estimateMs and taskId without writing disk", async () => {
    const { root, id } = await seedProject();
    const app = new Hono();
    registerShortsRoutes(app, {
      root,
      complete: async (_client, _model, _messages, options) => {
        expect(options?.signal).toBeInstanceOf(AbortSignal);
        return {
          content: "说明。\n\n```markdown\n新正文\n```",
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        };
      },
    });
    const res = await app.request(`/api/v1/shorts/${id}/assist`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ instruction: "改写第一句", action: "rewrite", taskId: "short-1" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { taskId: string; estimateMs: number; candidateMarkdown?: string };
    expect(body.taskId).toBe("short-1");
    expect(body.estimateMs).toBeGreaterThan(0);
    expect(body.candidateMarkdown).toContain("新正文");
  });

  it("aborts the LLM call through POST /long-tasks/:id/cancel", async () => {
    const { root, id } = await seedProject();
    const seen: AbortSignal[] = [];
    const app = new Hono();
    app.onError((error, c) => {
      if (error instanceof ApiError) {
        return c.json({ error: { code: error.code, message: error.message } }, error.status as 400);
      }
      return c.json({ error: { code: "INTERNAL_ERROR", message: String(error) } }, 500);
    });
    registerShortsRoutes(app, {
      root,
      complete: async (_client, _model, _messages, options) => {
        const signal = options?.signal;
        seen.push(signal!);
        await new Promise<never>((_resolve, reject) => {
          const fail = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          signal?.addEventListener("abort", fail, { once: true });
          if (signal?.aborted) fail();
        });
        return { content: "late", usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } };
      },
    });
    registerLongTaskRoutes(app);

    const pending = app.request(`/api/v1/shorts/${id}/assist`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ instruction: "改写全文", action: "rewrite", taskId: "short-cancel" }),
    });
    await vi.waitFor(() => {
      expect(seen.length).toBe(1);
    });
    const cancelled = await app.request("/api/v1/long-tasks/short-cancel/cancel", { method: "POST" });
    expect(cancelled.status).toBe(200);
    const res = await pending;
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ error: { code: "TASK_CANCELLED" } });
    expect(seen[0]?.aborted).toBe(true);
  });
});
