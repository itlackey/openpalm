import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import type { ControlPlaneState } from './types.js';
import { writeFileAtomic } from './fs-atomic.js';
import { buildComposeOptions } from './compose-args.js';
import { applyInstall } from './lifecycle.js';
import { buildManagedServices } from './lifecycle.js';
import { composeDown, composePs, composePull, composeUp, detectExistingProject, resolveComposeProjectName } from './docker.js';
import { mapDockerError } from './compose-errors.js';
import { mergeEnvContent, parseEnvFile } from './env.js';
import { acquireInstallLock, releaseInstallLock, type InstallLockHandle } from './install-lock.js';
import { resolveBackupsDir } from './home.js';

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

type ComposeContainerState = {
  service: string;
  state: string;
  health: string;
};

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
  return resolveComposeProjectName(parseEnvFile(`${state.stashDir}/env/stack.env`));
}

function parseComposePsOutput(stdout: string): ComposeContainerState[] {
  const results: ComposeContainerState[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      results.push({
        service: String(obj.Service ?? obj.Name ?? ''),
        state: String(obj.State ?? ''),
        health: String(obj.Health ?? ''),
      });
    } catch {
      continue;
    }
  }
  return results;
}

function resolveImageTag(state: ControlPlaneState): string {
  return parseEnvFile(`${state.stashDir}/env/stack.env`).OP_IMAGE_TAG ?? '';
}

async function missingServiceImages(composeOpts: ReturnType<typeof buildComposeOptions>, services: string[]): Promise<string[]> {
  if (services.length === 0) return [];
  const args = [
    'compose',
    ...composeOpts.files.flatMap((file) => ['-f', file]),
    ...(composeOpts.envFiles ?? []).filter((file) => existsSync(file)).flatMap((file) => ['--env-file', file]),
    ...composeOpts.profiles.flatMap((profile) => ['--profile', profile]),
    'config', '--format', 'json',
  ];
  const config = await new Promise<{ services?: Record<string, { image?: string }> }>((resolve) => {
    execFile('docker', args, { timeout: 30_000 }, (error, stdout) => {
      if (error) return resolve({});
      try {
        resolve(JSON.parse(stdout.toString()) as { services?: Record<string, { image?: string }> });
      } catch {
        resolve({});
      }
    });
  });
  const serviceConfig = config.services ?? {};
  const missing: string[] = [];
  for (const service of services) {
    const image = serviceConfig[service]?.image;
    if (!image) {
      missing.push(`${service} (image unknown)`);
      continue;
    }
    const present = await new Promise<boolean>((resolve) => {
      execFile('docker', ['image', 'inspect', image], { timeout: 5_000 }, (error) => resolve(!error));
    });
    if (!present) missing.push(image);
  }
  return missing;
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

async function pollContainerHealth(state: ControlPlaneState, progress: DeployProgress, services: string[], options: RunDeployOptions): Promise<string | null> {
  const composeOpts = buildComposeOptions(state);
  const deadline = Date.now() + 5 * 60_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    const psResult = await composePs(composeOpts);
    if (!psResult.ok) continue;
    const containers = parseComposePsOutput(psResult.stdout);
    progress.deployStatus = progress.deployStatus.map((entry) => {
      const found = containers.find((container) => container.service === entry.service);
      if (!found) return { ...entry, status: 'pending', label: 'Starting...' };
      if (found.state === 'running') {
        if (found.health === 'unhealthy') return { ...entry, status: 'error', label: 'Unhealthy' };
        if (found.health === 'starting') return { ...entry, status: 'pending', label: 'Health check running...' };
        return { ...entry, status: 'running', label: 'Running' };
      }
      if (found.state === 'exited' || found.state === 'dead') return { ...entry, status: 'error', label: `Exited (${found.state})` };
      return { ...entry, status: 'pending', label: `Starting (${found.state})...` };
    });
    emitProgress(options, progress);

    const failed = progress.deployStatus.filter((entry) => entry.status === 'error').map((entry) => entry.service);
    if (failed.length > 0) {
      return `Services started but the following did not become healthy: ${failed.join(', ')}. ${buildLogHint(state, failed)}`;
    }
    const allReady = services.every((service) => progress.deployStatus.find((entry) => entry.service === service)?.status === 'running');
    if (allReady) return null;
  }

  const unhealthy = progress.deployStatus.filter((entry) => entry.status !== 'running').map((entry) => entry.service);
  return `Services started but some did not become healthy in time: ${unhealthy.join(', ')}. ${buildLogHint(state, unhealthy)}`;
}

