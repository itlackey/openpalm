/**
 * Applying network access toggles — write, reconcile, recreate, advertise.
 *
 * A toggle save used to be a file write and nothing more. The bind addresses,
 * `OPENCODE_AUTH` and `GUARDIAN_DIRECT_INGRESS` are consumed EXCLUSIVELY by
 * Compose interpolation — published ports and container environment — which
 * only change when a container is RECREATED. Both affordances the product
 * pointed operators at (`openpalm restart` and the Containers-tab restart
 * button) run `docker compose restart`, which restarts existing containers
 * with their ORIGINAL port bindings and environment. So:
 *
 *   - "Let other devices on my network use the assistant" wrote
 *     `OP_UI_BIND_ADDRESS=0.0.0.0`, immediately began advertising
 *     `<name>.local`, and published nothing. The phone got connection refused
 *     against a name the host was actively advertising.
 *   - turning `assistantDirect` OFF made the host UI stop sending Basic auth
 *     while the running OpenCode still required it, so `/oc` chat 401'd until
 *     an unrelated future `up -d`.
 *   - enabling a guardian toggle published a port with no guardian behind it,
 *     because the addon auto-enable lived only in `performSetup`.
 *
 * So a save is an APPLY here, transactionally and in one place shared by both
 * writers (the wizard and the admin PUT): reconcile addons, write the env,
 * recreate exactly the affected services, and only then advertise. mDNS moving
 * last is the point — a name is never published ahead of a reachable port.
 */
import {
  ACCESS_ENV_KEYS,
  coerceAccessToggles,
  readAccessToggles,
  resolveAccessEnv,
  resolveAccessIntentEnv,
  type AccessEnv,
  type AccessToggles,
} from "./access-toggles.js";
import { activateStack } from "./activation.js";
import { buildComposeOptions } from "./compose-args.js";
import { composePs, parseComposePsRows } from "./docker.js";
import { createLogger } from "../logger.js";
import { reconcileMdnsResponder } from "./mdns-responder.js";
import { patchSecretsEnvFile, readStackEnv } from "./secrets.js";
import { GUARDIAN_INGRESS_ADDON_IDS } from "./addon-ids.js";
import { getAddonServiceNames, listEnabledAddonIds, setAddonEnabled } from "./addons.js";
import { computeGuardianIngressRequired } from "./remote-providers.js";
import type { InstallLockHandle } from "./install-lock.js";
import type { ControlPlaneState } from "./types.js";

const logger = createLogger("access-apply");

/**
 * Which service owns each generated key. A key's value reaches Docker only
 * through this service's compose definition, so changing it means recreating
 * exactly this service — and nothing else. Scoping matters: a guardian-only
 * change must not recreate the assistant and drop an in-flight chat turn.
 */
const KEY_OWNER: Record<keyof AccessEnv, "assistant" | "guardian"> = {
  // The assistant container publishes BOTH the UI co-process port and the
  // OpenCode port, and receives OPENCODE_AUTH in its environment.
  OP_UI_BIND_ADDRESS: "assistant",
  OP_ASSISTANT_BIND_ADDRESS: "assistant",
  OPENCODE_AUTH: "assistant",
  OP_GUARDIAN_BIND_ADDRESS: "guardian",
  OP_API_BIND_ADDRESS: "guardian",
  // GUARDIAN_DIRECT_INGRESS is consumed by the guardian's own listener — the
  // `remote` addon changing this value (guardianNetwork stays off, but a
  // tunnel now targets the guardian) still recreates the guardian, never the
  // `tunnel` sidecar. The tunnel dials OUT to whatever is already listening;
  // it has nothing baked in at container-start time for this key, so it has
  // no need to be recreated when it flips.
  GUARDIAN_DIRECT_INGRESS: "guardian",
};

export type AccessApplyResult = {
  /** The toggles now persisted (read back from disk). */
  access: AccessToggles;
  /** Generated keys whose value actually changed. Empty means nothing to apply. */
  changedKeys: (keyof AccessEnv)[];
  /** Services recreated so Docker picks the change up. */
  recreated: string[];
  /** Addons enabled so a published guardian port has something behind it. */
  autoEnabledAddons: string[];
  /** False when the Compose recreate failed — the env is written but not live. */
  ok: boolean;
  error?: string;
  /** mDNS advertisement state AFTER the apply (never advertised before it). */
  mdns: ReturnType<typeof reconcileMdnsResponder>;
};

