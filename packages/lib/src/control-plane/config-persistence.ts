/**
 * Runtime file resolution and persistence for the OpenPalm control plane.
 *
 * Writes and derives live runtime files (compose, env, schemas).
 * Files are validated in-place before writing; rollback is handled by
 * the rollback module (snapshot to OP_HOME/data/rollback/).
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, chownSync, rmSync } from "node:fs";
import { errMessage } from './errors.js';
import { dirname, resolve as resolvePath } from "node:path";
import { composeConfigJsonSync, type ComposeConfigJsonResult } from "./docker.js";
import { createLogger } from "../logger.js";
import { parseEnabledAddons, parseEnvContent, parseEnvFile, mergeEnvContent, removeEnvKey } from './env.js';
import {
  ACCESS_ENV_KEYS,
  hasStoredAccessIntent,
  migrateLegacyAccessEnv,
  readAccessToggles,
  resolveAccessEnv,
  resolveAccessIntentEnv,
  RETIRED_BIND_KEYS,
} from './access-toggles.js';
import { assertNoSecretLikeStackEnvKeys, isSecretLikeStackEnvKey } from './secrets.js';
import { writeSecret } from './secrets-files.js';
import { isVoiceLanAccessEnabled } from './voice-host-probes.js';
import type { ControlPlaneState, ArtifactMeta } from "./types.js";
import { stackEnvFile, legacyKnowledgeStackEnvFile, legacyStateEnvFile, composeFilePath, customComposeFilePath } from "./home.js";
import { stackEnvPath } from "./paths.js";
import { writeFileAtomic } from "./fs-atomic.js";
import {
  assertRootInstallAllowed,
  hasUsableOperatorId,
  isRootIds,
  type OperatorIds,
  pinnedNonRootOperatorIds,
  resolveOperatorIds,
} from "./operator-ids.js";
import { STACK_DEFAULTS } from "./defaults.js";
import { generateFallbackSystemEnv } from "./fallback-system-env.js";

import {
  readCoreCompose,
  readBundledStackAsset,
  readBundledCustomCompose,
} from "./core-assets.js";
export { sha256, randomHex } from "./crypto.js";
import { sha256 } from "./crypto.js";

const logger = createLogger("config-persistence");

// ── Env File Management ──────────────────────────────────────────────

/**
 * Return the env files used for docker compose --env-file args.
 *
 * Only `state/stack.env` (non-secret system config). Secret values live in the
 * name-routed file-secret stores and are granted to services as individual
 * Compose secrets. The user env (`knowledge/env/user.env`) is NOT a Compose env
 * file and is loaded only by scoped tools on demand.
 */
export function buildEnvFiles(state: ControlPlaneState): string[] {
  // One file. user.env is intentionally NOT here; scoped tools load it on
  // demand and the assistant entrypoint never sources it.
  const current = stackEnvFile(state.homeDir);
  if (existsSync(current)) return [current];
  return [legacyKnowledgeStackEnvFile(state.homeDir), legacyStateEnvFile(state.homeDir)].filter(existsSync);
}

/**
 * Swap the retired default port pair before the refreshed Compose file is
 * validated. Existing fallback-generated stack.env files persisted assistant
 * port 3800 while the UI implicitly used 3810; leaving that value in place
 * would collide with the corrected UI default on 3800.
 *
 * Custom combinations retain their old effective values. If only one custom
 * port was persisted, the other old implicit default is materialized so the
 * corrected defaults do not silently move it.
 */
