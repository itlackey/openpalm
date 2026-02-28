import { tool } from "@opencode-ai/plugin";
import { adminFetch } from "./lib.ts";

const LONG_TIMEOUT = { signal: AbortSignal.timeout(120_000) };

export const install = tool({
  description: "Install the full OpenPalm stack. Creates directories, generates secrets, renders configuration artifacts, and starts all containers via docker compose. This is a heavyweight operation.",
  async execute() {
    return adminFetch("/admin/install", { method: "POST", ...LONG_TIMEOUT });
  },
});

export const update = tool({
  description: "Update the OpenPalm stack. Regenerates secrets and configuration artifacts, then applies changes by restarting containers. Use after config changes.",
  async execute() {
    return adminFetch("/admin/update", { method: "POST", ...LONG_TIMEOUT });
  },
});

export const uninstall = tool({
  description: "Uninstall the OpenPalm stack. Stops all containers via docker compose down, clears installed extensions, and regenerates artifacts. WARNING: This will stop all services.",
  async execute() {
    return adminFetch("/admin/uninstall", { method: "POST", ...LONG_TIMEOUT });
  },
});

export const installed = tool({
  description: "List installed extensions and the status of all services",
  async execute() {
    return adminFetch("/admin/installed");
  },
});
