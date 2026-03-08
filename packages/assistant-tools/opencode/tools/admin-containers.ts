import { tool } from "@opencode-ai/plugin";
import { adminFetch } from "./lib.ts";

const VALID_SERVICES = "caddy, memory, assistant, guardian, admin, channel-chat, channel-discord, channel-voice, channel-telegram";
const ALLOWED_SERVICES = new Set([
  "caddy",
  "memory",
  "assistant",
  "guardian",
  "admin",
  "channel-chat",
  "channel-discord",
  "channel-voice",
  "channel-telegram",
]);

function validateService(service: string): string | null {
  if (ALLOWED_SERVICES.has(service)) return null;
  return `Invalid service '${service}'. Valid services: ${VALID_SERVICES}`;
}

export const list = tool({
  description: "List all OpenPalm containers and their current status (running/stopped/healthy)",
  async execute() {
    return adminFetch("/admin/containers/list");
  },
});

export const up = tool({
  description: "Start a stopped OpenPalm service container",
  args: {
    service: tool.schema.string().describe(`The service to start. Valid: ${VALID_SERVICES}`),
  },
  async execute(args) {
    const error = validateService(args.service);
    if (error) return JSON.stringify({ error: true, message: error });
    return adminFetch("/admin/containers/up", {
      method: "POST",
      body: JSON.stringify({ service: args.service }),
    });
  },
});

export const down = tool({
  description: "Stop a running OpenPalm service container",
  args: {
    service: tool.schema.string().describe(`The service to stop. Valid: ${VALID_SERVICES}`),
  },
  async execute(args) {
    const error = validateService(args.service);
    if (error) return JSON.stringify({ error: true, message: error });
    return adminFetch("/admin/containers/down", {
      method: "POST",
      body: JSON.stringify({ service: args.service }),
    });
  },
});

export const restart = tool({
  description: "Restart an OpenPalm service container",
  args: {
    service: tool.schema.string().describe(`The service to restart. Valid: ${VALID_SERVICES}`),
  },
  async execute(args) {
    const error = validateService(args.service);
    if (error) return JSON.stringify({ error: true, message: error });
    return adminFetch("/admin/containers/restart", {
      method: "POST",
      body: JSON.stringify({ service: args.service }),
    });
  },
});
