/**
 * Constant-time string comparison.
 *
 * Runs in time independent of WHERE the first differing byte is, and — unlike a
 * naive `a.length !== b.length` short-circuit — does not leak the secret's length
 * via an early return. Always walks the longer of the two byte lengths and folds
 * a length mismatch into the diff so unequal lengths compare in constant time too.
 *
 * This is the single shared implementation; all secret/token comparisons in the
 * guardian (principal token hashes, admin token, MCP bearer token, OpenAI/
 * Anthropic API keys) go through it.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const aBytes = new TextEncoder().encode(a);
  const bBytes = new TextEncoder().encode(b);
  const max = Math.max(aBytes.length, bBytes.length);
  let diff = aBytes.length === bBytes.length ? 0 : 1;
  for (let i = 0; i < max; i++) {
    diff |= (aBytes[i] ?? 0) ^ (bBytes[i] ?? 0);
  }
  return diff === 0;
}
