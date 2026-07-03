/**
 * Parse `docker compose` stderr for per-service failures.
 *
 * `docker compose up -d` reports its progress on stderr — one or more
 * status lines per service, plus a daemon-level "Error response from daemon"
 * summary. When a single addon service fails to pull or start, the rest of
 * the stack often comes up fine, so the only signal that anything is wrong
 * is whatever appears on stderr. This helper extracts the per-service
 * failure messages so callers can surface them to operators.
 */
export type ComposeServiceFailure = {
  service: string;
  reason: string;
};

export type DockerErrorMapping = {
  code:
    | "docker_unavailable"
    | "port_in_use"
    | "missing_file"
    | "permission_denied"
    | "no_space"
    | "platform_mismatch"
    | "image_auth"
    | "rate_limited"
    | "manifest_unknown"
    | "network_error"
    | "out_of_memory"
    | "healthcheck_failed"
    | "docker_error";
  message: string;
};

/**
 * Lines we recognise as per-service failure indicators. The compose CLI
 * has rendered these in a few different shapes across versions:
 *
 *   "voice Error pull access denied for openpalm/voice ..."
 *   " ⠿ voice Error    pull access denied for openpalm/voice ..."
 *   "Service \"voice\" failed to build: ..."
 *
 * We also pick up the bare daemon error and attribute it to the service
 * named in nearby lines when no service-prefixed line is present.
 */
const SERVICE_ERROR_RE = /^[\s⠦⠧⠇⠏⠋⠙⠹⠸⠼⠴⠿✔✘×]*\s*([A-Za-z0-9._-]+)\s+(Error|Failed|failed)\s+(.+)$/;
const SERVICE_FAILED_QUOTED_RE = /Service\s+["']([A-Za-z0-9._-]+)["']\s+failed[^:]*:\s*(.+)$/i;
const SERVICE_NOT_FOUND_RE = /no such service:\s*([A-Za-z0-9._-]+)/i;
const PULL_ACCESS_DENIED_RE = /pull access denied for\s+([^\s,]+)/i;

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

function pushUnique(
  failures: ComposeServiceFailure[],
  entry: ComposeServiceFailure
): void {
  const trimmed = { service: entry.service.trim(), reason: entry.reason.trim() };
  if (!trimmed.service || !trimmed.reason) return;
  const dup = failures.find(
    (f) => f.service === trimmed.service && f.reason === trimmed.reason
  );
  if (!dup) failures.push(trimmed);
}

/**
 * Best-effort extraction of failures from compose stderr.
 *
 * - Returns one entry per (service, reason) pair, in stderr order.
 * - Does NOT fabricate service names: if a daemon error appears without
 *   any nearby service-prefixed line, the caller's intended-services list
 *   is used by the route, not this parser.
 */
export function parseComposeStderr(stderr: string): ComposeServiceFailure[] {
  const failures: ComposeServiceFailure[] = [];
  if (!stderr) return failures;

  const lines = stderr.split(/\r?\n/);

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim()) continue;

    const quoted = SERVICE_FAILED_QUOTED_RE.exec(line);
    if (quoted) {
      pushUnique(failures, { service: quoted[1], reason: quoted[2] });
      continue;
    }

    const m = SERVICE_ERROR_RE.exec(line);
    if (m) {
      // Skip generic prefixes that look like services but aren't
      // (e.g. "Error response from daemon ..." would match if the parser
      // is too lenient — the verb word would be the second token).
      const candidate = m[1];
      if (candidate.toLowerCase() === "error") continue;
      pushUnique(failures, { service: candidate, reason: m[3] });
      continue;
    }

    const notFound = SERVICE_NOT_FOUND_RE.exec(line);
    if (notFound) {
      pushUnique(failures, {
        service: notFound[1],
        reason: `no such service: ${notFound[1]}`,
      });
    }
  }

  // If we still found nothing but the stderr clearly mentions a pull
  // access denied, surface the offending image as the "service" identifier
  // — better than swallowing the failure entirely.
  if (failures.length === 0) {
    const denied = PULL_ACCESS_DENIED_RE.exec(stderr);
    if (denied) {
      pushUnique(failures, {
        service: denied[1],
        reason: `pull access denied for ${denied[1]}`,
      });
    }
  }

  return failures;
}

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
  return first.length > maxLen ? first.slice(0, maxLen - 1) + "…" : first;
}

