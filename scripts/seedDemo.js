// Fills a SEPARATE demo database with dummy catalog data for the offline store:
// categories + sub-categories, products with sizes and stock, and their SKU links.
// No customers, bills or expenses. It also creates one owner login so you can sign in.
//
// Usage:  npm run seed:demo            (refuses if the demo database already has data)
//         npm run seed:demo -- --reset (drops ONLY the demo database first)
//
// Safety: it always writes to DEMO_DB_NAME (default "offlinestoretheninthdrop") on the
// cluster from MONGODB_URI, never to the online store's database ("thenine" or LIVE_DB_NAME).
import "dotenv/config";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";

const DEMO_DB = process.env.DEMO_DB_NAME || "offlinestoretheninthdrop";
const PROTECTED = new Set(["thenine", "admin", "local", "config", process.env.LIVE_DB_NAME].filter(Boolean));
const RESET = process.argv.includes("--reset");

if (!process.env.MONGODB_URI) {
  console.error("Set MONGODB_URI in .env first.");
  process.exit(1);
}
if (PROTECTED.has(DEMO_DB)) {
  console.error(`Refusing: "${DEMO_DB}" is a protected database. Demo data never goes into the online store's database.`);
  process.exit(1);
}

// Point the app at the demo database for both POS data and the catalog,
// BEFORE the models load (they read these env vars on import).
const uri = new URL(process.env.MONGODB_URI);
uri.pathname = `/${DEMO_DB}`;
process.env.MONGODB_URI = uri.toString();
process.env.ONLINE_DB_NAME = DEMO_DB;

const { connectDB } = await import("../src/lib/db.js");
const M = await import("../src/lib/models.js");
const { getSettings } = await import("../src/lib/settings.js");
const { syncProductLinks } = await import("../src/services/products.js");

await connectDB();
const db = mongoose.connection.db;
if (db.databaseName !== DEMO_DB || PROTECTED.has(db.databaseName)) {
  console.error(`Refusing: connected to "${db.databaseName}", expected "${DEMO_DB}".`);
  process.exit(1);
}

const existing = await db.listCollections().toArray();
if (existing.length) {
  if (!RESET) {
    console.error(`"${DEMO_DB}" already has data. Run with --reset to drop and refill it (only this demo database).`);
    process.exit(1);
  }
  await db.dropDatabase();
  console.log(`Dropped demo database "${DEMO_DB}".`);
}
// Right after a drop, Atlas can briefly refuse new indexes, so retry a few times.
const models = Object.values(M).filter((x) => x?.prototype instanceof mongoose.Model && x.db.name === DEMO_DB);
for (let attempt = 1; ; attempt++) {
  try {
    await Promise.all(models.map((m) => m.createIndexes()));
    break;
  } catch (err) {
    if (attempt >= 5) throw err;
    await new Promise((r) => setTimeout(r, 2000));
  }
}

/* ── Helpers ──────────────────────────────────────────────────────────────── */

