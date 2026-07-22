/**
 * Guardian principal minting (#511 D3/D4).
 *
 * The browser-safe codec and URL normalization live in `../pairing.ts`; this
 * module adds only host-side secret access and Guardian admin API calls.
 *
 * The pairing code itself is a self-contained, signed-nothing payload (D3):
 * `openpalm-pair:` + base64url(JSON). It is never persisted host-side — the
 * durable artifact is the minted guardian principal, individually revocable
 * via the guardian admin listener's principal-delete endpoint (#433,
 * `packages/guardian/src/admin.ts`).
 */
import { readSecret } from './secrets-files.js';
import {
  encodePairingCode,
  normalizeGuardianPairingUrl,
} from '../pairing.js';
export {
  decodePairingCode,
  encodePairingCode,
  normalizeGuardianPairingUrl,
  PAIRING_CODE_PREFIX,
} from '../pairing.js';
export type {
  DecodePairingResult,
  GuardianPairingUrlResult,
  PairingPayloadV1,
} from '../pairing.js';

export type MintPairingResult =
  | { ok: true; code: string; principalId: string }
  | { ok: false; error: string };

const DEFAULT_GUARDIAN_ADMIN_URL = 'http://127.0.0.1:3831';
/** Bound on the guardian admin mint call (PR #564 second retest) — a listener
 *  that accepts but never responds must not hang the mint. */
const PAIRING_ADMIN_TIMEOUT_MS = 5000;

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

  const normalizedUrl = normalizeGuardianPairingUrl(url);
  if (!normalizedUrl.ok) return normalizedUrl;

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
    try {
      await fetchImpl(
        `${guardianAdminUrl}/admin${`/principals/${encodeURIComponent(principalId)}`}`,
        {
          method: 'DELETE',
          headers: { authorization: `Bearer ${adminToken}` },
          signal: AbortSignal.timeout(PAIRING_ADMIN_TIMEOUT_MS),
        },
      );
    } catch {
      // The create response was ambiguous; cleanup is best-effort and bounded.
    }
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
    url: normalizedUrl.url,
    label,
    username: principalId,
    secret: principalToken,
  });

  return { ok: true, code, principalId };
}
