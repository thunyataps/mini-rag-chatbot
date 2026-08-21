# Login System (Supabase Auth) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the anonymous, localStorage-`session_id` access model with real Supabase Auth (email+password + Google OAuth), mandatory on every page, with Postgres RLS actually enforcing per-user document ownership for the first time.

**Architecture:** `@supabase/ssr` provides cookie-based sessions shared between the browser and the server (Proxy + Route Handlers). A `proxy.ts` file gates every route except `/login` and `/auth/callback`. `documents.user_id` (nullable = legacy/shared) becomes the real ownership column; RLS policies rewritten to enforce it via Postgres itself rather than client-side convention. `clusters`/`graph_state` are dropped and recreated keyed by `user_id` instead of migrated.

**Tech Stack:** `@supabase/ssr` (new), existing Next.js 16 App Router + Supabase Postgres/pgvector stack.

**Spec:** `docs/superpowers/specs/2026-08-21-auth-login-design.md`

## Global Constraints

- Login is mandatory: `proxy.ts` redirects every unauthenticated request to `/login`, except `/login` and `/auth/callback` themselves (and Next's own static/internal paths).
- `documents.user_id` is nullable; `null` means "filed before login existed" - visible to every authenticated user, editable/deletable by none. Every row inserted from now on has `user_id = auth.uid()`, never null.
- RLS is the real enforcement mechanism now. Where a client-side filter (e.g. `.eq("session_id", ...)`) would only be duplicating what RLS already guarantees, remove it rather than keep it as redundant defense-in-depth - except where the filter also expresses real write intent (e.g. scoping a DELETE to "my own clusters").
- `clusters` and `graph_state` are **dropped and recreated** with `user_id uuid not null references auth.users(id)`, not migrated - their existing rows are keyed by meaningless anonymous session ids and are fully derivable by a "Re-analyze" click.
- Use `@supabase/ssr`'s `createBrowserClient` / `createServerClient` - never raw `@supabase/supabase-js` `createClient` - for both the browser and server Supabase clients, so cookie-based sessions sync between the browser and Proxy/Route Handlers.
- The Proxy file is `proxy.ts` at the project root (Next.js 16 renamed `middleware.ts` -> `proxy.ts`; verified against current Next.js docs), exporting a function named `proxy`, not `middleware`.
- `supabase.auth.exchangeCodeForSession()` needs `await new Promise(r => setTimeout(r, 0))` immediately after it in the callback route - `@supabase/supabase-js` >=2.91.0 defers its `SIGNED_IN` notification via `setTimeout(fn, 0)`, which can otherwise fire after the redirect response is already sent, silently dropping the session cookie (confirmed live bug: github.com/supabase/supabase-js/issues/2037).
- Out of scope, do not implement: TOTP/MFA, password-reset UI, email-verification UI beyond Supabase's default confirmation email, a document-delete UI.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/lib/supabase/client.ts` (modify) | Browser Supabase client via `createBrowserClient` (was raw `createClient`) |
| `src/lib/supabase/server.ts` (new) | Server-side Supabase client factory (Route Handlers, Server Components) |
| `src/lib/supabase/middleware.ts` (new) | `updateSession()` - reads/refreshes the session from cookies, redirects unauthenticated requests |
| `proxy.ts` (new, project root) | Next.js Proxy entry point; delegates to `updateSession()` |
| `supabase/schema.sql` (modify) | `documents.user_id`, real ownership RLS, dropped+recreated `clusters`/`graph_state`, simplified retrieval RPC |
| `src/app/auth/callback/route.ts` (new) | OAuth/email-confirmation code exchange |
| `src/app/login/page.tsx` (new) | Sign in / sign up form + "Sign in with Google" |
| `src/hooks/useAuth.tsx` (new) | `AuthProvider` + `useAuth()` - current user, loading state, `signOut()` |
| `src/lib/session.ts` (delete) | Superseded by real auth - no more client-generated session ids |
| `src/hooks/useDocuments.ts` (modify) | Use `useAuth()`'s user id instead of `getSessionId()` |
| `src/hooks/useGraph.ts` (modify) | Same |
| `src/lib/graph/buildGraph.ts` (modify) | Same, plus drops the now-redundant explicit chunk-fetch filter (RLS covers it) and renames the retrieval RPC call |
| `src/app/layout.tsx` (modify) | Wrap `children` in `<AuthProvider>` |
| `src/app/page.tsx` (modify) | Sign-out control |

---

### Task 1: Supabase clients - browser + server, via `@supabase/ssr`

**Files:**
- Modify: `src/lib/supabase/client.ts`
- Create: `src/lib/supabase/server.ts`

**Interfaces:**
- Produces: `supabase` (browser client, unchanged export name/shape from the caller's perspective) from `client.ts`; `createClient(): Promise<SupabaseClient>` (server client factory) from `server.ts`.
- Consumes (Task 2 verification, Task 4, all later tasks): both.

- [ ] **Step 1: Install `@supabase/ssr`**

```bash
cd "/Users/mj/JAB/GITHUB/Mini RAG Chatbot" && npm install @supabase/ssr
```

- [ ] **Step 2: Rewrite `src/lib/supabase/client.ts`**

```ts
import { createBrowserClient } from "@supabase/ssr";

/**
 * Browser Supabase client, using the public "anon" key. This key is safe to
 * expose to the client - access is controlled by the Row Level Security
 * policies defined in supabase/schema.sql, not by keeping this key secret.
 *
 * Uses @supabase/ssr's createBrowserClient (not raw @supabase/supabase-js
 * createClient) so the session is stored in cookies the server (Proxy,
 * Route Handlers) can also read - a plain createClient() would keep the
 * session in localStorage only, invisible to server-side auth checks.
 */
export const supabase = createBrowserClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);
```

- [ ] **Step 3: Create `src/lib/supabase/server.ts`**

```ts
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

/**
 * Server-side Supabase client for Route Handlers and Server Components.
 * Reads the session from the request's cookies (set by proxy.ts /
 * updateSession, or by this same helper) rather than any client-side
 * storage.
 */
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          } catch {
            // Called from a Server Component render, where cookies can't
            // be mutated - harmless as long as proxy.ts is refreshing the
            // session on every request (it is, see Task 3).
          }
        },
      },
    }
  );
}
```

- [ ] **Step 4: Typecheck**

```bash
cd "/Users/mj/JAB/GITHUB/Mini RAG Chatbot" && npx tsc --noEmit
```
Expected: fails on every file still importing `getSessionId` from `@/lib/session` or calling `.session_id` against Supabase - that's expected until later tasks land. Confirm the failures are ONLY in files this plan will touch later (`useDocuments.ts`, `useGraph.ts`, `buildGraph.ts`) and not a syntax/type error in the two files this task created.

- [ ] **Step 5: Commit**

```bash
git add src/lib/supabase/client.ts src/lib/supabase/server.ts package.json package-lock.json
git commit -m "feat: add @supabase/ssr browser and server clients"
```

---

### Task 2: Schema migration - real ownership RLS, `clusters`/`graph_state` rebuilt, simplified retrieval RPC

**Files:**
- Modify: `supabase/schema.sql`

**Interfaces:**
- Produces: `documents.user_id` column; rewritten RLS on `documents`/`chunks`; recreated `clusters`/`graph_state` tables (schema: `clusters(id, user_id, label, color_index, created_at)`, `graph_state(user_id primary key, last_clustered_at)`); `match_chunks_for_caller(query_embedding vector(384), match_count int default 3)` RPC (replaces `match_chunks_by_session`, drops the id parameter entirely).
- Consumes (Task 7): `match_chunks_for_caller`, the recreated `clusters`/`graph_state` shape.

- [ ] **Step 1: Append the migration to `supabase/schema.sql`**

```sql
-- 9. Auth: documents get a real owner. NULL means "filed before login
-- existed" - visible to every authenticated user, editable/deletable by
-- none (there's no real owner to authorize a change).
alter table documents add column if not exists user_id uuid references auth.users(id) on delete cascade;

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
```

- [ ] **Step 2: Apply the migration via the Supabase Management API**

```bash
cd "/Users/mj/JAB/GITHUB/Mini RAG Chatbot" && \
TOKEN=$(grep '^SUPABASE_ACCESS_TOKEN=' .env.local | cut -d= -f2-) && \
python3 -c "
import json
sql = open('supabase/schema.sql').read()
print(json.dumps({'query': sql}))
" > /tmp/schema_payload.json && \
curl -s -X POST "https://api.supabase.com/v1/projects/imjqsevxanvbrjnbjsob/database/query" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  --data @/tmp/schema_payload.json && rm -f /tmp/schema_payload.json
```
Expected: `[]` (idempotent DDL, no rows returned).

- [ ] **Step 3: Verify the migration landed correctly**

```bash
cd "/Users/mj/JAB/GITHUB/Mini RAG Chatbot" && \
TOKEN=$(grep '^SUPABASE_ACCESS_TOKEN=' .env.local | cut -d= -f2-) && \
curl -s -X POST "https://api.supabase.com/v1/projects/imjqsevxanvbrjnbjsob/database/query" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "{\"query\":\"select column_name from information_schema.columns where table_name='documents' and column_name='user_id'; select proname from pg_proc where proname='match_chunks_for_caller'; select policyname, cmd from pg_policies where tablename='documents' order by cmd;\"}"
```
Expected: the last statement's output (the API returns only the final statement's rows) should list 4 policies on `documents` - `INSERT`, `SELECT`, `UPDATE`, `DELETE`, none named `anon can ...`. Run the first two statements separately if you want to see their output explicitly.

- [ ] **Step 4: Live RLS verification with two real Supabase Auth accounts**

This needs real authenticated users, not the anon key - fetch the project's `service_role` key via the Management API (used ONLY in this throwaway script, never committed, never used in application code) to create pre-confirmed test accounts directly.

```bash
cd "/Users/mj/JAB/GITHUB/Mini RAG Chatbot" && \
TOKEN=$(grep '^SUPABASE_ACCESS_TOKEN=' .env.local | cut -d= -f2-) && \
curl -s "https://api.supabase.com/v1/projects/imjqsevxanvbrjnbjsob/api-keys?reveal=true" \
  -H "Authorization: Bearer $TOKEN" > /tmp/api-keys.json && \
python3 -c "
import json
keys = json.load(open('/tmp/api-keys.json'))
for k in keys:
    if k.get('name') == 'service_role':
        print(k['api_key'])
" > /tmp/service-role-key.txt && \
cat /tmp/service-role-key.txt
```

```bash
cat > "/Users/mj/JAB/GITHUB/Mini RAG Chatbot/test-rls.mjs" << 'EOF'
import { pipeline } from "@huggingface/transformers";
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";

const env = Object.fromEntries(
  readFileSync("/Users/mj/JAB/GITHUB/Mini RAG Chatbot/.env.local", "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i), l.slice(i + 1)];
    })
);
const serviceRoleKey = readFileSync("/tmp/service-role-key.txt", "utf8").trim();

const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, serviceRoleKey);
const extractor = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");
async function embed(text) {
  const out = await extractor(text, { pooling: "mean", normalize: true });
  return Array.from(out.data);
}

async function makeConfirmedUser(email) {
  const password = "test-password-123!";
  const { data, error } = await admin.auth.admin.createUser({
    email, password, email_confirm: true,
  });
  if (error) throw error;
  const client = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
  const { error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw signInError;
  return { id: data.user.id, client };
}

const userA = await makeConfirmedUser(`test-a-${Date.now()}@example.com`);
const userB = await makeConfirmedUser(`test-b-${Date.now()}@example.com`);

// User A files a private document.
const { data: docA, error: docAErr } = await userA.client
  .from("documents")
  .insert({ user_id: userA.id, name: "user-a-private.txt" })
  .select("id")
  .single();
if (docAErr) throw docAErr;
const embeddingA = await embed("Only user A should be able to see this content.");
await userA.client.from("chunks").insert({
  document_id: docA.id, chunk_index: 0, content: "private to A", embedding: embeddingA,
});

// A legacy/shared document (user_id null), inserted via the service role
// key since RLS would otherwise reject a null user_id insert.
const { data: legacyDoc } = await admin
  .from("documents")
  .insert({ user_id: null, name: "legacy-shared.txt" })
  .select("id")
  .single();
const embeddingLegacy = await embed("Everyone should be able to see this legacy content.");
await admin.from("chunks").insert({
  document_id: legacyDoc.id, chunk_index: 0, content: "shared legacy", embedding: embeddingLegacy,
});

// User B should see the legacy doc but NOT user A's private doc.
const { data: bVisible } = await userB.client.from("documents").select("name");
const bNames = bVisible.map((d) => d.name);
console.log("User B sees:", bNames);
if (bNames.includes("user-a-private.txt")) throw new Error("FAIL: user B can see user A's private document");
if (!bNames.includes("legacy-shared.txt")) throw new Error("FAIL: user B cannot see the legacy shared document");

// User B should NOT be able to update or delete the legacy document.
const { error: bUpdateErr, count: bUpdateCount } = await userB.client
  .from("documents")
  .update({ name: "hacked" })
  .eq("id", legacyDoc.id)
  .select();
console.log("User B update of legacy doc affected rows:", bUpdateErr ? "error" : (bUpdateCount ?? "n/a"));

// User A should NOT be able to delete user B's account's data (none exists,
// but confirm A cannot delete the legacy doc either).
const { data: aDeleteLegacy } = await userA.client.from("documents").delete().eq("id", legacyDoc.id).select();
if (aDeleteLegacy && aDeleteLegacy.length > 0) throw new Error("FAIL: user A deleted the legacy document");
console.log("User A delete of legacy doc affected rows:", aDeleteLegacy?.length ?? 0);

// match_chunks_for_caller as user B should surface the legacy chunk, not A's.
const queryEmbedding = await embed("content everyone should see");
const { data: matches, error: matchErr } = await userB.client.rpc("match_chunks_for_caller", {
  query_embedding: queryEmbedding, match_count: 5,
});
if (matchErr) throw matchErr;
console.log("User B match_chunks_for_caller results:", matches.map((m) => m.content));
if (matches.some((m) => m.content === "private to A")) throw new Error("FAIL: RPC leaked user A's private chunk to user B");

console.log("PASS: RLS correctly isolates private documents and shares legacy ones");

// Cleanup: delete via service role (bypasses RLS entirely).
await admin.from("documents").delete().eq("id", docA.id);
await admin.from("documents").delete().eq("id", legacyDoc.id);
await admin.auth.admin.deleteUser(userA.id);
await admin.auth.admin.deleteUser(userB.id);
console.log("cleanup done");
EOF
cd "/Users/mj/JAB/GITHUB/Mini RAG Chatbot" && node test-rls.mjs
rm "/Users/mj/JAB/GITHUB/Mini RAG Chatbot/test-rls.mjs" /tmp/service-role-key.txt /tmp/api-keys.json
```

Expected: `PASS: RLS correctly isolates private documents and shares legacy ones`, no `FAIL:` lines, `cleanup done`. If any `FAIL:` line prints, the migration has a real RLS bug - stop and report it rather than proceeding, this is the security-critical part of the whole feature.

- [ ] **Step 5: Commit**

```bash
git add supabase/schema.sql
git commit -m "feat: real per-user RLS via auth.uid(), rebuild clusters/graph_state on user_id"
```

---

### Task 3: Proxy - route protection

**Files:**
- Create: `src/lib/supabase/middleware.ts`
- Create: `proxy.ts` (project root)

**Interfaces:**
- Consumes: `createServerClient` from `@supabase/ssr` (Task 1's pattern, but Proxy needs its own request/response-cookie-bound instance - see code below, this is NOT the same as `src/lib/supabase/server.ts`'s `createClient()`, which is for Route Handlers/Server Components).
- Produces: `updateSession(request: NextRequest): Promise<NextResponse>`.

- [ ] **Step 1: Create `src/lib/supabase/middleware.ts`**

```ts
import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

/** Paths reachable without being signed in. Everything else redirects to /login. */
const PUBLIC_PATHS = ["/login", "/auth/callback"];

export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  // getClaims() verifies the JWT against Supabase's JWKS locally/cached,
  // which is faster than getUser()'s round trip to the Auth server, and is
  // Supabase's current recommended way to check auth in Proxy/middleware.
  const { data, error } = await supabase.auth.getClaims();
  const isAuthenticated = !error && !!data?.claims;

  const isPublicPath = PUBLIC_PATHS.some((path) => request.nextUrl.pathname.startsWith(path));

  if (!isAuthenticated && !isPublicPath) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }

  return response;
}
```

- [ ] **Step 2: Create `proxy.ts` at the project root**

```ts
import { type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";

export async function proxy(request: NextRequest) {
  return updateSession(request);
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
```

- [ ] **Step 3: Typecheck, then verify redirect behavior against a real dev server**

```bash
cd "/Users/mj/JAB/GITHUB/Mini RAG Chatbot" && npx tsc --noEmit
```
Expected: same pre-existing failures as Task 1 (files this plan hasn't touched yet), nothing new from `proxy.ts`/`middleware.ts` themselves.

```bash
cd "/Users/mj/JAB/GITHUB/Mini RAG Chatbot" && pkill -f "next dev" 2>/dev/null; sleep 1; (npm run dev > /tmp/mini-rag-dev.log 2>&1 &) && sleep 3 && \
echo "-- unauthenticated / should redirect to /login --" && \
curl -s -o /dev/null -w "%{http_code} -> %{redirect_url}\n" http://localhost:3000/ && \
echo "-- /login itself should NOT redirect --" && \
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/login
```
Expected: `/` returns a 307/308 redirect to `/login`; `/login` returns 200 (it will actually 500 or similar right now since the page doesn't exist yet - that's expected, this step is only checking the *redirect* behavior for `/`, not that `/login` renders correctly; Task 5 creates that page).

- [ ] **Step 4: Commit**

```bash
git add src/lib/supabase/middleware.ts proxy.ts
git commit -m "feat: add Proxy route protection for authenticated pages"
```

---

### Task 4: OAuth/email-confirmation callback route

**Files:**
- Create: `src/app/auth/callback/route.ts`

**Interfaces:**
- Consumes: `createClient` from `@/lib/supabase/server` (Task 1).

- [ ] **Step 1: Create `src/app/auth/callback/route.ts`**

```ts
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * Handles both OAuth (Google) redirects and email-confirmation links -
 * both send the browser here with a `?code=...` to exchange for a session.
 */
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = searchParams.get("next") ?? "/";

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);

    // @supabase/supabase-js >=2.91.0 defers the SIGNED_IN notification via
    // setTimeout(fn, 0), which @supabase/ssr's cookie-writing subscriber
    // needs to run within this request's lifetime - without this yield the
    // redirect below can be sent before the session cookie is written.
    // See: github.com/supabase/supabase-js/issues/2037
    await new Promise((resolve) => setTimeout(resolve, 0));

    if (!error) {
      return NextResponse.redirect(`${origin}${next}`);
    }
  }

  return NextResponse.redirect(`${origin}/login?error=auth-code-error`);
}
```

- [ ] **Step 2: Typecheck**

```bash
cd "/Users/mj/JAB/GITHUB/Mini RAG Chatbot" && npx tsc --noEmit
```
Expected: same pre-existing failures as before, nothing new from this file.

- [ ] **Step 3: Commit**

```bash
git add src/app/auth/callback/route.ts
git commit -m "feat: add /auth/callback route for OAuth and email confirmation"
```

---

### Task 5: Login page

**Files:**
- Create: `src/app/login/page.tsx`

**Interfaces:**
- Consumes: `supabase` from `@/lib/supabase/client` (Task 1).

- [ ] **Step 1: Create `src/app/login/page.tsx`**

```tsx
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase/client";

type Mode = "sign-in" | "sign-up";

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("sign-in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setInfo(null);
    setIsSubmitting(true);
    try {
      if (mode === "sign-in") {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        router.push("/");
        router.refresh();
      } else {
        const { error } = await supabase.auth.signUp({
          email,
          password,
          options: { emailRedirectTo: `${window.location.origin}/auth/callback` },
        });
        if (error) throw error;
        setInfo("Check your email to confirm your account before signing in.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleGoogleSignIn() {
    setError(null);
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: `${window.location.origin}/auth/callback` },
    });
    if (error) setError(error.message);
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-paper px-4">
      <div className="w-full max-w-sm rounded border border-line bg-card p-6">
        <h1 className="font-display text-2xl text-ink">Mini RAG Chatbot</h1>
        <p className="mt-1 mb-6 font-mono text-[11px] text-ink-soft">
          {mode === "sign-in" ? "Sign in to your archive" : "Create an account"}
        </p>

        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            className="rounded border border-line bg-paper p-3 text-sm text-ink outline-none focus:border-stamp"
          />
          <input
            type="password"
            required
            minLength={6}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password"
            className="rounded border border-line bg-paper p-3 text-sm text-ink outline-none focus:border-stamp"
          />
          <button
            type="submit"
            disabled={isSubmitting}
            className="rounded-sm bg-ink px-5 py-2.5 text-sm font-medium text-card transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {isSubmitting ? "Working…" : mode === "sign-in" ? "Sign in" : "Sign up"}
          </button>
        </form>

        <div className="my-4 flex items-center gap-3 font-mono text-[11px] text-ink-soft">
          <div className="h-px flex-1 bg-line" />
          or
          <div className="h-px flex-1 bg-line" />
        </div>

        <button
          onClick={handleGoogleSignIn}
          className="w-full rounded-sm border border-line bg-paper px-5 py-2.5 text-sm font-medium text-ink transition-colors hover:border-stamp"
        >
          Sign in with Google
        </button>

        <button
          onClick={() => {
            setMode(mode === "sign-in" ? "sign-up" : "sign-in");
            setError(null);
            setInfo(null);
          }}
          className="mt-4 font-mono text-[11px] text-stamp underline decoration-dotted underline-offset-2 hover:text-ink"
        >
          {mode === "sign-in" ? "Need an account? Sign up" : "Already have an account? Sign in"}
        </button>

        {error && <p className="mt-4 text-sm text-danger">{error}</p>}
        {info && <p className="mt-4 text-sm text-ink-soft">{info}</p>}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck, lint, and build**

```bash
cd "/Users/mj/JAB/GITHUB/Mini RAG Chatbot" && npx tsc --noEmit && npm run lint 2>&1 | tail -20
```
Expected: same pre-existing failures as before (files not yet updated), nothing new from this file. Lint clean on this file specifically.

- [ ] **Step 3: Commit**

```bash
git add src/app/login/page.tsx
git commit -m "feat: add /login page (email+password + Google OAuth)"
```

---

### Task 6: `useAuth` provider + hook, wired into the root layout

**Files:**
- Create: `src/hooks/useAuth.tsx`
- Modify: `src/app/layout.tsx`

**Interfaces:**
- Consumes: `supabase` from `@/lib/supabase/client` (Task 1).
- Produces: `AuthProvider` (component), `useAuth(): { user: User | null; isLoading: boolean; signOut: () => Promise<void> }`.
- Consumes (Task 7, Task 8): `useAuth`.

- [ ] **Step 1: Create `src/hooks/useAuth.tsx`**

```tsx
"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import type { User } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase/client";

interface AuthContextValue {
  user: User | null;
  isLoading: boolean;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    supabase.auth.getUser().then(({ data }) => {
      if (cancelled) return;
      setUser(data.user);
      setIsLoading(false);
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
    });

    return () => {
      cancelled = true;
      subscription.unsubscribe();
    };
  }, []);

  const signOut = useCallback(async () => {
    await supabase.auth.signOut();
  }, []);

  return <AuthContext.Provider value={{ user, isLoading, signOut }}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within an AuthProvider");
  return ctx;
}
```

- [ ] **Step 2: Wire `AuthProvider` into `src/app/layout.tsx`**

Read the current file first, then wrap the existing `{children}` with `<AuthProvider>`, adding the import alongside the existing font imports:

```tsx
import { AuthProvider } from "@/hooks/useAuth";
```

```tsx
      <body className="min-h-full flex flex-col">
        <AuthProvider>{children}</AuthProvider>
      </body>