/**
 * Enable an addon that makes a published guardian port mean something.
 *
 * Extracted from `performSetup`, which was the only caller — so an operator
 * who enabled a guardian toggle from the admin tab published a host port onto
 * a container that was never deployed, and the toggle read back as ON while
 * being silently inert.
 *
 * `guardianOpenaiApi` needs the `api` addon specifically (it serves that
 * edge). `guardianNetwork` needs any guardian ingress; when nothing provides
 * one, the credential-less built-in `chat` portal is the least-surprising
 * default.
 */
export function reconcileGuardianIngressAddons(
  state: ControlPlaneState,
  toggles: AccessToggles,
  pendingAddons: Record<string, boolean> = {},
): string[] {
  const enabled: string[] = [];
  const enabledIds = listEnabledAddonIds(state.homeDir);
  const pendingOn = Object.entries(pendingAddons)
    .filter(([, on]) => on)
    .map(([name]) => name);

  if (toggles.guardianOpenaiApi) {
    const apiEnabled =
      pendingAddons.api === true ||
      (pendingAddons.api !== false && enabledIds.includes("api"));
    if (!apiEnabled) {
      setAddonEnabled(state.homeDir, "api", true, state);
      enabled.push("api");
      logger.info("auto-enabled the api portal for a published OpenAI-compatible edge", {
        reason: "the published port has nothing behind it otherwise",
      });
    }
  }

  if (toggles.guardianNetwork) {
    const hasGuardianIngress = [...pendingOn, ...enabledIds, ...enabled].some((addon) =>
      GUARDIAN_INGRESS_ADDON_IDS.includes(addon),
    );
    if (!hasGuardianIngress) {
      setAddonEnabled(state.homeDir, "chat", true, state);
      enabled.push("chat");
      logger.info("auto-enabled the chat portal for a published guardian", {
        reason: "guardian ingress required for the front door to exist",
      });
    }
  }

  return enabled;
}

/** Generated keys whose value differs between the current env and the new row. */
export function diffAccessEnv(
  currentEnv: Record<string, string | undefined>,
  next: AccessEnv,
): (keyof AccessEnv)[] {
  return ACCESS_ENV_KEYS.filter((key) => (currentEnv[key]?.trim() ?? "") !== next[key]);
}

/**
 * Everything this module reaches outside itself. Injected (the `doctor.ts`
 * pattern) rather than module-mocked: a whole-module mock is process-global in
 * Bun and leaks into unrelated files at this suite's scale.
 */
export type AccessApplyDeps = {
  /** Services the project currently has containers for. */
  listDeployedServices: (state: ControlPlaneState) => Promise<string[]>;
  /** `up -d --force-recreate` over exactly these services. */
  recreateServices: (
    state: ControlPlaneState,
    services: string[],
    lock: InstallLockHandle | null,
  ) => Promise<{ ok: boolean; started: string[]; error?: string }>;
  reconcileMdns: (homeDir: string) => ReturnType<typeof reconcileMdnsResponder>;
};

export const defaultAccessApplyDeps: AccessApplyDeps = {
  listDeployedServices: async (state) => {
    const options = buildComposeOptions(state);
    const ps = await composePs({ files: options.files, envFiles: options.envFiles });
    return parseComposePsRows(ps.stdout).map((row) => row.service);
  },
  recreateServices: async (state, services, lock) => {
    const result = await activateStack(state, { kind: "services", services }, {}, { lock });
    return {
      ok: result.ok,
      started: result.started,
      error:
        result.error ??
        (result.failed.length > 0
          ? result.failed.map((entry) => `${entry.service}: ${entry.reason}`).join("; ")
          : undefined),
    };
  },
  reconcileMdns: (homeDir) => reconcileMdnsResponder(homeDir),
};

/**
 * Services that must be recreated for `changedKeys` to take effect, restricted
 * to services the project actually has containers for.
 *
 * The restriction is what keeps this from failing on an install with no
 * guardian: `compose up guardian` on a profile-inactive service is an error,
 * and a freshly auto-enabled addon has no container yet — hence
 * `alsoInclude`, which carries services whose profile just became active.
 */
export function resolveRecreateScope(
  changedKeys: (keyof AccessEnv)[],
  alsoInclude: string[],
  deployedServices: string[],
): string[] {
  const wanted = new Set<string>(changedKeys.map((key) => KEY_OWNER[key]));
  for (const service of alsoInclude) wanted.add(service);
  if (wanted.size === 0) return [];

  const deployed = new Set(deployedServices);
  // A service whose profile just turned on has no container yet but IS now in
  // the project, so it must be included even though `ps` cannot see it.
  const justEnabled = new Set(alsoInclude);
  return [...wanted].filter((service) => deployed.has(service) || justEnabled.has(service));
}

