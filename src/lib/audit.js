import { PosAuditLog } from "./models.js";

/**
 * Writes one append-only audit row. Never throws: a failed audit write must
 * not break the action it describes, but it is logged on the server.
 * Pass `session` to make the row part of a transaction.
 */
export async function audit({ user, action, entity = "", entityId = "", before = null, after = null, ip = "", userAgent = "", session }) {
  try {
    const doc = {
      user: user?._id || null,
      userName: user?.name || "",
      role: user?.role || "",
      action,
      entity,
      entityId: entityId ? String(entityId) : "",
      before,
      after,
      ip,
      userAgent,
    };
    if (session) await PosAuditLog.create([doc], { session });
    else await PosAuditLog.create(doc);
  } catch (err) {
    if (session) throw err; // inside a transaction the whole action should fail
    console.error("[POS] audit write failed:", err.message);
  }
}