export function migrateLegacyDefaultPorts(homeDir: string): boolean {
  const path = legacyKnowledgeStackEnvFile(homeDir);
  if (!existsSync(path)) return false;

  const content = readFileSync(path, "utf-8");
  const parsed = parseEnvContent(content);
  const hasAssistantPort = Object.hasOwn(parsed, "OP_ASSISTANT_PORT");
  const hasUiPort = Object.hasOwn(parsed, "OP_UI_PORT");

  const assistantPort = parsed.OP_ASSISTANT_PORT?.trim();
  const uiPort = parsed.OP_UI_PORT?.trim();
  const oldEffectiveAssistantPort = assistantPort || "3800";
  const oldEffectiveUiPort = uiPort || "3810";
  const updates: Record<string, string> = {};

  if ((!hasAssistantPort && !hasUiPort) || (oldEffectiveAssistantPort === "3800" && oldEffectiveUiPort === "3810")) {
    updates.OP_ASSISTANT_PORT = String(STACK_DEFAULTS.ports.assistant);
    updates.OP_UI_PORT = String(STACK_DEFAULTS.ports.ui);
  } else {
    if (!assistantPort) updates.OP_ASSISTANT_PORT = oldEffectiveAssistantPort;
    if (!uiPort) updates.OP_UI_PORT = oldEffectiveUiPort;
  }
  if (Object.keys(updates).length === 0) return false;

  writeFileAtomic(path, mergeEnvContent(content, updates), 0o600);
  logger.warn("Migrated default host port assignments", {
    assistant: updates.OP_ASSISTANT_PORT,
    ui: updates.OP_UI_PORT,
  });
  return true;
}

/**
 * Materialize the flat bind row for an install written under the retired
 * compose cascade, and drop the keys that cascade used.
 *
 * The cascade was `${OP_UI_BIND_ADDRESS:-${OP_BIND_ADDRESS:-127.0.0.1}}` and
 * friends: a listener could be published purely by the ROOT variable, with no
 * per-service key in stack.env at all. The flat compose lines default straight
 * to loopback, so without this an upgraded shared-guardian install would come
 * back reachable only from the machine it runs on — the operator's paired
 * devices would simply stop connecting, with nothing in the config to explain
 * why. Runs on every deploy path beside {@link migrateLegacyDefaultPorts}.
 *
 * Exposure is preserved exactly, using the cascade's own precedence (an
 * explicit per-service key beats the root — see `readAccessToggles`). Two
 * One value is DERIVED rather than copied, because the flat model makes it a
 * consequence of a toggle rather than an independent setting:
 * `GUARDIAN_DIRECT_INGRESS`, which the legacy row usually omitted, leaving a
 * published guardian port answering 404 to everything.
 *
 * A legacy `OPENCODE_AUTH` row is neither copied nor derived — OpenCode
 * authenticates in every configuration now, and the schema-9 sweep
 * ({@link migrateRetiredOpencodeAuth}) removes the stale key.
 */
export function migrateLegacyBindAddresses(homeDir: string): boolean {
  const path = legacyKnowledgeStackEnvFile(homeDir);
  if (!existsSync(path)) return false;

  const content = readFileSync(path, "utf-8");
  const parsed = parseEnvContent(content);
  const retired = RETIRED_BIND_KEYS.filter((key) => Object.hasOwn(parsed, key));
  const incomplete = ACCESS_ENV_KEYS.some((key) => !parsed[key]?.trim());
  if (retired.length === 0 && !incomplete) return false;

  const migrated = migrateLegacyAccessEnv(parsed);
  let next = mergeEnvContent(content, migrated);
  for (const key of retired) next = removeEnvKey(next, key);
  if (next === content) return false;

  writeFileAtomic(path, next, 0o600);
  logger.warn("Migrated bind addresses to the flat access model", {
    retired,
    ...migrated,
  });
  return true;
}

/**
 * Apply the retired default-port swap to the CONSOLIDATED `state/stack.env`.
 *
 * {@link migrateLegacyDefaultPorts} only ever rewrote the pre-consolidation
 * `knowledge/env/stack.env`, so a home that had already consolidated could
 * still carry the retired pair (assistant 3800 / UI 3810) with nothing to
 * correct it. That gap is why a process-local "port contract reconciliation"
 * existed in the UI's request path, re-deriving the same swap from magic
 * literals on every supervised boot — and clobbering an operator who had
 * deliberately chosen 3800 for the assistant. Doing it once, on disk, lets that
 * shim be deleted.
 *
 * Only the retired PAIR is swapped. An absent value needs no write: the compose
 * fallbacks already resolve to the corrected defaults.
 */
