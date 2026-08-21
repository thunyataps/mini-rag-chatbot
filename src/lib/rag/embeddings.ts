/**
 * RAG concept: embeddings.
 *
 * An embedding turns a piece of text into a vector (an array of numbers)
 * that represents its *meaning*. Two chunks of text that mean similar
 * things end up with vectors that point in a similar direction, even if
 * they don't share any of the same words.
 *
 * We use Transformers.js to run a small embedding model (all-MiniLM-L6-v2)
 * entirely in the browser via WebAssembly/WebGPU - no separate embedding
 * API, no server round-trip, and it's free.
 */

"use client";

import { pipeline, env } from "@huggingface/transformers";

// Never try to read models from a local filesystem path - always fetch
// from the Hugging Face Hub CDN (and let the browser cache the download).
env.allowLocalModels = false;

// Without cross-origin-isolation headers, SharedArrayBuffer isn't
// available, so multi-threaded WASM can throw. Force a single thread to
// keep this working with zero extra server config.
if (env.backends?.onnx?.wasm) {
  env.backends.onnx.wasm.numThreads = 1;
}

const MODEL_ID = "Xenova/all-MiniLM-L6-v2";

type Extractor = (
  text: string,
  options: { pooling: "mean"; normalize: boolean }
) => Promise<{ data: Float32Array | Float64Array }>;

let extractorPromise: Promise<Extractor> | null = null;

function getExtractor(): Promise<Extractor> {
  if (!extractorPromise) {
    extractorPromise = pipeline("feature-extraction", MODEL_ID) as unknown as Promise<Extractor>;
  }
  return extractorPromise;
}

/** Embed a single piece of text (e.g. the user's question). */
export async function embedText(text: string): Promise<number[]> {
  const extractor = await getExtractor();
  const output = await extractor(text, { pooling: "mean", normalize: true });
  return Array.from(output.data);
}

/**
 * Embed many chunks in sequence, reporting progress as we go (useful for a
 * loading indicator while a whole document is being indexed).
 */
export async function embedTexts(
  texts: string[],
  onProgress?: (done: number, total: number) => void
): Promise<number[][]> {
  const extractor = await getExtractor();
  const results: number[][] = [];

  for (let i = 0; i < texts.length; i++) {
    const output = await extractor(texts[i], { pooling: "mean", normalize: true });
    results.push(Array.from(output.data));
    onProgress?.(i + 1, texts.length);
  }

  return results;
}
