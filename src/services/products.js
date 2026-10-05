import { OnlineProduct, OnlineCategory, PosProductLink, PosCategorySetting } from "../lib/models.js";
import { availableQty, adjustStock, priceFor } from "../lib/stock.js";
import { nextProductNo } from "../lib/counters.js";
import { hasPermission } from "../lib/permissions.js";
import { badRequest, notFound } from "../lib/errors.js";
import { escapeRegex } from "../lib/validate.js";
import { withTransaction } from "../lib/db.js";
import { audit } from "../lib/audit.js";

// Sizes a product can be sold in. Online identifies a variant by its size;
// sizes listed without their own variant row share the product-level stock.
function variantKeysOf(product) {
  const keys = [];
  for (const v of product.variants || []) {
    if (v.size && !keys.includes(v.size)) keys.push(v.size);
  }
  for (const s of product.sizes || []) {
    if (s && !keys.includes(s)) keys.push(s);
  }
  if (keys.length === 0) keys.push(null); // one-size product
  return keys;
}

function colorFor(product, variantKey) {
  for (const v of product.variants || []) {
    if (v.size === variantKey && v.color) return v.color;
  }
  return product.colorName || null;
}

function sizeCode(size) {
  if (!size) return "OS";
  const code = String(size).toUpperCase().replace(/[^A-Z0-9]/g, "");
  return code.slice(0, 6) || "OS";
}

async function categoryCodeFor(product, settingsBySlug, structuralSlugs) {
  for (const slug of product.categories || []) {
    const s = settingsBySlug.get(slug);
    if (s?.code) return s.code;
  }
  for (const slug of product.categories || []) {
    if (structuralSlugs.has(slug)) continue;
    const letters = slug.toUpperCase().replace(/[^A-Z]/g, "");
    if (letters.length >= 2) return letters.slice(0, 2);
  }
  return "GN";
}

async function productNumber(product) {
  const digits = String(product.productId || "").replace(/\D/g, "");
  if (digits) return digits.padStart(4, "0").slice(-6);
  return String(await nextProductNo()).padStart(4, "0");
}

/**
 * Creates a pos_product_links row for every product+size that does not have
 * one yet. Writes ONLY to pos_product_links.
 */
export async function syncProductLinks() {
  const [products, categorySettings, categories, existing] = await Promise.all([
    OnlineProduct.find({ isActive: { $ne: false } }).lean(),
    PosCategorySetting.find().lean(),
    OnlineCategory.find().select("slug kind").lean(),
    PosProductLink.find().select("productId variantKey sku").lean(),
  ]);

  const settingsBySlug = new Map();
  for (const s of categorySettings) settingsBySlug.set(s.categorySlug, s);
  const structuralSlugs = new Set();
  for (const c of categories) if (c.kind === "structural") structuralSlugs.add(c.slug);

  const have = new Set();
  const usedSkus = new Set();
  for (const l of existing) {
    have.add(`${l.productId}:${l.variantKey ?? ""}`);
    usedSkus.add(l.sku);
  }

  let created = 0;
  for (const product of products) {
    const keys = variantKeysOf(product);
    let base = null;
    for (const key of keys) {
      if (have.has(`${product._id}:${key ?? ""}`)) continue;
      if (!base) {
        const cat = await categoryCodeFor(product, settingsBySlug, structuralSlugs);
        base = `TND-${cat}-${await productNumber(product)}`;
      }
      let sku = `${base}-${sizeCode(key)}`;
      let n = 2;
      while (usedSkus.has(sku)) sku = `${base}-${sizeCode(key)}-${n++}`;
      usedSkus.add(sku);
      await PosProductLink.create({
        sku,
        productId: product._id,
        variantKey: key,
        size: key,
        color: colorFor(product, key),
      });
      created += 1;
    }
  }
  return { created, products: products.length };
}

/**
 * Shapes a sellable item for the client. Operators only see whether it is in
 * stock; exact stock and cost need extra permissions.
 */