export function migrateConsolidatedDefaultPorts(homeDir: string): boolean {
  const path = stackEnvFile(homeDir);
  if (!existsSync(path)) return false;

  const content = readFileSync(path, "utf-8");
  const parsed = parseEnvContent(content);
  const assistantPort = parsed.OP_ASSISTANT_PORT?.trim();
  const uiPort = parsed.OP_UI_PORT?.trim();

  // The retired pair, either written out in full or with the UI port left
  // implicit (its old default was 3810).
  const isRetiredPair = assistantPort === "3800" && (uiPort === "3810" || !uiPort);
  if (!isRetiredPair) return false;

  const next = mergeEnvContent(content, {
    OP_ASSISTANT_PORT: String(STACK_DEFAULTS.ports.assistant),
    OP_UI_PORT: String(STACK_DEFAULTS.ports.ui),
  });
  if (next === content) return false;

  writeFileAtomic(path, next, 0o600);
  logger.warn("Swapped the retired default port pair in state/stack.env", {
    assistant: STACK_DEFAULTS.ports.assistant,
    ui: STACK_DEFAULTS.ports.ui,
  });
  return true;
}

/**
 * Materialize stored access INTENT into the consolidated `state/stack.env`, and
 * strip the retired cascade keys from it.
 *
 * Two gaps this closes, both of which let display and reality disagree forever:
 *
 *  1. Intent was stored only as its own consequences (four bind addresses) and
 *     read back by inferring "is this loopback?". Inference and Compose's own
 *     precedence could disagree in BOTH directions, and the next save made the
 *     wrong reading real. Writing the four booleans once, from the exact reader
 *     that ran before, makes every later read a read.
 *  2. `migrateLegacyBindAddresses` only ever rewrote the PRE-consolidation
 *     `knowledge/env/stack.env`. Nothing sanitized `state/stack.env`, so a
 *     restored backup — or a hand edit following old docs — could put
 *     `OP_BIND_ADDRESS` there, where Compose ignores it while the toggle reader
 *     honored it as a fallback.
 *
 * Reads with the legacy-aware reader (its last such use for a migrated home)
 * and writes the result as explicit intent.
 */
export function migrateAccessIntent(homeDir: string): boolean {
  const path = stackEnvFile(homeDir);
  if (!existsSync(path)) return false;

  const content = readFileSync(path, "utf-8");
  const parsed = parseEnvContent(content);
  const retired = RETIRED_BIND_KEYS.filter((key) => Object.hasOwn(parsed, key));
  if (hasStoredAccessIntent(parsed) && retired.length === 0) return false;

  const toggles = readAccessToggles(parsed);
  let next = mergeEnvContent(content, {
    ...resolveAccessIntentEnv(toggles),
    // Re-assert the derived row so it agrees with the intent just recorded —
    // a legacy row could carry a cascade-only value with no per-service key.
    //
    // No `guardianIngressRequired` here, unlike the apply and setup paths: this
    // is the one-time legacy upgrade, and it returns early above once intent is
    // stored with no retired keys left. It therefore only ever runs against an
    // env that predates the `remote` addon entirely, where the addon cannot be
    // enabled and so cannot be requiring ingress.
    ...resolveAccessEnv(toggles),
  });
  for (const key of retired) next = removeEnvKey(next, key);
  if (next === content) return false;

  writeFileAtomic(path, next, 0o600);
  logger.warn("Recorded network access intent explicitly", { retired, ...toggles });
  return true;
}

/**
 * Strip the retired `OPENCODE_AUTH` row from `state/stack.env`.
 *
 * The key used to track `assistantDirect`: OpenCode authenticated only while
 * its port was published, so the default install ran it with no password and
 * turning the toggle off silently removed the credential from a running
 * server. OpenCode authenticates unconditionally now — nothing reads the key,
 * `resolveAccessEnv` no longer writes it, and compose no longer interpolates
 * it — so what is left on an upgraded home is a stale row that reads like a
 * live setting.
 *
 * Removal only, and inert by construction: with no reader left, a home that
 * kept the row would behave identically. It is swept anyway because an
 * operator reading their own `stack.env` should not find a security-shaped
 * key that means nothing.
 */
export function migrateRetiredOpencodeAuth(homeDir: string): boolean {
  const path = stackEnvFile(homeDir);
  if (!existsSync(path)) return false;

  const content = readFileSync(path, "utf-8");
  if (!Object.hasOwn(parseEnvContent(content), "OPENCODE_AUTH")) return false;

  const next = removeEnvKey(content, "OPENCODE_AUTH");
  if (next === content) return false;

  writeFileAtomic(path, next, 0o600);
  logger.warn(
    "Removed the retired OPENCODE_AUTH row — OpenCode now authenticates in every configuration",
  );
  return true;
}

