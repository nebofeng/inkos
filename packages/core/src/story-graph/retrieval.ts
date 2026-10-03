/**
 * Graph-aware context retrieval for the writer.
 *
 *   query (goal + outline node + must-keep)
 *     → key characters (names/aliases, longest match; protagonist fallback)
 *     → 1-2 relationship hops (weighted by strength × recency, truth relations count)
 *     → cards + relationships + recent events + relevant verbatim dialogue
 *     → merged with the BM25 memory selection (chapters already covered by a
 *       retrieved summary are de-prioritised) → greedy fill under a token budget
 */
import { join } from "node:path";
import { writeFile, mkdir } from "node:fs/promises";
import { estimateTextTokens } from "../llm/provider.js";
import { LocalSearchIndex } from "../retrieval/local-search.js";
import type { StoryGraphConfig } from "./config.js";
import { DEFAULT_STORY_GRAPH_CONFIG } from "./config.js";
import { STORY_GRAPH_SEARCH_SCOPE, syncStoryGraph } from "./service.js";
import { StoryGraphStore, type GraphDialogueRow, type GraphEdgeRow, type GraphEventRow, type GraphSnapshot } from "./store.js";
import { loadTruthRoster, NameResolver, relationPolarity, type TruthRoster } from "./truth.js";

export interface GraphContextEntry {
  readonly source: string;
  readonly reason: string;
  readonly excerpt: string;
}

export interface StoryGraphRetrievalTrace {
  readonly engine: "story-graph/v1";
  readonly chapter: number;
  readonly seeds: ReadonlyArray<string>;
  readonly expanded: ReadonlyArray<{ readonly name: string; readonly hop: number; readonly via?: string; readonly score: number }>;
  readonly budgetTokens: number;
  readonly usedTokens: number;
  readonly included: Record<string, number>;
  readonly droppedForBudget: number;
  readonly suppressedConflicts: ReadonlyArray<string>;
  readonly note?: string;
}

export interface StoryGraphContext {
  readonly entries: ReadonlyArray<GraphContextEntry>;
  readonly trace: StoryGraphRetrievalTrace;
}

export interface CharacterView {
  readonly name: string;
  readonly aliases: ReadonlyArray<string>;
  readonly role: string;
  readonly status: string;
  readonly faction: string;
  readonly firstChapter: number;
  readonly lastChapter: number;
  readonly appearances: number;
  readonly protagonist: boolean;
}

export interface EdgeView {
  readonly a: string;
  readonly b: string;
  readonly type: string;
  readonly strength: number;
  readonly startChapter: number;
  readonly endChapter?: number;
  readonly lastChapter: number;
  readonly previous: ReadonlyArray<{ readonly type: string; readonly from: number; readonly to: number }>;
  readonly truthNote?: string;
  readonly note: string;
}

export async function retrieveStoryGraphContext(params: {
  readonly bookDir: string;
  readonly chapterNumber: number;
  readonly goal: string;
  readonly outlineNode?: string;
  readonly mustKeep?: ReadonlyArray<string>;
  readonly language?: "zh" | "en";
  readonly config?: Partial<StoryGraphConfig>;
  /** Chapters whose summary the BM25 memory selection already injected. */
  readonly coveredChapters?: ReadonlyArray<number>;
  readonly roster?: TruthRoster;
  /** Write story/runtime/chapter-NNNN.graph.json (default false). */
  readonly writeTrace?: boolean;
}): Promise<StoryGraphContext> {
  const config = { ...DEFAULT_STORY_GRAPH_CONFIG, ...params.config };
  await syncStoryGraph(params.bookDir);
  const store = new StoryGraphStore(params.bookDir);
  let snapshot: GraphSnapshot;
  try {
    snapshot = store.snapshot(params.chapterNumber);
  } finally {
    store.close();
  }
  const roster = params.roster ?? await loadTruthRoster(params.bookDir);
  const query = [params.goal, params.outlineNode ?? "", ...(params.mustKeep ?? [])].filter(Boolean).join("\n");
  const dialogueHits = searchGraph(params.bookDir, query, "graph-dialogue", params.chapterNumber);
  const eventHits = searchGraph(params.bookDir, query, "graph-event", params.chapterNumber);
  const result = assembleGraphContext({
    snapshot,
    roster,
    chapterNumber: params.chapterNumber,
    query,
    language: params.language ?? "zh",
    config,
    coveredChapters: new Set(params.coveredChapters ?? []),
    dialogueHitKeys: dialogueHits,
    eventHitKeys: eventHits,
  });
  if (params.writeTrace) {
    const runtimeDir = join(params.bookDir, "story", "runtime");
    await mkdir(runtimeDir, { recursive: true });
    await writeFile(
      join(runtimeDir, `chapter-${String(params.chapterNumber).padStart(4, "0")}.graph.json`),
      `${JSON.stringify(result.trace, null, 2)}\n`,
      "utf-8",
    ).catch(() => undefined);
  }
  return result;
}

