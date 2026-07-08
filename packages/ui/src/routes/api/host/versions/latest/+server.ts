import { json } from "@sveltejs/kit";
import { requireAdmin, requireCapability, getRequestId } from "$lib/server/helpers.js";
import { DOCKER_IMAGE_NAMES, SERVICE_VERSION_KEYS, compareComparableVersions } from "@openpalm/lib";
import type { RequestHandler } from "./$types";

const DOCKER_HUB_NAMESPACE = "openpalm";

// Images are published with bare semver tags ("0.12.41"). Pre-0.12.41 images
// carry a legacy leading "v" ("v0.12.40") which is still on Docker Hub, so the
// `v?` keeps the resolver reading across the cutover. The captured group is bare
// — that is the canonical form written to stack.env and used as the image tag.
const STABLE_SEMVER = /^v?(\d+\.\d+\.\d+)$/;
// Voice tags carry a variant suffix appended by compose ("-cpu", "-cu121", etc.).
// Only applied to the voice image — other images use hyphens for pre-releases/arch variants.
const VOICE_STABLE = /^v?(\d+\.\d+\.\d+)-\w+$/;

type DockerHubTag = { name: string };
type DockerHubResponse = { results?: DockerHubTag[] };

async function resolveNpmLatest(pkg: string): Promise<string | null> {
  try {
    const res = await fetch(
      `https://registry.npmjs.org/${encodeURIComponent(pkg)}/latest`,
      { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(6_000) }
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { version?: string };
    return typeof data.version === "string" ? data.version : null;
  } catch {
    return null;
  }
}

async function resolveDockerLatest(image: string): Promise<string | null> {
  try {
    // Order by last_updated (newest push first), NOT -name. -name is
    // lexicographic, so "v0.12.9" sorts above "v0.12.33"; and once a repo
    // accumulates >100 tags (sha-*, rc, arch variants), the newest stable
    // release falls outside the first page entirely — the UI then reports a
    // stale "latest". last_updated keeps the most recent releases in-window;
    // the semverCompare below still picks the highest stable among them.
    const res = await fetch(
      `https://hub.docker.com/v2/repositories/${DOCKER_HUB_NAMESPACE}/${image}/tags?page_size=100&ordering=last_updated`,
      { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(8_000) }
    );
    if (!res.ok) return null;
    const data = (await res.json()) as DockerHubResponse;
    const isVoice = image === "voice";
    const candidates: string[] = [];
    for (const tag of data.results ?? []) {
      const plain = tag.name.match(STABLE_SEMVER);
      if (plain) { candidates.push(plain[1]); continue; }
      if (isVoice) {
        const voice = tag.name.match(VOICE_STABLE);
        if (voice) candidates.push(voice[1]);
      }
    }
    if (candidates.length === 0) return null;
    return candidates.sort(compareComparableVersions).at(-1) ?? null;
  } catch {
    return null;
  }
}

const CACHE_TTL_MS = 5 * 60 * 1000;
let cachedResult: { versions: Record<string, string | null>; errors: string[]; fetchedAt: string } | null = null;
let cacheExpiresAt = 0;

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const capabilityError = requireCapability(event, 'host:updates', requestId);
  if (capabilityError) return capabilityError;
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  if (cachedResult && Date.now() < cacheExpiresAt) return json(cachedResult);

  const errors: string[] = [];

  const [dockerResults, uiResult] = await Promise.all([
    Promise.all(
      SERVICE_VERSION_KEYS.map(async (key) => {
        const image = DOCKER_IMAGE_NAMES[key];
        const version = await resolveDockerLatest(image);
        if (!version) errors.push(`Docker Hub: could not resolve latest for ${DOCKER_HUB_NAMESPACE}/${image}`);
        return [key, version] as [string, string | null];
      })
    ),
    resolveNpmLatest("@openpalm/ui").then((v) => {
      if (!v) errors.push("npm: could not resolve latest for @openpalm/ui");
      return ["OP_UI_VERSION", v] as [string, string | null];
    }),
  ]);

  const versions: Record<string, string | null> = {};
  for (const [key, val] of [...dockerResults, uiResult]) {
    versions[key as string] = val as string | null;
  }

  const result = { versions, errors, fetchedAt: new Date().toISOString() };
  cachedResult = result;
  cacheExpiresAt = Date.now() + CACHE_TTL_MS;

  return json(result);
};
