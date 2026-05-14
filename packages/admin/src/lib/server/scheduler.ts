/**
 * Automation scheduler — re-exported from @openpalm/lib.
 *
 * Lifecycle functions (startScheduler, stopScheduler, reloadScheduler,
 * getSchedulerStatus, getExecutionLog) live in
 * packages/scheduler/src/scheduler.ts (the in-container co-process) —
 * they are not part of lib. Admin only needs loadAutomations here.
 */
export { loadAutomations } from "@openpalm/lib";