/**
 * Write system-managed values to state/stack.env.
 *
 * Secret-like keys are NOT written here — they belong in knowledge/secrets/.
 * Use ensurePortalSecret() for portal secrets.
 */
export function writeSystemEnv(state: ControlPlaneState): void {
  const systemEnvPath = stackEnvPath(state);
  mkdirSync(`${state.stashDir}/env`, { recursive: true, mode: 0o700 });

  let base = "";
  if (existsSync(systemEnvPath)) {
    base = readFileSync(systemEnvPath, "utf-8");
  } else {
    base = generateFallbackSystemEnv(state);
  }

  // Preserve the existing OP_SETUP_COMPLETE flag as-is.
  // Only the wizard completion path (startDeploy, after health check) writes "true".
  // Defaulting to "false" here ensures a fresh install always shows the wizard.
  const parsed = parseEnvFile(systemEnvPath);
  const adminManaged: Record<string, string> = {
    OP_SETUP_COMPLETE: parsed.OP_SETUP_COMPLETE === "true" ? "true" : "false",
  };

  // Backfill OP_UID/OP_GID when the existing stack.env was written by an
  // older code path that hard-coded 1000, or when the file was created
  // with missing/zero values. We only override when the current value is
  // missing or zero — an operator who manually set OP_UID=2000 (e.g.
  // because they're running on a host with a non-1000 service account)
  // must not be silently changed.
  const ids = resolveOperatorIds(state.homeDir);
  if (ids) {
    const writeUid = !hasUsableOperatorId(parsed, "OP_UID");
    const writeGid = !hasUsableOperatorId(parsed, "OP_GID");
    // Both the opt-in gate and the standing warning judge the EFFECTIVE
    // post-write identity, not the raw resolver result: a usable stack.env pin
    // covers the axis it pins (compose interpolates `user:` from stack.env, so
    // the pin — not the resolver — is what containers actually run as), and
    // the resolver fills only the axes being written. uid and gid resolve
    // INDEPENDENTLY in resolveOperatorIds, so a mixed result like 1000:0 is
    // reachable (an OP_HOME owned `1000:0` under a root process) — a pinned
    // OP_GID=1000 then makes the effective identity fully non-root, and
    // neither the gate nor the warning fires (see pinnedNonRootOperatorIds /
    // resolveRepairIdentity for the same pin-beats-resolver rule).
    const effective: OperatorIds = {
      uid: writeUid ? ids.uid : Number(parsed.OP_UID),
      gid: writeGid ? ids.gid : Number(parsed.OP_GID),
    };
    // Opt-in is checked only when a root identity would actually be PERSISTED.
    // A home already carrying OP_UID=0 records the operator's prior consent and
    // is never rewritten, so it does not re-trip the gate on every apply.
    if (writeUid || writeGid) assertRootInstallAllowed(effective);
    // Warn on every write rather than once: it is a standing condition, not a
    // one-time event. The message reports the effective ids — never "0:0" on
    // an install whose pins mean nothing root actually applies.
    if (isRootIds(effective)) {
      logger.warn(
        `Resolved a root operator id — containers will run as ${effective.uid}:${effective.gid}. ` +
          "This is supported but NOT recommended. To avoid it, ensure OP_HOME is owned by a " +
          "non-root user and group and install as that user, or set OP_UID/OP_GID explicitly " +
          "in state/stack.env."
      );
    }
    if (writeUid) adminManaged.OP_UID = String(ids.uid);
    if (writeGid) adminManaged.OP_GID = String(ids.gid);
  }

  // Backfill OP_HOME when missing — compose files reference ${OP_HOME}
  // for all volume mounts. Without this, Docker Compose defaults to blank.
  if (!parsed.OP_HOME) adminManaged.OP_HOME = state.homeDir;

  const { content: strippedBase, removed } = stripSecretLikeEnvKeys(base);
  base = strippedBase;
  if (removed.length > 0) {
    // Correct per the secret-boundary contract (secrets belong in the
    // name-routed file-secret stores, not stack.env) — but never do it silently, and
    // never destroy the value: relocate it to the canonical file-secret tree (the
    // same place ensurePortalSecret/writeStackSecretEnv write to) before
    // dropping the line, then log + drop a one-time notice so the user knows
    // where it went.
    for (const { key, value } of removed) {
      writeSecret(state.homeDir, key.toLowerCase(), value.endsWith("\n") ? value : `${value}\n`);
    }
    const removedKeys = removed.map((r) => r.key);
    logger.warn("Removed secret-looking keys from stack.env; relocated values to canonical file-secret storage", {
      removedKeys,
      stackEnvPath: systemEnvPath,
    });
    recordSecretStripNotice(state, removedKeys);
  }
  assertNoSecretLikeStackEnvKeys(parseEnvContent(base));
  assertNoSecretLikeStackEnvKeys(adminManaged);

  const content = mergeEnvContent(base, adminManaged, {
    sectionHeader: "# ── Admin-managed ──────────────────────────────────────────────────"
  });

  writeFileAtomic(systemEnvPath, content, 0o600);
  chmodSync(systemEnvPath, 0o600);
}

