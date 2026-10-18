/**
 * Studio shorts API (RD-035 S6). Kept out of server.ts.
 */

import { join } from "node:path";
import type { Hono } from "hono";
import {
  ReviewTransitionError,
  isSafeBookId,
  listShorts,
  readReview,
  readShortDetail,
  transitionReview,
  writeReview,
  writeShortFinal,
  type ReviewState,
} from "@actalk/inkos-core";
import { ApiError } from "../errors.js";

const REVIEW_STATES = new Set<ReviewState>(["pending", "confirmed", "published"]);

export interface ShortsRouteDeps {
  readonly root: string;
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

