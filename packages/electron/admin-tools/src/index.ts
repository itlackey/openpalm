/**
 * @openpalm/admin-tools-plugin — OpenCode plugin loaded into the Electron-
 * spawned ephemeral OpenCode server (Phase 3 of the auth/proxy refactor).
 *
 * Exposes admin-grade tools (compose lifecycle, secret-key listing,
 * endpoint enumeration, health checks) to the agent running on the host.
 *
 * Design notes:
 * - No appendAudit wrapping (D6a). OpenCode logs every tool invocation
 *   (args + result) natively at ${OP_HOME}/state/admin-opencode/log/.
 *   Adding a parallel audit on top would double the storage and create
 *   two timelines to reconcile during incident response.
 * - Tools NEVER return secret values. They list keys, run docker commands,
 *   ping health endpoints. Values stay with the operator + admin UI.
 * - No shell interpolation: every external command uses execFile with
 *   an argument array (repo rule).
 */
import { type Plugin } from "@opencode-ai/plugin";

import composeUp from "./tools/compose-up.js";
import composeDown from "./tools/compose-down.js";
import composePs from "./tools/compose-ps.js";
import secretsListKeys from "./tools/secrets-list-keys.js";
import endpointsList from "./tools/endpoints-list.js";
import healthCheck from "./tools/health-check.js";

export const plugin: Plugin = async () => {
  return {
    tool: {
      "compose.up": composeUp,
      "compose.down": composeDown,
      "compose.ps": composePs,
      "secrets.list-keys": secretsListKeys,
      "endpoints.list": endpointsList,
      "health-check": healthCheck,
    },
  };
};

export default plugin;
