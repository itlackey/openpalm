import { tool } from "@opencode-ai/plugin";
import { adminFetch } from "./lib.ts";

export const list = tool({
  description: "List all generated artifacts with their metadata (name, sha256 hash, generation time, size)",
  async execute() {
    return adminFetch("/admin/artifacts");
  },
});

export const manifest = tool({
  description: "Get the full artifact manifest with detailed metadata for all generated configuration files",
  async execute() {
    return adminFetch("/admin/artifacts/manifest");
  },
});

export const get = tool({
  description: "Get the raw content of a specific artifact. Use this to inspect the generated docker-compose.yml or Caddyfile.",
  args: {
    name: tool.schema.string().describe("The artifact to retrieve: 'compose' for docker-compose.yml, 'caddyfile' for Caddyfile"),
  },
  async execute(args) {
    return adminFetch(`/admin/artifacts/${args.name}`);
  },
});
