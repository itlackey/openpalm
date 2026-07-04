// ── Shared error helpers ──────────────────────────────────────────────────
// Small predicates for the errors thrown by the transport core (`core.ts`),
// whose non-OK / 401 rejections carry a numeric `.status`. Use these instead
// of fragile `message.includes('401')` string matching, which breaks for the
// 401 path (that error's message is "Sign-in required.", not "401").

/** True when the error came from an auth failure (HTTP 401 or 403). */
export function isAuthError(e: unknown): boolean {
  const status = (e as { status?: unknown } | null | undefined)?.status;
  return status === 401 || status === 403;
}

/** The Error's message, or `fallback` for anything that isn't an Error. */
export function toMessage(e: unknown, fallback: string): string {
  return e instanceof Error ? e.message : fallback;
}
