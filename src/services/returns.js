import { PosReturn, PosSale, PosCustomer, PosProductLink } from "../lib/models.js";
import { withTransaction } from "../lib/db.js";
import { increaseStock } from "../lib/stock.js";
import { toPaise, toRupees } from "../lib/money.js";
import { nextReturnNo } from "../lib/counters.js";
import { getSettings } from "../lib/settings.js";
import { hasPermission } from "../lib/permissions.js";
import { AppError, badRequest, notFound, forbidden } from "../lib/errors.js";
import { audit } from "../lib/audit.js";
import { findLinkBySku } from "./products.js";

const RETURNABLE = ["PAID", "PARTIALLY_RETURNED"];

/**
 * Applies a return inside a transaction: stock back, the bill's returned
 * quantities and status, a credit note number, and the refund (cash from the
 * drawer, or store credit on the customer).
 */
export async function processReturn(returnId, actor, session, info = {}) {
  const ret = await PosReturn.findById(returnId).session(session);
  if (!ret) throw notFound("Return not found.");
  if (ret.status !== "PENDING") throw badRequest("This return was already decided.");
  const sale = await PosSale.findById(ret.sale).session(session);
  if (!sale) throw notFound("Bill not found.");

  for (const r of ret.items) {
    const item = sale.items[r.lineIndex];
    if (!item || item.qty - (item.returnedQty || 0) < r.qty) throw badRequest(`Cannot return more ${r.name} than were sold.`);
    item.returnedQty = (item.returnedQty || 0) + r.qty;
    const link = await findLinkBySku(item.sku, session);
    await increaseStock({ productId: item.productId, variantKey: link ? link.variantKey : item.size, qty: r.qty, session });
  }

  let allBack = true;
  for (const it of sale.items) if ((it.returnedQty || 0) < it.qty) allBack = false;
  sale.status = allBack ? "RETURNED" : "PARTIALLY_RETURNED";
  sale.markModified("items");
  await sale.save({ session });

  if (sale.customer) {
    const inc = {};
    if (ret.refundMode === "STORE_CREDIT" || ret.refundMode === "EXCHANGE") inc.storeCredit = ret.refundAmount;
    if (sale.statsApplied) inc.totalSpent = -ret.refundAmount;
    if (Object.keys(inc).length) await PosCustomer.updateOne({ _id: sale.customer }, { $inc: inc }, { session });
  }

  ret.returnNo = await nextReturnNo(session);
  ret.status = "PROCESSED";
  ret.approvedBy = actor.name;
  ret.processedAt = new Date();
  await ret.save({ session });
  await audit({ user: actor, action: "RETURN", entity: "PosReturn", entityId: ret.returnNo, after: { billNo: ret.billNo, amount: ret.refundAmount, mode: ret.refundMode }, session, ...info });
  return ret;
}

