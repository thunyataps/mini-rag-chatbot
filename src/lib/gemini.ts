import { GoogleGenAI } from "@google/genai";

export const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

/**
 * Free-tier rate limits (RPM/TPM/RPD) are tracked per model, independently -
 * using up gemini-3.6-flash's quota doesn't touch gemini-3.5-flash's. So on
 * a 429 (rate limited) or 503 (overloaded) we just retry the same request
 * against the next model in this list instead of failing the request.
 * Verified working against this project's API key; gemini-2.5-flash and
 * gemini-2.5-flash-lite are deliberately excluded - Google retired them
 * ("no longer available to new users", 404).
 */
export const MODEL_FALLBACK_CHAIN = [
  "gemini-3.6-flash",
  "gemini-3.5-flash",
  "gemini-3.1-flash-lite",
  "gemini-3.5-flash-lite",
  "gemini-flash-lite-latest",
  "gemini-3.7-flash",
  "gemini-flash-latest",
];

export async function streamWithFallback(question: string, systemPrompt: string) {
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

/** Same fallback chain, but for a single non-streaming structured-JSON response. */
export async function generateJsonWithFallback<T>(
  prompt: string,
  responseSchema: object
): Promise<T> {
  let lastErr: unknown;
  for (const model of MODEL_FALLBACK_CHAIN) {
    try {
      const response = await ai.models.generateContent({
        model,
        contents: prompt,
        config: {
          responseMimeType: "application/json",
          responseSchema,
          temperature: 0.2,
        },
      });
      const text = response.text ?? "";
      return JSON.parse(text) as T;
    } catch (err) {
      console.error(`Gemini model "${model}" failed, trying next:`, err);
      lastErr = err;
    }
  }
  throw lastErr;
}
