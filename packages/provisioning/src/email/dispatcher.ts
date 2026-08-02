// Drain email_events: send each pending instant row as its own email; group
// pending digest rows per user and send one combined email. Marks sent_at on
// success. On transient failure, bumps retry_count with capped exponential
// backoff via scheduled_for. Permanent failure (4xx from Resend) marks
// sent_at with last_error set — visible in the DB but never retried.
import { sql } from "@vpnhub/db";
import { sendEmail, isTransientEmailError, EmailSendError } from "./resend-client";

const MAX_RETRIES = 5;
const BATCH_SIZE = 100;

export interface DispatchResult {
  processed: number;
  sent: number;
  failed: number;
  dryRun: boolean;
  errors: string[];
}

function isDryRun(): boolean {
  const v = process.env.EMAIL_ENABLED;
  return v === undefined || v === "" || v === "false" || v === "0";
}

interface PendingRow {
  id: string;
  user_id: string;
  action: string;
  category: "instant" | "digest";
  scheduled_for: Date;
  retry_count: number;
  payload: Record<string, unknown>;
  email: string;
  name: string | null;
}

export async function dispatchEmailEvents(): Promise<DispatchResult> {
  const dryRun = isDryRun();
  const res: DispatchResult = { processed: 0, sent: 0, failed: 0, dryRun, errors: [] };

  // Pull pending rows joined with the user's email. Recipient is captured
  // fresh each dispatch tick — no stale addresses.
  const rows = await sql<PendingRow[]>`
    SELECT e.id::text, e.user_id::text, e.action, e.category,
           e.scheduled_for, e.retry_count, e.payload, u.email, u.name
    FROM email_events e
    JOIN users u ON u.id = e.user_id
    WHERE e.sent_at IS NULL
      AND e.scheduled_for <= NOW()
      AND e.retry_count < ${MAX_RETRIES}
    ORDER BY e.scheduled_for ASC
    LIMIT ${BATCH_SIZE}`;
  if (rows.length === 0) return res;
  res.processed = rows.length;

  // Group digest rows by user; instant rows are sent individually so a big
  // buy-then-immediately-delete sequence produces two separate emails.
  const instants = rows.filter((r) => r.category === "instant");
  const digests = rows.filter((r) => r.category === "digest");
  const byUser = new Map<string, PendingRow[]>();
  for (const r of digests) {
    if (!byUser.has(r.user_id)) byUser.set(r.user_id, []);
    byUser.get(r.user_id)!.push(r);
  }

  for (const r of instants) {
    await sendOne(r, [r], "instant", dryRun, res);
  }
  for (const [_userId, items] of byUser) {
    // Combined email per user; mark each event sent atomically after the
    // single Resend call succeeds.
    await sendOne(items[0], items, "digest", dryRun, res);
  }

  return res;
}

async function sendOne(
  target: PendingRow,
  events: PendingRow[],
  kind: "instant" | "digest",
  dryRun: boolean,
  res: DispatchResult,
) {
  const { subject, text, html } = renderEmail(target, events, kind);
  const ids = events.map((e) => e.id);
  try {
    if (dryRun) {
      console.log(`[email:dry-run] to=${target.email} subject="${subject}" events=${ids.length}`);
    } else {
      await sendEmail({ to: target.email, subject, text, html });
    }
    await sql`UPDATE email_events SET sent_at = NOW(), last_error = NULL
              WHERE id = ANY(${ids}::uuid[])`;
    res.sent += events.length;
  } catch (e) {
    const msg = (e as Error).message.slice(0, 500);
    const transient = isTransientEmailError(e);
    if (transient && events[0].retry_count + 1 < MAX_RETRIES) {
      // Exponential backoff: 1m, 2m, 4m, 8m, 16m capped.
      const delayMin = Math.min(1 << events[0].retry_count, 16);
      await sql`UPDATE email_events
                SET retry_count = retry_count + 1,
                    scheduled_for = NOW() + (${delayMin}::text || ' minutes')::interval,
                    last_error = ${msg}
                WHERE id = ANY(${ids}::uuid[])`;
    } else {
      // Permanent (4xx) or exhausted retries: park with sent_at so we stop.
      await sql`UPDATE email_events
                SET sent_at = NOW(), last_error = ${msg}
                WHERE id = ANY(${ids}::uuid[])`;
    }
    res.failed += events.length;
    res.errors.push(`${target.email}: ${msg}`);
    if (e instanceof EmailSendError && e.status === 0) {
      // Config missing — no point trying more rows this tick.
      throw e;
    }
  }
}