function stripSecretLikeEnvKeys(
  content: string,
): { content: string; removed: { key: string; value: string }[] } {
  const removed: { key: string; value: string }[] = [];
  const kept = content
    .split('\n')
    .filter((line) => {
      let trimmed = line.trim();
      if (trimmed.startsWith('export ')) trimmed = trimmed.slice(7).trimStart();
      const eq = trimmed.indexOf('=');
      if (eq <= 0) return true;
      const key = trimmed.slice(0, eq).trim();
      if (isSecretLikeStackEnvKey(key)) {
        let value = trimmed.slice(eq + 1).trim();
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1);
        }
        removed.push({ key, value });
        return false;
      }
      return true;
    })
    .join('\n');
  return { content: kept, removed };
}

/**
 * Path of the one-time "secret-looking values were removed from stack.env"
 * notice the UI reads and dismisses.
 */
export function secretStripNoticePath(state: ControlPlaneState): string {
  return `${state.dataDir}/secret-strip-notice.json`;
}

interface SecretStripNotice {
  keys: string[];
  at: string;
}

function recordSecretStripNotice(state: ControlPlaneState, newlyRemoved: string[]): void {
  const path = secretStripNoticePath(state);
  let keys = new Set(newlyRemoved);
  if (existsSync(path)) {
    try {
      const prior = JSON.parse(readFileSync(path, "utf-8")) as Partial<SecretStripNotice>;
      if (Array.isArray(prior.keys)) keys = new Set([...prior.keys, ...newlyRemoved]);
    } catch {
      /* corrupt notice — overwrite with the fresh set */
    }
  }
  const notice: SecretStripNotice = { keys: [...keys].sort(), at: new Date().toISOString() };
  try {
    mkdirSync(state.dataDir, { recursive: true });
    writeFileSync(path, JSON.stringify(notice, null, 2));
  } catch (e) {
    logger.warn("Could not persist secret-strip notice", { error: errMessage(e) });
  }
}

/** Read the pending secret-strip notice, or null when there is none. */
export function readSecretStripNotice(state: ControlPlaneState): { keys: string[]; at: string } | null {
  const path = secretStripNoticePath(state);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<SecretStripNotice>;
    if (Array.isArray(parsed.keys) && parsed.keys.length > 0 && typeof parsed.at === "string") {
      return { keys: parsed.keys, at: parsed.at };
    }
  } catch {
    /* corrupt — treat as no notice */
  }
  return null;
}

/** Dismiss (delete) the pending secret-strip notice. */
export function dismissSecretStripNotice(state: ControlPlaneState): void {
  const path = secretStripNoticePath(state);
  if (existsSync(path)) {
    try {
      rmSync(path);
    } catch (e) {
      logger.warn("Could not dismiss secret-strip notice", { error: errMessage(e) });
    }
  }
}

// ── Stack Overlay Discovery ────────────────────────────────────────────

/**
 * Discover active compose overlays.
 * Returns the fixed compose stack: core, services, portals, and custom.
 * First-party services are profile-gated inside services.compose.yml and
 * portals.compose.yml.
 *
 * Host AKM sharing is NOT a compose overlay: the assistant always mounts
 * `/host-stash` (core.compose.yml, with an empty-dir fallback), and "sharing"
 * is purely a writable secondary source entry in config/akm/config.json. No
 * conditional overlay file is involved.
 */
