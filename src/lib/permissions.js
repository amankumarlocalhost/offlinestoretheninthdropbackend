// Every permission key the POS knows about. Routes check these keys, never
// role names, so a future role (e.g. MANAGER) only needs a new default set.
export const ALL_PERMISSIONS = [
  "dashboard.view",
  "reports.view",
  "reports.export",
  "products.view",
  "products.edit",
  "products.viewCost",
  "products.viewStock",
  "stock.adjust",
  "categories.manage",
  "catalog.manage",
  "customers.create",
  "customers.view",
  "customers.viewSpend",
  "customers.edit",
  "customers.editPhone",
  "customers.export",
  "sales.create",
  "sales.viewOwn",
  "sales.viewAll",
  "sales.cancelDirect",
  "sales.discount",
  "sales.discountUnlimited",
  "payments.markCash",
  "payments.verifyOnline",
  "payments.viewSummary",
  "receipts.print",
  "receipts.reprint",
  "returns.request",
  "returns.approve",
  "expenses.create",
  "expenses.viewAll",
  "users.manage",
  "settings.manage",
  "auditLogs.view",
];

export const ROLE_PERMISSIONS = {
  SUPER_ADMIN: ["*"],
  OPERATOR: [
    "products.view",
    "customers.create",
    "customers.view",
    "customers.edit",
    "sales.create",
    "sales.viewOwn",
    "sales.discount",
    "payments.markCash",
    "payments.verifyOnline",
    "receipts.print",
    "receipts.reprint",
    "returns.request",
    "expenses.create",
  ],
};

// role defaults − revokedPermissions + extraPermissions
export function getUserPermissions(user) {
  const defaults = ROLE_PERMISSIONS[user.role] || [];
  const revoked = user.revokedPermissions || [];
  const extra = user.extraPermissions || [];

  let base = [];
  if (defaults.includes("*")) {
    // "*" expands to everything so individual keys can still be revoked.
    for (const key of ALL_PERMISSIONS) base.push(key);
  } else {
    for (const key of defaults) base.push(key);
  }

  const result = [];
  for (const key of base) {
    if (!revoked.includes(key)) result.push(key);
  }
  for (const key of extra) {
    if (ALL_PERMISSIONS.includes(key) && !result.includes(key)) result.push(key);
  }
  return result;
}

export function hasPermission(permissions, key) {
  if (!permissions) return false;
  for (const p of permissions) {
    if (p === key) return true;
  }
  return false;
}
