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
 * Compose writes its PROGRESS to stderr, not stdout — `voice Pulling`,
 * per-layer `Downloading [===>   ]`, `Container x Started`. So "the first
 * stderr line" is almost never the failure. A real update was reported to the
 * operator, and recorded in the log envelope, as `voice Pulling`: a message
 * that names no problem and reads like the operation is still running.
 *
 * Case-SENSITIVITY is what makes this safe, not anchoring: compose emits
 * Title-Case status verbs, while `error pulling image: dial tcp: ... i/o
 * timeout` is a genuine failure whose second word is lowercase "pulling".
 * `Error`/`Warning` are absent from the list by design, so
 * `voice Error manifest unknown` still surfaces.
 *
 * An earlier version of this anchored to end-of-line, which looked tighter and
 * was wrong: compose appends detail after the verb. A real update failed with
 * `paperclip-locale Skipped - Image is already being pulled by paperclip` —
 * two services sharing one image, which is ordinary — and the anchor let that
 * line through as the operator-facing error. Worse, because the summary is the
 * FIRST unmatched line, a status line surviving the filter can mask the real
 * error further down the same stderr.
 *
 * `Recreate` (#644): every other in-progress/done pair is listed together
 * (Creating/Created, Starting/Started, Stopping/Stopped, Removing/Removed,
 * Pulling/Pulled) — this list had only the done half, `Recreated`. Compose
 * emits the bare present-tense `Recreate` (not `Recreating`) the moment a
 * `--force-recreate` up begins working on an existing container, one or more
 * lines before `Recreated`/`Starting` and — on a real failure — the daemon
 * error further down. Missing it meant that progress line, not the failure,
 * was the FIRST unmatched line and thus the whole summary: a reapply's real
 * cause (e.g. `Error response from daemon: ... port is already allocated`)
 * was replaced by `Container <name> Recreate`, which names no problem.
 *
 * #655.3/#644 audit: the alternation above was never checked against
 * Compose's actual progress vocabulary beyond the verbs a real failure had
 * already exposed. Re-derived against `docker compose` v5.1.1 (the daemon
 * available for this audit) by driving every lifecycle subcommand
 * (`up`/`--force-recreate`/`kill`/`pause`/`unpause`/`restart`/`stop`/`rm`/
 * `build`) against a real container and reading its stderr verbatim — see
 * the "verb vocabulary" describe block in compose-errors.test.ts for the
 * exact fixtures. Findings that changed the list:
 *   - `Killing`/`Killed` (docker compose kill) were entirely absent.
 *   - `Paused`/`Unpaused` (docker compose pause/unpause) were absent, and
 *     — unlike every other pair here — Compose emits ONLY the done form:
 *     there is no `Pausing`/`Unpausing` in-progress line to also match.
 *   - `Restarting` (docker compose restart) was absent; its "done" line
 *     reuses the plain `Started` verb already in the list — there is no
 *     `Restarted`.
 *   - `Running` (the idle/up-to-date status `docker compose up -d` prints
 *     for a container that needed no change) was absent.
 *   - `Building`/`Built` (docker compose build) were absent; Compose
 *     prefixes these with `Image <name>`, which the existing `{0,2}`
 *     leading-token budget already tolerates.
 *   - `Attaching` (the "Attaching to <service>-<n>" line a non-detached
 *     `up` prints before streaming logs) was absent.
 * Deliberately NOT added: the lowercase `<name> exited with code N` line —
 * case-sensitivity is exactly what keeps a real per-service failure from
 * being swallowed (see the module comment above), and this line carries the
 * exit code, which is useful, not noise.
 */
const COMPOSE_PROGRESS_RE =
  /^(?:\S+\s+){0,2}(?:Pulling fs layer|Pulling|Pulled|Waiting|Downloading|Download complete|Verifying Checksum|Extracting|Pull complete|Already exists|Creating|Created|Starting|Started|Restarting|Running|Healthy|Stopping|Stopped|Removing|Removed|Recreate|Recreated|Killing|Killed|Paused|Unpaused|Building|Built|Attaching|Skipped)\b/;

/**
 * Summarise compose stderr in a single short line, suitable for log
 * envelopes / API error messages when no per-service parse succeeded.
 *
 * Returns the first non-empty line that is not compose progress noise, capped.
 * When stderr is nothing but progress, returns "" so the caller's own fallback
 * (or {@link mapDockerError}'s generic message) wins — an empty summary is far
 * more honest than a confident-sounding progress line.
 */
export function summarizeComposeStderr(stderr: string, maxLen = 500): string {
  if (!stderr) return "";
  const first = stderr
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0 && !COMPOSE_PROGRESS_RE.test(l)) ?? "";
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

  // Every daemon phrasing puts the port BEFORE the phrase — `Bind for
  // 127.0.0.1:3810 failed: port is already allocated`, `failed to bind host
  // port 127.0.0.1:3810/tcp: address already in use`, `listen tcp
  // 0.0.0.0:3880: bind: address already in use` — so take the line that
  // carries the phrase and read the first `:<port>` on it (an IPv4 octet is
  // never colon-prefixed, so this cannot pick up `127.0.0.1`).
  const portLine = stderr.split(/\r?\n/).find((line) => /address already in use|port is already allocated/i.test(line));
  const portMatch = portLine ? /:([0-9]{2,5})(?:\/(?:tcp|udp))?\b/.exec(portLine) : null;
  if (portMatch) {
    return {
      code: "port_in_use",
      message: `Port ${portMatch[1]} is already in use by another program. Free it, then retry.`,
    };
  }

  // image_pull_failed — auth / rate-limit / bad tag / network, collapsed into
  // ONE class: the remedy is always "check the registry/network/tag", and the
  // raw stderr line (passed through in `summary`) already carries the specifics.
  //
  // The message states the requirement outright rather than only naming the
  // symptom: installing and updating ALWAYS pull from the registry, so an
  // offline host cannot complete either — even when the exact images are
  // already in the local daemon. Operators otherwise read "could not pull" as a
  // transient glitch to retry, rather than as a prerequisite they have not met.
  if (RATE_LIMIT_RE.test(stderr) || MANIFEST_UNKNOWN_RE.test(stderr) || NETWORK_ERROR_RE.test(stderr)
    || /pull access denied|unauthorized|authentication required|requested access to the resource is denied|denied: requested access/i.test(stderr)) {
    const rateLimited = RATE_LIMIT_RE.test(stderr);
    return {
      code: "image_pull_failed",
      message:
        `Docker could not pull the required image: ${summary} ` +
        'Installing and updating OpenPalm require internet access to the container ' +
        'registry (Docker Hub / ghcr.io); they cannot run offline.' +
        (rateLimited
          ? ' This host hit Docker Hub\'s anonymous pull rate limit — run `docker login`, or wait for the limit to reset, then retry.'
          : ''),
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
