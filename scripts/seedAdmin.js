// Creates the first SUPER_ADMIN for the store POS.
// Usage: npm run seed:admin   (reads .env: MONGODB_URI, POS_ADMIN_EMAIL, POS_ADMIN_PASSWORD, POS_ADMIN_NAME)
// Writes ONLY to the pos_users collection. Safe to run twice: it never overwrites an existing account.
import "dotenv/config";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";

const { MONGODB_URI, POS_ADMIN_EMAIL, POS_ADMIN_PASSWORD } = process.env;
const name = process.env.POS_ADMIN_NAME || "Owner";
if (!MONGODB_URI || !POS_ADMIN_EMAIL || !POS_ADMIN_PASSWORD) {
  console.error("Set MONGODB_URI, POS_ADMIN_EMAIL and POS_ADMIN_PASSWORD in .env first.");
  process.exit(1);
}
if (POS_ADMIN_PASSWORD.length < 8) {
  console.error("POS_ADMIN_PASSWORD must be at least 8 characters.");
  process.exit(1);
}

await mongoose.connect(MONGODB_URI);
const users = mongoose.connection.collection("pos_users");
const email = POS_ADMIN_EMAIL.trim().toLowerCase();
const existing = await users.findOne({ email });
if (existing) {
  console.log(`A POS user with ${email} already exists — nothing changed.`);
} else {
  const now = new Date();
  await users.insertOne({
    name,
    phone: "",
    email,
    username: "owner",
    passwordHash: await bcrypt.hash(POS_ADMIN_PASSWORD, 12),
    role: "SUPER_ADMIN",
    extraPermissions: [],
    revokedPermissions: [],
    discountLimitPercent: 100,
    isActive: true,
    mustChangePassword: true,
    tokenVersion: 0,
    failedLoginCount: 0,
    lockUntil: null,
    lastLoginAt: null,
    createdBy: null,
    createdAt: now,
    updatedAt: now,
  });
  console.log(`Super admin created. Sign in with "owner" or ${email}. You will be asked to change the password.`);
}
await mongoose.disconnect();
