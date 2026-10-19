import { readdir, readFile, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import yaml from "js-yaml";
import { safeParseRuleCard, type RuleCard } from "./schema.js";

export interface RuleCardsLogger {
  readonly warn?: (message: string, ctx?: Record<string, unknown>) => void;
  readonly info?: (message: string, ctx?: Record<string, unknown>) => void;
}

export interface LoadRuleCardsInput {
  readonly projectRoot: string;
  /** inkos.json `ruleCards.dir`; relative paths resolve against projectRoot. */
  readonly configDir?: string;
  readonly logger?: RuleCardsLogger;
}

const YAML_EXT = new Set([".yaml", ".yml"]);

export async function loadRuleCards(input: LoadRuleCardsInput): Promise<RuleCard[]> {
  const dirs = [join(input.projectRoot, "kb", "cards")];
  if (input.configDir?.trim()) {
    dirs.push(resolveMaybeRelative(input.projectRoot, input.configDir.trim()));
  }

  const cards: RuleCard[] = [];
  const seen = new Map<string, string>();

  for (const dir of dirs) {
    const files = await listYamlFiles(dir, input.logger);
    for (const filePath of files) {
      await loadFile(filePath, cards, seen, input.logger);
    }
  }

  return cards;
}

async function listYamlFiles(dir: string, logger: RuleCardsLogger | undefined): Promise<string[]> {
  try {
    const info = await stat(dir);
    if (!info.isDirectory()) {
      logger?.warn?.(`rule-cards path is not a directory: ${dir}`);
      return [];
    }
  } catch (error) {
    if (isMissingPathError(error)) return [];
    logger?.warn?.(`failed to read rule-cards directory ${dir}: ${errorMessage(error)}`);
    return [];
  }

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (error) {
    logger?.warn?.(`failed to list rule-cards directory ${dir}: ${errorMessage(error)}`);
    return [];
  }

  return entries
    .filter((name) => YAML_EXT.has(extnameLower(name)))
    .sort((a, b) => a.localeCompare(b))
    .map((name) => join(dir, name));
}

async function loadFile(
  filePath: string,
  cards: RuleCard[],
  seen: Map<string, string>,
  logger: RuleCardsLogger | undefined,
): Promise<void> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch (error) {
    logger?.warn?.(`failed to read rule-cards file ${filePath}: ${errorMessage(error)}`);
    return;
  }

  let parsed: unknown;
  try {
    parsed = yaml.load(raw);
  } catch (error) {
    logger?.warn?.(`failed to parse rule-cards file ${filePath}: ${errorMessage(error)}`);
    return;
  }

  const items = normalizeYamlItems(parsed);
  if (items === null) {
    if (parsed == null) return;
    logger?.warn?.(`rule-cards file ${filePath} is not a card or list of cards`);
    return;
  }

  for (const [index, item] of items.entries()) {
    const result = safeParseRuleCard(item);
    if (!result.ok) {
      const id = peekId(item);
      logger?.warn?.(
        `skipping invalid rule card${id ? ` ${id}` : ""} in ${filePath}[${index}]: ${result.error}`,
      );
      continue;
    }

    const existing = seen.get(result.card.id);
    if (existing) {
      logger?.warn?.(
        `duplicate rule card id ${result.card.id}; keeping first from ${existing}`,
        { id: result.card.id, file: filePath },
      );
      continue;
    }

    seen.set(result.card.id, filePath);
    cards.push(result.card);
  }
}

function normalizeYamlItems(parsed: unknown): unknown[] | null {
  if (parsed == null) return [];
  if (Array.isArray(parsed)) return parsed;
  if (typeof parsed === "object") return [parsed];
  return null;
}

function peekId(item: unknown): string | undefined {
  if (item && typeof item === "object" && "id" in item && typeof item.id === "string") {
    return item.id;
  }
  return undefined;
}

function resolveMaybeRelative(projectRoot: string, path: string): string {
  return isAbsolute(path) ? path : join(projectRoot, path);
}

function extnameLower(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot).toLowerCase() : "";
}

function isMissingPathError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
