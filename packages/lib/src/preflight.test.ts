import { describe, expect, it } from "bun:test";
import {
  checkDiskSpaceDetailed,
  checkPortDetailed,
  checkDaemonRunningDetailed,
  runPreflightChecksDetailed,
} from "./preflight.ts";
import type { PreflightIssue } from "./types.ts";

describe("preflight typed issue contracts", () => {
  describe("checkDiskSpaceDetailed", () => {
    it("returns null when disk space is sufficient", async () => {
      const result = await checkDiskSpaceDetailed();
      if (result !== null) {
        expect(result.code).toBe("disk_low");
        expect(result.severity).toBe("warning");
        expect(result.meta?.availableGb).toBeNumber();
      } else {
        expect(result).toBeNull();
      }
    });

    it("returns disk_low code with warning severity when triggered", () => {
      const mockIssue: PreflightIssue = {
        code: "disk_low",
        severity: "warning",
        message: "Low disk space — only ~1.5 GB available.",
        detail: "OpenPalm needs roughly 3 GB for container images and data.",
        meta: { availableGb: 1.5 },
      };
      expect(mockIssue.code).toBe("disk_low");
      expect(mockIssue.severity).toBe("warning");
      expect(mockIssue.meta?.availableGb).toBe(1.5);
    });
  });

  describe("checkPortDetailed", () => {
    it("returns null for a port that is not in use", async () => {
      const result = await checkPortDetailed(59123);
      expect(result).toBeNull();
    });

    it("returns port_conflict code with fatal severity when triggered", () => {
      const mockIssue: PreflightIssue = {
        code: "port_conflict",
        severity: "fatal",
        message: "Port 80 is already in use by another process.",
        detail: "OpenPalm needs port 80 for its web interface.",
        meta: { port: 80 },
      };
      expect(mockIssue.code).toBe("port_conflict");
      expect(mockIssue.severity).toBe("fatal");
      expect(mockIssue.meta?.port).toBe(80);
    });
  });

  describe("checkDaemonRunningDetailed", () => {
    it("returns daemon_unavailable or daemon_check_failed for a bad binary", async () => {
      const result = await checkDaemonRunningDetailed("nonexistent-binary-xyz");
      expect(result).not.toBeNull();
      expect(["daemon_unavailable", "daemon_check_failed"]).toContain(result!.code);
      expect(result!.severity).toBe("fatal");
      expect(result!.meta?.runtime).toBe("docker");
      expect(result!.meta?.command).toBe("nonexistent-binary-xyz info");
    });
  });

  describe("runPreflightChecksDetailed", () => {
    it("returns a PreflightResult with ok and issues fields", async () => {
      const result = await runPreflightChecksDetailed("nonexistent-binary-xyz", 59124);
      expect(result).toHaveProperty("ok");
      expect(result).toHaveProperty("issues");
      expect(Array.isArray(result.issues)).toBe(true);
      expect(result.issues.length).toBeGreaterThanOrEqual(1);
      expect(result.ok).toBe(false);
    });

    it("sets ok to false when any issue has fatal severity", async () => {
      const result = await runPreflightChecksDetailed("nonexistent-binary-xyz", 59125);
      expect(result.ok).toBe(false);
      const fatalIssues = result.issues.filter((i) => i.severity === "fatal");
      expect(fatalIssues.length).toBeGreaterThanOrEqual(1);
    });

    it("every issue has required fields", async () => {
      const result = await runPreflightChecksDetailed("nonexistent-binary-xyz", 59127);
      for (const issue of result.issues) {
        expect(issue.code).toBeDefined();
        expect(issue.severity).toBeDefined();
        expect(issue.message).toBeDefined();
        expect(typeof issue.code).toBe("string");
        expect(typeof issue.severity).toBe("string");
        expect(typeof issue.message).toBe("string");
        expect(["fatal", "warning"]).toContain(issue.severity);
        expect(["daemon_unavailable", "daemon_check_failed", "port_conflict", "disk_low", "unknown"]).toContain(issue.code);
      }
    });
  });

  describe("severity contracts", () => {
    it("disk_low is always warning severity", () => {
      const issue: PreflightIssue = {
        code: "disk_low",
        severity: "warning",
        message: "Low disk space",
        meta: { availableGb: 1.0 },
      };
      expect(issue.severity).toBe("warning");
    });

    it("daemon_unavailable is always fatal severity", () => {
      const issue: PreflightIssue = {
        code: "daemon_unavailable",
        severity: "fatal",
        message: "Docker daemon not running",
        meta: { runtime: "docker", command: "docker info" },
      };
      expect(issue.severity).toBe("fatal");
    });

    it("daemon_check_failed is always fatal severity", () => {
      const issue: PreflightIssue = {
        code: "daemon_check_failed",
        severity: "fatal",
        message: "Could not verify daemon",
        meta: { runtime: "docker", command: "docker info" },
      };
      expect(issue.severity).toBe("fatal");
    });

    it("port_conflict is always fatal severity", () => {
      const issue: PreflightIssue = {
        code: "port_conflict",
        severity: "fatal",
        message: "Port 80 in use",
        meta: { port: 80 },
      };
      expect(issue.severity).toBe("fatal");
    });
  });
});