export async function requestReturn(input, { user, permissions }, info) {
  const settings = await getSettings();
  const sale = await PosSale.findById(input.saleId);
  if (!sale) throw notFound("Bill not found.");
  if (!RETURNABLE.includes(sale.status)) throw badRequest(`A ${sale.status.toLowerCase().replace("_", " ")} bill cannot be returned.`);
  if (["STORE_CREDIT", "EXCHANGE"].includes(input.refundMode) && !sale.customer) {
    throw badRequest("Store credit / exchange needs a customer. Walk-in bills can be refunded in cash or online only.");
  }

  // Quantities already promised to other pending returns.
  const pending = await PosReturn.find({ sale: sale._id, status: "PENDING" }).lean();
  const pendingQty = new Map();
  for (const p of pending) for (const it of p.items) pendingQty.set(it.lineIndex, (pendingQty.get(it.lineIndex) || 0) + it.qty);

  const days = Number(settings.returns?.days ?? 7);
  const ageDays = (Date.now() - new Date(sale.createdAt).getTime()) / 86400000;
  let outsidePolicy = ageDays > days;
  const policyNotes = [];
  if (outsidePolicy) policyNotes.push(`older than ${days} days`);

  const items = [];
  let totalP = 0;
  for (const r of input.items) {
    const item = sale.items[r.lineIndex];
    if (!item) throw badRequest("Invalid item.");
    if (!(r.qty > 0)) continue;
    const left = item.qty - (item.returnedQty || 0) - (pendingQty.get(r.lineIndex) || 0);
    if (r.qty > left) throw badRequest(`Only ${left} of ${item.name} can be returned.`);
    if (item.isSaleItem && settings.returns?.saleExchangeOnly && input.refundMode !== "EXCHANGE") {
      outsidePolicy = true;
      policyNotes.push(`${item.name} was a sale item (exchange only)`);
    }
    // Refund what was actually paid for those units, after the bill discount.
    const amountP = Math.round((toPaise(item.lineTotal) * r.qty) / item.qty);
    totalP += amountP;
    items.push({ lineIndex: r.lineIndex, sku: item.sku, name: item.name, size: item.size, qty: r.qty, amount: toRupees(amountP) });
  }
  if (!items.length) throw badRequest("Select at least one item to return.");

  const isAdmin = hasPermission(permissions, "returns.approve");
  if (outsidePolicy) {
    if (!isAdmin) throw new AppError(`Outside return policy: ${policyNotes.join(", ")}. Only the owner can override.`, "RETURN_POLICY", 403);
    if (!input.overrideReason || !input.overrideReason.trim()) {
      throw new AppError(`Outside return policy: ${policyNotes.join(", ")}. Enter an override reason.`, "RETURN_POLICY", 400);
    }
  }

  const refundAmount = toRupees(totalP);
  // Operators do returns up to the limit in Settings; bigger ones the owner does.
  const autoLimit = Number(settings.returns?.autoApproveLimit ?? 0);
  if (!isAdmin && refundAmount > autoLimit) {
    throw new AppError(`Returns above ₹${autoLimit} are done by the owner. This one is ₹${refundAmount}.`, "RETURN_LIMIT", 403);
  }
  const ret = await PosReturn.create({
    sale: sale._id,
    billNo: sale.billNo,
    customer: sale.customer,
    customerSnapshot: sale.customerSnapshot,
    items,
    reason: input.reason,
    refundMode: input.refundMode,
    refundAmount,
    outsidePolicy,
    overrideReason: outsidePolicy ? input.overrideReason.trim() : "",
    requestedBy: user._id,
    requestedByName: user.name,
  });

  const processed = await withTransaction((session) => processReturn(ret._id, user, session, info));
  return { processed: true, ret: processed };
}

export async function listReturns(query, { user, permissions }) {
  const filter = {};
  if (!hasPermission(permissions, "returns.approve")) filter.requestedBy = user._id;
  if (query.status) filter.status = query.status;
  if (query.saleId) filter.sale = query.saleId;
  const rows = await PosReturn.find(filter).sort({ createdAt: -1 }).limit(100).lean();
  return rows.map(shapeReturn);
}

export function shapeReturn(r) {
  return {
    id: String(r._id),
    returnNo: r.returnNo,
    billNo: r.billNo,
    sale: String(r.sale),
    customerSnapshot: r.customerSnapshot,
    items: r.items,
    reason: r.reason,
    refundMode: r.refundMode,
    refundAmount: r.refundAmount,
    status: r.status,
    outsidePolicy: r.outsidePolicy,
    overrideReason: r.overrideReason,
    requestedByName: r.requestedByName,
    approvedBy: r.approvedBy,
    processedAt: r.processedAt,
    createdAt: r.createdAt,
  };
}

export async function getReturn(id, { user, permissions }) {
  const r = await PosReturn.findById(id).lean();
  if (!r) throw notFound("Return not found.");
  if (!hasPermission(permissions, "returns.approve") && String(r.requestedBy) !== String(user._id)) throw forbidden();
  return r;
}

/** Bills a customer can return from (for the returns screen). */
export async function returnableBills(customerId) {
  const sales = await PosSale.find({ customer: customerId, status: { $in: RETURNABLE } }).sort({ createdAt: -1 }).limit(30).lean();
  return sales.map((s) => ({
    id: String(s._id),
    billNo: s.billNo,
    createdAt: s.createdAt,
    grandTotal: s.grandTotal,
    status: s.status,
    items: s.items.map((i, idx) => ({ lineIndex: idx, name: i.name, sku: i.sku, size: i.size, qty: i.qty, returnedQty: i.returnedQty || 0, lineTotal: i.lineTotal, isSaleItem: i.isSaleItem })),
  }));
}
