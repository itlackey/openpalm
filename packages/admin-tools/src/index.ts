import { type Plugin } from "@opencode-ai/plugin";

// Default-export tools (single tool per file)
import healthCheck from "../opencode/tools/health-check.ts";
import adminAudit from "../opencode/tools/admin-audit.ts";
import adminLogs from "../opencode/tools/admin-logs.ts";
import adminGuardianAudit from "../opencode/tools/admin-guardian-audit.ts";
import adminConfigValidate from "../opencode/tools/admin-config-validate.ts";
import adminConnectionsTest from "../opencode/tools/admin-connections-test.ts";
import adminProvidersLocal from "../opencode/tools/admin-providers-local.ts";
import adminMemoryModels from "../opencode/tools/admin-memory-models.ts";
import adminContainersInspect from "../opencode/tools/admin-containers-inspect.ts";
import adminContainersEvents from "../opencode/tools/admin-containers-events.ts";
import adminGuardianStats from "../opencode/tools/admin-guardian-stats.ts";
import adminNetworkCheck from "../opencode/tools/admin-network-check.ts";
import stackDiagnostics from "../opencode/tools/stack-diagnostics.ts";
import messageTrace from "../opencode/tools/message-trace.ts";

// Named-export tools (multiple tools per file)
import * as adminConfig from "../opencode/tools/admin-config.ts";
import * as adminContainers from "../opencode/tools/admin-containers.ts";
import * as adminArtifacts from "../opencode/tools/admin-artifacts.ts";
import * as adminConnections from "../opencode/tools/admin-connections.ts";
import * as adminChannels from "../opencode/tools/admin-channels.ts";
import * as adminLifecycle from "../opencode/tools/admin-lifecycle.ts";
import * as adminAutomations from "../opencode/tools/admin-automations.ts";

export const plugin: Plugin = async () => {
  return {
    tool: {
      // Single tools
      "admin-health-check": healthCheck,
      "admin-audit": adminAudit,
      "admin-logs": adminLogs,
      "admin-guardian-audit": adminGuardianAudit,
      "admin-config-validate": adminConfigValidate,
      "admin-connections-test": adminConnectionsTest,
      "admin-providers-local": adminProvidersLocal,
      "admin-memory-models": adminMemoryModels,
      "admin-containers-inspect": adminContainersInspect,
      "admin-containers-events": adminContainersEvents,
      "admin-guardian-stats": adminGuardianStats,
      "admin-network-check": adminNetworkCheck,
      "stack-diagnostics": stackDiagnostics,
      "message-trace": messageTrace,

      // admin-config
      "admin-config-get-access-scope": adminConfig.get_access_scope,
      "admin-config-set-access-scope": adminConfig.set_access_scope,

      // admin-containers
      "admin-containers-list": adminContainers.list,
      "admin-containers-up": adminContainers.up,
      "admin-containers-down": adminContainers.down,
      "admin-containers-restart": adminContainers.restart,

      // admin-artifacts
      "admin-artifacts-list": adminArtifacts.list,
      "admin-artifacts-manifest": adminArtifacts.manifest,
      "admin-artifacts-get": adminArtifacts.get,

      // admin-connections
      "admin-connections-get": adminConnections.get,
      "admin-connections-set": adminConnections.set,
      "admin-connections-status": adminConnections.status,

      // admin-channels
      "admin-channels-list": adminChannels.list,
      "admin-channels-install": adminChannels.install,
      "admin-channels-uninstall": adminChannels.uninstall,

      // admin-lifecycle
      "admin-lifecycle-install": adminLifecycle.install,
      "admin-lifecycle-update": adminLifecycle.update,
      "admin-lifecycle-uninstall": adminLifecycle.uninstall,
      "admin-lifecycle-installed": adminLifecycle.installed,
      "admin-lifecycle-upgrade": adminLifecycle.upgrade,

      // admin-automations
      "admin-automations-list": adminAutomations.list,
      "admin-automations-trigger": adminAutomations.trigger,
      "admin-automations-log": adminAutomations.log,
    },
  };
};
