/**
 * Phase 4 hygiene — no client code calls or links a `/admin` path: /admin/* → 404,
 * no alias, and lib/api/* client paths are updated accordingly.
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
const REPO_ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));

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

describe('no /admin paths left in client code', () => {
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

// Review 2026-07-10 F1: the shipped skills ship to every user install
// (assistant-visible skills/docs). A dead /admin path there is worse than one
// in our own source — it's advice we hand to the assistant that drives a live
// "why isn't my connection working?" flow straight into a 404. Scanned as
// plain text (not just .md) so future skill file types are covered without
// editing this walker. They live in the MANAGED system/ tree now, which is
// what gives them an update channel.
const SKELETON_SKILLS_DIR = fileURLToPath(
  new URL('../../../../skeleton/system/skills/', import.meta.url)
);

function skillFiles(): string[] {
  if (!existsSync(SKELETON_SKILLS_DIR)) return [];
  return (readdirSync(SKELETON_SKILLS_DIR, { recursive: true }) as string[])
    .filter((rel) => /\.(md|ts|js|json)$/.test(rel))
    .map((rel) => join(SKELETON_SKILLS_DIR, rel));
}

// Knowledge files are prose/markdown, not JS/TS source, so an endpoint
// mention typically isn't quote-delimited (e.g. `` `GET /admin/config/validate` ``
// wraps the whole "GET /admin/..." phrase in one pair of backticks — the
// backtick sits before "GET", not before "/admin"). Match the bare path
// instead: a path-shaped /admin/<segment> anywhere in the line.
const BARE_ADMIN_PATH = /\/admin\/[a-zA-Z][\w-]*/;

function bareOffendersRelativeTo(files: string[], base: string): string[] {
  const offenders: string[] = [];
  for (const file of files) {
    const lines = readFileSync(file, 'utf-8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (BARE_ADMIN_PATH.test(lines[i])) {
        offenders.push(`${file.slice(base.length)}:${i + 1}`);
      }
    }
  }
  return offenders;
}

function bareOffendersIn(files: string[]): string[] {
  return bareOffendersRelativeTo(files, SKELETON_SKILLS_DIR);
}

describe('no /admin paths left in the shipped skills (review 2026-07-10 F1)', () => {
  test('the scan sees the tree (sanity)', () => {
    expect(skillFiles().length).toBeGreaterThanOrEqual(5);
  });

  test('no shipped skill/doc under packages/skeleton/system/skills references a dead /admin path', () => {
    expect(bareOffendersIn(skillFiles())).toEqual([]);
  });
});

// Review 2026-07-10 F4: one-time stale-reference sweep after the Phase 4
// /admin -> /api/host rename found dead /admin/voice, /admin/providers/
// import-host, /admin/versions, /admin/automations comments surviving in
// packages/electron and packages/lib (and a stale playwright.config.ts
// comment) — files the earlier walkers above never looked at because they
// only cover packages/ui/src. Extend the sweep so shipped comments in the
// harness/lib packages can't drift back to the dead namespace unnoticed.
// Scoped to comment/doc-string prose (bare paths, same convention as the F1
// skeleton-knowledge scan below) since these packages' actual route CALLS
// were never on /admin in the first place — only their comments went stale.
const ELECTRON_SRC_DIR = fileURLToPath(new URL('../../../../electron/src/', import.meta.url));
const LIB_SRC_DIR = fileURLToPath(new URL('../../../../lib/src/', import.meta.url));
const PLAYWRIGHT_CONFIGS = [
  fileURLToPath(new URL('../../../playwright.config.ts', import.meta.url)),
  fileURLToPath(new URL('../../../../cli/playwright.config.ts', import.meta.url)),
  fileURLToPath(new URL('../../../../client/playwright.config.ts', import.meta.url)),
].filter((p) => existsSync(p));

function tsFilesUnder(root: string): string[] {
  if (!existsSync(root)) return [];
  return (readdirSync(root, { recursive: true }) as string[])
    .filter((rel) => rel.endsWith('.ts'))
    .map((rel) => join(root, rel));
}

describe('no stale /admin path comments in electron/lib/playwright-config (review 2026-07-10 F4)', () => {
  test('the scans see the trees (sanity)', () => {
    expect(tsFilesUnder(ELECTRON_SRC_DIR).length).toBeGreaterThan(10);
    expect(tsFilesUnder(LIB_SRC_DIR).length).toBeGreaterThan(10);
    expect(PLAYWRIGHT_CONFIGS.length).toBeGreaterThanOrEqual(1);
  });

  test('packages/electron/src has no dead /admin path reference', () => {
    expect(bareOffendersRelativeTo(tsFilesUnder(ELECTRON_SRC_DIR), ELECTRON_SRC_DIR)).toEqual([]);
  });

  test('packages/lib/src has no dead /admin path reference', () => {
    expect(bareOffendersRelativeTo(tsFilesUnder(LIB_SRC_DIR), LIB_SRC_DIR)).toEqual([]);
  });

  test('playwright configs have no dead /admin path reference', () => {
    expect(bareOffendersRelativeTo(PLAYWRIGHT_CONFIGS, REPO_ROOT)).toEqual([]);
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