/**
 * True when the OpenAI-compatible edge's host publish belongs in the compose
 * file list: the operator turned the guardianOpenaiApi toggle on, or the
 * `api` addon (the pre-toggle exposure alias) is enabled. Reads the stored
 * intent the same way every consumer does — via readAccessToggles, so a
 * pre-intent row falls back to bind inference and a restored backup keeps
 * the publish it had.
 */
function isOpenaiEdgePublished(homeDir: string): boolean {
  const env = parseEnvFile(stackEnvFile(homeDir));
  if (readAccessToggles(env).guardianOpenaiApi) return true;
  return parseEnabledAddons(env.OP_ENABLED_ADDONS).includes('api');
}

export function discoverStackOverlays(homeDir: string): string[] {
  const files: string[] = [];

  // Managed compose (system/stack) — core first, then the fixed overlays.
  for (const name of ['core.compose.yml', 'services.compose.yml', 'portals.compose.yml']) {
    const composePath = composeFilePath(homeDir, name);
    if (existsSync(composePath)) files.push(composePath);
  }

  // Voice LAN-access overlay: opt-in (OP_VOICE_LAN_ACCESS, default off — see
  // isVoiceLanAccessEnabled) and gated on the file actually being seeded, same
  // double-gate as every other conditional overlay in this codebase.
  //
  // Deliberately included HERE — in the file list every compose invocation
  // builds from — and NOT only in the voice bring-up engine's one-off
  // applyStack call (packages/ui/.../voice/bring-up.ts extraFiles, which
  // carries the CDI/rootless fallback overlays). Those exist for exactly one
  // compose-up call each time bring-up runs. Every OTHER compose invocation —
  // `openpalm start`, an update, a settings-triggered recreate — builds its
  // file list from THIS function. If voice's network membership lived only in
  // bring-up's extraFiles, the next plain `openpalm start` would recreate
  // voice WITHOUT assistant_net, silently breaking LAN voice until someone
  // re-ran bring-up — the exact write-then-drift shape the access-toggle
  // apply work (access-apply.ts) removed elsewhere on this branch.
  if (isVoiceLanAccessEnabled(homeDir)) {
    const voiceLan = composeFilePath(homeDir, 'voice.compose.lan.yml');
    if (existsSync(voiceLan)) files.push(voiceLan);
  }

  // OpenAI-compatible edge host publish: the guardian's compatible listener
  // (8182) has NO unconditional `ports:` entry in portals.compose.yml — this
  // overlay carries the one host publish, so the guardianOpenaiApi toggle's
  // OFF position means no host listener at all rather than "loopback with a
  // fully working edge behind it". Same double-gate and same shared-file-list
  // rationale as the voice overlay above: every compose invocation must agree
  // on the file list, or a plain `openpalm start` would recreate the guardian
  // without (or with) the publish and silently flip the operator's setting.
  //
  // The `api` addon is the second inclusion reason: it is the pre-toggle
  // exposure alias (and the v7→v8 migration's substitute for `chat`), so an
  // upgraded install that enabled it keeps its loopback edge byte-identical.
  // Bind address and port still come from the flat access model
  // (OP_API_BIND_ADDRESS / OP_API_PORT); the overlay only interpolates them.
  if (isOpenaiEdgePublished(homeDir)) {
    const apiPublish = composeFilePath(homeDir, 'guardian.compose.api.yml');
    if (existsSync(apiPublish)) files.push(apiPublish);
  }

  // User custom overlay lives in the config/ tree (not system/stack).
  const custom = customComposeFilePath(homeDir);
  if (existsSync(custom)) files.push(custom);

  return files;
}

// ── Top-Level Operations ─────────────────────────────────────────────

export function resolveRuntimeFiles(): {
  compose: string;
} {
  return {
    compose: readCoreCompose(),
  };
}

// ── Runtime File Metadata ──────────────────────────────────────────────

export function buildRuntimeFileMeta(artifacts: {
  compose: string;
}): ArtifactMeta[] {
  const now = new Date().toISOString();
  return (["compose"] as const).map((name) => ({
    name,
    sha256: sha256(artifacts[name]),
    generatedAt: now,
    bytes: Buffer.byteLength(artifacts[name])
  }));
}

