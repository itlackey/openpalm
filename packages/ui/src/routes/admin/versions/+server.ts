/**
 * GET /admin/versions  — truthful version state (constitution §4.2, §5)
 * PATCH /admin/versions — write pins to state file
 *
 * GET returns THREE distinct values per component (§5 / Phase 5):
 *   running   — the digest + tag the currently running container was CREATED FROM
 *               (read from `docker inspect`, never from a pin file). Null when not running.
 *   pinned    — the explicit version lock from state/stack.state.env, or null = track latest.
 *               Moving tags ("latest", "next") are normalized to null (they express channel
 *               preference, not a lock).
 *   available — the resolved latest version on the active channel (silent null on registry down).
 *
 * Backward compatibility for the mixed-version window (old UI + new API or vice versa):
 *   - The legacy top-level `versions` field is preserved. Old UIs that read only
 *     `body.versions[key]` continue to get the same string they always did (the stored
 *     pin value / default). New UIs read `body.components[key].{running,pinned,available}`.
 *   - Old UIs cannot see `running` (never could — it's new). They may show a stale pin
 *     as "current", which was the pre-Phase-5 behaviour. That is acceptable for the
 *     transition window; Phase 6 (UpdatesTab rebuild) is where the new shape is consumed.
 *
 * Registry-down asymmetry (§4, compliance G2):
 *   Background "available?" resolution degrades SILENTLY — a registry outage just
 *   leaves `available` null; the stack keeps running what it has.
 *   A user-pressed update that can't reach the registry FAILS LOUDLY (handled in
 *   /admin/update via applyStack pull-before-up + fatal pull failure).
 *
 * Voice variant on display (§4.2, compliance G3):
 *   `running.tag` for the voice service will include the hardware suffix (e.g.
 *   "openpalm/voice:0.12.0-cpu"). The `running.plainVersion` field strips it for
 *   use in the pinning control. `pinned` never carries the suffix (compose adds it).
 *
 * Service-name vs image-name (§5 truthful state):
 *   getRunningImages() keys its result by compose SERVICE name, not image name.
 *   OP_PORTAL_VERSION images run under services discord/slack/guardian/api/chat/gateway.
 *   OP_VOICE_VERSION may run as voice (cpu), voice-cuda, or voice-rocm.
 *   We therefore scan runningImages by matching the image tag against the expected
 *   image name, not by looking up the image name as a service name.
 *
 * upToDate field removed (§8, Phase-5-item-3):
 *   Tag-string equality cannot determine up-to-date status (tags can point to different
 *   digests). Phase 6 decides up-to-date by digest comparison after a pull. The route
 *   surfaces running.digest, running.plainVersion, pinned, and available as separate
 *   truthful values for Phase 6 to use.
 */
import { json } from "@sveltejs/kit";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { getState } from "$lib/server/state.js";
import { requireAdmin, getRequestId, errorResponse } from "$lib/server/helpers.js";
import {
  readVersions,
  writeVersions,
  readPinnedVersions,
  readChannelPreference,
  writeChannelPreference,
  SERVICE_VERSION_KEYS,
  DOCKER_IMAGE_NAMES,
  PLATFORM_VERSION,
  formatForDisplay,
  parseEnvFile,
  mergeEnvContent,
  getRunningImages,
  stripVoiceVariantSuffix,
  compareComparableVersions,
  buildComposeOptions,
  type ChannelPreference,
} from "@openpalm/lib";
import type { RequestHandler } from "./$types";

const ALLOWED_KEYS = new Set<string>([...SERVICE_VERSION_KEYS, "OP_AUTO_UPDATE", "OP_CHANNEL"]);

function stackEnvPath(): string {
  return `${getState().stashDir}/env/stack.env`;
}

// ── Available resolver (background, silent on failure — §4 registry-down asymmetry) ──

const STABLE_SEMVER = /^v?(\d+\.\d+\.\d+)$/;
// Prerelease: X.Y.Z-rc.N or X.Y.Z-beta.N etc. Voice variant suffixes (-cpu/-cu121/-rocm6)
// are NOT prerelease — they are excluded from the prerelease match.
const PRERELEASE_SEMVER = /^v?(\d+\.\d+\.\d+-(?:rc|alpha|beta|next)\.\d+)$/;
const VOICE_STABLE = /^v?(\d+\.\d+\.\d+)-\w+$/;

/**
 * Read the Docker Hub namespace from the stack env (OP_IMAGE_NAMESPACE), defaulting to
 * "openpalm". Compose uses the same default: ${OP_IMAGE_NAMESPACE:-openpalm}.
 */
