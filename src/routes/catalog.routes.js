// Products and categories come live from the online store's collections.
// The POS adds only its own SKU links, category SKU codes and the shared stock update.
import { Router } from "express";
import { route, json, readJson, clientInfo, query } from "../lib/http.js";
import { categorySettingSchema, linkUpdateSchema, stockAdjustSchema } from "../lib/schemas.js";
import { OnlineCategory, OnlineProduct, PosCategorySetting, PosProductLink } from "../lib/models.js";
import { listProducts, searchSellable, findBySku, updateLink, adjustLinkStock, syncProductLinks } from "../services/products.js";
import { audit } from "../lib/audit.js";
import { badRequest } from "../lib/errors.js";
import { getSettings } from "../lib/settings.js";

const router = Router();

/* ── Categories ─────────────────────────────────────────────────────────── */

router.get(
  "/categories",
  route(
    async () => {
      const [cats, settings] = await Promise.all([
        OnlineCategory.find().sort({ sortOrder: 1, label: 1 }).lean(),
        PosCategorySetting.find().lean(),
      ]);
      const bySlug = new Map();
      for (const s of settings) bySlug.set(s.categorySlug, s);
      const items = cats.map((c) => {
        const s = bySlug.get(c.slug);
        return {
          id: String(c._id),
          slug: c.slug,
          label: c.label,
          kind: c.kind,
          parent: c.parent ? String(c.parent) : null,
          isActive: c.isActive !== false,
          code: s?.code || "",
        };
      });
      return json({ items });
    },
    { permission: "products.view" }
  )
);

router.get("/category-settings", route(async () => json({ items: await PosCategorySetting.find().lean() }), { permission: "categories.manage" }));

router.put(
  "/category-settings",
  route(
    async (req, { session }) => {
      const body = categorySettingSchema.parse(readJson(req));
      const row = await PosCategorySetting.findOneAndUpdate(
        { categorySlug: body.categorySlug },
        { $set: { code: body.code } },
        { upsert: true, new: true }
      );
      await audit({ user: session.user, action: "SETTINGS_CHANGE", entity: "PosCategorySetting", entityId: body.categorySlug, after: body, ...clientInfo(req) });
      return json({ item: row });
    },
    { permission: "categories.manage" }
  )
);

/* ── Products ───────────────────────────────────────────────────────────── */

router.get(
  "/products",
  route(
    async (req, { session }) => {
      const q = query(req);
      const data = await listProducts(
        { q: q.q || "", page: Number(q.page) || 1, limit: Math.min(50, Number(q.limit) || 30), linkFilter: q.filter, category: q.category || "" },
        session.permissions
      );
      return json(data);
    },
    { permission: "products.view" }
  )
);

// Search-as-you-type for New Bill: ?q=jeans or ?q=TND-SA
router.get(
  "/products/search",
  route(async (req, { session }) => json({ items: await searchSellable(query(req).q || "", session.permissions) }), { permission: "products.view" })
);

// Used by the New Bill screen when a SKU is scanned. Field-filtered by permission.
router.get(
  "/products/sku/:sku",
  route(async (_req, { params, session }) => json({ item: await findBySku(params.sku, session.permissions) }), { permission: "products.view" })
);

/* ── SKU links, stock and tags ──────────────────────────────────────────── */

// Creates missing SKU links. Writes only to pos_product_links.
router.post(
  "/product-links/sync",
  route(
    async (req, { session }) => {
      const result = await syncProductLinks();
      await audit({ user: session.user, action: "PRODUCT_SYNC", entity: "PosProductLink", after: result, ...clientInfo(req) });
      return json(result);
    },
    { permission: "products.edit" }
  )
);

const MAX_TAGS_PER_SKU = 1000;
const MAX_TAGS_TOTAL = 3000;

