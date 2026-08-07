/**
 * Node-side apply logic for the `remote` addon: the part that turns
 * `remote-access.ts`'s pure config model into files on disk. remote-access.ts
 * cannot do this itself — it is browser-safe (no `node:*` imports) so the
 * setup wizard can import it directly, and file writes are exactly the part
 * that has to stay off that path.
 *
 * This module owns two writes and nothing else: `serve.json` (the generated
 * `ipn.ServeConfig` the `tunnel` sidecar reads) and the one-time
 * `OP_REMOTE_HOSTNAME` pin in `state/stack.env`. It does not touch compose
 * files, does not recreate containers, and does not talk to Docker — a later
 * batch's API route composes this with `access-apply.ts`-style recreate
 * scoping the same way `applyAccessToggles` composes `access-toggles.ts`.
 *
 * Never throws: every exported function either cannot fail (pure writes to
 * paths this process controls) or, for `reconcileRemoteAccess`, catches and
 * reports failure in its result — the `access-apply.ts` convention, so a
 * caller can surface a message instead of an unhandled rejection.
 */
import { writeFileAtomic } from "./fs-atomic.js";
import { remoteServeConfigDir } from "./home.js";
import { BUILTIN_ADDON_IDS, GUARDIAN_INGRESS_ADDON_IDS } from "./addon-ids.js";
import { parseEnabledAddons } from "./env.js";
import {
  readAccessToggles,
  resolveAccessEnv,
} from "./access-toggles.js";
import { computeGuardianIngressRequired } from "./remote-providers.js";
import { patchSecretsEnvFile, patchStateEnvFile, readStackEnv } from "./secrets.js";
import {
  deriveRemoteHostname,
  readRemoteAccessConfig,
  resolveServeConfig,
  REMOTE_ACCESS_DEFAULTS,
  type RemoteAccessConfig,
  type ServeConfigDoc,
} from "./remote-access.js";

function serveConfigPath(homeDir: string): string {
  return `${remoteServeConfigDir(homeDir)}/serve.json`;
}

/**
 * `addons.ts`'s `listEnabledAddonIds`, rebuilt here from the same three
 * primitives it uses (`readStackEnv`, `parseEnabledAddons`, `BUILTIN_ADDON_IDS`).
 *
 * NOT a gratuitous copy: `addons.ts` imports `applyRemoteAccess` from this
 * module so `setAddonEnabled` can run the full remote apply inline (that hook
 * is what makes enable/disable fail-closed), and importing `addons.ts` back
 * from here would close that into a cycle. `addon-ids.ts` is documented as a
 * pure-constants file precisely so it can be imported from both sides, and
 * `env.ts`/`secrets.ts` are likewise leaves — so the dependency runs one way
 * and the PARSE stays shared even though the wrapper cannot be.
 * `remote-apply.test.ts` asserts this agrees with `listEnabledAddonIds` on the
 * cases that distinguish them, so the two cannot drift silently.
 */
function enabledAddonIds(homeDir: string): string[] {
  const available = new Set(BUILTIN_ADDON_IDS);
  const enabled = new Set(parseEnabledAddons(readStackEnv(homeDir).OP_ENABLED_ADDONS));
  return [...enabled].filter((name) => available.has(name)).sort();
}

/**
 * The document written when the `remote` addon itself is OFF.
 *
 * This is NOT `resolveServeConfig` applied to some config — a config still
 * names a `target` (assistant/guardian/both) left over from whatever the
 * operator last picked, and deriving from it would happily keep serving that
 * target while the addon reads as disabled. The correct "nothing is served"
 * document is the empty one: `TCP`/`Web`/`AllowFunnel` all present as empty
 * objects. That is a REAL, valid `ipn.ServeConfig` — distinct from a missing
 * or zero-byte file, which `readServeConfig` treats as "no change" and the
 * watch loop skips (see `resolveServeConfig`'s docblock and the never-delete
 * rule below). Writing this is how "off" is actually closed, not just
 * unlabeled.
 */
const DISABLED_SERVE_CONFIG: ServeConfigDoc = { TCP: {}, Web: {}, AllowFunnel: {} };

