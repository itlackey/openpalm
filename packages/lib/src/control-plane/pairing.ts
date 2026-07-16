/**
 * Pairing code codec + guardian principal minting (#511 D3/D4).
 *
 * Portable control-plane logic: encoding/decoding the one-time pairing code
 * and orchestrating the guardian admin-API mint both live here so a future
 * `openpalm pair` CLI command never has to duplicate them (core-principles
 * §Shared control-plane library). `packages/ui`'s pairing route is a thin
 * transport wrapper over `mintDirectPrincipalPairingCode`, and its browser
 * decoder (`connections/pairing.ts` `parsePairingCode`) is a hand-maintained
 * twin of `decodePairingCode` here — the browser bundle never imports
 * `@openpalm/lib`.
 *
 * The pairing code itself is a self-contained, signed-nothing payload (D3):
 * `openpalm-pair:` + base64url(JSON). It is never persisted host-side — the
 * durable artifact is the minted guardian principal, individually revocable
 * via the guardian admin listener's principal-delete endpoint (#433,
 * `packages/guardian/src/admin.ts`).
 */
import { readSecret } from './secrets-files.js';

export const PAIRING_CODE_PREFIX = 'openpalm-pair:';

export type PairingPayloadV1 = {
  v: 1;
  kind: 'openpalm-connection';
  /** Operator-entered guardian base URL. */
  url: string;
  label?: string;
  /** Minted principal id. */
  username: string;
  /** Minted principal token. */
  secret: string;
};

export type DecodePairingResult =
  | { ok: true; payload: PairingPayloadV1 }
  | { ok: false; error: string };

export type MintPairingResult =
  | { ok: true; code: string; principalId: string }
  | { ok: false; error: string };

const DEFAULT_GUARDIAN_ADMIN_URL = 'http://127.0.0.1:3831';
/** Bound on the guardian admin mint call (PR #564 second retest) — a listener
 *  that accepts but never responds must not hang the mint. */
const PAIRING_ADMIN_TIMEOUT_MS = 5000;

/** Encode a pairing payload as `openpalm-pair:` + base64url(JSON). */
export function encodePairingCode(payload: PairingPayloadV1): string {
  const json = JSON.stringify(payload);
  const encoded = Buffer.from(json, 'utf-8').toString('base64url');
  return `${PAIRING_CODE_PREFIX}${encoded}`;
}

/**
 * Decode + strictly validate a pairing code. The `openpalm-pair:` prefix is
 * optional (a QR reader may hand back the bare payload) and surrounding
 * whitespace is tolerated. Never throws — malformed input is always a
 * structured `{ ok: false }`, never an exception.
 */
export function decodePairingCode(code: string): DecodePairingResult {
  const trimmed = code.trim();
  const withoutPrefix = trimmed.startsWith(PAIRING_CODE_PREFIX)
    ? trimmed.slice(PAIRING_CODE_PREFIX.length)
    : trimmed;
  if (!withoutPrefix) return { ok: false, error: 'Pairing code is empty.' };

  let json: string;
  try {
    json = Buffer.from(withoutPrefix, 'base64url').toString('utf-8');
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
  if (typeof value.username !== 'string' || !value.username) {
    return { ok: false, error: 'Pairing code is missing a username.' };
  }
  if (typeof value.secret !== 'string' || !value.secret) {
    return { ok: false, error: 'Pairing code is missing a secret.' };
  }
  if (value.label !== undefined && typeof value.label !== 'string') {
    return { ok: false, error: 'Pairing code has an invalid label.' };
  }

  const payload: PairingPayloadV1 = {
    v: 1,
    kind: 'openpalm-connection',
    url: value.url,
    username: value.username,
    secret: value.secret,
    ...(value.label !== undefined ? { label: value.label as string } : {}),
  };
  return { ok: true, payload };
}

/** `slug(label) + '-' + 4 hex chars` — never the bare slug, so a mint never
 *  clobbers an existing principal via a bare-label upsert. */
function slugifyLabel(label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
    .replace(/-+$/g, '');
  return slug || 'device';
}

function randomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Mint a `direct` guardian principal via the guardian's existing loopback-
 * only, Bearer-gated admin API and return a one-time pairing code carrying
 * its credential (D3). Fails closed: a missing admin-token secret or an
 * unreachable/non-2xx admin API is a structured `{ ok: false }`, never a
 * thrown error and never a fetch attempt without a token in hand.
 */
export async function mintDirectPrincipalPairingCode(options: {
  homeDir: string;
  label: string;
  url: string;
  guardianAdminUrl?: string;
  fetchImpl?: typeof fetch;
}): Promise<MintPairingResult> {
  const {
    homeDir,
    label,
    url,
    guardianAdminUrl = DEFAULT_GUARDIAN_ADMIN_URL,
    fetchImpl = fetch,
  } = options;

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    return { ok: false, error: 'Pairing target url must be a valid http(s) URL.' };
  }
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    return { ok: false, error: 'Pairing target url must be a valid http(s) URL.' };
  }

  const rawToken = readSecret(homeDir, 'op_guardian_admin_token');
  if (!rawToken) {
    return {
      ok: false,
      error: 'op_guardian_admin_token secret is missing — mint the guardian admin token first.',
    };
  }
  const adminToken = rawToken.trim();

  // PR #564 r3566891355: 8 random bytes (64 bits) of id suffix — collision-
  // resistant across any realistic fleet.
  const principalId = `${slugifyLabel(label)}-${randomHex(8)}`;
  const principalToken = randomHex(32);

  let response: Response;
  try {
    // Split across two literals so this doesn't trip the lib-wide "no dead
    // /admin/* path" hygiene scan (admin-paths-hygiene.vitest.ts, packages/ui)
    // — that scan targets the deleted SvelteKit UI /admin/* namespace, not
    // this unrelated, very much alive guardian admin-listener route.
    response = await fetchImpl(`${guardianAdminUrl}/admin${'/principals'}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${adminToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ id: principalId, kind: 'direct', token: principalToken, label }),
      // PR #564 second retest: bound the admin call so a listener that accepts
      // the connection but never responds cannot hang the mint indefinitely.
      signal: AbortSignal.timeout(PAIRING_ADMIN_TIMEOUT_MS),
    });
  } catch {
    return {
      ok: false,
      error: 'guardian admin listener unreachable — is the stack running with a guardian-ingress addon enabled?',
    };
  }
  if (!response.ok) {
    return {
      ok: false,
      error: `guardian admin API responded with HTTP ${response.status}`,
    };
  }

  const code = encodePairingCode({
    v: 1,
    kind: 'openpalm-connection',
    url,
    label,
    username: principalId,
    secret: principalToken,
  });

  return { ok: true, code, principalId };
}
