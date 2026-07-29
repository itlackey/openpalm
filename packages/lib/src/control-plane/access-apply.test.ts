/**
 * Saving access toggles must APPLY them.
 *
 * The bind addresses, OPENCODE_AUTH and GUARDIAN_DIRECT_INGRESS reach Docker
 * only through Compose interpolation, which is re-read on container RECREATE.
 * Every "restart" the product offered runs `compose restart`, which keeps the
 * original port bindings and environment — so a toggle save wrote a file,
 * advertised a .local name, and published nothing.
 *
 * Dependencies are injected rather than module-mocked: a whole-module mock is
 * process-global in Bun and leaks into unrelated files in the aggregate run.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyAccessToggles,
  diffAccessEnv,
  resolveRecreateScope,
  type AccessApplyDeps,
} from "./access-apply.ts";
import { resolveAccessEnv, ACCESS_TOGGLE_DEFAULTS, type AccessToggles } from "./access-toggles.ts";
import { stackEnvFile } from "./home.ts";
import type { ControlPlaneState } from "./types.ts";

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeHome(stackEnv = ""): ControlPlaneState {
  const home = mkdtempSync(join(tmpdir(), "op-access-apply-"));
  tmpDirs.push(home);
  const envPath = stackEnvFile(home);
  mkdirSync(join(envPath, ".."), { recursive: true });
  writeFileSync(envPath, stackEnv);
  mkdirSync(join(home, "state"), { recursive: true });
  return {
    homeDir: home,
    configDir: join(home, "config"),
    stashDir: join(home, "knowledge"),
    workspaceDir: join(home, "workspace"),
    dataDir: join(home, "data"),
    stackDir: join(home, "system", "stack"),
    services: {},
    artifacts: { compose: "" },
    artifactMeta: [],
  } as ControlPlaneState;
}

function readEnv(state: ControlPlaneState): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(stackEnvFile(state.homeDir), "utf-8").split("\n")) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match) out[match[1]] = match[2];
  }
  return out;
}

/** Recording doubles; `deployed` controls what compose "already has". */
function makeDeps(deployed: string[] = ["assistant"]) {
  const calls: { recreated: string[][]; mdnsAfter: string[][] } = { recreated: [], mdnsAfter: [] };
  const deps: AccessApplyDeps = {
    listDeployedServices: async () => deployed,
    recreateServices: async (_state, services) => {
      calls.recreated.push(services);
      return { ok: true, started: services };
    },
    reconcileMdns: () => {
      // Record the recreate history AT THE MOMENT mDNS runs, so ordering is
      // observable: advertising before the recreate is the actual bug.
      calls.mdnsAfter.push(calls.recreated.flat());
      return {
        assistant: { name: "openpalm.local", port: 3800, advertised: true },
        guardian: { name: "openpalm-guardian.local", port: 3830, advertised: false },
      } as ReturnType<AccessApplyDeps["reconcileMdns"]>;
    },
  };
  return { deps, calls };
}

const ALL_OFF: AccessToggles = { ...ACCESS_TOGGLE_DEFAULTS };

describe("diffAccessEnv", () => {
  test("reports only the keys whose value actually changed", () => {
    const current = resolveAccessEnv(ALL_OFF) as unknown as Record<string, string>;
    const next = resolveAccessEnv({ ...ALL_OFF, networkAccess: true });
    expect(diffAccessEnv(current, next)).toEqual(["OP_UI_BIND_ADDRESS"]);
  });

  test("an unset key differs from a written loopback value, so a first write applies", () => {
    expect(diffAccessEnv({}, resolveAccessEnv(ALL_OFF)).length).toBeGreaterThan(0);
  });

  test("no diff when nothing moved", () => {
    const current = resolveAccessEnv(ALL_OFF) as unknown as Record<string, string>;
    expect(diffAccessEnv(current, resolveAccessEnv(ALL_OFF))).toEqual([]);
  });
});

describe("resolveRecreateScope", () => {
  test("UI/assistant/auth keys map to the assistant container only", () => {
    expect(resolveRecreateScope(["OP_UI_BIND_ADDRESS"], [], ["assistant", "guardian"])).toEqual([
      "assistant",
    ]);
    expect(resolveRecreateScope(["OPENCODE_AUTH"], [], ["assistant", "guardian"])).toEqual([
      "assistant",
    ]);
  });

  test("a guardian-only change never recreates the assistant — that would drop a live chat turn", () => {
    expect(
      resolveRecreateScope(["OP_GUARDIAN_BIND_ADDRESS"], [], ["assistant", "guardian"]),
    ).toEqual(["guardian"]);
  });

  test("a service with no container is skipped, so an install with no guardian does not fail", () => {
    expect(resolveRecreateScope(["OP_API_BIND_ADDRESS"], [], ["assistant"])).toEqual([]);
  });

  test("a just-enabled addon is included even though compose ps cannot see it yet", () => {
    expect(resolveRecreateScope([], ["guardian"], ["assistant"])).toEqual(["guardian"]);
  });
});

