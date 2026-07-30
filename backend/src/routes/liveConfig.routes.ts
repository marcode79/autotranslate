import { Router } from "express";
import { requireUser, type AuthenticatedRequest } from "../auth/requireUser.js";
import { adminClient } from "../lib/supabase.js";

const router = Router();
router.use(requireUser);

router.get("/config", async (req, res, next) => {
  try {
    const userId = (req as AuthenticatedRequest).auth.userId;
    const { data, error } = await adminClient().from("profiles").select("role,access_status").eq("id", userId).single();
    if (error) throw error;
    const globallyEnabled = process.env.LIVE_TRANSLATION_ENABLED?.trim().toLowerCase() === "true";
    const adminOnly = process.env.LIVE_TRANSLATION_ADMIN_ONLY?.trim().toLowerCase() !== "false";
    res.json({
      ok: true,
      enabled: globallyEnabled && data.access_status === "approved" && (!adminOnly || data.role === "admin"),
      preview: true,
      adminOnly,
    });
  } catch (error) {
    next(error);
  }
});

export default router;
