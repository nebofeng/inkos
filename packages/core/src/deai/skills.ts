/**
 * Custom de-AI skills: SKILL.md directories with YAML frontmatter.
 * Never eval/execute user code. Unknown fields are ignored.
 *
 * Location priority (high wins on the same id):
 *   book `books/<id>/skills/`
 *   > project `.agents/skills/` then `skills/`
 *   > user `~/.agents/skills/` (HOME / injectable homeDir)
 *   > built-in `packages/core/skills/`
 *
 * Explicit selection (who to load) is separate: CLI --skill > book.deAI.skill
 * > project.deAI.skill > default inkos-story-deslop. Invalid copies fall back
 * to the next location, then the built-in default.
 */

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import yaml from "js-yaml";
import { builtinSkillsRoot } from "../skills/builtin-loader.js";
import {
  MAX_SKILL_MANIFEST_BYTES,
  discoverSkillDirs,
  parseSkillFrontmatter,
} from "../skills/external-loader.js";
import { DEFAULT_DEAI_SKILL } from "./config.js";

export const DEAI_SKILL_KIND = "deai";
export const DEAI_SCORER_BUILTIN = "builtin-ai-flavor";
export const MAX_BANNED_PATTERN_CHARS = 256;
export const MAX_BANNED_PATTERNS = 64;
export const MAX_BANNED_PHRASE_CHARS = 128;
export const MAX_BANNED_PHRASES = 64;

const SOURCE_RANK = { book: 0, project: 1, user: 2, builtin: 3 } as const;

export type DeAISkillSource = keyof typeof SOURCE_RANK;

export interface DeAISkillError {
  readonly code: string;
  readonly message: string;
  readonly field?: string;
}

export interface DeAISkill {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly body: string;
  readonly source: DeAISkillSource;
  readonly path: string;
  readonly kind: typeof DEAI_SKILL_KIND;
  readonly version?: string;
  readonly language?: string;
  readonly bannedPhrases: readonly string[];
  readonly bannedPatterns: readonly string[];
  readonly preserve: readonly string[];
  readonly scorer: typeof DEAI_SCORER_BUILTIN;
}

export interface DeAISkillListItem {
  readonly id: string;
  readonly source: DeAISkillSource;
  readonly path: string;
  readonly valid: boolean;
  readonly errors: readonly DeAISkillError[];
  readonly description?: string;
  readonly shadowed?: boolean;
}

export interface DeAISkillRecord extends DeAISkillListItem {
  readonly name?: string;
  readonly body: string;
  readonly version?: string;
  readonly language?: string;
  readonly bannedPhrases: readonly string[];
  readonly bannedPatterns: readonly string[];
  readonly preserve: readonly string[];
  readonly scorer?: string;
  readonly kind?: string;
}

export interface DeAISkillLookupInput {
  readonly projectRoot: string;
  readonly bookId?: string;
  readonly homeDir?: string;
  readonly env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
}

export interface ValidateDeAISkillResult {
  readonly valid: boolean;
  readonly errors: readonly DeAISkillError[];
  readonly skill?: DeAISkillRecord;
}

export interface ResolveDeAISkillResult {
  readonly skill: DeAISkill;
  readonly requestedId: string;
  readonly fallback: boolean;
  readonly warnings: readonly string[];
}

export interface CreateDeAISkillInput {
  readonly from?: string;
  readonly scope: "project" | "book";
  readonly projectRoot: string;
  readonly bookId?: string;
  readonly homeDir?: string;
  readonly env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
}

interface SkillDir {
  readonly path: string;
  readonly source: DeAISkillSource;
  readonly dirIndex: number;
}

interface ParsedCandidate extends Omit<DeAISkillRecord, "shadowed"> {
  shadowed?: boolean;
  readonly dirIndex: number;
  readonly isDeAI: boolean;
}

