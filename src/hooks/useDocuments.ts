"use client";

import { useCallback, useEffect, useState } from "react";
import { chunkText } from "@/lib/rag/chunk";
import { embedText, embedTexts } from "@/lib/rag/embeddings";
import { supabase } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import type { DocumentRecord, RetrievedChunk } from "@/lib/rag/types";

const TOP_K = 3;

// Embedding still runs on the main thread (see embeddings.ts), just no
// longer freezing it solid - so this cap is about bounding worst-case
// wait time (~150ms/chunk => ~5 min at the cap), not about avoiding a
// freeze. Raise it further if legitimate documents keep hitting it.
const MAX_CHUNKS = 2000;

/** "all" searches across every filed document; a document id scopes to just that one. */
export type SearchScope = "all" | string;

interface AskResult {
  answer: string;
  sources: RetrievedChunk[];
}

type MatchChunksRow = {
  id: number;
  content: string;
  chunk_index: number;
  similarity: number;
};

type MatchChunksForCallerRow = MatchChunksRow & {
  document_id: string;
  document_name: string;
};

/**
 * Documents are chunked + embedded in the browser and persisted to Supabase
 * (Postgres + pgvector). Retrieval runs as a Postgres RPC (see
 * supabase/schema.sql) that does the same cosine-distance math you'd write
 * by hand in JS, just as a SQL query - which is what lets it scale past
 * memory and survive a refresh.
 *
 * By default retrieval searches across every document the caller can see
 * (match_chunks_for_caller) rather than one you have to pick first -
 * whichever file (or files) actually contain the relevant chunks wins,
 * so an answer can draw on more than one document at once. Scoping to a
 * single file (match_chunks) is available as a filter, not a requirement.
 */
export function useDocuments() {
  const { user } = useAuth();
  // Depend on the id, not the User object: Supabase hands back a fresh
  // object on every token refresh / tab-focus re-emit, which would otherwise
  // re-run the fetch effect and rebuild uploadDocument for no reason.
  const userId = user?.id;
  const [documents, setDocuments] = useState<DocumentRecord[]>([]);
  const [searchScope, setSearchScope] = useState<SearchScope>("all");
  const [isLoadingDocuments, setIsLoadingDocuments] = useState(true);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState({ done: 0, total: 0 });
  const [isAsking, setIsAsking] = useState(false);

  const refreshDocuments = useCallback(async () => {
    const { data, error } = await supabase
      .from("documents")
      .select("id, name, created_at")
      .order("created_at", { ascending: false });

    if (error) throw new Error(error.message);

    const docs: DocumentRecord[] = (data ?? []).map((row) => ({
      id: row.id,
      name: row.name,
      createdAt: row.created_at,
    }));
    setDocuments(docs);
    return docs;
  }, []);

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;

    async function load() {
      try {
        await refreshDocuments();
      } finally {
        if (!cancelled) setIsLoadingDocuments(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [refreshDocuments, userId]);

  const uploadDocument = useCallback(
    async (name: string, text: string) => {
      // Reachable if the session drops while the tab is open - without this
      // the user!.id below throws a raw TypeError straight into the UI.
      if (!userId) throw new Error("You're signed out — please sign in again.");

      const rawChunks = chunkText(text);
      if (rawChunks.length === 0) {
        throw new Error("Document is empty");
      }
      if (rawChunks.length > MAX_CHUNKS) {
        throw new Error(
          `This document is too large to index (${rawChunks.length} chunks, limit ${MAX_CHUNKS}) — try a shorter file or split it up.`
        );
      }

      setIsUploading(true);
      setUploadProgress({ done: 0, total: rawChunks.length });
      try {
        const { data: doc, error: docError } = await supabase
          .from("documents")
          .insert({ user_id: userId, name })
          .select("id, name, created_at")
          .single();
        if (docError) throw new Error(docError.message);

        const embeddings = await embedTexts(
          rawChunks.map((c) => c.text),
          (done, total) => setUploadProgress({ done, total })
        );

        const rows = rawChunks.map((chunk, i) => ({
          document_id: doc.id,
          chunk_index: chunk.id,
          content: chunk.text,
          embedding: embeddings[i],
        }));

        const { error: chunksError } = await supabase.from("chunks").insert(rows);
        if (chunksError) throw new Error(chunksError.message);

        await refreshDocuments();
      } finally {
        setIsUploading(false);
      }
    },
    [refreshDocuments, userId]
  );

  const askQuestion = useCallback(
    async (
      question: string,
      callbacks?: {
        onSources?: (sources: RetrievedChunk[]) => void;
        onToken?: (token: string) => void;
      }
    ): Promise<AskResult> => {
      if (documents.length === 0) {
        throw new Error("No documents filed yet");
      }

      setIsAsking(true);
      try {
        const queryEmbedding = await embedText(question);

        let sources: RetrievedChunk[];
        if (searchScope === "all") {
          const { data, error } = await supabase.rpc("match_chunks_for_caller", {
            query_embedding: queryEmbedding,
            match_count: TOP_K,
          });
          if (error) throw new Error(error.message);

          sources = ((data ?? []) as MatchChunksForCallerRow[]).map((row) => ({
            content: row.content,
            chunkIndex: row.chunk_index,
            similarity: row.similarity,
            documentId: row.document_id,
            documentName: row.document_name,
          }));
        } else {
          const { data, error } = await supabase.rpc("match_chunks", {
            query_embedding: queryEmbedding,
            match_document_id: searchScope,
            match_count: TOP_K,
          });
          if (error) throw new Error(error.message);

          const scopedDoc = documents.find((d) => d.id === searchScope);
          sources = ((data ?? []) as MatchChunksRow[]).map((row) => ({
            content: row.content,
            chunkIndex: row.chunk_index,
            similarity: row.similarity,
            documentId: searchScope,
            documentName: scopedDoc?.name ?? "",
          }));
        }
        callbacks?.onSources?.(sources);

        if (sources.length === 0) {
          throw new Error("No indexed content found to search");
        }

        const context = sources
          .map((s, i) => `[${i + 1}] (from "${s.documentName}") ${s.content}`)
          .join("\n\n");

        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ question, context }),
        });

        if (!res.ok) {
          const responseData = await res.json();
          throw new Error(responseData.error ?? "Request to /api/chat failed");
        }
        if (!res.body) {
          throw new Error("No response body from /api/chat");
        }

        // RAG concept: streaming generation. The LLM writes its answer one
        // token at a time; instead of waiting for the whole thing, we read
        // the response body incrementally and hand each piece to the caller
        // as it arrives, so the UI can render it immediately (ChatGPT-style).
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let answer = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const token = decoder.decode(value, { stream: true });
          answer += token;
          callbacks?.onToken?.(token);
        }

        return { answer, sources };
      } finally {
        setIsAsking(false);
      }
    },
    [documents, searchScope]
  );

  return {
    documents,
    searchScope,
    setSearchScope,
    isLoadingDocuments,
    isUploading,
    uploadProgress,
    isAsking,
    uploadDocument,
    askQuestion,
  };
}
