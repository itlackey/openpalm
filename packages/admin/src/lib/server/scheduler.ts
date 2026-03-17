/**
 * Automation scheduler — re-exported from @openpalm/lib.
 */
export type {
  ActionType,
  AutomationAction,
  AutomationConfig,
  ExecutionLogEntry,
} from "@openpalm/lib";

export {
  SCHEDULE_PRESETS,
  resolveSchedule,
  parseAutomationYaml,
  loadAutomations,
  executeAction,
  startScheduler,
  stopScheduler,
  reloadScheduler,
  getSchedulerStatus,
  getExecutionLog,
  getAllExecutionLogs,
} from "@openpalm/lib";
