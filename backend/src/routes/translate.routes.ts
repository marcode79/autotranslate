import { Router } from "express";
import { requireAuth } from "../auth/simpleAuth.js";
import { translateAudioChunk } from "../services/geminiTranslate.service.js";

const router = Router();

router.use(requireAuth);

router.post("/audio", async (req, res, next) => {
  try {
    const { audioBase64, mimeType, sourceLanguage, targetLanguage, previousContext } = req.body ?? {};
    if (typeof audioBase64 !== "string" || audioBase64.length < 64) {
      return res.status(400).json({ ok: false, message: "audioBase64 is required." });
    }
    if (typeof mimeType !== "string" || !mimeType.startsWith("audio/")) {
      return res.status(400).json({ ok: false, message: "A valid audio mimeType is required." });
    }

    const result = await translateAudioChunk({
      audioBase64,
      mimeType,
      sourceLanguage: typeof sourceLanguage === "string" ? sourceLanguage : "auto",
      targetLanguage: typeof targetLanguage === "string" ? targetLanguage : "es",
      previousContext: typeof previousContext === "string" ? previousContext : "",
    });

    return res.json({ ok: true, ...result });
  } catch (err) {
    next(err);
  }
});

export default router;
