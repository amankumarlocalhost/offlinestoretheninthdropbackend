import bcrypt from "bcryptjs";
import { PosUser } from "../lib/models.js";
import { getUserPermissions, ALL_PERMISSIONS } from "../lib/permissions.js";
import { getSettings } from "../lib/settings.js";
import { AppError, badRequest, conflict, notFound } from "../lib/errors.js";
import { isWithinHours } from "../lib/time.js";
import { audit } from "../lib/audit.js";

const MAX_FAILS = 5;
const LOCK_MINUTES = 15;
// Compared against when the username doesn't exist, so a wrong username takes
// as long as a wrong password and can't be told apart by timing.
let dummyHash = null;
async function dummyCompare(password) {
  if (!dummyHash) dummyHash = await bcrypt.hash("not-a-real-password", 12);
  await bcrypt.compare(password, dummyHash);
}

export async function login({ identifier, password }, info) {
  const id = String(identifier).trim().toLowerCase();
  const user = await PosUser.findOne({ $or: [{ username: id }, { email: id }] }).select("+passwordHash");

  if (!user) {
    await dummyCompare(password);
    await audit({ action: "LOGIN_FAIL", entity: "PosUser", after: { identifier: id, reason: "unknown" }, ...info });
    throw new AppError("Wrong username or password.", "BAD_CREDENTIALS", 401);
  }
  if (user.lockUntil && user.lockUntil > new Date()) {
    const mins = Math.ceil((user.lockUntil - Date.now()) / 60000);
    throw new AppError(`Too many wrong attempts. Try again in ${mins} minute(s).`, "LOCKED", 423);
  }
  if (!user.isActive) {
    await audit({ user, action: "LOGIN_FAIL", entity: "PosUser", entityId: user._id, after: { reason: "inactive" }, ...info });
    throw new AppError("This account is deactivated.", "INACTIVE", 403);
  }

  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) {
    user.failedLoginCount += 1;
    let locked = false;
    if (user.failedLoginCount >= MAX_FAILS) {
      user.lockUntil = new Date(Date.now() + LOCK_MINUTES * 60000);
      user.failedLoginCount = 0;
      locked = true;
    }
    await user.save();
    await audit({ user, action: "LOGIN_FAIL", entity: "PosUser", entityId: user._id, after: { reason: "password", locked }, ...info });
    if (locked) throw new AppError(`Too many wrong attempts. Account locked for ${LOCK_MINUTES} minutes.`, "LOCKED", 423);
    throw new AppError("Wrong username or password.", "BAD_CREDENTIALS", 401);
  }

  if (user.role === "OPERATOR") {
    const settings = await getSettings();
    const sec = settings.security || {};
    if (sec.storeHoursOnly && !isWithinHours(sec.openTime, sec.closeTime)) {
      throw new AppError(`Login is allowed only during store hours (${sec.openTime}–${sec.closeTime}).`, "OUTSIDE_HOURS", 403);
    }
  }

  user.failedLoginCount = 0;
  user.lockUntil = null;
  user.lastLoginAt = new Date();
  await user.save();
  await audit({ user, action: "LOGIN", entity: "PosUser", entityId: user._id, ...info });
  return user;
}

export async function changePassword(user, { currentPassword, newPassword }, info) {
  const fresh = await PosUser.findById(user._id).select("+passwordHash");
  if (!(await bcrypt.compare(currentPassword, fresh.passwordHash))) throw badRequest("Current password is wrong.");
  if (currentPassword === newPassword) throw badRequest("Choose a new password different from the current one.");
  fresh.passwordHash = await bcrypt.hash(newPassword, 12);
  fresh.mustChangePassword = false;
  fresh.tokenVersion += 1; // signs out every other device
  await fresh.save();
  await audit({ user: fresh, action: "PASSWORD_CHANGE", entity: "PosUser", entityId: fresh._id, ...info });
  return fresh;
}

export function shapeUser(u) {
  return {
    id: String(u._id),
    name: u.name,
    phone: u.phone || "",
    email: u.email || "",
    username: u.username || "",
    role: u.role,
    extraPermissions: u.extraPermissions || [],
    revokedPermissions: u.revokedPermissions || [],
    permissions: getUserPermissions(u),
    discountLimitPercent: u.discountLimitPercent,
    isActive: u.isActive,
    mustChangePassword: u.mustChangePassword,
    locked: Boolean(u.lockUntil && u.lockUntil > new Date()),
    lastLoginAt: u.lastLoginAt,
    createdAt: u.createdAt,
  };
}

