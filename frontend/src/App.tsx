import { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  AudioLines,
  Captions,
  Copy,
  Languages,
  MonitorUp,
  Pause,
  Play,
  RotateCcw,
  Shield,
  LogOut,
  Settings2,
} from "lucide-react";

type Segment = {
  id: string;
  transcript: string;
  translation: string;
  detectedLanguage: string;
  createdAt: string;
};

type TranslateResponse = {
  ok: boolean;
  transcript: string;
  translation: string;
  detectedLanguage: string;
  message?: string;
};

type AuthStatusResponse = {
  ok: boolean;
  authenticated: boolean;
};

const API_URL = import.meta.env.VITE_API_URL || "";
const CHUNK_OPTIONS = [3500, 5000, 8000, 12000];

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = String(reader.result || "");
      resolve(result.includes(",") ? result.split(",")[1] : result);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function flattenBuffers(buffers: Float32Array[]): Float32Array {
  const length = buffers.reduce((sum, buffer) => sum + buffer.length, 0);
  const result = new Float32Array(length);
  let offset = 0;
  for (const buffer of buffers) {
    result.set(buffer, offset);
    offset += buffer.length;
  }
  return result;
}

function isMostlySilent(buffers: Float32Array[]): boolean {
  const samples = flattenBuffers(buffers);
  if (!samples.length) return true;
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) {
    sum += samples[i] * samples[i];
  }
  const rms = Math.sqrt(sum / samples.length);
  return rms < 0.008;
}

function encodeWav(buffers: Float32Array[], sampleRate: number): Blob {
  const samples = flattenBuffers(buffers);
  const bytesPerSample = 2;
  const blockAlign = bytesPerSample;
  const buffer = new ArrayBuffer(44 + samples.length * bytesPerSample);
  const view = new DataView(buffer);

  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + samples.length * bytesPerSample, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, samples.length * bytesPerSample, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i += 1, offset += 2) {
    const sample = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }

  return new Blob([view], { type: "audio/wav" });
}

function writeAscii(view: DataView, offset: number, value: string) {
  for (let i = 0; i < value.length; i += 1) {
    view.setUint8(offset + i, value.charCodeAt(i));
  }
}

function pairedTargetFor(source: string): string | null {
  if (source === "es") return "en";
  if (source === "en") return "es";
  return null;
}

