// Owner-managed catalog: categories, sub-categories and products.
//
// These live in the ONLINE_DB_NAME database. When that is the website's own
// database, every write here is refused, so the website's catalog can never be
// changed from the store. Only the store's own catalog database (e.g. the
// demo) is editable.
import mongoose from "mongoose";
import { OnlineProduct, OnlineCategory, PosCategorySetting, PosProductLink, PosSale, PosCounter } from "../lib/models.js";
import { AppError, badRequest, notFound, conflict } from "../lib/errors.js";
import { audit } from "../lib/audit.js";
import { syncProductLinks } from "./products.js";

const LIVE_DBS = new Set(["thenine", ...String(process.env.LIVE_DB_NAME || "").split(",").map((s) => s.trim()).filter(Boolean)]);
const NEW_ARRIVALS = "new-arrivals";

export function catalogInfo() {
  const database = OnlineProduct.db.name;
  return { database, editable: !LIVE_DBS.has(database) };
}

function assertEditable() {
  if (!catalogInfo().editable) {
    throw new AppError("These products and categories belong to the website. Edit them in the online admin.", "CATALOG_READ_ONLY", 403);
  }
}

function slugify(text) {
  return String(text).toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 60) || "item";
}

// "kurtis", then "kurtis-2", "kurtis-3"... until it is free in that collection.
async function uniqueSlug(Model, text) {
  const base = slugify(text);
  let slug = base;
  for (let n = 2; await Model.exists({ slug }); n++) slug = `${base}-${n}`;
  return slug;
}

async function assertCodeFree(code, exceptSlug) {
  if (!code) return;
  const taken = await PosCategorySetting.findOne({ code, categorySlug: { $ne: exceptSlug } }).lean();
  if (taken) throw conflict(`SKU code ${code} is already used by another category.`);
}

async function saveCategorySetting(slug, { code }) {
  if (code !== undefined) await PosCategorySetting.updateOne({ categorySlug: slug }, { $set: { code } }, { upsert: true });
}

/* ── Categories ───────────────────────────────────────────────────────────── */

// Main categories with their sub-categories, product counts and POS settings.
export async function categoryTree() {
  const [cats, settings, counts] = await Promise.all([
    OnlineCategory.find().sort({ sortOrder: 1, label: 1 }).lean(),
    PosCategorySetting.find().lean(),
    OnlineProduct.aggregate([{ $unwind: "$categories" }, { $group: { _id: "$categories", n: { $sum: 1 } } }]),
  ]);
  const setting = new Map(settings.map((s) => [s.categorySlug, s]));
  const count = new Map(counts.map((c) => [c._id, c.n]));
  const shape = (c) => {
    const s = setting.get(c.slug);
    return {
      id: String(c._id),
      slug: c.slug,
      label: c.label,
      description: c.description || "",
      parentId: c.parent ? String(c.parent) : null,
      sortOrder: c.sortOrder ?? 0,
      isActive: c.isActive !== false,
      productCount: count.get(c.slug) || 0,
      code: s?.code || "",
    };
  };
  const mains = cats.filter((c) => !c.parent).map((c) => ({ ...shape(c), children: [] }));
  const byId = new Map(mains.map((m) => [m.id, m]));
  for (const c of cats) if (c.parent && byId.has(String(c.parent))) byId.get(String(c.parent)).children.push(shape(c));
  return { items: mains, ...catalogInfo() };
}

async function mainCategory(parentId) {
  const parent = await OnlineCategory.findById(parentId).lean();
  if (!parent) throw notFound("Main category not found.");
  if (parent.parent) throw badRequest("A sub-category can only sit under a main category.");
  return parent;
}

export async function createCategory(input, actor, info) {
  assertEditable();
  const parent = input.parentId ? await mainCategory(input.parentId) : null;
  const slug = await uniqueSlug(OnlineCategory, input.label);
  await assertCodeFree(input.code, slug);
  const cat = await OnlineCategory.create({
    slug,
    label: input.label,
    description: input.description,
    kind: parent ? "subcategory" : "structural",
    parent: parent?._id || null,
    image: { url: null, publicId: null },
    isActive: input.isActive,
    showInNav: true,
    sortOrder: input.sortOrder,
  });
  await saveCategorySetting(slug, { code: input.code });
  await audit({ user: actor, action: "CATEGORY_CREATE", entity: "Category", entityId: slug, after: { label: cat.label, parent: parent?.label || null, code: input.code }, ...info });
  return cat;
}

