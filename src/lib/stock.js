import { OnlineProduct } from "./models.js";
import { AppError } from "./errors.js";

/*
 * The ONLY place the POS writes to the online `products` collection.
 *
 * It mirrors exactly what the online order flow does
 * (theninebackend/src/services/order.service.js decrementStock/restockItems):
 *   - the product-level `stock` and, when the size has its own variant row,
 *     that row's `stock` move together in ONE conditional update, so the
 *     check and the decrement are atomic and stock can never go negative;
 *   - `inStock` is flipped when stock reaches zero (or comes back), so the
 *     website shows the right availability.
 * Online code is not touched.
 */

// A variant row is identified by its `key`. One size can have several rows
// (e.g. two M at different prices), so the size alone is not enough. Rows made
// before keys existed have none: their key is their size.
export function keyOf(variant) {
  return variant.key || variant.size;
}

// Mongo condition for "the variant row with this key", for $elemMatch
// (prefix "") and arrayFilters (prefix "v.").
export function variantMatch(variantKey, prefix = "") {
  return { $or: [{ [`${prefix}key`]: variantKey }, { [`${prefix}key`]: null, [`${prefix}size`]: variantKey }] };
}

function hasVariantFor(product, variantKey) {
  if (!variantKey) return false;
  const variants = product.variants || [];
  for (const v of variants) {
    if (keyOf(v) === variantKey) return true;
  }
  return false;
}

// Selling price and MRP for one size row. A row can carry its own price and
// MRP; without them it uses the product's. MRP is never below the price.
export function priceFor(product, variantKey) {
  let price = product.price;
  let mrp = product.originalPrice || 0;
  if (variantKey) {
    for (const v of product.variants || []) {
      if (keyOf(v) !== variantKey) continue;
      if (v.price > 0) price = v.price;
      if (v.mrp > 0) mrp = v.mrp;
    }
  }
  return { price, mrp: mrp > price ? mrp : price };
}

// How many units can be sold right now for this product + size.
export function availableQty(product, variantKey) {
  const total = Number(product.stock || 0);
  if (!hasVariantFor(product, variantKey)) return Math.max(0, total);
  for (const v of product.variants) {
    if (keyOf(v) === variantKey) return Math.max(0, Math.min(total, Number(v.stock || 0)));
  }
  return 0;
}

async function syncInStock(productId, session) {
  const p = await OnlineProduct.findById(productId).select("stock variants inStock").session(session).lean();
  if (!p) return;
  let stillInStock = Number(p.stock || 0) > 0;
  if (!stillInStock) {
    for (const v of p.variants || []) {
      if (Number(v.stock || 0) > 0) {
        stillInStock = true;
        break;
      }
    }
  }
  if (p.inStock !== stillInStock) {
    await OnlineProduct.updateOne({ _id: productId }, { $set: { inStock: stillInStock } }, { session });
  }
}

export async function decreaseStock({ productId, variantKey, qty, sku, session }) {
  const product = await OnlineProduct.findById(productId).select("variants stock isActive").session(session).lean();
  if (!product || product.isActive === false) {
    throw new AppError(`${sku} is no longer available.`, "PRODUCT_INACTIVE", 409);
  }

  const filter = { _id: productId, stock: { $gte: qty } };
  const update = { $inc: { stock: -qty } };
  const options = { session };
  if (hasVariantFor(product, variantKey)) {
    filter.variants = { $elemMatch: { ...variantMatch(variantKey), stock: { $gte: qty } } };
    update.$inc["variants.$[v].stock"] = -qty;
    options.arrayFilters = [variantMatch(variantKey, "v.")];
  }

  const result = await OnlineProduct.updateOne(filter, update, options);
  if (result.matchedCount === 0) {
    throw new AppError(`${sku} is out of stock.`, "OUT_OF_STOCK", 409);
  }
  await syncInStock(productId, session);
}

export async function increaseStock({ productId, variantKey, qty, session }) {
  const product = await OnlineProduct.findById(productId).select("variants").session(session).lean();
  if (!product) return; // product removed from the database — nothing to restock

  const update = { $inc: { stock: qty }, $set: { inStock: true } };
  const options = { session };
  if (hasVariantFor(product, variantKey)) {
    update.$inc["variants.$[v].stock"] = qty;
    options.arrayFilters = [variantMatch(variantKey, "v.")];
  }
  await OnlineProduct.updateOne({ _id: productId }, update, options);
}

// Manual correction by a super admin: delta can be + or −.
export async function adjustStock({ productId, variantKey, delta, sku, session }) {
  if (delta < 0) return decreaseStock({ productId, variantKey, qty: -delta, sku, session });
  return increaseStock({ productId, variantKey, qty: delta, session });
}
