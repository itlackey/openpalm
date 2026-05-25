import { type Plugin } from "@opencode-ai/plugin";

import loadVault from "../opencode/tools/load_vault.ts";

export const plugin: Plugin = async () => {
  return {
    tool: { "load_vault": loadVault },
  };
};
