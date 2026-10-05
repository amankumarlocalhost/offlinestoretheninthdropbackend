// Owner screens for managing the store's own catalog: categories,
// sub-categories, products and product photos. The service refuses every
// write when the catalog is the website's database.
import { Router } from "express";
import { route, json, readJson, clientInfo } from "../lib/http.js";
import { categoryCreateSchema, categoryUpdateSchema, productCreateSchema, productUpdateSchema } from "../lib/schemas.js";
import { catalogInfo, categoryTree, createCategory, updateCategory, deleteCategory, getProduct, createProduct, updateProduct, deleteProduct } from "../services/catalog.js";
import { readImageUpload } from "../lib/upload.js";
import { uploadImage } from "../lib/cloudinary.js";

const router = Router();
const manage = { permission: "catalog.manage" };

// Lets the screens show or hide the add / edit / delete buttons.
router.get("/meta", route(async () => json(catalogInfo()), { permission: "products.view" }));

router.get("/categories", route(async () => json(await categoryTree()), { permission: ["categories.manage", "catalog.manage"] }));

router.post(
  "/categories",
  route(async (req, { session }) => {
    const cat = await createCategory(categoryCreateSchema.parse(readJson(req)), session.user, clientInfo(req));
    return json({ id: String(cat._id), slug: cat.slug }, 201);
  }, manage)
);

router.patch(
  "/categories/:id",
  route(async (req, { params, session }) => {
    const cat = await updateCategory(params.id, categoryUpdateSchema.parse(readJson(req)), session.user, clientInfo(req));
    return json({ id: String(cat._id), slug: cat.slug });
  }, manage)
);

router.delete("/categories/:id", route(async (req, { params, session }) => json(await deleteCategory(params.id, session.user, clientInfo(req))), manage));

router.get("/products/:id", route(async (_req, { params }) => json({ product: await getProduct(params.id) }), manage));

router.post(
  "/products",
  route(async (req, { session }) => json({ product: await createProduct(productCreateSchema.parse(readJson(req)), session.user, clientInfo(req)) }, 201), manage)
);

router.patch(
  "/products/:id",
  route(async (req, { params, session }) => json({ product: await updateProduct(params.id, productUpdateSchema.parse(readJson(req)), session.user, clientInfo(req)) }), manage)
);

router.delete("/products/:id", route(async (req, { params, session }) => json(await deleteProduct(params.id, session.user, clientInfo(req))), manage));

// Product photo → Cloudinary. Returns its URL for the product form.
router.post(
  "/images",
  route(async (req, { res }) => {
    const file = await readImageUpload(req, res);
    const uploaded = await uploadImage(file.buffer, file.mimetype, { subfolder: "products" });
    return json({ url: uploaded.url }, 201);
  }, manage)
);

export default router;
