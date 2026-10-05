import { Router } from "express";
import { route, json, readJson, clientInfo } from "../lib/http.js";
import { createUserSchema, updateUserSchema } from "../lib/schemas.js";
import { listUsers, createUser, updateUser, forceLogout, shapeUser } from "../services/users.js";

const router = Router();
const opts = { permission: "users.manage" };

router.get("/", route(async () => json({ items: await listUsers() }), opts));

router.post(
  "/",
  route(async (req, { session }) => {
    const body = createUserSchema.parse(readJson(req));
    const user = await createUser(body, session.user, clientInfo(req));
    return json({ user: shapeUser(user) }, 201);
  }, opts)
);

router.patch(
  "/:id",
  route(async (req, { params, session }) => {
    const body = updateUserSchema.parse(readJson(req));
    const user = await updateUser(params.id, body, session.user, clientInfo(req));
    return json({ user: shapeUser(user) });
  }, opts)
);

router.post(
  "/:id/force-logout",
  route(async (req, { params, session }) => json({ user: shapeUser(await forceLogout(params.id, session.user, clientInfo(req))) }), opts)
);

export default router;
