import { tool } from "@opencode-ai/plugin";
import { adminFetch } from "./lib.ts";

const LONG_TIMEOUT = { signal: AbortSignal.timeout(120_000) };
const ADDON_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

function validateAddonName(name: string): string | null {
  if (!ADDON_NAME_PATTERN.test(name)) {
    return "Invalid addon name. Use lowercase letters, numbers, and hyphens only.";
  }
  return null;
}

export const list = tool({
  description: "List catalog addons from registry/addons with their enabled state from stack/addons",
  args: {},
  async execute() {
    return adminFetch("/admin/addons");
  },
});

export const install = tool({
  description: "Enable an addon by copying it from registry/addons into stack/addons. Generates HMAC secrets for channel addons.",
  args: {
    addon: tool.schema.string().describe("The addon name to enable (e.g. 'chat', 'discord', 'ollama')"),
  },
  async execute(args) {
    const error = validateAddonName(args.addon);
    if (error) return JSON.stringify({ error: true, message: error });
    return adminFetch(`/admin/addons/${encodeURIComponent(args.addon)}`, {
      method: "POST",
      body: JSON.stringify({ enabled: true }),
      ...LONG_TIMEOUT,
    });
  },
});

export const uninstall = tool({
  description: "Disable an addon by removing it from stack/addons. WARNING: This stops the addon service.",
  args: {
    addon: tool.schema.string().describe("The addon name to disable (e.g. 'chat', 'discord', 'ollama')"),
  },
  async execute(args) {
    const error = validateAddonName(args.addon);
    if (error) return JSON.stringify({ error: true, message: error });
    return adminFetch(`/admin/addons/${encodeURIComponent(args.addon)}`, {
      method: "POST",
      body: JSON.stringify({ enabled: false }),
      ...LONG_TIMEOUT,
    });
  },
});
