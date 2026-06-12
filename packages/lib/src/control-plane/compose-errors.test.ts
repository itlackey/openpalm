import { describe, expect, it } from "bun:test";
import {
  mapDockerError,
  parseComposeStderr,
  summarizeComposeStderr,
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

  it("handles spinner / status prefix glyphs", () => {
    const stderr = " ⠿ voice Error    pull access denied for openpalm/voice";
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

  it("maps platform mismatches", () => {
    expect(mapDockerError("no matching manifest for linux/arm64/v8 in the manifest list entries").code).toBe("platform_mismatch");
  });

  it("maps image auth failures", () => {
    expect(mapDockerError("pull access denied for openpalm/assistant, repository does not exist or may require 'docker login'").code).toBe("image_auth");
  });

  it("maps OOM failures", () => {
    expect(mapDockerError("container exited: OOMKilled").code).toBe("out_of_memory");
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
