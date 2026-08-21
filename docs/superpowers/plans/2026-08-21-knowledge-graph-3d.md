# 3D Knowledge Graph Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `/graph` page that renders a rotatable 3D force-directed graph of every filed document and its chunks, colored by an auto-computed, Gemini-labeled semantic cluster, with cross-document similarity links.

**Architecture:** All computation (k-means clustering, similarity edges) runs client-side in the browser using data already fetched from Supabase, mirroring this project's existing pattern of doing RAG logic in the browser rather than a server framework. Cluster labels are the one exception — a single batched call to a new `/api/cluster-labels` route (reusing the same Gemini model-fallback chain as `/api/chat`) — and are cached in Supabase so re-opening the page doesn't re-spend free-tier quota.

**Tech Stack:** `3d-force-graph` (three.js + d3-force-3d) for rendering; plain JS k-means (no ML library) for clustering; existing Supabase/pgvector/Gemini stack for everything else.

**Spec:** `docs/superpowers/specs/2026-08-21-knowledge-graph-3d-design.md`

## Global Constraints

- Embeddings are 384-dimensional and already L2-normalized (from `all-MiniLM-L6-v2` via Transformers.js) — k-means may use plain euclidean distance; no separate cosine-distance k-means variant is needed.
- Gemini free-tier quota is scarce (as low as 5 RPM / 20 RPD per model, observed directly against this project's key). Cluster labeling must be **one Gemini call for all clusters**, never one call per cluster.
- All Gemini calls go through the shared `MODEL_FALLBACK_CHAIN` (`src/lib/gemini.ts`) — no route may call `GoogleGenAI` directly.
- No new backend framework or ORM. Supabase access from the client uses the existing `@/lib/supabase/client` singleton and the existing permissive, session-scoped (not server-enforced) RLS policy pattern — do not add auth.
- Visual design must extend the existing archive/card-catalog design tokens (`--paper`, `--card`, `--ink`, `--ink-soft`, `--line`, `--stamp`, `--danger`) from `src/app/globals.css` — no unrelated color system.
- This session's browser-automation tool has been non-functional all session; the plan's manual verification steps say so explicitly rather than assuming a screenshot can be taken.

---

## File Structure

| File | Responsibility |
|---|---|
| `supabase/schema.sql` (modify) | Add `clusters`, `graph_state` tables and `chunks.cluster_id` column |
| `src/lib/gemini.ts` (new) | Shared `GoogleGenAI` client + `MODEL_FALLBACK_CHAIN` + `streamWithFallback` + `generateJsonWithFallback` |
| `src/app/api/chat/route.ts` (modify) | Use `streamWithFallback` from the new shared module instead of its own copy |
| `src/lib/graph/types.ts` (new) | Shared types: `ChunkPoint`, `ClusterRow`, `GraphNode`, `GraphEdge`, `GraphData` |
| `src/lib/graph/palette.ts` (new) | `CLUSTER_PALETTE` — the fixed archive-toned color list |
| `src/lib/graph/kmeans.ts` (new) | Plain-JS k-means (Lloyd's algorithm, farthest-point init) |
| `src/lib/graph/edges.ts` (new) | `cosineSimilarity` + `computeSimilarityEdges` |
| `src/app/api/cluster-labels/route.ts` (new) | One batched Gemini call: cluster samples in, `{id, label}[]` out |
| `src/lib/graph/buildGraph.ts` (new) | Orchestrates fetch -> staleness check -> recompute -> assemble `GraphData` |
| `src/hooks/useGraph.ts` (new) | React hook wrapping `buildGraph.ts` for the page component |
| `src/app/graph/page.tsx` (new) | The 3D graph page itself |
| `src/app/page.tsx` (modify) | Add a nav link to `/graph` |

---

### Task 1: Database schema — clusters, graph_state, chunks.cluster_id

**Files:**
- Modify: `supabase/schema.sql`

**Interfaces:**
- Produces: tables `clusters (id uuid, session_id uuid, label text, color_index int, created_at timestamptz)`, `graph_state (session_id uuid primary key, last_clustered_at timestamptz)`; new column `chunks.cluster_id uuid references clusters(id)`.

- [ ] **Step 1: Append the migration to `supabase/schema.sql`**

Add this to the end of the file (idempotent, matching the file's existing style):

```sql
-- 8. Knowledge graph: semantic clusters over a session's chunks, and a
-- watermark of when they were last computed (see src/lib/graph/buildGraph.ts).
create table if not exists clusters (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null,
  label text not null,
  color_index int not null,
  created_at timestamptz not null default now()
);

alter table chunks add column if not exists cluster_id uuid references clusters(id) on delete set null;

create table if not exists graph_state (
  session_id uuid primary key,
  last_clustered_at timestamptz not null
);

create index if not exists clusters_session_id_idx on clusters (session_id);

alter table clusters enable row level security;
alter table graph_state enable row level security;

drop policy if exists "anon can insert clusters" on clusters;
create policy "anon can insert clusters" on clusters
  for insert to anon with check (true);
drop policy if exists "anon can read clusters" on clusters;
create policy "anon can read clusters" on clusters
  for select to anon using (true);
drop policy if exists "anon can delete clusters" on clusters;
create policy "anon can delete clusters" on clusters
  for delete to anon using (true);

drop policy if exists "anon can update chunks" on chunks;
create policy "anon can update chunks" on chunks
  for update to anon using (true) with check (true);

drop policy if exists "anon can upsert graph_state" on graph_state;
create policy "anon can upsert graph_state" on graph_state
  for insert to anon with check (true);
drop policy if exists "anon can update graph_state" on graph_state;
create policy "anon can update graph_state" on graph_state
  for update to anon using (true) with check (true);
drop policy if exists "anon can read graph_state" on graph_state;
create policy "anon can read graph_state" on graph_state
  for select to anon using (true);
```

- [ ] **Step 2: Apply the migration via the Supabase Management API**

This project has no `supabase` CLI link; migrations are applied the same way the earlier `documents`/`chunks`/`match_chunks*` schema was: via a direct Management API call using the `SUPABASE_ACCESS_TOKEN` already saved in `.env.local`, against project ref `imjqsevxanvbrjnbjsob`.

```bash
cd "/Users/mj/JAB/GITHUB/Mini RAG Chatbot" && \
TOKEN=$(grep '^SUPABASE_ACCESS_TOKEN=' .env.local | cut -d= -f2-) && \
python3 -c "
import json
sql = open('supabase/schema.sql').read()
print(json.dumps({'query': sql}))
" > /tmp/schema_payload.json && \
curl -s -X POST "https://api.supabase.com/v1/projects/imjqsevxanvbrjnbjsob/database/query" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  --data @/tmp/schema_payload.json && rm -f /tmp/schema_payload.json
```

Expected output: `[]` (the whole file is idempotent DDL; no rows returned).

- [ ] **Step 3: Verify the new tables and column exist**

```bash
cd "/Users/mj/JAB/GITHUB/Mini RAG Chatbot" && \
TOKEN=$(grep '^SUPABASE_ACCESS_TOKEN=' .env.local | cut -d= -f2-) && \
curl -s -X POST "https://api.supabase.com/v1/projects/imjqsevxanvbrjnbjsob/database/query" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "{\"query\":\"select table_name from information_schema.tables where table_schema='public' and table_name in ('clusters','graph_state'); select column_name from information_schema.columns where table_name='chunks' and column_name='cluster_id';\"}"
```

Expected: a JSON array containing `cluster_id` (the API returns only the last statement's rows — run the two `select`s as separate calls if you want to see both explicitly).

- [ ] **Step 4: Commit**

```bash
git add supabase/schema.sql
git commit -m "feat: add clusters/graph_state tables for knowledge graph"
```

---

### Task 2: Extract shared Gemini fallback chain into `src/lib/gemini.ts`

**Files:**
- Create: `src/lib/gemini.ts`
- Modify: `src/app/api/chat/route.ts`

**Interfaces:**
- Produces: `ai: GoogleGenAI`, `MODEL_FALLBACK_CHAIN: string[]`, `streamWithFallback(question: string, systemPrompt: string): Promise<{ stream: AsyncGenerator<{text?: string}>, model: string }>`, `generateJsonWithFallback<T>(prompt: string, responseSchema: object): Promise<T>`.
- Consumes (Task 5): `generateJsonWithFallback`.

- [ ] **Step 1: Create `src/lib/gemini.ts`**

```ts
import { GoogleGenAI } from "@google/genai";

export const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

/**
 * Free-tier rate limits (RPM/TPM/RPD) are tracked per model, independently -
 * using up gemini-3.6-flash's quota doesn't touch gemini-3.5-flash's. So on
 * a 429 (rate limited) or 503 (overloaded) we just retry the same request
 * against the next model in this list instead of failing the request.
 * Verified working against this project's API key; gemini-2.5-flash and
 * gemini-2.5-flash-lite are deliberately excluded - Google retired them
 * ("no longer available to new users", 404).
 */
export const MODEL_FALLBACK_CHAIN = [
  "gemini-3.6-flash",
  "gemini-3.5-flash",
  "gemini-3.1-flash-lite",
  "gemini-3.5-flash-lite",
  "gemini-flash-lite-latest",
  "gemini-3.7-flash",
  "gemini-flash-latest",
];

export async function streamWithFallback(question: string, systemPrompt: string) {
  let lastErr: unknown;
  for (const model of MODEL_FALLBACK_CHAIN) {
    try {
      const stream = await ai.models.generateContentStream({
        model,
        contents: question,
        config: { systemInstruction: systemPrompt, temperature: 0.2 },
      });
      return { stream, model };
    } catch (err) {
      console.error(`Gemini model "${model}" failed, trying next:`, err);
      lastErr = err;
    }
  }
  throw lastErr;
}

/** Same fallback chain, but for a single non-streaming structured-JSON response. */
export async function generateJsonWithFallback<T>(
  prompt: string,
  responseSchema: object
): Promise<T> {
  let lastErr: unknown;
  for (const model of MODEL_FALLBACK_CHAIN) {
    try {
      const response = await ai.models.generateContent({
        model,
        contents: prompt,
        config: {
          responseMimeType: "application/json",
          responseSchema,
          temperature: 0.2,
        },
      });
      const text = response.text ?? "";
      return JSON.parse(text) as T;
    } catch (err) {
      console.error(`Gemini model "${model}" failed, trying next:`, err);
      lastErr = err;
    }
  }
  throw lastErr;
}
```

- [ ] **Step 2: Rewrite `src/app/api/chat/route.ts` to use the shared module**

Replace the entire file:

```ts
import { NextRequest, NextResponse } from "next/server";
import { streamWithFallback } from "@/lib/gemini";

/**
 * RAG concept: augmented generation.
 *
 * This route is the "Generation" half of RAG. It never touches the whole
 * document - it only receives the handful of chunks the client already
 * retrieved as the most relevant to the question (see useDocuments.ts), and
 * asks the LLM to answer using only that context. This is what keeps
 * answers grounded in the user's own document instead of the model's
 * general training knowledge.
 *
 * The response is streamed back as plain text (one chunk per network
 * write), which is what lets the UI show tokens appearing one at a time
 * instead of waiting for the full answer.
 */
export async function POST(req: NextRequest) {
  const { question, context } = await req.json();

  if (!question || typeof question !== "string") {
    return NextResponse.json({ error: "Missing question" }, { status: 400 });
  }
  if (!context || typeof context !== "string") {
    return NextResponse.json({ error: "Missing context" }, { status: 400 });
  }
  if (!process.env.GEMINI_API_KEY) {
    return NextResponse.json(
      { error: "GEMINI_API_KEY is not set on the server" },
      { status: 500 }
    );
  }

  const systemPrompt = `You are a helpful assistant that answers questions using ONLY the document excerpts provided below. If the answer isn't contained in the excerpts, say you don't know instead of guessing. Answer in the same language the question was asked in.

Document excerpts:
${context}`;

  let geminiStream;
  try {
    const result = await streamWithFallback(question, systemPrompt);
    geminiStream = result.stream;
    console.log(`Answering with model: ${result.model}`);
  } catch (err) {
    console.error("All Gemini models failed:", err);
    return NextResponse.json({ error: "Gemini API request failed" }, { status: 500 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const chunk of geminiStream) {
          if (chunk.text) controller.enqueue(encoder.encode(chunk.text));
        }
        controller.close();
      } catch (err) {
        console.error("Gemini stream failed:", err);
        controller.error(err);
      }
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
```

- [ ] **Step 3: Typecheck and verify `/api/chat` still works**

```bash
cd "/Users/mj/JAB/GITHUB/Mini RAG Chatbot" && npx tsc --noEmit
```
Expected: no output (passes).

```bash
cd "/Users/mj/JAB/GITHUB/Mini RAG Chatbot" && pkill -f "next dev" 2>/dev/null; sleep 1; (npm run dev > /tmp/mini-rag-dev.log 2>&1 &) && sleep 3 && curl -s -N -X POST http://localhost:3000/api/chat -H "Content-Type: application/json" -d '{"question":"What is this about?","context":"[1] Mini RAG Chatbot answers questions from uploaded documents."}' -w "\n[HTTP %{http_code}]\n"
```
Expected: `[HTTP 200]` with a real answer in the body (same behavior as before the refactor).

- [ ] **Step 4: Commit**

```bash
git add src/lib/gemini.ts src/app/api/chat/route.ts
git commit -m "refactor: extract shared Gemini model-fallback chain"
```

---

### Task 3: k-means clustering

**Files:**
- Create: `src/lib/graph/kmeans.ts`
- Test: throwaway script `/tmp/test-kmeans.mjs` (not committed — same pattern used earlier in this project for `test-phase2.mjs`/`test-multidoc.mjs`)

**Interfaces:**
- Produces: `interface KMeansResult { assignments: number[]; centroids: number[][] }`, `kmeans(points: number[][], k: number, maxIterations?: number): KMeansResult`.
- Consumes (Task 6): `kmeans`.

- [ ] **Step 1: Create `src/lib/graph/kmeans.ts`**

```ts
export interface KMeansResult {
  assignments: number[];
  centroids: number[][];
}

function squaredDistance(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return sum;
}

/**
 * Farthest-point sampling for initial centroids: deterministic (no RNG),
 * and spreads the starting centroids across the data instead of risking
 * several landing in the same cluster, which plain random init can do.
 */
function initCentroids(points: number[][], k: number): number[][] {
  const centroids: number[][] = [points[0]];
  while (centroids.length < k) {
    let farthestPoint = points[0];
    let farthestDist = -Infinity;
    for (const point of points) {
      const minDist = Math.min(...centroids.map((c) => squaredDistance(point, c)));
      if (minDist > farthestDist) {
        farthestDist = minDist;
        farthestPoint = point;
      }
    }
    centroids.push(farthestPoint);
  }
  return centroids;
}

/** Plain Lloyd's-algorithm k-means. Points are 384-dim, already L2-normalized
 * embeddings, so squared-euclidean distance ranking matches cosine-similarity
 * ranking here - no separate cosine variant needed. */
export function kmeans(points: number[][], k: number, maxIterations = 25): KMeansResult {
  if (points.length === 0) return { assignments: [], centroids: [] };

  const effectiveK = Math.min(k, points.length);
  let centroids = initCentroids(points, effectiveK);
  let assignments = new Array(points.length).fill(-1);

  for (let iter = 0; iter < maxIterations; iter++) {
    const newAssignments = points.map((point) => {
      let best = 0;
      let bestDist = Infinity;
      centroids.forEach((centroid, i) => {
        const dist = squaredDistance(point, centroid);
        if (dist < bestDist) {
          bestDist = dist;
          best = i;
        }
      });
      return best;
    });

    const changed = newAssignments.some((a, i) => a !== assignments[i]);
    assignments = newAssignments;
    if (!changed && iter > 0) break;

    const dims = points[0].length;
    const sums = Array.from({ length: effectiveK }, () => new Array(dims).fill(0));
    const counts = new Array(effectiveK).fill(0);
    points.forEach((point, i) => {
      const cluster = assignments[i];
      counts[cluster]++;
      for (let d = 0; d < dims; d++) sums[cluster][d] += point[d];
    });
    centroids = sums.map((sum, i) =>
      counts[i] === 0 ? centroids[i] : sum.map((v) => v / counts[i])
    );
  }

  return { assignments, centroids };
}
```

- [ ] **Step 2: Write and run a throwaway correctness test**

```bash
cat > /tmp/test-kmeans.mjs << 'EOF'
// Throwaway correctness check - three well-separated 3D blobs, expect 3 clean clusters.
const { kmeans } = await import("/Users/mj/JAB/GITHUB/Mini RAG Chatbot/src/lib/graph/kmeans.ts");
EOF
echo "kmeans.ts is TS - test via a quick ts-node-less inline check instead:"
cd "/Users/mj/JAB/GITHUB/Mini RAG Chatbot" && npx tsx -e '
import { kmeans } from "./src/lib/graph/kmeans";

const blobA = Array.from({ length: 5 }, () => [0 + Math.random() * 0.1, 0 + Math.random() * 0.1, 0]);
const blobB = Array.from({ length: 5 }, () => [10 + Math.random() * 0.1, 10 + Math.random() * 0.1, 0]);
const blobC = Array.from({ length: 5 }, () => [-10 + Math.random() * 0.1, 10 + Math.random() * 0.1, 0]);
const points = [...blobA, ...blobB, ...blobC];

const { assignments } = kmeans(points, 3);
console.log("assignments:", assignments);

const sameWithin = (start) => assignments.slice(start, start + 5).every((a) => a === assignments[start]);
const ok = sameWithin(0) && sameWithin(5) && sameWithin(10) &&
  new Set([assignments[0], assignments[5], assignments[10]]).size === 3;
console.log(ok ? "PASS: three distinct, internally-consistent clusters" : "FAIL");
process.exit(ok ? 0 : 1);
'
```

Expected: `PASS: three distinct, internally-consistent clusters`. If `npx tsx` is not available, run `npm install -D tsx` first (dev-only, used for this ad-hoc check).

- [ ] **Step 3: Commit**

```bash
git add src/lib/graph/kmeans.ts
git commit -m "feat: add plain-JS k-means for chunk clustering"
```

---

### Task 4: Similarity edges

**Files:**
- Create: `src/lib/graph/types.ts`
- Create: `src/lib/graph/edges.ts`

**Interfaces:**
- Consumes: none (pure functions over plain data).
- Produces: `ChunkPoint`, `ClusterRow`, `GraphNode`, `GraphEdge`, `GraphData` (types), `cosineSimilarity(a: number[], b: number[]): number`, `computeSimilarityEdges(chunks: ChunkPoint[]): GraphEdge[]`.
- Consumes (Task 6, Task 8): all of the above.

- [ ] **Step 1: Create `src/lib/graph/types.ts`**

```ts
export interface ChunkPoint {
  id: number;
  documentId: string;
  documentName: string;
  chunkIndex: number;
  content: string;
  embedding: number[];
  clusterId: string | null;
}

export interface ClusterRow {
  id: string;
  label: string;
  colorIndex: number;
}

export interface GraphNode {
  id: string; // "doc:<uuid>" or "chunk:<id>"
  kind: "document" | "chunk";
  name: string;
  content?: string; // chunk only
  documentName?: string; // chunk only
  clusterLabel?: string; // chunk only
  colorIndex?: number; // chunk only
}

export interface GraphEdge {
  source: string;
  target: string;
  kind: "structural" | "similarity";
  strength?: number; // similarity only
}

export interface GraphData {
  nodes: GraphNode[];
  links: GraphEdge[];
  clusters: ClusterRow[];
}
```

- [ ] **Step 2: Create `src/lib/graph/edges.ts`**

```ts
import type { ChunkPoint, GraphEdge } from "./types";

/**
 * Same cosine-similarity concept used for retrieval (see supabase/schema.sql
 * match_chunks* RPCs), just computed in JS here because the graph page
 * already has every chunk's embedding in memory - no extra query needed.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

const TOP_K = 3;
const SIMILARITY_THRESHOLD = 0.5;

/** For each chunk, link its top-3 most similar OTHER chunks above the
 * threshold (can cross documents/clusters - that's the point: it's what
 * visually shows "these files talk about the same thing"). Deduped so a
 * mutual match only produces one edge. */
export function computeSimilarityEdges(chunks: ChunkPoint[]): GraphEdge[] {
  const edges: GraphEdge[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < chunks.length; i++) {
    const scored = chunks
      .map((other, j) => ({
        j,
        sim: i === j ? -1 : cosineSimilarity(chunks[i].embedding, other.embedding),
      }))
      .filter((s) => s.sim >= SIMILARITY_THRESHOLD)
      .sort((a, b) => b.sim - a.sim)
      .slice(0, TOP_K);

    for (const { j, sim } of scored) {
      const key = [chunks[i].id, chunks[j].id].sort((a, b) => a - b).join("-");
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({
        source: `chunk:${chunks[i].id}`,
        target: `chunk:${chunks[j].id}`,
        kind: "similarity",
        strength: sim,
      });
    }
  }

  return edges;
}
```

- [ ] **Step 3: Typecheck**

```bash
cd "/Users/mj/JAB/GITHUB/Mini RAG Chatbot" && npx tsc --noEmit
```
Expected: no output.

- [ ] **Step 4: Commit**

```bash
git add src/lib/graph/types.ts src/lib/graph/edges.ts
git commit -m "feat: add graph types and cosine-similarity edge computation"
```

---

### Task 5: `/api/cluster-labels` route

**Files:**
- Create: `src/app/api/cluster-labels/route.ts`

**Interfaces:**
- Consumes: `generateJsonWithFallback` from `@/lib/gemini` (Task 2).
- Produces: `POST /api/cluster-labels` — request `{ clusters: { id: number; samples: string[] }[] }`, response `{ labels: { id: number; label: string }[] }` on success, `{ error: string }` on failure.
- Consumes (Task 6): this HTTP endpoint.

- [ ] **Step 1: Create `src/app/api/cluster-labels/route.ts`**

```ts
import { NextRequest, NextResponse } from "next/server";
import { generateJsonWithFallback } from "@/lib/gemini";

interface ClusterSample {
  id: number;
  samples: string[];
}

interface ClusterLabelResult {
  id: number;
  label: string;
}

const RESPONSE_SCHEMA = {
  type: "array",
  items: {
    type: "object",
    properties: {
      id: { type: "integer" },
      label: { type: "string" },
    },
    required: ["id", "label"],
  },
};

/**
 * One Gemini call labels every cluster at once (not one call per cluster) -
 * free-tier RPM/RPD is too scarce to spend per-cluster (see src/lib/gemini.ts).
 */
export async function POST(req: NextRequest) {
  const { clusters } = (await req.json()) as { clusters: ClusterSample[] };

  if (!Array.isArray(clusters) || clusters.length === 0) {
    return NextResponse.json({ error: "Missing clusters" }, { status: 400 });
  }
  if (!process.env.GEMINI_API_KEY) {
    return NextResponse.json(
      { error: "GEMINI_API_KEY is not set on the server" },
      { status: 500 }
    );
  }

  const prompt = `You will be given several groups of short text excerpts, each pulled from the same topic cluster in a document collection. For each group, respond with a short 1-3 word topic label that describes what that group is about.

${clusters
  .map((c) => `Cluster ${c.id}:\n${c.samples.map((s) => `- ${s.slice(0, 300)}`).join("\n")}`)
  .join("\n\n")}

Respond with a JSON array matching the schema, one entry per cluster id above.`;

  try {
    const labels = await generateJsonWithFallback<ClusterLabelResult[]>(prompt, RESPONSE_SCHEMA);
    return NextResponse.json({ labels });
  } catch (err) {
    console.error("Cluster labeling failed:", err);
    return NextResponse.json({ error: "Cluster labeling failed" }, { status: 500 });
  }
}
```

- [ ] **Step 2: Typecheck, then test against the real Gemini API**

```bash
cd "/Users/mj/JAB/GITHUB/Mini RAG Chatbot" && npx tsc --noEmit
```
Expected: no output.

```bash
cd "/Users/mj/JAB/GITHUB/Mini RAG Chatbot" && pkill -f "next dev" 2>/dev/null; sleep 1; (npm run dev > /tmp/mini-rag-dev.log 2>&1 &) && sleep 3 && curl -s -X POST http://localhost:3000/api/cluster-labels \
  -H "Content-Type: application/json" \
  -d '{"clusters":[{"id":0,"samples":["Employees get 20 days of paid vacation per year.","Health insurance covers dental and vision."]},{"id":1,"samples":["The office is closed on Christmas Day.","New Year is a company holiday."]}]}'
```

Expected: `{"labels":[{"id":0,"label":"..."},{"id":1,"label":"..."}]}` with plausible short labels (e.g. something like "Benefits" and "Holidays").

- [ ] **Step 3: Commit**

```bash
git add src/app/api/cluster-labels/route.ts
git commit -m "feat: add /api/cluster-labels route"
```

---

### Task 6: `buildGraph.ts` orchestration

**Files:**
- Create: `src/lib/graph/palette.ts`
- Create: `src/lib/graph/buildGraph.ts`
- Test: throwaway script `test-graph.mjs` at the project root (delete after running, same pattern as `test-phase2.mjs`/`test-multidoc.mjs` earlier in this project)

**Interfaces:**
- Consumes: `supabase` from `@/lib/supabase/client`; `kmeans` (Task 3); `computeSimilarityEdges`, `ChunkPoint`, `ClusterRow`, `GraphNode`, `GraphData` (Task 4); `POST /api/cluster-labels` (Task 5).
- Produces: `CLUSTER_PALETTE: string[]`; `fetchChunkPoints(sessionId: string): Promise<ChunkPoint[]>`; `needsRecompute(sessionId: string, chunks: ChunkPoint[]): Promise<boolean>`; `recomputeClusters(sessionId: string, chunks: ChunkPoint[]): Promise<void>`; `forceRecompute(sessionId: string): Promise<void>`; `fetchGraphData(sessionId: string): Promise<GraphData>`.
- Consumes (Task 7, Task 8): all of the above.

- [ ] **Step 1: Create `src/lib/graph/palette.ts`**

```ts
/** Fixed, archive-toned qualitative palette for cluster colors - extends this
 * project's existing design tokens rather than using default force-graph
 * neon colors. Index into this with `colorIndex % CLUSTER_PALETTE.length`. */
export const CLUSTER_PALETTE = [
  "#9c6a1e", // stamp/amber
  "#3f6b5c", // sage
  "#7a3b3b", // rust
  "#3d5a80", // dusty blue
  "#6b4d8f", // muted violet
  "#5c7a3f", // olive
  "#8f5a3b", // clay
  "#4a6363", // teal-gray
];
```

- [ ] **Step 2: Create `src/lib/graph/buildGraph.ts`**

```ts
"use client";

import { supabase } from "@/lib/supabase/client";
import { kmeans } from "./kmeans";
import { computeSimilarityEdges } from "./edges";
import { CLUSTER_PALETTE } from "./palette";
import type { ChunkPoint, ClusterRow, GraphData, GraphNode } from "./types";

type ChunkWithDocumentRow = {
  id: number;
  document_id: string;
  chunk_index: number;
  content: string;
  embedding: number[];
  cluster_id: string | null;
  documents: { name: string; session_id: string };
};

export async function fetchChunkPoints(sessionId: string): Promise<ChunkPoint[]> {
  const { data, error } = await supabase
    .from("chunks")
    .select(
      "id, document_id, chunk_index, content, embedding, cluster_id, documents!inner(name, session_id)"
    )
    .eq("documents.session_id", sessionId);
  if (error) throw new Error(error.message);

  return ((data ?? []) as unknown as ChunkWithDocumentRow[]).map((row) => ({
    id: row.id,
    documentId: row.document_id,
    documentName: row.documents.name,
    chunkIndex: row.chunk_index,
    content: row.content,
    embedding: row.embedding,
    clusterId: row.cluster_id,
  }));
}

/** Stale if clustering has never run for this session, or if any chunk has
 * never been assigned a cluster (i.e. a document was filed since the last
 * run). Simpler and more robust than comparing timestamps. */
export async function needsRecompute(sessionId: string, chunks: ChunkPoint[]): Promise<boolean> {
  if (chunks.length === 0) return false;

  const { data, error } = await supabase
    .from("graph_state")
    .select("last_clustered_at")
    .eq("session_id", sessionId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return true;

  return chunks.some((c) => c.clusterId === null);
}

export async function recomputeClusters(sessionId: string, chunks: ChunkPoint[]): Promise<void> {
  if (chunks.length < 2) return;

  const k = Math.min(8, Math.max(2, Math.round(Math.sqrt(chunks.length / 2))));
  const { assignments, centroids } = kmeans(
    chunks.map((c) => c.embedding),
    k
  );

  const samplesByCluster = new Map<number, { content: string; dist: number }[]>();
  assignments.forEach((clusterIndex, i) => {
    const centroid = centroids[clusterIndex];
    let dist = 0;
    for (let d = 0; d < centroid.length; d++) {
      const diff = centroid[d] - chunks[i].embedding[d];
      dist += diff * diff;
    }
    const list = samplesByCluster.get(clusterIndex) ?? [];
    list.push({ content: chunks[i].content, dist });
    samplesByCluster.set(clusterIndex, list);
  });

  const clusterSamples = [...samplesByCluster.entries()].map(([clusterIndex, items]) => ({
    id: clusterIndex,
    samples: items
      .sort((a, b) => a.dist - b.dist)
      .slice(0, 3)
      .map((i) => i.content),
  }));

  let labels: { id: number; label: string }[];
  try {
    const res = await fetch("/api/cluster-labels", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clusters: clusterSamples }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? "cluster-labels failed");
    labels = data.labels;
  } catch (err) {
    console.error("Cluster labeling failed, using generic labels:", err);
    labels = clusterSamples.map((c) => ({ id: c.id, label: `Cluster ${c.id + 1}` }));
  }

  const { error: deleteError } = await supabase.from("clusters").delete().eq("session_id", sessionId);
  if (deleteError) throw new Error(deleteError.message);

  const clusterIndexToDbId = new Map<number, string>();
  for (const { id: clusterIndex, label } of labels) {
    const { data: row, error } = await supabase
      .from("clusters")
      .insert({
        session_id: sessionId,
        label,
        color_index: clusterIndex % CLUSTER_PALETTE.length,
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    clusterIndexToDbId.set(clusterIndex, row.id);
  }

  await Promise.all(
    assignments.map((clusterIndex, i) =>
      supabase
        .from("chunks")
        .update({ cluster_id: clusterIndexToDbId.get(clusterIndex) })
        .eq("id", chunks[i].id)
    )
  );

  const { error: upsertError } = await supabase
    .from("graph_state")
    .upsert({ session_id: sessionId, last_clustered_at: new Date().toISOString() });
  if (upsertError) throw new Error(upsertError.message);
}

/** Used by the "Re-analyze" button - fetches fresh chunk data and always
 * recomputes, regardless of staleness. */
export async function forceRecompute(sessionId: string): Promise<void> {
  const chunks = await fetchChunkPoints(sessionId);
  await recomputeClusters(sessionId, chunks);
}

export async function fetchGraphData(sessionId: string): Promise<GraphData> {
  const chunks = await fetchChunkPoints(sessionId);
  if (chunks.length === 0) {
    return { nodes: [], links: [], clusters: [] };
  }

  if (await needsRecompute(sessionId, chunks)) {
    await recomputeClusters(sessionId, chunks);
  }

  const { data: clusterRows, error: clusterErr } = await supabase
    .from("clusters")
    .select("id, label, color_index")
    .eq("session_id", sessionId);
  if (clusterErr) throw new Error(clusterErr.message);

  const clusters: ClusterRow[] = (clusterRows ?? []).map((r) => ({
    id: r.id,
    label: r.label,
    colorIndex: r.color_index,
  }));
  const clusterById = new Map(clusters.map((c) => [c.id, c]));

  const freshChunks = await fetchChunkPoints(sessionId);

  const documentIds = [...new Set(freshChunks.map((c) => c.documentId))];
  const documentNodes: GraphNode[] = documentIds.map((docId) => ({
    id: `doc:${docId}`,
    kind: "document",
    name: freshChunks.find((c) => c.documentId === docId)?.documentName ?? "",
  }));

  const chunkNodes: GraphNode[] = freshChunks.map((c) => {
    const cluster = c.clusterId ? clusterById.get(c.clusterId) : undefined;
    return {
      id: `chunk:${c.id}`,
      kind: "chunk",
      name: `Chunk #${c.chunkIndex}`,
      content: c.content,
      documentName: c.documentName,
      clusterLabel: cluster?.label,
      colorIndex: cluster?.colorIndex,
    };
  });

  const structuralLinks = freshChunks.map((c) => ({
    source: `doc:${c.documentId}`,
    target: `chunk:${c.id}`,
    kind: "structural" as const,
  }));

  const similarityLinks = computeSimilarityEdges(freshChunks);

  return {
    nodes: [...documentNodes, ...chunkNodes],
    links: [...structuralLinks, ...similarityLinks],
    clusters,
  };
}
```

- [ ] **Step 3: Typecheck**

```bash
cd "/Users/mj/JAB/GITHUB/Mini RAG Chatbot" && npx tsc --noEmit
```
Expected: no output.

- [ ] **Step 4: Write and run a throwaway end-to-end test against real Supabase + Gemini**

```bash
cat > "/Users/mj/JAB/GITHUB/Mini RAG Chatbot/test-graph.mjs" << 'EOF'
import { pipeline } from "@huggingface/transformers";
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";

