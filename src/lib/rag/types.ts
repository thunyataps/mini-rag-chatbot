export interface DocumentRecord {
  id: string;
  name: string;
  createdAt: string;
}

export interface RetrievedChunk {
  content: string;
  chunkIndex: number;
  similarity: number;
  documentId: string;
  documentName: string;
}
