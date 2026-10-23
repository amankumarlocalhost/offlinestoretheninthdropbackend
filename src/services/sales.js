import crypto from "crypto";
import bcrypt from "bcryptjs";
import { SignJWT, jwtVerify } from "jose";
import { PosSale, PosProductLink, OnlineProduct, PosCustomer, PosUser, PosAdvance, PosReturn } from "../lib/models.js";
import { withTransaction } from "../lib/db.js";
import { decreaseStock, increaseStock, priceFor } from "../lib/stock.js";
import { calculateBill, getBillStatus, toPaise, toRupees } from "../lib/money.js";
import { nextBillNo } from "../lib/counters.js";
import { getSettings, storeSnapshot } from "../lib/settings.js";
import { hasPermission } from "../lib/permissions.js";
import { AppError, badRequest, forbidden, notFound } from "../lib/errors.js";
import { audit } from "../lib/audit.js";
import { findLinkBySku } from "./products.js";
import { rateLimit } from "../lib/http.js";
import { istDayRange } from "../lib/time.js";
import { escapeRegex, normalizePhone } from "../lib/validate.js";
import { releaseAdvanceStock } from "./advances.js";

/* ── Discount approval tokens (admin PIN entered on the spot) ─────────────── */
function approvalKey() {
  return new TextEncoder().encode(process.env.POS_JWT_SECRET + ":discount-approval");
}