// ── Portal Secrets ────────────────────────────────────────────────────
// Defined in secrets-files.ts (so ensureSecrets can seed them without an
// import cycle); re-exported here, their long-standing public home.

export { ensurePortalSecret, portalSecretName } from './secrets-files.js';

// ── Volume Mount Targets ───────────────────────────────────────────────

/**
 * Parse enabled compose files and pre-create host-side volume mount
 * targets under OP_HOME as the current user. This prevents Docker from
 * creating them as root-owned, which causes EACCES inside non-root
 * containers.
 *
 * Only mount sources under `state.homeDir` are touched; external paths
 * (e.g. `/var/run/docker.sock`) are left alone.
 *
 * The file-vs-directory distinction is best-effort and only applies to
 * explicit OP_HOME paths.
 */
export function ensureComposeVolumeTargets(state: ControlPlaneState): void {
  // Resolve the operator UID/GID compose runs containers as (`user:`), so we
  // can chown the dirs we pre-create to match. Without this, dirs created by
  // a root-running install (or a host UID that differs from the forced
  // container UID) are unwritable inside the non-root container — on OrbStack
  // real UIDs are preserved, so e.g. ollama's mkdir is denied (issue #452).
  // A root resolution defers to a hand-pinned non-root OP_UID/OP_GID in
  // stack.env when one exists: compose interpolates `user:` from the pin, so
  // the pinned ids — not root — are what the containers actually run as.
  const resolvedIds = resolveOperatorIds(state.homeDir);
  const operatorIds = resolvedIds && isRootIds(resolvedIds)
    ? pinnedNonRootOperatorIds(parseEnvFile(stackEnvFile(state.homeDir))) ?? resolvedIds
    : resolvedIds;

  for (const mount of discoverHomeBindMountSources(state)) {
    if (existsSync(mount.path)) continue;

    if (mount.isFile) {
      const parent = dirname(mount.path);
      mkdirSync(parent, { recursive: true });
      writeFileSync(mount.path, '');
      chownVolumeTarget(parent, operatorIds);
      chownVolumeTarget(mount.path, operatorIds);
    } else {
      mkdirSync(mount.path, { recursive: true });
      chownVolumeTarget(mount.path, operatorIds);
    }
  }
}

export function discoverHomeBindMountSources(
  state: ControlPlaneState,
  resolveConfig: (
    options: { files: string[]; envFiles?: string[] },
  ) => ComposeConfigJsonResult = composeConfigJsonSync,
): Array<{ path: string; isFile: boolean }> {
  const composeFiles = discoverStackOverlays(state.homeDir);
  if (composeFiles.length === 0) return [];

  // Docker's `compose config --format json` is the single source of truth for
  // volume/env resolution: `source` is already absolute and fully
  // `${VAR}`-interpolated (including nested `${VAR:-${VAR}}` defaults the old
  // hand-rolled regex mangled), and `type` distinguishes a host bind from a
  // named volume. Every service is included, profiled or not — `config` renders
  // profile-gated services too — so a disabled addon's dir is still pre-created
  // (issue #452). Best-effort: if compose can't resolve, skip pre-creation.
  const { ok, config, stderr } = resolveConfig({
    files: composeFiles,
    envFiles: [stackEnvPath(state)],
  });
  if (!ok || !config?.services) {
    logger.warn(`Could not resolve compose config for bind-mount pre-creation: ${stderr}`);
    return [];
  }

  const homeRoot = resolvePath(state.homeDir);
  const seen = new Set<string>();
  const mounts: Array<{ path: string; isFile: boolean }> = [];

  for (const svc of Object.values(config.services)) {
    for (const vol of svc?.volumes ?? []) {
      // Only host bind mounts point at OP_HOME paths; named volumes (`type:
      // volume`) carry a volume name, not a path.
      if (vol.type && vol.type !== 'bind') continue;
      const source = vol.source;
      if (!source?.startsWith('/')) continue;
      const resolvedHostPath = resolvePath(source);
      if (!resolvedHostPath.startsWith(`${homeRoot}/`) && resolvedHostPath !== homeRoot) continue;

      if (seen.has(resolvedHostPath)) continue;
      seen.add(resolvedHostPath);
      mounts.push({ path: resolvedHostPath, isFile: isFileMount(resolvedHostPath) });
    }
  }

  return mounts;
}