// --- rendering ---
// Kept intentionally plain-text-first; HTML is a lightly-wrapped version so
// mail clients that hide plain text still get something readable. Body copy
// is bilingual (Thai first) since operator + customers both use the portal.

interface Rendered { subject: string; text: string; html: string }

function renderEmail(
  user: PendingRow,
  events: PendingRow[],
  kind: "instant" | "digest",
): Rendered {
  const lines = events.map((e) => `• ${formatAction(e)}`);
  const heading =
    kind === "instant"
      ? `กิจกรรมสำคัญในบัญชี VPN Hub · ${formatAction(events[0])}`
      : `สรุปกิจกรรม VPN Hub (${events.length} รายการ)`;
  const text = [
    `สวัสดีครับ ${user.name ?? ""}`.trim(),
    "",
    heading,
    "",
    ...lines,
    "",
    `ดูรายละเอียดที่ https://portal.myip.in.th/dashboard`,
    ``,
    `หากไม่ได้ทำรายการเหล่านี้ กรุณาเปลี่ยนรหัสผ่านและติดต่อทีมทันที`,
  ].join("\n");
  const html = `<div style="font-family:system-ui,Arial,sans-serif;font-size:14px;line-height:1.5;color:#0f172a">
<p>สวัสดีครับ ${escapeHtml(user.name ?? "")}</p>
<p><strong>${escapeHtml(heading)}</strong></p>
<ul>${events.map((e) => `<li>${escapeHtml(formatAction(e))}</li>`).join("")}</ul>
<p><a href="https://portal.myip.in.th/dashboard">เปิด Dashboard</a></p>
<p style="color:#64748b;font-size:12px">หากไม่ได้ทำรายการเหล่านี้ กรุณาเปลี่ยนรหัสผ่านและติดต่อทีมทันที</p>
</div>`;
  return { subject: heading, text, html };
}

function formatAction(e: PendingRow): string {
  const md = (e.payload?.metadata ?? {}) as Record<string, unknown>;
  const at = e.payload?.audit_created_at as string | undefined;
  const t = at ? new Date(at).toLocaleString("en-GB", { timeZone: "Asia/Bangkok" }) : "";
  const detail = actionLabel(e.action, md);
  return t ? `${t} — ${detail}` : detail;
}

function actionLabel(action: string, md: Record<string, unknown>): string {
  const s = (v: unknown) => (v == null ? "" : String(v));
  switch (action) {
    case "code.redeem":         return `แลกโค้ด: +฿${satang(md.satang_added)}`;
    case "ip.buy":              return `ซื้อ Public IP: ${s(md.ip)}`;
    case "ipblock.buy":         return `ซื้อ IP block: ${s(md.block)}`;
    case "ip.release":          return `คืน IP: ${s(md.ip)}`;
    case "ipblock.release":     return `คืน IP block: ${s(md.block)}`;
    case "tunnel.delete":       return `ลบ tunnel: ${s(md.name ?? md.tunnelName ?? md.tunnelId)}`;
    case "tunnel.tier_change":  return `เปลี่ยน tier: ${s(md.from)} → ${s(md.to)} ฿${satang(md.charged_satang)}`;
    case "ip.assign":           return `ผูก IP ${s(md.ip)} เข้า tunnel ${s(md.to ?? md.tunnelId)}`;
    case "ip.unassign":         return `ปลด IP ${s(md.ip)} จาก tunnel ${s(md.from ?? md.tunnelId)}`;
    case "ipblock.assign":      return `ผูก block ${s(md.blockId ?? md.block)} เข้า tunnel`;
    case "ipblock.unassign":    return `ปลด block ${s(md.blockId ?? md.block)} จาก tunnel`;
    case "wallet.adjust":       return `แอดมินปรับ wallet: ${md.delta_satang && Number(md.delta_satang) > 0 ? "+" : ""}฿${satang(md.delta_satang)}${md.reason ? ` (${s(md.reason)})` : ""}`;
    case "ip.admin_grant":      return `แอดมิน grant IP: ${s(md.ip)}`;
    case "ipblock.admin_grant": return `แอดมิน grant IP block: ${s(md.block)}`;
    case "billing.suspend":     return `Tunnel ถูกระงับเนื่องจากยอดคงเหลือไม่พอ`;
    case "billing.cancel":      return `Tunnel ถูกยกเลิกอัตโนมัติ`;
    default:                    return action;
  }
}

function satang(v: unknown): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return "0.00";
  return (n / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}
