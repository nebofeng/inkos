import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isSafeBookId } from "../utils/book-id.js";
import { countAnswerChars } from "./quality.js";
import { readReview, ReviewTransitionError, writeReview, type ReviewFile } from "./review.js";

export interface ShortListItem {
  readonly id: string;
  readonly title: string;
  readonly batch?: string;
  readonly source?: string;
  readonly platform?: string;
  readonly charCount: number;
  readonly productionStatus?: string;
  readonly reviewState: string;
  readonly answerUrl?: string | null;
  readonly finalPath: string;
}

export interface ShortDetail extends ShortListItem {
  readonly markdown: string;
  readonly review?: ReviewFile;
  readonly ruleCardIds?: ReadonlyArray<string>;
  readonly status?: unknown;
}

export async function listShorts(projectRoot: string, outDir = "shorts"): Promise<ShortListItem[]> {
  const root = join(projectRoot, outDir);
  let names: string[] = [];
  try {
    names = await readdir(root);
  } catch {
    return [];
  }
  const items: ShortListItem[] = [];
  for (const name of names) {
    if (!isSafeBookId(name)) continue;
    const dir = join(root, name);
    const info = await stat(dir).catch(() => undefined);
    if (!info?.isDirectory()) continue;
    items.push(await readShortListItem(dir, name));
  }
  items.sort((a, b) => a.id.localeCompare(b.id));
  return items;
}

export async function readShortDetail(projectRoot: string, id: string, outDir = "shorts"): Promise<ShortDetail | undefined> {
  if (!isSafeBookId(id)) return undefined;
  const dir = join(projectRoot, outDir, id);
  if (!await existsDir(dir)) return undefined;
  const item = await readShortListItem(dir, id);
  const review = await readReview(dir);
  const markdown = await readFinalMarkdown(dir, item.finalPath);
  const ruleCards = await readJson(join(dir, "rule-cards.json"));
  const status = await readJson(join(dir, "status.json"));
  const stages = ruleCards && typeof ruleCards === "object" ? (ruleCards as { stages?: Record<string, string[]> }).stages : undefined;
  const ruleCardIds = stages
    ? [...new Set(Object.values(stages).flat())]
    : undefined;
  return {
    ...item,
    markdown,
    review,
    ruleCardIds,
    status,
  };
}

async function readShortListItem(dir: string, id: string): Promise<ShortListItem> {
  const review = await readReview(dir);
  const status = await readJson(join(dir, "status.json"));
  const finalPath = review?.finalPath ?? (await existsFile(join(dir, "final", "zhihu-answer.md")) ? "final/zhihu-answer.md" : "final/full.md");
  const markdown = await readFinalMarkdown(dir, finalPath);
  return {
    id,
    title: review?.title ?? id,
    batch: review?.batch,
    source: review?.source,
    platform: review?.platform,
    charCount: countAnswerChars(markdown, "zh"),
    productionStatus: typeof status?.status === "string" ? status.status : undefined,
    reviewState: review?.state ?? "pending",
    answerUrl: review?.answerUrl ?? null,
    finalPath,
  };
}

async function readFinalMarkdown(dir: string, finalPath: string): Promise<string> {
  try {
    return await readFile(join(dir, finalPath), "utf-8");
  } catch {
    try {
      return await readFile(join(dir, "final", "full.md"), "utf-8");
    } catch {
      return "";
    }
  }
}

async function readJson(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf-8")) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
  return undefined;
}

async function existsDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function existsFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

export async function writeShortFinal(dir: string, markdown: string): Promise<ReviewFile> {
  const review = await readReview(dir);
  if (review?.state === "published") {
    throw new ReviewTransitionError("published shorts are read-only");
  }
  const finalPath = review?.finalPath ?? "final/full.md";
  const absFinal = join(dir, finalPath);
  let previous = "";
  try {
    previous = await readFile(absFinal, "utf-8");
  } catch {
    previous = "";
  }
  if (previous && previous !== markdown) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const historyDir = join(dir, "final", "history");
    await mkdir(historyDir, { recursive: true });
    await writeFile(join(historyDir, `${stamp}.md`), previous, "utf-8");
  }
  await mkdir(join(dir, "final"), { recursive: true });
  await writeFile(absFinal, markdown, "utf-8");
  if (finalPath !== "final/full.md") {
    await writeFile(join(dir, "final", "full.md"), markdown, "utf-8");
  }
  let next = review;
  if (!next) {
    next = { version: 1, state: "pending", finalPath };
    await writeReview(dir, next);
    return next;
  }
  if (next.state === "confirmed") {
    next = {
      ...next,
      state: "pending",
      confirmedAt: null,
      history: [
        ...(next.history ?? []),
        { from: "confirmed", to: "pending", at: new Date().toISOString(), by: "studio-user" },
      ],
    };
    await writeReview(dir, next);
  }
  return next;
}
