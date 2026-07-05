import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ControlPlaneState } from './types.js';
import { writeFileAtomic } from './fs-atomic.js';
import { buildComposeOptions } from './compose-args.js';
import { applyInstall } from './lifecycle.js';
import { buildManagedServices } from './lifecycle.js';
import { applyStack, composeDown, defaultStackDeps, detectExistingProject, resolveComposeProjectName, type ApplyStackResult } from './docker.js';
import { parseEnvFile } from './env.js';
import { patchStateEnvFile } from './secrets.js';
import { acquireInstallLock, releaseInstallLock } from './install-lock.js';
import { resolveBackupsDir } from './home.js';
import { stackEnvPath } from './paths.js';

export type DeployEntry = {
  service: string;
  status: 'pending' | 'running' | 'error' | 'warning';
  label: string;
};

export type DeployPhase = 'writing-config' | 'pulling-images' | 'starting' | 'starting-voice' | 'ready';

export type DeployJournal = {
  deploying: boolean;
  interrupted?: boolean;
  setupComplete: boolean;
  deployStatus: DeployEntry[];
  deployError: string | null;
  imageWarning: string | null;
  phase: DeployPhase;
  startedAt: string | null;
  pid: number | null;
};

export type DeployProgress = DeployJournal;

type RunDeployOptions = {
  journalPath?: string;
  onUpdate?: (state: DeployProgress) => void;
  markSetupComplete?: () => void;
};

const DEFAULT_DEPLOY_PROGRESS: DeployProgress = {
  deploying: false,
  setupComplete: false,
  deployStatus: [],
  deployError: null,
  imageWarning: null,
  phase: 'writing-config',
  startedAt: null,
  pid: null,
};

function cloneProgress(state: DeployProgress): DeployProgress {
  return { ...state, deployStatus: state.deployStatus.map((entry) => ({ ...entry })) };
}

function updateProgress(current: DeployProgress, patch: Partial<DeployProgress>): DeployProgress {
  return cloneProgress({ ...current, ...patch });
}

export function writeJournal(path: string, state: DeployProgress): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileAtomic(path, `${JSON.stringify(state, null, 2)}\n`, 0o600);
}

export function readDeployJournal(path: string): DeployProgress {
  if (!existsSync(path)) return cloneProgress(DEFAULT_DEPLOY_PROGRESS);
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<DeployProgress>;
    const state = updateProgress(DEFAULT_DEPLOY_PROGRESS, {
      deploying: parsed.deploying === true,
      interrupted: parsed.interrupted === true,
      setupComplete: parsed.setupComplete === true,
      deployStatus: Array.isArray(parsed.deployStatus)
        ? parsed.deployStatus.filter((entry): entry is DeployEntry => Boolean(entry && typeof entry.service === 'string' && typeof entry.label === 'string' && typeof entry.status === 'string'))
        : [],
      deployError: typeof parsed.deployError === 'string' ? parsed.deployError : null,
      imageWarning: typeof parsed.imageWarning === 'string' ? parsed.imageWarning : null,
      phase: parsed.phase ?? 'writing-config',
      startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : null,
      pid: typeof parsed.pid === 'number' ? parsed.pid : null,
    });
    if (state.deploying && state.pid && !isPidAlive(state.pid)) {
      state.deploying = false;
      state.interrupted = true;
      state.deployError = state.deployError ?? 'Deployment was interrupted. Retry to resume Docker deploy.';
    }
    return state;
  } catch {
    return cloneProgress(DEFAULT_DEPLOY_PROGRESS);
  }
}

export function resolveDeployJournalPath(state: ControlPlaneState): string {
  return join(state.dataDir, 'setup', 'deploy-journal.json');
}

