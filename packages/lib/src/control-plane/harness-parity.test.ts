/**
 * Harness-parity test.
 *
 * The recurring failure mode in this subsystem was never a wrong formula —
 * it was two harnesses answering the same question differently from the
 * SAME home: Electron ignored a persisted `OP_HOST_UI_PORT` the CLI
 * honored; Electron's env spread inverted live-vs-persisted precedence; the
 * UI carried its own, shorter assistant-URL chain. Phase 1 consolidated all
 * of that into two lib functions — `resolveHostUiPort` / `resolveUiListenEnv`
 * (network-contract.ts) and `resolveAssistantEndpoint` (assistant-endpoint.ts).
 *
 * This file does NOT re-test those functions' internals — network-contract.
 * test.ts and assistant-endpoint.test.ts already do that exhaustively. It
 * tests PARITY: that the way each real call site actually invokes the shared
 * resolver still converges on one answer, for the same seeded home + env.
 * Two verified real differences in call shape are exercised directly instead
 * of assumed away:
 *
 *  1. Host UI port — the "persisted" half of the merge is derived two
 *     different ways in shipped code: the CLI's `ui-server.ts` resolves it
 *     via `readStackEnv(homeDir)` (secret-stripped), Electron's `main.ts`
 *     resolves it via `parseEnvFile(stackEnvFile(homeDir))` directly (raw).
 *     `OP_HOST_UI_PORT` is not secret-like, so both must agree — but "not
 *     secret-like" is exactly the kind of fact a future refactor could get
 *     wrong silently, so it is asserted, per scenario, instead of assumed.
 *
 *  2. Host UI listen env — Electron's `buildUIServerEnv` does NOT call
 *     `resolveUiListenEnv` for HOST/ORIGIN; it bakes an admin-shaped loopback
 *     env by hand (packages/electron/src/main.ts), because the desktop app
 *     is unconditionally an admin host UI. That hand-baked shape is pinned
 *     here against `resolveUiListenEnv({ admin: true, allowRemote: false })`
 *     — if Electron ever stops being unconditionally admin, or the shared
 *     resolver's admin shape changes, THIS fails instead of the two quietly
 *     drifting apart the way the pre-Phase-1 code did.
 *
 *  3. Assistant endpoint — every real caller (Electron's `resolveAssistantUrl`,
 *     the CLI's session-maintenance client in `doctor.ts`, and the UI's
 *     `getAssistantOpencodeTarget`) invokes `resolveAssistantEndpoint(homeDir)`
 *     BARE, relying on its `env = process.env` default parameter. Nearly
 *     every existing assistant-endpoint.test.ts case instead passes an
 *     EXPLICIT env object, so a regression that only breaks the default
 *     parameter (the one every real caller actually depends on) would slip
 *     past that file. This file drives the full scenario table through the
 *     bare, process.env-implicit call shape and cross-checks it against the
 *     explicit-env call shape, so both are pinned — not just the one that
 *     happens to be easiest to unit test.
 *
 * (The container entrypoint mirrors the same assistant-endpoint precedence
 * inline in shell, per assistant-endpoint.ts's own header — that mirror is
 * out of scope for a TypeScript parity test and is not exercised here.)
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseEnvFile } from "./env.js";
import { stackEnvFile } from "./home.js";
import { readStackEnv } from "./secrets.js";
import { DEFAULT_HOST_UI_PORT, resolveHostUiPort, resolveUiListenEnv } from "./network-contract.js";
import { resolveAssistantEndpoint } from "./assistant-endpoint.js";
import { STACK_DEFAULTS } from "./defaults.js";

// ── shared home/env fixtures ────────────────────────────────────────────

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "openpalm-harness-parity-"));
  mkdirSync(join(home, "state"), { recursive: true });
  mkdirSync(join(home, "knowledge", "secrets"), { recursive: true });
  return home;
}

function writeStackEnv(home: string, entries: Record<string, string>): void {
  const lines = Object.entries(entries).map(([k, v]) => `${k}=${v}`);
  writeFileSync(join(home, "state", "stack.env"), lines.join("\n") + (lines.length ? "\n" : ""));
}

let homes: string[] = [];

beforeEach(() => {
  homes = [];
});

afterEach(() => {
  for (const home of homes) rmSync(home, { recursive: true, force: true });
});

function seededHome(persisted: Record<string, string>): string {
  const home = makeHome();
  homes.push(home);
  writeStackEnv(home, persisted);
  return home;
}

// ── 1. host UI port: CLI's readStackEnv vs Electron's parseEnvFile+stackEnvFile ──

/** Mirrors packages/cli/src/lib/ui-server.ts's resolvePort() -> resolveHostUiPortFromEnv. */
function cliHostUiPort(homeDir: string, env: Record<string, string | undefined>): number {
  return resolveHostUiPort(undefined, env, readStackEnv(homeDir));
}

