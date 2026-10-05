import { Router } from "express";
import { route, json, raw, readJson, clientInfo, query } from "../lib/http.js";
import { customerSchema, customerUpdateSchema } from "../lib/schemas.js";
import { searchCustomers, createCustomer, customerHistory, updateCustomer, exportCustomersCsv } from "../services/customers.js";
import { returnableBills } from "../services/returns.js";
import { audit } from "../lib/audit.js";

const router = Router();

router.get(
  "/",
  route(async (req, { session }) => json({ items: await searchCustomers(query(req).q || "", session.permissions) }), { permission: "customers.view" })
);

router.post(
  "/",
  route(
    async (req, { session }) => {
      const body = customerSchema.parse(readJson(req));
      const customer = await createCustomer(body, session.user, session.permissions, clientInfo(req));
      return json({ customer }, 201);
    },
    { permission: "customers.create" }
  )
);

router.get(
  "/export",
  route(
    async (req, { session }) => {
      const csv = await exportCustomersCsv();
      await audit({ user: session.user, action: "CUSTOMER_EXPORT", entity: "PosCustomer", ...clientInfo(req) });
      return raw(csv, { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": "attachment; filename=customers.csv" });
    },
    { permission: "customers.export" }
  )
);

router.get(
  "/:id",
  route(async (_req, { params, session }) => json(await customerHistory(params.id, session.permissions)), { permission: "customers.view" })
);

router.patch(
  "/:id",
  route(
    async (req, { params, session }) => {
      const body = customerUpdateSchema.parse(readJson(req));
      const customer = await updateCustomer(params.id, body, session.user, session.permissions, clientInfo(req));
      return json({ customer });
    },
    { permission: "customers.edit" }
  )
);

router.get("/:id/returnable", route(async (_req, { params }) => json({ items: await returnableBills(params.id) }), { permission: "returns.request" }));

export default router;
