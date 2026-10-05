import { z } from "zod";

export function escapeRegex(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Accepts "+91 98765 43210", "098765-43210", "9876543210" → "9876543210".
export function normalizePhone(value) {
  let digits = String(value || "").replace(/\D/g, "");
  if (digits.length === 12 && digits.startsWith("91")) digits = digits.slice(2);
  if (digits.length === 11 && digits.startsWith("0")) digits = digits.slice(1);
  return digits;
}

export const phoneSchema = z
  .string()
  .trim()
  .transform(normalizePhone)
  .refine((v) => /^[6-9]\d{9}$/.test(v), "Enter a valid 10-digit mobile number");

export const objectId = z.string().regex(/^[a-f\d]{24}$/i, "Invalid id");

// Money in rupees, max 2 decimals.
export const money = z.coerce
  .number()
  .min(0, "Amount cannot be negative")
  .max(10_000_000)
  .refine((v) => Math.round(v * 100) === v * 100 || Math.abs(Math.round(v * 100) - v * 100) < 1e-6, "At most 2 decimals");

export function maskPhone(phone) {
  const p = String(phone || "");
  if (p.length < 10) return p;
  return `${p.slice(0, 2)}XXXX${p.slice(-4)}`;
}
