import mongoose from "mongoose";

const { Schema } = mongoose;
const ObjectId = Schema.Types.ObjectId;

function model(name, schema, collection) {
  return mongoose.models[name] || mongoose.model(name, schema, collection);
}

// The online store's database (products, categories, ...). POS data lives in the
// database named in MONGODB_URI; ONLINE_DB_NAME points at the online one on the
// SAME cluster, so a sale's stock update and bill still share one transaction.
// Not set = both live in the same database.
const onlineDb = process.env.ONLINE_DB_NAME
  ? mongoose.connection.useDb(process.env.ONLINE_DB_NAME, { useCache: true })
  : mongoose.connection;

function onlineModel(name, schema, collection) {
  return onlineDb.models[name] || onlineDb.model(name, schema, collection);
}

/* ────────────────────────────────────────────────────────────────────────
 * CATALOG COLLECTIONS (products, categories) in the ONLINE_DB_NAME database.
 * These mirror the online backend's schemas, so a catalog made here has the
 * same shape as the website's.
 * - When ONLINE_DB_NAME is the website's own database, the POS only READS them,
 *   plus the atomic stock update in lib/stock.js. services/catalog.js refuses
 *   every create/edit/delete there.
 * - When it is the store's own database (e.g. the demo), the owner manages
 *   products and categories from the POS.
 * No indexes are created on these collections.
 * ──────────────────────────────────────────────────────────────────────── */
const readOnlyOpts = { timestamps: true, autoIndex: false, autoCreate: false, strict: true };

const onlineVariantSchema = new Schema(
  // price: this size's own selling price; empty = the product price.
  { size: String, color: String, sku: String, stock: Number, price: Number },
  { _id: false }
);
const onlineProductSchema = new Schema(
  {
    productId: String,
    slug: String,
    name: String,
    description: String,
    categories: [String],
    price: Number,
    originalPrice: Number,
    images: [String],
    colorName: String,
    sizes: [String],
    variants: [onlineVariantSchema],
    stock: Number,
    inStock: Boolean,
    badge: String,
    tags: [String],
    isActive: Boolean,
  },
  readOnlyOpts
);
export const OnlineProduct = onlineModel("OnlineProduct", onlineProductSchema, "products");

const onlineCategorySchema = new Schema(
  {
    slug: String,
    label: String,
    description: String,
    kind: String, // "structural" = main category, "subcategory" = has a parent
    parent: ObjectId,
    image: { url: String, publicId: String },
    isActive: Boolean,
    showInNav: Boolean,
    sortOrder: Number,
  },
  readOnlyOpts
);
export const OnlineCategory = onlineModel("OnlineCategory", onlineCategorySchema, "categories");

const onlineUserSchema = new Schema({ name: String, email: String, phone: String, role: String }, readOnlyOpts);
export const OnlineUser = onlineModel("OnlineUser", onlineUserSchema, "users");

const onlineOrderSchema = new Schema(
  {
    orderNumber: String,
    user: ObjectId,
    items: [{ _id: false, name: String, size: String, qty: Number, price: Number }],
    total: Number,
    paymentStatus: String,
    orderStatus: String,
  },
  readOnlyOpts
);
export const OnlineOrder = onlineModel("OnlineOrder", onlineOrderSchema, "orders");

/* ────────────────────────────────────────────────────────────────────────
 * POS COLLECTIONS — all prefixed `pos_`.
 * ──────────────────────────────────────────────────────────────────────── */
export const ROLES = ["SUPER_ADMIN", "OPERATOR"];

const posUserSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    phone: { type: String, trim: true, default: "" },
    // No default: sparse unique indexes only skip fields that are missing.
    email: { type: String, lowercase: true, trim: true },
    username: { type: String, lowercase: true, trim: true },
    passwordHash: { type: String, required: true, select: false },
    role: { type: String, enum: ROLES, required: true },
    extraPermissions: { type: [String], default: [] },
    revokedPermissions: { type: [String], default: [] },
    discountLimitPercent: { type: Number, default: 10, min: 0, max: 100 },
    isActive: { type: Boolean, default: true },
    mustChangePassword: { type: Boolean, default: false },
    // Bumped to sign the user out everywhere at once.
    tokenVersion: { type: Number, default: 0 },
    failedLoginCount: { type: Number, default: 0 },
    lockUntil: { type: Date, default: null },
    lastLoginAt: { type: Date, default: null },
    createdBy: { type: ObjectId, ref: "PosUser", default: null },
  },
  { timestamps: true }
);
posUserSchema.index({ email: 1 }, { unique: true, sparse: true });
posUserSchema.index({ username: 1 }, { unique: true, sparse: true });
export const PosUser = model("PosUser", posUserSchema, "pos_users");

// One row per sellable variant (product + size). The SKU on the tag lives here.
const productLinkSchema = new Schema(
  {
    sku: { type: String, required: true, uppercase: true, trim: true },
    productId: { type: ObjectId, required: true },
    // How the online product identifies the variant: its size (null = no sizes).
    variantKey: { type: String, default: null },
    size: { type: String, default: null },
    color: { type: String, default: null },
    costPrice: { type: Number, default: null },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);
productLinkSchema.index({ sku: 1 }, { unique: true });
productLinkSchema.index({ productId: 1, variantKey: 1 }, { unique: true });
export const PosProductLink = model("PosProductLink", productLinkSchema, "pos_product_links");

const categorySettingSchema = new Schema(
  {
    categorySlug: { type: String, required: true },
    code: { type: String, uppercase: true, trim: true, default: "" }, // 2–4 letters used in SKUs
  },
  { timestamps: true }
);
categorySettingSchema.index({ categorySlug: 1 }, { unique: true });
export const PosCategorySetting = model("PosCategorySetting", categorySettingSchema, "pos_category_settings");

const customerSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    phone: { type: String, required: true, trim: true },
    email: { type: String, trim: true, lowercase: true, default: "" },
    address: { type: String, trim: true, default: "" },
    dob: { type: Date, default: null },
    notes: { type: String, default: "" },
    totalSpent: { type: Number, default: 0 },
    totalVisits: { type: Number, default: 0 },
    lastVisitAt: { type: Date, default: null },
    storeCredit: { type: Number, default: 0, min: 0 },
    onlineUserId: { type: ObjectId, default: null }, // read-only link to an online account
    createdBy: { type: ObjectId, default: null },
  },
  { timestamps: true }
);
customerSchema.index({ phone: 1 }, { unique: true });
export const PosCustomer = model("PosCustomer", customerSchema, "pos_customers");

const saleItemSchema = new Schema(
  {
    productId: ObjectId,
    sku: String,
    name: String,
    size: String,
    color: String,
    image: String,
    qty: Number,
    mrp: Number, // per unit
    price: Number, // per unit selling price at sale time
    lineGross: Number, // price × qty
    discount: Number, // share of the bill discount
    lineTotal: Number, // what the customer pays for this line
    isSaleItem: Boolean, // was on sale → exchange-only if the policy says so
    returnedQty: { type: Number, default: 0 },
  },
  { _id: false }
);

const paymentSchema = new Schema({
  mode: { type: String, enum: ["CASH", "ONLINE", "STORE_CREDIT"], required: true },
  amount: { type: Number, required: true },
  status: { type: String, enum: ["RECEIVED", "PENDING", "REVERSED"], default: "PENDING" },
  ref: { type: String, default: "" }, // UTR / last digits for online
  receivedAt: { type: Date, default: null },
  verifiedBy: { type: ObjectId, default: null },
  verifiedByName: { type: String, default: "" },
});

export const SALE_STATUSES = [
  "PAID",
  "PARTIAL",
  "PENDING",
  "PENDING_VERIFICATION",
  "CANCELLED",
  "RETURNED",
  "PARTIALLY_RETURNED",
];

