import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ControlPlaneState } from './types.js';
import { CORE_SERVICES } from './types.js';
import { writeFileAtomic } from './fs-atomic.js';
import { buildComposeOptions } from './compose-args.js';
import { applyInstall } from './lifecycle.js';
import { buildManagedServices } from './lifecycle.js';
import { applyStack, composeDown, composePs, detectExistingProject, parseComposePsRows, resolveComposeProjectName } from './docker.js';
import { parseEnvFile } from './env.js';
import { patchStateEnvFile } from './secrets.js';
import { acquireInstallLock, releaseInstallLock, isProcessAlive } from './install-lock.js';
import { resolveBackupsDir } from './home.js';
import { stackEnvPath } from './paths.js';
import { discoverStackOverlays } from './config-persistence.js';
import { auditComposeSecrets } from './secret-audit.js';
import { validateProposedState } from './validate.js';
import { createLogger } from '../logger.js';

const deployLogger = createLogger('deploy');

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
    if (state.deploying && state.pid && !isProcessAlive(state.pid)) {
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

/**
 * §2.1: `compose up -d --wait` IS the health gate now — this no longer polls
 * or decides pass/fail. Demoted + renamed from the old pollContainerHealth
 * gate: ONE `compose ps` call refreshes the per-service display labels the UI
 * shows. On a successful `up`, `--wait` already confirmed every requested
 * service is healthy, so every entry is marked running regardless of what
 * this best-effort ps call sees. On a failed `up`, the same single call NAMES
 * which services didn't come up (§2.1's "one compose ps --format json call
 * names the failed services"), split into CORE_SERVICES vs everything else —
 * runDeploy gates setup-completion on core only.
 */
async function refreshDeployStatus(
  state: ControlPlaneState,
  progress: DeployProgress,
  upFailed: boolean,
): Promise<{ failedCore: string[]; failedOptional: string[] }> {
  const composeOpts = buildComposeOptions(state);
  const psResult = await composePs(composeOpts);
  const rows = psResult.ok ? parseComposePsRows(psResult.stdout) : [];
  const coreServices: string[] = CORE_SERVICES;

  const failedCore: string[] = [];
  const failedOptional: string[] = [];

  progress.deployStatus = progress.deployStatus.map((entry) => {
    const row = rows.find((r) => r.service === entry.service);
    const healthy = row?.state === 'running' && row.health !== 'unhealthy';
    if (healthy || !upFailed) {
      return { ...entry, status: 'running', label: 'Running' };
    }
    (coreServices.includes(entry.service) ? failedCore : failedOptional).push(entry.service);
    const label = !row ? 'Did not start' : row.health === 'unhealthy' ? 'Unhealthy' : `Exited (${row.state || 'unknown'})`;
    return { ...entry, status: 'error', label };
  });

  return { failedCore, failedOptional };
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

/**
 * Secret-boundary + runtime-config gate the deploy runs before it touches any
 * container (S.2.2). Before this, neither `auditComposeSecrets` nor
 * `validateProposedState` was invoked outside the manual `openpalm audit-secrets`
 * command, so an apply could grant a secret across the boundary unchecked. Runs
 * `auditComposeSecrets` over the on-disk compose overlays plus
 * `validateProposedState`; `error`-severity audit issues and validation errors
 * block the deploy, warnings are returned for the caller to log and continue.
 */
export async function auditApplyState(
  state: ControlPlaneState,
): Promise<{ errors: string[]; warnings: string[] }> {
  const errors: string[] = [];
  const warnings: string[] = [];

  for (const file of discoverStackOverlays(state.homeDir)) {
    for (const auditIssue of auditComposeSecrets(readFileSync(file, 'utf-8'))) {
      const where = auditIssue.path ? `${file}:${auditIssue.path}` : file;
      const line = `${auditIssue.code}: ${auditIssue.message} (${where})`;
      (auditIssue.severity === 'error' ? errors : warnings).push(line);
    }
  }

  const validation = await validateProposedState(state);
  errors.push(...validation.errors);
  warnings.push(...validation.warnings);

  return { errors, warnings };
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

    // Validate the written config BEFORE touching containers (S.2.2). Route a
    // blocking failure through deployError — the same user-visible surface as a
    // compose failure — so an unauthorized secret grant refuses the deploy.
    const audit = await auditApplyState(state);
    for (const warning of audit.warnings) deployLogger.warn(warning);
    if (audit.errors.length > 0) {
      progress.deployError = `Refusing to deploy: configuration validation failed.\n${audit.errors.join('\n')}`;
      progress.deploying = false;
      emitProgress(options, progress);
      return progress;
    }

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
    progress.deployStatus = progress.deployStatus.map((entry) => ({ ...entry, status: 'pending', label: 'Starting...' }));
    emitProgress(options, progress);

    // The single compose driver (§4.3, plan 2.2): ONE `up --pull missing --wait
    // --force-recreate --remove-orphans` call — no separate pull step. `--pull
    // missing` never makes a network call for a locally-built dev image (a
    // present image is not "missing"); a changed pin makes its tag "missing" so
    // compose pulls it in the same `up` and a pull failure is fatal. `--wait` is
    // the health gate; a wider health timeout tolerates a first install's slow
    // cold boot of multi-GB images.
    const imageTag = resolveImageTag(state);
    const isDevTag = imageTag.startsWith('dev');
    const stackResult = await applyStack({ kind: 'all' }, composeOpts, undefined, { pull: 'missing', healthTimeoutMs: 5 * 60_000 });

    if (!stackResult.ok) {
      // ONE `compose ps` refreshes the per-service display labels and splits the
      // failures into CORE vs OPTIONAL — setup-completion gates on core only, so
      // an addon/portal hiccup can't wedge a fresh install (§2.1). `upFailed`
      // means nothing came up at all, always a hard failure.
      const { failedCore, failedOptional } = await refreshDeployStatus(state, progress, true);
      if (failedCore.length > 0 || stackResult.upFailed) {
        const allFailed = [...failedCore, ...failedOptional];
        progress.deployError = isDevTag
          ? `Dev images not found locally or failed to start (tag: ${imageTag}): ${allFailed.join(', ')}. Run \`bun run dev:build\` from the project root to build them, then retry setup.`
          : `Services started but the following did not become healthy: ${allFailed.join(', ')}. ${buildLogHint(state, allFailed)}`;
        progress.deploying = false;
        emitProgress(options, progress);
        return progress;
      }
      // Only OPTIONAL (non-core) services failed — setup completes anyway
      // (§2.1: markSetupComplete gates on CORE_SERVICES only, never the full
      // managed set, so an addon/portal hiccup can't wedge a fresh install).
      progress.imageWarning = `The following optional service(s) did not start correctly and were skipped: ${failedOptional.join(', ')}. ${buildLogHint(state, failedOptional)}`;
      options.markSetupComplete?.();
      progress.deploying = false;
      progress.setupComplete = true;
      progress.phase = 'ready';
      emitProgress(options, progress);
      return progress;
    }

    await refreshDeployStatus(state, progress, false);
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
