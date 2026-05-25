/**
 * In-process deploy state for the setup wizard.
 *
 * Tracks Docker Compose deploy progress during first-time setup.
 * State lives in this module so the polling endpoint can read it
 * without a database or filesystem dependency.
 */
import {
  acquireInstallLock,
  applyInstall,
  buildComposeOptions,
  buildManagedServices,
  composeDown,
  composePull,
  composePs,
  composeUp,
  createLogger,
  getAddonProfiles,
  getAddonProfileSelection,
  isSetupComplete,
  listEnabledAddonIds,
  releaseInstallLock,
  resolveStackDir,
  setAddonProfileSelection,
} from "@openpalm/lib";
import type { ControlPlaneState, InstallLockHandle } from "@openpalm/lib";
import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";

const logger = createLogger("admin:setup-deploy");

export type DeployEntry = {
  service: string;
  status: "pending" | "running" | "error";
  label: string;
};

export type DeployPhase =
  | "writing-config"
  | "pulling-images"
  | "starting"
  | "starting-voice"
  | "ready";

type DeployState = {
  deploying: boolean;
  setupComplete: boolean;
  deployStatus: DeployEntry[];
  deployError: string | null;
  phase: DeployPhase;
};

let _state: DeployState = {
  deploying: false,
  setupComplete: false,
  deployStatus: [],
  deployError: null,
  phase: "writing-config",
};

export function getDeployState(): DeployState {
  // Reconcile after a server restart: if setup is complete on disk, reflect that.
  if (!_state.setupComplete && !_state.deploying && isSetupComplete(resolveStackDir())) {
    _state.setupComplete = true;
  }
  return { ..._state, deployStatus: [..._state.deployStatus] };
}

export function resetDeployState(): void {
  _state = {
    deploying: false,
    setupComplete: false,
    deployStatus: [],
    deployError: null,
    phase: "writing-config",
  };
}

// ── Docker stderr → friendly error messages ──────────────────────────────

/**
 * Map opaque Docker/compose stderr text to a human-friendly error message.
 * If no pattern matches, the raw message is returned prefixed with a generic header.
 */
function mapDockerError(raw: string): string {
  if (/cannot connect to the docker daemon|docker daemon is not running/i.test(raw)) {
    return "Docker Desktop appears to have stopped. Start Docker, then click Retry.";
  }
  const portMatch = /bind: address already in use.*?:(\d+)/i.exec(raw);
  if (portMatch) {
    return `Port ${portMatch[1]} is already in use by another program. Free it (or quit the other app) and click Retry.`;
  }
  if (/Cannot find specified .* file|no such file or directory/i.test(raw)) {
    return "A required configuration file is missing. Try re-running setup.";
  }
  if (/permission denied/i.test(raw)) {
    return "Permission denied. Check that ~/.openpalm and Docker have permission to write.";
  }
  if (/no space left on device|ENOSPC/i.test(raw)) {
    return "Your disk is full. Free up space and click Retry.";
  }
  return `Deployment ran into a problem: ${raw}`;
}

// ── Setup-complete flag (atomic write) ───────────────────────────────────

/**
 * Atomic-merge OP_SETUP_COMPLETE=true into stack.env. Called only after every
 * container has reported healthy — until then the wizard must remain
 * resumable, so the flag is intentionally not written by performSetup.
 */
function markSetupComplete(state: ControlPlaneState): void {
  const path = `${state.stackDir}/stack.env`;
  const existing = existsSync(path) ? readFileSync(path, "utf-8") : "";
  // Inline mergeEnvContent semantics: if OP_SETUP_COMPLETE exists, replace it;
  // otherwise append. Keep this dumb — one key, no edge cases worth a helper.
  const lines = existing.split("\n");
  let replaced = false;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trimStart();
    const eq = trimmed.indexOf("=");
    if (eq > 0 && trimmed.slice(0, eq).trim() === "OP_SETUP_COMPLETE") {
      lines[i] = "OP_SETUP_COMPLETE=true";
      replaced = true;
      break;
    }
  }
  if (!replaced) {
    if (lines.length > 0 && lines[lines.length - 1] === "") {
      lines[lines.length - 1] = "OP_SETUP_COMPLETE=true";
      lines.push("");
    } else {
      lines.push("OP_SETUP_COMPLETE=true");
    }
  }
  let merged = lines.join("\n");
  if (!merged.endsWith("\n")) merged += "\n";
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, merged, { mode: 0o600 });
  renameSync(tmp, path);
}

