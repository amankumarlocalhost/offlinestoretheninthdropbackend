import crypto from "crypto";
import { AppError } from "./errors.js";

// Minimal signed upload to Cloudinary over HTTPS (no SDK needed).
// Uses the same Cloudinary account as the online store, in its own folder.
function config() {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;
  if (!cloudName || !apiKey || !apiSecret) {
    throw new AppError("Image upload is not set up (Cloudinary keys missing in .env.local).", "NO_CLOUDINARY", 503);
  }
  return { cloudName, apiKey, apiSecret, folder: process.env.CLOUDINARY_UPLOAD_FOLDER || "the-nine/pos" };
}

// Cloudinary signature: SHA-1 of the sorted params plus the API secret.
function sign(params, apiSecret) {
  const keys = Object.keys(params).sort();
  const parts = [];
  for (const k of keys) parts.push(`${k}=${params[k]}`);
  return crypto.createHash("sha1").update(parts.join("&") + apiSecret).digest("hex");
}

export async function uploadImage(buffer, mime, { subfolder = "logo" } = {}) {
  const { cloudName, apiKey, apiSecret, folder } = config();
  const params = { folder: `${folder}/${subfolder}`, timestamp: Math.floor(Date.now() / 1000) };
  const form = new FormData();
  form.append("file", new Blob([buffer], { type: mime }));
  form.append("api_key", apiKey);
  form.append("timestamp", String(params.timestamp));
  form.append("folder", params.folder);
  form.append("signature", sign(params, apiSecret));

  let res;
  try {
    res = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/image/upload`, { method: "POST", body: form });
  } catch {
    throw new AppError("Could not reach Cloudinary. Check the internet connection and try again.", "UPLOAD_FAILED", 502);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error("[POS] Cloudinary upload failed:", data?.error?.message);
    throw new AppError("The image upload failed. Please try again.", "UPLOAD_FAILED", 502);
  }
  return { url: data.secure_url, publicId: data.public_id, width: data.width, height: data.height, bytes: data.bytes };
}

export async function destroyImage(publicId) {
  const { cloudName, apiKey, apiSecret } = config();
  const params = { public_id: publicId, timestamp: Math.floor(Date.now() / 1000) };
  const form = new FormData();
  form.append("public_id", publicId);
  form.append("api_key", apiKey);
  form.append("timestamp", String(params.timestamp));
  form.append("signature", sign(params, apiSecret));
  const res = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/image/destroy`, { method: "POST", body: form });
  return res.json().catch(() => ({}));
}