const saleSchema = new Schema(
  {
    billNo: { type: String, required: true },
    customer: { type: ObjectId, ref: "PosCustomer", default: null }, // null = walk-in
    customerSnapshot: { name: String, phone: String },
    items: [saleItemSchema],
    mrpTotal: Number,
    subTotal: Number,
    discount: { type: Number, default: 0 },
    discountPercent: { type: Number, default: 0 },
    discountReason: { type: String, default: "" },
    discountApprovedBy: { type: String, default: "" },
    roundOff: Number,
    grandTotal: Number,
    payments: [paymentSchema],
    status: { type: String, enum: SALE_STATUSES, required: true },
    // True once the customer's totals include this bill (only when fully paid).
    statsApplied: { type: Boolean, default: false },
    soldBy: { type: ObjectId, ref: "PosUser", required: true },
    soldByName: String,
    exchangeAgainst: { type: String, default: "" },
    invoice: {
      publicToken: String,
      format: String,
      title: String,
      store: { type: Schema.Types.Mixed, default: {} },
      printCount: { type: Number, default: 0 },
      lastPrintedAt: { type: Date, default: null },
    },
    cancelReason: { type: String, default: "" },
    cancelledBy: { type: String, default: "" },
    cancelledAt: { type: Date, default: null },
    // Cash handed back when the bill was cancelled.
    cancelCashRefund: { type: Number, default: 0 },
  },
  { timestamps: true }
);
saleSchema.index({ billNo: 1 }, { unique: true });
saleSchema.index({ "invoice.publicToken": 1 }, { unique: true });
saleSchema.index({ createdAt: -1 });
saleSchema.index({ soldBy: 1, createdAt: -1 });
saleSchema.index({ customer: 1, createdAt: -1 });
export const PosSale = model("PosSale", saleSchema, "pos_sales");

const returnSchema = new Schema(
  {
    returnNo: { type: String, default: null }, // credit note number, assigned when processed
    sale: { type: ObjectId, ref: "PosSale", required: true },
    billNo: String,
    customer: { type: ObjectId, default: null },
    customerSnapshot: { name: String, phone: String },
    items: [
      {
        _id: false,
        lineIndex: Number,
        sku: String,
        name: String,
        size: String,
        qty: Number,
        amount: Number,
      },
    ],
    reason: { type: String, required: true },
    refundMode: { type: String, enum: ["CASH", "ONLINE", "STORE_CREDIT", "EXCHANGE"], required: true },
    refundAmount: Number,
    status: { type: String, enum: ["PENDING", "PROCESSED", "REJECTED"], default: "PENDING" },
    outsidePolicy: { type: Boolean, default: false },
    overrideReason: { type: String, default: "" },
    requestedBy: ObjectId,
    requestedByName: String,
    approvedBy: { type: String, default: "" },
    processedAt: { type: Date, default: null },
  },
  { timestamps: true }
);
returnSchema.index({ sale: 1 });
returnSchema.index({ processedAt: -1 });
returnSchema.index({ returnNo: 1 }, { unique: true, sparse: true });
export const PosReturn = model("PosReturn", returnSchema, "pos_returns");

export const EXPENSE_CATEGORIES = ["TEA_SNACKS", "CLEANING", "TRANSPORT", "MISC"];
const expenseSchema = new Schema(
  {
    title: { type: String, required: true, trim: true },
    category: { type: String, enum: EXPENSE_CATEGORIES, required: true },
    amount: { type: Number, required: true, min: 0 },
    paidVia: { type: String, enum: ["CASH", "ONLINE"], required: true },
    date: { type: Date, default: Date.now },
    addedBy: ObjectId,
    addedByName: String,
    status: { type: String, enum: ["APPROVED", "PENDING", "REJECTED"], default: "APPROVED" },
    note: { type: String, default: "" },
  },
  { timestamps: true }
);
expenseSchema.index({ date: -1 });
expenseSchema.index({ addedBy: 1, date: -1 });
export const PosExpense = model("PosExpense", expenseSchema, "pos_expenses");

