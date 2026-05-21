import { sql } from "@vpnhub/db";
import { authConfig } from "./config";
import type { GoogleProfile } from "./google";

export interface AppUser {
  id: string;
  email: string;
  name: string;
  isAdmin: boolean;
}

// Upsert by google_sub (stable identifier, design §6.2). First insert fires
// the DB trigger that auto-creates the credit wallet.
export async function upsertGoogleUser(
  p: GoogleProfile,
  ip?: string,
): Promise<AppUser> {
  const [row] = await sql<{ id: string; email: string; name: string }[]>`
    INSERT INTO users (google_sub, email, name, avatar_url, email_verified,
      last_login_at, last_login_ip)
    VALUES (${p.sub}, ${p.email}, ${p.name}, ${p.picture ?? null},
      ${p.emailVerified}, NOW(), ${ip ?? null}::inet)
    ON CONFLICT (google_sub) DO UPDATE SET
      email = EXCLUDED.email,
      name = EXCLUDED.name,
      avatar_url = EXCLUDED.avatar_url,
      email_verified = EXCLUDED.email_verified,
      last_login_at = NOW(),
      last_login_ip = ${ip ?? null}::inet
    RETURNING id, email, name`;

  return {
    id: row.id,
    email: row.email,
    name: row.name,
    isAdmin: await isAdmin(row.email),
  };
}

export async function isAdmin(email: string): Promise<boolean> {
  if (authConfig.adminEmails().includes(email.toLowerCase())) return true;
  const [a] = await sql`
    SELECT 1 FROM admin_users
    WHERE lower(email) = lower(${email}) AND active = true LIMIT 1`;
  return !!a;
}
