"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchGraphData, forceRecompute } from "@/lib/graph/buildGraph";
import { useAuth } from "@/hooks/useAuth";
import type { GraphData } from "@/lib/graph/types";

export function useGraph() {
  const { user } = useAuth();
  // Depend on the id, not the User object - Supabase hands back a new object
  // on token refresh / tab-focus re-emit, which would otherwise re-run the
  // whole graph load (and, before clustering was cached properly, a Gemini
  // labeling call) each time.
  const userId = user?.id;
  const [data, setData] = useState<GraphData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isRecomputing, setIsRecomputing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!userId) return;
    setError(null);
    try {
      const graph = await fetchGraphData(userId);
      setData(graph);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load graph");
    }
  }, [userId]);

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    (async () => {
      setIsLoading(true);
      await load();
      if (!cancelled) setIsLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [load, userId]);

  const recompute = useCallback(async () => {
    // Reachable if the session drops while the page is open.
    if (!userId) {
      setError("You're signed out — please sign in again.");
      return;
    }
    setIsRecomputing(true);
    setError(null);
    try {
      await forceRecompute(userId);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to re-analyze");
    } finally {
      setIsRecomputing(false);
    }
  }, [load, userId]);

  return { data, isLoading, isRecomputing, error, recompute };
}
