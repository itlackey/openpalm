/**
 * endpoints.list — return the known OpenCode endpoints from
 * ${OP_HOME}/config/endpoints.json (Phase 5 / D4 of the auth/proxy
 * refactor — see docs/technical/auth-and-proxy-refactor-plan.md).
 *
 * Returns ids, labels, urls — NEVER passwords. The agent has no reason to
 * see endpoint credentials.
 */
import { tool } from "@opencode-ai/plugin";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

type EndpointEntry = {
  id: string;
  label: string;
  url: string;
  password?: string;
};

type EndpointsFile = {
  activeId: string | null;
  endpoints: EndpointEntry[];
};

function opHome(): string {
  return process.env.OP_HOME ?? join(process.env.HOME ?? "", ".openpalm");
}

export function endpointsPath(home = opHome()): string {
  return join(home, "config", "endpoints.json");
}

export function readEndpointsFile(path: string): EndpointsFile {
  if (!existsSync(path)) return { activeId: null, endpoints: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<EndpointsFile>;
    return {
      activeId: typeof parsed.activeId === "string" ? parsed.activeId : null,
      endpoints: Array.isArray(parsed.endpoints) ? parsed.endpoints as EndpointEntry[] : [],
    };
  } catch {
    return { activeId: null, endpoints: [] };
  }
}

export default tool({
  description:
    "List the OpenCode endpoints configured in OpenPalm (id, label, URL). " +
    "Never includes passwords. The active id is also returned.",
  args: {},
  async execute() {
    const data = readEndpointsFile(endpointsPath());
    return JSON.stringify({
      activeId: data.activeId,
      endpoints: data.endpoints.map((e) => ({ id: e.id, label: e.label, url: e.url })),
    }, null, 2);
  },
});
