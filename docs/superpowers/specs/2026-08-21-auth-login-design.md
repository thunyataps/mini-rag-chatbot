# Login system (Supabase Auth) — design

Status: approved by user, ready for implementation plan
Date: 2026-08-21

## Goal

Replace the current anonymous, localStorage-`session_id`-based access model
with real authentication: email+password and "Sign in with Google", both
via Supabase Auth. Login becomes mandatory — every page except the
auth pages requires a signed-in session.

Non-goals (explicitly out of scope for this pass): password reset UI
beyond Supabase's own default flow, email verification UI polish beyond
Supabase's default confirmation email, TOTP/MFA (considered and explicitly
descoped by the user in favor of just email+password + Google), a
document-delete UI (still not part of the app — unchanged from before),
profile/account settings pages.

## Why this shape

Two decisions the user made explicitly, both binding:

1. **TOTP descoped.** Supabase Auth's TOTP is a second factor layered on
   top of a primary factor (email/password or magic link) — it can't be
   the sole login method. Given that, and given TOTP added real
   complexity for marginal benefit on a portfolio project, the user chose
   email+password (+ Google OAuth) with no MFA.
2. **Legacy anonymous data stays, and becomes visible to everyone.**
   Every document/chunk filed before this feature existed is tagged by a
   random, client-generated `session_id` that maps to no real user. Rather
   than delete this data or leave it permanently orphaned/inaccessible,
   it becomes shared read-only reference data: every authenticated user
   can see and query it, but no one (including the original "owner", since
   there isn't one) can edit or delete it through the app.

## Data model

`documents` gets a nullable `user_id uuid references auth.users(id) on
delete cascade`. `null` means "legacy/shared" — this is the only place
`null` is meaningful; every document filed from now on gets
`user_id = auth.uid()` and is never null.

**RLS becomes real** (this is the actual security upgrade this feature
buys, beyond just having a login page): today's RLS is permissive by
convention only (`using (true)` on nearly everything) — enforcement is
purely "the client happens to filter by session_id," not enforced by
Postgres. With real `auth.uid()` available, RLS starts doing its actual
job:

- `documents` SELECT: `user_id is null or auth.uid() = user_id` (see own +
  legacy).
- `documents` INSERT: `auth.uid() = user_id` (can only create documents you
  own — no filing anonymous/other-user documents).
- `documents` UPDATE/DELETE: `auth.uid() = user_id` (only the owner; legacy
  rows have no owner, so they become uneditable/undeletable by anyone
  through the app — matches the "leave them alone" decision above).
- `chunks`: no direct `user_id` column. Access is mediated by the parent
  document's ownership via an `exists (select 1 from documents where
  documents.id = chunks.document_id and ...)` subquery in each policy,
  mirroring the same null-is-shared / auth.uid()-is-owner rule.

**`clusters` and `graph_state` are dropped and recreated**, not migrated.
Their existing rows are keyed by the same meaningless anonymous
`session_id`s, they're pure cache/derived data (a "Re-analyze" click fully
regenerates them), and — unlike `documents`/`chunks` — there's no real
content being discarded, just a stale computed clustering. Recreated with
`user_id uuid references auth.users(id) on delete cascade` (not nullable —
every cluster run is scoped to the user who triggered it; legacy documents
still get pulled into whichever user's clustering/graph view includes
them, they just don't own the cluster analysis itself). Since
`chunks.cluster_id` has a foreign key into `clusters`, the migration must
null out every `chunks.cluster_id` before dropping the old `clusters`
table (or drop with `cascade` and re-add the FK after recreating) —
`needsRecompute`'s existing "any chunk has a null `cluster_id`" staleness
check means this requires no special-casing: every chunk simply looks
freshly-unclustered on first load after the migration, and recomputes
normally.

**RLS scoping simplification (important):** because Postgres RLS policies
apply automatically inside `language sql` functions run as the calling
user (the default — `SECURITY INVOKER`, not `SECURITY DEFINER`), the
`match_chunks_by_session` RPC no longer needs a manual
`match_session_id`/`match_user_id` filter parameter at all. Once RLS on
`chunks`/`documents` correctly restricts visible rows to "own + legacy,"
any query inside the RPC automatically only sees rows the caller is
allowed to see. The RPC is renamed `match_chunks_for_caller` (or similar)
and drops the id parameter entirely — retrieval scope is now enforced by
the database, not passed in as an argument the client could get wrong.
`match_chunks` (single-document scope) is unaffected in shape — it already
scoped by `document_id`; it implicitly gains the same RLS protection for
free.

## Auth flow

- `/login` — single page, toggles between "Sign in" and "Sign up" (email +
  password fields), plus a "Sign in with Google" button. Uses
  `@supabase/ssr`'s browser client for the actual auth calls.
- `/auth/callback` — a Route Handler that exchanges the OAuth/magic-link
  code for a session (the standard Supabase SSR pattern for Next.js App
  Router), then redirects to `/`.
- Supabase's default behavior (email confirmation required before
  sign-in) is left as-is — no code needed to support it, but it means a
  freshly-signed-up account can't sign in until the confirmation email is
  clicked. This is called out explicitly so it isn't mistaken for a bug
  during testing.
- Google OAuth requires manual setup outside this codebase: the user
  creates a Google Cloud OAuth client (Client ID + Secret) and enables the
  Google provider in the Supabase dashboard with those values. The app
  code renders the "Sign in with Google" button regardless — if the
  provider isn't configured yet, Supabase returns an error toast, but
  email+password auth works independently.

## Route protection

A `proxy.ts` file (Next.js 16 renamed `middleware.ts` → `proxy.ts`, the
Proxy convention — verified against the current Next.js docs, not
assumed) at the project root runs on every request, using `@supabase/ssr`
to read the session from cookies. Unauthenticated requests to any path
other than `/login`, `/auth/callback`, and Next's own internals
(`_next/*`, static assets) are redirected to `/login`. This is the
project's first server-side gate — Proxy defaults to the Node.js runtime,
which is what this project already relies on elsewhere (no Edge-runtime
assumptions to unwind).

## Client-side changes

- `src/lib/session.ts` (`getSessionId`, localStorage-based) is deleted —
  identity now comes from the real Supabase Auth session, not a
  client-generated id.
- New `src/hooks/useAuth.ts` (or a context provider) exposes the current
  user and a `signOut()` action, backed by `@supabase/ssr`'s browser
  client's `onAuthStateChange` listener.
- `useDocuments.ts`, `useGraph.ts`, and `buildGraph.ts` swap every
  `getSessionId()` call for the authenticated user's id from `useAuth()`
  (or, server-side in the RPC's case, nothing at all — see the RLS
  simplification above).
- Main page header gets a sign-out control.

## Testing plan

- Script-level: verify the RLS policies actually enforce what they claim
  (an authenticated user's client can see legacy + own documents but not
  another real user's; insert/update/delete rejected for non-owned rows) —
  this needs two real Supabase Auth test accounts created via the
  Supabase Admin API or `supabase.auth.signUp`, not just the anon key, so
  it's a heavier test than prior phases' throwaway scripts, but the same
  "insert, assert, clean up" pattern applies.
- `/auth/callback` and Proxy redirect behavior: verified via `curl`
  against the real dev server (unauthenticated request to `/` should
  redirect to `/login`; the login page itself must NOT redirect).
- Manual browser verification (sign up, confirm email, sign in, Google
  button, sign out) is explicitly flagged as pending on the user, per this
  whole session's known browser-automation limitation — same caveat as
  the knowledge graph feature.
