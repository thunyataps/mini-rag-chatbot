# 3D Knowledge Graph page — design

Status: approved by user, ready for implementation plan
Date: 2026-08-21

## Goal

Add a new page (`/graph`) that visualizes how the RAG data a user has filed
relates to itself: documents, their chunks, semantic clusters ("categories")
across those chunks, and cross-document similarity links — rendered as a
rotatable, zoomable 3D force-directed graph ("brain" aesthetic).

Non-goals: this is a read-only visualization. It does not change retrieval
behavior (`/api/chat`, `match_chunks*` RPCs) and does not let users edit
cluster labels or manually re-tag chunks.

## Data model (Supabase)

```sql
create table clusters (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null,
  label text not null,
  color_index int not null,
  created_at timestamptz not null default now()
);

alter table chunks add column cluster_id uuid references clusters(id) on delete set null;

create table graph_state (
  session_id uuid primary key,
  last_clustered_at timestamptz not null
);
```

RLS: same permissive anon policy as `documents`/`chunks` (session-scoped
only by convention, not enforced server-side — consistent with the rest of
this project; see README's existing security caveat).

`color_index` is an integer assigned round-robin at cluster-creation time
(`clusterIndex % PALETTE.length`), so the client can map it to a fixed,
theme-consistent color without re-deriving anything from the label text.

## Compute pipeline

Runs client-side, triggered when `/graph` loads and the cached clustering
is stale, or when the user clicks "Re-analyze":

**Staleness check**: fetch `graph_state.last_clustered_at` for the session.
Stale if the row is missing, or if any `chunks.created_at` for this
session is newer than it (i.e. a document was filed since the last run).

**Steps** (`src/lib/graph/`):

1. Fetch every `document` and `chunk` (id, document_id, chunk_index,
   content, embedding) for the session.
2. `k = clamp(round(sqrt(chunkCount / 2)), 2, 8)`. If `chunkCount < 2`,
   skip clustering entirely (nothing meaningful to group).
3. Run k-means (`kmeans.ts`, Lloyd's algorithm, plain JS, no ML library —
   consistent with the rest of this project's "write the RAG logic
   yourself" approach). Distance: euclidean over the embeddings, which are
   already L2-normalized (see `embeddings.ts`), so euclidean ranking is
   monotonic with cosine similarity here — no separate cosine k-means
   variant needed. Fixed iteration cap (e.g. 25) with early-exit on
   convergence (no assignment changes).
4. For each cluster, pick the 3 chunks closest to its centroid as label
   samples.
5. POST `{ clusters: [{ id: <temp-index>, samples: [text, text, text] }] }`
   to `/api/cluster-labels`. That route calls Gemini once (structured JSON
   output, reusing the existing `MODEL_FALLBACK_CHAIN` from
   `/api/chat/route.ts` — extract the fallback-chain logic into a shared
   `src/lib/gemini.ts` so both routes use it) and returns
   `[{ id: <temp-index>, label: string }]`.
6. Persist: delete this session's existing `clusters` rows, insert the new
   ones (with round-robin `color_index`), update `chunks.cluster_id` for
   every chunk, upsert `graph_state.last_clustered_at = now()`.

**Failure handling**: if the Gemini call fails (quota, network, etc.),
fall back to generic labels ("Cluster 1", "Cluster 2", ...) — clustering
itself has no dependency on the LLM, so the graph still renders correctly,
just with less descriptive labels. Never block the page on this call.

## Edges

Computed fresh on every page load (not cached — the data needed is already
in memory from the fetch above, and pairwise similarity over a few hundred
384-dim vectors is sub-second in JS):

- **Structural**: `document -> chunk` for every chunk belonging to that
  document. Rendered thin and low-opacity — scaffolding, not the focus.
- **Similarity**: for each chunk, cosine-similarity against every other
  chunk in the session; keep the top 3 above a `0.5` threshold as edges
  (dedupe symmetric pairs). These can cross documents and clusters — this
  is what visually shows "these two files talk about the same thing."

## Rendering & interaction

- New route: `src/app/graph/page.tsx`, client component.
- Library: `3d-force-graph` (wraps three.js + d3-force-3d). Dynamically
  imported inside a `useEffect` — same reason as `pdfjs-dist`: it touches
  `window`/WebGL at module-eval time, which would break Next's server-side
  prerender of the client component otherwise.
- Node styling:
  - Document nodes: larger, fixed `--ink` color, labeled with the
    document name.
  - Chunk nodes: smaller, colored by `clusters.color_index` against a
    small fixed qualitative palette (6–8 archive-toned hues extending the
    existing design tokens — not default neon force-graph colors).
- Camera: orbit/zoom/pan (built into the library); slow ambient
  auto-rotation while idle, paused on user drag.
- Interaction: click a chunk node -> side panel with full chunk text,
  source document name, and cluster label. Click a document node -> camera
  flies to it. A legend lists each cluster's label + color swatch.
- "Re-analyze" button in the header re-runs the compute pipeline
  unconditionally.
- Entry point: a nav link from the main page (`/`) to `/graph`.

## Error / empty states

- No documents filed yet: empty-state message, no compute attempted, no
  empty 3D canvas shown.
- `chunkCount < 2`: render nodes without cluster coloring (all one neutral
  color) rather than attempting k-means on too little data.
- Cluster-label request fails: silently falls back to generic labels (see
  above) — surfaced as a small inline notice, not a blocking error.

## Testing plan

- `kmeans.ts`: unit-style script test (same pattern used earlier in this
  project — a throwaway `.mjs` script run via `node`, not a committed test
  file) against synthetic embeddings with obvious separated clusters,
  asserting correct grouping.
- `/api/cluster-labels`: script test hitting the real Gemini API (as done
  for `/api/chat` and the model-fallback chain) confirming it returns
  valid parseable JSON matching the requested shape.
- Staleness check: verify `graph_state` logic triggers recompute after a
  new document is filed, and skips recompute when nothing changed.
- Manual verification in an actual browser is required for the 3D
  rendering/interaction itself (rotate, click, legend, auto-rotate) —
  automated browser tooling was unavailable for this whole session, so
  this step depends on the user checking it visually after implementation.