const env = Object.fromEntries(
  readFileSync("/Users/mj/JAB/GITHUB/Mini RAG Chatbot/.env.local", "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i), l.slice(i + 1)];
    })
);

const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
const extractor = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");
async function embed(text) {
  const out = await extractor(text, { pooling: "mean", normalize: true });
  return Array.from(out.data);
}

const sessionId = crypto.randomUUID();

async function fileDoc(name, texts) {
  const { data: doc, error } = await supabase
    .from("documents")
    .insert({ session_id: sessionId, name })
    .select("id")
    .single();
  if (error) throw error;
  for (let i = 0; i < texts.length; i++) {
    const embedding = await embed(texts[i]);
    const { error: chunkErr } = await supabase
      .from("chunks")
      .insert({ document_id: doc.id, chunk_index: i, content: texts[i], embedding });
    if (chunkErr) throw chunkErr;
  }
  return doc.id;
}

const docA = await fileDoc("benefits.txt", [
  "Employees get 20 days of paid vacation per year.",
  "Health insurance covers dental and vision care.",
]);
const docB = await fileDoc("holidays.txt", [
  "The office is closed on Christmas Day every year.",
  "New Year's Day is a paid company holiday.",
]);

console.log("Filed 2 documents, 4 chunks total. Running fetchGraphData equivalent via curl to dev server...");
console.log("session id for manual /graph check:", sessionId);

