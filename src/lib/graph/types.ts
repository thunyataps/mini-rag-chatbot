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
