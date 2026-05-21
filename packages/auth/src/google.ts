// Minimal Google OAuth 2.0 (Authorization Code) — design §2.5/6.2.
import { authConfig } from "./config";

export interface GoogleProfile {
  sub: string;
  email: string;
  emailVerified: boolean;
  name: string;
  picture?: string;
}

export function buildAuthUrl(state: string): string {
  const p = new URLSearchParams({
    client_id: authConfig.googleClientId(),
    redirect_uri: authConfig.googleRedirectUri(),
    response_type: "code",
    scope: "openid email profile",
    state,
    access_type: "online",
    prompt: "select_account",
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
}

export async function exchangeCode(code: string): Promise<GoogleProfile> {
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: authConfig.googleClientId(),
      client_secret: authConfig.googleClientSecret(),
      redirect_uri: authConfig.googleRedirectUri(),
      grant_type: "authorization_code",
    }),
  });
  if (!tokenRes.ok) {
    throw new Error(`google token exchange failed: ${tokenRes.status} ${await tokenRes.text()}`);
  }
  const { access_token } = (await tokenRes.json()) as { access_token: string };

  const uiRes = await fetch(
    "https://openidconnect.googleapis.com/v1/userinfo",
    { headers: { Authorization: `Bearer ${access_token}` } },
  );
  if (!uiRes.ok) throw new Error(`google userinfo failed: ${uiRes.status}`);
  const u = (await uiRes.json()) as {
    sub: string;
    email: string;
    email_verified?: boolean;
    name?: string;
    picture?: string;
  };
  return {
    sub: u.sub,
    email: u.email,
    emailVerified: u.email_verified ?? false,
    name: u.name ?? u.email,
    picture: u.picture,
  };
}
