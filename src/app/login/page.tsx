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