export default function App() {
  const [segments, setSegments] = useState<Segment[]>([]);
  const [authStatus, setAuthStatus] = useState<"checking" | "authenticated" | "anonymous">("checking");
  const [loginPassword, setLoginPassword] = useState("");
  const [loginError, setLoginError] = useState("");
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [status, setStatus] = useState<"idle" | "selecting" | "listening" | "paused" | "error">("idle");
  const [error, setError] = useState("");
  const [sourceLanguage, setSourceLanguage] = useState("auto");
  const [targetLanguage, setTargetLanguage] = useState("es");
  const [chunkMs, setChunkMs] = useState(5000);
  const [includeMicrophone, setIncludeMicrophone] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [sourceLabel, setSourceLabel] = useState("Ninguna fuente seleccionada");
  const streamRef = useRef<MediaStream | null>(null);
  const microphoneStreamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const chunkTimerRef = useRef<number | null>(null);
  const audioBuffersRef = useRef<Float32Array[]>([]);
  const sampleRateRef = useRef(48000);
  const queueRef = useRef<Promise<void>>(Promise.resolve());
  const sourceLanguageRef = useRef(sourceLanguage);
  const targetLanguageRef = useRef(targetLanguage);
  const latestContextRef = useRef("");
  const configVersionRef = useRef(0);

  const latestContext = useMemo(
    () =>
      segments
        .slice(0, 5)
        .map((segment) => `${segment.transcript} -> ${segment.translation}`)
        .reverse()
        .join("\n"),
    [segments]
  );

  useEffect(() => {
    sourceLanguageRef.current = sourceLanguage;
  }, [sourceLanguage]);

  useEffect(() => {
    targetLanguageRef.current = targetLanguage;
  }, [targetLanguage]);

  useEffect(() => {
    latestContextRef.current = latestContext;
  }, [latestContext]);

  useEffect(() => {
    let cancelled = false;
    async function checkAuth() {
      try {
        const response = await fetch(`${API_URL}/api/auth/me`, { credentials: "include" });
        const data = (await response.json()) as AuthStatusResponse;
        if (!cancelled) setAuthStatus(data.authenticated ? "authenticated" : "anonymous");
      } catch {
        if (!cancelled) setAuthStatus("anonymous");
      }
    }
    void checkAuth();
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleLogin(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoginError("");
    setIsLoggingIn(true);
    try {
      const response = await fetch(`${API_URL}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ password: loginPassword }),
      });
      const data = (await response.json()) as { ok: boolean; message?: string };
      if (!response.ok || !data.ok) throw new Error(data.message || "No se pudo iniciar sesion.");
      setLoginPassword("");
      setAuthStatus("authenticated");
    } catch (err) {
      setLoginError(err instanceof Error ? err.message : "No se pudo iniciar sesion.");
    } finally {
      setIsLoggingIn(false);
    }
  }

  async function handleLogout() {
    stopCapture();
    await fetch(`${API_URL}/api/auth/logout`, { method: "POST", credentials: "include" }).catch(() => undefined);
    setSegments([]);
    setAuthStatus("anonymous");
  }

  async function sendChunk(blob: Blob, configVersion: number) {
    if (!blob.size) return;
    setIsSending(true);
    try {
      const audioBase64 = await blobToBase64(blob);
      const sourceLanguageForChunk = sourceLanguageRef.current;
      const targetLanguageForChunk = targetLanguageRef.current;
      const response = await fetch(`${API_URL}/api/translate/audio`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          audioBase64,
          mimeType: blob.type || "audio/wav",
          sourceLanguage: sourceLanguageForChunk,
          targetLanguage: targetLanguageForChunk,
          previousContext: latestContextRef.current,
        }),
      });
      const data = (await response.json()) as TranslateResponse;
      if (response.status === 401) {
        setAuthStatus("anonymous");
        throw new Error("La sesion expiro. Inicia sesion de nuevo.");
      }
      if (!response.ok || !data.ok) throw new Error(data.message || "No se pudo traducir el audio.");
      if (configVersion !== configVersionRef.current) return;
      if (!data.transcript && !data.translation) return;
      setSegments((current) => [
        {
          id: crypto.randomUUID(),
          transcript: data.transcript,
          translation: data.translation,
          detectedLanguage: data.detectedLanguage,
          createdAt: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
        },
        ...current,
      ]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error inesperado traduciendo audio.");
      setStatus("error");
    } finally {
      setIsSending(false);
    }
  }

  async function startCapture() {
    setError("");
    setStatus("selecting");

    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      if (!stream.getAudioTracks().length) {
        stream.getTracks().forEach((track) => track.stop());
        throw new Error("La fuente seleccionada no trae audio. Vuelve a seleccionar y activa compartir audio.");
      }

      streamRef.current = stream;
      setSourceLabel(stream.getVideoTracks()[0]?.label || "Fuente del navegador");

      const audioContext = new AudioContext();
      const mixer = audioContext.createGain();
      const source = audioContext.createMediaStreamSource(new MediaStream(stream.getAudioTracks()));
      source.connect(mixer);

      if (includeMicrophone) {
        const microphoneStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
          video: false,
        });
        microphoneStreamRef.current = microphoneStream;
        const microphoneSource = audioContext.createMediaStreamSource(microphoneStream);
        microphoneSource.connect(mixer);
      }

      const processor = audioContext.createScriptProcessor(4096, 1, 1);
      const silentOutput = audioContext.createGain();
      silentOutput.gain.value = 0;
      audioContextRef.current = audioContext;
      processorRef.current = processor;
      sampleRateRef.current = audioContext.sampleRate;
      audioBuffersRef.current = [];

      processor.onaudioprocess = (event) => {
        const input = event.inputBuffer;
        const frames = input.length;
        const mixed = new Float32Array(frames);
        for (let channel = 0; channel < input.numberOfChannels; channel += 1) {
          const data = input.getChannelData(channel);
          for (let i = 0; i < frames; i += 1) {
            mixed[i] += data[i] / input.numberOfChannels;
          }
        }
        audioBuffersRef.current.push(mixed);
      };

      mixer.connect(processor);
      processor.connect(silentOutput);
      silentOutput.connect(audioContext.destination);

      chunkTimerRef.current = window.setInterval(() => {
        const configVersion = configVersionRef.current;
        const buffers = audioBuffersRef.current;
        audioBuffersRef.current = [];
        const wav = encodeWav(buffers, sampleRateRef.current);
        if (wav.size < 2048 || isMostlySilent(buffers)) return;
        queueRef.current = queueRef.current.then(() => sendChunk(wav, configVersion));
      }, chunkMs);

      stream.getVideoTracks()[0]?.addEventListener("ended", stopCapture);
      setStatus("listening");
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo iniciar la captura.");
      setStatus("error");
    }
  }

  function stopCapture() {
    if (chunkTimerRef.current != null) {
      window.clearInterval(chunkTimerRef.current);
      chunkTimerRef.current = null;
    }
    processorRef.current?.disconnect();
    processorRef.current = null;
    void audioContextRef.current?.close();
    audioContextRef.current = null;
    microphoneStreamRef.current?.getTracks().forEach((track) => track.stop());
    microphoneStreamRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    setStatus("paused");
  }

  async function copyText(kind: "transcript" | "translation") {
    const text = segments
      .slice()
      .reverse()
      .map((segment) => segment[kind])
      .filter(Boolean)
      .join("\n");
    await navigator.clipboard.writeText(text);
  }

  const isListening = status === "listening";

  function resetConversationContext() {
    configVersionRef.current += 1;
    setSegments([]);
    audioBuffersRef.current = [];
    queueRef.current = Promise.resolve();
  }

  function handleSourceLanguageChange(value: string) {
    setSourceLanguage(value);
    const pairedTarget = pairedTargetFor(value);
    if (pairedTarget && targetLanguage === value) {
      setTargetLanguage(pairedTarget);
    }
    resetConversationContext();
  }

  function handleTargetLanguageChange(value: string) {
    setTargetLanguage(value);
    resetConversationContext();
  }

  if (authStatus === "checking") {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background px-4">
        <div className="l-panel w-full max-w-sm p-5 text-center text-sm text-muted-foreground">Verificando sesion...</div>
      </main>
    );
  }

  if (authStatus === "anonymous") {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background px-4">
        <form className="l-panel w-full max-w-sm p-5" onSubmit={handleLogin}>
          <div className="mb-5 flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Shield className="h-5 w-5" />
            </div>
            <div>
              <h1 className="text-lg font-semibold text-foreground">AutoTranslate Live</h1>
              <p className="text-sm text-muted-foreground">Acceso privado</p>
            </div>
          </div>

          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted-foreground">Contrasena</span>
            <input
              autoComplete="current-password"
              autoFocus
              className="l-input"
              onChange={(event) => setLoginPassword(event.target.value)}
              type="password"
              value={loginPassword}
            />
          </label>

          {loginError && <div className="mt-3 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">{loginError}</div>}

          <button className="l-btn-primary mt-4 w-full" disabled={isLoggingIn || !loginPassword.trim()} type="submit">
            {isLoggingIn ? "Ingresando..." : "Ingresar"}
          </button>
        </form>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-background">
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex max-w-7xl flex-col gap-4 px-4 py-4 sm:px-6 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Languages className="h-5 w-5" />
            </div>
            <div>
              <h1 className="text-xl font-semibold tracking-normal text-foreground">AutoTranslate Live</h1>
              <p className="text-sm text-muted-foreground">Traduccion de reuniones en vivo con Gemini</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button className="l-btn-muted" onClick={handleLogout} type="button">
              <LogOut className="h-4 w-4" />
              Salir
            </button>
            <button className="l-btn-muted" onClick={() => setSegments([])} type="button">
              <RotateCcw className="h-4 w-4" />
              Limpiar
            </button>
            {isListening ? (
              <button className="l-btn-muted" onClick={stopCapture} type="button">
                <Pause className="h-4 w-4" />
                Pausar
              </button>
            ) : (
              <button className="l-btn-primary" onClick={startCapture} type="button">
                <Play className="h-4 w-4" />
                Escuchar fuente
              </button>
            )}
          </div>
        </div>
      </header>

      <section className="mx-auto grid max-w-7xl gap-4 px-4 py-5 sm:px-6 lg:grid-cols-[320px_1fr]">
        <aside className="l-panel h-fit p-4">
          <div className="mb-4 flex items-center gap-2 text-sm font-semibold">
            <Settings2 className="h-4 w-4 text-primary" />
            Configuracion
          </div>

          <div className="space-y-4">
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-muted-foreground">Idioma origen</span>
              <select className="l-input" value={sourceLanguage} onChange={(event) => handleSourceLanguageChange(event.target.value)}>
                <option value="auto">Detectar automaticamente</option>
                <option value="en">Ingles</option>
                <option value="es">Espanol</option>
                <option value="pt">Portugues</option>
                <option value="fr">Frances</option>
              </select>
            </label>

            <label className="block">
              <span className="mb-1 block text-xs font-medium text-muted-foreground">Traducir a</span>
              <select className="l-input" value={targetLanguage} onChange={(event) => handleTargetLanguageChange(event.target.value)}>
                <option value="es">Espanol</option>
                <option value="en">Ingles</option>
                <option value="pt">Portugues</option>
                <option value="fr">Frances</option>
              </select>
            </label>

            <label className="block">
              <span className="mb-1 block text-xs font-medium text-muted-foreground">Tamano de chunk</span>
              <select className="l-input" value={chunkMs} onChange={(event) => setChunkMs(Number(event.target.value))} disabled={isListening}>
                {CHUNK_OPTIONS.map((value) => (
                  <option key={value} value={value}>
                    {(value / 1000).toFixed(1)} segundos
                  </option>
                ))}
              </select>
            </label>

            <label className="flex items-center justify-between gap-3 rounded-md border border-border bg-muted/40 px-3 py-2">
              <span>
                <span className="block text-sm font-medium text-foreground">Incluir microfono</span>
                <span className="block text-xs text-muted-foreground">Mezcla tu voz con la fuente compartida</span>
              </span>
              <input
                checked={includeMicrophone}
                className="h-4 w-4 accent-blue-600"
                disabled={isListening}
                onChange={(event) => setIncludeMicrophone(event.target.checked)}
                type="checkbox"
              />
            </label>
          </div>

          <div className="mt-5 space-y-3 rounded-md border border-border bg-muted/40 p-3 text-sm">
            <div className="flex items-start gap-2">
              <MonitorUp className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
              <span className="break-words text-muted-foreground">{sourceLabel}</span>
            </div>
            <div className="flex items-center gap-2">
              <Activity className={`h-4 w-4 ${isListening ? "text-success" : "text-muted-foreground"}`} />
              <span className="capitalize text-muted-foreground">{status}</span>
              {isSending && <span className="ml-auto text-xs text-primary">Gemini...</span>}
            </div>
          </div>

          {error && <div className="mt-4 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">{error}</div>}
        </aside>

        <section className="space-y-4">
          <div className="grid gap-4 lg:grid-cols-2">
            <TranscriptColumn title="Original" icon={<AudioLines className="h-4 w-4" />} segments={segments} field="transcript" onCopy={() => copyText("transcript")} />
            <TranscriptColumn title="Traduccion" icon={<Captions className="h-4 w-4" />} segments={segments} field="translation" onCopy={() => copyText("translation")} />
          </div>
        </section>
      </section>
    </main>
  );
}

function TranscriptColumn(props: {
  title: string;
  icon: React.ReactNode;
  segments: Segment[];
  field: "transcript" | "translation";
  onCopy: () => void;
}) {
  return (
    <div className="l-panel flex min-h-[70vh] flex-col">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <span className="text-primary">{props.icon}</span>
          {props.title}
        </div>
        <button className="l-btn-muted h-8 px-2 text-xs" onClick={props.onCopy} type="button">
          <Copy className="h-3.5 w-3.5" />
          Copiar
        </button>
      </div>

      <div className="flex-1 space-y-3 overflow-y-auto p-4">
        {props.segments.length === 0 ? (
          <div className="flex h-full min-h-[420px] items-center justify-center text-center text-sm text-muted-foreground">
            Selecciona una fuente con audio para ver la conversacion aqui.
          </div>
        ) : (
          props.segments.map((segment) => (
            <article key={`${segment.id}-${props.field}`} className="rounded-md border border-border bg-background p-3">
              <div className="mb-2 flex items-center justify-between gap-2 text-xs text-muted-foreground">
                <span>{segment.createdAt}</span>
                <span>{segment.detectedLanguage}</span>
              </div>
              <p className="whitespace-pre-wrap text-sm leading-6 text-foreground">{segment[props.field]}</p>
            </article>
          ))
        )}
      </div>
    </div>
  );
}

