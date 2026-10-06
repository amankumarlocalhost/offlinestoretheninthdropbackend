import { z } from "zod";
import { phoneSchema, objectId, money } from "./validate.js";
import { ALL_PERMISSIONS } from "./permissions.js";
import { EXPENSE_CATEGORIES } from "./models.js";

const perm = z.enum(ALL_PERMISSIONS);
const password = z.string().min(8, "Password must be at least 8 characters").max(100);
const username = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9._-]{3,30}$/, "Username: 3–30 letters, numbers, dot, dash or underscore");

export const loginSchema = z.object({
  identifier: z.string().trim().min(1, "Enter your username or email").max(100),
  password: z.string().min(1, "Enter your password").max(100),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: password,
});

export const createUserSchema = z.object({
  name: z.string().trim().min(1).max(80),
  phone: z.string().trim().max(15).optional().default(""),
  email: z.string().trim().toLowerCase().email().optional().or(z.literal("")),
  username: username.optional().or(z.literal("")),
  password,
  role: z.enum(["SUPER_ADMIN", "OPERATOR"]).default("OPERATOR"),
  extraPermissions: z.array(perm).optional(),
  revokedPermissions: z.array(perm).optional(),
  discountLimitPercent: z.coerce.number().min(0).max(100).optional(),
});

export const updateUserSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  phone: z.string().trim().max(15).optional(),
  email: z.string().trim().toLowerCase().email().optional().or(z.literal("")),
  username: username.optional().or(z.literal("")),
  role: z.enum(["SUPER_ADMIN", "OPERATOR"]).optional(),
  extraPermissions: z.array(perm).optional(),
  revokedPermissions: z.array(perm).optional(),
  discountLimitPercent: z.coerce.number().min(0).max(100).optional(),
  isActive: z.boolean().optional(),
  unlock: z.boolean().optional(),
  newPassword: password.optional(),
});

export const customerSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(80),
  phone: phoneSchema,
  email: z.string().trim().toLowerCase().email().optional().or(z.literal("")),
  address: z.string().trim().max(300).optional(),
  dob: z.coerce.date().optional().nullable(),
  notes: z.string().trim().max(500).optional(),
});
export const customerUpdateSchema = customerSchema.partial();

export const saleSchema = z.object({
  // Every bill needs a customer (mobile + name). Walk-in bills are not allowed.
  customerId: objectId.nullable().optional().refine((v) => Boolean(v), "Add the customer's mobile number and name first."),
  items: z
    .array(z.object({ sku: z.string().trim().min(1).max(40), qty: z.coerce.number().int().min(1).max(100) }))
    .min(1, "Add at least one item")
    .max(200),
  discount: z
    .object({
      type: z.enum(["AMOUNT", "PERCENT"]),
      value: z.coerce.number().min(0),
      reason: z.string().trim().max(200).optional().default(""),
    })
    .optional()
    .nullable(),
  approvalToken: z.string().max(1000).optional().nullable(),
  payments: z
    .array(
      z.object({
        mode: z.enum(["CASH", "ONLINE", "STORE_CREDIT"]),
        amount: money,
        ref: z.string().trim().max(40).optional().default(""),
        verified: z.boolean().optional().default(false),
      })
    )
    .min(1, "Add a payment")
    .max(5),
  exchangeAgainst: z.string().trim().max(30).optional().default(""),
});

export const reasonSchema = z.object({ reason: z.string().trim().min(1, "A reason is required").max(300) });
export const verifySchema = z.object({ ref: z.string().trim().max(40).optional() });


export const returnSchema = z.object({
  saleId: objectId,
  items: z.array(z.object({ lineIndex: z.number().int().min(0), qty: z.number().int().min(0).max(100) })).min(1),
  reason: z.string().trim().min(1, "A reason is required").max(300),
  refundMode: z.enum(["CASH", "ONLINE", "STORE_CREDIT", "EXCHANGE"]),
  overrideReason: z.string().trim().max(300).optional(),
});

export const expenseSchema = z.object({
  title: z.string().trim().min(1).max(100),
  category: z.enum(EXPENSE_CATEGORIES),
  amount: money.refine((v) => v > 0, "Amount must be more than zero"),
  paidVia: z.enum(["CASH", "ONLINE"]),
  date: z.coerce.date().optional(),
  note: z.string().trim().max(300).optional(),
});

export const pinSchema = z.object({
  pin: z.string().regex(/^\d{4}$/, "PIN is 4 digits"),
  percent: z.coerce.number().min(0.01).max(100),
});

export const linkUpdateSchema = z.object({
  costPrice: money.nullable().optional(),
  isActive: z.boolean().optional(),
});
export const stockAdjustSchema = z.object({
  delta: z.coerce.number().int(),
  reason: z.string().trim().min(1, "A reason is required").max(300),
});
export const categorySettingSchema = z.object({
  categorySlug: z.string().trim().min(1).max(80),
  code: z.string().trim().toUpperCase().regex(/^[A-Z]{2,4}$/, "Code: 2–4 letters").or(z.literal("")),
});

