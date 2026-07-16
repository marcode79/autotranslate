import { Router } from "express";
import { isAuthenticated, login, logout } from "../auth/simpleAuth.js";

const router = Router();

router.get("/me", (req, res) => {
  res.json({ ok: true, authenticated: isAuthenticated(req) });
});

router.post("/login", (req, res, next) => {
  try {
    return login(req, res);
  } catch (err) {
    next(err);
  }
});

router.post("/logout", (_req, res) => {
  return logout(_req, res);
});

export default router;
