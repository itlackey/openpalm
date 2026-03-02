/**
 * OpenPalm shared HMAC utilities.
 *
 * Uses Bun.CryptoHasher (Bun built-in, synchronous) for HMAC-SHA256.
 * verifySignature uses a constant-time XOR comparison to prevent timing attacks.
 */

/**
 * Produces an HMAC-SHA256 hex digest of body using secret as the key.
 */
export function signPayload(secret: string, body: string): string {
  return new Bun.CryptoHasher("sha256", secret).update(body).digest("hex");
}

/**
 * Constant-time comparison of the expected HMAC against the provided signature.
 * Returns true only when both the length and every byte match.
 */
export function verifySignature(secret: string, body: string, sig: string): boolean {
  if (!secret || !sig) return false;
  const expected = signPayload(secret, body);
  if (expected.length !== sig.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  }
  return diff === 0;
}
