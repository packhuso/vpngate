// Re-export the introspected schema + relations.
// Source of truth = docs/vpn_hub_schema.sql, applied to the DB and pulled
// via `pnpm db:pull` (drizzle-kit). Do not hand-edit ./drizzle/*.
export * from "./drizzle/schema";
export * from "./drizzle/relations";
