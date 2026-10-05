// Vercel serverless entry. Every request is rewritten here (see vercel.json);
// locally, src/server.js is used instead.
import "dotenv/config";
import { createApp } from "../src/app.js";
import { connectDB } from "../src/lib/db.js";

const app = createApp();

export default async function handler(req, res) {
  // The status page and health check report DB problems themselves.
  if (req.url !== "/" && !req.url.startsWith("/api/health")) {
    try {
      await connectDB();
    } catch (err) {
      console.error("[POS] Could not connect to MongoDB:", err.message);
      return res.status(503).json({ message: "Database unavailable.", code: "DB_UNAVAILABLE" });
    }
  }
  return app(req, res);
}
