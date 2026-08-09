/**
 * Every state transition of the Tailscale provider's status read-back
 * (remote-provider-status.ts), driven through injected deps so no Docker
 * daemon is involved — the gold-standard bar remote-access-providers.md §8
 * sets: every vocabulary state a provider can emit is reachable in a test.
 *
 * The fabricated `tailscale status --json` payloads follow the shapes the
 * live implementation was verified against (AuthURL while sign-in is
 * pending; Self.DNSName with a trailing dot once registered; Self.KeyExpiry
 * as RFC3339). The compose-ps rows follow `parseComposePsRows`' contract.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  fetchRemoteProviderStatus,
  type RemoteProviderStatusDeps,
} from "./remote-provider-status.js";
import type { ControlPlaneState } from "./types.js";

let tempDir: string;

function makeState(): ControlPlaneState {
  return {
    homeDir: tempDir,
    configDir: join(tempDir, "config"),
    stashDir: join(tempDir, "knowledge"),
    workspaceDir: join(tempDir, "workspace"),
    dataDir: join(tempDir, "data"),
    stackDir: join(tempDir, "system", "stack"),
    services: {},
    artifacts: { compose: "" },
    artifactMeta: [],
  };
}

function seedHome(stackEnv: string): void {
  mkdirSync(join(tempDir, "system", "stack"), { recursive: true });
  writeFileSync(join(tempDir, "system", "stack", "core.compose.yml"), "services: {}");
  mkdirSync(join(tempDir, "state"), { recursive: true });
  writeFileSync(join(tempDir, "state", "stack.env"), stackEnv);
}

const NOW = Date.parse("2026-08-07T00:00:00Z");

type ExecResult = { ok: boolean; stdout: string; stderr: string; code: number };

function deps(overrides: {
  exec?: ExecResult;
  ps?: ExecResult;
}): Partial<RemoteProviderStatusDeps> {
  return {
    composeExec: async () =>
      overrides.exec ?? { ok: false, stdout: "", stderr: "no exec stub", code: 1 },
    composePs: async () =>
      overrides.ps ?? { ok: false, stdout: "", stderr: "no ps stub", code: 1 },
    now: () => NOW,
  };
}

function execOk(payload: unknown): ExecResult {
  return { ok: true, stdout: JSON.stringify(payload), stderr: "", code: 0 };
}

function psOk(rows: Record<string, string>[]): ExecResult {
  return {
    ok: true,
    stdout: rows.map((r) => JSON.stringify(r)).join("\n"),
    stderr: "",
    code: 0,
  };
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "remote-status-test-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("addon-level states", () => {
  test("disabled addon reports off without touching Docker", async () => {
    seedHome("OP_ENABLED_ADDONS=chat\n");
    let dockerTouched = false;
    const status = await fetchRemoteProviderStatus(makeState(), {
      composeExec: async () => {
        dockerTouched = true;
        return { ok: false, stdout: "", stderr: "", code: 1 };
      },
    });
    expect(status.state).toBe("off");
    expect(dockerTouched).toBe(false);
  });
});

describe("tailscale — LocalAPI answering", () => {
  test("AuthURL maps to awaiting-authentication with the Connect action", async () => {
    seedHome("OP_ENABLED_ADDONS=remote\n");
    const status = await fetchRemoteProviderStatus(
      makeState(),
      deps({
        exec: execOk({ BackendState: "NeedsLogin", AuthURL: "https://login.tailscale.com/a/abc" }),
      }),
    );
    expect(status.state).toBe("awaiting-authentication");
    expect(status.action).toEqual({
      label: "Connect your account",
      url: "https://login.tailscale.com/a/abc",
    });
  });

  test("Running + DNSName maps to up, trailing dot stripped, QR on the assistant URL", async () => {
    seedHome("OP_ENABLED_ADDONS=remote\n");
    const status = await fetchRemoteProviderStatus(
      makeState(),
      deps({
        exec: execOk({
          BackendState: "Running",
          Self: { DNSName: "openpalm.tail1234.ts.net." },
        }),
      }),
    );
    expect(status.state).toBe("up");
    expect(status.copyables).toEqual([
      { label: "Assistant address", value: "https://openpalm.tail1234.ts.net", qr: true },
    ]);
    expect(status.message).toContain("Only devices signed in");
  });

  test("target=both advertises assistant and guardian addresses; public flips the reach copy", async () => {
    seedHome("OP_ENABLED_ADDONS=remote\nOP_REMOTE_TARGET=both\nOP_REMOTE_PUBLIC=true\n");
    const status = await fetchRemoteProviderStatus(
      makeState(),
      deps({
        exec: execOk({ BackendState: "Running", Self: { DNSName: "op.ts.net." } }),
      }),
    );
    expect(status.state).toBe("up");
    expect(status.copyables?.map((c) => c.value)).toEqual([
      "https://op.ts.net",
      "https://op.ts.net:8443",
    ]);
    expect(status.message).toContain("Anyone with the address");
  });

  test("a URL is advertised ONLY in up — never in any other state", async () => {
    seedHome("OP_ENABLED_ADDONS=remote\n");
    const nonUp = [
      execOk({ BackendState: "Starting" }),
      execOk({ BackendState: "NeedsLogin", AuthURL: "https://login.tailscale.com/a/x" }),
      execOk({ BackendState: "Stopped" }),
    ];
    for (const exec of nonUp) {
      const status = await fetchRemoteProviderStatus(makeState(), deps({ exec }));
      expect(status.state).not.toBe("up");
      expect(status.copyables ?? []).toEqual([]);
    }
  });

  test("Starting and NoState map to starting", async () => {
    seedHome("OP_ENABLED_ADDONS=remote\n");
    for (const backend of ["Starting", "NoState"]) {
      const status = await fetchRemoteProviderStatus(
        makeState(),
        deps({ exec: execOk({ BackendState: backend }) }),
      );
      expect(status.state).toBe("starting");
    }
  });

  test("an unknown backend state maps to degraded, naming what Tailscale reported", async () => {
    seedHome("OP_ENABLED_ADDONS=remote\n");
    const status = await fetchRemoteProviderStatus(
      makeState(),
      deps({ exec: execOk({ BackendState: "Stopped" }) }),
    );
    expect(status.state).toBe("degraded");
    expect(status.message).toContain("Stopped");
  });

  test("unreadable status output maps to error", async () => {
    seedHome("OP_ENABLED_ADDONS=remote\n");
    const status = await fetchRemoteProviderStatus(
      makeState(),
      deps({ exec: { ok: true, stdout: "not json", stderr: "", code: 0 } }),
    );
    expect(status.state).toBe("error");
  });

  test("an invalid OP_REMOTE_TARGET maps to error — every path returns a status, never throws", async () => {
    seedHome("OP_ENABLED_ADDONS=remote\nOP_REMOTE_TARGET=bogus\n");
    const status = await fetchRemoteProviderStatus(
      makeState(),
      deps({
        exec: execOk({ BackendState: "Running", Self: { DNSName: "op.ts.net." } }),
      }),
    );
    expect(status.state).toBe("error");
    expect(status.message).toContain("OP_REMOTE_TARGET");
    expect(status.copyables ?? []).toEqual([]);
  });
});

describe("tailscale — node-key expiry (roadmap risk 6)", () => {
  test("an expired key degrades the tunnel with re-sign-in guidance", async () => {
    seedHome("OP_ENABLED_ADDONS=remote\n");
    const status = await fetchRemoteProviderStatus(
      makeState(),
      deps({
        exec: execOk({
          BackendState: "Running",
          Self: { DNSName: "op.ts.net.", KeyExpiry: "2026-08-06T00:00:00Z" },
        }),
      }),
    );
    expect(status.state).toBe("degraded");
    expect(status.message).toContain("expired");
    expect(status.copyables ?? []).toEqual([]);
  });

  test("an expiry inside the warning window stays up but says so", async () => {
    seedHome("OP_ENABLED_ADDONS=remote\n");
    const status = await fetchRemoteProviderStatus(
      makeState(),
      deps({
        exec: execOk({
          BackendState: "Running",
          Self: { DNSName: "op.ts.net.", KeyExpiry: "2026-08-14T00:00:00Z" },
        }),
      }),
    );
    expect(status.state).toBe("up");
    expect(status.message).toContain("expires in 7 days");
  });

  test("a far-off expiry adds no note; an absent expiry (tagged node) adds none either", async () => {
    seedHome("OP_ENABLED_ADDONS=remote\n");
    for (const self of [
      { DNSName: "op.ts.net.", KeyExpiry: "2027-01-01T00:00:00Z" },
      { DNSName: "op.ts.net." },
    ]) {
      const status = await fetchRemoteProviderStatus(
        makeState(),
        deps({ exec: execOk({ BackendState: "Running", Self: self }) }),
      );
      expect(status.state).toBe("up");
      expect(status.message).not.toContain("expires");
    }
  });
});

describe("tailscale — LocalAPI not answering (compose ps disambiguation)", () => {
  test("never-started container reads as starting with the start hint", async () => {
    seedHome("OP_ENABLED_ADDONS=remote\n");
    const status = await fetchRemoteProviderStatus(makeState(), deps({ ps: psOk([]) }));
    expect(status.state).toBe("starting");
    expect(status.message).toContain("openpalm start");
  });

  test("stopped or crash-looping container reads as error, not eternal starting", async () => {
    seedHome("OP_ENABLED_ADDONS=remote\n");
    for (const stateStr of ["exited", "restarting"]) {
      const status = await fetchRemoteProviderStatus(
        makeState(),
        deps({ ps: psOk([{ Service: "tunnel", State: stateStr, Health: "", ID: "t" }]) }),
      );
      expect(status.state).toBe("error");
      expect(status.message).toContain("openpalm logs tunnel");
    }
  });

  test("running-but-unhealthy container reads as starting (containerboot booting)", async () => {
    seedHome("OP_ENABLED_ADDONS=remote\n");
    const status = await fetchRemoteProviderStatus(
      makeState(),
      deps({ ps: psOk([{ Service: "tunnel", State: "running", Health: "starting", ID: "t" }]) }),
    );
    expect(status.state).toBe("starting");
  });

  test("healthy container with a dead status socket reads as degraded — a contradiction, not patience", async () => {
    seedHome("OP_ENABLED_ADDONS=remote\n");
    const status = await fetchRemoteProviderStatus(
      makeState(),
      deps({ ps: psOk([{ Service: "tunnel", State: "running", Health: "healthy", ID: "t" }]) }),
    );
    expect(status.state).toBe("degraded");
  });

  test("Docker itself unreachable degrades to an honest unknown, still starting-shaped", async () => {
    seedHome("OP_ENABLED_ADDONS=remote\n");
    const status = await fetchRemoteProviderStatus(makeState(), deps({}));
    expect(status.state).toBe("starting");
    expect(status.message).toContain("Docker couldn't be asked");
  });
});
