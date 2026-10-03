/**
 * SQLite projection of the story-graph journal, stored in the book's existing
 * story/memory.db (graph_* tables; no separate graph DB).
 *
 * Every row carries its source chapter, so per-chapter rebuild/rollback is a
 * `DELETE … WHERE chapter = ?` and time-travel queries are `chapter < N`.
 */
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { hashRecord } from "./journal.js";
import type { ChapterGraphRecord, CharacterStatus, GraphEntityKind } from "./types.js";

const require = createRequire(import.meta.url);

export interface GraphEntityRow {
  readonly chapter: number;
  readonly kind: GraphEntityKind;
  readonly name: string;
  readonly aliases: ReadonlyArray<string>;
  readonly role: string;
  readonly status: string;
  readonly faction: string;
  readonly owner: string;
  readonly notes: string;
}

export interface GraphEdgeRow {
  readonly chapter: number;
  readonly source: string;
  readonly target: string;
  readonly type: string;
  readonly strength: number;
  readonly status: "active" | "ended";
  readonly note: string;
}

export interface GraphEventRow {
  readonly id: number;
  readonly chapter: number;
  readonly seq: number;
  readonly summary: string;
  readonly location: string;
  readonly importance: number;
  readonly participants: ReadonlyArray<string>;
}

export interface GraphDialogueRow {
  readonly id: number;
  readonly chapter: number;
  readonly seq: number;
  readonly speaker: string;
  readonly addressee: string;
  readonly quote: string;
  readonly context: string;
}

export interface GraphConflictRow {
  readonly chapter: number;
  readonly kind: string;
  readonly subject: string;
  readonly detail: string;
  readonly resolution: string;
}

/** All rows strictly before a chapter (what the writer of `before` may know). */
export interface GraphSnapshot {
  readonly before: number;
  readonly entities: ReadonlyArray<GraphEntityRow>;
  readonly edges: ReadonlyArray<GraphEdgeRow>;
  readonly events: ReadonlyArray<GraphEventRow>;
  readonly dialogues: ReadonlyArray<GraphDialogueRow>;
}

export class StoryGraphStore {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly db: any;

