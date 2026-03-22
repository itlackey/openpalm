/**
 * Automation scheduler — re-exported from @openpalm/lib.
 *
 * Lifecycle functions (startScheduler, stopScheduler, reloadScheduler,
 * getSchedulerStatus, getExecutionLog, getAllExecutionLogs) live in
 * packages/scheduler/src/scheduler.ts — they are not part of lib.
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
} from "@openpalm/lib";
