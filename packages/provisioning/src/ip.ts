import { NoIpAvailable, ValidationError } from "./errors";

// Allocate the lowest free host in an IPv4 gateway subnet.
// Skips network (.0), gateway (.1) and broadcast (.255 for /24).
export function allocatePrivateIp(cidr: string, used: Set<string>): string {
  const [base, prefixStr] = cidr.split("/");
  const prefix = Number(prefixStr);
  const o = base.split(".").map(Number);
  if (o.length !== 4 || o.some((n) => Number.isNaN(n))) {
    throw ValidationError(`bad subnet ${cidr}`);
  }
  if (prefix !== 24) {
    // MVP gateways use /24 (design 3.2 example 10.99.0.0/24).
    throw ValidationError(`only /24 gateway subnets supported, got /${prefix}`);
  }
  for (let host = 2; host <= 254; host++) {
    const ip = `${o[0]}.${o[1]}.${o[2]}.${host}`;
    if (!used.has(ip)) return ip;
  }
  throw NoIpAvailable();
}