/**
 * Decide whether a bind-mount target should be pre-created as a file vs a
 * directory, from the resolved host path alone.
 *
 * Docker's resolved project view normalizes every host mount to `type: bind`
 * (short- and long-form alike), so it carries no file-vs-directory signal —
 * that distinction is inherently ours. We use a basename heuristic: a dot in
 * the basename means a file (e.g. `auth.json`, the only file mounts the shipped
 * stack declares). It is imperfect for dotted *directory* names like `data.v2`
 * (none exist in the shipped stack); prefer dotless directory names in compose
 * files to avoid relying on it.
 */
function isFileMount(resolvedHostPath: string): boolean {
  const basename = resolvedHostPath.split('/').pop() ?? '';
  return basename.includes('.');
}

/**
 * chown a just-created bind-mount target to the operator UID/GID so the
 * non-root container (`user: ${OP_UID}:${OP_GID}`) can write to it.
 *
 * No-op on Windows (chown is meaningless there) or when no operator can be
 * resolved. A failure (e.g. not the owner) is logged and swallowed — the
 * mkdir already succeeded and Docker Desktop's gRPC-FUSE masks ownership
 * anyway, so a chown failure must not abort the install.
 */
function chownVolumeTarget(path: string, operatorIds: OperatorIds | null): void {
  if (process.platform === "win32" || !operatorIds) return;
  try {
    chownSync(path, operatorIds.uid, operatorIds.gid);
  } catch (error) {
    logger.warn(
      `Could not chown volume target ${path} to ${operatorIds.uid}:${operatorIds.gid}: ${errMessage(error)}`
    );
  }
}

// ── Persistence (direct-write to live paths) ────────────────────────

export function writeRuntimeFiles(
  state: ControlPlaneState
): void {
  mkdirSync(state.stackDir, { recursive: true });
  // The managed system/ tree (compose stack + system OpenCode config) is
  // overwritten wholesale from the release skeleton in applyHomeSeed
  // (overwriteSystemTree) before this runs. Here we only seed-if-absent the
  // compose files a fresh home is missing, never overwriting the managed copies.
  const composePath = `${state.stackDir}/core.compose.yml`;
  if (!existsSync(composePath)) writeFileSync(composePath, state.artifacts.compose);
  // K4: `readBundledStackAsset` degrades to `''` BY DESIGN when the skeleton
  // is unresolvable (e.g. a fresh Electron first-run before OP_HOME is
  // seeded) — never write that empty string out as the seeded file. An empty
  // file is invalid Compose input, `discoverStackOverlays` includes it purely
  // because it EXISTS (content is never checked), and every subsequent
  // `docker compose` invocation then fails — permanently, because the file
  // now exists and this seed-if-missing guard never runs again to repair it.
  // Skipping the write here leaves the slot open for the NEXT writeRuntimeFiles
  // call (e.g. once the skeleton resolves) to seed it for real.
  for (const name of ['services.compose.yml', 'portals.compose.yml']) {
    const path = `${state.stackDir}/${name}`;
    if (existsSync(path)) continue;
    const content = readBundledStackAsset(name);
    if (!content) {
      logger.warn(`Skipping seed of ${name}: bundled stack asset unavailable (empty content)`, { path });
      continue;
    }
    writeFileSync(path, content);
  }
  const customComposePath = customComposeFilePath(state.homeDir);
  if (!existsSync(customComposePath)) {
    const customContent = readBundledCustomCompose();
    // Same empty-fallback hazard as the loop above (readBundledCustomCompose
    // shares the identical try/catch-to-'' degradation) — this file is also
    // unconditionally included by discoverStackOverlays once it exists.
    if (customContent) {
      mkdirSync(dirname(customComposePath), { recursive: true });
      writeFileSync(customComposePath, customContent);
    } else {
      logger.warn('Skipping seed of custom.compose.yml: bundled asset unavailable (empty content)', {
        path: customComposePath,
      });
    }
  }

  // Write stack.env (no secrets — those live in knowledge/secrets/)
  writeSystemEnv(state);

  // Ensure state directory exists
  mkdirSync(state.dataDir, { recursive: true });

  state.artifactMeta = buildRuntimeFileMeta(state.artifacts);
}
