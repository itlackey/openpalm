/**
 * npm registry lookups — latest version + version list for any npm package.
 *
 * The admin UI's "Admin interface" picker (@openpalm/ui) and the platform
 * latest-version check (@openpalm/lib) both read from the npm registry. Keeping
 * these helpers in lib (not duplicated in the UI) follows the shared control-
 * plane library rule: both CLI and admin import portable lookups from
 * `@openpalm/lib`.
 *
 * Uses the Web Platform `fetch` built-in — no third-party deps.
 */

const NPM_REGISTRY = 'https://registry.npmjs.org';
const NPM_TIMEOUT_MS = 8_000;

type NpmPackument = {
  versions?: Record<string, unknown>;
  time?: Record<string, string>;
  'dist-tags'?: Record<string, string>;
};

async function fetchNpmPackument(packageName: string): Promise<NpmPackument> {
  let response: Response;
  try {
    response = await fetch(`${NPM_REGISTRY}/${packageName}`, {
      headers: { 'User-Agent': 'openpalm-admin/1.0', Accept: 'application/json' },
      signal: AbortSignal.timeout(NPM_TIMEOUT_MS),
    });
  } catch (e) {
    throw new Error(`Failed to query npm registry: ${e instanceof Error ? e.message : String(e)}`);
  }

  // 404 = package not yet published — return an empty packument so callers get
  // an empty version list rather than an error.
  if (response.status === 404) return {};
  if (!response.ok) {
    throw new Error(`npm registry lookup failed (${response.status})`);
  }
  return (await response.json()) as NpmPackument;
}

/**
 * Resolve the latest published version of an npm package from its dist-tags.
 *
 * `distTag` defaults to `'latest'`; pass `{ allowPrerelease: true }` (or
 * `{ distTag: 'next' }`) to read the prerelease channel. Returns `null` when the
 * package exists but the requested dist-tag is absent.
 */
export async function resolveLatestNpmVersion(
  packageName: string,
  opts: { distTag?: 'latest' | 'next'; allowPrerelease?: boolean } = {},
): Promise<string | null> {
  const distTag = opts.distTag ?? (opts.allowPrerelease ? 'next' : 'latest');
  const packument = await fetchNpmPackument(packageName);
  const distTags = packument['dist-tags'] ?? {};
  const version = distTags[distTag];
  return typeof version === 'string' ? version : null;
}

export type NpmVersionEntry = {
  /** npm version, e.g. "0.11.0-rc.2" (no `v` prefix). */
  version: string;
  prerelease: boolean;
  /** ISO publish time, when available (used for sort + display). */
  publishedAt: string | null;
  /** dist-tag pointing at this version, if any ("latest" | "next"). */
  distTag: string | null;
};

/**
 * List published npm versions for a package, newest-first by publish time.
 *
 * Mirrors the shape the admin UI's `@openpalm/ui` picker expects. Returns at
 * most `max` entries (default 20). A 404 (package not yet published) yields an
 * empty list.
 */
export async function listNpmVersions(
  packageName: string,
  opts: { max?: number } = {},
): Promise<NpmVersionEntry[]> {
  const { max = 20 } = opts;
  const packument = await fetchNpmPackument(packageName);
  const distTags = packument['dist-tags'] ?? {};
  const versionToTag = new Map<string, string>();
  for (const [tag, version] of Object.entries(distTags)) {
    versionToTag.set(version, tag);
  }
  const time = packument.time ?? {};
  return Object.keys(packument.versions ?? {})
    .map((version): NpmVersionEntry => ({
      version,
      prerelease: version.includes('-'),
      publishedAt: time[version] ?? null,
      distTag: versionToTag.get(version) ?? null,
    }))
    .sort((a, b) => (b.publishedAt ?? '').localeCompare(a.publishedAt ?? ''))
    .slice(0, max);
}
