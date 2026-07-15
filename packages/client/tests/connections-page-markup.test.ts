/**
 * E3 (UI half)/E6/E9/G3/G4 (review 2026-07-10) — source "pin" test for
 * routes/connections/+page.svelte. packages/client has no component-render
 * harness (bun:test only — see chat-page-markup.test.ts/
 * sessions-drawer-markup.test.ts for the same house pattern), so this
 * asserts the wiring exists in source rather than exercising it through a
 * mounted DOM.
 *
 * RED until +page.svelte:
 *   - distinguishes health.state === 'blocked'/'cors' from bare
 *     "unreachable" with a distinct badge + remediation text naming
 *     GUARDIAN_CORS_ALLOWED_ORIGINS and GUARDIAN_DIRECT_INGRESS (E3 UI half,
 *     review §E3/§I4),
 *   - offers a "Set credentials" affordance on locked entries that calls
 *     store.setSecretRef() rather than the locked-rejecting update() (E6),
 *   - loads the stored username into the edit form via peekUsername() and
 *     preserves it via updateUsername() when the password isn't retyped
 *     (E9),
 *   - wraps the add/edit/credentials form in the ui-kit Drawer (G3's
 *     promoted focus-trap) instead of an inline expand-in-place block with
 *     no focus management,
 *   - gives the credentials-lock badge an accessible name (G4).
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PATH = fileURLToPath(new URL('../src/routes/connections/+page.svelte', import.meta.url));

function source(): string {
  return readFileSync(PATH, 'utf8');
}

describe('+page.svelte (connections) — E3 CORS-blocked health badge (UI half)', () => {
  test('a blocked/cors health state renders text distinct from "unreachable"', () => {
    const src = source();
    expect(src).toMatch(/state\s*===\s*['"]blocked['"]/);
    expect(src).toMatch(/blocked \(CORS\)/i);
  });

  test('remediation text names both guardian env vars', () => {
    const src = source();
    expect(src).toContain('GUARDIAN_CORS_ALLOWED_ORIGINS');
    expect(src).toContain('GUARDIAN_DIRECT_INGRESS');
  });
});

describe('+page.svelte (connections) — E6 credentials on locked entries', () => {
  test('locked entries get a "Set credentials" affordance', () => {
    const src = source();
    expect(src).toMatch(/Set credentials/);
  });

  test('submitting credentials for a locked entry calls store.setSecretRef, not the locked-rejecting update()', () => {
    const src = source();
    expect(src).toContain('.setSecretRef(');
  });

  test("a locked entry's URL/label stay immutable in the credentials-only form (no editable url/label inputs outside edit mode)", () => {
    const src = source();
    // The credentials-only mode must exist as its own branch distinct from
    // 'add'/'edit' so identity fields are never wired to store.update() for
    // a locked entry.
    expect(src).toMatch(/formMode\s*===\s*['"]credentials['"]/);
  });
});

describe('+page.svelte (connections) — E9 username load/preserve', () => {
  test('loads stored username via secrets.peekUsername when opening the edit form', () => {
    const src = source();
    expect(src).toContain('peekUsername');
  });

  test('preserves the unedited username half via secrets.updateUsername rather than dropping it', () => {
    const src = source();
    expect(src).toContain('updateUsername');
  });
});

describe('+page.svelte (connections) — G3 focus management', () => {
  test('reuses the ui-kit Drawer (G3 promoted focus-trap), not an inline expand-in-place form', () => {
    const src = source();
    expect(src).toMatch(/from\s+['"]@openpalm\/ui-kit\/components\/common\/Drawer\.svelte['"]/);
    expect(src).toMatch(/<Drawer\b/);
  });

  test('the Drawer receives an onClose that also serves as Cancel (Escape closes, restoring focus to the invoker)', () => {
    const src = source();
    expect(src).toMatch(/onClose=\{cancelForm\}/);
  });
});

describe('+page.svelte (connections) — G4 lock badge accessible name', () => {
  test('the credentials-lock badge is not icon-only: it carries role="img" + aria-label', () => {
    const src = source();
    expect(src).toMatch(/badge password[\s\S]{0,200}role="img"/);
    expect(src).toMatch(/badge password[\s\S]{0,200}aria-label="[^"]+"/);
  });
});

describe('+page.svelte (connections) — E7 residual-exposure form copy', () => {
  test('the credential fields document that this browser is the trust boundary', () => {
    const src = source();
    expect(src).toMatch(/this browser/i);
  });
});

describe('+page.svelte (connections) — S3 openEditForm/openCredentialsForm dedup', () => {
  // S3 (review of PR #562): openCredentialsForm() was a byte-identical copy
  // of openEditForm() except for which formMode it set. Collapsed into one
  // openEntryForm(entry, mode) helper — openAddForm stays separate (it is
  // genuinely different: no entry to prefill from, no peekUsername lookup).
  test('a single openEntryForm(entry, mode) helper backs both Edit and Set credentials', () => {
    const src = source();
    expect(src).toMatch(/async function\s+openEntryForm\s*\(/);
  });

  test('the Edit button opens the shared helper in "edit" mode', () => {
    const src = source();
    expect(src).toMatch(/openEntryForm\(conn,\s*['"]edit['"]\)/);
  });

  test('the "Set credentials" button opens the shared helper in "credentials" mode', () => {
    const src = source();
    expect(src).toMatch(/openEntryForm\(conn,\s*['"]credentials['"]\)/);
  });

  test('openEditForm/openCredentialsForm no longer exist as separate duplicated functions', () => {
    const src = source();
    expect(src).not.toMatch(/async function\s+openEditForm\s*\(/);
    expect(src).not.toMatch(/async function\s+openCredentialsForm\s*\(/);
  });

  test('openAddForm is untouched — it stays its own function (genuinely different: no entry to prefill)', () => {
    const src = source();
    expect(src).toMatch(/function\s+openAddForm\s*\(/);
  });

  test('the shared helper still awaits loadStoredUsername to prefill the username in both modes', () => {
    const src = source();
    const match = src.match(/async function\s+openEntryForm\s*\([\s\S]*?\n {2}\}/);
    expect(match).not.toBeNull();
    expect(match?.[0]).toContain('await loadStoredUsername(entry)');
  });
});

describe('+page.svelte (connections) — accessible exit', () => {
  test('offers chat only for an active connection and a safe setup landing when none exist', () => {
    const src = source();
    expect(src).toMatch(/\{#if activeId\}[\s\S]*href="\/chat"/);
    expect(src).toMatch(/connections\.length === 0[\s\S]*href="\/connections\/new"/);
    expect(src).toContain('Back to chat');
    expect(src).toContain('Set up a connection');
    expect(src).toContain('Choose a connection to chat');
  });

  test('deleting the active connection deterministically selects a remaining entry or routes to setup', () => {
    const src = source();
    expect(src).toContain('const removingActive = entry.id === activeId');
    expect(src).toMatch(/remaining\.length > 0[\s\S]*store\.setActive\(next\.id\)/);
    expect(src).toMatch(/remaining\.length === 0[\s\S]*openAddForm\(\)[\s\S]*goto\('\/connections\?new=1'/);
  });
});
