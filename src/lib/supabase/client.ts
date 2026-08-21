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