// Append-only. There is deliberately no update or delete code for this model.
const auditSchema = new Schema(
  {
    user: { type: ObjectId, default: null },
    userName: { type: String, default: "" },
    role: { type: String, default: "" },
    action: { type: String, required: true },
    entity: { type: String, default: "" },
    entityId: { type: String, default: "" },
    before: { type: Schema.Types.Mixed, default: null },
    after: { type: Schema.Types.Mixed, default: null },
    ip: { type: String, default: "" },
    userAgent: { type: String, default: "" },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);
auditSchema.index({ createdAt: -1 });
auditSchema.index({ action: 1, createdAt: -1 });
auditSchema.index({ user: 1, createdAt: -1 });
export const PosAuditLog = model("PosAuditLog", auditSchema, "pos_audit_logs");

const counterSchema = new Schema({ _id: String, seq: { type: Number, default: 0 } });
export const PosCounter = model("PosCounter", counterSchema, "pos_counters");

// An owner-made block on a bill: a heading and its text, near the top or bottom.
const billSectionSchema = new Schema(
  {
    heading: { type: String, default: "" },
    text: { type: String, default: "" },
    position: { type: String, enum: ["TOP", "BOTTOM"], default: "BOTTOM" },
  },
  { _id: false }
);

// One printed copy of a bill: its heading, custom notes, extra sections and what it shows.
function copySchema(label, topNote, bottomNote) {
  return {
    enabled: { type: Boolean, default: true },
    label: { type: String, default: label },
    topNote: { type: String, default: topNote },
    bottomNote: { type: String, default: bottomNote },
    showPrices: { type: Boolean, default: true },
    showQr: { type: Boolean, default: true },
    sections: { type: [billSectionSchema], default: [] },
  };
}

const settingsSchema = new Schema(
  {
    key: { type: String, default: "store" },
    store: {
      name: { type: String, default: "THE NINTH DROP" },
      logo: { type: String, default: "" }, // data URL (small image)
      address: { type: String, default: "" },
      phone: { type: String, default: "" },
      email: { type: String, default: "" },
      website: { type: String, default: "" },
      instagram: { type: String, default: "" },
    },
    invoice: {
      defaultFormat: { type: String, enum: ["THERMAL", "A5"], default: "THERMAL" },
      policyText: {
        type: String,
        default: "Exchange/return within 7 days with bill and original tags. Sale items are exchange only.",
      },
      footerText: { type: String, default: "Thank you for shopping with us!" },
    },
    returns: {
      days: { type: Number, default: 7 },
      saleExchangeOnly: { type: Boolean, default: true },
      autoApproveLimit: { type: Number, default: 1000 },
    },
    payments: {
      operatorCanVerifyOnline: { type: Boolean, default: true },
    },
    limits: {
      defaultDiscountPercent: { type: Number, default: 10 },
      expenseApprovalLimit: { type: Number, default: 500 },
      adminPinHash: { type: String, default: "", select: false },
    },
    security: {
      storeHoursOnly: { type: Boolean, default: false },
      openTime: { type: String, default: "09:00" },
      closeTime: { type: String, default: "22:00" },
    },
    stock: { lowStockThreshold: { type: Number, default: 3 } },
    // Each print makes one copy per enabled entry, in this order: ORIGINAL then PICKUP.
    copies: {
      original: copySchema("ORIGINAL", "Customer copy", ""),
      pickup: copySchema("PICKUP", "Show this slip at the pickup counter to collect your items.", ""),
    },
    updatedBy: { type: String, default: "" },
  },
  { timestamps: true, minimize: false }
);
settingsSchema.index({ key: 1 }, { unique: true });
export const PosSettings = model("PosSettings", settingsSchema, "pos_settings");
