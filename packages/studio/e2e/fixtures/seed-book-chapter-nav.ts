import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { E2E_ROOT } from "./seed-analysis";

/** Chinese book id on purpose: it must survive hash encode/decode on the way to the chapter route. */
export const E2E_NAV_BOOK_ID = "我给仙族管账三百年";
export const E2E_NAV_BOOK_TITLE = "我给仙族管账三百年";

export async function seedBookChapterNav(): Promise<void> {
  const bookDir = join(E2E_ROOT, "books", E2E_NAV_BOOK_ID);
  const now = new Date().toISOString();
  await mkdir(join(bookDir, "chapters"), { recursive: true });
  await writeFile(join(bookDir, "book.json"), JSON.stringify({
    id: E2E_NAV_BOOK_ID,
    title: E2E_NAV_BOOK_TITLE,
    platform: "other",
    genre: "xianxia",
    status: "active",
    targetChapters: 10,
    chapterWordCount: 3000,
    language: "zh",
    createdAt: now,
    updatedAt: now,
  }, null, 2));
  await writeFile(join(bookDir, "chapters", "index.json"), JSON.stringify([
    { number: 1, title: "账房先生", status: "drafted", wordCount: 20, createdAt: now, updatedAt: now, auditIssues: [], lengthWarnings: [] },
  ], null, 2));
  await writeFile(join(bookDir, "chapters", "0001_账房先生.md"), "# 第1章 账房先生\n\n陆青接过仙族的账本，第一页就记错了三百块灵石。\n");
}