// ── Container health polling ─────────────────────────────────────────────

type ContainerState = {
  name: string;
  state: string;   // "running", "exited", etc.
  health: string;  // "healthy", "unhealthy", "starting", or "" if no healthcheck
};

/**
 * Parse `docker compose ps --format json` output into a list of container states.
 * Compose outputs one JSON object per line (NDJSON), not a JSON array.
 */
function parseComposePsOutput(stdout: string): ContainerState[] {
  const results: ContainerState[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      results.push({
        name: String(obj["Name"] ?? obj["Service"] ?? ""),
        state: String(obj["State"] ?? ""),
        health: String(obj["Health"] ?? ""),
      });
    } catch {
      // Skip unparseable lines
    }
  }
  return results;
}

/**
 * Poll container health for `services` until all are running (and healthy if
 * they declare a healthcheck). Updates `_state.deployStatus` with intermediate
 * labels as containers flip states.
 *
 * @returns null on success, or an error string if timeout fires with unhealthy services.
 */
async function pollContainerHealth(
  composeOpts: Parameters<typeof composePs>[0],
  services: string[],
  timeoutMs: number,
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  const POLL_INTERVAL_MS = 2_000;

  while (Date.now() < deadline) {
    await new Promise<void>((r) => setTimeout(r, POLL_INTERVAL_MS));

    const psResult = await composePs(composeOpts);
    if (!psResult.ok) {
      // docker ps failed — not fatal yet, keep polling
      logger.warn("composePs failed during health poll", { stderr: psResult.stderr });
      continue;
    }

    const containers = parseComposePsOutput(psResult.stdout);

    // Update per-service status labels
    _state.deployStatus = _state.deployStatus.map((entry) => {
      const found = containers.find(
        (c) => c.name === entry.service || c.name.endsWith(`-${entry.service}-1`) || c.name.endsWith(`_${entry.service}_1`)
      );
      if (!found) return { ...entry, status: "pending", label: "Starting..." };
      if (found.state === "running") {
        const health = found.health;
        if (health === "unhealthy") return { ...entry, status: "error", label: "Unhealthy" };
        if (health === "starting") return { ...entry, status: "pending", label: "Health check running..." };
        // healthy or no healthcheck declared
        return { ...entry, status: "running", label: "Running" };
      }
      if (found.state === "exited" || found.state === "dead") {
        return { ...entry, status: "error", label: `Exited (${found.state})` };
      }
      return { ...entry, status: "pending", label: `Starting (${found.state})...` };
    });

    // Check if all services are up
    const allReady = services.every((svc) => {
      const entry = _state.deployStatus.find((e) => e.service === svc);
      return entry?.status === "running";
    });
    if (allReady) return null;

    // Bail early if any service is in a terminal error state
    const failed = _state.deployStatus.filter((e) => e.status === "error").map((e) => e.service);
    if (failed.length > 0) {
      const projectName = process.env.OP_PROJECT_NAME ?? process.env.COMPOSE_PROJECT_NAME ?? "openpalm";
      return (
        `Services started but the following did not become healthy: ${failed.join(", ")}. ` +
        `Check logs: docker compose -p ${projectName} logs ${failed.join(" ")}.`
      );
    }
  }

  // Timeout — collect which services are still not running
  const unhealthy = _state.deployStatus
    .filter((e) => e.status !== "running")
    .map((e) => e.service);
  const projectName = process.env.OP_PROJECT_NAME ?? process.env.COMPOSE_PROJECT_NAME ?? "openpalm";
  return (
    `Services started but some did not become healthy in time: ${unhealthy.join(", ")}. ` +
    `Check logs: docker compose -p ${projectName} logs ${unhealthy.join(" ")}.`
  );
}

