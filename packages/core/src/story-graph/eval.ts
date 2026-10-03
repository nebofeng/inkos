/**
 * Offline comparison harness: BM25 memory retrieval (old) vs BM25 + story
 * graph (new), replayed chapter by chapter on a COPY of a book.
 *
 * Ground truth is the chapter that was actually written: for chapter N we ask
 * whether the context assembled before writing N mentions the characters (and
 * character pairs) that N actually brings back from earlier chapters.
 * Ground truth uses roster/alias matching over raw chapter text, independent
 * of the extractor.
 */
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { estimateTextTokens } from "../llm/provider.js";
import { retrieveMemorySelection } from "../utils/memory-retrieval.js";
import { parseChapterSummariesMarkdown } from "../utils/story-markdown.js";
import { DEFAULT_STORY_GRAPH_CONFIG, type StoryGraphConfig } from "./config.js";
import { readAllGraphRecords } from "./journal.js";
import { retrieveStoryGraphContext } from "./retrieval.js";
import { backfillStoryGraph, listChapterFiles, readChapterFile } from "./service.js";
import { loadTruthRoster, NameResolver, relationPolarity, type TruthRoster } from "./truth.js";
import type { ChapterGraphExtractor } from "./types.js";

export interface ChapterEvalRow {
  readonly chapter: number;
  readonly querySource: "intent" | "summary-proxy";
  readonly returning: number;
  readonly longRange: number;
  readonly pairs: number;
  readonly old: ContextScore;
  readonly next: ContextScore;
  /** Graph context alone (diagnostic: what the graph contributes by itself). */
  readonly graphOnly: ContextScore;
  readonly graphTokens: number;
  readonly contradictionsInContext: number;
}

export interface ContextScore {
  readonly tokens: number;
  readonly chars: number;
  readonly characterRecall: number | null;
  readonly longRangeRecall: number | null;
  readonly pairRecall: number | null;
  /** Share of characters named in the context that chapter N actually uses. */
  readonly characterPrecision: number | null;
}

export interface BookEvalResult {
  readonly book: string;
  readonly extractor: string;
  readonly chapters: number;
  readonly rows: ReadonlyArray<ChapterEvalRow>;
  readonly summary: {
    readonly old: AggregateScore;
    readonly next: AggregateScore;
    readonly graphOnly: AggregateScore;
    readonly avgGraphTokens: number;
    readonly contradictionsInContext: number;
    readonly reconcileConflicts: Record<string, number>;
    readonly extraction: { readonly characters: number; readonly edges: number; readonly events: number; readonly dialogues: number };
  };
}

export interface AggregateScore {
  readonly avgTokens: number;
  readonly avgChars: number;
  readonly characterRecall: number | null;
  readonly longRangeRecall: number | null;
  readonly pairRecall: number | null;
  readonly characterPrecision: number | null;
}

