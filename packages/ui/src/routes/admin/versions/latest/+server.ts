import { json } from "@sveltejs/kit";
import { requireAdmin, getRequestId } from "$lib/server/helpers.js";
import { NPM_PACKAGE_NAMES, DOCKER_IMAGE_NAMES, SERVICE_VERSION_KEYS, NPM_VERSION_KEYS } from "@openpalm/lib";
import type { RequestHandler } from "./$types";

const DOCKER_HUB_NAMESPACE = "openpalm";

// Tags are published as "v0.12.22" — capture and strip the "v".
const STABLE_SEMVER = /^v?(\d+\.\d+\.\d+)$/;
// Voice tags carry a variant suffix appended by compose ("-cpu", "-cu121", etc.).
const VOICE_STABLE = /^v?(\d+\.\d+\.\d+)-\w+$/;

type DockerHubTag = { name: string };
type DockerHubResponse = { results?: DockerHubTag[] };

async function resolveDockerLatest(image: string): Promise<string | null> {
  try {
    const res = await fetch(
      `https://hub.docker.com/v2/repositories/${DOCKER_HUB_NAMESPACE}/${image}/tags?page_size=25&ordering=-last_updated`,
      { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(8_000) }
    );
    if (!res.ok) return null;
    const data = (await res.json()) as DockerHubResponse;
    for (const tag of data.results ?? []) {
      const plain = tag.name.match(STABLE_SEMVER);
      if (plain) return plain[1];
      const voice = tag.name.match(VOICE_STABLE);
      if (voice) return voice[1];
    }
    return null;
  } catch {
    return null;
  }
}

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

const CACHE_TTL_MS = 5 * 60 * 1000;
let cachedResult: { versions: Record<string, string | null>; errors: string[]; fetchedAt: string } | null = null;
let cacheExpiresAt = 0;

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  if (cachedResult && Date.now() < cacheExpiresAt) return json(cachedResult);

  const errors: string[] = [];

  const [dockerResults, npmResults, uiResult] = await Promise.all([
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
    resolveNpmLatest("@openpalm/ui").then((v) => {
      if (!v) errors.push("npm: could not resolve latest for @openpalm/ui");
      return ["OP_UI_VERSION", v] as [string, string | null];
    }),
  ]);

  const versions: Record<string, string | null> = {};
  for (const [key, val] of [...dockerResults, ...npmResults, uiResult]) {
    versions[key as string] = val as string | null;
  }

  const result = { versions, errors, fetchedAt: new Date().toISOString() };
  cachedResult = result;
  cacheExpiresAt = Date.now() + CACHE_TTL_MS;

  return json(result);
};
