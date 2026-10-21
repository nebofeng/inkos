/**
 * Opening-check report + hard-gate view (RD-049). Kept out of server.ts.
 */

import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Hono } from "hono";
import { ApiError } from "../errors.js";
import { isSafeBookId } from "../safety.js";

export interface OpeningCheckOverrideView {
  readonly enabled?: boolean;
  readonly hardGate?: boolean;
}

export interface OpeningCheckReportView {
  readonly bookId?: string;
  readonly items?: readonly unknown[];
  readonly skipped?: boolean;
}

export interface OpeningHardGateResultView {
  readonly passed: boolean;
  readonly mode: "hard" | "soft" | "disabled";
  readonly blocks: readonly unknown[];
  readonly reason?: string;
}

export interface OpeningCheckRouteDeps {
  readonly root: string;
  readonly readReport: (bookDir: string) => Promise<OpeningCheckReportView | undefined>;
  readonly resolveHardGate: (input: {
    readonly bookDir: string;
    readonly projectOpeningCheck?: OpeningCheckOverrideView;
    readonly bookOpeningCheck?: OpeningCheckOverrideView;
  }) => Promise<OpeningHardGateResultView>;
  readonly parseProjectOpeningCheck?: (raw: unknown) => OpeningCheckOverrideView | undefined;
}

export function registerOpeningCheckRoutes(app: Hono, deps: OpeningCheckRouteDeps): void {
  app.get("/api/v1/books/:id/opening-check", async (c) => {
    const bookId = requiredBookId(c.req.param("id"));
    const bookDir = join(deps.root, "books", bookId);
    await assertBookExists(bookDir, bookId);
    const report = await deps.readReport(bookDir);
    const projectOpeningCheck = await loadProjectOpeningCheck(deps.root, deps.parseProjectOpeningCheck);
    const bookOpeningCheck = await loadBookOpeningCheck(bookDir);
    const hardGate = await deps.resolveHardGate({
      bookDir,
      projectOpeningCheck,
      bookOpeningCheck,
    });
    return c.json({ report: report ?? null, hardGate });
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

async function loadProjectOpeningCheck(
  root: string,
  parse?: (raw: unknown) => OpeningCheckOverrideView | undefined,
): Promise<OpeningCheckOverrideView | undefined> {
  try {
    const raw = JSON.parse(await readFile(join(root, "inkos.json"), "utf-8")) as Record<string, unknown>;
    if (parse) return parse(raw.openingCheck ?? {});
    const value = raw.openingCheck;
    if (!value || typeof value !== "object") return undefined;
    return value as OpeningCheckOverrideView;
  } catch {
    return undefined;
  }
}

async function loadBookOpeningCheck(bookDir: string): Promise<OpeningCheckOverrideView | undefined> {
  try {
    const raw = JSON.parse(await readFile(join(bookDir, "book.json"), "utf-8")) as {
      readonly openingCheck?: OpeningCheckOverrideView;
    };
    return raw.openingCheck;
  } catch {
    return undefined;
  }
}
