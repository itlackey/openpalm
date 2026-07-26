/**
 * Map `docker compose` stderr to a small set of named, operator-facing error
 * classes (§6). `applyStack` is the single caller that turns a compose failure
 * into a per-service reason (it already knows which services it targeted, via
 * `compose ps --format json`), so this module no longer parses service names
 * out of stderr — it only classifies the failure and passes the raw first line
 * through as the message.
 */

/**
 * §2.1 shrink: 6 stable-substring classes, down from the prior 12. Only
 * distinctions with a genuinely different remedy get their own code
 * (`docker_unavailable`→start Docker, `port_in_use`→free the port,
 * `image_pull_failed`→registry/network/tag/auth issue, `resource_exhausted`→
 * free disk/memory, `healthcheck_failed`→check container logs). Everything
 * else (missing files, permission errors, platform mismatches, and any truly
 * novel daemon error) falls through to `docker_error`, whose message is a
 * RAW-STDERR PASSTHROUGH (the first non-empty line) rather than bespoke
 * copy per pattern — nothing outside this file switches on the removed codes
 * (verified: only `.message` is consumed by callers).
 */
export type DockerErrorMapping = {
  code:
    | "docker_unavailable"
    | "port_in_use"
    | "image_pull_failed"
    | "resource_exhausted"
    | "healthcheck_failed"
    | "docker_error";
  message: string;
};

// ── Registry error patterns — for named error messages (§6) ─────────────────
/** Matches `toomanyrequests: You have reached your pull rate limit` (Docker Hub rate limit). */
const RATE_LIMIT_RE = /toomanyrequests/i;
/**
 * Matches `manifest unknown` or `manifest for <image>:<tag> not found`.
 * Captures the offending image reference when present.
 */
const MANIFEST_UNKNOWN_RE = /manifest\s+(?:unknown|for\s+([^\s]+)\s+not found)/i;
/** Matches network-level pull failures (dial tcp, connection reset, EOF mid-layer). */
const NETWORK_ERROR_RE = /(?:dial tcp|connection reset by peer|EOF|i\/o timeout|TLS handshake timeout|no route to host)/i;

/**
 * Summarise compose stderr in a single short line, suitable for log
 * envelopes / API error messages when no per-service parse succeeded.
 * Returns the first non-empty stderr line, capped.
 */
export function summarizeComposeStderr(stderr: string, maxLen = 500): string {
  if (!stderr) return "";
  const first = stderr
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0) ?? "";
  return first.length > maxLen ? `${first.slice(0, maxLen - 1)}…` : first;
}

/**
 * D1: the docker binary itself is missing/unresolvable — `command not found`
 * (shell), `executable file not found` (execFile PATH lookup), an explicit
 * "not installed", or a bare `ENOENT` (Node's spawn errno, which callers may
 * synthesize into stderr text — e.g. `spawn docker ENOENT` — since the real
 * spawn failure carries no stderr at all). Reuses the `docker_unavailable`
 * code (callers read only `.message`) with distinct, actionable copy.
 */
const NOT_INSTALLED_RE = /docker: (command )?not found|executable file not found|not installed|\bENOENT\b/i;

/**
 * D1: the daemon socket exists but the current user lacks permission to
 * reach it (typically: not in the `docker` group). Distinct remedy from a
 * genuinely stopped/unreachable daemon, so it gets its own message.
 */
const PERMISSION_DENIED_RE = /permission denied while trying to connect to the docker daemon|dial unix.*permission denied|got permission denied.*docker/i;

export function mapDockerError(stderr: string): DockerErrorMapping {
  const summary = summarizeComposeStderr(stderr) || "Docker reported an unknown error.";

  if (NOT_INSTALLED_RE.test(stderr)) {
    return {
      code: "docker_unavailable",
      message: "Docker is not installed or not on your PATH. Install Docker (or set OP_DOCKER_BIN to a compatible binary), then retry.",
    };
  }

  if (PERMISSION_DENIED_RE.test(stderr)) {
    return {
      code: "docker_unavailable",
      message: "Docker daemon connection was denied by permissions. Add your user to the docker group (or run with sufficient privileges), then retry.",
    };
  }

  if (/cannot connect to the docker daemon|docker daemon is not running|error during connect|is the docker daemon running|connection refused/i.test(stderr)) {
    return {
      code: "docker_unavailable",
      message: "Docker appears to be stopped or unreachable. Start Docker, then retry.",
    };
  }

  const portMatch = /(?:bind: address already in use|port is already allocated).*?([0-9]{2,5})\b/i.exec(stderr)
    ?? /listen tcp[^:]*:([0-9]{2,5})\b/i.exec(stderr)
    ?? /Ports are not available: .*?:([0-9]+)\b/i.exec(stderr);
  if (portMatch) {
    return {
      code: "port_in_use",
      message: `Port ${portMatch[1]} is already in use by another program. Free it, then retry.`,
    };
  }

  // image_pull_failed — auth / rate-limit / bad tag / network, collapsed into
  // ONE class: the remedy is always "check the registry/network/tag", and the
  // raw stderr line (passed through in `summary`) already carries the specifics.
  if (RATE_LIMIT_RE.test(stderr) || MANIFEST_UNKNOWN_RE.test(stderr) || NETWORK_ERROR_RE.test(stderr)
    || /pull access denied|unauthorized|authentication required|requested access to the resource is denied|denied: requested access/i.test(stderr)) {
    return {
      code: "image_pull_failed",
      message: `Docker could not pull the required image: ${summary}`,
    };
  }

  // resource_exhausted — disk or memory; the fix is the same either way (free
  // up the resource), so one class covers both raw-stderr-passthrough.
  if (/no space left on device|ENOSPC|out of memory|cannot allocate memory|ENOMEM|oom killed|oomkilled/i.test(stderr)) {
    return {
      code: "resource_exhausted",
      message: `Docker ran out of a critical resource (disk space or memory): ${summary}`,
    };
  }

  if (/health check|is unhealthy|unhealthy|failed to start/i.test(stderr)) {
    return {
      code: "healthcheck_failed",
      message: "A container failed its health check. Check the container logs, then retry.",
    };
  }

  // docker_error — the fallback for everything else (missing files,
  // permission errors, platform mismatches, and any novel daemon error):
  // raw-stderr passthrough rather than bespoke copy per pattern (§2.1 shrink).
  return {
    code: "docker_error",
    message: summary,
  };
}