export async function listDeAISkills(
  input: DeAISkillLookupInput,
): Promise<DeAISkillListItem[]> {
  const candidates = await scanCandidates(input);
  const deai = candidates.filter((item) => item.isDeAI);
  markShadowed(deai);
  return deai.sort(comparePriority).map((item) => toListItem(item));
}

export async function getDeAISkill(
  id: string,
  input: DeAISkillLookupInput,
): Promise<DeAISkillRecord | undefined> {
  const wanted = normalizeSkillId(id);
  const candidates = (await scanCandidates(input))
    .filter((item) => item.id === wanted && item.isDeAI);
  if (candidates.length === 0) return undefined;
  markShadowed(candidates);
  const winner = [...candidates].sort(comparePriority)[0];
  return winner ? stripInternal(winner) : undefined;
}

export async function validateDeAISkill(
  pathOrId: string,
  input: DeAISkillLookupInput,
): Promise<ValidateDeAISkillResult> {
  const asPath = await resolveValidateTarget(pathOrId, input.projectRoot);
  if (asPath) {
    const source = inferSourceFromPath(asPath, input);
    const parsed = await parseSkillFile(asPath, source, 0);
    const errors = parsed.isDeAI
      ? parsed.errors
      : [
          ...parsed.errors,
          {
            code: "kind",
            field: "kind",
            message: `custom deAI skills require kind: ${DEAI_SKILL_KIND}`,
          },
        ];
    const valid = errors.length === 0 && parsed.isDeAI && parsed.valid;
    return { valid, errors, skill: stripInternal(parsed) };
  }

  const record = await getDeAISkill(pathOrId, input);
  if (!record) {
    return {
      valid: false,
      errors: [{ code: "not_found", message: `deAI skill not found: ${pathOrId}` }],
    };
  }
  return { valid: record.valid, errors: record.errors, skill: record };
}

export async function resolveDeAISkill(
  id: string | undefined,
  input: DeAISkillLookupInput,
): Promise<ResolveDeAISkillResult> {
  const requestedId = normalizeSkillId(id ?? DEFAULT_DEAI_SKILL);
  const warnings: string[] = [];
  const candidates = (await scanCandidates(input))
    .filter((item) => item.id === requestedId)
    .sort(comparePriority);

  for (const candidate of candidates) {
    if (candidate.valid && candidate.isDeAI) {
      const skill = toSkill(candidate);
      return {
        skill,
        requestedId,
        fallback: skill.id !== requestedId || candidate.source !== candidates[0]?.source,
        warnings,
      };
    }
    const reason = candidate.errors[0]?.message ?? "invalid skill";
    warnings.push(
      `deAI skill "${requestedId}" at ${candidate.path} (${candidate.source}) is invalid (${reason}); falling back`,
    );
  }

  if (requestedId !== DEFAULT_DEAI_SKILL) {
    warnings.push(`deAI skill "${requestedId}" unavailable; falling back to ${DEFAULT_DEAI_SKILL}`);
    const fallback = await resolveDeAISkill(DEFAULT_DEAI_SKILL, input);
    return {
      skill: fallback.skill,
      requestedId,
      fallback: true,
      warnings: [...warnings, ...fallback.warnings],
    };
  }

  throw new Error(`built-in deAI skill ${DEFAULT_DEAI_SKILL} is missing or invalid`);
}

