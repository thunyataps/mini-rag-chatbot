"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { useDocuments } from "@/hooks/useDocuments";
import { useAuth } from "@/hooks/useAuth";
import { ACCEPTED_FILE_TYPES, extractText } from "@/lib/files/extractText";
import type { RetrievedChunk } from "@/lib/rag/types";

const MAX_FILE_BYTES = 15 * 1024 * 1024; // 15 MB

export default function Home() {
  const router = useRouter();
  const { user, signOut } = useAuth();
  const {
    documents,
    searchScope,
    setSearchScope,
    isLoadingDocuments,
    isUploading,
    uploadProgress,
    isAsking,
    uploadDocument,
    askQuestion,
  } = useDocuments();

  const [docText, setDocText] = useState("");
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<string | null>(null);
  const [sources, setSources] = useState<RetrievedChunk[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isParsingFile, setIsParsingFile] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function handleIndexText() {
    setError(null);
    setAnswer(null);
    try {
      await uploadDocument(`Pasted text — ${new Date().toLocaleString()}`, docText);
      setDocText("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't file that document");
    }
  }

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = ""; // allow re-selecting the same file later

    setError(null);
    setAnswer(null);

    if (file.size > MAX_FILE_BYTES) {
      setError("This file is over 15MB — try a shorter document.");
      return;
    }

    setIsParsingFile(true);
    try {
      const text = await extractText(file);
      if (!text.trim()) {
        throw new Error("No readable text in this file — it looks empty.");
      }
      await uploadDocument(file.name, text);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't read that file");
    } finally {
      setIsParsingFile(false);
    }
  }

  /** Navigating away (rather than just clearing the session) is what drops
   * the previous user's documents/graph from React state - otherwise their
   * data stays on screen until the next full page load. */
  async function handleSignOut() {
    await signOut();
    router.push("/login");
    router.refresh();
  }

  async function handleAsk() {
    setError(null);
    setSources([]);
    setAnswer(""); // shows the answer card immediately, filled in as tokens stream
    try {
      await askQuestion(question, {
        onSources: setSources,
        onToken: (token) => setAnswer((prev) => (prev ?? "") + token),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't get an answer");
      setAnswer(null);
    }
  }

  const isIndexed = documents.length > 0;
  const isBusy = isUploading || isParsingFile;

  return (
    <div className="min-h-screen px-4 py-10 sm:py-14">
      <main className="mx-auto flex w-full max-w-2xl flex-col gap-10">
        {/* ---------- masthead ---------- */}
        <header className="animate-rise-in flex flex-col gap-2 border-b border-line pb-6">
          <span className="font-mono text-[11px] tracking-[0.2em] text-ink-soft uppercase">
            Archive · Document Q&amp;A
          </span>
          <h1 className="font-display text-3xl leading-tight text-ink sm:text-4xl">
            Mini RAG Chatbot
          </h1>
          <p className="max-w-md text-sm text-ink-soft">
            File one or more documents, then ask questions. Retrieval finds the
            best-matching cards across everything you&apos;ve filed — no need to
            pick a file first.
          </p>
          <div className="mt-1 flex items-center justify-between gap-2">
            <Link
              href="/graph"
              className="font-mono text-[11px] text-stamp underline decoration-dotted underline-offset-2 hover:text-ink"
            >
              View the knowledge graph →
            </Link>
            <div className="flex items-center gap-2 font-mono text-[11px] text-ink-soft">
              {user?.email}
              <button onClick={handleSignOut} className="underline decoration-dotted underline-offset-2 hover:text-ink">
                Sign out
              </button>
            </div>
          </div>
        </header>

        {/* ---------- 1. intake tray ---------- */}
        <section
          className="animate-rise-in flex flex-col gap-3"
          style={{ animationDelay: "60ms" }}
        >
          <SectionLabel>File a document</SectionLabel>

          <label
            htmlFor="file-input"
            className={`flex cursor-pointer flex-col items-center justify-center gap-1 rounded border-2 border-dashed border-line bg-card px-4 py-6 text-center transition-colors hover:border-stamp ${
              isBusy ? "pointer-events-none opacity-50" : ""
            }`}
          >
            <span className="text-sm font-medium text-ink">
              Drop a file here, or click to choose one
            </span>
            <span className="text-xs text-ink-soft">PDF, Excel, CSV, or text — up to 15MB</span>
            <input
              ref={fileInputRef}
              id="file-input"
              type="file"
              accept={ACCEPTED_FILE_TYPES}
              onChange={handleFileChange}
              disabled={isBusy}
              className="sr-only"
            />
          </label>

          <div className="flex items-center gap-3 font-mono text-[11px] text-ink-soft">
            <div className="h-px flex-1 bg-line" />
            or paste text
            <div className="h-px flex-1 bg-line" />
          </div>

          <textarea
            value={docText}
            onChange={(e) => setDocText(e.target.value)}
            placeholder="Paste any text here..."
            rows={5}
            disabled={isBusy}
            className="w-full resize-y rounded border border-line bg-card p-3 text-sm text-ink outline-none placeholder:text-ink-soft focus:border-stamp disabled:opacity-50"
          />
          <button
            onClick={handleIndexText}
            disabled={!docText.trim() || isBusy}
            className="self-start rounded-sm bg-ink px-5 py-2 text-sm font-medium text-card transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Add to archive
          </button>

          {isParsingFile && <StatusLine>Reading file…</StatusLine>}
          {isUploading && (
            <StatusLine>
              Embedding &amp; filing… ({uploadProgress.done}/{uploadProgress.total} cards)
            </StatusLine>
          )}
        </section>

        {/* ---------- 2. folder tabs ---------- */}
        {!isLoadingDocuments && documents.length > 0 && (
          <section
            className="animate-rise-in flex flex-col gap-2"
            style={{ animationDelay: "120ms" }}
          >
            <SectionLabel>Search scope</SectionLabel>
            <div className="flex flex-wrap gap-2">
              <FolderTab
                label={`All files (${documents.length})`}
                active={searchScope === "all"}
                onClick={() => setSearchScope("all")}
              />
              {documents.map((doc) => (
                <FolderTab
                  key={doc.id}
                  label={doc.name}
                  active={searchScope === doc.id}
                  onClick={() => setSearchScope(doc.id)}
                />
              ))}
            </div>
            <div className="h-px bg-line" />
            <p className="font-mono text-[11px] text-ink-soft">
              {searchScope === "all"
                ? "Retrieval pulls the best-matching cards from any filed document."
                : "Retrieval is scoped to this one document."}
            </p>
          </section>
        )}

        {/* ---------- 3. request slip ---------- */}
        <section
          className="animate-rise-in flex flex-col gap-3"
          style={{ animationDelay: "180ms" }}
        >
          <SectionLabel>Ask the archive</SectionLabel>
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && !isAsking && isIndexed && handleAsk()}
              placeholder={
                isIndexed ? "What do your files say about...?" : "File a document first"
              }
              disabled={!isIndexed}
              className="flex-1 rounded border border-line bg-card p-3 text-sm text-ink outline-none placeholder:text-ink-soft focus:border-stamp disabled:opacity-50"
            />
            <button
              onClick={handleAsk}
              disabled={!isIndexed || !question.trim() || isAsking}
              className="rounded-sm bg-ink px-5 py-2.5 text-sm font-medium text-card transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {isAsking ? "Asking…" : "Ask"}
            </button>
          </div>
        </section>

        {error && (
          <p className="animate-rise-in rounded border border-danger/30 bg-danger-bg px-4 py-3 text-sm text-danger">
            {error}
          </p>
        )}

        {/* ---------- 4. case file (answer) + pulled cards (sources) ---------- */}
        {answer !== null && (
          <section className="animate-rise-in flex flex-col gap-4">
            <div>
              <SectionLabel>Case file</SectionLabel>
              <p className="mt-2 whitespace-pre-wrap rounded border border-line bg-card p-4 text-sm leading-relaxed text-ink">
                {answer}
                {isAsking && <span className="animate-pulse">▍</span>}
              </p>
            </div>

            {sources.length > 0 && (
              <div>
                <SectionLabel>Pulled cards ({sources.length})</SectionLabel>
                <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2">
                  {sources.map((s, i) => (
                    <IndexCard key={`${s.documentId}-${s.chunkIndex}`} chunk={s} delayMs={i * 80} />
                  ))}
                </div>
              </div>
            )}
          </section>
        )}
      </main>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="font-mono text-[11px] tracking-[0.15em] text-ink-soft uppercase">
      {children}
    </h2>
  );
}

