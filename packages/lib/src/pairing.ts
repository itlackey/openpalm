export const PAIRING_CODE_PREFIX = 'openpalm-pair:';

export type PairingPayloadV1 = {
  v: 1;
  kind: 'openpalm-connection';
  url: string;
  label?: string;
  username: string;
  secret: string;
};

export type DecodePairingResult =
  | { ok: true; payload: PairingPayloadV1 }
  | { ok: false; error: string };

export type GuardianPairingUrlResult =
  | { ok: true; url: string }
  | { ok: false; error: string };

const INVALID_CODE = 'This pairing code is not valid. Ask for a new code and try again.';
const INCOMPLETE_CODE = 'This pairing code is incomplete. Ask for a new code and try again.';

function utf8ToBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlToUtf8(value: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('invalid pairing code');
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

export function normalizeGuardianPairingUrl(rawUrl: string): GuardianPairingUrlResult {
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    return { ok: false, error: 'Enter a valid address beginning with http:// or https://.' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, error: 'Enter a valid address beginning with http:// or https://.' };
  }
  if (!url.hostname || url.username || url.password || url.search || url.hash) {
    return { ok: false, error: 'Enter only the server address, without sign-in details or extra text.' };
  }
  if (url.pathname !== '/' && url.pathname !== '/oc' && url.pathname !== '/oc/') {
    return { ok: false, error: 'Use the server root address or an address ending in /oc.' };
  }
  url.pathname = '/oc';
  return { ok: true, url: url.toString() };
}

export function encodePairingCode(payload: PairingPayloadV1): string {
  return `${PAIRING_CODE_PREFIX}${utf8ToBase64Url(JSON.stringify(payload))}`;
}

export function decodePairingCode(code: string): DecodePairingResult {
  const trimmed = code.trim();
  const encoded = trimmed.startsWith(PAIRING_CODE_PREFIX)
    ? trimmed.slice(PAIRING_CODE_PREFIX.length)
    : trimmed;
  if (!encoded) return { ok: false, error: 'Paste a pairing code.' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(base64UrlToUtf8(encoded));
  } catch {
    return { ok: false, error: INVALID_CODE };
  }
  if (typeof parsed !== 'object' || parsed === null) return { ok: false, error: INVALID_CODE };
  const value = parsed as Record<string, unknown>;
  if (value.v !== 1 || value.kind !== 'openpalm-connection') {
    return { ok: false, error: INVALID_CODE };
  }
  if (
    typeof value.url !== 'string' ||
    !value.url ||
    typeof value.username !== 'string' ||
    !value.username ||
    typeof value.secret !== 'string' ||
    !value.secret ||
    (value.label !== undefined && typeof value.label !== 'string')
  ) {
    return { ok: false, error: INCOMPLETE_CODE };
  }

  const normalizedUrl = normalizeGuardianPairingUrl(value.url);
  if (!normalizedUrl.ok) {
    return { ok: false, error: 'This pairing code has an invalid address. Ask for a new code and try again.' };
  }
  return {
    ok: true,
    payload: {
      v: 1,
      kind: 'openpalm-connection',
      url: normalizedUrl.url,
      username: value.username,
      secret: value.secret,
      ...(value.label !== undefined ? { label: value.label } : {}),
    },
  };
}
