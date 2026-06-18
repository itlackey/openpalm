import { existsSync } from "node:fs";
import { json } from "@sveltejs/kit";
import { getState } from "$lib/server/state.js";
import { requireAdmin, getRequestId, errorResponse } from "$lib/server/helpers.js";
import { withCache, invalidateVersionCache } from "$lib/server/version-cache.js";
import {
  parseEnvFile,
  PLATFORM_VERSION,
  formatForDisplay,
  resolveEffectivePlatformImageTag,
  listEnabledAddonIds,
  resolveLatestImageTag,
  resolveLatestImageTagForCurrentMajor,
  listDockerImageTags,
  resolveLatestNpmVersion,
  isComparableSemver,
} from "@openpalm/lib";
import type { RequestHandler } from "./$types";

type StackServiceVersion = { id: string; label: string; version: string; latestVersion?: string | null };

// Portal ingress (guardian) and the chat portal only run when a portal addon is
// enabled. Mirrors PORTAL_ADDON_IDS in lib's lifecycle.ts (not exported).
const PORTAL_ADDON_IDS = ["api", "chat", "discord", "slack", "gateway"];

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  // ?refresh=1 — invalidate all version caches before fetching (the "Check for
  // updates" button uses the POST /refresh endpoint, but this per-endpoint
  // trigger is available for fine-grained refresh).
  if (event.url.searchParams.get('refresh') === '1') invalidateVersionCache();

  const state = getState();
  if (!state.stackDir) return errorResponse(503, "not_initialized", "Stack directory not configured", {}, requestId);
  const stackEnvPath = `${state.stashDir}/env/stack.env`;
  const envVars = existsSync(stackEnvPath) ? parseEnvFile(stackEnvPath) : {};
  const imageTag = envVars.OP_IMAGE_TAG ?? "latest";

  // The configured stack pieces, each with the image tag it actually runs.
  // Each service id matches its Docker image name (assistant/guardian/portal/voice).
  const enabledAddons = listEnabledAddonIds(state.homeDir);
  const portalEnabled = enabledAddons.some((a) => PORTAL_ADDON_IDS.includes(a));
  const baseServices: StackServiceVersion[] = [
    { id: "assistant", label: "Assistant", version: envVars.OP_ASSISTANT_IMAGE_TAG ?? imageTag },
  ];
  if (portalEnabled) {
    baseServices.push({ id: "guardian", label: "Guardian", version: resolveEffectivePlatformImageTag(envVars, "guardian") });
    baseServices.push({ id: "portal", label: "Chat (Discord/Slack)", version: resolveEffectivePlatformImageTag(envVars, "portal") });
  }
  if (enabledAddons.includes("voice")) {
    baseServices.push({ id: "voice", label: "Voice", version: envVars.OP_VOICE_IMAGE_TAG ?? imageTag });
  }
  // Ollama is a third-party image (ollama/ollama) that does not participate in
  // OpenPalm release versioning. Omit it from the version-tracking list so it
  // never shows a spurious "update to X.Y.Z" badge.

  const inElectron = process.env.OP_INSIDE_ELECTRON === "1";
  const electronVersion = process.env.OP_ELECTRON_VERSION ?? null;
  const electronLatestVersion = process.env.OP_ELECTRON_LATEST_VERSION ?? null;
  const electronLatestUrl = process.env.OP_ELECTRON_LATEST_URL ?? null;
  const harnessContractVersion = process.env.OP_HARNESS_CONTRACT_VERSION
    ? Number(process.env.OP_HARNESS_CONTRACT_VERSION)
    : null;
  const platformVersion = formatForDisplay(PLATFORM_VERSION);

  const namespace = (envVars.OP_IMAGE_NAMESPACE ?? process.env.OP_IMAGE_NAMESPACE ?? "openpalm").trim().toLowerCase();

  // ── Per-unit Docker Hub lookups (cached) ──────────────────────────────────
  // Each image has its own release line. Docker Hub is the authoritative source
  // for both the latest tag (update detection) and the available tag list
  // (version picker dropdowns). Each lookup is cached separately so one stale
  // entry doesn't block another, and one image's failure doesn't blank the
  // others. The fetchers throw on failure so withCache can serve stale data.
  const latestImageTags: Record<string, string> = {};
  const unitTags: Record<string, string[]> = {};
  const services: StackServiceVersion[] = [];
  for (const s of baseServices) {
    const current = s.version;

    // Latest tag (update detection) — scoped to current major when comparable.
    const latest = await withCache<string | null>(`docker:latest:${s.id}`, async () => {
      const resolved = isComparableSemver(current)
        ? await resolveLatestImageTagForCurrentMajor(namespace, s.id, current)
        : await resolveLatestImageTag(namespace, s.id);
      return formatForDisplay(resolved);
    });
    const latestVersion = latest ?? null;
    if (latestVersion) latestImageTags[s.id] = latestVersion;

    // Available tags (version picker) — scoped to current major when comparable,
    // showing all tags including prereleases so the user can manually pin to an rc.
    const tags = await withCache<string[]>(`docker:tags:${s.id}`, async () => {
      return listDockerImageTags(namespace, s.id, {
        sameMajorAs: isComparableSemver(current) ? current : undefined,
      });
    });
    unitTags[s.id] = tags ?? [];

    services.push({ ...s, latestVersion });
  }

  // latestImageTag (backward compat) is the assistant's latest — the version-of-
  // record image that the "Update now" platform upgrade resolves to.
  const latestImageTag = latestImageTags["assistant"] ?? null;

  // ── Platform latest (npm @openpalm/lib) ───────────────────────────────────
  // The control plane (@openpalm/lib) is distributed via npm, not Docker Hub.
  // platformVersion (above) is the RUNNING version; platformLatest is what's
  // available on npm — used to show whether the control plane itself has an
  // update available, separate from the container image updates.
  const platformLatest = await withCache<string | null>("npm:@openpalm/lib", async () => {
    return resolveLatestNpmVersion("@openpalm/lib", { distTag: "latest" });
  });

  return json({
    imageTag,
    services,
    inElectron,
    electronVersion,
    electronLatestVersion,
    electronLatestUrl,
    electronUpdateAvailable: !!electronLatestVersion,
    harnessVersion: electronVersion,
    harnessContractVersion,
    harnessUpdateAvailable: !!electronLatestVersion,
    platformVersion,
    platformLatest: platformLatest ?? null,
    latestImageTag,
    latestImageTags,
    unitTags,
  });
};
