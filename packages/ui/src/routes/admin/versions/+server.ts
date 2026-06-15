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
} from "@openpalm/lib";
import type { RequestHandler } from "./$types";

// A configured stack piece and the image tag it is actually pinned to. The UI
// compares each version against the control plane (PLATFORM_VERSION) to decide
// "behind"/"up to date", so all four version lines stay legible.
type StackServiceVersion = { id: string; label: string; version: string };

// Portal ingress (guardian) and the chat portal only run when a portal addon is
// enabled. Mirrors PORTAL_ADDON_IDS in lib's lifecycle.ts (not exported).
const PORTAL_ADDON_IDS = ["api", "chat", "discord", "slack", "gateway"];

export const GET: RequestHandler = (event) => {
  const requestId = getRequestId(event);
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  const state = getState();
  if (!state.stackDir) return errorResponse(503, "not_initialized", "Stack directory not configured", {}, requestId);
  const stackEnvPath = `${state.stashDir}/env/stack.env`;
  const envVars = existsSync(stackEnvPath) ? parseEnvFile(stackEnvPath) : {};
  const imageTag = envVars.OP_IMAGE_TAG ?? "latest";

  // The configured stack pieces, each with the image tag it actually runs. The
  // user "can't update all the pieces of the stack" if we only report one tag —
  // so enumerate every managed service. Guardian + the chat portal are gated to
  // portal addons (they're only deployed when one is enabled); voice/ollama are
  // shown only when their addon is enabled. resolveEffectivePlatformImageTag
  // honours per-image pins, falling back to OP_IMAGE_TAG.
  const enabledAddons = listEnabledAddonIds(state.homeDir);
  const portalEnabled = enabledAddons.some((a) => PORTAL_ADDON_IDS.includes(a));
  const services: StackServiceVersion[] = [
    // Assistant is the platform image-of-record (its tag === OP_IMAGE_TAG); it is
    // not pinnable, so read its per-image key directly with the OP_IMAGE_TAG
    // fallback. resolveEffectivePlatformImageTag only covers the pinnable images.
    { id: "assistant", label: "Assistant", version: envVars.OP_ASSISTANT_IMAGE_TAG ?? imageTag },
  ];
  if (portalEnabled) {
    services.push({ id: "guardian", label: "Guardian", version: resolveEffectivePlatformImageTag(envVars, "guardian") });
    services.push({ id: "portal", label: "Chat (Discord/Slack)", version: resolveEffectivePlatformImageTag(envVars, "portal") });
  }
  if (enabledAddons.includes("voice")) {
    services.push({ id: "voice", label: "Voice", version: envVars.OP_VOICE_IMAGE_TAG ?? imageTag });
  }
  if (enabledAddons.includes("ollama")) {
    services.push({ id: "ollama", label: "Ollama", version: envVars.OP_OLLAMA_IMAGE_TAG ?? imageTag });
  }

  const inElectron = process.env.OP_INSIDE_ELECTRON === "1";

  // Desktop (Electron) app version + update info, injected by buildUIServerEnv()
  // in packages/electron/src/main.ts. Present only when running inside Electron.
  // OP_ELECTRON_LATEST_* are set only when the app's GitHub update check found a
  // newer release, so latestVersion non-null ⇒ an update is available.
  const electronVersion = process.env.OP_ELECTRON_VERSION ?? null;
  const electronLatestVersion = process.env.OP_ELECTRON_LATEST_VERSION ?? null;
  const electronLatestUrl = process.env.OP_ELECTRON_LATEST_URL ?? null;

  // Two INDEPENDENT version lines (design §5.2 / §6.6):
  //   • harnessVersion  — the native shell. A bump here is the ONLY thing that
  //     forces an app re-download; surfaced via OP_HARNESS_CONTRACT_VERSION.
  //   • platformVersion — the running control plane (@openpalm/lib, which travels
  //     with the data/ui build). It self-updates over npm with NO re-download.
  // Reporting them separately lets the UI tell the user "platform updated
  // automatically; an app re-download is needed only for the harness."
  const harnessContractVersion = process.env.OP_HARNESS_CONTRACT_VERSION
    ? Number(process.env.OP_HARNESS_CONTRACT_VERSION)
    : null;
  const platformVersion = formatForDisplay(PLATFORM_VERSION);

  return json({
    imageTag,
    // Every configured stack piece + the tag it actually runs (#494/#503): the
    // UI groups these as "Services" and flags any that are behind the control
    // plane.
    services,
    inElectron,
    electronVersion,
    electronLatestVersion,
    electronLatestUrl,
    electronUpdateAvailable: !!electronLatestVersion,
    // Native harness line (re-download gate). Independent of platformVersion.
    harnessVersion: electronVersion,
    harnessContractVersion,
    harnessUpdateAvailable: !!electronLatestVersion,
    // Control-plane line (self-updates in place).
    platformVersion,
  });
};
