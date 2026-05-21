function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required (see /opt/vpnhub-app/.env)`);
  return v;
}

export const authConfig = {
  googleClientId: () => req("GOOGLE_CLIENT_ID"),
  googleClientSecret: () => req("GOOGLE_CLIENT_SECRET"),
  googleRedirectUri: () => req("GOOGLE_REDIRECT_URI"),
  portalBaseUrl: () => process.env.PORTAL_BASE_URL ?? "https://portal.myip.in.th",
  sessionTtlSeconds: () =>
    Number(process.env.AUTH_SESSION_TTL_SECONDS ?? 604800),
  redisUrl: () => req("REDIS_URL"),
  adminEmails: () =>
    (process.env.ADMIN_EMAILS ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  cookieName: "session",
};