export async function createDeAISkill(
  id: string,
  input: CreateDeAISkillInput,
): Promise<{ readonly path: string }> {
  const skillId = normalizeSkillId(id);
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(skillId)) {
    throw new Error(`invalid deAI skill id: ${id}`);
  }
  if (input.scope === "book" && !input.bookId) {
    throw new Error("book scope requires bookId");
  }
  const root = resolve(input.projectRoot);
  const destDir = input.scope === "book"
    ? join(root, "books", input.bookId!, "skills", skillId)
    : join(root, ".agents", "skills", skillId);
  const destPath = join(destDir, "SKILL.md");
  if (await exists(destPath)) {
    throw new Error(`deAI skill already exists: ${destPath}`);
  }

  const fromId = normalizeSkillId(input.from ?? DEFAULT_DEAI_SKILL);
  const from = await getDeAISkill(fromId, {
    projectRoot: root,
    bookId: input.bookId,
    homeDir: input.homeDir,
    env: input.env,
  });
  const markdown = renderDeAISkillMarkdown({
    id: skillId,
    description: from?.description || `Custom de-AI skill ${skillId}`,
    body: from?.body?.trim() || defaultSkillBody(),
    version: from?.version ?? "1",
    language: from?.language ?? "zh",
    bannedPhrases: from?.bannedPhrases ?? [],
    bannedPatterns: from?.bannedPatterns ?? [],
    preserve: from?.preserve ?? [],
  });

  await mkdir(destDir, { recursive: true });
  await writeFile(destPath, markdown, "utf-8");
  return { path: destPath };
}

export function rewritePromptsForDeAISkill(skill: DeAISkill): readonly string[] | undefined {
  // Built-in default must keep sending DEFAULT_DEAI_PROMPTS (local rewrite).
  if (skill.id === DEFAULT_DEAI_SKILL && skill.source === "builtin") return undefined;
  const body = skill.body.trim();
  return body ? [body] : undefined;
}

export function scanDeAISkillBans(text: string, skill: Pick<DeAISkill, "bannedPhrases" | "bannedPatterns">): string[] {
  const issues: string[] = [];
  for (const phrase of skill.bannedPhrases) {
    if (phrase && text.includes(phrase)) {
      issues.push(`bannedPhrase: ${phrase}`);
    }
  }
  for (const source of skill.bannedPatterns) {
    const compiled = tryCompilePattern(source);
    if (!compiled) continue;
    compiled.lastIndex = 0;
    if (compiled.test(text)) {
      issues.push(`bannedPattern: ${source}`);
    }
  }
  return issues;
}

export function parseDeAISkillMarkdown(
  raw: string,
  options: { readonly path: string; readonly source: DeAISkillSource },
): DeAISkillRecord {
  return stripInternal(parseRaw(raw, options.path, options.source, 0));
}

async function scanCandidates(input: DeAISkillLookupInput): Promise<ParsedCandidate[]> {
  const dirs = skillDirs(input);
  const out: ParsedCandidate[] = [];
  for (const dir of dirs) {
    const found = await safeDiscover(dir.path);
    for (const skillDir of found) {
      out.push(await parseSkillFile(join(skillDir, "SKILL.md"), dir.source, dir.dirIndex));
    }
  }
  return out;
}

function skillDirs(input: DeAISkillLookupInput): SkillDir[] {
  const root = resolve(input.projectRoot);
  const home = resolveHomeDir(input);
  const dirs: SkillDir[] = [
    { path: builtinSkillsRoot(), source: "builtin", dirIndex: 0 },
    { path: join(home, ".agents", "skills"), source: "user", dirIndex: 1 },
    { path: join(root, ".agents", "skills"), source: "project", dirIndex: 2 },
    { path: join(root, "skills"), source: "project", dirIndex: 3 },
  ];
  if (input.bookId) {
    dirs.push({
      path: join(root, "books", input.bookId, "skills"),
      source: "book",
      dirIndex: 4,
    });
  }
  return dirs;
}

function resolveHomeDir(input: DeAISkillLookupInput): string {
  const fromInput = input.homeDir?.trim();
  if (fromInput) return fromInput;
  const fromEnv = input.env?.HOME ?? process.env.HOME;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  return homedir();
}

async function safeDiscover(dir: string): Promise<string[]> {
  try {
    return await discoverSkillDirs([resolve(dir)]);
  } catch {
    return [];
  }
}

