// Display timestamps in Thailand time (Asia/Bangkok) consistently — independent
// of the server's TZ (server-rendered pages) and the viewer's device. DB stores
// timestamptz (UTC); these format to local for display only.
const TZ = "Asia/Bangkok";

function parts(s: string | Date): Record<string, string> {
  const d = new Date(s);
  // month: "short" → Jan/Feb/…/Dec — unambiguous against day/year (design
  // preference: numeric YYYY-MM-DD is hard to scan when eyeballing many rows).
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ,
    year: "numeric", month: "short", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  });
  const out: Record<string, string> = {};
  for (const p of fmt.formatToParts(d)) out[p.type] = p.value;
  return out;
}

/** "DD Mon YYYY" (Bangkok) — e.g. "03 Aug 2026". */
export function fmtDate(s?: string | Date | null): string {
  if (!s) return "—";
  const p = parts(s);
  return `${p.day} ${p.month} ${p.year}`;
}

/** "DD Mon YYYY HH:MM" (Bangkok). */
export function fmtDateTime(s?: string | Date | null): string {
  if (!s) return "—";
  const p = parts(s);
  return `${p.day} ${p.month} ${p.year} ${p.hour}:${p.minute}`;
}

/** "DD Mon YYYY HH:MM:SS" (Bangkok) — full precision. Use when the second
 *  matters (audit trail, DNS resolve timing, connection events). */
export function fmtDateTimeSec(s?: string | Date | null): string {
  if (!s) return "—";
  const p = parts(s);
  return `${p.day} ${p.month} ${p.year} ${p.hour}:${p.minute}:${p.second}`;
}

/** "DD Mon HH:MM:SS" (Bangkok) — compact for logs. */
export function fmtLogTime(s?: string | Date | null): string {
  if (!s) return "";
  const p = parts(s);
  return `${p.day} ${p.month} ${p.hour}:${p.minute}:${p.second}`;
}
