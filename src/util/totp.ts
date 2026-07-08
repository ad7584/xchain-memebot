/**
 * RFC 6238 TOTP (and RFC 4226 HOTP) — 6 digits, 30s step, SHA-1. Hand-rolled on
 * node:crypto so we add no dependency. Used to 2FA-protect withdrawals.
 */
import { createHmac, randomBytes } from "node:crypto";

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function generateSecret(bytes = 20): string {
  const buf = randomBytes(bytes);
  let bits = "";
  for (const b of buf) bits += b.toString(2).padStart(8, "0");
  let out = "";
  for (let i = 0; i + 5 <= bits.length; i += 5) {
    out += B32[parseInt(bits.slice(i, i + 5), 2)];
  }
  return out;
}

function base32Decode(s: string): Buffer {
  const clean = s.replace(/=+$/,"").toUpperCase().replace(/\s/g, "");
  let bits = "";
  for (const c of clean) {
    const idx = B32.indexOf(c);
    if (idx === -1) continue;
    bits += idx.toString(2).padStart(5, "0");
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

function hotp(secret: Buffer, counter: number): string {
  const buf = Buffer.alloc(8);
  // 64-bit big-endian counter
  buf.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const hmac = createHmac("sha1", secret).update(buf).digest();
  const offset = hmac[hmac.length - 1]! & 0xf;
  const code =
    ((hmac[offset]! & 0x7f) << 24) |
    ((hmac[offset + 1]! & 0xff) << 16) |
    ((hmac[offset + 2]! & 0xff) << 8) |
    (hmac[offset + 3]! & 0xff);
  return (code % 1_000_000).toString().padStart(6, "0");
}

export function totp(secretB32: string, nowMs = Date.now(), step = 30): string {
  const counter = Math.floor(nowMs / 1000 / step);
  return hotp(base32Decode(secretB32), counter);
}

/** Verify with a ±window tolerance (default ±1 step) for clock drift. */
export function verifyTotp(
  secretB32: string,
  token: string,
  window = 1,
  nowMs = Date.now(),
  step = 30
): boolean {
  const t = token.trim();
  if (!/^\d{6}$/.test(t)) return false;
  const secret = base32Decode(secretB32);
  const counter = Math.floor(nowMs / 1000 / step);
  for (let w = -window; w <= window; w++) {
    if (hotp(secret, counter + w) === t) return true;
  }
  return false;
}

/** otpauth:// URI for authenticator-app QR provisioning. */
export function otpauthUrl(secretB32: string, label: string, issuer = "XChainMemeBot"): string {
  const l = encodeURIComponent(`${issuer}:${label}`);
  return `otpauth://totp/${l}?secret=${secretB32}&issuer=${encodeURIComponent(issuer)}&digits=6&period=30`;
}