/** "chapter:seq" keys of BM25 hits, best first, restricted to chapters < before. */
function searchGraph(bookDir: string, query: string, kind: string, before: number): string[] {
  if (!query.trim()) return [];
  const index = new LocalSearchIndex(join(bookDir, "story", "memory.db"));
  try {
    return index.search(query, { scope: STORY_GRAPH_SEARCH_SCOPE, kinds: [kind], limit: 60 })
      .map((hit) => ({ chapter: Number(hit.metadata?.chapter), seq: Number(hit.metadata?.seq) }))
      .filter((hit) => Number.isFinite(hit.chapter) && hit.chapter < before)
      .map((hit) => `${hit.chapter}:${hit.seq}`);
  } catch {
    return [];
  } finally {
    index.close();
  }
}

interface Candidate {
  readonly group: "characters" | "relationships" | "events" | "dialogue";
  readonly key: string;
  readonly priority: number;
  readonly text: string;
  readonly chapter?: number;
}

/** Pure assembly step (unit-testable without SQLite/FTS). */
export function assembleGraphContext(params: {
  readonly snapshot: GraphSnapshot;
  readonly roster: TruthRoster;
  readonly chapterNumber: number;
  readonly query: string;
  readonly language: "zh" | "en";
  readonly config: StoryGraphConfig;
  readonly coveredChapters: ReadonlySet<number>;
  readonly dialogueHitKeys?: ReadonlyArray<string>;
  readonly eventHitKeys?: ReadonlyArray<string>;
}): StoryGraphContext {
  const { snapshot, roster, config } = params;
  const isEn = params.language === "en";
  const N = params.chapterNumber;
  const characters = buildCharacterViews(snapshot, roster);
  const emptyTrace = (note: string): StoryGraphContext => ({
    entries: [],
    trace: {
      engine: "story-graph/v1", chapter: N, seeds: [], expanded: [], budgetTokens: config.budgetTokens,
      usedTokens: 0, included: {}, droppedForBudget: 0, suppressedConflicts: [], note,
    },
  });
  if (characters.size === 0 && snapshot.events.length === 0) return emptyTrace("empty-graph");

  const resolver = new NameResolver([
    ...roster.characters,
    ...[...characters.values()].map((view) => ({ name: view.name, aliases: view.aliases })),
  ]);
  const suppressedConflicts: string[] = [];
  const edges = buildEdgeViews(snapshot.edges, roster, N, suppressedConflicts);

  // 1. Seeds: characters named in the query; else protagonist + last chapter's cast.
  const mentioned = [...resolver.findMentions(params.query).entries()]
    .filter(([name]) => characters.has(name))
    .sort((a, b) => b[1] - a[1])
    .map(([name]) => name);
  // Entities (items/locations/factions) in the query pull in their owners / members.
  const entityLinked = linkedCharactersForEntities(snapshot, params.query).filter((name) => characters.has(name));
  let seeds = [...new Set([...mentioned, ...entityLinked])];
  if (seeds.length === 0) {
    const protagonists = [...characters.values()].filter((view) => view.protagonist).map((view) => view.name);
    const lastCast = [...characters.values()]
      .filter((view) => view.lastChapter === N - 1 && !view.protagonist)
      .sort((a, b) => b.appearances - a.appearances)
      .slice(0, 2)
      .map((view) => view.name);
    seeds = [...new Set([...protagonists, ...lastCast])];
  }
  seeds = seeds.slice(0, Math.max(1, Math.min(config.maxCharacters, 4)));

  // 2. Hop expansion.
  const adjacency = new Map<string, Array<{ other: string; weight: number; edge: EdgeView }>>();
  for (const edge of edges) {
    const weight = edgeWeight(edge, N);
    for (const [from, to] of [[edge.a, edge.b], [edge.b, edge.a]] as const) {
      const list = adjacency.get(from) ?? [];
      list.push({ other: to, weight, edge });
      adjacency.set(from, list);
    }
  }
  for (const list of adjacency.values()) list.sort((x, y) => y.weight - x.weight);
  const selected = new Map<string, { hop: number; score: number; via?: string }>();
  seeds.forEach((name, index) => selected.set(name, { hop: 0, score: 100 - index }));
  const hop1: string[] = [];
  for (const seed of seeds) {
    for (const neighbour of (adjacency.get(seed) ?? []).slice(0, 3)) {
      if (selected.has(neighbour.other) || !characters.has(neighbour.other)) continue;
      selected.set(neighbour.other, { hop: 1, score: 50 * neighbour.weight, via: seed });
      hop1.push(neighbour.other);
    }
  }
  if (config.hops >= 2) {
    for (const name of hop1) {
      const next = (adjacency.get(name) ?? []).find((neighbour) =>
        !selected.has(neighbour.other) && characters.has(neighbour.other) && neighbour.weight >= 0.35);
      if (next) selected.set(next.other, { hop: 2, score: 20 * next.weight, via: name });
    }
  }
  const ranked = [...selected.entries()]
    .sort((a, b) => a[1].hop - b[1].hop || b[1].score - a[1].score)
    .slice(0, config.maxCharacters);
  const selectedNames = new Set(ranked.map(([name]) => name));
  const seedSet = new Set(seeds);

  // 3. Candidates.
  const candidates: Candidate[] = [];
  for (const [name, info] of ranked) {
    const view = characters.get(name)!;
    candidates.push({
      group: "characters",
      key: `character:${name}`,
      priority: info.hop === 0 ? 1000 - info.score / 100 : info.hop === 1 ? 500 + info.score / 10 : 300 + info.score / 10,
      text: renderCharacter(view, N, isEn),
    });
  }
  for (const edge of edges) {
    if (!selectedNames.has(edge.a) || !selectedNames.has(edge.b)) continue;
    const bothSeeds = seedSet.has(edge.a) && seedSet.has(edge.b);
    const touchesSeed = seedSet.has(edge.a) || seedSet.has(edge.b);
    candidates.push({
      group: "relationships",
      key: `edge:${edge.a}~${edge.b}~${edge.type}`,
      priority: (bothSeeds ? 900 : touchesSeed ? 800 : 450) + edge.strength * 10,
      text: renderEdge(edge, N, isEn),
    });
  }
  const eventHitRank = new Map((params.eventHitKeys ?? []).map((key, index) => [key, index]));
  const eventsByKey = new Map(snapshot.events.map((event) => [`${event.chapter}:${event.seq}`, event]));
  const takenEvents = new Set<string>();
  for (const [name, info] of ranked) {
    const quota = info.hop === 0 ? config.eventsPerCharacter : Math.min(1, config.eventsPerCharacter);
    const own = snapshot.events
      .filter((event) => event.participants.includes(name))
      .sort((a, b) => b.chapter - a.chapter || b.importance - a.importance)
      .slice(0, quota * 2);
    let used = 0;
    for (const event of own) {
      if (used >= quota) break;
      const key = `${event.chapter}:${event.seq}`;
      if (takenEvents.has(key)) continue;
      takenEvents.add(key);
      used += 1;
      const covered = params.coveredChapters.has(event.chapter);
      const base = info.hop === 0 ? 700 : 400;
      candidates.push({
        group: "events",
        key: `event:${key}`,
        priority: base - (N - event.chapter) * 2 + event.importance * 5 + (eventHitRank.has(key) ? 40 : 0) - (covered ? 150 : 0),
        text: renderEvent(event, N, isEn),
        chapter: event.chapter,
      });
    }
  }
  for (const [key, rank] of eventHitRank) {
    if (takenEvents.has(key) || rank >= 4) continue;
    const event = eventsByKey.get(key);
    if (!event) continue;
    takenEvents.add(key);
    candidates.push({
      group: "events",
      key: `event:${key}`,
      priority: 350 - rank * 10 - (params.coveredChapters.has(event.chapter) ? 150 : 0),
      text: renderEvent(event, N, isEn),
      chapter: event.chapter,
    });
  }
  const dialogueByKey = new Map(snapshot.dialogues.map((line) => [`${line.chapter}:${line.seq}`, line]));
  const involves = (line: GraphDialogueRow, names: ReadonlySet<string>) => names.has(line.speaker) || names.has(line.addressee);
  const takenDialogue = new Set<string>();
  let dialogueCount = 0;
  (params.dialogueHitKeys ?? []).forEach((key, rank) => {
    const line = dialogueByKey.get(key);
    if (!line || !involves(line, selectedNames) || dialogueCount >= config.maxDialogues) return;
    takenDialogue.add(key);
    dialogueCount += 1;
    candidates.push({ group: "dialogue", key: `dialogue:${key}`, priority: 650 - rank * 5, text: renderDialogue(line, N, isEn), chapter: line.chapter });
  });
  for (const seed of seeds) {
    if (dialogueCount >= config.maxDialogues) break;
    const latest = [...snapshot.dialogues]
      .filter((line) => (line.speaker === seed || line.addressee === seed) && !takenDialogue.has(`${line.chapter}:${line.seq}`))
      .sort((a, b) => b.chapter - a.chapter || a.seq - b.seq)[0];
    if (!latest) continue;
    const key = `${latest.chapter}:${latest.seq}`;
    takenDialogue.add(key);
    dialogueCount += 1;
    candidates.push({ group: "dialogue", key: `dialogue:${key}`, priority: 600 - (N - latest.chapter), text: renderDialogue(latest, N, isEn), chapter: latest.chapter });
  }

  // 4. Greedy fill under the token budget (entry headers counted once per group).
  const headerTokens = 40;
  let used = 0;
  let dropped = 0;
  const groups = new Map<Candidate["group"], Candidate[]>();
  for (const candidate of candidates.sort((a, b) => b.priority - a.priority)) {
    const cost = estimateTextTokens(candidate.text) + 1 + (groups.has(candidate.group) ? 0 : headerTokens);
    if (used + cost > config.budgetTokens) {
      dropped += 1;
      continue;
    }
    used += cost;
    const list = groups.get(candidate.group) ?? [];
    list.push(candidate);
    groups.set(candidate.group, list);
  }

  const entries: GraphContextEntry[] = [];
  const order: Array<[Candidate["group"], string]> = isEn
    ? [
        ["characters", "Key characters for this chapter (story graph: aliases, status, last seen)."],
        ["relationships", "Relationships among the key characters (type, strength, since/until). Character matrix notes win on conflict."],
        ["events", "Earlier events involving the key characters (story graph, oldest first)."],
        ["dialogue", "Verbatim earlier dialogue the chapter may call back to (story graph)."],
      ]
    : [
        ["characters", "本章关键人物（知识图谱：别名、状态、最近出场）。"],
        ["relationships", "关键人物之间的关系（类型、强度、起止时间）；与角色矩阵冲突时以矩阵为准。"],
        ["events", "关键人物此前经历的事件（知识图谱，按时间先后）。"],
        ["dialogue", "此前的原话，可供回扣（知识图谱，逐字）。"],
      ];
  const included: Record<string, number> = {};
  for (const [group, reason] of order) {
    const list = groups.get(group);
    if (!list || list.length === 0) continue;
    const sortedList = group === "events" || group === "dialogue"
      ? [...list].sort((a, b) => (a.chapter ?? 0) - (b.chapter ?? 0))
      : list;
    included[group] = list.length;
    entries.push({ source: `story/graph#${group}`, reason, excerpt: sortedList.map((item) => item.text).join("\n") });
  }

  return {
    entries,
    trace: {
      engine: "story-graph/v1",
      chapter: N,
      seeds,
      expanded: ranked.map(([name, info]) => ({ name, hop: info.hop, ...(info.via ? { via: info.via } : {}), score: Math.round(info.score * 10) / 10 })),
      budgetTokens: config.budgetTokens,
      usedTokens: used,
      included,
      droppedForBudget: dropped,
      suppressedConflicts,
    },
  };
}

