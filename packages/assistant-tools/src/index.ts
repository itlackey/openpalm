import { type Plugin } from "@opencode-ai/plugin";
import { MemoryContextPlugin } from "../opencode/plugins/memory-context.ts";
import { isVikingConfigured } from "../opencode/tools/viking-lib.ts";

// Default-export tools (single tool per file)
import loadVault from "../opencode/tools/load_vault.ts";
import healthCheck from "../opencode/tools/health-check.ts";
import memorySearch from "../opencode/tools/memory-search.ts";
import memoryAdd from "../opencode/tools/memory-add.ts";
import memoryUpdate from "../opencode/tools/memory-update.ts";
import memoryDelete from "../opencode/tools/memory-delete.ts";
import memoryGet from "../opencode/tools/memory-get.ts";
import memoryList from "../opencode/tools/memory-list.ts";
import memoryStats from "../opencode/tools/memory-stats.ts";
import memoryFeedback from "../opencode/tools/memory-feedback.ts";
import memoryEvents from "../opencode/tools/memory-events.ts";

// Viking tools
import vikingSearch from "../opencode/tools/viking-search.ts";
import vikingGrep from "../opencode/tools/viking-grep.ts";
import vikingBrowse from "../opencode/tools/viking-browse.ts";
import vikingRead from "../opencode/tools/viking-read.ts";
import vikingAddResource from "../opencode/tools/viking-add-resource.ts";
import vikingOverview from "../opencode/tools/viking-overview.ts";

// Named-export tools (multiple tools per file)
import * as memoryApps from "../opencode/tools/memory-apps.ts";
import * as memoryExports from "../opencode/tools/memory-exports.ts";

export const plugin: Plugin = async (input) => {
  const memoryHooks = await MemoryContextPlugin(input);

  // Build tool map — Viking tools only when configured
  const tools: Record<string, unknown> = {
    // Single tools
    "load_vault": loadVault,
    "health-check": healthCheck,
    "memory-search": memorySearch,
    "memory-add": memoryAdd,
    "memory-update": memoryUpdate,
    "memory-delete": memoryDelete,
    "memory-get": memoryGet,
    "memory-list": memoryList,
    "memory-stats": memoryStats,
    "memory-feedback": memoryFeedback,
    "memory-events_get": memoryEvents,

    // memory-apps
    "memory-apps_list": memoryApps.list,
    "memory-apps_get": memoryApps.get,
    "memory-apps_memories": memoryApps.memories,

    // memory-exports
    "memory-exports_create": memoryExports.create,
    "memory-exports_get": memoryExports.get,
  };

  if (isVikingConfigured()) {
    tools["viking-search"] = vikingSearch;
    tools["viking-grep"] = vikingGrep;
    tools["viking-browse"] = vikingBrowse;
    tools["viking-read"] = vikingRead;
    tools["viking-add-resource"] = vikingAddResource;
    tools["viking-overview"] = vikingOverview;
  }

  return {
    ...memoryHooks,
    tool: tools,
  };
};
