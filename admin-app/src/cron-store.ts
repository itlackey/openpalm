import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { JsonStore } from "./admin-store.ts";

export type CronJob = {
  id: string;
  name: string;
  schedule: string;
  prompt: string;
  enabled: boolean;
  createdAt: string;
};

export type CronState = {
  jobs: CronJob[];
};

/**
 * Manages cron job metadata (crons.json) and generates the crontab + payload
 * files that the opencode-core container's system cron daemon executes.
 *
 * Layout on the shared config volume:
 *   <crontabDir>/crontab              — installed by entrypoint.sh
 *   <crontabDir>/cron-payloads/<id>.json — curl reads these with -d @<file>
 */
export class CronStore {
  private store: JsonStore<CronState>;
  private crontabDir: string;
  private payloadDir: string;

  constructor(dataDir: string, crontabDir: string) {
    this.store = new JsonStore<CronState>(`${dataDir}/crons.json`, { jobs: [] });
    this.crontabDir = crontabDir;
    this.payloadDir = `${crontabDir}/cron-payloads`;
    mkdirSync(this.payloadDir, { recursive: true });
  }

  list(): CronJob[] {
    return this.store.get().jobs;
  }

  get(id: string): CronJob | undefined {
    return this.store.get().jobs.find((j) => j.id === id);
  }

  add(job: CronJob): void {
    const state = this.store.get();
    state.jobs.push(job);
    this.store.set(state);
  }

  update(id: string, fields: Partial<Omit<CronJob, "id" | "createdAt">>): CronJob | undefined {
    const state = this.store.get();
    const idx = state.jobs.findIndex((j) => j.id === id);
    if (idx === -1) return undefined;
    state.jobs[idx] = { ...state.jobs[idx], ...fields };
    this.store.set(state);
    return state.jobs[idx];
  }

  remove(id: string): boolean {
    const state = this.store.get();
    const before = state.jobs.length;
    state.jobs = state.jobs.filter((j) => j.id !== id);
    if (state.jobs.length === before) return false;
    this.store.set(state);
    // Clean up the payload file
    const payloadPath = `${this.payloadDir}/${id}.json`;
    if (existsSync(payloadPath)) rmSync(payloadPath);
    return true;
  }

  /**
   * Regenerates the crontab file and per-job JSON payloads from current state.
   * Call this after any mutation, then restart opencode-core so crond picks it up.
   */
  writeCrontab(): void {
    const jobs = this.store.get().jobs;
    const lines: string[] = [
      "# OpenPalm cron jobs — managed by admin-app, do not edit manually",
      "# Installed into opencode-core container by entrypoint.sh",
      "",
    ];

    for (const job of jobs) {
      // Write the JSON payload file (avoids shell-escaping issues)
      const payload = JSON.stringify({
        message: job.prompt,
        session_id: `cron-${job.id}`,
        user_id: "cron-scheduler",
        metadata: { source: "cron", cronJobId: job.id, cronJobName: job.name },
      });
      writeFileSync(`${this.payloadDir}/${job.id}.json`, payload);

      // Add crontab entry (commented out if disabled)
      const prefix = job.enabled ? "" : "# DISABLED: ";
      lines.push(`# ${job.name} (${job.id})`);
      lines.push(
        `${prefix}${job.schedule} curl -sf -m 120 -X POST http://localhost:4096/chat -H 'Content-Type: application/json' -d @/config/cron-payloads/${job.id}.json >/dev/null 2>&1`
      );
      lines.push("");
    }

    writeFileSync(`${this.crontabDir}/crontab`, lines.join("\n"));
  }
}

/**
 * Basic validation for 5-field cron expressions.
 * Returns null if valid, or an error message string.
 */
export function validateCron(expr: string): string | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return "cron expression must have exactly 5 fields";
  // Validate each field allows only cron-legal characters: digits, *, /, -, ,
  const fieldPattern = /^[\d*\/\-,]+$/;
  const labels = ["minute", "hour", "day-of-month", "month", "day-of-week"];
  for (let i = 0; i < 5; i++) {
    if (!fieldPattern.test(parts[i])) {
      return `invalid characters in ${labels[i]} field: "${parts[i]}"`;
    }
  }
  return null;
}