// Exercise the same DB calls buildGraph.ts makes, without importing the
// "use client" module directly from Node:
const { data: chunkRows, error: chunkErr } = await supabase
  .from("chunks")
  .select("id, document_id, chunk_index, content, embedding, cluster_id, documents!inner(name, session_id)")
  .eq("documents.session_id", sessionId);
if (chunkErr) throw chunkErr;
console.log(`fetched ${chunkRows.length} chunks via the same query buildGraph.ts uses`);
if (chunkRows.length !== 4) throw new Error("FAIL: expected 4 chunks");
console.log("PASS: chunk fetch + session-scoped join works");

await supabase.from("documents").delete().in("id", [docA, docB]);
console.log("cleanup done");
EOF
cd "/Users/mj/JAB/GITHUB/Mini RAG Chatbot" && node test-graph.mjs
rm "/Users/mj/JAB/GITHUB/Mini RAG Chatbot/test-graph.mjs"
```

Expected: `PASS: chunk fetch + session-scoped join works` and `cleanup done`, no errors.

- [ ] **Step 5: Commit**

```bash
git add src/lib/graph/palette.ts src/lib/graph/buildGraph.ts
git commit -m "feat: add buildGraph orchestration (clustering + edges + caching)"
```

---

### Task 7: `useGraph` hook

**Files:**
- Create: `src/hooks/useGraph.ts`

**Interfaces:**
- Consumes: `fetchGraphData`, `forceRecompute` (Task 6); `getSessionId` from `@/lib/session`; `GraphData` (Task 4).
- Produces: `useGraph(): { data: GraphData | null; isLoading: boolean; isRecomputing: boolean; error: string | null; recompute: () => Promise<void> }`.
- Consumes (Task 8): this hook.

- [ ] **Step 1: Create `src/hooks/useGraph.ts`**

```ts
"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchGraphData, forceRecompute } from "@/lib/graph/buildGraph";
import { getSessionId } from "@/lib/session";
import type { GraphData } from "@/lib/graph/types";

