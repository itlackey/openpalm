/**
 * Automation scheduler — re-exported from @openpalm/lib.
 *
 * Lifecycle functions (startScheduler, stopScheduler, reloadScheduler,
 * getSchedulerStatus, getExecutionLog) live in
 * packages/scheduler/src/scheduler.ts (the in-container co-process) —
 * they are not part of lib. Admin only needs parsing helpers here.
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