// ── Project-name collision guard ─────────────────────────────────────────

/**
 * Pre-flight: refuse to deploy if existing containers in this compose
 * project belong to a DIFFERENT OP_HOME than the one we're about to deploy.
 * Without this, two stacks (e.g. dev and host) that share the default
 * "openpalm" project name will silently clobber each other.
 */
async function checkProjectNameCollision(state: ControlPlaneState): Promise<string | null> {
  // Use docker CLI directly — composePs would require running the same
  // compose file set we're about to launch, which is what we're guarding.
  const { execFile } = await import("node:child_process");
  return new Promise((resolve) => {
    execFile(
      "docker",
      ["ps", "-q", "--filter", `label=com.docker.compose.project=${process.env.OP_PROJECT_NAME ?? "openpalm"}`],
      (err, stdout) => {
        if (err) return resolve(null); // docker not running / no permissions — let composeUp surface it
        const ids = stdout.toString().trim().split(/\s+/).filter(Boolean);
        if (ids.length === 0) return resolve(null);
        // Inspect the first container's working_dir label to learn which OP_HOME it belongs to.
        execFile(
          "docker",
          ["inspect", "--format", '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}', ids[0]],
          (err2, stdout2) => {
            if (err2) return resolve(null);
            const runningHome = stdout2.toString().trim();
            if (runningHome && runningHome !== state.homeDir) {
              resolve(
                `Refusing to deploy: docker project "${process.env.OP_PROJECT_NAME ?? "openpalm"}" is already running with OP_HOME=${runningHome}, ` +
                `but this deploy would use OP_HOME=${state.homeDir}. Set OP_PROJECT_NAME to a distinct value in stack.env, ` +
                `or stop the existing stack first.`
              );
              return;
            }
            resolve(null);
          },
        );
      },
    );
  });
}

// ── Main deploy entry point ──────────────────────────────────────────────

