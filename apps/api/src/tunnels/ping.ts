// Server-side ICMP ping helper. Shells out to /usr/bin/ping via execFile (array
// args, no shell) so the only injection vector is the IP — and the regex guard
// rejects anything that isn't a clean IPv4/IPv6 literal. Returns zeros on any
// failure (timeout, unreachable, parse miss) rather than throwing, so the API
// route can return a stable shape per target.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

// Strict IPv4 (4 octets 0–255) OR a permissive IPv6 literal (hex+colons only).
// Callers must already restrict to DB-sourced IPs; this is defence-in-depth.
const IPV4 = /^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const IPV6 = /^[0-9a-fA-F:]+$/;

export interface PingResult {
  ip: string;
  transmitted: number;
  received: number;
  lossPct: number;
  minMs: number | null;
  avgMs: number | null;
  maxMs: number | null;
}

const zero = (ip: string): PingResult => ({
  ip, transmitted: 4, received: 0, lossPct: 100,
  minMs: null, avgMs: null, maxMs: null,
});

export async function pingOne(ip: string): Promise<PingResult> {
  if (!IPV4.test(ip) && !IPV6.test(ip)) return zero(ip);
  const bin = IPV6.test(ip) && !IPV4.test(ip) ? "ping6" : "ping";
  try {
    const { stdout } = await exec(
      bin,
      ["-n", "-c", "4", "-W", "2", "-i", "0.3", ip],
      { timeout: 10_000 },
    );
    const sum = /(\d+) packets transmitted, (\d+) received/.exec(stdout);
    const rtt = /min\/avg\/max\/[^\s=]+\s*=\s*([\d.]+)\/([\d.]+)\/([\d.]+)/.exec(stdout);
    if (!sum) return zero(ip);
    const transmitted = Number(sum[1]);
    const received = Number(sum[2]);
    const lossPct = transmitted > 0
      ? Math.round(((transmitted - received) / transmitted) * 100)
      : 100;
    return {
      ip, transmitted, received, lossPct,
      minMs: rtt ? Number(rtt[1]) : null,
      avgMs: rtt ? Number(rtt[2]) : null,
      maxMs: rtt ? Number(rtt[3]) : null,
    };
  } catch {
    return zero(ip);
  }
}
