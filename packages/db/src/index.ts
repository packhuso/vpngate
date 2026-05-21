import postgres, { type Sql } from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "./schema";

export { schema };

let _sql: Sql | undefined;
let _db: ReturnType<typeof drizzle<typeof schema>> | undefined;

function init() {
  if (_sql && _db) return;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required (see /opt/vpnhub-app/.env)");
  // max=10 keeps well under PG max_connections=200 (design 4.2).
  _sql = postgres(url, { max: 10 });
  _db = drizzle(_sql, { schema });
}

// Lazy proxies: connecting happens on first use, not on import — so a library
// import never crashes a process that hasn't loaded env yet.
export const sql: Sql = new Proxy((() => {}) as unknown as Sql, {
  get: (_t, p) => {
    init();
    const v = Reflect.get(_sql as object, p);
    return typeof v === "function" ? v.bind(_sql) : v;
  },
  apply: (_t, _this, args: unknown[]) => {
    init();
    return (_sql as unknown as (...a: unknown[]) => unknown)(...args);
  },
});

export const db = new Proxy({} as ReturnType<typeof drizzle<typeof schema>>, {
  get: (_t, p) => {
    init();
    return Reflect.get(_db as object, p);
  },
});

export type DB = ReturnType<typeof drizzle<typeof schema>>;
