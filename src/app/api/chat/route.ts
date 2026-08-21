import { NextRequest, NextResponse } from "next/server";
import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

/**
 * Free-tier rate limits (RPM/TPM/RPD) are tracked per model, independently -
 * using up gemini-3.6-flash's quota doesn't touch gemini-3.5-flash's. So on
 * a 429 (rate limited) or 503 (overloaded) we just retry the same request
 * against the next model in this list instead of failing the request.
 * Verified working against this project's API key; gemini-2.5-flash and
 * gemini-2.5-flash-lite are deliberately excluded - Google retired them
 * ("no longer available to new users", 404).
 */
const MODEL_FALLBACK_CHAIN = [
  "gemini-3.6-flash",
  "gemini-3.5-flash",
  "gemini-3.1-flash-lite",
  "gemini-3.5-flash-lite",
  "gemini-flash-lite-latest",
  "gemini-3.7-flash",
  "gemini-flash-latest",
];

async function startGeminiStream(question: string, systemPrompt: string) {
  let lastErr: unknown;
  for (const model of MODEL_FALLBACK_CHAIN) {
    try {
      const stream = await ai.models.generateContentStream({
        model,
        contents: question,
        config: { systemInstruction: systemPrompt, temperature: 0.2 },
      });
      return { stream, model };
    } catch (err) {
      console.error(`Gemini model "${model}" failed, trying next:`, err);
      lastErr = err;
    }
  }
  throw lastErr;
}

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
    const result = await startGeminiStream(question, systemPrompt);
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
