import { json } from "@sveltejs/kit";
import { requireAdmin, getRequestId } from "$lib/server/helpers.js";
import { NPM_PACKAGE_NAMES, DOCKER_IMAGE_NAMES, SERVICE_VERSION_KEYS, NPM_VERSION_KEYS } from "@openpalm/lib";
import type { RequestHandler } from "./$types";

const DOCKER_HUB_NAMESPACE = "openpalm";

// Semver tag: digits only, no pre-release suffix (e.g. "0.12.22").
const STABLE_SEMVER = /^\d+\.\d+\.\d+$/;
// Voice tags carry a variant suffix appended by compose ("-cpu", "-cu121", etc.).
// Strip the suffix to get OP_VOICE_VERSION's base value.
const VOICE_STABLE = /^(\d+\.\d+\.\d+)-\w+$/;

type DockerHubTag = { name: string };
type DockerHubResponse = { results?: DockerHubTag[] };

/**
 * Query Docker Hub for the latest stable tag of one openpalm image.
 * Returns the base version string (e.g. "0.12.22"), or null on failure.
 * Voice tags have a variant suffix that compose appends — we strip it here
 * so the returned value is the raw OP_VOICE_VERSION to write into stack.env.
 */
async function resolveDockerLatest(image: string): Promise<string | null> {
  try {
    const url =
      `https://hub.docker.com/v2/repositories/${DOCKER_HUB_NAMESPACE}/${image}/tags` +
      `?page_size=25&ordering=-last_updated`;
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as DockerHubResponse;
    for (const tag of data.results ?? []) {
      // Plain semver tag (assistant, guardian, portal).
      if (STABLE_SEMVER.test(tag.name)) return tag.name;
      // Voice variant tag — return the base semver part.
      const voiceMatch = tag.name.match(VOICE_STABLE);
      if (voiceMatch) return voiceMatch[1];
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Fetch the `latest` dist-tag version for one npm package.
 * Returns the concrete version string (e.g. "1.18.0"), or null on failure.
 */
async function resolveNpmLatest(pkg: string): Promise<string | null> {
  try {
    const res = await fetch(
      `https://registry.npmjs.org/${encodeURIComponent(pkg)}/latest`,
      {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(6_000),
      }
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { version?: string };
    return typeof data.version === "string" ? data.version : null;
  } catch {
    return null;
  }
}

// Short-lived in-process cache — one server instance, reset on restart.
// Avoids hammering registries when the operator clicks "Re-check" rapidly.
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
let cachedResult: { versions: Record<string, string | null>; errors: string[]; fetchedAt: string } | null = null;
let cacheExpiresAt = 0;

/**
 * GET /admin/versions/latest
 *
 * Resolves the latest stable version for every tracked component:
 *  - Docker images: query Docker Hub tags for each openpalm image directly.
 *    Filters for stable semver tags (no pre-release suffix). Voice tags carry
 *    a variant suffix ("-cpu" etc.) added by compose — the base version is stored.
 *  - npm packages: one fetch per package to registry.npmjs.org for the `latest`
 *    dist-tag. All fetches run in parallel with per-source timeouts.
 *
 * Returns:
 *   { versions: Record<string, string | null>, errors: string[], fetchedAt: string }
 *
 * null for a key means the registry was unreachable; the UI shows "unavailable".
 * Results are cached for 5 minutes in process memory to absorb Re-check clicks.
 * Called only on explicit user action — never polled, never auto-fetched on load.
 */
export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  // Return cached result if still fresh.
  if (cachedResult && Date.now() < cacheExpiresAt) {
    return json(cachedResult);
  }

  const errors: string[] = [];

  // Fetch all Docker images and npm packages in parallel.
  const [dockerResults, npmResults] = await Promise.all([
    Promise.all(
      SERVICE_VERSION_KEYS.map(async (key) => {
        const image = DOCKER_IMAGE_NAMES[key];
        const version = await resolveDockerLatest(image);
        if (!version) errors.push(`Docker Hub: could not resolve latest for ${DOCKER_HUB_NAMESPACE}/${image}`);
        return [key, version] as [string, string | null];
      })
    ),
    Promise.all(
      NPM_VERSION_KEYS.map(async (key) => {
        const pkg = NPM_PACKAGE_NAMES[key];
        const version = await resolveNpmLatest(pkg);
        if (!version) errors.push(`npm: could not resolve latest for ${pkg}`);
        return [key, version] as [string, string | null];
      })
    ),
  ]);

  const versions: Record<string, string | null> = {};
  for (const [key, val] of [...dockerResults, ...npmResults]) {
    versions[key] = val;
  }

  const result = { versions, errors, fetchedAt: new Date().toISOString() };
  cachedResult = result;
  cacheExpiresAt = Date.now() + CACHE_TTL_MS;

  return json(result);
};
