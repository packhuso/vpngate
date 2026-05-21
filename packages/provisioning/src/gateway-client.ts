// Factory for the per-gateway control-plane client (mTLS + Bearer).
import { readFileSync } from "node:fs";
import { decryptSecret } from "@vpnhub/shared";
import { GatewayClient } from "@vpnhub/gateway-client";

export interface GatewayEndpoint {
  agent_endpoint: string;
  agent_ca_cert: string;
  agent_token: string; // AES-GCM blob from vpn_gateways
}

export function buildGatewayClient(g: GatewayEndpoint): GatewayClient {
  const certPath = process.env.WORKER_TLS_CLIENT_CERT;
  const keyPath = process.env.WORKER_TLS_CLIENT_KEY;
  if (!certPath || !keyPath) {
    throw new Error("WORKER_TLS_CLIENT_CERT/_KEY env not set");
  }
  return new GatewayClient({
    baseUrl: g.agent_endpoint,
    bearerToken: decryptSecret(g.agent_token),
    clientCertPem: readFileSync(certPath, "utf8"),
    clientKeyPem: readFileSync(keyPath, "utf8"),
    caPem: g.agent_ca_cert,
    timeoutMs: 10_000,
  });
}
