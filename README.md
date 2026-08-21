# Mini RAG Chatbot

A chatbot that answers questions using only the content of documents you
upload — a from-scratch implementation of Retrieval-Augmented Generation
(RAG), built to learn the mechanics rather than hide them behind a
framework. No LangChain, no managed vector-search product: chunking,
embedding, clustering, and similarity retrieval are all plain code you can
read in `src/lib/`.

Live demo: https://mini-rag-chatbot-liart.vercel.app

## What it does

- **Sign in** with email + password or Google (Supabase Auth). Everything
  you file is scoped to your account by Postgres Row Level Security.
- Upload **PDF, Excel (.xlsx/.xls), CSV, or plain text (.txt/.md)** — all
  parsed client-side, nothing uploaded raw to a server.
- Ask questions and get **streamed** answers grounded only in what you
  filed — the model is told to say "I don't know" rather than guess.
- Retrieval searches **across every document you've filed by default** —
  no need to pick a file first; an answer can draw on more than one
  document at once. Scoping to a single file is available as a filter.
- A **3D knowledge graph** (`/graph`) visualizes how your filed documents
  and their chunks relate: chunks are auto-clustered into topics (labeled
  by one batched Gemini call, not one per cluster) and cross-document
  similarity links show which files talk about the same thing.

## Accounts and access

Login is required — every page except `/login` and `/auth/callback` is
gated by `src/proxy.ts`, and both API routes reject unauthenticated
requests themselves. Two ways in, both through Supabase Auth:

- **Email + password** (email confirmation link → `/auth/callback`)
- **Google OAuth** (also lands on `/auth/callback`)

Access control is enforced in the database, not in the client: RLS policies
on `documents` and `chunks` compare `auth.uid()` to `documents.user_id`, so
one user's documents are invisible to another no matter what the browser
asks for.

**One caveat, stated plainly:** documents filed *before* this login system
existed have `user_id is null` ("legacy" documents). They are readable by
**every signed-in user**, and writable by none — they can't be edited,
deleted, or clustered. Sign-up is self-serve, so anyone who creates an
account on this deployment can read those pre-existing documents. This is
an intentional, accepted tradeoff for a portfolio project (it keeps the
pre-auth demo content visible rather than orphaning it); nothing filed
since auth landed is ever shared this way. If you're deploying your own
copy, either start with an empty database or delete the legacy rows.

## How RAG works here

```
 upload (PDF / Excel / CSV / text)
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
   cosine-similarity search  match_chunks_for_caller() SQL function
   across every document     (pgvector's <=> operator; RLS scopes the rows
   you can see               to your own documents; match_chunks() scopes
        │                     to one document instead, used when filtering
        │                     to a single file)
        ▼
   send question + top       src/lib/gemini.ts + app/api/chat/route.ts
   matches to the LLM,       (Gemini, streamed token by token, with a
   answer using ONLY them     model-fallback chain for free-tier quota)
```

**Embeddings** turn text into a vector (an array of numbers) that
represents its meaning — two chunks that mean similar things end up with
vectors pointing in a similar direction, even with no words in common.

**Cosine similarity** measures the angle between two vectors: 1 means
"point the same direction" (same meaning), 0 means unrelated. It's what
decides which chunks are "relevant" to a question.

**Augmented generation**: the LLM never sees your whole document, and it's
told to answer *only* from the top matching chunks retrieval found —
that's what keeps answers grounded in your files instead of the model's
general training data.

