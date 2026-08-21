import type { Server as HttpServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { adminClient, createUserClient } from "../lib/supabase.js";
import { finalizeUsage, releaseUsage, reserveUsage, type Reservation } from "../services/quota.service.js";

type ClientSetup = {
  type: "start";
  accessToken: string;
  conversationId: string;
  targetLanguage: string;
};

type LiveState = {
  userId: string;
  conversationId: string;
  startedAt: number;
  accountedAt: number;
  reservation?: Reservation;
  inputTranscript: string;
  outputTranscript: string;
  inputTokens: number;
  outputTokens: number;
  lastInputTokens: number;
  lastOutputTokens: number;
};

const activeUsers = new Set<string>();
const MODEL = process.env.GEMINI_LIVE_MODEL?.trim() || "gemini-3.5-live-translate-preview";
const GOOGLE_WS =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";
const MAX_UPSTREAM_RECONNECTS = 5;
const MAX_BUFFERED_AUDIO_CHUNKS = 30;

const isEnabled = () => process.env.LIVE_TRANSLATION_ENABLED?.trim().toLowerCase() === "true";

function sendJson(socket: WebSocket, message: unknown) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function append(current: string, incoming: unknown) {
  const value = typeof incoming === "string" ? incoming.trim() : "";
  if (!value) return current;
  return `${current}${current && !/^[,.;:!?)]/.test(value) ? " " : ""}${value}`.slice(-50_000);
}

function captureMessage(message: any, state: LiveState) {
  const usage = message?.usageMetadata;
  if (usage) {
    const nextInput = Number(usage.promptTokenCount || 0);
    const nextOutput = Number(usage.responseTokenCount || usage.candidatesTokenCount || 0);
    state.inputTokens += nextInput >= state.lastInputTokens ? nextInput - state.lastInputTokens : nextInput;
    state.outputTokens += nextOutput >= state.lastOutputTokens ? nextOutput - state.lastOutputTokens : nextOutput;
    state.lastInputTokens = nextInput;
    state.lastOutputTokens = nextOutput;
  }
  const content = message?.serverContent;
  if (content) {
    state.inputTranscript = append(state.inputTranscript, content.inputTranscription?.text);
    state.outputTranscript = append(state.outputTranscript, content.outputTranscription?.text);
  }
}

function estimatedCost(durationMs: number) {
  const usdPerMinute = Number(process.env.GEMINI_LIVE_ESTIMATED_USD_PER_MINUTE || "0");
  return Math.max(0, Math.ceil(durationMs / 60_000 * usdPerMinute * 1_000_000));
}

async function account(state: LiveState, final = false) {
  const now = Date.now();
  const durationMs = Math.max(0, now - state.accountedAt);
  if (!state.reservation || (!final && durationMs < 25_000)) return;
  const reservation = state.reservation;
  state.reservation = undefined;
  if (durationMs) {
    const tokens = state.inputTokens + state.outputTokens;
    const cost = estimatedCost(durationMs);
    await finalizeUsage(state.userId, reservation, durationMs, tokens, cost);
    const { error } = await adminClient().from("ai_usage_events").insert({
      user_id: state.userId,
      conversation_id: state.conversationId,
      model: MODEL,
      prompt_tokens: state.inputTokens,
      output_tokens: state.outputTokens,
      total_tokens: tokens,
      audio_duration_ms: durationMs,
      estimated_cost_micros: cost,
      price_snapshot: {
        mode: "live",
        estimatedUsdPerMinute: Number(process.env.GEMINI_LIVE_ESTIMATED_USD_PER_MINUTE || "0"),
      },
    });
    if (error) throw error;
    state.inputTokens = 0;
    state.outputTokens = 0;
  } else {
    await releaseUsage(state.userId, reservation);
  }
  state.accountedAt = now;
  if (!final) state.reservation = await reserveUsage(state.userId, 30_000);
}

async function authorize(setup: ClientSetup) {
  if (!isEnabled()) throw new Error("El intérprete Live no está habilitado.");
  const { data, error } = await createUserClient(setup.accessToken).auth.getUser();
  if (error || !data.user) throw new Error("Sesión inválida o expirada.");
  const db = adminClient();
  const [{ data: profile, error: profileError }, { data: conversation, error: conversationError }] = await Promise.all([
    db.from("profiles").select("role,access_status").eq("id", data.user.id).single(),
    db.from("conversations").select("id,user_id,translation_mode").eq("id", setup.conversationId).single(),
  ]);
  if (profileError || profile?.access_status !== "approved") throw new Error("Tu cuenta no está aprobada.");
  const adminOnly = process.env.LIVE_TRANSLATION_ADMIN_ONLY?.trim().toLowerCase() !== "false";
  if (adminOnly && profile.role !== "admin") throw new Error("Live está disponible únicamente para pruebas administrativas.");
  if (conversationError || conversation?.user_id !== data.user.id || conversation.translation_mode !== "live") {
    throw new Error("La conversación Live no es válida.");
  }
  if (activeUsers.has(data.user.id)) throw new Error("Ya tienes una sesión Live activa.");
  return data.user.id;
}

async function persist(state: LiveState) {
  const db = adminClient();
  if (state.inputTranscript || state.outputTranscript) {
    const { error } = await db.from("conversation_segments").insert({
      conversation_id: state.conversationId,
      user_id: state.userId,
      transcript: state.inputTranscript,
      translation: state.outputTranscript,
      detected_language: "auto",
      audio_duration_ms: Math.max(0, Date.now() - state.startedAt),
    });
    if (error) throw error;
  }
  await db.from("conversations").update({ ended_at: new Date().toISOString() })
    .eq("id", state.conversationId).eq("user_id", state.userId);
}

export function attachLiveGateway(server: HttpServer) {
  const wss = new WebSocketServer({ server, path: "/api/live" });
  wss.on("connection", client => {
    let upstream: WebSocket | undefined;
    let state: LiveState | undefined;
    let timer: NodeJS.Timeout | undefined;
    let reconnectTimer: NodeJS.Timeout | undefined;
    let closing = false;
    let upstreamGeneration = 0;
    let reconnectAttempts = 0;
    let resumptionHandle: string | undefined;
    let clientReady = false;
    let upstreamReady = false;
    const pendingAudio: Buffer[] = [];

    const close = async () => {
      if (closing) return;
      closing = true;
      if (timer) clearInterval(timer);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      upstream?.close();
      if (state) {
        activeUsers.delete(state.userId);
        try {
          await account(state, true);
          await persist(state);
        } catch (error) {
          console.error("Live session finalization failed", error);
          if (state.reservation) await releaseUsage(state.userId, state.reservation).catch(() => {});
        }
      }
      if (client.readyState === WebSocket.OPEN) client.close();
    };

    client.once("message", async raw => {
      try {
        const setup = JSON.parse(raw.toString()) as ClientSetup;
        if (setup.type !== "start" || !setup.accessToken || !setup.conversationId || !setup.targetLanguage) {
          throw new Error("Configuración Live incompleta.");
        }
        const userId = await authorize(setup);
        const initialReservation = await reserveUsage(userId, 30_000);
        activeUsers.add(userId);
        state = {
          userId,
          conversationId: setup.conversationId,
          startedAt: Date.now(),
          accountedAt: Date.now(),
          reservation: initialReservation,
          inputTranscript: "",
          outputTranscript: "",
          inputTokens: 0,
          outputTokens: 0,
          lastInputTokens: 0,
          lastOutputTokens: 0,
        };
        const apiKey = process.env.GEMINI_API_KEY?.trim();
        if (!apiKey) throw new Error("Falta GEMINI_API_KEY.");
        const sendAudio = (socket: WebSocket, audio: Buffer) => socket.send(JSON.stringify({
          realtimeInput: {
            audio: {
              data: audio.toString("base64"),
              mimeType: "audio/pcm;rate=16000",
            },
          },
        }));

        const connectUpstream = (handle?: string) => {
          if (closing) return;
          if (reconnectTimer) clearTimeout(reconnectTimer);
          reconnectTimer = undefined;
          const generation = ++upstreamGeneration;
          const socket = new WebSocket(`${GOOGLE_WS}?key=${encodeURIComponent(apiKey)}`);
          upstream = socket;
          upstreamReady = false;
          console.info("Opening Gemini Live connection", { generation, resumed: Boolean(handle), attempt: reconnectAttempts });

          socket.on("open", () => socket.send(JSON.stringify({
            setup: {
              model: `models/${MODEL}`,
              generationConfig: {
                responseModalities: ["AUDIO"],
                translationConfig: {
                  targetLanguageCode: setup.targetLanguage,
                  echoTargetLanguage: false,
                },
              },
              inputAudioTranscription: {},
              outputAudioTranscription: {},
              contextWindowCompression: { slidingWindow: {} },
              sessionResumption: handle ? { handle } : {},
            },
          })));

          socket.on("message", data => {
            if (generation !== upstreamGeneration || closing) return;
            try {
              const message = JSON.parse(data.toString());
              if (state) captureMessage(message, state);
              const update = message.sessionResumptionUpdate;
              if (update?.resumable && typeof update.newHandle === "string") {
                resumptionHandle = update.newHandle;
              }
              if (message.goAway) {
                console.info("Gemini Live requested connection rotation", {
                  generation,
                  timeLeft: message.goAway.timeLeft,
                  resumable: Boolean(resumptionHandle),
                });
                rotateUpstream("goAway");
              }
              if (message.setupComplete) {
                reconnectAttempts = 0;
                upstreamReady = true;
                while (pendingAudio.length && socket.readyState === WebSocket.OPEN) {
                  sendAudio(socket, pendingAudio.shift()!);
                }
                if (!clientReady) {
                  clientReady = true;
                  sendJson(client, { type: "ready", model: MODEL });
                } else {
                  sendJson(client, { type: "reconnected", model: MODEL });
                }
              }
              if (message.error) sendJson(client, { type: "error", message: message.error.message || "Gemini rechazó la sesión Live." });
              sendJson(client, { type: "gemini", message });
            } catch (error) {
              console.error("Invalid Gemini Live message", error);
            }
          });
          socket.on("error", error => console.error("Gemini Live WebSocket error", { generation, message: error.message }));
          socket.on("close", (code, reasonBuffer) => {
            if (generation !== upstreamGeneration || closing) return;
            upstreamReady = false;
            const reason = reasonBuffer.toString();
            console.warn("Gemini Live connection closed", { generation, code, reason, resumable: Boolean(resumptionHandle) });
            const retryable = ![1002, 1003, 1007, 1008].includes(code);
            if (retryable && reconnectAttempts < MAX_UPSTREAM_RECONNECTS) {
              reconnectAttempts += 1;
              const delay = Math.min(4_000, 250 * 2 ** (reconnectAttempts - 1));
              sendJson(client, { type: "reconnecting", attempt: reconnectAttempts });
              reconnectTimer = setTimeout(() => connectUpstream(resumptionHandle), delay);
              return;
            }
            sendJson(client, { type: "error", message: `Gemini Live cerró la conexión (${code})${reason ? `: ${reason}` : "."}` });
            void close();
          });
        };

        const rotateUpstream = (cause: string) => {
          if (closing) return;
          const previous = upstream;
          console.info("Rotating Gemini Live connection", { cause, resumable: Boolean(resumptionHandle) });
          connectUpstream(resumptionHandle);
          previous?.close(1000, "Rotating Gemini Live connection");
        };

        connectUpstream();
        sendJson(client, { type: "connected", model: MODEL });
        timer = setInterval(() => {
          if (!state) return;
          account(state).catch(error => {
            sendJson(client, { type: "error", message: error instanceof Error ? error.message : "Límite alcanzado." });
            void close();
          });
        }, 5_000);

        client.on("message", (audio, isBinary) => {
          if (!isBinary) return;
          const chunk = Buffer.from(audio as Buffer);
          if (upstreamReady && upstream?.readyState === WebSocket.OPEN) {
            sendAudio(upstream, chunk);
            return;
          }
          pendingAudio.push(chunk);
          if (pendingAudio.length > MAX_BUFFERED_AUDIO_CHUNKS) pendingAudio.shift();
        });
      } catch (error) {
        sendJson(client, { type: "error", message: error instanceof Error ? error.message : "No se pudo iniciar Live." });
        await close();
      }
    });
    client.on("close", () => void close());
    client.on("error", () => void close());
  });
  return wss;
}
