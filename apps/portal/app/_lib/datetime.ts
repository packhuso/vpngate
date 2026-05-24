// Display timestamps in Thailand time (Asia/Bangkok) consistently — independent
// of the server's TZ (server-rendered pages) and the viewer's device. DB stores
// timestamptz (UTC); these format to local for display only.
const TZ = "Asia/Bangkok";

function parts(s: string | Date): Record<string, string> {
  const d = new Date(s);
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  });
  const out: Record<string, string> = {};
  for (const p of fmt.formatToParts(d)) out[p.type] = p.value;
  return out;
}

/** "YYYY-MM-DD" (Bangkok). */
export function fmtDate(s?: string | Date | null): string {
  if (!s) return "—";
  const p = parts(s);
  return `${p.year}-${p.month}-${p.day}`;
}

/** "YYYY-MM-DD HH:MM" (Bangkok). */
export function fmtDateTime(s?: string | Date | null): string {
  if (!s) return "—";
  const p = parts(s);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

/** "MM-DD HH:MM:SS" (Bangkok) — compact for logs. */
export function fmtLogTime(s?: string | Date | null): string {
  if (!s) return "";
  const p = parts(s);
  return `${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}