describe("applyAccessToggles", () => {
  test("writes the generated row and recreates the assistant when networkAccess turns on", async () => {
    const state = makeHome("OP_UI_BIND_ADDRESS=127.0.0.1\n");
    const { deps, calls } = makeDeps(["assistant"]);

    const result = await applyAccessToggles(state, { ...ALL_OFF, networkAccess: true }, { deps });

    expect(result.ok).toBe(true);
    expect(readEnv(state).OP_UI_BIND_ADDRESS).toBe("0.0.0.0");
    expect(calls.recreated).toEqual([["assistant"]]);
    expect(result.access.networkAccess).toBe(true);
  });

  test("advertises over mDNS only AFTER the recreate", async () => {
    // The ordering IS the fix: advertising first made <name>.local resolve to a
    // port that refused connections.
    const state = makeHome("OP_UI_BIND_ADDRESS=127.0.0.1\n");
    const { deps, calls } = makeDeps(["assistant"]);

    await applyAccessToggles(state, { ...ALL_OFF, networkAccess: true }, { deps });

    expect(calls.mdnsAfter).toEqual([["assistant"]]);
  });

  test("does not recreate anything when no generated value moved", async () => {
    const state = makeHome(
      Object.entries(resolveAccessEnv(ALL_OFF))
        .map(([k, v]) => `${k}=${v}`)
        .join("\n"),
    );
    const { deps, calls } = makeDeps(["assistant", "guardian"]);

    const result = await applyAccessToggles(state, ALL_OFF, { deps });

    expect(result.changedKeys).toEqual([]);
    expect(calls.recreated).toEqual([]);
  });

  test("turning assistantDirect off recreates the assistant so OpenCode stops requiring auth", async () => {
    // Otherwise the host proxy drops Basic auth while the running OpenCode
    // still demands it, and /oc chat 401s until an unrelated future up -d.
    const state = makeHome("OP_ASSISTANT_BIND_ADDRESS=0.0.0.0\nOPENCODE_AUTH=true\n");
    const { deps, calls } = makeDeps(["assistant"]);

    const result = await applyAccessToggles(state, ALL_OFF, { deps });

    expect(result.changedKeys).toContain("OPENCODE_AUTH");
    expect(readEnv(state).OPENCODE_AUTH).toBe("false");
    expect(calls.recreated).toEqual([["assistant"]]);
  });

  test("reports failure without claiming the settings are live", async () => {
    const state = makeHome("OP_UI_BIND_ADDRESS=127.0.0.1\n");
    const { deps } = makeDeps(["assistant"]);
    deps.recreateServices = async () => ({ ok: false, started: [], error: "port already allocated" });

    const result = await applyAccessToggles(state, { ...ALL_OFF, networkAccess: true }, { deps });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("port already allocated");
    // The env IS written — the operator's intent is recorded and a later
    // `openpalm start` will apply it.
    expect(readEnv(state).OP_UI_BIND_ADDRESS).toBe("0.0.0.0");
  });

  test("a throwing compose apply is reported, not propagated", async () => {
    const state = makeHome("OP_UI_BIND_ADDRESS=127.0.0.1\n");
    const { deps } = makeDeps(["assistant"]);
    deps.recreateServices = async () => {
      throw new Error("docker daemon not running");
    };

    const result = await applyAccessToggles(state, { ...ALL_OFF, networkAccess: true }, { deps });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("docker daemon not running");
  });

  test("extraEnv rides along in the same patch", async () => {
    const state = makeHome("");
    const { deps } = makeDeps([]);

    await applyAccessToggles(state, ALL_OFF, { deps, extraEnv: { OP_PROJECT_NAME: "renamed" } });

    expect(readEnv(state).OP_PROJECT_NAME).toBe("renamed");
  });

  test("skipRecreate leaves the apply to a caller that deploys the whole stack", async () => {
    const state = makeHome("OP_UI_BIND_ADDRESS=127.0.0.1\n");
    const { deps, calls } = makeDeps(["assistant"]);

    const result = await applyAccessToggles(
      state,
      { ...ALL_OFF, networkAccess: true },
      { deps, skipRecreate: true },
    );

    expect(result.ok).toBe(true);
    expect(calls.recreated).toEqual([]);
    expect(readEnv(state).OP_UI_BIND_ADDRESS).toBe("0.0.0.0");
  });
});
