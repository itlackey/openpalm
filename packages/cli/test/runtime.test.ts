import { describe, expect, it } from "bun:test";
import { detectOS, detectArch, resolveSocketPath, COMPOSE_BIN, detectRuntime } from "@openpalm/lib/runtime.ts";

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
      const path = resolveSocketPath("linux");
      expect(path).toBe("/var/run/docker.sock");
    });
  });

  describe("COMPOSE_BIN", () => {
    it("has docker compose values", () => {
      expect(COMPOSE_BIN).toEqual({ bin: "docker", subcommand: "compose" });
    });
  });

  describe("detectRuntime", () => {
    it("returns docker or null", async () => {
      const result = await detectRuntime();
      expect(["docker", null]).toContain(result);
    });
  });
});