export async function evaluateStoryGraphRetrieval(params: {
  readonly bookDir: string;
  readonly extractor: ChapterGraphExtractor;
  readonly config?: Partial<StoryGraphConfig>;
  readonly fromChapter?: number;
  readonly toChapter?: number;
  /** Work on a temp copy (default true). The source book is never modified. */
  readonly copy?: boolean;
  readonly language?: "zh" | "en";
  readonly onProgress?: (message: string) => void;
}): Promise<BookEvalResult> {
  const useCopy = params.copy !== false;
  const workRoot = useCopy ? await mkdtemp(join(tmpdir(), "inkos-graph-eval-")) : undefined;
  const bookDir = workRoot ? join(workRoot, basename(params.bookDir)) : params.bookDir;
  try {
    if (workRoot) await cp(params.bookDir, bookDir, { recursive: true });
    const config = { ...DEFAULT_STORY_GRAPH_CONFIG, ...params.config, enabled: true };
    params.onProgress?.(`extracting with ${params.extractor.id}`);
    const backfill = await backfillStoryGraph({ bookDir, extractor: params.extractor, language: params.language, force: true });
    if (backfill.failed.length > 0) params.onProgress?.(`extraction failed for chapters ${backfill.failed.map((f) => f.chapter).join(",")}`);

    const roster = await loadTruthRoster(bookDir);
    const records = await readAllGraphRecords(bookDir);
    const resolver = new NameResolver([
      ...roster.characters,
      ...records.flatMap((record) => record.extraction.characters.map((character) => ({ name: character.name, aliases: character.aliases ?? [] }))),
    ]);
    const files = await listChapterFiles(bookDir);
    const texts = new Map<number, string>();
    for (const file of files) texts.set(file.chapter, (await readChapterFile(bookDir, file.chapter))?.content ?? "");
    const lastSeen = buildAppearanceIndex(texts, resolver);
    const summaries = parseChapterSummariesMarkdown(
      await readFile(join(bookDir, "story", "chapter_summaries.md"), "utf-8").catch(() => ""),
    );

    const rows: ChapterEvalRow[] = [];
    const from = Math.max(2, params.fromChapter ?? 2);
    const to = params.toChapter ?? Math.max(...files.map((file) => file.chapter), 0);
    for (const file of files) {
      const N = file.chapter;
      if (N < from || N > to) continue;
      const query = await loadChapterQuery(bookDir, N, summaries);
      const truth = groundTruth(texts.get(N) ?? "", N, lastSeen, resolver);

      const memory = await retrieveMemorySelection({ bookDir, chapterNumber: N, goal: query.goal, outlineNode: query.outlineNode });
      const oldText = renderMemorySelection(memory);
      const graph = await retrieveStoryGraphContext({
        bookDir, chapterNumber: N, goal: query.goal, outlineNode: query.outlineNode,
        language: params.language, config, roster,
        coveredChapters: memory.summaries.map((summary) => summary.chapter),
      });
      const graphText = graph.entries.map((entry) => `${entry.source}\n${entry.reason}\n${entry.excerpt}`).join("\n\n");
      const newText = [oldText, graphText].filter(Boolean).join("\n\n");
      rows.push({
        chapter: N,
        querySource: query.source,
        returning: truth.returning.size,
        longRange: truth.longRange.size,
        pairs: truth.pairs.size,
        old: scoreContext(oldText, truth, resolver),
        next: scoreContext(newText, truth, resolver),
        graphOnly: scoreContext(graphText, truth, resolver),
        graphTokens: estimateTextTokens(graphText),
        contradictionsInContext: countContradictions(graphText, roster),
      });
      params.onProgress?.(`chapter ${N} done`);
    }

    const reconcileConflicts: Record<string, number> = {};
    for (const record of records) {
      for (const conflict of record.conflicts) {
        const key = `${conflict.kind}:${conflict.resolution}`;
        reconcileConflicts[key] = (reconcileConflicts[key] ?? 0) + 1;
      }
    }
    return {
      book: basename(params.bookDir),
      extractor: params.extractor.id,
      chapters: rows.length,
      rows,
      summary: {
        old: aggregate(rows.map((row) => row.old)),
        next: aggregate(rows.map((row) => row.next)),
        graphOnly: aggregate(rows.map((row) => row.graphOnly)),
        avgGraphTokens: average(rows.map((row) => row.graphTokens)) ?? 0,
        contradictionsInContext: rows.reduce((sum, row) => sum + row.contradictionsInContext, 0),
        reconcileConflicts,
        extraction: {
          characters: records.reduce((sum, record) => sum + record.extraction.characters.length, 0),
          edges: records.reduce((sum, record) => sum + record.extraction.relationships.length, 0),
          events: records.reduce((sum, record) => sum + record.extraction.events.length, 0),
          dialogues: records.reduce((sum, record) => sum + record.extraction.dialogues.length, 0),
        },
      },
    };
  } finally {
    if (workRoot) await rm(workRoot, { recursive: true, force: true });
  }
}

async function loadChapterQuery(
  bookDir: string,
  chapter: number,
  summaries: ReadonlyArray<{ chapter: number; title: string; events: string }>,
): Promise<{ goal: string; outlineNode?: string; source: "intent" | "summary-proxy" }> {
  const intent = await readFile(
    join(bookDir, "story", "runtime", `chapter-${String(chapter).padStart(4, "0")}.intent.md`),
    "utf-8",
  ).catch(() => "");
  const section = (name: string) => intent.match(new RegExp(`##\\s*${name}\\s*\\n([\\s\\S]*?)(?=\\n##\\s|$)`))?.[1]?.trim();
  const goal = section("Goal");
  if (goal) return { goal, outlineNode: section("Outline Node"), source: "intent" };
  // No planner intent on disk: fall back to the chapter's own summary row
  // (optimistic for both methods equally).
  const row = summaries.find((summary) => summary.chapter === chapter);
  return { goal: [row?.title, row?.events].filter(Boolean).join("：") || `第${chapter}章`, source: "summary-proxy" };
}

interface GroundTruth {
  readonly mentioned: ReadonlySet<string>;
  readonly returning: ReadonlySet<string>;
  readonly longRange: ReadonlySet<string>;
  readonly pairs: ReadonlySet<string>;
}

