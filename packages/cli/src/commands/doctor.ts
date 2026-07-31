/**
 * `openpalm doctor` — the UNIFIED diagnostics command (C2, plus S6/S7/S8 from
 * #581, per the maintainer's decided direction: one `doctor`, not a separate
 * `storage` command).
 *
 * Composes the already-exported lib checks (`checkDocker`,
 * `checkDockerCompose`, `detectRuntime`, `detectGpu`, `detectLocalProviders`)
 * with a TCP port probe (folding in container-ownership so a port held by
 * OUR OWN running stack never reads as a conflict), a disk-headroom reading,
 * a storage report, and a Docker image/volume retention report — plus two
 * gated actions: `--clean-caches` (S1/S8) and `--clean-docker` (S7).
 *
 * `runDoctorAction` takes an injectable `deps` object (mirroring
 * `project-rename.ts`'s `ProjectRenameDeps` pattern already used elsewhere in
 * this codebase) rather than being tested via `mock.module('@openpalm/lib')`
 * — a whole-module mock is process-global and, at this suite's scale,
 * observably leaks into unrelated test files that import the real
 * `@openpalm/lib` afterwards. Dependency injection keeps the test for this
 * file from ever touching global module state.
 */
import { defineCommand } from 'citty';
import { existsSync, statSync } from 'node:fs';
import {
  checkDiskHeadroom,
  checkDocker,
  checkDockerCompose,
  checkExistingUiInstance,
  cleanCaches,
  cleanupImagesAndVolumes,
  buildStorageReport,
  resolveBackupsDirFor,
  createOpenCodeClient,
  resolveOpenCodeCredential,
  resolveAssistantEndpoint,
  detectExistingProject,
  listSessionsPaged,
  toSessionRecord,
  type SessionDeletionClient,
  type SessionRecord,
  type SessionVisibilityPage,
  type RunMaintenanceResult,
  describeDiskHeadroom,
  detectGpu,
  detectLocalProviders,
  detectRuntime,
  formatStorageReport,
  probeInstallPorts,
  readStackEnv,
  reportImagesAndVolumes,
  resolveComposeProjectName,
  resolveEnvPort,
  DEFAULT_HOST_UI_PORT,
  DEFAULT_PUBLISHED_UI_PORT,
  STACK_DEFAULTS,
  resolveOpenCodeDbPath,
  runOpenCodeDbMaintenance,
  type ControlPlaneState,
  type DockerResult,
  type ExistingProject,
  type GpuInfo,
  type ImageVolumeReport,
  type InstallPortStatus,
  type InstallPortTarget,
  type LocalProviderDetection,
  type RuntimeInfo,
  type StorageReport,
  type UiInstanceCheck,
} from '@openpalm/lib';
import { resolveServeState } from '../lib/cli-state.ts';
import { promptYesNo } from '../lib/prompt.ts';

/** OpenCode DBs the reclaim action can VACUUM — the assistant and guardian stores (storage-report.ts). */
const RECLAIM_DB_ROLES = ['assistant', 'guardian'] as const;

