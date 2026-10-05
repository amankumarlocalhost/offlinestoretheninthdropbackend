import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";

dayjs.extend(utc);
dayjs.extend(timezone);

// The database stores UTC. Every "day" and "month" in the POS is an
// Asia/Kolkata day or month, so a bill at 11:59 PM IST lands on the right date.
export const TZ = "Asia/Kolkata";

export function nowIst() {
  return dayjs().tz(TZ);
}

// "2026-10-04" → { from, to } as UTC Date objects covering that IST day.
export function istDayRange(dateStr) {
  const start = dateStr ? dayjs.tz(dateStr, "YYYY-MM-DD", TZ) : nowIst().startOf("day");
  if (!start.isValid()) throw new Error("Invalid date");
  const from = start.startOf("day");
  return { from: from.toDate(), to: from.add(1, "day").toDate(), label: from.format("YYYY-MM-DD") };
}

export function istMonthRange(year, month) {
  const now = nowIst();
  const y = Number(year) || now.year();
  const m = Number(month) || now.month() + 1;
  const from = dayjs.tz(`${y}-${String(m).padStart(2, "0")}-01`, "YYYY-MM-DD", TZ).startOf("month");
  return { from: from.toDate(), to: from.add(1, "month").toDate(), year: y, month: m, days: from.daysInMonth() };
}

// IST calendar date key of a UTC date, e.g. for grouping a month by day.
export function istDateKey(date) {
  return dayjs(date).tz(TZ).format("YYYY-MM-DD");
}

export function istHour(date) {
  return dayjs(date).tz(TZ).hour();
}

export function yymm(date = new Date()) {
  return dayjs(date).tz(TZ).format("YYMM");
}

// "HH:mm" string compare in IST — used for the optional store-hours login rule.
export function isWithinHours(openTime, closeTime) {
  const t = nowIst().format("HH:mm");
  if (openTime <= closeTime) return t >= openTime && t < closeTime;
  return t >= openTime || t < closeTime; // overnight hours
}