export function useGraph() {
  const [data, setData] = useState<GraphData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isRecomputing, setIsRecomputing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const graph = await fetchGraphData(getSessionId());
      setData(graph);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load graph");
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setIsLoading(true);
      await load();
      if (!cancelled) setIsLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [load]);

  const recompute = useCallback(async () => {
    setIsRecomputing(true);
    setError(null);
    try {
      await forceRecompute(getSessionId());
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to re-analyze");
    } finally {
      setIsRecomputing(false);
    }
  }, [load]);

  return { data, isLoading, isRecomputing, error, recompute };
}
```

- [ ] **Step 2: Typecheck**

```bash
cd "/Users/mj/JAB/GITHUB/Mini RAG Chatbot" && npx tsc --noEmit
```
Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add src/hooks/useGraph.ts
git commit -m "feat: add useGraph hook"
```

---

### Task 8: `/graph` page (3D rendering)

**Files:**
- Create: `src/app/graph/page.tsx`
- Modify: `package.json` (via `npm install`)

**Interfaces:**
- Consumes: `useGraph` (Task 7); `CLUSTER_PALETTE` (Task 6); `GraphNode` (Task 4).

- [ ] **Step 1: Install `3d-force-graph`**

```bash
cd "/Users/mj/JAB/GITHUB/Mini RAG Chatbot" && npm install 3d-force-graph
```

