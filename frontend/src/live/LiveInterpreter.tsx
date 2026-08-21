import { useEffect, useRef, useState } from "react";
import { Activity, Check, Copy, Headphones, Mic, Pause, Play, Volume2, VolumeX } from "lucide-react";

type Api = (path: string, init?: RequestInit) => Promise<any>;
type Props = {
  token: string;
  api: Api;
  onFinished: () => void;
};

const LANGUAGES = [
  ["es", "Español"],
  ["en", "Inglés"],
  ["pt-BR", "Portugués (Brasil)"],
  ["fr", "Francés"],
  ["de", "Alemán"],
  ["it", "Italiano"],
];

function socketUrl() {
  const configured = import.meta.env.VITE_API_URL?.trim();
  const base = configured ? new URL(configured, window.location.href) : new URL(window.location.href);
  base.protocol = base.protocol === "https:" ? "wss:" : "ws:";
  base.pathname = "/api/live";
  base.search = "";
  base.hash = "";
  return base.toString();
}

function base64Bytes(value: string) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function append(previous: string, value: unknown) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return previous;
  return `${previous}${previous && !/^[,.;:!?)]/.test(text) ? " " : ""}${text}`.slice(-50_000);
}

export function LiveInterpreter({ token, api, onFinished }: Props) {
  const [available, setAvailable] = useState<boolean | null>(null);
  const [target, setTarget] = useState("es");
  const [includeMic, setIncludeMic] = useState(false);
  const [playVoice, setPlayVoice] = useState(true);
  const [status, setStatus] = useState("idle");
  const [error, setError] = useState("");
  const [transcript, setTranscript] = useState("");
  const [translation, setTranslation] = useState("");
  const [seconds, setSeconds] = useState(0);
  const [copied, setCopied] = useState(false);
  const socket = useRef<WebSocket | null>(null);
  const display = useRef<MediaStream | null>(null);
  const microphone = useRef<MediaStream | null>(null);
  const audioContext = useRef<AudioContext | null>(null);
  const worklet = useRef<AudioWorkletNode | null>(null);
  const nextPlayback = useRef(0);
  const startedAt = useRef(0);
  const clock = useRef<number | null>(null);
  const copiedTimer = useRef<number | null>(null);

  useEffect(() => {
    api("/api/live/config").then(result => setAvailable(Boolean(result.enabled))).catch(() => setAvailable(false));
    return () => {
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
      stop(false);
    };
  }, []);

  function playPcm(encoded: string) {
    if (!playVoice || !audioContext.current) return;
    const bytes = base64Bytes(encoded);
    const samples = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
    const buffer = audioContext.current.createBuffer(1, samples.length, 24_000);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < samples.length; i += 1) channel[i] = samples[i] / 32768;
    const source = audioContext.current.createBufferSource();
    source.buffer = buffer;
    source.connect(audioContext.current.destination);
    const now = audioContext.current.currentTime;
    nextPlayback.current = Math.max(now + 0.04, nextPlayback.current);
    source.start(nextPlayback.current);
    nextPlayback.current += buffer.duration;
  }

  function handleGemini(message: any) {
    const content = message?.serverContent;
    if (content?.inputTranscription?.text) setTranscript(value => append(value, content.inputTranscription.text));
    if (content?.outputTranscription?.text) setTranslation(value => append(value, content.outputTranscription.text));
    for (const part of content?.modelTurn?.parts || []) {
      if (part?.inlineData?.data) playPcm(part.inlineData.data);
    }
  }

  async function beginCapture(ws: WebSocket) {
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    if (!stream.getAudioTracks().length) {
      stream.getTracks().forEach(track => track.stop());
      throw new Error("La fuente seleccionada no comparte audio.");
    }
    display.current = stream;
    const context = new AudioContext();
    await context.audioWorklet.addModule("/live-pcm-worklet.js");
    await context.resume();
    const mix = context.createGain();
    context.createMediaStreamSource(new MediaStream(stream.getAudioTracks())).connect(mix);
    if (includeMic) {
      microphone.current = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      context.createMediaStreamSource(microphone.current).connect(mix);
    }
    const node = new AudioWorkletNode(context, "live-pcm-processor");
    const silent = context.createGain();
    silent.gain.value = 0;
    mix.connect(node);
    node.connect(silent).connect(context.destination);
    node.port.onmessage = event => {
      if (ws.readyState === WebSocket.OPEN) ws.send(event.data);
    };
    stream.getVideoTracks()[0]?.addEventListener("ended", () => stop());
    audioContext.current = context;
    worklet.current = node;
    startedAt.current = Date.now();
    clock.current = window.setInterval(() => setSeconds(Math.floor((Date.now() - startedAt.current) / 1000)), 1_000);
    setStatus("listening");
  }

  async function start() {
    setError("");
    setTranscript("");
    setTranslation("");
    setSeconds(0);
    setStatus("connecting");
    try {
      const created = await api("/api/conversations", {
        method: "POST",
        body: JSON.stringify({ sourceLanguage: "auto", targetLanguage: target, translationMode: "live" }),
      });
      const ws = new WebSocket(socketUrl());
      socket.current = ws;
      ws.binaryType = "arraybuffer";
      ws.onopen = () => ws.send(JSON.stringify({
        type: "start",
        accessToken: token,
        conversationId: created.conversation.id,
        targetLanguage: target,
      }));
      ws.onmessage = async event => {
        const data = JSON.parse(String(event.data));
        if (data.type === "ready") await beginCapture(ws);
        if (data.type === "gemini") handleGemini(data.message);
        if (data.type === "error") {
          setError(data.message || "La sesión Live se interrumpió.");
          stop();
        }
      };
      ws.onerror = () => {
        setError("No se pudo conectar con el intérprete Live.");
        stop();
      };
      ws.onclose = () => setStatus("paused");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "No se pudo iniciar el intérprete.");
      stop();
    }
  }

  function stop(refresh = true) {
    if (clock.current) clearInterval(clock.current);
    clock.current = null;
    worklet.current?.disconnect();
    worklet.current = null;
    microphone.current?.getTracks().forEach(track => track.stop());
    display.current?.getTracks().forEach(track => track.stop());
    microphone.current = null;
    display.current = null;
    void audioContext.current?.close();
    audioContext.current = null;
    socket.current?.close();
    socket.current = null;
    nextPlayback.current = 0;
    setStatus("paused");
    if (refresh) window.setTimeout(onFinished, 500);
  }

  async function copyChat() {
    const content = [`Original\n${transcript || "—"}`, `Traducción\n${translation || "—"}`].join("\n\n");
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
      copiedTimer.current = window.setTimeout(() => setCopied(false), 2_000);
    } catch {
      setError("No se pudo copiar el chat al portapapeles.");
    }
  }

  if (available === null) return <div className="l-panel p-8 text-sm">Verificando disponibilidad de Live…</div>;
  if (!available) {
    return <div className="l-panel p-8"><h2 className="font-semibold">Intérprete Live no habilitado</h2><p className="mt-2 text-sm text-muted-foreground">Activa LIVE_TRANSLATION_ENABLED en el backend. Inicialmente puede limitarse a administradores.</p></div>;
  }

  const active = status === "connecting" || status === "listening";
  return <div>
    {error && <div className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>}
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
      <div><h1 className="text-xl font-semibold">Intérprete en tiempo real</h1><p className="text-sm text-muted-foreground">Motor independiente en versión preliminar. Recomendamos usar auriculares.</p></div>
      <div className="flex gap-2">
        <button
          className="l-btn-muted px-3"
          disabled={!transcript && !translation}
          title={copied ? "Chat copiado" : "Copiar chat"}
          aria-label={copied ? "Chat copiado" : "Copiar chat"}
          onClick={copyChat}
        >
          {copied ? <Check className="h-4 w-4 text-green-600"/> : <Copy className="h-4 w-4"/>}
        </button>
        {active
          ? <button className="l-btn-muted" onClick={() => stop()}><Pause className="h-4 w-4"/>Finalizar</button>
          : <button className="l-btn-primary" onClick={start}><Play className="h-4 w-4"/>Iniciar Live</button>}
      </div>
    </div>
    <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
      <aside className="l-panel h-fit space-y-4 p-4">
        <label className="block"><span className="mb-1 block text-xs text-muted-foreground">Traducir a</span><select className="l-input" value={target} disabled={active} onChange={event => setTarget(event.target.value)}>{LANGUAGES.map(language => <option key={language[0]} value={language[0]}>{language[1]}</option>)}</select></label>
        <label className="flex items-center justify-between rounded-md border p-3 text-sm"><span className="flex items-center gap-2"><Mic className="h-4 w-4"/>Incluir micrófono</span><input type="checkbox" checked={includeMic} disabled={active} onChange={event => setIncludeMic(event.target.checked)}/></label>
        <label className="flex items-center justify-between rounded-md border p-3 text-sm"><span className="flex items-center gap-2">{playVoice ? <Volume2 className="h-4 w-4"/> : <VolumeX className="h-4 w-4"/>}Reproducir traducción</span><input type="checkbox" checked={playVoice} onChange={event => setPlayVoice(event.target.checked)}/></label>
        <div className="rounded-md bg-blue-50 p-3 text-xs text-blue-800"><Headphones className="mr-2 inline h-4 w-4"/>Usa auriculares para evitar que el audio traducido vuelva a capturarse.</div>
        <div className="rounded-md bg-muted p-3 text-sm"><Activity className={`mr-2 inline h-4 w-4 ${status === "listening" ? "text-green-600" : ""}`}/>{status} · {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}</div>
      </aside>
      <div className="grid gap-4 xl:grid-cols-2">
        <LiveColumn title="Original" text={transcript}/>
        <LiveColumn title="Traducción" text={translation}/>
      </div>
    </div>
  </div>;
}

function LiveColumn({ title, text }: { title: string; text: string }) {
  const scroll = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
    });
    return () => cancelAnimationFrame(frame);
  }, [text]);
  return <div className="l-panel flex h-[65vh] min-h-[420px] flex-col overflow-hidden"><div className="shrink-0 border-b p-3 font-medium">{title}</div><div ref={scroll} className="min-h-0 flex-1 overflow-y-auto p-5"><p className="whitespace-pre-wrap text-sm leading-7">{text || "El contenido aparecerá aquí mientras se escucha."}</p></div></div>
}
