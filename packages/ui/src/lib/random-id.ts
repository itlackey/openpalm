/**
 * Random id generation that works in EVERY browsing context.
 *
 * `crypto.randomUUID()` is secure-context-only: on a plain-http LAN origin
 * (the LAN-served tier) it is undefined and calling it throws. Every
 * browser-side id mint (connection ids, secret refs, request ids, local chat
 * entry ids) must go through this guard instead of bare `crypto.randomUUID()`
 * — the fallback builds a v4 UUID from `crypto.getRandomValues`, which IS
 * available in insecure contexts.
 *
 * Zero-import leaf module so any $lib code can use it without cycles.
 */
export function randomId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
