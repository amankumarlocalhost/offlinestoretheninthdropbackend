import { PosAdvance, PosCustomer, PosProductLink, OnlineProduct } from "../lib/models.js";
import { withTransaction } from "../lib/db.js";
import { decreaseStock, increaseStock, priceFor } from "../lib/stock.js";
import { toPaise, toRupees } from "../lib/money.js";
import { nextAdvanceNo } from "../lib/counters.js";
import { hasPermission } from "../lib/permissions.js";
import { AppError, badRequest, forbidden, notFound } from "../lib/errors.js";
import { audit } from "../lib/audit.js";
import { istDayRange } from "../lib/time.js";
import { escapeRegex, normalizePhone } from "../lib/validate.js";

/*
 * Advance / booking: the customer pays part of the money now and the shop keeps
 * the products aside. Their stock is taken off at once, so nobody else can sell
 * them. When the customer comes back, the advance is used on a new bill (see
 * createSale `advanceId`): the kept stock is released and taken again by the
 * bill, and the advance money is a payment on it. Cancelling releases the stock
 * and gives the money back (cash / online / store credit) or keeps it.
 */

function sumPaise(list) {
  let p = 0;
  for (const x of list) p += toPaise(x.amount);
  return p;
}

function checkPayments(payments, permissions) {
  for (const p of payments) {
    if (p.mode === "CASH" && !hasPermission(permissions, "payments.markCash")) throw forbidden("You cannot take cash payments.");
    if (p.mode === "ONLINE" && String(p.ref || "").trim().length < 4) throw badRequest("Enter the UTR / last 6 digits for the online payment.");
  }
}

// Puts the kept-aside pieces back on the shelf (inside a transaction).
export async function releaseAdvanceStock(advance, session) {
  for (const it of advance.items) {
    await increaseStock({ productId: it.productId, variantKey: it.variantKey, qty: it.qty, session });
  }
}

export async function createAdvance(input, { user, permissions }, info) {
  checkPayments(input.payments, permissions);

  // Merge repeated SKUs into one line.
  const wanted = [];
  for (const it of input.items || []) {
    const sku = String(it.sku).trim().toUpperCase();
    const found = wanted.find((w) => w.sku === sku);
    if (found) found.qty += it.qty;
    else wanted.push({ sku, qty: it.qty });
  }

  return withTransaction(async (session) => {
    const customer = await PosCustomer.findById(input.customerId).session(session);
    if (!customer) throw badRequest("Customer not found.");

    const items = [];
    let estimateP = 0;
    for (const w of wanted) {
      const link = await PosProductLink.findOne({ sku: w.sku }).session(session).lean();
      if (!link) throw notFound(`No product with SKU ${w.sku}.`);
      if (!link.isActive) throw new AppError(`${w.sku} is not available.`, "SKU_INACTIVE", 409);
      const product = await OnlineProduct.findById(link.productId).session(session).lean();
      if (!product || product.isActive === false) throw new AppError(`${w.sku} is no longer available.`, "PRODUCT_INACTIVE", 409);
      await decreaseStock({ productId: link.productId, variantKey: link.variantKey, qty: w.qty, sku: w.sku, session });
      const { price, mrp } = priceFor(product, link.variantKey);
      estimateP += toPaise(price) * w.qty;
      items.push({
        productId: product._id,
        sku: link.sku,
        variantKey: link.variantKey,
        name: product.name,
        size: link.size,
        color: link.color,
        image: product.images?.[0] || null,
        qty: w.qty,
        price,
        mrp,
      });
    }

    const paidP = sumPaise(input.payments);
    if (paidP <= 0) throw badRequest("Enter the advance amount.");
    const now = new Date();
    const [advance] = await PosAdvance.create(
      [
        {
          advanceNo: await nextAdvanceNo(session),
          customer: customer._id,
          customerSnapshot: { name: customer.name, phone: customer.phone },
          items,
          estimateTotal: toRupees(estimateP),
          payments: input.payments.map((p) => ({ mode: p.mode, amount: p.amount, ref: p.ref || "", receivedAt: now, byName: user.name })),
          paidTotal: toRupees(paidP),
          note: input.note || "",
          pickupBy: input.pickupBy ? istDayRange(input.pickupBy).from : null,
          status: "OPEN",
          createdBy: user._id,
          createdByName: user.name,
        },
      ],
      { session }
    );
    await audit({ user, action: "ADVANCE_CREATE", entity: "PosAdvance", entityId: advance.advanceNo, after: { amount: advance.paidTotal, items: items.length, customer: customer.phone }, session, ...info });
    return advance;
  });
}

