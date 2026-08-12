import { describe, expect, it } from "bun:test";
import {
  mapDockerError,
  summarizeComposeStderr,
  type DockerErrorMapping,
} from "./compose-errors.js";

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

  // Regression: a real update failed and reported itself as "voice Pulling" —
  // compose streams progress to stderr, so the first line is a status update,
  // not the failure. The operator saw a message that named no problem, and an
  // automatic rollback they could not explain.
  it("skips compose progress lines and reports the real error", () => {
    const stderr = [
      "voice Pulling",
      " 8a1e25ce7c4f Pulling fs layer",
      " 8a1e25ce7c4f Downloading [==>                ]  1.2MB/24MB",
      " 8a1e25ce7c4f Download complete",
      "Error response from daemon: manifest for openpalm/voice:0.13.0 not found",
    ].join("\n");
    expect(summarizeComposeStderr(stderr)).toBe(
      "Error response from daemon: manifest for openpalm/voice:0.13.0 not found",
    );
  });

  it("skips container/network/volume lifecycle progress too", () => {
    const stderr = [
      "Network splinter_default  Creating",
      "Network splinter_default  Created",
      "Container splinter-voice-1  Creating",
      "Container splinter-voice-1  Created",
      "Container splinter-voice-1  Starting",
      "Error response from daemon: driver failed programming external connectivity",
    ].join("\n");
    expect(summarizeComposeStderr(stderr)).toBe(
      "Error response from daemon: driver failed programming external connectivity",
    );
  });

  // `Error` and `Warning` must NOT be treated as progress — a per-service
  // error line is exactly what we want to surface.
  it("keeps a per-service Error line", () => {
    expect(summarizeComposeStderr("voice Pulling\nvoice Error manifest unknown")).toBe(
      "voice Error manifest unknown",
    );
  });

  // Real failure from a 0.13.0-beta.27 update: paperclip and paperclip-locale
  // share one image, so compose skips the duplicate pull and says so. The
  // operator was shown that sentence as the reason their update failed.
  it("skips a Skipped line that carries trailing detail", () => {
    const stderr = [
      'paperclip-locale Skipped - Image is already being pulled by paperclip',
      ' paperclip Pulling',
      ' paperclip Pulled',
    ].join('\n');
    expect(summarizeComposeStderr(stderr)).toBe("");
  });

  // The summary is the FIRST unmatched line, so a status line that slips
  // through does not merely read badly — it hides the real error behind it.
  it("does not let a status line mask the real error below it", () => {
    const stderr = [
      'paperclip-locale Skipped - Image is already being pulled by paperclip',
      'Error response from daemon: manifest unknown',
    ].join('\n');
    expect(summarizeComposeStderr(stderr)).toBe("Error response from daemon: manifest unknown");
  });

  // Compose appends detail after lifecycle verbs too.
  it("skips lifecycle lines with trailing detail", () => {
    expect(summarizeComposeStderr('Container splinter-voice-1  Started  0.4s')).toBe("");
  });

  it("returns empty when stderr is nothing but progress", () => {
    // Honest emptiness: the caller's own fallback (the exit code) then wins,
    // instead of a progress line masquerading as a diagnosis.
    expect(summarizeComposeStderr("voice Pulling\nvoice Pulled\n")).toBe("");
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

  it("states the registry-access requirement on every pull failure", () => {
    // Install and update always pull, so an offline host cannot complete
    // either — even with the images already in the local daemon. The message
    // must say so outright, or the failure reads as a transient glitch.
    for (const stderr of [
      "pull access denied for openpalm/assistant, repository does not exist or may require 'docker login'",
      "dial tcp 140.82.121.4:443: connect: network is unreachable",
      "manifest unknown: manifest unknown",
    ]) {
      const mapped = mapDockerError(stderr);
      expect(mapped.code).toBe("image_pull_failed");
      expect(mapped.message).toContain("require internet access to the container registry");
      expect(mapped.message).toContain("cannot run offline");
    }
  });

  it("names the docker login remedy only for a Docker Hub rate limit", () => {
    const limited = mapDockerError("toomanyrequests: You have reached your pull rate limit");
    expect(limited.code).toBe("image_pull_failed");
    expect(limited.message).toContain("docker login");

    const offline = mapDockerError("dial tcp 140.82.121.4:443: connect: network is unreachable");
    expect(offline.message).not.toContain("docker login");
  });

  it("maps resource-exhaustion (OOM) failures", () => {
    expect(mapDockerError("container exited: OOMKilled").code).toBe("resource_exhausted");
  });

  it("maps healthcheck failures (service-less generic message)", () => {
    const mapped = mapDockerError("assistant Error container is unhealthy");
    expect(mapped.code).toBe("healthcheck_failed");
    expect(mapped.message).toContain("health check");
  });

  it("falls back to the summarized first line", () => {
    expect(mapDockerError("\n\n  first useful line\nsecond line")).toEqual({
      code: "docker_error",
      message: "first useful line",
    });
  });

  // ── D1: friendly not-installed / permission-denied branches ──────────────
  it("maps a missing docker binary (spawn ENOENT) as not-installed", () => {
    const mapped = mapDockerError("spawn docker ENOENT");
    expect(mapped.code).toBe("docker_unavailable");
    expect(mapped.message.toLowerCase()).toContain("not installed");
  });

  it("maps a shell 'command not found' as not-installed", () => {
    const mapped = mapDockerError("/bin/sh: 1: docker: not found");
    expect(mapped.code).toBe("docker_unavailable");
    expect(mapped.message.toLowerCase()).toContain("not installed");
  });

  it("maps the typical socket permission-denied wording as docker_unavailable with a distinct message", () => {
    const mapped = mapDockerError(
      "Got permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock",
    );
    expect(mapped.code).toBe("docker_unavailable");
    expect(mapped.message.toLowerCase()).toContain("permission");
    // Distinct copy from the plain "stopped or unreachable" daemon-down message.
    expect(mapped.message).not.toBe("Docker appears to be stopped or unreachable. Start Docker, then retry.");
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
    // ── §2.1 shrink: these used to be their own classes (missing_file,
    //    permission_denied, platform_mismatch ×2) — collapsed to
    //    raw-stderr-passthrough fallback (docker_error). The remedy copy is
    //    gone; the specific stderr line is still surfaced via `summary`.
    {
      name: "fallback — missing file (no such file or directory)",
      stderr: "open /home/user/.openpalm/config/stack/core.compose.yml: no such file or directory",
      expectedCode: "docker_error",
      expectedMessageContains: "no such file or directory",
    },
    // D1: permission-denied wording is now its OWN docker_unavailable branch
    // (reusing the code, distinct message) — no longer the docker_error
    // raw-passthrough fallback.
    {
      name: "docker_unavailable — permission denied connecting to the daemon socket",
      stderr: "Error response from daemon: permission denied while trying to connect to the Docker daemon socket",
      expectedCode: "docker_unavailable",
      expectedMessageContains: "permission",
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
      name: "healthcheck failure — unhealthy (service-less generic)",
      stderr: "assistant Error container is unhealthy",
      expectedCode: "healthcheck_failed",
      expectedMessageContains: "health check",
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
