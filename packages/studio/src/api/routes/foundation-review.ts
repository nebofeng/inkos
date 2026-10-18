/**
 * Foundation-review soft-gate routes (RD-038 S6). Kept out of server.ts.
 */

import { access } from "node:fs/promises";
import { join } from "node:path";
import type { Hono } from "hono";
import {
  ackFoundationReview,
  readFoundationReview,
} from "@actalk/inkos-core";
import { ApiError } from "../errors.js";
import { isSafeBookId } from "../safety.js";

export interface FoundationReviewRouteDeps {
  readonly root: string;
}

export function registerFoundationReviewRoutes(app: Hono, deps: FoundationReviewRouteDeps): void {
  app.get("/api/v1/books/:id/foundation-review", async (c) => {
    const bookId = requiredBookId(c.req.param("id"));
    const bookDir = join(deps.root, "books", bookId);
    await assertBookExists(bookDir, bookId);
    const review = await readFoundationReview(bookDir);
    return c.json({ review: review ?? null });
  });

  app.post("/api/v1/books/:id/foundation-review/ack", async (c) => {
    const bookId = requiredBookId(c.req.param("id"));
    const bookDir = join(deps.root, "books", bookId);
    await assertBookExists(bookDir, bookId);
    const body = await readJsonObject(c);
    const by = typeof body.by === "string" && body.by.trim() ? body.by.trim() : undefined;
    const review = await ackFoundationReview(bookDir, by ? { by } : undefined);
    if (!review) {
      throw new ApiError(404, "FOUNDATION_REVIEW_NOT_FOUND", `No foundation review for book "${bookId}"`);
    }
    return c.json({ review });
  });
}

function requiredBookId(value: unknown): string {
  if (typeof value !== "string" || !isSafeBookId(value)) {
    throw new ApiError(400, "INVALID_BOOK_ID", `Invalid book ID: "${String(value)}"`);
  }
  return value;
}

async function assertBookExists(bookDir: string, bookId: string): Promise<void> {
  try {
    await access(join(bookDir, "book.json"));
  } catch {
    throw new ApiError(404, "BOOK_NOT_FOUND", `Book "${bookId}" not found`);
  }
}

async function readJsonObject(c: { req: { json: () => Promise<unknown> } }): Promise<Record<string, unknown>> {
  try {
    const body = await c.req.json();
    if (body && typeof body === "object" && !Array.isArray(body)) {
      return body as Record<string, unknown>;
    }
  } catch {
    // empty body is fine for ack
  }
  return {};
}
