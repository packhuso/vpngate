import { defineConfig } from "drizzle-kit";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required (see /opt/vpnhub-app/.env)");

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./src/drizzle",
  dbCredentials: { url },
  // Schema is owned by docs/vpn_hub_schema.sql and applied directly to the DB;
  // we introspect it into Drizzle (drizzle-kit pull) rather than re-author it.
  introspect: { casing: "preserve" },
});
