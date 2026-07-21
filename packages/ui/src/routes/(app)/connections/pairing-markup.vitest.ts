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
    expect(src).toMatch(/hasCapability\(\s*runtimeContext\s*,\s*['"`]host:stack:write['"`]\s*\)/);
  });

  test('renders the minted QR and one-time code with a shown-once warning', () => {
    const src = pageSource();
    expect(src).toMatch(/qrSvg/);
    expect(src).toMatch(/data:image\/svg\+xml/);
    expect(src).not.toMatch(/\{@html/);
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

  // A fragment-only URL change on an already-open /connections tab is a
  // same-document navigation — onMount never re-runs — so consumption must
  // ALSO be wired to window hashchange, or a #pair= link opened into a live
  // tab is silently ignored and the credential lingers in the URL bar.
  test('consumes #pair= on hashchange, not only on mount', () => {
    const src = pageSource();
    expect(src).toMatch(/<svelte:window[^>]*onhashchange=\{consumePairDeepLink\}/);
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

  test('resolves a reload-safe return context including the active assistant fallback', () => {
    const src = pageSource();
    expect(src).toMatch(/page\.url\.searchParams\.get\(\s*['"`]returnTo['"`]\s*\)/);
    expect(src).toMatch(/resolveReturnToPath/);
    expect(src).toMatch(/buildChatPath/);
    expect(src).toMatch(/buildAdvancedPath/);
    expect(src).toMatch(/connectionsService\.activeId/);
  });

  test('splits settings into General and Connections tabs', () => {
    const src = pageSource();
    expect(src).toMatch(
      /<Navbar brandHref=\{chatReturnHref\} showUtilities=\{false\} \/>[\s\S]*<DeviceSettingsNav \{chatReturnHref\} \{activeTab\} onTabChange=\{selectSettingsTab\} \/>[\s\S]*<main/,
    );
    expect(src).not.toMatch(/ChatNavbar/);
    expect(src).toMatch(/<h1>Settings<\/h1>/);
    expect(src).toMatch(/id="settings-panel-connections"/);
    expect(src).toMatch(/id="settings-panel-general"/);
    expect(src).toMatch(/activeTab === 'connections'/);
    expect(src).toMatch(/<VoiceClientSettings \/>/);
    expect(src).toMatch(/themeService\.setPreference/);
  });

  test('opens connection deep links in the Connections tab', () => {
    const src = pageSource();
    expect(src).toMatch(/searchParams\.get\(\s*['"`]new['"`]\s*\)[\s\S]*?['"`]connections['"`]/);
    expect(src).toMatch(/pairCode[\s\S]*activeTab\s*=\s*['"`]connections['"`]/);
  });

  test('links clearly to host management when host controls are available', () => {
    const src = pageSource();
    expect(src).toMatch(/hasCapability\(\s*runtimeContext\s*,\s*['"`]host:stack:read['"`]\s*\)/);
    expect(src).toMatch(/buildReturnToPath\(resolve\(\s*['"`]\/host['"`]\s*\), chatReturnHref\)/);
    expect(src).toMatch(/href=\{hostSettingsHref\}[\s\S]*?>Manage host/);
  });

  test('retains new-connection and fragment pairing behavior alongside return context', () => {
    const src = pageSource();
    expect(src).toMatch(/page\.url\.searchParams\.get\(\s*['"`]new['"`]\s*\)\s*===\s*['"`]1['"`]/);
    expect(src).toMatch(/new SvelteURLSearchParams\(page\.url\.searchParams\)/);
    expect(src).toMatch(
      /replaceState\(\s*`\$\{page\.url\.pathname\}\?\$\{searchParams\}`\s*,\s*\{\}\s*\)/,
    );
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
