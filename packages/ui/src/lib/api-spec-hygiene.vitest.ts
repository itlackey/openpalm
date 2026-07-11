/**
 * Review 2026-07-10 F2 — docs/technical/api-spec.md documented 14+ endpoints
 * that don't exist at HEAD (a textual Phase 4 `/admin` → `/api/host` rename
 * applied without verifying existence) plus a materially wrong description
 * of the secrets write API. Those were pruned/corrected by hand; this test
 * guards against the same drift recurring: every `### \`METHOD /path\``
 * heading in api-spec.md must resolve to a real `+server.ts` route file
 * exporting that method (mirroring the walker convention in
 * routes/api/host/guard-hygiene.vitest.ts).
 *
 * Two endpoints are documented but deliberately excluded from the route
 * check (see EXTERNAL_NON_UI_ENDPOINTS below): they are real, but are not
 * served by a packages/ui route.
 */
import { describe, expect, test } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const API_SPEC_PATH = join(REPO_ROOT, 'docs', 'technical', 'api-spec.md');
const ROUTES_DIR = fileURLToPath(new URL('../routes/', import.meta.url));

type Endpoint = { method: string; path: string; line: number };

/** `### \`GET /api/host/foo\`` or `### \`GET /a\` / \`PUT /a\` / \`DELETE /a\`` */
const HEADING_RE = /^### (.+)$/;
const METHOD_PATH_RE = /`(GET|POST|PUT|PATCH|DELETE) (\/[^\s`?]+)/g;

function parseEndpoints(source: string): Endpoint[] {
  const endpoints: Endpoint[] = [];
  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const heading = HEADING_RE.exec(lines[i]);
    if (!heading) continue;
    for (const match of heading[1].matchAll(METHOD_PATH_RE)) {
      endpoints.push({ method: match[1], path: match[2], line: i + 1 });
    }
  }
  return endpoints;
}

// Real endpoints that are documented but are NOT packages/ui routes:
// - GET /guardian/stats is served directly by the guardian process (the doc
//   says so explicitly) — there is no routes/guardian/stats/+server.ts.
const EXTERNAL_NON_UI_ENDPOINTS = new Set(['GET /guardian/stats']);

/** Resolve a documented path (dynamic segments as `:name`) to a routes/ dir. */
function resolveRouteDir(path: string): string | null {
  const segments = path.split('/').filter(Boolean);
  let dir = ROUTES_DIR;
  for (const segment of segments) {
    if (!existsSync(dir)) return null;
    const entries = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory());
    if (segment.startsWith(':')) {
      const dynamic = entries.find((e) => /^\[.+\]$/.test(e.name));
      if (!dynamic) return null;
      dir = join(dir, dynamic.name);
    } else {
      const literal = entries.find((e) => e.name === segment);
      if (!literal) return null;
      dir = join(dir, literal.name);
    }
  }
  return dir;
}

describe('every endpoint documented in api-spec.md exists at HEAD (review 2026-07-10 F2)', () => {
  const source = readFileSync(API_SPEC_PATH, 'utf-8');
  const endpoints = parseEndpoints(source);

  test('the doc scan sees endpoints (sanity)', () => {
    expect(endpoints.length).toBeGreaterThan(30);
  });

  test.each(endpoints)('$method $path (api-spec.md:$line) is a real route', ({ method, path }) => {
    const key = `${method} ${path}`;
    if (EXTERNAL_NON_UI_ENDPOINTS.has(key)) {
      expect(key).toEqual(key); // documented-external, not a ui route — no walk needed
      return;
    }

    const dir = resolveRouteDir(path);
    expect(dir, `no route directory resolves for ${path}`).not.toBeNull();

    const serverFile = join(dir as string, '+server.ts');
    expect(existsSync(serverFile), `${serverFile} does not exist`).toBe(true);

    const contents = readFileSync(serverFile, 'utf-8');
    const exported = new RegExp(`export const ${method}\\b`).test(contents);
    expect(exported, `${serverFile} does not export ${method}`).toBe(true);
  });
});
