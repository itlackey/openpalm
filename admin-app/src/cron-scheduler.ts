import { CronStore } from "./cron-store.ts";
import type { CronJob } from "./cron-store.ts";

/**
 * Lightweight cron expression parser supporting standard 5-field format:
 *   minute (0-59)  hour (0-23)  day-of-month (1-31)  month (1-12)  day-of-week (0-6, 0=Sunday)
 *
 * Supported syntax per field: *, N, N-M, N/step, *, star/step, N-M/step, comma-separated lists
 */

function parseField(field: string, min: number, max: number): number[] {
  const values = new Set<number>();

  for (const part of field.split(",")) {
    const trimmed = part.trim();

    // */step or *
    if (trimmed.startsWith("*")) {
      const step = trimmed.includes("/") ? parseInt(trimmed.split("/")[1], 10) : 1;
      if (isNaN(step) || step < 1) throw new Error(`invalid step in "${trimmed}"`);
      for (let i = min; i <= max; i += step) values.add(i);
      continue;
    }

    // range: N-M or N-M/step
    if (trimmed.includes("-")) {
      const [rangePart, stepPart] = trimmed.split("/");
      const [startStr, endStr] = rangePart.split("-");
      const start = parseInt(startStr, 10);
      const end = parseInt(endStr, 10);
      const step = stepPart ? parseInt(stepPart, 10) : 1;
      if (isNaN(start) || isNaN(end) || isNaN(step) || step < 1) {
        throw new Error(`invalid range "${trimmed}"`);
      }
      if (start < min || end > max) throw new Error(`range out of bounds "${trimmed}"`);
      for (let i = start; i <= end; i += step) values.add(i);
      continue;
    }

    // N/step (starting at N, every step)
    if (trimmed.includes("/")) {
      const [startStr, stepStr] = trimmed.split("/");
      const start = parseInt(startStr, 10);
      const step = parseInt(stepStr, 10);
      if (isNaN(start) || isNaN(step) || step < 1) throw new Error(`invalid step "${trimmed}"`);
      for (let i = start; i <= max; i += step) values.add(i);
      continue;
    }

    // single value
    const val = parseInt(trimmed, 10);
    if (isNaN(val) || val < min || val > max) throw new Error(`invalid value "${trimmed}"`);
    values.add(val);
  }

  return [...values].sort((a, b) => a - b);
}

export function parseCron(expr: string): { minutes: number[]; hours: number[]; daysOfMonth: number[]; months: number[]; daysOfWeek: number[] } {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error("cron expression must have exactly 5 fields");
  return {
    minutes: parseField(parts[0], 0, 59),
    hours: parseField(parts[1], 0, 23),
    daysOfMonth: parseField(parts[2], 1, 31),
    months: parseField(parts[3], 1, 12),
    daysOfWeek: parseField(parts[4], 0, 6),
  };
}

export function validateCron(expr: string): string | null {
  try {
    parseCron(expr);
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

function matchesCron(expr: string, date: Date): boolean {
  const cron = parseCron(expr);
  const minute = date.getMinutes();
  const hour = date.getHours();
  const dayOfMonth = date.getDate();
  const month = date.getMonth() + 1;
  const dayOfWeek = date.getDay();

  return (
    cron.minutes.includes(minute) &&
    cron.hours.includes(hour) &&
    cron.daysOfMonth.includes(dayOfMonth) &&
    cron.months.includes(month) &&
    cron.daysOfWeek.includes(dayOfWeek)
  );
}

export type CronSchedulerOptions = {
  store: CronStore;
  opencodeUrl: string;
  onRun?: (job: CronJob, result: "ok" | "error", error?: string) => void;
};

export class CronScheduler {
  private store: CronStore;
  private opencodeUrl: string;
  private onRun?: CronSchedulerOptions["onRun"];
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastCheckMinute = -1;

  constructor(opts: CronSchedulerOptions) {
    this.store = opts.store;
    this.opencodeUrl = opts.opencodeUrl;
    this.onRun = opts.onRun;
  }

  start(): void {
    if (this.timer) return;
    // Check every 15 seconds; only fire jobs once per matching minute
    this.timer = setInterval(() => this.tick(), 15_000);
    console.log(JSON.stringify({ kind: "cron-scheduler", event: "started" }));
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private tick(): void {
    const now = new Date();
    const currentMinute = now.getFullYear() * 100_000_000 + (now.getMonth() + 1) * 1_000_000 + now.getDate() * 10_000 + now.getHours() * 100 + now.getMinutes();

    // Only fire once per minute boundary
    if (currentMinute === this.lastCheckMinute) return;
    this.lastCheckMinute = currentMinute;

    const jobs = this.store.list();
    for (const job of jobs) {
      if (!job.enabled) continue;
      try {
        if (matchesCron(job.schedule, now)) {
          this.executeJob(job);
        }
      } catch {
        // invalid cron expression — skip silently
      }
    }
  }

  async executeJob(job: CronJob): Promise<void> {
    console.log(JSON.stringify({ kind: "cron-run", jobId: job.id, name: job.name }));
    try {
      const resp = await fetch(`${this.opencodeUrl}/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message: job.prompt,
          session_id: `cron-${job.id}`,
          user_id: "cron-scheduler",
          metadata: { source: "cron", cronJobId: job.id, cronJobName: job.name },
        }),
        signal: AbortSignal.timeout(120_000),
      });

      if (!resp.ok) {
        const text = await resp.text();
        this.store.update(job.id, { lastRunAt: new Date().toISOString(), lastResult: "error", lastError: `HTTP ${resp.status}: ${text.substring(0, 200)}` });
        this.onRun?.(job, "error", `HTTP ${resp.status}`);
        return;
      }

      this.store.update(job.id, { lastRunAt: new Date().toISOString(), lastResult: "ok", lastError: undefined });
      this.onRun?.(job, "ok");
    } catch (e) {
      const msg = String(e).substring(0, 200);
      this.store.update(job.id, { lastRunAt: new Date().toISOString(), lastResult: "error", lastError: msg });
      this.onRun?.(job, "error", msg);
    }
  }
}
