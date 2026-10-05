import { Router } from "express";
import { route, json, readJson, clientInfo, query } from "../lib/http.js";
import { returnSchema } from "../lib/schemas.js";
import { requestReturn, listReturns, getReturn, shapeReturn } from "../services/returns.js";
import { PosSale } from "../lib/models.js";

const router = Router();
const view = { permission: ["returns.request", "returns.approve"] };

router.get("/", route(async (req, { session }) => json({ items: await listReturns(query(req), session) }), view));

router.post(
  "/",
  route(
    async (req, { session }) => {
      const body = returnSchema.parse(readJson(req));
      const { processed, ret } = await requestReturn(body, session, clientInfo(req));
      return json({ processed, ret: shapeReturn(ret.toObject ? ret.toObject() : ret) }, processed ? 201 : 202);
    },
    { permission: "returns.request" }
  )
);

// Credit note / return slip data.
router.get(
  "/:id",
  route(async (_req, { params, session }) => {
    const r = await getReturn(params.id, session);
    const sale = await PosSale.findById(r.sale).select("invoice.store createdAt").lean();
    return json({ ret: shapeReturn(r), store: sale?.invoice?.store || {}, billDate: sale?.createdAt });
  }, view)
);

export default router;
