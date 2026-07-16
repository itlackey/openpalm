/**
 * Browser-owned pairing-code decoder (Phase 3a — "One UI, delete the split").
 *
 * Decode + strictly validate a one-time pairing code minted host-side by
 * `@openpalm/lib`'s `encodePairingCode`. This is the decode half only (the host
 * mint route lives in ui).
 *
 * base64url decode via `atob` + `Uint8Array` + `TextDecoder` — the UTF-8-safe
 * inverse of the transport's `base64Utf8` encoder.
 */
import { validateConnectionUrl } from './url-policy.js';

const PAIRING_CODE_PREFIX = 'openpalm-pair:';

export type PairingPayload = {
  v: 1;
  kind: 'openpalm-connection';
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
  if (value.kind !== 'openpalm-connection') {
    return { ok: false, error: 'Pairing code has an unsupported kind.' };
  }
  if (typeof value.url !== 'string' || !value.url) {
    return { ok: false, error: 'Pairing code is missing a url.' };
  }
  const urlVerdict = validateConnectionUrl(value.url, null);
  if (!urlVerdict.ok) {
    return { ok: false, error: urlVerdict.message };
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
    kind: 'openpalm-connection',
    url: value.url,
    username: value.username,
    secret: value.secret,
    ...(value.label !== undefined ? { label: value.label as string } : {}),
  };
  return { ok: true, payload };
}