// Seeded random numbers, so every run produces the same demo shop.
let seed = 20261005;
function rand() {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const int = (min, max) => min + Math.floor(rand() * (max - min + 1));
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const round10 = (n) => Math.round(n / 10) * 10 - 1; // 1299-style prices
const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
const image = (label) => `https://placehold.co/600x800/f4efe6/1a1a1a?text=${encodeURIComponent(label)}`;

/* ── 1. Categories and sub-categories (same shape as the website's) ──────── */

const SIZES = {
  apparel: ["XS", "S", "M", "L", "XL", "XXL"],
  short: ["S", "M", "L", "XL"],
  waist: ["26", "28", "30", "32", "34"],
  free: ["Free Size"],
  one: [],
};

// A women's clothing store. code = the category's letters in each SKU.
const CATALOG = [
  {
    slug: "ethnic-wear", label: "Ethnic Wear", subs: [
      { label: "Kurtis", code: "KU", sizes: "apparel", price: [599, 1499], items: ["Chikankari Cotton Kurti", "Floral Print A-Line Kurti", "Mirror Work Kurti", "Block Print Straight Kurti"] },
      { label: "Kurta Sets", code: "KS", sizes: "apparel", price: [1299, 2999], items: ["Anarkali Kurta Set", "Cotton Kurta Palazzo Set", "Gota Patti Kurta Set"] },
      { label: "Sarees", code: "SR", sizes: "free", price: [1499, 5999], items: ["Banarasi Silk Saree", "Georgette Party Saree", "Cotton Handloom Saree"] },
      { label: "Lehengas", code: "LH", sizes: "short", price: [3999, 9999], items: ["Embroidered Bridal Lehenga", "Printed Festive Lehenga"] },
      { label: "Salwar Suits", code: "SS", sizes: "apparel", price: [999, 2499], items: ["Patiala Salwar Suit", "Unstitched Cotton Suit"] },
    ],
  },
  {
    slug: "western-wear", label: "Western Wear", subs: [
      { label: "Dresses", code: "DR", sizes: "short", price: [999, 2499], items: ["Tiered Maxi Dress", "Wrap Midi Dress", "Smocked Sundress"] },
      { label: "Tops", code: "TP", sizes: "short", price: [399, 999], items: ["Puff Sleeve Top", "Ribbed Crop Top", "Peplum Top"] },
      { label: "Shirts", code: "SH", sizes: "short", price: [699, 1299], items: ["Oversized Linen Shirt", "Satin Button Shirt"] },
      { label: "Co-ord Sets", code: "CO", sizes: "short", price: [1299, 2499], items: ["Printed Co-ord Set", "Knit Co-ord Set"] },
    ],
  },
  {
    slug: "bottom-wear", label: "Bottom Wear", subs: [
      { label: "Jeans", code: "JN", sizes: "waist", price: [999, 1999], items: ["High-Rise Mom Jeans", "Wide Leg Jeans", "Straight Fit Jeans"] },
      { label: "Palazzos", code: "PZ", sizes: "short", price: [499, 999], items: ["Rayon Palazzo", "Printed Flared Palazzo"] },
      { label: "Skirts", code: "SK", sizes: "short", price: [599, 1299], items: ["Pleated Midi Skirt", "Denim Mini Skirt"] },
    ],
  },
  {
    slug: "winter-wear", label: "Winter Wear", subs: [
      { label: "Shrugs", code: "SG", sizes: "short", price: [699, 1499], items: ["Crochet Shrug", "Long Knit Shrug"] },
      { label: "Jackets", code: "JK", sizes: "short", price: [1499, 3499], items: ["Cropped Denim Jacket", "Quilted Puffer Jacket"] },
    ],
  },
  {
    slug: "accessories", label: "Accessories", subs: [
      { label: "Dupattas", code: "DU", sizes: "one", price: [399, 1199], items: ["Phulkari Dupatta", "Chiffon Dupatta", "Banarasi Dupatta"] },
      { label: "Handbags", code: "HB", sizes: "one", price: [799, 2499], items: ["Quilted Sling Bag", "Embroidered Potli"] },
    ],
  },
];
const COLORS = ["Black", "Ivory", "Maroon", "Mustard", "Blush Pink", "Teal", "Lavender", "Olive", "Peach", "Wine", "Powder Blue", "Rani Pink"];

const now = new Date();
const catDocs = [];
let order = 0;
for (const top of CATALOG) {
  const topDoc = { _id: new mongoose.Types.ObjectId(), slug: top.slug, label: top.label, description: "", kind: "structural", parent: null, image: { url: null, publicId: null }, sortOrder: order++, isActive: true, showInNav: true, createdAt: now, updatedAt: now };
  catDocs.push(topDoc);
  top.subs.forEach((sub, i) => {
    sub.slug = slugify(sub.label);
    catDocs.push({ _id: new mongoose.Types.ObjectId(), slug: sub.slug, label: sub.label, description: "", kind: "subcategory", parent: topDoc._id, image: { url: null, publicId: null }, sortOrder: i, isActive: true, showInNav: true, createdAt: now, updatedAt: now });
  });
}
catDocs.push({ _id: new mongoose.Types.ObjectId(), slug: "new-arrivals", label: "New Arrivals", description: "", kind: "structural", parent: null, image: { url: null, publicId: null }, sortOrder: order++, isActive: true, showInNav: true, createdAt: now, updatedAt: now });
await db.collection("categories").insertMany(catDocs);

await M.PosCategorySetting.insertMany(CATALOG.flatMap((t) => t.subs.map((s) => ({ categorySlug: s.slug, code: s.code }))));

/* ── 2. Products with sizes and stock (same shape as the website's) ──────── */

const productDocs = [];
let pNo = 0;
for (const top of CATALOG) {
  for (const sub of top.subs) {
    for (const name of sub.items) {
      pNo += 1;
      const color = pick(COLORS);
      const sizes = SIZES[sub.sizes];
      const price = round10(int(sub.price[0], sub.price[1]));
      const onSale = rand() < 0.3;
      const variants = sizes.map((size) => ({ size, color, sku: "", stock: int(2, 12) }));
      const stock = variants.length ? variants.reduce((a, v) => a + v.stock, 0) : int(5, 20);
      const isNew = rand() < 0.25;
      productDocs.push({
        productId: `d${String(pNo).padStart(3, "0")}`,
        slug: `${slugify(name)}-${pNo}`,
        name,
        categories: [sub.slug, top.slug, ...(isNew ? ["new-arrivals"] : [])],
        price,
        originalPrice: onSale ? round10(price * 1.35) : null,
        images: [image(name)],
        colorName: color,
        sizes,
        variants,
        stock,
        inStock: stock > 0,
        badge: onSale ? "Sale" : isNew ? "New" : "",
        isActive: true,
        tags: [sub.slug, top.slug, "demo"],
        createdAt: now,
        updatedAt: now,
      });
    }
  }
}
await db.collection("products").insertMany(productDocs);

/* ── 3. Store settings, owner login, SKU links ──────────────────────────── */

await getSettings();
await M.PosSettings.updateOne(
  { key: "store" },
  {
    $set: {
      "store.name": "THE NINTH DROP (DEMO)",
      "store.address": "12 Main Bazaar, Jind, Haryana 126102",
      "limits.adminPinHash": await bcrypt.hash("1234", 10),
      updatedBy: "seed-demo",
    },
  }
);

const DEMO_PASSWORD = "Demo@1234";
await M.PosUser.create({ name: "Owner (Demo)", username: "owner", email: "owner@demo.local", passwordHash: await bcrypt.hash(DEMO_PASSWORD, 12), role: "SUPER_ADMIN", discountLimitPercent: 100 });

const sync = await syncProductLinks();
const priceById = new Map((await M.OnlineProduct.find().lean()).map((p) => [String(p._id), p.price]));
for (const link of await M.PosProductLink.find()) {
  link.costPrice = Math.round(priceById.get(String(link.productId)) * (0.45 + rand() * 0.15));
  await link.save();
}

/* ── Summary ─────────────────────────────────────────────────────────────── */

const count = async (name) => db.collection(name).countDocuments();
console.log(`
Demo catalog ready in database "${DEMO_DB}" (the online store's database was not touched):`);
console.log(`  categories  ${await count("categories")}  (${CATALOG.length} main + ${CATALOG.reduce((a, t) => a + t.subs.length, 0)} sub-categories + New Arrivals)`);
console.log(`  products    ${await count("products")}  →  ${sync.created} SKUs ready to scan`);
console.log(`
Login: owner / ${DEMO_PASSWORD}     Owner approval PIN: 1234`);

await mongoose.disconnect();
