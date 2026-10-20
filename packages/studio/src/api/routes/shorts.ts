/**
 * Studio shorts API (RD-035 S6). Kept out of server.ts.
 */

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Hono } from "hono";
import {
  ReviewTransitionError,
  chatCompletion,
  createLLMClient,
  isSafeBookId,
  listShorts,
  loadProjectConfig,
  readReview,
  readShortDetail,
  transitionReview,
  writeReview,
  writeShortFinal,
  type LLMClient,
  type LLMMessage,
  type LLMResponse,
  type ProjectConfig,
  type ReviewState,
} from "@actalk/inkos-core";
import { ApiError } from "../errors.js";
import {
  combineAbortSignals,
  estimateLongTaskMs,
  isAbortError,
  parseTaskId,
  registerLongTask,
  unregisterLongTask,
} from "../lib/long-task.js";

const REVIEW_STATES = new Set<ReviewState>(["pending", "confirmed", "published"]);

const PLATFORM_BOUNDS: Record<string, { min: number; max: number }> = {
  zhihu: { min: 2200, max: 3500 },
  "zhihu-short": { min: 2200, max: 3500 },
  fanqie: { min: 10000, max: 30000 },
  "fanqie-short": { min: 10000, max: 30000 },
};

function getPlatformBounds(platform?: string): { min: number; max: number } {
  return PLATFORM_BOUNDS[platform ?? ""] ?? { min: 2200, max: 3500 };
}

export function parseAssistResponse(raw: string): { reply: string; candidateMarkdown?: string } {
  const trimmed = raw.trim();
  const codeBlockRegex = /```(?:markdown)?\s*\n([\s\S]*?)\n```/i;
  const match = codeBlockRegex.exec(trimmed);
  if (match && match[1]) {
    const candidate = match[1].trim();
    const replyBefore = trimmed.slice(0, match.index).trim();
    const replyAfter = trimmed.slice(match.index + match[0].length).trim();
    const reply = [replyBefore, replyAfter].filter(Boolean).join("\n\n") || "已根据您的要求生成候选修改版本，请在下方对比并确认是否应用。";
    return { reply, candidateMarkdown: candidate };
  }
  return { reply: trimmed };
}

export interface ShortsRouteDeps {
  readonly root: string;
  readonly loadConfig?: (root: string) => Promise<ProjectConfig>;
  readonly createClient?: (llmConfig: any) => LLMClient;
  readonly complete?: (
    client: LLMClient,
    model: string,
    messages: ReadonlyArray<LLMMessage>,
    options?: { temperature?: number; signal?: AbortSignal },
  ) => Promise<LLMResponse>;
}