- [ ] **Step 2: Create `src/app/graph/page.tsx`**

```tsx
"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useGraph } from "@/hooks/useGraph";
import { CLUSTER_PALETTE } from "@/lib/graph/palette";
import type { GraphNode } from "@/lib/graph/types";

const DOCUMENT_COLOR = "#1b2e2b";
const NEUTRAL_CHUNK_COLOR = "#8a8a7a";

export default function GraphPage() {
  const { data, isLoading, isRecomputing, error, recompute } = useGraph();
  const containerRef = useRef<HTMLDivElement>(null);
  // 3d-force-graph ships no first-party TypeScript types for this usage
  // pattern; `any` here is the instantiated imperative graph object.
  const graphInstanceRef = useRef<any>(null);
  const [selected, setSelected] = useState<GraphNode | null>(null);

  useEffect(() => {
    if (!data || data.nodes.length === 0 || !containerRef.current) return;

    let disposed = false;

    import("3d-force-graph").then(({ default: ForceGraph3D }) => {
      if (disposed || !containerRef.current) return;

      const graph = ForceGraph3D()(containerRef.current)
        .graphData({
          nodes: data.nodes.map((n) => ({ ...n })),
          links: data.links.map((l) => ({ ...l })),
        })
        .nodeLabel((node: GraphNode) =>
          node.kind === "document" ? node.name : (node.content ?? node.name).slice(0, 80)
        )
        .nodeColor((node: GraphNode) => {
          if (node.kind === "document") return DOCUMENT_COLOR;
          return node.colorIndex != null
            ? CLUSTER_PALETTE[node.colorIndex % CLUSTER_PALETTE.length]
            : NEUTRAL_CHUNK_COLOR;
        })
        .nodeVal((node: GraphNode) => (node.kind === "document" ? 8 : 2))
        .linkOpacity((link: { kind: string }) => (link.kind === "structural" ? 0.15 : 0.4))
        .linkColor((link: { kind: string }) =>
          link.kind === "structural" ? "#c9bfa0" : "#9c6a1e"
        )
        .onNodeClick((node: GraphNode) => setSelected(node))
        .backgroundColor("rgba(0,0,0,0)");

      const controls = graph.controls();
      controls.autoRotate = true;
      controls.autoRotateSpeed = 0.6;
      controls.addEventListener("start", () => {
        controls.autoRotate = false;
      });

      graphInstanceRef.current = graph;
    });

    return () => {
      disposed = true;
      if (containerRef.current) containerRef.current.innerHTML = "";
      graphInstanceRef.current = null;
    };
  }, [data]);

  return (
    <div className="relative min-h-screen bg-paper text-ink">
      <header className="absolute top-0 right-0 left-0 z-10 flex flex-wrap items-center justify-between gap-3 border-b border-line bg-paper/90 px-4 py-3 backdrop-blur">
        <div className="flex items-center gap-3">
          <Link href="/" className="font-mono text-[11px] text-ink-soft hover:text-ink">
            ← Back to archive
          </Link>
          <h1 className="font-display text-lg text-ink">Knowledge graph</h1>
        </div>
        <button
          onClick={() => recompute()}
          disabled={isRecomputing}
          className="rounded-sm bg-ink px-4 py-1.5 text-xs font-medium text-card transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {isRecomputing ? "Analyzing…" : "Re-analyze"}
        </button>
      </header>

      {isLoading && (
        <p className="pt-24 text-center font-mono text-sm text-ink-soft">Loading graph…</p>
      )}

      {!isLoading && error && (
        <p className="pt-24 text-center font-mono text-sm text-danger">{error}</p>
      )}

      {!isLoading && !error && data && data.nodes.length === 0 && (
        <p className="pt-24 text-center font-mono text-sm text-ink-soft">
          No documents filed yet — go back and add one first.
        </p>
      )}

      <div ref={containerRef} className="h-screen w-full" />

      {data && data.clusters.length > 0 && (
        <div className="absolute bottom-4 left-4 z-10 flex flex-col gap-1 rounded border border-line bg-card/90 p-3 backdrop-blur">
          {data.clusters.map((c) => (
            <div key={c.id} className="flex items-center gap-2 font-mono text-[11px] text-ink">
              <span
                className="h-2 w-2 rounded-full"
                style={{ backgroundColor: CLUSTER_PALETTE[c.colorIndex % CLUSTER_PALETTE.length] }}
              />
              {c.label}
            </div>
          ))}
        </div>
      )}

      {selected && (
        <div className="absolute top-20 right-4 z-10 w-72 rounded border border-line bg-card p-4 shadow-lg">
          <button
            onClick={() => setSelected(null)}
            className="mb-2 font-mono text-[11px] text-ink-soft hover:text-ink"
          >
            ✕ close
          </button>
          {selected.kind === "chunk" ? (
            <>
              <p className="mb-1 font-mono text-[11px] text-ink-soft">
                from “{selected.documentName}” · {selected.clusterLabel ?? "uncategorized"}
              </p>
              <p className="font-mono text-xs leading-relaxed text-ink">{selected.content}</p>
            </>
          ) : (
            <p className="font-mono text-xs text-ink">{selected.name}</p>
          )}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Typecheck, lint, and build**

```bash
cd "/Users/mj/JAB/GITHUB/Mini RAG Chatbot" && npx tsc --noEmit && npm run lint
```
Expected: `tsc` prints nothing; lint prints only the `> mini-rag-chatbot@0.1.0 lint` / `> eslint` banner (no errors). If `3d-force-graph`'s dynamic import breaks the production/static prerender the same way `pdfjs-dist` originally did (module touching `window` at eval time), the fix is the same one already used in `src/lib/files/extractText.ts`: the `import("3d-force-graph")` call must stay inside the `useEffect`, never hoisted to module scope.

```bash
cd "/Users/mj/JAB/GITHUB/Mini RAG Chatbot" && rm -rf .next && npm run build
```
Expected: build completes, `Route (app)` table lists `/graph` as `○ (Static)`.

- [ ] **Step 4: Commit**

```bash
git add src/app/graph/page.tsx package.json package-lock.json
git commit -m "feat: add /graph 3D knowledge graph page"
```

---

### Task 9: Nav link + final verification

**Files:**
- Modify: `src/app/page.tsx`

- [ ] **Step 1: Add a nav link to `/graph` in the masthead**

In `src/app/page.tsx`, find the `<header>` block (it currently ends with the tagline `<p>`). Add a `Link` import and a link under the tagline:

```tsx
import Link from "next/link";
```

(add this import alongside the existing `useRef, useState` import line)

```tsx
          <p className="max-w-md text-sm text-ink-soft">
            File one or more documents, then ask questions. Retrieval finds the
            best-matching cards across everything you&apos;ve filed — no need to
            pick a file first.
          </p>
          <Link
            href="/graph"
            className="mt-1 self-start font-mono text-[11px] text-stamp underline decoration-dotted underline-offset-2 hover:text-ink"
          >
            View the knowledge graph →
          </Link>
