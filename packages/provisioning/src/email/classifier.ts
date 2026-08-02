// Decide how to notify a user about a single audit event.
// 'instant' → send email now (money movement, destructive ops, security).
// 'digest'  → include in the user's next batched digest (routine ops).
// 'skip'    → do not email (system reconciliation noise, admin-only ops).
export type EmailCategory = "instant" | "digest" | "skip";

// Actions the user takes on their own account get one of the three categories.
// Everything not listed defaults to 'digest' — a new user-facing action added
// later will still land in the customer's activity email until we explicitly
// mark it otherwise.
const USER_ACTIONS: Record<string, EmailCategory> = {
  "code.redeem":       "instant",  // money in via redemption
  "ip.buy":            "instant",  // spent money
  "ipblock.buy":       "instant",
  "ip.release":        "instant",  // destructive, no refund
  "ipblock.release":   "instant",
  "tunnel.delete":     "instant",  // destructive, no refund
  "tunnel.tier_change":"instant",  // full charge new tier
  "ip.assign":         "digest",   // routine plumbing
  "ip.unassign":       "digest",
  "ipblock.assign":    "digest",
  "ipblock.unassign":  "digest",
};

// Admin actions targeting a specific user (grant credit / IPs). MUST have
// a target user resolvable from the metadata payload; otherwise we skip.
const ADMIN_TO_USER_ACTIONS: Record<string, EmailCategory> = {
  "ip.admin_grant":     "instant",
  "ipblock.admin_grant":"instant",
  "wallet.adjust":      "instant",
};

// System-driven state changes the user needs to know about. Everything else
// system does (drift, reconcile, orphans) is noise and stays out of email.
const SYSTEM_USER_FACING_ACTIONS: Record<string, EmailCategory> = {
  "billing.suspend": "instant",
  "billing.cancel":  "instant",
};

export interface AuditRow {
  actor_type: "user" | "admin" | "system";
  actor_id: string | null;
  action: string;
  resource_type: string | null;
  resource_id: string | null;
  metadata: unknown;
}

/** Return the email category + the user_id to notify, or null to skip. */
export function classifyAudit(
  row: AuditRow,
): { userId: string; category: Exclude<EmailCategory, "skip"> } | null {
  if (row.actor_type === "user" && row.actor_id) {
    const cat = USER_ACTIONS[row.action];
    if (!cat || cat === "skip") return cat === "skip" ? null : { userId: row.actor_id, category: "digest" };
    return { userId: row.actor_id, category: cat };
  }
  if (row.actor_type === "admin") {
    const cat = ADMIN_TO_USER_ACTIONS[row.action];
    if (!cat) return null;
    const target = extractTargetUser(row);
    if (!target) return null;
    return { userId: target, category: cat as Exclude<EmailCategory, "skip"> };
  }
  if (row.actor_type === "system") {
    const cat = SYSTEM_USER_FACING_ACTIONS[row.action];
    if (!cat) return null;
    // System events attach the target user in metadata.userId or via
    // resource_id → tunnels/users lookup. MVP: only metadata.userId.
    const target = extractTargetUser(row);
    if (!target) return null;
    return { userId: target, category: cat as Exclude<EmailCategory, "skip"> };
  }
  return null;
}

function extractTargetUser(row: AuditRow): string | null {
  const md = (row.metadata ?? {}) as Record<string, unknown>;
  const candidates = [md.userId, md.user_id, md.targetUserId, md.target_user_id];
  for (const c of candidates) {
    if (typeof c === "string" && /^[0-9a-f-]{36}$/i.test(c)) return c;
  }
  return null;
}
