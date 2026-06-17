import { existsSync } from "node:fs";
import { json } from "@sveltejs/kit";
import { getState } from "$lib/server/state.js";
import { requireAdmin, getRequestId, errorResponse } from "$lib/server/helpers.js";
import {
  parseEnvFile,
  PLATFORM_VERSION,
  formatForDisplay,
  resolveEffectivePlatformImageTag,
  listEnabledAddonIds,
  resolveLatestPlatformTag,
  resolveLatestPlatformTagForCurrentMajor,
  isComparableSemver,
} from "@openpalm/lib";
import type { RequestHandler } from "./$types";

type StackServiceVersion = { id: string; label: string; version: string };

// Portal ingress (guardian) and the chat portal only run when a portal addon is
// enabled. Mirrors PORTAL_ADDON_IDS in lib's lifecycle.ts (not exported).
const PORTAL_ADDON_IDS = ["api", "chat", "discord", "slack", "gateway"];

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  const state = getState();
  if (!state.stackDir) return errorResponse(503, "not_initialized", "Stack directory not configured", {}, requestId);
  const stackEnvPath = `${state.stashDir}/env/stack.env`;
  const envVars = existsSync(stackEnvPath) ? parseEnvFile(stackEnvPath) : {};
  const imageTag = envVars.OP_IMAGE_TAG ?? "latest";

  // The configured stack pieces, each with the image tag it actually runs.
  const enabledAddons = listEnabledAddonIds(state.homeDir);
  const portalEnabled = enabledAddons.some((a) => PORTAL_ADDON_IDS.includes(a));
  const services: StackServiceVersion[] = [
    { id: "assistant", label: "Assistant", version: envVars.OP_ASSISTANT_IMAGE_TAG ?? imageTag },
  ];
  if (portalEnabled) {
    services.push({ id: "guardian", label: "Guardian", version: resolveEffectivePlatformImageTag(envVars, "guardian") });
    services.push({ id: "portal", label: "Chat (Discord/Slack)", version: resolveEffectivePlatformImageTag(envVars, "portal") });
  }
  if (enabledAddons.includes("voice")) {
    services.push({ id: "voice", label: "Voice", version: envVars.OP_VOICE_IMAGE_TAG ?? imageTag });
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

  // Query Docker Hub for the latest available image tag (best-effort).
  // With independently versioned units, services can be ahead or behind the
  // platform npm version — Docker Hub is the authoritative source for what's
  // available to deploy.
  let latestImageTag: string | null = null;
  try {
    const namespace = (envVars.OP_IMAGE_NAMESPACE ?? process.env.OP_IMAGE_NAMESPACE ?? "openpalm").trim().toLowerCase();
    const currentDockerTag = envVars.OP_ASSISTANT_IMAGE_TAG ?? imageTag;
    if (isComparableSemver(currentDockerTag)) {
      latestImageTag = formatForDisplay(await resolveLatestPlatformTagForCurrentMajor(namespace, currentDockerTag));
    } else {
      latestImageTag = formatForDisplay(await resolveLatestPlatformTag(namespace));
    }
  } catch {
    // Non-fatal: latestImageTag stays null; UI falls back to no update banner.
  }

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
    latestImageTag,
  });
};
