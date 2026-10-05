import mongoose from "mongoose";

// One shared connection per server process.
const cached = { conn: null, promise: null, replicaSet: null };

export async function connectDB() {
  if (cached.conn) return cached.conn;
  if (!cached.promise) {
    const uri = process.env.MONGODB_URI;
    if (!uri) throw new Error("MONGODB_URI is not set");
    mongoose.set("strictQuery", true);
    cached.promise = mongoose.connect(uri, { maxPoolSize: 10, serverSelectionTimeoutMS: 10000 });
  }
  try {
    cached.conn = await cached.promise;
  } catch (err) {
    cached.promise = null;
    throw err;
  }
  return cached.conn;
}

// Sales, returns and cancels use transactions, which only work on a replica
// set (MongoDB Atlas always is one). Checked once and remembered.
export async function isReplicaSet() {
  if (cached.replicaSet !== null) return cached.replicaSet;
  await connectDB();
  const hello = await mongoose.connection.db.admin().command({ hello: 1 });
  cached.replicaSet = Boolean(hello.setName);
  return cached.replicaSet;
}

// Runs `work(session)` inside a transaction; everything rolls back on error.
export async function withTransaction(work) {
  await connectDB();
  if (!(await isReplicaSet())) {
    const { AppError } = await import("./errors.js");
    throw new AppError(
      "Database is not a replica set, so sales cannot be saved safely. Use MongoDB Atlas or a single-node replica set.",
      "NO_TRANSACTIONS",
      503
    );
  }
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await work(session);
    });
    return result;
  } finally {
    await session.endSession();
  }
}
