/**
 * Client-side twin of the shared control-plane library's decodePairingCode
 * (#511 D3/D4). packages/client never imports the host control-plane
 * package (purity gate) — this is a hand-maintained twin of
 * `packages/lib/src/control-plane/pairing.ts`'s decode half, pinned
 * compatible by a tests-only cross-import round-trip test
 * (`tests/connections-pairing.test.ts`, precedent:
 * `tests/remote-attach.e2e.test.ts:58`).
 *
 * base64url decode via `atob` + `Uint8Array` + `TextDecoder` — the same
 * UTF-8-safe approach as the transport's `base64Utf8` encoder
 * (transport/index.ts:222-227), inverted for decoding.
 */

const PAIRING_CODE_PREFIX = 'openpalm-pair:';

export type PairingPayload = {
  v: 1;
  kind: 'openpalm-client-api';
  url: string;
  label?: string;
  username: string;
  secret: string;
};

export type ParsePairingResult = { ok: true; payload: PairingPayload } | { ok: false; error: string };

function base64UrlToUtf8(b64url: string): string {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/**
 * Decode + strictly validate a pairing code. The `openpalm-pair:` prefix is
 * optional (a QR reader may hand back the bare payload) and surrounding
 * whitespace is tolerated. Never throws — malformed input is always a
 * structured `{ ok: false }`.
 */
export function parsePairingCode(code: string): ParsePairingResult {
  const trimmed = code.trim();
  const withoutPrefix = trimmed.startsWith(PAIRING_CODE_PREFIX)
    ? trimmed.slice(PAIRING_CODE_PREFIX.length)
    : trimmed;
  if (!withoutPrefix) return { ok: false, error: 'Pairing code is empty.' };

  let json: string;
  try {
    json = base64UrlToUtf8(withoutPrefix);
  } catch {
    return { ok: false, error: 'Pairing code is not valid base64url.' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { ok: false, error: 'Pairing code payload is not valid JSON.' };
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return { ok: false, error: 'Pairing code payload must be an object.' };
  }
  const value = parsed as Record<string, unknown>;

  if (value.v !== 1) {
    return { ok: false, error: 'Pairing code has an unsupported version.' };
  }
  if (value.kind !== 'openpalm-client-api') {
    return { ok: false, error: 'Pairing code has an unsupported kind.' };
  }
  if (typeof value.url !== 'string' || !value.url) {
    return { ok: false, error: 'Pairing code is missing a url.' };
  }
  if (typeof value.username !== 'string' || !value.username) {
    return { ok: false, error: 'Pairing code is missing a username.' };
  }
  if (typeof value.secret !== 'string' || !value.secret) {
    return { ok: false, error: 'Pairing code is missing a secret.' };
  }
  if (value.label !== undefined && typeof value.label !== 'string') {
    return { ok: false, error: 'Pairing code has an invalid label.' };
  }

  const payload: PairingPayload = {
    v: 1,
    kind: 'openpalm-client-api',
    url: value.url,
    username: value.username,
    secret: value.secret,
    ...(value.label !== undefined ? { label: value.label as string } : {}),
  };
  return { ok: true, payload };
}