/** chapter → (character → paragraphs mentioning it) and pair co-occurrence. */
function buildAppearanceIndex(texts: ReadonlyMap<number, string>, resolver: NameResolver) {
  const appearances = new Map<string, number[]>();
  const pairChapters = new Map<string, number[]>();
  for (const [chapter, text] of [...texts.entries()].sort((a, b) => a[0] - b[0])) {
    for (const name of resolver.findMentions(text).keys()) {
      const list = appearances.get(name) ?? [];
      list.push(chapter);
      appearances.set(name, list);
    }
    for (const pair of paragraphPairs(text, resolver)) {
      const list = pairChapters.get(pair) ?? [];
      list.push(chapter);
      pairChapters.set(pair, list);
    }
  }
  return { appearances, pairChapters };
}

function paragraphPairs(text: string, resolver: NameResolver): Set<string> {
  const pairs = new Set<string>();
  for (const paragraph of text.split(/\n+/)) {
    const names = [...resolver.findMentions(paragraph).keys()].sort();
    for (let i = 0; i < names.length; i += 1) {
      for (let j = i + 1; j < names.length; j += 1) pairs.add(`${names[i]}\u0000${names[j]}`);
    }
  }
  return pairs;
}

function groundTruth(
  text: string,
  chapter: number,
  index: ReturnType<typeof buildAppearanceIndex>,
  resolver: NameResolver,
): GroundTruth {
  const mentioned = new Set(resolver.findMentions(text).keys());
  const returning = new Set<string>();
  const longRange = new Set<string>();
  for (const name of mentioned) {
    const earlier = (index.appearances.get(name) ?? []).filter((c) => c < chapter);
    if (earlier.length === 0) continue;
    returning.add(name);
    if (Math.max(...earlier) <= chapter - 4) longRange.add(name);
  }
  const pairs = new Set<string>();
  for (const pair of paragraphPairs(text, resolver)) {
    const [a, b] = pair.split("\u0000") as [string, string];
    if (!returning.has(a) || !returning.has(b)) continue;
    if ((index.pairChapters.get(pair) ?? []).some((c) => c < chapter)) pairs.add(pair);
  }
  return { mentioned, returning, longRange, pairs };
}

function scoreContext(context: string, truth: GroundTruth, resolver: NameResolver): ContextScore {
  const named = new Set(resolver.findMentions(context).keys());
  const recall = (set: ReadonlySet<string>) =>
    set.size === 0 ? null : [...set].filter((name) => named.has(name)).length / set.size;
  const lines = context.split(/\n|\s\|\s/);
  const linePairs = new Set<string>();
  for (const line of lines) for (const pair of paragraphPairs(line, resolver)) linePairs.add(pair);
  return {
    tokens: estimateTextTokens(context),
    chars: context.length,
    characterRecall: recall(truth.returning),
    longRangeRecall: recall(truth.longRange),
    pairRecall: truth.pairs.size === 0 ? null : [...truth.pairs].filter((pair) => linePairs.has(pair)).length / truth.pairs.size,
    characterPrecision: named.size === 0 ? null : [...named].filter((name) => truth.mentioned.has(name)).length / named.size,
  };
}

/** Structured claims in the graph context that contradict the truth files. */
export function countContradictions(graphText: string, roster: TruthRoster): number {
  let count = 0;
  const byName = new Map(roster.characters.map((entry) => [entry.name, entry]));
  for (const line of graphText.split("\n")) {
    const card = line.match(/^- ([^：—]+)：.*状态：(已死亡|失踪)/);
    if (card) {
      const truth = byName.get(card[1]!.trim());
      const claimed = card[2] === "已死亡" ? "dead" : "missing";
      if (truth?.status && truth.status !== claimed) count += 1;
    }
    const edge = line.match(/^- (.+?) — (.+?)：([^；]+)/);
    if (edge) {
      const [a, b, type] = [edge[1]!.trim(), edge[2]!.trim(), edge[3]!.trim()];
      const truthDesc = byName.get(a)?.relations.get(b) ?? byName.get(b)?.relations.get(a);
      if (truthDesc) {
        const tp = relationPolarity(truthDesc);
        const gp = relationPolarity(type);
        if (tp !== "neutral" && gp !== "neutral" && tp !== gp) count += 1;
      }
    }
  }
  return count;
}

function renderMemorySelection(memory: Awaited<ReturnType<typeof retrieveMemorySelection>>): string {
  // Mirrors composer.collectSelectedContext's excerpts for BM25 memory.
  return [
    ...memory.facts.map((fact) => `${fact.predicate} | ${fact.object}`),
    ...memory.summaries.map((summary) => [summary.title, summary.events, summary.stateChanges, summary.hookActivity].filter(Boolean).join(" | ")),
    ...memory.volumeSummaries.map((summary) => `${summary.heading} | ${summary.content}`),
    ...memory.hooks.map((hook) => [hook.type, hook.status, hook.expectedPayoff, hook.payoffTiming, hook.notes].filter(Boolean).join(" | ")),
  ].join("\n");
}