/** Kick off a background Docker Compose deploy. Returns immediately. */
export function startDeploy(state: ControlPlaneState): void {
  // Acquire install lock before mutating _state so concurrent calls are rejected
  // before any deploy work begins.
  const lockHandle: InstallLockHandle | null = acquireInstallLock(state.stateDir);
  if (lockHandle === null) {
    _state.deployError =
      "install_in_progress: Another install is in progress. Wait for it to finish, or remove state/.install.lock if you're sure no install is running.";
    logger.warn("deploy rejected: install lock already held", { stateDir: state.stateDir });
    return;
  }

  _state.deploying = true;
  _state.deployError = null;
  _state.phase = "writing-config";

  void (async () => {
    try {
      // Pre-flight: detect cross-OP_HOME project-name collision and refuse.
      const collision = await checkProjectNameCollision(state);
      if (collision) {
        logger.error("deploy aborted: project name collision", { error: collision });
        _state.deployError = collision;
        return;
      }

      // Phase 1: write compose files, env, etc.
      await applyInstall(state);
      const services = await buildManagedServices(state);
      _state.deployStatus = services.map(s => ({ service: s, status: "pending", label: "Waiting..." }));

      // Phase 1b: best-effort `compose down` (volumes preserved) to clean up
      // any half-started containers left behind by a previous failed deploy
      // attempt. Without this, `compose up` may try to attach to a container
      // that exited mid-start and fail in surprising ways. Failures here are
      // expected on first install (nothing to remove) and intentionally
      // swallowed.
      const composeOpts = buildComposeOptions(state);
      try {
        const downResult = await composeDown({ ...composeOpts, removeVolumes: false });
        if (!downResult.ok) {
          logger.info("pre-deploy compose down returned non-zero (likely nothing to remove)", {
            stderr: downResult.stderr?.slice(0, 500),
          });
        }
      } catch (err) {
        logger.warn("pre-deploy compose down threw — continuing", {
          error: err instanceof Error ? err.message : String(err),
        });
      }

      // Phase 2: pull images. Surface this phase explicitly so the UI can
      // explain the expected wait time (multi-GB images on first install).
      // Retry transient pull failures (network blips, registry hiccups) up to
      // three times with 0/5s/15s back-off. Permanent failures (manifest
      // unknown, unauthorized) bail immediately.
      _state.phase = "pulling-images";
      const pullDelaysMs = [0, 5_000, 15_000];
      let pullResult: Awaited<ReturnType<typeof composePull>> | null = null;
      for (let attempt = 0; attempt < pullDelaysMs.length; attempt++) {
        if (pullDelaysMs[attempt] > 0) {
          logger.info("retrying image pull", { attempt: attempt + 1, delayMs: pullDelaysMs[attempt] });
          await new Promise<void>((r) => setTimeout(r, pullDelaysMs[attempt]));
        }
        pullResult = await composePull(composeOpts);
        if (pullResult.ok) break;
        const stderr = pullResult.stderr ?? "";
        // Permanent errors — no point retrying.
        if (/manifest unknown|manifest for .* not found|unauthorized|authentication required|access denied/i.test(stderr)) {
          logger.error("image pull failed with permanent error", { stderr: stderr.slice(0, 500) });
          break;
        }
        logger.warn("image pull failed (transient?)", {
          attempt: attempt + 1,
          stderr: stderr.slice(0, 500),
        });
      }
      if (!pullResult || !pullResult.ok) {
        // Dev-mode fallback: locally-built images (typically tagged
        // `:dev`) aren't in any registry, so `docker compose pull`
        // legitimately fails with "manifest unknown". Check if every
        // service's image is already present on the daemon — if so the
        // pull is a no-op and we can proceed with composeUp. Production
        // installs pull real published tags and never hit this branch.
        const allPresent = await allServiceImagesPresent(composeOpts, services);
        if (allPresent) {
          logger.info("image pull failed but all images present locally — continuing", {
            services,
            stderrSlice: (pullResult?.stderr ?? "").slice(0, 200),
          });
        } else {
          const raw = pullResult?.stderr?.trim() || "Image pull failed";
          const msg = mapDockerError(raw);
          _state.deployStatus = _state.deployStatus.map(e => ({ ...e, status: "error", label: "Image pull failed" }));
          _state.deployError = msg;
          return;
        }
      }

      // Phase 3: start containers.
      _state.phase = "starting";
      _state.deployStatus = _state.deployStatus.map(e => ({ ...e, status: "pending", label: "Starting..." }));
      const result = await composeUp({ ...composeOpts, services });

      if (!result.ok) {
        const raw = result.stderr ?? "compose up failed";
        const msg = mapDockerError(raw);
        _state.deployStatus = _state.deployStatus.map(e => ({ ...e, status: "error", label: msg }));
        _state.deployError = msg;
        return;
      }

      // Phase 4: wait for containers to actually be healthy before marking ready.
      // composeUp returning ok only means Docker accepted the start request —
      // containers may still be crash-looping or waiting for healthchecks.
      // 5-minute timeout: cold start of multi-GB images on slow disks
      // regularly exceeds 60 seconds, especially when several containers race
      // for IO. Tighter timeouts produced false "unhealthy" errors during
      // perfectly normal first installs.
      const healthError = await pollContainerHealth(composeOpts, services, 5 * 60_000);
      if (healthError) {
        _state.deployError = healthError;
        // deployStatus entries were already updated by pollContainerHealth
        return;
      }

      // Voice addon bring-up (optional). The core stack is healthy; if
      // the operator enabled the voice addon in the wizard, the voice
      // services are profile-gated and therefore inactive from the
      // baseline composePull/composeUp calls above. Bring them up
      // explicitly with --profile cpu (the wizard always picks cpu;
      // admin can switch to cuda/rocm later). This is what makes
      // "Install completes" actually mean "voice is ready to use",
      // not "voice will start later when you click Save in admin".
      const voiceError = await bringUpVoiceIfEnabled(state, composeOpts);
      if (voiceError) {
        _state.deployError = voiceError;
        return;
      }

      // All services healthy — persist OP_SETUP_COMPLETE=true so subsequent
      // server restarts skip the wizard. This is the FIRST and ONLY place
      // that flag is set; see the matching note in packages/lib setup.ts.
      try {
        markSetupComplete(state);
      } catch (err) {
        logger.error("failed to persist OP_SETUP_COMPLETE after healthy deploy", {
          error: err instanceof Error ? err.message : String(err),
        });
        _state.deployError =
          "Deployment succeeded but failed to mark setup complete. " +
          "Try Retry; if it persists, check disk space and permissions on config/stack/stack.env.";
        return;
      }

      // Only mark ready when ALL services are confirmed running.
      _state.setupComplete = true;
      _state.phase = "ready";
    } catch (err) {
      const raw = String(err);
      const msg = mapDockerError(raw);
      logger.error("deploy failed", { error: raw });
      _state.deployStatus = _state.deployStatus.map(e => ({ ...e, status: "error", label: msg }));
      _state.deployError = msg;
    } finally {
      _state.deploying = false;
      releaseInstallLock(lockHandle);
    }
  })();
}

