import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const FOUNDATION_REVIEW_VERSION = 1;
export const FOUNDATION_REVIEW_THRESHOLD = 80;

export const FOUNDATION_REVIEW_STATUSES = [
  "passed",
  "accepted-with-warning",
  "parse-failed",
  "acked",
] as const;

export type FoundationReviewStatus = (typeof FOUNDATION_REVIEW_STATUSES)[number];

export interface FoundationReviewDimension {
  readonly name: string;
  readonly score: number;
  readonly feedback: string;
}

export interface FoundationReviewUserAck {
  readonly at: string;
  readonly by?: string;
}

export interface FoundationReviewRecord {
  readonly version: typeof FOUNDATION_REVIEW_VERSION;
  readonly status: FoundationReviewStatus;
  readonly passed: boolean;
  readonly totalScore: number;
  readonly threshold: number;
  readonly attempts: number;
  readonly reviewedAt: string;
  readonly overallFeedback: string;
  readonly dimensions: ReadonlyArray<FoundationReviewDimension>;
  readonly userAck: FoundationReviewUserAck | null;
}

export interface CreateFoundationReviewInput {
  readonly status: FoundationReviewStatus;
  readonly passed: boolean;
  readonly totalScore: number;
  readonly threshold?: number;
  readonly attempts: number;
  readonly overallFeedback: string;
  readonly dimensions?: ReadonlyArray<FoundationReviewDimension>;
  readonly reviewedAt?: string;
  readonly userAck?: FoundationReviewUserAck | null;
}

export function foundationReviewJsonPath(bookDir: string): string {
  return join(bookDir, "story", "foundation-review.json");
}

export function isFoundationReviewAlert(
  status: FoundationReviewStatus | string | null | undefined,
): boolean {
  return status === "accepted-with-warning" || status === "parse-failed";
}

export function createFoundationReviewRecord(
  input: CreateFoundationReviewInput,
): FoundationReviewRecord {
  return {
    version: FOUNDATION_REVIEW_VERSION,
    status: input.status,
    passed: input.passed,
    totalScore: input.totalScore,
    threshold: input.threshold ?? FOUNDATION_REVIEW_THRESHOLD,
    attempts: input.attempts,
    reviewedAt: input.reviewedAt ?? new Date().toISOString(),
    overallFeedback: input.overallFeedback,
    dimensions: input.dimensions ? [...input.dimensions] : [],
    userAck: input.userAck ?? null,
  };
}

export async function readFoundationReview(
  bookDir: string,
): Promise<FoundationReviewRecord | undefined> {
  try {
    const raw = await readFile(foundationReviewJsonPath(bookDir), "utf-8");
    return parseFoundationReview(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

export async function writeFoundationReview(
  bookDir: string,
  record: FoundationReviewRecord,
): Promise<string> {
  const path = foundationReviewJsonPath(bookDir);
  const payload = createFoundationReviewRecord(record);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
  await patchBookFoundationReviewStatus(bookDir, payload.status);
  return path;
}

export async function ackFoundationReview(
  bookDir: string,
  ack?: { readonly at?: string; readonly by?: string },
): Promise<FoundationReviewRecord | undefined> {
  const current = await readFoundationReview(bookDir);
  if (!current) return undefined;
  if (current.status === "passed" || current.status === "acked") {
    return current;
  }
  const userAck: FoundationReviewUserAck = {
    at: ack?.at ?? new Date().toISOString(),
    ...(ack?.by ? { by: ack.by } : {}),
  };
  const next = createFoundationReviewRecord({
    ...current,
    status: "acked",
    userAck,
  });
  await writeFoundationReview(bookDir, next);
  return next;
}

function parseFoundationReview(raw: unknown): FoundationReviewRecord | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;
  if (!isFoundationReviewStatus(obj.status)) return undefined;
  const dimensions = Array.isArray(obj.dimensions)
    ? obj.dimensions.flatMap((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return [];
      const dim = item as Record<string, unknown>;
      if (typeof dim.name !== "string" || typeof dim.score !== "number" || typeof dim.feedback !== "string") {
        return [];
      }
      return [{ name: dim.name, score: dim.score, feedback: dim.feedback }];
    })
    : [];
  return createFoundationReviewRecord({
    status: obj.status,
    passed: obj.passed === true,
    totalScore: typeof obj.totalScore === "number" ? obj.totalScore : 0,
    threshold: typeof obj.threshold === "number" ? obj.threshold : FOUNDATION_REVIEW_THRESHOLD,
    attempts: typeof obj.attempts === "number" ? obj.attempts : 0,
    reviewedAt: typeof obj.reviewedAt === "string" ? obj.reviewedAt : new Date().toISOString(),
    overallFeedback: typeof obj.overallFeedback === "string" ? obj.overallFeedback : "",
    dimensions,
    userAck: parseUserAck(obj.userAck),
  });
}

function parseUserAck(raw: unknown): FoundationReviewUserAck | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.at !== "string" || !obj.at) return null;
  return {
    at: obj.at,
    ...(typeof obj.by === "string" && obj.by ? { by: obj.by } : {}),
  };
}

function isFoundationReviewStatus(value: unknown): value is FoundationReviewStatus {
  return typeof value === "string" && (FOUNDATION_REVIEW_STATUSES as readonly string[]).includes(value);
}

async function patchBookFoundationReviewStatus(
  bookDir: string,
  status: FoundationReviewStatus,
): Promise<void> {
  const path = join(bookDir, "book.json");
  try {
    const raw = await readFile(path, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
    if (parsed.foundationReviewStatus === status) return;
    parsed.foundationReviewStatus = status;
    await writeFile(path, `${JSON.stringify(parsed, null, 2)}\n`, "utf-8");
  } catch {
    // book.json may not exist yet (initBook writes the review after staging is created).
  }
}
