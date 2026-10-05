import { ZodError } from "zod";
import mongoose from "mongoose";
import { AppError } from "./errors.js";
import { connectDB } from "./db.js";
import { getSession } from "./auth.js";
import { hasPermission } from "./permissions.js";
import { audit } from "./audit.js";

// Route handlers return json(...) or raw(...); route() sends it.
// Cookies are attached with setSessionCookie(reply, token) before returning.
export function json(data, status = 200) {
  return { kind: "json", data, status, cookies: [] };
}

export function raw(body, headers = {}, status = 200) {
  return { kind: "raw", body, headers, status, cookies: [] };
}

// Turns any thrown error into a safe JSON answer. Unknown errors never leak
// their internal message to the client; they are logged on the server instead.
export function errorResponse(err) {
  if (err instanceof AppError) {
    return json({ message: err.message, code: err.code, details: err.details }, err.status);
  }
  if (err instanceof ZodError) {
    const details = [];
    for (const issue of err.issues) details.push({ path: issue.path.join("."), message: issue.message });
    return json({ message: details[0]?.message || "Invalid input.", code: "VALIDATION", details }, 400);
  }
  if (err instanceof mongoose.Error.CastError) {
    return json({ message: "Invalid id.", code: "BAD_ID" }, 400);
  }
  if (err?.code === 11000) {
    return json({ message: "That value is already in use.", code: "DUPLICATE" }, 409);
  }
  console.error("[POS] Unhandled error:", err);
  return json({ message: "Something went wrong. Please try again.", code: "SERVER_ERROR" }, 500);
}

export function clientInfo(req) {
  const fwd = req.get("x-forwarded-for") || "";
  return {
    ip: fwd.split(",")[0].trim() || req.get("x-real-ip") || req.socket?.remoteAddress || "",
    userAgent: req.get("user-agent") || "",
  };
}

function send(res, reply) {
  for (const c of reply.cookies) res.cookie(c.name, c.value, c.options);
  res.set("Cache-Control", "no-store");
  if (reply.kind === "raw") res.status(reply.status).set(reply.headers).send(reply.body);
  else res.status(reply.status).json(reply.data);
}

/**
 * Wraps a route handler with DB connection, auth, permission check and
 * error handling.
 *   permission: undefined = public, "auth" = any signed-in user,
 *   string or array = needs at least one of these permissions.
 */
export function route(handler, { permission } = {}) {
  return async (req, res) => {
    let reply;
    try {
      await connectDB();
      let session = null;
      if (permission) {
        session = await getSession(req);
        if (permission !== "auth") {
          const keys = Array.isArray(permission) ? permission : [permission];
          let allowed = false;
          for (const key of keys) {
            if (hasPermission(session.permissions, key)) {
              allowed = true;
              break;
            }
          }
          if (!allowed) {
            await audit({
              user: session.user,
              action: "FORBIDDEN_ACCESS",
              entity: "Route",
              entityId: req.originalUrl.split("?")[0],
              after: { method: req.method, needed: keys },
              ...clientInfo(req),
            });
            return send(res, json({ message: "You do not have permission to do this.", code: "FORBIDDEN" }, 403));
          }
        }
      }
      reply = await handler(req, { params: req.params || {}, session, res });
    } catch (err) {
      reply = errorResponse(err);
    }
    send(res, reply);
  };
}

export function readJson(req) {
  return req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body) ? req.body : {};
}

// Query string as a plain { key: "value" } object (first value wins).
export function query(req) {
  const out = {};
  for (const [k, v] of Object.entries(req.query || {})) out[k] = Array.isArray(v) ? String(v[0]) : String(v);
  return out;
}

// Simple in-memory limiter per key. Good enough for a single-server store deployment.
const buckets = new Map();
export function rateLimit(key, max, windowMs) {
  const now = Date.now();
  const entry = buckets.get(key);
  if (!entry || entry.reset < now) {
    buckets.set(key, { count: 1, reset: now + windowMs });
    return;
  }
  entry.count += 1;
  if (entry.count > max) throw new AppError("Too many requests. Please wait and try again.", "RATE_LIMITED", 429);
}
