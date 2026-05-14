import { type Plugin } from "@opencode-ai/plugin";

// Default-export tools (single tool per file)
import loadVault from "../opencode/tools/load_vault.ts";
import healthCheck from "../opencode/tools/health-check.ts";

export const plugin: Plugin = async () => {
  const tools: Record<string, unknown> = {
    "load_vault": loadVault,
    "health-check": healthCheck,
  };

  return {
    tool: tools,
  };
};
