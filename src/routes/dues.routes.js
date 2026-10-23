// Udhaar: bills where the customer took the goods and still owes money.
// Collecting a due is POST /sales/:id/collect.
import { Router } from "express";
import { route, json, query } from "../lib/http.js";
import { listDues } from "../services/sales.js";

const router = Router();

router.get("/", route(async (req) => json(await listDues(query(req))), { permission: "dues.view" }));

export default router;