/** Mirrors packages/electron/src/main.ts's module-level `const UI_PORT = resolveHostUiPort(...)`. */
function electronHostUiPort(homeDir: string, env: Record<string, string | undefined>): number {
  return resolveHostUiPort(undefined, env, parseEnvFile(stackEnvFile(homeDir)));
}

type PortScenario = {
  name: string;
  persisted: Record<string, string>;
  live: Record<string, string | undefined>;
  expectedPort: number;
};

const PORT_SCENARIOS: PortScenario[] = [
  {
    name: "default — nothing set anywhere",
    persisted: {},
    live: {},
    expectedPort: DEFAULT_HOST_UI_PORT,
  },
  {
    name: "persisted-only — a headless install's stack.env",
    persisted: { OP_HOST_UI_PORT: "4200" },
    live: {},
    expectedPort: 4200,
  },
  {
    name: "live-env-only — an operator-exported override, nothing persisted",
    persisted: {},
    live: { OP_HOST_UI_PORT: "5000" },
    expectedPort: 5000,
  },
  {
    name: "both — live env wins over persisted stack.env",
    persisted: { OP_HOST_UI_PORT: "4200" },
    live: { OP_HOST_UI_PORT: "5000" },
    expectedPort: 5000,
  },
];

describe("host UI port — CLI and Electron's differing persisted-env plumbing converge", () => {
  for (const scenario of PORT_SCENARIOS) {
    test(scenario.name, () => {
      const home = seededHome(scenario.persisted);
      const cli = cliHostUiPort(home, scenario.live);
      const electron = electronHostUiPort(home, scenario.live);
      expect(cli).toBe(scenario.expectedPort);
      expect(electron).toBe(scenario.expectedPort);
      // The real assertion: two independently-plumbed persisted-env reads
      // (secret-stripped vs raw) must still agree — this is what "same
      // home, two harnesses" caught diverging in shipped code.
      expect(cli).toBe(electron);
    });
  }
});

// ── 2. host UI listen env: Electron's hand-baked shape vs the shared resolver ──

describe("host UI listen env — Electron's hand-baked admin shape matches resolveUiListenEnv", () => {
  test("HOST/PORT/ORIGIN agree with the admin, non-remote branch", () => {
    const port = 4200;
    // Mirrors packages/electron/src/main.ts buildUIServerEnv's literal
    // `HOST: '127.0.0.1', PORT: String(port), ORIGIN: \`http://127.0.0.1:${port}\``,
    // plus its forced `OP_ALLOW_REMOTE_SETUP: '0'`.
    const electronBaked = {
      HOST: "127.0.0.1",
      PORT: String(port),
      ORIGIN: `http://127.0.0.1:${port}`,
    };
    const shared = resolveUiListenEnv({ port, admin: true, allowRemote: false });
    expect(shared.HOST).toBe(electronBaked.HOST);
    expect(shared.PORT).toBe(electronBaked.PORT);
    expect(shared.ORIGIN).toBe(electronBaked.ORIGIN);
  });

  test("the baked shape holds even if a future Electron passed allowRemote through", () => {
    // Electron never actually varies allowRemote (it forces
    // OP_ALLOW_REMOTE_SETUP=0), but admin:true must ignore it regardless —
    // host admin is never remotely reachable. If this ever stopped being
    // true, Electron's hand-baked loopback env would silently disagree with
    // what the shared resolver considers correct for an admin process.
    expect(resolveUiListenEnv({ port: 4200, admin: true, allowRemote: true }).HOST).toBe("127.0.0.1");
  });
});

