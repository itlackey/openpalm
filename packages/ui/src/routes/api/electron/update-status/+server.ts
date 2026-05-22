import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";

// Reads Electron-injected env vars set by buildUIServerEnv() in
// packages/electron/src/main.ts. CLI users have OP_INSIDE_ELECTRON unset
// and get { inElectron: false }, which keeps the update banner hidden.

export const GET: RequestHandler = () => {
  const inElectron = process.env.OP_INSIDE_ELECTRON === "1";
  const currentVersion = process.env.OP_ELECTRON_VERSION ?? null;
  const latestVersion = process.env.OP_ELECTRON_LATEST_VERSION ?? null;
  const latestUrl = process.env.OP_ELECTRON_LATEST_URL ?? null;
  return json({
    inElectron,
    currentVersion,
    latestVersion,
    latestUrl,
    updateAvailable: !!latestVersion,
  });
};
