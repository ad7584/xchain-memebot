/**
 * AES-256-GCM encryption for secrets at rest — protects user 2FA secrets AND (in
 * the local custody backend) per-user wallet private keys. Key = ENCRYPTION_KEY
 * (32-byte hex). Missing key throws (never stores plaintext). `decrypt` still
 * accepts a legacy `plain:` prefix for backward-compat, but `encrypt` never emits it.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { config } from "../config.js";

function key(): Buffer {
  const b = Buffer.from(config.ENCRYPTION_KEY, "hex");
  if (b.length !== 32) {
    throw new Error("ENCRYPTION_KEY must be 32 bytes as hex (64 chars).");
  }
  return b;
}

export function encrypt(plaintext: string): string {
  if (!config.ENCRYPTION_KEY) {
    // Fail loud rather than silently persisting a raw private key / 2FA secret.
    throw new Error("ENCRYPTION_KEY is required to encrypt secrets at rest (set a 32-byte hex key).");
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${Buffer.concat([iv, tag, ct]).toString("base64")}`;
}

export function decrypt(payload: string): string {
  if (payload.startsWith("plain:")) return payload.slice(6);
  if (!payload.startsWith("v1:")) throw new Error("Unrecognized ciphertext format.");
  const raw = Buffer.from(payload.slice(3), "base64");
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const ct = raw.subarray(28);
  const d = createDecipheriv("aes-256-gcm", key(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString("utf8");
}