export default defineCommand({
  meta: {
    name: 'doctor',
    description: 'Diagnose Docker, ports, runtime, and storage health for this OpenPalm install',
  },
  args: {
    'clean-caches': {
      type: 'boolean',
      description: 'Remove regenerable cache directories (never secrets/knowledge/sessions/the OpenCode DB)',
      default: false,
    },
    'clean-docker': {
      type: 'boolean',
      description: 'Remove superseded OpenPalm images and orphan project-scoped volumes (confirm-gated)',
      default: false,
    },
    'reclaim-db': {
      type: 'boolean',
      description: 'Checkpoint + VACUUM the OpenCode session DBs to reclaim disk (stop the stack first; confirm-gated)',
      default: false,
    },
    sessions: {
      type: 'boolean',
      description: 'List OpenCode sessions with parent/depth/age (needs the stack RUNNING)',
      default: false,
    },
    'prune-sessions': {
      type: 'boolean',
      description:
        'Delete stale ARCHIVED child sessions older than --max-age-days (needs the stack RUNNING; confirm-gated). Root sessions are never deleted.',
      default: false,
    },
    'max-age-days': {
      type: 'string',
      description: 'Required with --prune-sessions: only child sessions idle this many days are eligible',
    },
    'max-sessions': {
      type: 'string',
      description: 'Optional cap with --prune-sessions: keep at most this many sessions',
    },
    'dry-run': {
      type: 'boolean',
      description: 'With --prune-sessions: report what would be deleted, delete nothing',
      default: false,
    },
    yes: {
      type: 'boolean',
      alias: 'y',
      description: 'Skip the confirmation prompt for --clean-caches/--clean-docker/--reclaim-db/--prune-sessions',
      default: false,
    },
    json: {
      type: 'boolean',
      description: 'Print machine-readable JSON instead of a human report',
      default: false,
    },
  },
  // Not wrapped in defineAction (C10/B8): a successful run — one that produced
  // a full report, not a thrown error — must still be able to exit non-zero
  // when the report itself says Docker FAILed or a blocking port conflict is
  // unresolved, or `openpalm doctor` is useless for scripts that gate on it.
  // defineAction's own catch only fires on a THROWN error and always exits 1,
  // which can't express "ran fine, but here's what's wrong" — the same reason
  // `scan`/`audit-secrets` also manage their own exit codes.
  async run({ args }) {
    let report: DoctorReport;
    try {
      report = await runDoctorAction({
        cleanCaches: !!args['clean-caches'],
        cleanDocker: !!args['clean-docker'],
        reclaimDb: !!args['reclaim-db'],
        sessions: !!args.sessions,
        pruneSessions: !!args['prune-sessions'],
        maxAgeDays: args['max-age-days'] as string | undefined,
        maxSessions: args['max-sessions'] as string | undefined,
        dryRun: !!args['dry-run'],
        yes: !!args.yes,
        json: !!args.json,
      });
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
    process.exit(doctorReportHasFailure(report) ? 1 : 0);
  },
});

export interface DoctorReport {
  docker: DockerResult;
  compose: DockerResult;
  runtime: RuntimeInfo;
  gpu: GpuInfo | null;
  localProviders: LocalProviderDetection[];
  ports: InstallPortStatus[];
  diskHeadroom: ReturnType<typeof checkDiskHeadroom>;
  storage: StorageReport;
  dockerArtifacts: ImageVolumeReport;
  cleanCachesResult?: { removed: string[]; freedBytes: number; dryRun: boolean; skipped?: boolean };
  sessionsResult?: SessionVisibilityPage | { error: string };
  pruneSessionsResult?: RunMaintenanceResult | { error: string } | { skipped: true };
  cleanDockerResult?: { removedImages: string[]; removedVolumes: string[]; errors: string[]; skipped?: boolean };
  reclaimDbResult?: ReclaimDbResult;
}

/** Per-database outcome of `--reclaim-db`. */
export interface ReclaimDbEntry {
  role: (typeof RECLAIM_DB_ROLES)[number];
  path: string;
  present: boolean;
  vacuumed: boolean;
  freedBytes: number;
  error?: string;
}

export interface ReclaimDbResult {
  databases: ReclaimDbEntry[];
  skipped?: boolean;
}

export interface DoctorActionOptions {
  cleanCaches?: boolean;
  cleanDocker?: boolean;
  reclaimDb?: boolean;
  sessions?: boolean;
  pruneSessions?: boolean;
  maxAgeDays?: string;
  maxSessions?: string;
  dryRun?: boolean;
  yes?: boolean;
  json?: boolean;
}

/** Everything `runDoctorAction` calls out to lib/CLI-lib for — injectable so tests never need `mock.module`. */
export interface DoctorDeps {
  resolveServeState: typeof resolveServeState;
  checkDocker: typeof checkDocker;
  checkDockerCompose: typeof checkDockerCompose;
  detectRuntime: typeof detectRuntime;
  detectGpu: typeof detectGpu;
  detectLocalProviders: typeof detectLocalProviders;
  probeInstallPorts: typeof probeInstallPorts;
  /** Instance-identity probe (D1) — tells the admin (host UI) port apart from a foreign process on it; it is never a container, so no docker check can attribute it to "us". */
  checkExistingUiInstance: typeof checkExistingUiInstance;
  /** Ownership-by-project probe (deploy.ts's own collision check) — tells a custom OP_PROJECT_NAME's OWN containers apart from a real foreign conflict on the ui/assistant ports. */
  detectExistingProject: typeof detectExistingProject;
  checkDiskHeadroom: typeof checkDiskHeadroom;
  describeDiskHeadroom: typeof describeDiskHeadroom;
  buildStorageReport: typeof buildStorageReport;
  formatStorageReport: typeof formatStorageReport;
  reportImagesAndVolumes: typeof reportImagesAndVolumes;
  resolveComposeProjectName: typeof resolveComposeProjectName;
  readStackEnv: typeof readStackEnv;
  cleanCaches: typeof cleanCaches;
  cleanupImagesAndVolumes: typeof cleanupImagesAndVolumes;
  resolveOpenCodeDbPath: typeof resolveOpenCodeDbPath;
  runOpenCodeDbMaintenance: typeof runOpenCodeDbMaintenance;
  buildSessionClient: (homeDir: string) => SessionDeletionClient;
  promptYesNo: typeof promptYesNo;
}

export const defaultDoctorDeps: DoctorDeps = {
  resolveServeState,
  checkDocker,
  checkDockerCompose,
  detectRuntime,
  detectGpu,
  detectLocalProviders,
  probeInstallPorts,
  checkExistingUiInstance,
  detectExistingProject,
  checkDiskHeadroom,
  describeDiskHeadroom,
  buildStorageReport,
  formatStorageReport,
  reportImagesAndVolumes,
  resolveComposeProjectName,
  readStackEnv,
  cleanCaches,
  cleanupImagesAndVolumes,
  resolveOpenCodeDbPath,
  runOpenCodeDbMaintenance,
  buildSessionClient,
  promptYesNo,
};

/**
 * Run every doctor check and return the composed report (also used directly
 * by tests via the injectable `deps` param — the CLI `run` above is a thin
 * args-parsing wrapper that always uses the real `defaultDoctorDeps`).
 */
export async function runDoctorAction(
  opts: DoctorActionOptions = {},
  deps: DoctorDeps = defaultDoctorDeps,
): Promise<DoctorReport> {
  const state = deps.resolveServeState();
  const homeDir = state.homeDir;

  const [docker, compose, runtime, gpu, localProviders] = await Promise.all([
    deps.checkDocker(),
    deps.checkDockerCompose(),
    deps.detectRuntime(),
    deps.detectGpu(),
    deps.detectLocalProviders(),
  ]);

  const ports = await deps.probeInstallPorts(undefined, { dockerAvailable: docker.ok });
  const diskHeadroom = deps.checkDiskHeadroom(homeDir);
  const storage = await deps.buildStorageReport({
    homeDir,
    // Honor OP_BACKUP_DIR — the report otherwise measures data/backups even
    // when backups are configured onto another filesystem entirely.
    backupsDir: resolveBackupsDirFor(homeDir),
    skipDocker: !docker.ok,
  });

  const projectName = deps.resolveComposeProjectName(deps.readStackEnv(homeDir));
  const dockerArtifacts = docker.ok
    ? await deps.reportImagesAndVolumes({ projectName })
    : { reliable: false, error: 'Docker unavailable', images: [], supersededImages: [], volumes: [], orphanVolumes: [] };

  const report: DoctorReport = { docker, compose, runtime, gpu, localProviders, ports, diskHeadroom, storage, dockerArtifacts };

  if (opts.cleanCaches) {
    report.cleanCachesResult = await performCleanCaches(homeDir, storage, deps, opts.yes);
  }
  if (opts.cleanDocker) {
    report.cleanDockerResult = await performCleanDocker(dockerArtifacts, deps, opts.yes);
  }
  if (opts.reclaimDb) {
    report.reclaimDbResult = await performReclaimDb(homeDir, deps, opts.yes);
  }
  // --sessions / --prune-sessions need the assistant RUNNING (they use its REST
  // API), the exact opposite of --reclaim-db, which needs it stopped so VACUUM
  // can take an exclusive lock. Kept as separate flags for that reason.
  if (opts.sessions) {
    report.sessionsResult = await performListSessions(homeDir, deps);
  }
  if (opts.pruneSessions) {
    report.pruneSessionsResult = await performPruneSessions(homeDir, deps, opts);
  }

  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printDoctorReport(report);
  }

  return report;
}

