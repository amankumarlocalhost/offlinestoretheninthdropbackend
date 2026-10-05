import { Router } from "express";
import bcrypt from "bcryptjs";
import { route, json, readJson, clientInfo } from "../lib/http.js";
import { settingsSchema } from "../lib/schemas.js";
import { getSettings } from "../lib/settings.js";
import { PosSettings } from "../lib/models.js";
import { badRequest } from "../lib/errors.js";
import { uploadImage } from "../lib/cloudinary.js";
import { audit } from "../lib/audit.js";
import { readImageUpload } from "../lib/upload.js";

const router = Router();

function shape(s) {
  const o = s.toObject ? s.toObject() : s;
  const hasPin = Boolean(o.limits?.adminPinHash);
  if (o.limits) delete o.limits.adminPinHash;
  // Old GST settings may still be stored; the store no longer uses GST.
  delete o.tax;
  if (o.store) delete o.store.gstin;
  return { ...o, limits: { ...o.limits, hasAdminPin: hasPin } };
}

router.get(
  "/",
  route(async () => json({ settings: shape(await getSettings({ withPin: true })) }), {
    permission: ["settings.manage", "sales.create", "returns.request"],
  })
);

router.put(
  "/",
  route(
    async (req, { session }) => {
      const body = settingsSchema.parse(readJson(req));
      const before = shape(await getSettings({ withPin: true }));
      const set = {};
      for (const group of Object.keys(body)) {
        for (const [key, value] of Object.entries(body[group] || {})) {
          if (group === "limits" && key === "adminPin") {
            if (value) set["limits.adminPinHash"] = await bcrypt.hash(value, 10);
            continue;
          }
          set[`${group}.${key}`] = value;
        }
      }
      set.updatedBy = session.user.name;
      await PosSettings.updateOne({ key: "store" }, { $set: set });
      const after = shape(await getSettings({ withPin: true }));
      const logged = { ...body };
      if (logged.limits?.adminPin) logged.limits = { ...logged.limits, adminPin: "(changed)" };
      await audit({ user: session.user, action: "SETTINGS_CHANGE", entity: "PosSettings", before: { ...before, store: { ...before.store, logo: undefined } }, after: logged, ...clientInfo(req) });
      return json({ settings: after });
    },
    { permission: "settings.manage" }
  )
);

/**
 * Upload the store logo (PNG / JPG / WEBP, up to 5 MB) to Cloudinary and save
 * its URL in settings. Each new bill copies the URL into its own snapshot, so
 * old bills keep the logo they were printed with — which is also why the
 * previous logo is NOT deleted from Cloudinary.
 *
 * Send multipart/form-data with field "file". Send JSON { remove: true } to clear the logo.
 */
router.post(
  "/logo",
  route(
    async (req, { session, res }) => {
      if (req.is("application/json")) {
        if (readJson(req).remove) {
          await PosSettings.updateOne({ key: "store" }, { $set: { "store.logo": "" } }, { upsert: true });
          await audit({ user: session.user, action: "SETTINGS_CHANGE", entity: "PosSettings", after: { logo: "removed" }, ...clientInfo(req) });
          return json({ logo: "" });
        }
        throw badRequest("Choose an image file.");
      }
      const file = await readImageUpload(req, res);
      const uploaded = await uploadImage(file.buffer, file.mimetype, { subfolder: "logo" });
      await PosSettings.updateOne({ key: "store" }, { $set: { "store.logo": uploaded.url } }, { upsert: true });
      await audit({
        user: session.user,
        action: "SETTINGS_CHANGE",
        entity: "PosSettings",
        after: { logo: uploaded.url, name: file.originalname, bytes: file.size },
        ...clientInfo(req),
      });
      return json({ logo: uploaded.url });
    },
    { permission: "settings.manage" }
  )
);

export default router;
