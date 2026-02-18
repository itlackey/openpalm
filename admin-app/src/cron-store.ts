import { JsonStore } from "./admin-store.ts";

export type CronJob = {
  id: string;
  name: string;
  schedule: string;
  prompt: string;
  enabled: boolean;
  createdAt: string;
  lastRunAt?: string;
  lastResult?: "ok" | "error";
  lastError?: string;
};

export type CronState = {
  jobs: CronJob[];
};

export class CronStore {
  private store: JsonStore<CronState>;

  constructor(dataDir: string) {
    this.store = new JsonStore<CronState>(`${dataDir}/crons.json`, { jobs: [] });
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
    return true;
  }
}