/**
 * Build a SessionDeletionClient over the live assistant. Thin adapter only —
 * endpoint precedence lives in lib's resolveAssistantEndpoint and the REST
 * calls in lib's createOpenCodeClient; this just shims deleteSession's
 * ProxyResult into the {ok,message} shape the maintenance module declares.
 */
function buildSessionClient(homeDir: string): SessionDeletionClient {
  const client = createOpenCodeClient({
    baseUrl: resolveAssistantEndpoint(homeDir),
    // OpenCode authenticates every client, loopback included, once
    // `assistantDirect` is on — without this, session maintenance 401s on
    // exactly the installs that published the assistant API.
    ...resolveOpenCodeCredential(homeDir),
  });
  return {
    listSessions: () => client.listSessions(),
    deleteSession: async (id: string) => {
      const res = await client.deleteSession(id);
      // ProxyResult's failure branch carries `message` (+ status/code); the
      // success branch carries neither, so narrow on `ok` before reading.
      return res.ok ? { ok: true } : { ok: false, message: res.message || `HTTP ${res.status}` };
    },
  };
}

async function performListSessions(
  homeDir: string,
  deps: DoctorDeps,
): Promise<SessionVisibilityPage | { error: string }> {
  let sessions: SessionRecord[];
  try {
    sessions = (await deps.buildSessionClient(homeDir).listSessions()).map(toSessionRecord);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`Could not list sessions: ${message}. Is the stack running? Start it with \`openpalm start\`.`);
    return { error: message };
  }

  const page = listSessionsPaged(sessions, {});
  console.log(
    `\nSessions: ${page.totalSessions} total, ${page.summary.rootCount} root, ` +
      `max depth ${page.summary.maxDepth}, ${page.summary.staleCount} archived.`,
  );
  console.log(`Page ${page.page} of ${page.totalPages}.`);
  for (const row of page.rows) {
    const kind = row.parentID ? `child(d${row.depth})` : 'root';
    const age = `${Math.floor(row.ageMs / 86_400_000)}d`;
    const flag = row.archived ? ' archived' : '';
    console.log(`  ${row.id}  ${kind.padEnd(11)} age ${age.padStart(5)}${flag}`);
  }
  return page;
}

