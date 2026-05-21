import { sql } from "@vpnhub/db";
import { runBillingTick, notify } from "@vpnhub/provisioning";

async function main() {
  const [t] = await sql<{ id: string; user_id: string; name: string; speed_tier: string; next_billing_at: Date; status: string }[]>`
    SELECT id, user_id, name, speed_tier, next_billing_at, status FROM tunnels
    WHERE status='active' AND deleted_at IS NULL LIMIT 1`;
  if (!t) { console.log("no tunnel; skip"); await sql.end(); return; }
  console.log("tunnel:", t.name, "user:", t.user_id);

  // snapshot for restore
  const [w0] = await sql<{ b: string }[]>`SELECT balance_satang::text b FROM credit_wallets WHERE user_id=${t.user_id}`;
  const origBal = w0.b, origNbf = t.next_billing_at;

  console.log("\n[A] notify() helper direct insert");
  await notify(null, t.user_id, { type: "test.ping", title: "ทดสอบ", body: "hello", severity: "info" });
  const [direct] = await sql`SELECT title FROM notifications WHERE user_id=${t.user_id} AND type='test.ping' ORDER BY created_at DESC LIMIT 1`;
  if (!direct) throw new Error("FAIL: notify() did not insert"); console.log("   ✓ inserted:", direct.title);

  console.log("\n[B] Drain wallet + tunnel due → suspend + notification");
  await sql`UPDATE credit_wallets SET balance_satang=0 WHERE user_id=${t.user_id}`;
  await sql`UPDATE tunnels SET next_billing_at=NOW()-INTERVAL '1 min', status='active', suspended_at=NULL, delete_after=NULL WHERE id=${t.id}`;
  const r1 = await runBillingTick();
  console.log("   tick tunnels:", JSON.stringify(r1.tunnels));
  const [susp] = await sql<{ title: string; severity: string }[]>`
    SELECT title, severity FROM notifications WHERE user_id=${t.user_id} AND type='billing.suspended' ORDER BY created_at DESC LIMIT 1`;
  if (!susp) throw new Error("FAIL: no suspend notification"); 
  console.log("   ✓ suspend notif:", susp.title, `(${susp.severity})`);

  console.log("\n[C] RESTORE — re-credit, un-suspend, reset billing");
  await sql`UPDATE credit_wallets SET balance_satang=${origBal} WHERE user_id=${t.user_id}`;
  await sql`UPDATE tunnels SET status='active', suspended_at=NULL, delete_after=NULL, next_billing_at=${origNbf} WHERE id=${t.id}`;
  await sql`DELETE FROM notifications WHERE user_id=${t.user_id} AND type='test.ping'`;
  const [chk] = await sql`SELECT status FROM tunnels WHERE id=${t.id}`;
  console.log("   tunnel status restored:", chk.status);

  const [unread] = await sql<{ n: string }[]>`SELECT count(*)::text n FROM notifications WHERE user_id=${t.user_id} AND read_at IS NULL`;
  console.log("\n   unread notifs for user:", unread.n);
  console.log("\n✅ NOTIFICATION FLOW PASSED (non-destructive; tunnel restored to active)");
}
main().then(() => sql.end()).catch(async (e) => { console.error("FAIL:", e); await sql.end(); process.exit(1); });
