// Prints a valid session cookie token for an existing user (by EMAIL env).
// Used by the browser-path E2E to authenticate curl against the public URL.
import { sql } from "@vpnhub/db";
import { createSession, closeAuthRedis, isAdmin } from "@vpnhub/auth";

async function main() {
  const email = process.env.EMAIL;
  if (!email) throw new Error("EMAIL env required");
  const [u] = await sql<{ id: string; email: string; name: string }[]>`
    SELECT id, email, name FROM users WHERE email = ${email}`;
  if (!u) throw new Error(`user ${email} not found (seed first)`);
  const s = await createSession({
    id: u.id,
    email: u.email,
    name: u.name,
    isAdmin: await isAdmin(u.email),
  });
  process.stdout.write(s.token);
}

main()
  .then(async () => {
    await closeAuthRedis();
    await sql.end();
    process.exit(0);
  })
  .catch(async (e) => {
    console.error("make-session FAIL:", e);
    await closeAuthRedis().catch(() => {});
    await sql.end().catch(() => {});
    process.exit(1);
  });
