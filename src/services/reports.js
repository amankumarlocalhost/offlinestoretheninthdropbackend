import { PosSale, PosReturn, PosExpense, OnlineProduct, OnlineOrder, OnlineCategory, PosProductLink, PosAdvance } from "../lib/models.js";
import { availableQty, priceFor, keyOf } from "../lib/stock.js";
import { hasPermission } from "../lib/permissions.js";
import { istDayRange, istMonthRange, istDateKey, istHour } from "../lib/time.js";
import { toPaise, toRupees } from "../lib/money.js";
import { getSettings } from "../lib/settings.js";
import { lowStock, variantKeysOf } from "./products.js";

const COUNTED = { $nin: ["CANCELLED"] };

// Totals over a list of sales. Money is summed in paise.
function summarize(sales) {
  let totalP = 0;
  let cashP = 0;
  let onlineP = 0;
  let creditP = 0;
  let pendingP = 0;
  let discountP = 0;
  let advanceP = 0;
  let dueP = 0;
  let items = 0;
  let splitBills = 0;
  for (const s of sales) {
    totalP += toPaise(s.grandTotal);
    discountP += toPaise(s.discount);
    dueP += toPaise(s.dueAmount || 0);
    for (const it of s.items) items += it.qty;
    const modes = new Set();
    for (const p of s.payments) {
      modes.add(p.mode);
      // Taken after the bill (a due, or a bill edit): counted on its own day in moneyMoved().
      if (p.late) continue;
      if (p.status === "PENDING") pendingP += toPaise(p.amount);
      if (p.mode === "ADVANCE") {
        if (p.status === "RECEIVED") advanceP += toPaise(p.amount);
        continue;
      }
      if (p.status !== "RECEIVED") continue;
      if (p.mode === "CASH") cashP += toPaise(p.amount);
      else if (p.mode === "ONLINE") onlineP += toPaise(p.amount);
      else creditP += toPaise(p.amount);
    }
    if (modes.size > 1) splitBills += 1;
  }
  return {
    totalSales: toRupees(totalP),
    bills: sales.length,
    itemsSold: items,
    cash: toRupees(cashP),
    online: toRupees(onlineP),
    storeCredit: toRupees(creditP),
    pendingAmount: toRupees(pendingP),
    discounts: toRupees(discountP),
    splitBills,
    advanceUsed: toRupees(advanceP), // paid earlier as an advance
    due: toRupees(dueP), // udhaar still to come on these bills
  };
}

/**
 * Money that moved in a period outside the bill's own moment: dues collected
 * (and bill-edit top-ups), refunds given on a bill edit (negative rows), and
 * advances taken / given back. Each counts on the day it happened.
 */