function imageNamespace(stackEnvContent: Record<string, string>): string {
  return (stackEnvContent.OP_IMAGE_NAMESPACE ?? process.env.OP_IMAGE_NAMESPACE ?? "openpalm").trim() || "openpalm";
}

async function resolveDockerLatestSilent(
  image: string,
  namespace: string,
  channel: ChannelPreference
): Promise<string | null> {
  try {
    const res = await fetch(
      `https://hub.docker.com/v2/repositories/${namespace}/${image}/tags?page_size=100&ordering=last_updated`,
      { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(5_000) }
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { results?: { name: string }[] };
    const isVoice = image === "voice";
    const candidates: string[] = [];
    for (const tag of data.results ?? []) {
      // Stable semver always accepted
      const plain = tag.name.match(STABLE_SEMVER)?.[1];
      if (plain) { candidates.push(plain); continue; }
      // Voice variant tags (X.Y.Z-cpu etc.) — extract base version for the voice image
      if (isVoice) {
        const voice = tag.name.match(VOICE_STABLE)?.[1];
        if (voice) { candidates.push(voice); continue; }
      }
      // Prerelease tags accepted only on the "next" channel
      if (channel === "next") {
        const pre = tag.name.match(PRERELEASE_SEMVER)?.[1];
        if (pre) candidates.push(pre);
      }
    }
    if (candidates.length === 0) return null;
    return candidates.sort(compareComparableVersions).at(-1) ?? null;
  } catch {
    return null; // SILENT degradation — background check (§4 registry-down asymmetry)
  }
}

// 5-minute in-process cache for the background available resolver, keyed by channel.
type AvailableCache = {
  versions: Record<string, string | null>;
  fetchedAt: number;
};
const _availableCache = new Map<string, AvailableCache>();
const CACHE_TTL_MS = 5 * 60_000;

async function resolveAvailableVersions(
  channel: ChannelPreference,
  namespace: string
): Promise<Record<string, string | null>> {
  const cacheKey = `${channel}:${namespace}`;
  const cached = _availableCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.versions;
  }
  const results = await Promise.all(
    SERVICE_VERSION_KEYS.map(async (key) => {
      const image = DOCKER_IMAGE_NAMES[key];
      const v = await resolveDockerLatestSilent(image, namespace, channel);
      return [key, v] as [string, string | null];
    })
  );
  const versions: Record<string, string | null> = {};
  for (const [k, v] of results) versions[k] = v;
  _availableCache.set(cacheKey, { versions, fetchedAt: Date.now() });
  return versions;
}

// ── Service-name candidates for each version key ─────────────────────────────
//
// getRunningImages() keys by compose SERVICE name, not image name.
// We scan all running services whose image tag contains the expected image name
// to find the running container for a given version key.

/**
 * Find the first running (non-not_installed) container whose image tag contains
 * the given image name (e.g. "/portal:" or "/voice:"). Returns null if none found.
 */
function findRunningByImage(
  runningImages: Record<string, { digest: string; tag: string; healthStatus: string; state: string }>,
  imageName: string
): { digest: string; tag: string; healthStatus: string; state: string } | null {
  // Match image tag containing "/<imageName>:" (e.g. "openpalm/portal:...")
  const needle = `/${imageName}:`;
  for (const ri of Object.values(runningImages)) {
    if (ri.state !== "not_installed" && ri.tag.includes(needle)) {
      return ri;
    }
  }
  return null;
}

