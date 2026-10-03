/**
 * Cross-check one chapter's raw extraction against the truth files.
 * Truth files win on every conflict; conflicts are recorded in the journal.
 */
import { NameResolver, relationPolarity, type TruthRoster } from "./truth.js";
import type {
  ChapterGraphExtraction,
  ChapterGraphRecord,
  GraphCharacter,
  GraphConflict,
  GraphDialogue,
  GraphGenericEntity,
} from "./types.js";

export function buildResolver(
  roster: TruthRoster,
  learnedAliases: Iterable<{ readonly name: string; readonly aliases: Iterable<string> }> = [],
): NameResolver {
  const resolver = new NameResolver(roster.characters);
  for (const entry of learnedAliases) resolver.add(entry.name, entry.aliases);
  return resolver;
}

export function reconcileExtraction(params: {
  readonly extraction: ChapterGraphExtraction;
  readonly roster: TruthRoster;
  readonly content: string;
  readonly resolver?: NameResolver;
}): { extraction: ChapterGraphRecord["extraction"]; conflicts: GraphConflict[] } {
  const conflicts: GraphConflict[] = [];
  const resolver = params.resolver ?? buildResolver(params.roster);
  const truthByName = new Map(params.roster.characters.map((entry) => [entry.name, entry]));

  // 1. Characters → canonical names (truth names win), merge duplicates.
  const characters = new Map<string, GraphCharacter & { aliases: string[] }>();
  for (const raw of params.extraction.characters) {
    const candidates = [raw.name, ...(raw.aliases ?? [])];
    const canonical = candidates.map((value) => resolver.canonical(value)).find(Boolean) ?? raw.name;
    if (canonical !== raw.name) {
      conflicts.push({
        kind: "alias",
        subject: raw.name,
        detail: `extracted name "${raw.name}" maps to canonical "${canonical}" via truth roster`,
        resolution: "renamed",
      });
    }
    const aliases = new Set([...(raw.aliases ?? []), ...(canonical !== raw.name ? [raw.name] : [])]);
    aliases.delete(canonical);
    const truth = truthByName.get(canonical);
    let status = raw.status;
    if (truth?.status && status && status !== "unknown" && status !== truth.status) {
      conflicts.push({
        kind: "status",
        subject: canonical,
        detail: `extraction says ${status}, truth files say ${truth.status}`,
        resolution: "truth-wins",
      });
      status = truth.status;
    } else if (truth?.status) {
      status = truth.status;
    }
    const existing = characters.get(canonical);
    if (existing) {
      for (const alias of aliases) if (!existing.aliases.includes(alias)) existing.aliases.push(alias);
      continue;
    }
    characters.set(canonical, {
      ...raw,
      name: canonical,
      aliases: [...aliases],
      ...(status ? { status } : {}),
      ...(truth?.role && !raw.role ? { role: truth.role } : {}),
    });
    // Learn extracted aliases for the rest of this chapter (never overrides truth).
    resolver.add(canonical, aliases);
  }

  const resolve = (name: string | undefined): string | undefined => (name ? resolver.resolve(name) : undefined);

  // 2. Relationships: canonical endpoints, drop self loops, truth polarity wins.
  const relationships: ChapterGraphRecord["extraction"]["relationships"][number][] = [];
  const seenEdges = new Set<string>();
  for (const raw of params.extraction.relationships) {
    const from = resolve(raw.from)!;
    const to = resolve(raw.to)!;
    if (!from || !to || from === to) continue;
    const truthDesc = truthByName.get(from)?.relations.get(to) ?? truthByName.get(to)?.relations.get(from);
    if (truthDesc) {
      const truthPolarity = relationPolarity(truthDesc);
      const extractedPolarity = relationPolarity(`${raw.type} ${raw.note ?? ""}`);
      if (truthPolarity !== "neutral" && extractedPolarity !== "neutral" && truthPolarity !== extractedPolarity) {
        conflicts.push({
          kind: "relationship",
          subject: `${from}~${to}`,
          detail: `extracted "${raw.type}" (${extractedPolarity}) contradicts character_matrix "${truthDesc}" (${truthPolarity})`,
          resolution: "dropped",
        });
        continue;
      }
    }
    const key = `${from}\u0000${to}\u0000${raw.type}`;
    if (seenEdges.has(key)) continue;
    seenEdges.add(key);
    relationships.push({ ...raw, from, to, strength: raw.strength ?? 0.5 });
  }

  // 3. Events: canonical participants.
  const events = params.extraction.events.map((event) => ({
    ...event,
    participants: [...new Set((event.participants ?? []).map((name) => resolver.resolve(name)))],
  }));

  // 4. Dialogue must be verbatim; unverifiable quotes are dropped.
  const haystack = normalizeQuoteText(params.content);
  const dialogues: GraphDialogue[] = [];
  for (const raw of params.extraction.dialogues) {
    const quote = stripOuterQuotes(raw.quote);
    const needle = normalizeQuoteText(quote);
    const verified = needle.length >= 2 && haystack.includes(needle);
    if (!verified) {
      conflicts.push({
        kind: "dialogue",
        subject: resolver.resolve(raw.speaker),
        detail: `quote not found verbatim in chapter text (${quote.slice(0, 24)}…)`,
        resolution: "dropped",
      });
      continue;
    }
    dialogues.push({
      ...raw,
      quote,
      speaker: resolver.resolve(raw.speaker),
      ...(raw.addressee ? { addressee: resolver.resolve(raw.addressee) } : {}),
      verified: true,
    });
  }

  return {
    extraction: {
      characters: [...characters.values()],
      factions: dedupeEntities(params.extraction.factions),
      items: dedupeEntities(params.extraction.items).map((item) => ({
        ...item,
        ...(item.owner ? { owner: resolver.resolve(item.owner) } : {}),
      })),
      locations: dedupeEntities(params.extraction.locations),
      events,
      relationships,
      dialogues,
    },
    conflicts,
  };
}

function dedupeEntities(entities: ReadonlyArray<GraphGenericEntity>): GraphGenericEntity[] {
  const byName = new Map<string, GraphGenericEntity>();
  for (const entity of entities) {
    if (!byName.has(entity.name)) byName.set(entity.name, entity);
  }
  return [...byName.values()];
}

function stripOuterQuotes(value: string): string {
  return value.trim().replace(/^[“"「『]+/, "").replace(/[”"」』]+$/, "").trim();
}

export function normalizeQuoteText(value: string): string {
  return value.replace(/[\s“”"「」『』'‘’]/g, "");
}