// Data for printable barcode tags: ?skus=A*90,B*20 — one row per SKU (a size of a
// product) with how many copies to print. The screen repeats each tag `copies` times.
router.get(
  "/product-links/tags",
  route(
    async (req, { session }) => {
      const raw = (query(req).skus || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 200);
      const groups = [];
      let total = 0;
      for (const entry of raw) {
        const [sku, copiesText] = entry.split("*");
        const copies = Math.max(1, Math.floor(Number(copiesText) || 1));
        if (copies > MAX_TAGS_PER_SKU) throw badRequest(`${sku}: at most ${MAX_TAGS_PER_SKU} tags per size at a time.`);
        let item;
        try {
          item = await findBySku(sku, session.permissions);
        } catch {
          groups.push({ sku, error: "Not found" });
          continue;
        }
        total += copies;
        if (total > MAX_TAGS_TOTAL) throw badRequest(`At most ${MAX_TAGS_TOTAL} tags in one print. Print in smaller batches.`);
        groups.push({ sku: item.sku, productId: item.productId, name: item.name, size: item.size, color: item.color, price: item.price, mrp: item.mrp, copies });
      }

      // Product code and category for the label, from the product itself.
      const ids = [...new Set(groups.filter((g) => g.productId).map((g) => g.productId))];
      const products = await OnlineProduct.find({ _id: { $in: ids } }).select("productId categories fabric showMrpCut variants").lean();
      // Which size row each SKU is, for that row's own edition.
      const linkRows = await PosProductLink.find({ sku: { $in: groups.map((g) => g.sku) } }).select("sku variantKey").lean();
      const rowOfSku = new Map(linkRows.map((l) => [l.sku, l.variantKey]));
      const cats = await OnlineCategory.find({ slug: { $in: products.flatMap((p) => p.categories || []) } }).select("slug label parent").lean();
      const catBySlug = new Map(cats.map((c) => [c.slug, c]));
      const catById = new Map(cats.map((c) => [String(c._id), c]));
      const shortBySlug = new Map((await PosCategorySetting.find().select("categorySlug code").lean()).map((s) => [s.categorySlug, s.code]));
      const productById = new Map(products.map((p) => [String(p._id), p]));
      for (const g of groups) {
        const p = productById.get(String(g.productId));
        if (!p) continue;
        const own = (p.categories || []).map((slug) => catBySlug.get(slug)).filter((c) => c && c.slug !== "new-arrivals");
        g.code = p.productId || "";
        const row = (p.variants || []).find((v) => (v.key || v.size) === rowOfSku.get(g.sku));
        g.fabric = row?.edition || p.fabric || "";
        // This size row's own MRP-cut choice wins; otherwise the product's.
        const rowCut = (p.variants || []).find((v) => (v.key || v.size) === rowOfSku.get(g.sku))?.mrpCut;
        g.showMrpCut = typeof rowCut === "boolean" ? rowCut : Boolean(p.showMrpCut);
        // The tag shows the category's short code (e.g. BW), not its full name:
        // the sub-category's code, else its main category's, else the one in the SKU.
        const chosen = own.find((c) => c.parent) || own[0];
        const parent = chosen?.parent && catById.get(String(chosen.parent));
        g.category = (chosen && shortBySlug.get(chosen.slug)) || (parent && shortBySlug.get(parent.slug)) || g.sku.split("-")[1] || "";
        delete g.productId;
      }
      // The owner's tag layout (Settings → Tag design). The barcode is always printed.
      const settings = (await getSettings()).toObject();
      const tags = settings.tags || {};
      const design = [];
      for (const key of ["original", "pickup"]) {
        const t = tags[key] || {};
        if (t.enabled === false) continue;
        design.push({ key, ...t, fields: (t.fields || []).filter((f) => f.label || f.text) });
      }
      // Store logo from Settings → Store, printed on tags when "Logo" is on.
      return json({ groups, total, design, layout: tags.layout || "VERTICAL", logo: settings.store?.logo || "" });
    },
    { permission: "products.edit" }
  )
);

router.patch(
  "/product-links/:sku",
  route(
    async (req, { params, session }) => {
      const body = linkUpdateSchema.parse(readJson(req));
      const link = await updateLink(params.sku, body, session.user, clientInfo(req));
      return json({ link: { sku: link.sku, costPrice: link.costPrice, isActive: link.isActive } });
    },
    { permission: "products.edit" }
  )
);

// Atomic $inc on the shared stock fields, with a reason and an audit log row.
router.post(
  "/product-links/:sku/stock-adjust",
  route(
    async (req, { params, session }) => {
      const body = stockAdjustSchema.parse(readJson(req));
      return json(await adjustLinkStock(params.sku, body, session.user, clientInfo(req)));
    },
    { permission: "stock.adjust" }
  )
);

export default router;