const VOICE_ADDON = "voice";
const VOICE_HEALTH_TIMEOUT_MS = 10 * 60_000; // 10 min for first-launch model load

/**
 * Resolve each service's image via `docker compose config` and verify
 * `docker image inspect` finds it locally. Lets the deploy proceed
 * after a registry-pull failure when the operator has the images
 * cached (e.g. dev mode with locally-built `:dev` tags). Returns false
 * on any service whose image we can't confirm is present, including
 * services with no resolvable image and any docker-side error.
 */
async function allServiceImagesPresent(
  composeOpts: ReturnType<typeof buildComposeOptions>,
  services: string[],
): Promise<boolean> {
  if (services.length === 0) return false;
  const { execFile } = await import("node:child_process");
  const args = [
    "compose",
    ...composeOpts.files.flatMap((f) => ["-f", f]),
    ...(composeOpts.envFiles ?? []).filter((f) => existsSync(f)).flatMap((f) => ["--env-file", f]),
    "config",
    "--format",
    "json",
  ];
  const config: { services?: Record<string, { image?: string }> } = await new Promise((resolve) => {
    execFile("docker", args, { timeout: 30_000 }, (err, stdout) => {
      if (err) return resolve({});
      try {
        resolve(JSON.parse(stdout.toString()));
      } catch {
        resolve({});
      }
    });
  });
  const serviceConfig = config.services ?? {};
  for (const svc of services) {
    const image = serviceConfig[svc]?.image;
    if (!image) return false;
    const present = await new Promise<boolean>((resolve) => {
      execFile("docker", ["image", "inspect", image], { timeout: 5_000 }, (err) => {
        resolve(!err);
      });
    });
    if (!present) return false;
  }
  return true;
}

/**
 * Pull + bring up the voice addon's chosen profile (default: cpu) if
 * the addon is enabled. Runs after the core stack is healthy so the
 * deploy progress UI shows voice as a distinct phase ("starting-voice")
 * with its own status row.
 *
 * Returns null on success or a user-friendly error string on failure.
 * The caller surfaces the error via _state.deployError.
 */