export async function listUsers() {
  const rows = await PosUser.find().sort({ createdAt: 1 }).lean();
  return rows.map(shapeUser);
}

function cleanPerms(list) {
  const out = [];
  for (const p of list || []) if (ALL_PERMISSIONS.includes(p) && !out.includes(p)) out.push(p);
  return out;
}

export async function createUser(data, actor, info) {
  if (!data.username && !data.email) throw badRequest("Give a username or an email.");
  const user = await PosUser.create({
    name: data.name,
    phone: data.phone || "",
    ...(data.email ? { email: data.email } : {}),
    ...(data.username ? { username: data.username } : {}),
    passwordHash: await bcrypt.hash(data.password, 12),
    role: data.role || "OPERATOR",
    extraPermissions: cleanPerms(data.extraPermissions),
    revokedPermissions: cleanPerms(data.revokedPermissions),
    discountLimitPercent: data.discountLimitPercent ?? 10,
    mustChangePassword: true,
    createdBy: actor._id,
  }).catch((err) => {
    if (err.code === 11000) throw conflict("That username or email is already taken.");
    throw err;
  });
  await audit({ user: actor, action: "USER_CREATE", entity: "PosUser", entityId: user._id, after: { name: user.name, username: user.username, role: user.role }, ...info });
  return user;
}

async function activeSuperAdmins(excludeId) {
  return PosUser.countDocuments({ role: "SUPER_ADMIN", isActive: true, _id: { $ne: excludeId } });
}

export async function updateUser(id, data, actor, info) {
  const user = await PosUser.findById(id);
  if (!user) throw notFound("User not found.");
  const before = shapeUser(user);
  const isSelf = String(user._id) === String(actor._id);

  // At least one active super admin must always remain.
  const losesAdmin =
    user.role === "SUPER_ADMIN" &&
    user.isActive &&
    ((data.role && data.role !== "SUPER_ADMIN") || data.isActive === false);
  if (losesAdmin && (await activeSuperAdmins(user._id)) === 0) {
    throw badRequest("This is the last active super admin. Create another one first.");
  }
  if (isSelf && (data.isActive === false || (data.role && data.role !== user.role))) {
    throw badRequest("You cannot deactivate yourself or change your own role.");
  }

  for (const key of ["name", "phone", "role", "discountLimitPercent"]) {
    if (data[key] !== undefined) user[key] = data[key];
  }
  if (data.email !== undefined) user.email = data.email || undefined;
  if (data.username !== undefined) user.username = data.username || undefined;
  if (data.extraPermissions !== undefined) user.extraPermissions = cleanPerms(data.extraPermissions);
  if (data.revokedPermissions !== undefined) user.revokedPermissions = cleanPerms(data.revokedPermissions);
  if (data.isActive !== undefined && data.isActive !== user.isActive) {
    user.isActive = data.isActive;
    if (!data.isActive) user.tokenVersion += 1; // signed out immediately
  }
  if (data.unlock) {
    user.lockUntil = null;
    user.failedLoginCount = 0;
  }
  if (data.newPassword) {
    user.passwordHash = await bcrypt.hash(data.newPassword, 12);
    user.mustChangePassword = true;
    user.tokenVersion += 1;
  }
  try {
    await user.save();
  } catch (err) {
    if (err.code === 11000) throw conflict("That username or email is already taken.");
    throw err;
  }
  const action = data.isActive === false ? "USER_DEACTIVATE" : "USER_EDIT";
  const after = { ...data };
  delete after.newPassword;
  if (data.newPassword) after.passwordReset = true;
  await audit({ user: actor, action, entity: "PosUser", entityId: user._id, before, after, ...info });
  return user;
}

export async function forceLogout(id, actor, info) {
  const user = await PosUser.findById(id);
  if (!user) throw notFound("User not found.");
  user.tokenVersion += 1;
  await user.save();
  await audit({ user: actor, action: "FORCE_LOGOUT", entity: "PosUser", entityId: user._id, ...info });
  return user;
}
