-- Mini RAG Chatbot - schema
-- Run this in the Supabase SQL Editor (Project -> SQL Editor -> New query).
-- Safe to re-run: every statement is idempotent in its final effect, though
-- section 10 (clusters / graph_state) resets cached clustering data on each
-- re-run - it nulls every chunk's cluster_id and drops/recreates both cache
-- tables. Document and chunk content is never touched; a "Re-analyze" click
-- regenerates the cluster cache.

-- 1. Enable pgvector (stores embeddings as a native Postgres type).
create extension if not exists vector;

-- 2. One row per uploaded document (PDF, Excel, CSV, or pasted text).
-- session_id grouped documents by browser back when there was no login;
-- section 9 retires it in favour of a real user_id (see README).
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
-- (documents used to be indexed on session_id here; section 9 replaces that
-- with an index on user_id and drops the dead one.)

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

-- 7. RLS, original anonymous-session version - SUPERSEDED by section 9,
-- which replaces every policy below with real auth.uid() ownership checks.
-- Kept only so this file still reads as the full migration history.
alter table documents enable row level security;
alter table chunks enable row level security;

drop policy if exists "anon can insert documents" on documents;
create policy "anon can insert documents" on documents
  for insert to anon with check (true);
drop policy if exists "anon can read documents" on documents;
create policy "anon can read documents" on documents
  for select to anon using (true);
-- The two delete policies below exist for maintenance/test-cleanup scripts
-- (run via the Supabase Management API or the SQL editor), not for any in-app
-- delete flow - the app itself never deletes a document or chunk.
drop policy if exists "anon can delete documents" on documents;
create policy "anon can delete documents" on documents
  for delete to anon using (true);

drop policy if exists "anon can insert chunks" on chunks;
create policy "anon can insert chunks" on chunks
  for insert to anon with check (true);
drop policy if exists "anon can read chunks" on chunks;
create policy "anon can read chunks" on chunks
  for select to anon using (true);
drop policy if exists "anon can delete chunks" on chunks;
create policy "anon can delete chunks" on chunks
  for delete to anon using (true);

-- 8. Knowledge graph: semantic clusters over a session's chunks, and a
-- watermark of when they were last computed (see src/lib/graph/buildGraph.ts).
create table if not exists clusters (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null,
  label text not null,
  color_index int not null,
  created_at timestamptz not null default now()
);

alter table chunks add column if not exists cluster_id uuid references clusters(id) on delete set null;

create table if not exists graph_state (
  session_id uuid primary key,
  last_clustered_at timestamptz not null
);

alter table clusters enable row level security;
alter table graph_state enable row level security;

drop policy if exists "anon can insert clusters" on clusters;
create policy "anon can insert clusters" on clusters
  for insert to anon with check (true);
drop policy if exists "anon can read clusters" on clusters;
create policy "anon can read clusters" on clusters
  for select to anon using (true);
drop policy if exists "anon can delete clusters" on clusters;
create policy "anon can delete clusters" on clusters
  for delete to anon using (true);

drop policy if exists "anon can update chunks" on chunks;
create policy "anon can update chunks" on chunks
  for update to anon using (true) with check (true);

drop policy if exists "anon can upsert graph_state" on graph_state;
create policy "anon can upsert graph_state" on graph_state
  for insert to anon with check (true);
drop policy if exists "anon can update graph_state" on graph_state;
create policy "anon can update graph_state" on graph_state
  for update to anon using (true) with check (true);
drop policy if exists "anon can read graph_state" on graph_state;
create policy "anon can read graph_state" on graph_state
  for select to anon using (true);

