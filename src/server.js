import "dotenv/config"; // must stay first: models read env vars when they load
import mongoose from "mongoose";
import { createApp } from "./app.js";
import { connectDB, isReplicaSet } from "./lib/db.js";

const port = Number(process.env.PORT || 4001);

for (const key of ["MONGODB_URI", "POS_JWT_SECRET"]) {
  if (!process.env[key]) {
    console.error(`[POS] ${key} is not set. Copy .env.example to .env and fill it in.`);
    process.exit(1);
  }
}

try {
  await connectDB();
  const tx = await isReplicaSet();
  console.log(`[POS] MongoDB connected (POS db: ${mongoose.connection.name}, online db: ${process.env.ONLINE_DB_NAME || mongoose.connection.name}, transactions: ${tx ? "yes" : "NO"})`);
} catch (err) {
  console.error("[POS] Could not connect to MongoDB:", err.message);
  process.exit(1);
}

const server = createApp().listen(port, () => console.log(`[POS] Store backend on http://localhost:${port}/api`));

function shutdown() {
  server.close(() => mongoose.disconnect().finally(() => process.exit(0)));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