  constructor(bookDirOrDbPath: string, options: { readonly inMemory?: boolean } = {}) {
    const { DatabaseSync } = require("node:sqlite");
    if (options.inMemory) {
      this.db = new DatabaseSync(":memory:");
    } else {
      const dbPath = bookDirOrDbPath.endsWith(".db") ? bookDirOrDbPath : join(bookDirOrDbPath, "story", "memory.db");
      mkdirSync(dirname(dbPath), { recursive: true });
      this.db = new DatabaseSync(dbPath);
      this.db.exec("PRAGMA journal_mode = WAL");
    }
    this.db.exec("PRAGMA busy_timeout = 2000");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS graph_chapters (
        chapter INTEGER PRIMARY KEY,
        record_hash TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        extractor TEXT NOT NULL DEFAULT '',
        extracted_at TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS graph_entities (
        chapter INTEGER NOT NULL,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        aliases_json TEXT NOT NULL DEFAULT '[]',
        role TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT '',
        faction TEXT NOT NULL DEFAULT '',
        owner TEXT NOT NULL DEFAULT '',
        notes TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (chapter, kind, name)
      );
      CREATE TABLE IF NOT EXISTS graph_aliases (
        alias TEXT NOT NULL,
        canonical TEXT NOT NULL,
        kind TEXT NOT NULL,
        chapter INTEGER NOT NULL,
        PRIMARY KEY (alias, kind, chapter)
      );
      CREATE TABLE IF NOT EXISTS graph_edges (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chapter INTEGER NOT NULL,
        source TEXT NOT NULL,
        target TEXT NOT NULL,
        type TEXT NOT NULL,
        strength REAL NOT NULL DEFAULT 0.5,
        status TEXT NOT NULL DEFAULT 'active',
        note TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS graph_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chapter INTEGER NOT NULL,
        seq INTEGER NOT NULL,
        summary TEXT NOT NULL,
        location TEXT NOT NULL DEFAULT '',
        importance INTEGER NOT NULL DEFAULT 2
      );
      CREATE TABLE IF NOT EXISTS graph_event_participants (
        event_id INTEGER NOT NULL REFERENCES graph_events(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        PRIMARY KEY (event_id, name)
      );
      CREATE TABLE IF NOT EXISTS graph_dialogues (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chapter INTEGER NOT NULL,
        seq INTEGER NOT NULL,
        speaker TEXT NOT NULL,
        addressee TEXT NOT NULL DEFAULT '',
        quote TEXT NOT NULL,
        context TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS graph_conflicts (
        chapter INTEGER NOT NULL,
        kind TEXT NOT NULL,
        subject TEXT NOT NULL,
        detail TEXT NOT NULL,
        resolution TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_graph_entities_name ON graph_entities(kind, name);
      CREATE INDEX IF NOT EXISTS idx_graph_aliases_canonical ON graph_aliases(canonical);
      CREATE INDEX IF NOT EXISTS idx_graph_edges_chapter ON graph_edges(chapter);
      CREATE INDEX IF NOT EXISTS idx_graph_edges_pair ON graph_edges(source, target);
      CREATE INDEX IF NOT EXISTS idx_graph_events_chapter ON graph_events(chapter);
      CREATE INDEX IF NOT EXISTS idx_graph_event_participants_name ON graph_event_participants(name);
      CREATE INDEX IF NOT EXISTS idx_graph_dialogues_chapter ON graph_dialogues(chapter);
      CREATE INDEX IF NOT EXISTS idx_graph_dialogues_speaker ON graph_dialogues(speaker);
      CREATE INDEX IF NOT EXISTS idx_graph_conflicts_chapter ON graph_conflicts(chapter);
    `);
  }

  /** chapter → record hash of what is currently projected. */
  projectedHashes(): Map<number, string> {
    const rows = this.db.prepare("SELECT chapter, record_hash AS hash FROM graph_chapters").all() as Array<{ chapter: number; hash: string }>;
    return new Map(rows.map((row) => [Number(row.chapter), String(row.hash)]));
  }

  chapterContentHashes(): Map<number, string> {
    const rows = this.db.prepare("SELECT chapter, content_hash AS hash FROM graph_chapters").all() as Array<{ chapter: number; hash: string }>;
    return new Map(rows.map((row) => [Number(row.chapter), String(row.hash)]));
  }

  /** Replace every row of one chapter with the given record (transactional). */
  replaceChapter(record: ChapterGraphRecord): void {
    this.transaction(() => {
      this.deleteChapterRows(record.chapter);
      const chapter = record.chapter;
      const x = record.extraction;
      this.db.prepare(
        "INSERT INTO graph_chapters (chapter, record_hash, content_hash, extractor, extracted_at) VALUES (?, ?, ?, ?, ?)",
      ).run(chapter, hashRecord(record), record.contentHash, record.extractor, record.extractedAt);

      const insertEntity = this.db.prepare(
        `INSERT OR REPLACE INTO graph_entities (chapter, kind, name, aliases_json, role, status, faction, owner, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const insertAlias = this.db.prepare(
        "INSERT OR IGNORE INTO graph_aliases (alias, canonical, kind, chapter) VALUES (?, ?, ?, ?)",
      );
      const entityGroups: Array<[GraphEntityKind, ReadonlyArray<{ name: string; aliases?: ReadonlyArray<string>; role?: string; status?: CharacterStatus; faction?: string; owner?: string; notes?: string }>]> = [
        ["character", x.characters],
        ["faction", x.factions],
        ["item", x.items],
        ["location", x.locations],
      ];
      for (const [kind, rows] of entityGroups) {
        for (const row of rows) {
          const aliases = [...new Set(row.aliases ?? [])];
          insertEntity.run(
            chapter, kind, row.name, JSON.stringify(aliases),
            row.role ?? "", row.status ?? "", row.faction ?? "", row.owner ?? "", row.notes ?? "",
          );
          for (const alias of aliases) insertAlias.run(alias, row.name, kind, chapter);
        }
      }

      const insertEdge = this.db.prepare(
        "INSERT INTO graph_edges (chapter, source, target, type, strength, status, note) VALUES (?, ?, ?, ?, ?, ?, ?)",
      );
      for (const edge of x.relationships) {
        insertEdge.run(chapter, edge.from, edge.to, edge.type, edge.strength ?? 0.5, edge.status ?? "active", edge.note ?? "");
      }

      const insertEvent = this.db.prepare(
        "INSERT INTO graph_events (chapter, seq, summary, location, importance) VALUES (?, ?, ?, ?, ?)",
      );
      const insertParticipant = this.db.prepare(
        "INSERT OR IGNORE INTO graph_event_participants (event_id, name) VALUES (?, ?)",
      );
      x.events.forEach((event, seq) => {
        const result = insertEvent.run(chapter, seq, event.summary, event.location ?? "", event.importance ?? 2);
        const eventId = Number(result.lastInsertRowid);
        for (const name of event.participants ?? []) insertParticipant.run(eventId, name);
      });

      const insertDialogue = this.db.prepare(
        "INSERT INTO graph_dialogues (chapter, seq, speaker, addressee, quote, context) VALUES (?, ?, ?, ?, ?, ?)",
      );
      x.dialogues.forEach((dialogue, seq) => {
        insertDialogue.run(chapter, seq, dialogue.speaker, dialogue.addressee ?? "", dialogue.quote, dialogue.context ?? "");
      });

      const insertConflict = this.db.prepare(
        "INSERT INTO graph_conflicts (chapter, kind, subject, detail, resolution) VALUES (?, ?, ?, ?, ?)",
      );
      for (const conflict of record.conflicts) {
        insertConflict.run(chapter, conflict.kind, conflict.subject, conflict.detail, conflict.resolution);
      }
    });
  }

  deleteChapter(chapter: number): void {
    this.transaction(() => this.deleteChapterRows(chapter));
  }

  /** Drop every row from chapters > targetChapter (rollback / chapter delete). */
  deleteChaptersAfter(targetChapter: number): number[] {
    const chapters = [...this.projectedHashes().keys()].filter((chapter) => chapter > targetChapter);
    this.transaction(() => {
      for (const chapter of chapters) this.deleteChapterRows(chapter);
    });
    return chapters;
  }

  /** Make the projection match the journal exactly. Returns chapters touched. */
  syncFromRecords(records: ReadonlyArray<ChapterGraphRecord>): { readonly replaced: number[]; readonly removed: number[] } {
    const projected = this.projectedHashes();
    const replaced: number[] = [];
    const keep = new Set<number>();
    for (const record of records) {
      keep.add(record.chapter);
      if (projected.get(record.chapter) === hashRecord(record)) continue;
      this.replaceChapter(record);
      replaced.push(record.chapter);
    }
    const removed = [...projected.keys()].filter((chapter) => !keep.has(chapter));
    if (removed.length > 0) {
      this.transaction(() => {
        for (const chapter of removed) this.deleteChapterRows(chapter);
      });
    }
    return { replaced, removed };
  }

  snapshot(before: number): GraphSnapshot {
    const entities = (this.db.prepare(
      `SELECT chapter, kind, name, aliases_json AS aliasesJson, role, status, faction, owner, notes
       FROM graph_entities WHERE chapter < ? ORDER BY chapter, kind, name`,
    ).all(before) as Array<Omit<GraphEntityRow, "aliases"> & { aliasesJson: string }>).map(({ aliasesJson, ...row }) => ({
      ...row,
      chapter: Number(row.chapter),
      aliases: parseJsonArray(aliasesJson),
    }));
    const edges = (this.db.prepare(
      `SELECT chapter, source, target, type, strength, status, note
       FROM graph_edges WHERE chapter < ? ORDER BY chapter, id`,
    ).all(before) as GraphEdgeRow[]).map((row) => ({ ...row, chapter: Number(row.chapter), strength: Number(row.strength) }));
    const participants = this.db.prepare(
      `SELECT p.event_id AS eventId, p.name AS name FROM graph_event_participants p
       JOIN graph_events e ON e.id = p.event_id WHERE e.chapter < ?`,
    ).all(before) as Array<{ eventId: number; name: string }>;
    const byEvent = new Map<number, string[]>();
    for (const row of participants) {
      const list = byEvent.get(Number(row.eventId)) ?? [];
      list.push(row.name);
      byEvent.set(Number(row.eventId), list);
    }
    const events = (this.db.prepare(
      `SELECT id, chapter, seq, summary, location, importance FROM graph_events WHERE chapter < ? ORDER BY chapter, seq`,
    ).all(before) as Array<Omit<GraphEventRow, "participants">>).map((row) => ({
      ...row,
      id: Number(row.id),
      chapter: Number(row.chapter),
      importance: Number(row.importance),
      participants: byEvent.get(Number(row.id)) ?? [],
    }));
    const dialogues = (this.db.prepare(
      `SELECT id, chapter, seq, speaker, addressee, quote, context FROM graph_dialogues WHERE chapter < ? ORDER BY chapter, seq`,
    ).all(before) as GraphDialogueRow[]).map((row) => ({ ...row, id: Number(row.id), chapter: Number(row.chapter) }));
    return { before, entities, edges, events, dialogues };
  }

  conflicts(): GraphConflictRow[] {
    return this.db.prepare(
      "SELECT chapter, kind, subject, detail, resolution FROM graph_conflicts ORDER BY chapter",
    ).all() as GraphConflictRow[];
  }

  stats(): Record<string, number> {
    const count = (table: string): number =>
      Number((this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);
    return {
      chapters: count("graph_chapters"),
      entities: count("graph_entities"),
      edges: count("graph_edges"),
      events: count("graph_events"),
      dialogues: count("graph_dialogues"),
      conflicts: count("graph_conflicts"),
    };
  }

  close(): void {
    this.db.close();
  }

  private deleteChapterRows(chapter: number): void {
    this.db.prepare(
      "DELETE FROM graph_event_participants WHERE event_id IN (SELECT id FROM graph_events WHERE chapter = ?)",
    ).run(chapter);
    for (const table of ["graph_chapters", "graph_entities", "graph_aliases", "graph_edges", "graph_events", "graph_dialogues", "graph_conflicts"]) {
      this.db.prepare(`DELETE FROM ${table} WHERE chapter = ?`).run(chapter);
    }
  }

  private transaction(fn: () => void): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      fn();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

function parseJsonArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}
