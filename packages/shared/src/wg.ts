// WireGuard keypair generation (X25519) in `wg`-compatible base64,
// without needing wireguard-tools on the control plane.
import { generateKeyPairSync } from "node:crypto";

export interface WgKeypair {
  privateKey: string; // base64, 32 bytes
  publicKey: string; // base64, 32 bytes
}

/** Raw 32-byte X25519 key is the tail of the DER (pkcs8/spki) encoding. */
export function generateWireguardKeypair(): WgKeypair {
  const { privateKey, publicKey } = generateKeyPairSync("x25519");
  const priv = privateKey.export({ type: "pkcs8", format: "der" });
  const pub = publicKey.export({ type: "spki", format: "der" });
  return {
    privateKey: priv.subarray(priv.length - 32).toString("base64"),
    publicKey: pub.subarray(pub.length - 32).toString("base64"),
  };
}
