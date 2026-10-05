import { SignJWT, jwtVerify } from "jose";
import { PosUser } from "./models.js";
import { getUserPermissions } from "./permissions.js";
import { unauthorized, AppError } from "./errors.js";

// Separate cookie from the online store's cookies (nine_token / nine_refresh).
export const COOKIE_NAME = "tnd_pos_token";

function secretKey() {
  const secret = process.env.POS_JWT_SECRET;
  if (!secret || secret.length < 32) {
    throw new AppError("POS_JWT_SECRET is missing or too short.", "CONFIG", 500);
  }
  return new TextEncoder().encode(secret);
}

export function sessionHours() {
  const h = Number(process.env.POS_SESSION_HOURS || 12);
  return h > 0 && h <= 24 ? h : 12;
}

export async function signToken(user) {
  return new SignJWT({ role: user.role, tv: user.tokenVersion })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(String(user._id))
    .setIssuedAt()
    .setExpirationTime(`${sessionHours()}h`)
    .sign(secretKey());
}

function cookieOptions(maxAgeMs) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: maxAgeMs,
    ...(process.env.POS_COOKIE_DOMAIN ? { domain: process.env.POS_COOKIE_DOMAIN } : {}),
  };
}

// `reply` is the object returned by json() in http.js.
export function setSessionCookie(reply, token) {
  reply.cookies.push({ name: COOKIE_NAME, value: token, options: cookieOptions(sessionHours() * 3600 * 1000) });
}

export function clearSessionCookie(reply) {
  reply.cookies.push({ name: COOKIE_NAME, value: "", options: cookieOptions(0) });
}

/**
 * Reads the cookie, verifies the JWT, then re-loads the user from the database
 * on EVERY request so deactivation, permission changes and "log out all
 * devices" (tokenVersion) take effect immediately.
 */
export async function getSession(req) {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) throw unauthorized();

  let payload;
  try {
    ({ payload } = await jwtVerify(token, secretKey(), { algorithms: ["HS256"] }));
  } catch {
    throw unauthorized("Your session has expired. Please sign in again.");
  }

  const user = await PosUser.findById(payload.sub);
  if (!user || !user.isActive) throw unauthorized("This account is not active.");
  if (user.tokenVersion !== payload.tv) throw unauthorized("You were signed out. Please sign in again.");

  return { user, permissions: getUserPermissions(user) };
}

export function publicUser(user, permissions) {
  return {
    id: String(user._id),
    name: user.name,
    username: user.username || "",
    email: user.email || "",
    phone: user.phone || "",
    role: user.role,
    discountLimitPercent: user.discountLimitPercent,
    mustChangePassword: user.mustChangePassword,
    permissions: permissions || getUserPermissions(user),
  };
}
