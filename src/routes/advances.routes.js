// Advances / bookings: the customer paid money and the shop keeps the goods
// aside until they come back. Turning one into a bill is POST /sales with `advanceId`.
import { Router } from "express";
import { route, json, readJson, clientInfo, query } from "../lib/http.js";
import { advanceSchema, advancePaymentSchema, advanceCancelSchema } from "../lib/schemas.js";
import { createAdvance, addAdvancePayment, cancelAdvance, getAdvance, listAdvances, shapeAdvance } from "../services/advances.js";

const router = Router();
const manage = { permission: "advances.manage" };

// ?status=OPEN (default) | COMPLETED | CANCELLED | "" for all; ?q= name / phone / number.
router.get("/", route(async (req) => json(await listAdvances(query(req))), manage));

router.post(
  "/",
  route(async (req, { session }) => {
    const body = advanceSchema.parse(readJson(req));
    const advance = await createAdvance(body, session, clientInfo(req));
    return json({ advance: shapeAdvance(advance) }, 201);
  }, manage)
);

router.get("/:id", route(async (_req, { params }) => json({ advance: shapeAdvance(await getAdvance(params.id)) }), manage));

router.post(
  "/:id/payments",
  route(async (req, { params, session }) => {
    const body = advancePaymentSchema.parse(readJson(req));
    const advance = await addAdvancePayment(params.id, body, session, clientInfo(req));
    return json({ advance: shapeAdvance(advance) });
  }, manage)
);

router.post(
  "/:id/cancel",
  route(async (req, { params, session }) => {
    const body = advanceCancelSchema.parse(readJson(req));
    const advance = await cancelAdvance(params.id, body, session, clientInfo(req));
    return json({ advance: shapeAdvance(advance) });
  }, manage)
);

export default router;