async function performPruneSessions(
  homeDir: string,
  deps: DoctorDeps,
  opts: DoctorActionOptions,
): Promise<RunMaintenanceResult | { error: string } | { skipped: true }> {
  // A retention WINDOW is mandatory: the maintenance module refuses a live
  // client without one, deliberately, so nobody deletes history by reflex.
  const days = Number(opts.maxAgeDays);
  if (!Number.isFinite(days) || days <= 0) {
    const error = '--prune-sessions requires --max-age-days <n> (a positive number of days).';
    console.error(error);
    return { error };
  }
  const maxSessions = opts.maxSessions === undefined ? undefined : Number(opts.maxSessions);
  if (maxSessions !== undefined && (!Number.isInteger(maxSessions) || maxSessions <= 0)) {
    const error = '--max-sessions must be a positive integer.';
    console.error(error);
    return { error };
  }

  if (!opts.dryRun && !opts.yes) {
    const ok = await deps.promptYesNo(
      `Delete archived child sessions idle more than ${days} day(s)? ` +
        'Root sessions are never deleted. Run with --dry-run first to preview. [y/N]',
    );
    if (!ok) {
      console.log('Session pruning skipped.');
      return { skipped: true };
    }
  }

  try {
    const result = await deps.runOpenCodeDbMaintenance(
      deps.buildSessionClient(homeDir),
      deps.resolveOpenCodeDbPath(homeDir, 'assistant'),
      {
        confirm: true,
        dryRun: opts.dryRun,
        retention: {
          maxChildAgeMs: days * 86_400_000,
          ...(maxSessions === undefined ? {} : { maxSessions }),
        },
        // VACUUM needs the assistant STOPPED; this path needs it running.
        // Reclaim disk separately with `openpalm doctor --reclaim-db`.
        skipVacuumStage: true,
      },
    );
    const verb = result.dryRun ? 'Would delete' : 'Deleted';
    console.log(
      `${verb} ${result.plan.deleteSessionIds.length} session(s); ` +
        `kept ${result.plan.rootCount} root and ${result.plan.preservedChildIds.length} recent child session(s).`,
    );
    if (result.deleteFailures.length > 0) {
      console.warn(`Some deletions failed: ${result.deleteFailures.map((f) => f.id).join(', ')}`);
    }
    if (!result.dryRun && result.plan.deleteSessionIds.length > 0) {
      console.log('Run `openpalm stop && openpalm doctor --reclaim-db` to reclaim the freed disk space.');
    }
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`Session pruning failed: ${message}. Is the stack running?`);
    return { error: message };
  }
}