async function moneyMoved(range) {
  const inRange = (d) => d && d >= range.from && d < range.to;
  const [sales, advances, cancelledAdv] = await Promise.all([
    PosSale.find({ payments: { $elemMatch: { late: true, receivedAt: { $gte: range.from, $lt: range.to } } } })
      .select("billNo customerSnapshot payments")
      .lean(),
    PosAdvance.find({ "payments.receivedAt": { $gte: range.from, $lt: range.to } }).select("advanceNo customerSnapshot payments").lean(),
    PosAdvance.find({ status: "CANCELLED", cancelledAt: { $gte: range.from, $lt: range.to } }).select("advanceNo customerSnapshot refund").lean(),
  ]);
  const out = { inP: { CASH: 0, ONLINE: 0, STORE_CREDIT: 0 }, outP: { CASH: 0, ONLINE: 0, STORE_CREDIT: 0 }, advInP: { CASH: 0, ONLINE: 0 }, advOutP: { CASH: 0, ONLINE: 0, STORE_CREDIT: 0 } };
  const rows = [];
  for (const s of sales) {
    for (const p of s.payments) {
      // A reversed row (bill cancelled later) still moved money that day; the cancel gives it back.
      if (!p.late || !inRange(p.receivedAt) || p.status === "PENDING") continue;
      const a = toPaise(p.amount);
      if (a >= 0) out.inP[p.mode] = (out.inP[p.mode] || 0) + a;
      else out.outP[p.mode] = (out.outP[p.mode] || 0) - a;
      rows.push({ kind: a >= 0 ? "DUE_IN" : "EDIT_REFUND", ref: s.billNo, customer: s.customerSnapshot?.name, mode: p.mode, amount: p.amount, at: p.receivedAt, note: p.note || "" });
    }
  }
  for (const a of advances) {
    for (const p of a.payments) {
      if (!inRange(p.receivedAt)) continue;
      out.advInP[p.mode] = (out.advInP[p.mode] || 0) + toPaise(p.amount);
      rows.push({ kind: "ADVANCE_IN", ref: a.advanceNo, customer: a.customerSnapshot?.name, mode: p.mode, amount: p.amount, at: p.receivedAt, note: "" });
    }
  }
  for (const a of cancelledAdv) {
    const m = a.refund?.mode;
    if (!m || m === "NONE" || !(a.refund.amount > 0)) continue;
    out.advOutP[m] = (out.advOutP[m] || 0) + toPaise(a.refund.amount);
    rows.push({ kind: "ADVANCE_REFUND", ref: a.advanceNo, customer: a.customerSnapshot?.name, mode: m, amount: -a.refund.amount, at: null, note: "" });
  }
  const r = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, toRupees(v)]));
  return {
    dueCollected: r(out.inP),
    editRefunds: r(out.outP),
    advancesTaken: r(out.advInP),
    advancesRefunded: r(out.advOutP),
    cashIn: toRupees(out.inP.CASH + out.advInP.CASH),
    cashOut: toRupees(out.outP.CASH + out.advOutP.CASH),
    rows: rows.sort((x, y) => new Date(x.at || 0) - new Date(y.at || 0)),
  };
}

// Udhaar outstanding right now and money held as open advances.
async function openBalances() {
  const [dues, advances] = await Promise.all([
    PosSale.find({ dueAmount: { $gt: 0 }, status: { $ne: "CANCELLED" } }).select("dueAmount customer").lean(),
    PosAdvance.find({ status: "OPEN" }).select("paidTotal").lean(),
  ]);
  let dueP = 0;
  const people = new Set();
  for (const s of dues) {
    dueP += toPaise(s.dueAmount);
    people.add(String(s.customer));
  }
  let advP = 0;
  for (const a of advances) advP += toPaise(a.paidTotal);
  return { dues: { outstanding: toRupees(dueP), bills: dues.length, customers: people.size }, advances: { held: toRupees(advP), open: advances.length } };
}

function sumReturns(returns) {
  let p = 0;
  let cashP = 0;
  for (const r of returns) {
    p += toPaise(r.refundAmount);
    if (r.refundMode === "CASH") cashP += toPaise(r.refundAmount);
  }
  return { total: toRupees(p), cash: toRupees(cashP) };
}

function sumExpenses(expenses) {
  let p = 0;
  let cashP = 0;
  for (const e of expenses) {
    p += toPaise(e.amount);
    if (e.paidVia === "CASH") cashP += toPaise(e.amount);
  }
  return { total: toRupees(p), cash: toRupees(cashP) };
}

function topProducts(sales, limit = 10) {
  const map = new Map();
  for (const s of sales) {
    for (const it of s.items) {
      const net = it.qty - (it.returnedQty || 0);
      const key = it.sku;
      const row = map.get(key) || { sku: it.sku, name: it.name, size: it.size, qty: 0, revenue: 0 };
      row.qty += net;
      row.revenue = toRupees(toPaise(row.revenue) + Math.round((toPaise(it.lineTotal) * net) / it.qty));
      map.set(key, row);
    }
  }
  return [...map.values()].sort((a, b) => b.revenue - a.revenue).slice(0, limit);
}

function staffWise(sales) {
  const map = new Map();
  for (const s of sales) {
    const row = map.get(s.soldByName) || { name: s.soldByName, bills: 0, total: 0 };
    row.bills += 1;
    row.total = toRupees(toPaise(row.total) + toPaise(s.grandTotal));
    map.set(s.soldByName, row);
  }
  return [...map.values()].sort((a, b) => b.total - a.total);
}

