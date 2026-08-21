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
