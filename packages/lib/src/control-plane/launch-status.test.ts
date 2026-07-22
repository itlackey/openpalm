/**
 * (#440) Launch-status routing table — the authoritative decision logic.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  deriveLaunchStatus,
  classifyLocalInstall,
  hasMaterializedLocalInstall,
  deriveLocalStackState,
  detectRuntimeName,
  type LocalStackState,
  type RemoteStatus,
} from "./launch-status.js";

function remote(state: RemoteStatus["state"], id = "r1", name = "Remote One"): RemoteStatus {
  return { id, name, url: `https://${id}.example`, state };
}

describe("deriveLaunchStatus routing table", () => {
  // | Local stack            | Remotes               | Route  |
  const cases: Array<{
    name: string;
    local: LocalStackState;
    remotes: RemoteStatus[];
    route: "chat" | "splash";
    active: "local" | "remote" | null;
  }> = [
    { name: "healthy local, no remotes", local: "running", remotes: [], route: "chat", active: "local" },
    { name: "healthy local + dead remote", local: "running", remotes: [remote("unreachable")], route: "chat", active: "local" },
    { name: "healthy local + healthy remote", local: "running", remotes: [remote("accessible")], route: "chat", active: "local" },
    { name: "not installed + accessible remote", local: "not_installed", remotes: [remote("accessible")], route: "chat", active: "remote" },
    { name: "not installed + only unreachable remote", local: "not_installed", remotes: [remote("unreachable")], route: "splash", active: null },
    { name: "not installed + no remotes", local: "not_installed", remotes: [], route: "splash", active: null },
    // The crucial rule: installed-but-unhealthy → splash EVEN WITH a healthy remote.
    { name: "offline local + healthy remote", local: "installed_offline", remotes: [remote("accessible")], route: "splash", active: null },
    { name: "broken local + healthy remote", local: "installed_broken", remotes: [remote("accessible")], route: "splash", active: null },
    { name: "setup-incomplete local + healthy remote", local: "setup_incomplete", remotes: [remote("accessible")], route: "splash", active: null },
    { name: "offline local, no remotes", local: "installed_offline", remotes: [], route: "splash", active: null },
  ];

  for (const c of cases) {
    it(c.name, () => {
      const s = deriveLaunchStatus({ local: { state: c.local }, remotes: c.remotes });
      expect(s.recommendedRoute).toBe(c.route);
      if (c.active === null) expect(s.activeAssistant).toBeNull();
      else expect(s.activeAssistant?.kind).toBe(c.active);
    });
  }

  it("picks the FIRST accessible remote as active on the remote route", () => {
    const s = deriveLaunchStatus({
      local: { state: "not_installed" },
      remotes: [remote("unreachable", "a"), remote("accessible", "b"), remote("accessible", "c")],
    });
    expect(s.activeAssistant).toEqual({ kind: "remote", id: "b" });
  });

  it("emits non-blocking alerts for other dead remotes when routing to chat", () => {
    const s = deriveLaunchStatus({
      local: { state: "running" },
      remotes: [remote("unreachable", "a", "Alpha"), remote("unauthorized", "b", "Beta"), remote("accessible", "c")],
    });
    expect(s.recommendedRoute).toBe("chat");
    expect(s.alerts).toHaveLength(2);
    expect(s.alerts[0]).toContain("Alpha");
    expect(s.alerts[1]).toContain("Beta");
  });

  it("emits NO alerts on the splash route (the splash itself shows guidance)", () => {
    const s = deriveLaunchStatus({
      local: { state: "installed_offline" },
      remotes: [remote("unreachable")],
    });
    expect(s.recommendedRoute).toBe("splash");
    expect(s.alerts).toHaveLength(0);
  });

  it("exposes the convenience derivations", () => {
    const s = deriveLaunchStatus({ local: { state: "installed_broken" }, remotes: [remote("accessible")] });
    expect(s.hasHealthyLocal).toBe(false);
    expect(s.localInstalledButUnhealthy).toBe(true);
    expect(s.hasAccessibleRemote).toBe(true);
  });
});

describe("classifyLocalInstall (disk markers)", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "launch-status-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  function stackDir(): string {
    const sd = join(dir, "config", "stack");
    mkdirSync(sd, { recursive: true });
    return sd;
  }
  function writeStackEnv(content: string): void {
    const envDir = join(dir, "knowledge", "env");
    mkdirSync(envDir, { recursive: true });
    writeFileSync(join(envDir, "stack.env"), content);
  }

  it("not_installed when no compose and not complete", () => {
    expect(classifyLocalInstall(stackDir(), dir)).toBe("not_installed");
  });

  it("setup_incomplete when compose exists but OP_SETUP_COMPLETE is unset", () => {
    const sd = stackDir();
    writeFileSync(join(sd, "core.compose.yml"), "services: {}");
    expect(classifyLocalInstall(sd, dir)).toBe("setup_incomplete");
  });

  it("installed when OP_SETUP_COMPLETE=true (even without compose on disk yet)", () => {
    const sd = stackDir();
    writeStackEnv("OP_SETUP_COMPLETE=true\n");
    expect(classifyLocalInstall(sd, dir)).toBe("installed");
  });

  it("installed when compose exists and both guardian tokens are present, even without the OP_SETUP_COMPLETE stamp (hand-built install, R1-R3)", () => {
    const sd = stackDir();
    writeFileSync(join(sd, "core.compose.yml"), "services: {}");
    const secretsDir = join(dir, "knowledge", "secrets");
    mkdirSync(secretsDir, { recursive: true });
    writeFileSync(join(secretsDir, "op_guardian_admin_token"), "deadbeef\n");
    writeFileSync(join(secretsDir, "op_guardian_mcp_token"), "cafef00d\n");
    expect(classifyLocalInstall(sd, dir)).toBe("installed");
  });

  it("stays setup_incomplete when compose exists but only ONE guardian token is present", () => {
    const sd = stackDir();
    writeFileSync(join(sd, "core.compose.yml"), "services: {}");
    const secretsDir = join(dir, "knowledge", "secrets");
    mkdirSync(secretsDir, { recursive: true });
    writeFileSync(join(secretsDir, "op_guardian_admin_token"), "deadbeef\n");
    expect(classifyLocalInstall(sd, dir)).toBe("setup_incomplete");
  });

  it("exposes one authoritative read-only materialization predicate", () => {
    expect(hasMaterializedLocalInstall(dir)).toBe(false);

    const sd = join(dir, "system", "stack");
    mkdirSync(sd, { recursive: true });
    writeFileSync(join(sd, "core.compose.yml"), "services: {}");
    expect(hasMaterializedLocalInstall(dir)).toBe(true);

    rmSync(sd, { recursive: true, force: true });
    writeStackEnv("OP_SETUP_COMPLETE=true\n");
    expect(hasMaterializedLocalInstall(dir)).toBe(true);
  });
});

describe('deriveLocalStackState', () => {
  it('treats a setup-incomplete but already-running stack as running', () => {
    expect(deriveLocalStackState('setup_incomplete', [{ service: 'assistant', state: 'running', health: 'healthy' }])).toBe('running');
  });

  it('treats exited installed services as installed_broken', () => {
    expect(deriveLocalStackState('installed', [{ service: 'assistant', state: 'exited', health: '' }])).toBe('installed_broken');
  });
});

describe("detectRuntimeName", () => {
  it("detects OrbStack", () => {
    expect(detectRuntimeName("Server: OrbStack\n Engine: Docker Desktop")).toBe("OrbStack");
  });

  it("detects Podman", () => {
    expect(detectRuntimeName("Emulate Docker CLI using podman\nServer: Podman Engine")).toBe("Podman");
  });

  it("falls back to Docker", () => {
    expect(detectRuntimeName("Client: Docker Engine\nServer: Docker Engine")).toBe("Docker");
  });
});