export function buildCharacterViews(snapshot: GraphSnapshot, roster: TruthRoster): Map<string, CharacterView> {
  const views = new Map<string, {
    name: string; aliases: Set<string>; role: string; status: string; faction: string;
    firstChapter: number; lastChapter: number; chapters: Set<number>; protagonist: boolean;
  }>();
  for (const row of snapshot.entities) {
    if (row.kind !== "character") continue;
    const view = views.get(row.name) ?? {
      name: row.name, aliases: new Set<string>(), role: "", status: "", faction: "",
      firstChapter: row.chapter, lastChapter: row.chapter, chapters: new Set<number>(), protagonist: false,
    };
    for (const alias of row.aliases) view.aliases.add(alias);
    if (row.role) view.role = row.role;
    if (row.status && row.status !== "unknown") view.status = row.status;
    if (row.faction) view.faction = row.faction;
    view.firstChapter = Math.min(view.firstChapter, row.chapter);
    view.lastChapter = Math.max(view.lastChapter, row.chapter);
    view.chapters.add(row.chapter);
    views.set(row.name, view);
  }
  // Truth files win: canonical aliases, role, explicit status, protagonist flag.
  for (const truth of roster.characters) {
    const view = views.get(truth.name);
    if (!view) continue;
    for (const alias of truth.aliases) view.aliases.add(alias);
    if (truth.role) view.role = truth.role;
    if (truth.status) view.status = truth.status;
    view.protagonist = truth.protagonist;
  }
  return new Map([...views.entries()].map(([name, view]) => [name, {
    name,
    aliases: [...view.aliases].filter((alias) => alias !== name),
    role: view.role,
    status: view.status,
    faction: view.faction,
    firstChapter: view.firstChapter,
    lastChapter: view.lastChapter,
    appearances: view.chapters.size,
    protagonist: view.protagonist,
  }]));
}