function writeServeConfigDoc(homeDir: string, doc: ServeConfigDoc): void {
  const json = `${JSON.stringify(doc, null, 2)}\n`;
  // Atomic (temp file + rename), NOT writeFileInPlace. serve.json lives inside
  // the bind-mounted DIRECTORY `remoteServeConfigDir` (see home.ts), not a
  // single-file mount — that is deliberate, precisely so a rename is visible
  // to the container instead of orphaning it on a stale inode the way
  // writeFileInPlace's single-file case (auth.json) requires. writeFileAtomic
  // also mkdirs the parent recursively, so a fresh home or a manually deleted
  // `state/remote/` directory still succeeds here instead of failing
  // with an ENOENT on the temp file — and the alternative (a missing
  // directory) is worse than redundant, since containerboot itself
  // `log.Fatalf`s if it cannot register its fsnotify watch on that directory.
  //
  // NEVER add a code path that deletes this file instead of writing it. A
  // missing file reads to Tailscale exactly like "no change", so deleting it
  // to turn public access off would leave a previously-funneled service
  // exposed to the public internet indefinitely. Every "off" case in this
  // module — including the whole-addon-disabled case — is a WRITE of an
  // explicit document, never an absence.
  writeFileAtomic(serveConfigPath(homeDir), json);
}

/**
 * Serialize `resolveServeConfig(cfg)` and write it atomically to
 * `${remoteServeConfigDir(homeDir)}/serve.json`.
 *
 * This is the mechanical half only: it does not consult whether the `remote`
 * addon is enabled (that is `reconcileRemoteAccess`'s job) and does not pin
 * the hostname `resolveServeConfig` embeds nothing about anyway — the
 * document leaves `${TS_CERT_DOMAIN}` as a literal, substituted by
 * containerboot at read time.
 */
export function writeServeConfig(homeDir: string, cfg: RemoteAccessConfig): void {
  writeServeConfigDoc(homeDir, resolveServeConfig(cfg));
}

/**
 * THE RENAME FIX (see remote-access.ts's `resolveRemoteHostname` docblock).
 *
 * If `OP_REMOTE_HOSTNAME` is already pinned in stack.env, return it
 * unchanged — a pin is write-once, never re-derived. Otherwise derive a
 * hostname from the compose project name (`projectName` if given, else
 * `OP_PROJECT_NAME` from stack.env, else the same "openpalm" fallback
 * `resolveRemoteHostname` uses) via `deriveRemoteHostname`, persist it, and
 * return it.
 *
 * WHY write-once: the tailnet node name is baked into the operator's public
 * URL and into every bookmark, shared link, and QR code made from it.
 * Deriving it fresh on every apply would mean a later `docker compose`
 * project rename (`project-rename.ts`'s `recordProjectRename` /
 * `teardownRenamedProject`) silently moves that URL out from under the
 * operator and strands the old tailnet registration — Tailscale resolves the
 * resulting name collision by permanently appending "-1" to whichever node
 * registers second, and that suffix outlives the collision itself. Pinning
 * once, at first registration, and always preferring the pin thereafter is
 * what makes a project rename safe to allow at all: `recordProjectRename`
 * only has to handle the RUNNING containers, not this hostname, because this
 * function guarantees the hostname never moved in the first place.
 *
 * Uses `patchStateEnvFile` (not `patchSecretsEnvFile`): `OP_REMOTE_HOSTNAME`
 * is an app-written record like `OP_UID`/`OP_SETUP_COMPLETE`/
 * `OP_PREVIOUS_PROJECT_NAME` (see ownership-reconcile.ts, deploy.ts,
 * project-rename.ts), not operator-facing access config, and it is not
 * secret-like — `isSecretLikeStackEnvKey("OP_REMOTE_HOSTNAME")` is false
 * (no `SECRET`/`TOKEN`/`PASSWORD`/`PASS`/`API_KEY`/`PRIVATE_KEY`/
 * `CLIENT_SECRET`/`AUTH_JSON`/`CREDENTIALS` segment), so
 * `assertNoSecretLikeStackEnvKeys` (patchStateEnvFile's inner guard, via
 * `patchStackEnv`) never rejects this write.
 */
