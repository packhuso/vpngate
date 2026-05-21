// Field encryption for secrets at rest (design Section 6.5):
// WireGuard private keys + per-gateway agent tokens are AES-256-GCM
// encrypted before they touch the DB. Key = APP_SECRET_KEY (64 hex chars).
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";

const ALG = "aes-256-gcm";

function key(): Buffer {
  const hex = process.env.APP_SECRET_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error("APP_SECRET_KEY must be 64 hex chars (32 bytes)");
  }
  return Buffer.from(hex, "hex");
}

/** Returns "v1:<iv b64>:<tag b64>:<ciphertext b64>". */
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv(ALG, key(), iv);
  const ct = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
  const tag = c.getAuthTag();
  return `v1:${iv.toString("base64")}:${tag.toString("base64")}:${ct.toString(
    "base64",
  )}`;
}

export function decryptSecret(blob: string): string {
  const [v, ivB64, tagB64, ctB64] = blob.split(":");
  if (v !== "v1") throw new Error("unknown secret envelope version");
  const d = createDecipheriv(ALG, key(), Buffer.from(ivB64, "base64"));
  d.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([
    d.update(Buffer.from(ctB64, "base64")),
    d.final(),
  ]).toString("utf8");
}
