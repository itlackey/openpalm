import { createHmac, timingSafeEqual } from "crypto";

export function signPayload(secret: string, body: string): string {
  if (!secret) throw new Error("HMAC secret must not be empty");
  return createHmac("sha256", secret).update(body).digest("hex");
}

export function verifySignature(secret: string, body: string, incomingSig: string): boolean {
  if (!secret || !incomingSig) return false;
  const expected = signPayload(secret, body);
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(incomingSig, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