function emitProgress(options: RunDeployOptions, state: DeployProgress): void {
  if (options.journalPath) writeJournal(options.journalPath, state);
  options.onUpdate?.(cloneProgress(state));
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function projectNameForState(state: ControlPlaneState): string {
  return resolveComposeProjectName(parseEnvFile(stackEnvPath(state)));
}

function resolveImageTag(state: ControlPlaneState): string {
  // Per-image versions replaced the single OP_IMAGE_TAG cascade. The assistant
  // is the version-of-record image; its tag is representative for the "dev tag ⇒
  // skip remote pull" heuristic. Fall back to the legacy OP_IMAGE_TAG for an
  // install whose stack.env predates the version migration.
  const env = parseEnvFile(stackEnvPath(state));
  return env.OP_ASSISTANT_VERSION ?? env.OP_IMAGE_TAG ?? '';
}

async function detectProjectCollision(state: ControlPlaneState): Promise<string | null> {
  const projectName = projectNameForState(state);
  const delays = [0, 1_000, 1_000];
  for (let attempt = 0; attempt < delays.length; attempt++) {
    if (delays[attempt] > 0) await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
    const existing = await detectExistingProject({ projectName, expectedWorkingDir: state.stackDir });
    if (!existing.exists) return null;
    if (existing.isOurs) return null;
    if (!existing.workingDir) continue;
    return `Refusing to deploy: docker project "${projectName}" is already running from ${existing.workingDir}, but this deploy would use OP_HOME=${state.homeDir}. Set OP_PROJECT_NAME to a distinct value in stack.env, or stop the existing stack first.`;
  }
  return `Refusing to deploy: docker project "${projectName}" could not be verified safely. Docker returned an existing project without a trustworthy working_dir label, so this deploy is failing closed.`;
}

function buildLogHint(state: ControlPlaneState, services: string[]): string {
  return `Check logs: docker compose -p ${projectNameForState(state)} logs ${services.join(' ')}.`;
}

// Same retry ladder the pre-2.2 pull step used: a first-time install's pull
// (multi-GB voice/assistant images) can hit a transient network blip, worth
// a couple of retries before giving up — but NOT when the failure is clearly
// permanent (bad tag, auth denied), so those fail fast instead of burning 20s.
const APPLY_STACK_RETRY_DELAYS_MS = [0, 5_000, 15_000];
const NON_TRANSIENT_FAILURE_RE = /manifest unknown|manifest for .* not found|unauthorized|authentication required|access denied/i;

/**
 * applyStack — the single compose driver (§4.3) — wrapped with the setup-time
 * retry ladder a first install needs on a slow/flaky connection. Retrying the
 * ONE driver call is not a second driver; it is the same reliability
 * engineering `detectProjectCollision` above already does for the collision
 * probe.
 */
async function applyStackWithRetry(
  composeOpts: ReturnType<typeof buildComposeOptions>,
  onService: NonNullable<Parameters<typeof applyStack>[3]>['onService'],
): Promise<ApplyStackResult> {
  let last: ApplyStackResult | undefined;
  for (const delay of APPLY_STACK_RETRY_DELAYS_MS) {
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    last = await applyStack(
      { kind: 'all' },
      composeOpts,
      defaultStackDeps,
      { onService, healthTimeoutMs: 5 * 60_000 },
    );
    if (last.ok || NON_TRANSIENT_FAILURE_RE.test(last.error ?? '')) return last;
  }
  return last!;
}

export function markSetupComplete(state: ControlPlaneState): void {
  // OP_SETUP_COMPLETE is an app-written record → state/ (constitution §1), not the
  // operator-facing knowledge/env/stack.env. isSetupComplete/classifyLocalInstall
  // merge state over legacy, so installs that recorded it in stack.env still read complete.
  patchStateEnvFile(state.homeDir, { OP_SETUP_COMPLETE: 'true' });
}

export function backupSetupInputs(state: ControlPlaneState): string | null {
  const stackEnvFile = stackEnvPath(state);
  const secretsDir = `${state.stashDir}/secrets`;
  if (!existsSync(stackEnvFile) && !existsSync(secretsDir)) return null;
  const backupDir = join(resolveBackupsDir(), `${new Date().toISOString().replace(/[:.]/g, '-')}-setup`);
  if (existsSync(stackEnvFile)) {
    const dest = join(backupDir, 'knowledge/env/stack.env');
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(stackEnvFile, dest);
  }
  if (existsSync(secretsDir)) {
    const copyDir = (sourceDir: string, targetDir: string) => {
      mkdirSync(targetDir, { recursive: true });
      for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
        const sourcePath = join(sourceDir, entry.name);
        const targetPath = join(targetDir, entry.name);
        if (entry.isDirectory()) {
          copyDir(sourcePath, targetPath);
          continue;
        }
        copyFileSync(sourcePath, targetPath);
      }
    };
    copyDir(secretsDir, join(backupDir, 'knowledge/secrets'));
  }
  return backupDir;
}

