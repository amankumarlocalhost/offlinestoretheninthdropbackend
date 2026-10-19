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

export const MAX_DOC_BYTES = 10 * 1024 * 1024; // 10 MB
const DOC_SIGNATURES = { ...SIGNATURES, "application/pdf": [0x25, 0x50, 0x44, 0x46] }; // %PDF
const docUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_DOC_BYTES, files: 1 } }).single("file");

/**
 * Reads one purchase document (multipart field "file"): a PDF or a PNG / JPG /
 * WEBP photo of the vendor's bill or invoice, up to 10 MB.
 */
export function readDocumentUpload(req, res) {
  return new Promise((resolve, reject) => {
    docUpload(req, res, (err) => {
      if (err) return reject(badRequest(err.code === "LIMIT_FILE_SIZE" ? "File must be 10 MB or smaller." : "Choose a file."));
      const file = req.file;
      if (!file) return reject(badRequest("Choose a file."));
      const sig = DOC_SIGNATURES[file.mimetype];
      if (!sig) return reject(badRequest("Upload a PDF, PNG, JPG or WEBP file."));
      for (let i = 0; i < sig.length; i++) {
        if (file.buffer[i] !== sig[i]) return reject(badRequest("That file is not what its name says."));
      }
      resolve(file);
    });
  });
}
