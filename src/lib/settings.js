import { PosSettings } from "./models.js";

// The single settings document. Created with defaults the first time.
export async function getSettings({ withPin = false, session } = {}) {
  let query = PosSettings.findOneAndUpdate(
    { key: "store" },
    { $setOnInsert: { key: "store" } },
    { upsert: true, new: true, setDefaultsOnInsert: true, session }
  );
  if (withPin) query = query.select("+limits.adminPinHash");
  return query;
}

// What goes on an invoice. Copied into every sale so later changes to the
// settings never alter old bills.
export function storeSnapshot(settings) {
  const s = settings.store || {};
  const inv = settings.invoice || {};
  return {
    name: s.name,
    logo: s.logo,
    address: s.address,
    phone: s.phone,
    email: s.email,
    website: s.website,
    instagram: s.instagram,
    policyText: inv.policyText,
    footerText: inv.footerText,
  };
}
