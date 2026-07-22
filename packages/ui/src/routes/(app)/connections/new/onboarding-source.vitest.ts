import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const PAGE = fileURLToPath(new URL('./+page.svelte', import.meta.url));
const LOAD = fileURLToPath(new URL('./+page.ts', import.meta.url));

describe('/connections/new onboarding source', () => {
  test('is a dedicated pairing-first wizard, not a Settings redirect', () => {
    const page = readFileSync(PAGE, 'utf-8');
    const load = readFileSync(LOAD, 'utf-8');
    expect(load).not.toMatch(/redirect\(/);
    expect(load).toMatch(/export const ssr = false/);
    expect(page).toMatch(/Connect to OpenPalm/i);
    expect(page).toMatch(/Pairing code/i);
    expect(page).toMatch(/Enter an address instead/i);
    expect(page.indexOf('Pairing code')).toBeLessThan(page.indexOf('Enter an address instead'));
  });

  test('uses event handlers without $effect and preserves form state across mode changes', () => {
    const page = readFileSync(PAGE, 'utf-8');
    expect(page).not.toContain('$effect');
    expect(page).toMatch(/onclick=.*showManual|onclick=.*showPairing/);
    expect(page).not.toMatch(/show(?:Manual|Pairing)[\s\S]{0,300}(?:pairingCode|formUrl|formPassword)\s*=\s*['"]{2}/);
    expect(page).toMatch(/tick\(\)/);
    expect(page).toMatch(/\.focus\(\)/);
  });

  test('consumes pair only from the fragment and immediately strips it with query state intact', () => {
    const page = readFileSync(PAGE, 'utf-8');
    expect(page).toMatch(/pairingFragment\(new URL\(window\.location\.href\)\)/);
    expect(page).toMatch(/replaceState\(consumed\.cleanPath/);
    expect(page).not.toMatch(/page\.url\.searchParams\.get\(['"]pair['"]\)/);
    expect(page).not.toMatch(/\?pair=/);
    expect(page).toMatch(/<svelte:window[^>]*onhashchange=\{consumePairDeepLink\}/);
  });

  test('verifies before saving, wires existing browser-owned services, and replace-navigates only on success', () => {
    const page = readFileSync(PAGE, 'utf-8');
    expect(page).toMatch(/verifyConnectionCandidate\(/);
    expect(page).toMatch(/saveVerifiedConnection\(/);
    expect(page).toMatch(/getConnectionStore\(\)/);
    expect(page).toMatch(/getSecretStore\(\)/);
    expect(page).toMatch(/connectionsService\.activate/);
    expect(page).toMatch(/connectionsService\.load\(true\)/);
    expect(page).toMatch(/if\s*\(!saved\.ok\)[\s\S]*?return;[\s\S]*?goto\([\s\S]*?replaceState:\s*true/);
  });

  test('discloses storage limits without implementation jargon or keychain claims', () => {
    const page = readFileSync(PAGE, 'utf-8');
    expect(page).toMatch(/session-only/i);
    expect(page).toMatch(/cannot protect saved passwords/i);
    expect(page).toMatch(/getConnectionStorageMode/);
    expect(page).toMatch(/connectionSecretsEncryptedAtRest/);
    const markup = page.slice(page.indexOf('</script>'));
    expect(markup).not.toMatch(/keychain|SubtleCrypto|plaintext|Guardian|CORS|base64url|JSON|kind/i);
    expect(page).not.toMatch(/console\./);
  });

  test('announces and focuses consequential transitions and provides context-aware cancel routing', () => {
    const page = readFileSync(PAGE, 'utf-8');
    expect(page).toMatch(/role="alert"[^>]*aria-labelledby="storage-warning-title"/);
    expect(page).toMatch(/searchParams\.get\(['"]onboarding['"]\)\s*===\s*['"]1['"]/);
    expect(page).toMatch(/requestAnimationFrame/);
    expect(page).toMatch(/hasCapability\(runtimeContext, ['"]host:setup['"]\)/);
    expect(page).toMatch(/resolve\(['"]\/start['"]\)/);
    expect(page).toMatch(/resolve\(['"]\/connections['"]\)/);
  });

  test('cancels stale verification and disables Back during persistence', () => {
    const page = readFileSync(PAGE, 'utf-8');
    expect(page).toMatch(/onDestroy/);
    expect(page).toMatch(/operationGeneration/);
    expect(page).toMatch(/disabled=\{persisting\}/);
    expect(page).toMatch(/if \(operation !== operationGeneration\) return/);
  });

  test('uses theme-safe primary contrast and a reduced-motion override', () => {
    const page = readFileSync(PAGE, 'utf-8');
    expect(page).toMatch(/button\.primary\s*\{[\s\S]*color:\s*var\(--s-paper\)/);
    expect(page).not.toMatch(/button\.primary\s*\{[\s\S]*?color:\s*white/);
    expect(page).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  });
});
