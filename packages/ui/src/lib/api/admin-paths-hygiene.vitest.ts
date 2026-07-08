/**
 * Phase 4 hygiene — no client code calls or links a `/admin` path (plan
 * ui-runtime-modes-plan.md Phase 4 step 1: "/admin/* → 404, no alias" +
 * "Update lib/api/* client paths accordingly").
 *
 * With the alias gone, ANY surviving quoted '/admin…' path in a domain
 * client or component is a dead call/link: lib/api clients must target
 * /api/host/* and /api/assistant/*, hrefs and pathname checks must target
 * /host, and the login page must post to the relocated session endpoint.
 *
 * RED until Phase 4 lands: 9 lib/api clients and 7 .svelte files still
 * reference /admin paths.
 *
 * Source-level scan, same conventions as features-admin-hygiene.vitest.ts.
 * The match is QUOTED occurrences only ('/admin', "/admin", `/admin — i.e.
 * route-string literals), so prose comments mentioning the legacy namespace
 * don't trip it. routes/admin/** is excluded (that tree is deleted by Phase
 * 4 — its absence is asserted in hooks.server.admin-404.vitest.ts).
 */
import { describe, expect, test } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const API_CLIENT_DIR = fileURLToPath(new URL('./', import.meta.url));

/** A quote character immediately followed by /admin at a path boundary. */
const QUOTED_ADMIN_PATH = /['"`]\/admin(?=['"`/?])/;

function apiClientFiles(): string[] {
  return readdirSync(API_CLIENT_DIR)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.vitest.ts'))
    .map((name) => join(API_CLIENT_DIR, name));
}

function svelteFiles(): string[] {
  return (readdirSync(SRC_ROOT, { recursive: true }) as string[])
    .filter((rel) => rel.endsWith('.svelte'))
    .filter((rel) => !rel.startsWith(join('routes', 'admin') + sep))
    .map((rel) => join(SRC_ROOT, rel));
}

function offendersIn(files: string[]): string[] {
  const offenders: string[] = [];
  for (const file of files) {
    const lines = readFileSync(file, 'utf-8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (QUOTED_ADMIN_PATH.test(lines[i])) {
        offenders.push(`${file.slice(SRC_ROOT.length)}:${i + 1}`);
      }
    }
  }
  return offenders;
}

describe('no /admin paths left in client code (plan Phase 4 step 1)', () => {
  test('the scans see the trees (sanity)', () => {
    // Guards the walkers: an empty file list would make the hygiene
    // assertions below pass vacuously.
    expect(apiClientFiles().length).toBeGreaterThanOrEqual(10);
    expect(svelteFiles().length).toBeGreaterThan(50);
  });

  test('no lib/api domain client requests a /admin path', () => {
    expect(offendersIn(apiClientFiles())).toEqual([]);
  });

  test('no .svelte component (outside the deleted routes/admin tree) references a /admin path', () => {
    expect(offendersIn(svelteFiles())).toEqual([]);
  });
});

describe('login flow stays wired after the move (Phase 4 acceptance: login/session unchanged)', () => {
  test('the login page posts to an existing auth endpoint outside the dead /admin namespace', () => {
    const loginPage = join(SRC_ROOT, 'routes', 'login', '+page.svelte');
    const source = readFileSync(loginPage, 'utf-8');
    const match = source.match(/fetch\(\s*['"`]([^'"`]+)['"`]/);
    expect(match, 'login page must fetch() its auth endpoint').not.toBeNull();

    const path = (match as RegExpMatchArray)[1].split('?')[0];
    expect(path.startsWith('/')).toBe(true);
    expect(path.startsWith('/admin'), `login must not post to the 404 namespace (${path})`).toBe(false);

    // The referenced endpoint must actually exist as a route — the session
    // flow itself is unchanged, only its address moves out of /admin.
    const routeFile = join(SRC_ROOT, 'routes', path.replace(/^\//, ''), '+server.ts');
    expect(existsSync(routeFile), `no +server.ts found for the login endpoint ${path}`).toBe(true);
  });
});