async function bringUpVoiceIfEnabled(
  state: ControlPlaneState,
  composeOpts: ReturnType<typeof buildComposeOptions>,
): Promise<string | null> {
  const enabled = listEnabledAddonIds(state.homeDir);
  if (!enabled.includes(VOICE_ADDON)) return null;

  // Resolve the chosen profile. The wizard's payload doesn't currently
  // include a profile field (admin-only) so we default to cpu and
  // persist it so the admin Voice tab loads with the same selection.
  const profiles = getAddonProfiles(state.homeDir, VOICE_ADDON);
  const stored = getAddonProfileSelection(state.stackDir, VOICE_ADDON);
  const profileId =
    stored ?? profiles.find((p) => p.id === "cpu")?.id ?? profiles[0]?.id ?? "cpu";
  if (!stored) {
    try {
      setAddonProfileSelection(state.stackDir, VOICE_ADDON, profileId);
    } catch (err) {
      // Persistence failure is non-fatal — we still attempt the bring-up,
      // operator just needs to re-pick the profile in admin if they want
      // to switch later.
      logger.warn("voice: failed to persist profile selection (continuing)", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  const profileServices = profiles.find((p) => p.id === profileId)?.services ?? [];
  if (profileServices.length === 0) {
    logger.warn("voice: no services found for chosen profile (skipping)", { profileId });
    return null;
  }

  _state.phase = "starting-voice";
  _state.deployStatus = [
    ..._state.deployStatus,
    ...profileServices.map((svc) => ({
      service: svc,
      status: "pending" as const,
      label: "Voice — downloading image…",
    })),
  ];

  // Pull the voice image. The 60-min timeout (PULL_TIMEOUT_MS in
  // docker.ts) gives slow connections room to finish the ~2.4 GB
  // download. composePull with --profile cpu only pulls voice-related
  // services from the profile.
  const pullResult = await composePull({ ...composeOpts, profiles: [profileId] });
  if (!pullResult.ok) {
    const msg = mapDockerError(pullResult.stderr ?? "Voice image pull failed");
    _state.deployStatus = _state.deployStatus.map((e) =>
      profileServices.includes(e.service)
        ? { ...e, status: "error" as const, label: "Voice — image pull failed" }
        : e,
    );
    return `Voice addon: ${msg}`;
  }

  _state.deployStatus = _state.deployStatus.map((e) =>
    profileServices.includes(e.service)
      ? { ...e, status: "pending" as const, label: "Voice — starting container…" }
      : e,
  );

  const upResult = await composeUp({
    ...composeOpts,
    services: profileServices,
    profiles: [profileId],
    forceRecreate: true,
  });
  if (!upResult.ok) {
    const msg = mapDockerError(upResult.stderr ?? "Voice container failed to start");
    _state.deployStatus = _state.deployStatus.map((e) =>
      profileServices.includes(e.service)
        ? { ...e, status: "error" as const, label: msg }
        : e,
    );
    return `Voice addon: ${msg}`;
  }

  // Health-poll voice /health for up to 10 min — covers the
  // start_period (180s) plus first-launch model load on slow disks.
  // The voice container binds to loopback 127.0.0.1:8880 by default.
  const probeUrl = "http://127.0.0.1:8880/health";
  const deadline = Date.now() + VOICE_HEALTH_TIMEOUT_MS;
  let healthy = false;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(probeUrl, { signal: AbortSignal.timeout(1500) });
      if (res.ok) {
        healthy = true;
        break;
      }
    } catch {
      /* keep polling */
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }

  if (!healthy) {
    _state.deployStatus = _state.deployStatus.map((e) =>
      profileServices.includes(e.service)
        ? {
          ...e,
          status: "error" as const,
          label: "Voice is still warming up. You can finish setup; check the Voice tab in admin.",
        }
        : e,
    );
    // Don't fail the entire install — the operator can re-trigger
    // voice from admin. Just surface a non-blocking notice.
    logger.warn("voice: container did not become healthy in time", {
      timeoutMs: VOICE_HEALTH_TIMEOUT_MS,
    });
    return null;
  }

  _state.deployStatus = _state.deployStatus.map((e) =>
    profileServices.includes(e.service)
      ? { ...e, status: "running" as const, label: "Voice — ready" }
      : e,
  );
  return null;
}
