import type { NextFunction, Request, Response } from "express";
import { createUserClient } from "../lib/supabase.js";

export type AuthenticatedRequest = Request & {
  auth: { userId: string; email: string | null; accessToken: string };
};

export async function requireUser(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) return res.status(401).json({ ok: false, message: "Authentication required." });
  try {
    const { data, error } = await createUserClient(token).auth.getUser();
    if (error || !data.user) return res.status(401).json({ ok: false, message: "Invalid or expired session." });
    (req as AuthenticatedRequest).auth = { userId: data.user.id, email: data.user.email ?? null, accessToken: token };
    return next();
  } catch (error) { return next(error); }
}
