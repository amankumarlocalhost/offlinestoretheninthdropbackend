import multer from "multer";
import { badRequest } from "./errors.js";

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB

// The file's first bytes must match its type, so a renamed file is refused.
const SIGNATURES = {
  "image/png": [0x89, 0x50, 0x4e, 0x47],
  "image/jpeg": [0xff, 0xd8, 0xff],
  "image/webp": [0x52, 0x49, 0x46, 0x46],
};

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_IMAGE_BYTES, files: 1 } }).single("file");

/**
 * Reads one PNG / JPG / WEBP image (multipart field "file", up to 5 MB) into
 * memory and checks it really is that kind of image. Call it inside a route
 * handler, so it runs after the permission check.
 */
export function readImageUpload(req, res) {
  return new Promise((resolve, reject) => {
    upload(req, res, (err) => {
      if (err) return reject(badRequest(err.code === "LIMIT_FILE_SIZE" ? "Image must be 5 MB or smaller." : "Choose an image file."));
      const file = req.file;
      if (!file) return reject(badRequest("Choose an image file."));
      const sig = SIGNATURES[file.mimetype];
      if (!sig) return reject(badRequest("Upload a PNG, JPG or WEBP image."));
      for (let i = 0; i < sig.length; i++) {
        if (file.buffer[i] !== sig[i]) return reject(badRequest("That file is not a real image."));
      }
      resolve(file);
    });
  });
}
