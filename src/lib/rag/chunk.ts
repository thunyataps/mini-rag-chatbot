/**
 * RAG concept: chunking.
 *
 * LLMs (and the embedding model) can't usefully digest a whole document at
 * once, and we don't want to hand the LLM more text than the actual answer
 * needs. So we split the document into smaller "chunks" first, embed each
 * chunk separately, and later retrieve only the few chunks that are most
 * relevant to a given question.
 *
 * We chunk by word count (not characters) because word count roughly tracks
 * token count, which is what both the embedding model and the LLM actually
 * care about. Chunks overlap a little so a sentence that happens to fall
 * right on a chunk boundary doesn't get cut in half and lose its context.
 */

export interface TextChunk {
  id: number;
  text: string;
}

const DEFAULT_CHUNK_SIZE = 400; // words per chunk (within the 300-500 target range)
const DEFAULT_OVERLAP = 60; // words shared between consecutive chunks

export function chunkText(
  text: string,
  chunkSize: number = DEFAULT_CHUNK_SIZE,
  overlap: number = DEFAULT_OVERLAP
): TextChunk[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];

  const chunks: TextChunk[] = [];
  let start = 0;
  let id = 0;

  while (start < words.length) {
    const end = Math.min(start + chunkSize, words.length);
    chunks.push({ id: id++, text: words.slice(start, end).join(" ") });
    if (end === words.length) break;
    start = end - overlap; // step back so the next chunk overlaps this one
  }

  return chunks;
}
