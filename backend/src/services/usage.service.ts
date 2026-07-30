export type UsageMetadata = {
  promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number; totalTokenCount?: number;
  promptTokensDetails?: Array<{ modality?: string; tokenCount?: number }>;
};

function price(name: string, fallback: number) { const value = Number(process.env[name]); return Number.isFinite(value) ? value : fallback; }
export function calculateCost(metadata: UsageMetadata) {
  const audioTokens = metadata.promptTokensDetails?.filter(x => x.modality === "AUDIO").reduce((n,x) => n + (x.tokenCount ?? 0),0) ?? 0;
  const promptTokens = metadata.promptTokenCount ?? 0;
  const textInputTokens = Math.max(0, promptTokens - audioTokens);
  const outputTokens = metadata.candidatesTokenCount ?? 0;
  const thinkingTokens = metadata.thoughtsTokenCount ?? 0;
  const rates = { audioInput: price("GEMINI_AUDIO_INPUT_USD_PER_MILLION",0.30), textInput: price("GEMINI_TEXT_INPUT_USD_PER_MILLION",0.10), output: price("GEMINI_OUTPUT_USD_PER_MILLION",0.40) };
  const usd = (audioTokens*rates.audioInput + textInputTokens*rates.textInput + (outputTokens+thinkingTokens)*rates.output)/1_000_000;
  return { audioTokens, textInputTokens, outputTokens, thinkingTokens, totalTokens: metadata.totalTokenCount ?? promptTokens+outputTokens+thinkingTokens, estimatedCostMicros: Math.ceil(usd*1_000_000), rates };
}