export function markSetupComplete(state: ControlPlaneState): void {
  const path = `${state.stashDir}/env/stack.env`;
  const existing = existsSync(path) ? readFileSync(path, 'utf-8') : '';
  writeFileAtomic(path, mergeEnvContent(existing, { OP_SETUP_COMPLETE: 'true' }), 0o600);
}

export function backupSetupInputs(state: ControlPlaneState): string | null {
  const stackEnvPath = `${state.stashDir}/env/stack.env`;
  const secretsDir = `${state.stashDir}/secrets`;
  if (!existsSync(stackEnvPath) && !existsSync(secretsDir)) return null;
  const backupDir = join(resolveBackupsDir(), `${new Date().toISOString().replace(/[:.]/g, '-')}-setup`);
  if (existsSync(stackEnvPath)) {
    const dest = join(backupDir, 'knowledge/env/stack.env');
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(stackEnvPath, dest);
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

    progress.phase = 'pulling-images';
    emitProgress(options, progress);
    const imageTag = resolveImageTag(state);
    const isDevTag = imageTag.startsWith('dev');
    let pullResult: Awaited<ReturnType<typeof composePull>> | null = null;
    if (!isDevTag) {
      for (const delay of [0, 5_000, 15_000]) {
        if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
        pullResult = await composePull(composeOpts);
        if (pullResult.ok) break;
        if (/manifest unknown|manifest for .* not found|unauthorized|authentication required|access denied/i.test(pullResult.stderr ?? '')) break;
      }
    }

    if (isDevTag || !pullResult || !pullResult.ok) {
      const missing = await missingServiceImages(composeOpts, services);
      if (missing.length > 0) {
        progress.deployStatus = progress.deployStatus.map((entry) => ({ ...entry, status: 'error', label: 'Image pull failed' }));
        progress.deployError = isDevTag
          ? `Dev images not found locally (tag: ${imageTag}): ${missing.join(', ')}. Run \`bun run dev:build\` from the project root to build them, then retry setup.`
          : mapDockerError(pullResult?.stderr?.trim() || 'Image pull failed').message;
        progress.deploying = false;
        emitProgress(options, progress);
        return progress;
      }
      if (!isDevTag && pullResult && !pullResult.ok) {
        progress.imageWarning = `Couldn't download the latest images (network or registry issue), so the install used the images already on your machine — these may be out of date. Check your connection and re-run setup or Update to pull the newest versions.`;
        emitProgress(options, progress);
      }
    }

    progress.phase = 'starting';
    progress.deployStatus = progress.deployStatus.map((entry) => ({ ...entry, status: 'pending', label: 'Starting...' }));
    emitProgress(options, progress);
    const upResult = await composeUp({ ...composeOpts, services, forceRecreate: true, removeOrphans: true });
    if (!upResult.ok) {
      progress.deployStatus = progress.deployStatus.map((entry) => ({ ...entry, status: 'error', label: mapDockerError(upResult.stderr ?? 'compose up failed').message }));
      progress.deployError = mapDockerError(upResult.stderr ?? 'compose up failed').message;
      progress.deploying = false;
      emitProgress(options, progress);
      return progress;
    }

    const healthError = await pollContainerHealth(state, progress, services, options);
    if (healthError) {
      progress.deployError = healthError;
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