// The slug never changes, so products and SKUs that point to it stay linked.
export async function updateCategory(id, patch, actor, info) {
  assertEditable();
  const cat = await OnlineCategory.findById(id);
  if (!cat) throw notFound("Category not found.");
  const before = { label: cat.label, parent: cat.parent ? String(cat.parent) : null, isActive: cat.isActive };

  if (patch.parentId !== undefined) {
    const isSub = Boolean(cat.parent);
    if (!isSub && patch.parentId) throw badRequest("A main category cannot be moved under another one.");
    if (isSub && !patch.parentId) throw badRequest("Choose the main category for this sub-category.");
    if (isSub) cat.parent = (await mainCategory(patch.parentId))._id;
  }
  for (const key of ["label", "description", "sortOrder", "isActive"]) if (patch[key] !== undefined) cat[key] = patch[key];
  await assertCodeFree(patch.code, cat.slug);
  await cat.save();
  await saveCategorySetting(cat.slug, patch);
  await audit({ user: actor, action: "CATEGORY_UPDATE", entity: "Category", entityId: cat.slug, before, after: patch, ...info });
  return cat;
}

export async function deleteCategory(id, actor, info) {
  assertEditable();
  const cat = await OnlineCategory.findById(id).lean();
  if (!cat) throw notFound("Category not found.");
  const subs = await OnlineCategory.countDocuments({ parent: cat._id });
  if (subs) throw badRequest(`"${cat.label}" has ${subs} sub-categor${subs === 1 ? "y" : "ies"}. Delete or move them first.`);
  const used = await OnlineProduct.countDocuments({ categories: cat.slug });
  if (used) throw badRequest(`${used} product${used === 1 ? " is" : "s are"} in "${cat.label}". Move or delete ${used === 1 ? "it" : "them"} first.`);
  await OnlineCategory.deleteOne({ _id: cat._id });
  await PosCategorySetting.deleteOne({ categorySlug: cat.slug });
  await audit({ user: actor, action: "CATEGORY_DELETE", entity: "Category", entityId: cat.slug, before: { label: cat.label }, ...info });
  return { deleted: true };
}

/* ── Products ─────────────────────────────────────────────────────────────── */

// Like the website: [chosen category, its main category, "new-arrivals"?].
async function categorySlugs(categoryId, newArrival) {
  const cat = await OnlineCategory.findById(categoryId).lean();
  if (!cat) throw badRequest("Choose a category.");
  const slugs = [cat.slug];
  if (cat.parent) {
    const parent = await OnlineCategory.findById(cat.parent).select("slug").lean();
    if (parent) slugs.push(parent.slug);
  }
  if (newArrival && (await OnlineCategory.exists({ slug: NEW_ARRIVALS })) && !slugs.includes(NEW_ARRIVALS)) slugs.push(NEW_ARRIVALS);
  return slugs;
}

// Next "p042"-style product code, continuing after the highest one in use.
async function nextProductCode() {
  const key = "catalog-product-no";
  if (!(await PosCounter.exists({ _id: key }))) {
    let max = 0;
    for (const p of await OnlineProduct.find().select("productId").lean()) {
      const n = Number(String(p.productId || "").replace(/\D/g, ""));
      if (n > max) max = n;
    }
    await PosCounter.updateOne({ _id: key }, { $max: { seq: max } }, { upsert: true });
  }
  const doc = await PosCounter.findOneAndUpdate({ _id: key }, { $inc: { seq: 1 } }, { new: true, upsert: true });
  return `p${String(doc.seq).padStart(3, "0")}`;
}

function cleanPrices(price, originalPrice) {
  // MRP is only kept when it is really higher than the selling price.
  return { price, originalPrice: originalPrice && originalPrice > price ? originalPrice : null };
}

