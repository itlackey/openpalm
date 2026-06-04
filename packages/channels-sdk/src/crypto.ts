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

/**
 * Per-call request signing for the native OpenCode proxy (/oc/*).
 *
 * Unlike the legacy whole-body envelope (signPayload), this binds the HTTP
 * method, the path+query, a SHA256 of the body, and — critically — the
 * `userId` into the signed material as a mandatory positional field. Because
 * the channel secret is shared across a channel's users, signing userId
 * prevents one user replaying another user's signed call with a swapped
 * userId (security review F1).
 *
 * The signed string is EXACTLY:
 *   METHOD "\n" PATH+QUERY "\n" SHA256(body) "\n" nonce "\n" timestamp "\n" userId
 *
 * nonce/timestamp/userId also travel as headers so the verifier can
 * reconstruct the string, but verification uses the SIGNED copy.
 */
export interface RequestSignatureFields {
  /** HTTP method, e.g. "GET", "POST". Compared verbatim (case-sensitive). */
  method: string;
  /** Path plus query string, e.g. "/session/abc/message?foo=1". */
  pathWithQuery: string;
  /** Raw request body bytes. Empty-body requests (GET /event) sign SHA256(""). */
  body: string;
  /** Anti-replay nonce. */
  nonce: string;
  /** Unix-ms timestamp. */
  timestamp: number;
  /** Mandatory signed principal identity. */
  userId: string;
}

/** SHA256 hex digest of a (possibly empty) body string. Bun built-in. */
function sha256Hex(body: string): string {
  return new Bun.CryptoHasher("sha256").update(body).digest("hex");
}

/** Builds the canonical signed string for a native proxy call. */
function buildSignedString(fields: RequestSignatureFields): string {
  return [
    fields.method,
    fields.pathWithQuery,
    sha256Hex(fields.body),
    fields.nonce,
    String(fields.timestamp),
    fields.userId,
  ].join("\n");
}

/**
 * Produces the x-channel-signature for a native proxy call:
 * HMAC-SHA256(channel_secret, signed).
 */
export function signRequest(secret: string, fields: RequestSignatureFields): string {
  return new Bun.CryptoHasher("sha256", secret).update(buildSignedString(fields)).digest("hex");
}

/**
 * Constant-time verification of a native proxy call signature. The verifier
 * MUST pass the reconstructed fields (method, path+query, body, and the
 * nonce/timestamp/userId from the headers); verification recomputes the
 * signed string from these and compares against the provided signature.
 *
 * A request that swaps userId (or method/path/body/nonce/timestamp) while
 * reusing another call's signature fails, because userId is inside the
 * signed material. Fail-closed on empty secret or empty signature.
 */
export function verifyRequest(secret: string, fields: RequestSignatureFields, sig: string): boolean {
  if (!secret || !sig) return false;
  return constantTimeEqual(signRequest(secret, fields), sig);
}
