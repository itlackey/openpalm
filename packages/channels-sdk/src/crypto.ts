/**
 * OpenPalm shared HMAC utilities.
 *
 * Uses Bun.CryptoHasher (Bun built-in, synchronous) for HMAC-SHA256.
 * verifySignature uses a constant-time XOR comparison to prevent timing attacks.
 */

/**
 * Constant-time string comparison to prevent timing attacks.
 * Used for API key, token, and HMAC signature validation.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

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
  return constantTimeEqual(signPayload(secret, body), sig);
}
