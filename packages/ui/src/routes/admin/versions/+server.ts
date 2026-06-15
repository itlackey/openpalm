import { existsSync } from "node:fs";
import { json } from "@sveltejs/kit";
import { getState } from "$lib/server/state.js";
import { requireAdmin, getRequestId, errorResponse } from "$lib/server/helpers.js";
import { parseEnvFile, PLATFORM_VERSION, formatForDisplay } from "@openpalm/lib";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = (event) => {
  const requestId = getRequestId(event);
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  const state = getState();
  if (!state.stackDir) return errorResponse(503, "not_initialized", "Stack directory not configured", {}, requestId);
  const stackEnvPath = `${state.stashDir}/env/stack.env`;
  const envVars = existsSync(stackEnvPath) ? parseEnvFile(stackEnvPath) : {};
  const imageTag = envVars.OP_IMAGE_TAG ?? "latest";

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
