/**
 * Admin skills allowlist.
 *
 * Validates arguments for every admin skill call before they reach the admin API
 * or lib functions. This is the security boundary between the assistant subprocess
 * and the control plane.
 *
 * Four invariants enforced:
 *   1. No ".." in path arguments (path traversal).
 *   2. Service names must be in CORE_SERVICES.
 *   3. Destructive operations require confirmation: "yes-i-am-sure".
 *   4. No raw shell strings (sub-shell expansions, pipes, redirects).
 */
import { CORE_SERVICES } from "@openpalm/lib";

// ── Invariant helpers ────────────────────────────────────────────────────

/** INV-1: No path traversal */
function assertNoPathTraversal(value: string, field: string): string | null {
  if (value.includes("..")) {
    return `${field}: path traversal ("..") is not allowed`;
  }
  return null;
}

/** INV-2: Service name must be in CORE_SERVICES */
function assertValidServiceName(value: string, field: string): string | null {
  const valid = new Set<string>(CORE_SERVICES);
  if (!valid.has(value as never)) {
    return `${field}: "${value}" is not a valid service name (allowed: ${[...valid].join(", ")})`;
  }
  return null;
}

/** INV-3: Destructive ops require explicit confirmation */
function assertConfirmation(confirmation: unknown, field = "confirmation"): string | null {
  if (confirmation !== "yes-i-am-sure") {
    return `${field}: destructive operation requires confirmation === "yes-i-am-sure"`;
  }
  return null;
}

/** INV-4: No shell special characters in string arguments */
const SHELL_INJECTION_RE = /[$`|&;<>(){}[\]\\!]/;
function assertNoShellInjection(value: string, field: string): string | null {
  if (SHELL_INJECTION_RE.test(value)) {
    return `${field}: shell special characters are not allowed in admin skill arguments`;
  }
  return null;
}

// ── Public validation entry points ───────────────────────────────────────

export type ValidationResult =
  | { ok: true }
  | { ok: false; error: string };

/**
 * Validate arguments for a container operation (up/down/restart/start/stop).
 *
 * @param serviceName  The name of the service to act on
 */
export function validateContainerOp(serviceName: string): ValidationResult {
  const err =
    assertNoPathTraversal(serviceName, "serviceName") ??
    assertValidServiceName(serviceName, "serviceName") ??
    assertNoShellInjection(serviceName, "serviceName");
  if (err) return { ok: false, error: err };
  return { ok: true };
}

/**
 * Validate arguments for a destructive operation (uninstall, wipe, etc.).
 *
 * @param confirmation  Must equal "yes-i-am-sure"
 */
export function validateDestructiveOp(confirmation: unknown): ValidationResult {
  const err = assertConfirmation(confirmation);
  if (err) return { ok: false, error: err };
  return { ok: true };
}

/**
 * Validate a filesystem path argument passed to any admin skill.
 *
 * @param path  The path string to validate
 */
export function validatePathArg(path: string): ValidationResult {
  const err =
    assertNoPathTraversal(path, "path") ??
    assertNoShellInjection(path, "path");
  if (err) return { ok: false, error: err };
  return { ok: true };
}

/**
 * Validate an addon name (same rules as service name but addons are not in CORE_SERVICES;
 * still must not contain shell characters or path traversal).
 *
 * @param name  The addon name
 */
export function validateAddonName(name: string): ValidationResult {
  // Addon names are not fixed like CORE_SERVICES, but must be clean identifiers.
  const ADDON_NAME_RE = /^[a-zA-Z0-9_-]+$/;
  if (!ADDON_NAME_RE.test(name)) {
    return { ok: false, error: `name: "${name}" is not a valid addon name (alphanumeric, _ and - only)` };
  }
  const err =
    assertNoPathTraversal(name, "name") ??
    assertNoShellInjection(name, "name");
  if (err) return { ok: false, error: err };
  return { ok: true };
}