/**
 * Collapse per-chapter edge observations into current relationships with
 * start/end chapters. Undirected for retrieval; the latest observation wins.
 */
export function buildEdgeViews(
  observations: ReadonlyArray<GraphEdgeRow>,
  roster: TruthRoster,
  chapterNumber: number,
  suppressed: string[] = [],
): EdgeView[] {
  const byPair = new Map<string, GraphEdgeRow[]>();
  for (const row of observations) {
    if (row.chapter >= chapterNumber) continue;
    const [a, b] = [row.source, row.target].sort();
    const key = `${a}\u0000${b}`;
    const list = byPair.get(key) ?? [];
    list.push(row);
    byPair.set(key, list);
  }
  const truthRelation = (a: string, b: string): string | undefined => {
    const left = roster.characters.find((entry) => entry.name === a)?.relations.get(b);
    const right = roster.characters.find((entry) => entry.name === b)?.relations.get(a);
    return left || right || undefined;
  };
  const views: EdgeView[] = [];
  for (const [key, rows] of byPair) {
    const [a, b] = key.split("\u0000") as [string, string];
    rows.sort((x, y) => x.chapter - y.chapter);
    // Segments of consecutive observations with the same type.
    const segments: Array<{ type: string; from: number; to: number; strength: number; status: string; note: string }> = [];
    for (const row of rows) {
      const last = segments[segments.length - 1];
      if (last && last.type === row.type) {
        last.to = row.chapter;
        last.strength = row.strength;
        last.status = row.status;
        if (row.note) last.note = row.note;
      } else {
        segments.push({ type: row.type, from: row.chapter, to: row.chapter, strength: row.strength, status: row.status, note: row.note });
      }
    }
    const current = segments[segments.length - 1]!;
    const truthNote = truthRelation(a, b);
    if (truthNote) {
      const truthPolarity = relationPolarity(truthNote);
      const graphPolarity = relationPolarity(`${current.type} ${current.note}`);
      if (truthPolarity !== "neutral" && graphPolarity !== "neutral" && truthPolarity !== graphPolarity) {
        suppressed.push(`${a}~${b}: graph "${current.type}" vs matrix "${truthNote}"`);
        views.push({
          a, b, type: truthNote, strength: Math.max(0.5, current.strength), startChapter: current.from,
          lastChapter: current.to, previous: [], truthNote, note: "",
        });
        continue;
      }
    }
    views.push({
      a,
      b,
      type: current.type,
      strength: current.strength,
      startChapter: current.from,
      ...(current.status === "ended" ? { endChapter: current.to } : {}),
      lastChapter: current.to,
      previous: segments.slice(0, -1).slice(-2).map((segment) => ({ type: segment.type, from: segment.from, to: segment.to })),
      ...(truthNote ? { truthNote } : {}),
      note: current.note,
    });
  }
  // Truth-only relations (matrix knows, graph has not observed yet).
  const seen = new Set(views.map((view) => `${view.a}\u0000${view.b}`));
  for (const truth of roster.characters) {
    for (const [other, desc] of truth.relations) {
      const [a, b] = [truth.name, other].sort() as [string, string];
      const key = `${a}\u0000${b}`;
      if (seen.has(key) || a === b) continue;
      seen.add(key);
      views.push({ a, b, type: desc || "相关", strength: 0.5, startChapter: 0, lastChapter: 0, previous: [], truthNote: desc, note: "" });
    }
  }
  return views;
}

