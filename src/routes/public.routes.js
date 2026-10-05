// Endpoints that need no login.
import { Router } from "express";
import { route, json, clientInfo, rateLimit } from "../lib/http.js";
import { connectDB, isReplicaSet } from "../lib/db.js";
import { findByPublicToken, publicBill } from "../services/sales.js";

const router = Router();

// Minimal health check: no versions, hosts or ids.
router.get("/health", async (_req, res) => {
  try {
    await connectDB();
    res.json({ status: "ok", transactions: await isReplicaSet() });
  } catch {
    res.status(503).json({ status: "db-unavailable" });
  }
});

// Public digital bill. Random 32-char token, rate limited, masked phone, no internal data.
router.get(
  "/public/bills/:token",
  route(async (req, { params }) => {
    rateLimit(`bill:${clientInfo(req).ip}`, 30, 60 * 1000);
    const sale = await findByPublicToken(params.token);
    return json({ bill: publicBill(sale) });
  })
);

export default router;