export function mapDockerError(stderr: string): DockerErrorMapping {
  const summary = summarizeComposeStderr(stderr) || "Docker reported an unknown error.";
  const failures = parseComposeStderr(stderr);
  const healthFailure = failures.find((failure) =>
    /health check|is unhealthy|unhealthy|failed to start/i.test(failure.reason)
  );

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

  if (/cannot find specified .* file|no such file or directory|ENOTDIR|EISDIR/i.test(stderr)) {
    return {
      code: "missing_file",
      message: "A required OpenPalm file or path is missing. Re-run setup or repair the install path, then retry.",
    };
  }

  if (/permission denied|EACCES|EPERM/i.test(stderr)) {
    return {
      code: "permission_denied",
      message: "Permission denied. Check that OpenPalm and Docker can read and write the required files.",
    };
  }

  if (/no space left on device|ENOSPC/i.test(stderr)) {
    return {
      code: "no_space",
      message: "Your disk is full. Free up space, then retry.",
    };
  }

  if (/no matching manifest for|platform .* does not match the detected host platform|requested image's platform/i.test(stderr)) {
    return {
      code: "platform_mismatch",
      message: "The requested image does not support this machine's platform. Check the selected image tag or runtime architecture.",
    };
  }

  // Rate limit (Docker Hub toomanyrequests) — check before generic image_auth
  if (RATE_LIMIT_RE.test(stderr)) {
    // Try to extract the offending image:tag from context lines
    const imageMatch = /toomanyrequests.*?(\S+:\S+)/i.exec(stderr)
      ?? /pull\s+(\S+:\S+)/i.exec(stderr);
    const imagePart = imageMatch ? ` for ${imageMatch[1]}` : "";
    return {
      code: "rate_limited",
      message: `Docker Hub rate limit reached${imagePart}. Wait a few minutes and retry, or log in to Docker Hub (docker login) for a higher limit.`,
    };
  }

  // manifest unknown — bad tag (pull requested a tag that does not exist)
  if (MANIFEST_UNKNOWN_RE.test(stderr)) {
    const m = MANIFEST_UNKNOWN_RE.exec(stderr);
    const imagePart = m?.[1] ? ` (${m[1]})` : "";
    // Also try to pick up image:tag from nearby context if the regex didn't
    const tagMatch = imagePart ? null : /(?:pull|manifest for)\s+(\S+:\S+)/i.exec(stderr);
    const extra = imagePart || (tagMatch ? ` (${tagMatch[1]})` : "");
    return {
      code: "manifest_unknown",
      message: `The requested image tag does not exist in the registry${extra}. Check your version pin or channel setting, then retry.`,
    };
  }

  // Network-level pull failure
  if (NETWORK_ERROR_RE.test(stderr)) {
    return {
      code: "network_error",
      message: "A network error interrupted the image pull. Check your internet connection and retry.",
    };
  }

  if (/pull access denied|unauthorized|authentication required|requested access to the resource is denied|denied: requested access/i.test(stderr)) {
    // Try to extract the offending image:tag
    const imageMatch = /pull access denied for\s+(\S+)/i.exec(stderr)
      ?? /unauthorized.*?(\S+:\S+)/i.exec(stderr);
    const imagePart = imageMatch ? ` (${imageMatch[1]})` : "";
    return {
      code: "image_auth",
      message: `Docker could not pull one or more images${imagePart} because the image is private, missing, or requires authentication.`,
    };
  }

  if (/out of memory|cannot allocate memory|ENOMEM|oom killed|oomkilled/i.test(stderr)) {
    return {
      code: "out_of_memory",
      message: "Docker ran out of memory while starting containers. Free memory or lower the workload, then retry.",
    };
  }

  if (healthFailure) {
    return {
      code: "healthcheck_failed",
      message: `The ${healthFailure.service} container failed its health check. Check its logs, then retry.`,
    };
  }

  if (/health check|is unhealthy|unhealthy|failed to start/i.test(summary)) {
    return {
      code: "healthcheck_failed",
      message: "A container failed its health check. Check the container logs, then retry.",
    };
  }

  return {
    code: "docker_error",
    message: summary,
  };
}