-- 9. Auth: documents get a real owner. NULL means "filed before login
-- existed" - visible to every authenticated user, editable/deletable by
-- none (there's no real owner to authorize a change).
alter table documents add column if not exists user_id uuid references auth.users(id) on delete cascade;

-- session_id is retired as of this migration (Task 7 in the auth-login plan
-- inserts documents with only user_id/name, never session_id) - drop the
-- leftover NOT NULL so those inserts don't fail. The column itself is left
-- in place (not dropped) since it's still harmless historical data and
-- dropping it is out of scope for this migration.
alter table documents alter column session_id drop not null;

-- user_id is now the filter column in the documents SELECT policy and in the
-- EXISTS subquery of all four chunks policies, so it needs its own index.
-- session_id's index is dead weight now that nothing filters on it.
create index if not exists documents_user_id_idx on documents (user_id);
drop index if exists documents_session_id_idx;

drop policy if exists "anon can insert documents" on documents;
drop policy if exists "anon can read documents" on documents;
drop policy if exists "anon can delete documents" on documents;

drop policy if exists "authenticated users can read own or shared documents" on documents;
create policy "authenticated users can read own or shared documents" on documents
  for select to authenticated using (user_id is null or auth.uid() = user_id);

drop policy if exists "authenticated users can insert own documents" on documents;
create policy "authenticated users can insert own documents" on documents
  for insert to authenticated with check (auth.uid() = user_id);

drop policy if exists "authenticated users can update own documents" on documents;
create policy "authenticated users can update own documents" on documents
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "authenticated users can delete own documents" on documents;
create policy "authenticated users can delete own documents" on documents
  for delete to authenticated using (auth.uid() = user_id);

-- chunks has no user_id of its own - ownership is mediated through the
-- parent document via an EXISTS subquery, same null-is-shared rule.
drop policy if exists "anon can insert chunks" on chunks;
drop policy if exists "anon can read chunks" on chunks;
drop policy if exists "anon can delete chunks" on chunks;
drop policy if exists "anon can update chunks" on chunks;

drop policy if exists "authenticated users can read chunks of visible documents" on chunks;
create policy "authenticated users can read chunks of visible documents" on chunks
  for select to authenticated using (
    exists (
      select 1 from documents
      where documents.id = chunks.document_id
        and (documents.user_id is null or documents.user_id = auth.uid())
    )
  );

drop policy if exists "authenticated users can insert chunks into own documents" on chunks;
create policy "authenticated users can insert chunks into own documents" on chunks
  for insert to authenticated with check (
    exists (
      select 1 from documents
      where documents.id = chunks.document_id
        and documents.user_id = auth.uid()
    )
  );

drop policy if exists "authenticated users can update chunks of own documents" on chunks;
create policy "authenticated users can update chunks of own documents" on chunks
  for update to authenticated using (
    exists (
      select 1 from documents
      where documents.id = chunks.document_id
        and documents.user_id = auth.uid()
    )
  );

drop policy if exists "authenticated users can delete chunks of own documents" on chunks;
create policy "authenticated users can delete chunks of own documents" on chunks
  for delete to authenticated using (
    exists (
      select 1 from documents
      where documents.id = chunks.document_id
        and documents.user_id = auth.uid()
    )
  );

-- 10. clusters / graph_state: pure derived cache data keyed by the old
-- meaningless anonymous session_id. Dropped and recreated rather than
-- migrated - a "Re-analyze" click fully regenerates them, so there's no
-- real content lost (unlike documents/chunks).
alter table chunks drop constraint if exists chunks_cluster_id_fkey;
update chunks set cluster_id = null;
drop table if exists clusters cascade;
drop table if exists graph_state cascade;

create table clusters (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  label text not null,
  color_index int not null,
  created_at timestamptz not null default now()
);

alter table chunks add constraint chunks_cluster_id_fkey
  foreign key (cluster_id) references clusters(id) on delete set null;

create table graph_state (
  user_id uuid primary key references auth.users(id) on delete cascade,
  last_clustered_at timestamptz not null
);

create index if not exists clusters_user_id_idx on clusters (user_id);

alter table clusters enable row level security;
alter table graph_state enable row level security;

drop policy if exists "authenticated users can insert own clusters" on clusters;
create policy "authenticated users can insert own clusters" on clusters
  for insert to authenticated with check (auth.uid() = user_id);
drop policy if exists "authenticated users can read own clusters" on clusters;
create policy "authenticated users can read own clusters" on clusters
  for select to authenticated using (auth.uid() = user_id);
drop policy if exists "authenticated users can delete own clusters" on clusters;
create policy "authenticated users can delete own clusters" on clusters
  for delete to authenticated using (auth.uid() = user_id);

drop policy if exists "authenticated users can insert own graph_state" on graph_state;
create policy "authenticated users can insert own graph_state" on graph_state
  for insert to authenticated with check (auth.uid() = user_id);
drop policy if exists "authenticated users can update own graph_state" on graph_state;
create policy "authenticated users can update own graph_state" on graph_state
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "authenticated users can read own graph_state" on graph_state;
create policy "authenticated users can read own graph_state" on graph_state
  for select to authenticated using (auth.uid() = user_id);

-- 11. Retrieval RPC: RLS on chunks/documents now enforces "own + legacy"
-- automatically for any caller (this function is SECURITY INVOKER, the
-- default), so the id parameter match_chunks_by_session used to take is
-- pure redundancy now - the database already enforces it, the client
-- can't get it wrong. Renamed to make that explicit.
drop function if exists match_chunks_by_session(vector, uuid, int);

create or replace function match_chunks_for_caller(
  query_embedding vector(384),
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
  order by chunks.embedding <=> query_embedding
  limit match_count;
$$;