async function categoryWise(sales) {
  const ids = new Set();
  for (const s of sales) for (const it of s.items) ids.add(String(it.productId));
  const products = await OnlineProduct.find({ _id: { $in: [...ids] } }).select("categories").lean();
  const catOf = new Map();
  for (const p of products) catOf.set(String(p._id), (p.categories || []).find((c) => !["women", "girls", "new-arrivals", "sale", "best-sellers"].includes(c)) || p.categories?.[0] || "other");
  const map = new Map();
  for (const s of sales) {
    for (const it of s.items) {
      const cat = catOf.get(String(it.productId)) || "other";
      map.set(cat, toRupees(toPaise(map.get(cat) || 0) + toPaise(it.lineTotal)));
    }
  }
  return [...map.entries()].map(([category, total]) => ({ category, total })).sort((a, b) => b.total - a.total);
}

// Current cost of each SKU (also by its old aliases), for bills made before
// the cost was saved on the bill line.
async function costBySku(sales) {
  const skus = new Set();
  for (const s of sales) for (const it of s.items) if (it.cost == null) skus.add(it.sku);
  if (!skus.size) return new Map();
  const list = [...skus];
  const links = await PosProductLink.find({ $or: [{ sku: { $in: list } }, { aliases: { $in: list } }] })
    .select("sku aliases costPrice")
    .lean();
  const map = new Map();
  for (const l of links) {
    if (l.costPrice == null) continue;
    map.set(l.sku, l.costPrice);
    for (const a of l.aliases || []) if (!map.has(a)) map.set(a, l.costPrice);
  }
  return map;
}

/**
 * Profit on the pieces that were sold and not returned: what the customer paid
 * for the line (after discount) minus its cost price. Lines without a cost are
 * left out of the profit and counted, so the number is never silently high.
 */
function profitOf(sales, fallbackCost) {
  let revenueP = 0;
  let costP = 0;
  let piecesWithoutCost = 0;
  let salesWithoutCostP = 0;
  for (const s of sales) {
    for (const it of s.items) {
      const net = it.qty - (it.returnedQty || 0);
      if (net <= 0 || !it.qty) continue;
      const lineP = Math.round((toPaise(it.lineTotal) * net) / it.qty);
      const cost = it.cost ?? fallbackCost.get(it.sku) ?? null;
      if (cost == null) {
        piecesWithoutCost += net;
        salesWithoutCostP += lineP;
        continue;
      }
      revenueP += lineP;
      costP += toPaise(cost) * net;
    }
  }
  return {
    revenue: toRupees(revenueP),
    cost: toRupees(costP),
    profit: toRupees(revenueP - costP),
    marginPercent: revenueP > 0 ? Math.round(((revenueP - costP) / revenueP) * 1000) / 10 : 0,
    piecesWithoutCost,
    salesWithoutCost: toRupees(salesWithoutCostP),
  };
}

const saleFields = "billNo createdAt customer customerSnapshot items payments grandTotal discount status soldByName dueAmount";