async function performCleanCaches(
  homeDir: string,
  storage: StorageReport,
  deps: DoctorDeps,
  yes?: boolean,
): Promise<NonNullable<DoctorReport['cleanCachesResult']>> {
  if (storage.totalCacheBytes === 0) {
    console.log('No cache directories to clean.');
    return { removed: [], freedBytes: 0, dryRun: false };
  }
  if (!yes) {
    const ok = await deps.promptYesNo(
      `Remove ${storage.caches.filter((c) => c.exists).map((c) => c.relativePath).join(', ')} (regenerable caches only)? [y/N]`,
    );
    if (!ok) {
      console.log('Cache cleanup skipped. Re-run with --yes to skip this prompt.');
      return { removed: [], freedBytes: 0, dryRun: false, skipped: true };
    }
  }
  const result = deps.cleanCaches(homeDir, { confirm: true });
  console.log(`Removed caches: ${result.removed.join(', ') || '(none)'} — freed approximately ${result.freedBytes} bytes.`);
  return result;
}

async function performCleanDocker(
  report: ImageVolumeReport,
  deps: DoctorDeps,
  yes?: boolean,
): Promise<NonNullable<DoctorReport['cleanDockerResult']>> {
  if (!report.reliable) {
    console.log(`Skipping Docker image/volume cleanup: ${report.error ?? 'docker unavailable'}`);
    return { removedImages: [], removedVolumes: [], errors: [], skipped: true };
  }
  if (report.supersededImages.length === 0 && report.orphanVolumes.length === 0) {
    console.log('No superseded OpenPalm images or orphan volumes to remove.');
    return { removedImages: [], removedVolumes: [], errors: [] };
  }
  if (!yes) {
    const summary = [
      ...report.supersededImages.map((i) => `image ${i.repository}:${i.tag} (${i.id})`),
      ...report.orphanVolumes.map((v) => `volume ${v.name}`),
    ].join(', ');
    const ok = await deps.promptYesNo(`Remove these OpenPalm-owned artifacts: ${summary}? [y/N]`);
    if (!ok) {
      console.log('Docker cleanup skipped. Re-run with --yes to skip this prompt.');
      return { removedImages: [], removedVolumes: [], errors: [], skipped: true };
    }
  }
  const result = await deps.cleanupImagesAndVolumes(report, { confirm: true });
  console.log(
    `Removed images: ${result.removedImages.join(', ') || '(none)'}; removed volumes: ${result.removedVolumes.join(', ') || '(none)'}.`,
  );
  if (result.errors.length > 0) console.warn(`Some removals failed: ${result.errors.join('; ')}`);
  return result;
}

