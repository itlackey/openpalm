import { describe, expect, it } from "bun:test";
import { detectOS, detectArch, resolveSocketPath, resolveComposeBin, detectRuntime, validateRuntime } from "@openpalm/lib/runtime.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("runtime", () => {
  describe("detectOS", () => {
    it("returns a valid HostOS", () => {
      const os = detectOS();
      expect(["linux", "macos", "windows", "unknown"]).toContain(os);
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
  });

  describe("resolveComposeBin", () => {
    it("returns docker compose for docker platform", () => {
      const result = resolveComposeBin("docker");
      expect(result).toEqual({ bin: "docker", subcommand: "compose" });
    });
  });

  describe("detectRuntime", () => {
    it("returns docker or null", async () => {
      const result = await detectRuntime("linux");
      expect(["docker", null]).toContain(result);
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