async function parseSkillFile(
  skillPath: string,
  source: DeAISkillSource,
  dirIndex: number,
): Promise<ParsedCandidate> {
  const fallbackId = normalizeSkillId(basename(dirname(skillPath)));
  try {
    const info = await stat(skillPath);
    if (info.size > MAX_SKILL_MANIFEST_BYTES) {
      return invalidCandidate(fallbackId, skillPath, source, dirIndex, [{
        code: "size",
        message: `SKILL.md exceeds ${MAX_SKILL_MANIFEST_BYTES} bytes.`,
      }]);
    }
    const raw = await readFile(skillPath, "utf-8");
    return parseRaw(raw, skillPath, source, dirIndex);
  } catch (error) {
    return invalidCandidate(fallbackId, skillPath, source, dirIndex, [{
      code: "io",
      message: error instanceof Error ? error.message : String(error),
    }]);
  }
}

function parseRaw(
  raw: string,
  skillPath: string,
  source: DeAISkillSource,
  dirIndex: number,
): ParsedCandidate {
  const fallbackId = normalizeSkillId(basename(dirname(skillPath)));
  let parsed: { data: unknown; body: string };
  try {
    parsed = parseDeAIFrontmatter(raw);
  } catch (error) {
    return invalidCandidate(fallbackId, skillPath, source, dirIndex, [{
      code: "yaml",
      message: error instanceof Error ? error.message : String(error),
    }]);
  }

  if (!parsed.data || typeof parsed.data !== "object" || Array.isArray(parsed.data)) {
    return invalidCandidate(fallbackId, skillPath, source, dirIndex, [{
      code: "yaml",
      message: "SKILL.md frontmatter must be a YAML object.",
    }]);
  }

  const data = parsed.data as Record<string, unknown>;
  const errors: DeAISkillError[] = [];
  const name = readRequiredText(data.name, "name", 64, errors) ?? fallbackId;
  const id = normalizeSkillId(name || fallbackId);
  const description = readRequiredText(data.description, "description", 1024, errors) ?? "";
  const kind = readOptionalText(data.kind);
  const builtinDeslopCompat = source === "builtin" && id === DEFAULT_DEAI_SKILL && (kind === undefined || kind === DEAI_SKILL_KIND);
  const isDeAI = kind === DEAI_SKILL_KIND || builtinDeslopCompat;

  if (kind !== undefined && kind !== DEAI_SKILL_KIND) {
    errors.push({
      code: "kind",
      field: "kind",
      message: `kind must be "${DEAI_SKILL_KIND}" (got "${kind}")`,
    });
  }
  if (kind === undefined && !builtinDeslopCompat) {
    errors.push({
      code: "kind",
      field: "kind",
      message: `custom deAI skills require kind: ${DEAI_SKILL_KIND}`,
    });
  }

  const bannedPhrases = readStringArray(data.bannedPhrases, "bannedPhrases", MAX_BANNED_PHRASES, MAX_BANNED_PHRASE_CHARS, errors);
  const bannedPatterns = readStringArray(data.bannedPatterns, "bannedPatterns", MAX_BANNED_PATTERNS, MAX_BANNED_PATTERN_CHARS, errors);
  for (const pattern of bannedPatterns) {
    if (!tryCompilePattern(pattern)) {
      errors.push({
        code: "regex",
        field: "bannedPatterns",
        message: `invalid regex: ${pattern}`,
      });
    }
  }
  const preserve = readStringArray(data.preserve, "preserve", MAX_BANNED_PHRASES, MAX_BANNED_PHRASE_CHARS, errors);
  const scorerRaw = readOptionalText(data.scorer);
  const scorer = scorerRaw ?? DEAI_SCORER_BUILTIN;
  if (scorer !== DEAI_SCORER_BUILTIN) {
    errors.push({
      code: "scorer",
      field: "scorer",
      message: `scorer must be "${DEAI_SCORER_BUILTIN}" in v1`,
    });
  }

  const valid = errors.length === 0 && isDeAI;
  return {
    id,
    name,
    description,
    body: parsed.body.replace(/^\uFEFF/, ""),
    source,
    path: skillPath,
    valid,
    errors,
    kind: kind ?? (builtinDeslopCompat ? DEAI_SKILL_KIND : undefined),
    version: readOptionalScalar(data.version),
    language: readOptionalText(data.language),
    bannedPhrases,
    bannedPatterns,
    preserve,
    scorer,
    dirIndex,
    isDeAI,
  };
}

