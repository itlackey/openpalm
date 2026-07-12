/**
 * POST /api/connections/pairing — host-minted QR + one-time pairing code
 * (#511 D3/D4/D6).
 *
 * Minting writes a `direct` principal into the LOCAL stack's guardian — a
 * host-stack mutation, not a connections-list mutation — so this is guarded
 * by `host:stack:write` (D6), NOT `connections:manage`: `pwa-static` mode
 * advertises `connections:manage` (stack-less `openpalm app`) but has no
 * local guardian to mint against, and this endpoint must not exist there.
 * Double-guarded like sibling `/api/connections` writes: the capability
 * check above PLUS the admin session + origin check inside `withAdminBody`.
 *
 * Transport concerns only (sveltekit-rules §1.1, §3.1) — minting itself
 * delegates entirely to `@openpalm/lib`'s `mintDirectPrincipalPairingCode`.
 * The minted secret is returned exactly once, inside `code`; it is never
 * logged and never written to disk by this route.
 */
import type { RequestHandler } from './$types';
import { renderSVG } from 'uqr';
import { mintDirectPrincipalPairingCode, readStackRuntimeEnv } from '@openpalm/lib';
import {
  errorResponse,
  getRequestId,
  jsonResponse,
  requireCapability,
  withAdminBody,
} from '$lib/server/helpers.js';
import { validateConnectionUrl } from '$lib/server/endpoints.js';
import { getState } from '$lib/server/state.js';

function isLoopbackHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

/** Warnings named in the panel copy so the operator knows exactly which env
 *  keys / prerequisites this pairing code depends on (D3 risk 6: the pairing
 *  endpoint never mutates stack env implicitly — it only tells the operator
 *  what to set). */
function computeWarnings(mergedEnv: Record<string, string>, targetUrl: string): string[] {
  const warnings: string[] = [];
  if (mergedEnv.GUARDIAN_DIRECT_INGRESS !== 'true') {
    warnings.push(
      'GUARDIAN_DIRECT_INGRESS is not enabled on this stack — set it to true in stack.env and restart the guardian, or this connection will 404.',
    );
  }
  try {
    const parsed = new URL(targetUrl);
    if (parsed.protocol === 'http:' && !isLoopbackHostname(parsed.hostname)) {
      warnings.push(
        'This URL is plain HTTP, not HTTPS, and not loopback — phones and hosted clients refuse plain-HTTP remote connections. See docs/remote-access-tls.md.',
      );
    }
  } catch {
    // Unparseable URLs are rejected before this point (400 invalid_connection).
  }
  return warnings;
}

export const POST: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const capabilityError = requireCapability(event, 'host:stack:write', requestId);
  if (capabilityError) return capabilityError;

  return withAdminBody(event, async ({ requestId, body }) => {
    const label = typeof body.label === 'string' ? body.label.trim() : '';
    const rawUrl = typeof body.url === 'string' ? body.url : '';
    if (!label) {
      return errorResponse(400, 'invalid_connection', 'label is required', {}, requestId);
    }
    const urlCheck = validateConnectionUrl(rawUrl);
    if (!urlCheck.ok) {
      return errorResponse(400, 'invalid_connection', 'URL must be a valid http(s) URL', {}, requestId);
    }

    const homeDir = getState().homeDir;
    // process.env cast follows the established pattern (hooks.server.ts:60) —
    // Node's ProcessEnv type is `Record<string, string | undefined>`.
    const mergedEnv = { ...readStackRuntimeEnv(homeDir), ...(process.env as Record<string, string>) };
    const guardianAdminUrl = `http://127.0.0.1:${Number(mergedEnv.OP_GUARDIAN_ADMIN_PORT) || 3831}`;

    const result = await mintDirectPrincipalPairingCode({
      homeDir,
      label,
      url: urlCheck.url,
      guardianAdminUrl,
    });

    if (!result.ok) {
      if (result.error.includes('op_guardian_admin_token')) {
        return errorResponse(500, 'pairing_mint_failed', result.error, {}, requestId);
      }
      return errorResponse(502, 'pairing_mint_failed', result.error, {}, requestId);
    }

    const warnings = computeWarnings(mergedEnv, urlCheck.url);
    const qrSvg = renderSVG(result.code);

    return jsonResponse(
      201,
      { code: result.code, principalId: result.principalId, qrSvg, warnings },
      requestId,
    );
  });
};
