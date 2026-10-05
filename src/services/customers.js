import { PosCustomer, PosSale, PosReturn, OnlineUser, OnlineOrder } from "../lib/models.js";
import { hasPermission } from "../lib/permissions.js";
import { badRequest, conflict, forbidden, notFound } from "../lib/errors.js";
import { normalizePhone, escapeRegex } from "../lib/validate.js";
import { audit } from "../lib/audit.js";

export function shapeCustomer(c, permissions) {
  const out = {
    id: String(c._id),
    name: c.name,
    phone: c.phone,
    email: c.email || "",
    address: c.address || "",
    dob: c.dob || null,
    notes: c.notes || "",
    totalVisits: c.totalVisits || 0,
    lastVisitAt: c.lastVisitAt,
    storeCredit: c.storeCredit || 0,
    linkedOnline: Boolean(c.onlineUserId),
    createdAt: c.createdAt,
  };
  if (hasPermission(permissions, "customers.viewSpend")) out.totalSpent = c.totalSpent || 0;
  return out;
}

// Read-only lookup of an online account with the same phone number.
async function findOnlineUserId(phone) {
  try {
    const u = await OnlineUser.findOne({ phone, role: "customer" }).select("_id").lean();
    return u?._id || null;
  } catch {
    return null;
  }
}

export async function searchCustomers(query, permissions) {
  const digits = normalizePhone(query);
  // No search text: show the most recent customers so the list is never blank.
  if (!query || !String(query).trim()) {
    const rows = await PosCustomer.find().sort({ lastVisitAt: -1, createdAt: -1 }).limit(100).lean();
    return rows.map((c) => shapeCustomer(c, permissions));
  }
  if (digits.length < 3) {
    if (String(query).trim().length < 2) return [];
    const rx = new RegExp(escapeRegex(String(query).trim()), "i");
    const rows = await PosCustomer.find({ name: rx }).limit(10).lean();
    return rows.map((c) => shapeCustomer(c, permissions));
  }
  const rows = await PosCustomer.find({ phone: new RegExp("^" + escapeRegex(digits)) }).limit(10).lean();
  return rows.map((c) => shapeCustomer(c, permissions));
}

export async function createCustomer(data, actor, permissions, info) {
  const phone = normalizePhone(data.phone);
  const exists = await PosCustomer.findOne({ phone }).lean();
  if (exists) throw conflict("A customer with this phone already exists.", "CUSTOMER_EXISTS");
  const customer = await PosCustomer.create({
    name: data.name,
    phone,
    email: data.email || "",
    address: data.address || "",
    dob: data.dob || null,
    notes: data.notes || "",
    onlineUserId: await findOnlineUserId(phone),
    createdBy: actor._id,
  });
  await audit({ user: actor, action: "CUSTOMER_CREATE", entity: "PosCustomer", entityId: customer._id, after: { name: customer.name, phone }, ...info });
  return shapeCustomer(customer, permissions);
}

/**
 * Operators may only fill in fields that are still empty and can never change
 * the phone number. Admins (customers.editPhone) can change anything.
 */
export async function updateCustomer(id, data, actor, permissions, info) {
  const customer = await PosCustomer.findById(id);
  if (!customer) throw notFound("Customer not found.");
  const canEditAll = hasPermission(permissions, "customers.editPhone");
  const before = { name: customer.name, phone: customer.phone, email: customer.email, address: customer.address, notes: customer.notes };

  if (data.phone !== undefined) {
    const phone = normalizePhone(data.phone);
    if (phone !== customer.phone) {
      if (!canEditAll) throw forbidden("Only the owner can change a customer's phone number.");
      const taken = await PosCustomer.findOne({ phone, _id: { $ne: customer._id } }).lean();
      if (taken) throw conflict("Another customer already has this phone.");
      customer.phone = phone;
      customer.onlineUserId = await findOnlineUserId(phone);
    }
  }
  for (const key of ["name", "email", "address", "notes", "dob"]) {
    if (data[key] === undefined) continue;
    const current = customer[key];
    const isEmpty = current === null || current === undefined || current === "";
    if (!canEditAll && !isEmpty && String(current) !== String(data[key])) {
      throw forbidden(`You can only add missing details. Ask the owner to change "${key}".`);
    }
    customer[key] = data[key];
  }
  await customer.save();
  await audit({ user: actor, action: "CUSTOMER_EDIT", entity: "PosCustomer", entityId: customer._id, before, after: data, ...info });
  return shapeCustomer(customer, permissions);
}

export async function customerHistory(id, permissions) {
  const customer = await PosCustomer.findById(id).lean();
  if (!customer) throw notFound("Customer not found.");
  const [sales, returns] = await Promise.all([
    PosSale.find({ customer: customer._id }).sort({ createdAt: -1 }).limit(100).lean(),
    PosReturn.find({ customer: customer._id }).sort({ createdAt: -1 }).limit(50).lean(),
  ]);

  let onlineOrders = [];
  if (customer.onlineUserId) {
    try {
      const orders = await OnlineOrder.find({ user: customer.onlineUserId }).sort({ createdAt: -1 }).limit(20).lean();
      onlineOrders = orders.map((o) => ({
        orderNumber: o.orderNumber,
        total: o.total,
        orderStatus: o.orderStatus,
        paymentStatus: o.paymentStatus,
        createdAt: o.createdAt,
        items: (o.items || []).map((i) => `${i.name}${i.size ? ` (${i.size})` : ""} × ${i.qty}`),
      }));
    } catch {
      onlineOrders = [];
    }
  }

  return {
    customer: shapeCustomer(customer, permissions),
    sales: sales.map((s) => ({
      id: String(s._id),
      billNo: s.billNo,
      createdAt: s.createdAt,
      grandTotal: s.grandTotal,
      status: s.status,
      items: s.items.map((i) => ({ name: i.name, size: i.size, qty: i.qty, returnedQty: i.returnedQty || 0 })),
    })),
    returns: returns.map((r) => ({
      id: String(r._id),
      returnNo: r.returnNo,
      billNo: r.billNo,
      refundAmount: r.refundAmount,
      refundMode: r.refundMode,
      status: r.status,
      createdAt: r.createdAt,
    })),
    onlineOrders,
  };
}

function csvCell(v) {
  const s = v === null || v === undefined ? "" : String(v);
  // Prefix formula characters so a spreadsheet never runs them.
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return `"${safe.replace(/"/g, '""')}"`;
}

export async function exportCustomersCsv() {
  const rows = await PosCustomer.find().sort({ createdAt: -1 }).lean();
  const lines = ["Name,Phone,Email,Address,Total Spent,Visits,Last Visit,Store Credit,Created"];
  for (const c of rows) {
    lines.push(
      [c.name, c.phone, c.email, c.address, c.totalSpent, c.totalVisits, c.lastVisitAt?.toISOString() || "", c.storeCredit, c.createdAt?.toISOString()]
        .map(csvCell)
        .join(",")
    );
  }
  return lines.join("\n");
}

export async function getCustomerForSale(customerId, session) {
  if (!customerId) return null;
  const c = await PosCustomer.findById(customerId).session(session);
  if (!c) throw badRequest("Customer not found.");
  return c;
}
