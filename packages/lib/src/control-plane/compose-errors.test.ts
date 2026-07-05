import { describe, expect, it } from "bun:test";
import {
  mapDockerError,
  parseComposeStderr,
  summarizeComposeStderr,
  type DockerErrorMapping,
} from "./compose-errors.js";

describe("parseComposeStderr", () => {
  it("returns empty for empty input", () => {
    expect(parseComposeStderr("")).toEqual([]);
    expect(parseComposeStderr("\n\n")).toEqual([]);
  });

  it("extracts pull access denied for a single service", () => {
    const stderr = [
      " Network openpalm_default  Created",
      " voice Pulling",
      " voice Error pull access denied for openpalm/voice, repository does not exist or may require 'docker login'",
      "Error response from daemon: pull access denied for openpalm/voice, repository does not exist or may require 'docker login': denied: requested access to the resource is denied",
    ].join("\n");

    const failures = parseComposeStderr(stderr);
    expect(failures.length).toBeGreaterThanOrEqual(1);
    expect(failures[0].service).toBe("voice");
    expect(failures[0].reason).toMatch(/pull access denied/);
  });

  it("parses a plain-progress line with leading whitespace (§2.1: no braille spinner frames to tolerate)", () => {
    // §2.1: every non-interactive compose call now runs with `--progress
    // plain`, so the default renderer's braille spinner-frame prefixes
    // (⠋⠙⠹…) never appear here — plain output is just `<service> <verb>
    // <detail>`, optionally indented.
    const stderr = "   voice Error    pull access denied for openpalm/voice";
    const failures = parseComposeStderr(stderr);
    expect(failures).toHaveLength(1);
    expect(failures[0].service).toBe("voice");
    expect(failures[0].reason).toMatch(/pull access denied/);
  });

  it("captures quoted Service failed lines", () => {
    const stderr =
      'Service "discord" failed to build: failed to solve: process did not complete';
    const failures = parseComposeStderr(stderr);
    expect(failures).toHaveLength(1);
    expect(failures[0].service).toBe("discord");
    expect(failures[0].reason).toMatch(/failed to solve/);
  });

  it("deduplicates identical (service, reason) pairs", () => {
    const stderr = [
      "voice Error pull access denied for openpalm/voice",
      "voice Error pull access denied for openpalm/voice",
    ].join("\n");
    const failures = parseComposeStderr(stderr);
    expect(failures).toHaveLength(1);
  });

  it("returns multiple distinct failures", () => {
    const stderr = [
      "voice Error pull access denied for openpalm/voice",
      "discord Error no such image: openpalm/discord:latest",
    ].join("\n");
    const failures = parseComposeStderr(stderr);
    expect(failures).toHaveLength(2);
    expect(failures.map((f) => f.service).sort()).toEqual(["discord", "voice"]);
  });

  it("falls back to image name when only daemon error is present", () => {
    const stderr =
      "Error response from daemon: pull access denied for openpalm/voice, repository does not exist";
    const failures = parseComposeStderr(stderr);
    expect(failures).toHaveLength(1);
    expect(failures[0].service).toBe("openpalm/voice");
    expect(failures[0].reason).toMatch(/pull access denied/);
  });

  it("ignores non-error noise (Pulling/Created/Started)", () => {
    const stderr = [
      " Network openpalm_default  Created",
      " Container openpalm-guardian-1  Started",
      " assistant Pulling",
    ].join("\n");
    expect(parseComposeStderr(stderr)).toEqual([]);
  });

  it("does not treat 'Error response from daemon' as a service name", () => {
    const stderr = "Error response from daemon: something bad happened";
    // No service-prefixed line, no pull access denied, no quoted service —
    // parser should NOT invent a service called "Error".
    expect(parseComposeStderr(stderr)).toEqual([]);
  });
});

describe("summarizeComposeStderr", () => {
  it("returns first non-empty line", () => {
    expect(summarizeComposeStderr("\n\n  hello world  \nnext line")).toBe(
      "hello world"
    );
  });

  it("truncates long lines", () => {
    const long = "x".repeat(800);
    const out = summarizeComposeStderr(long, 100);
    expect(out.length).toBe(100);
    expect(out.endsWith("…")).toBe(true);
  });

  it("returns empty string for empty input", () => {
    expect(summarizeComposeStderr("")).toBe("");
  });
});

