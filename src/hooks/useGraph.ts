"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchGraphData, forceRecompute } from "@/lib/graph/buildGraph";
import { getSessionId } from "@/lib/session";
import type { GraphData } from "@/lib/graph/types";

export function useGraph() {
  const [data, setData] = useState<GraphData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isRecomputing, setIsRecomputing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const graph = await fetchGraphData(getSessionId());
      setData(graph);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load graph");
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setIsLoading(true);
      await load();
      if (!cancelled) setIsLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [load]);

  const recompute = useCallback(async () => {
    setIsRecomputing(true);
    setError(null);
    try {
      await forceRecompute(getSessionId());
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to re-analyze");
    } finally {
      setIsRecomputing(false);
    }
  }, [load]);

  return { data, isLoading, isRecomputing, error, recompute };
}
