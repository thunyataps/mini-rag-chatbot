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