export async function dashboard(year, month, permissions) {
  const range = istMonthRange(year, month);
  const today = istDayRange();
  const settings = await getSettings();

  const [sales, returns, expenses, todaySales, low, onlineOrders] = await Promise.all([
    PosSale.find({ createdAt: { $gte: range.from, $lt: range.to }, status: COUNTED }).select(saleFields).lean(),
    PosReturn.find({ status: "PROCESSED", processedAt: { $gte: range.from, $lt: range.to } }).lean(),
    PosExpense.find({ status: "APPROVED", date: { $gte: range.from, $lt: range.to } }).lean(),
    PosSale.find({ createdAt: { $gte: today.from, $lt: today.to }, status: COUNTED }).select(saleFields).lean(),
    lowStock(settings.stock?.lowStockThreshold ?? 3),
    // Read-only card: online orders paid this month.
    OnlineOrder.find({ createdAt: { $gte: range.from, $lt: range.to }, paymentStatus: { $in: ["Paid", "Partially Refunded"] } })
      .select("total")
      .lean()
      .catch(() => []),
  ]);

  const month_ = summarize(sales);
  const ret = sumReturns(returns);
  const exp = sumExpenses(expenses);
  const [balances, moved] = await Promise.all([openBalances(), moneyMoved(range)]);

  const days = [];
  const byDay = new Map();
  for (const s of sales) {
    const k = istDateKey(s.createdAt);
    byDay.set(k, toRupees(toPaise(byDay.get(k) || 0) + toPaise(s.grandTotal)));
  }
  for (let d = 1; d <= range.days; d++) {
    const key = `${range.year}-${String(range.month).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    days.push({ day: d, date: key, total: byDay.get(key) || 0 });
  }

  // Profit (sale price − cost) only for users who may see cost prices.
  let profit = null;
  if (hasPermission(permissions, "products.viewCost")) {
    const fallback = await costBySku([...sales, ...todaySales]);
    const m = profitOf(sales, fallback);
    const t = profitOf(todaySales, fallback);
    // Net profit: profit on goods sold minus the shop's expenses this month.
    profit = { month: { ...m, expenses: exp.total, netProfit: toRupees(toPaise(m.profit) - toPaise(exp.total)) }, today: t };
  }

  let onlineP = 0;
  for (const o of onlineOrders) onlineP += toPaise(o.total);
  const todaySum = summarize(todaySales);
  let pendingBills = 0;
  for (const s of todaySales) if (s.status === "PENDING_VERIFICATION" || s.status === "PARTIAL") pendingBills += 1;

  return {
    range: { year: range.year, month: range.month },
    month: {
      ...month_,
      returns: ret.total,
      expenses: exp.total,
      net: toRupees(toPaise(month_.totalSales) - toPaise(ret.total) - toPaise(exp.total)),
    },
    today: { totalSales: todaySum.totalSales, bills: todaySum.bills, pendingBills, pendingAmount: todaySum.pendingAmount },
    lowStock: low.slice(0, 20),
    charts: {
      daily: days,
      paymentSplit: [
        { name: "Cash", value: month_.cash },
        { name: "Online", value: month_.online },
        { name: "Store credit", value: month_.storeCredit },
      ],
      categories: await categoryWise(sales),
      topProducts: topProducts(sales, 10),
    },
    online: { orders: onlineOrders.length, total: toRupees(onlineP) },
    profit,
    ...balances,
    collections: { dueCollected: moved.dueCollected, advancesTaken: moved.advancesTaken },
  };
}

export async function dailyReport(dateStr) {
  const day = istDayRange(dateStr);
  const [sales, cancelled, returns, expenses] = await Promise.all([
    PosSale.find({ createdAt: { $gte: day.from, $lt: day.to }, status: COUNTED }).select(saleFields).sort({ createdAt: 1 }).lean(),
    PosSale.find({ createdAt: { $gte: day.from, $lt: day.to }, status: "CANCELLED" }).select("billNo grandTotal cancelReason cancelledBy cancelCashRefund").lean(),
    PosReturn.find({ status: "PROCESSED", processedAt: { $gte: day.from, $lt: day.to } }).lean(),
    PosExpense.find({ status: { $ne: "REJECTED" }, date: { $gte: day.from, $lt: day.to } }).lean(),
  ]);

  const summary = summarize(sales);
  const ret = sumReturns(returns);
  const exp = sumExpenses(expenses.filter((e) => e.status === "APPROVED"));
  const moved = await moneyMoved(day);

  const hourly = [];
  for (let h = 0; h < 24; h++) hourly.push({ hour: `${String(h).padStart(2, "0")}:00`, total: 0, bills: 0 });
  for (const s of sales) {
    const h = istHour(s.createdAt);
    hourly[h].total = toRupees(toPaise(hourly[h].total) + toPaise(s.grandTotal));
    hourly[h].bills += 1;
  }

  const utr = [];
  for (const s of sales) {
    for (const p of s.payments) {
      if (p.mode === "ONLINE") utr.push({ billNo: s.billNo, amount: p.amount, ref: p.ref, status: p.status, verifiedBy: p.verifiedByName || "" });
    }
  }

  // Cash taken and given back during the day (no opening balance is tracked).
  let cancelCashP = 0;
  for (const c of cancelled) cancelCashP += toPaise(c.cancelCashRefund || 0);
  // Dues collected and advances taken add to the drawer; bill-edit and advance refunds leave it.
  const movedInP = toPaise(moved.cashIn);
  const movedOutP = toPaise(moved.cashOut);
  const cash = {
    cashIn: toRupees(toPaise(summary.cash) + movedInP),
    cashReturned: toRupees(toPaise(ret.cash) + cancelCashP + movedOutP),
    cashExpenses: exp.cash,
    netCash: toRupees(toPaise(summary.cash) + movedInP - toPaise(ret.cash) - cancelCashP - movedOutP - toPaise(exp.cash)),
    fromDues: moved.dueCollected.CASH || 0,
    fromAdvances: moved.advancesTaken.CASH || 0,
  };

  return {
    date: day.label,
    summary: {
      ...summary,
      returns: ret.total,
      cashRefunds: ret.cash,
      expenses: exp.total,
      cashExpenses: exp.cash,
      net: toRupees(toPaise(summary.totalSales) - toPaise(ret.total) - toPaise(exp.total)),
      cancelledBills: cancelled.length,
    },
    hourly: hourly.filter((h) => h.bills > 0 || (h.hour >= "09:00" && h.hour <= "22:00")),
    bills: sales.map((s) => ({
      billNo: s.billNo,
      time: s.createdAt,
      customer: s.customerSnapshot?.name,
      amount: s.grandTotal,
      modes: [...new Set(s.payments.map((p) => p.mode))].join(" + "),
      status: s.status,
      staff: s.soldByName,
    })),
    cancelled,
    utr,
    topProducts: topProducts(sales, 10),
    returns: returns.map((r) => ({ returnNo: r.returnNo, billNo: r.billNo, amount: r.refundAmount, mode: r.refundMode, by: r.requestedByName })),
    expenses: expenses.map((e) => ({ title: e.title, category: e.category, amount: e.amount, paidVia: e.paidVia, status: e.status, by: e.addedByName })),
    cash,
    staff: staffWise(sales),
    moneyMoved: moved,
  };
}

export async function monthlyReport(year, month) {
  const range = istMonthRange(year, month);
  const [sales, returns, expenses] = await Promise.all([
    PosSale.find({ createdAt: { $gte: range.from, $lt: range.to }, status: COUNTED }).select(saleFields).lean(),
    PosReturn.find({ status: "PROCESSED", processedAt: { $gte: range.from, $lt: range.to } }).lean(),
    PosExpense.find({ status: "APPROVED", date: { $gte: range.from, $lt: range.to } }).lean(),
  ]);
  const summary = summarize(sales);
  const ret = sumReturns(returns);
  const exp = sumExpenses(expenses);

  const byDay = new Map();
  for (const s of sales) {
    const k = istDateKey(s.createdAt);
    byDay.set(k, toRupees(toPaise(byDay.get(k) || 0) + toPaise(s.grandTotal)));
  }
  const daily = [];
  for (let d = 1; d <= range.days; d++) {
    const key = `${range.year}-${String(range.month).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    daily.push({ day: d, total: byDay.get(key) || 0 });
  }

  // Top customers and new vs repeat (first-ever bill in this month = new).
  const custMap = new Map();
  for (const s of sales) {
    if (!s.customer) continue;
    const k = String(s.customer);
    const row = custMap.get(k) || { name: s.customerSnapshot?.name, phone: s.customerSnapshot?.phone, bills: 0, total: 0 };
    row.bills += 1;
    row.total = toRupees(toPaise(row.total) + toPaise(s.grandTotal));
    custMap.set(k, row);
  }
  const custIds = [...custMap.keys()];
  const earlier = await PosSale.distinct("customer", { customer: { $in: custIds }, createdAt: { $lt: range.from }, status: COUNTED });
  const earlierSet = new Set(earlier.map(String));
  let repeat = 0;
  for (const id of custIds) if (earlierSet.has(id)) repeat += 1;

  return {
    range: { year: range.year, month: range.month },
    summary: {
      ...summary,
      returns: ret.total,
      expenses: exp.total,
      net: toRupees(toPaise(summary.totalSales) - toPaise(ret.total) - toPaise(exp.total)),
    },
    daily,
    categories: await categoryWise(sales),
    topProducts: topProducts(sales, 10),
    topCustomers: [...custMap.values()].sort((a, b) => b.total - a.total).slice(0, 10),
    customers: { total: custIds.length, new: custIds.length - repeat, repeat, walkInBills: sales.filter((s) => !s.customer).length },
    staff: staffWise(sales),
  };
}

/**
 * Stock left right now: pieces and their value for every size of every active
 * product, and the totals. Value at selling price (what the shop gets), at MRP,
 * and at cost (cost only for users who may see it; sizes without a cost are
 * counted separately so the cost total is never silently short).
 */
export async function stockReport(permissions) {
  const showCost = hasPermission(permissions, "products.viewCost");
  const [products, links, cats, settings] = await Promise.all([
    OnlineProduct.find({ isActive: { $ne: false } }).select("name productId categories price originalPrice stock variants sizes").lean(),
    PosProductLink.find().select("sku productId variantKey costPrice isActive").lean(),
    OnlineCategory.find().select("slug label parent").lean(),
    getSettings(),
  ]);
  const low = Number(settings.stock?.lowStockThreshold ?? 3);
  const linkOf = new Map(links.map((l) => [`${l.productId}:${l.variantKey ?? ""}`, l]));
  const catBySlug = new Map(cats.map((c) => [c.slug, c]));

  const totals = { pieces: 0, valueP: 0, mrpValueP: 0, costValueP: 0, piecesWithoutCost: 0, sizes: 0, outOfStock: 0, lowStock: 0, products: 0 };
  const items = [];
  for (const p of products) {
    const own = (p.categories || []).map((slug) => catBySlug.get(slug)).filter((c) => c && c.slug !== "new-arrivals");
    const category = (own.find((c) => c.parent) || own[0])?.label || "";
    const sizes = [];
    const t = { pieces: 0, valueP: 0, mrpValueP: 0, costValueP: 0 };
    for (const key of variantKeysOf(p)) {
      const link = linkOf.get(`${p._id}:${key ?? ""}`);
      const qty = availableQty(p, key);
      const { price, mrp } = priceFor(p, key);
      const cost = link?.costPrice ?? null;
      const row = (p.variants || []).find((v) => keyOf(v) === key);
      const valueP = toPaise(price) * qty;
      const mrpValueP = toPaise(mrp) * qty;
      const costValueP = cost != null ? toPaise(cost) * qty : 0;
      sizes.push({
        size: row?.size || key || "Free size",
        sku: link?.sku || null,
        stock: qty,
        price,
        mrp,
        ...(showCost && { cost, costValue: cost != null ? toRupees(costValueP) : null }),
        value: toRupees(valueP),
        mrpValue: toRupees(mrpValueP),
      });
      t.pieces += qty;
      t.valueP += valueP;
      t.mrpValueP += mrpValueP;
      t.costValueP += costValueP;
      totals.sizes += 1;
      if (qty <= 0) totals.outOfStock += 1;
      else if (qty <= low) totals.lowStock += 1;
      if (cost == null) totals.piecesWithoutCost += qty;
    }
    totals.pieces += t.pieces;
    totals.valueP += t.valueP;
    totals.mrpValueP += t.mrpValueP;
    totals.costValueP += t.costValueP;
    totals.products += 1;
    items.push({
      id: String(p._id),
      name: p.name,
      code: p.productId,
      category,
      pieces: t.pieces,
      value: toRupees(t.valueP),
      mrpValue: toRupees(t.mrpValueP),
      ...(showCost && { costValue: toRupees(t.costValueP) }),
      sizes,
    });
  }
  items.sort((a, b) => b.value - a.value || a.name.localeCompare(b.name));
  return {
    at: new Date(),
    lowStockThreshold: low,
    totals: {
      products: totals.products,
      sizes: totals.sizes,
      pieces: totals.pieces,
      value: toRupees(totals.valueP),
      mrpValue: toRupees(totals.mrpValueP),
      ...(showCost && { costValue: toRupees(totals.costValueP), piecesWithoutCost: totals.piecesWithoutCost }),
      outOfStock: totals.outOfStock,
      lowStock: totals.lowStock,
    },
    items,
  };
}
