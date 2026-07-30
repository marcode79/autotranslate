import { Router } from "express";
import { requireUser, type AuthenticatedRequest } from "../auth/requireUser.js";
import { adminClient } from "../lib/supabase.js";
const router = Router();
router.get("/me", requireUser, async (req, res, next) => {
  try {
    const auth = (req as AuthenticatedRequest).auth;
    const db = adminClient();
    await db.from("profiles").upsert({ id: auth.userId, email: auth.email }, { onConflict: "id" });
    await db.from("subscriptions").upsert({ user_id: auth.userId, plan_id: "free" }, { onConflict: "user_id", ignoreDuplicates: true });
    const { data, error } = await db.from("profiles").select("id,email,full_name,avatar_url,role,access_status,rejection_reason,approved_at").eq("id", auth.userId).single();
    if (error) throw error;
    res.json({ ok: true, user: data });
  } catch (error) { next(error); }
});
export default router;