function edgeWeight(edge: EdgeView, chapterNumber: number): number {
  const age = edge.lastChapter > 0 ? Math.max(0, chapterNumber - 1 - edge.lastChapter) : 10;
  const recency = 1 / (1 + age / 10);
  const ended = edge.endChapter !== undefined ? 0.3 : 1;
  const truthBonus = edge.truthNote ? 0.2 : 0;
  return Math.min(1.5, edge.strength * recency * ended + truthBonus);
}

function linkedCharactersForEntities(snapshot: GraphSnapshot, query: string): string[] {
  const names = new Set<string>();
  const entityNames = new Map<string, string>();
  for (const row of snapshot.entities) {
    if (row.kind === "character") continue;
    for (const key of [row.name, ...row.aliases]) if (key.length >= 2) entityNames.set(key, row.name);
  }
  const hits = new Set<string>();
  for (const [key, canonical] of entityNames) if (query.includes(key)) hits.add(canonical);
  if (hits.size === 0) return [];
  for (const row of snapshot.entities) {
    if (row.kind === "item" && hits.has(row.name) && row.owner) names.add(row.owner);
    if (row.kind === "character" && row.faction && hits.has(row.faction)) names.add(row.name);
  }
  for (const event of snapshot.events) {
    if (event.location && hits.has(event.location)) event.participants.slice(0, 2).forEach((name) => names.add(name));
  }
  return [...names].slice(0, 3);
}