export async function getProduct(id) {
  const p = await OnlineProduct.findById(id).lean();
  if (!p) throw notFound("Product not found.");
  const [cats, links] = await Promise.all([OnlineCategory.find({ slug: { $in: p.categories || [] } }).lean(), PosProductLink.find({ productId: p._id }).lean()]);
  // The chosen category is the most specific one: a sub-category if there is one.
  const own = cats.filter((c) => c.slug !== NEW_ARRIVALS);
  const chosen = own.find((c) => c.parent) || own[0];
  const skuOf = new Map(links.map((l) => [l.variantKey ?? "", l.sku]));
  return {
    id: String(p._id),
    code: p.productId,
    name: p.name,
    description: p.description || "",
    categoryId: chosen ? String(chosen._id) : "",
    newArrival: (p.categories || []).includes(NEW_ARRIVALS),
    price: p.price,
    originalPrice: p.originalPrice ?? null,
    colorName: p.colorName || "",
    images: p.images || [],
    badge: p.badge || "",
    isActive: p.isActive !== false,
    variants: (p.variants || []).map((v) => ({ size: v.size, stock: v.stock ?? 0, price: v.price > 0 ? v.price : null, sku: skuOf.get(v.size) || null })),
    stock: p.stock ?? 0,
    oneSizeSku: (p.variants || []).length ? null : skuOf.get("") || null,
  };
}

export async function createProduct(input, actor, info) {
  assertEditable();
  const categories = await categorySlugs(input.categoryId, input.newArrival);
  const variants = input.variants.map((v) => ({ size: v.size, color: input.colorName || null, sku: "", stock: v.stock, price: v.price > 0 ? v.price : null }));
  const stock = variants.length ? variants.reduce((a, v) => a + v.stock, 0) : input.oneSizeStock;
  const product = await OnlineProduct.create({
    productId: await nextProductCode(),
    slug: await uniqueSlug(OnlineProduct, input.name),
    name: input.name,
    description: input.description,
    categories,
    ...cleanPrices(input.price, input.originalPrice),
    images: input.images,
    colorName: input.colorName,
    sizes: variants.map((v) => v.size),
    variants,
    stock,
    inStock: stock > 0,
    badge: input.badge,
    tags: [],
    isActive: input.isActive,
  });
  // Every size gets its SKU right away, ready for tags and billing.
  await syncProductLinks();
  if (input.costPrice != null) await PosProductLink.updateMany({ productId: product._id }, { $set: { costPrice: input.costPrice } });
  await audit({ user: actor, action: "PRODUCT_CREATE", entity: "Product", entityId: product.productId, after: { name: product.name, price: product.price, sizes: product.sizes, stock }, ...info });
  return getProduct(product._id);
}

/**
 * Edits a product without ever overwriting its stock numbers, because a sale
 * may change them at the same moment. Each step is its own targeted update:
 *   - plain fields are $set;
 *   - a removed size is $pulled only while its stock is 0;
 *   - a new size is $pushed and its opening stock $inc'ed onto the total;
 *   - a size's own price is $set on just that size.
 * Stock of existing sizes is changed with the Stock button (reason + audit).
 */