function shapeItem(link, product, permissions) {
  const available = availableQty(product, link.variantKey);
  const item = {
    sku: link.sku,
    productId: String(product._id),
    name: product.name,
    image: product.images?.[0] || null,
    size: link.size,
    color: link.color,
    ...priceFor(product, link.variantKey),
    inStock: product.isActive !== false && link.isActive && available > 0,
    linkActive: link.isActive,
    productActive: product.isActive !== false,
  };
  if (hasPermission(permissions, "products.viewStock")) item.stock = available;
  if (hasPermission(permissions, "products.viewCost")) item.costPrice = link.costPrice;
  return item;
}

export async function findBySku(sku, permissions) {
  const link = await PosProductLink.findOne({ sku: String(sku).trim().toUpperCase() }).lean();
  if (!link) throw notFound(`No product with SKU ${sku}.`);
  const product = await OnlineProduct.findById(link.productId).lean();
  if (!product) throw notFound(`Product for SKU ${sku} no longer exists.`);
  return shapeItem(link, product, permissions);
}

/**
 * Live search for the billing screen: matches product name, product code or
 * SKU and returns sellable sizes, in-stock first. Small and fast — it runs on
 * every keystroke (debounced on the client).
 */
export async function searchSellable(q, permissions, limit = 12) {
  const text = String(q || "").trim();
  if (text.length < 2) return [];
  const rx = new RegExp(escapeRegex(text), "i");

  const [byName, bySku] = await Promise.all([
    OnlineProduct.find({ isActive: { $ne: false }, $or: [{ name: rx }, { productId: rx }] })
      .select("name productId images price originalPrice stock variants isActive categories")
      .limit(25)
      .lean(),
    PosProductLink.find({ sku: rx, isActive: true }).limit(25).lean(),
  ]);

  const productIds = new Set();
  for (const p of byName) productIds.add(String(p._id));
  for (const l of bySku) productIds.add(String(l.productId));
  if (productIds.size === 0) return [];

  const ids = [...productIds];
  const [links, extraProducts] = await Promise.all([
    PosProductLink.find({ productId: { $in: ids }, isActive: true }).lean(),
    OnlineProduct.find({ _id: { $in: ids.filter((id) => !byName.some((p) => String(p._id) === id)) }, isActive: { $ne: false } })
      .select("name productId images price originalPrice stock variants isActive categories")
      .lean(),
  ]);

  const productById = new Map();
  for (const p of byName) productById.set(String(p._id), p);
  for (const p of extraProducts) productById.set(String(p._id), p);

  // When the text looks like a SKU, show only matching SKUs; otherwise every size.
  const skuHits = new Set(bySku.map((l) => l.sku));
  const items = [];
  for (const link of links) {
    const product = productById.get(String(link.productId));
    if (!product) continue;
    if (skuHits.size && !skuHits.has(link.sku) && !rx.test(product.name)) continue;
    items.push(shapeItem(link, product, permissions));
  }
  items.sort((a, b) => Number(b.inStock) - Number(a.inStock) || a.name.localeCompare(b.name) || String(a.size).localeCompare(String(b.size), undefined, { numeric: true }));
  return items.slice(0, limit);
}

/** Product list with every size and its POS link (for admin and search). */
function priceRange(product) {
  let min = Infinity;
  let max = 0;
  for (const key of variantKeysOf(product)) {
    const { price } = priceFor(product, key);
    if (price < min) min = price;
    if (price > max) max = price;
  }
  return { minPrice: min === Infinity ? product.price : min, maxPrice: max || product.price };
}

