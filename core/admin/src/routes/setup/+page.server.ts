import { redirect } from "@sveltejs/kit";
import { existsSync, readFileSync } from "node:fs";
import { userInfo } from "node:os";
import { getState } from "$lib/server/state.js";
import type { PageServerLoad } from "./$types";

function detectUserId(): string {
  const envUser = process.env.USER ?? process.env.LOGNAME ?? "";
  if (envUser) return envUser;
  try {
    return userInfo().username || "default_user";
  } catch {
    return "default_user";
  }
}

function isSetupComplete(stateDir: string): boolean {
  const stackEnvPath = `${stateDir}/artifacts/stack.env`;
  if (!existsSync(stackEnvPath)) return false;

  const stackEnv = readFileSync(stackEnvPath, "utf-8");
  for (const line of stackEnv.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (key !== "OPENPALM_SETUP_COMPLETE") continue;
    return trimmed.slice(eq + 1).trim().toLowerCase() === "true";
  }
  return false;
}

export const load: PageServerLoad = async () => {
  const state = getState();
  if (isSetupComplete(state.stateDir)) {
    throw redirect(307, "/");
  }

  return {
    setupToken: state.setupToken,
    detectedUserId: detectUserId()
  };
};