async function performReclaimDb(
  homeDir: string,
  deps: DoctorDeps,
  yes?: boolean,
): Promise<ReclaimDbResult> {
  // Discover which OpenCode DBs actually exist on disk (a chat-only install has
  // no guardian DB; a fresh install may have neither).
  const present = RECLAIM_DB_ROLES
    .map((role) => ({ role, path: deps.resolveOpenCodeDbPath(homeDir, role) }))
    .filter((d) => existsSync(d.path));

  if (present.length === 0) {
    console.log('No OpenCode session databases found — nothing to reclaim.');
    return { databases: [] };
  }

  if (!yes) {
    const ok = await deps.promptYesNo(
      `Checkpoint + VACUUM ${present.map((d) => d.role).join(', ')} OpenCode DB(s) to reclaim disk? ` +
        'The stack should be stopped first so the assistant is not writing to the DB. [y/N]',
    );
    if (!ok) {
      console.log('DB reclamation skipped. Stop the stack (openpalm stop) and re-run with --yes to skip this prompt.');
      return { databases: [], skipped: true };
    }
  }

  const databases: ReclaimDbEntry[] = [];
  for (const { role, path } of present) {
    const before = safeFileSize(path);
    try {
      // client: null → file-only reclamation (checkpoint + conditional VACUUM),
      // never a live REST session-delete. VACUUM needs the assistant stopped;
      // a live server would hold a lock, so we never try to reach one here.
      const result = await deps.runOpenCodeDbMaintenance(null, path, { confirm: true });
      const after = safeFileSize(path);
      databases.push({
        role,
        path,
        present: true,
        vacuumed: result.vacuumed,
        freedBytes: Math.max(0, before - after),
      });
    } catch (err) {
      // A locked DB (assistant still running) fails cleanly here — sqlite never
      // corrupts a busy VACUUM, it just refuses. Surface it as actionable.
      const message = err instanceof Error ? err.message : String(err);
      databases.push({ role, path, present: true, vacuumed: false, freedBytes: 0, error: message });
    }
  }

  for (const d of databases) {
    if (d.error) {
      console.warn(
        `  ${d.role}: could not reclaim (${d.error}). Is the stack running? Stop it with \`openpalm stop\` and retry.`,
      );
    } else if (d.vacuumed) {
      console.log(`  ${d.role}: reclaimed approximately ${d.freedBytes} bytes.`);
    } else {
      console.log(`  ${d.role}: already compact — no VACUUM needed.`);
    }
  }
  return { databases };
}

/** Best-effort file size (0 if the file is gone or unreadable) — used to bracket the VACUUM. */
function safeFileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function printDoctorReport(report: DoctorReport): void {
  console.log(`Docker: ${report.docker.ok ? 'ok' : 'FAIL'}${report.docker.stdout ? ` (${report.docker.stdout.trim()})` : ''}`);
  if (!report.docker.ok) console.log(`  ${report.docker.stderr || '(no further detail)'}`);
  console.log(`Compose: ${report.compose.ok ? 'ok' : 'FAIL'}`);
  console.log(`Runtime: ${report.runtime.runtimeName ?? 'unknown'}${report.runtime.dockerVersion ? ` ${report.runtime.dockerVersion}` : ''}`);
  console.log(`GPU: ${report.gpu ? `${report.gpu.vendor} ${report.gpu.name}` : 'none detected'}`);
  const hostProviders = report.localProviders.filter((p) => p.available);
  console.log(`Local providers: ${hostProviders.length > 0 ? hostProviders.map((p) => p.provider).join(', ') : 'none detected'}`);

  console.log('Ports:');
  for (const p of report.ports) {
    const state = p.available ? 'available' : p.blocking ? 'CONFLICT' : 'in use (non-blocking)';
    const note = p.ownership === 'ours' || p.ownership === 'held' ? ' — held by OpenPalm itself' : p.ownership === 'unreachable' ? ' — could not verify ownership' : '';
    console.log(`  ${p.service} (${p.port}): ${state}${note}`);
  }

  const headroomWarning = describeDiskHeadroom(report.diskHeadroom);
  console.log(`Disk headroom: ${report.diskHeadroom.status}${headroomWarning ? ` — ${headroomWarning}` : ''}`);

  console.log(formatStorageReport(report.storage));

  if (report.dockerArtifacts.reliable) {
    if (report.dockerArtifacts.supersededImages.length > 0) {
      console.log('Superseded OpenPalm images:');
      for (const i of report.dockerArtifacts.supersededImages) console.log(`  ${i.repository}:${i.tag} (${i.id}, ${i.size})`);
    }
    if (report.dockerArtifacts.orphanVolumes.length > 0) {
      console.log('Orphan OpenPalm volumes:');
      for (const v of report.dockerArtifacts.orphanVolumes) console.log(`  ${v.name}`);
    }
    if (report.dockerArtifacts.supersededImages.length === 0 && report.dockerArtifacts.orphanVolumes.length === 0) {
      console.log('No superseded images or orphan volumes found.');
    }
  }
}
