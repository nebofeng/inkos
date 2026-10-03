/**
 * Truth-file roster for the story graph.
 *
 * character_matrix.md (+ roles/ cards) and current_state are authoritative.
 * The reconciler uses this roster to (1) canonicalise extracted names via
 * aliases, (2) override extracted life status, and (3) suppress extracted
 * relationship edges whose polarity contradicts the matrix "关系" field.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { readRoleCards } from "../utils/outline-paths.js";
import type { CharacterStatus } from "./types.js";

export interface TruthCharacter {
  readonly name: string;
  readonly aliases: ReadonlyArray<string>;
  readonly role?: string;
  /** Only set when a truth file states it explicitly (conservative). */
  readonly status?: CharacterStatus;
  /** other character name → relation description from the matrix. */
  readonly relations: ReadonlyMap<string, string>;
  readonly protagonist: boolean;
}

export interface TruthRoster {
  readonly characters: ReadonlyArray<TruthCharacter>;
}

const ALIAS_KEYS = /^(别名|外号|绰号|称呼|昵称|代号|化名|aka|alias(?:es)?|nicknames?)$/i;
const ROLE_KEYS = /^(定位|身份|role|position)$/i;
const STATUS_KEYS = /^(状态|生死|status)$/i;
const CURRENT_KEYS = /^(当前|current)$/i;
const RELATION_KEYS = /^(关系|relations?(?:hips)?)$/i;

export async function loadTruthRoster(bookDir: string): Promise<TruthRoster> {
  const [matrix, cards, currentState] = await Promise.all([
    readFile(join(bookDir, "story", "character_matrix.md"), "utf-8").catch(() => ""),
    readRoleCards(bookDir).catch(() => []),
    readFile(join(bookDir, "story", "current_state.md"), "utf-8").catch(() => ""),
  ]);
  const byName = new Map<string, MutableTruth>();
  for (const parsed of parseCharacterMatrix(matrix)) mergeTruth(byName, parsed);
  for (const card of cards) {
    mergeTruth(byName, {
      name: card.name,
      aliases: extractInlineAliases(card.content),
      relations: new Map(),
      protagonist: card.tier === "major" && /主角|protagonist/i.test(card.content.slice(0, 400)),
    });
  }
  // current_state.md fills in life status the matrix does not state.
  for (const [name, status] of detectStatusesInCurrentState(currentState, [...byName.keys()])) {
    const entry = byName.get(name);
    if (entry && !entry.status) entry.status = status;
  }
  return { characters: [...byName.values()].map(freezeTruth) };
}

/**
 * Very conservative: "<name>已死/身亡/阵亡/殒命/失踪…" directly after the name,
 * on a line without hedging words (以为/传言/疑似/假死…).
 */
export function detectStatusesInCurrentState(
  markdown: string,
  names: ReadonlyArray<string>,
): Map<string, CharacterStatus> {
  const out = new Map<string, CharacterStatus>();
  if (!markdown.trim()) return out;
  for (const line of markdown.split("\n")) {
    if (/(以为|传言|谣言|疑似|据说|假死|诈死|或许|可能|不要写成|并未|没有死|没死)/.test(line)) continue;
    for (const name of names) {
      if (name.length < 2) continue;
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (new RegExp(`${escaped}(?:已经|已)?(?:死亡|死了|身亡|阵亡|殒命|遇害|去世)`).test(line)) out.set(name, "dead");
      else if (new RegExp(`${escaped}(?:已经|已)?(?:失踪|下落不明)`).test(line)) out.set(name, "missing");
    }
  }
  return out;
}

interface MutableTruth {
  name: string;
  aliases: Set<string>;
  role?: string;
  status?: CharacterStatus;
  relations: Map<string, string>;
  protagonist: boolean;
}

function mergeTruth(
  target: Map<string, MutableTruth>,
  entry: { name: string; aliases: Iterable<string>; role?: string; status?: CharacterStatus; relations: ReadonlyMap<string, string>; protagonist: boolean },
): void {
  const existing = target.get(entry.name);
  if (!existing) {
    target.set(entry.name, {
      name: entry.name,
      aliases: new Set([...entry.aliases].filter((alias) => alias !== entry.name)),
      role: entry.role,
      status: entry.status,
      relations: new Map(entry.relations),
      protagonist: entry.protagonist,
    });
    return;
  }
  for (const alias of entry.aliases) if (alias !== existing.name) existing.aliases.add(alias);
  existing.role ??= entry.role;
  existing.status ??= entry.status;
  for (const [other, desc] of entry.relations) if (!existing.relations.has(other)) existing.relations.set(other, desc);
  existing.protagonist ||= entry.protagonist;
}