function StatusLine({ children }: { children: React.ReactNode }) {
  return <p className="font-mono text-xs text-ink-soft">{children}</p>;
}

function FolderTab({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      title={label}
      className={`max-w-[14rem] truncate rounded-t border border-b-0 px-3 py-1.5 text-xs transition-colors ${
        active
          ? "border-line bg-card font-medium text-ink"
          : "border-transparent text-ink-soft hover:text-ink"
      }`}
    >
      {label}
    </button>
  );
}

function IndexCard({ chunk, delayMs }: { chunk: RetrievedChunk; delayMs: number }) {
  const pct = Math.round(chunk.similarity * 100);
  return (
    <div
      className="animate-rise-in relative rounded border border-line bg-card p-4 pt-6"
      style={{ animationDelay: `${delayMs}ms` }}
    >
      <span className="card-punch" aria-hidden="true" />
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="font-mono text-[11px] text-ink-soft">
          CARD #{String(chunk.chunkIndex).padStart(2, "0")}
        </span>
        <span className="-rotate-6 rounded-sm border border-stamp px-1.5 py-0.5 font-mono text-[10px] font-medium text-stamp">
          {pct}% MATCH
        </span>
      </div>
      <p className="mb-2 truncate font-mono text-[11px] text-ink-soft" title={chunk.documentName}>
        from “{chunk.documentName}”
      </p>
      <p className="line-clamp-4 font-mono text-xs leading-relaxed text-ink">
        {chunk.content}
      </p>
    </div>
  );
}
