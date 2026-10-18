import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { GLOSSARY_LIMIT } from "./rewrite-prompt.js";

const HEADING_DENY = new Set([
  "核心标签", "反差细节", "人物小传", "当前现状", "当前状态", "故事圣经", "简介", "人物",
  "主要角色", "次要角色", "关系", "已知", "未知", "定位", "标签", "性格", "动机", "说话",
  "设定", "世界", "大纲", "章纲", "备忘", "规则", "文风", "主题", "基调",
]);

const HEADING_RE = /^(#{1,3})\s+(.+?)\s*$/;
const BRACKET_RE = /【([^】]{2,12})】/g;
const RELATION_RE = /([\u4e00-\u9fffA-Za-z0-9·]{2,12})\s*[（(]/g;

export async function extractGlossaryFromBookDir(
  bookDir: string,
  limit = GLOSSARY_LIMIT,
): Promise<string[]> {
  const names: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string): void => {
    const name = normalizeTerm(raw);
    if (!name || seen.has(name) || names.length >= limit) return;
    seen.add(name);
    names.push(name);
  };

  await collectRoleFilenames(join(bookDir, "story", "roles"), add);
  await collectFromFile(join(bookDir, "story", "character_matrix.md"), add, { headings: true, relations: true });
  await collectFromFile(join(bookDir, "story", "story_bible.md"), add, { headings: true, brackets: true });
  await collectFromFile(join(bookDir, "story", "current_state.md"), add, { brackets: true });
  await collectFromFile(join(bookDir, "story", "brief.md"), add, { brackets: true });
  return names.slice(0, limit);
}

export function glossaryTermsMissing(original: string, rewritten: string, glossary: readonly string[]): string[] {
  return glossary.filter((term) => original.includes(term) && !rewritten.includes(term));
}

function normalizeTerm(raw: string): string | undefined {
  const name = raw.trim().replace(/\.(md|json)$/i, "").replace(/^【|】$/g, "");
  if (name.length < 2 || name.length > 12) return undefined;
  if (HEADING_DENY.has(name)) return undefined;
  if (/^(第.+章|截至|当前|核心|人物|关系|已知|未知|字段|值)/.test(name)) return undefined;
  if (!/[\u4e00-\u9fff]/.test(name)) return undefined;
  return name;
}

async function collectRoleFilenames(rolesDir: string, add: (name: string) => void): Promise<void> {
  const stack = [rolesDir];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        add(entry.name);
        stack.push(path);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        add(entry.name);
      }
    }
  }
}

async function collectFromFile(
  path: string,
  add: (name: string) => void,
  opts: { headings?: boolean; brackets?: boolean; relations?: boolean },
): Promise<void> {
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch {
    return;
  }
  if (opts.headings) {
    for (const line of raw.split("\n")) {
      const match = HEADING_RE.exec(line);
      if (match?.[2]) add(match[2]);
    }
  }
  if (opts.brackets) {
    for (const match of raw.matchAll(BRACKET_RE)) {
      if (match[1]) add(match[1]);
    }
  }
  if (opts.relations) {
    for (const match of raw.matchAll(RELATION_RE)) {
      if (match[1]) add(match[1]);
    }
  }
}
