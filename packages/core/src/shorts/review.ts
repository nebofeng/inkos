import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const REVIEW_FILE_VERSION = 1;
export const REVIEW_STATES = ["pending", "confirmed", "published"] as const;
export const REVIEW_SOURCES = ["inkos", "import"] as const;

export type ReviewState = (typeof REVIEW_STATES)[number];
export type ReviewSource = (typeof REVIEW_SOURCES)[number];

export interface ReviewHistoryEntry {
  readonly from: ReviewState;
  readonly to: ReviewState;
  readonly at: string;
  readonly by?: string;
}

export interface ReviewFile {
  readonly version: typeof REVIEW_FILE_VERSION;
  readonly state: ReviewState;
  readonly source?: ReviewSource;
  readonly platform?: string;
  readonly batch?: string;
  readonly finalPath?: string;
  readonly title?: string;
  readonly titleRequiredPrefix?: string;
  readonly questionUrl?: string;
  readonly answerUrl?: string | null;
  readonly publishedAt?: string | null;
  readonly confirmedAt?: string | null;
  readonly history?: ReadonlyArray<ReviewHistoryEntry>;
  readonly generatedAt?: string;
}

export interface ReviewTransitionInput {
  readonly to: ReviewState;
  readonly answerUrl?: string;
  readonly by?: string;
}

export class ReviewTransitionError extends Error {
  readonly code = 409 as const;

  constructor(message: string) {
    super(message);
    this.name = "ReviewTransitionError";
  }
}

export function reviewJsonPath(dir: string): string {
  return join(dir, "review.json");
}

export function createPendingReview(overrides: Omit<Partial<ReviewFile>, "state" | "version"> = {}): ReviewFile {
  return {
    source: "inkos",
    generatedAt: new Date().toISOString(),
    ...overrides,
    version: REVIEW_FILE_VERSION,
    state: "pending",
  };
}

export async function reviewFileExists(dir: string): Promise<boolean> {
  try {
    await access(reviewJsonPath(dir));
    return true;
  } catch {
    return false;
  }
}

export async function readReview(dir: string): Promise<ReviewFile | undefined> {
  try {
    const raw = await readFile(reviewJsonPath(dir), "utf-8");
    return parseReviewFile(JSON.parse(raw));
  } catch (error) {
    if (isMissingPathError(error)) return undefined;
    throw error;
  }
}

export async function writeReview(dir: string, review: ReviewFile): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(reviewJsonPath(dir), `${JSON.stringify(review, null, 2)}\n`, "utf-8");
}

/** Write pending review.json only when the file is absent. Never clobbers a human state. */
export async function ensurePendingReview(
  dir: string,
  overrides: Omit<Partial<ReviewFile>, "state" | "version"> = {},
): Promise<ReviewFile> {
  if (await reviewFileExists(dir)) {
    const existing = await readReview(dir);
    if (existing) return existing;
    throw new ReviewTransitionError("review.json exists but could not be parsed; refusing to overwrite");
  }
  const created = createPendingReview(overrides);
  await writeReview(dir, created);
  return created;
}

export function transitionReview(review: ReviewFile, input: ReviewTransitionInput): ReviewFile {
  const from = review.state;
  const to = input.to;
  const allowed = (from === "pending" && to === "confirmed")
    || (from === "confirmed" && to === "pending")
    || (from === "confirmed" && to === "published");
  if (!allowed) {
    throw new ReviewTransitionError(`cannot transition short review from ${from} to ${to}`);
  }
  if (from === "confirmed" && to === "published") {
    const answerUrl = input.answerUrl?.trim();
    if (!answerUrl) {
      throw new ReviewTransitionError("confirmed → published requires answerUrl");
    }
    return withTransition(review, to, input.by, {
      answerUrl,
      publishedAt: new Date().toISOString(),
    });
  }
  if (from === "pending" && to === "confirmed") {
    return withTransition(review, to, input.by, {
      confirmedAt: new Date().toISOString(),
    });
  }
  return withTransition(review, to, input.by, {
    confirmedAt: null,
  });
}

export function assertShortPublishable(review: ReviewFile): void;
export function assertShortPublishable(dir: string): Promise<void>;
export function assertShortPublishable(dirOrReview: string | ReviewFile): void | Promise<void> {
  if (typeof dirOrReview === "string") {
    return assertShortPublishableDir(dirOrReview);
  }
  assertReviewIsConfirmed(dirOrReview);
}

async function assertShortPublishableDir(dir: string): Promise<void> {
  const review = await readReview(dir);
  if (!review) {
    throw new ReviewTransitionError("short is not publishable: review.json is missing");
  }
  assertReviewIsConfirmed(review);
}

function assertReviewIsConfirmed(review: ReviewFile): void {
  if (review.state !== "confirmed") {
    throw new ReviewTransitionError(`short is not publishable: state is ${review.state}, expected confirmed`);
  }
}

function withTransition(
  review: ReviewFile,
  to: ReviewState,
  by: string | undefined,
  extra: Partial<ReviewFile>,
): ReviewFile {
  const entry: ReviewHistoryEntry = {
    from: review.state,
    to,
    at: new Date().toISOString(),
    ...(by ? { by } : {}),
  };
  return {
    ...review,
    ...extra,
    version: REVIEW_FILE_VERSION,
    state: to,
    history: [...(review.history ?? []), entry],
  };
}

function parseReviewFile(value: unknown): ReviewFile {
  if (!value || typeof value !== "object") {
    throw new ReviewTransitionError("review.json is not an object");
  }
  const record = value as Record<string, unknown>;
  const state = record.state;
  if (!isReviewState(state)) {
    throw new ReviewTransitionError("review.json is missing a valid state");
  }
  return {
    ...(record as unknown as ReviewFile),
    version: REVIEW_FILE_VERSION,
    state,
  };
}

function isReviewState(value: unknown): value is ReviewState {
  return value === "pending" || value === "confirmed" || value === "published";
}

function isMissingPathError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT");
}
