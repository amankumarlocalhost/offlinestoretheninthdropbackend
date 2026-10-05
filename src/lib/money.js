// All money maths is done in whole paise (integers) to avoid floating point
// drift, then converted back to rupees with two decimals for storage.
export function toPaise(rupees) {
  return Math.round(Number(rupees || 0) * 100);
}
export function toRupees(paise) {
  return Math.round(paise) / 100;
}

/**
 * For each line: lineTotal = price × qty − its share of the bill discount.
 * The bill total is rounded to the nearest rupee with a round-off line.
 *
 * lines: [{ price, qty }]  (rupees)
 * discount: bill-level discount in rupees
 */
export function calculateBill(lines, discount) {
  const gross = [];
  let subTotalP = 0;
  for (let i = 0; i < lines.length; i++) {
    const g = toPaise(lines[i].price) * lines[i].qty;
    gross.push(g);
    subTotalP += g;
  }

  let discountP = toPaise(discount);
  if (discountP < 0) discountP = 0;
  if (discountP > subTotalP) discountP = subTotalP;

  // Spread the bill discount over lines in proportion to their value. Any
  // paise left over by rounding go to the biggest line.
  const shares = [];
  let given = 0;
  let biggest = 0;
  for (let i = 0; i < lines.length; i++) {
    const share = subTotalP > 0 ? Math.floor((discountP * gross[i]) / subTotalP) : 0;
    shares.push(share);
    given += share;
    if (gross[i] > gross[biggest]) biggest = i;
  }
  if (lines.length) shares[biggest] += discountP - given;

  const out = [];
  let totalP = 0;
  for (let i = 0; i < lines.length; i++) {
    const lineTotal = gross[i] - shares[i];
    totalP += lineTotal;
    out.push({ lineGross: toRupees(gross[i]), discount: toRupees(shares[i]), lineTotal: toRupees(lineTotal) });
  }

  const grandP = Math.round(totalP / 100) * 100;
  return {
    lines: out,
    subTotal: toRupees(subTotalP),
    discount: toRupees(discountP),
    roundOff: toRupees(grandP - totalP),
    grandTotal: toRupees(grandP),
  };
}

// Same rule as the spec: PAID only when received payments equal the total.
export function getBillStatus(sale) {
  let receivedP = 0;
  let hasPending = false;
  for (let i = 0; i < sale.payments.length; i++) {
    const p = sale.payments[i];
    if (p.status === "RECEIVED") receivedP += toPaise(p.amount);
    if (p.status === "PENDING") hasPending = true;
  }
  const totalP = toPaise(sale.grandTotal);
  if (receivedP === totalP) return "PAID";
  if (hasPending) return "PENDING_VERIFICATION";
  if (receivedP > 0) return "PARTIAL";
  return "PENDING";
}

const ONES = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];

function twoDigits(n) {
  if (n < 20) return ONES[n];
  return (TENS[Math.floor(n / 10)] + " " + ONES[n % 10]).trim();
}
function threeDigits(n) {
  const h = Math.floor(n / 100);
  const rest = n % 100;
  let s = h ? ONES[h] + " Hundred" : "";
  if (rest) s += (s ? " " : "") + twoDigits(rest);
  return s;
}

// Indian numbering: crore, lakh, thousand. e.g. 12345 → "Twelve Thousand Three Hundred Forty Five"
export function amountInWords(rupees) {
  let n = Math.floor(Math.abs(Number(rupees) || 0));
  const paise = Math.round((Math.abs(Number(rupees) || 0) - n) * 100);
  if (n === 0 && paise === 0) return "Rupees Zero Only";
  const parts = [];
  const crore = Math.floor(n / 10000000);
  n %= 10000000;
  const lakh = Math.floor(n / 100000);
  n %= 100000;
  const thousand = Math.floor(n / 1000);
  n %= 1000;
  if (crore) parts.push(threeDigits(crore) + " Crore");
  if (lakh) parts.push(twoDigits(lakh) + " Lakh");
  if (thousand) parts.push(twoDigits(thousand) + " Thousand");
  if (n) parts.push(threeDigits(n));
  let words = "Rupees " + (parts.join(" ") || "Zero");
  if (paise) words += " and " + twoDigits(paise) + " Paise";
  return words + " Only";
}