/**
 * Rendered text uses RELATIVE time ("3章前" / "上一章"): the writer prompt
 * sanitiser rewrites absolute "第N章" references to "此前" (to keep chapter
 * numbers out of prose), which would erase recency. Absolute chapters stay in
 * the trace and the journal.
 */
export function relativeChapter(current: number, chapter: number, isEn: boolean): string {
  const distance = Math.max(1, current - chapter);
  if (isEn) return distance === 1 ? "last chapter" : `${distance} chapters ago`;
  return distance === 1 ? "上一章" : `${distance}章前`;
}

function renderCharacter(view: CharacterView, current: number, isEn: boolean): string {
  const parts = [
    view.aliases.length > 0 ? (isEn ? `aka ${view.aliases.slice(0, 4).join("/")}` : `又称${view.aliases.slice(0, 4).join("、")}`) : "",
    view.role ? view.role.slice(0, 40) : "",
    view.status && view.status !== "alive" ? (isEn ? `status: ${view.status}` : `状态：${statusZh(view.status)}`) : "",
    view.faction ? (isEn ? `faction: ${view.faction}` : `势力：${view.faction}`) : "",
    isEn
      ? `last seen ${relativeChapter(current, view.lastChapter, true)}, in ${view.appearances} chapter(s)`
      : `最近出场：${relativeChapter(current, view.lastChapter, false)}，共${view.appearances}章`,
  ].filter(Boolean);
  return `- ${view.name}：${parts.join("；")}`;
}

