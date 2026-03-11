import { describe, it, expect, beforeEach } from "vitest";
import {
  getDeployStatus,
  initDeployStatus,
  markImageReady,
  markAllImagesReady,
  markContainerRunning,
  markAllRunning,
  markDeployError,
  clearDeployStatus,
} from "./deploy-tracker.js";

describe("deploy-tracker", () => {
  beforeEach(() => {
    clearDeployStatus();
  });

  it("returns null when no deploy is active", () => {
    expect(getDeployStatus()).toBeNull();
  });

  it("initializes with pulling phase and all services pending", () => {
    initDeployStatus([
      { service: "caddy", label: "Caddy" },
      { service: "memory", label: "Memory" },
    ]);

    const status = getDeployStatus();
    expect(status).not.toBeNull();
    expect(status!.phase).toBe("pulling");
    expect(status!.message).toBe("Pulling container images...");
    expect(status!.services).toHaveLength(2);
    expect(status!.services[0]).toEqual({
      service: "caddy",
      label: "Caddy",
      imageReady: false,
      containerRunning: false,
    });
  });

  it("markImageReady sets imageReady for the named service", () => {
    initDeployStatus([
      { service: "caddy", label: "Caddy" },
      { service: "memory", label: "Memory" },
    ]);

    markImageReady("caddy");

    const status = getDeployStatus()!;
    expect(status.services[0].imageReady).toBe(true);
    expect(status.services[1].imageReady).toBe(false);
  });

  it("markImageReady is a no-op for unknown service names", () => {
    initDeployStatus([{ service: "caddy", label: "Caddy" }]);
    markImageReady("unknown-service");

    const status = getDeployStatus()!;
    expect(status.services[0].imageReady).toBe(false);
  });

  it("markImageReady is a no-op when no deploy is active", () => {
    // Should not throw
    markImageReady("caddy");
    expect(getDeployStatus()).toBeNull();
  });

  it("markAllImagesReady sets all images ready and transitions to starting phase", () => {
    initDeployStatus([
      { service: "caddy", label: "Caddy" },
      { service: "memory", label: "Memory" },
    ]);

    markAllImagesReady();

    const status = getDeployStatus()!;
    expect(status.phase).toBe("starting");
    expect(status.message).toBe("Starting services...");
    expect(status.services.every((s) => s.imageReady)).toBe(true);
    expect(status.services.every((s) => s.containerRunning)).toBe(false);
  });

  it("markContainerRunning sets containerRunning for the named service", () => {
    initDeployStatus([
      { service: "caddy", label: "Caddy" },
      { service: "memory", label: "Memory" },
    ]);

    markContainerRunning("memory");

    const status = getDeployStatus()!;
    expect(status.services[0].containerRunning).toBe(false);
    expect(status.services[1].containerRunning).toBe(true);
  });

  it("markAllRunning sets all services as running and transitions to ready", () => {
    initDeployStatus([
      { service: "caddy", label: "Caddy" },
      { service: "memory", label: "Memory" },
    ]);

    markAllRunning();

    const status = getDeployStatus()!;
    expect(status.phase).toBe("ready");
    expect(status.message).toBe("All services are up and running.");
    expect(status.services.every((s) => s.imageReady)).toBe(true);
    expect(status.services.every((s) => s.containerRunning)).toBe(true);
  });

  it("markDeployError transitions to error phase with message", () => {
    initDeployStatus([{ service: "caddy", label: "Caddy" }]);

    markDeployError("Docker Compose failed: port conflict");

    const status = getDeployStatus()!;
    expect(status.phase).toBe("error");
    expect(status.message).toBe("Docker Compose failed: port conflict");
    expect(status.error).toBe("Docker Compose failed: port conflict");
  });

  it("clearDeployStatus resets to null", () => {
    initDeployStatus([{ service: "caddy", label: "Caddy" }]);
    expect(getDeployStatus()).not.toBeNull();

    clearDeployStatus();
    expect(getDeployStatus()).toBeNull();
  });

  it("all functions are safe to call when no deploy is active", () => {
    // None of these should throw
    markImageReady("caddy");
    markAllImagesReady();
    markContainerRunning("caddy");
    markAllRunning();
    markDeployError("test");
    clearDeployStatus();
    expect(getDeployStatus()).toBeNull();
  });
});
