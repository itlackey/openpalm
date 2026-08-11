/**
 * Make the guardian's RUNNING state match `guardianRequired`.
 *
 * The guardian deploys for reasons that cross module boundaries (an ingress
 * addon, a guardian toggle, a remote tunnel targeting it — guardian-required.ts),
 * and several mutation paths can flip the answer as a side effect of what they
 * actually change: enabling/disabling the `remote` addon, saving a new
 * OP_REMOTE_TARGET, or (pre-existing shape) disabling one portal addon whose
 * profile-matched stop took the shared guardian down while another portal
 * still needs it. Each of those callers would otherwise need its own copy of
 * "should the guardian be up now, and is it?" — this helper is that answer,
 * applied: called AFTER a mutation lands, it starts a guardian that is newly
 * required and stops one that nothing needs anymore.
 *
 * The stop passes an explicit `--profile guardian` (via composeOptions): the
 * mutation that made the guardian unnecessary also deactivated every profile
 * that would let Compose ADDRESS the service, and `compose stop` on an
 * unaddressable service is an error. `access-apply.ts` avoids the same trap
 * by stopping before its env write; a post-mutation reconciler cannot, so it
 * forces the profile instead.
 *
 * Never throws: the caller just changed real state and must report that
 * change — a Docker hiccup here is a warning on top of a successful mutation,
 * not a failure of it.
 *
 * Dependencies are injected (the `access-apply.ts` pattern) rather than
 * module-mocked: a whole-module mock is process-global in Bun and leaks into
 * unrelated files at this suite's scale.
 */
import { activateComposeCommand } from "./activation.js";
import { buildComposeOptions, type ComposeOptions } from "./compose-args.js";
import { composePs, parseComposePsRows } from "./docker.js";
import { GUARDIAN_PROFILE, guardianRequired } from "./guardian-required.js";
import { createLogger } from "../logger.js";
import type { InstallLockHandle } from "./install-lock.js";
import type { ControlPlaneState } from "./types.js";

const logger = createLogger("guardian-reconcile");

export type GuardianReconcileResult = {
  /** What the reconcile did. `none` = already matching (or unknowable). */
  action: "none" | "started" | "stopped";
  ok: boolean;
  error?: string;
};

export type GuardianReconcileDeps = {
  /** Services the project currently has RUNNING containers for. Throws on a failed probe. */
  listRunningServices: (options: ComposeOptions) => Promise<string[]>;
  /** `compose up -d guardian` with the freshly-resolved (guardian-active) profile set. */
  startGuardian: (state: ControlPlaneState, lock: InstallLockHandle | null) => Promise<void>;
  /** `compose stop guardian`, with the guardian profile forced so the service resolves. */
  stopGuardian: (
    state: ControlPlaneState,
    options: ComposeOptions,
    lock: InstallLockHandle | null,
  ) => Promise<void>;
};

export const defaultGuardianReconcileDeps: GuardianReconcileDeps = {
  listRunningServices: async (options) => {
    const ps = await composePs({ files: options.files, envFiles: options.envFiles });
    // A failed `ps` must not read as "nothing running": acting on it could
    // stop a required guardian or "start" one that is already up mid-flap.
    if (!ps.ok) throw new Error(ps.stderr?.trim() || "docker compose ps failed");
    return parseComposePsRows(ps.stdout).map((row) => row.service);
  },
  startGuardian: async (state, lock) => {
    await activateComposeCommand(state, ["up", "-d", "guardian"], { lock });
  },
  stopGuardian: async (state, options, lock) => {
    await activateComposeCommand(state, ["stop", "guardian"], {
      lock,
      composeOptions: {
        ...options,
        profiles: [...new Set([...options.profiles, GUARDIAN_PROFILE])],
      },
    });
  },
};

export async function reconcileGuardianDeployment(
  state: ControlPlaneState,
  opts: { lock?: InstallLockHandle | null; deps?: Partial<GuardianReconcileDeps> } = {},
): Promise<GuardianReconcileResult> {
  const deps: GuardianReconcileDeps = { ...defaultGuardianReconcileDeps, ...(opts.deps ?? {}) };
  try {
    const required = guardianRequired(state.homeDir);
    const options = buildComposeOptions(state);
    const running = (await deps.listRunningServices(options)).includes("guardian");
    if (required === running) return { action: "none", ok: true };

    if (required) {
      await deps.startGuardian(state, opts.lock ?? null);
      logger.info("started the guardian — this change made it required", {});
      return { action: "started", ok: true };
    }

    await deps.stopGuardian(state, options, opts.lock ?? null);
    logger.info("stopped the guardian — nothing requires it anymore", {});
    return { action: "stopped", ok: true };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.warn("guardian reconcile failed", { error });
    return { action: "none", ok: false, error };
  }
}