export async function signDiscountApproval(userId, maxPercent, approverName) {
  return new SignJWT({ maxPercent, approver: approverName, kind: "discount" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(String(userId))
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(approvalKey());
}

async function readDiscountApproval(token, userId) {
  try {
    const { payload } = await jwtVerify(token, approvalKey(), { algorithms: ["HS256"] });
    if (payload.kind !== "discount" || payload.sub !== String(userId)) return null;
    return payload;
  } catch {
    return null;
  }
}

/**
 * The owner types their 4-digit PIN on the operator's screen. Returns a
 * short-lived token that lets THIS operator give up to `percent` discount.
 */
export async function verifyAdminPin({ pin, percent }, user, info) {
  rateLimit(`pin:${user._id}`, 5, 10 * 60 * 1000);
  const settings = await getSettings({ withPin: true });
  const hash = settings.limits?.adminPinHash;
  if (!hash) throw new AppError("No approval PIN is set. The owner can set one in Settings.", "NO_PIN", 400);
  const ok = await bcrypt.compare(String(pin), hash);
  if (!ok) {
    await audit({ user, action: "PIN_FAIL", entity: "Discount", after: { percent }, ...info });
    throw new AppError("Wrong PIN.", "WRONG_PIN", 403);
  }
  const owner = await PosUser.findOne({ role: "SUPER_ADMIN", isActive: true }).select("name").lean();
  const token = await signDiscountApproval(user._id, percent, owner?.name || "Owner");
  await audit({ user, action: "DISCOUNT_PIN_APPROVED", entity: "Discount", after: { percent }, ...info });
  return { approvalToken: token, maxPercent: percent };
}

/* ── Who may verify an online (UPI) payment ───────────────────────────────── */
function canVerifyOnline(permissions, settings) {
  if (hasPermission(permissions, "sales.viewAll")) return true; // the owner
  return hasPermission(permissions, "payments.verifyOnline") && settings.payments?.operatorCanVerifyOnline !== false;
}

async function applyCustomerStats(sale, sign, session) {
  if (!sale.customer) return;
  const update = { $inc: { totalSpent: sign * sale.grandTotal, totalVisits: sign } };
  if (sign > 0) update.$set = { lastVisitAt: sale.createdAt || new Date() };
  await PosCustomer.updateOne({ _id: sale.customer }, update, { session });
}

/**
 * Creates a sale in ONE transaction. Prices come only from the database; any
 * price the client sends is ignored. If anything fails (stock, discount,
 * payment mismatch) nothing is saved and stock is untouched.
 */
export async function createSale(input, { user, permissions }, info) {
  if (!input.items?.length) throw badRequest("Add at least one item.");

  // Merge repeated scans of the same SKU into one line.
  const wanted = [];
  for (const it of input.items) {
    const sku = String(it.sku).trim().toUpperCase();
    let found = null;
    for (const w of wanted) if (w.sku === sku) found = w;
    if (found) found.qty += it.qty;
    else wanted.push({ sku, qty: it.qty });
  }

  return withTransaction(async (session) => {
    const settings = await getSettings({ session });

    // Customer is compulsory on every bill.
    if (!input.customerId) throw badRequest("Add the customer's mobile number and name first.");
    const customer = await PosCustomer.findById(input.customerId).session(session);
    if (!customer) throw badRequest("Customer not found.");

    // An advance paid earlier: its kept-aside stock goes back first, so the
    // lines below can take it again, and its money becomes a payment.
    let advance = null;
    if (input.advanceId) {
      if (!hasPermission(permissions, "advances.manage")) throw forbidden("You cannot use advances.");
      advance = await PosAdvance.findById(input.advanceId).session(session);
      if (!advance || advance.status !== "OPEN") throw badRequest("This advance is not open any more.");
      if (String(advance.customer) !== String(customer._id)) throw badRequest("This advance belongs to another customer.");
      await releaseAdvanceStock(advance, session);
    }

    // Lines: read live product data, then take the stock atomically.
    const lines = [];
    for (const w of wanted) {
      const link = await PosProductLink.findOne({ sku: w.sku }).session(session).lean();
      if (!link) throw notFound(`No product with SKU ${w.sku}.`);
      if (!link.isActive) throw new AppError(`${w.sku} is not available for billing.`, "SKU_INACTIVE", 409);
      const product = await OnlineProduct.findById(link.productId).session(session).lean();
      if (!product || product.isActive === false) throw new AppError(`${w.sku} is no longer available.`, "PRODUCT_INACTIVE", 409);

      await decreaseStock({ productId: link.productId, variantKey: link.variantKey, qty: w.qty, sku: w.sku, session });

      const { price, mrp } = priceFor(product, link.variantKey);
      let isSaleItem = product.badge === "Sale";
      for (const c of product.categories || []) if (c === "sale") isSaleItem = true;
      lines.push({
        productId: product._id,
        sku: link.sku,
        name: product.name,
        size: link.size,
        color: link.color,
        image: product.images?.[0] || null,
        qty: w.qty,
        mrp,
        price,
        cost: link.costPrice ?? null,
        isSaleItem,
      });
    }

    // Discount.
    let subTotalP = 0;
    let mrpTotalP = 0;
    for (const l of lines) {
      subTotalP += toPaise(l.price) * l.qty;
      mrpTotalP += toPaise(l.mrp) * l.qty;
    }
    let discount = 0;
    const d = input.discount;
    if (d && Number(d.value) > 0) {
      if (!hasPermission(permissions, "sales.discount")) throw forbidden("You cannot give discounts.");
      if (!d.reason || !d.reason.trim()) throw badRequest("A reason is required for a discount.");
      discount = d.type === "PERCENT" ? toRupees(Math.round((subTotalP * Number(d.value)) / 100)) : Number(d.value);
      if (toPaise(discount) > subTotalP) throw badRequest("Discount cannot be more than the bill amount.");
    }
    const discountPercent = subTotalP > 0 ? Math.round((toPaise(discount) / subTotalP) * 10000) / 100 : 0;
    let discountApprovedBy = "";
    if (discount > 0 && !hasPermission(permissions, "sales.discountUnlimited") && discountPercent > user.discountLimitPercent + 1e-9) {
      let ok = false;
      if (input.approvalToken) {
        const p = await readDiscountApproval(input.approvalToken, user._id);
        if (p && discountPercent <= Number(p.maxPercent) + 1e-9) {
          ok = true;
          discountApprovedBy = `${p.approver} (PIN)`;
        }
      }
      if (!ok) {
        throw new AppError(
          `Discount ${discountPercent}% is above your limit of ${user.discountLimitPercent}%. Ask the owner to enter the PIN.`,
          "DISCOUNT_LIMIT",
          403
        );
      }
    }

    const bill = calculateBill(lines, discount);
    const items = [];
    for (let i = 0; i < lines.length; i++) items.push({ ...lines[i], ...bill.lines[i], returnedQty: 0 });

    // Payments must add up to the bill exactly.
    const canVerify = canVerifyOnline(permissions, settings);
    const payments = [];
    let paidP = 0;
    for (const p of input.payments || []) {
      if (!(p.amount > 0)) throw badRequest("Each payment amount must be more than zero.");
      paidP += toPaise(p.amount);
      if (p.mode === "CASH") {
        if (!hasPermission(permissions, "payments.markCash")) throw forbidden("You cannot take cash payments.");
        payments.push({ mode: "CASH", amount: p.amount, status: "RECEIVED", receivedAt: new Date() });
      } else if (p.mode === "ONLINE") {
        const ref = String(p.ref || "").trim();
        if (ref.length < 4) throw badRequest("Enter the UTR / last 6 digits for the online payment.");
        if (p.verified && canVerify) {
          payments.push({ mode: "ONLINE", amount: p.amount, status: "RECEIVED", ref, receivedAt: new Date(), verifiedBy: user._id, verifiedByName: user.name });
        } else {
          payments.push({ mode: "ONLINE", amount: p.amount, status: "PENDING", ref });
        }
      } else if (p.mode === "STORE_CREDIT") {
        if (!customer) throw badRequest("Store credit needs a customer (not walk-in).");
        const res = await PosCustomer.updateOne(
          { _id: customer._id, storeCredit: { $gte: p.amount } },
          { $inc: { storeCredit: -p.amount } },
          { session }
        );
        if (res.matchedCount === 0) throw badRequest("Not enough store credit.");
        payments.push({ mode: "STORE_CREDIT", amount: p.amount, status: "RECEIVED", receivedAt: new Date() });
      } else {
        throw badRequest("Unknown payment mode.");
      }
    }
    if (advance) {
      paidP += toPaise(advance.paidTotal);
      payments.push({ mode: "ADVANCE", amount: advance.paidTotal, status: "RECEIVED", ref: advance.advanceNo, receivedAt: new Date() });
      if (paidP > toPaise(bill.grandTotal)) {
        throw badRequest(`Advance and payments (₹${toRupees(paidP)}) are more than the bill (₹${bill.grandTotal}). Add items, or cancel the advance with a refund.`);
      }
    }
    // Udhaar: the customer takes the goods and pays the rest later.
    const dueP = toPaise(bill.grandTotal) - paidP;
    const onDue = input.allowDue && dueP > 0;
    if (onDue && !hasPermission(permissions, "sales.credit")) throw forbidden("You cannot give goods on udhaar (pay later).");
    if (!onDue && paidP !== toPaise(bill.grandTotal)) {
      throw new AppError(
        `Payments (₹${toRupees(paidP)}) must equal the bill total (₹${bill.grandTotal}).`,
        "PAYMENT_MISMATCH",
        400
      );
    }

    const billNo = await nextBillNo(session);
    const sale = new PosSale({
      billNo,
      customer: customer?._id || null,
      customerSnapshot: { name: customer.name, phone: customer.phone },
      items,
      mrpTotal: toRupees(mrpTotalP),
      subTotal: bill.subTotal,
      discount: bill.discount,
      discountPercent,
      discountReason: discount > 0 ? d.reason.trim() : "",
      discountApprovedBy,
      roundOff: bill.roundOff,
      grandTotal: bill.grandTotal,
      payments,
      status: "PENDING",
      soldBy: user._id,
      soldByName: user.name,
      exchangeAgainst: input.exchangeAgainst || "",
      dueAmount: onDue ? toRupees(dueP) : 0,
      dueNote: onDue ? input.dueNote || "" : "",
      dueDate: onDue && input.dueDate ? istDayRange(input.dueDate).from : null,
      advanceNo: advance ? advance.advanceNo : "",
      invoice: {
        publicToken: crypto.randomBytes(24).toString("base64url"),
        format: settings.invoice?.defaultFormat || "THERMAL",
        title: "RETAIL INVOICE",
        store: storeSnapshot(settings),
        printCount: 0,
      },
    });
    sale.status = getBillStatus(sale);
    if (sale.status === "PAID" && customer) sale.statsApplied = true;
    await sale.save({ session });
    if (sale.statsApplied) await applyCustomerStats(sale, 1, session);
    if (advance) {
      advance.status = "COMPLETED";
      advance.sale = sale._id;
      advance.billNo = sale.billNo;
      advance.completedAt = new Date();
      await advance.save({ session });
      await audit({ user, action: "ADVANCE_COMPLETE", entity: "PosAdvance", entityId: advance.advanceNo, after: { billNo: sale.billNo, amount: advance.paidTotal }, session, ...info });
    }
    if (onDue) {
      await audit({ user, action: "SALE_ON_DUE", entity: "PosSale", entityId: sale.billNo, after: { due: sale.dueAmount, note: sale.dueNote }, session, ...info });
    }

    await audit({ user, action: "SALE_CREATE", entity: "PosSale", entityId: sale.billNo, after: { grandTotal: sale.grandTotal, status: sale.status, items: items.length }, session, ...info });
    if (discount > 0) {
      await audit({ user, action: "DISCOUNT_APPLY", entity: "PosSale", entityId: sale.billNo, after: { discount: sale.discount, percent: discountPercent, reason: sale.discountReason, approvedBy: discountApprovedBy }, session, ...info });
    }
    return sale;
  });
}

/* ── Reading sales ─────────────────────────────────────────────────────────── */
export function shapeSale(sale, permissions) {
  const s = sale.toObject ? sale.toObject() : sale;
  return {
    id: String(s._id),
    billNo: s.billNo,
    createdAt: s.createdAt,
    customer: s.customer ? String(s.customer) : null,
    customerSnapshot: s.customerSnapshot,
    // Cost price stays on the server unless the user may see costs.
    items: hasPermission(permissions, "products.viewCost") ? s.items : s.items.map(({ cost, ...rest }) => rest),
    mrpTotal: s.mrpTotal,
    subTotal: s.subTotal,
    discount: s.discount,
    discountPercent: s.discountPercent,
    discountReason: s.discountReason,
    discountApprovedBy: s.discountApprovedBy,
    roundOff: s.roundOff,
    grandTotal: s.grandTotal,
    payments: (s.payments || []).map((p) => ({ id: String(p._id), mode: p.mode, amount: p.amount, status: p.status, ref: p.ref, receivedAt: p.receivedAt, verifiedByName: p.verifiedByName, late: Boolean(p.late), note: p.note || "" })),
    dueAmount: s.dueAmount || 0,
    dueNote: s.dueNote || "",
    dueDate: s.dueDate || null,
    advanceNo: s.advanceNo || "",
    edits: s.edits || [],
    status: s.status,
    soldBy: String(s.soldBy),
    soldByName: s.soldByName,
    exchangeAgainst: s.exchangeAgainst,
    invoice: { publicToken: s.invoice?.publicToken, format: s.invoice?.format, title: s.invoice?.title, store: s.invoice?.store, printCount: s.invoice?.printCount || 0, lastPrintedAt: s.invoice?.lastPrintedAt },
    cancelReason: s.cancelReason,
    cancelledBy: s.cancelledBy,
    cancelledAt: s.cancelledAt,
    canVerify: hasPermission(permissions, "payments.verifyOnline"),
  };
}

// Operators only see their own bills from today.
function assertCanView(sale, { user, permissions }) {
  if (hasPermission(permissions, "sales.viewAll")) return;
  const today = istDayRange();
  if (String(sale.soldBy) !== String(user._id) || sale.createdAt < today.from) {
    throw forbidden("You can only open your own bills from today.");
  }
}

export async function getSale(id, auth) {
  const sale = await PosSale.findById(id);
  if (!sale) throw notFound("Bill not found.");
  assertCanView(sale, auth);
  return sale;
}

export async function listSales(query, { user, permissions }) {
  const filter = {};
  const page = Math.max(1, Number(query.page) || 1);
  const limit = Math.min(100, Number(query.limit) || 30);
  if (!hasPermission(permissions, "sales.viewAll")) {
    filter.soldBy = user._id;
    filter.createdAt = { $gte: istDayRange().from };
  } else {
    if (query.from || query.to) {
      filter.createdAt = {};
      if (query.from) filter.createdAt.$gte = istDayRange(query.from).from;
      if (query.to) filter.createdAt.$lt = istDayRange(query.to).to;
    }
    if (query.soldBy) filter.soldBy = query.soldBy;
  }
  if (query.status) filter.status = query.status;
  if (query.q) {
    const q = String(query.q).trim();
    const digits = normalizePhone(q);
    const or = [{ billNo: new RegExp(escapeRegex(q), "i") }];
    if (digits.length >= 4) or.push({ "customerSnapshot.phone": new RegExp(escapeRegex(digits)) });
    or.push({ "customerSnapshot.name": new RegExp(escapeRegex(q), "i") });
    filter.$or = or;
  }
  const [rows, total] = await Promise.all([
    PosSale.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    PosSale.countDocuments(filter),
  ]);
  const items = rows.map((s) => ({
    id: String(s._id),
    billNo: s.billNo,
    createdAt: s.createdAt,
    customerName: s.customerSnapshot?.name,
    customerPhone: s.customerSnapshot?.phone,
    itemCount: s.items.reduce((n, i) => n + i.qty, 0),
    grandTotal: s.grandTotal,
    status: s.status,
    soldByName: s.soldByName,
    modes: [...new Set(s.payments.map((p) => p.mode))],
    dueAmount: s.dueAmount || 0,
  }));
  return { items, total, page, pages: Math.ceil(total / limit) };
}

/* ── Verify a pending online payment ──────────────────────────────────────── */
export async function verifyPayment(saleId, paymentId, { ref }, { user, permissions }, info) {
  const settings = await getSettings();
  if (!canVerifyOnline(permissions, settings)) throw forbidden("Only the owner can verify online payments right now.");
  return withTransaction(async (session) => {
    const sale = await PosSale.findById(saleId).session(session);
    if (!sale) throw notFound("Bill not found.");
    assertCanView(sale, { user, permissions });
    if (sale.status === "CANCELLED") throw badRequest("This bill is cancelled.");
    const pay = sale.payments.id(paymentId);
    if (!pay || pay.mode !== "ONLINE") throw notFound("Payment not found.");
    if (pay.status !== "PENDING") throw badRequest("This payment is already verified.");
    if (ref && String(ref).trim().length >= 4) pay.ref = String(ref).trim();
    if (!pay.ref) throw badRequest("Enter the UTR before verifying.");
    pay.status = "RECEIVED";
    pay.receivedAt = new Date();
    pay.verifiedBy = user._id;
    pay.verifiedByName = user.name;
    sale.status = getBillStatus(sale);
    if (sale.status === "PAID" && sale.customer && !sale.statsApplied) {
      sale.statsApplied = true;
      await applyCustomerStats(sale, 1, session);
    }
    await sale.save({ session });
    await audit({ user, action: "PAYMENT_VERIFY", entity: "PosSale", entityId: sale.billNo, after: { amount: pay.amount, ref: pay.ref }, session, ...info });
    return sale;
  });
}

/* ── Cancel ───────────────────────────────────────────────────────────────── */
/**
 * Cancels a bill inside an existing transaction: stock back, payments
 * reversed, store credit returned, customer totals undone. The bill number is
 * kept (never reused).
 */
export async function performCancel(saleId, reason, actor, session, info = {}) {
  const sale = await PosSale.findById(saleId).session(session);
  if (!sale) throw notFound("Bill not found.");
  if (sale.status === "CANCELLED") throw badRequest("This bill is already cancelled.");
  for (const it of sale.items) {
    if (it.returnedQty > 0) throw badRequest("Items on this bill were already returned. Use a return instead of cancelling.");
  }

  for (const it of sale.items) {
    const link = await findLinkBySku(it.sku, session);
    await increaseStock({ productId: it.productId, variantKey: link ? link.variantKey : it.size, qty: it.qty, session });
  }

  let cashBackP = 0;
  let creditBackP = 0;
  for (const p of sale.payments) {
    if (p.status !== "RECEIVED") {
      if (p.status === "PENDING") p.status = "REVERSED";
      continue;
    }
    if (p.mode === "CASH") cashBackP += toPaise(p.amount);
    if (p.mode === "STORE_CREDIT") creditBackP += toPaise(p.amount);
    // An advance used on the bill goes back to the customer as store credit.
    if (p.mode === "ADVANCE") creditBackP += toPaise(p.amount);
    p.status = "REVERSED";
  }
  if (creditBackP > 0 && sale.customer) {
    await PosCustomer.updateOne({ _id: sale.customer }, { $inc: { storeCredit: toRupees(creditBackP) } }, { session });
  }
  if (sale.statsApplied) {
    await applyCustomerStats(sale, -1, session);
    sale.statsApplied = false;
  }

  // Cash handed back to the customer, shown in the daily report.
  if (cashBackP > 0) sale.cancelCashRefund = toRupees(cashBackP);

  sale.status = "CANCELLED";
  sale.dueAmount = 0;
  sale.cancelReason = reason;
  sale.cancelledBy = actor.name;
  sale.cancelledAt = new Date();
  await sale.save({ session });
  await audit({ user: actor, action: "SALE_CANCEL", entity: "PosSale", entityId: sale.billNo, after: { reason, cashBack: toRupees(cashBackP) }, session, ...info });
  return sale;
}

/** Only the owner (sales.cancelDirect) cancels bills; the route checks it too. */
export async function cancelSale(saleId, reason, { user, permissions }, info) {
  if (!reason || !reason.trim()) throw badRequest("A reason is required.");
  if (!hasPermission(permissions, "sales.cancelDirect")) throw forbidden("Only the owner can cancel a bill.");
  const sale = await PosSale.findById(saleId);
  if (!sale) throw notFound("Bill not found.");
  if (sale.status === "CANCELLED") throw badRequest("This bill is already cancelled.");
  return withTransaction((session) => performCancel(saleId, reason.trim(), user, session, info));
}

/* ── Printing ─────────────────────────────────────────────────────────────── */
/** First print is the original; every later print is a logged DUPLICATE COPY. */
export async function recordPrint(saleId, auth, info) {
  const sale = await PosSale.findById(saleId);
  if (!sale) throw notFound("Bill not found.");
  assertCanView(sale, auth);
  const duplicate = (sale.invoice.printCount || 0) >= 1;
  if (duplicate && !hasPermission(auth.permissions, "receipts.reprint")) throw forbidden("You cannot reprint bills.");
  const updated = await PosSale.findOneAndUpdate(
    { _id: sale._id },
    { $inc: { "invoice.printCount": 1 }, $set: { "invoice.lastPrintedAt": new Date() } },
    { new: true }
  );
  if (duplicate) {
    await audit({ user: auth.user, action: "REPRINT", entity: "PosSale", entityId: sale.billNo, after: { printCount: updated.invoice.printCount }, ...info });
  }
  return { duplicate, printCount: updated.invoice.printCount, printedAt: updated.invoice.lastPrintedAt };
}

export function publicBillUrl(sale) {
  const base = (process.env.POS_PUBLIC_URL || "").replace(/\/+$/, "");
  return `${base}/b/${sale.invoice.publicToken}`;
}

export function whatsappLink(sale) {
  const phone = sale.customerSnapshot?.phone;
  if (!phone) throw badRequest("This bill has no customer phone (walk-in).");
  const store = sale.invoice?.store?.name || "THE NINTH DROP";
  const text =
    `Hi ${sale.customerSnapshot.name}, thank you for shopping at ${store}!\n` +
    `Bill ${sale.billNo}: ₹${sale.grandTotal.toLocaleString("en-IN")}\n` +
    `View your bill: ${publicBillUrl(sale)}`;
  return `https://wa.me/91${phone}?text=${encodeURIComponent(text)}`;
}

/** What the public /b/:token page may show — no internal ids or staff data. */
export function publicBill(sale) {
  const s = sale.toObject ? sale.toObject() : sale;
  const phone = s.customerSnapshot?.phone || "";
  return {
    billNo: s.billNo,
    createdAt: s.createdAt,
    status: s.status,
    title: s.invoice?.title,
    store: s.invoice?.store,
    customer: { name: s.customerSnapshot?.name, phone: phone.length >= 10 ? `${phone.slice(0, 2)}XXXX${phone.slice(-4)}` : "" },
    items: s.items.map((i) => ({ name: i.name, sku: i.sku, size: i.size, color: i.color, qty: i.qty, mrp: i.mrp, price: i.price, discount: i.discount, lineTotal: i.lineTotal, returnedQty: i.returnedQty })),
    mrpTotal: s.mrpTotal,
    subTotal: s.subTotal,
    discount: s.discount,
    roundOff: s.roundOff,
    grandTotal: s.grandTotal,
    payments: s.payments.filter((p) => p.status !== "REVERSED" || s.status === "CANCELLED").map((p) => ({ mode: p.mode, amount: p.amount, status: p.status, ref: p.ref ? p.ref.slice(-6) : "" })),
    cancelReason: s.status === "CANCELLED" ? s.cancelReason : "",
    exchangeAgainst: s.exchangeAgainst,
    dueAmount: s.status === "CANCELLED" ? 0 : s.dueAmount || 0,
  };
}

export async function findByPublicToken(token) {
  if (!token || token.length < 24) throw notFound("Bill not found.");
  const sale = await PosSale.findOne({ "invoice.publicToken": token });
  if (!sale) throw notFound("Bill not found.");
  return sale;
}

/* ── Udhaar: money still due on a bill ───────────────────────────────────── */
// Total − every payment that is not reversed (a pending online payment counts as paid).
export function dueOf(sale) {
  let paidP = 0;
  for (const p of sale.payments) if (p.status !== "REVERSED") paidP += toPaise(p.amount);
  return Math.max(0, toRupees(toPaise(sale.grandTotal) - paidP));
}

// Payments taken after the bill was made (a due collected, or a bill-edit top-up).
async function laterPayments(list, sale, { user, permissions, canVerify, session }, note) {
  const out = [];
  for (const p of list || []) {
    if (!(p.amount > 0)) throw badRequest("Each payment amount must be more than zero.");
    const base = { mode: p.mode, amount: p.amount, late: true, note };
    if (p.mode === "CASH") {
      if (!hasPermission(permissions, "payments.markCash")) throw forbidden("You cannot take cash payments.");
      out.push({ ...base, status: "RECEIVED", receivedAt: new Date(), verifiedByName: user.name });
    } else if (p.mode === "ONLINE") {
      const ref = String(p.ref || "").trim();
      if (ref.length < 4) throw badRequest("Enter the UTR / last 6 digits for the online payment.");
      if (p.verified && canVerify) out.push({ ...base, ref, status: "RECEIVED", receivedAt: new Date(), verifiedBy: user._id, verifiedByName: user.name });
      else out.push({ ...base, ref, status: "PENDING" });
    } else if (p.mode === "STORE_CREDIT") {
      if (!sale.customer) throw badRequest("Store credit needs a customer.");
      const res = await PosCustomer.updateOne({ _id: sale.customer, storeCredit: { $gte: p.amount } }, { $inc: { storeCredit: -p.amount } }, { session });
      if (res.matchedCount === 0) throw badRequest("Not enough store credit.");
      out.push({ ...base, status: "RECEIVED", receivedAt: new Date(), verifiedByName: user.name });
    } else {
      throw badRequest("Unknown payment mode.");
    }
  }
  return out;
}

// Due amount and status from the payments; customer totals once fully paid.
async function settleSale(sale, session) {
  sale.dueAmount = dueOf(sale);
  sale.status = getBillStatus(sale);
  if (sale.status === "PAID" && sale.customer && !sale.statsApplied) {
    sale.statsApplied = true;
    await applyCustomerStats(sale, 1, session);
  }
}

/** The customer pays (part of) what they owe on a bill. */
export async function collectDue(saleId, input, { user, permissions }, info) {
  const settings = await getSettings();
  const canVerify = canVerifyOnline(permissions, settings);
  return withTransaction(async (session) => {
    const sale = await PosSale.findById(saleId).session(session);
    if (!sale) throw notFound("Bill not found.");
    if (sale.status === "CANCELLED") throw badRequest("This bill is cancelled.");
    const dueP = toPaise(dueOf(sale));
    if (dueP <= 0) throw badRequest("Nothing is due on this bill.");
    let addP = 0;
    for (const p of input.payments) addP += toPaise(p.amount);
    if (addP > dueP) throw badRequest(`Only ₹${toRupees(dueP)} is due on this bill.`);
    const added = await laterPayments(input.payments, sale, { user, permissions, canVerify, session }, input.note || "Due collected");
    for (const p of added) sale.payments.push(p);
    await settleSale(sale, session);
    await sale.save({ session });
    await audit({ user, action: "DUE_COLLECT", entity: "PosSale", entityId: sale.billNo, after: { amount: toRupees(addP), stillDue: sale.dueAmount }, session, ...info });
    return sale;
  });
}

/** Bills with money still due, newest first, with the customer's details. */
export async function listDues(query) {
  const filter = { dueAmount: { $gt: 0 }, status: { $ne: "CANCELLED" } };
  if (query.customer) filter.customer = query.customer;
  if (query.q) {
    const q = String(query.q).trim();
    const digits = normalizePhone(q);
    const or = [{ billNo: new RegExp(escapeRegex(q), "i") }, { "customerSnapshot.name": new RegExp(escapeRegex(q), "i") }];
    if (digits.length >= 4) or.push({ "customerSnapshot.phone": new RegExp(escapeRegex(digits)) });
    filter.$or = or;
  }
  const rows = await PosSale.find(filter).sort({ createdAt: -1 }).limit(500).lean();
  const ids = [...new Set(rows.filter((s) => s.customer).map((s) => String(s.customer)))];
  const customers = await PosCustomer.find({ _id: { $in: ids } }).select("name phone email address notes").lean();
  const byId = new Map(customers.map((c) => [String(c._id), c]));

  let totalP = 0;
  const people = new Map();
  const items = rows.map((s) => {
    totalP += toPaise(s.dueAmount);
    const c = byId.get(String(s.customer)) || {};
    const key = String(s.customer);
    const name = c.name || s.customerSnapshot?.name;
    const phone = c.phone || s.customerSnapshot?.phone;
    const row = people.get(key) || { id: key, name, phone, address: c.address || "", bills: 0, due: 0 };
    row.bills += 1;
    row.due = toRupees(toPaise(row.due) + toPaise(s.dueAmount));
    people.set(key, row);
    let paidP = 0;
    for (const p of s.payments) if (p.status !== "REVERSED") paidP += toPaise(p.amount);
    return {
      id: String(s._id),
      billNo: s.billNo,
      createdAt: s.createdAt,
      customer: { id: key, name, phone, email: c.email || "", address: c.address || "", notes: c.notes || "" },
      items: s.items.map((i) => ({ name: i.name, sku: i.sku, size: i.size, qty: i.qty, lineTotal: i.lineTotal })),
      grandTotal: s.grandTotal,
      paid: toRupees(paidP),
      dueAmount: s.dueAmount,
      dueNote: s.dueNote || "",
      dueDate: s.dueDate || null,
      status: s.status,
      soldByName: s.soldByName,
    };
  });
  return {
    items,
    customers: [...people.values()].sort((a, b) => b.due - a.due),
    total: toRupees(totalP),
  };
}

/* ── Edit a saved bill's items ────────────────────────────────────────────── */
/**
 * Replaces the bill's items with `input.items` in one transaction. Lines that
 * stay keep the price they were sold at; new lines are priced from the
 * database. Only the stock difference moves. The bill keeps its number and its
 * discount rate. If the new total is lower than what was paid, the difference
 * goes back (cash / online / store credit) as a negative payment row; if it is
 * higher, the customer pays now and/or the rest becomes udhaar.
 */
export async function editSale(saleId, input, { user, permissions }, info) {
  const settings = await getSettings();
  const canVerify = canVerifyOnline(permissions, settings);

  const wanted = [];
  for (const it of input.items) {
    const sku = String(it.sku).trim().toUpperCase();
    const found = wanted.find((w) => w.sku === sku);
    if (found) found.qty += it.qty;
    else wanted.push({ sku, qty: it.qty });
  }

  return withTransaction(async (session) => {
    const sale = await PosSale.findById(saleId).session(session);
    if (!sale) throw notFound("Bill not found.");
    assertCanView(sale, { user, permissions });
    if (sale.status === "CANCELLED") throw badRequest("This bill is cancelled.");
    for (const it of sale.items) {
      if (it.returnedQty > 0) throw badRequest("Items on this bill were already returned, so it cannot be edited. Use a return instead.");
    }
    if (await PosReturn.exists({ sale: sale._id, status: "PENDING" }).session(session)) throw badRequest("This bill has a return waiting.");
    for (const p of sale.payments) {
      if (p.status === "PENDING") throw badRequest("Verify the online payment on this bill before editing it.");
    }

    const oldTotal = sale.grandTotal;
    const oldItems = sale.items.map((it) => (it.toObject ? it.toObject() : { ...it }));
    const oldBySku = new Map(oldItems.map((it) => [it.sku, it]));

    // Customer totals are taken back here and added again below once fully paid.
    if (sale.statsApplied) {
      await applyCustomerStats(sale, -1, session);
      sale.statsApplied = false;
    }

    const lines = [];
    const changes = [];
    const kept = new Set();
    for (const w of wanted) {
      let old = oldBySku.get(w.sku);
      let link = null;
      if (!old) {
        link = await findLinkBySku(w.sku, session);
        if (!link) throw notFound(`No product with SKU ${w.sku}.`);
        old = oldBySku.get(link.sku);
      }
      if (old) {
        if (kept.has(old.sku)) throw badRequest(`${old.sku} is listed twice.`);
        kept.add(old.sku);
        const delta = w.qty - old.qty;
        if (delta !== 0) {
          const l = await findLinkBySku(old.sku, session);
          const variantKey = l ? l.variantKey : old.size;
          if (delta > 0) await decreaseStock({ productId: old.productId, variantKey, qty: delta, sku: old.sku, session });
          else await increaseStock({ productId: old.productId, variantKey, qty: -delta, session });
          changes.push({ sku: old.sku, name: old.name, size: old.size, fromQty: old.qty, toQty: w.qty });
        }
        lines.push({ productId: old.productId, sku: old.sku, name: old.name, size: old.size, color: old.color, image: old.image, qty: w.qty, mrp: old.mrp, price: old.price, cost: old.cost ?? null, isSaleItem: old.isSaleItem });
        continue;
      }
      // A new item on the bill: priced and stocked like a new sale.
      if (kept.has(link.sku)) throw badRequest(`${link.sku} is listed twice.`);
      if (!link.isActive) throw new AppError(`${link.sku} is not available for billing.`, "SKU_INACTIVE", 409);
      const product = await OnlineProduct.findById(link.productId).session(session).lean();
      if (!product || product.isActive === false) throw new AppError(`${link.sku} is no longer available.`, "PRODUCT_INACTIVE", 409);
      await decreaseStock({ productId: link.productId, variantKey: link.variantKey, qty: w.qty, sku: link.sku, session });
      const { price, mrp } = priceFor(product, link.variantKey);
      let isSaleItem = product.badge === "Sale";
      for (const c of product.categories || []) if (c === "sale") isSaleItem = true;
      lines.push({ productId: product._id, sku: link.sku, name: product.name, size: link.size, color: link.color, image: product.images?.[0] || null, qty: w.qty, mrp, price, cost: link.costPrice ?? null, isSaleItem });
      kept.add(link.sku);
      changes.push({ sku: link.sku, name: product.name, size: link.size, fromQty: 0, toQty: w.qty });
    }
    // Lines taken off the bill: their stock goes back.
    for (const old of oldItems) {
      if (kept.has(old.sku)) continue;
      const l = await findLinkBySku(old.sku, session);
      await increaseStock({ productId: old.productId, variantKey: l ? l.variantKey : old.size, qty: old.qty, session });
      changes.push({ sku: old.sku, name: old.name, size: old.size, fromQty: old.qty, toQty: 0 });
    }
    if (!changes.length) throw badRequest("Nothing changed on the bill.");

    // Same discount rate as before, on the new subtotal.
    let subP = 0;
    let mrpP = 0;
    for (const l of lines) {
      subP += toPaise(l.price) * l.qty;
      mrpP += toPaise(l.mrp) * l.qty;
    }
    const oldSubP = toPaise(sale.subTotal);
    const discountP = oldSubP > 0 ? Math.min(subP, Math.round((subP * toPaise(sale.discount)) / oldSubP)) : 0;
    const bill = calculateBill(lines, toRupees(discountP));
    const items = [];
    for (let i = 0; i < lines.length; i++) items.push({ ...lines[i], ...bill.lines[i], returnedQty: 0 });

    let paidP = 0;
    for (const p of sale.payments) if (p.status !== "REVERSED") paidP += toPaise(p.amount);
    const oldDueP = Math.max(0, toPaise(oldTotal) - paidP);
    const newTotalP = toPaise(bill.grandTotal);

    sale.items = items;
    sale.markModified("items");
    sale.mrpTotal = toRupees(mrpP);
    sale.subTotal = bill.subTotal;
    sale.discount = bill.discount;
    sale.discountPercent = subP > 0 ? Math.round((toPaise(bill.discount) / subP) * 10000) / 100 : 0;
    sale.roundOff = bill.roundOff;
    sale.grandTotal = bill.grandTotal;

    let refund = null;
    if (paidP > newTotalP) {
      // Paid more than the new total: give the difference back.
      if ((input.payments || []).length) throw badRequest("The new total is less than what was paid, so no payment is needed.");
      const backP = paidP - newTotalP;
      const mode = input.refundMode;
      if (!mode) throw new AppError(`The customer gets ₹${toRupees(backP)} back. Choose cash, online or store credit.`, "REFUND_MODE", 400);
      if (mode === "CASH" && !hasPermission(permissions, "payments.markCash")) throw forbidden("You cannot give cash back.");
      if (mode === "STORE_CREDIT") {
        if (!sale.customer) throw badRequest("Store credit needs a customer.");
        await PosCustomer.updateOne({ _id: sale.customer }, { $inc: { storeCredit: toRupees(backP) } }, { session });
      }
      sale.payments.push({ mode, amount: -toRupees(backP), status: "RECEIVED", late: true, note: "Refund on bill edit", receivedAt: new Date(), verifiedBy: user._id, verifiedByName: user.name });
      refund = { mode, amount: toRupees(backP) };
    } else {
      let addP = 0;
      for (const p of input.payments || []) addP += toPaise(p.amount);
      const shortP = newTotalP - paidP;
      if (addP > shortP) throw badRequest(`Only ₹${toRupees(shortP)} more is to be paid.`);
      const newDueP = shortP - addP;
      if (newDueP > oldDueP) {
        if (!input.allowDue) throw new AppError(`₹${toRupees(newDueP - oldDueP)} more is to be paid. Add a payment, or keep it as udhaar.`, "PAYMENT_SHORT", 400);
        if (!hasPermission(permissions, "sales.credit")) throw forbidden("You cannot give goods on udhaar (pay later).");
      }
      const added = await laterPayments(input.payments, sale, { user, permissions, canVerify, session }, "Paid on bill edit");
      for (const p of added) sale.payments.push(p);
    }

    sale.edits.push({ at: new Date(), by: user._id, byName: user.name, reason: input.reason, oldTotal, newTotal: sale.grandTotal, changes });
    await settleSale(sale, session);
    await sale.save({ session });
    await audit({
      user,
      action: "SALE_EDIT",
      entity: "PosSale",
      entityId: sale.billNo,
      before: { grandTotal: oldTotal, items: oldItems.map((i) => `${i.sku} ×${i.qty}`) },
      after: { grandTotal: sale.grandTotal, reason: input.reason, changes, refund, due: sale.dueAmount },
      session,
      ...info,
    });
    return sale;
  });
}
