// Owner-side read screens and shop expenses: dashboard, reports, audit logs, expenses.
import { Router } from "express";
import { route, json, readJson, clientInfo, query } from "../lib/http.js";
import { expenseSchema } from "../lib/schemas.js";
import { dashboard, dailyReport, monthlyReport, stockReport } from "../services/reports.js";
import { createExpense, listExpenses } from "../services/expenses.js";
import { PosAuditLog } from "../lib/models.js";
import { istDayRange } from "../lib/time.js";
import { badRequest } from "../lib/errors.js";

const router = Router();

// Never resets data: it simply shows the chosen IST month (current by default).
router.get(
  "/dashboard",
  route(async (req) => {
    const q = query(req);
    return json(await dashboard(q.year, q.month));
  }, { permission: "dashboard.view" })
);

router.get(
  "/reports/daily",
  route(async (req) => {
    const date = query(req).date;
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw badRequest("Use date=YYYY-MM-DD.");
    return json(await dailyReport(date));
  }, { permission: "reports.view" })
);

// Stock left right now: pieces and value per size, and the totals.
router.get(
  "/reports/stock",
  route(async (_req, { session }) => json(await stockReport(session.permissions)), { permission: "reports.view" })
);

router.get(
  "/reports/monthly",
  route(async (req) => {
    const q = query(req);
    return json(await monthlyReport(q.year, q.month));
  }, { permission: "reports.view" })
);

router.get(
  "/expenses",
  route(async (req, { session }) => json(await listExpenses(query(req), session)), { permission: ["expenses.create", "expenses.viewAll"] })
);

router.post(
  "/expenses",
  route(
    async (req, { session }) => {
      const body = expenseSchema.parse(readJson(req));
      const e = await createExpense(body, session, clientInfo(req));
      return json({ expense: { id: String(e._id), status: e.status, amount: e.amount, title: e.title } }, 201);
    },
    { permission: "expenses.create" }
  )
);

// Read only. There is no update or delete endpoint for audit logs.
router.get(
  "/audit-logs",
  route(async (req) => {
    const q = query(req);
    const filter = {};
    if (q.action) filter.action = q.action;
    if (q.user) filter.user = q.user;
    if (q.from || q.to) {
      filter.createdAt = {};
      if (q.from) filter.createdAt.$gte = istDayRange(q.from).from;
      if (q.to) filter.createdAt.$lt = istDayRange(q.to).to;
    }
    const page = Math.max(1, Number(q.page) || 1);
    const limit = 50;
    const [rows, total, actions] = await Promise.all([
      PosAuditLog.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      PosAuditLog.countDocuments(filter),
      PosAuditLog.distinct("action"),
    ]);
    return json({
      items: rows.map((r) => ({ ...r, id: String(r._id), _id: undefined })),
      total,
      page,
      pages: Math.ceil(total / limit),
      actions: actions.sort(),
    });
  }, { permission: "auditLogs.view" })
);

export default router;
