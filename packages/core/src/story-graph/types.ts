/**
 * Story knowledge graph — shared types and the extraction payload schema.
 *
 * The story graph is an opt-in (default off) retrieval layer: after each
 * chapter one extra LLM extraction records who/what/where plus verbatim key
 * dialogue, and the composer pulls a small, budgeted slice of it (key
 * characters + 1-2 relationship hops) into the writer context.
 *
 * Everything in story-graph/* is self-contained. The 1.8.0 pipeline touches it
 * only through the hook functions in ./hooks.ts (search for "STORY-GRAPH HOOK").
 */
import { z } from "zod";

export const GRAPH_ENTITY_KINDS = ["character", "faction", "item", "location"] as const;
export type GraphEntityKind = typeof GRAPH_ENTITY_KINDS[number];

const nameString = z.string().trim().min(1).max(80);
const optionalText = (max: number) => z.string().trim().max(max).optional().catch(undefined);
const aliasList = z.array(z.string().trim().min(1).max(80)).max(16).optional().catch(undefined);

export const CharacterStatusSchema = z.enum(["alive", "dead", "missing", "unknown"]);
export type CharacterStatus = z.infer<typeof CharacterStatusSchema>;

const characterSchema = z.object({
  name: nameString,
  aliases: aliasList,
  role: optionalText(80),
  status: CharacterStatusSchema.optional().catch(undefined),
  faction: optionalText(80),
  notes: optionalText(300),
});

const genericEntitySchema = z.object({
  name: nameString,
  aliases: aliasList,
  owner: optionalText(80),
  notes: optionalText(300),
});

const eventSchema = z.object({
  summary: z.string().trim().min(1).max(300),
  participants: z.array(nameString).max(12).optional().catch(undefined),
  location: optionalText(80),
  importance: z.coerce.number().int().min(1).max(3).optional().catch(undefined),
});

const relationshipSchema = z.object({
  from: nameString,
  to: nameString,
  type: z.string().trim().min(1).max(60),
  strength: z.coerce.number().min(0).max(1).optional().catch(undefined),
  status: z.enum(["active", "ended"]).optional().catch(undefined),
  note: optionalText(200),
});

const dialogueSchema = z.object({
  speaker: nameString,
  addressee: optionalText(80),
  quote: z.string().trim().min(1).max(400),
  context: optionalText(200),
});

/** Lenient element-wise array: drops invalid rows instead of failing the payload. */
function lenientArray<T extends z.ZodTypeAny>(item: T, max: number) {
  return z.preprocess(
    (value) => (Array.isArray(value) ? value : []),
    z.array(z.unknown()),
  ).transform((rows) => {
    const out: Array<z.infer<T>> = [];
    for (const row of rows) {
      const parsed = item.safeParse(row);
      if (parsed.success) out.push(parsed.data);
      if (out.length >= max) break;
    }
    return out;
  });
}

export const ChapterGraphExtractionSchema = z.object({
  characters: lenientArray(characterSchema, 40),
  factions: lenientArray(genericEntitySchema, 20),
  items: lenientArray(genericEntitySchema, 20),
  locations: lenientArray(genericEntitySchema, 20),
  events: lenientArray(eventSchema, 20),
  relationships: lenientArray(relationshipSchema, 40),
  dialogues: lenientArray(dialogueSchema, 20),
});

export type ChapterGraphExtraction = z.infer<typeof ChapterGraphExtractionSchema>;
export type GraphCharacter = ChapterGraphExtraction["characters"][number];
export type GraphGenericEntity = ChapterGraphExtraction["items"][number];
export type GraphEvent = ChapterGraphExtraction["events"][number];
export type GraphRelationship = ChapterGraphExtraction["relationships"][number];
export type GraphDialogue = ChapterGraphExtraction["dialogues"][number] & {
  /** true when the quote was found verbatim in the chapter text. */
  readonly verified?: boolean;
};

export interface GraphConflict {
  readonly kind: "alias" | "status" | "relationship" | "dialogue" | "name";
  readonly subject: string;
  readonly detail: string;
  /** What the reconciler did: truth files always win. */
  readonly resolution: "truth-wins" | "dropped" | "renamed" | "kept-flagged";
}

/**
 * One chapter's reconciled extraction. Persisted verbatim as
 * story/graph/chapter-NNNN.json (the authoritative journal); the memory.db
 * graph_* tables are a rebuildable projection of these files.
 */
export interface ChapterGraphRecord {
  readonly version: 1;
  readonly chapter: number;
  readonly title: string;
  /** sha256 of the chapter body the extraction was made from. */
  readonly contentHash: string;
  readonly extractor: string;
  readonly extractedAt: string;
  readonly extraction: Omit<ChapterGraphExtraction, "dialogues"> & {
    readonly dialogues: ReadonlyArray<GraphDialogue>;
  };
  readonly conflicts: ReadonlyArray<GraphConflict>;
}

export interface ChapterGraphExtractorInput {
  readonly chapterNumber: number;
  readonly title: string;
  readonly content: string;
  readonly language: "zh" | "en";
  /** Canonical roster (truth files) so the model reuses the same names. */
  readonly knownCharacters: ReadonlyArray<{ readonly name: string; readonly aliases: ReadonlyArray<string> }>;
  /** Optional chapter summary row (from chapter_summaries) for grounding. */
  readonly summaryHint?: string;
}

export interface ChapterGraphExtractor {
  readonly id: string;
  extract(input: ChapterGraphExtractorInput): Promise<ChapterGraphExtraction>;
}

/** Optional vector retrieval hook (no implementation ships by default). */
export interface StoryGraphEmbedder {
  readonly id: string;
  readonly dimensions: number;
  embed(texts: ReadonlyArray<string>): Promise<ReadonlyArray<ReadonlyArray<number>>>;
}
