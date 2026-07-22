/**
 * Source-pin tests for routes/connections/+page.svelte — pairing UX wiring
 * (#511 D3/D6). Idiom: lib/api/admin-paths-hygiene.vitest.ts — a readFileSync +
 * regex scan of the .svelte source.
 */
import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PAGE_PATH = fileURLToPath(new URL('./+page.svelte', import.meta.url));

function pageSource(): string {
  return readFileSync(PAGE_PATH, 'utf-8');
}

function submitFormSource(src: string): string {
  const start = src.indexOf('async function submitForm');
  expect(start).toBeGreaterThan(-1);
  const end = src.slice(start).search(/\n\s+async function activate/);
  expect(end).toBeGreaterThan(0);
  return src.slice(start, start + end);
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

  test('routes fragment pairing to the verified onboarding wizard without parsing or saving locally', () => {
    const src = pageSource();
    expect(src).toMatch(/window\.location\.hash/);
    expect(src).toMatch(/const fragment = includeFragment \? window\.location\.hash : ['"]{2}/);
    expect(src).toMatch(/goto\([\s\S]*\/connections\/new[\s\S]*replaceState:\s*true/);
    expect(src).not.toMatch(/parsePairingCode|applyPairingPayload|applyPairingPaste/);
    expect(src).not.toMatch(/searchParams\.get\(\s*['"`]pair['"`]\s*\)/);
    expect(src).not.toMatch(/\?pair=/);
  });

  // A fragment-only URL change on an already-open /connections tab is a
  // same-document navigation — onMount never re-runs — so consumption must
  // ALSO be wired to window hashchange, or a #pair= link opened into a live
  // tab is silently ignored and the credential lingers in the URL bar.
  test('routes #pair= on hashchange, not only on mount', () => {
    const src = pageSource();
    expect(src).toMatch(/<svelte:window[^>]*onhashchange=\{routePairDeepLink\}/);
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
      /<Navbar brandHref=\{chatReturnHref\} showUtilities=\{false\}>[\s\S]*<SurfaceToolbar[\s\S]*conversationHref=\{chatReturnHref\}[\s\S]*settingsCurrent[\s\S]*<DeviceSettingsNav \{activeTab\} onTabChange=\{selectSettingsTab\} \/>[\s\S]*<main/,
    );
    expect(src).not.toMatch(/ChatNavbar/);
    expect(src).toMatch(/<h1>Settings<\/h1>/);
    expect(src).toMatch(/id="settings-panel-connections"/);
    expect(src).toMatch(/id="settings-panel-general"/);
    expect(src).toMatch(/activeTab === 'connections'/);
    expect(src).toMatch(/<VoiceClientSettings \/>/);
    expect(src).toMatch(/themeService\.setPreference/);
  });

  test('routes legacy ?new=1 entry to the dedicated wizard', () => {
    const src = pageSource();
    expect(src).toMatch(/searchParams\.get\(\s*['"`]new['"`]\s*\)\s*===\s*['"`]1['"`][\s\S]*routeNewConnection/);
    expect(src).toMatch(/href=\{resolve\(\s*['"`]\/connections\/new['"`]\s*\)\}[\s\S]*Add connection/);
  });

  test('prioritizes a pairing fragment over ?new=1 so the code is not dropped', () => {
    const src = pageSource();
    const mount = src.slice(src.indexOf('onMount(() => {'), src.indexOf('\n  function routeNewConnection'));
    expect(mount.indexOf('routePairDeepLink()')).toBeLessThan(
      mount.indexOf("page.url.searchParams.get('new')"),
    );
  });

  test('validates the current form URL before any secret or connection mutation', () => {
    const body = submitFormSource(pageSource());
    const validationIndex = body.indexOf('validateConnectionUrl(url)');
    expect(validationIndex).toBeGreaterThan(-1);
    for (const mutation of [
      'getConnectionStore()',
      'getSecretStore()',
      'updateManagedConnection(',
    ]) {
      expect(body.indexOf(mutation), mutation).toBeGreaterThan(validationIndex);
    }
  });

  test('surfaces policy errors and renders the insecure-remote TLS guide link', () => {
    const src = pageSource();
    const body = submitFormSource(src);
    expect(src).toMatch(/<form class="connection-form" novalidate onsubmit=\{submitForm\}>/);
    expect(body).toMatch(
      /if\s*\(!urlVerdict\.ok\)\s*\{[\s\S]*formError\s*=\s*urlVerdict\.message[\s\S]*return;\s*\}/,
    );
    expect(body).toMatch(/urlVerdict\.reason\s*===\s*['"]insecure-remote['"]/);
    expect(body).toMatch(/urlVerdict\.guideUrl/);
    expect(src).toMatch(/href=\{formGuideUrl\}[\s\S]*Open the TLS setup guide/);
  });

  test('keeps edit management but has no direct new-connection persistence path', () => {
    const src = pageSource();
    expect(src).toMatch(/openEditForm/);
    expect(submitFormSource(src)).toMatch(/updateManagedConnection\(/);
    expect(submitFormSource(src)).not.toMatch(/store\.update\(/);
    expect(submitFormSource(src)).not.toMatch(/store\.add\(/);
    expect(src).not.toMatch(/formMode\s*===\s*['"]add['"]|openAddForm|pairingPasteCode/);
  });

  test('requires storage disclosure before writing a new password during edit', () => {
    const src = pageSource();
    expect(src).toMatch(/getConnectionStorageMode/);
    expect(src).toMatch(/connectionSecretsEncryptedAtRest/);
    expect(src).toMatch(/formDisclosurePending/);
    expect(src).toMatch(/cannot protect saved passwords/i);
    expect(src).toMatch(/updateManagedConnection/);
  });

  test('delegates removal to connection-first transactional management', () => {
    const src = pageSource();
    expect(src).toMatch(/removeManagedConnection\(/);
    const removeBody = src.slice(src.indexOf('async function remove('), src.indexOf('\n  function setTheme'));
    expect(removeBody).not.toMatch(/getSecretStore\(\)\.delete/);
    expect(removeBody).not.toMatch(/store\.remove/);
  });

  test('links clearly to host management when host controls are available', () => {
    const src = pageSource();
    expect(src).toMatch(/hasCapability\(\s*runtimeContext\s*,\s*['"`]host:stack:read['"`]\s*\)/);
    expect(src).toMatch(/buildReturnToPath\(resolve\(\s*['"`]\/host['"`]\s*\), chatReturnHref\)/);
    expect(src).toMatch(/hostHref=\{hasCapability\(runtimeContext, 'host:stack:read'\) \? hostSettingsHref : undefined\}/);
    expect(src).not.toMatch(/Return to conversation/);
    expect(src).not.toMatch(/>Manage host/);
  });

  test('offers PWA installation only on non-admin client surfaces', () => {
    const src = pageSource();
    expect(src).toMatch(
      /hasCapability\(runtimeContext, 'pwa:install'\)\s*&&\s*!hasCapability\(runtimeContext, 'host:stack:read'\)/,
    );
  });

  test('preserves return context while routing legacy new-connection entry', () => {
    const src = pageSource();
    expect(src).toMatch(/page\.url\.searchParams\.get\(\s*['"`]new['"`]\s*\)\s*===\s*['"`]1['"`]/);
    expect(src).toMatch(/new SvelteURLSearchParams\(page\.url\.searchParams\)/);
    expect(src).toMatch(/searchParams\.delete\(\s*['"]new['"]\s*\)/);
  });

  test('pairing panel copy names the ingress/CORS prerequisites', () => {
    const src = pageSource();
    expect(src).toMatch(/GUARDIAN_CORS_ALLOWED_ORIGINS/);
    expect(src).toMatch(/remote-access-tls\.md|managing-openpalm\.md/);
  });

  test('directs receiving devices to the dedicated connection wizard', () => {
    const src = pageSource();
    expect(src).toMatch(/On the other device, open Connect to OpenPalm and paste this code/);
    expect(src).not.toMatch(/open the connections page and paste this code/i);
  });
});
