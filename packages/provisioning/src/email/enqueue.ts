// Scan audit_logs since the last checkpoint, classify each row, insert
// email_events. Idempotent: unique index on audit_log_id prevents duplicates
// if the checkpoint isn't advanced in time. Checkpoint is bumped to the
// latest scanned row's created_at, so a mid-scan crash re-processes at most
// the last window on next run.
import { sql } from "@vpnhub/db";
import { classifyAudit, type AuditRow } from "./classifier";

const DIGEST_INTERVAL_MIN_DEFAULT = 15;

export interface EnqueueResult {
  scanned: number;
  enqueued: number;
  skipped: number;
}

export async function enqueueEmailEvents(): Promise<EnqueueResult> {
  const res: EnqueueResult = { scanned: 0, enqueued: 0, skipped: 0 };

  // postgres.js returns timestamptz as ISO string; keep as string throughout.
  const [chk] = await sql<{ last_scanned: string }[]>`
    SELECT last_scanned::text AS last_scanned FROM email_scan_state WHERE id = 1`;
  const since = chk?.last_scanned ?? "1970-01-01T00:00:00Z";

  const rows = await sql<(AuditRow & { id: string; created_at: string })[]>`
    SELECT id::text, actor_type, actor_id::text, action,
           resource_type, resource_id::text, metadata,
           created_at::text AS created_at
    FROM audit_logs
    WHERE created_at > ${since}::timestamptz
    ORDER BY created_at ASC
    LIMIT 500`;
  res.scanned = rows.length;
  if (rows.length === 0) return res;

  const nextInterval = new Map<string, number>();
  async function getIntervalMin(userId: string): Promise<number> {
    if (nextInterval.has(userId)) return nextInterval.get(userId)!;
    const [pref] = await sql<{ enabled: boolean; digest_interval_min: number }[]>`
      SELECT enabled, digest_interval_min FROM user_email_prefs
      WHERE user_id = ${userId}`;
    if (pref && !pref.enabled) {
      nextInterval.set(userId, -1); // sentinel: disabled
      return -1;
    }
    const v = pref?.digest_interval_min ?? DIGEST_INTERVAL_MIN_DEFAULT;
    nextInterval.set(userId, v);
    return v;
  }

  for (const r of rows) {
    const c = classifyAudit(r);
    if (!c) { res.skipped++; continue; }
    const interval = await getIntervalMin(c.userId);
    if (interval < 0) { res.skipped++; continue; }
    const scheduledFor =
      c.category === "instant"
        ? new Date()
        : nextDigestBoundary(new Date(), interval);
    try {
      await sql`
        INSERT INTO email_events
          (user_id, audit_log_id, action, category, scheduled_for, payload)
        VALUES
          (${c.userId}, ${r.id}, ${r.action}, ${c.category},
           ${scheduledFor.toISOString()},
           ${JSON.stringify({
             resource_type: r.resource_type,
             resource_id: r.resource_id,
             metadata: r.metadata ?? {},
             audit_created_at: r.created_at,
           })}::jsonb)`;
      res.enqueued++;
    } catch (e) {
      // Unique-index conflict on audit_log_id → we already enqueued this. Fine.
      if (!/duplicate key/i.test((e as Error).message)) throw e;
    }
  }

  const last = rows[rows.length - 1].created_at;
  await sql`
    UPDATE email_scan_state SET last_scanned = ${last}::timestamptz,
      updated_at = NOW() WHERE id = 1`;
  return res;
}

// Round up to the next digest boundary — so N users sharing the same interval
// see one email per interval, not one email per action.
function nextDigestBoundary(now: Date, intervalMin: number): Date {
  const ms = intervalMin * 60_000;
  return new Date(Math.ceil(now.getTime() / ms) * ms);
}
