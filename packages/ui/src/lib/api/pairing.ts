import { request, requireOk } from './core.js';

// ── Device pairing (host-minted) ─────────────────────────────────────────────
//
// The browser owns connections and only ever IMPORTS pairing codes (decoded by
// `$lib/connections/pairing.ts`). Minting a one-time code is a host-stack
// mutation that stays server-side: `POST /api/connections/pairing` writes a
// `direct` principal into the local guardian, guarded by `host:stack:write`.
// This is the only surviving `/api/connections/*` browser call.

/** #511 D3/D4/D6: mint a one-time device-pairing QR/code via the host's
 *  guardian admin API. `host:stack:write`-gated server-side; UI-gated the
 *  same way via `hasCapability('host:stack:write')`. */
export async function mintPairingCode(input: {
  label: string;
  url: string;
}): Promise<{ code: string; principalId: string; qrSvg: string | null; warnings: string[] }> {
  // PR #564 retest P3-3: `qrSvg` is `string | null` — the route returns null when
  // SVG rendering fails, and the client must not orphan the (usable) text code by
  // typing it as a non-null string. Callers fall back to the code on null.
  const res = await requireOk(await request('POST', '/api/connections/pairing', input));
  return (await res.json()) as { code: string; principalId: string; qrSvg: string | null; warnings: string[] };
}
