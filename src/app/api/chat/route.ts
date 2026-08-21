import { NextRequest, NextResponse } from "next/server";
import { streamWithFallback } from "@/lib/gemini";
import { createClient } from "@/lib/supabase/server";

/**
 * RAG concept: augmented generation.
 *
 * This route is the "Generation" half of RAG. It never touches the whole
 * document - it only receives the handful of chunks the client already
 * retrieved as the most relevant to the question (see useDocuments.ts), and
 * asks the LLM to answer using only that context. This is what keeps
 * answers grounded in the user's own document instead of the model's
 * general training knowledge.
 *
 * The response is streamed back as plain text (one chunk per network
 * write), which is what lets the UI show tokens appearing one at a time
 * instead of waiting for the full answer.
 */
export async function POST(req: NextRequest) {
  // Self-defending, not relying on Proxy's matcher alone: an edit to the
  // matcher must never be able to turn this into an open, unauthenticated
  // proxy onto the server's Gemini key. It also means a request arriving
  // with a stale session cookie gets a clean 401 JSON error instead of
  // being redirected to /login and streamed into the chat UI as HTML.
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { question, context } = await req.json();

  if (!question || typeof question !== "string") {
    return NextResponse.json({ error: "Missing question" }, { status: 400 });
  }
  if (!context || typeof context !== "string") {
    return NextResponse.json({ error: "Missing context" }, { status: 400 });
  }
  if (!process.env.GEMINI_API_KEY) {
    return NextResponse.json(
      { error: "GEMINI_API_KEY is not set on the server" },
      { status: 500 }
    );
  }

  const systemPrompt = `You are a helpful assistant that answers questions using ONLY the document excerpts provided below. If the answer isn't contained in the excerpts, say you don't know instead of guessing. Answer in the same language the question was asked in.

Document excerpts:
${context}`;

  let geminiStream;
  try {
    const result = await streamWithFallback(question, systemPrompt);
    geminiStream = result.stream;
    console.log(`Answering with model: ${result.model}`);
  } catch (err) {
    console.error("All Gemini models failed:", err);
    return NextResponse.json({ error: "Gemini API request failed" }, { status: 500 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const chunk of geminiStream) {
          if (chunk.text) controller.enqueue(encoder.encode(chunk.text));
        }
        controller.close();
      } catch (err) {
        console.error("Gemini stream failed:", err);
        controller.error(err);
      }
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
