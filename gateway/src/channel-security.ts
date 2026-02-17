import { createHmac, timingSafeEqual } from "node:crypto";

const usedNonces = new Map<string, number>();

function cleanupNonces() {
  const now = Date.now();
  for (const [k, ts] of usedNonces.entries()) {
    if (now - ts > 10 * 60_000) usedNonces.delete(k);
  }
}

export function signPayload(secret: string, body: string) {
  return createHmac("sha256", secret).update(body).digest("hex");
}

export function verifySignature(secret: string, body: string, incomingSig: string) {
  const expected = signPayload(secret, body);
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(incomingSig, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function verifyReplayProtection(channel: string, nonce: string, timestamp: number, skewMs = 120000): boolean {
  cleanupNonces();
  const now = Date.now();
  if (Math.abs(now - timestamp) > skewMs) return false;
  const key = `${channel}:${nonce}`;
  if (usedNonces.has(key)) return false;
  usedNonces.set(key, now);
  return true;
}
