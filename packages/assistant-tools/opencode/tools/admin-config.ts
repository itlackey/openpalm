import { tool } from "@opencode-ai/plugin";
import { adminFetch } from "./lib.ts";

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
