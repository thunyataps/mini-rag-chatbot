export interface ChunkPoint {
  id: number;
  documentId: string;
  documentName: string;
  chunkIndex: number;
  content: string;
  embedding: number[];
  clusterId: string | null;
  /**
   * False for "legacy" chunks - those whose parent document predates login
   * (`documents.user_id is null`) and so is readable by every signed-in user
   * but writable by none. The chunks UPDATE policy requires
   * `documents.user_id = auth.uid()`, so a `cluster_id` write against a
   * legacy chunk silently matches 0 rows. Clustering therefore skips them
   * entirely; they still render as graph nodes, just uncategorized.
   */
  isOwned: boolean;
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
