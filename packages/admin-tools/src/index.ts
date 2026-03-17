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
      "health-check": healthCheck,
      "admin-audit": adminAudit,
      "admin-logs": adminLogs,
      "admin-guardian_audit": adminGuardianAudit,
      "admin-config_validate": adminConfigValidate,
      "admin-connections_test": adminConnectionsTest,
      "admin-providers_local": adminProvidersLocal,
      "admin-memory_models": adminMemoryModels,
      "admin-containers_inspect": adminContainersInspect,
      "admin-containers_events": adminContainersEvents,
      "admin-guardian_stats": adminGuardianStats,
      "admin-network_check": adminNetworkCheck,
      "stack-diagnostics": stackDiagnostics,
      "message-trace": messageTrace,

      // admin-config
      "admin-config_get_access_scope": adminConfig.get_access_scope,
      "admin-config_set_access_scope": adminConfig.set_access_scope,

      // admin-containers
      "admin-containers_list": adminContainers.list,
      "admin-containers_up": adminContainers.up,
      "admin-containers_down": adminContainers.down,
      "admin-containers_restart": adminContainers.restart,

      // admin-artifacts
      "admin-artifacts_list": adminArtifacts.list,
      "admin-artifacts_manifest": adminArtifacts.manifest,
      "admin-artifacts_get": adminArtifacts.get,

      // admin-connections
      "admin-connections_get": adminConnections.get,
      "admin-connections_set": adminConnections.set,
      "admin-connections_status": adminConnections.status,

      // admin-channels
      "admin-channels_list": adminChannels.list,
      "admin-channels_install": adminChannels.install,
      "admin-channels_uninstall": adminChannels.uninstall,

      // admin-lifecycle
      "admin-lifecycle_install": adminLifecycle.install,
      "admin-lifecycle_update": adminLifecycle.update,
      "admin-lifecycle_uninstall": adminLifecycle.uninstall,
      "admin-lifecycle_installed": adminLifecycle.installed,
      "admin-lifecycle_upgrade": adminLifecycle.upgrade,

      // admin-automations
      "admin-automations_list": adminAutomations.list,
    },
  };
};