export function pinRemoteHostname(homeDir: string, projectName?: string): string {
  const env = readStackEnv(homeDir);
  const pinned = env.OP_REMOTE_HOSTNAME?.trim();
  if (pinned) return pinned;

  const project = projectName?.trim() || env.OP_PROJECT_NAME?.trim() || "openpalm";
  const hostname = deriveRemoteHostname(project);
  patchStateEnvFile(homeDir, { OP_REMOTE_HOSTNAME: hostname });
  return hostname;
}

/** The `remote` addon's persisted state, read back with no side effects. */
export function readRemoteAccessState(homeDir: string): {
  enabled: boolean;
  config: RemoteAccessConfig;
} {
  const env = readStackEnv(homeDir);
  return {
    enabled: enabledAddonIds(homeDir).includes("remote"),
    config: readRemoteAccessConfig(env),
  };
}

export type RemoteAccessReconcileResult = {
  /** Whether the `remote` addon is enabled, as read at the start of this call. */
  enabled: boolean;
  /** The addon's config, as read at the start of this call. */
  config: RemoteAccessConfig;
  /**
   * The effective tailnet hostname. Always populated (pinned-or-derived, via
   * `readRemoteAccessConfig` -> `resolveRemoteHostname`), whether or not this
   * call actually persisted a pin — see `wrote`.
   */
  hostname: string;
  /**
   * True only when the addon is enabled AND this call wrote the LIVE
   * `serve.json` document for it (and, along the way, ensured the hostname
   * pin is persisted). False when the addon is disabled — `serve.json` was
   * still written (never omitted; see the never-delete rule), but with the
   * always-empty "nothing is served" document, and no hostname was pinned
   * for it. Also false when the call failed before either write completed
   * (see `error`).
   */
  wrote: boolean;
  /**
   * Set only when a step failed. A failed reconcile attempts to replace any
   * stale policy with the explicit disabled document before returning.
   */
  error?: string;
};

/**
 * The single entry point a caller (a later batch's API route) uses after any
 * change to the `remote` addon's enablement or config: read the current
 * state, then make `serve.json` match it.
 *
 * - Disabled: write the empty "serve nothing, funnel nothing" document.
 *   Nothing is pinned — burning the one-time hostname pin on an addon that
 *   may never be turned on would be wasteful, and there is nothing yet for
 *   the hostname to label.
 * - Enabled: pin the hostname (a no-op if already pinned) and write the
 *   live document derived from the current config.
 *
 * Follows `access-apply.ts`'s convention: never throws. A failure in either
 * step is caught and surfaced via `error`; before returning a read or apply
 * failure, the stale policy is replaced with the explicit disabled document.
 * If that fail-closed write also fails, both failures are reported.
 */
export function reconcileRemoteAccess(homeDir: string): RemoteAccessReconcileResult {
  try {
    const { enabled, config } = readRemoteAccessState(homeDir);

    if (!enabled) {
      writeServeConfigDoc(homeDir, DISABLED_SERVE_CONFIG);
      return { enabled, config, hostname: config.hostname, wrote: false };
    }

    const hostname = pinRemoteHostname(homeDir);
    writeServeConfig(homeDir, config);
    return { enabled, config, hostname, wrote: true };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    try {
      writeServeConfigDoc(homeDir, DISABLED_SERVE_CONFIG);
    } catch (closeErr) {
      const closeError = closeErr instanceof Error ? closeErr.message : String(closeErr);
      return {
        enabled: false,
        config: REMOTE_ACCESS_DEFAULTS,
        hostname: "",
        wrote: false,
        error: `${error}; additionally failed to write fail-closed serve config: ${closeError}`,
      };
    }

    return {
      enabled: false,
      config: REMOTE_ACCESS_DEFAULTS,
      hostname: "",
      wrote: false,
      error,
    };
  }
}

