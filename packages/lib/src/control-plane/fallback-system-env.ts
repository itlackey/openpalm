/**
 * K6: the ONE definition of what a freshly-created stack.env looks like
 * (paths/images/ports scaffolding). config-persistence.ts's `writeSystemEnv`
 * uses this whenever the file doesn't exist yet; secrets.ts's
 * `ensureSystemSecrets` imports it too, for the same reason, instead of
 * hand-rolling a second, smaller skeleton. Whichever of the two happens to
 * run first on a given code path (their relative order depends on the
 * caller — the CLI's pre-wizard seed calls writeSystemEnv directly before any
 * secret is minted, while a corrupted/partial OP_HOME that's missing only its
 * stack.env reaches ensureSecrets first) now produces byte-for-byte the same
 * base, so there is nothing left to drift between them.
 *
 * Lives in its own leaf module — importing neither config-persistence.ts nor
 * secrets.ts — because secrets.ts needs it and config-persistence.ts already
 * imports FROM secrets.ts (isSecretLikeStackEnvKey / assertNoSecretLikeStackEnvKeys).
 * secrets.ts importing generateFallbackSystemEnv straight out of
 * config-persistence.ts would be a require cycle between the two.
 */
import { assertRootInstallAllowed, resolveOperatorIds } from "./operator-ids.js";
import { STACK_DEFAULTS } from "./defaults.js";
import { SERVICE_VERSION_KEYS, VERSION_DEFAULTS } from "./versions.js";
import type { ControlPlaneState } from "./types.js";

export function generateFallbackSystemEnv(state: ControlPlaneState): string {
  // Operator UID/GID — auto-detect from OP_HOME owner (or process UID).
  // Skipped on Windows where containers run in WSL2 and OP_UID has no
  // meaning on the host process.
  const ids = resolveOperatorIds(state.homeDir);
  // This generator always emits the ids it resolves, so a root identity is
  // always a persist — gate it unconditionally (see assertRootInstallAllowed).
  if (ids) assertRootInstallAllowed(ids);
  const idLines: string[] = ids
    ? [`OP_UID=${ids.uid}`, `OP_GID=${ids.gid}`]
    : [];

  return [
    "# OpenPalm — System Configuration (managed by CLI/admin)",
    "# Auto-generated fallback.",
    "",
    "# ── Paths ──────────────────────────────────────────────────────────",
    `OP_HOME=${state.homeDir}`,
    ...idLines,
    "",
    "# ── Images ──────────────────────────────────────────────────────────",
    `OP_IMAGE_NAMESPACE=${process.env.OP_IMAGE_NAMESPACE ?? "openpalm"}`,
    "# Docker image tags (exact tag, \"latest\", or \"next\" — no semver ranges).",
    // The compose files reference these as ${OP_*_VERSION:?}, so a value is
    // required for every image. `openpalm update` overwrites the platform ones
    // with the release it deploys (#679).
    ...SERVICE_VERSION_KEYS.map((key) => `${key}=${VERSION_DEFAULTS[key]}`),
    "",
    "# ── Enabled addons (comma-separated; managed via the Add-ons UI / CLI) ──",
    "OP_ENABLED_ADDONS=",
    "",
    "# ── Does this machine host a stack? ─────────────────────────────────",
    "# Written as `true` by an install. Left blank here on purpose: this file is",
    "# also generated BEFORE the wizard has asked anything, so seeding a value",
    "# would answer for the operator. Blank reads as false — a client, not a host.",
    "OP_HOST_ENABLED=",
    "",
    "# ── Ports (38XX range) ──────────────────────────────────────────────",
    "# Guardian is network-only (no host port) — portals reach it via",
    "# http://guardian:8080 over the portal_net Docker network.",
    "# The compose-published ports (OP_UI_PORT, OP_ASSISTANT_PORT,",
    "# OP_WORKSPACE_PORT, …) are deliberately NOT seeded: an absent key means",
    "# the release default, and a value written here would read as an",
    "# operator's explicit choice before anything has checked the host. The",
    "# first install/update apply probes each default and persists a free",
    "# port only if another instance already holds it (ensureHostPortDefaults).",
    `OP_HOST_UI_PORT=${STACK_DEFAULTS.ports.hostUi}`,
    ""
  ].join("\n");
}
