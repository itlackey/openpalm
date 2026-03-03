import { tool } from "@opencode-ai/plugin";
import { adminFetch } from "./lib.ts";

const LONG_TIMEOUT = { signal: AbortSignal.timeout(120_000) };

export const list = tool({
  description: "List all discovered channels, their routing status (hasRoute), and whether they are built-in or community-added",
  async execute() {
    return adminFetch("/admin/channels");
  },
});

export const install = tool({
  description: "Install a channel from the registry. Copies channel files into config, generates an HMAC secret, re-stages artifacts, and runs docker compose up. Requires the channel name (e.g. 'chat').",
  args: {
    channel: tool.schema.string().describe("The channel name to install (e.g. 'chat', 'telegram')"),
  },
  async execute(args) {
    return adminFetch("/admin/channels/install", {
      method: "POST",
      body: JSON.stringify({ channel: args.channel }),
      ...LONG_TIMEOUT,
    });
  },
});

export const uninstall = tool({
  description: "Uninstall a channel. Removes channel files from config, removes the HMAC secret and service entry, re-stages artifacts, and stops the channel container. WARNING: This will stop the channel service.",
  args: {
    channel: tool.schema.string().describe("The channel name to uninstall (e.g. 'chat', 'telegram')"),
  },
  async execute(args) {
    return adminFetch("/admin/channels/uninstall", {
      method: "POST",
      body: JSON.stringify({ channel: args.channel }),
      ...LONG_TIMEOUT,
    });
  },
});
