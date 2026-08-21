# Mini RAG Chatbot

A chatbot that answers questions using only the content of documents you
upload — a from-scratch implementation of Retrieval-Augmented Generation
(RAG), built to learn the mechanics rather than hide them behind a
framework. No LangChain, no managed vector-search product: chunking,
embedding, and cosine-similarity retrieval are all plain code you can read
in `src/lib/rag/`.

Live demo: https://mini-rag-chatbot-liart.vercel.app

## How RAG works here

```
 upload (PDF or text)
        │
        ▼
   chunk the text            src/lib/rag/chunk.ts
   (400 words, 60 overlap)
        │
        ▼
   embed each chunk          src/lib/rag/embeddings.ts
   (all-MiniLM-L6-v2,        (Transformers.js, runs in the browser)
    384-dim vector)
        │
        ▼
   store in Postgres         supabase/schema.sql
   (chunk text + vector,     (Supabase + pgvector)
    tagged to a document)


 ── ask a question ──

   embed the question        same model, same vector space
        │
        ▼
   cosine-similarity search  match_chunks() SQL function
   over that document's      (pgvector's <=> operator)
   chunks → top 3 matches
        │
        ▼
   send question + those     src/app/api/chat/route.ts
   3 chunks to the LLM,      (Gemini, streamed token by token)
   answer using ONLY them
```

**Embeddings** turn text into a vector (an array of numbers) that
represents its meaning — two chunks that mean similar things end up with
vectors pointing in a similar direction, even with no words in common.

**Cosine similarity** measures the angle between two vectors: 1 means
"point the same direction" (same meaning), 0 means unrelated. It's what
decides which chunks are "relevant" to a question.

**Augmented generation**: the LLM never sees your whole document, and it's
told to answer *only* from the 3 chunks retrieval found — that's what keeps
answers grounded in your file instead of the model's general training data.

## Stack

| Concern | Choice | Why |
|---|---|---|
| Frontend | Next.js App Router + TypeScript + Tailwind | |
| Embeddings | Transformers.js (`all-MiniLM-L6-v2`) | Runs client-side, no embedding API/cost |
| LLM | Gemini (`gemini-3.6-flash`) via `@google/genai` | Free tier, streaming support |
| Vector storage | Supabase Postgres + `pgvector` | Free tier, SQL-native similarity search |
| PDF parsing | pdf.js | Runs client-side |
| Deploy | Vercel | Free tier |

## Running locally

```bash
npm install
cp .env.local.example .env.local   # fill in the values below
npm run dev
```

Open http://localhost:3000.

### Environment variables (`.env.local`)

| Variable | Where to get it |
|---|---|
| `GEMINI_API_KEY` | [aistudio.google.com](https://aistudio.google.com) → "Get API key" (free, no card) |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project → Settings → Data API |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase project → Settings → Data API |

### Database setup

Run `supabase/schema.sql` once in the Supabase SQL Editor. It:
- enables the `pgvector` extension
- creates `documents` and `chunks` tables (384-dim embeddings, matching `all-MiniLM-L6-v2`)
- creates `match_chunks()`, the RPC used for retrieval
- sets permissive Row Level Security policies scoped only by a client-generated
  session id (`src/lib/session.ts`) — there's no login system in this project,
  so **don't upload sensitive documents**; this is a portfolio/learning project,
  not a document store with real access control.

## Deploying

```bash
vercel link
vercel env add GEMINI_API_KEY production preview development
vercel env add NEXT_PUBLIC_SUPABASE_URL production preview development
vercel env add NEXT_PUBLIC_SUPABASE_ANON_KEY production preview development
vercel --prod
```

## Project structure

```
src/
  lib/rag/chunk.ts          word-based chunking with overlap
  lib/rag/embeddings.ts     Transformers.js embedding (browser-side)
  lib/rag/types.ts          shared RAG types
  lib/pdf/extractText.ts    client-side PDF → text (pdf.js)
  lib/supabase/client.ts    Supabase browser client
  lib/session.ts            per-browser session id (localStorage)
  hooks/useDocuments.ts     upload/index/ask flow — the RAG pipeline glue
  app/api/chat/route.ts     calls Gemini, streams the answer back
  app/page.tsx              UI
supabase/schema.sql         tables, pgvector, match_chunks() RPC
```