// ── GET /admin/versions ──────────────────────────────────────────────────────

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  const state = getState();
  if (!state.stackDir) {
    return errorResponse(503, "not_initialized", "Stack directory not configured", {}, requestId);
  }

  // 1. Pin values (state + legacy fallback) — backward-compat "versions" field
  const versions = readVersions(state);

  // 2. Pinned with null-for-latest semantics (§4.2)
  const pinned = readPinnedVersions(state);

  // 3. Channel preference
  const channel = readChannelPreference(state);

  // 4. Running images from Docker (§5 truthful state) — best-effort, never blocks on error
  let runningImages: Record<string, { digest: string; tag: string; healthStatus: string; state: string }> = {};
  try {
    runningImages = await getRunningImages(buildComposeOptions(state));
  } catch {
    // If docker is not available, running stays empty — UI shows "not_installed" per service
  }

  // 5. Namespace + available versions (background resolver, silent on registry failure)
  //    Namespace is read from stack.env (same source compose uses).
  const path = stackEnvPath();
  const env = existsSync(path) ? parseEnvFile(path) : {};
  const namespace = imageNamespace(env);
  const available = await resolveAvailableVersions(channel, namespace);

  // 6. Build per-component shape (§5 Phase 5 deliverable)
  //    upToDate intentionally omitted — tag-string equality is forbidden (§8/Phase-5-item-3).
  //    Phase 6 will determine up-to-date by digest after a pull.
  const components: Record<string, {
    running: { digest: string; tag: string; plainVersion: string; healthStatus: string; containerState: string } | null;
    pinned: string | null;
    available: string | null;
  }> = {};

  for (const key of SERVICE_VERSION_KEYS) {
    // getRunningImages keys by compose SERVICE name, not image name.
    // assistant and guardian have 1:1 service=image mapping.
    // portal image runs as discord/slack/guardian/api/chat/gateway services.
    // voice image runs as voice (cpu), voice-cuda, or voice-rocm services.
    // Scan by image tag match so we find the real running container regardless of service name.
    const imageName = DOCKER_IMAGE_NAMES[key];
    const ri = findRunningByImage(runningImages, imageName);

    // running: null when no matching container is running
    let runningEntry: typeof components[string]["running"] = null;
    if (ri) {
      const rawTag = ri.tag.split(":").pop() ?? ri.tag;
      const plainVersion = key === "OP_VOICE_VERSION"
        ? stripVoiceVariantSuffix(rawTag)
        : rawTag;
      runningEntry = {
        digest: ri.digest,
        tag: ri.tag,
        plainVersion,
        healthStatus: ri.healthStatus,
        containerState: ri.state,
      };
    }

    components[key] = {
      running: runningEntry,
      pinned: pinned[key],
      available: available[key] ?? null,
    };
  }

  // Legacy autoUpdate from stack.env (not part of state split yet — keep reading from there)
  // path/env already resolved above for namespace lookup — reuse them here.

  return json({
    // ── Phase 5 shape (three distinct values per component) ──
    components,
    channel,
    platformVersion: formatForDisplay(PLATFORM_VERSION),
    // ── Legacy backward-compat fields (old UI reads these) ──
    // Old UIs that read body.versions[key] still get the same string.
    // They miss the running/pinned/available distinction — acceptable during the
    // mixed-version window (Phase 6 UpdatesTab rebuild consumes the new shape).
    versions,
    autoUpdate: env.OP_AUTO_UPDATE !== "false",
  });
};

// ── PATCH /admin/versions ────────────────────────────────────────────────────

export const PATCH: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  const state = getState();
  if (!state.stackDir) {
    return errorResponse(503, "not_initialized", "Stack directory not configured", {}, requestId);
  }

  let body: { versions?: Record<string, string> };
  try {
    body = (await event.request.json()) as { versions?: Record<string, string> };
  } catch {
    return errorResponse(400, "invalid_body", "Request body must be JSON", {}, requestId);
  }

  const versions = body?.versions;
  if (!versions || typeof versions !== "object") {
    return errorResponse(400, "invalid_body", "Body must include a versions object", {}, requestId);
  }

  const versionUpdates: Record<string, string> = {};
  const settingUpdates: Record<string, string> = {};
  let channelUpdate: string | undefined;

  for (const [key, value] of Object.entries(versions)) {
    if (!ALLOWED_KEYS.has(key)) {
      return errorResponse(400, "unknown_version_key", `Unknown key: ${key}`, {}, requestId);
    }
    if (typeof value !== "string") {
      return errorResponse(400, "invalid_version_value", `Value for ${key} must be a string`, {}, requestId);
    }
    if (key === "OP_CHANNEL") {
      // Channel preference (§4.2) — written via writeChannelPreference (state file, never overwritten).
      channelUpdate = value;
    } else if (key === "OP_AUTO_UPDATE") {
      settingUpdates[key] = value;
    } else {
      versionUpdates[key] = value;
    }
  }

  if (Object.keys(versionUpdates).length > 0) {
    writeVersions(state, versionUpdates);
    // Invalidate the available cache so the next GET reflects updated pins
    _availableCache.clear();
  }

  if (channelUpdate !== undefined) {
    try {
      writeChannelPreference(state, channelUpdate);
      _availableCache.clear();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return errorResponse(400, "invalid_channel", msg, {}, requestId);
    }
  }

  if (Object.keys(settingUpdates).length > 0) {
    const path = stackEnvPath();
    const current = existsSync(path) ? readFileSync(path, "utf-8") : "";
    writeFileSync(path, mergeEnvContent(current, settingUpdates), { mode: 0o600 });
  }

  return json({ ok: true, versions: readVersions(state) });
};