function parseDeAIFrontmatter(raw: string): { data: unknown; body: string } {
  // Split with the shared helper first so delimiter errors match Agent Skills,
  // then re-load YAML with CORE_SCHEMA so !!js/* tags cannot execute.
  const split = parseSkillFrontmatter(raw);
  const normalized = raw.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const end = normalized.indexOf("\n---", 4);
  const frontmatter = normalized.slice(4, end).trim();
  try {
    return {
      data: yaml.load(frontmatter, { schema: yaml.CORE_SCHEMA }),
      body: split.body,
    };
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : String(error));
  }
}

function readRequiredText(
  value: unknown,
  field: string,
  maxChars: number,
  errors: DeAISkillError[],
): string | undefined {
  if (typeof value !== "string" || !value.trim()) {
    errors.push({ code: "required", field, message: `SKILL.md frontmatter requires ${field}.` });
    return undefined;
  }
  const text = value.trim();
  if (text.length > maxChars) {
    errors.push({ code: "length", field, message: `${field} must be at most ${maxChars} characters.` });
  }
  return text;
}

function readOptionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readOptionalScalar(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function readStringArray(
  value: unknown,
  field: string,
  maxItems: number,
  maxChars: number,
  errors: DeAISkillError[],
): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    errors.push({ code: "type", field, message: `${field} must be an array of strings.` });
    return [];
  }
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") {
      errors.push({ code: "type", field, message: `${field} entries must be strings.` });
      continue;
    }
    const text = item.trim();
    if (!text) continue;
    if (text.length > maxChars) {
      errors.push({
        code: "length",
        field,
        message: `${field} entry exceeds ${maxChars} characters.`,
      });
      continue;
    }
    out.push(text);
  }
  if (out.length > maxItems) {
    errors.push({
      code: "length",
      field,
      message: `${field} supports at most ${maxItems} entries.`,
    });
    return out.slice(0, maxItems);
  }
  return out;
}

function tryCompilePattern(source: string): RegExp | undefined {
  if (!source || source.length > MAX_BANNED_PATTERN_CHARS) return undefined;
  try {
    return new RegExp(source);
  } catch {
    return undefined;
  }
}

function invalidCandidate(
  id: string,
  path: string,
  source: DeAISkillSource,
  dirIndex: number,
  errors: DeAISkillError[],
): ParsedCandidate {
  return {
    id,
    name: id,
    description: "",
    body: "",
    source,
    path,
    valid: false,
    errors,
    bannedPhrases: [],
    bannedPatterns: [],
    preserve: [],
    dirIndex,
    isDeAI: true,
  };
}

function markShadowed(items: ParsedCandidate[]): void {
  const best = new Map<string, ParsedCandidate>();
  for (const item of [...items].sort(comparePriority)) {
    if (!best.has(item.id)) best.set(item.id, item);
  }
  for (const item of items) {
    const winner = best.get(item.id);
    item.shadowed = Boolean(winner && winner.path !== item.path);
  }
}

function comparePriority(a: ParsedCandidate, b: ParsedCandidate): number {
  if (a.id !== b.id) return a.id.localeCompare(b.id);
  const rank = SOURCE_RANK[a.source] - SOURCE_RANK[b.source];
  if (rank !== 0) return rank;
  return b.dirIndex - a.dirIndex;
}

function toListItem(item: ParsedCandidate): DeAISkillListItem {
  return {
    id: item.id,
    source: item.source,
    path: item.path,
    valid: item.valid,
    errors: item.errors,
    description: item.description || undefined,
    shadowed: item.shadowed,
  };
}

