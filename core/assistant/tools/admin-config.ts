import { tool } from "@opencode-ai/plugin";
import { adminFetch } from "./lib.ts";

export const get_config = tool({
  description: "Get the current OpenCode configuration for the assistant",
  async execute() {
    return adminFetch("/admin/config");
  },
});

export const update_config = tool({
  description: "Update the OpenCode configuration. The config must be a valid JSON string. Setting any permission to 'allow' is blocked by policy.",
  args: {
    config: tool.schema.string().describe("The full opencode config as a JSON string"),
    restart: tool.schema.string().optional().describe("Whether to restart the assistant after updating config (true/false)"),
  },
  async execute(args) {
    return adminFetch("/admin/config", {
      method: "POST",
      body: JSON.stringify({ config: args.config, restart: args.restart === "true" }),
    });
  },
});

export const get_access_scope = tool({
  description: "Get the current access scope (host-only or LAN)",
  async execute() {
    return adminFetch("/admin/access-scope");
  },
});

export const set_access_scope = tool({
  description: "Set the access scope to control who can reach OpenPalm services. 'host' restricts to localhost only, 'lan' allows local network access.",
  args: {
    scope: tool.schema.string().describe("The access scope to set: host or lan"),
  },
  async execute(args) {
    return adminFetch("/admin/access-scope", {
      method: "POST",
      body: JSON.stringify({ scope: args.scope }),
    });
  },
});
