import { redirect } from "@sveltejs/kit";
import { getState } from "$lib/server/state.js";
import { detectUserId, isSetupComplete } from "$lib/server/setup-status.js";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async () => {
  const state = getState();
  if (isSetupComplete(state.stateDir, state.configDir)) {
    throw redirect(307, "/");
  }

  return {
    setupToken: state.setupToken,
    detectedUserId: detectUserId()
  };
};
