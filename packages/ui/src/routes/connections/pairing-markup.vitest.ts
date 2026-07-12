/**
 * Source-pin tests for routes/connections/+page.svelte — pairing UX wiring
 * (#511 D3/D6/D8). Idiom: lib/api/admin-paths-hygiene.vitest.ts (source scan
 * of .svelte files); packages/client/tests/connections-https-refusal.test.ts
 * is the same readFileSync + regex pattern in bun.
 *
 * RED reason (every test): the marker regex has nothing to match — the
 * pairing panel / install affordance are not wired into +page.svelte yet.
 */
import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PAGE_PATH = fileURLToPath(new URL('./+page.svelte', import.meta.url));

function pageSource(): string {
  return readFileSync(PAGE_PATH, 'utf-8');
}

describe('connections +page.svelte — pairing panel wiring (#511)', () => {
  test('wires a Pair-a-device flow through the api helper', () => {
    const src = pageSource();
    expect(src).toMatch(/mintPairingCode\(/);
    expect(src).toMatch(/hasCapability\(\s*['"`]host:stack:write['"`]\s*\)/);
  });

  test('renders the minted QR and one-time code with a shown-once warning', () => {
    const src = pageSource();
    expect(src).toMatch(/qrSvg/);
    expect(src).toMatch(/pairingCode/);
    expect(src).toMatch(/shown only once|won't be shown again/i);
  });

  test('renders an Install OpenPalm app affordance gated by the reachability probe', () => {
    const src = pageSource();
    expect(src).toMatch(/probeClientApp\(/);
    expect(src).toMatch(/clientAppUrl/);
    expect(src).toMatch(/Install OpenPalm app/);
  });

  test('pairing panel copy names the ingress/CORS prerequisites', () => {
    const src = pageSource();
    expect(src).toMatch(/GUARDIAN_CORS_ALLOWED_ORIGINS/);
    expect(src).toMatch(/remote-access-tls\.md|managing-openpalm\.md/);
  });
});