function statusZh(status: string): string {
  return ({ dead: "已死亡", missing: "失踪", alive: "在世", unknown: "未知" } as Record<string, string>)[status] ?? status;
}

function renderEdge(edge: EdgeView, current: number, isEn: boolean): string {
  const rel = (chapter: number) => relativeChapter(current, chapter, isEn);
  const span = edge.startChapter > 0
    ? (isEn
        ? `since ${rel(edge.startChapter)}${edge.endChapter ? `, ended ${rel(edge.endChapter)}` : ""}`
        : `始于${rel(edge.startChapter)}${edge.endChapter ? `，${rel(edge.endChapter)}结束` : ""}`)
    : "";
  const previous = edge.previous.length > 0
    ? (isEn
        ? `before: ${edge.previous.map((segment) => `${segment.type} (${rel(segment.from)} to ${rel(segment.to)})`).join(", ")}`
        : `此前：${edge.previous.map((segment) => `${segment.type}（${rel(segment.from)}至${rel(segment.to)}）`).join("，")}`)
    : "";
  const truth = edge.truthNote && edge.truthNote !== edge.type ? (isEn ? `matrix: ${edge.truthNote}` : `矩阵：${edge.truthNote}`) : "";
  const strength = isEn ? `strength ${edge.strength.toFixed(1)}` : `强度${edge.strength.toFixed(1)}`;
  // Hyphenated labels ("owes-debt") would be rewritten by the writer's
  // hook-slug sanitiser, so render them with spaces.
  const type = edge.type.replace(/-/g, " ");
  return `- ${edge.a} — ${edge.b}：${[type, strength, span, previous, truth].filter(Boolean).join("；")}`;
}

function renderEvent(event: GraphEventRow, current: number, isEn: boolean): string {
  const where = event.location ? (isEn ? ` @${event.location}` : `（${event.location}）`) : "";
  return `- [${relativeChapter(current, event.chapter, isEn)}] ${event.summary}${where}`;
}

function renderDialogue(line: GraphDialogueRow, current: number, isEn: boolean): string {
  const who = line.addressee ? `${line.speaker}→${line.addressee}` : line.speaker;
  return isEn
    ? `- [${relativeChapter(current, line.chapter, true)}] ${who}: "${line.quote}"`
    : `- [${relativeChapter(current, line.chapter, false)}] ${who}：“${line.quote}”`;
}