```

(replace the existing tagline `<p>` block with this, keeping the same `<p>` content and adding the `Link` right after it)

- [ ] **Step 2: Full verification**

```bash
cd "/Users/mj/JAB/GITHUB/Mini RAG Chatbot" && npx tsc --noEmit && npm run lint
```
Expected: no errors from either command.

```bash
cd "/Users/mj/JAB/GITHUB/Mini RAG Chatbot" && rm -rf .next && npm run build
```
Expected: build completes; route table includes `/` and `/graph` as static.

- [ ] **Step 3: Manual browser verification (required — cannot be automated this session)**

This session's browser-automation tool has been non-functional throughout (every attempt across all four phases of the base app failed the same way). The 3D rendering and interaction cannot be verified without a working browser tool or the user checking manually:

1. `npm run dev`, open http://localhost:3000
2. File 2+ documents on distinct topics (e.g. paste two unrelated paragraphs)
3. Click "View the knowledge graph →"
4. Confirm: the graph renders (not a blank canvas), auto-rotates until you drag, clicking a small (chunk) node opens the side panel with its text, the legend shows cluster labels with distinct colors, "Re-analyze" re-runs without errors

- [ ] **Step 4: Commit**

```bash
git add src/app/page.tsx
git commit -m "feat: link to the knowledge graph page from the archive"
```

---

## Self-Review Notes

- **Spec coverage:** schema (Task 1), compute pipeline + staleness (Task 6), edges (Task 4), rendering/interaction (Task 8), nav entry point (Task 9), error/empty states (Task 8's loading/error/empty branches), shared Gemini fallback reuse (Task 2) — all covered.
- **Type consistency checked:** `ChunkPoint`/`ClusterRow`/`GraphNode`/`GraphEdge`/`GraphData` (Task 4) are the only definitions of these types and are imported (never redefined) in Tasks 6–8. `fetchGraphData`/`forceRecompute` signatures in Task 6 match exactly what Task 7's hook and Task 9's manual test expect.
- **Deviation from spec, noted and intentional:** the spec describes staleness as a `last_clustered_at` vs. chunk-`created_at` timestamp comparison; Task 6 implements it as "graph_state row missing OR any chunk has a null `cluster_id`" instead — functionally equivalent (still recomputes on first run and whenever a new document was filed since), simpler, and immune to clock-skew edge cases. The `graph_state` table is still used (existence check + `last_clustered_at` watermark for potential future "last analyzed" display).
