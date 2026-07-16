import { GoogleGenerativeAI } from "@google/generative-ai";

type TranslateAudioParams = {
  audioBase64: string;
  mimeType: string;
  sourceLanguage: string;
  targetLanguage: string;
  previousContext: string;
};

type TranslateAudioResult = {
  transcript: string;
  translation: string;
  detectedLanguage: string;
  isFinal: boolean;
};

const MODEL_FALLBACKS = ["gemini-2.5-flash-lite", "gemini-2.5-flash", "gemini-1.5-flash"];
const LANGUAGE_NAMES: Record<string, string> = {
  auto: "auto-detect",
  en: "English",
  es: "Spanish",
  pt: "Portuguese",
  fr: "French",
};

function modelCandidates(): string[] {
  const preferred = (process.env.GEMINI_MODEL || "").split("#")[0].trim();
  if (!preferred) return MODEL_FALLBACKS;
  return [preferred, ...MODEL_FALLBACKS.filter((m) => m !== preferred)];
}

function parseJsonPayload(text: string): TranslateAudioResult {
  const cleaned = text
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim();
  const parsed = JSON.parse(cleaned) as Partial<TranslateAudioResult>;
  return {
    transcript: String(parsed.transcript || "").trim(),
    translation: String(parsed.translation || "").trim(),
    detectedLanguage: String(parsed.detectedLanguage || "unknown").trim(),
    isFinal: Boolean(parsed.isFinal ?? true),
  };
}

function isModelFallbackError(err: unknown): boolean {
  const msg = String((err as { message?: string })?.message ?? err ?? "").toLowerCase();
  return msg.includes("model") && (msg.includes("not found") || msg.includes("unexpected model name format"));
}

export async function translateAudioChunk(params: TranslateAudioParams): Promise<TranslateAudioResult> {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("Missing GEMINI_API_KEY in backend/.env.");
  }

  const genAI = new GoogleGenerativeAI(apiKey);
  const sourceLanguage = LANGUAGE_NAMES[params.sourceLanguage] ?? params.sourceLanguage;
  const targetLanguage = LANGUAGE_NAMES[params.targetLanguage] ?? params.targetLanguage;
  const prompt = [
    "You are a low-latency meeting interpreter.",
    "Transcribe only the speech in this audio chunk and translate it.",
    "Return strict JSON only with these fields: transcript, translation, detectedLanguage, isFinal.",
    "transcript must be in the original spoken language. translation must be in the requested target language.",
    `The translation field must always be written in ${targetLanguage}, even if the detected speech is already ${targetLanguage}.`,
    `Do not translate into any language other than ${targetLanguage}.`,
    sourceLanguage === "auto-detect"
      ? "Detect the spoken source language from the audio."
      : `Expected source language is ${sourceLanguage}. If the audio is actually another language, still keep transcript as spoken and keep translation in ${targetLanguage}.`,
    "If there is no clear speech, return empty strings.",
    `Source language hint: ${sourceLanguage}. Target language: ${targetLanguage}.`,
    params.previousContext
      ? `Recent same-direction context for wording only. Do not infer target language from it; target language remains ${targetLanguage}: ${params.previousContext.slice(-600)}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");

  let lastError: unknown = null;
  for (const modelName of modelCandidates()) {
    try {
      const model = genAI.getGenerativeModel({
        model: modelName,
        generationConfig: {
          temperature: 0,
          topP: 1,
          candidateCount: 1,
          responseMimeType: "application/json",
        } as any,
      });

      const response = await model.generateContent([
        { text: prompt },
        {
          inlineData: {
            mimeType: params.mimeType,
            data: params.audioBase64,
          },
        },
      ]);

      return parseJsonPayload(response.response.text());
    } catch (err) {
      lastError = err;
      if (isModelFallbackError(err)) continue;
      throw err;
    }
  }

  throw lastError ?? new Error("Gemini model unavailable.");
}
