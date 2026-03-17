/**
 * Action executor registry — dispatches to the correct executor by type.
 */
import type { AutomationAction } from "@openpalm/lib";
import { executeApiAction } from "./api.js";
import { executeAssistantAction } from "./assistant.js";
import { executeHttpAction } from "./http.js";
import { executeShellAction } from "./shell.js";

export { executeApiAction } from "./api.js";
export { executeAssistantAction } from "./assistant.js";
export { executeHttpAction } from "./http.js";
export { executeShellAction } from "./shell.js";

/** Dispatch to the correct action executor by type. */
export async function executeAction(
  action: AutomationAction,
  adminToken: string,
): Promise<void> {
  switch (action.type) {
    case "api":
      return executeApiAction(action, adminToken);
    case "http":
      return executeHttpAction(action);
    case "shell":
      return executeShellAction(action);
    case "assistant":
      return executeAssistantAction(action);
    default:
      throw new Error(`Unknown action type: ${(action as { type: string }).type}`);
  }
}
