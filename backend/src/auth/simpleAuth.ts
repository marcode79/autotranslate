import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";

const COOKIE_NAME = "autotranslate_session";
const SESSION_TTL_MS = 1000 * 60 * 60 * 12;

function requireSecret(value: string | undefined, name: string): string {
  const trimmed = value?.trim();
  if (!trimmed) throw new Error(`Missing ${name} in backend/.env.`);
  return trimmed;
}

function base64Url(input: string): string {
  return Buffer.from(input, "utf8").toString("base64url");
}

function fromBase64Url(input: string): string {
  return Buffer.from(input, "base64url").toString("utf8");
}

function sign(payload: string): string {
  const secret = requireSecret(process.env.SESSION_SECRET, "SESSION_SECRET");
  return crypto.createHmac("sha256", secret).update(payload).digest("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {};
  return Object.fromEntries(
    header.split(";").map((part) => {
      const [rawKey, ...rawValue] = part.trim().split("=");
      return [rawKey, decodeURIComponent(rawValue.join("=") || "")];
    })
  );
}

function createSessionToken(): string {
  const payload = JSON.stringify({
    sub: "local-user",
    exp: Date.now() + SESSION_TTL_MS,
    nonce: crypto.randomBytes(16).toString("base64url"),
  });
  const encodedPayload = base64Url(payload);
  return `${encodedPayload}.${sign(encodedPayload)}`;
}

function verifySessionToken(token: string | undefined): boolean {
  if (!token || !token.includes(".")) return false;
  const [encodedPayload, signature] = token.split(".");
  if (!encodedPayload || !signature || !safeEqual(signature, sign(encodedPayload))) return false;

  try {
    const payload = JSON.parse(fromBase64Url(encodedPayload)) as { exp?: unknown };
    return typeof payload.exp === "number" && payload.exp > Date.now();
  } catch {
    return false;
  }
}

function cookieOptions(req: Request): string {
  const secure = process.env.NODE_ENV === "production" || req.secure || req.headers["x-forwarded-proto"] === "https";
  return [
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
    secure ? "Secure" : "",
  ]
    .filter(Boolean)
    .join("; ");
}

function clearCookieOptions(): string {
  return "HttpOnly; SameSite=Lax; Path=/; Max-Age=0";
}

export function isAuthenticated(req: Request): boolean {
  const cookies = parseCookies(req.headers.cookie);
  return verifySessionToken(cookies[COOKIE_NAME]);
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (isAuthenticated(req)) return next();
  return res.status(401).json({ ok: false, message: "Authentication required." });
}

export function login(req: Request, res: Response) {
  const configuredPassword = requireSecret(process.env.APP_ACCESS_PASSWORD, "APP_ACCESS_PASSWORD");
  const password = typeof req.body?.password === "string" ? req.body.password.trim() : "";
  if (!safeEqual(password, configuredPassword)) {
    return res.status(401).json({ ok: false, message: "Invalid password." });
  }

  res.setHeader("Set-Cookie", `${COOKIE_NAME}=${encodeURIComponent(createSessionToken())}; ${cookieOptions(req)}`);
  return res.json({ ok: true });
}

export function logout(_req: Request, res: Response) {
  res.setHeader("Set-Cookie", `${COOKIE_NAME}=; ${clearCookieOptions()}`);
  return res.json({ ok: true });
}

