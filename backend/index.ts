import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = fs.existsSync(path.resolve(__dirname, "package.json"))
  ? __dirname
  : path.resolve(__dirname, "..");
dotenv.config({
  path: path.resolve(backendRoot, ".env"),
  override: process.env.NODE_ENV !== "production",
});

import express from "express";
import cors from "cors";
import helmet from "helmet";
import authRoutes from "./src/routes/auth.routes.js";
import translateRoutes from "./src/routes/translate.routes.js";

const app = express();
const port = Number(process.env.PORT || 4000);
const requestBodyLimit = process.env.REQUEST_BODY_LIMIT?.trim() || "18mb";
const frontendUrl = process.env.FRONTEND_URL?.trim() || "http://localhost:5173";
const allowedOrigins = new Set([
  frontendUrl,
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:5174",
  "http://127.0.0.1:5174",
]);

app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: "cross-origin" },
  })
);

app.use(
  cors({
    origin(origin, cb) {
      if (!origin || allowedOrigins.has(origin)) return cb(null, true);
      return cb(new Error("Not allowed by CORS"));
    },
    credentials: true,
  })
);

app.use(express.json({ limit: requestBodyLimit }));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "autotranslate-backend" });
});

app.use("/api/auth", authRoutes);
app.use("/api/translate", translateRoutes);

function resolveFrontendDist(): string | null {
  const candidates = [
    path.resolve(backendRoot, "../frontend/dist"),
    path.resolve(process.cwd(), "frontend/dist"),
    path.resolve(process.cwd(), "../frontend/dist"),
    path.resolve(__dirname, "../../frontend/dist"),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, "index.html"))) {
      return candidate;
    }
  }

  console.warn("[static] frontend/dist not found. Checked:", candidates);
  return null;
}

const frontendDist = resolveFrontendDist();
if (frontendDist) {
  console.info(`[static] serving frontend from ${frontendDist}`);
  app.use(express.static(frontendDist));
  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api/")) return next();
    return res.sendFile(path.join(frontendDist, "index.html"));
  });
}

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const message = err instanceof Error ? err.message : "Internal server error";
  const status = message.includes("GEMINI_API_KEY") ? 500 : 400;
  res.status(status).json({ ok: false, message });
});

app.listen(port, () => {
  console.log(`AutoTranslate API on http://localhost:${port}`);
});

export { app };