describe("mapDockerError", () => {
  it("maps docker daemon outages", () => {
    expect(mapDockerError("Cannot connect to the Docker daemon at unix:///var/run/docker.sock")).toEqual({
      code: "docker_unavailable",
      message: "Docker appears to be stopped or unreachable. Start Docker, then retry.",
    });
  });

  it("maps port conflicts", () => {
    expect(mapDockerError("Error response from daemon: Ports are not available: exposing port TCP 0.0.0.0:3880 -> 0.0.0.0:0: listen tcp 0.0.0.0:3880: bind: address already in use")).toEqual({
      code: "port_in_use",
      message: "Port 3880 is already in use by another program. Free it, then retry.",
    });
  });

  it("falls back to docker_error (raw passthrough) for a platform mismatch — no longer its own class", () => {
    // §2.1 shrink: platform_mismatch was deleted as a distinct class; the raw
    // stderr line still surfaces via the docker_error fallback passthrough.
    const mapped = mapDockerError("no matching manifest for linux/arm64/v8 in the manifest list entries");
    expect(mapped.code).toBe("docker_error");
    expect(mapped.message).toContain("no matching manifest for linux/arm64/v8");
  });

  it("maps image pull failures (auth)", () => {
    expect(mapDockerError("pull access denied for openpalm/assistant, repository does not exist or may require 'docker login'").code).toBe("image_pull_failed");
  });

  it("maps resource-exhaustion (OOM) failures", () => {
    expect(mapDockerError("container exited: OOMKilled").code).toBe("resource_exhausted");
  });

  it("maps healthcheck failures from parsed service errors", () => {
    const mapped = mapDockerError("assistant Error container is unhealthy");
    expect(mapped.code).toBe("healthcheck_failed");
    expect(mapped.message).toContain("assistant");
  });

  it("falls back to the summarized first line", () => {
    expect(mapDockerError("\n\n  first useful line\nsecond line")).toEqual({
      code: "docker_error",
      message: "first useful line",
    });
  });
});

