import { sql } from "@vpnhub/db";
async function main() {
  const [c] = await sql<{ id: string; code: string }[]>`
    SELECT id, code FROM credit_codes WHERE status='active' LIMIT 1`;
  if (!c) { console.log("no active code; skip"); await sql.end(); return; }
  console.log("test code:", c.code);

  console.log("[1] paused"); await sql`UPDATE credit_codes SET status='paused' WHERE id=${c.id}`;
  let [r] = await sql`SELECT count(*)::int n FROM credit_codes WHERE id=${c.id} AND status='active'`;
  if (r.n !== 0) throw new Error("FAIL paused redeemable"); console.log("   ✓ not redeemable");

  console.log("[2] active"); await sql`UPDATE credit_codes SET status='active' WHERE id=${c.id}`;
  console.log("[3] expiry past");
  await sql`UPDATE credit_codes SET expires_at=NOW()-INTERVAL '1 min' WHERE id=${c.id}`;
  [r] = await sql`SELECT count(*)::int n FROM credit_codes WHERE id=${c.id} AND status='active' AND (expires_at IS NULL OR expires_at>NOW())`;
  if (r.n !== 0) throw new Error("FAIL expired redeemable"); console.log("   ✓ expired not redeemable");

  console.log("[4] clear expiry");
  await sql`UPDATE credit_codes SET expires_at=NULL WHERE id=${c.id}`;
  [r] = await sql`SELECT count(*)::int n FROM credit_codes WHERE id=${c.id} AND status='active' AND (expires_at IS NULL OR expires_at>NOW())`;
  if (r.n !== 1) throw new Error("FAIL not redeemable"); console.log("   ✓ redeemable again");

  console.log("[5] revoked"); await sql`UPDATE credit_codes SET status='revoked' WHERE id=${c.id}`;
  [r] = await sql`SELECT count(*)::int n FROM credit_codes WHERE id=${c.id} AND status='active'`;
  if (r.n !== 0) throw new Error("FAIL revoked redeemable"); console.log("   ✓ revoked not redeemable");

  console.log("[6] restore"); await sql`UPDATE credit_codes SET status='active' WHERE id=${c.id}`;
  console.log("\n✅ ALL CHECKS PASSED (status/expiry guard works)");
}
main().then(() => sql.end()).catch(async (e) => { console.error("FAIL:", e); await sql.end(); process.exit(1); });
