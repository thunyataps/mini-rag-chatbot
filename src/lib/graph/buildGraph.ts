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
  // PostgREST serializes pgvector `vector` columns as their text form
  // (e.g. "[0.1,-0.2,...]"), so supabase-js hands this back as a JSON
  // string, not a parsed array - see the parse in fetchChunkPoints.
  embedding: number[] | string;
  cluster_id: string | null;
  documents: { name: string; session_id: string };
};

/** all-MiniLM-L6-v2 (see src/lib/rag/embeddings.ts) is always 384-dimensional. */
const EMBEDDING_DIMENSIONS = 384;

export async function fetchChunkPoints(sessionId: string): Promise<ChunkPoint[]> {
  const { data, error } = await supabase
    .from("chunks")
    .select(
      "id, document_id, chunk_index, content, embedding, cluster_id, documents!inner(name, session_id)"
    )
    .eq("documents.session_id", sessionId);
  if (error) throw new Error(error.message);

  return ((data ?? []) as unknown as ChunkWithDocumentRow[]).map((row) => {
    const embedding =
      typeof row.embedding === "string" ? (JSON.parse(row.embedding) as number[]) : row.embedding;
    // Cheap invariant: a malformed/unparsed embedding would otherwise poison
    // every downstream distance calculation with NaN, silently (no throw) -
    // producing zero similarity edges and a single k-means cluster.
    if (!Array.isArray(embedding) || embedding.length !== EMBEDDING_DIMENSIONS) {
      throw new Error(
        `Expected ${EMBEDDING_DIMENSIONS}-dim embedding, got ${
          Array.isArray(embedding) ? embedding.length : typeof embedding
        }`
      );
    }
    return {
      id: row.id,
      documentId: row.document_id,
      documentName: row.documents.name,
      chunkIndex: row.chunk_index,
      content: row.content,
      embedding,
      clusterId: row.cluster_id,
    };
  });
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
    // Reconcile the model's answer against the clusters we actually computed:
    // a missing/malformed `labels`, a label for a hallucinated cluster id, or
    // a cluster the model skipped must never reach the inserts below (and a
    // malformed response must not throw outside this try - labeling failure
    // may never block the graph from rendering).
    const returned: { id: number; label: string }[] = Array.isArray(data.labels)
      ? data.labels
      : [];
    const labelById = new Map(returned.map((l) => [l.id, l.label]));
    labels = clusterSamples.map((c) => ({
      id: c.id,
      label: labelById.get(c.id) ?? `Cluster ${c.id + 1}`,
    }));
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

  const updateResults = await Promise.all(
    assignments.map((clusterIndex, i) =>
      supabase
        .from("chunks")
        .update({ cluster_id: clusterIndexToDbId.get(clusterIndex) })
        .eq("id", chunks[i].id)
    )
  );
  const updateError = updateResults.find((r) => r.error)?.error;
  if (updateError) throw new Error(updateError.message);

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

  // Only re-read the chunks when a recompute actually rewrote their
  // cluster_id values - on the (common) cache-hit path the already-fetched
  // rows are current, and embeddings are a few KB each as text.
  let freshChunks = chunks;
  if (await needsRecompute(sessionId, chunks)) {
    await recomputeClusters(sessionId, chunks);
    freshChunks = await fetchChunkPoints(sessionId);
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