/**
 * Persist access toggles and make them true.
 *
 * Callers hold the admin/install lock and pass it through, so the Compose
 * recreate joins the same critical section as the write — a concurrent deploy
 * cannot interleave between "env written" and "containers recreated".
 */
export async function applyAccessToggles(
  state: ControlPlaneState,
  requested: unknown,
  options: {
    lock?: InstallLockHandle | null;
    /** Addon changes being written in the same operation (wizard runs). */
    pendingAddons?: Record<string, boolean>;
    /** Extra env written in the same patch (e.g. OP_PROJECT_NAME). */
    extraEnv?: Record<string, string>;
    /** Skip the Compose recreate — the caller deploys the whole stack itself. */
    skipRecreate?: boolean;
    deps?: Partial<AccessApplyDeps>;
  } = {},
): Promise<AccessApplyResult> {
  const deps: AccessApplyDeps = { ...defaultAccessApplyDeps, ...(options.deps ?? {}) };
  const toggles = coerceAccessToggles(requested);
  const currentEnv = readStackEnv(state.homeDir);

  // The `remote` addon can require the guardian's direct listener to answer
  // without touching `guardianNetwork` at all — it tunnels over `portal_net`,
  // never through the LAN bind. Enablement, provider selection, and target
  // are all read from `currentEnv` (the stack env read BEFORE this apply's
  // own writes land) by computeGuardianIngressRequired — the registry's
  // single ingress writer (remote-providers.ts), shared with setup.ts and
  // applyRemoteAccess so the three call sites cannot drift. A toggle save
  // changes access toggles, not the remote addon's own config, so the
  // current env is always the right source.
  //
  // Guarded so a poisoned env (an invalid OP_REMOTE_TARGET makes the registry
  // throw) returns the structured failure result instead of rejecting — and
  // returns it BEFORE the env write below, so intent is never half-applied.
  let guardianIngressRequired: boolean;
  try {
    guardianIngressRequired = computeGuardianIngressRequired(currentEnv);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.error("access toggles NOT applied — remote addon config unreadable", { error });
    return {
      access: readAccessToggles(currentEnv),
      changedKeys: [],
      recreated: [],
      autoEnabledAddons: [],
      ok: false,
      error,
      mdns: deps.reconcileMdns(state.homeDir),
    };
  }

  const nextEnv = resolveAccessEnv(toggles, { guardianIngressRequired });
  const changedKeys = diffAccessEnv(currentEnv, nextEnv);

  const autoEnabledAddons = reconcileGuardianIngressAddons(
    state,
    toggles,
    options.pendingAddons ?? {},
  );

  // Store the INTENT alongside the row it generates, so the next read is a read
  // rather than an inference from bind addresses (which is what could disagree
  // with Compose and then be made real by the following save).
  patchSecretsEnvFile(state.homeDir, {
    ...(options.extraEnv ?? {}),
    ...resolveAccessIntentEnv(toggles),
    ...nextEnv,
  });

  let recreated: string[] = [];
  let ok = true;
  let error: string | undefined;

  if (!options.skipRecreate && (changedKeys.length > 0 || autoEnabledAddons.length > 0)) {
    try {
      const scope = resolveRecreateScope(
        changedKeys,
        // `autoEnabledAddons` holds ADDON ids ('chat'/'api'), but the scope is
        // compose SERVICE names — both ids activate the `guardian` profile,
        // and passing the id through verbatim made `up -d --no-deps chat`
        // fail while the guardian itself was filtered out as undeployed.
        autoEnabledAddons.flatMap((addon) => getAddonServiceNames(state.homeDir, addon)),
        await deps.listDeployedServices(state),
      );
      if (scope.length > 0) {
        const result = await deps.recreateServices(state, scope, options.lock ?? null);
        ok = result.ok;
        recreated = result.started;
        if (!result.ok) error = result.error ?? "compose apply failed";
      }
    } catch (err) {
      ok = false;
      error = err instanceof Error ? err.message : String(err);
    }
  }

  // Advertise LAST, and only for what is actually live. Reconciling before the
  // recreate is what made `<name>.local` resolve to a port that refused
  // connections.
  const mdns = deps.reconcileMdns(state.homeDir);
  const access = readAccessToggles(readStackEnv(state.homeDir));

  if (!ok) {
    logger.error("access toggles written but not applied", { error, changedKeys });
  }

  return { access, changedKeys, recreated, autoEnabledAddons, ok, error, mdns };
}
