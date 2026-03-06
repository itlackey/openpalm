import { type Plugin } from "@opencode-ai/plugin";
import { MemoryContextPlugin } from "../opencode/plugins/memory-context.ts";

// Default-export tools (single tool per file)
import healthCheck from "../opencode/tools/health-check.ts";
import adminAudit from "../opencode/tools/admin-audit.ts";
import memorySearch from "../opencode/tools/memory-search.ts";
import memoryAdd from "../opencode/tools/memory-add.ts";
import memoryUpdate from "../opencode/tools/memory-update.ts";
import memoryDelete from "../opencode/tools/memory-delete.ts";
import memoryGet from "../opencode/tools/memory-get.ts";
import memoryList from "../opencode/tools/memory-list.ts";
import memoryStats from "../opencode/tools/memory-stats.ts";
import memoryFeedback from "../opencode/tools/memory-feedback.ts";
import memoryEvents from "../opencode/tools/memory-events.ts";

// Named-export tools (multiple tools per file)
import * as adminConfig from "../opencode/tools/admin-config.ts";
import * as adminContainers from "../opencode/tools/admin-containers.ts";
import * as adminArtifacts from "../opencode/tools/admin-artifacts.ts";
import * as adminConnections from "../opencode/tools/admin-connections.ts";
import * as adminChannels from "../opencode/tools/admin-channels.ts";
import * as adminLifecycle from "../opencode/tools/admin-lifecycle.ts";
import * as adminAutomations from "../opencode/tools/admin-automations.ts";
import * as memoryApps from "../opencode/tools/memory-apps.ts";
import * as memoryExports from "../opencode/tools/memory-exports.ts";

export const plugin: Plugin = async (input) => {
  const memoryHooks = await MemoryContextPlugin(input);

  return {
    ...memoryHooks,
    tool: {
      // Single tools
      "health-check": healthCheck,
      "admin-audit": adminAudit,
      "memory-search": memorySearch,
      "memory-add": memoryAdd,
      "memory-update": memoryUpdate,
      "memory-delete": memoryDelete,
      "memory-get": memoryGet,
      "memory-list": memoryList,
      "memory-stats": memoryStats,
      "memory-feedback": memoryFeedback,
      "memory-events_get": memoryEvents,

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

      // memory-apps
      "memory-apps_list": memoryApps.list,
      "memory-apps_get": memoryApps.get,
      "memory-apps_memories": memoryApps.memories,

      // memory-exports
      "memory-exports_create": memoryExports.create,
      "memory-exports_get": memoryExports.get,
    },
  };
};
