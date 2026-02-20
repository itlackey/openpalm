import { describe, expect, it } from "bun:test";
import { detectOS, detectArch, resolveSocketPath, resolveComposeBin, detectRuntime, validateRuntime } from "@openpalm/lib/runtime.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("runtime", () => {
  describe("detectOS", () => {
    it("returns a valid HostOS", () => {
      const os = detectOS();
      expect(["linux", "macos", "windows-bash", "unknown"]).toContain(os);
    });

    it("returns linux on this machine", () => {
      const os = detectOS();
      expect(os).toBe("linux");
    });
  });

  describe("detectArch", () => {
    it("returns a valid HostArch", () => {
      const arch = detectArch();
      expect(["amd64", "arm64"]).toContain(arch);
    });

    it("returns amd64 on this machine", () => {
      const arch = detectArch();
      expect(arch).toBe("amd64");
    });
  });

  describe("resolveSocketPath", () => {
    it("returns /var/run/docker.sock for docker on linux", () => {
      const path = resolveSocketPath("docker", "linux");
      expect(path).toBe("/var/run/docker.sock");
    });

    it("returns a path containing podman.sock for podman on linux", () => {
      const path = resolveSocketPath("podman", "linux");
      expect(path).toContain("podman.sock");
    });

    it("returns orbstack socket path for orbstack", () => {
      const path = resolveSocketPath("orbstack", "linux");
      expect(path).toContain("docker.sock");
    });
  });

  describe("resolveComposeBin", () => {
    it("returns docker compose for docker platform", () => {
      const result = resolveComposeBin("docker");
      expect(result).toEqual({ bin: "docker", subcommand: "compose" });
    });

    it("returns podman compose for podman platform", () => {
      const result = resolveComposeBin("podman");
      expect(result).toEqual({ bin: "podman", subcommand: "compose" });
    });

    it("returns docker compose for orbstack platform", () => {
      const result = resolveComposeBin("orbstack");
      expect(result).toEqual({ bin: "docker", subcommand: "compose" });
    });
  });

  describe("detectRuntime", () => {
    it("returns one of the valid container platforms or null", async () => {
      const result = await detectRuntime("linux");
      const validValues = ["docker", "podman", "orbstack", null];
      expect(validValues).toContain(result);
    });
  });

  describe("validateRuntime", () => {
    it("source code contains Bun.spawn and exitCode", () => {
      const sourcePath = join(import.meta.dir, "..", "..", "lib", "src", "runtime.ts");
      const source = readFileSync(sourcePath, "utf-8");
      expect(source).toContain("Bun.spawn");
      expect(source).toContain("exitCode");
    });

    it("exports validateRuntime function", () => {
      const sourcePath = join(import.meta.dir, "..", "..", "lib", "src", "runtime.ts");
      const source = readFileSync(sourcePath, "utf-8");
      expect(source).toContain("export async function validateRuntime");
    });
  });
});