export async function updateProduct(id, patch, actor, info) {
  assertEditable();
  const p = await OnlineProduct.findById(id).lean();
  if (!p) throw notFound("Product not found.");

  const set = {};
  for (const key of ["name", "description", "colorName", "images", "badge", "isActive"]) if (patch[key] !== undefined) set[key] = patch[key];
  if (patch.price !== undefined || patch.originalPrice !== undefined) {
    Object.assign(set, cleanPrices(patch.price ?? p.price, patch.originalPrice !== undefined ? patch.originalPrice : p.originalPrice));
  }
  if (patch.categoryId !== undefined || patch.newArrival !== undefined) {
    const current = await getProduct(id);
    set.categories = await categorySlugs(patch.categoryId ?? current.categoryId, patch.newArrival ?? current.newArrival);
  }
  if (Object.keys(set).length) await OnlineProduct.updateOne({ _id: p._id }, { $set: set });

  const added = [];
  const removed = [];
  const repriced = [];
  if (patch.variants) {
    const have = new Map((p.variants || []).map((v) => [v.size.toUpperCase(), v]));
    const want = new Map(patch.variants.map((v) => [v.size.toUpperCase(), v]));
    const wasOneSize = !(p.variants || []).length;
    if (wasOneSize && want.size && (p.stock || 0) > 0) {
      throw badRequest(`This product has ${p.stock} in stock without sizes. Set its stock to 0 with the Stock button before adding sizes.`);
    }
    for (const [key, v] of have) {
      if (want.has(key)) continue;
      const res = await OnlineProduct.updateOne({ _id: p._id, variants: { $elemMatch: { size: v.size, stock: { $lte: 0 } } } }, { $pull: { variants: { size: v.size }, sizes: v.size } });
      if (!res.modifiedCount) throw badRequest(`Size ${v.size} still has stock. Set it to 0 with the Stock button before removing the size.`);
      removed.push(v.size);
    }
    for (const [key, v] of want) {
      if (have.has(key)) continue;
      const color = set.colorName ?? p.colorName ?? null;
      await OnlineProduct.updateOne({ _id: p._id }, { $push: { variants: { size: v.size, color, sku: "", stock: v.stock, price: v.price > 0 ? v.price : null } }, $addToSet: { sizes: v.size }, $inc: { stock: v.stock } });
      added.push(v.size);
    }
    for (const [key, v] of want) {
      const old = have.get(key);
      if (!old || v.price === undefined) continue;
      const price = v.price > 0 ? v.price : null;
      if ((old.price > 0 ? old.price : null) === price) continue;
      await OnlineProduct.updateOne({ _id: p._id }, { $set: { "variants.$[v].price": price } }, { arrayFilters: [{ "v.size": old.size }] });
      repriced.push(`${old.size}: ${price ?? "default"}`);
    }
  }

  // Keep the in-stock flag true to the numbers.
  await OnlineProduct.updateOne({ _id: p._id, stock: { $gt: 0 } }, { $set: { inStock: true } });
  await OnlineProduct.updateOne({ _id: p._id, stock: { $lte: 0 } }, { $set: { inStock: false } });

  if (removed.length) await PosProductLink.updateMany({ productId: p._id, variantKey: { $in: removed } }, { $set: { isActive: false } });
  // Switching between "one size" and "has sizes" swaps which SKUs can be billed.
  const nowSized = (p.variants || []).length - removed.length + added.length > 0;
  if (added.length || removed.length) {
    await PosProductLink.updateMany({ productId: p._id, variantKey: null }, { $set: { isActive: !nowSized } });
    if (!nowSized) await syncProductLinks();
  }
  if (added.length) {
    // A size that existed before keeps its old SKU; otherwise a new one is made.
    await PosProductLink.updateMany({ productId: p._id, variantKey: { $in: added } }, { $set: { isActive: true } });
    await syncProductLinks();
    const cost = (await PosProductLink.findOne({ productId: p._id, costPrice: { $ne: null } }).lean())?.costPrice;
    if (cost != null) await PosProductLink.updateMany({ productId: p._id, variantKey: { $in: added }, costPrice: null }, { $set: { costPrice: cost } });
  }

  await audit({ user: actor, action: "PRODUCT_UPDATE", entity: "Product", entityId: p.productId, before: { name: p.name, price: p.price }, after: { ...set, addedSizes: added, removedSizes: removed, sizePrices: repriced }, ...info });
  return getProduct(id);
}

/**
 * A product that was never billed is removed with its SKUs. One that appears
 * on a bill is ARCHIVED instead (hidden from billing), because its bills and
 * any later return still need it, for example to put stock back.
 */
export async function deleteProduct(id, actor, info) {
  assertEditable();
  const p = await OnlineProduct.findById(id).lean();
  if (!p) throw notFound("Product not found.");
  const billed = await PosSale.exists({ "items.productId": new mongoose.Types.ObjectId(id) });
  if (billed) {
    await OnlineProduct.updateOne({ _id: p._id }, { $set: { isActive: false } });
    await audit({ user: actor, action: "PRODUCT_ARCHIVE", entity: "Product", entityId: p.productId, before: { name: p.name }, ...info });
    return { archived: true };
  }
  await OnlineProduct.deleteOne({ _id: p._id });
  await PosProductLink.deleteMany({ productId: p._id });
  await audit({ user: actor, action: "PRODUCT_DELETE", entity: "Product", entityId: p.productId, before: { name: p.name, sizes: p.sizes }, ...info });
  return { deleted: true };
}
