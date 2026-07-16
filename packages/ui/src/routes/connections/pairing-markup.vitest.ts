/**
 * Source-pin tests for routes/connections/+page.svelte — pairing UX wiring
 * (#511 D3/D6). Idiom: lib/api/admin-paths-hygiene.vitest.ts — a readFileSync +
 * regex scan of the .svelte source.
 */
import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PAGE_PATH = fileURLToPath(new URL('./+page.svelte', import.meta.url));
const HOST_PAGE_PATH = fileURLToPath(new URL('../host/+page.svelte', import.meta.url));

function pageSource(): string {
  return readFileSync(PAGE_PATH, 'utf-8');
}

describe('connections +page.svelte — host UX and pairing wiring', () => {
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

  // PR #564 P1-7: the pairing deep link must ride in the URL FRAGMENT, not the
  // query string. The browser never sends the fragment to the UI's static
  // host, so the durable credential stays out of access logs, reverse proxies,
  // and Referer headers. Consumption still strips it from history.
  test('consumes the pairing code from the URL fragment, never the query string', () => {
    const src = pageSource();
    // Reads the code from the hash and advertises the #pair= fragment form.
    expect(src).toMatch(/window\.location\.hash/);
    expect(src).toMatch(/#pair=/);
    // Still strips the credential from history after consuming it.
    expect(src).toMatch(/replaceState\(/);
    // No longer reads or advertises the credential-leaking ?pair= query param.
    expect(src).not.toMatch(/searchParams\.get\(\s*['"`]pair['"`]\s*\)/);
    expect(src).not.toMatch(/searchParams\.delete\(\s*['"`]pair['"`]\s*\)/);
    expect(src).not.toMatch(/\?pair=/);
  });

  // PR #564 retest P3-3: qrSvg is string|null; the panel must fall back to the
  // text code (not render a null SVG) when the host could not generate the QR.
  test('falls back to the text code when qrSvg is null', () => {
    const src = pageSource();
    // The QR block is conditional on a truthy qrSvg, with an else fallback.
    expect(src).toMatch(/\{#if pairingQrSvg\}/);
    expect(src).toMatch(/\{:else\}/);
    // State typed to allow null (never a bare '' that hides the null case).
    expect(src).toMatch(/pairingQrSvg\s*=\s*\$state<string \| null>/);
  });

  test('provides a visible route back to host admin with a chat fallback', () => {
    const src = pageSource();
    expect(src).toMatch(/hasCapability\(\s*['"`]host:stack:read['"`]\s*\)/);
    expect(src).toMatch(/runtimeContext\.routes\.host/);
    expect(src).toMatch(/runtimeContext\.routes\.chat/);
    expect(src).toMatch(/aria-label=\{exitLabel\}>← \{exitLabel\}/);
    expect(src).toMatch(/'Back to Admin'/);
    expect(src).toMatch(/'Back to Chat'/);
  });

  test('does not advertise installing the client app from host UI surfaces', () => {
    const sources = [pageSource(), readFileSync(HOST_PAGE_PATH, 'utf-8')];
    for (const src of sources) {
      expect(src).not.toMatch(/Install OpenPalm app/);
      expect(src).not.toMatch(/app-install-banner|class="install-app"/);
    }
  });

  test('pairing panel copy names the ingress/CORS prerequisites', () => {
    const src = pageSource();
    expect(src).toMatch(/GUARDIAN_CORS_ALLOWED_ORIGINS/);
    expect(src).toMatch(/remote-access-tls\.md|managing-openpalm\.md/);
  });
});
