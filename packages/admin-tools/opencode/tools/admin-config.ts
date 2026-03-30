import { tool } from "@opencode-ai/plugin";
import { adminFetch } from "./lib.ts";

export const get_access_scope = tool({
  description: "Get the current connection status and configuration",
  async execute() {
    return adminFetch("/admin/connections/status");
  },
});

export const set_access_scope = tool({
  description: "Network scope configuration has been removed. Bind addresses are managed via stack.env variables (OP_*_BIND_ADDRESS). Use the admin UI or edit vault/stack/stack.env directly.",
  args: {
    scope: tool.schema.enum(["host", "lan"]).describe("The access scope: host or lan"),
  },
  async execute(_args) {
    return { ok: false, error: "Access scope is now managed via OP_*_BIND_ADDRESS variables in vault/stack/stack.env. Edit the env file directly or use the admin UI." };
  },
});