export async function listProducts({ q, page = 1, limit = 30, linkFilter, category }, permissions) {
  const filter = {};
  if (category) filter.categories = category;
  if (q) {
    const rx = new RegExp(escapeRegex(q), "i");
    const linkMatches = await PosProductLink.find({ sku: rx }).select("productId").lean();
    const ids = [];
    for (const l of linkMatches) ids.push(l.productId);
    filter.$or = [{ name: rx }, { slug: rx }, { productId: rx }, { _id: { $in: ids } }];
  }
  const skip = (Math.max(1, page) - 1) * limit;
  const [products, total] = await Promise.all([
    OnlineProduct.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    OnlineProduct.countDocuments(filter),
  ]);
  const ids = [];
  for (const p of products) ids.push(p._id);
  const links = await PosProductLink.find({ productId: { $in: ids } }).lean();

  const items = [];
  for (const p of products) {
    const sizes = [];
    for (const key of variantKeysOf(p)) {
      let link = null;
      for (const l of links) {
        if (String(l.productId) === String(p._id) && (l.variantKey ?? null) === key) {
          link = l;
          break;
        }
      }
      if (link) {
        sizes.push({ linked: true, ...shapeItem(link, p, permissions) });
      } else {
        const row = { linked: false, size: key, sku: null, inStock: availableQty(p, key) > 0 };
        if (hasPermission(permissions, "products.viewStock")) row.stock = availableQty(p, key);
        sizes.push(row);
      }
    }
    if (linkFilter === "unlinked" && sizes.every((s) => s.linked)) continue;
    items.push({
      productId: String(p._id),
      name: p.name,
      code: p.productId,
      image: p.images?.[0] || null,
      price: p.price,
      mrp: p.originalPrice || p.price,
      // Lowest and highest size price, for "₹500–₹800" on the product card.
      ...priceRange(p),
      categories: p.categories || [],
      isActive: p.isActive !== false,
      sizes,
    });
  }
  return { items, total, page, pages: Math.ceil(total / limit) };
}

export async function updateLink(sku, patch, actor, info) {
  const link = await PosProductLink.findOne({ sku: String(sku).toUpperCase() });
  if (!link) throw notFound("SKU not found.");
  const before = { costPrice: link.costPrice, isActive: link.isActive };
  for (const key of ["costPrice", "isActive"]) {
    if (patch[key] !== undefined) link[key] = patch[key];
  }
  await link.save();
  await audit({ user: actor, action: "PRODUCT_EDIT", entity: "PosProductLink", entityId: link.sku, before, after: patch, ...info });
  return link;
}

export async function adjustLinkStock(sku, { delta, reason }, actor, info) {
  if (!Number.isInteger(delta) || delta === 0) throw badRequest("Enter a whole number other than zero.");
  const link = await PosProductLink.findOne({ sku: String(sku).toUpperCase() }).lean();
  if (!link) throw notFound("SKU not found.");
  return withTransaction(async (session) => {
    const before = await OnlineProduct.findById(link.productId).select("stock variants").session(session).lean();
    await adjustStock({ productId: link.productId, variantKey: link.variantKey, delta, sku: link.sku, session });
    const after = await OnlineProduct.findById(link.productId).select("stock variants").session(session).lean();
    await audit({
      user: actor,
      action: "STOCK_ADJUST",
      entity: "Product",
      entityId: link.sku,
      before: { available: availableQty(before, link.variantKey) },
      after: { available: availableQty(after, link.variantKey), delta, reason },
      session,
      ...info,
    });
    return { sku: link.sku, available: availableQty(after, link.variantKey) };
  });
}

export async function lowStock(threshold) {
  const links = await PosProductLink.find({ isActive: true }).lean();
  const ids = [];
  for (const l of links) ids.push(l.productId);
  const products = await OnlineProduct.find({ _id: { $in: ids }, isActive: { $ne: false } })
    .select("name stock variants")
    .lean();
  const byId = new Map();
  for (const p of products) byId.set(String(p._id), p);
  const rows = [];
  for (const l of links) {
    const p = byId.get(String(l.productId));
    if (!p) continue;
    const qty = availableQty(p, l.variantKey);
    if (qty <= threshold) rows.push({ sku: l.sku, name: p.name, size: l.size, stock: qty });
  }
  rows.sort((a, b) => a.stock - b.stock);
  return rows;
}