describe("mapDockerError — table of representative stderr fixtures", () => {
  type Fixture = {
    name: string;
    stderr: string;
    expectedCode: DockerErrorMapping["code"];
    expectedMessageContains?: string;
  };

  const fixtures: Fixture[] = [
    {
      name: "docker daemon unavailable — unix socket",
      stderr: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?",
      expectedCode: "docker_unavailable",
      expectedMessageContains: "Start Docker",
    },
    {
      name: "docker daemon unavailable — connection refused",
      stderr: "Error response from daemon: dial unix /var/run/docker.sock: connect: connection refused",
      expectedCode: "docker_unavailable",
      expectedMessageContains: "Start Docker",
    },
    {
      name: "port conflict — bind address already in use",
      stderr: "Error response from daemon: Ports are not available: exposing port TCP 0.0.0.0:3880 -> 0.0.0.0:0: listen tcp 0.0.0.0:3880: bind: address already in use",
      expectedCode: "port_in_use",
      expectedMessageContains: "Port 3880",
    },
    {
      name: "port conflict — port already allocated",
      stderr: "Error starting userland proxy: listen tcp4 0.0.0.0:8080: bind: address already in use",
      expectedCode: "port_in_use",
      expectedMessageContains: "Port 8080",
    },
    // ── §2.1 shrink: these four used to be their own classes (missing_file,
    //    permission_denied, platform_mismatch ×2) — now raw-stderr-passthrough
    //    fallback (docker_error). The remedy copy is gone; the specific stderr
    //    line is still surfaced via `summary`.
    {
      name: "fallback — missing file (no such file or directory)",
      stderr: "open /home/user/.openpalm/config/stack/core.compose.yml: no such file or directory",
      expectedCode: "docker_error",
      expectedMessageContains: "no such file or directory",
    },
    {
      name: "fallback — permission denied (EACCES)",
      stderr: "Error response from daemon: permission denied while trying to connect to the Docker daemon socket",
      expectedCode: "docker_error",
      expectedMessageContains: "permission denied",
    },
    {
      name: "fallback — platform mismatch (no matching manifest)",
      stderr: "no matching manifest for linux/arm64/v8 in the manifest list entries",
      expectedCode: "docker_error",
      expectedMessageContains: "no matching manifest",
    },
    {
      name: "fallback — platform mismatch (requested image platform)",
      stderr: "The requested image's platform (linux/amd64) does not match the detected host platform (linux/arm64)",
      expectedCode: "docker_error",
      expectedMessageContains: "does not match the detected host platform",
    },
    {
      name: "resource_exhausted — no space left on device (ENOSPC)",
      stderr: "write /var/lib/docker/tmp/GetImageBlob123: no space left on device",
      expectedCode: "resource_exhausted",
      expectedMessageContains: "critical resource",
    },
    {
      name: "image_pull_failed — pull access denied",
      stderr: "pull access denied for openpalm/assistant, repository does not exist or may require 'docker login'",
      expectedCode: "image_pull_failed",
      expectedMessageContains: "could not pull",
    },
    {
      name: "image_pull_failed — unauthorized",
      stderr: "Error response from daemon: unauthorized: authentication required",
      expectedCode: "image_pull_failed",
      expectedMessageContains: "could not pull",
    },
    {
      name: "image_pull_failed — denied requested access",
      stderr: "Error response from daemon: pull access denied for openpalm/voice: denied: requested access to the resource is denied",
      expectedCode: "image_pull_failed",
      expectedMessageContains: "could not pull",
    },
    {
      name: "resource_exhausted — container exited OOMKilled",
      stderr: "container exited: OOMKilled",
      expectedCode: "resource_exhausted",
      expectedMessageContains: "critical resource",
    },
    {
      name: "resource_exhausted — cannot allocate memory",
      stderr: "failed to start container: cannot allocate memory",
      expectedCode: "resource_exhausted",
      expectedMessageContains: "critical resource",
    },
    {
      name: "healthcheck failure — parsed from service error",
      stderr: "assistant Error container is unhealthy",
      expectedCode: "healthcheck_failed",
      expectedMessageContains: "assistant",
    },
    {
      name: "healthcheck failure — unhealthy in summary",
      stderr: "Error response from daemon: container assistant is unhealthy",
      expectedCode: "healthcheck_failed",
      expectedMessageContains: "health check",
    },
    {
      name: "healthcheck failure — failed to start",
      stderr: "assistant Error failed to start: health check failed",
      expectedCode: "healthcheck_failed",
      expectedMessageContains: "health check",
    },
    {
      name: "fallback — generic error summarized",
      stderr: "\n\n  some unexpected docker error occurred\n  with multiple lines",
      expectedCode: "docker_error",
      expectedMessageContains: "some unexpected docker error",
    },
    {
      name: "fallback — empty stderr",
      stderr: "",
      expectedCode: "docker_error",
      expectedMessageContains: "unknown error",
    },
    {
      name: "fallback — only whitespace",
      stderr: "   \n\n\t  ",
      expectedCode: "docker_error",
      expectedMessageContains: "unknown error",
    },
    // ── §2.1: rate-limit / bad-tag / network pull failures all collapse into
    //    image_pull_failed (raw-stderr passthrough carries the specifics) ────
    {
      name: "image_pull_failed — Docker Hub rate limit (toomanyrequests)",
      stderr: "toomanyrequests: You have reached your pull rate limit. You may increase the limit by authenticating and upgrading: https://www.docker.com/increase-rate-limit",
      expectedCode: "image_pull_failed",
      expectedMessageContains: "toomanyrequests",
    },
    {
      name: "image_pull_failed — manifest unknown (bad tag)",
      stderr: "Error response from daemon: manifest for openpalm/assistant:does-not-exist-9999 not found: manifest unknown: manifest unknown",
      expectedCode: "image_pull_failed",
      expectedMessageContains: "manifest",
    },
    {
      name: "image_pull_failed — manifest unknown (plain)",
      stderr: "manifest unknown: manifest unknown",
      expectedCode: "image_pull_failed",
      expectedMessageContains: "manifest unknown",
    },
    {
      name: "image_pull_failed — network error (dial tcp)",
      stderr: "error pulling image: dial tcp: lookup registry-1.docker.io on 8.8.8.8:53: i/o timeout",
      expectedCode: "image_pull_failed",
      expectedMessageContains: "dial tcp",
    },
    {
      name: "image_pull_failed — network error (connection reset by peer)",
      stderr: "Error response from daemon: Get \"https://registry-1.docker.io/v2/\": connection reset by peer",
      expectedCode: "image_pull_failed",
      expectedMessageContains: "connection reset by peer",
    },
    {
      name: "image_pull_failed — includes offending image via raw passthrough",
      stderr: "pull access denied for openpalm/assistant, repository does not exist or may require 'docker login'",
      expectedCode: "image_pull_failed",
      expectedMessageContains: "openpalm/assistant",
    },
  ];

  for (const f of fixtures) {
    it(f.name, () => {
      const mapped = mapDockerError(f.stderr);
      expect(mapped.code).toBe(f.expectedCode);
      if (f.expectedMessageContains) {
        expect(mapped.message.toLowerCase()).toContain(f.expectedMessageContains.toLowerCase());
      }
      // Ensure message is never raw multi-line stderr
      expect(mapped.message).not.toContain("\n");
      // Ensure message is not the raw stderr (unless stderr is a single short line)
      if (f.stderr.trim().length > 100 || f.stderr.includes("\n")) {
        expect(mapped.message).not.toBe(f.stderr.trim());
      }
    });
  }
});
