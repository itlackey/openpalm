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
import { listEnabledAddonIds } from "./addons.js";
import { patchStateEnvFile, readStackEnv } from "./secrets.js";
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
  // `system/stack/remote/` directory still succeeds here instead of failing
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
    enabled: listEnabledAddonIds(homeDir).includes("remote"),
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
  /** Set only when a step failed; `serve.json` may be unwritten or stale in that case. */
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
 * step is caught and surfaced via `error`, with the rest of the result
 * falling back to safe defaults rather than partially-read state.
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
    return {
      enabled: false,
      config: REMOTE_ACCESS_DEFAULTS,
      hostname: "",
      wrote: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
