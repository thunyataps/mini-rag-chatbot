"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useGraph } from "@/hooks/useGraph";
import { CLUSTER_PALETTE } from "@/lib/graph/palette";
import type { GraphNode } from "@/lib/graph/types";

// Fallbacks only - the real colors are read from the --ink/--line CSS custom
// properties at render time so the graph follows light/dark mode (the canvas
// is transparent, so the page background shows through behind the nodes).
const DOCUMENT_COLOR = "#1b2e2b";
const LINK_COLOR = "#c9bfa0";
const NEUTRAL_CHUNK_COLOR = "#8a8a7a";

export default function GraphPage() {
  const { data, isLoading, isRecomputing, error, recompute } = useGraph();
  const containerRef = useRef<HTMLDivElement>(null);
  // `any` here is the instantiated imperative graph object - see the cast
  // inside the effect below for why it can't be typed from the shipped .d.ts.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const graphInstanceRef = useRef<any>(null);
  const [selected, setSelected] = useState<GraphNode | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!data || data.nodes.length === 0 || !container) return;

    let disposed = false;

    const styles = getComputedStyle(document.documentElement);
    const inkColor = styles.getPropertyValue("--ink").trim() || DOCUMENT_COLOR;
    const lineColor = styles.getPropertyValue("--line").trim() || LINK_COLOR;

    import("3d-force-graph").then((mod) => {
      if (disposed) return;

      // Cast to `any`: the shipped .d.ts declares the default export only as
      // a `new (element, ...)` constructor, but the installed library is
      // Kapsule-based at runtime and is called as the factory form used here
      // (`ForceGraph3D()(container)`), which that declaration can't express.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ForceGraph3D = mod.default as any;
      const graph = ForceGraph3D()(container)
        .graphData({
          nodes: data.nodes.map((n) => ({ ...n })),
          links: data.links.map((l) => ({ ...l })),
        })
        .nodeLabel((node: GraphNode) =>
          node.kind === "document" ? node.name : (node.content ?? node.name).slice(0, 80)
        )
        .nodeColor((node: GraphNode) => {
          if (node.kind === "document") return inkColor;
          return node.colorIndex != null
            ? CLUSTER_PALETTE[node.colorIndex % CLUSTER_PALETTE.length]
            : NEUTRAL_CHUNK_COLOR;
        })
        .nodeVal((node: GraphNode) => (node.kind === "document" ? 8 : 2))
        .linkOpacity((link: { kind: string }) => (link.kind === "structural" ? 0.15 : 0.4))
        .linkColor((link: { kind: string }) =>
          link.kind === "structural" ? lineColor : CLUSTER_PALETTE[0]
        )
        .onNodeClick((node: GraphNode) => setSelected(node))
        .backgroundColor("rgba(0,0,0,0)");

      const controls = graph.controls();
      controls.autoRotate = true;
      controls.autoRotateSpeed = 0.6;
      controls.addEventListener("start", () => {
        controls.autoRotate = false;
      });

      graphInstanceRef.current = graph;
    });

    return () => {
      disposed = true;
      // Clearing innerHTML only detaches the canvas - the renderer's animation
      // loop and its WebGL context keep running. Since this effect re-runs on
      // every recompute, skipping the destructor would strand a live GL context
      // each time (browsers cap concurrent contexts at ~16).
      if (graphInstanceRef.current && typeof graphInstanceRef.current._destructor === "function") {
        graphInstanceRef.current._destructor();
      }
      container.innerHTML = "";
      graphInstanceRef.current = null;
      // Tearing down this graph also invalidates anything the side panel is
      // showing - after a "Re-analyze" the selected node belongs to the old
      // graph and can carry a stale cluster label. (Done here rather than at
      // the top of the effect body: React forbids a synchronous setState
      // there, and the cleanup runs on exactly the same `data` changes.)
      setSelected(null);
    };
  }, [data]);

  return (
    <div className="relative min-h-screen bg-paper text-ink">
      <header className="absolute top-0 right-0 left-0 z-10 flex flex-wrap items-center justify-between gap-3 border-b border-line bg-paper/90 px-4 py-3 backdrop-blur">
        <div className="flex items-center gap-3">
          <Link href="/" className="font-mono text-[11px] text-ink-soft hover:text-ink">
            ← Back to archive
          </Link>
          <h1 className="font-display text-lg text-ink">Knowledge graph</h1>
        </div>
        <button
          onClick={() => recompute()}
          disabled={isRecomputing}
          className="rounded-sm bg-ink px-4 py-1.5 text-xs font-medium text-card transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {isRecomputing ? "Analyzing…" : "Re-analyze"}
        </button>
      </header>

      {isLoading && (
        <p className="pt-24 text-center font-mono text-sm text-ink-soft">Loading graph…</p>
      )}

      {!isLoading && error && (
        <p className="pt-24 text-center font-mono text-sm text-danger">{error}</p>
      )}

      {!isLoading && !error && data && data.nodes.length === 0 && (
        <p className="pt-24 text-center font-mono text-sm text-ink-soft">
          No documents filed yet — go back and add one first.
        </p>
      )}

      <div ref={containerRef} className="h-screen w-full" />

      {data && data.clusters.length > 0 && (
        <div className="absolute bottom-4 left-4 z-10 flex flex-col gap-1 rounded border border-line bg-card/90 p-3 backdrop-blur">
          {data.clusters.map((c) => (
            <div key={c.id} className="flex items-center gap-2 font-mono text-[11px] text-ink">
              <span
                className="h-2 w-2 rounded-full"
                style={{ backgroundColor: CLUSTER_PALETTE[c.colorIndex % CLUSTER_PALETTE.length] }}
              />
              {c.label}
            </div>
          ))}
        </div>
      )}

      {selected && (
        <div className="absolute top-20 right-4 z-10 w-72 rounded border border-line bg-card p-4 shadow-lg">
          <button
            onClick={() => setSelected(null)}
            className="mb-2 font-mono text-[11px] text-ink-soft hover:text-ink"
          >
            ✕ close
          </button>
          {selected.kind === "chunk" ? (
            <>
              <p className="mb-1 font-mono text-[11px] text-ink-soft">
                from “{selected.documentName}” · {selected.clusterLabel ?? "uncategorized"}
              </p>
              <p className="font-mono text-xs leading-relaxed text-ink">{selected.content}</p>
            </>
          ) : (
            <p className="font-mono text-xs text-ink">{selected.name}</p>
          )}
        </div>
      )}
    </div>
  );
}
