/**
 * #557 D1/D3/D4/D7 — source + doc "pin" tests for the client-side HTTPS
 * enforcement UI and the new `docs/remote-access-tls.md` guide. Modeled on
 * the house pattern of connections-page-markup.test.ts (packages/client has
 * no component-render harness, so wiring is asserted against the raw
 * `.svelte`/`.md` source via readFileSync + regex — see also
 * assistant-client-compose.test.ts:213-218 for the repo-root-relative doc
 * read from a package test).
 *
 * RED reasons (per row):
 *   - the +page.svelte pins fail because the form/badge/placeholder wiring
 *     to validateConnectionUrl()/TLS_GUIDE_URL does not exist yet;
 *   - the guide pins fail because docs/remote-access-tls.md does not exist;
 *   - the ui-runtime-modes.md pin fails because the doc still carries the
 *     pre-#557 "policy, not yet enforcement" paragraph.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PAGE = fileURLToPath(new URL('../src/routes/connections/+page.svelte', import.meta.url));
const GUIDE = fileURLToPath(new URL('../../../docs/remote-access-tls.md', import.meta.url));
const MODES_DOC = fileURLToPath(new URL('../../../docs/technical/ui-runtime-modes.md', import.meta.url));

function pageSource(): string {
  return readFileSync(PAGE, 'utf8');
}

describe('+page.svelte (connections) — #557 client-side HTTPS refusal wiring', () => {
  test('validates the URL through validateConnectionUrl before saving', () => {
    const src = pageSource();
    expect(src).toMatch(/validateConnectionUrl\(/);
    expect(src).toMatch(/from\s+['"]\$lib\/connections\/url-policy\.js['"]/);
  });

  test('an insecure health state renders badge text distinct from "unreachable"', () => {
    const src = pageSource();
    expect(src).toMatch(/state\s*===\s*['"]insecure['"]/);
    expect(src).toMatch(/needs HTTPS/i);
  });

  test('the insecure remediation deep-links the TLS guide', () => {
    const src = pageSource();
    expect(src).toContain('TLS_GUIDE_URL');
    expect(src).toMatch(/<a[^>]+href=\{TLS_GUIDE_URL\}/);
  });

  test('the form URL placeholder is no longer a plain-HTTP LAN example', () => {
    const src = pageSource();
    expect(src).not.toContain('placeholder="http://10.0.0.5:8443"');
    expect(src).toMatch(/placeholder="https:\/\//);
  });
});

describe('docs/remote-access-tls.md (#557 D3/D4)', () => {
  test('the TLS guide exists at the path TLS_GUIDE_URL names', () => {
    expect(() => readFileSync(GUIDE, 'utf8')).not.toThrow();
  });

  test('the guide documents the Tailscale default and the Caddy alternative under stable anchors', () => {
    const src = readFileSync(GUIDE, 'utf8');
    expect(src).toContain('## Tailscale (recommended)');
    expect(src).toContain('## Caddy with your own domain');
  });

  test('the guide names the exact env knobs', () => {
    const src = readFileSync(GUIDE, 'utf8');
    expect(src).toContain('GUARDIAN_DIRECT_INGRESS');
    expect(src).toContain('GUARDIAN_CORS_ALLOWED_ORIGINS');
  });

  test('the guide states the private-CA non-goal and the mTLS coexistence rule', () => {
    const src = readFileSync(GUIDE, 'utf8');
    expect(src).toMatch(/private CA/i);
    expect(src).toMatch(/mTLS/);
  });
});

describe('docs/technical/ui-runtime-modes.md (#557 D5)', () => {
  test('no longer calls HTTPS-for-remote "policy, not yet enforcement"', () => {
    const src = readFileSync(MODES_DOC, 'utf8');
    expect(src).not.toContain('policy, not yet');
    expect(src).toContain('validateConnectionUrl');
  });
});
