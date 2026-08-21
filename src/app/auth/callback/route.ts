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
