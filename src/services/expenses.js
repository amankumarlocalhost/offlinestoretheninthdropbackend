import { PosExpense } from "../lib/models.js";
import { forbidden } from "../lib/errors.js";
import { getSettings } from "../lib/settings.js";
import { hasPermission } from "../lib/permissions.js";
import { istDayRange } from "../lib/time.js";
import { audit } from "../lib/audit.js";
import { toPaise, toRupees } from "../lib/money.js";

export async function createExpense(input, { user, permissions }, info) {
  // Operators add expenses up to the limit in Settings; bigger ones the owner adds.
  const isOwner = hasPermission(permissions, "expenses.viewAll");
  const settings = await getSettings();
  const limit = Number(settings.limits?.expenseApprovalLimit ?? 0);
  if (!isOwner && input.amount > limit) throw forbidden(`Expenses above ₹${limit} are added by the owner.`);

  const expense = await PosExpense.create({
    title: input.title,
    category: input.category,
    amount: input.amount,
    paidVia: input.paidVia,
    date: input.date || new Date(),
    note: input.note || "",
    addedBy: user._id,
    addedByName: user.name,
    status: "APPROVED",
  });
  await audit({ user, action: "EXPENSE", entity: "PosExpense", entityId: expense._id, after: { title: expense.title, amount: expense.amount, status: expense.status }, ...info });
  return expense;
}

export async function listExpenses(query, { user, permissions }) {
  const viewAll = hasPermission(permissions, "expenses.viewAll");
  const filter = {};
  if (!viewAll) {
    filter.addedBy = user._id;
    filter.date = { $gte: istDayRange().from };
  } else if (query.from || query.to) {
    filter.date = {};
    if (query.from) filter.date.$gte = istDayRange(query.from).from;
    if (query.to) filter.date.$lt = istDayRange(query.to).to;
  }
  if (query.category) filter.category = query.category;
  const rows = await PosExpense.find(filter).sort({ date: -1 }).limit(300).lean();
  const items = rows.map((e) => ({
    id: String(e._id),
    title: e.title,
    category: e.category,
    amount: e.amount,
    paidVia: e.paidVia,
    date: e.date,
    status: e.status,
    note: e.note,
    addedByName: e.addedByName,
  }));
  if (!viewAll) return { items }; // operators never see totals
  let totalP = 0;
  for (const e of rows) if (e.status !== "REJECTED") totalP += toPaise(e.amount);
  return { items, total: toRupees(totalP) };
}
