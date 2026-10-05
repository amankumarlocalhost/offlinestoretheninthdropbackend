import { PosCounter } from "./models.js";
import { yymm } from "./time.js";

// Atomic: two operators billing at the same moment always get different
// numbers, and a number is never reused (cancelled bills keep theirs).
async function next(key, session) {
  const doc = await PosCounter.findOneAndUpdate(
    { _id: key },
    { $inc: { seq: 1 } },
    { upsert: true, new: true, session }
  );
  return doc.seq;
}

export async function nextBillNo(session) {
  const ym = yymm();
  const seq = await next(`bill:${ym}`, session);
  return `TND-${ym}-${String(seq).padStart(4, "0")}`;
}

export async function nextReturnNo(session) {
  const ym = yymm();
  const seq = await next(`return:${ym}`, session);
  return `TND-RT-${ym}-${String(seq).padStart(4, "0")}`;
}

export async function nextProductNo() {
  return next("sku-product-no", null);
}