function stripInternal(item: ParsedCandidate): DeAISkillRecord {
  return {
    id: item.id,
    source: item.source,
    path: item.path,
    valid: item.valid,
    errors: item.errors,
    description: item.description || undefined,
    shadowed: item.shadowed,
    name: item.name,
    body: item.body,
    version: item.version,
    language: item.language,
    bannedPhrases: item.bannedPhrases,
    bannedPatterns: item.bannedPatterns,
    preserve: item.preserve,
    scorer: item.scorer,
    kind: item.kind,
  };
}

function toSkill(item: ParsedCandidate): DeAISkill {
  return {
    id: item.id,
    name: item.name ?? item.id,
    description: item.description ?? "",
    body: item.body,
    source: item.source,
    path: item.path,
    kind: DEAI_SKILL_KIND,
    version: item.version,
    language: item.language,
    bannedPhrases: item.bannedPhrases,
    bannedPatterns: item.bannedPatterns,
    preserve: item.preserve,
    scorer: DEAI_SCORER_BUILTIN,
  };
}

function normalizeSkillId(value: string): string {
  const id = value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!id) return "skill";
  return /^[a-z]/.test(id) ? id : `skill-${id}`;
}

async function resolveValidateTarget(pathOrId: string, projectRoot: string): Promise<string | undefined> {
  const trimmed = pathOrId.trim();
  if (!trimmed) return undefined;
  const looksLikePath = trimmed.endsWith("SKILL.md")
    || trimmed.includes("/")
    || trimmed.includes("\\")
    || trimmed.startsWith(".");
  if (!looksLikePath && !isAbsolute(trimmed)) return undefined;
  const candidate = isAbsolute(trimmed) ? trimmed : resolve(projectRoot, trimmed);
  try {
    const info = await stat(candidate);
    if (info.isDirectory()) return join(candidate, "SKILL.md");
    if (info.isFile()) return candidate;
  } catch {
    if (looksLikePath) return candidate.endsWith("SKILL.md") ? candidate : join(candidate, "SKILL.md");
  }
  return undefined;
}

function inferSourceFromPath(skillPath: string, input: DeAISkillLookupInput): DeAISkillSource {
  const normalized = skillPath.replace(/\\/g, "/");
  if (normalized.includes("/books/") && normalized.includes("/skills/")) return "book";
  if (normalized.includes("/.agents/skills/") || /\/skills\//.test(normalized)) {
    const home = resolveHomeDir(input).replace(/\\/g, "/");
    if (normalized.startsWith(home.replace(/\\/g, "/"))) return "user";
    const builtin = builtinSkillsRoot().replace(/\\/g, "/");
    if (normalized.startsWith(builtin)) return "builtin";
    return "project";
  }
  const builtin = builtinSkillsRoot().replace(/\\/g, "/");
  if (normalized.startsWith(builtin)) return "builtin";
  return "project";
}

function renderDeAISkillMarkdown(input: {
  readonly id: string;
  readonly description: string;
  readonly body: string;
  readonly version?: string;
  readonly language?: string;
  readonly bannedPhrases: readonly string[];
  readonly bannedPatterns: readonly string[];
  readonly preserve: readonly string[];
}): string {
  const doc = {
    name: input.id,
    description: input.description,
    kind: DEAI_SKILL_KIND,
    version: input.version ?? "1",
    language: input.language ?? "zh",
    bannedPhrases: [...input.bannedPhrases],
    bannedPatterns: [...input.bannedPatterns],
    preserve: [...input.preserve],
    scorer: DEAI_SCORER_BUILTIN,
  };
  const front = yaml.dump(doc, { lineWidth: 100, noRefs: true }).trimEnd();
  const body = input.body.trimEnd();
  return `---\n${front}\n---\n${body ? `\n${body}\n` : ""}`;
}

function defaultSkillBody(): string {
  return [
    "# 改写规则",
    "",
    "- 只改空泛、总结、对称金句；情节、人称、事实不动。",
    "- 换成大白话、短句、具体动作；不要新增情节。",
  ].join("\n");
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
