import { Router } from "express";
import { route, json, readJson, clientInfo, rateLimit } from "../lib/http.js";
import { loginSchema, changePasswordSchema } from "../lib/schemas.js";
import { login, changePassword } from "../services/users.js";
import { signToken, setSessionCookie, clearSessionCookie, getSession, publicUser } from "../lib/auth.js";
import { audit } from "../lib/audit.js";

const router = Router();

router.post(
  "/login",
  route(async (req) => {
    const info = clientInfo(req);
    rateLimit(`login:${info.ip}`, 20, 15 * 60 * 1000);
    const body = loginSchema.parse(readJson(req));
    const user = await login(body, info);
    const reply = json({ user: publicUser(user) });
    setSessionCookie(reply, await signToken(user));
    return reply;
  })
);

// Always clears the cookie, even if the session was already invalid.
router.post(
  "/logout",
  route(async (req) => {
    try {
      const { user } = await getSession(req);
      await audit({ user, action: "LOGOUT", entity: "PosUser", entityId: user._id, ...clientInfo(req) });
    } catch {
      /* already signed out */
    }
    const reply = json({ ok: true });
    clearSessionCookie(reply);
    return reply;
  })
);

router.get(
  "/me",
  route(async (_req, { session }) => json({ user: publicUser(session.user, session.permissions) }), { permission: "auth" })
);

// Other devices are signed out; this one gets a fresh session.
router.post(
  "/change-password",
  route(
    async (req, { session }) => {
      const body = changePasswordSchema.parse(readJson(req));
      const user = await changePassword(session.user, body, clientInfo(req));
      const reply = json({ user: publicUser(user) });
      setSessionCookie(reply, await signToken(user));
      return reply;
    },
    { permission: "auth" }
  )
);

export default router;