**Model fallback**: Gemini's free tier rate-limits per model, independently
(exhausting `gemini-3.6-flash`'s quota doesn't touch `gemini-3.5-flash`'s).
`src/lib/gemini.ts` retries a request across a chain of models on 429/503
before failing, so a single busy model doesn't take the app down.

## Knowledge graph (`/graph`)

Clustering runs client-side, cached in Supabase so re-opening the page
doesn't re-spend Gemini quota:

1. Fetch every chunk + embedding you can see (RLS does the scoping).
   Legacy documents (see [Accounts and access](#accounts-and-access)) are
   read-only, so their chunks are never clustered — they appear in the
   graph in a neutral color instead.
2. Run k-means (`src/lib/graph/kmeans.ts`, plain JS, no ML library) to
   group chunks into topics.
3. Send the 3 most-central chunks per cluster to `/api/cluster-labels` in
   **one batched Gemini call** — never one call per cluster — for a short
   topic label. A failed label call falls back to generic "Cluster N"
   names rather than blocking the page.
4. Cache cluster assignments + labels in Supabase (`clusters`,
   `graph_state` tables); only recompute when a new document was filed
   since the last run, or on demand via "Re-analyze".
5. Render with `3d-force-graph` (three.js): document nodes, chunk nodes
   colored by cluster, structural links (document → its chunks), and
   cosine-similarity links between chunks (can cross documents/clusters).

## Stack

| Concern | Choice | Why |
|---|---|---|
| Frontend | Next.js App Router + TypeScript + Tailwind | |
| Embeddings | Transformers.js (`all-MiniLM-L6-v2`) | Runs client-side, no embedding API/cost |
| LLM | Gemini (model-fallback chain) via `@google/genai` | Free tier, streaming support |
| Vector storage | Supabase Postgres + `pgvector` | Free tier, SQL-native similarity search |
| File parsing | pdf.js (PDF), SheetJS (Excel) | Runs client-side |
| 3D graph | `3d-force-graph` (three.js) | Renders the knowledge graph |
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
- creates `match_chunks()` (single-document) and `match_chunks_for_caller()`
  (searches everything you've filed — it takes no id parameter; RLS scopes
  the visible rows automatically) — the RPCs used for retrieval
- creates `clusters` and `graph_state` tables for the knowledge graph, and
  a `cluster_id` column on `chunks`
- sets Row Level Security policies keyed on `auth.uid()`, so each account
  sees only its own documents — plus the read-only legacy rows described
  under [Accounts and access](#accounts-and-access)

Re-running the file is safe in the sense that every statement is idempotent
in its final effect, but note that the `clusters` / `graph_state` section
resets the cached clustering (a "Re-analyze" click regenerates it).
Documents and chunks are never touched.

You'll also need to enable the auth providers in the Supabase dashboard:
Authentication → Providers → Email (on by default) and Google (add your
Google OAuth client id/secret), with
`https://<your-project>.supabase.co/auth/v1/callback` as the authorized
redirect URI on the Google side, and your app's `/auth/callback` added
under Authentication → URL Configuration → Redirect URLs.

## Known limitations

- **Embedding runs on the main thread.** A true Web Worker was attempted,
  but Turbopack (Next.js 16.3.1) doesn't currently bundle the
  `new Worker(new URL(...))` pattern for production builds — it copies the
  worker file's raw TypeScript source as a static asset instead of
  compiling it. Until that's fixed upstream, `embeddings.ts` yields to the
  event loop between chunks so the page stays responsive between inference
  calls, and `uploadDocument` caps documents at 2000 chunks so no single
  file can run indefinitely. Large files (a few-thousand-row spreadsheet)
  can take a few minutes to index.
- **No document delete UI.** You can file documents but not remove them
  from the app itself (cleanup is a maintenance-script-only path — see above).

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
  lib/rag/chunk.ts            word-based chunking with overlap
  lib/rag/embeddings.ts       Transformers.js embedding (browser-side)
  lib/rag/types.ts            shared RAG types
  lib/files/extractText.ts    client-side PDF/Excel/CSV/text -> text
  lib/supabase/client.ts      Supabase browser client
  lib/supabase/server.ts      Supabase server client (cookie-backed session)
  lib/supabase/middleware.ts  session refresh + public/private path gating
  proxy.ts                     redirects unauthenticated requests to /login
  lib/gemini.ts                shared Gemini client + model-fallback chain
  lib/graph/kmeans.ts          plain-JS k-means clustering
  lib/graph/edges.ts           cosine similarity + similarity-edge computation
  lib/graph/palette.ts         cluster color palette
  lib/graph/types.ts           shared knowledge-graph types
  lib/graph/buildGraph.ts      graph orchestration: fetch, cluster, cache, assemble
  hooks/useAuth.tsx            auth context: current user + signOut
  hooks/useDocuments.ts        upload/index/ask flow - the RAG pipeline glue
  hooks/useGraph.ts            knowledge-graph data + recompute hook
  app/api/chat/route.ts        calls Gemini, streams the answer back
  app/api/cluster-labels/route.ts  batched Gemini call for cluster topic labels
  app/auth/callback/route.ts   exchanges an OAuth/email-confirm code for a session
  app/login/page.tsx           sign in / sign up (email+password, Google)
  app/page.tsx                 main UI
  app/graph/page.tsx            3D knowledge graph page
supabase/schema.sql            tables, pgvector, RPCs, RLS policies
```
