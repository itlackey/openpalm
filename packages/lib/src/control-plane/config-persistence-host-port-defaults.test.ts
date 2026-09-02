/**
 * ensureHostPortDefaults (#660) — closes the class of host-blind default port
 * collisions the two port migrations above it in config-persistence.ts never
 * covered: they only ever considered the assistant/ui pair, so every OTHER
 * compose-published port (workspace, api, guardian, guardian-admin,
 * paperclip, voice) fell straight through to compose's bare
 * `${KEY:-default}` whenever `state/stack.env` left the key unset — the
 * multi-instance smoke's actual failure (#652/PR #660): two sibling
 * OpenPalm installs both left `OP_WORKSPACE_PORT` unset and both fell onto
 * compose's default 3820.
 *
 * Real `Bun.serve` listeners stand in for a sibling instance's container, per
 * the same "prove it against a real bound port, not a mock" standard the
 * sibling `config-persistence-port-migration.test.ts` file uses (there via
 * `node:net`'s `createServer`).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "bun";
import { ensureHostPortDefaults } from "./config-persistence.js";
import type { ControlPlaneState } from "./types.js";

let server: Server | undefined;

afterEach(() => {
  server?.stop(true);
  server = undefined;
});

function listenOn(port: number): Server {
  return Bun.serve({ port, hostname: "127.0.0.1", fetch: () => new Response("ok") });
}

function stateFor(homeDir: string): ControlPlaneState {
  return {
    homeDir,
    configDir: join(homeDir, "config"),
    stashDir: join(homeDir, "knowledge"),
    workspaceDir: join(homeDir, "workspace"),
    dataDir: join(homeDir, "data"),
    stackDir: join(homeDir, "system", "stack"),
    services: {},
    artifacts: { compose: "" },
    artifactMeta: [],
  };
}

async function withHome(
  content: string,
  run: (homeDir: string, path: string) => void | Promise<void>,
): Promise<void> {
  const homeDir = mkdtempSync(join(tmpdir(), "openpalm-host-port-defaults-"));
  const path = join(homeDir, "state", "stack.env");
  mkdirSync(join(homeDir, "state"), { recursive: true });
  writeFileSync(path, content);
  try {
    await run(homeDir, path);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
}

describe("ensureHostPortDefaults (#660)", () => {
  test("a busy workspace default is bumped to the next free port not in the reserved set, and nothing else is written", async () => {
    server = listenOn(3820); // stand-in for a sibling instance already on the workspace default

    await withHome(
      "OP_UI_PORT=3800\nOP_ASSISTANT_PORT=3810\nOP_GUARDIAN_PORT=3830\nOP_GUARDIAN_ADMIN_PORT=3831\nOP_API_PORT=3821\n",
      async (homeDir, path) => {
        await ensureHostPortDefaults(stateFor(homeDir));
        const after = readFileSync(path, "utf-8");
        // 3820 is busy, 3821 is the api default (reserved even though free) —
        // the first port neither busy nor reserved is 3822.
        expect(after).toContain("OP_WORKSPACE_PORT=3822");
        // Every other key was already explicit and must be untouched.
        expect(after).toContain("OP_UI_PORT=3800");
        expect(after).toContain("OP_ASSISTANT_PORT=3810");
        expect(after).toContain("OP_GUARDIAN_PORT=3830");
        expect(after).toContain("OP_GUARDIAN_ADMIN_PORT=3831");
        expect(after).toContain("OP_API_PORT=3821");
        // Paperclip/voice were absent and their defaults are free — absence
        // keeps meaning "the default": nothing gets written for them.
        expect(after).not.toContain("OP_PAPERCLIP_PORT");
        expect(after).not.toContain("OP_VOICE_PORT_HOST");
      },
    );
  });

  test("a free workspace default is left absent — nothing is written at all", async () => {
    await withHome(
      "OP_UI_PORT=3800\nOP_ASSISTANT_PORT=3810\nOP_GUARDIAN_PORT=3830\nOP_GUARDIAN_ADMIN_PORT=3831\nOP_API_PORT=3821\n",
      async (homeDir, path) => {
        const before = readFileSync(path, "utf-8");
        await ensureHostPortDefaults(stateFor(homeDir));
        expect(readFileSync(path, "utf-8")).toBe(before);
      },
    );
  });

  test("an explicit workspace port colliding with a listener is left untouched — operator-authoritative", async () => {
    server = listenOn(4820);

    await withHome(
      "OP_UI_PORT=3800\nOP_ASSISTANT_PORT=3810\nOP_WORKSPACE_PORT=4820\n",
      async (homeDir, path) => {
        const before = readFileSync(path, "utf-8");
        await ensureHostPortDefaults(stateFor(homeDir));
        expect(readFileSync(path, "utf-8")).toBe(before);
      },
    );
  });

  test("the reserved-set rule: with the workspace default held and the api default free, the chosen port skips the api default", async () => {
    server = listenOn(3820);

    await withHome("OP_UI_PORT=3800\nOP_ASSISTANT_PORT=3810\n", async (homeDir, path) => {
      // OP_API_PORT is ALSO absent here (its default is 3821, genuinely free)
      // — the point is that ensureHostPortDefaults must never hand workspace
      // a port that is another key's default, even though nothing is bound
      // there and a plain bind-probe alone would have called it free.
      await ensureHostPortDefaults(stateFor(homeDir));
      const after = readFileSync(path, "utf-8");
      expect(after).toContain("OP_WORKSPACE_PORT=3822");
      expect(after).not.toContain("OP_WORKSPACE_PORT=3821");
      // api's own default (3821) was free and stays absent.
      expect(after).not.toContain("OP_API_PORT");
    });
  });

  test("does not create state/stack.env at all when the file is absent and every default is free", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "openpalm-host-port-defaults-nofile-"));
    try {
      const path = join(homeDir, "state", "stack.env");
      expect(existsSync(path)).toBe(false);
      await ensureHostPortDefaults(stateFor(homeDir));
      expect(existsSync(path)).toBe(false);
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });
});
