# Story knowledge graph (opt-in RAG)

Default **off**. Enable per project in `inkos.json`:

```json
{ "memory": { "graph": { "enabled": true } } }
```

or with `INKOS_STORY_GRAPH=1`. Everything lives in `core/src/story-graph/*`;
the 1.8.0 pipeline only calls the three hooks in `hooks.ts`
(grep `STORY-GRAPH HOOK`).

## Data

* **Journal (authoritative):** `story/graph/chapter-NNNN.json`, one reconciled
  extraction per chapter (+ content hash, extractor id, truth conflicts).
* **Projection:** `graph_*` tables in the existing `story/memory.db`
  (`graph_chapters`, `graph_entities`, `graph_aliases`, `graph_edges`,
  `graph_events`, `graph_event_participants`, `graph_dialogues`,
  `graph_conflicts`, optional `graph_vectors`) plus BM25 documents in the
  shared `retrieval_documents` index (scope `story-graph`). Every row carries
  its chapter, so rollback is `DELETE … WHERE chapter > N` and time travel is
  `chapter < N`. `memory.db` is deleted on rollback in 1.8.0; the projection is
  rebuilt from the journal on demand (no model call).

## Extraction (hook A, after `persistChapterArtifacts`)

One extra call per chapter (`modelOverrides["story-graph"]` can route it to a
cheaper model). Prompt: `extract.ts#buildExtractionMessages` — canonical roster
from the truth files, strict JSON with characters (aliases, status, faction),
factions, items, locations, 3-8 events, directed relationships as of chapter end
(type, strength 0-1, active/ended), and up to 8 key dialogue lines copied
verbatim. `extractor: "heuristic"` gives a free offline extractor (roster
matching, paragraph co-occurrence, quote attribution, summary events).

Reconciliation (`reconcile.ts`, truth files win): names → canonical via
`character_matrix.md` / `roles/` aliases; status overridden by the matrix
(`current_state.md` fills gaps, conservatively); relationships whose polarity
contradicts the matrix `关系` field are dropped; quotes not found verbatim in
the chapter are dropped. Conflicts are kept in the journal.

## Retrieval (hook B, in `composeGovernedChapter`)

1. Seeds: characters named (names/aliases) in goal + outline node + must-keep +
   memo; items/locations/factions in the query pull in owners/members; fallback
   protagonist + last chapter's cast. Max 4 seeds.
2. Expand 1-2 hops over relationship spans (weight = strength × recency, ended
   ×0.3, matrix relation +0.2); 3 neighbours per seed, 1 per hop-1 node.
3. Candidates: character cards, relationships among selected characters (type,
   strength, since/ended, previous types, matrix note), recent events (3 per
   seed, 1 per neighbour), dialogue (BM25 — optionally fused with vectors —
   filtered to selected speakers/addressees, plus each seed's latest line).
4. Merge with BM25 memory: events from chapters whose summary BM25 already
   injected are de-prioritised.
5. Greedy fill by priority under `budgetTokens` (default 1200).

Rendered text uses relative time (`上一章`, `3章前`) because the writer prompt
sanitiser rewrites absolute `第N章` to `此前`.

## Config (`memory.graph`)

| key | default | env |
| --- | --- | --- |
| enabled | false | `INKOS_STORY_GRAPH` |
| budgetTokens | 1200 | `INKOS_STORY_GRAPH_BUDGET` |
| hops | 2 | `INKOS_STORY_GRAPH_HOPS` |
| extractor | llm | `INKOS_STORY_GRAPH_EXTRACTOR` |
| maxCharacters / maxDialogues / eventsPerCharacter | 8 / 6 / 3 | |
| maxChapterChars | 24000 | |
| refreshStaleLimit | 1 (re-extract revised earlier chapters after each write) | |
| vector | `{ enabled: false, baseUrl, model, apiKeyEnv }` | |

## CLI

```
inkos graph status   [book]
inkos graph backfill [book] [--from N --to N] [--force] [--extractor llm|heuristic]
inkos graph rebuild  [book] --chapter N
inkos graph sync     [book]
inkos graph eval     [book] [--extractor heuristic|llm] [--noise] [--hops 1|2] [--budget N]
```

`eval` runs on a temporary copy of the book and never writes into it.