function average(values: ReadonlyArray<number | null>): number | null {
  const real = values.filter((value): value is number => value !== null);
  return real.length === 0 ? null : real.reduce((sum, value) => sum + value, 0) / real.length;
}

function aggregate(scores: ReadonlyArray<ContextScore>): AggregateScore {
  return {
    avgTokens: Math.round(average(scores.map((score) => score.tokens)) ?? 0),
    avgChars: Math.round(average(scores.map((score) => score.chars)) ?? 0),
    characterRecall: average(scores.map((score) => score.characterRecall)),
    longRangeRecall: average(scores.map((score) => score.longRangeRecall)),
    pairRecall: average(scores.map((score) => score.pairRecall)),
    characterPrecision: average(scores.map((score) => score.characterPrecision)),
  };
}

export function formatEvalSummary(result: BookEvalResult): string {
  const pct = (value: number | null) => (value === null ? "n/a" : `${(value * 100).toFixed(1)}%`);
  const { old, next, graphOnly: g } = result.summary;
  return [
    `book: ${result.book}  extractor: ${result.extractor}  chapters evaluated: ${result.chapters}`,
    `                      old(BM25)   new(BM25+graph)  graph-only`,
    `character recall      ${pct(old.characterRecall).padEnd(11)} ${pct(next.characterRecall).padEnd(16)} ${pct(g.characterRecall)}`,
    `long-range recall     ${pct(old.longRangeRecall).padEnd(11)} ${pct(next.longRangeRecall).padEnd(16)} ${pct(g.longRangeRecall)}`,
    `pair recall           ${pct(old.pairRecall).padEnd(11)} ${pct(next.pairRecall).padEnd(16)} ${pct(g.pairRecall)}`,
    `character precision   ${pct(old.characterPrecision).padEnd(11)} ${pct(next.characterPrecision).padEnd(16)} ${pct(g.characterPrecision)}`,
    `avg context tokens    ${String(old.avgTokens).padEnd(11)} ${next.avgTokens} (graph +${Math.round(result.summary.avgGraphTokens)})`,
    `contradictions in graph context: ${result.summary.contradictionsInContext}`,
    `reconcile conflicts (truth wins): ${JSON.stringify(result.summary.reconcileConflicts)}`,
    `extracted: ${JSON.stringify(result.summary.extraction)}`,
  ].join("\n");
}

/**
 * Wraps an extractor and injects known-bad rows (fabricated quote, status
 * contradicting the truth files, relation with the opposite polarity of the
 * character matrix) so the harness can measure that truth-wins reconciliation
 * keeps them out of the writer context — without a live model.
 */
export class NoiseInjectingExtractor implements ChapterGraphExtractor {
  readonly id: string;
  readonly injected = { quotes: 0, statuses: 0, relations: 0 };

  constructor(private readonly base: ChapterGraphExtractor, private readonly roster: TruthRoster) {
    this.id = `${base.id}+noise`;
  }

  async extract(input: Parameters<ChapterGraphExtractor["extract"]>[0]) {
    const out = await this.base.extract(input);
    const present = new Set(out.characters.map((character) => character.name));
    const characters = [...out.characters];
    const relationships = [...out.relationships];
    const dialogues = [...out.dialogues];
    const speaker = characters[0]?.name;
    if (speaker) {
      dialogues.push({ speaker, quote: `（注入的伪造台词 ${input.chapterNumber}）` });
      this.injected.quotes += 1;
    }
    for (const truth of this.roster.characters) {
      if (truth.status && present.has(truth.name)) {
        const index = characters.findIndex((character) => character.name === truth.name);
        characters[index] = { ...characters[index]!, status: truth.status === "dead" ? "alive" : "dead" };
        this.injected.statuses += 1;
        break;
      }
    }
    for (const truth of this.roster.characters) {
      if (!present.has(truth.name)) continue;
      const hit = [...truth.relations.entries()].find(([other, desc]) => present.has(other) && relationPolarity(desc) !== "neutral");
      if (!hit) continue;
      relationships.push({
        from: truth.name,
        to: hit[0],
        type: relationPolarity(hit[1]) === "hostile" ? "盟友" : "宿敌",
        strength: 0.9,
        status: "active",
      });
      this.injected.relations += 1;
      break;
    }
    return { ...out, characters, relationships, dialogues };
  }
}