export function registerShortsRoutes(app: Hono, deps: ShortsRouteDeps): void {
  app.get("/api/v1/shorts", async (c) => {
    const items = await listShorts(deps.root);
    return c.json({ shorts: items });
  });

  app.get("/api/v1/shorts/:id", async (c) => {
    const id = requiredShortId(c.req.param("id"));
    const detail = await readShortDetail(deps.root, id);
    if (!detail) {
      throw new ApiError(404, "SHORT_NOT_FOUND", `Short "${id}" not found`);
    }
    return c.json({ short: detail });
  });

  app.put("/api/v1/shorts/:id/final", async (c) => {
    const id = requiredShortId(c.req.param("id"));
    const dir = join(deps.root, "shorts", id);
    const detail = await readShortDetail(deps.root, id);
    if (!detail) {
      throw new ApiError(404, "SHORT_NOT_FOUND", `Short "${id}" not found`);
    }
    const body = await readJsonObject(c);
    const markdown = pickMarkdown(body);
    if (markdown === undefined) {
      throw new ApiError(400, "MISSING_MARKDOWN", "PUT /final requires markdown");
    }
    try {
      const review = await writeShortFinal(dir, markdown);
      return c.json({ review, short: await readShortDetail(deps.root, id) });
    } catch (error) {
      throw asApiError(error);
    }
  });

  app.post("/api/v1/shorts/:id/review", async (c) => {
    const id = requiredShortId(c.req.param("id"));
    const dir = join(deps.root, "shorts", id);
    const existing = await readReview(dir);
    if (!existing) {
      throw new ApiError(404, "SHORT_NOT_FOUND", `Short "${id}" not found`);
    }
    const body = await readJsonObject(c);
    const to = body.to;
    if (typeof to !== "string" || !REVIEW_STATES.has(to as ReviewState)) {
      throw new ApiError(400, "INVALID_REVIEW_STATE", "review.to must be pending, confirmed, or published");
    }
    const answerUrl = typeof body.answerUrl === "string" ? body.answerUrl : undefined;
    try {
      const review = transitionReview(existing, {
        to: to as ReviewState,
        answerUrl,
        by: typeof body.by === "string" ? body.by : "studio-user",
      });
      await writeReview(dir, review);
      return c.json({ review });
    } catch (error) {
      throw asApiError(error);
    }
  });

  app.post("/api/v1/shorts/:id/assist", async (c) => {
    const id = requiredShortId(c.req.param("id"));
    const detail = await readShortDetail(deps.root, id);
    if (!detail) {
      throw new ApiError(404, "SHORT_NOT_FOUND", `Short "${id}" not found`);
    }
    const body = await readJsonObject(c);
    const instruction = typeof body.instruction === "string" ? body.instruction.trim() : "";
    if (!instruction) {
      throw new ApiError(400, "MISSING_INSTRUCTION", "POST /assist requires instruction");
    }
    const action = typeof body.action === "string" ? body.action : undefined;
    const targetWords = typeof body.targetWords === "number" ? body.targetWords : undefined;
    const selectedText = typeof body.selectedText === "string" ? body.selectedText.trim() : undefined;
    const clientMessages = Array.isArray(body.messages) ? body.messages : [];

    const taskId = parseTaskId(body.taskId, () => randomUUID());
    const estimateMs = estimateLongTaskMs(detail.charCount ?? detail.markdown.length);

    if (Boolean(process.env.INKOS_AGENT_LLM_STUB) && !deps.complete) {
      const isRewrite = Boolean(action && action !== "chat") || /改写|扩写|压缩|去.*ai/i.test(instruction);
      if (isRewrite) {
        return c.json({
          reply: "已根据您的要求生成候选修改建议（存根模式）。",
          candidateMarkdown: `${detail.markdown}\n\n【AI改写补充】风声掠过屋檐，残剑的光芒在夜幕中泛起微澜。`,
          taskId,
          estimateMs,
          charCount: detail.charCount,
        });
      }
      return c.json({
        reply: "这是关于该短篇的分析建议：文章叙事节奏明快，人物动机清晰（存根模式）。",
        taskId,
        estimateMs,
        charCount: detail.charCount,
      });
    }

    const bounds = getPlatformBounds(detail.platform);
    const systemPrompt = [
      "你是一个专业的短篇小说编辑助手，正在辅助作者修改短篇作品。",
      `当前短篇标题：《${detail.title}》`,
      `平台定位：${detail.platform ?? "通用"}（推荐篇幅：${bounds.min} ~ ${bounds.max} 字）`,
      `当前字数：${detail.charCount} 字`,
      "当前短篇全文 Markdown 内容如下：",
      "---",
      detail.markdown,
      "---",
      "请按照用户的具体要求提供帮助：",
      "- 若用户要求改写、扩写、压缩、去AI味或提供具体修改建议，请在回复中包含两部分：",
      "  1. 简要说明你的修改理由与改动要点（段落文字）；",
      "  2. 完整的候选新 Markdown 全文，必须严格包裹在 ```markdown ... ``` 代码块中。",
      "- 若用户仅提问、分析或探讨剧情，则直接清晰回答，不需要附带全文代码块。",
    ].join("\n");

    const userContent = [
      instruction,
      targetWords ? `目标字数要求：约 ${targetWords} 字。` : "",
      selectedText ? `重点针对选中的以下片段进行修改：\n"""\n${selectedText}\n"""` : "",
    ].filter(Boolean).join("\n\n");

    const llmMessages: LLMMessage[] = [
      { role: "system", content: systemPrompt },
      ...clientMessages
        .filter((m): m is { role: "user" | "assistant"; content: string } =>
          (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
        .slice(-6),
      { role: "user", content: userContent },
    ];

    let config: ProjectConfig;
    try {
      config = deps.loadConfig
        ? await deps.loadConfig(deps.root)
        : await loadProjectConfig(deps.root, { consumer: "cli", requireApiKey: false });
    } catch {
      config = { name: "default", version: "1.0", llm: { provider: "openai", model: "default" } } as unknown as ProjectConfig;
    }

    const client = deps.createClient
      ? deps.createClient(config.llm)
      : createLLMClient(config.llm);

    const completeFn = deps.complete ?? chatCompletion;
    const controller = registerLongTask(taskId);
    const signal = combineAbortSignals(c.req.raw.signal, controller.signal);
    try {
      signal.throwIfAborted();
      const response = await completeFn(
        client,
        config.llm?.model || "default",
        llmMessages,
        { temperature: 0.7, signal },
      );
      const parsed = parseAssistResponse(response.content);
      return c.json({ ...parsed, taskId, estimateMs, charCount: detail.charCount });
    } catch (error) {
      if (isAbortError(error) || signal.aborted) {
        throw new ApiError(409, "TASK_CANCELLED", "Task was cancelled");
      }
      throw asApiError(error);
    } finally {
      unregisterLongTask(taskId, controller);
    }
  });
}

function requiredShortId(value: unknown): string {
  if (typeof value !== "string" || !isSafeBookId(value)) {
    throw new ApiError(400, "INVALID_SHORT_ID", `Invalid short id: "${String(value)}"`);
  }
  return value;
}

function pickMarkdown(body: Record<string, unknown>): string | undefined {
  for (const key of ["markdown", "content", "text"]) {
    const value = body[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}

function asApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (error instanceof ReviewTransitionError) {
    return new ApiError(error.code, "REVIEW_CONFLICT", error.message);
  }
  const message = error instanceof Error ? error.message : String(error);
  return new ApiError(500, "INTERNAL_ERROR", message);
}

async function readJsonObject(c: { req: { json: () => Promise<unknown> } }): Promise<Record<string, unknown>> {
  try {
    const body = await c.req.json();
    if (body && typeof body === "object" && !Array.isArray(body)) {
      return body as Record<string, unknown>;
    }
  } catch {
    // empty
  }
  return {};
}

