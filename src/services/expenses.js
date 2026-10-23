import { PosExpense } from "../lib/models.js";
import { badRequest, forbidden, notFound } from "../lib/errors.js";
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
    // Today's entries, plus ones added today for an earlier date (back-dated).
    const today = istDayRange().from;
    filter.$or = [{ date: { $gte: today } }, { createdAt: { $gte: today } }];
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
    createdAt: e.createdAt,
    editable: viewAll || (String(e.addedBy) === String(user._id) && e.createdAt >= istDayRange().from),
  }));
  if (!viewAll) return { items }; // operators never see totals
  let totalP = 0;
  for (const e of rows) if (e.status !== "REJECTED") totalP += toPaise(e.amount);
  return { items, total: toRupees(totalP) };
}

// The owner edits any expense; staff only their own, on the day they added it.
async function editableExpense(id, { user, permissions }) {
  const expense = await PosExpense.findById(id);
  if (!expense) throw notFound("Expense not found.");
  if (hasPermission(permissions, "expenses.viewAll")) return expense;
  if (String(expense.addedBy) !== String(user._id) || expense.createdAt < istDayRange().from) {
    throw forbidden("You can only change your own expenses on the day you added them.");
  }
  return expense;
}

/** Fix a wrong entry: title, category, amount, paid via, date (back date allowed) or note. */
export async function updateExpense(id, input, { user, permissions }, info) {
  const expense = await editableExpense(id, { user, permissions });
  if (input.date && input.date.getTime() > Date.now() + 60 * 1000) throw badRequest("The date cannot be in the future.");
  const isOwner = hasPermission(permissions, "expenses.viewAll");
  if (!isOwner && input.amount !== undefined) {
    const settings = await getSettings();
    const limit = Number(settings.limits?.expenseApprovalLimit ?? 0);
    if (input.amount > limit) throw forbidden(`Expenses above ₹${limit} are added by the owner.`);
  }
  const fields = ["title", "category", "amount", "paidVia", "date", "note"];
  const before = {};
  const after = {};
  for (const key of fields) {
    if (input[key] === undefined) continue;
    before[key] = expense[key];
    after[key] = input[key];
    expense[key] = input[key];
  }
  if (!Object.keys(after).length) throw badRequest("Nothing to change.");
  await expense.save();
  await audit({ user, action: "EXPENSE_EDIT", entity: "PosExpense", entityId: expense._id, before, after, ...info });
  return expense;
}

export async function deleteExpense(id, { user, permissions }, info) {
  const expense = await editableExpense(id, { user, permissions });
  await PosExpense.deleteOne({ _id: expense._id });
  await audit({ user, action: "EXPENSE_DELETE", entity: "PosExpense", entityId: expense._id, before: { title: expense.title, amount: expense.amount, date: expense.date }, ...info });
  return { deleted: true };
}