```

(Keep every existing class/attribute on `<html>` and `<body>` exactly as they are - only wrap the `children` expression itself.)

- [ ] **Step 3: Typecheck**

```bash
cd "/Users/mj/JAB/GITHUB/Mini RAG Chatbot" && npx tsc --noEmit
```
Expected: same pre-existing failures as before, nothing new from these two files.

- [ ] **Step 4: Commit**

```bash
git add src/hooks/useAuth.tsx src/app/layout.tsx
git commit -m "feat: add useAuth provider/hook, wire into root layout"
```

---

### Task 7: Wire real user ids through the RAG + graph pipeline

**Files:**
- Delete: `src/lib/session.ts`
- Modify: `src/hooks/useDocuments.ts`
- Modify: `src/hooks/useGraph.ts`
- Modify: `src/lib/graph/buildGraph.ts`

**Interfaces:**
- Consumes: `useAuth` (Task 6); `match_chunks_for_caller`, recreated `clusters`/`graph_state` shape (Task 2).
- Produces: `useDocuments()` and `useGraph()` keep their exact same external return shape as before (no consumer outside these two hooks needs to change) - only their *internal* identity source changes from `getSessionId()` to the authenticated user's id.

- [ ] **Step 1: Delete `src/lib/session.ts`**

```bash
rm "/Users/mj/JAB/GITHUB/Mini RAG Chatbot/src/lib/session.ts"
```

- [ ] **Step 2: Update `src/hooks/useDocuments.ts`**

Read the current file first. Replace the `getSessionId` import with `useAuth`:

```ts
import { useAuth } from "@/hooks/useAuth";
```
(remove `import { getSessionId } from "@/lib/session";`)

Inside `useDocuments()`, get the user at the top:

```ts
export function useDocuments() {
  const { user } = useAuth();
```

Replace every `getSessionId()` call with `user!.id` (the `!` is safe here: `useDocuments` is only ever rendered on pages Proxy has already confirmed are authenticated - by the time this hook's effects run, `useAuth()`'s `user` has resolved to a real user in every realistic case for this app's single-page-at-a-time usage).

In `refreshDocuments`, `uploadDocument`, and the `askQuestion`/RPC call, this means:
- `.eq("session_id", sessionId)` on the `documents` select becomes unnecessary - RLS already returns exactly "own + legacy" for the authenticated caller. Remove the `.eq(...)` clause on `documents` entirely (keep the rest of the query as-is).
- `.insert({ session_id: sessionId, name })` becomes `.insert({ user_id: user!.id, name })`.
- The RPC call site changes from:
  ```ts
  const { data, error } = await supabase.rpc("match_chunks_by_session", {
    query_embedding: queryEmbedding,
    match_session_id: getSessionId(),
    match_count: TOP_K,
  });
  ```
  to:
  ```ts
  const { data, error } = await supabase.rpc("match_chunks_for_caller", {
    query_embedding: queryEmbedding,
    match_count: TOP_K,
  });
  ```
  (drop the id parameter entirely - RLS scopes it now, per Task 2's RPC change).
- The `useEffect` that calls `refreshDocuments()` on mount should also depend on `user` and skip running until `user` is non-null:
  ```ts
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    // ... existing body, unchanged ...
  }, [refreshDocuments, user]);
  ```

The single-document-scoped `match_chunks` RPC call (used when `searchScope !== "all"`) is unchanged - it already scoped by `document_id` and gains RLS protection automatically with no code change needed.

- [ ] **Step 3: Update `src/lib/graph/buildGraph.ts`**

Read the current file first. Changes:

- `fetchChunkPoints` drops its `sessionId` parameter and the `.eq("documents.session_id", sessionId)` filter entirely - RLS already returns exactly the rows the caller can see:
  ```ts
  export async function fetchChunkPoints(): Promise<ChunkPoint[]> {
    const { data, error } = await supabase
      .from("chunks")
      .select(
        "id, document_id, chunk_index, content, embedding, cluster_id, documents!inner(name)"
      );
    if (error) throw new Error(error.message);

    return ((data ?? []) as unknown as ChunkWithDocumentRow[]).map((row) => ({
      id: row.id,
      documentId: row.document_id,
      documentName: row.documents.name,
      chunkIndex: row.chunk_index,
      content: row.content,
      embedding:
        typeof row.embedding === "string" ? (JSON.parse(row.embedding) as number[]) : row.embedding,
      clusterId: row.cluster_id,
    }));
  }
  ```
  (keep the existing embedding-string-parsing + 384-dimension invariant from the final-review fix wave - only the `session_id` filter and parameter are removed. Update the `ChunkWithDocumentRow` type's `documents` field to `{ name: string }` instead of `{ name: string; session_id: string }`.)

- `needsRecompute(userId: string, chunks: ChunkPoint[])` and `recomputeClusters(userId: string, chunks: ChunkPoint[])` keep a `userId` parameter (renamed from `sessionId`) - `clusters`/`graph_state` are per-user, not RLS-shared, so this one still needs to be passed explicitly. Every `.eq("session_id", sessionId)` becomes `.eq("user_id", userId)`; every `{ session_id: sessionId, ... }` insert/upsert payload becomes `{ user_id: userId, ... }`.

- `forceRecompute(userId: string)` calls `fetchChunkPoints()` (no argument now) then `recomputeClusters(userId, chunks)`.

- `fetchGraphData(userId: string)` calls `fetchChunkPoints()` (no argument) for its initial fetch, still passes `userId` to `needsRecompute`/`recomputeClusters`, and its final re-fetch after a recompute also becomes a bare `fetchChunkPoints()` call.

- [ ] **Step 4: Update `src/hooks/useGraph.ts`**

Read the current file first. Replace `getSessionId` usage with `useAuth()`'s `user.id`, same pattern as Task 7 Step 2:

```ts
import { useAuth } from "@/hooks/useAuth";
```
(remove `import { getSessionId } from "@/lib/session";`)

```ts
export function useGraph() {
  const { user } = useAuth();
  // ...
```

Every call site that passed `getSessionId()` to `fetchGraphData`/`forceRecompute` now passes `user!.id` instead (same non-null-assertion reasoning as Task 7 Step 2 - this hook is only ever rendered on the `/graph` page, which Proxy already gates). Guard the initial-load effect the same way: skip running until `user` is non-null.

- [ ] **Step 5: Typecheck, lint, and build**

```bash
cd "/Users/mj/JAB/GITHUB/Mini RAG Chatbot" && npx tsc --noEmit && npm run lint 2>&1 | tail -20
```
Expected: both clean now - this was the last task with pre-existing expected failures.

```bash
cd "/Users/mj/JAB/GITHUB/Mini RAG Chatbot" && rm -rf .next && npm run build
```
Expected: build succeeds. Route table should show `/`, `/graph`, `/login` as static, `/auth/callback`, `/api/chat`, `/api/cluster-labels` as dynamic.

- [ ] **Step 6: Commit**

```bash
git add src/lib/session.ts src/hooks/useDocuments.ts src/hooks/useGraph.ts src/lib/graph/buildGraph.ts
git commit -m "feat: wire real user ids through RAG and graph pipelines, drop session_id"
```

---

### Task 8: Sign-out control + final verification

**Files:**
- Modify: `src/app/page.tsx`

**Interfaces:**
- Consumes: `useAuth` (Task 6).

- [ ] **Step 1: Add a sign-out control to the masthead**

Read the current file first. Add the import:

```tsx
import { useAuth } from "@/hooks/useAuth";
```

Inside the `Home` component, alongside the existing `useDocuments()` call:

```tsx
  const { user, signOut } = useAuth();
```

In the `<header>` block, alongside the existing "View the knowledge graph" link, add a sign-out control that shows the signed-in user's email:

```tsx
          <div className="mt-1 flex items-center justify-between gap-2">
            <Link
              href="/graph"
              className="font-mono text-[11px] text-stamp underline decoration-dotted underline-offset-2 hover:text-ink"
            >
              View the knowledge graph →
            </Link>
            <div className="flex items-center gap-2 font-mono text-[11px] text-ink-soft">
              {user?.email}
              <button onClick={() => signOut()} className="underline decoration-dotted underline-offset-2 hover:text-ink">
                Sign out
              </button>
            </div>
          </div>
```

(Replace the existing standalone `<Link href="/graph">...</Link>` with this block, which wraps it alongside the new sign-out control - don't duplicate the link.)

- [ ] **Step 2: Full verification**

```bash
cd "/Users/mj/JAB/GITHUB/Mini RAG Chatbot" && npx tsc --noEmit && npm run lint 2>&1 | tail -20
```
Expected: clean.

```bash
cd "/Users/mj/JAB/GITHUB/Mini RAG Chatbot" && rm -rf .next && npm run build
```
Expected: succeeds, same route table as Task 7.

- [ ] **Step 3: Manual browser verification (required - cannot be automated this session)**

Browser automation has been non-functional this whole session (same known limitation as the knowledge graph feature). This needs a human to check:

1. `npm run dev`, open http://localhost:3000 - should immediately redirect to `/login`.
2. Sign up with a real email you can check. Confirm the email link routes back into the app signed in.
3. Sign out, sign back in with the same email/password.
4. Try "Sign in with Google" - if Google OAuth hasn't been configured in the Supabase dashboard yet (a manual step outside this codebase, per the spec), confirm it fails with a clear error rather than crashing the page.
5. File a document, confirm it appears; confirm the pre-existing `Shipment_Log.xlsx`/`tbl_shipment.xlsx`/`netflix_titles.csv`-style legacy documents (if any still exist) also appear, read-only.
6. Open `/graph`, confirm it still renders for the signed-in user's own + legacy documents.
7. Sign out, confirm every page redirects back to `/login`.

- [ ] **Step 4: Commit**

```bash
git add src/app/page.tsx
git commit -m "feat: add sign-out control to the main page"
```

---

## Self-Review Notes

- **Spec coverage:** mandatory login + Proxy gate (Task 3), email+password + Google (Task 5), legacy-shared/private RLS model (Task 2), `@supabase/ssr` browser+server clients (Task 1), OAuth/email-confirm callback (Task 4), `useAuth` (Task 6), pipeline rewiring off `session_id` (Task 7), sign-out (Task 8) - all covered.
- **Type consistency checked:** `useAuth()`'s `{user, isLoading, signOut}` shape (Task 6) is consumed identically in Tasks 7 and 8. `fetchGraphData`/`forceRecompute`/`needsRecompute`/`recomputeClusters` signatures in Task 7 Step 3 match what Task 7 Step 4's `useGraph.ts` update calls. `match_chunks_for_caller`'s parameter list (Task 2) matches exactly what Task 7 Step 2's `useDocuments.ts` RPC call sends (no id parameter).
- **Real bug baked into the plan, not left implicit:** the `exchangeCodeForSession` deferred-notification issue (Task 4) is a live, version-specific upstream bug - the workaround is in the actual code sample, not just mentioned in prose, so an implementer transcribing the code gets it correct by default.
- **Deviation from a "simpler" alternative, intentional:** Task 2 drops/recreates `clusters`/`graph_state` rather than attempting a column rename + backfill, because the old `session_id` values are random UUIDs with no mapping to real `auth.users` rows - a rename would either leave a dangling non-FK column or require inventing fake ownership, both worse than just letting a "Re-analyze" click regenerate real data.
