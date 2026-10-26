import test from "node:test";
import assert from "node:assert/strict";
import { parseTranslation } from "../dist/src/services/speakerTurns.js";

test("keeps repeated speakers in order and aligns labels in both languages", () => {
  const result = parseTranslation(JSON.stringify({ turns: [
    { speakerId: 1, transcript: "Hello", translation: "Hola" },
    { speakerId: 2, transcript: "Hi", translation: "Buenas" },
    { speakerId: 1, transcript: "Ready?", translation: "¿Listo?" },
  ] }));
  assert.equal(result.transcript, "Participante 1: Hello\n\nParticipante 2: Hi\n\nParticipante 1: Ready?");
  assert.equal(result.translation, "Participante 1: Hola\n\nParticipante 2: Buenas\n\nParticipante 1: ¿Listo?");
});

test("does not invent identity or speech for uncertain or malformed turns", () => {
  const result = parseTranslation(JSON.stringify({ turns: [null, {},
    { speakerId: "Alice", transcript: "Hello", translation: "Hola" },
    { speakerId: -1, transcript: "Yes" },
  ] }));
  assert.equal(result.turns.length, 2);
  assert.ok(result.turns.every(turn => turn.speakerId === null));
  assert.equal(result.translation, "Participante sin identificar: Hola");
  assert.equal(parseTranslation('{"turns":[]}').transcript, "");
});

test("accepts legacy responses and JSON fences without losing text", () => {
  assert.equal(parseTranslation('```json\n{"transcript":"Hello","translation":"Hola"}\n```').transcript, "Hello");
  assert.throws(() => parseTranslation("not json"));
  assert.throws(() => parseTranslation("null"));
});