// ── 3. assistant endpoint: the bare, process.env-implicit call shape every real caller uses ──

const ASSISTANT_ENV_KEYS = [
  "OP_UI_DEFAULT_ASSISTANT_URL",
  "OP_OPENCODE_URL",
  "OP_ASSISTANT_URL",
  "OP_ASSISTANT_PORT",
  "OP_ASSISTANT_BIND_ADDRESS",
] as const;

const savedAssistantEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ASSISTANT_ENV_KEYS) {
    savedAssistantEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ASSISTANT_ENV_KEYS) {
    if (savedAssistantEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedAssistantEnv[key];
  }
});

type AssistantScenario = {
  name: string;
  persisted: Record<string, string>;
  live: Record<string, string>;
  expectedUrl: string;
};

const ASSISTANT_SCENARIOS: AssistantScenario[] = [
  {
    name: "default — nothing set anywhere",
    persisted: {},
    live: {},
    expectedUrl: `http://127.0.0.1:${STACK_DEFAULTS.ports.assistant}`,
  },
  {
    name: "persisted-only — a headless install's stack.env",
    persisted: { OP_ASSISTANT_PORT: "4910" },
    live: {},
    expectedUrl: "http://127.0.0.1:4910",
  },
  {
    name: "live-env-only — an operator-exported override, nothing persisted",
    persisted: {},
    live: { OP_ASSISTANT_PORT: "5000" },
    expectedUrl: "http://127.0.0.1:5000",
  },
  {
    name: "both — live env wins over persisted stack.env",
    persisted: { OP_ASSISTANT_PORT: "4910" },
    live: { OP_ASSISTANT_PORT: "5000" },
    expectedUrl: "http://127.0.0.1:5000",
  },
  {
    name: "a custom assistant port persisted alone, distinct from every other default port",
    persisted: { OP_ASSISTANT_PORT: "9411" },
    live: {},
    expectedUrl: "http://127.0.0.1:9411",
  },
  {
    name: "a wildcard OP_ASSISTANT_BIND_ADDRESS normalizes to loopback — a wildcard is not dialable",
    persisted: { OP_ASSISTANT_BIND_ADDRESS: "0.0.0.0", OP_ASSISTANT_PORT: "3810" },
    live: {},
    expectedUrl: "http://127.0.0.1:3810",
  },
  {
    name: "a CONCRETE non-loopback bind is preserved — docker publishes bind:port:target on that interface only",
    persisted: { OP_ASSISTANT_BIND_ADDRESS: "192.168.1.50", OP_ASSISTANT_PORT: "3810" },
    live: {},
    expectedUrl: "http://192.168.1.50:3810",
  },
];

describe("assistant endpoint — the bare call every real caller uses (process.env default) matches the explicit-env call", () => {
  for (const scenario of ASSISTANT_SCENARIOS) {
    test(scenario.name, () => {
      const home = seededHome(scenario.persisted);
      for (const [key, value] of Object.entries(scenario.live)) process.env[key] = value;

      // Shape every real caller uses: Electron's resolveAssistantUrl, the
      // CLI's doctor.ts session client, and the UI's
      // getAssistantOpencodeTarget all call this bare, relying on the
      // env=process.env default parameter.
      const bare = resolveAssistantEndpoint(home);
      // Shape most of assistant-endpoint.test.ts's own cases use.
      const explicit = resolveAssistantEndpoint(home, process.env);

      expect(bare).toBe(scenario.expectedUrl);
      expect(explicit).toBe(scenario.expectedUrl);
      expect(bare).toBe(explicit);
    });
  }
});
