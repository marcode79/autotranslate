export type SpeakerTurn = { speakerId: number | null; transcript: string; translation: string };

const clean = (value: unknown) => typeof value === "string" ? value.trim() : "";

export function parseTranslation(text: string) {
  const parsed = JSON.parse(text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/, "").trim());
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid transcription response.");
  const turns: SpeakerTurn[] = [];
  if (Array.isArray(parsed.turns)) {
    for (const item of parsed.turns) {
      if (!item || typeof item !== "object") continue;
      const transcript = clean(item.transcript), translation = clean(item.translation);
      if (!transcript && !translation) continue;
      const speakerId = Number.isInteger(item.speakerId) && item.speakerId > 0 && item.speakerId <= 999
        ? item.speakerId as number : null;
      turns.push({ speakerId, transcript, translation });
    }
  }
  const format = (field: "transcript" | "translation") => turns.filter(turn => turn[field]).map(turn =>
    `${turn.speakerId === null ? "Participante sin identificar" : `Participante ${turn.speakerId}`}: ${turn[field]}`
  ).join("\n\n");
  return {
    turns,
    transcript: turns.length ? format("transcript") : clean(parsed.transcript),
    translation: turns.length ? format("translation") : clean(parsed.translation),
    detectedLanguage: clean(parsed.detectedLanguage) || "unknown",
    isFinal: Boolean(parsed.isFinal ?? true),
  };
}
