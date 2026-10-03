/**
 * Optional semantic (vector) retrieval for graph dialogue/events.
 *
 * No native deps: vectors live in memory.db (graph_vectors, Float32 BLOBs)
 * and are scored by brute-force cosine in JS — fine for the few thousand
 * rows a long book produces. Embeddings come from any OpenAI-compatible
 * /embeddings endpoint (memory.graph.vector in inkos.json); off by default.
 * Results are fused with BM25 via reciprocal-rank fusion in retrieval.ts.
 */
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { StoryGraphEmbedder } from "./types.js";

const require = createRequire(import.meta.url);

export interface StoryGraphVectorConfig {
  readonly enabled: boolean;
  readonly baseUrl?: string;
  readonly model?: string;
  /** Env var holding the API key (never store keys in inkos.json). */
  readonly apiKeyEnv?: string;
  readonly dimensions?: number;
}

export const DEFAULT_VECTOR_CONFIG: StoryGraphVectorConfig = { enabled: false };

export class OpenAICompatibleEmbedder implements StoryGraphEmbedder {
  readonly id: string;
  readonly dimensions: number;

  constructor(
    private readonly options: { readonly baseUrl: string; readonly model: string; readonly apiKey?: string; readonly dimensions?: number },
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.id = `openai-compatible:${options.model}`;
    this.dimensions = options.dimensions ?? 0;
  }

  async embed(texts: ReadonlyArray<string>): Promise<ReadonlyArray<ReadonlyArray<number>>> {
    if (texts.length === 0) return [];
    const response = await this.fetchImpl(`${this.options.baseUrl.replace(/\/+$/, "")}/embeddings`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {}),
      },
      body: JSON.stringify({ model: this.options.model, input: texts }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`embeddings HTTP ${response.status}`);
    const body = await response.json() as { data?: Array<{ index?: number; embedding?: number[] }> };
    const rows = [...(body.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    if (rows.length !== texts.length) throw new Error("embeddings: row count mismatch");
    return rows.map((row) => row.embedding ?? []);
  }
}

export function createEmbedderFromConfig(config: StoryGraphVectorConfig | undefined, env: NodeJS.ProcessEnv = process.env): StoryGraphEmbedder | undefined {
  if (!config?.enabled || !config.baseUrl || !config.model) return undefined;
  return new OpenAICompatibleEmbedder({
    baseUrl: config.baseUrl,
    model: config.model,
    apiKey: config.apiKeyEnv ? env[config.apiKeyEnv] : undefined,
    dimensions: config.dimensions,
  });
}

export interface VectorDocument {
  readonly id: string;
  readonly chapter: number;
  readonly text: string;
}

export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

/**
 * Embed any documents not yet stored (or whose text changed), then return
 * ids ranked by cosine similarity to the query, restricted to chapter < before.
 */
export async function semanticSearch(params: {
  readonly bookDir: string;
  readonly embedder: StoryGraphEmbedder;
  readonly documents: ReadonlyArray<VectorDocument>;
  readonly query: string;
  readonly before: number;
  readonly limit?: number;
  readonly batchSize?: number;
}): Promise<string[]> {
  if (!params.query.trim() || params.documents.length === 0) return [];
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(join(params.bookDir, "story", "memory.db"));
  try {
    db.exec("PRAGMA busy_timeout = 2000");
    db.exec(`CREATE TABLE IF NOT EXISTS graph_vectors (
      doc_id TEXT NOT NULL,
      embedder TEXT NOT NULL,
      chapter INTEGER NOT NULL,
      text_hash TEXT NOT NULL,
      vector BLOB NOT NULL,
      PRIMARY KEY (doc_id, embedder)
    )`);
    const existing = new Map(
      (db.prepare("SELECT doc_id AS id, text_hash AS hash FROM graph_vectors WHERE embedder = ?").all(params.embedder.id) as Array<{ id: string; hash: string }>)
        .map((row) => [row.id, row.hash]),
    );
    const hashOf = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);
    const missing = params.documents.filter((doc) => existing.get(doc.id) !== hashOf(doc.text));
    const upsert = db.prepare(
      "INSERT OR REPLACE INTO graph_vectors (doc_id, embedder, chapter, text_hash, vector) VALUES (?, ?, ?, ?, ?)",
    );
    const batchSize = params.batchSize ?? 32;
    for (let i = 0; i < missing.length; i += batchSize) {
      const batch = missing.slice(i, i + batchSize);
      const vectors = await params.embedder.embed(batch.map((doc) => doc.text));
      batch.forEach((doc, index) => {
        upsert.run(doc.id, params.embedder.id, doc.chapter, hashOf(doc.text), Buffer.from(new Float32Array(vectors[index] ?? []).buffer));
      });
    }
    const keep = new Set(params.documents.filter((doc) => doc.chapter < params.before).map((doc) => doc.id));
    const [queryVector] = await params.embedder.embed([params.query]);
    if (!queryVector) return [];
    const rows = db.prepare("SELECT doc_id AS id, vector FROM graph_vectors WHERE embedder = ? AND chapter < ?")
      .all(params.embedder.id, params.before) as Array<{ id: string; vector: Uint8Array }>;
    return rows
      .filter((row) => keep.has(row.id))
      .map((row) => {
        const bytes = row.vector;
        const floats = new Float32Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 4));
        return { id: row.id, score: cosine(queryVector, floats) };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, params.limit ?? 30)
      .map((row) => row.id);
  } finally {
    db.close();
  }
}

/** Reciprocal-rank fusion of several best-first id lists. */
export function fuseRankings(lists: ReadonlyArray<ReadonlyArray<string>>, k = 60): string[] {
  const scores = new Map<string, number>();
  for (const list of lists) {
    list.forEach((id, rank) => scores.set(id, (scores.get(id) ?? 0) + 1 / (k + rank + 1)));
  }
  return [...scores.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}
