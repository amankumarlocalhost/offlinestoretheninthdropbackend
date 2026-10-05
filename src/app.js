import express from "express";
import cookieParser from "cookie-parser";
import cors from "cors";
import authRoutes from "./routes/auth.routes.js";
import usersRoutes from "./routes/users.routes.js";
import settingsRoutes from "./routes/settings.routes.js";
import catalogRoutes from "./routes/catalog.routes.js";
import catalogAdminRoutes from "./routes/catalogAdmin.routes.js";
import customersRoutes from "./routes/customers.routes.js";
import salesRoutes from "./routes/sales.routes.js";
import returnsRoutes from "./routes/returns.routes.js";
import adminRoutes from "./routes/admin.routes.js";
import publicRoutes from "./routes/public.routes.js";

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  // The POS frontend proxies /api here, so the client IP comes from X-Forwarded-For.
  app.set("trust proxy", true);

  // Only needed when the frontend calls this server directly from another origin.
  // Through the frontend's /api proxy, requests are same-origin and CORS never applies.
  const origins = (process.env.CLIENT_ORIGIN || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (origins.length) app.use(cors({ origin: origins, credentials: true }));

  app.use(express.json({ limit: "1mb" }));
  app.use(cookieParser());

  // Plain status page so opening the deployment URL shows the API is up.
  app.get("/", (_req, res) => {
    res.json({ status: "ok", message: "THE NINTH DROP store API is running.", health: "/api/health" });
  });

  const api = express.Router();
  api.use("/", publicRoutes);
  api.use("/auth", authRoutes);
  api.use("/users", usersRoutes);
  api.use("/settings", settingsRoutes);
  api.use("/", catalogRoutes);
  api.use("/catalog", catalogAdminRoutes);
  api.use("/customers", customersRoutes);
  api.use("/sales", salesRoutes);
  api.use("/returns", returnsRoutes);
  api.use("/", adminRoutes);
  app.use("/api", api);

  app.use((_req, res) => res.status(404).json({ message: "Not found.", code: "NOT_FOUND" }));
  // Bad JSON bodies and anything else that escapes a route.
  app.use((err, _req, res, _next) => {
    if (err.type === "entity.parse.failed") return res.status(400).json({ message: "Invalid JSON.", code: "BAD_JSON" });
    if (err.type === "entity.too.large") return res.status(413).json({ message: "Request is too large.", code: "TOO_LARGE" });
    console.error("[POS] Unhandled error:", err);
    res.status(500).json({ message: "Something went wrong. Please try again.", code: "SERVER_ERROR" });
  });

  return app;
}
