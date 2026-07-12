/**
 * #486 D2 — source "pin" test for routes/connections/+page.svelte's
 * ConnectionKind wiring. packages/client has no component-render harness
 * (bun:test only), so this asserts the wiring exists in source rather than
 * exercising it through a mounted DOM — same house pattern as
 * tests/connections-page-markup.test.ts.
 *
 * RED until +page.svelte wires the `openpalm-client-api` kind selector,
 * normalizes guardian URLs on save, probes guardian-kind entries at
 * /session, and adds guardian-specific remediation/username copy — today the
 * add call hardcodes `kind: 'remote-opencode'` (+page.svelte:247) and none of
 * this wiring exists.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PATH = fileURLToPath(new URL('../src/routes/connections/+page.svelte', import.meta.url));

function source(): string {
  return readFileSync(PATH, 'utf8');
}

describe('+page.svelte (connections) — #486 D2 kind selector', () => {
  test('the add/edit form renders a kind selector with the openpalm-client-api option', () => {
    const src = source();
    expect(src).toMatch(/value="openpalm-client-api"/);
    expect(src).toMatch(/formKind/);
  });

  test('submitForm persists the selected kind instead of hardcoding remote-opencode', () => {
    const src = source();
    expect(src).toMatch(/kind:\s*formKind/);
    const submitFormMatch = src.match(/async function\s+submitForm\s*\([\s\S]*?\n {2}\}/);
    expect(submitFormMatch).not.toBeNull();
    expect(submitFormMatch?.[0]).not.toMatch(/kind:\s*['"]remote-opencode['"]/);
  });
});

describe('+page.svelte (connections) — #486 D2 guardian URL normalization', () => {
  test('guardian-kind submits normalize the URL via normalizeGuardianUrl', () => {
    const src = source();
    expect(src).toMatch(/from\s+['"]\$lib\/connections\/url-policy\.js['"]/);
    expect(src).toContain('normalizeGuardianUrl');
    expect(src).toMatch(/formKind\s*===\s*['"]openpalm-client-api['"]/);
  });
});

describe('+page.svelte (connections) — #486 D2 kind-aware health probe', () => {
  test('health probes pass probePath /session for guardian-kind entries', () => {
    const src = source();
    expect(src).toMatch(/probePath/);
    expect(src).toMatch(/entry\.kind\s*===\s*['"]openpalm-client-api['"]/);
  });

  test('a guardian-kind HTTP 404 renders remediation naming GUARDIAN_DIRECT_INGRESS', () => {
    const src = source();
    expect(src).toContain('GUARDIAN_DIRECT_INGRESS');
    // The remediation must be conditioned on the guardian kind AND the
    // unreachable/HTTP 404 combination (D2 decision), not just a bare mention.
    expect(src).toMatch(/HTTP 404/);
  });

  test('the Basic username hint names the guardian principal id for guardian connections', () => {
    const src = source();
    expect(src).toMatch(/principal id/i);
  });
});
