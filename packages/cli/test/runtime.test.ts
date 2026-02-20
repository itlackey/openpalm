import { describe, expect, it } from "bun:test";
import { detectOS, detectArch, resolveSocketPath, resolveComposeBin } from "../src/lib/runtime.ts";

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
});
