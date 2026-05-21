// Connectivity + schema sanity check against the live database.
// Run via `pnpm --filter @vpnhub/db check:db` (tsx → CJS, so no top-level await).
import postgres from "postgres";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");

  const sql = postgres(url, { max: 1 });
  try {
    const [{ version }] = await sql`SELECT version()`;
    const tables = await sql<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name`;
    const [{ count: enumCount }] = await sql`
      SELECT count(*)::int AS count FROM pg_type WHERE typtype = 'e'`;

    console.log("PG:", String(version).split(",")[0]);
    console.log(
      "tables:",
      tables.length,
      "->",
      tables.map((t) => t.table_name).join(", "),
    );
    console.log("enum types:", enumCount);
    const ok = tables.length >= 15 && enumCount >= 12;
    console.log(ok ? "DB CHECK: PASS" : "DB CHECK: FAIL");
    process.exitCode = ok ? 0 : 1;
  } finally {
    await sql.end();
  }
}

main().catch((e) => {
  console.error("DB CHECK: ERROR", e);
  process.exit(1);
});
