-- Mini RAG Chatbot - schema
-- Run this in the Supabase SQL Editor (Project -> SQL Editor -> New query).
-- Safe to re-run: every statement is idempotent (if not exists / or replace).

-- 1. Enable pgvector (stores embeddings as a native Postgres type).
create extension if not exists vector;

-- 2. One row per uploaded document (PDF, Excel, CSV, or pasted text).
-- session_id groups documents by browser (no login in this project - see README).
create table if not exists documents (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null,
  name text not null,
  created_at timestamptz not null default now()
);

-- 3. One row per chunk, with its embedding.
-- all-MiniLM-L6-v2 (the model used in embeddings.ts) outputs 384-dimensional vectors.
create table if not exists chunks (
  id bigserial primary key,
  document_id uuid not null references documents(id) on delete cascade,
  chunk_index int not null,
  content text not null,
  embedding vector(384) not null,
  created_at timestamptz not null default now()
);

-- 4. Vector index so similarity search stays fast as chunks grow.
create index if not exists chunks_embedding_idx
  on chunks using hnsw (embedding vector_cosine_ops);

create index if not exists chunks_document_id_idx on chunks (document_id);
create index if not exists documents_session_id_idx on documents (session_id);

-- 5. RPC: retrieval scoped to one document (used when the UI is filtered to
-- a single file). Cosine similarity via pgvector's <=> operator.
create or replace function match_chunks(
  query_embedding vector(384),
  match_document_id uuid,
  match_count int default 3
)
returns table (
  id bigint,
  content text,
  chunk_index int,
  similarity float
)
language sql stable
as $$
  select
    chunks.id,
    chunks.content,
    chunks.chunk_index,
    1 - (chunks.embedding <=> query_embedding) as similarity
  from chunks
  where chunks.document_id = match_document_id
  order by chunks.embedding <=> query_embedding
  limit match_count;
$$;

-- 6. RPC: retrieval across every document in a session (the default "search
-- everything I've filed" mode). Same cosine-distance math as match_chunks,
-- just not filtered down to one document_id - so the top matches can come
-- from whichever file (or files) actually contain the relevant content.
create or replace function match_chunks_by_session(
  query_embedding vector(384),
  match_session_id uuid,
  match_count int default 3
)
returns table (
  id bigint,
  document_id uuid,
  document_name text,
  content text,
  chunk_index int,
  similarity float
)
language sql stable
as $$
  select
    chunks.id,
    chunks.document_id,
    documents.name as document_name,
    chunks.content,
    chunks.chunk_index,
    1 - (chunks.embedding <=> query_embedding) as similarity
  from chunks
  join documents on documents.id = chunks.document_id
  where documents.session_id = match_session_id
  order by chunks.embedding <=> query_embedding
  limit match_count;
$$;

-- 7. RLS: this project has no login system, so access is scoped only by the
-- client-generated session_id (see src/lib/session.ts), not enforced server-side.
-- Fine for a portfolio project - do not store sensitive documents.
alter table documents enable row level security;
alter table chunks enable row level security;

drop policy if exists "anon can insert documents" on documents;
create policy "anon can insert documents" on documents
  for insert to anon with check (true);
drop policy if exists "anon can read documents" on documents;
create policy "anon can read documents" on documents
  for select to anon using (true);

drop policy if exists "anon can insert chunks" on chunks;
create policy "anon can insert chunks" on chunks
  for insert to anon with check (true);
drop policy if exists "anon can read chunks" on chunks;
create policy "anon can read chunks" on chunks
  for select to anon using (true);