const printCopy = z.object({
  enabled: z.boolean(),
  label: z.string().trim().max(40),
  topNote: z.string().trim().max(300),
  bottomNote: z.string().trim().max(300),
  showPrices: z.boolean(),
  showQr: z.boolean(),
  sections: z
    .array(
      z.object({
        heading: z.string().trim().max(60),
        text: z.string().trim().max(500),
        position: z.enum(["TOP", "BOTTOM"]),
      })
    )
    .max(10, "At most 10 sections per copy")
    .optional()
    .default([]),
});
// Owner's tag layout. At most 3 extra lines, so the barcode keeps enough height to scan.
const tagDesign = z.object({
  enabled: z.boolean(),
  brand: z.string().trim().max(30),
  label: z.string().trim().max(14),
  showName: z.boolean(),
  showColor: z.boolean(),
  showPrice: z.boolean(),
  showMrp: z.boolean(),
  showSize: z.boolean(),
  showSku: z.boolean(),
  showPiece: z.boolean(),
  fields: z
    .array(z.object({ label: z.string().trim().max(16), text: z.string().trim().max(40) }))
    .max(3, "At most 3 extra lines on a tag, so the barcode stays scannable")
    .optional()
    .default([]),
});
const timeStr = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:mm");
export const settingsSchema = z.object({
  store: z
    .object({
      name: z.string().trim().max(80),
      address: z.string().trim().max(300),
      phone: z.string().trim().max(30),
      email: z.string().trim().max(100),
      website: z.string().trim().max(100),
      instagram: z.string().trim().max(100),
    })
    .partial()
    .optional(),
  invoice: z
    .object({
      defaultFormat: z.enum(["THERMAL", "A5"]),
      policyText: z.string().trim().max(600),
      footerText: z.string().trim().max(200),
    })
    .partial()
    .optional(),
  returns: z
    .object({ days: z.coerce.number().int().min(0).max(365), saleExchangeOnly: z.boolean(), autoApproveLimit: money })
    .partial()
    .optional(),
  payments: z.object({ operatorCanVerifyOnline: z.boolean() }).partial().optional(),
  limits: z
    .object({
      defaultDiscountPercent: z.coerce.number().min(0).max(100),
      expenseApprovalLimit: money,
      adminPin: z.string().regex(/^\d{4}$/, "PIN is 4 digits").or(z.literal("")),
    })
    .partial()
    .optional(),
  security: z.object({ storeHoursOnly: z.boolean(), openTime: timeStr, closeTime: timeStr }).partial().optional(),
  stock: z.object({ lowStockThreshold: z.coerce.number().int().min(0).max(1000) }).partial().optional(),
  copies: z.object({ original: printCopy, pickup: printCopy }).partial().optional(),
  tags: z.object({ original: tagDesign, pickup: tagDesign }).partial().optional(),
});

/* ── Catalog (owner) ──────────────────────────────────────────────────────── */

const skuCode = z.string().trim().toUpperCase().regex(/^[A-Z]{2,4}$/, "SKU code: 2–4 letters").or(z.literal(""));

export const categoryCreateSchema = z.object({
  label: z.string().trim().min(1, "Enter a name").max(60),
  parentId: objectId.nullable().optional(), // empty = main category
  description: z.string().trim().max(300).optional().default(""),
  sortOrder: z.coerce.number().int().min(0).max(999).optional().default(0),
  isActive: z.boolean().optional().default(true),
  code: skuCode.optional().default(""),
});
export const categoryUpdateSchema = categoryCreateSchema
  .partial()
  .extend({ description: z.string().trim().max(300).optional(), sortOrder: z.coerce.number().int().min(0).max(999).optional(), isActive: z.boolean().optional(), code: skuCode.optional() });

const size = z.string().trim().min(1).max(20);
const imageUrl = z.string().trim().url("Image must be a link (https://…)").max(500).refine((v) => v.startsWith("https://"), "Image link must start with https://");
const productFields = {
  name: z.string().trim().min(1, "Enter a name").max(120),
  description: z.string().trim().max(2000),
  categoryId: objectId,
  newArrival: z.boolean(),
  price: money.refine((v) => v > 0, "Price must be more than zero"),
  originalPrice: money.nullable(),
  colorName: z.string().trim().max(40),
  images: z.array(imageUrl).max(8),
  badge: z.string().trim().max(20),
  isActive: z.boolean(),
};
const uniqueSizes = (list) => new Set(list.map((v) => v.size.toUpperCase())).size === list.length;

export const productCreateSchema = z.object({
  ...productFields,
  description: productFields.description.optional().default(""),
  newArrival: productFields.newArrival.optional().default(false),
  originalPrice: productFields.originalPrice.optional().default(null),
  colorName: productFields.colorName.optional().default(""),
  images: productFields.images.optional().default([]),
  badge: productFields.badge.optional().default(""),
  isActive: productFields.isActive.optional().default(true),
  // Sizes with their opening stock. Empty = one-size product using oneSizeStock.
  variants: z.array(z.object({ size, stock: z.coerce.number().int().min(0).max(100000), price: money.nullable().optional() })).max(20).refine(uniqueSizes, "Each size only once").optional().default([]),
  oneSizeStock: z.coerce.number().int().min(0).max(100000).optional().default(0),
  costPrice: money.nullable().optional(),
});

// Stock of sizes that already exist is changed with the Stock button (audited),
// so here a size only carries stock when it is new.
export const productUpdateSchema = z
  .object({
    ...productFields,
    variants: z.array(z.object({ size, stock: z.coerce.number().int().min(0).max(100000).optional().default(0), price: money.nullable().optional() })).max(20).refine(uniqueSizes, "Each size only once"),
  })
  .partial();
