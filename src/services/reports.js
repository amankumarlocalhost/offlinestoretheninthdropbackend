import { PosSale, PosReturn, PosExpense, OnlineProduct, OnlineOrder } from "../lib/models.js";
import { istDayRange, istMonthRange, istDateKey, istHour } from "../lib/time.js";
import { toPaise, toRupees } from "../lib/money.js";
import { getSettings } from "../lib/settings.js";
import { lowStock } from "./products.js";

const COUNTED = { $nin: ["CANCELLED"] };

// Totals over a list of sales. Money is summed in paise.
function summarize(sales) {
  let totalP = 0;
  let cashP = 0;
  let onlineP = 0;
  let creditP = 0;
  let pendingP = 0;
  let discountP = 0;
  let items = 0;
  let splitBills = 0;
  for (const s of sales) {
    totalP += toPaise(s.grandTotal);
    discountP += toPaise(s.discount);
    for (const it of s.items) items += it.qty;
    const modes = new Set();
    for (const p of s.payments) {
      modes.add(p.mode);
      if (p.status === "PENDING") pendingP += toPaise(p.amount);
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
  };
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

const saleFields = "billNo createdAt customer customerSnapshot items payments grandTotal discount status soldByName";

export async function dashboard(year, month) {
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
  const cash = {
    cashIn: summary.cash,
    cashReturned: toRupees(toPaise(ret.cash) + cancelCashP),
    cashExpenses: exp.cash,
    netCash: toRupees(toPaise(summary.cash) - toPaise(ret.cash) - cancelCashP - toPaise(exp.cash)),
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
