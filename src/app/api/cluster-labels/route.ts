import { NextRequest, NextResponse } from "next/server";
import { generateJsonWithFallback } from "@/lib/gemini";

interface ClusterSample {
  id: number;
  samples: string[];
}

interface ClusterLabelResult {
  id: number;
  label: string;
}

const RESPONSE_SCHEMA = {
  type: "array",
  items: {
    type: "object",
    properties: {
      id: { type: "integer" },
      label: { type: "string" },
    },
    required: ["id", "label"],
  },
};

/**
 * One Gemini call labels every cluster at once (not one call per cluster) -
 * free-tier RPM/RPD is too scarce to spend per-cluster (see src/lib/gemini.ts).
 */
export async function POST(req: NextRequest) {
  const { clusters } = (await req.json()) as { clusters: ClusterSample[] };

  if (!Array.isArray(clusters) || clusters.length === 0) {
    return NextResponse.json({ error: "Missing clusters" }, { status: 400 });
  }
  if (!process.env.GEMINI_API_KEY) {
    return NextResponse.json(
      { error: "GEMINI_API_KEY is not set on the server" },
      { status: 500 }
    );
  }

  const prompt = `You will be given several groups of short text excerpts, each pulled from the same topic cluster in a document collection. For each group, respond with a short 1-3 word topic label that describes what that group is about.

${clusters
  .map((c) => `Cluster ${c.id}:\n${c.samples.map((s) => `- ${s.slice(0, 300)}`).join("\n")}`)
  .join("\n\n")}

Respond with a JSON array matching the schema, one entry per cluster id above.`;

  try {
    const labels = await generateJsonWithFallback<ClusterLabelResult[]>(prompt, RESPONSE_SCHEMA);
    return NextResponse.json({ labels });
  } catch (err) {
    console.error("Cluster labeling failed:", err);
    return NextResponse.json({ error: "Cluster labeling failed" }, { status: 500 });
  }
}