export async function runDeploy(state: ControlPlaneState, options: RunDeployOptions = {}): Promise<DeployProgress> {
  const progress = cloneProgress(DEFAULT_DEPLOY_PROGRESS);
  progress.deploying = true;
  progress.startedAt = new Date().toISOString();
  progress.pid = process.pid;
  emitProgress(options, progress);

  const lock = acquireInstallLock(state.dataDir);
  if (!lock) {
    progress.deploying = false;
    progress.deployError = "install_in_progress: A deploy is already running. Wait for it to finish (the lock clears itself automatically after 30 minutes). If you're sure nothing is running, run 'openpalm unlock' to clear a stale lock.";
    emitProgress(options, progress);
    return progress;
  }

  try {
    const collision = await detectProjectCollision(state);
    if (collision) {
      progress.deployError = collision;
      progress.deploying = false;
      emitProgress(options, progress);
      return progress;
    }

    progress.phase = 'writing-config';
    emitProgress(options, progress);
    await applyInstall(state, { lock });

    const services = await buildManagedServices(state);
    progress.deployStatus = services.map((service) => ({ service, status: 'pending', label: 'Waiting...' }));
    emitProgress(options, progress);

    const composeOpts = buildComposeOptions(state);
    try {
      await composeDown({ ...composeOpts, removeVolumes: false, removeOrphans: true });
    } catch {
      // Best-effort cleanup only.
    }

    progress.phase = 'starting';
    emitProgress(options, progress);

    // The single compose driver (§4.3, plan 2.2): ONE `up --pull missing
    // --force-recreate --remove-orphans` call, retried a couple of times for
    // a first install's transient network blips (a dev tag never needs a
    // network call at all — --pull missing skips it once the locally-built
    // image is present). onService reports each service's pending→terminal
    // transition straight into deployStatus as it happens.
    const imageTag = resolveImageTag(state);
    const isDevTag = imageTag.startsWith('dev');
    const onService = (service: string, status: 'pending' | 'running' | 'error', detail: string): void => {
      progress.deployStatus = progress.deployStatus.map((entry) =>
        entry.service === service ? { ...entry, status, label: detail } : entry,
      );
      emitProgress(options, progress);
    };
    const stackResult = await applyStackWithRetry(composeOpts, onService);

    if (!stackResult.ok) {
      progress.deployStatus = progress.deployStatus.map((entry) => {
        const failure = stackResult.failed.find((f) => f.service === entry.service);
        return failure ? { ...entry, status: 'error', label: failure.reason } : entry;
      });
      const failedServices = stackResult.failed.map((f) => f.service).filter((s) => services.includes(s));
      const hint = failedServices.length > 0 ? ` ${buildLogHint(state, failedServices)}` : '';
      progress.deployError = isDevTag
        ? `Dev images not found locally (tag: ${imageTag}). Run \`bun run dev:build\` from the project root to build them, then retry setup. (${stackResult.error ?? ''})`
        : `${stackResult.error ?? 'Deploy failed.'}${hint}`;
      progress.deploying = false;
      emitProgress(options, progress);
      return progress;
    }

    options.markSetupComplete?.();
    progress.deploying = false;
    progress.setupComplete = true;
    progress.phase = 'ready';
    emitProgress(options, progress);
    return progress;
  } finally {
    releaseInstallLock(lock);
  }
}