export type RemoteAccessApplyResult = RemoteAccessReconcileResult & {
  /**
   * Services whose containers must be recreated for this apply to take
   * effect. An enabled remote addon always contains `tunnel` (it reads the
   * regenerated document at container start); a disabled addon never does.
   * `guardian` is included whenever this call changed
   * `GUARDIAN_DIRECT_INGRESS`, because that variable is consumed by the
   * guardian's own listener and only a recreate re-reads it.
   */
  services: string[];
  /** True when this call changed `GUARDIAN_DIRECT_INGRESS`. */
  ingressChanged: boolean;
  /**
   * Set when the apply succeeded but the result cannot work as configured and
   * only the operator can finish it — today: `remote` targets the guardian,
   * so ingress is now on, but no guardian-ingress addon is enabled, which
   * means no `guardian` service is deployed for the tunnel to proxy TO.
   * Deliberately NOT auto-fixed: enabling a portal addon deploys a new
   * network-listening service, which is the operator's call to make, not a
   * side effect of saving a target. Callers surface this; they do not fail on it.
   */
  warning?: string;
};

/**
 * The COMPLETE apply for the `remote` addon — what every mutation path must
 * call, rather than each one re-deriving a piece of it.
 *
 * `reconcileRemoteAccess` above is only half the job: it makes `serve.json`
 * match the addon's state, but the document it writes can name the guardian
 * as a proxy target, and the guardian's direct listener answers 404 unless
 * `GUARDIAN_DIRECT_INGRESS` is "true". Regenerating one without recomputing
 * the other produces a tunnel that reports success and serves a 404 — which
 * is what happened when the only callers of the reconcile were the install
 * path and the credentials route, and neither touched the ingress flag.
 *
 * ORDER MATTERS, and it is fail-closed: the caller is expected to invoke this
 * AFTER the enablement/config write lands but BEFORE starting or stopping any
 * container. On disable that sequence is what closes public access even if
 * the subsequent `compose stop` fails — the empty document is already on disk
 * by then, and a running tunnel re-reads it through its fsnotify watch within
 * seconds. Reversing the order (stop first, rewrite after) would leave a
 * Funnel publicly reachable for as long as the stop kept failing.
 *
 * Never throws — same convention as `reconcileRemoteAccess`.
 */
export function applyRemoteAccess(homeDir: string): RemoteAccessApplyResult {
  const reconcile = reconcileRemoteAccess(homeDir);
  if (reconcile.error) {
    return { ...reconcile, services: [], ingressChanged: false };
  }

  try {
    const env = readStackEnv(homeDir);
    const toggles = readAccessToggles(env);
    // One env snapshot feeds toggles, enablement, and target alike:
    // computeGuardianIngressRequired (the registry's single ingress writer —
    // remote-providers.ts) reads all of it from the `env` read above, so the
    // three inputs cannot disagree with each other the way the earlier
    // split read (reconcile's snapshot for enablement/target, this one for
    // toggles) allowed under a concurrent write.
    const guardianIngressRequired = computeGuardianIngressRequired(env);
    const next = resolveAccessEnv(toggles, { guardianIngressRequired }).GUARDIAN_DIRECT_INGRESS;
    const ingressChanged = (env.GUARDIAN_DIRECT_INGRESS ?? "") !== next;

    if (ingressChanged) {
      // Same file and same helper `applyAccessToggles` uses for this key —
      // GUARDIAN_DIRECT_INGRESS is operator-facing access config, not an
      // app-written record, so it belongs in the secrets env file rather than
      // the state one `pinRemoteHostname` writes to.
      patchSecretsEnvFile(homeDir, { GUARDIAN_DIRECT_INGRESS: next });
    }

    const services = reconcile.enabled
      ? ingressChanged
        ? ["tunnel", "guardian"]
        : ["tunnel"]
      : ingressChanged
        ? ["guardian"]
        : [];

    // The guardian answering is necessary but not sufficient: it also has to
    // EXIST. guardian is profile-gated behind the ingress addons, so a target
    // of guardian/both with none of them enabled leaves the tunnel proxying
    // to a service Compose never deploys.
    let warning: string | undefined;
    if (guardianIngressRequired) {
      const enabledAddons = enabledAddonIds(homeDir);
      const hasIngressAddon = GUARDIAN_INGRESS_ADDON_IDS.some((id) => enabledAddons.includes(id));
      if (!hasIngressAddon) {
        warning =
          `Remote access targets the guardian, but no guardian service is deployed — ` +
          `enable one of: ${GUARDIAN_INGRESS_ADDON_IDS.join(", ")}.`;
      }
    }

    return { ...reconcile, services, ingressChanged, warning };
  } catch (err) {
    return {
      ...reconcile,
      services: [],
      ingressChanged: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
