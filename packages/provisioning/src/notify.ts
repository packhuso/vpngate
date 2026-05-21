// In-app notifications — single INSERT into the `notifications` table. Accepts
// an optional tx so the write joins the surrounding billing transaction
// atomically (no notification without the state change that triggered it).
import { sql } from "@vpnhub/db";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Tx = any;

export type NotifySeverity = "info" | "warning" | "error";

export interface NotifyInput {
  type: string; // e.g. billing.suspended, billing.cancelled, wallet.low
  title: string;
  body?: string;
  severity?: NotifySeverity;
  metadata?: Record<string, unknown>;
}

/** Insert one notification for a user. Pass `tx` to run inside an open
 *  transaction; omit to run standalone. */
export async function notify(
  exec: Tx,
  userId: string,
  n: NotifyInput,
): Promise<void> {
  const q = exec ?? sql;
  await q`
    INSERT INTO notifications (user_id, type, title, body, severity, metadata)
    VALUES (${userId}, ${n.type}, ${n.title}, ${n.body ?? null},
      ${n.severity ?? "info"}, ${JSON.stringify(n.metadata ?? {})}::jsonb)`;
}