function freezeTruth(entry: MutableTruth): TruthCharacter {
  return {
    name: entry.name,
    aliases: [...entry.aliases],
    ...(entry.role ? { role: entry.role } : {}),
    ...(entry.status ? { status: entry.status } : {}),
    relations: entry.relations,
    protagonist: entry.protagonist,
  };
}

/** Parse `## Name` sections with `- **Key**: value` fields. */
export function parseCharacterMatrix(markdown: string): Array<{
  name: string;
  aliases: string[];
  role?: string;
  status?: CharacterStatus;
  relations: Map<string, string>;
  protagonist: boolean;
}> {
  if (!markdown.trim()) return [];
  const out: ReturnType<typeof parseCharacterMatrix> = [];
  const sections = markdown.split(/^##\s+/m).slice(1);
  for (const section of sections) {
    const [headingLine = "", ...lines] = section.split("\n");
    const { name, aliases } = splitHeading(headingLine);
    if (!name || /^(角色|人物|characters?)\b/i.test(name) && lines.every((line) => !line.includes("**"))) continue;
    let role: string | undefined;
    let status: CharacterStatus | undefined;
    const relations = new Map<string, string>();
    for (const line of lines) {
      const match = line.match(/^\s*[-*]\s*\*\*(.+?)\*\*\s*[:：]\s*(.*)$/);
      if (!match) continue;
      const key = match[1]!.trim();
      const value = match[2]!.trim();
      if (ALIAS_KEYS.test(key)) aliases.push(...splitList(value));
      else if (ROLE_KEYS.test(key)) role = value.slice(0, 80);
      else if (STATUS_KEYS.test(key)) status = status ?? detectExplicitStatus(value);
      // "当前" is free-form situational prose; only a leading death/missing
      // statement ("已死于第8章…") counts there.
      else if (CURRENT_KEYS.test(key)) status = status ?? detectExplicitStatus(value.slice(0, 8));
      else if (RELATION_KEYS.test(key)) {
        for (const [other, desc] of parseRelationField(value)) relations.set(other, desc);
      }
    }
    out.push({
      name,
      aliases: [...new Set(aliases.filter((alias) => alias && alias !== name))],
      ...(role ? { role } : {}),
      ...(status ? { status } : {}),
      relations,
      protagonist: Boolean(role && /主角|protagonist/i.test(role)),
    });
  }
  return out;
}

function splitHeading(heading: string): { name: string; aliases: string[] } {
  const cleaned = heading.replace(/[#*`]/g, "").trim();
  const paren = cleaned.match(/^(.+?)\s*[（(]([^）)]+)[）)]\s*$/);
  if (paren) {
    return { name: paren[1]!.trim(), aliases: splitList(paren[2]!) };
  }
  const [first, ...rest] = cleaned.split(/\s*[/／|]\s*/);
  return { name: (first ?? "").trim(), aliases: rest.map((part) => part.trim()).filter(Boolean) };
}

function splitList(value: string): string[] {
  return value
    .split(/[、,，/／|;；]/)
    .map((part) => part.replace(/[“”"'「」]/g, "").replace(/[（(].*?[）)]/g, "").trim())
    .filter((part) => part.length > 0 && part.length <= 20 && !/^(无|暂无|none|n\/a)$/i.test(part));
}

function extractInlineAliases(content: string): string[] {
  const aliases: string[] = [];
  for (const match of content.matchAll(/(?:别名|外号|绰号|昵称|代号|化名|aka|alias(?:es)?)\s*[:：]\s*([^\n]+)/gi)) {
    aliases.push(...splitList(match[1]!));
  }
  return aliases;
}

/** `B(desc/Ch12) | C（desc）| D: desc` → Map(B→desc, …) */
export function parseRelationField(value: string): Map<string, string> {
  const relations = new Map<string, string>();
  for (const part of value.split(/\s*[|｜;；]\s*/)) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const paren = trimmed.match(/^([^（(:：]{1,20})\s*[（(](.*)[）)]\s*$/);
    const colon = trimmed.match(/^([^（(:：]{1,20})\s*[:：]\s*(.+)$/);
    const name = (paren?.[1] ?? colon?.[1] ?? "").trim();
    const desc = (paren?.[2] ?? colon?.[2] ?? "").replace(/\/\s*Ch\s*\d+\s*$/i, "").trim();
    if (name) relations.set(name, desc);
  }
  return relations;
}

/**
 * Conservative: only an explicit, non-negated death/missing statement counts.
 * "不要写成已经死亡" / "没死" must not flip a character to dead.
 */
export function detectExplicitStatus(value: string): CharacterStatus | undefined {
  const text = value.trim();
  const dead = /(已死|已故|身亡|阵亡|已经死亡|殒命|遇害|去世|\bdead\b|\bdeceased\b|\bkilled\b)/i.exec(text);
  if (dead && !isNegated(text, dead.index)) return "dead";
  const missing = /(失踪|下落不明|\bmissing\b)/i.exec(text);
  if (missing && !isNegated(text, missing.index)) return "missing";
  return undefined;
}

function isNegated(text: string, index: number): boolean {
  const before = text.slice(Math.max(0, index - 6), index);
  return /(不|没|未|别|非|勿|假|not|never|no)\s*\S{0,3}$/i.test(before) || /不要写成|并未|尚未|还没/.test(before);
}

export type RelationPolarity = "hostile" | "friendly" | "neutral";

const HOSTILE = /(敌|仇|对手|对头|追杀|反目|恨|宿敌|死对头|威胁|对立|enemy|rival|nemesis|hostile|hates?)/i;
const FRIENDLY = /(友|盟|恋|爱人|夫妻|师父|师傅|徒弟|亲|兄|姐|妹|弟|父|母|伴|搭档|同伴|战友|信任|ally|friend|lover|mentor|partner|family|trust)/i;

export function relationPolarity(text: string): RelationPolarity {
  const hostile = HOSTILE.test(text);
  const friendly = FRIENDLY.test(text);
  if (hostile && !friendly) return "hostile";
  if (friendly && !hostile) return "friendly";
  return "neutral";
}

/** alias/name → canonical name, longest-first matcher over text. */
export class NameResolver {
  private readonly lookup = new Map<string, string>();
  private sortedKeys: string[] = [];

  constructor(entries: Iterable<{ readonly name: string; readonly aliases: Iterable<string> }> = []) {
    for (const entry of entries) this.add(entry.name, entry.aliases);
  }

  add(name: string, aliases: Iterable<string> = [], override = false): void {
    const canonical = this.lookup.get(name) ?? name;
    for (const key of [name, ...aliases]) {
      const trimmed = key.trim();
      if (!trimmed || (trimmed.length < 2 && /[\u3400-\u9fff]/.test(trimmed) === false)) continue;
      if (!override && this.lookup.has(trimmed)) continue;
      this.lookup.set(trimmed, canonical);
    }
    this.sortedKeys = [...this.lookup.keys()].sort((a, b) => b.length - a.length);
  }

  canonical(name: string): string | undefined {
    return this.lookup.get(name.trim());
  }

  resolve(name: string): string {
    return this.canonical(name) ?? name.trim();
  }

  /** Canonical names mentioned in `text` (longest-match, non-overlapping). */
  findMentions(text: string): Map<string, number> {
    const counts = new Map<string, number>();
    if (!text) return counts;
    const taken: boolean[] = new Array(text.length).fill(false);
    for (const key of this.sortedKeys) {
      if (key.length < 2) continue;
      let from = 0;
      for (;;) {
        const at = text.indexOf(key, from);
        if (at < 0) break;
        from = at + key.length;
        let free = true;
        for (let i = at; i < at + key.length; i += 1) if (taken[i]) { free = false; break; }
        if (!free) continue;
        for (let i = at; i < at + key.length; i += 1) taken[i] = true;
        const canonical = this.lookup.get(key)!;
        counts.set(canonical, (counts.get(canonical) ?? 0) + 1);
      }
    }
    return counts;
  }

  /** Canonical name whose mention ends closest to the end of `text`. */
  lastMention(text: string): string | undefined {
    let best: { canonical: string; end: number } | undefined;
    for (const key of this.sortedKeys) {
      if (key.length < 2) continue;
      const at = text.lastIndexOf(key);
      if (at < 0) continue;
      const end = at + key.length;
      if (!best || end > best.end) best = { canonical: this.lookup.get(key)!, end };
    }
    return best?.canonical;
  }

  /** Canonical name mentioned earliest in `text`. */
  firstMention(text: string): string | undefined {
    let best: { canonical: string; at: number } | undefined;
    for (const key of this.sortedKeys) {
      if (key.length < 2) continue;
      const at = text.indexOf(key);
      if (at < 0) continue;
      if (!best || at < best.at) best = { canonical: this.lookup.get(key)!, at };
    }
    return best?.canonical;
  }

  names(): string[] {
    return [...new Set(this.lookup.values())];
  }
}
