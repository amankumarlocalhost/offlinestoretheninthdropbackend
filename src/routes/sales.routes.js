import { Router } from "express";
import { route, json, readJson, clientInfo, query } from "../lib/http.js";
import { saleSchema, reasonSchema, verifySchema, pinSchema } from "../lib/schemas.js";
import { createSale, listSales, getSale, shapeSale, publicBillUrl, cancelSale, verifyPayment, recordPrint, whatsappLink, verifyAdminPin } from "../services/sales.js";
import { audit } from "../lib/audit.js";
import { getSettings } from "../lib/settings.js";

const router = Router();
const view = { permission: ["sales.viewOwn", "sales.viewAll"] };

router.get("/", route(async (req, { session }) => json(await listSales(query(req), session)), view));

// Any price/total in the body is ignored — the server prices every line.
router.post(
  "/",
  route(
    async (req, { session }) => {
      const body = saleSchema.parse(readJson(req));
      const sale = await createSale(body, session, clientInfo(req));
      return json({ sale: shapeSale(sale, session.permissions) }, 201);
    },
    { permission: "sales.create" }
  )
);

// Owner types the 4-digit PIN on the operator's screen to allow a bigger discount.
router.post(
  "/discount-pin",
  route(
    async (req, { session }) => {
      const body = pinSchema.parse(readJson(req));
      return json(await verifyAdminPin(body, session.user, clientInfo(req)));
    },
    { permission: "sales.create" }
  )
);

router.get(
  "/:id",
  route(async (_req, { params, session }) => {
    const sale = await getSale(params.id, session);
    const settings = await getSettings();
    // Which copies to print (Original / Pickup) and what each one says. Read from
    // the current settings, so a layout change also applies to reprints.
    const copies = [];
    for (const key of ["original", "pickup"]) {
      const c = settings.copies?.[key];
      if (c?.enabled) copies.push({ key, label: c.label, topNote: c.topNote, bottomNote: c.bottomNote, showPrices: c.showPrices !== false, showQr: c.showQr !== false, sections: (c.sections || []).filter((x) => x.heading || x.text) });
    }
    return json({ sale: { ...shapeSale(sale, session.permissions), publicUrl: publicBillUrl(sale) }, copies });
  }, view)
);

// Only the owner cancels a bill: stock goes back, payments are reversed.
router.post(
  "/:id/cancel",
  route(
    async (req, { params, session }) => {
      const { reason } = reasonSchema.parse(readJson(req));
      const sale = await cancelSale(params.id, reason, session, clientInfo(req));
      return json({ cancelled: true, sale: shapeSale(sale, session.permissions) });
    },
    { permission: "sales.cancelDirect" }
  )
);

router.patch(
  "/:id/payments/:payId/verify",
  route(
    async (req, { params, session }) => {
      const body = verifySchema.parse(readJson(req));
      const sale = await verifyPayment(params.id, params.payId, body, session, clientInfo(req));
      return json({ sale: shapeSale(sale, session.permissions) });
    },
    { permission: ["payments.verifyOnline", "sales.viewAll"] }
  )
);

// Called right before printing/downloading. 2nd print onwards = DUPLICATE COPY (logged).
router.post(
  "/:id/print",
  route(async (req, { params, session }) => json(await recordPrint(params.id, session, clientInfo(req))), { permission: "receipts.print" })
);

// Returns a wa.me link; staff tap Send in WhatsApp themselves.
router.get(
  "/:id/whatsapp",
  route(
    async (req, { params, session }) => {
      const sale = await getSale(params.id, session);
      const url = whatsappLink(sale);
      await audit({ user: session.user, action: "BILL_WHATSAPP", entity: "PosSale", entityId: sale.billNo, ...clientInfo(req) });
      return json({ url });
    },
    { permission: "receipts.print" }
  )
);

export default router;