// More advance money from the same customer.
export async function addAdvancePayment(id, input, { user, permissions }, info) {
  checkPayments(input.payments, permissions);
  return withTransaction(async (session) => {
    const advance = await PosAdvance.findById(id).session(session);
    if (!advance) throw notFound("Advance not found.");
    if (advance.status !== "OPEN") throw badRequest("This advance is not open any more.");
    const now = new Date();
    for (const p of input.payments) advance.payments.push({ mode: p.mode, amount: p.amount, ref: p.ref || "", receivedAt: now, byName: user.name });
    advance.paidTotal = toRupees(sumPaise(advance.payments));
    await advance.save({ session });
    await audit({ user, action: "ADVANCE_PAYMENT", entity: "PosAdvance", entityId: advance.advanceNo, after: { added: toRupees(sumPaise(input.payments)), paidTotal: advance.paidTotal }, session, ...info });
    return advance;
  });
}

export async function cancelAdvance(id, { reason, refundMode }, { user, permissions }, info) {
  if (refundMode === "CASH" && !hasPermission(permissions, "payments.markCash")) throw forbidden("You cannot give cash back.");
  return withTransaction(async (session) => {
    const advance = await PosAdvance.findById(id).session(session);
    if (!advance) throw notFound("Advance not found.");
    if (advance.status !== "OPEN") throw badRequest("This advance is not open any more.");
    await releaseAdvanceStock(advance, session);
    const amount = refundMode === "NONE" ? 0 : advance.paidTotal;
    if (refundMode === "STORE_CREDIT" && amount > 0) {
      await PosCustomer.updateOne({ _id: advance.customer }, { $inc: { storeCredit: amount } }, { session });
    }
    advance.status = "CANCELLED";
    advance.cancelReason = reason;
    advance.cancelledAt = new Date();
    advance.cancelledBy = user.name;
    advance.refund = { mode: refundMode, amount };
    await advance.save({ session });
    await audit({ user, action: "ADVANCE_CANCEL", entity: "PosAdvance", entityId: advance.advanceNo, after: { reason, refundMode, amount }, session, ...info });
    return advance;
  });
}

export function shapeAdvance(a) {
  const x = a.toObject ? a.toObject() : a;
  return {
    id: String(x._id),
    advanceNo: x.advanceNo,
    customer: String(x.customer),
    customerSnapshot: x.customerSnapshot,
    items: x.items,
    estimateTotal: x.estimateTotal,
    payments: x.payments,
    paidTotal: x.paidTotal,
    balance: toRupees(Math.max(0, toPaise(x.estimateTotal) - toPaise(x.paidTotal))),
    note: x.note,
    pickupBy: x.pickupBy,
    status: x.status,
    sale: x.sale ? String(x.sale) : null,
    billNo: x.billNo,
    completedAt: x.completedAt,
    cancelReason: x.cancelReason,
    cancelledAt: x.cancelledAt,
    cancelledBy: x.cancelledBy,
    refund: x.refund,
    createdByName: x.createdByName,
    createdAt: x.createdAt,
  };
}

export async function getAdvance(id) {
  const a = await PosAdvance.findById(id).lean();
  if (!a) throw notFound("Advance not found.");
  return a;
}

export async function listAdvances(query) {
  const filter = {};
  const status = query.status === undefined ? "OPEN" : query.status;
  if (status) filter.status = status;
  if (query.customer) filter.customer = query.customer;
  if (query.q) {
    const q = String(query.q).trim();
    const digits = normalizePhone(q);
    const or = [{ advanceNo: new RegExp(escapeRegex(q), "i") }, { "customerSnapshot.name": new RegExp(escapeRegex(q), "i") }];
    if (digits.length >= 4) or.push({ "customerSnapshot.phone": new RegExp(escapeRegex(digits)) });
    filter.$or = or;
  }
  const rows = await PosAdvance.find(filter).sort({ createdAt: -1 }).limit(200).lean();
  let heldP = 0;
  for (const a of rows) if (a.status === "OPEN") heldP += toPaise(a.paidTotal);
  return { items: rows.map(shapeAdvance), held: toRupees(heldP) };
}
