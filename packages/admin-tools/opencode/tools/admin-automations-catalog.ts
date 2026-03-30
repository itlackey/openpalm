import { tool } from "@opencode-ai/plugin";
import { adminFetch } from "./lib.ts";

const AUTOMATION_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

function validateName(name: string): string | null {
  if (!AUTOMATION_NAME_PATTERN.test(name)) {
    return "Invalid automation name. Use lowercase letters, numbers, and hyphens only (1-63 chars).";
  }
  return null;
}

export const list = tool({
  description: "List available automations from the registry catalog with their installed status",
  args: {},
  async execute() {
    return adminFetch("/admin/automations/catalog");
  },
});

export const install = tool({
  description: "Install an automation from the registry catalog into config/automations/. The scheduler auto-reloads.",
  args: {
    name: tool.schema.string().describe("The automation name to install (e.g. 'health-check', 'cleanup-logs')"),
  },
  async execute(args) {
    const error = validateName(args.name);
    if (error) return JSON.stringify({ error: true, message: error });
    return adminFetch("/admin/automations/catalog/install", {
      method: "POST",
      body: JSON.stringify({ name: args.name, type: "automation" }),
    });
  },
});

export const uninstall = tool({
  description: "Uninstall an automation by removing it from config/automations/. The scheduler auto-reloads.",
  args: {
    name: tool.schema.string().describe("The automation name to uninstall (e.g. 'health-check', 'cleanup-logs')"),
  },
  async execute(args) {
    const error = validateName(args.name);
    if (error) return JSON.stringify({ error: true, message: error });
    return adminFetch("/admin/automations/catalog/uninstall", {
      method: "POST",
      body: JSON.stringify({ name: args.name, type: "automation" }),
    });
  },
});

export const refresh = tool({
  description: "Refresh the registry catalog from the remote Git repository. Updates available addons and automations.",
  args: {},
  async execute() {
    return adminFetch("/admin/automations/catalog/refresh", {
      method: "POST",
      signal: AbortSignal.timeout(120_000),
    });
  },
});
